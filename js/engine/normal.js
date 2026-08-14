/**
 * normal.js:普通弹幕渲染器(滚动 / 顶部 / 底部)。
 *
 * 所有进度以 clock.now()(媒体秒)为基准:
 *   progress = (now - startMediaTime) / durationSec
 * 暂停时 now 冻结 => 进度冻结;seek 时 now 跳变 => 进度自动重算。
 *
 * 滚动弹幕动画 = CSS transition(transform translateX),GPU 合成、数量大时也不卡。
 * 碰撞判断用解析式 getMoveDistance() = progress * (舞台宽 + 弹幕宽),与 danmu-lib 一致。
 */
(function (global) {
  'use strict'

  const FONT_SIZE_PX = global.FONT_SIZE_PX

  // 普通弹幕:去掉所有真实/字面换行、/n,保持单行(禁止 enter 换行)
  function sanitizeNormalContent(str) {
    let s = String(str == null ? '' : str)
    s = s.replace(/\\n/g, '')
    s = s.replace(/\/n/gi, '')
    s = s.replace(/\r\n?/g, '')
    s = s.replace(/\n/g, '')
    return s
  }

  // █ -> 1em 方背景块; _ -> 1em 宽带底边线 span; 其余保持文本节点(安全无 innerHTML)
  function buildNormalNodes(text, colorHex) {
    const frag = document.createDocumentFragment()
    if (!text) return frag
    const chars = Array.from(text)
    for (const ch of chars) {
      if (ch === '\u2588') {
        const s = document.createElement('span')
        s.className = 'dm-ws-block'
        s.style.background = colorHex || 'currentColor'
        frag.appendChild(s)
        continue
      }
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

  class NormalDanmaku {
    constructor(renderer, record, startMediaTime, opts) {
      this.renderer = renderer
      this.engine = renderer.engine
      this.record = record
      this.id = record.id
      this.mode = record.mode // 'scroll' | 'top' | 'bottom'
      this.startMediaTime = startMediaTime // 真正开始移动的媒体秒
      this.durationSec = opts.durationSec
      this.ended = false
      this.paused = false
      this.moving = false // scroll:已开始 transition;top/bottom:已显示
      this.track = null
      this.tracks = null // ★ 大字号弹幕可能跨越多个轨道,存储所有占用的轨道
      this.slot = null // top/bottom 槽位
      this.slotToken = null
      this.state = 'pending' // pending -> animating -> ended
      this.node = null
      this.textEl = null
      this._removing = false
      this._w = 0 // 缓存宽高,避免碰撞/暂停时 clientWidth 强制布局
      this._h = 0
    }

    /** 已走过的比例(0..1+)。 */
    getProgress() {
      return (this.engine.clock.now() - this.startMediaTime) / this.durationSec
    }

    /** 滚动位移(像素)。供碰撞判断,等价 danmu-lib _getMoveDistance。 */
    getMoveDistance() {
      if (!this.moving || this.mode !== 'scroll') return 0
      return this.getProgress() * (this.engine.width + this.getWidth())
    }

    getWidth() {
      if (this._w) return this._w
      const w = this.node ? this.node.clientWidth || this.node.offsetWidth : 0
      if (w) this._w = w // 仅缓存非 0,便于编辑后失效重测
      return w
    }

    getHeight() {
      if (this._h) return this._h
      const h = this.node ? this.node.clientHeight || this.node.offsetHeight : 0
      if (h) this._h = h
      return h
    }

    buildNode() {
      const rec = this.record
      const node = document.createElement('div')
      node.className = 'dm dm-normal'
      node.setAttribute('data-dm-id', this.id)
      if (!this.engine.editable && this.engine.store.selectedId === this.id) node.classList.add('dm-selected')
      node.style.position = 'absolute'
      node.style.whiteSpace = 'nowrap'

      const inner = document.createElement('span')
      inner.className = 'dm-text'
      const safeContent = sanitizeNormalContent(rec.content)
      const colorHex = global.ColorUtil.normalizeHex(rec.color, '#FFFFFF')
      const frag = buildNormalNodes(safeContent, colorHex)
      inner.appendChild(frag)
      this.textEl = inner

      if (rec.isUp) {
        const badge = document.createElement('img')
        badge.className = 'dm-up-badge'
        badge.src = 'up_pb.svg'
        badge.alt = 'UP'
        badge.draggable = false
        node.appendChild(badge)
      }
      node.appendChild(inner)
      // 先挂 this.node 再应用样式(applyRecordStyle 依赖 this.node 已存在)
      this.node = node
      this.applyRecordStyle()
      return node
    }

    /** 根据 record 应用文本样式(内容/颜色/字号/描边/大会员渐变/字幕)。 */
    applyRecordStyle() {
      if (!this.node) return
      const rec = this.record
      const st = this.engine.getGlobalStyle()
      const px = FONT_SIZE_PX[rec.fontSize] || FONT_SIZE_PX.standard
      const size = Math.round(px * st.fontScale)

      this.node.style.fontSize = size + 'px'
      this.node.style.fontFamily = st.fontFamily
      this.node.style.opacity = String(st.opacity)
      this.node.style.zIndex = '0'
      // 边距:仅█字符本身在 stage.css(.dm-ws-block) 内加 margin,div 外层不加 padding
      // 批量激活(勾选批量复选框)时,即使非编辑模式也要接收鼠标事件(右键弹菜单)。
      this.node.style.pointerEvents = (this.engine.editable || this.engine.batchActive) ? 'auto' : 'none'

      const textEl = this.textEl
      if (!textEl) return
      // ★ textEl 不设 padding(由外层 .dm 提供边距)
      textEl.style.paddingLeft = '0'
      textEl.style.paddingRight = '0'
      // 普通弹幕:真实/字面换行全部过滤, 单行显示
      const content = sanitizeNormalContent(rec.content)
      // 颜色统一归一化为十六进制,避免非 hex 值渲染失败
      const colorHex = global.ColorUtil.normalizeHex(rec.color, '#FFFFFF')
      // 普通弹幕描边:四方向 text-shadow 黑边,粗细可调
      const sw = st.strokeWidth || 1
      const off = (x, y) => sw * x + 'px ' + sw * y + 'px 0 #000'
      const shadow =
        off(1, 0) + ',' + off(-1, 0) + ',' + off(0, 1) + ',' + off(0, -1) + ',' +
        off(1, 1) + ',' + off(-1, -1) + ',' + off(1, -1) + ',' + off(-1, 1) + ',' +
        '0 0 ' + sw * 2 + 'px #000'
      // 清空 textEl,并移除可能的 stroke/fill 子元素缓存
      textEl.innerHTML = ''
      // 强制东亚字符等宽,减少符号宽度差异
      textEl.style.fontVariantEastAsian = 'full-width'
      // 先重置所有可能被 colorful 分支写入的属性
      textEl.style.color = ''
      textEl.style.webkitTextFillColor = ''
      textEl.style.backgroundImage = 'none'
      textEl.style.webkitBackgroundClip = 'initial'
      textEl.style.backgroundClip = 'initial'
      textEl.style.whiteSpace = 'nowrap'
      if (rec.colorful != null && rec.colorful !== 0) {
        // === 大会员:白色填充 + 渐变描边(双层 DOM 叠加) ===
        textEl.classList.add('dm-colorful')
        textEl.classList.remove('dm-colorful-fallback')
        // 底层:渐变描边
        const strokeEl = document.createElement('span')
        strokeEl.className = 'dm-colorful-stroke'
        strokeEl.appendChild(buildNormalNodes(content, '#FFFFFF'))
        // 上层:白色填充
        const fillEl = document.createElement('span')
        fillEl.className = 'dm-colorful-fill'
        fillEl.appendChild(buildNormalNodes(content, '#FFFFFF'))
        textEl.appendChild(strokeEl)
        textEl.appendChild(fillEl)
        textEl.style.textShadow = 'none'
      } else {
        // === 普通弹幕:单层,直接在 textEl 内构建节点(保持原有逻辑) ===
        textEl.classList.remove('dm-colorful')
        textEl.classList.remove('dm-colorful-fallback')
        const contentFrag = buildNormalNodes(content, colorHex)
        textEl.appendChild(contentFrag)
        textEl.style.color = colorHex
        textEl.style.webkitTextFillColor = ''
        textEl.style.backgroundImage = 'none'
        textEl.style.webkitBackgroundClip = 'initial'
        textEl.style.backgroundClip = 'initial'
        textEl.style.textShadow = shadow
      }
      // 文本/字号变化后宽高缓存失效,下次 getWidth 重新测量
      this._w = 0
      this._h = 0
    }

    /** 挂到舞台并测量尺寸(等双 rAF 让字体渲染完成)。 */
    append() {
      this.engine.stage.appendChild(this.node)
      // 测量期隐藏,避免闪烁;scroll 先移到右侧屏外
      this.node.style.opacity = '0'
      if (this.mode === 'scroll') {
        this.node.style.left = '0px'
        this.node.style.transform = 'translateX(' + this.engine.width + 'px)'
      }
    }

    /** 开始滚动动画。必须已分配 track、已测量宽度。 */
    startScroll() {
      const W = this.engine.width
      const w = this.getWidth()
      const h = this.getHeight()
      // ★ y 坐标基于所有占用轨道块的居中位置(大字号弹幕跨越多个轨道)
      const tracks = this.tracks || [this.track]
      const blockTop = tracks[0].top
      const blockBottom = tracks[tracks.length - 1].top + this.engine.trackHeight
      const blockMiddle = (blockTop + blockBottom) / 2
      let y = blockMiddle - h / 2
      // 钳制到可视范围内
      if (y < 0) y = 0
      if (h <= this.engine.height && y + h > this.engine.height) {
        y = this.engine.height - h
      }
      // 正常播放 startMediaTime 为 null => 从当前时刻开始;seek 重放传入 timeSec 实现进度
      if (this.startMediaTime == null) this.startMediaTime = this.engine.clock.now()
      this.node.style.top = y + 'px'
      this.node.style.left = '0px'
      this.node.style.opacity = String(this.engine.getGlobalStyle().opacity)

      // ★ 快进到当前 clock.now() 对应的真实位置,避免 replace/undo/seek 时弹幕从右侧重跑。
      const now = this.engine.clock.now()
      const elapsedSec = Math.max(0, now - this.startMediaTime)
      const totalSec = this.durationSec
      const progress = Math.min(1, Math.max(0, totalSec > 0 ? elapsedSec / totalSec : 0))

      // 总走过距离(左缘 x 从 W 到 -w,总距离 = 屏幕宽度 W + 弹幕自身宽度 w)
      const totalDist = W + w
      const walked = totalDist * progress

      // 如果进度已经走完(例如 seek 到很远后面),直接销毁不生成空节点
      if (progress >= 1) {
        this.destroy()
        return
      }

      this.moving = true
      this.state = 'animating'

      // 走完后必须 destroy(移除节点),否则节点泄漏留在 DOM,选中框会残留
      this._onEnd = () => {
        this.destroy()
      }
      this.node.addEventListener('transitionend', this._onEnd, { once: true })

      if (this.engine.clock.playing) {
        // 播放中:先锁死到快进位置,再启动剩余时长的 transition
        this.node.style.transition = 'none'
        this.node.style.transform = 'translateX(' + (W - walked) + 'px)'
        void this.node.offsetWidth // 强制 reflow,确保快进位置先落地
        const remainSec = totalSec - elapsedSec
        const effDurMs = (remainSec / this.engine.clock.rate) * 1000
        this.node.style.transition = 'transform linear ' + effDurMs + 'ms'
        this.node.style.transform = 'translateX(' + -w + 'px)'
      } else {
        // ★ 暂停状态:直接设置到当前位置,不启动 transition。
        //   之前先启动 transition 再 pause() 取消的方式,在某些时序下仍会触发 transitionend,
        //   导致弹幕被错误销毁。改为直接设置静态位置,resume() 时再启动 transition。
        this.paused = true
        this.node.style.transition = 'none'
        this.node.style.transform = 'translateX(' + (W - walked) + 'px)'
      }
    }

    /** 顶部/底部:显示固定时长后结束。位置由 engine 分配槽位后调用。 */
    startFixed() {
      const W = this.engine.width
      const w = this.getWidth()
      const h = this.getHeight()
      const trackHeight = this.engine.trackHeight
      let top
      if (this.mode === 'top') {
        top = this.slot * trackHeight + (trackHeight - h) / 2
      } else {
        const slotIdx = ~this.slot
        const areaH = this.engine.usableHeight || this.engine.height
        top = areaH - (slotIdx + 1) * trackHeight + (trackHeight - h) / 2
      }
      // ★ engine 未 layout(stage 无尺寸)时直接销毁,避免渲染到错误位置
      if (!this.engine.height) {
        this.destroy()
        return
      }
      // ★ 弹幕实际高度因 line-height(1.3) 可能略大于 trackHeight(30),导致 top 计算为负
      //   或 top+h 超出舞台。此时钳制到可视范围内,而非销毁(否则顶/底弹幕永不显示)。
      if (top < 0) top = 0
      if (h <= this.engine.height && top + h > this.engine.height) {
        top = this.engine.height - h
      }
      if (this.startMediaTime == null) this.startMediaTime = this.engine.clock.now()
      this.node.style.top = top + 'px'
      this.node.style.left = (W - w) / 2 + 'px'
      this.node.style.opacity = String(this.engine.getGlobalStyle().opacity)

      // ★ 与滚动弹幕一致:快进到当前真实进度,若已经走完则直接销毁,不生成残留空节点
      const now = this.engine.clock.now()
      const elapsedSec = Math.max(0, now - this.startMediaTime)
      const totalSec = this.durationSec
      const progress = Math.min(1, Math.max(0, totalSec > 0 ? elapsedSec / totalSec : 0))
      if (progress >= 1) {
        this.destroy()
        return
      }

      this.moving = true
      this.state = 'animating'

      // 与滚动弹幕保持一致:暂停/拖动进度条时新生成的顶/底弹幕也标记 paused,
      // 避免后续 play→resumeAll 时漏处理状态不一致。
      if (!this.engine.clock.playing) {
        this.paused = true
      }
    }

    /** 每帧更新(由 engine 循环调用)。top/bottom 到点销毁。 */
    update() {
      if (this.mode === 'scroll') return
      if (this.state === 'animating' && this.getProgress() >= 1) {
        this.destroy()
      }
    }

    /** 暂停:冻结位置(当前左缘 x = W - 已走距离 d)。 */
    pause() {
      if (this.paused || this.ended || !this.moving) return
      this.paused = true
      if (this.mode === 'scroll') {
        const d = this.getMoveDistance()
        this.node.style.transition = 'none'
        this.node.style.transform = 'translateX(' + (this.engine.width - d) + 'px)'
      }
    }

    /** 恢复:按剩余媒体时长重放过渡。 */
    resume() {
      if (!this.paused || this.ended || !this.moving) return
      this.paused = false
      if (this.mode === 'scroll') {
        const W = this.engine.width
        const w = this.getWidth()
        const remaining = Math.max(0, this.durationSec - this.getProgress() * this.durationSec)
        const effDurMs = (remaining / this.engine.clock.rate) * 1000
        void this.node.offsetWidth
        this.node.style.transition = 'transform linear ' + effDurMs + 'ms'
        this.node.style.transform = 'translateX(' + -w + 'px)'
      }
    }

    end() {
      if (this.ended) return
      this.ended = true
      this.moving = false
      this.state = 'ended'
      if (this.node && this._onEnd) {
        this.node.removeEventListener('transitionend', this._onEnd)
        this._onEnd = null
      }
      if (this.tracks) {
        for (const t of this.tracks) t._remove(this)
        this.tracks = null
      }
      if (this.track) {
        this.track._remove(this)
        this.track = null
      }
      if (this.slotToken) {
        this.renderer.releaseSlot(this.slot, this.mode, this.slotToken)
        this.slotToken = null
        this.slot = null
      }
    }

    destroy() {
      this.end()
      if (this.node && this.node.parentNode) {
        this.node.parentNode.removeChild(this.node)
      }
      this.node = null
    }
  }

  class NormalRenderer {
    constructor(engine) {
      this.engine = engine
      this.active = [] // 活跃(含 pending/animating)
      this.stash = [] // 等待轨道的滚动弹幕 record
    }

    get count() {
      return this.active.length
    }

    getGlobalStyle() {
      return this.engine.getGlobalStyle()
    }

    /**
     * 滚动弹幕尝试找轨道:从上到下顺序分配,先发在上,后发在下。
     * ★ 大字号弹幕高度可能 > trackHeight,需占用连续多个轨道避免与其他弹幕重叠。
     * 返回 { track, tracks } 或 null。track=起始轨道,tracks=所有占用的轨道数组。
     *
     *  ★ 修复规则(按用户需求):
     *   - small(18px) / standard(25px) → 碰撞高度完全相同 → 均只占 1 条轨道(避免 standard 白白占 2 轨道导致拥挤)
     *   - large(36px) → 碰撞高度与字号实际大小相适应 → 按 estHeight/trackHeight 精确计算占用轨道
     *   - 同轨两条弹幕的最小间距缩小(不再用大 gap 8),避免轨道复用过于保守导致卡弹
     */
    getTrack(record) {
      const engine = this.engine
      const rows = engine.tracks.length
      if (rows === 0) return null
      if (engine.allowOverlap) return { track: engine.tracks[0], tracks: [engine.tracks[0]] }

      // ★ 根据字号分类决定需要占用的轨道数(用户需求:小/标准一致=1轨;large 按实际高度算)
      const fs = (record && record.fontSize) || 'standard'
      let needRows
      if (fs === 'large') {
        const px = FONT_SIZE_PX.large
        const estHeight = px * 1.3 // line-height 放大
        const trackHeight = engine.trackHeight || 30
        needRows = Math.max(1, Math.ceil(estHeight / trackHeight))
      } else {
        // small / standard 以及任何非 large 的情况:都按 1 轨道计算,保证碰撞高度相同
        needRows = 1
      }

      // ★ 缩小弹幕与弹幕之间的间距:原本全局 8px,对每条新弹幕根据字号精确到"同量级字号的保守安全距离",
      //   按字号 * 0.029 计算(Padding 风格),再额外 + 2px 保底,整体比旧版小得多。
      const pxCurrent = FONT_SIZE_PX[fs] || FONT_SIZE_PX.standard
      const dynamicGap = Math.round(pxCurrent * 0.029) + 2 // small≈2.5,standard≈2.7,large≈3

      const gap = engine.allowOverlap ? 0 : dynamicGap
      for (let i = 0; i <= rows - needRows; i++) {
        // 检查从 i 开始的连续 needRows 个轨道是否都可用
        let ok = true
        const tracks = []
        for (let j = 0; j < needRows; j++) {
          const track = engine.tracks[i + j]
          const last = track.last()
          if (last) {
            const lastWidth = last.getWidth()
            if (!(lastWidth > 0 && last.getMoveDistance() >= gap + lastWidth)) {
              ok = false
              break
            }
          }
          tracks.push(track)
        }
        if (ok) return { track: tracks[0], tracks: tracks }
      }
      return null
    }

    _getTrackRec(founds, prev, gap) {
      // ★ 保留方法签名兼容外部调用,内部已改用顺序分配(见 getTrack)
      return this.getTrack()
    }

    /**
     * 入列一条普通弹幕(滚动进 stash 等轨道;顶/底直接发射)。
     * 返回是否已发射(true)或已排队。
     */
    enqueue(record, startMediaTime) {
      if (record.mode === 'scroll') {
        this.stash.push({ record: record, startMediaTime: startMediaTime })
        return true
      }
      return this.spawnFixed(record, startMediaTime)
    }

    /** 从 stash 尽量发射滚动弹幕(受 maxOnScreen 约束)。 */
    emitStash() {
      const engine = this.engine
      const durationSec = engine.options.durationSec / engine.danmakuSpeed
      while (this.stash.length) {
        if (engine.isAtMax()) break
        const item = this.stash[0]
        const trackInfo = this.getTrack(item.record)
        if (!trackInfo) break // 轨道全满,等待
        this.stash.shift()
        // ★ 弹幕在 stash 中等待过久(超过其生命周期)时,重置 startMediaTime 为当前时间,
        //   避免 startScroll 中 progress>=1 直接销毁导致弹幕不渲染
        if (item.startMediaTime != null) {
          const elapsed = engine.clock.now() - item.startMediaTime
          if (elapsed >= durationSec) {
            item.startMediaTime = engine.clock.now()
          }
        }
        const dm = this.spawnScroll(item.record, item.startMediaTime, trackInfo)
        if (!dm) break
      }
    }

    /** 发射滚动弹幕(已分好轨道)。trackInfo = { track, tracks } */
    spawnScroll(record, startMediaTime, trackInfo) {
      const dm = new NormalDanmaku(this, record, startMediaTime, {
        durationSec: this.engine.options.durationSec / this.engine.danmakuSpeed,
      })
      dm.track = trackInfo.track
      dm.tracks = trackInfo.tracks
      for (const t of trackInfo.tracks) t._add(dm)
      this.active.push(dm)
      dm.buildNode()
      dm.append()
      let tries = 0
      const measure = () => {
        if (dm.ended || !dm.node) return
        const w = dm.getWidth()
        if (w === 0 && tries < 20) {
          tries++
          global.DomUtil.nextFrame(measure)
          return
        }
        dm.startScroll()
      }
      global.DomUtil.nextFrame(measure)
      return dm
    }

    /** 发射顶/底固定弹幕。满则丢弃。 */
    spawnFixed(record, startMediaTime) {
      const engine = this.engine
      if (engine.stack.isFull(record.mode)) return null
      const slot = engine.stack.push(record.mode)
      const dm = new NormalDanmaku(this, record, startMediaTime, {
        durationSec: this.engine.options.durationSec / this.engine.danmakuSpeed,
      })
      dm.slot = slot
      dm.slotToken = engine.stack
      this.active.push(dm)
      dm.buildNode()
      dm.append()
      let tries = 0
      const measure = () => {
        if (dm.ended || !dm.node) return
        const w = dm.getWidth()
        if (w === 0 && tries < 20) {
          tries++
          global.DomUtil.nextFrame(measure)
          return
        }
        dm.startFixed()
      }
      global.DomUtil.nextFrame(measure)
      return dm
    }

    releaseSlot(slot, mode, token) {
      if (!token) return
      this.engine.stack.remove(slot, mode)
    }

    /** 推进所有活跃普通弹幕(顶/底到点销毁)。 */
    update() {
      if (!this.active.length) return
      for (let i = this.active.length - 1; i >= 0; i--) {
        const dm = this.active[i]
        if (dm.ended) {
          this.active.splice(i, 1)
          continue
        }
        dm.update()
      }
    }

    /** 暂停/恢复全部。 */
    pauseAll() {
      this.active.forEach((dm) => dm.pause())
    }

    resumeAll() {
      this.active.forEach((dm) => dm.resume())
    }

    /** 清场。 */
    clear() {
      this.active.slice().forEach((dm) => dm.destroy())
      this.active.length = 0
      this.stash.length = 0
    }

    /** 编辑时按 record 即时刷新节点样式(内容/颜色/字号/渐变)。 */
    refreshNode(record) {
      this.active.forEach((dm) => {
        if (dm.id === record.id && dm.node) {
          dm.applyRecordStyle()
        }
      })
    }

    /** 编辑时按 id 重建(模式切换等)。 */
    respawn(record) {
      const dm = this.active.find((d) => d.id === record.id)
      if (!dm) return false
      const startMediaTime = this.engine.clock.now()
      const track = dm.track
      const slot = dm.slot
      const mode = dm.mode
      dm.destroy()
      this.active = this.active.filter((d) => d.id !== record.id)
      if (mode === 'scroll') {
        this.stash.unshift({ record: record, startMediaTime: startMediaTime })
      } else {
        // 释放旧槽位后在下一帧重新发射(简化:直接尝试)
        this.enqueue(record, startMediaTime)
      }
      return true
    }

    /** 移除某 record 对应的活跃弹幕。 */
    removeById(id) {
      for (let i = this.active.length - 1; i >= 0; i--) {
        if (this.active[i].id === id) {
          this.active[i].destroy()
          this.active.splice(i, 1)
        }
      }
      this.stash = this.stash.filter((it) => it.record.id !== id)
    }
  }

  global.NormalRenderer = NormalRenderer
  global.NormalDanmaku = NormalDanmaku
})(window)
