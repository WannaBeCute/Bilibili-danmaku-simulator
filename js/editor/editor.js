/**
 * editor.js:编辑模式管理。
 *  - 开启后舞台可点击,elementFromPoint 命中弹幕节点 -> 选中(高亮)
 *  - 坐标拾取:面板点击"拾取"armed 后,点舞台写入坐标;路径模式支持连续加点
 */
(function (global) {
  'use strict'

  class Editor {
    constructor(stage, store, engine) {
      this.stage = stage
      this.store = store
      this.engine = engine
      this.enabled = false
      this.pickMode = null // null | 'single' | 'path'
      this.pickField = null // 'startX' | 'startY' | 'endX' | 'endY'
      this.pickCrosshair = document.getElementById('pick-crosshair')
      this.overlay = null // EditOverlay,由 main.js 注入
      this.onPickDone = null // 回调,用于面板刷新拾取按钮状态

      this.ctxMenu = this._buildCtxMenu()

      stage.addEventListener('click', (e) => this.handleStageClick(e))
      stage.addEventListener('contextmenu', (e) => this.handleContextMenu(e))
      // ★ 拾取模式下,#stage-wrap 上的点击(含空白、视频、图片)都要走拾取逻辑
      //   因为 #stage 内的弹幕/视频节点会在 bubble 阶段 stopPropagation,
      //   所以必须在 capture 阶段拦截,否则 stage-wrap 的 bubble 监听器永远不会触发
      stage.parentElement.addEventListener('click', (e) => {
        if (this.pickMode) {
          e.stopPropagation()
          const rect = this.stage.getBoundingClientRect()
          const x = Math.round(e.clientX - rect.left)
          const y = Math.round(e.clientY - rect.top)
          this.pick(x, y)
          return
        }
        // 非拾取模式:只在 bubble 阶段才做 deselect 判断(让 .dm / video 等正常冒泡处理)
      }, true)
      // ★ 补充 bubble 阶段的 deselect:避开弹幕/播放条/提示/overlay 的点击
      stage.parentElement.addEventListener('click', (e) => {
        if (this.pickMode) return // capture 已处理,跳过
        const t = e.target
        if (t.closest('.dm') || t.closest('.player-bar') || t.closest('#stage-hint') || t.closest('#edit-overlay') || t.closest('.adv-menu')) return
        this.store.deselect()
      })
      document.addEventListener('click', () => this.hideCtxMenu())
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.hideCtxMenu()
        }
      })
      store.onChange((evt, id) => {
        if (evt === 'select' || evt === 'replace' || evt === 'remove') {
          this.applySelection(evt === 'select' ? id : null)
          // 选中变化后,刷新 stage/弹幕 pointer-events:
          // 选中状态下(哪怕非编辑模式)也要允许接收事件,否则右键舞台不弹菜单。
          this.refreshStagePointerEvents()
        }
      })
      // 初始化:根据初始 selectedIds 状态决定是否启用 pointer-events,
      // 避免刷新页面后已有的选中态无法右键菜单。
      this.refreshStagePointerEvents()
    }

    /** 右键菜单:时间调整 + 颜色 + 复制 + 删除(普通/高级通用)。 */
    _buildCtxMenu() {
      const menu = document.createElement('div')
      menu.className = 'ctx-menu'
      menu.hidden = true
      // 时间调整行
      const timeRow = document.createElement('div')
      timeRow.className = 'ctx-menu-row'
      timeRow.innerHTML = '<span>时间:</span>'
      const timeVal = document.createElement('b')
      timeVal.id = 'ctx-menu-time'
      timeVal.title = '点击直接修改时间'
      timeVal.style.cursor = 'pointer'
      timeVal.addEventListener('click', (e) => {
        e.stopPropagation()
        this._editCtxMenuTime(timeVal)
      })
      const timeMinus = this._timeBtn('-', timeVal)
      const timePlus = this._timeBtn('+', timeVal)
      timeRow.appendChild(timeMinus)
      timeRow.appendChild(timeVal)
      timeRow.appendChild(timePlus)
      timeRow.appendChild(this._sep())
      // 颜色行
      const colorRow = document.createElement('div')
      colorRow.className = 'ctx-menu-row'
      colorRow.innerHTML = '<span>颜色:</span>'
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.id = 'ctx-menu-color'
      colorInput.addEventListener('input', () => {
        const id = menu.dataset.id
        if (!id) return
        const rec = this.store.get(id)
        if (!rec) return
        const col = colorInput.value.toUpperCase()
        // 高级弹幕颜色在 style.color,普通弹幕在顶层 color(和 list.js 的颜色更新逻辑保持一致)
        if (rec.type === 'advanced') this.store.updateDeep(id, 'style.color', col)
        else this.store.update(id, { color: col }, 'color')
        // ★ 直接改动已提交:退出菜单/切选不再回滚
        if (typeof this.store.commitEditId === 'function') this.store.commitEditId(id)
      })
      colorRow.appendChild(colorInput)
      // 分隔线
      const sep1 = this._sep()
      // 复制
      const dup = document.createElement('button')
      dup.textContent = '复制'
      dup.addEventListener('click', () => {
        const id = menu.dataset.id
        this.hideCtxMenu()
        if (id) {
          const copy = this.store.duplicate(id)
          if (copy) this.store.select(copy.id)
        }
      })
      // 复制(从消失时间开始)
      const dupEnd = document.createElement('button')
      dupEnd.textContent = '复制(从消失时间开始)'
      dupEnd.className = 'ctx-copy-fromend-btn'
      dupEnd.addEventListener('click', () => {
        const id = menu.dataset.id
        this.hideCtxMenu()
        if (id) {
          const copy = this.store.duplicateFromEndTime(id)
          if (copy) this.store.select(copy.id)
        }
      })
      // ★ 保存(条件显示, 与 adv-menu 对齐):草稿→发送;已入池→保存所有改动
      const saveBtn = document.createElement('button')
      saveBtn.textContent = '保存'
      saveBtn.className = 'ctx-save-btn'
      saveBtn.id = 'ctx-menu-save'
      saveBtn.addEventListener('click', () => {
        const id = menu.dataset.id
        this.hideCtxMenu()
        if (!id) return
        const app = global.window.App
        const rec = this.store.get(id) || (this.store.draft && String(this.store.draft.id) === String(id) ? this.store.draft : null)
        if (!rec) return
        const controls = app && app.controls
        // 确保 store.getSelected() 是当前被右键的弹幕
        if (!this.store.selectedIds.has(id)) this.store.select(id)
        // ★ 歌词模式:右键「保存」草稿(即LRC草稿)时按LRC批量生成
        const panelAdv = app && app.panelAdvanced
        if (panelAdv && panelAdv._lrcMode && this.store.draft === rec && typeof panelAdv.sendLrcDanmaku === 'function') {
          panelAdv.sendLrcDanmaku()
          return
        }
        // ★ 草稿:先发送入池(与面板「发送」一致);已入池:改动已在 store,无需额外提交
        if (this.store.draft === rec) {
          if (controls && typeof controls.validateAndSend === 'function') {
            controls.validateAndSend(rec.type || 'advanced')
          }
        }
        // ★ 等效 Ctrl+S:把改动写进对应文件 + 列表保存按钮刷新为「已保存」
        if (controls && typeof controls.saveViaUserAction === 'function') {
          controls.saveViaUserAction()
        }
      })
      // ★ 取消当前选择(把被右键的弹幕从所有选择集中清除)
      const clearSelBtn = document.createElement('button')
      clearSelBtn.textContent = '取消当前选择'
      clearSelBtn.id = 'ctx-menu-clear-sel'
      clearSelBtn.title = '把被右键的弹幕从当前选择(单选/轻度/深度批量)中移除'
      clearSelBtn.addEventListener('click', () => {
        const id = menu.dataset.id
        this.hideCtxMenu()
        if (!id) return
        const app = global.window.App
        const list = app && app.list
        if (list && typeof list.clearSelectionOf === 'function') {
          list.clearSelectionOf(id)
        }
      })
      // 删除
      const del = document.createElement('button')
      del.textContent = '删除'
      del.id = 'ctx-menu-del'
      del.addEventListener('click', () => {
        const id = menu.dataset.id
        this.hideCtxMenu()
        if (this.store.selectedIds.size > 1) {
          // ★ 批量删除:需要先通过范围校验
          const list = global.window.App && global.window.App.list
          const ids = Array.from(this.store.selectedIds)
          if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete(ids)) {
            const player = global.window.App && global.window.App.player
            if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
            return
          }
          this.store.removeMany(ids)
        } else if (id) {
          const list = global.window.App && global.window.App.list
          if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete([id])) {
            const player = global.window.App && global.window.App.player
            if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
            return
          }
          this.store.remove(id)
        }
      })
      menu.appendChild(timeRow)
      menu.appendChild(colorRow)
      menu.appendChild(sep1)
      menu.appendChild(dup)
      menu.appendChild(dupEnd)
      menu.appendChild(saveBtn)
      menu.appendChild(clearSelBtn)
      menu.appendChild(del)
      // ★ 关键修复:菜单容器统一拦截 click 冒泡 → 所有子元素(时间 -/+ / 颜色 input / 取色按钮 / 复制 / 删除)
      // 的 click 不会冒到 document,从而不会触发 document.addEventListener('click', hideCtxMenu)
      // 导致菜单一被点就立刻关闭。复制/删除按钮自己会在 handler 内部显式调用 this.hideCtxMenu(),
      // 所以仍然会按预期在操作后关闭菜单。
      menu.addEventListener('click', (e) => {
        e.stopPropagation()
      })
      document.body.appendChild(menu)
      return menu
    }

    _sep() {
      const s = document.createElement('div')
      s.className = 'ctx-menu-sep'
      return s
    }

    _timeBtn(sign, timeVal) {
      const b = document.createElement('button')
      b.textContent = sign === '-' ? '◀' : '▶'
      let timer = null
      const step = (e) => {
        const id = this.ctxMenu.dataset.id
        if (!id) return
        const rec = this.store.get(id)
        if (!rec) return
        const delta = e.ctrlKey ? 1 : 0.1
        const t = Math.max(0, Math.round((rec.timeSec + (sign === '-' ? -delta : delta)) * 100) / 100)
        this.store.update(id, { timeSec: t }, 'timeSec')
        // ★ 直接改动已提交:退出菜单/切选不再回滚
        if (typeof this.store.commitEditId === 'function') this.store.commitEditId(id)
        timeVal.textContent = global.TimeUtil.timeToStrPrecise(t)
      }
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        step(e)
        timer = setInterval(() => step(e), 120)
      })
      b.addEventListener('mouseup', () => clearInterval(timer))
      b.addEventListener('mouseleave', () => clearInterval(timer))
      return b
    }

    /** ★ 右键菜单时间标签:点击后变为输入框,直接编辑时间(hh:mm:ss格式,支持两位小数)。 */
    _editCtxMenuTime(timeVal) {
      const id = this.ctxMenu.dataset.id
      if (!id) return
      const rec = this.store.get(id)
      if (!rec) return
      const currentSec = rec.timeSec || 0
      const currentStr = global.TimeUtil.timeToStrPrecise(currentSec)
      const input = document.createElement('input')
      input.type = 'text'
      input.value = currentStr
      input.style.width = '72px'
      input.style.fontSize = '12px'
      input.style.background = '#1f1f23'
      input.style.color = '#fff'
      input.style.border = '1px solid #4a9eff'
      input.style.borderRadius = '3px'
      input.style.padding = '1px 4px'
      input.style.fontFamily = 'inherit'
      timeVal.replaceWith(input)
      input.focus()
      input.select()
      const commit = () => {
        const parsed = global.TimeUtil.strToTime(input.value)
        if (parsed != null) {
          const t = Math.max(0, Math.round(parsed * 100) / 100)
          this.store.update(id, { timeSec: t }, 'timeSec')
          // ★ 直接改动已提交:退出菜单/切选不再回滚
          if (typeof this.store.commitEditId === 'function') this.store.commitEditId(id)
          timeVal.textContent = global.TimeUtil.timeToStrPrecise(t)
        } else {
          timeVal.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec || 0)
        }
        input.replaceWith(timeVal)
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
        else if (e.key === 'Escape') { e.preventDefault(); input.value = currentStr; input.blur() }
        e.stopPropagation()
      })
    }

    handleContextMenu(e) {
      // 舞台右键弹弹幕操作菜单(调整时间/颜色/复制/删除) —— 和列表里右键弹的是同一个 ctxMenu,
      // 与"编辑模式是否开启"解耦:非编辑模式下批量选择列表勾选后,右键舞台弹幕也能操作,
      // 修复"批量选择时舞台右键弹不出菜单"的问题。
      //
      // ★ 新增:若当前处于「深度批量选择纯高级弹幕」,点击在 _batchIds 中 → 直接弹列表的批量菜单(deep 上下文,
      //   和列表右键批量弹幕的菜单完全一致),方便用户在舞台上直接批量操作多个高级弹幕(如时间/颜色/删除);
      //   否则继续走原有单弹 ctxMenu 逻辑。
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const dmEl = el && el.closest ? el.closest('[data-dm-id]') : null
      if (!dmEl) return
      e.preventDefault()
      const id = dmEl.getAttribute('data-dm-id')

      const deepIds = this._getDeepBatchIds()
      const list = global.window.App && global.window.App.list
      if (this._isDeepAdvancedBatch() && deepIds.has(id) && list && typeof list._showBatchMenu === 'function') {
        // ★ 批量模式:复用列表 _showBatchMenu,deep 上下文,菜单和列表批量完全相同
        list._batchContext = 'deep'
        list._lastContextId = id
        list._refreshBatchUI && list._refreshBatchUI()
        list._showBatchMenu(id, e.clientX, e.clientY)
        return
      }

      if (!this.store.selectedIds.has(id)) this.store.select(id)
      this.ctxMenu.dataset.id = id
      const rec = this.store.get(id) || (this.store.draft && String(this.store.draft.id) === String(id) ? this.store.draft : null)
      const n = this.store.selectedIds.size
      const timeVal = this.ctxMenu.querySelector('#ctx-menu-time')
      if (timeVal && rec) timeVal.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec)
      const colorInput = this.ctxMenu.querySelector('#ctx-menu-color')
      if (colorInput && rec) {
        const col = (rec.style && rec.style.color) ? rec.style.color : (rec.color || '#FFFFFF')
        colorInput.value = global.ColorUtil.normalizeHex(col, '#FFFFFF')
      }
      const saveBtn = this.ctxMenu.querySelector('#ctx-menu-save')
      if (saveBtn) {
        const isDraft = !!rec && this.store.draft === rec
        const inPool = !!rec && rec.id && !!this.store.get(rec.id) && !isDraft
        const showSave = isDraft || inPool
        saveBtn.style.display = showSave ? '' : 'none'
        saveBtn.textContent = isDraft ? '保存(发送)' : '保存'
      }
      // ★ 删除按钮:按 id 直接定位(不再依赖按钮顺序)
      const delBtn = this.ctxMenu.querySelector('#ctx-menu-del')
      if (delBtn) delBtn.textContent = n > 1 ? '删除选中(' + n + '条)' : '删除'
      // ★ 锁定/批量锁定时统一灰化复制类按钮
      if (this.overlay && typeof this.overlay._applyLockVisuals === 'function') {
        this.overlay._applyLockVisuals()
      }
      this.ctxMenu.hidden = false
      const mw = this.ctxMenu.offsetWidth || 220
      const mh = this.ctxMenu.offsetHeight || 120
      const x = Math.min(e.clientX, window.innerWidth - mw - 8)
      const y = Math.min(e.clientY, window.innerHeight - mh - 8)
      this.ctxMenu.style.left = x + 'px'
      this.ctxMenu.style.top = y + 'px'
    }

    hideCtxMenu() {
      this.ctxMenu.hidden = true
    }

    /** 注入高级弹幕编辑 overlay(由 main.js 装配)。 */
    attachOverlay(overlay) {
      this.overlay = overlay
      overlay.setEnabled(this.enabled)
    }

    setEnabled(on) {
      this.enabled = on
      this.engine.setEditable(on)
      this.refreshStagePointerEvents()
      if (!on) this.cancelPick()
      if (this.overlay) this.overlay.setEnabled(on)
      document.body.classList.toggle('editing', on)
      // 切换编辑模式后重新应用选中高亮(节点框 <-> overlay 选定框)
      this.applySelection(this.store.selectedId)
    }

    /**
     * 综合 enabled(编辑模式) + 选中状态(selectedIds 非空,含单条/批量)刷新 pointer-events。
     * 只要任一激活,stage/弹幕就接收鼠标事件 → contextmenu/click 能命中 [data-dm-id]。
     * 必须在:
     *   - 切换编辑模式(setEnabled)
     *   - store select 事件(选中/取消/批量切换)
     *   - 切页/初始化后
     * 调用。
     */
    refreshStagePointerEvents() {
      const anySelected = (this.store.selectedIds && this.store.selectedIds.size > 0)
      const needPE = this.enabled || anySelected
      this.engine.setBatchActive(needPE)
      this.stage.style.pointerEvents = needPE ? 'auto' : 'none'
    }

    isEnabled() {
      return this.enabled
    }

    applySelection(id) {
      const els = this.stage.querySelectorAll('.dm-selected')
      for (const n of els) n.classList.remove('dm-selected')
      // 只有编辑模式开启时,才给选中弹幕加舞台 dm-selected 描边(用于 overlay 选中框联动);非编辑模式下完全隐藏节点选择框
      if (id && this.enabled) {
        const nodes = this.stage.querySelectorAll('[data-dm-id="' + id + '"]')
        for (const n of nodes) n.classList.add('dm-selected')
      }
      // ★ 新增:深度批量纯高级 → 编辑模式下也要给每个批量节点加描边高亮(非编辑模式下也统一加描边,方便识别批量操作范围)
      //   若有一个普通弹幕则不启用(保持默认单条或无描边)。
      if (this._isDeepAdvancedBatch()) {
        const ids = this._getDeepBatchIds()
        for (const bid of ids) {
          const nodes = this.stage.querySelectorAll('[data-dm-id="' + bid + '"]')
          for (const n of nodes) n.classList.add('dm-selected')
        }
        // 同时通知 overlay:激活态(选中集==批量集)→批量模式;偏离态→单选手柄
        const list2 = global.window.App && global.window.App.list
        const isActive2 = !!(list2 && list2._batchIds && this.store.selectedIds.size === list2._batchIds.size &&
          Array.from(this.store.selectedIds).every((sid) => list2._batchIds.has(sid)))
        if (this.overlay && typeof this.overlay.setBatchMode === 'function') {
          this.overlay.setBatchMode(isActive2)
        }
      } else {
        // 退出批量模式:恢复 overlay 单条手柄显示
        if (this.overlay && typeof this.overlay.setBatchMode === 'function') {
          this.overlay.setBatchMode(false)
        }
      }
    }

    handleStageClick(e) {
      // 拾取模式优先(不依赖 enabled:非编辑模式,如创建新高级弹幕,也能 arm 拾取)
      if (this.pickMode) {
        // ★ 阻止冒泡到 stage.parentElement 的 click 监听器(会触发 deselect 导致面板异常关闭)
        e.stopPropagation()
        const rect = this.stage.getBoundingClientRect()
        const x = Math.round(e.clientX - rect.left)
        const y = Math.round(e.clientY - rect.top)
        this.pick(x, y)
        return
      }

      if (!this.enabled) return

      const el = document.elementFromPoint(e.clientX, e.clientY)
      const dmEl = el && el.closest ? el.closest('[data-dm-id]') : null
      if (dmEl) {
        // 批量选择激活时(列表复选框有勾选):单击不执行 store.select(不显示 4 个编辑手柄),
        // 让弹幕保持纯"可右键操作"状态;仅当没有批量勾选项时,正常单击选中显示手柄。
        if (this._isBatchActive()) return
        this.store.select(dmEl.getAttribute('data-dm-id'))
      }
    }

    /** 判断是否处于「批量多选」激活状态(选中 ≥2 条)。
     *  用于 handleStageClick:批量多选时单击舞台弹幕不执行 store.select(不切换单条选中/显示手柄),
     *  让弹幕保持纯「可右键操作」状态。
     *  注意:与舞台/弹幕是否接收 pointer-events 的判断分开——
     *       非编辑模式下只要选中了 ≥1 条,就需要 pointer-events 让右键菜单能触发。 */
    _isBatchActive() {
      try {
        return this.store.selectedIds.size > 1 || this._getDeepBatchIds().size > 1
      } catch (_) {
        return false
      }
    }

    /** ★ 取深度批量选择集(从 list._batchIds 拿,通过 window.App.list 跨模块访问)。
     *  若拿不到则返回空 Set,保证调用方判断为 false。 */
    _getDeepBatchIds() {
      try {
        const list = global.window.App && global.window.App.list
        if (list && list._batchIds) return list._batchIds
      } catch (_) {}
      return new Set()
    }

    /** ★ 判断是否满足「深度批量选择纯高级弹幕」(至少 2 条,全部 type==='advanced',无普通弹幕)。
     *  满足条件时:编辑模式下舞台显示批量描边 + 单击切换为批量操作状态 + 右键弹列表批量菜单。 */
    _isDeepAdvancedBatch() {
      const ids = this._getDeepBatchIds()
      if (ids.size < 2) return false
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || rec.type !== 'advanced') return false
      }
      return true
    }

    /** 面板 armed 单项坐标拾取。field: 'start'(起始点) 或 'end'(结束点) */
    armPick(field) {
      this.pickMode = 'single'
      this.pickField = field
      this.showCrosshair(true)
      this.notifyPickState()
    }

    /** 面板 armed 路径拾取(连续加点)。 */
    armPathPick() {
      this.pickMode = 'path'
      this.pickField = null
      this.showCrosshair(true)
      this.notifyPickState()
    }

    cancelPick() {
      this.pickMode = null
      this.pickField = null
      this.showCrosshair(false)
      this.notifyPickState()
    }

    notifyPickState() {
      if (this.onPickDone) this.onPickDone(this.pickMode)
      // ★ 直接操作 #edit-overlay 的 picking class:CSS 已定义 .picking * { pointer-events:none !important }
      //   覆盖子元素显式设的 pointer-events:all(pointer-events 不继承)
      const svg = document.getElementById('edit-overlay')
      if (svg) svg.classList.toggle('picking', this.pickMode != null)
      if (this.overlay) this.overlay.setPicking(this.pickMode != null)
    }

    showCrosshair(on) {
      if (this.pickCrosshair) this.pickCrosshair.hidden = !on
    }

    pick(x, y) {
      // ★ 批量拾取:更新批量面板的 S/E 坐标输入框(不依赖单条选中)
      if (this.pickField && String(this.pickField).indexOf('batch-') === 0) {
        const pa = global.window.App && global.window.App.panelAdvanced
        if (pa && typeof pa.setBatchPickCoords === 'function') {
          pa.setBatchPickCoords(this.pickField, x, y)
        }
        this.cancelPick()
        return
      }
      const rec = this.store.getSelected()
      if (!rec || rec.type !== 'advanced') {
        this.cancelPick()
        return
      }
      const round2 = (n) => Math.round(n * 100) / 100
      const round1 = (n) => Math.round(n * 10) / 10
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
      // 像素 -> 单位:百分比(0~0.99 小数)或像素
      const toUnit = (px, axis) => {
        if (rec.position.usePercent) {
          return clamp(round2(px / (axis === 'x' ? this.engine.width : this.engine.height)), 0, 0.99)
        }
        return clamp(round1(px), 0, 9999)
      }

      if (this.pickMode === 'single') {
        if (this.pickField === 'start') {
          this.store.updateDeep(rec.id, 'position.startX', toUnit(x, 'x'))
          this.store.updateDeep(rec.id, 'position.startY', toUnit(y, 'y'))
        } else {
          this.store.updateDeep(rec.id, 'position.endX', toUnit(x, 'x'))
          this.store.updateDeep(rec.id, 'position.endY', toUnit(y, 'y'))
        }
        this.cancelPick()
      } else if (this.pickMode === 'path') {
        if (!rec.motion.path) rec.motion.path = []
        rec.motion.path.push({ x: toUnit(x, 'x'), y: toUnit(y, 'y') })
        this.store._emit('change', rec.id, 'motion.path')
        // 保持拾取模式,继续加点
      }
    }
  }

  global.Editor = Editor
})(window)
