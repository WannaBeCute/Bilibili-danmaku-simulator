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
      // ★ 上次草稿参数(添加「新草稿」时,继承这些参数,仅 content 为空)
      this._lastDraftNormal = null // 上次普通弹幕草稿(不含 content/id)
      this._lastDraftAdvanced = null // 上次高级弹幕草稿(不含 content/id)
      this.videoInfo = null // { filename, path, duration }
      this._listeners = new Set() // fn(event, id, field)
      this._beforeMutators = new Set() // 变更前钩子(撤回/恢复用)
      this._seq = 1
      this._editSnapshots = new Map() // id -> 编辑前的原始快照(延迟提交用)
      this._lockVeto = null // () -> boolean,返回 false 时阻止切换选中
      this.autoSave = false // ★ 自动保存:开启后编辑弹幕自动提交(无需点「更改」按钮)
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

    /** ★ 正规化一条 record:若 timeSec 缺失则根据 time("HH:MM:SS.cc")或 0 填充(精确到 0.01s)。
     *  用于修复 start.json 仅有时文字段却没有 timeSec 时,duplicate() 读到 undefined 变 NaN→0 的问题。*/
    _ensureTimeSec(r) {
      if (!r) return r
      if (typeof r.timeSec !== 'number' || isNaN(r.timeSec)) {
        let s = 0
        if (typeof r.time === 'string' && r.time) {
          const parts = r.time.split(':')
          const last = parts[parts.length - 1] || '0'
          const secPart = parseFloat(last) || 0
          let h = 0, m = 0, sec = secPart
          if (parts.length >= 3) { h = parseInt(parts[0], 10) || 0; m = parseInt(parts[1], 10) || 0; sec = secPart }
          else if (parts.length === 2) { m = parseInt(parts[0], 10) || 0; sec = secPart }
          else { sec = secPart }
          s = h * 3600 + m * 60 + sec
        }
        r.timeSec = Math.round(Math.max(0, s) * 100) / 100
      }
      return r
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
      if (this.draft && this.draft.id === id) {
        this._ensureTimeSec(this.draft)
        return this.draft
      }
      const r = this.comments.find((c) => c.id === id) || null
      if (r) this._ensureTimeSec(r)
      return r
    }

    /** ★ 把一条 record 的参数(去除 content/id)缓存到 _lastDraftXxx,
     *    下次点「添加弹幕」时可以直接用这些参数创建新草稿(除正文外所有状态均保留)。*/
    _cacheLastDraft(record) {
      if (!record) return
      try {
        const snap = JSON.parse(JSON.stringify(record))
        delete snap.id
        delete snap.content
        delete snap._isDuplicate
        if (snap.type === 'advanced') this._lastDraftAdvanced = snap
        else this._lastDraftNormal = snap
      } catch (_) {}
    }

    /** 设置草稿弹幕(不入池,面板绑定它;发送时 add 才入池)。
     *  ★ 同时把当前草稿的参数(去除 content/id)缓存到 _lastDraftXxx。*/
    setDraft(record) {
      if (record && !record.id) record.id = this._genId()
      this.draft = record || null

      // ★ 记录到「上次草稿参数」,用于后续新草稿继承
      if (record) this._cacheLastDraft(record)

      this.selectedId = this.draft ? this.draft.id : null
      this.selectedIds = new Set(this.draft ? [this.draft.id] : [])
      this._emit('select', this.selectedId, null)
    }

    /** ★ 用缓存的「上次草稿参数」创建一个新草稿骨架(除 content 为空、无 id 外与上次完全一致)。
     *  如果没有缓存,返回 null 让调用方回退到默认值(Convert.makeXxx)。
     *  type = 'normal' | 'advanced'。*/
    buildDraftFromLast(type) {
      const snap = type === 'advanced' ? this._lastDraftAdvanced : this._lastDraftNormal
      if (!snap) return null
      try {
        const copy = JSON.parse(JSON.stringify(snap))
        copy.content = '' // ★ 正文保持空白(按需求:除正文外所有参数保留)
        return copy
      } catch (_) {
        return null
      }
    }

    getSelected() {
      return this.get(this.selectedId)
    }

    sorted() {
      return this.comments
        .slice()
        .sort((a, b) => a.timeSec - b.timeSec || a.id.localeCompare(b.id))
    }

    /** 整个替换(导入/加载),并补全缺失 id 与 timeSec。*/
    setComments(list) {
      this._emitBefore()
      this.comments = Array.isArray(list) ? list.slice() : []
      for (const r of this.comments) {
        if (!r.id) r.id = this._genId()
        this._ensureTimeSec(r)
      }
      this.selectedId = null
      this._editSnapshots.clear()
      this._emit('replace', null, null)
    }

    /** ★ 批量追加(合并导入用):不替换现有弹幕,把传入 records 追加到末尾,
     *  自动补全新 id/timeSec,并返回 { added, sameCount, accepted } 三个计数器
     *  (用于「加入其他弹幕」同参判定提示)。若 opts.skipSame=true 则跳过与现有完全一致的弹幕。*/
    appendMany(list, opts) {
      if (!Array.isArray(list) || !list.length) return { added: 0, sameCount: 0, accepted: [] }
      opts = opts || {}
      this._emitBefore()
      const existingIds = new Set(this.comments.map((r) => r.id))
      // 对要比较的每条 record 计算"指纹"(用于参数完全一致的判定):
      //   - 普通弹幕: type + content + timeSec 四舍五入到 10ms + mode + fontSize + color + isUp (+ colorful)
      //   - 高级弹幕: type + content + style(颜色/字号/字体/描边JSON化) + life.duration + position(usePercent/sx/sy/ex/ey) + rotation(z/y)
      const fingerprint = (rec) => {
        if (!rec) return ''
        const t = (rec.type === 'advanced') ? 'advanced' : 'normal'
        if (t === 'advanced') {
          const s = rec.style || {}
          const p = rec.position || {}
          const ro = rec.rotation || {}
          const l = rec.life || {}
          return 'A' +
            '|c:' + String(rec.content || '') +
            '|co:' + String(s.color || '') +
            '|fs:' + (s.fontSize != null ? s.fontSize : '') +
            '|ff:' + String(s.fontFamilyRaw || s.fontFamily || '') +
            '|st:' + (s.stroke ? 1 : 0) +
            '|ld:' + (l.duration != null ? l.duration : '') +
            '|up:' + (p.usePercent ? 1 : 0) +
            '|sx:' + (p.startX != null ? p.startX : '') +
            '|sy:' + (p.startY != null ? p.startY : '') +
            '|ex:' + (p.endX != null ? p.endX : '') +
            '|ey:' + (p.endY != null ? p.endY : '') +
            '|rz:' + (ro.z != null ? ro.z : '') +
            '|ry:' + (ro.y != null ? ro.y : '')
        } else {
          return 'N' +
            '|c:' + String(rec.content || '') +
            '|t:' + (typeof rec.timeSec === 'number' ? Math.round(rec.timeSec * 100) / 100 : '') +
            '|m:' + String(rec.mode || 'scroll') +
            '|fs:' + String(rec.fontSize != null ? rec.fontSize : '') +
            '|co:' + String(rec.color || '') +
            '|up:' + (rec.isUp ? 1 : 0)
        }
      }
      // 规范化现有记录的 timeSec(保证指纹与 timeSec 一致)
      for (let j = 0; j < this.comments.length; j++) this._ensureTimeSec(this.comments[j])
      const existingFp = new Set(this.comments.map(fingerprint))
      let added = 0
      let sameCount = 0
      const accepted = []
      for (let r of list) {
        if (!r) continue
        r = Object.assign({}, r)
        r.id = null
        r.id = this._genId()
        if (existingIds.has(r.id)) r.id = this._genId()
        if (this.draft && this.draft.id === r.id) r.id = this._genId()
        this._ensureTimeSec(r)
        const fp = fingerprint(r)
        if (fp && existingFp.has(fp)) {
          sameCount++
          if (opts.skipSame) continue
        }
        if (fp) existingFp.add(fp)
        this.comments.push(r)
        added++
        accepted.push(r)
      }
      this._emit('replace', null, null)
      return { added: added, sameCount: sameCount, accepted: accepted }
    }

    /** 新增,返回新 record(会补全 id/timeSec;发送草稿后清空草稿)。
     *  ★ 发送 = 写入当前时间戳 sentAt:发送成功后再改弹幕 content/参数等不算"发送",不算重写 sentAt(仅 commitEdit 更新)。*/
    add(patch) {
      this._emitBefore()
      const record = Object.assign({}, patch)
      if (!record.id) record.id = this._genId()
      this._ensureTimeSec(record)
      record.sentAt = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
      this.comments.push(record)
      this.draft = null
      this._cacheLastDraft(record)
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
      // ★ 自动保存:开启后,编辑已有弹幕(非草稿)时自动提交
      if (this.autoSave && record !== this.draft) this.commitEdit(id)
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
      // ★ 自动保存:开启后,编辑已有弹幕(非草稿)时自动提交
      if (this.autoSave && record !== this.draft) this.commitEdit(id)
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

    /** 提交编辑(清除旧快照,以当前状态创建新快照)。
     *  ★ 同时更新 sentAt 为当前时间戳:用户点击"更改" = 对弹幕做了修改,修改时间更新为此时。*/
    commitEdit(id) {
      const rec = this.get(id)
      if (rec && rec !== this.draft) {
        rec.sentAt = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
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
     *  ★ 复制后的弹幕发送人改为全局默认发送人(默认"我"),不沿用被复制弹幕的发送人。
     *  ★ sentAt 不沿用被复制弹幕的:草稿阶段先写入复制时间,最后以发送(add)时为准(发送时会再次覆写)。*/
    duplicate(id) {
      const src = this.get(id)
      if (!src) return null
      this._ensureTimeSec(src)
      const copy = JSON.parse(JSON.stringify(src))
      delete copy.id
      copy.timeSec = Math.round((src.timeSec + 0.01) * 100) / 100
      copy._isDuplicate = true
      copy.sentAt = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
      copy.sender = (global.App && global.App.settings && global.App.settings.defaultSender) || '我'
      if (global.TimeUtil && global.TimeUtil.fmtClock) copy.time = global.TimeUtil.fmtClock(copy.timeSec)
      this.setDraft(copy)
      return copy
    }

    /** 计算消失时间并以此为起点复制弹幕（精确到小数点后两位）。
     *  - 普通弹幕: 消失时间 = timeSec + (lifeSec 或 player 的默认 lifeSec)
     *  - 高级弹幕: 消失时间 = timeSec + life.duration
     */
    duplicateFromEndTime(id) {
      const src = this.get(id)
      if (!src) return null
      const copy = JSON.parse(JSON.stringify(src))
      delete copy.id
      let durSec = 0
      if (src.type === 'advanced') {
        durSec = parseFloat((src.life && src.life.duration) || 0)
      } else {
        // 普通弹幕: 从 player 的 DANMAKU_LIFE[fontSize][mode] 获取
        let lifeSec = 4.5
        try {
          const P = global.window && global.window.App && global.window.App.player
          if (P && P.defaultGlobalStyle && P.defaultGlobalStyle.lifeSec) {
            lifeSec = parseFloat(P.defaultGlobalStyle.lifeSec) || 4.5
          }
          if (P && P.DANMAKU_LIFE) {
            const fs = (src.style && src.style.fontSize != null) ? src.style.fontSize : src.fontSize
            const key = (fs === 18 || fs === 'small') ? 'small'
                      : ((fs === 45 || fs === 'large') ? 'large' : 'standard')
            const mode = (src.mode && typeof src.mode === 'string') ? src.mode : 'scroll'
            if (P.DANMAKU_LIFE[key] && P.DANMAKU_LIFE[key][mode]) lifeSec = P.DANMAKU_LIFE[key][mode]
          }
        } catch (e) {}
        durSec = lifeSec
      }
      const endSec = parseFloat((parseFloat(src.timeSec || 0) + parseFloat(durSec || 0)).toFixed(2))
      copy.timeSec = Math.max(0, endSec)
      if (copy.time && global.TimeUtil && global.TimeUtil.fmtClock) {
        copy.time = global.TimeUtil.fmtClock(copy.timeSec)
      }
      copy._isDuplicate = true
      copy.sentAt = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
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
