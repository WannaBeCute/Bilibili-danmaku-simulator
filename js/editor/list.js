/**
 * list.js:弹幕列表面板(按时间排序,可选中/删除)。
 *
 * 渲染策略:仅在结构事件(replace/add/remove/select)重渲染;
 * 字段变更(change)时原位更新该行内容,避免整表 innerHTML 重建导致页面滚动到顶。
 */
(function (global) {
  'use strict'

  const MAX_BATCH = 200

  function createRow(rec, store, list) {
    const row = document.createElement('div')
    row.className = 'list-row'
    row.dataset.id = rec.id
    row.dataset.time = String(rec.timeSec)

    const time = document.createElement('span')
    time.className = 'list-time'
    time.textContent = global.TimeUtil.fmtClockExact(rec.timeSec)
    time.title = '点击跳转到该弹幕出现时间'
    // ★ 点击时间只跳时间,不触发选中:同时阻止 mousedown(行选择在这里) 和 click(冒泡到行)
    time.addEventListener('mousedown', (e) => e.stopPropagation())
    time.addEventListener('click', (e) => {
      e.stopPropagation()
      const app = global.window.App
      if (app && app.engine) app.engine.seek(rec.timeSec)
    })

    const badge = document.createElement('span')
    badge.className = 'list-badge ' + (rec.type === 'advanced' ? 'advanced' : 'normal')
    badge.textContent = rec.type === 'advanced' ? '高级' : '普通'

    const content = document.createElement('span')
    content.className = 'list-content'
    content.textContent = rec.content || '(空)'
    content.title = rec.content || ''

    row.appendChild(time)
    row.appendChild(badge)
    row.appendChild(content)
    row.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      list.onRowMouseDown(row, e)
    })
    // ★ 双击:不执行任何选择/取消操作(深度批量中的弹幕必须 Ctrl+单击 才能取消)
    row.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
    // 单击:弹出与播放器一致的菜单(若已处于批量多选,则批量菜单优先在右键触发)
    row.addEventListener('click', (e) => {
      list.onRowClick(row, e)
    })
    // 右键:多选→批量操作菜单;单选→普通菜单
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      list.onRowContextMenu(row, e)
    })
    return row
  }

  class DanmakuList {
    constructor(store, body, countEl) {
      this.store = store
      this.body = body
      this.countEl = countEl
      // ★ 防硬编码:启动时强制清空列表容器内的子节点。
      //   浏览器预览模式下运行时的 list-row 可能被浏览器误当作 HTML 原生内容序列化回来,
      //   导致程序初始化时就存在假的 DOM 节点,与按 store 渲染的真实行重叠。
      try { while (body && body.firstChild) body.removeChild(body.firstChild) } catch (_) {}
      this._rows = new Map() // id -> row element
      this._selDrag = null
      this.delSelBtn = document.getElementById('list-delete-sel')
      this._filters = { text: '', timeFrom: null, timeTo: null, type: 'all', subtype: 'all', sender: '' }
      this._range = { start: 0, end: Infinity } // ★ 当前弹幕池:展示范围 [start, end), end=Infinity 表示到末尾
      // ★ 弹幕池列表:详情列显示/隐藏(默认=出现时间/弹幕类型/颜色)
      const cols = this._readColumnsPref()
      this._columns = Object.assign(
        { time: true, type: true, color: true, sender: false, fontSize: false, mode: false, isup: false, ctime: false },
        cols || {}
      )
      // ★ 弹幕池列表:内容列「显示颜色」切换(默认关)
      this._contentShowColor = this._readContentShowColorPref()
      // ★ 弹幕池列表:排序状态(默认按「#」列正序)
      this._sort = { col: 'idx', dir: 'asc' }
      // ★ 弹幕池列表:多选集合(Ctrl+点击/拖拽选中,右键菜单操作目标)
      this._poolSelectedIds = new Set()
      this._wireSearch()

      this._onSelMove = (e) => this._handleSelMove(e)
      this._onSelUp = () => this._endSelDrag()
      this._autoScrollRAF = null
      this._autoScrollDir = 0 // -1 up, 1 down
      this._lastContextId = null // 右键点击的那条弹幕 id(用于批量菜单取该条颜色)
      this._batchIds = new Set() // ★ 深度选择集合:Ctrl选中 或 点"批量选中"按钮后合入;仅「取消所有选择」或新的轻度选择才清空
      this._batchContext = null // ★ 当前批量菜单的操作上下文:'deep'(深度选择) | 'light'(轻度选择) | null

      // ★ 弹幕池列表拖拽选择 + 自动滚动(document 级 mousemove,移出 div 也能追踪)
      this._poolDrag = null
      this._poolAutoScrollRAF = null
      this._poolAutoScrollDir = 0
      this._poolAutoScrollSpeed = 0
      this._onPoolDragMove = (e) => this._handlePoolDragMove(e)
      this._onPoolDragEnd = () => this._endPoolDrag()

      // ★ 固定展示:仅记录源 id(不拷贝弹幕),弹幕仍在主列表中
      //   - 始终优先展示,不受范围/筛选/showOnlyIds 影响
      //   - 引擎通过 _pinnedSourceIds 集合标记,强制通过筛选
      this._pinnedSourceIds = new Set() // 被固定展示的源记录 id 集合
      this._pinnedCollapsed = this._readPinnedCollapsedPref()
      this._pinnedSelectedIds = new Set() // 固定展示列表里的多选集合(存源 id)

      this._wireMenus()
      this._wirePoolUI() // ★ 总览窗口控件绑定

      // ★ 轻度批量选择清除:当 selectedIds.size > 1(轻度批量选择,无描边框)时,
      //   点击程序任意位置都清除轻度选择(selectedIds),但保留深度选择(_batchIds)。
      //   单选(size===1,有描边框)不清除;点击列表行/菜单由各自 handler 处理。
      document.addEventListener('mousedown', (e) => {
        if (this.store.selectedIds.size <= 1) return
        // ★ 拾取坐标模式中:不清除选择。
        //   否则点舞台拾取点时会先 deselect → 面板切偏离态 → cancelPick 把拾取模式取消,拾取永远无效
        const editor = global.window.App && global.window.App.editor
        if (editor && editor.pickMode) return
        // 点击列表行:由 onRowMouseDown 处理,不拦截
        if (e.target.closest('.list-row')) return
        // 点击批量菜单/右键菜单/高级弹幕菜单:由菜单 handler 处理,不拦截
        if (e.target.closest('.batch-menu') || e.target.closest('.ctx-menu') || e.target.closest('.adv-menu')) return
        // ★ 点击列表头部「删除选中」按钮:不拦截,否则 mousedown 先清空 selectedIds,
        //   随后 click 处理器读到空集合 → 轻度批量删除失效(深度批量走 _batchIds 不受影响)
        if (e.target.closest && e.target.closest('#list-delete-sel')) return
        // ★ 点击编辑 overlay(#edit-overlay 的手柄/选定框/批量框):由 overlay 自身处理,不拦截
        //   (否则点批量框想跳回批量操作面板时会先被 deselect 清掉选择)
        if (e.target.closest && e.target.closest('#edit-overlay')) return
        // ★ 点击高级弹幕面板(#panel-advanced 内的批量坐标表单/底部操作栏/统一参数按钮等):
        //   不拦截,否则点「预览/清除预览/批量统一参数」等按钮时会先被 deselect 清掉选择,
        //   随即深度批量恢复逻辑又会重新 selectRange → 触发面板强制刷新(_fillBatchCoordInputs 被重置)
        if (e.target.closest && e.target.closest('#panel-advanced')) return
        // ★ 点击普通弹幕面板(#panel-normal 内的时间/发送/颜色等控件):不拦截。
        //   缺这条会导致:批量态(size>1)下点普通面板任意按钮,mousedown 先 deselect,
        //   草稿被连带清(旧 Bug3 逻辑)或高亮丢失,与 #panel-advanced 对称处理。
        if (e.target.closest && e.target.closest('#panel-normal')) return
        // ★ 点击「批量统一参数」弹窗内的元素时不拦截(弹窗在 #app 根之外,绝对定位)
        if (e.target.closest && e.target.closest('#pa-batch-unify-modal')) return
        // 清除轻度选择,保留深度选择(_batchIds 在 list 上,store.deselect 不触及)
        this.store.deselect()
      })

      store.onChange((evt, id, field) => this.onStore(evt, id, field))
      this.render()
      // ★ 构造函数结束后立即渲染「当前弹幕池」窗口,否则初始加载时无 store 事件触发,弹幕池为空
      this._renderPoolInfo()
      this._renderPoolList()
    }

    /** 读取 localStorage 中保存的「展示列」偏好(若存在)。*/
    _readColumnsPref() {
      try {
        const s = (global.window.localStorage || {}).getItem('dp_columns')
        return s ? JSON.parse(s) : null
      } catch (e) {
        return null
      }
    }
    _persistColumnsPref() {
      try {
        const ls = global.window.localStorage
        if (ls) ls.setItem('dp_columns', JSON.stringify(this._columns || {}))
      } catch (e) { /* ignore */ }
    }
    /** 内容列「显示颜色」偏好:默认不应用颜色(false)。 */
    _readContentShowColorPref() {
      try {
        const s = (global.window.localStorage || {}).getItem('dp_content_show_color')
        if (s == null) return false // ★ 默认不应用
        return s === '1' || s === 'true'
      } catch (e) { return false }
    }
    _persistContentShowColorPref() {
      try {
        const ls = global.window.localStorage
        if (ls) ls.setItem('dp_content_show_color', this._contentShowColor ? '1' : '0')
      } catch (e) { /* ignore */ }
    }
    _readPinnedCollapsedPref() {
      try {
        const s = (global.window.localStorage || {}).getItem('dp_pinned_collapsed')
        return s === '1' || s === 'true'
      } catch (e) { return false }
    }
    _persistPinnedCollapsedPref() {
      try {
        const ls = global.window.localStorage
        if (ls) ls.setItem('dp_pinned_collapsed', this._pinnedCollapsed ? '1' : '0')
      } catch (e) { /* ignore */ }
    }

    /** 判断某条主记录是否已被固定展示。*/
    isPinned(recOrId) {
      if (!recOrId) return false
      const id = typeof recOrId === 'string' ? recOrId : (recOrId && recOrId.id ? recOrId.id : null)
      if (!id) return false
      return this._pinnedSourceIds.has(id)
    }

    /** 把选中的主弹幕加入固定展示(只标记源 id,不拷贝弹幕)。*/
    pinSelected(sourceIds) {
      const ids = (Array.isArray(sourceIds) ? sourceIds : Array.from(sourceIds || []))
      if (!ids.length) return 0
      let added = 0
      for (const id of ids) {
        if (!this.store.get(id)) continue
        if (this._pinnedSourceIds.has(id)) continue
        this._pinnedSourceIds.add(id)
        added++
      }
      if (added > 0) {
        this.refreshPoolList()
        this._notifyEnginePinnedChanged()
      }
      return added
    }
    /** 从固定展示移除(按源 ids)。*/
    unpinBySourceIds(sourceIds) {
      const set = new Set(Array.isArray(sourceIds) ? sourceIds : [])
      const before = this._pinnedSourceIds.size
      for (const id of set) this._pinnedSourceIds.delete(id)
      this._pinnedSelectedIds = new Set([...this._pinnedSelectedIds].filter((i) => !set.has(i)))
      const removed = before - this._pinnedSourceIds.size
      if (removed > 0) {
        this.refreshPoolList()
        this._notifyEnginePinnedChanged()
      }
      return removed
    }
    _notifyEnginePinnedChanged() {
      const app = global.window.App
      if (app && app.engine && typeof app.engine.setPinnedSourceIds === 'function') {
        app.engine.setPinnedSourceIds(Array.from(this._pinnedSourceIds))
      }
    }

    /** ★ 检查删除操作是否会破坏展示范围。
     *   返回 true = 允许删除;false = 阻止删除并显示错误提示。
     *   规则:
     *   - 范围 end 为 Infinity (到末尾):始终允许,无需校验
     *   - 范围 end 为具体数字:删除后剩余数量必须 >= end
     *   - 特殊:end 为 0 时,删除后剩余数量必须 >= start */
    _validateRangeBeforeDelete(idsToDelete) {
      const range = this._range
      // end 为 Infinity = 到末尾,无需校验
      if (range.end === Infinity) return true
      const total = this.store.count()
      const afterCount = total - idsToDelete.length
      const endVal = Math.max(0, Math.floor(Number(range.end) || 0))
      const startVal = Math.max(0, Math.floor(Number(range.start) || 0))
      if (endVal === 0) {
        // 特殊:end 为 0,校验 start
        if (afterCount < startVal) return false
      } else {
        if (afterCount < endVal) return false
      }
      return true
    }

    /** ★ 展示设置是否应用了筛选条件(仅筛选,不含展示范围)。 */
    _hasActiveFilters() {
      const f = this._filters
      return !!(f.text || f.timeFrom != null || f.timeTo != null ||
        f.type !== 'all' || f.subtype !== 'all' || f.sender)
    }

    /** ★ 当展示设置应用了筛选条件时,新发送的弹幕可能被筛掉,显示黄色警告。 */
    _warnIfFilterActive() {
      const app = global.window.App
      const player = app && app.player
      if (this._hasActiveFilters() && player) {
        player.toast('当前展示设置应用了筛选(不是弹幕展示范围),刚刚发送的弹幕可能会因此不予显示', { warn: true })
      }
    }

    /** 公共方法:controls 合并导入后刷新当前弹幕池列表。 */
    refreshPoolList() {
      this._renderPoolInfo()
      this._renderPoolList()
    }

    /** ★ 单击已通过 onRowMouseDown 实现 toggle 选中/取消选中(亮粉色描边框 + 连接参数面板)。
     *  不再在 click 事件弹出 ctx 菜单;右键仍可弹菜单(单选菜单/批量菜单)。 */
    onRowClick(_row, _e) {
      // no-op:toggle 在 mousedown 已处理
    }

    /**
     * ★ 右键行:根据右键点击的行所在的选择集区分上下文:
     *   - 在深度选择集(_batchIds)中且 > 1 条 → deep 上下文,批量菜单操作仅作用于 _batchIds
     *   - 在轻度选择集(selectedIds)中且 > 1 条 → light 上下文,批量菜单操作仅作用于 selectedIds
     *   - 不在任何选择集 → 单选该行,走单选菜单
     * 两种上下文的批量操作互不混淆。
     */
    onRowContextMenu(row, e) {
      const id = row.dataset.id
      this._lastContextId = id

      const inBatch = this._batchIds.has(id)
      const inSel = this.store.selectedIds.has(id)

      if (inBatch && this._batchIds.size > 1) {
        // ★ 深度选择上下文
        this._batchContext = 'deep'
        this._refreshBatchUI()
        this._showBatchMenu(id, e.clientX, e.clientY)
      } else if (inSel && this.store.selectedIds.size > 1) {
        // ★ 轻度选择上下文
        this._batchContext = 'light'
        this._refreshBatchUI()
        this._showBatchMenu(id, e.clientX, e.clientY)
      } else {
        // ★ 不在任何多选集 → 单选该行,弹出「与舞台右键完全相同的单弹 ctxMenu」(包含完整的取色器:支持视频/图片像素取色、失败不退出菜单、保留原色 toast 等)
        //   这样就实现了「舞台取色操作完全替代为弹幕列表同款完整取色」,顺便修复舞台取色成功/失败无法退出取色状态的bug」(因为两套逻辑完全统一到editor.ctxMenu的新取色器,退出键:ESC/点击空白都会走 editor.cancelColorPick + hideCtxMenu)

        // 先把右键行纳入选择(非已选择)保证菜单颜色/时间能正确回填
        if (!inSel) {
          // ★ 深度批量候选存在时保留 _batchIds(右键集合外的行 → 单选偏离态,可跳回批量);
          //   无深度批量时清掉残留的批量集合,避免轻度选择与旧批量集混合
          if (!this._isDeepCandidate()) this._batchIds.clear()
          this.store.select(id)
        }
        const app = global.window.App
        const editor = app && app.editor
        if (editor && editor.ctxMenu) {
          // 复用 editor 单弹 ctxMenu:填数据 → 定位 → 显示(完全和舞台右键同一套DOM和逻辑）
          editor.ctxMenu.dataset.id = id
          const rec = this.store.get(id)
          const n = this.store.selectedIds.size
          const timeVal = editor.ctxMenu.querySelector('#ctx-menu-time')
          if (timeVal && rec) timeVal.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec)
          const colorInput = editor.ctxMenu.querySelector('#ctx-menu-color')
          if (colorInput && rec) {
            const col = (rec.style && rec.style.color) ? rec.style.color : (rec.color || '#FFFFFF')
            colorInput.value = global.ColorUtil.normalizeHex(col, '#FFFFFF')
          }
          // 删除按钮文字(保持和批量/单选一致;★ 用 id 定位,不依赖按钮顺序)
          const delBtnEl = editor.ctxMenu.querySelector('#ctx-menu-del')
          if (delBtnEl) delBtnEl.textContent = n > 1 ? ('删除选中(' + n + '条)') : '删除'
          editor.ctxMenu.hidden = false
          const mw = editor.ctxMenu.offsetWidth || 220
          const mh = editor.ctxMenu.offsetHeight || 120
          const x = Math.min(e.clientX, window.innerWidth - mw - 8)
          const y = Math.min(e.clientY, window.innerHeight - mh - 8)
          editor.ctxMenu.style.left = x + 'px'
          editor.ctxMenu.style.top = y + 'px'
        } else {
          // 兜底:若 editor 未初始化前的降级,走 onRowClick(空)
          this.onRowClick(row, e)
        }
      }
    }

    _wireMenus() {
      // 批量操作菜单
      this._batchMenu = document.createElement('div')
      this._batchMenu.className = 'batch-menu'
      this._batchMenu.hidden = true
      // 顶部提示
      const head = document.createElement('div')
      head.className = 'batch-menu-head'
      head.innerHTML = '<span class=\"batch-menu-title\">批量操作</span>'
      this._batchMenu.appendChild(head)
      // 时间
      const row1 = document.createElement('div')
      row1.className = 'ctx-menu-row'
      row1.innerHTML = '<span>时间:</span>'
      const bTimeVal = document.createElement('b')
      bTimeVal.id = 'batch-menu-time'
      const bMinus = this._batchTimeBtn('-')
      const bPlus = this._batchTimeBtn('+')
      row1.appendChild(bMinus)
      row1.appendChild(bTimeVal)
      row1.appendChild(bPlus)
      this._batchMenu.appendChild(row1)
      // 颜色
      const row2 = document.createElement('div')
      row2.className = 'ctx-menu-row'
      row2.innerHTML = '<span>颜色:</span>'
      const bColor = document.createElement('input')
      bColor.type = 'color'
      bColor.id = 'batch-menu-color'
      bColor.addEventListener('input', () => {
        const ids = this._activeIds()
        const col = bColor.value.toUpperCase()
        ids.forEach((id) => {
          const rec = this.store.get(id)
          if (!rec) return
          if (rec.type === 'advanced') this.store.updateDeep(id, 'style.color', col)
          else this.store.update(id, { color: col }, 'color')
        })
      })
      row2.appendChild(bColor)
      // "应用当前(你右击那条弹幕的)颜色"
      const applyCur = document.createElement('button')
      applyCur.textContent = '使用当前颜色'
      applyCur.className = 'ctx-menu-pick'
      applyCur.title = '将所有选中弹幕颜色设置为你右键点击的那条弹幕的颜色'
      applyCur.addEventListener('click', () => {
        const ids = this._activeIds()
        const src = this.store.get(this._lastContextId)
        if (!src) return
        const col = (src.style && src.style.color) ? src.style.color : (src.color || '#FFFFFF')
        const hex = global.ColorUtil.normalizeHex(col, '#FFFFFF')
        bColor.value = hex
        ids.forEach((id) => {
          const rec = this.store.get(id)
          if (!rec) return
          if (rec.type === 'advanced') this.store.updateDeep(id, 'style.color', hex)
          else this.store.update(id, { color: hex }, 'color')
        })
      })
      row2.appendChild(applyCur)
      this._batchMenu.appendChild(row2)
      // 分隔线
      const sep1 = document.createElement('div')
      sep1.className = 'ctx-menu-sep'
      this._batchMenu.appendChild(sep1)
      // 批量选中(舞台框出所有选中弹幕 + 操作手柄)
      const boxBtn = document.createElement('button')
      boxBtn.id = 'batch-menu-box'
      boxBtn.textContent = '批量选中(0条)'
      boxBtn.className = 'batch-btn-box'
      boxBtn.addEventListener('click', () => {
        this._batchMenu.hidden = true
        // ★ 将当前操作集(轻度或深度)提升为深度选择 _batchIds
        const ids = this._activeIds()
        this._batchIds.clear()
        this.addBatchIds(ids)
        this._batchContext = 'deep'
        // ★ 满足深度批量候选(>=2 且全为高级弹幕)→ 进入激活态(舞台批量框 + 批量操作面板);
        //   否则保持轻度选择(舞台无批量框)
        if (this._isDeepCandidate()) {
          this.store.selectRange(Array.from(this._batchIds))
        } else {
          this.store.selectRange(ids)
        }
        this._refreshBatchUI()
      })
      this._batchMenu.appendChild(boxBtn)
      // 删除
      const delBatch = document.createElement('button')
      delBatch.className = 'batch-btn-del'
      delBatch.id = 'batch-menu-del'
      delBatch.textContent = '删除选中(0条)'
      delBatch.addEventListener('click', () => {
        const ids = this._activeIds()
        this._batchMenu.hidden = true
        if (ids.length) {
          // ★ 范围校验:删除前检查是否满足展示范围
          if (!this._validateRangeBeforeDelete(ids)) {
            const app = global.window.App
            const player = app && app.player
            if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
            return
          }
          // removeMany 发 'replace' 事件 → onStore 自动清空 _batchIds 和 selectedIds
          this.store.removeMany(ids)
        }
      })
      this._batchMenu.appendChild(delBatch)
      // ★ 单个操作:「取消当前选择」(把被右键的那 1 条从所有选择集中清除)
      const curSep = document.createElement('div')
      curSep.className = 'ctx-menu-sep'
      this._batchMenu.appendChild(curSep)
      const clearSelBtn = document.createElement('button')
      clearSelBtn.className = 'batch-btn-clear-sel'
      clearSelBtn.id = 'batch-menu-clear-sel'
      clearSelBtn.textContent = '取消当前选择'
      clearSelBtn.title = '把被右键的这 1 条弹幕从当前选择(单选/轻度/深度批量)中移除'
      clearSelBtn.addEventListener('click', () => {
        const id = this._lastContextId
        this._batchMenu.hidden = true
        if (id && typeof this.clearSelectionOf === 'function') {
          this.clearSelectionOf(id)
        }
      })
      this._batchMenu.appendChild(clearSelBtn)
      // ★ 最后一排:「取消所有选择」(清空独立批量集合) —— 与「取消当前选择」之间无分界线
      const clearBatch = document.createElement('button')
      clearBatch.className = 'batch-btn-clear'
      clearBatch.textContent = '取消所有选择'
      clearBatch.title = '清空当前批量选中列表(所有"批量选中(x条)"的 x 归零,但不删除弹幕本身)'
      clearBatch.addEventListener('click', () => {
        this.clearBatchIds()
        this._batchMenu.hidden = true
      })
      this._batchMenu.appendChild(clearBatch)
      // ★ 全选:将列表中所有弹幕设为轻度选择(selectedIds)
      const selectAllBtn = document.createElement('button')
      selectAllBtn.className = 'batch-btn-selectall'
      selectAllBtn.textContent = '全选'
      selectAllBtn.title = '选中列表中所有弹幕(轻度选择)'
      selectAllBtn.addEventListener('click', () => {
        this._batchMenu.hidden = true
        const allIds = this.store.sorted().map((r) => r.id)
        if (!allIds.length) return
        this.store.selectedIds = new Set(allIds)
        this.store.selectedId = allIds[0]
        this.store._emit('select', allIds[0], null)
      })
      this._batchMenu.appendChild(selectAllBtn)
      document.body.appendChild(this._batchMenu)
      document.addEventListener('click', (ev) => {
        if (!ev.target.closest('.batch-menu')) this._batchMenu.hidden = true
      })
    }

    /**
     * ★ 把一个 id 从独立批量集合 _batchIds 中切换(有就删,没有就加)。
     * 用于 Ctrl + 单击行 toggle 选中时同步到批量集合。
     */
    toggleBatchId(id) {
      if (!id) return
      if (this._batchIds.has(id)) this._batchIds.delete(id)
      else this._batchIds.add(id)
      this._refreshBatchUI()
    }

    /** ★ 把一批 ids 合并进 _batchIds(去重,不替换)。 */
    addBatchIds(ids) {
      if (!ids || !ids.length) return
      ids.forEach((id) => id && this._batchIds.add(id))
      this._refreshBatchUI()
    }

    /** ★ 清空所有选择:深度选择 _batchIds + 轻度选择 selectedIds(「取消所有选择」按钮触发)。
     *  未开 autoSave 且有批量改动时一并回滚。*/
    clearBatchIds() {
      const rolled = this.store.exitBatch ? this.store.exitBatch() : 0
      this._batchIds.clear()
      this._batchContext = null
      this.store.deselect()
      this._refreshBatchUI()
      if (rolled > 0) {
        const app = global.window.App
        const player = app && app.player
        if (player) player.toast('已取消所有选择,未保存的批量改动已回滚(' + rolled + '条)')
      }
    }

    /** ★ Ctrl+A(或菜单全选):把当前展示中的所有弹幕(筛选+范围切片后的集)设为轻度选择(selectedIds)。
     * 注:这里不选「弹幕池总量」,只选"当前展示中的",以便与「当前弹幕池」窗口一致。
     * ★ 深度批量选择集合(_batchIds)不受全选影响:全选属于轻度选择(批量偏离态),
     *   之前的深度批量集合保留 —— 之后单选/取消选择或点击舞台批量框都可跳回深度批量激活态。*/
    selectAllShowing() {
      const rows = Array.isArray(this._filteredAndRanged) ? this._filteredAndRanged() : this._filteredAndRanged()
      const recs = rows || []
      if (!recs.length) return
      const ids = recs.map((r) => r.id).filter(Boolean)
      if (!ids.length) return
      this._batchContext = 'light'
      this.store.selectRange(ids)
      this._refreshBatchUI()
    }

    /** ★ 刷新所有展示:批量行高亮类、批量按钮数字、批量舞台框出。 */
    _refreshBatchUI() {
      // 1. 批量行高亮(通过 _applySelection 统一刷 selected + batch-selected)
      const set = this.store.selectedIds
      // ★ multi-select 仅表示"真·多选"(selectedIds.size !== 1);
      //   深度选择(_batchIds)通过 batch-selected 类独立呈现背景加深,不影响描边框显隐。
      //   这样单击深度选择中的某条弹幕时,selectedIds.size === 1,描边框能正常显示。
      this.body.classList.toggle('multi-select', set.size !== 1)
      const rows = this.body.querySelectorAll('.list-row')
      rows.forEach((row) => {
        const rid = row.dataset.id
        const inSel = set.has(rid)
        const inBatch = this._batchIds.has(rid)
        // ★ 描边框只在 selectedIds 中的单条显示;_batchIds 中的行只显示背景色,不显示描边框
        // 故仅在 inSel 时加 'selected',inBatch 时加 'batch-selected'(提供加深背景)
        row.classList.toggle('selected', inSel)
        row.classList.toggle('batch-selected', inBatch)
      })
      // 2. 主面板「删除选中」按钮数字(主按钮仍用 selectedIds 语义)
      if (this.delSelBtn) {
        const n = set.size
        this.delSelBtn.disabled = n === 0
        // ★ 空列表时隐藏(replace/clear 后 selectedIds 已清空但按钮曾残留可见)
        this.delSelBtn.hidden = n < 2 || this.store.comments.length === 0
        this.delSelBtn.textContent = '删除选中(' + n + ')'
      }
      // 3. 批量菜单已打开时同步刷新菜单里的数字
      if (this._batchMenu && !this._batchMenu.hidden) {
        this._updateBatchTime()
      }
      // 4. ★ 舞台批量框统一由 overlay.js 的 SVG 绘制(深度批量态自动显示),此处不再维护 DOM 框
    }

    /**
     * ★ 返回当前批量菜单的操作集(由 _batchContext 决定,两种选择互不混淆):
     *   'deep'  → 深度选择 _batchIds
     *   'light' → 轻度选择 selectedIds
     *   null    → 默认:深度选择优先,否则回退 selectedIds
     */
    _activeIds() {
      let src
      if (this._batchContext === 'deep') src = this._batchIds
      else if (this._batchContext === 'light') src = this.store.selectedIds
      else src = this._batchIds.size > 0 ? this._batchIds : this.store.selectedIds
      return Array.from(src).slice(0, MAX_BATCH)
    }

    _batchTimeBtn(sign) {
      const b = document.createElement('button')
      b.textContent = sign === '-' ? '◀' : '▶'
      let timer = null
      const step = (e) => {
        const ids = this._activeIds()
        if (!ids.length) return
        const delta = e.ctrlKey ? 1 : 0.1
        const delta2 = sign === '-' ? -delta : delta
        ids.forEach((id) => {
          const rec = this.store.get(id)
          if (!rec) return
          const t = Math.max(0, Math.round((rec.timeSec + delta2) * 100) / 100)
          this.store.update(id, { timeSec: t }, 'timeSec')
        })
        this._updateBatchTime()
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

    _updateBatchTime() {
      const el = document.getElementById('batch-menu-time')
      const src = this.store.get(this._lastContextId)
      if (el && src) el.textContent = global.TimeUtil.timeToStrPrecise(src.timeSec)
      const delEl = document.getElementById('batch-menu-del')
      const boxEl = document.getElementById('batch-menu-box')
      // ★ 按钮数字读当前上下文操作集(deep→_batchIds.size, light→selectedIds.size)
      const n = this._activeIds().length
      const limit = Math.min(n, MAX_BATCH)
      if (delEl) delEl.textContent = '删除选中(' + limit + '条)'
      if (boxEl) boxEl.textContent = '批量选中(' + limit + '条)'
    }

    _showBatchMenu(id, x, y) {
      const rec = this.store.get(id)
      if (!rec) return
      // ★ 按钮数字读当前上下文操作集(deep→_batchIds, light→selectedIds)
      const n = this._activeIds().length
      if (n > MAX_BATCH) {
        const app = global.window.App
        if (app && app.player) {
          app.player.toast('批量操作最多选取 ' + MAX_BATCH + ' 条,已自动截断前 ' + MAX_BATCH + ' 条')
        }
      }
      const timeVal = document.getElementById('batch-menu-time')
      if (timeVal) timeVal.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec)
      const colInput = document.getElementById('batch-menu-color')
      if (colInput) {
        const col = (rec.style && rec.style.color) ? rec.style.color : (rec.color || '#FFFFFF')
        colInput.value = global.ColorUtil.normalizeHex(col, '#FFFFFF')
      }
      const limit = Math.min(n, MAX_BATCH)
      const delEl = document.getElementById('batch-menu-del')
      if (delEl) delEl.textContent = '删除选中(' + limit + '条)'
      const boxEl = document.getElementById('batch-menu-box')
      if (boxEl) boxEl.textContent = '批量选中(' + limit + '条)'
      this._batchMenu.hidden = false
      const mw = this._batchMenu.offsetWidth || 240
      const mh = this._batchMenu.offsetHeight || 240
      const mx = Math.min(x, window.innerWidth - mw - 8)
      const my = Math.min(y, window.innerHeight - mh - 8)
      this._batchMenu.style.left = mx + 'px'
      this._batchMenu.style.top = my + 'px'
    }

    /** 构建舞台批量框:已废弃 —— 舞台批量框统一由 overlay.js 的 SVG(_renderBatch)绘制与跟随,
     *  避免双重框叠加/残影(旧 .batch-stage-box DOM 框已移除)。 */

    _stageRect() {
      const stageWrap = document.getElementById('stage-wrap')
      return stageWrap ? stageWrap.getBoundingClientRect() : { left: 0, top: 0 }
    }

    _batchMvStart(e) {
      const stageRect = this._stageRect()
      const startX = e.clientX
      const startY = e.clientY
      const ids = this._activeIds()
      // 记录每个 id 的起始单位坐标(pixel 或 percent 保留)
      const starts = new Map()
      ids.forEach((id) => {
        const rec = this.store.get(id)
        if (!rec) return
        if (rec.type === 'advanced' && rec.position) {
          starts.set(id, {
            mode: 'adv',
            usePercent: !!rec.position.usePercent,
            sx: rec.position.startX, sy: rec.position.startY,
            ex: rec.position.endX, ey: rec.position.endY,
          })
        } else if (rec.type === 'normal') {
          // 普通弹幕:平移时间
          starts.set(id, { mode: 'normal', timeSec: rec.timeSec })
        }
      })
      const W = (global.window.App && global.window.App.engine) ? global.window.App.engine.width : 960
      const H = (global.window.App && global.window.App.engine) ? global.window.App.engine.height : 540
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
      const round2 = (n) => Math.round(n * 100) / 100
      const onMove = (ev) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        ids.forEach((id) => {
          const s = starts.get(id)
          if (!s) return
          const rec = this.store.get(id)
          if (!rec) return
          if (s.mode === 'adv') {
            let dxu, dyu
            if (s.usePercent) {
              dxu = W > 0 ? dx / W : 0; dyu = H > 0 ? dy / H : 0
            } else {
              dxu = dx; dyu = dy
            }
            const nsx = s.usePercent ? clamp(round2(s.sx + dxu), 0, 0.99) : clamp(Math.round((s.sx + dxu) * 10) / 10, 0, 9999)
            const nsy = s.usePercent ? clamp(round2(s.sy + dyu), 0, 0.99) : clamp(Math.round((s.sy + dyu) * 10) / 10, 0, 9999)
            const nex = s.usePercent ? clamp(round2(s.ex + dxu), 0, 0.99) : clamp(Math.round((s.ex + dxu) * 10) / 10, 0, 9999)
            const ney = s.usePercent ? clamp(round2(s.ey + dxu), 0, 0.99) : clamp(Math.round((s.ey + dyu) * 10) / 10, 0, 9999)
            this.store.update(rec.id, {
              position: Object.assign({}, rec.position, {
                startX: nsx, startY: nsy, endX: nex, endY: ney,
              })
            }, 'position')
          } else if (s.mode === 'normal') {
            const dsec = dx * 0.005
            const nt = Math.max(0, Math.round((s.timeSec + dsec) * 100) / 100)
            this.store.update(rec.id, { timeSec: nt }, 'timeSec')
          }
        })
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    /** ★ 深度批量集合是否满足「纯高级弹幕」候选条件(>=2 且全部高级且非草稿)。
     *  满足 = 舞台显示批量选择框(overlay),面板可显示批量操作面板;
     *  是否处于「激活态」(selectedIds 与 _batchIds 一致)另见 store.isDeepBatchAdvanced()。*/
    _isDeepCandidate() {
      if (this._batchIds.size < 2) return false
      for (const id of this._batchIds) {
        const r = this.store.get(id)
        if (!r || r.type !== 'advanced' || r === this.store.draft) return false
      }
      return true
    }

    /** ★ 深度批量选择的核心切换(Ctrl+单击 / 批量内取消):
     *  - toggle _batchIds 中的 id
     *  - 仍满足深度批量条件 → selectRange(_batchIds) 进入/保持激活态(merge 快照)
     *  - 之前满足现在不满足:
     *      · 若是「移除」操作(hadId=true)→ exitBatch 回滚 + 清空选择(直接未选择状态)
     *      · 若是「新增」操作(hadId=false)→ 不退出,仅同步 selectedIds(允许暂时混入普通弹幕)
     *  - 一直不满足(构建中)→ selectedIds 同步 _batchIds(普通 Ctrl 多选行为) */
    _deepToggle(id) {
      if (!id) return
      const wasSatisfied = this._isDeepCandidate()
      const hadId = this._batchIds.has(id)
      if (hadId) this._batchIds.delete(id)
      else this._batchIds.add(id)
      const nowSatisfied = this._isDeepCandidate()
      if (nowSatisfied) {
        this.store.selectRange(Array.from(this._batchIds))
      } else if (wasSatisfied && hadId) {
        // ★ 退出深度批量态:仅在「移除」操作导致不满足时才回滚+清空
        const rolled = this.store.exitBatch ? this.store.exitBatch() : 0
        this._batchIds.clear()
        this._batchContext = null
        this.store.deselect()
        if (rolled > 0) {
          const app = global.window.App
          const player = app && app.player
          if (player) player.toast('已取消深度批量选择,未保存的批量改动已回滚(' + rolled + '条)')
        }
      } else {
        // 构建中(0/1 条或含普通弹幕) 或 新增导致不满足:selectedIds 与 _batchIds 同步
        this.store.selectRange(Array.from(this._batchIds))
      }
      this._refreshBatchUI()
    }

    /** ★ 把指定弹幕的选择状态彻底清除(右键菜单「取消当前选择」):
     *  从 _batchIds 与 selectedIds 中移除该 id;若深度批量集合因此不再满足(从满足降级),
     *  则整体清空 + 回滚(与 Ctrl+单击取消语义一致)。*/
    clearSelectionOf(id) {
      if (!id) return
      if (!this._batchIds.has(id) && !this.store.selectedIds.has(id)) return
      const wasSatisfied = this._isDeepCandidate()
      if (this._batchIds.has(id)) {
        this._batchIds.delete(id)
        const nowSatisfied = this._isDeepCandidate()
        if (wasSatisfied && !nowSatisfied) {
          const rolled = this.store.exitBatch ? this.store.exitBatch() : 0
          this._batchIds.clear()
          this._batchContext = null
          this.store.deselect()
          if (rolled > 0) {
            const app = global.window.App
            const player = app && app.player
            if (player) player.toast('已取消深度批量选择,未保存的批量改动已回滚(' + rolled + '条)')
          }
          this._refreshBatchUI()
          return
        }
        if (nowSatisfied) {
          this.store.selectRange(Array.from(this._batchIds))
        } else {
          this.store.selectRange(Array.from(this._batchIds))
        }
      } else {
        // 不在深度集合中:仅从当前选择中移除(单选 → 未选择;轻度多选 → 移除该项)
        if (this.store.selectedIds.size <= 1) {
          this.store.deselect()
        } else {
          const rest = Array.from(this.store.selectedIds).filter((i) => i !== id)
          this.store.selectRange(rest)
        }
      }
      this._refreshBatchUI()
    }

    /** 行 mousedown:开始拖拽选择 / Ctrl 多选 / 单击 toggle 选中。 */
    onRowMouseDown(row, e) {
      e.preventDefault()
      const idx = Array.prototype.indexOf.call(this.body.children, row)
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey
      const id = row.dataset.id
      this._selDrag = { anchorIdx: idx, ctrl: ctrl, moved: false, anchorInBatch: this._batchIds.has(id) }
      if (ctrl) {
        // ★ Ctrl+单击:深度批量选择核心入口(_batchIds + selectedIds 同步管理)
        this._deepToggle(id)
      } else {
        // ★ 深度批量激活态下的普通单击:切换为单选该弹幕(进入"批量偏离态"),
        //   深度批量集合 _batchIds 保留(舞台批量框仍显示,面板显示"批量操作中"但隐藏批量操作面板);
        //   点击舞台批量框或取消单选可跳回批量激活态。
        if (this.store.selectedId === id && this.store.selectedIds.size === 1) {
          this.store.deselect()
        } else {
          this.store.select(id)
        }
        // ★ 非深度批量候选时,普通单击单选意味着放弃残留的批量集合(清空避免后续 Ctrl 合并误伤)
        if (!this._isDeepCandidate()) this._batchIds.clear()
      }
      document.addEventListener('mousemove', this._onSelMove)
      document.addEventListener('mouseup', this._onSelUp)
    }

    _handleSelMove(e) {
      const d = this._selDrag
      if (!d) return
      d.lastX = e.clientX
      d.lastY = e.clientY
      const rect = this.body.getBoundingClientRect()
      const y = e.clientY

      // ★ 鼠标移出 div 外面时自动滚动(上方或下方)
      if (y < rect.top && this.body.scrollTop > 0) {
        this._autoScrollDir = -1
        this._startAutoScroll()
      } else if (y > rect.bottom && this.body.scrollTop + this.body.clientHeight < this.body.scrollHeight) {
        this._autoScrollDir = 1
        this._startAutoScroll()
      } else {
        this._autoScrollDir = 0
      }

      this._updateSelFromHover()
    }

    _startAutoScroll() {
      if (this._autoScrollRAF != null) return
      this._autoScrollSpeed = 0
      const step = () => {
        if (!this._selDrag) {
          this._autoScrollRAF = null
          return
        }
        const rect = this.body.getBoundingClientRect()
        const y = this._selDrag.lastY != null ? this._selDrag.lastY : rect.top + rect.height / 2
        let targetSpeed = 0
        let curDir = this._autoScrollDir

        // ★ 鼠标在 div 上方/外面:向上滚动;在下方/外面:向下滚动
        //   速度从 0 开始加速:距离 div 越远,目标速度越大(1~8px/帧)
        if (y < rect.top && this.body.scrollTop > 0) {
          curDir = -1
          const dist = Math.max(0, rect.top - y)
          targetSpeed = Math.min(8, 1 + dist * 0.15)
        } else if (y > rect.bottom && this.body.scrollTop + this.body.clientHeight < this.body.scrollHeight) {
          curDir = 1
          const dist = Math.max(0, y - rect.bottom)
          targetSpeed = Math.min(8, 1 + dist * 0.15)
        } else {
          curDir = 0
        }
        this._autoScrollDir = curDir

        if (curDir === 0) {
          // ★ 鼠标回到 div 内:速度逐渐衰减(摩擦)
          this._autoScrollSpeed *= 0.85
          if (this._autoScrollSpeed < 0.5) {
            this._stopAutoScroll()
            return
          }
        } else {
          // ★ 速度从 0 开始加速,逐渐逼近目标速度
          this._autoScrollSpeed += (targetSpeed - this._autoScrollSpeed) * 0.12
        }

        this.body.scrollTop += curDir * this._autoScrollSpeed
        this._updateSelFromHover()
        this._autoScrollRAF = requestAnimationFrame(step)
      }
      this._autoScrollRAF = requestAnimationFrame(step)
    }

    _stopAutoScroll() {
      if (this._autoScrollRAF != null) {
        cancelAnimationFrame(this._autoScrollRAF)
        this._autoScrollRAF = null
      }
      this._autoScrollDir = 0
    }

    _updateSelFromHover() {
      const d = this._selDrag
      if (!d) return
      const x = d.lastX != null ? d.lastX : 0
      const y = d.lastY != null ? d.lastY : 0
      const el = document.elementFromPoint(x, y)
      const row = el && el.closest ? el.closest('.list-row') : null
      let curIdx
      if (!row) {
        const visibleRows = this._visibleRows()
        if (!visibleRows.length) return
        const lastVisible = this._autoScrollDir < 0 ? visibleRows[0] : visibleRows[visibleRows.length - 1]
        curIdx = Array.prototype.indexOf.call(this.body.children, lastVisible)
        if (curIdx < 0) return
      } else {
        curIdx = Array.prototype.indexOf.call(this.body.children, row)
      }
      if (Math.abs(curIdx - d.anchorIdx) > 0) d.moved = true
      const lo = Math.min(d.anchorIdx, curIdx)
      const hi = Math.max(d.anchorIdx, curIdx)
      const ids = Array.from(this.body.children)
        .slice(lo, hi + 1)
        .map((r) => r.dataset.id)
      if (d.ctrl) {
        // ★ Ctrl 拖选:范围合入深度批量集合;若形成深度批量候选(全高级>=2)直接进入激活态
        ids.forEach((id) => id && this._batchIds.add(id))
        if (this._isDeepCandidate()) {
          this.store.selectRange(Array.from(this._batchIds))
        } else {
          const set = new Set(this.store.selectedIds)
          ids.forEach((id) => set.add(id))
          this.store.selectRange(Array.from(set))
        }
      } else {
        // ★ 拖选(无Ctrl):轻度选择;非深度候选时清掉残留批量集合(深度候选保留 → 偏离态)
        if (!this._isDeepCandidate()) this._batchIds.clear()
        this.store.selectRange(ids)
      }
    }

    _visibleRows() {
      const rect = this.body.getBoundingClientRect()
      const rows = Array.from(this.body.children)
      return rows.filter((r) => {
        const rr = r.getBoundingClientRect()
        return rr.bottom >= rect.top && rr.top <= rect.bottom
      })
    }

    _endSelDrag() {
      this._stopAutoScroll()
      document.removeEventListener('mousemove', this._onSelMove)
      document.removeEventListener('mouseup', this._onSelUp)
      this._selDrag = null
    }

    onStore(evt, id, field) {
      switch (evt) {
        case 'replace':
        case 'clear':
          this._batchIds.clear()
          this._batchContext = null
          this.render()
          this._refreshBatchUI()
          // ★ 同步刷新「当前弹幕池」总览窗口:addMany/appendMany/removeMany/clear 均触发 replace 事件
          this._renderPoolInfo()
          this._renderPoolList()
          break
        case 'add':
          this._insertRow(id)
          // ★ 新增后同步更新左上角计数 (x/sum):x 与 sum 一起 +1(无筛选时)
          this._updateCount()
          // ★ 单条添加(普通/高级/脚本发送)后:同步刷新当前弹幕池窗口计数与列表(修复"新增后池里看不到"的bug)
          this._renderPoolInfo()
          this._renderPoolList()
          break
        case 'remove':
          this._removeRow(id)
          this._updateCount()
          // 删除弹幕时同步清理独立批量集合中的幽灵 id
          if (id) this._batchIds.delete(id)
          this._refreshBatchUI()
          // ★ 删除后同步刷新弹幕池窗口
          this._renderPoolInfo()
          this._renderPoolList()
          break
        case 'removeMany':
          this.render()
          // ★ 批量删除后同步刷新弹幕池窗口
          this._renderPoolInfo()
          this._renderPoolList()
          break
        case 'select':
          // ★ 深度批量恢复:selectedIds 被清空(deselect/点空白)但深度批量集合仍满足候选条件
          //   → 自动恢复深度批量激活态(跳回批量操作面板;这也是"取消单选/轻度多选回到批量面板"的入口)
          if (!this.store.selectedIds.size && this._isDeepCandidate()) {
            this.store.selectRange(Array.from(this._batchIds))
            break // selectRange 会再次触发 select 事件(非空),走正常刷新
          }
          this._applySelection(id)
          this._refreshBatchUI()
          break
        case 'change':
          if (field === 'timeSec' || field === 'type' || field === null) {
            this._moveRow(id)
          } else {
            this._updateRow(id)
          }
          // ★ 字段变化(包括内容/颜色/字号等)后也重绘当前弹幕池,保证池内显示的数据是最新的
          this._renderPoolList()
          break
      }
    }

    _updateCount() {
      const total = this.store.count()
      if (!total) { this.countEl.textContent = ''; return }
      // 若有任何筛选或范围限制:显示 "目前展示中的弹幕量/弹幕池总量"
      const hasFilter =
        this._filters.text ||
        this._filters.timeFrom != null ||
        this._filters.timeTo != null ||
        this._filters.type !== 'all' ||
        this._filters.subtype !== 'all' ||
        this._filters.sender
      const hasRange = this._range.start > 0 || this._range.end !== Infinity
      if (hasFilter || hasRange) {
        const show = this._filteredAndRanged().length
        this.countEl.textContent = '(' + show + '/' + total + ')'
      } else {
        this.countEl.textContent = '(' + total + ')'
      }
    }

    render() {
      // ★ C5:重建行前保存 scrollTop,重建后恢复(Ctrl+深度选择/取消触发 render 时不再跳动)
      const savedScroll = this.body.scrollTop
      this.body.innerHTML = ''
      this._rows.clear()
      const count = this.store.count()
      this._updateCount()
      if (!count) {
        const empty = document.createElement('div')
        empty.className = 'list-empty'
        const player = global.window.App && global.window.App.player
        const videoName = player && player.getVideoName()
        if (videoName) {
          empty.textContent = '未找到与视频同名的弹幕文件,可手动载入弹幕。'
          const btn = document.createElement('button')
          btn.className = 'list-empty-btn'
          btn.textContent = '打开弹幕'
          btn.addEventListener('click', () => {
            const c = global.window.App && global.window.App.controls
            if (c && c.openDanmakuDialog) c.openDanmakuDialog()
          })
          empty.appendChild(document.createElement('br'))
          empty.appendChild(btn)
        } else {
          empty.textContent = '暂无弹幕,点击「＋ 普通 / ＋ 高级」新增,或导入 XML / ASS'
        }
        this.body.appendChild(empty)
        return
      }
      for (const rec of this._filteredAndRanged()) {
        const row = createRow(rec, this.store, this)
        this.body.appendChild(row)
        this._rows.set(rec.id, row)
      }
      this._applySelection(this.store.selectedId)
      // ★ C5:恢复滚动位置(避免 render 重建行后跳到顶部)
      if (this.body.scrollHeight >= this.body.clientHeight) this.body.scrollTop = savedScroll
    }

    /** 按搜索/筛选过滤。★ 固定展示弹幕始终通过筛选(不受过滤限制)。 */
    _filtered() {
      const f = this._filters
      const list = this.store.sorted()
      const pinnedSet = this._pinnedSourceIds
      if (!f.text && f.timeFrom == null && f.timeTo == null && f.type === 'all' && f.subtype === 'all' && !f.sender) {
        return list
      }
      const text = f.text.toLowerCase()
      const sender = (f.sender || '').toLowerCase()
      const result = []
      for (const rec of list) {
        // ★ 固定展示弹幕:始终包含(跳过所有筛选)
        if (pinnedSet.has(rec.id)) { result.push(rec); continue }
        if (text && !(rec.content || '').toLowerCase().includes(text)) continue
        if (f.timeFrom != null && rec.timeSec < f.timeFrom) continue
        if (f.timeTo != null && rec.timeSec > f.timeTo) continue
        if (f.type !== 'all' && rec.type !== f.type) continue
        if (f.subtype !== 'all') {
          if (rec.type !== 'normal') continue
          if (rec.mode !== f.subtype) continue
        }
        if (sender && !(rec.sender || '').toLowerCase().includes(sender)) continue
        result.push(rec)
      }
      return result
    }

    /** ★ 先 _filtered,再按 this._range 截取 [start, end)。
     *   ★ 固定展示弹幕始终包含(即使在范围外),去重。*/
    _filteredAndRanged() {
      const arr = this._filtered()
      const s = Math.max(0, Math.floor(Number(this._range.start) || 0))
      const eRaw = this._range.end === Infinity ? arr.length : Math.floor(Number(this._range.end))
      const e = Math.min(arr.length, Math.max(0, eRaw))
      const pinnedSet = this._pinnedSourceIds
      if (s === 0 && e >= arr.length) return arr
      const ranged = arr.slice(s, e)
      // ★ 固定展示弹幕:始终在结果中;去重(若已在范围内则不重复添加)
      if (pinnedSet.size) {
        const existingIds = new Set(ranged.map((r) => r.id))
        for (const rec of arr) {
          if (pinnedSet.has(rec.id) && !existingIds.has(rec.id)) {
            ranged.push(rec)
            existingIds.add(rec.id)
          }
        }
      }
      return ranged
    }

    /** 返回过滤+范围后的 rec 数组;对外暴露给 controls 用(保存展示中 / 8000 阈值提示)。 */
    getShowingRecs() { return this._filteredAndRanged() }

    /** 搜索框 + 高级筛选绑定。 */
    _wireSearch() {
      const input = document.getElementById('list-search-input')
      if (!input) return
      input.addEventListener('input', () => {
        this._filters.text = input.value
        this.render()
      })
      const filterBtn = document.getElementById('list-search-filter')
      filterBtn.addEventListener('click', () => {
        const panel = document.getElementById('list-filter-panel')
        panel.hidden = !panel.hidden
        filterBtn.classList.toggle('active', !panel.hidden)
      })
      const bind = (id, key, parse) => {
        const el = document.getElementById(id)
        el.addEventListener('change', () => {
          const v = el.value
          this._filters[key] = parse ? parse(v) : v
          this.render()
        })
      }
      bind('lf-time-from', 'timeFrom', (v) => (v === '' ? null : parseFloat(v)))
      bind('lf-time-to', 'timeTo', (v) => (v === '' ? null : parseFloat(v)))
      bind('lf-type', 'type')
      bind('lf-subtype', 'subtype')
      bind('lf-sender', 'sender')
      document.getElementById('lf-clear').addEventListener('click', () => {
        this._filters = { text: '', timeFrom: null, timeTo: null, type: 'all', subtype: 'all', sender: '' }
        input.value = ''
        document.getElementById('lf-time-from').value = ''
        document.getElementById('lf-time-to').value = ''
        document.getElementById('lf-type').value = 'all'
        document.getElementById('lf-subtype').value = 'all'
        document.getElementById('lf-sender').value = ''
        this.render()
      })
    }

    _insertRow(id) {
      const rec = this.store.get(id)
      if (!rec) return
      // ★ 清除空列表提示(.list-empty),避免添加弹幕后空提示仍然显示
      const emptyEl = this.body.querySelector('.list-empty')
      if (emptyEl) emptyEl.remove()
      const row = createRow(rec, this.store, this)
      let anchor = null
      for (const el of this.body.children) {
        const t = parseFloat(el.dataset.time)
        const otherId = el.dataset.id
        if (rec.timeSec < t || (rec.timeSec === t && String(id) < otherId)) break
        anchor = el
      }
      if (anchor) this.body.insertBefore(row, anchor.nextSibling)
      else this.body.insertBefore(row, this.body.firstChild)
      this._rows.set(id, row)
      this._updateCount()
      this._applySelection(id)
    }

    _removeRow(id) {
      const row = this._rows.get(id)
      if (row) row.remove()
      this._rows.delete(id)
    }

    _moveRow(id) {
      const row = this._rows.get(id)
      const rec = this.store.get(id)
      if (row && rec) {
        row.remove()
        this._rows.delete(id)
        this._insertRow(id)
      } else {
        this.render()
      }
    }

    /** 原位更新单行内容/徽标,不重建列表,避免滚动。 */
    _updateRow(id) {
      const rec = this.store.get(id)
      const row = this._rows.get(id)
      if (!rec || !row) {
        this.render()
        return
      }
      const contentEl = row.querySelector('.list-content')
      const badgeEl = row.querySelector('.list-badge')
      const timeEl = row.querySelector('.list-time')
      if (contentEl) {
        contentEl.textContent = rec.content || '(空)'
        contentEl.title = rec.content || ''
      }
      if (badgeEl) {
        badgeEl.className = 'list-badge ' + (rec.type === 'advanced' ? 'advanced' : 'normal')
        badgeEl.textContent = rec.type === 'advanced' ? '高级' : '普通'
      }
      if (timeEl) timeEl.textContent = global.TimeUtil.fmtClockExact(rec.timeSec)
      row.dataset.time = String(rec.timeSec)
    }

    _applySelection(id) {
      const set = this.store.selectedIds
      // ★ multi-select 仅表示"真·多选";深度选择不影响描边框显隐
      this.body.classList.toggle('multi-select', set.size !== 1)
      for (const row of this._rows.values()) {
        row.classList.toggle('selected', set.has(row.dataset.id))
      }
      if (this.delSelBtn) {
        const n = set.size
        // ★ 空列表(无任何弹幕)时强制隐藏,防止残留 selectedIds/旧计数让按钮出现
        this.delSelBtn.hidden = n < 2 || this.store.comments.length === 0
        this.delSelBtn.textContent = '删除选中(' + n + ')'
      }
      // ★ C5:仅「单选且 selectedId 真正改变」时滚动到选中行;
      //   Ctrl 多选/深度批量操作时(set.size !== 1 或 id 未变)不跳动,保持用户当前滚动位置
      const selRow = id != null ? this._rows.get(id) : null
      if (selRow && set.size === 1 && this._lastScrolledSelId !== id && this.body.scrollHeight > this.body.clientHeight) {
        this._lastScrolledSelId = id
        selRow.scrollIntoView({ block: 'nearest' })
      }
    }

    // =================================================================
    // ★ 当前弹幕池(总览窗口):范围/筛选/跳转/显示格式
    // =================================================================

    /** 打开当前弹幕池总览窗口(并初始化控件/渲染)。 */
    openPoolOverview() {
      const root = document.getElementById('danmaku-pool')
      if (!root) return
      root.hidden = false
      // 用当前筛选/范围初始化控件
      this._syncPoolControlsFromState()
      // 初始化「展示列」复选框与当前偏好一致
      this._syncColsCheckboxFromState()
      this._renderPoolInfo()
      this._renderPoolList()
    }

    closePoolOverview() {
      const root = document.getElementById('danmaku-pool')
      if (root) root.hidden = true
      // ★ 关闭时清空弹幕池多选 + 隐藏右键菜单 + 重置按钮 active 状态
      this._poolSelectedIds.clear()
      this._hidePoolCtxMenu()
      const colsBtn = document.getElementById('dp-columns')
      const fOpen = document.getElementById('dp-filter-open')
      if (colsBtn) colsBtn.classList.remove('active')
      if (fOpen) fOpen.classList.remove('active')
      // ★ 关闭时终止拖拽 + 停止自动滚动
      this._endPoolDrag()
    }

    /** 把当前 _filters / _range 同步到总览窗口的输入控件上(每次打开或应用筛选后调用)。 */
    _syncPoolControlsFromState() {
      const $ = (id) => document.getElementById(id)
      const text = $('dp-f-text'), fFrom = $('dp-f-from'), fTo = $('dp-f-to')
      const fType = $('dp-f-type'), fSubtype = $('dp-f-subtype'), fSender = $('dp-f-sender')
      if (text) text.value = this._filters.text
      if (fFrom) fFrom.value = this._filters.timeFrom != null ? this._filters.timeFrom : ''
      if (fTo) fTo.value = this._filters.timeTo != null ? this._filters.timeTo : ''
      if (fType) fType.value = this._filters.type
      if (fSubtype) fSubtype.value = this._filters.subtype
      if (fSender) fSender.value = this._filters.sender
      const rStart = $('dp-range-start'), rEnd = $('dp-range-end')
      if (rStart) rStart.value = this._range.start > 0 ? this._range.start : 0
      if (rEnd) rEnd.value = this._range.end === Infinity ? '' : this._range.end
    }

    /** 顶栏信息(目前展示中的弹幕量/弹幕池总量,以及 >8000 的警告)。 */
    _renderPoolInfo() {
      const info = document.getElementById('dp-info')
      if (!info) return
      const total = this.store.count()
      const show = this._filteredAndRanged().length
      const pinnedN = this._pinnedSourceIds.size
      // ★ pinned 记录已包含在 total 中(不拷贝),无需额外去重
      //   show 可能不包含被筛选掉的 pinned 记录,但舞台上它们仍会展示
      const pinPart = pinnedN > 0 ? ' (含固定' + pinnedN + ')' : ''
      const warn = show > 8000
        ? '<span class="dp-warn">⚠ 当前展示中弹幕量 &gt; 8000,直接运行可能卡顿,建议调整范围/筛选</span>'
        : ''
      info.innerHTML =
        '<span>目前展示:</span>' +
        '<span class="dp-count">' + show + ' / ' + total + pinPart + '</span>' +
        warn
    }

    /** 渲染固定展示弹幕到主表格 tbody 顶部(共用列标签,可展开/收纳)。 */
    _renderPinnedList(tbody, headTr) {
      const n = this._pinnedSourceIds.size
      if (n <= 0) return

      // 从 store 获取被固定的记录
      const pinnedRecs = []
      for (const id of this._pinnedSourceIds) {
        const rec = this.store.get(id)
        if (rec) pinnedRecs.push(rec)
      }
      if (!pinnedRecs.length) return

      // 按 timeSec 排序
      pinnedRecs.sort((a, b) => {
        const at = Number.isFinite(a.timeSec) ? a.timeSec : 0
        const bt = Number.isFinite(b.timeSec) ? b.timeSec : 0
        return at - bt
      })

      const collapsed = !!this._pinnedCollapsed
      const arrow = collapsed ? '▶' : '▼'
      const titleText = n === 1 ? '固定展示弹幕' : ('固定展示弹幕(' + n + '个)')
      const self = this
      const colSpan = headTr ? headTr.children.length : 7

      // ★ 固定展示标题行(可点击收纳/展开,共用主表格列标签)
      const headerTr = document.createElement('tr')
      headerTr.className = 'dp-pinned-header'
      // ★ 标题行:外框线 #C0A050,收纳态底框闭合、展开态去掉底框和行框衔接
      headerTr.style.cssText = 'cursor:pointer;background:#252016;border:2px solid #C0A050;' +
        (collapsed ? '' : 'border-bottom:none;')
      const headerTd = document.createElement('td')
      headerTd.colSpan = colSpan
      headerTd.style.cssText = 'padding:6px 10px;'
      headerTd.innerHTML =
        '<span class="dp-pinned-header-inner" style="display:inline-flex;align-items:center;gap:8px;width:100%;">' +
          '<span style="display:inline-flex;align-items:center;gap:6px;">' +
            '<span style="color:#f5a623;">★</span>' +
            '<span class="dp-pinned-title" style="font-weight:600;color:#c0a050;">' + this._escHtml(titleText) + '</span>' +
            '<span style="font-size:11px;color:#8a7040;">(优先展示,不受筛选/范围影响)</span>' +
          '</span>' +
          '<span style="display:inline-flex;align-items:center;gap:6px;margin-left:auto;">' +
            '<button type="button" class="fd-btn dp-pinned-collapse-btn" style="padding:2px 8px;font-size:12px;min-width:auto;height:auto;line-height:1.6;">' + (collapsed ? '展开全部 ' : '收纳 ') + arrow + '</button>' +
            '<button type="button" class="fd-btn dp-pinned-clear-btn" style="padding:2px 8px;font-size:12px;min-width:auto;height:auto;line-height:1.6;color:#c09050;">全部移出</button>' +
          '</span>' +
        '</span>'

      // 点击标题行收纳/展开
      headerTd.addEventListener('click', (e) => {
        if (e.target.closest('button')) return
        self._pinnedCollapsed = !self._pinnedCollapsed
        self._persistPinnedCollapsedPref()
        self._renderPoolList()
      })

      const collapseBtn = headerTd.querySelector('.dp-pinned-collapse-btn')
      if (collapseBtn) {
        collapseBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          self._pinnedCollapsed = !self._pinnedCollapsed
          self._persistPinnedCollapsedPref()
          self._renderPoolList()
        })
      }

      const clearBtn = headerTd.querySelector('.dp-pinned-clear-btn')
      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!self._pinnedSourceIds.size) return
          const ids = Array.from(self._pinnedSourceIds)
          const rm = self.unpinBySourceIds(ids)
          const app = global.window.App
          if (app && app.player) app.player.toast('已移出固定展示 ' + rm + ' 条')
        })
      }

      headerTr.appendChild(headerTd)
      // ★ 插入到 tbody 最前面(固定展示在最顶部)
      tbody.insertBefore(headerTr, tbody.firstChild)

      if (collapsed) return

      // ★ 固定展示弹幕行(与普通行列结构完全一致,含 # 列)
      const TU = global.TimeUtil
      const CU = global.ColorUtil
      const cols = this._columns || {}
      const showColor = !!this._contentShowColor
      const modeLabel = (m) => ({ scroll: '滚动', top: '顶部', bottom: '底部', position: '定位' })[m] || (m || '-')

      // ★ 用 DocumentFragment 收集所有 pinned 行,一次性插入到 headerTr 之后
      const frag = document.createDocumentFragment()
      for (let i = 0; i < pinnedRecs.length; i++) {
        const rec = pinnedRecs[i]
        const color = CU && CU.normalizeHex ? CU.normalizeHex(
          (rec.style && rec.style.color) || rec.color || '#FFFFFF', '#FFFFFF'
        ) : ((rec.style && rec.style.color) || rec.color || '#FFFFFF')
        const isAdv = rec.type === 'advanced'
        const poolSel = this._pinnedSelectedIds.has(rec.id) ? ' dp-pool-sel' : ''

        const tr = document.createElement('tr')
        tr.className = 'dp-row dp-pinned-row' + poolSel
        tr.dataset.id = rec.id
        tr.dataset.pinned = '1'
        // ★ 固定展示行基础色 #252016;若选中高亮为 #8A7040;左右外框模拟区段框
        const selBg = poolSel ? '#8A7040' : '#252016'
        // 最后一行加底边框,闭合外框
        const isLastRow = (i === pinnedRecs.length - 1)
        tr.style.cssText = 'position:relative;background:' + selBg + ';' +
          'border-left:2px solid #C0A050;border-right:2px solid #C0A050;' +
          (isLastRow ? 'border-bottom:2px solid #C0A050;' : '')

        const tds = []
        // ★ 不再添加 # 列 td(与普通行列数不再强对齐,因固定展示区独立于主表头外框)
        if (cols.time) tds.push('<td class="dp-col-time">' + (TU ? TU.fmtClock(rec.timeSec) : rec.timeSec.toFixed(1)) + '</td>')
        if (cols.type) tds.push('<td class="dp-col-type">' + (isAdv ? '<span class="adv-tag">高级</span>' : '<span class="normal-tag">普通</span>') + '</td>')
        if (cols.color) tds.push('<td class="dp-col-color" title="' + color + '"><span class="dp-swatch" style="background:' + color + '"></span></td>')
        if (cols.sender) tds.push('<td class="dp-col-sender">' + this._escHtml(rec.sender || '') + '</td>')
        if (cols.fontSize) {
          const fs = (rec.style && rec.style.fontSize) != null ? rec.style.fontSize : rec.fontSize
          tds.push('<td class="dp-col-fontsize">' + (fs != null ? fs : '') + '</td>')
        }
        if (cols.mode) tds.push('<td class="dp-col-mode">' + modeLabel(rec.mode || (isAdv ? 'position' : 'scroll')) + '</td>')
        if (cols.isup) tds.push('<td class="dp-col-isup">' + (rec.isup ? '✔' : '') + '</td>')
        if (cols.ctime) {
          let ctimeStr = ''
          const ctime = Number.isFinite(rec.ctime) && rec.ctime > 0 ? rec.ctime : 0
          if (ctime > 0) {
            const d = new Date(ctime)
            if (!isNaN(d.getTime())) {
              const pad = (nn) => String(nn).padStart(2, '0')
              ctimeStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
            }
          }
          tds.push('<td class="dp-col-ctime" title="' + this._escHtml(ctimeStr) + '">' + this._escHtml(ctimeStr) + '</td>')
        }

        const content = this._escHtml((rec.content || '').replace(/\n/g, ' '))
        const contentStyle = showColor ? ' style="color:' + color + '"' : ''
        const title = (
          'ID: ' + (rec.id || '') +
          '\n出现时间: ' + (TU ? TU.timeToStrPrecise(rec.timeSec) : rec.timeSec) +
          (rec.sender ? '\n发送人: ' + rec.sender : '') +
          (content ? '\n内容: ' + content : '')
        )
        tds.push('<td class="dp-col-content"' + contentStyle + ' title="' + title + '">' + content + '</td>')

        tr.innerHTML = '<span title="该条弹幕在「固定展示」中,会被优先展示且不受筛选/范围影响" style="position:absolute;top:2px;right:2px;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#f5a623;font-weight:700;line-height:1;pointer-events:none;">★</span>' + tds.join('')
        frag.appendChild(tr)
      }
      // ★ 插入到 headerTr 之后(即普通行之前)
      headerTr.after(frag)
    }

    /** ★ 弹幕池:按表格形式渲染 + 详细信息列(默认出现时间/类型/颜色,可自定义)
     *   - 除「颜色列」「弹幕内容列」之外的列不应用弹幕颜色
     *   - 内容列旁边有「显示颜色」小开关,默认关,决定内容列是否着色
     *   - 点击列表头可切换该列排序(正序→倒序,再次点击反过来;默认按「#」列升序)
     */
    _renderPoolList() {
      const list = document.getElementById('dp-list')
      const tableWrap = document.getElementById('dp-list-table-wrap')
      if (!list || !tableWrap) return
      tableWrap.innerHTML = ''
      const TU = global.TimeUtil
      const CU = global.ColorUtil
      const modeLabel = (m) => ({ scroll: '滚动', top: '顶部', bottom: '底部', position: '定位' })[m] || (m || '-')
      const modeOrder = (m) => ({ scroll: 0, top: 1, bottom: 2, position: 3 })[m] ?? 4
      const typeOrder = (t) => ({ normal: 0, advanced: 1 })[t] ?? 5
      const pinIcon = (show) => show
        ? '<span title="该条弹幕同时存在于「固定展示」小列表中,会被优先展示,不受筛选/范围影响" style="position:absolute;top:2px;right:2px;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;color:#f5a623;font-weight:700;line-height:1;pointer-events:none;">★</span>'
        : ''

      // 1. 先拿到筛选+范围切片后的记录数组
      const raw = this._filteredAndRanged()
      // 给每条绑定「在原始切片中的位置」—用于「#列」排序的默认顺序 & 需要恢复默认排序时
      const indexed = raw.map((rec, i) => ({ idx: i, rec }))
      // 2. 按 this._sort 排序
      const sorted = this._applyListSort(indexed, { modeLabel, modeOrder, typeOrder, TU, CU })
      const cols = this._columns || {}
      const showColor = !!this._contentShowColor

      // 3. 渲染表头(支持排序点击 + 内容列旁边加「显示颜色」小开关)
      const table = document.createElement('table')
      const thead = document.createElement('thead')
      const headTr = document.createElement('tr')
      const sortCol = this._sort ? this._sort.col : 'idx'
      const sortDir = this._sort ? this._sort.dir : 'asc'
      const mkTh = (key, label, className) => {
        const th = document.createElement('th')
        if (className) th.className = className
        th.dataset.sort = key
        const active = sortCol === key
        th.innerHTML =
          this._escHtml(label) +
          (active
            ? ' <span class="dp-sort-arrow">' + (sortDir === 'asc' ? '▲' : '▼') + '</span>'
            : ' <span class="dp-sort-arrow dp-sort-dim">▲</span>')
        th.style.cursor = 'pointer'
        th.title =
          (active ? '当前排序:' + (sortDir === 'asc' ? '升序' : '降序') + '。' : '') +
          '点击按「' + label + '」排序(同列再点切换升降)'
        th.addEventListener('click', (_e) => {
          if (this._sort && this._sort.col === key) {
            this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc'
          } else {
            this._sort = { col: key, dir: 'asc' }
          }
          this._renderPoolList()
        })
        return th
      }
      headTr.appendChild(mkTh('idx', '#')) // 序号(默认)
      if (cols.time) headTr.appendChild(mkTh('time', '出现时间', 'dp-col-time'))
      if (cols.type) headTr.appendChild(mkTh('type', '弹幕类型', 'dp-col-type'))
      if (cols.color) headTr.appendChild(mkTh('color', '颜色', 'dp-col-color'))
      if (cols.sender) headTr.appendChild(mkTh('sender', '发送人', 'dp-col-sender'))
      if (cols.fontSize) headTr.appendChild(mkTh('fontSize', '字号', 'dp-col-fontsize'))
      if (cols.mode) headTr.appendChild(mkTh('mode', '子类型', 'dp-col-mode'))
      if (cols.isup) headTr.appendChild(mkTh('isup', 'UP主', 'dp-col-isup'))
      if (cols.ctime) headTr.appendChild(mkTh('ctime', '发送时间', 'dp-col-ctime'))
      // ★ 内容列表头 + 「显示颜色」小开关
      const thContent = document.createElement('th')
      thContent.className = 'dp-col-content'
      thContent.dataset.sort = 'content'
      const contentActive = sortCol === 'content'
      thContent.innerHTML =
        '<span class="dp-col-content-inner">' +
          '<span class="dp-content-head-label">' +
            this._escHtml('弹幕内容') +
            (contentActive
              ? ' <span class="dp-sort-arrow">' + (sortDir === 'asc' ? '▲' : '▼') + '</span>'
              : ' <span class="dp-sort-arrow dp-sort-dim">▲</span>') +
          '</span>' +
          '<label class="dp-show-color-toggle" title="打开后,弹幕内容列文字会按弹幕颜色着色;关闭则统一按默认颜色显示,避免看不清文字">' +
            '<input type="checkbox" id="dp-show-color-toggle"' + (showColor ? ' checked' : '') + '>' +
            '<span>显示颜色</span>' +
          '</label>' +
        '</span>'
      thContent.style.cursor = 'pointer'
      thContent.addEventListener('click', (e) => {
        // 如果点到「显示颜色」开关自身 → 不要触发排序
        const t = e.target
        if (t && (t.id === 'dp-show-color-toggle' || t.closest('.dp-show-color-toggle'))) return
        if (this._sort && this._sort.col === 'content') {
          this._sort.dir = this._sort.dir === 'asc' ? 'desc' : 'asc'
        } else {
          this._sort = { col: 'content', dir: 'asc' }
        }
        this._renderPoolList()
      })
      headTr.appendChild(thContent)
      thead.appendChild(headTr)
      table.appendChild(thead)
      const tbody = document.createElement('tbody')

      // ★ 绑定「显示颜色」小开关(因为 switch 是 th 里的子元素,需在 th 加入DOM之后绑定,避免事件冒泡冲突)
      // 这里先记一下会在插入 table 到 list 后再绑定
      // 4. 表体渲染
      if (!sorted.length) {
        const tr = document.createElement('tr')
        const td = document.createElement('td')
        td.colSpan = Math.max(2, headTr.children.length)
        td.style.padding = '24px 12px'
        td.style.color = '#777'
        td.style.textAlign = 'center'
        td.textContent = '没有匹配的弹幕。请调整范围或清空筛选。'
        tr.appendChild(td)
        tbody.appendChild(tr)
      } else {
        const frags = []
        const maxRows = Math.min(sorted.length, 30000)
        for (let i = 0; i < maxRows; i++) {
          const { idx, rec } = sorted[i]
          const color = CU && CU.normalizeHex ? CU.normalizeHex(
            (rec.style && rec.style.color) || rec.color || '#FFFFFF',
            '#FFFFFF'
          ) : ((rec.style && rec.style.color) || rec.color || '#FFFFFF')
          const isAdv = rec.type === 'advanced'
          const sel = (this.store.selectedIds && this.store.selectedIds.has(rec.id)) ? ' selected' : ''
          // ★ 弹幕池多选高亮:在 _poolSelectedIds 中的行额外加 dp-pool-sel 类
          const poolSel = this._poolSelectedIds.has(rec.id) ? ' dp-pool-sel' : ''
          const tds = []
          // #列:显示排序前的原始切片序号?还是按当前排序后的顺序?用户说「默认顺序为#列正序」,所以这里显示当前表格里的行序 i
          tds.push('<td>' + i + '</td>')
          if (cols.time) tds.push('<td class="dp-col-time">' + (TU ? TU.fmtClock(rec.timeSec) : rec.timeSec.toFixed(1)) + '</td>')
          if (cols.type) {
            tds.push('<td class="dp-col-type">' + (isAdv ? '<span class="adv-tag">高级</span>' : '<span class="normal-tag">普通</span>') + '</td>')
          }
          if (cols.color) {
            // ★ 颜色列:保留颜色(色卡本身 + tooltip 值),但不影响其他列
            tds.push('<td class="dp-col-color" title="' + color + '">' +
              '<span class="dp-swatch" style="background:' + color + '"></span></td>')
          }
          if (cols.sender) {
            tds.push('<td class="dp-col-sender">' + this._escHtml(rec.sender || '') + '</td>')
          }
          if (cols.fontSize) {
            const fs = (rec.style && rec.style.fontSize) != null ? rec.style.fontSize : rec.fontSize
            tds.push('<td class="dp-col-fontsize">' + (fs != null ? fs : '') + '</td>')
          }
          if (cols.mode) tds.push('<td class="dp-col-mode">' + modeLabel(rec.mode || (isAdv ? 'position' : 'scroll')) + '</td>')
          if (cols.isup) tds.push('<td class="dp-col-isup">' + (rec.isup ? '✔' : '') + '</td>')
          if (cols.ctime) {
            // ★ 发送时间:从 ctime 时间戳(Unix ms)格式化为 yyyy-MM-dd HH:mm:ss
            let ctimeStr = ''
            const ctime = Number.isFinite(rec.ctime) && rec.ctime > 0 ? rec.ctime : 0
            if (ctime > 0) {
              const d = new Date(ctime)
              if (!isNaN(d.getTime())) {
                const pad = (n) => String(n).padStart(2, '0')
                ctimeStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
                  ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
              }
            }
            tds.push('<td class="dp-col-ctime" title="' + this._escHtml(ctimeStr) + '">' + this._escHtml(ctimeStr) + '</td>')
          }
          // ★ 弹幕内容列:仅当 showColor=true 时,给该单元格颜色;否则沿用默认文字颜色
          const content = this._escHtml((rec.content || '').replace(/\n/g, ' '))
          const title = (
            'ID: ' + (rec.id || '') +
            '\n原始序号: ' + idx +
            '\n出现时间: ' + (TU ? TU.timeToStrPrecise(rec.timeSec) : rec.timeSec) +
            (rec.sender ? '\n发送人: ' + rec.sender : '') +
            (content ? '\n内容: ' + content : '')
          )
          const contentStyle = showColor ? ' style="color:' + color + '"' : ''
          tds.push('<td class="dp-col-content"' + contentStyle + ' title="' + title + '">' + content + '</td>')
          // ★ 颜色只作用于颜色列(swatch)与内容列(若打开开关):整行 tr 不再设置 color
          // ★ 被固定展示的弹幕行加背景色 #252016 + 星标(pinIcon 已有)
          const isPinnedRow = this.isPinned(rec.id)
          const rowBg = isPinnedRow ? 'background:#252016;' : ''
          frags.push(
            '<tr class="dp-row' + sel + poolSel + '" data-id="' + (rec.id || '') + '" data-idx="' + idx + '" style="position:relative;' + rowBg + '">' +
              pinIcon(isPinnedRow) +
              tds.join('') +
            '</tr>'
          )
        }
        if (sorted.length > maxRows) {
          frags.push('<tr><td colspan="' + headTr.children.length + '" style="color:#777;padding:10px;text-align:center;font-size:12px">匹配 ' + sorted.length + ' 条,仅显示前 ' + maxRows + ' 条。请调整范围/筛选以查看更多。</td></tr>')
        }
        tbody.innerHTML = frags.join('')
      }
      // ★ 在 tbody 最前面插入固定展示弹幕(共用列标签,不受筛选/范围影响)
      this._renderPinnedList(tbody, headTr)

      // ★ 行点击:普通点击=单选+seek;Ctrl+点击=多选 toggle;右键=contextmenu
      //   区分固定展示行(pinned)和普通行
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr.dp-row')
        if (!tr) return
        const id = tr.dataset.id
        if (!id) return
        const isPinned = tr.dataset.pinned === '1'

        if (isPinned) {
          // ★ 固定展示行:操作 _pinnedSelectedIds(存源 id)
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            if (this._pinnedSelectedIds.has(id)) this._pinnedSelectedIds.delete(id)
            else this._pinnedSelectedIds.add(id)
            this._refreshPoolSelectionUI()
            return
          }
          this._pinnedSelectedIds.clear(); this._pinnedSelectedIds.add(id)
          this._poolSelectedIds.clear()
          this._refreshPoolSelectionUI()
          const rec = this.store.get(id)
          if (rec && global.window.App && global.window.App.engine) {
            global.window.App.engine.seek(rec.timeSec)
            global.window.App.store.select && global.window.App.store.select(id)
          }
          return
        }

        // ★ 普通行
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          if (this._poolSelectedIds.has(id)) {
            this._poolSelectedIds.delete(id)
          } else {
            this._poolSelectedIds.add(id)
          }
          this._refreshPoolSelectionUI()
          return
        }
        this._poolSelectedIds.clear()
        this._pinnedSelectedIds.clear()
        this._poolSelectedIds.add(id)
        const rec = this.store.get(id)
        if (rec && global.window.App && global.window.App.engine) {
          global.window.App.engine.seek(rec.timeSec)
        }
        this.store.select(id)
        // ★ store.select 后再刷新 UI,确保 selected 类正确同步
        this._refreshPoolSelectionUI()
        const row = this._rows.get(id)
        if (row) row.scrollIntoView({ block: 'nearest' })
      })
      // ★ 右键:弹出弹幕池上下文菜单(区分固定展示/普通)
      tbody.addEventListener('contextmenu', (e) => {
        const tr = e.target.closest('tr.dp-row')
        if (!tr) return
        e.preventDefault()
        const id = tr.dataset.id
        if (!id) return
        const isPinned = tr.dataset.pinned === '1'

        if (isPinned) {
          // ★ 固定展示行右键
          if (!this._pinnedSelectedIds.has(id)) {
            this._pinnedSelectedIds.clear()
            this._pinnedSelectedIds.add(id)
            this._refreshPoolSelectionUI()
          }
          this._showPoolCtxMenu(e.clientX, e.clientY, true)
          return
        }

        // ★ 普通行右键
        if (!this._poolSelectedIds.has(id)) {
          this._poolSelectedIds.clear()
          this._poolSelectedIds.add(id)
          this._refreshPoolSelectionUI()
        }
        this._showPoolCtxMenu(e.clientX, e.clientY)
      })
      // ★ 鼠标拖拽批量选择(从按下行开始,区分固定展示/普通)
      //   使用 document 级 mousemove:移出 #dp-list div 也能追踪 + 自动加速滚动
      tbody.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const tr = e.target.closest('tr.dp-row')
        if (!tr) return
        const id = tr.dataset.id
        if (!id) return
        if (e.ctrlKey || e.metaKey) return
        const isPinned = tr.dataset.pinned === '1'

        // 记录拖拽上下文(固定展示或普通)
        this._poolDrag = {
          startId: id, lastX: e.clientX, lastY: e.clientY,
          tbody: tbody, pinned: isPinned
        }
        if (isPinned) {
          this._pinnedSelectedIds.clear(); this._pinnedSelectedIds.add(id)
          this._poolSelectedIds.clear()
        } else {
          this._poolSelectedIds.clear(); this._poolSelectedIds.add(id)
          this._pinnedSelectedIds.clear()
        }
        this._refreshPoolSelectionUI()
        document.addEventListener('mousemove', this._onPoolDragMove)
        document.addEventListener('mouseup', this._onPoolDragEnd)
      })
      table.appendChild(tbody)
      tableWrap.appendChild(table)
      // ★ 给内容列表头的「显示颜色」小开关绑定事件(必须在 DOM 插入之后)
      const toggle = document.getElementById('dp-show-color-toggle')
      if (toggle) {
        toggle.addEventListener('change', (ev) => {
          ev.stopPropagation()
          this._contentShowColor = !!toggle.checked
          this._persistContentShowColorPref()
          this._renderPoolList()
        })
      }
    }

    /** ★ 刷新弹幕池多选行的视觉高亮(不重渲染整个列表,仅 toggle class + 更新内联背景)。
     *   同时处理固定展示行(_pinnedSelectedIds)和普通行(_poolSelectedIds)。
     *   固定展示行:选中背景 #8A7040,未选中 #252016;内联 style 会覆盖 CSS class,必须同步改。
     *   普通行:用 CSS class `.dp-pool-sel` 即可(无内联背景冲突)。*/
    _refreshPoolSelectionUI() {
      const tbody = document.querySelector('#dp-list tbody')
      if (!tbody) return
      const rows = tbody.querySelectorAll('tr.dp-row')
      const selectedIds = this.store.selectedIds || new Set()
      rows.forEach((tr) => {
        const id = tr.dataset.id
        if (!id) return
        const isPinned = tr.dataset.pinned === '1'
        if (isPinned) {
          const picked = this._pinnedSelectedIds.has(id)
          tr.classList.toggle('dp-pool-sel', picked)
          // ★ 固定展示行有内联背景,必须同步更新,否则多选切换时颜色不变
          tr.style.background = picked ? '#8A7040' : '#252016'
        } else {
          tr.classList.toggle('dp-pool-sel', this._poolSelectedIds.has(id))
        }
        // ★ 同步更新 selected 类(跟随 store.selectedIds),避免背景色残留
        tr.classList.toggle('selected', selectedIds.has(id))
      })
    }

    /** ★ 弹幕池拖拽:document 级 mousemove 处理(移出 div 也能追踪)。*/
    _handlePoolDragMove(e) {
      const d = this._poolDrag
      if (!d) return
      d.lastX = e.clientX
      d.lastY = e.clientY
      const list = document.getElementById('dp-list')
      if (!list) return
      const rect = list.getBoundingClientRect()
      const y = e.clientY

      // ★ 鼠标移出 div 外面时自动滚动(上方或下方)
      if (y < rect.top && list.scrollTop > 0) {
        this._poolAutoScrollDir = -1
        this._startPoolAutoScroll()
      } else if (y > rect.bottom && list.scrollTop + list.clientHeight < list.scrollHeight) {
        this._poolAutoScrollDir = 1
        this._startPoolAutoScroll()
      } else {
        this._poolAutoScrollDir = 0
      }

      this._updatePoolSelFromHover()
    }

    /** ★ 弹幕池拖拽:根据鼠标位置(含 div 外的 elementFromPoint)更新选中范围。
     *   区分固定展示行和普通行,拖拽时不会混选。*/
    _updatePoolSelFromHover() {
      const d = this._poolDrag
      if (!d) return
      const x = d.lastX != null ? d.lastX : 0
      const y = d.lastY != null ? d.lastY : 0
      const el = document.elementFromPoint(x, y)
      const tr = el && el.closest ? el.closest('tr.dp-row') : null
      if (!tr) return
      const id = tr.dataset.id
      if (!id) return
      const tbody = d.tbody
      if (!tbody) return
      const dragPinned = !!d.pinned
      // ★ 只取同类型的行(固定展示 vs 普通),避免混选
      const rows = Array.from(tbody.querySelectorAll('tr.dp-row')).filter((r) => {
        if (dragPinned) return r.dataset.pinned === '1'
        return r.dataset.pinned !== '1'
      })
      const startIdx = rows.findIndex((r) => r.dataset.id === d.startId)
      const curIdx = rows.findIndex((r) => r.dataset.id === id)
      if (startIdx < 0 || curIdx < 0) return
      const lo = Math.min(startIdx, curIdx)
      const hi = Math.max(startIdx, curIdx)
      // 重建选中集合:起点到当前行之间的所有同类型行
      const newSel = new Set()
      for (let i = lo; i <= hi; i++) {
        const rid = rows[i].dataset.id
        if (rid) newSel.add(rid)
      }
      // 更新对应集合
      const targetSet = dragPinned ? this._pinnedSelectedIds : this._poolSelectedIds
      let changed = newSel.size !== targetSet.size
      if (!changed) {
        for (const sid of newSel) {
          if (!targetSet.has(sid)) { changed = true; break }
        }
      }
      if (changed) {
        if (dragPinned) {
          this._pinnedSelectedIds = newSel
        } else {
          this._poolSelectedIds = newSel
        }
        this._refreshPoolSelectionUI()
      }
    }

    /** ★ 弹幕池拖拽:自动加速滚动(移出 div 越远,速度越快)。*/
    _startPoolAutoScroll() {
      if (this._poolAutoScrollRAF != null) return
      this._poolAutoScrollSpeed = 0
      const step = () => {
        if (!this._poolDrag) {
          this._poolAutoScrollRAF = null
          return
        }
        const list = document.getElementById('dp-list')
        if (!list) { this._poolAutoScrollRAF = null; return }
        const rect = list.getBoundingClientRect()
        const y = this._poolDrag.lastY != null ? this._poolDrag.lastY : rect.top + rect.height / 2
        let targetSpeed = 0
        let curDir = this._poolAutoScrollDir

        if (y < rect.top && list.scrollTop > 0) {
          curDir = -1
          const dist = Math.max(0, rect.top - y)
          targetSpeed = Math.min(8, 1 + dist * 0.15)
        } else if (y > rect.bottom && list.scrollTop + list.clientHeight < list.scrollHeight) {
          curDir = 1
          const dist = Math.max(0, y - rect.bottom)
          targetSpeed = Math.min(8, 1 + dist * 0.15)
        } else {
          curDir = 0
        }
        this._poolAutoScrollDir = curDir

        if (curDir === 0) {
          // ★ 鼠标回到 div 内:速度逐渐衰减(摩擦)
          this._poolAutoScrollSpeed *= 0.85
          if (this._poolAutoScrollSpeed < 0.5) {
            this._stopPoolAutoScroll()
            return
          }
        } else {
          // ★ 速度从 0 开始加速,逐渐逼近目标速度
          this._poolAutoScrollSpeed += (targetSpeed - this._poolAutoScrollSpeed) * 0.12
        }

        list.scrollTop += curDir * this._poolAutoScrollSpeed
        this._updatePoolSelFromHover()
        this._poolAutoScrollRAF = requestAnimationFrame(step)
      }
      this._poolAutoScrollRAF = requestAnimationFrame(step)
    }

    _stopPoolAutoScroll() {
      if (this._poolAutoScrollRAF != null) {
        cancelAnimationFrame(this._poolAutoScrollRAF)
        this._poolAutoScrollRAF = null
      }
      this._poolAutoScrollDir = 0
    }

    /** ★ 弹幕池拖拽结束:移除 document 监听,停止自动滚动。*/
    _endPoolDrag() {
      this._poolDrag = null
      document.removeEventListener('mousemove', this._onPoolDragMove)
      document.removeEventListener('mouseup', this._onPoolDragEnd)
      this._stopPoolAutoScroll()
    }

    /** ★ 弹幕池右键菜单:显示在指定坐标,按钮文字根据选中数量变化。
     * @param {number} x
     * @param {number} y
     * @param {boolean} [pinnedContext] 是否在固定展示小列表内(默认 false,表示主列表)。*/
    _showPoolCtxMenu(x, y, pinnedContext) {
      const menu = document.getElementById('dp-ctx-menu')
      const delBtn = document.getElementById('dp-ctx-delete')
      const pinBtn = document.getElementById('dp-ctx-pin')
      const unpinBtn = document.getElementById('dp-ctx-unpin')
      if (!menu || !delBtn || !pinBtn || !unpinBtn) return
      const app = global.window.App
      const player = app && app.player
      const list = this
      pinnedContext = !!pinnedContext
      const mainSelSize = this._poolSelectedIds.size
      const pinSelSize = this._pinnedSelectedIds.size
      const n = pinnedContext ? pinSelSize : mainSelSize
      // ★ 小列表(pinnedContext)仅显示「移出固定展示」(删除行为与移出完全等价,不再重复"删除")
      if (pinnedContext) {
        pinBtn.style.display = 'none'
        delBtn.style.display = 'none'
        unpinBtn.style.display = ''
        unpinBtn.textContent = n >= 2 ? ('移出固定展示(' + n + '个)') : '移出固定展示'
      } else {
        unpinBtn.style.display = 'none'
        pinBtn.style.display = ''
        delBtn.style.display = ''
        pinBtn.textContent = n >= 2 ? ('固定展示(' + n + '个)') : '固定展示'
        delBtn.textContent = n >= 2 ? ('删除选中(' + n + '个)') : '删除'
      }
      menu.hidden = false
      menu.style.left = x + 'px'
      menu.style.top = y + 'px'
      // handler:先移除老事件(通过 cloneNode(true)快速解绑旧 listener)
      const newPin = pinBtn.cloneNode(true)
      const newUnpin = unpinBtn.cloneNode(true)
      const newDel = delBtn.cloneNode(true)
      if (pinBtn.parentNode) pinBtn.parentNode.replaceChild(newPin, pinBtn)
      if (unpinBtn.parentNode) unpinBtn.parentNode.replaceChild(newUnpin, unpinBtn)
      if (delBtn.parentNode) delBtn.parentNode.replaceChild(newDel, delBtn)

      newPin.addEventListener('click', () => {
        if (!list._poolSelectedIds.size) return
        const added = list.pinSelected(Array.from(list._poolSelectedIds))
        if (player) {
          if (added > 0) player.toast('已加入固定展示 ' + added + ' 条(优先展示,不受筛选/范围影响)')
          else player.toast('所选弹幕已在固定展示中', { error: true })
        }
        list._hidePoolCtxMenu()
      })
      newUnpin.addEventListener('click', () => {
        // ★ 固定展示统一只走"移出"(不删除原记录)
        if (!list._pinnedSelectedIds.size) return
        const rm = list.unpinBySourceIds(Array.from(list._pinnedSelectedIds))
        if (player) player.toast('已移出固定展示 ' + rm + ' 条')
        list._hidePoolCtxMenu()
      })
      newDel.addEventListener('click', () => {
        if (pinnedContext) {
          const rm = list.unpinBySourceIds(Array.from(list._pinnedSelectedIds))
          if (player) player.toast('已移出固定展示 ' + rm + ' 条')
          list._hidePoolCtxMenu()
        } else {
          list._poolCtxDelete()
        }
      })

      // ★ 点击菜单外部 / ESC 关闭
      const closeHandler = (ev) => {
        if (!menu.contains(ev.target)) {
          list._hidePoolCtxMenu()
          document.removeEventListener('mousedown', closeHandler, true)
        }
      }
      setTimeout(() => {
        document.addEventListener('mousedown', closeHandler, true)
      }, 0)
      // ESC 关闭
      const escHandler = (ev) => {
        if (ev.key === 'Escape') {
          list._hidePoolCtxMenu()
          document.removeEventListener('keydown', escHandler)
        }
      }
      document.addEventListener('keydown', escHandler)
      // 菜单自身 click 不冒泡到 document(避免立即关闭)
      menu.addEventListener('click', (ev) => ev.stopPropagation(), { once: true })
    }

    _hidePoolCtxMenu() {
      const menu = document.getElementById('dp-ctx-menu')
      if (menu) menu.hidden = true
      const pinBtn = document.getElementById('dp-ctx-pin')
      const unpinBtn = document.getElementById('dp-ctx-unpin')
      const delBtn = document.getElementById('dp-ctx-delete')
      if (pinBtn) pinBtn.style.display = ''
      if (unpinBtn) unpinBtn.style.display = 'none'
      if (delBtn) delBtn.style.display = ''
    }

    /** ★ 主列表:删除选中主记录。*/
    _poolCtxDelete() {
      const ids = Array.from(this._poolSelectedIds)
      if (!ids.length) return
      // ★ 范围校验:删除前检查是否满足展示范围
      if (!this._validateRangeBeforeDelete(ids)) {
        const app = global.window.App
        const player = app && app.player
        if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
        return
      }
      this.store.removeMany(ids)
      // 同时:如果被删的记录在固定展示中,一并移出(源 id 即记录 id)
      if (this._pinnedSourceIds.size) {
        const toRemove = ids.filter((id) => this._pinnedSourceIds.has(id))
        if (toRemove.length) this.unpinBySourceIds(toRemove)
      }
      this._poolSelectedIds.clear()
      this._hidePoolCtxMenu()
      // ★ 删除后刷新弹幕池列表,确保右侧列表同步更新
      this._renderPoolInfo()
      this._renderPoolList()
      const app = global.window.App
      const player = app && app.player
      if (player) player.toast('已删除 ' + ids.length + ' 条弹幕')
    }

    /** ★ 弹幕池全选:把当前列表展示中的所有弹幕加入 _poolSelectedIds。*/
    poolSelectAll() {
      const recs = this._filteredAndRanged() || []
      this._poolSelectedIds = new Set(recs.map((r) => r.id).filter(Boolean))
      this._refreshPoolSelectionUI()
    }

    /** ★ 弹幕池删除选中(Ctrl+D 快捷键入口)。*/
    poolDeleteSelected() {
      const ids = Array.from(this._poolSelectedIds)
      if (!ids.length) return false
      // ★ 范围校验:删除前检查是否满足展示范围
      if (!this._validateRangeBeforeDelete(ids)) {
        const app = global.window.App
        const player = app && app.player
        if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
        return false
      }
      this.store.removeMany(ids)
      this._poolSelectedIds.clear()
      // ★ 删除后刷新弹幕池列表,确保右侧列表同步更新
      this._renderPoolInfo()
      this._renderPoolList()
      const app = global.window.App
      const player = app && app.player
      if (player) player.toast('已删除 ' + ids.length + ' 条弹幕')
      return true
    }

    /** 把记录数组按 this._sort 排序;返回新数组(不修改原数组)。 */
    _applyListSort(indexed, helpers) {
      const { modeOrder, typeOrder } = helpers
      const arr = indexed.slice()
      const s = this._sort || { col: 'idx', dir: 'asc' }
      const dirMul = s.dir === 'desc' ? -1 : 1
      const cmp = (a, b) => {
        let va, vb, r = 0
        switch (s.col) {
          case 'idx':
            return (a.idx - b.idx) * dirMul
          case 'time':
            return ((a.rec.timeSec || 0) - (b.rec.timeSec || 0)) * dirMul
          case 'type':
            va = typeOrder(a.rec.type); vb = typeOrder(b.rec.type)
            r = (va - vb)
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'color':
            va = ((a.rec.style && a.rec.style.color) || a.rec.color || '').toLowerCase()
            vb = ((b.rec.style && b.rec.style.color) || b.rec.color || '').toLowerCase()
            r = va < vb ? -1 : (va > vb ? 1 : 0)
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'sender':
            va = (a.rec.sender || '').toString(); vb = (b.rec.sender || '').toString()
            r = va.localeCompare(vb, 'zh-Hans-CN')
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'fontSize':
            va = (a.rec.style && a.rec.style.fontSize != null) ? a.rec.style.fontSize : a.rec.fontSize
            vb = (b.rec.style && b.rec.style.fontSize != null) ? b.rec.style.fontSize : b.rec.fontSize
            va = Number(va); vb = Number(vb)
            if (!isFinite(va)) va = -1
            if (!isFinite(vb)) vb = -1
            r = va - vb
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'mode':
            va = modeOrder(a.rec.mode || ((a.rec.type === 'advanced') ? 'position' : 'scroll'))
            vb = modeOrder(b.rec.mode || ((b.rec.type === 'advanced') ? 'position' : 'scroll'))
            r = va - vb
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'isup':
            va = a.rec.isup ? 1 : 0; vb = b.rec.isup ? 1 : 0
            r = va - vb
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'ctime':
            va = Number.isFinite(a.rec.ctime) ? a.rec.ctime : 0
            vb = Number.isFinite(b.rec.ctime) ? b.rec.ctime : 0
            r = va - vb
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          case 'content':
            va = ((a.rec.content || '')).toString()
            vb = ((b.rec.content || '')).toString()
            r = va.localeCompare(vb, 'zh-Hans-CN')
            if (r === 0) r = (a.idx - b.idx)
            return r * dirMul
          default:
            return (a.idx - b.idx) * dirMul
        }
      }
      arr.sort(cmp)
      return arr
    }

    _escHtml(s) {
      return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    }

    /** 把当前偏好同步到「展示列」复选框面板。*/
    _syncColsCheckboxFromState() {
      const checks = document.querySelectorAll('#dp-columns-panel input[type=checkbox][data-col]')
      if (!checks || !checks.length) return
      checks.forEach((c) => {
        const k = c.getAttribute('data-col')
        c.checked = !!this._columns[k]
      })
    }

    /** 绑定总览窗口上的所有输入控件(范围/筛选/关闭按钮 + 列配置 + 加入其他弹幕合并导入按钮)。 */
    _wirePoolUI() {
      // 关闭
      const close = document.getElementById('dp-close')
      if (close) close.addEventListener('click', () => this.closePoolOverview())
      // 范围:应用/重置
      const apply = document.getElementById('dp-range-apply')
      const reset = document.getElementById('dp-range-reset')
      const rStart = document.getElementById('dp-range-start')
      const rEnd = document.getElementById('dp-range-end')
      if (apply) apply.addEventListener('click', () => {
        const s = rStart ? Math.max(0, Math.floor(Number(rStart.value) || 0)) : 0
        let e = Infinity
        if (rEnd) {
          const v = rEnd.value
          if (v !== '' && v != null) e = Math.max(0, Math.floor(Number(v)))
        }
        this._range.start = s
        this._range.end = e
        // ★ 仅刷新弹幕池列表,不联动左侧弹幕列表和引擎展示(等待用户点击「展示当前弹幕」)
        this.refreshPoolList()
      })
      if (reset) reset.addEventListener('click', () => {
        this._range = { start: 0, end: Infinity }
        if (rStart) rStart.value = 0
        if (rEnd) rEnd.value = ''
        // ★ 仅刷新弹幕池列表,不清除引擎 showOnlyIds(等待用户点击「展示当前弹幕」)
        this.refreshPoolList()
      })
      // 列配置面板:显示/隐藏 + 应用
      const colsBtn = document.getElementById('dp-columns')
      const colsPanel = document.getElementById('dp-columns-panel')
      const colsApply = document.getElementById('dp-cols-apply')
      const colsClose = document.getElementById('dp-cols-close')
      if (colsBtn && colsPanel) colsBtn.addEventListener('click', () => {
        colsPanel.hidden = !colsPanel.hidden
        colsBtn.classList.toggle('active', !colsPanel.hidden)
        if (!colsPanel.hidden) this._syncColsCheckboxFromState()
      })
      if (colsClose && colsPanel) colsClose.addEventListener('click', () => {
        colsPanel.hidden = true
        if (colsBtn) colsBtn.classList.remove('active')
      })
      if (colsApply) colsApply.addEventListener('click', () => {
        const checks = document.querySelectorAll('#dp-columns-panel input[type=checkbox][data-col]')
        const next = {}
        checks.forEach((c) => {
          const k = c.getAttribute('data-col')
          next[k] = !!c.checked
        })
        this._columns = Object.assign({}, this._columns, next)
        this._persistColumnsPref()
        this.refreshPoolList()
        if (colsPanel) colsPanel.hidden = true
        if (colsBtn) colsBtn.classList.remove('active')
      })

      // ★「加入其他弹幕」按钮:合并导入(JSON/XML/ASS → 追加到当前池,不替换)
      const mergeBtn = document.getElementById('dp-merge-import')
      if (mergeBtn) mergeBtn.addEventListener('click', () => this._runMergeImportDialog())

      // ★「展示当前弹幕」按钮:把当前列表里(筛选后、范围内、当前排序后的结果)的所有弹幕
      //  替换为新的「当前弹幕池」→ 左侧弹幕列表与舞台只展示这些弹幕
      const applyBtn = document.getElementById('dp-apply-showing')
      if (applyBtn) applyBtn.addEventListener('click', () => this._applyShowingAsPool())

      // 筛选面板切换显隐
      const fOpen = document.getElementById('dp-filter-open')
      const fPanel = document.getElementById('dp-filter-panel')
      if (fOpen && fPanel) fOpen.addEventListener('click', () => {
        fPanel.hidden = !fPanel.hidden
        fOpen.classList.toggle('active', !fPanel.hidden)
        if (!fPanel.hidden) this._syncPoolControlsFromState()
      })
      // 筛选:清空 / 应用
      const fClear = document.getElementById('dp-f-clear')
      const fApply = document.getElementById('dp-f-apply')
      const fText = document.getElementById('dp-f-text')
      const fFrom = document.getElementById('dp-f-from')
      const fTo = document.getElementById('dp-f-to')
      const fType = document.getElementById('dp-f-type')
      const fSubtype = document.getElementById('dp-f-subtype')
      const fSender = document.getElementById('dp-f-sender')
      if (fClear) fClear.addEventListener('click', () => {
        this._filters = { text: '', timeFrom: null, timeTo: null, type: 'all', subtype: 'all', sender: '' }
        this._syncPoolControlsFromState()
        // ★ 仅刷新弹幕池列表,不联动左侧弹幕列表和引擎展示(等待用户点击「展示当前弹幕」)
        this.refreshPoolList()
      })
      if (fApply) fApply.addEventListener('click', () => {
        this._filters.text = fText ? (fText.value || '') : ''
        this._filters.timeFrom = fFrom && fFrom.value !== '' ? parseFloat(fFrom.value) : null
        this._filters.timeTo = fTo && fTo.value !== '' ? parseFloat(fTo.value) : null
        this._filters.type = fType ? fType.value : 'all'
        this._filters.subtype = fSubtype ? fSubtype.value : 'all'
        this._filters.sender = fSender ? (fSender.value || '') : ''
        // ★ 仅刷新弹幕池列表,不联动左侧弹幕列表和引擎展示(等待用户点击「展示当前弹幕」)
        this.refreshPoolList()
      })
    }

    /** ★ 弹出「加入其他弹幕」对话框:复用 FileDialog,标题自定义,内容合并导入(追加)。*/
    _runMergeImportDialog() {
      const app = global.window.App
      const controls = app && app.controls
      const player = app && app.player
      const fileDialog = (controls && controls.fileDialog) || (global.FileDialog ? new global.FileDialog() : null)
      if (!fileDialog) {
        if (player) player.toast('环境不支持文件选择对话框', { error: true })
        return
      }
      const title = '加入其他弹幕(JSON/XML/ASS)'
      const accept = '.json,.xml,.ass,.ssa,application/json,text/xml,application/xml'
      fileDialog.open(title, accept, (file) => {
        if (!file || !controls) return
        const reader = new FileReader()
        reader.onerror = () => {
          if (player) player.toast('读取文件失败', { error: true })
        }
        reader.onload = () => {
          const text = typeof reader.result === 'string' ? reader.result : ''
          controls._mergeImportText(text, { name: file.name, mtimeMs: file.lastModified || 0 })
        }
        reader.readAsText(file, 'utf-8')
      })
    }

    /** ★ 清除引擎的 showOnlyIds(无条件恢复展示全部弹幕)。*/
    _clearEngineShowOnly() {
      const app = global.window.App
      const engine = app && app.engine
      if (engine && typeof engine.setShowOnlyIds === 'function') {
        engine.setShowOnlyIds(null)
      }
    }

    /** ★ 当筛选与范围都为空时,清除引擎的 showOnlyIds(恢复展示全部)。*/
    _maybeClearEngineShowOnly() {
      const f = this._filters
      const noFilter = !f.text && f.timeFrom == null && f.timeTo == null &&
        f.type === 'all' && f.subtype === 'all' && !f.sender
      const noRange = this._range.start === 0 && this._range.end === Infinity
      if (noFilter && noRange) this._clearEngineShowOnly()
    }

    /** ★「展示当前弹幕」主逻辑(非破坏性):
     *   - 取当前 _filteredAndRanged()(筛选 + 范围切片后的结果)
     *   - 调用 engine.setShowOnlyIds() 让舞台仅展示这些弹幕
     *   - 不替换 store.comments,弹幕池数据完整保留
     *   - 左侧列表本来就用同样的筛选/范围,保持一致
     *   - 固定展示弹幕始终包含在内(不受范围/筛选影响)
     */
    _applyShowingAsPool() {
      const raw = this._filteredAndRanged() || []
      const app = global.window.App
      const engine = app && app.engine
      const player = app && app.player
      const pinnedN = this._pinnedSourceIds.size
      if (!raw.length && !pinnedN) {
        if (player) player.toast('当前列表为空,无法展示', { error: true })
        return
      }
      const ids = new Set(raw.map((r) => r.id).filter(Boolean))
      if (engine && typeof engine.setShowOnlyIds === 'function') {
        engine.setShowOnlyIds(ids)
      }
      // 列表 + 总览窗口刷新(数据未变,仅刷新展示信息)
      this.render()
      this.refreshPoolList()
      // Toast 反馈
      const msg = pinnedN > 0
        ? '已将当前展示中的 ' + ids.size + ' 条弹幕应用到舞台(含 ' + pinnedN + ' 条固定展示,弹幕池数据已保留)'
        : '已将当前展示中的 ' + ids.size + ' 条弹幕应用到舞台(弹幕池数据已保留,清除筛选可恢复全部展示)'
      if (player) player.toast(msg)
    }

    /** 把总览窗口的筛选写回到列表侧的原生输入控件上,保证「和列表里的筛选状态一致」。 */
    _syncListSearchInputsFromPool() {
      const f = this._filters
      const si = document.getElementById('list-search-input')
      if (si) si.value = f.text
      const lfTimeFrom = document.getElementById('lf-time-from')
      if (lfTimeFrom) lfTimeFrom.value = f.timeFrom != null ? f.timeFrom : ''
      const lfTimeTo = document.getElementById('lf-time-to')
      if (lfTimeTo) lfTimeTo.value = f.timeTo != null ? f.timeTo : ''
      const lfType = document.getElementById('lf-type')
      if (lfType) lfType.value = f.type
      const lfSubtype = document.getElementById('lf-subtype')
      if (lfSubtype) lfSubtype.value = f.subtype
      const lfSender = document.getElementById('lf-sender')
      if (lfSender) lfSender.value = f.sender
    }
  }

  global.DanmakuList = DanmakuList
})(window)
