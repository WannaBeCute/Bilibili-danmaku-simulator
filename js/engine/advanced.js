/**
 * advanced.js:高级弹幕渲染器(rAF 逐帧驱动)。
 *
 * 双层节点解决 transform 冲突:
 *   外层 .dm-adv-outer  -> translate3d 定位 + opacity(透明度渐变)
 *   内层 .dm-adv-inner  -> rotateZ / rotateY(3D 旋转)
 *   文本 .dm-adv-text   -> 颜色/字号/字体/描边
 *
 * 每帧直接读 record,因此编辑器改任意字段下一帧即生效(实时编辑)。
 * 进度以媒体秒为基准:elapsed = (clock.now() - record.timeSec) * 1000 ms。
 * 暂停 => now 冻结,动画停;seek => 自动重算。
 */
(function (global) {
  'use strict'

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
  // 加速运动:从 0 速度开始匀加速,保证 t=1 时插值=1(总时长内刚好完成)
  const easeInQuad = (t) => t * t

  // 高级弹幕:保留真实换行(\r\n \r \n),但过滤字面的 "\n"(反斜杠+n) 与 "/n"
  function sanitizeAdvContent(str) {
    let s = String(str == null ? '' : str)
    // 先去字面 "\n"(反斜杠 + n)
    s = s.replace(/\\n/g, '')
    // 再去字面 "/n"(斜杠 + n,大小写不敏感)
    s = s.replace(/\/n/gi, '')
    // 归一化真实换行(\r\n \r -> \n)
    s = s.replace(/\r\n?/g, '\n')
    return s
  }

  // 普通弹幕:去掉所有换行与字面换行、/n, 保持单行
  function sanitizeNormalContent(str) {
    let s = String(str == null ? '' : str)
    s = s.replace(/\\n/g, '')
    s = s.replace(/\/n/gi, '')
    s = s.replace(/\r\n?/g, '')
    s = s.replace(/\n/g, '')
    return s
  }

  // █ _ 等特殊字符:替换成 1em 内联元素,保证与汉字等宽(避免字体回退造成宽度不一)
  // 返回 DOM fragment(安全,不使用 innerHTML)
  function buildWidthSafeNodes(text, colorHex) {
    const frag = document.createDocumentFragment()
    if (!text) return frag
    // 按字符拆分(兼容 Unicode BMP / 代理对)
    const chars = Array.from(text)
    for (const ch of chars) {
      // █ 全块字符 -> 1em 方背景块(currentColor 继承自父节点颜色)
      if (ch === '\u2588') {
        const s = document.createElement('span')
        s.className = 'dm-ws-block'
        s.style.background = colorHex || 'currentColor'
        frag.appendChild(s)
        continue
      }
      // _ 下划线 -> 1em 宽带底边线 span
      if (ch === '_') {
        const s = document.createElement('span')
        s.className = 'dm-ws-underscore'
        s.style.borderBottomColor = colorHex || 'currentColor'
        frag.appendChild(s)
        continue
      }
      frag.appendChild(document.createTextNode(ch))
    }
    return frag
  }

  /** 折线按弧长采样,返回进度 t 处的点。 */
  function samplePath(points, t) {
    if (!points.length) return { x: 0, y: 0 }
    if (points.length === 1) return { x: points[0].x, y: points[0].y }
    const segs = []
    let total = 0
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x
      const dy = points[i + 1].y - points[i].y
      const len = Math.sqrt(dx * dx + dy * dy)
      segs.push(len)
      total += len
    }
    if (total <= 0) return { x: points[0].x, y: points[0].y }
    let target = clamp(t, 0, 1) * total
    let acc = 0
    for (let i = 0; i < segs.length; i++) {
      if (acc + segs[i] >= target || i === segs.length - 1) {
        const local = segs[i] > 0 ? clamp((target - acc) / segs[i], 0, 1) : 0
        return {
          x: points[i].x + (points[i + 1].x - points[i].x) * local,
          y: points[i].y + (points[i + 1].y - points[i].y) * local,
        }
      }
      acc += segs[i]
    }
    return { x: points[points.length - 1].x, y: points[points.length - 1].y }
  }

  class AdvancedDanmaku {
    constructor(renderer, record) {
      this.renderer = renderer
      this.engine = renderer.engine
      this.record = record
      this.id = record.id
      this.ended = false
      this.node = null
      this.inner = null
      this.textEl = null
      this._sig = ''
      this._spawnPerf = record._previewImmediate ? performance.now() : null
    }

    buildNode() {
      const node = document.createElement('div')
      node.className = 'dm dm-advanced dm-adv-outer'
      node.setAttribute('data-dm-id', this.id)
      if (!this.engine.editable && this.engine.store.selectedId === this.id) node.classList.add('dm-selected')
      node.style.position = 'absolute'
      node.style.top = '0'
      node.style.left = '0'
      node.style.willChange = 'transform, opacity'
      // 批量激活(勾选批量复选框)时,即使非编辑模式也要接收鼠标事件(右键弹菜单)。
      node.style.pointerEvents = (this.engine.editable || this.engine.batchActive) ? 'auto' : 'none'
      node.style.opacity = '0'

      const inner = document.createElement('div')
      inner.className = 'dm-adv-inner'
      inner.style.willChange = 'transform'
      // 高级弹幕:允许真实换行,但禁止自动换行(pre = 仅真实 \n 处换行,长行不自动折行)
      inner.style.whiteSpace = 'pre'

      const text = document.createElement('span')
      text.className = 'dm-adv-text'
      text.style.whiteSpace = 'pre'
      inner.appendChild(text)

      node.appendChild(inner)
      this.node = node
      this.inner = inner
      this.textEl = text
      this.applyTextStyle()
      return node
    }

    /** 应用文本外观(颜色/字号/字体/描边/大会员渐变外框),仅当字段变化时重写。高级弹幕尺寸固定,不随全局字号缩放。 */
    applyTextStyle() {
      const rec = this.record
      const s = rec.style
      // 高级弹幕:保留真实换行,过滤字面 "\n" / "/n"
      const content = sanitizeAdvContent(rec.content)
      const colorHex = global.ColorUtil.normalizeHex(s.color, '#FF0000')
      const colorful = rec.colorful != null && rec.colorful !== 0
      const sig = content + '|' + colorHex + '|' + s.fontSize + '|' + s.fontFamily + '|' + s.stroke + '|' + colorful
      if (sig === this._sig) return
      this._sig = sig
      // 清空 textEl
      this.textEl.innerHTML = ''
      this.textEl.style.fontSize = Math.round(s.fontSize) + 'px'
      this.textEl.style.fontFamily = s.fontFamily
      // 强制东亚字符等宽,减少符号/汉字宽度差异
      this.textEl.style.fontVariantEastAsian = 'full-width'
      // 边距:仅█字符本身在 stage.css(.dm-ws-block) 内加 margin,各层 div/span 的 padding 全部归零(上下左右一致)
      this.inner.style.padding = '0'
      this.textEl.style.padding = '0'
      // 先重置父级层可能被 colorful 分支写入的属性
      this.textEl.style.color = ''
      this.textEl.style.webkitTextFillColor = ''
      this.textEl.style.backgroundImage = 'none'
      this.textEl.style.webkitBackgroundClip = 'initial'
      this.textEl.style.backgroundClip = 'initial'
      this.textEl.style.whiteSpace = 'pre' // 高级弹幕保留真实换行
      if (colorful) {
        // === 大会员:白色填充 + 渐变描边(双层 DOM 叠加,字形 100% 不变形) ===
        //   底层 strokeEl:-webkit-text-stroke 加肥 3px + background-clip:text → 渐变描边层
        //   上层 fillEl:正常白字盖在上面,遮住内部 1.5px → 只留外部均匀 1.5px 渐变外框
        // 颜色顺序(左→右):1.#f2509e →2.#ce5ba7 →3.#8272ba →4.#6b7abf →5.#5499cb
        this.textEl.classList.add('dm-colorful')
        this.textEl.classList.remove('dm-colorful-fallback')
        // 底层:渐变描边(pointer-events:none,避免拦截点击/右键)
        const strokeEl = document.createElement('span')
        strokeEl.className = 'dm-colorful-stroke'
        strokeEl.appendChild(buildWidthSafeNodes(content, '#FFFFFF'))
        // 上层:白色填充(原字形)
        const fillEl = document.createElement('span')
        fillEl.className = 'dm-colorful-fill'
        fillEl.appendChild(buildWidthSafeNodes(content, '#FFFFFF'))
        this.textEl.appendChild(strokeEl)
        this.textEl.appendChild(fillEl)
        // 描边由 CSS 渐变负责,父级不再额外加 shadow;fill 层自带极淡黑 shadow 提升可读性
        this.textEl.style.textShadow = 'none'
      } else {
        // === 普通高级弹幕:单层内联 ===
        this.textEl.classList.remove('dm-colorful')
        this.textEl.classList.remove('dm-colorful-fallback')
        const frag = buildWidthSafeNodes(content, colorHex)
        this.textEl.appendChild(frag)
        this.textEl.style.color = colorHex
        this.textEl.style.webkitTextFillColor = ''
        this.textEl.style.backgroundImage = 'none'
        this.textEl.style.webkitBackgroundClip = 'initial'
        this.textEl.style.backgroundClip = 'initial'
        if (s.stroke) {
          this.textEl.style.textShadow =
            '1px 0 0 #000,-1px 0 0 #000,0 1px 0 #000,0 -1px 0 #000,' +
            '1px 1px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,0 0 3px #000'
        } else {
          this.textEl.style.textShadow = 'none'
        }
      }
    }

    /** 当前采样位置(像素,未换算百分比)。 */
    samplePos(e) {
      const rec = this.record
      if (rec.motion.type === 'path' && rec.motion.path && rec.motion.path.length) {
        return samplePath(rec.motion.path, e)
      }
      const p = rec.position
      return {
        x: p.startX + (p.endX - p.startX) * e,
        y: p.startY + (p.endY - p.startY) * e,
      }
    }

    /** 每帧驱动。 */
    update() {
      if (this.ended || !this.node) return
      const rec = this.record
      let elapsed
      if (rec._previewImmediate) {
        // performance.now() 返回已经是毫秒(高精确 DOMHighResTimeStamp,单位 ms)
        // 注意:之前误乘 1000 导致 elapsed 瞬间远大于 lifeMs/mv,进度直接 clamp 到 1,移动立即完成
        elapsed = performance.now() - this._spawnPerf
      } else {
        const clock = this.engine.clock
        elapsed = (clock.now() - rec.timeSec) * 1000
      }

      const lifeMs = rec.life.duration * 1000
      // ★ 编辑选中保护:当前选中的弹幕即使超出生命周期也不销毁,clamp 到生命周期内保持可见
      //   预览弹幕(_preview)不受选中保护,按自身生命周期正常销毁
      const isSelected = !rec._preview && this.engine.store && this.engine.store.selectedId === this.id
      // ★ _editSpawned 弹幕(选中时主动 spawn 的)失去选中后,若不在正常时间范围内则销毁
      if (this._editSpawned && !isSelected && !rec._preview) {
        if (elapsed < 0 || elapsed >= lifeMs) {
          this.destroy()
          return
        }
      }
      if (elapsed < 0) {
        if (!isSelected) return // 尚未到出现时间
        elapsed = 0 // 选中态:从起点显示
      }
      if (elapsed >= lifeMs) {
        if (!isSelected) {
          this.destroy()
          return
        }
        elapsed = lifeMs - 1 // 选中态:保持在生命周期末尾
      }

      // 运动进度(含 delay)
      let t = 0
      const mv = rec.motion.moveDuration
      const dl = rec.motion.delay
      if (mv > 0) {
        t = (elapsed - dl) / mv
        t = clamp(t, 0, 1)
      } else {
        t = elapsed >= dl ? 1 : 0
      }
      const e = rec.motion.linear ? easeInQuad(t) : t

      const pos = this.samplePos(e)
      const W = this.engine.width
      const H = this.engine.height
      let x = pos.x
      let y = pos.y
      if (rec.position.usePercent) {
        // 百分比为 0~0.99 的小数(0.5 = 舞台一半)
        x = x * W
        y = y * H
      }

      // 透明度渐变(生存期内线性)
      const lt = clamp(elapsed / lifeMs, 0, 1)
      const op = rec.life.opacityStart + (rec.life.opacityEnd - rec.life.opacityStart) * lt

      // 锚点:坐标视为文本左上角(拾取/ASS 均按左上);透明度固定用自身 life.opacity,不随全局透明度
      this.node.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'
      this.node.style.opacity = String(clamp(op, 0, 1))
      this.inner.style.transform =
        'rotateZ(' + rec.rotation.z + 'deg) rotateY(' + rec.rotation.y + 'deg)'

      this.applyTextStyle()
    }

    /** 强制刷新一次(编辑时,即使暂停也生效)。 */
    refresh() {
      this.applyTextStyle()
      this.update()
    }

    destroy() {
      if (this.ended) return
      this.ended = true
      const wasPreview = !!(this.record && this.record._preview)
      if (this.node && this.node.parentNode) {
        this.node.parentNode.removeChild(this.node)
      }
      this.node = null
      // ★ 如果是预览弹幕销毁,检查舞台上是否还有其他预览;若没有则自动复原被隐藏的正式弹幕
      if (wasPreview && this.renderer && this.renderer.engine && typeof this.renderer.engine.hasPreviewActive === 'function') {
        if (!this.renderer.engine.hasPreviewActive()) {
          this.renderer.engine.showNonPreviews()
        }
      }
    }
  }

  class AdvancedRenderer {
    constructor(engine) {
      this.engine = engine
      this.active = []
    }

    get count() {
      return this.active.length
    }

    spawn(record, opts) {
      const dm = new AdvancedDanmaku(this, record)
      // ★ 编辑选中态 spawn 的弹幕打标记:失去选中且不在正常时间范围内时自动销毁
      dm._editSpawned = !!(opts && opts.editSpawned)
      this.active.push(dm)
      dm.buildNode()
      this.engine.stage.appendChild(dm.node)
      dm.update() // 立即就位(elapsed>=0)或等待
      return dm
    }

    /** 一键清除所有预览弹幕(仅 _preview 标记的,不影响正式弹幕)。 */
    clearPreviews() {
      for (let i = this.active.length - 1; i >= 0; i--) {
        if (this.active[i].record._preview) {
          // 注意:destroy 内部会判断 hasPreviewActive() 并复原正式弹幕,
          // 但此时我们是批量删除,所以最后再统一调用一次更安全
          this.active[i].destroy()
          this.active.splice(i, 1)
        }
      }
      // ★ 批量清除预览后,确保被隐藏的正式弹幕立即复原
      if (this.engine && typeof this.engine.showNonPreviews === 'function') {
        this.engine.showNonPreviews()
      }
    }

    /** 清除指定 id 的预览弹幕(仅 _preview 标记的)。 */
    removePreviewById(id) {
      for (let i = this.active.length - 1; i >= 0; i--) {
        if (this.active[i].record._preview && this.active[i].id === id) {
          this.active[i].destroy()
          this.active.splice(i, 1)
        }
      }
    }

    /** 清理失去选中的编辑预览弹幕(不在正常时间范围内的)。 */
    cleanupEditSpawned(keepId) {
      const clock = this.engine.clock
      for (let i = this.active.length - 1; i >= 0; i--) {
        const dm = this.active[i]
        if (dm._editSpawned && dm.id !== keepId) {
          const rec = dm.record
          // 预览即时弹幕用墙钟,否则用引擎时钟
          const elapsed = rec._previewImmediate
            ? performance.now() - dm._spawnPerf
            : (clock.now() - rec.timeSec) * 1000
          const lifeMs = rec.life.duration * 1000
          if (elapsed < 0 || elapsed >= lifeMs) {
            dm.destroy()
            this.active.splice(i, 1)
          }
        }
      }
    }

    update() {
      if (!this.active.length) return
      let removed = false
      for (let i = this.active.length - 1; i >= 0; i--) {
        const dm = this.active[i]
        if (dm.ended) {
          this.active.splice(i, 1)
          removed = true
          continue
        }
        dm.update()
      }
      if (removed && this.engine._onAdvEnded) this.engine._onAdvEnded()
    }

    refresh(id) {
      const dm = this.active.find((d) => d.id === id)
      if (dm) dm.refresh()
    }

    clear() {
      this.active.slice().forEach((dm) => dm.destroy())
      this.active.length = 0
    }

    removeById(id) {
      for (let i = this.active.length - 1; i >= 0; i--) {
        if (this.active[i].id === id) {
          this.active[i].destroy()
          this.active.splice(i, 1)
        }
      }
    }
  }

  global.AdvancedRenderer = AdvancedRenderer
  global.samplePath = samplePath
})(window)
