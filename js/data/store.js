/**
 * CommentStore:弹幕数据仓库(运行时对象)。
 *
 * 运行时对象字段:
 *   普通: { id, sender, type:'normal', content, timeSec, mode:'scroll'|'top'|'bottom',
 *           fontSize:'small'|'standard'|'large', color:'#RRGGBB', isUp, colorful? }
 *   高级: { id, sender, type:'advanced', content, timeSec,
 *           style:{color,fontSize,fontFamily,stroke}, rotation:{z,y},
 *           life:{duration,opacityStart,opacityEnd},
 *           motion:{moveDuration,delay,linear,type:'position'|'path',path?:[{x,y}]},
 *           position:{usePercent,startX,startY,endX,endY} }
 *
 * 编辑实时生效:store 变更会通过监听器通知 engine / 面板刷新。
 */
(function (global) {
  'use strict'

  const FONT_SIZE_PX = { small: 18, standard: 25, large: 36 }

  class CommentStore {
    constructor() {
      this.comments = []
      this.selectedId = null
      this.selectedIds = new Set() // 多选集合(列表拖动/Ctrl 多选)
      this.draft = null // 草稿弹幕(添加弹幕时先不入池,写好后发送才 add)
      this.videoInfo = null // { filename, path, duration }
      this._listeners = new Set() // fn(event, id, field)
      this._beforeMutators = new Set() // 变更前钩子(撤回/恢复用)
      this._seq = 1
      this._editSnapshots = new Map() // id -> 编辑前的原始快照(延迟提交用)
      this._lockVeto = null // () -> boolean,返回 false 时阻止切换选中
    }

    onChange(fn) {
      this._listeners.add(fn)
      return () => this._listeners.delete(fn)
    }

    /** 在每次数据变更前回调(用于撤回历史快照)。 */
    onBeforeMutate(fn) {
      this._beforeMutators.add(fn)
      return () => this._beforeMutators.delete(fn)
    }

    _emit(event, id, field) {
      this._listeners.forEach((fn) => {
        try {
          fn(event, id, field)
        } catch (e) {
          console.error('[store] listener error', e)
        }
      })
    }

    _emitBefore() {
      this._beforeMutators.forEach((fn) => {
        try {
          fn()
        } catch (e) {
          console.error('[store] beforeMutate error', e)
        }
      })
    }

    /** 生成唯一 id:d001,d002,...(复用被删 id 则继续递增,避免重复). */
    _genId() {
      for (;;) {
        const id = 'd' + String(this._seq++).padStart(3, '0')
        if (!this.get(id)) return id
      }
    }

    get(id) {
      if (id == null) return null
      if (this.draft && this.draft.id === id) return this.draft
      return this.comments.find((c) => c.id === id) || null
    }

    /** 设置草稿弹幕(不入池,面板绑定它;发送时 add 才入池)。 */
    setDraft(record) {
      if (record && !record.id) record.id = this._genId()
      this.draft = record || null
      this.selectedId = this.draft ? this.draft.id : null
      this.selectedIds = new Set(this.draft ? [this.draft.id] : [])
      this._emit('select', this.selectedId, null)
    }

    getSelected() {
      return this.get(this.selectedId)
    }

    sorted() {
      return this.comments
        .slice()
        .sort((a, b) => a.timeSec - b.timeSec || a.id.localeCompare(b.id))
    }

    /** 整个替换(导入/加载),并补全缺失 id。*/
    setComments(list) {
      this._emitBefore()
      this.comments = Array.isArray(list) ? list.slice() : []
      for (const r of this.comments) {
        if (!r.id) r.id = this._genId()
      }
      this.selectedId = null
      this._editSnapshots.clear()
      this._emit('replace', null, null)
    }

    /** ★ 批量追加(合并导入用):不替换现有弹幕,把传入 records 追加到末尾,
     * 自动去重 + 补全新 id,触发单个 replace 事件让引擎整体刷新。
     * 「加入其他弹幕」合并导入入口。*/
    appendMany(list) {
      if (!Array.isArray(list) || !list.length) return 0
      this._emitBefore()
      const existingIds = new Set(this.comments.map((r) => r.id))
      let added = 0
      for (let r of list) {
        if (!r) continue
        r = Object.assign({}, r)
        // 去重/补 id:导入文件的 id 会与现有冲突,一律清空让 _genId 重分
        r.id = null
        r.id = this._genId()
        if (existingIds.has(r.id)) r.id = this._genId()
        if (this.draft && this.draft.id === r.id) {
          // 新 id 刚好等于草稿 id,避免冲突
          r.id = this._genId()
        }
        this.comments.push(r)
        added++
      }
      this._emit('replace', null, null)
      return added
    }

    /** 新增,返回新 record(会补全 id/timeSec;发送草稿后清空草稿)。 */
    add(patch) {
      this._emitBefore()
      const record = Object.assign({}, patch)
      if (!record.id) record.id = this._genId()
      this.comments.push(record)
      this.draft = null
      this._emit('add', record.id, null)
      return record
    }

    /** 删除,返回是否成功。 */
    remove(id) {
      const i = this.comments.findIndex((c) => c.id === id)
      if (i < 0) return false
      this._emitBefore()
      this.comments.splice(i, 1)
      this._editSnapshots.delete(id)
      if (this.selectedId === id) this.selectedId = null
      this._emit('remove', id, null)
      return true
    }

    /**
     * 局部更新 record。field 是变更的字段名(可为 'content'、'style'、'position.startX' 等,
     * 用于引擎精准响应;为 null 表示整体变更)。
     */
    update(id, patch, field) {
      const record = this.get(id)
      if (!record) return false
      this._emitBefore()
      Object.assign(record, patch)
      this._emit('change', id, field || null)
      return true
    }

    /** 更新嵌套字段,如 updateDeep(id, 'style.color', '#FF0000'). */
    updateDeep(id, path, value) {
      const record = this.get(id)
      if (!record) return false
      this._emitBefore()
      const keys = path.split('.')
      let obj = record
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (obj[k] == null || typeof obj[k] !== 'object') obj[k] = {}
        obj = obj[k]
      }
      obj[keys[keys.length - 1]] = value
      this._emit('change', id, path)
      return true
    }

    /** 替换整个嵌套对象(如整个 style 对象)。 */
    setDeep(id, path, value) {
      const record = this.get(id)
      if (!record) return false
      this._emitBefore()
      const keys = path.split('.')
      let obj = record
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]
        if (obj[k] == null || typeof obj[k] !== 'object') obj[k] = {}
        obj = obj[k]
      }
      obj[keys[keys.length - 1]] = value
      this._emit('change', id, path)
      return true
    }

    /** 恢复指定记录的编辑快照(撤销未提交的修改)。 */
    _restoreEditSnapshot(id) {
      if (!this._editSnapshots.has(id)) return
      const original = this._editSnapshots.get(id)
      this._emitBefore()
      const idx = this.comments.findIndex((c) => c.id === id)
      if (idx !== -1) {
        this.comments[idx] = original
      }
      this._editSnapshots.delete(id)
      this._emit('change', id, null)
    }

    /** 提交编辑(清除旧快照,以当前状态创建新快照)。 */
    commitEdit(id) {
      const rec = this.get(id)
      if (rec && rec !== this.draft) {
        this._editSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
      } else {
        this._editSnapshots.delete(id)
      }
    }

    /** 检查记录是否有未提交的编辑快照。 */
    hasPendingEdit(id) {
      return this._editSnapshots.has(id)
    }

    /** 设置锁定 veto 函数。返回 false 时阻止切换选中(锁定态)。 */
    setLockVeto(fn) {
      this._lockVeto = fn || null
    }

    select(id) {
      // 锁定态:阻止切换选中
      if (this._lockVeto && !this._lockVeto()) {
        if (id !== this.selectedId) return
      }
      // 切换前恢复上一个记录的编辑快照(延迟提交:未点"更改"就切换则撤销修改)
      if (this.selectedId !== id && this.selectedId != null) {
        this._restoreEditSnapshot(this.selectedId)
      }
      if (this.selectedId === id && this.selectedIds.size === 1 && this.selectedIds.has(id)) {
        return
      }
      this.selectedId = id
      this.selectedIds = new Set(id != null ? [id] : [])
      // 为新选中的已发送记录创建快照(草稿无需快照)
      if (id != null) {
        const rec = this.get(id)
        if (rec && rec !== this.draft && !this._editSnapshots.has(id)) {
          this._editSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
        }
      }
      this._emit('select', id, null)
    }

    /** 多选:整体替换选中集合。primary 取首个。 */
    selectRange(ids) {
      // 锁定态:阻止切换选中
      if (this._lockVeto && !this._lockVeto()) return
      ids = Array.isArray(ids) ? ids : []
      this.selectedIds = new Set(ids)
      this.selectedId = ids.length ? ids[0] : null
      this._emit('select', this.selectedId, null)
    }

    /** 多选:Ctrl 切换单项。 */
    toggleSelect(id) {
      if (this.selectedIds.has(id)) {
        this.selectedIds.delete(id)
        if (this.selectedId === id) {
          this.selectedId = this.selectedIds.size
            ? this.selectedIds.values().next().value
            : null
        }
      } else {
        this.selectedIds.add(id)
        this.selectedId = id
      }
      this._emit('select', this.selectedId, null)
    }

    /** 批量删除,整体替换事件(一次撤回步骤)。 */
    removeMany(ids) {
      if (!ids || !ids.length) return false
      const set = new Set(ids)
      this._emitBefore()
      this.comments = this.comments.filter((c) => !set.has(c.id))
      if (set.has(this.selectedId)) this.selectedId = null
      this.selectedIds = new Set()
      this._emit('replace', null, null)
      return true
    }

    deselect() {
      // 锁定态:阻止取消选中
      if (this._lockVeto && !this._lockVeto()) return
      if (this.selectedId == null && !this.selectedIds.size) return
      // 恢复当前选中记录的编辑快照
      if (this.selectedId != null) {
        this._restoreEditSnapshot(this.selectedId)
      }
      this.selectedId = null
      this.selectedIds.clear()
      this._emit('select', null, null)
    }

    /** 用于"从 record 改类型时,重建一个不同类型的 record"。
     *  ★ 复制后的弹幕发送人改为全局默认发送人(默认"我"),不沿用被复制弹幕的发送人。*/
    duplicate(id) {
      const src = this.get(id)
      if (!src) return null
      const copy = JSON.parse(JSON.stringify(src))
      delete copy.id
      copy.timeSec = src.timeSec + 0.01
      copy._isDuplicate = true
      // ★ 发送人改为全局默认发送人(由全局设置面板控制,默认"我")
      copy.sender = (global.App && global.App.settings && global.App.settings.defaultSender) || '我'
      this.setDraft(copy)
      return copy
    }

    count() {
      return this.comments.length
    }

    clear() {
      this._emitBefore()
      this.comments = []
      this.selectedId = null
      this._editSnapshots.clear()
      this._emit('replace', null, null)
    }
  }

  global.CommentStore = CommentStore
  global.FONT_SIZE_PX = FONT_SIZE_PX
})(window)
