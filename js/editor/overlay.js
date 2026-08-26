/**
 * overlay.js:编辑模式下的高级弹幕标注 overlay。
 *
 * 选中高级弹幕后,在舞台 SVG 上标注:
 *   - 起始点(绿) / 结束点(红) —— 可拖动,改 position.startX/Y、endX/Y
 *   - 三点虚线连接
 *   - 三个手柄:Z(绕Z旋转) / Y(绕Y旋转) / 拖(整体平移 start+end)
 *
 * 拖拽通过 store.updateDeep 写回,面板与引擎随之实时刷新。
 */
(function (global) {
  'use strict'

  const NS = 'http://www.w3.org/2000/svg'
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
  const round1 = (n) => Math.round(n * 10) / 10
  const round2 = (n) => Math.round(n * 100) / 100

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name)
    if (attrs) {
      for (const k in attrs) el.setAttribute(k, attrs[k])
    }
    return el
  }

  class EditOverlay {
    constructor(svg, store, engine, editor) {
      this.svg = svg
      this.store = store
      this.engine = engine
      this.editor = editor
      this.enabled = false
      this.picking = false
      this._batchMode = false // ★ 深度批量纯高级模式:不显示单条手柄,显示联合BBox+批量平移
      this.record = null
      this._dragging = null
      this._lockedId = null // 锁定的弹幕 id(阻止切换选中)
      this._renderRAF = null  // ★ 每帧重绘循环:跟随运动/旋转的 dm.node 真实 bbox
      this._needsAnimatedRender = false  // 当前选择是否需要持续重绘(有 active 节点在舞台运动)

      this._onMove = (e) => this._handleMove(e)
      this._onUp = () => {
        const d = this._dragging
        // ★ C6:批量拖拽结束,确认刷新批量面板 S/E 输入框最终值
        if (d && typeof d.type === 'string' && d.type.indexOf('batch-') === 0) {
          const pa = global.window.App && global.window.App.panelAdvanced
          if (pa && typeof pa._fillBatchCoordInputs === 'function') pa._fillBatchCoordInputs()
        }
        this._dragging = null
        document.removeEventListener('mousemove', this._onMove)
        document.removeEventListener('mouseup', this._onUp)
      }

      // ★ RAF tick:在 深度批量候选(任何模式) 或 enabled=true 且当前需要动画跟随(单选有 active 节点)时持续 render()
      this._renderTick = () => {
        this._renderRAF = null
        let need = false
        if (!this.picking) {
          // 深度批量候选或激活态:只要有 2 条以上全高级候选,就跟随帧刷新(弹幕在运动 → 框也要动)
          const dc = this._isDeepCandidateOnly()
          const da = typeof this.store.isDeepBatchAdvanced === 'function' ? this.store.isDeepBatchAdvanced() : false
          if (dc || da) { need = true }
          else if (this.enabled) {
            if (this._batchMode) need = false  // batchMode flag 冗余,用 dc/da
            else if (this.record && this.record.type === 'advanced') {
              const dm = this.engine.advanced.active.find((d) => d.id === this.record.id)
              need = !!(dm && dm.node)
            }
          }
        }
        this._needsAnimatedRender = !!need
        if (need) {
          try { this.render() } catch (err) { /* 不抛错以免 RAF 中断 */ }
          this._renderRAF = requestAnimationFrame(this._renderTick)
        }
      }

      store.onChange((evt, id, field) => this.onStore(evt, id, field))

      // ★ 注册锁定 veto(store.select/selectRange/deselect/toggleSelect 都会先调用)
      if (store && typeof store.setLockVeto === 'function') {
        store.setLockVeto(() => {
          // 返回 false 时阻止切换选中;未锁定时返回 true 允许
          return !this.isLocked()
        })
      }

      // ★ Ctrl+C / Ctrl+Shift+C 拦截:锁定态(单选或批量)下禁止复制(也拦截 Cmd+C)
      this._onCopyShortcut = (e) => {
        if (!this.isLocked()) return
        const metaC = (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')
        if (!metaC) return
        // 若焦点在可输入元素内(textarea/input[text] 等),允许用户复制文本,不拦截
        const t = (e.target && typeof e.target.tagName === 'string') ? String(e.target.tagName).toLowerCase() : ''
        const isInputInside = t === 'textarea' || t === 'input' || t === 'select' || e.target && (e.target.isContentEditable === true)
        if (isInputInside) return
        e.preventDefault()
        e.stopPropagation()
      }
      document.addEventListener('keydown', this._onCopyShortcut, true)
    }

    /** 当前是否处于「锁定态」:单选锁定 id 或 批量锁定 __batch__。 */
    isLocked() {
      if (!this._lockedId) return false
      if (this._lockedId === '__batch__') {
        // 批量锁定:检查当前是否仍在深度批量纯高级态(批量集合已空则不算锁定)
        return typeof this.store.isDeepBatchAdvanced === 'function' ? this.store.isDeepBatchAdvanced() : this.store.selectedIds.size >= 2
      }
      // 单选锁定:要求 store 里该 id 仍存在且为高级弹幕
      const r = this.store.get(this._lockedId)
      return !!(r && r.type === 'advanced')
    }

    onStore(evt, id, field) {
      if (evt === 'change' || evt === 'remove' || evt === 'select') {
        this._syncFromSelection()
      } else if (evt === 'replace' || evt === 'clear') {
        this.record = null
        this.render()
      }
      void field
    }

    /** ★ RAF 动画循环的启停控制:需要跟随运动时启动(若未启动),不需要时停止(若在跑)。*/
    _ensureRenderTick(start) {
      if (start) {
        if (this._renderRAF == null) {
          this._renderRAF = requestAnimationFrame(this._renderTick)
        }
      } else {
        // ★ 若当前仍然处于「深度批量候选态」→ 仍需要画框,停止 RAF 后下一次 select/变更会重开
        //   (这里不需要额外判断,按外部调用决定即可;外部仅在 setEnabled=false 且非 picking 时停,深度批量即使 setEnabled=false,
        //    _syncFromSelection 里也会 render 一次,并继续开 RAF 维持帧刷新)
        if (this._renderRAF != null) {
          cancelAnimationFrame(this._renderRAF)
          this._renderRAF = null
        }
        this._needsAnimatedRender = false
      }
    }

    /** 由 Editor 调用:编辑模式开关。
     * ★ 深度批量候选存在时,即使关闭编辑模式也继续 render(框常驻)、继续 RAF。*/
    setEnabled(on) {
      this.enabled = !!on
      if (!this.enabled) {
        this.record = null
        // ★ 关闭编辑模式时:仅当「无深度批量候选」时才停止 RAF;深度批量态仍然保留 RAF 跟随(弹幕在运动,框也要刷新)
        const dc = this._isDeepCandidateOnly()
        const da = typeof this.store.isDeepBatchAdvanced === 'function' ? this.store.isDeepBatchAdvanced() : false
        if (!dc && !da) {
          this._ensureRenderTick(false)
        }
      }
      this._syncFromSelection()
      // ★ 开启编辑模式 / 或 仍有深度批量候选 → 保 RAF 运行
      if (this.enabled || this._isDeepCandidateOnly() ||
          (typeof this.store.isDeepBatchAdvanced === 'function' && this.store.isDeepBatchAdvanced())) {
        this._ensureRenderTick(true)
      }
    }

    /** 由 Editor 调用:进入/退出拾取模式(拾取时隐藏 overlay)。 */
    setPicking(picking) {
      this.picking = !!picking
      this.render()
      if (this.picking) this._ensureRenderTick(false)
      else if (this.enabled) this._ensureRenderTick(true)
    }

    /** ★ 由 Editor 调用:进入/退出「深度批量纯高级」模式(批量操作手柄)。 */
    setBatchMode(on) {
      on = !!on
      if (this._batchMode === on) return
      this._batchMode = on
      this.render()
      // 切换批量模式后,检查 RAF 是否需要启动/重启动
      if (this.enabled && !this.picking) this._ensureRenderTick(true)
    }

    _syncFromSelection() {
      // ★ 批量锁定态:__batch__ 时保持深度批量纯高级选中集合不被意外清空
      if (this._lockedId === '__batch__') {
        if (typeof this.store.isDeepBatchAdvanced === 'function' && this.store.isDeepBatchAdvanced()) {
          // 保持批量模式开、record=null;强制重新渲染
          this._batchMode = true
          this.record = null
          this.render()
          this._applyLockVisuals()
          return
        }
        // 已离开深度批量态(批量集合已非纯高级或<2),解除批量锁定
        this._lockedId = null
      }
      // 锁定状态:保持锁定的弹幕为选中状态
      if (this._lockedId) {
        const lockedRec = this.store.get(this._lockedId)
        if (lockedRec && lockedRec.type === 'advanced') {
          this.record = lockedRec
          if (this.store.selectedId !== this._lockedId) {
            this.store.selectedId = this._lockedId
            this.store.selectedIds = new Set([this._lockedId])
            this.store._emit('select', this._lockedId, null)
          }
          this.render()
          this._applyLockVisuals()
          return
        }
        // 锁定的弹幕已被删除,解除锁定
        this._lockedId = null
      }
      const rec = this.store.getSelected()
      // 选中高级弹幕即显示 overlay(含离屏弹幕,便于列表选中编辑)
      if (this.enabled && !this.picking && rec && rec.type === 'advanced') {
        this.record = rec
      } else {
        this.record = null
      }
      this.render()
      // 选中变化后,统一刷新锁定灰化视觉
      this._applyLockVisuals()
      // ★ 选中变化后,若现在处于需要动画跟随的情况(存在 active 节点或批量态),启动 RAF
      if (this.enabled && !this.picking) this._ensureRenderTick(true)
    }

    /** 弹幕被销毁(生命结束/清场)时:若选中高级弹幕已不在屏,隐藏 overlay 防残留。
     *  若所有 active 节点都已消失,则停止 RAF,避免空转。 */
    onAdvEnded() {
      if (this._lockedId) return // 锁定时不响应弹幕结束
      const rec = this.store.getSelected()
      const active =
        !!rec &&
        rec.type === 'advanced' &&
        this.engine.advanced.active.some((d) => d.id === rec.id)
      if (!active) {
        this.record = null
        this.render()
        if (!this._batchMode) this._ensureRenderTick(false)
      }
    }

    /** 换算:单位(像素或百分比) -> 舞台实际渲染像素。
     * ★ displayScale:像素坐标的记录,引擎会 * displayScale 再 translate3d,
     *   所以 overlay 读 position 时也要 × displayScale 获得屏幕上的真实位置,
     *   这样 marker/框才能贴到弹幕节点上。*/
    _toPx(v, axis) {
      if (this.record.position.usePercent) {
        return v * (axis === 'x' ? this.engine.width : this.engine.height)
      }
      const s = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
      return v * s
    }

    /** 舞台实际渲染像素 -> 单位(按当前 usePercent,反向 displayScale 换算)。
     *  拖拽 marker/框得到的是屏幕像素,需要 ÷ displayScale 还原成逻辑像素(存盘时的 px)。*/
    _toUnit(px, axis) {
      if (this.record.position.usePercent) {
        return clamp(round2(px / (axis === 'x' ? this.engine.width : this.engine.height)), 0, 0.99)
      }
      const s = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
      const logicalPx = s > 0 ? (px / s) : px
      return clamp(round1(logicalPx), 0, 9999)
    }

    /** ★ 单选/批量锁定:统一灰化+禁用 复制类/多选类按钮(舞台菜单/高级菜单/列表/高级面板)。 */
    _applyLockVisuals() {
      const locked = this.isLocked()
      // 1. 舞台 ctx-menu:所有 textContent 是「复制」或「复制(从消失时间开始)」的按钮
      const ctxCopySelector = '#' + 'ctx-menu' + ' .' + 'ctx-copy-fromend-btn,' + '#' + 'ctx-menu' + ' button'
      try {
        const ctxMenu = document.querySelector('.' + 'ctx-menu') || document.querySelector('#' + 'ctx-menu') || null
        if (ctxMenu) {
          const btns = ctxMenu.querySelectorAll('button')
          for (const b of btns) {
            const txt = (b.textContent || '').trim()
            if (txt === '复制' || txt.indexOf('复制(从消失') === 0) {
              b.classList.toggle('lock-disabled', !!locked)
              // 复制已经 set pointer-events none 了,但再次保证点击时不触发
              if (locked) {
                b.setAttribute('disabled', 'disabled')
              } else {
                b.removeAttribute('disabled')
              }
            }
          }
        }
      } catch (_) {}
      // 2. adv-menu (高级弹幕舞台右键菜单)
      try {
        const advMenu = document.querySelector('.' + 'adv-menu') || null
        if (advMenu) {
          const btns = advMenu.querySelectorAll('button')
          for (const b of btns) {
            const txt = (b.textContent || '').trim()
            if (txt === '复制' || txt.indexOf('复制(从消失') === 0) {
              b.classList.toggle('lock-disabled', !!locked)
              if (locked) b.setAttribute('disabled', 'disabled'); else b.removeAttribute('disabled')
            }
          }
        }
      } catch (_) {}
      // 3. 高级面板顶部的「复制」按钮(id = pa-copy)
      try {
        const paCopy = document.getElementById('pa-copy')
        if (paCopy) {
          paCopy.classList.toggle('lock-disabled', !!locked)
          if (locked) paCopy.setAttribute('disabled', 'disabled'); else paCopy.removeAttribute('disabled')
        }
      } catch (_) {}
      // 4. 列表里复制按钮(通常为 .btn-copy / .dm-copy-btn 类):泛化查找 common class 名
      try {
        const listSel = ['.btn-copy', '.dm-copy-btn', '.list-copy', '.copy-btn']
        const app = global.window.App || global.App || null
        const list = app && app.list ? app.list : null
        const rootList = (list && list.root) ? list.root : (document.querySelector('#list-body') ? document.querySelector('#list-body').parentNode : document.body)
        for (const sel of listSel) {
          const all = rootList.querySelectorAll(sel)
          for (const el of all) {
            el.classList.toggle('lock-disabled', !!locked)
            if (locked) el.setAttribute('disabled', 'disabled'); else el.removeAttribute('disabled')
          }
        }
        // 5. 列表行(tr/td .dm-row):多选(Ctrl 单击/Shift 范围/整行点击)时,灰化整行的选择交互
        const rows = rootList.querySelectorAll('tr[data-id], tr.list-row, tbody tr')
        if (rows && rows.length) {
          for (const row of rows) {
            row.classList.toggle('lock-disabled', !!locked)
          }
        }
        // 6. 列表内批量操作按钮(如「删除选中」「批量删除」「批量复制」这类带批量语义的按钮):灰化
        const batchSels = ['#list-delete-sel', '.batch-delete', '.list-batch-delete', '.btn-delete-selected', '.btn-batch-copy', '.batch-copy']
        for (const sel of batchSels) {
          const all = document.querySelectorAll(sel)
          for (const el of all) {
            if (locked) {
              el.classList.add('lock-disabled')
              el.setAttribute('disabled', 'disabled')
            } else {
              el.classList.remove('lock-disabled')
              el.removeAttribute('disabled')
            }
          }
        }
      } catch (_) {}
      // 7. 「锁定」导致:选中条目无法被点击列表单选/多选时,把 tbody 的 click 选中选择类回调整体禁用(通过 list 的 setLockVeto 已经处理),
      //    这里再给 list 的根容器加一个视觉提示(锁定态灰框)
      try {
        const panel = document.getElementById('list-panel') || document.querySelector('.list-section')
        if (panel) panel.classList.toggle('lock-disabled', !!locked)
      } catch (_) {}
    }

    render() {
      // ★ 深度批量纯高级「激活态」(选中集与 list._batchIds 完全一致,>=2,全高级,非草稿)
      const deepActive = !this.picking && (typeof this.store.isDeepBatchAdvanced === 'function' ? this.store.isDeepBatchAdvanced() : false)
      // ★ 判定:深度批量「候选态」(list._batchIds 自身满足 >=2 且全高级非草稿,但当前 selectedIds 不一定匹配——偏离态)
      const deepCandidate = this._isDeepCandidateOnly()
      // ★ D9:深度候选存在但单选某条高级弹幕 → 显示单选手柄(边框+四角),不显示批量框
      const rec = this.record
      const hasDeviatedSingle = !deepActive && deepCandidate && rec && rec.type === 'advanced' && !this.picking
      // ★ 关键规则:只要深度批量候选存在(>=2 条全高级),不管是否开了编辑模式 → 舞台都画框
      //   但 D9 例外:单选某条高级弹幕时,让位给单选手柄
      const needsBatch = (deepActive || deepCandidate) && !this.picking && !hasDeviatedSingle
      if (needsBatch) {
        this._renderBatch(deepActive)
        return
      }
      // D9:偏离态单选 → 编辑模式开时显示单选手柄,否则显示批量框
      if (hasDeviatedSingle) {
        if (this.enabled) {
          this._renderSingleFromRecord()
        } else {
          this._renderBatch(false)
        }
        return
      }
      // ★ 单条高级弹幕:仍然要求编辑模式 enabled(与原行为保持一致)
      if (!rec || !this.enabled || this.picking) {
        this.svg.innerHTML = ''
        return
      }
      this._renderSingleFromRecord()
    }

    /** 渲染单条高级弹幕的操作手柄(边框+四角+S/E marker)。
     *  D9:批量偏离态单选时复用此方法,显示单选手柄而非批量手柄。*/
    _renderSingleFromRecord() {
      const rec = this.record
      if (!rec) { this.svg.innerHTML = ''; return }
      const W = this.engine.width
      const H = this.engine.height
      if (!W || !H) return
      const p = rec.position
      const usePercent = !!p.usePercent
      const displayScale = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
      // ★ displayScale:overlay 使用「逻辑舞台像素」(存盘时用的 px),绘制时需 /displayScale
      //   百分比模式不受 displayScale 影响;像素模式下引擎实际渲染位置是 record.px * displayScale
      const posToPx = (u, axis) => {
        if (usePercent) return u * (axis === 'x' ? W : H)
        return (u * displayScale) // 逻辑像素 → 舞台实际渲染像素(与 engine.advanced.update 一致)
      }
      const sx = posToPx(p.startX, 'x')
      const sy = posToPx(p.startY, 'y')
      const ex = posToPx(p.endX, 'x')
      const ey = posToPx(p.endY, 'y')

      this.svg.setAttribute('width', String(W))
      this.svg.setAttribute('height', String(H))
      this.svg.innerHTML = ''

      // 起始/结束点 marker + 连线(贴 record 的 position 像素坐标,不跟随运动插值)
      const line = svgEl('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: 'eo-line' })
      this.svg.appendChild(line)

      // 选定框:若高级弹幕在屏 → 按 dm.node 真实 bbox 绘制「跟随旋转的多边形外框」;
      //         否则退化为 axis-aligned 的 rect(基于 startX/Y + 估算尺寸)
      const dm = this.engine.advanced.active.find((d) => d.id === rec.id)
      const drawn = this._renderSingleSelectedBox(dm, rec, sx, sy, W, H, displayScale, usePercent)
      if (!drawn) return

      // S/E marker 最后追加(在最上层,不被选定框遮住)
      this.svg.appendChild(this._marker('start', sx, sy))
      this.svg.appendChild(this._marker('end', ex, ey))

      // 顶部四个手柄(根据选定框顶部布局,Z/Y/移动/锁定)
      this._renderSingleHandles(dm, rec, sx, sy, W, H, displayScale, usePercent)
    }

    /** ★ 判断是否仅满足「深度批量候选」(list._batchIds 自身全高级 >=2,但 selectedIds 不一定匹配):
     *  → 用于偏离态:仅显示一个可点击的批量外框,不显示批量操作手柄/S-E,点击后跳回激活态。*/
    _isDeepCandidateOnly() {
      try {
        const list = global.window.App && global.window.App.list
        if (!list || !list._batchIds) return false
        const ids = list._batchIds
        if (ids.size < 2) return false
        for (const id of ids) {
          const r = this.store.get(id)
          if (!r || r.type !== 'advanced' || r === this.store.draft) return false
        }
        return true
      } catch (_) { return false }
    }

    _cornerHandle(x, y, cdx, cdy) {
      const g = svgEl('g', { class: 'eo-handle eo-corner', transform: 'translate(' + x + ',' + y + ')' })
      const r = svgEl('rect', { x: -6, y: -6, width: 12, height: 12, fill: '#fff', stroke: '#fb7299', 'stroke-width': 1.5, rx: 2 })
      g.appendChild(r)
      const t = svgEl('text', { y: 3.5, fill: '#fb7299' })
      t.textContent = '⤢'
      g.appendChild(t)
      g.style.cursor = cdx === cdy ? 'nwse-resize' : 'nesw-resize'
      g.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const rec = this.record
        if (!rec) return
        this._dragging = {
          type: 'resize',
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startFont: rec.style.fontSize,
        }
        document.addEventListener('mousemove', this._onMove)
        document.addEventListener('mouseup', this._onUp)
      })
      g.addEventListener('click', (e) => e.stopPropagation())
      return g
    }

    /** ★ 单选高级弹幕:绘制「跟随旋转的选定框」(多边形) + 四角手柄。
     *  dm.node 在屏 → 计算 4 个角点在 rotateZ 旋转后的位置,用 SVG polygon 绘制外框;
     *  否则退化为 axis-aligned 的矩形 + corner handles。
     * @returns {boolean} 是否成功绘制(失败时 render 返回) */
    _renderSingleSelectedBox(dm, rec, sx, sy, W, H, displayScale, usePercent) {
      // 先估算节点尺寸(用于回退时):
      let nodeW = 160, nodeH = 44
      if (dm && dm.node) {
        const ow = dm.node.offsetWidth || 0
        const oh = dm.node.offsetHeight || 0
        if (ow > 0) nodeW = ow
        if (oh > 0) nodeH = oh
      }
      // 7px padding(与原逻辑保持一致:node.w+14)
      const pad = 7
      // 节点在舞台坐标系中的「参考中心 x,y」(外框外扩前)
      let refX = sx, refY = sy  // 回退:把 startX/Y 作为文本左上(advanced.js 也是把 pos 当 translate 左上)
      // ★ C4:不再解析 style.transform 的 translate3d(运动中易解析失败/不同步 → 选中框严重偏离),
      //   直接用 dm.node.getBoundingClientRect() 获取「实际渲染位置」(含平移/旋转/插值效果),
      //   选定框 = div 实际外接矩形(贴合 div 边框),四角方块在边框四角上。
      const stageRect = (this.engine.stage && this.engine.stage.getBoundingClientRect) ? this.engine.stage.getBoundingClientRect() : null
      let hasRotatedCorners = false
      let corners = [[refX - pad, refY - pad], [refX - pad + nodeW + pad * 2, refY - pad], [refX - pad + nodeW + pad * 2, refY - pad + nodeH + pad * 2], [refX - pad, refY - pad + nodeH + pad * 2]]
      let outerMinX = refX - pad, outerMinY = refY - pad, outerMaxX = refX + nodeW + pad, outerMaxY = refY + nodeH + pad
      if (dm && dm.node && stageRect) {
        try {
          const nodeRect = dm.node.getBoundingClientRect()
          const tx = nodeRect.left - stageRect.left
          const ty = nodeRect.top - stageRect.top
          const nw = nodeRect.width
          const nh = nodeRect.height
          if (nw > 0 && nh > 0 && isFinite(tx) && isFinite(ty)) {
            // div 实际外接矩形(axis-aligned,含旋转外扩)+ pad 让框略大于 div 便于观察
            corners = [
              [tx - pad, ty - pad],
              [tx + nw + pad, ty - pad],
              [tx + nw + pad, ty + nh + pad],
              [tx - pad, ty + nh + pad],
            ]
            outerMinX = tx - pad; outerMinY = ty - pad
            outerMaxX = tx + nw + pad; outerMaxY = ty + nh + pad
            hasRotatedCorners = true
          }
        } catch (_) { hasRotatedCorners = false }
      }
      if (!hasRotatedCorners) {
        corners = [
          [refX - pad, refY - pad],
          [refX - pad + nodeW + pad * 2, refY - pad],
          [refX - pad + nodeW + pad * 2, refY - pad + nodeH + pad * 2],
          [refX - pad, refY - pad + nodeH + pad * 2],
        ]
        outerMinX = refX - pad
        outerMinY = refY - pad
        outerMaxX = refX + nodeW + pad
        outerMaxY = refY + nodeH + pad
      }
      // 绘制多边形(旋转外框)
      const pts = corners.map((c) => (round1(c[0])) + ',' + (round1(c[1]))).join(' ')
      const poly = svgEl('polygon', {
        points: pts,
        class: 'eo-box eo-box-rotated',
      })
      // eo-box 默认有 stroke-dasharray;旋转框保持一样的填充和描边
      poly.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const ta = document.getElementById('pa-content')
        if (ta) ta.focus()
      })
      poly.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this._showAdvMenu(e.clientX, e.clientY)
      })
      this.svg.appendChild(poly)

      // 四角手柄:放在「未旋转的」axis-aligned bbox 四边上中心?不对:
      // ⤢ 是"对角缩放"的语义,所以放在联合 bbox 的四角(即 outerMinX/Y/X2/Y2 的 4 个端点)
      const cornerAnchors = [
        [outerMinX, outerMinY, -1, -1],
        [outerMaxX, outerMinY, 1, -1],
        [outerMaxX, outerMaxY, 1, 1],
        [outerMinX, outerMaxY, -1, 1],
      ]
      for (const [cx, cy, cdx, cdy] of cornerAnchors) {
        this.svg.appendChild(this._cornerHandle(cx, cy, cdx, cdy))
      }
      // 保存给 _renderSingleHandles 用(存到 this,下一帧 RAF render 会覆盖,所以是一次性的)
      this._lastSingleOuter = { minX: outerMinX, minY: outerMinY, maxX: outerMaxX, maxY: outerMaxY, w: outerMaxX - outerMinX, h: outerMaxY - outerMinY }
      return true
    }

    /** ★ 单选:绘制 Z/Y/移动/锁定 四个顶部手柄(根据联合 bbox 的右上外侧布局)。 */
    _renderSingleHandles(dm, rec, sx, sy, W, H, displayScale, usePercent) {
      const outer = this._lastSingleOuter
      if (!outer) return
      const handleW = 28
      const handleGap = 4
      const lockW = 24
      const totalW = handleW * 3 + handleGap * 2 + lockW + handleGap
      let bhx, bhy
      const rightSpace = W - outer.maxX - 20
      if (rightSpace >= totalW) {
        bhx = outer.maxX + 10
      } else if (outer.minX - 20 >= totalW) {
        bhx = outer.minX - totalW - 10
      } else {
        bhx = Math.min(Math.max(outer.maxX + 10, 20), W - totalW - 20)
      }
      bhy = Math.max(outer.minY - 46, 14)
      if (bhy < 14) bhy = Math.min(outer.minY + 50, H - 20)
      this.svg.appendChild(this._handle('z', bhx, bhy, 'Z'))
      this.svg.appendChild(this._handle('y', bhx + handleW + handleGap, bhy, 'Y'))
      this.svg.appendChild(this._handle('move', bhx + (handleW + handleGap) * 2, bhy, '👆'))
      // 锁定手柄
      const locked = this._lockedId === rec.id
      const lockLabel = locked ? '🔒' : '🔓'
      const lockColor = locked ? '#e74c3c' : '#27ae60'
      const lockX = bhx + (handleW + handleGap) * 2 + handleW + handleGap + lockW / 2
      const lockG = svgEl('g', { class: 'eo-handle eo-lock', transform: 'translate(' + lockX + ',' + bhy + ')' })
      lockG.appendChild(svgEl('circle', { r: 11, fill: lockColor }))
      const lockT = svgEl('text', { y: 4, 'font-size': '12' })
      lockT.textContent = lockLabel
      lockG.appendChild(lockT)
      lockG.style.cursor = 'pointer'
      lockG.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      lockG.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggleLock()
      })
      this.svg.appendChild(lockG)
    }

    /** 高级弹幕右键菜单(与 ctx-menu 条目一致):时间调整 + 颜色 + 复制 + 复制(从消失时间开始) + 保存(条件显示) + 删除。 */
    _showAdvMenu(x, y) {
      this._advMenu = this._advMenu || this._buildAdvMenu()
      const menu = this._advMenu
      const rec = this.record
      menu.dataset.id = rec && rec.id ? String(rec.id) : ''
      if (rec && rec.style) {
        const colorEl = menu.querySelector('#adv-menu-color')
        if (colorEl) colorEl.value = global.ColorUtil.normalizeHex(rec.style.color, '#FFFFFF')
      }
      // ★ 保存按钮条件显示 + 删除按钮批量 N 条文案(与 ctx-menu 对齐)
      const saveBtn = menu.querySelector('.adv-menu-save')
      if (saveBtn) {
        const isDraft = !!rec && this.store.draft === rec
        const inPool = !!rec && rec.id && !!this.store.get(rec.id) && !isDraft
        const showSave = isDraft || inPool
        saveBtn.style.display = showSave ? '' : 'none'
        saveBtn.textContent = isDraft ? '保存(发送)' : '保存'
      }
      const delBtn = menu.querySelector('.adv-menu-del')
      if (delBtn) {
        const n = this.store.selectedIds ? this.store.selectedIds.size : 0
        delBtn.textContent = n > 1 ? '删除选中(' + n + '条)' : '删除'
      }
      // ★ 按当前锁定状态统一灰化复制类按钮
      this._applyLockVisuals()
      menu.hidden = false
      const mw = menu.offsetWidth || 220
      const mh = menu.offsetHeight || 180
      menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px'
      menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px'
      this._updateAdvMenuTime()
    }

    _buildAdvMenu() {
      const menu = document.createElement('div')
      menu.className = 'adv-menu ctx-menu' // ★ 复用 ctx-menu 的 CSS 样式(同外观)
      menu.hidden = true
      menu.dataset.id = ''
      // 时间调整
      const row1 = document.createElement('div')
      row1.className = 'ctx-menu-row'
      row1.innerHTML = '<span>时间:</span>'
      const minus = this._timeBtn('-')
      const plus = this._timeBtn('+')
      const timeVal = document.createElement('b')
      timeVal.id = 'adv-menu-time'
      timeVal.title = '点击直接修改时间'
      timeVal.style.cursor = 'pointer'
      timeVal.addEventListener('click', (e) => {
        e.stopPropagation()
        this._editAdvMenuTime(timeVal)
      })
      row1.appendChild(minus)
      row1.appendChild(timeVal)
      row1.appendChild(plus)
      const row1Sep = document.createElement('div')
      row1Sep.className = 'ctx-menu-sep'
      row1.appendChild(row1Sep)
      // 颜色
      const row2 = document.createElement('div')
      row2.className = 'ctx-menu-row'
      row2.innerHTML = '<span>颜色:</span>'
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.id = 'adv-menu-color'
      colorInput.addEventListener('input', () => {
        const id = menu.dataset.id
        const rec = id ? this.store.get(id) : (this.record || null)
        if (rec) this.store.updateDeep(rec.id, 'style.color', colorInput.value.toUpperCase())
      })
      row2.appendChild(colorInput)
      // 取色器
      const pickBtn = document.createElement('button')
      pickBtn.textContent = '取色'
      pickBtn.className = 'ctx-menu-pick'
      pickBtn.title = '点击后再点击任意弹幕拾取颜色'
      pickBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const id = menu.dataset.id
        const rec = id ? this.store.get(id) : (this.record || null)
        if (!rec) return
        this.editor._startColorPick(rec.id, colorInput)
      })
      row2.appendChild(pickBtn)
      // 分隔线
      const sep = document.createElement('div')
      sep.className = 'ctx-menu-sep'
      // 复制
      const dup = document.createElement('button')
      dup.textContent = '复制'
      dup.className = 'adv-menu-dup adv-copy-btn'
      dup.addEventListener('click', () => {
        const id = menu.dataset.id || (this.record && this.record.id)
        menu.hidden = true
        if (id) {
          const copy = this.store.duplicate(id)
          if (copy) this.store.select(copy.id)
        }
      })
      // ★ 复制(从消失时间开始)(与 ctx-menu 保持完全一致条目)
      const dupEnd = document.createElement('button')
      dupEnd.textContent = '复制(从消失时间开始)'
      dupEnd.className = 'adv-menu-dup-end adv-copy-btn'
      dupEnd.addEventListener('click', () => {
        const id = menu.dataset.id || (this.record && this.record.id)
        menu.hidden = true
        if (id) {
          const copy = this.store.duplicateFromEndTime(id)
          if (copy) this.store.select(copy.id)
        }
      })
      // ★ 保存(条件显示):草稿 → 发送;已入池 → 保存所有改动到文件
      const saveBtn = document.createElement('button')
      saveBtn.textContent = '保存'
      saveBtn.className = 'adv-menu-save adv-save-btn'
      saveBtn.addEventListener('click', () => {
        menu.hidden = true
        const app = global.window.App
        const rec = this.record
        if (!rec) return
        const controls = app && app.controls
        const isDraft = this.store.draft === rec
        if (isDraft) {
          // 草稿:等价于高级弹幕发送
          if (controls && typeof controls.validateAndSend === 'function') controls.validateAndSend('advanced')
        } else {
          // 已入池:执行 Ctrl+S 对应入口(保存到 start.json)
          if (controls && typeof controls.saveDanmakuFile === 'function') controls.saveDanmakuFile()
          else if (app && app.list && typeof app.list._onSaveClick === 'function') app.list._onSaveClick()
        }
      })
      // 删除
      const del = document.createElement('button')
      del.textContent = '删除'
      del.className = 'adv-menu-del'
      del.addEventListener('click', () => {
        menu.hidden = true
        const app = global.window.App
        if (this.store.selectedIds && this.store.selectedIds.size > 1) {
          // ★ 批量删除:需要先通过范围校验
          const list = app && app.list
          const ids = Array.from(this.store.selectedIds)
          if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete(ids)) {
            const player = app && app.player
            if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
            return
          }
          this.store.removeMany(ids)
        } else {
          const rec = this.record
          if (rec) {
            const list = app && app.list
            if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete([rec.id])) {
              const player = app && app.player
              if (player) player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
              return
            }
            this.store.remove(rec.id)
          }
        }
      })
      menu.appendChild(row1)
      menu.appendChild(row2)
      menu.appendChild(sep)
      menu.appendChild(dup)
      menu.appendChild(dupEnd)
      menu.appendChild(saveBtn)
      menu.appendChild(del)
      // ★ 「取消当前选择」(把被右键的那 1 条弹幕从所有选择集中清除)
      const sepClearSel = document.createElement('div')
      sepClearSel.className = 'ctx-menu-sep'
      menu.appendChild(sepClearSel)
      const clearSel = document.createElement('button')
      clearSel.textContent = '取消当前选择'
      clearSel.className = 'adv-menu-clear-sel'
      clearSel.title = '把被右键的这 1 条弹幕从当前选择(单选/轻度/深度批量)中移除'
      clearSel.addEventListener('click', () => {
        menu.hidden = true
        const id = menu.dataset.id || (this.record && this.record.id)
        if (!id) return
        const app = global.window.App
        const list = app && app.list
        if (list && typeof list.clearSelectionOf === 'function') {
          list.clearSelectionOf(id)
        }
      })
      menu.appendChild(clearSel)
      menu.addEventListener('click', (e) => {
        e.stopPropagation()
      })
      document.body.appendChild(menu)
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.adv-menu')) menu.hidden = true
      })
      return menu
    }

    _timeBtn(sign) {
      const b = document.createElement('button')
      b.textContent = sign === '-' ? '◀' : '▶'
      let timer = null
      const step = (e) => {
        const rec = this.record
        if (!rec) return
        const delta = e.ctrlKey ? 1 : 0.1
        const t = Math.max(0, Math.round((rec.timeSec + (sign === '-' ? -delta : delta)) * 100) / 100)
        this.store.update(rec.id, { timeSec: t }, 'timeSec')
        this._updateAdvMenuTime()
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

    _updateAdvMenuTime() {
      const rec = this.record
      const el = document.getElementById('adv-menu-time')
      if (el && rec) el.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec)
    }

    /** ★ 高级弹幕右键菜单时间可直接编辑(与 ctx-menu 的 _editCtxMenuTime 完全一致):
     *   hh:mm:ss 或带两位小数 hh:mm:ss.cc;Enter 确认;Escape 取消。*/
    _editAdvMenuTime(timeValEl) {
      const rec = this.record
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
      timeValEl.replaceWith(input)
      input.focus()
      input.select()
      const commit = () => {
        const parsed = global.TimeUtil.strToTime(input.value)
        if (parsed != null) {
          const t = Math.max(0, Math.round(parsed * 100) / 100)
          this.store.update(rec.id, { timeSec: t }, 'timeSec')
          timeValEl.textContent = global.TimeUtil.timeToStrPrecise(t)
        } else {
          timeValEl.textContent = global.TimeUtil.timeToStrPrecise(rec.timeSec || 0)
        }
        input.replaceWith(timeValEl)
      }
      input.addEventListener('blur', commit)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
        else if (e.key === 'Escape') { e.preventDefault(); input.value = currentStr; input.blur() }
        e.stopPropagation()
      })
    }

    _marker(type, x, y) {
      const g = svgEl('g', { class: 'eo-marker ' + type, transform: 'translate(' + x + ',' + y + ')' })
      g.appendChild(svgEl('circle', { r: 7 }))
      const t = svgEl('text', { y: 4, class: 'eo-label' })
      t.textContent = type === 'start' ? 'S' : 'E'
      g.appendChild(t)
      this._makeDraggable(g, type)
      return g
    }

    _handle(type, x, y, label) {
      const g = svgEl('g', { class: 'eo-handle', transform: 'translate(' + x + ',' + y + ')' })
      const color = type === 'move' ? '#f39c12' : type === 'z' ? '#9b59b6' : '#3498db'
      g.appendChild(svgEl('circle', { r: 11, fill: color }))
      const t = svgEl('text', { y: 4 })
      t.textContent = label
      g.appendChild(t)
      this._makeDraggable(g, type)
      return g
    }

    _makeDraggable(g, type) {
      g.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const rec = this.record
        if (!rec) return
        this._dragging = {
          type: type,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          startSX: rec.position.startX,
          startSY: rec.position.startY,
          startEX: rec.position.endX,
          startEY: rec.position.endY,
          startZ: rec.rotation.z,
          startYr: rec.rotation.y,
        }
        document.addEventListener('mousemove', this._onMove)
        document.addEventListener('mouseup', this._onUp)
      })
      g.addEventListener('click', (e) => e.stopPropagation())
    }

    _handleMove(e) {
      const d = this._dragging
      if (!d) return
      const dx = e.clientX - d.startMouseX
      const dy = e.clientY - d.startMouseY
      // ★ 批量平移/起始/结束:每条弹幕使用 mousedown 瞬间记录的舞台像素快照,加上累计 dx/dy 后转回单位,
      // 每帧计算目标坐标前先做越界预检:只要任何一条越界,这一帧整体中止移动(AC14 + N2 瞬移修复)
      // ★ displayScale:回写逻辑像素时,必须把「拖拽后的屏幕像素」 ÷ displayScale 还原成逻辑 px,
      //   再用 displayScale × 获得屏幕上的正确位置。
      if (d.type === 'batch-move' || d.type === 'batch-start' || d.type === 'batch-end') {
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : new Set()
        const width = this.engine.width
        const height = this.engine.height
        const displayScale = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
        const pending = []
        let anyOob = false
        for (const id of ids) {
          const snap = d.perRec && d.perRec[id]
          const rec = this.store.get(id)
          if (!snap || !rec || !rec.position) continue
          const usePct = !!snap.usePercent
          const ds = usePct ? 1 : displayScale // 百分比不受 displayScale 影响
          // 回写逻辑坐标:屏幕像素(快照+dx/dy) → 先 /ds 得逻辑像素(若百分比,ds=1 等价于直接像素/舞台尺寸得百分比)
          const screenPxToUnit = (screenPx, axis) => {
            if (usePct) return clamp(round2(screenPx / (axis === 'x' ? width : height)), 0, 0.99)
            // 像素模式:screenPx 是屏幕上的实际像素,engine.update()里会 * ds;所以存盘值 = screenPx / ds
            const logicalPx = ds > 0 ? (screenPx / ds) : screenPx
            return clamp(round1(logicalPx), 0, 9999)
          }
          let nsxPx, nsyPx, nexPx, neyPx
          if (d.type === 'batch-start') {
            // startX/Y 随鼠标移动,endX/Y 保持按下瞬间
            nsxPx = snap.snapSXPx + dx
            nsyPx = snap.snapSYPx + dy
            nexPx = snap.snapEXPx
            neyPx = snap.snapEYPx
          } else if (d.type === 'batch-end') {
            nsxPx = snap.snapSXPx
            nsyPx = snap.snapSYPx
            nexPx = snap.snapEXPx + dx
            neyPx = snap.snapEYPx + dy
          } else {
            // batch-move: start/end 同步平移(快照 + 同一 dx/dy)
            nsxPx = snap.snapSXPx + dx
            nsyPx = snap.snapSYPx + dy
            nexPx = snap.snapEXPx + dx
            neyPx = snap.snapEYPx + dy
          }
          const nsxu = screenPxToUnit(nsxPx, 'x')
          const nsyu = screenPxToUnit(nsyPx, 'y')
          const nexu = screenPxToUnit(nexPx, 'x')
          const neyu = screenPxToUnit(neyPx, 'y')
          // 越界判定:与 clamp 后值不等或超出合法范围即视为越界
          const isOob =
            (usePct && (nsxu < 0 || nsxu > 0.99 || nsyu < 0 || nsyu > 0.99 || nexu < 0 || nexu > 0.99 || neyu < 0 || neyu > 0.99)) ||
            (!usePct && (nsxu < 0 || nsxu > 9999 || nsyu < 0 || nsyu > 9999 || nexu < 0 || nexu > 9999 || neyu < 0 || neyu > 9999)) ||
            !isFinite(nsxPx) || !isFinite(nsyPx) || !isFinite(nexPx) || !isFinite(neyPx)
          if (isOob) { anyOob = true; break }
          pending.push([id, nsxu, nsyu, nexu, neyu])
        }
        if (anyOob) return
        for (const [id, nsxu, nsyu, nexu, neyu] of pending) {
          this.store.updateDeep(id, 'position.startX', nsxu)
          this.store.updateDeep(id, 'position.startY', nsyu)
          this.store.updateDeep(id, 'position.endX', nexu)
          this.store.updateDeep(id, 'position.endY', neyu)
        }
        // ★ C6:拖拽中实时刷新批量面板 S/E 输入框,让面板值跟随手柄移动
        const _pa = global.window.App && global.window.App.panelAdvanced
        if (_pa && typeof _pa._fillBatchCoordInputs === 'function') _pa._fillBatchCoordInputs()
        return
      }
      if (d.type === 'batch-z' || d.type === 'batch-y') {
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : new Set()
        for (const id of ids) {
          const rec = this.store.get(id)
          if (!rec || !rec.rotation) continue
          if (d.type === 'batch-z') {
            const startZ = (d.perRec && d.perRec[id] && typeof d.perRec[id].z === 'number') ? d.perRec[id].z : (rec.rotation.z || 0)
            const z = clamp(Math.round((startZ + dx * 1.2) * 10) / 10, 0, 360)
            this.store.updateDeep(id, 'rotation.z', z)
          } else {
            const startYr = (d.perRec && d.perRec[id] && typeof d.perRec[id].y === 'number') ? d.perRec[id].y : (rec.rotation.y || 0)
            const y = clamp(Math.round((startYr + dx * 1.2) * 10) / 10, 0, 360)
            this.store.updateDeep(id, 'rotation.y', y)
          }
        }
        return
      }
      const rec = this.record
      if (!rec) return
      // 统一:把起始单位先转成像素,加像素增量后再转回单位,避免百分比模式混算归 0
      const pxOf = (unit, axis) => this._toPx(unit, axis)
      const toUnit = (px, axis) => this._toUnit(px, axis)
      switch (d.type) {
        case 'start': {
          const nx = pxOf(d.startSX, 'x') + dx
          const ny = pxOf(d.startSY, 'y') + dy
          this.store.updateDeep(rec.id, 'position.startX', toUnit(nx, 'x'))
          this.store.updateDeep(rec.id, 'position.startY', toUnit(ny, 'y'))
          break
        }
        case 'end': {
          const nx = pxOf(d.startEX, 'x') + dx
          const ny = pxOf(d.startEY, 'y') + dy
          this.store.updateDeep(rec.id, 'position.endX', toUnit(nx, 'x'))
          this.store.updateDeep(rec.id, 'position.endY', toUnit(ny, 'y'))
          break
        }
        case 'move': {
          // 整体平移:起点与终点同加像素增量,保持相对位移
          const nsx = pxOf(d.startSX, 'x') + dx
          const nsy = pxOf(d.startSY, 'y') + dy
          const nex = pxOf(d.startEX, 'x') + dx
          const ney = pxOf(d.startEY, 'y') + dy
          this.store.updateDeep(rec.id, 'position.startX', toUnit(nsx, 'x'))
          this.store.updateDeep(rec.id, 'position.startY', toUnit(nsy, 'y'))
          this.store.updateDeep(rec.id, 'position.endX', toUnit(nex, 'x'))
          this.store.updateDeep(rec.id, 'position.endY', toUnit(ney, 'y'))
          break
        }
        case 'resize': {
          // 四角放大:改变字号(同步面板) —— 高级弹幕字号仅支持整数,步长=1,避免出现小数
          const nf = clamp(Math.round(d.startFont + dx * 1), 10, 127)
          this.store.updateDeep(rec.id, 'style.fontSize', nf)
          break
        }
        case 'z': {
          const z = clamp(Math.round((d.startZ + dx * 1.2) * 10) / 10, 0, 360)
          this.store.updateDeep(rec.id, 'rotation.z', z)
          break
        }
        case 'y': {
          // Y 旋转:左右拖动(符合直觉)
          const y = clamp(Math.round((d.startYr + dx * 1.2) * 10) / 10, 0, 360)
          this.store.updateDeep(rec.id, 'rotation.y', y)
          break
        }
      }
    }

    toggleLock() {
      const rec = this.record
      if (!rec) return
      if (this._lockedId === rec.id) {
        this._lockedId = null
      } else {
        this._lockedId = rec.id
      }
      this._syncFromSelection()
    }

    isLocked() {
      return this._lockedId != null
    }

    lockedId() {
      return this._lockedId
    }

    /** 深度批量纯高级弹幕:联合 BBox + S/E marker(S/E 重合在框左上角,E 最上层显示) + 批量手柄。
     * @param {boolean} active true=激活态(显示完整批量面板+所有手柄),false=偏离态(仅框可点击跳回)*/
    _renderBatch(active) {
      const W = this.engine.width
      const H = this.engine.height
      if (!W || !H) { this.svg.innerHTML = ''; return }
      this.svg.setAttribute('width', String(W))
      this.svg.setAttribute('height', String(H))
      this.svg.innerHTML = ''
      const ids = this._getBatchIds()
      if (ids.size < 2) return
      const displayScale = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1

      // 1. 计算每个弹幕在舞台坐标系的「当前渲染 4 角点」(跟随旋转),再合并出整个批量的 axis-aligned 外包围盒(永远不旋转)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      let hasBox = false
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || !rec.position) continue
        const dm = this.engine.advanced.active.find((d) => d.id === id)
        // --- 估算单条弹幕在屏幕上的 4 角点 ---
        let nodeW = 160, nodeH = 44
        if (dm && dm.node) {
          const ow = dm.node.offsetWidth || 0
          const oh = dm.node.offsetHeight || 0
          if (ow > 0) nodeW = ow
          if (oh > 0) nodeH = oh
        }
        const pad = 7
        const usePercent = !!rec.position.usePercent
        let tx, ty
        // 读取已渲染的 translate 位置(最准确)
        let gotT = false
        if (dm && dm.node) {
          const tStr = dm.node.style.transform || ''
          const m2 = /translate3d\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(tStr)
          if (m2) {
            tx = parseFloat(m2[1]); ty = parseFloat(m2[2])
            gotT = isFinite(tx) && isFinite(ty)
          }
        }
        if (!gotT) {
          if (usePercent) {
            tx = rec.position.startX * W
            ty = rec.position.startY * H
          } else {
            tx = rec.position.startX * displayScale
            ty = rec.position.startY * displayScale
          }
        }
        const rotZDeg = (rec.rotation && typeof rec.rotation.z === 'number') ? rec.rotation.z : 0
        const raw = [
          [tx - pad, ty - pad],
          [tx - pad + nodeW + pad * 2, ty - pad],
          [tx - pad + nodeW + pad * 2, ty - pad + nodeH + pad * 2],
          [tx - pad, ty - pad + nodeH + pad * 2],
        ]
        const cx2 = tx + nodeW / 2
        const cy2 = ty + nodeH / 2
        const rad = (rotZDeg || 0) * Math.PI / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        const corners = raw.map(([x, y]) => {
          const ddx = x - cx2
          const ddy = y - cy2
          return [cx2 + ddx * cos - ddy * sin, cy2 + ddx * sin + ddy * cos]
        })
        // --- 绘制子框(淡虚线,单条范围) ---
        const sub = svgEl('polygon', {
          points: corners.map((c) => round1(c[0]) + ',' + round1(c[1])).join(' '),
          fill: 'none', stroke: '#fb7299', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.6,
        })
        this.svg.appendChild(sub)
        for (const [cx, cy] of corners) {
          if (!isFinite(cx) || !isFinite(cy)) continue
          if (cx < minX) minX = cx
          if (cy < minY) minY = cy
          if (cx > maxX) maxX = cx
          if (cy > maxY) maxY = cy
        }
        hasBox = true
      }
      if (!hasBox) return
      // 外框 padding
      minX -= 6; minY -= 6; maxX += 6; maxY += 6
      const bw = Math.max(20, maxX - minX)
      const bh = Math.max(20, maxY - minY)

      // ★ 2. S/E marker 坐标与「高级弹幕批量操作面板」(_fillBatchCoordInputs)保持一致:
      //   S = 所有选中弹幕 startX/Y 的最小值(屏幕像素);E = endX/Y 的最小值(屏幕像素)。
      //   固定弹幕(start==end)时 S 与 E 自然重合;拖动 E 即给所有弹幕结束点施加相对位移,
      //   从而实现"多弹幕相对运动"(如让固定弹幕从左到右运动)。
      let minSSx = Infinity, minSSy = Infinity, minESx = Infinity, minESy = Infinity
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || !rec.position) continue
        const up = !!rec.position.usePercent
        const sX = up ? rec.position.startX * W : rec.position.startX * displayScale
        const sY = up ? rec.position.startY * H : rec.position.startY * displayScale
        const eX = up ? rec.position.endX * W : rec.position.endX * displayScale
        const eY = up ? rec.position.endY * H : rec.position.endY * displayScale
        if (sX < minSSx) minSSx = sX
        if (sY < minSSy) minSSy = sY
        if (eX < minESx) minESx = eX
        if (eY < minESy) minESy = eY
      }
      if (!isFinite(minSSx)) { minSSx = minX; minSSy = minY; minESx = minX; minESy = minY }
      const sePxX = minSSx
      const sePxY = minSSy

      // ★ 3. 绘制联合外框(永远不旋转,只包含所有弹幕的 axis-aligned bbox)
      //   - 激活态:外框可拖拽(批量平移)
      //   - 偏离态:外框仅可点击 → 跳回批量激活态(恢复 selectedIds 为 _batchIds)
      const outer = svgEl('rect', {
        x: minX, y: minY, width: bw, height: bh,
        class: active ? 'eo-batch-outer' : 'eo-batch-outer deviate',
        fill: active ? 'rgba(251,114,153,0.05)' : 'rgba(251,114,153,0.02)',
        stroke: '#fb7299', 'stroke-width': active ? 2.2 : 1.2,
        'stroke-dasharray': active ? '0' : '5 4',
      })
      if (active) {
        outer.style.cursor = 'move'
        outer.title = '批量平移所有选中的高级弹幕(或使用 Z/Y/移动 手柄)'
        outer.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation()
          const list = global.window.App && global.window.App.list
          const firstId = (ids.values().next().value) || null
          if (list && firstId && typeof list._showBatchMenu === 'function') {
            list._batchContext = 'deep'
            list._lastContextId = firstId
            list._refreshBatchUI && list._refreshBatchUI()
            list._showBatchMenu(firstId, e.clientX, e.clientY)
          }
        })
        this._makeBatchDraggable(outer, 'batch-move')
      } else {
        outer.style.cursor = 'pointer'
        outer.title = '点击恢复批量操作面板'
        outer.addEventListener('mousedown', (e) => {
          e.preventDefault(); e.stopPropagation()
        })
        outer.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          // 点击 → 恢复 selectedIds 与 list._batchIds 一致,回到激活态
          try {
            const list = global.window.App && global.window.App.list
            if (list && list._batchIds && list._batchIds.size) {
              this.store.selectRange(Array.from(list._batchIds))
            }
          } catch (_) {}
        })
      }
      this.svg.appendChild(outer)

      // ★ 4. 仅激活态:S/E marker(左上角重合,E 最上层) + 4 个手柄 + 计数标签
      if (!active) return

      // S/E marker:拖拽时批量同步每条弹幕对应 start/end。
      // ★ E(结束点)先绘制(下层,实心蓝);S(起始点)后绘制(上层),重合时 S 用环形(fill=none),
      //   仅描边响应 → 点击外环抓 S、点击中心镂空穿过抓 E,两枚皆可独立拖拽。
      //   分离时(sepDist>16)两枚都用实心圆,各自独立抓取。坐标与批量面板一致(无偏移)。
      const ePxX = minESx, ePxY = minESy
      const sepDist = Math.hypot(ePxX - sePxX, ePxY - sePxY)
      this.svg.appendChild(this._batchMarkerHandle('batch-end', ePxX, ePxY, 'E', false))
      this.svg.appendChild(this._batchMarkerHandle('batch-start', sePxX, sePxY, 'S', sepDist <= 16))

      // 连接 S→E 的线段(分离时可见,重合时退化为点)
      const joint = svgEl('line', {
        x1: sePxX, y1: sePxY, x2: ePxX, y2: ePxY,
        class: 'eo-line', opacity: sepDist > 4 ? 0.8 : 0.01,
      })
      this.svg.appendChild(joint)

      // 5. 四个手柄:Z/Y/移动/锁定(和单选完全一致的布局,放在 S/E 点的右上外侧)
      const handleW = 28
      const handleGap = 4
      const lockW = 24
      const totalW = handleW * 3 + handleGap * 2 + lockW + handleGap
      let bhx, bhy
      const rightSpace = W - sePxX - 20
      if (rightSpace >= totalW) {
        bhx = sePxX + 10
      } else if (sePxX - 20 >= totalW) {
        bhx = sePxX - totalW - 10
      } else {
        bhx = Math.min(Math.max(sePxX + 10, 20), W - totalW - 20)
      }
      bhy = Math.max(sePxY - 46, 14)
      if (bhy < 14) bhy = Math.min(sePxY + 50, H - 20)
      this.svg.appendChild(this._batchHandle('batch-z', bhx, bhy, 'Z'))
      this.svg.appendChild(this._batchHandle('batch-y', bhx + handleW + handleGap, bhy, 'Y'))
      this.svg.appendChild(this._batchHandle('batch-move', bhx + (handleW + handleGap) * 2, bhy, '👆'))

      // 批量锁定手柄
      const batchLocked = this._lockedId === '__batch__'
      const lockLabel = batchLocked ? '🔒' : '🔓'
      const lockColor = batchLocked ? '#e74c3c' : '#27ae60'
      const lockX = bhx + (handleW + handleGap) * 2 + handleW + handleGap + lockW / 2
      const lockG = svgEl('g', { class: 'eo-handle eo-lock', transform: 'translate(' + lockX + ',' + bhy + ')' })
      lockG.appendChild(svgEl('circle', { r: 11, fill: lockColor }))
      const lockT = svgEl('text', { y: 4, 'font-size': '12' })
      lockT.textContent = lockLabel
      lockG.appendChild(lockT)
      lockG.style.cursor = 'pointer'
      // ★ 修复:锁定手柄必须先拦截 mousedown 避免拖拽进入移动态,再在 click 里 toggleBatchLock
      lockG.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      lockG.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggleBatchLock()
      })
      this.svg.appendChild(lockG)

      // 6. 计数标签(作为视觉提示,非拖拽入口)
      const tagW = 96
      const tagH = 26
      const tagX = Math.min(maxX - tagW, Math.max(minX, W - tagW - 14))
      const tagY = Math.max(minY - tagH - 6, 6)
      const tagRect = svgEl('rect', {
        x: tagX, y: tagY, width: tagW, height: tagH,
        fill: 'rgba(251,114,153,0.92)', stroke: '#d4557a', rx: 4,
      })
      this.svg.appendChild(tagRect)
      const tagText = svgEl('text', {
        x: tagX + tagW / 2, y: tagY + tagH / 2 + 4,
        'text-anchor': 'middle', fill: '#fff', 'font-size': 12, 'font-weight': 600,
      })
      tagText.textContent = '批量操作 (' + ids.size + ')'
      tagText.style.pointerEvents = 'none'
      this.svg.appendChild(tagText)

      // ★ 标签右上角取消按钮:点击清除深度批量选择(标签随即消失),不影响弹幕本身
      const cancelR = 8
      const cancelCx = tagX + tagW - cancelR - 2
      const cancelCy = tagY + cancelR + 2
      const cancelG = svgEl('g', { class: 'eo-tag-cancel', transform: 'translate(' + cancelCx + ',' + cancelCy + ')' })
      cancelG.appendChild(svgEl('circle', { r: cancelR, fill: 'rgba(0,0,0,0.25)', stroke: 'rgba(255,255,255,0.5)', 'stroke-width': 1 }))
      const cancelT = svgEl('text', { y: 4, fill: '#fff', 'font-size': 11, 'text-anchor': 'middle', 'font-weight': 700 })
      cancelT.textContent = '✕'
      cancelT.style.pointerEvents = 'none'
      cancelG.appendChild(cancelT)
      cancelG.style.cursor = 'pointer'
      cancelG.title = '取消当前批量选择'
      cancelG.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      cancelG.addEventListener('click', (e) => {
        e.stopPropagation()
        const app = global.window.App
        const list = app && app.list
        if (list && typeof list.clearBatchIds === 'function') list.clearBatchIds()
      })
      this.svg.appendChild(cancelG)
    }

    _batchHandle(type, x, y, label) {
      const g = svgEl('g', { class: 'eo-handle', transform: 'translate(' + x + ',' + y + ')' })
      const color = type === 'batch-move' ? '#f39c12' : type === 'batch-z' ? '#9b59b6' : '#3498db'
      g.appendChild(svgEl('circle', { r: 11, fill: color }))
      const t = svgEl('text', { y: 4 })
      t.textContent = label
      g.appendChild(t)
      this._makeBatchDraggable(g, type)
      return g
    }

    _batchMarkerHandle(type, x, y, label, asRing) {
      const isStart = type === 'batch-start'
      // ★ A:与单选 _marker 同款 class/CSS(eo-marker start/end),颜色统一(start 绿 #2ecc71 / end 红 #e74c3c)
      const g = svgEl('g', { class: 'eo-marker ' + (isStart ? 'start' : 'end'), transform: 'translate(' + x + ',' + y + ')' })
      let hitTarget = g
      if (asRing) {
        // 环形(仅 S 重合时用):inline style 强制 fill=none + start 绿描边
        //   (CSS .eo-marker.start 的 fill 会覆盖 attribute,故用 style 提升优先级保证镂空)
        const ring = svgEl('circle', { r: 10 })
        ring.style.fill = 'none'
        ring.style.stroke = '#2ecc71'
        ring.style.strokeWidth = '2.5'
        ring.style.pointerEvents = 'stroke'
        g.appendChild(ring)
        hitTarget = ring
      } else {
        // 与单选 _marker 一致:r=7,颜色/描边由 CSS .eo-marker.start/.end 提供
        g.appendChild(svgEl('circle', { r: 7 }))
      }
      const t = svgEl('text', { y: 4, class: 'eo-label' })
      t.textContent = label
      g.appendChild(t)
      this._makeBatchDraggable(hitTarget, type)
      return g
    }

    /** ★ 从 list._batchIds 取深度批量选择集(跨模块访问 App.list._batchIds)。
     *  拿不到返回空 Set(保证调用方判断为 false)。*/
    _getBatchIds() {
      try {
        const list = global.window.App && global.window.App.list
        if (list && list._batchIds) return list._batchIds
      } catch (_) {}
      return new Set()
    }

    /** 批量锁定:使用特殊 id '__batch__' 区分单选锁定 */
    toggleBatchLock() {
      if (this._lockedId === '__batch__') {
        this._lockedId = null
      } else {
        this._lockedId = '__batch__'
      }
      this._syncFromSelection()
    }

    /** 批量模式下:任何一个外框/手柄/标签被按下,都进入对应拖拽状态。 */
    _makeBatchDraggable(g, type, extra) {
      const self = this
      g.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation()
        if (type === 'lock') {
          // 锁定是 click,不进入拖拽
          return
        }
        const ids = self._getBatchIds()
        const perRec = {}
        const width = self.engine.width
        const height = self.engine.height
        const displayScale = (self.engine.displayScale != null && isFinite(self.engine.displayScale)) ? Number(self.engine.displayScale) : 1
        if (type === 'batch-z' || type === 'batch-y') {
          for (const id of ids) {
            const rec = self.store.get(id)
            if (!rec || !rec.rotation) continue
            perRec[id] = { z: rec.rotation.z || 0, y: rec.rotation.y || 0 }
          }
        } else if (type === 'batch-move' || type === 'batch-start' || type === 'batch-end') {
          // ★ 关键:在按下瞬间记录每条弹幕的 position「屏幕像素坐标」快照,
          //   避免每帧 mousemove 时用「当前 live 值 + 累计 dx」的重复累加方式导致严重瞬移(FR N2)。
          for (const id of ids) {
            const rec = self.store.get(id)
            if (!rec || !rec.position) continue
            const usePct = !!rec.position.usePercent
            const ds = usePct ? 1 : displayScale
            const toScreenPx = (u, axis) => {
              if (usePct) return u * (axis === 'x' ? width : height)
              return u * ds // 逻辑像素 → 屏幕渲染像素(× displayScale)
            }
            perRec[id] = {
              usePercent: usePct,
              // 以按下瞬间的「屏幕像素坐标」作为快照
              snapSXPx: toScreenPx(rec.position.startX, 'x'),
              snapSYPx: toScreenPx(rec.position.startY, 'y'),
              snapEXPx: toScreenPx(rec.position.endX, 'x'),
              snapEYPx: toScreenPx(rec.position.endY, 'y'),
            }
          }
        }
        self._dragging = {
          type: type,
          startMouseX: e.clientX,
          startMouseY: e.clientY,
          perRec: perRec,
        }
        if (extra && typeof extra === 'object') {
          for (const k in extra) self._dragging[k] = extra[k]
        }
        document.addEventListener('mousemove', self._onMove)
        document.addEventListener('mouseup', self._onUp)
      })
      g.addEventListener('click', (e) => e.stopPropagation())
    }
  }

  global.EditOverlay = EditOverlay
})(window)
