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
      this._batchSnapshots = new Map() // id -> 批量进入时的原始快照(批量取消回滚用)
      this._batchIdsAtEntry = null // Set<string> | null,最近一次进入批量时的 id 集合
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
     *  ★ 同时把当前草稿的参数(去除 content/id)缓存到 _lastDraftXxx。
     *  ★ 僵尸草稿修复:若已有未发送的旧草稿(id 不同)被替换(例如点了另一边的
     *    「＋ 添加弹幕」/复制/LRC),旧草稿已被 spawn 到舞台上,必须先移除其舞台实例,
     *    否则残留成"僵尸弹幕"——不在列表里、也无法删除。与 store.select 里的清理一致。*/
    setDraft(record) {
      if (record && !record.id) record.id = this._genId()
      if (this.draft && (!record || record.id !== this.draft.id)) {
        const oldDraftId = this.draft.id
        try {
          const app = global.window && global.window.App
          const engine = app && app.engine
          if (engine) {
            if (engine.advanced && typeof engine.advanced.removeById === 'function') engine.advanced.removeById(oldDraftId)
            if (engine.normal && typeof engine.normal.removeById === 'function') engine.normal.removeById(oldDraftId)
          }
        } catch (_) {}
      }
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
      this.selectedIds.clear() // ★ 批量多选集也必须清空,否则 panel.replace 分支会误判批量态
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
     *  ★ 发送 = 写入当前时间戳 ctime:发送成功后再改弹幕 content/参数等不算"发送",不算重写 ctime(仅 commitEdit 更新)。*/
    add(patch) {
      this._emitBefore()
      const record = Object.assign({}, patch)
      if (!record.id) record.id = this._genId()
      this._ensureTimeSec(record)
      record.ctime = Number.isFinite(record.ctime) && record.ctime > 0
        ? Number(record.ctime)
        : (global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now())
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
      this._batchSnapshots.delete(id)
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
     *  ★ 同时更新 ctime 为当前时间戳:用户点击"更改" = 对弹幕做了修改,保存时间更新为此时。*/
    commitEdit(id) {
      const rec = this.get(id)
      if (rec && rec !== this.draft) {
        rec.ctime = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
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
      // ★ 批量快照的回滚/清理由 exitBatch()(list.js 在深度批量集合真正退出时调用)统一管理;
      //   单选切换(批量偏离态:单选/轻度多选其他弹幕)不回滚,以便用户跳回批量态后改动仍在。
      // 切换前恢复上一个记录的编辑快照(延迟提交:未点"更改"就切换则撤销修改)
      // ★ 处于批量快照管理中的记录不恢复单选快照(其当前状态包含批量改动,恢复会误回退批量改动)
      if (this.selectedId !== id && this.selectedId != null) {
        if (!this._batchSnapshots.has(this.selectedId)) {
          this._restoreEditSnapshot(this.selectedId)
        }
        // ★ Bug3 本意保留:切选到另一条弹幕(或 deselect 之后再切)时,若上一条选中的是
        //   未发送草稿,则必须丢弃它 + 移除舞台实例(避免僵尸弹幕残留)。
        //   注意:这里只在「切到不同 id」时清理(重新选中同一条草稿不删)。
        if (this.draft && this.selectedId === this.draft.id && id !== this.draft.id) {
          const draftId = this.draft.id
          try {
            const app = global.window && global.window.App
            const engine = app && app.engine
            if (engine) {
              if (engine.advanced && typeof engine.advanced.removeById === 'function') {
                engine.advanced.removeById(draftId)
              }
              if (engine.normal && typeof engine.normal.removeById === 'function') {
                engine.normal.removeById(draftId)
              }
            }
          } catch (_) {}
          this.draft = null
        }
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
      // ★ 快照创建采用 merge 策略:已有快照的 id 保留(保持最初进入批量时的回滚基准),
      //   只为"新加入"的 id 补建快照;这样批量偏离(单选/轻度多选)后跳回批量态,未保存改动仍在,
      //   取消批量时仍回滚到最初(或最后一次点「更改」后重建)的基准。
      const nowBatchAdvanced = ids.length >= 2 && ids.every((i) => {
        const r = this.get(i); return r && r.type === 'advanced' && r !== this.draft
      })
      if (nowBatchAdvanced) {
        const idSet = new Set(ids)
        this._batchIdsAtEntry = new Set(idSet)
        for (const id of idSet) {
          if (this._batchSnapshots.has(id)) continue // ★ merge:已有快照不覆盖
          const rec = this.get(id)
          if (!rec || rec === this.draft) continue
          this._batchSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
          // ★ 清掉该 id 的单选编辑快照:批量改动由批量快照统一管理,
          //   防止后续单选切换/deselect 时误回退批量改动
          this._editSnapshots.delete(id)
        }
      }
      this.selectedIds = new Set(ids)
      this.selectedId = ids.length ? ids[0] : null
      this._emit('select', this.selectedId, null)
    }

    /** 多选:Ctrl 切换单项。 */
    toggleSelect(id) {
      // 锁定态:阻止切换选中
      if (this._lockVeto && !this._lockVeto()) return
      // 批量锁定态下:禁止加减选中
      if (this._lockVeto && !this._lockVeto()) return
      // 重新生成目标 ids 数组
      const ids = Array.from(this.selectedIds)
      const idx = ids.indexOf(id)
      if (idx !== -1) ids.splice(idx, 1); else ids.push(id)
      // 交给 selectRange 处理(含批量快照/回滚逻辑)
      this.selectRange(ids)
    }

    /** 批量提交:把 _batchSnapshots 指向的 id 们 commitEdit(保存当前改动),并清除批量快照。
     *  等价于用户逐一点「更改」。返回保存条数。
     *  ★ 提交后以「保存后的状态」重建快照:后续若继续改动再取消批量,回滚到最后一次保存点。*/
    commitBatch() {
      let n = 0
      for (const id of this._batchSnapshots.keys()) {
        this.commitEdit(id)
        n++
      }
      this._batchSnapshots.clear()
      this._batchIdsAtEntry = null
      // ★ 以保存后的状态重建回滚基准(仅当前仍选中的批量 id)
      if (n > 0 && this.isDeepBatchAdvanced()) {
        for (const id of this.selectedIds) {
          const rec = this.get(id)
          if (!rec || rec === this.draft) continue
          this._batchSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
        }
        this._batchIdsAtEntry = new Set(this.selectedIds)
      }
      return n
    }

    /** ★ 单条「已提交编辑」:把该记录的编辑快照(_editSnapshots)与批量快照(_batchSnapshots)重基到当前状态。
     *  等价于对该条点了一次「更改」,但不动 ctime、不发事件。
     *  用途:右键菜单 / 批量菜单直接改时间、颜色后调用,退出菜单 / 退出批量不再回滚这次改动。 */
    commitEditId(id) {
      const rec = this.get(id)
      if (!rec || rec === this.draft) return
      const snap = JSON.parse(JSON.stringify(rec))
      if (this._editSnapshots.has(id)) this._editSnapshots.set(id, snap)
      if (this._batchSnapshots.has(id)) this._batchSnapshots.set(id, snap)
    }

    /** ★ 保存后调用:把所有「未提交编辑快照」(单条 _editSnapshots / 批量 _batchSnapshots)重基到当前状态。
     *  用途:用户编辑后不点「更改」直接 Ctrl+S/保存,保存成功后当前状态即已保存的事实,
     *  此后切换选中 / 退出批量时不再回滚到保存前的旧状态(避免"保存了却丢失改动"的困惑)。
     *  仅重基,不改 ctime、不发事件。*/
    rebasePendingEdits() {
      for (const id of Array.from(this._editSnapshots.keys())) {
        const rec = this.get(id)
        if (rec && rec !== this.draft) this._editSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
      }
      for (const id of Array.from(this._batchSnapshots.keys())) {
        const rec = this.get(id)
        if (rec && rec !== this.draft) this._batchSnapshots.set(id, JSON.parse(JSON.stringify(rec)))
      }
    }

    /** 强制回滚批量快照:仅暴露给面板/overlay 特殊调用(如用户显式点「取消」)。 */
    rollbackBatch() {
      if (!this._batchSnapshots.size) return 0
      this._emitBefore()
      let n = 0
      for (const [id, orig] of this._batchSnapshots) {
        const idx = this.comments.findIndex((c) => c.id === id)
        if (idx !== -1) { this.comments[idx] = orig; n++ }
      }
      this._batchSnapshots.clear()
      this._batchIdsAtEntry = null
      this._emit('replace', null, null)
      return n
    }

    /** ★ 深度批量集合真正退出时调用(list.js 负责):
     *  - autoSave=false 且有快照 → 回滚批量改动(回到进入批量时/最后一次「更改」时的状态)
     *  - 否则仅清除快照(改动保留)。返回回滚条数(0=无回滚)。*/
    exitBatch() {
      if (!this._batchSnapshots.size) return 0
      if (!this.autoSave) return this.rollbackBatch()
      this._batchSnapshots.clear()
      this._batchIdsAtEntry = null
      return 0
    }

    /** 当前是否处于「深度批量纯高级激活态」:
     *  深度批量集合(list._batchIds,>=2 且全部高级且非草稿)存在,且当前 selectedIds 与其完全一致。
     *  (批量偏离态:selectedIds 是单选/轻度多选 → false,但深度批量集合仍保留可跳回) */
    isDeepBatchAdvanced() {
      if (this.selectedIds.size < 2) return false
      let deepIds = null
      try {
        const list = global.window.App && global.window.App.list
        if (list && list._batchIds) deepIds = list._batchIds
      } catch (_) {}
      if (deepIds) {
        // ★ selectedIds 必须与深度批量集合完全一致(激活态)
        if (this.selectedIds.size !== deepIds.size) return false
        for (const id of deepIds) {
          if (!this.selectedIds.has(id)) return false
        }
      }
      for (const id of this.selectedIds) {
        const r = this.get(id)
        if (!r || r.type !== 'advanced' || r === this.draft) return false
      }
      return true
    }

    /** 批量删除,整体替换事件(一次撤回步骤)。 */
    removeMany(ids) {
      if (!ids || !ids.length) return false
      const set = new Set(ids)
      this._emitBefore()
      this.comments = this.comments.filter((c) => !set.has(c.id))
      for (const id of set) this._batchSnapshots.delete(id)
      if (set.has(this.selectedId)) this.selectedId = null
      this.selectedIds = new Set()
      this._emit('replace', null, null)
      return true
    }

    deselect() {
      // 锁定态:阻止取消选中
      if (this._lockVeto && !this._lockVeto()) return
      if (this.selectedId == null && !this.selectedIds.size) return
      // ★ 批量快照不在此处理(偏离态 deselect 后可由 list 恢复深度批量激活态;
      //   真正退出批量时由 list.js 调用 exitBatch() 回滚/清除)。
      // 恢复当前选中记录的编辑快照(★ 批量快照管理中的记录除外,防止误回退批量改动)
      if (this.selectedId != null && !this._batchSnapshots.has(this.selectedId)) {
        this._restoreEditSnapshot(this.selectedId)
      }
      // ★ Bug3 修正(防发送失败 / "未创建新弹幕"假错误):
      //   deselect = 只取消"选中"状态(高亮消失、面板切空态),**绝不**丢弃 store.draft。
      //   否则用户点"+添加弹幕"后误触舞台空白/非白名单按钮 → 草稿被连带删除,
      //   再点"发送/当前时间"就会因为 selectedId===null 而失败/无反应(与用户报告完全一致)。
      //   正确的草稿清理时机:
      //     a) 点击 send → store.add() 时 draft = null (发送成功,草稿入池)
      //     b) store.select(otherId) 且旧 selectedId===draftId 时,丢弃草稿(切到别的弹幕)
      //     c) 面板级切换(clear/showBatch/load 非草稿)时通过 _discardDraftIfNeeded 清理
      this.selectedId = null
      this.selectedIds.clear()
      this._emit('select', null, null)
    }

    /** 用于"从 record 改类型时,重建一个不同类型的 record"。
     *  ★ 复制后的弹幕发送人改为全局默认发送人(默认"我"),不沿用被复制弹幕的发送人。
     *  ★ ctime 不沿用被复制弹幕的:草稿阶段先写入复制时间,最后以发送(add)时为准(发送时会再次覆写)。*/
    duplicate(id) {
      // ★ 锁定态(单选或批量):禁止复制(与视觉灰化保持一致的行为约束)
      if (this._lockVeto && typeof this._lockVeto === 'function' && !this._lockVeto()) return null
      const src = this.get(id)
      if (!src) return null
      this._ensureTimeSec(src)
      const copy = JSON.parse(JSON.stringify(src))
      delete copy.id
      copy.timeSec = Math.round((src.timeSec + 0.01) * 100) / 100
      copy._isDuplicate = true
      copy.ctime = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
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
      // ★ 锁定态(单选或批量):禁止复制
      if (this._lockVeto && typeof this._lockVeto === 'function' && !this._lockVeto()) return null
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
      copy.ctime = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
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
