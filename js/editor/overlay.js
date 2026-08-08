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

      this._onMove = (e) => this._handleMove(e)
      this._onUp = () => {
        this._dragging = null
        document.removeEventListener('mousemove', this._onMove)
        document.removeEventListener('mouseup', this._onUp)
      }

      store.onChange((evt, id, field) => this.onStore(evt, id, field))
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

    /** 由 Editor 调用:编辑模式开关。 */
    setEnabled(on) {
      this.enabled = !!on
      if (!this.enabled) this.record = null
      this._syncFromSelection()
    }

    /** 由 Editor 调用:进入/退出拾取模式(拾取时隐藏 overlay)。 */
    setPicking(picking) {
      this.picking = !!picking
      this.render()
    }

    /** ★ 由 Editor 调用:进入/退出「深度批量纯高级」模式(批量操作手柄)。 */
    setBatchMode(on) {
      on = !!on
      if (this._batchMode === on) return
      this._batchMode = on
      this.render()
    }

    _syncFromSelection() {
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
    }

    /** 弹幕被销毁(生命结束/清场)时:若选中高级弹幕已不在屏,隐藏 overlay 防残留。 */
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
      }
    }

    /** 换算:单位(像素或百分比) -> 舞台像素。百分比为 0~0.99 小数。 */
    _toPx(v, axis) {
      if (this.record.position.usePercent) {
        return v * (axis === 'x' ? this.engine.width : this.engine.height)
      }
      return v
    }

    /** 舞台像素 -> 单位(按当前 usePercent)。 */
    _toUnit(px, axis) {
      if (this.record.position.usePercent) {
        return clamp(round2(px / (axis === 'x' ? this.engine.width : this.engine.height)), 0, 0.99)
      }
      return clamp(round1(px), 0, 9999)
    }

    render() {
      // ★ 深度批量纯高级模式:不渲染单条高级手柄,渲染联合 BBox + 批量平移/缩放
      if (this._batchMode && this.enabled && !this.picking) {
        this._renderBatch()
        return
      }
      const rec = this.record
      if (!rec || !this.enabled || this.picking) {
        this.svg.innerHTML = ''
        return
      }
      const W = this.engine.width
      const H = this.engine.height
      if (!W || !H) return
      const p = rec.position
      const sx = this._toPx(p.startX, 'x')
      const sy = this._toPx(p.startY, 'y')
      const ex = this._toPx(p.endX, 'x')
      const ey = this._toPx(p.endY, 'y')

      this.svg.setAttribute('width', String(W))
      this.svg.setAttribute('height', String(H))
      this.svg.innerHTML = ''

      const line = svgEl('line', { x1: sx, y1: sy, x2: ex, y2: ey, class: 'eo-line' })
      this.svg.appendChild(line)

      // 选定框:以起始点为左上角,尺寸贴近弹幕实际大小(锚点=弹幕左上)
      const dm = this.engine.advanced.active.find((d) => d.id === rec.id)
      let bw = 160
      let bh = 44
      if (dm && dm.node) {
        const w = dm.node.offsetWidth || 0
        const h = dm.node.offsetHeight || 0
        if (w > 0) bw = w + 14
        if (h > 0) bh = h + 14
      }
      const rect = svgEl('rect', {
        x: sx,
        y: sy,
        width: bw,
        height: bh,
        class: 'eo-box',
      })
      rect.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const ta = document.getElementById('pa-content')
        if (ta) ta.focus()
      })
      rect.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this._showAdvMenu(e.clientX, e.clientY)
      })
      this.svg.appendChild(rect)
      const corners = [
        [sx, sy, -1, -1],
        [sx + bw, sy, 1, -1],
        [sx + bw, sy + bh, 1, 1],
        [sx, sy + bh, -1, 1],
      ]
      for (const [cx, cy, cdx, cdy] of corners) {
        this.svg.appendChild(this._cornerHandle(cx, cy, cdx, cdy))
      }

      this.svg.appendChild(this._marker('start', sx, sy))
      this.svg.appendChild(this._marker('end', ex, ey))

      // 四个手柄,根据起始点位置自适应布局(含锁定手柄)
      const handleW = 28
      const handleGap = 4
      const lockW = 24
      const totalW = handleW * 3 + handleGap * 2 + lockW + handleGap
      let bx, by
      // 优先放在右侧,不够则放左侧
      const rightSpace = W - sx - 20
      if (rightSpace >= totalW) {
        bx = sx + 70
      } else if (sx - 20 >= totalW) {
        bx = sx - totalW - 10
      } else {
        // 两侧都不够,尽量放在可见区域内
        bx = Math.min(Math.max(sx + 70, 20), W - totalW - 20)
      }
      by = Math.max(sy - 46, 14)
      // 若上方空间不足则移到下方
      if (by < 14) by = Math.min(sy + 50, H - 20)
      this.svg.appendChild(this._handle('z', bx, by, 'Z'))
      this.svg.appendChild(this._handle('y', bx + handleW + handleGap, by, 'Y'))
      this.svg.appendChild(this._handle('move', bx + (handleW + handleGap) * 2, by, '👆'))
      // 锁定手柄
      const locked = this._lockedId === rec.id
      const lockLabel = locked ? '🔒' : '🔓'
      const lockColor = locked ? '#e74c3c' : '#27ae60'
      const lockX = bx + (handleW + handleGap) * 2 + handleW + handleGap + lockW / 2
      const lockG = svgEl('g', { class: 'eo-handle eo-lock', transform: 'translate(' + lockX + ',' + by + ')' })
      lockG.appendChild(svgEl('circle', { r: 11, fill: lockColor }))
      const lockT = svgEl('text', { y: 4, 'font-size': '12' })
      lockT.textContent = lockLabel
      lockG.appendChild(lockT)
      lockG.style.cursor = 'pointer'
      lockG.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggleLock()
      })
      this.svg.appendChild(lockG)
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

    /** 高级弹幕右键菜单:时间调整(最上层) + 颜色设置(第二层)。 */
    _showAdvMenu(x, y) {
      this._advMenu = this._advMenu || this._buildAdvMenu()
      const menu = this._advMenu
      const rec = this.record
      if (rec && rec.style) {
        const colorEl = menu.querySelector('#adv-menu-color')
        if (colorEl) colorEl.value = global.ColorUtil.normalizeHex(rec.style.color, '#FFFFFF')
      }
      menu.hidden = false
      const mw = menu.offsetWidth || 220
      const mh = menu.offsetHeight || 180
      menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px'
      menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px'
      this._updateAdvMenuTime()
    }

    _buildAdvMenu() {
      const menu = document.createElement('div')
      menu.className = 'adv-menu'
      menu.hidden = true
      menu.dataset.id = ''
      // 时间调整
      const row1 = document.createElement('div')
      row1.className = 'adv-menu-row'
      row1.textContent = '时间:'
      const minus = this._timeBtn('-')
      const plus = this._timeBtn('+')
      const timeVal = document.createElement('b')
      timeVal.id = 'adv-menu-time'
      row1.appendChild(minus)
      row1.appendChild(timeVal)
      row1.appendChild(plus)
      // 颜色
      const row2 = document.createElement('div')
      row2.className = 'adv-menu-row'
      row2.textContent = '颜色:'
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.id = 'adv-menu-color'
      colorInput.addEventListener('input', () => {
        const rec = this.record
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
        const rec = this.record
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
      dup.addEventListener('click', () => {
        const rec = this.record
        menu.hidden = true
        if (rec) {
          const copy = this.store.duplicate(rec.id)
          if (copy) this.store.select(copy.id)
        }
      })
      // 删除
      const del = document.createElement('button')
      del.textContent = '删除'
      del.addEventListener('click', () => {
        const rec = this.record
        menu.hidden = true
        if (rec) this.store.remove(rec.id)
      })
      menu.appendChild(row1)
      menu.appendChild(row2)
      menu.appendChild(sep)
      menu.appendChild(dup)
      menu.appendChild(del)
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
      // ★ 批量平移:不依赖单条 record
      if (d.type === 'batch-move') {
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : new Set()
        const width = this.engine.width
        const height = this.engine.height
        for (const id of ids) {
          const rec = this.store.get(id)
          if (!rec || !rec.position) continue
          let nx, ny, nex, ney
          const usePct = !!rec.position.usePercent
          const toPx = (u, axis) => usePct ? u * (axis === 'x' ? width : height) : u
          const toUn = (px, axis) => usePct ? clamp(round2(px / (axis === 'x' ? width : height)), 0, 0.99) : clamp(round1(px), 0, 9999)
          nx = toPx(rec.position.startX, 'x') + dx
          ny = toPx(rec.position.startY, 'y') + dy
          nex = toPx(rec.position.endX, 'x') + dx
          ney = toPx(rec.position.endY, 'y') + dy
          this.store.updateDeep(id, 'position.startX', toUn(nx, 'x'))
          this.store.updateDeep(id, 'position.startY', toUn(ny, 'y'))
          this.store.updateDeep(id, 'position.endX', toUn(nex, 'x'))
          this.store.updateDeep(id, 'position.endY', toUn(ney, 'y'))
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

    // =================================================================
    // ★ 批量模式(深度批量纯高级弹幕) —— 联合 BBox + 批量平移手柄
    // =================================================================

    _getBatchIds() {
      try {
        const list = global.window.App && global.window.App.list
        if (list && list._batchIds) return list._batchIds
      } catch (_) {}
      return new Set()
    }

    /** 联合 BBox:以高级弹幕节点在舞台的实际 rect 合并;若节点还未 active(未到播放时间或离屏),
     *  则退化用 position.startX/startY + 估算尺寸。 */
    _renderBatch() {
      const W = this.engine.width
      const H = this.engine.height
      if (!W || !H) { this.svg.innerHTML = ''; return }
      this.svg.setAttribute('width', String(W))
      this.svg.setAttribute('height', String(H))
      this.svg.innerHTML = ''
      const ids = this._getBatchIds()
      if (ids.size < 2) return

      // 1. 计算每个 id 的 BBox(优先用 active 节点实际尺寸,否则按 startX/startY 估算)
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      let hasBox = false
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || !rec.position) continue
        const usePct = !!rec.position.usePercent
        const toPx = (u, axis) => usePct ? u * (axis === 'x' ? W : H) : u
        const sx = toPx(rec.position.startX, 'x')
        const sy = toPx(rec.position.startY, 'y')
        const dm = this.engine.advanced.active.find((d) => d.id === id)
        let bw = 160, bh = 44
        if (dm && dm.node) {
          const w = dm.node.offsetWidth || 0
          const h = dm.node.offsetHeight || 0
          if (w > 0) bw = w + 14
          if (h > 0) bh = h + 14
        }
        // 每个弹幕后绘制一个淡色子框,方便用户识别单条范围
        const sub = svgEl('rect', { x: sx, y: sy, width: bw, height: bh,
          fill: 'none', stroke: '#fb7299', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.6 })
        this.svg.appendChild(sub)
        const x2 = sx + bw, y2 = sy + bh
        if (sx < minX) minX = sx
        if (sy < minY) minY = sy
        if (x2 > maxX) maxX = x2
        if (y2 > maxY) maxY = y2
        hasBox = true
      }
      if (!hasBox) return
      // 给外框留一点 padding,避免与子框贴合太近
      minX -= 6; minY -= 6; maxX += 6; maxY += 6
      const bw = Math.max(20, maxX - minX)
      const bh = Math.max(20, maxY - minY)

      // 2. 联合外框(粗线,醒目显示批量范围)
      const outer = svgEl('rect', { x: minX, y: minY, width: bw, height: bh,
        fill: 'rgba(251,114,153,0.05)', stroke: '#fb7299', 'stroke-width': 2.2 })
      outer.style.cursor = 'move'
      outer.title = '批量平移所有选中的高级弹幕(或使用右侧手柄)'
      outer.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation()
        // 批量外框右键 -> 和舞台右键弹同样的批量菜单(取第一个选中的 id 作为上下文)
        const list = global.window.App && global.window.App.list
        const firstId = (ids.values().next().value) || null
        if (list && firstId && typeof list._showBatchMenu === 'function') {
          list._batchContext = 'deep'
          list._lastContextId = firstId
          list._refreshBatchUI && list._refreshBatchUI()
          list._showBatchMenu(firstId, e.clientX, e.clientY)
        }
      })
      this._makeBatchDraggable(outer)
      this.svg.appendChild(outer)

      // 3. 8 个边角/边中点手柄(视觉标识 + 尺寸锚点;拖拽简化为"触发批量平移")
      const corners = [
        { x: minX, y: minY, cursor: 'nwse-resize' },
        { x: minX + bw / 2, y: minY, cursor: 'ns-resize' },
        { x: maxX, y: minY, cursor: 'nesw-resize' },
        { x: maxX, y: minY + bh / 2, cursor: 'ew-resize' },
        { x: maxX, y: maxY, cursor: 'nwse-resize' },
        { x: minX + bw / 2, y: maxY, cursor: 'ns-resize' },
        { x: minX, y: maxY, cursor: 'nesw-resize' },
        { x: minX, y: minY + bh / 2, cursor: 'ew-resize' },
      ]
      for (const c of corners) {
        const h = svgEl('g', { class: 'eo-handle eo-corner', transform: 'translate(' + c.x + ',' + c.y + ')' })
        h.appendChild(svgEl('rect', { x: -6, y: -6, width: 12, height: 12, fill: '#fff', stroke: '#fb7299',
          'stroke-width': 1.5, rx: 2 }))
        const t = svgEl('text', { y: 3.5, fill: '#fb7299', 'font-size': 11 })
        t.textContent = '◆'
        h.appendChild(t)
        h.style.cursor = c.cursor
        this._makeBatchDraggable(h)
        h.addEventListener('click', (e) => e.stopPropagation())
        this.svg.appendChild(h)
      }

      // 4. 右上角显式的批量平移按钮 + 计数标签
      const tagW = 96
      const tagH = 26
      const tagX = Math.min(maxX - tagW, Math.max(minX, W - tagW - 14))
      const tagY = Math.max(minY - tagH - 6, 6)
      const tagRect = svgEl('rect', { x: tagX, y: tagY, width: tagW, height: tagH,
        fill: '#fb7299', stroke: '#d4557a', rx: 4 })
      tagRect.style.cursor = 'move'
      this._makeBatchDraggable(tagRect)
      this.svg.appendChild(tagRect)
      const tagText = svgEl('text', {
        x: tagX + tagW / 2, y: tagY + tagH / 2 + 4,
        'text-anchor': 'middle', fill: '#fff', 'font-size': 12, 'font-weight': 600,
      })
      tagText.textContent = '批量操作 (' + ids.size + ')'
      tagText.style.pointerEvents = 'none'
      this.svg.appendChild(tagText)
    }

    /** 批量模式下:任何一个外框/手柄/标签被按下,都进入 batch-move 拖拽状态。 */
    _makeBatchDraggable(g) {
      g.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation()
        this._dragging = { type: 'batch-move', startMouseX: e.clientX, startMouseY: e.clientY }
        document.addEventListener('mousemove', this._onMove)
        document.addEventListener('mouseup', this._onUp)
      })
    }
  }

  global.EditOverlay = EditOverlay
})(window)
