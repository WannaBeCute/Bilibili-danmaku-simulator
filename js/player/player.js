/**
 * player.js:视频模式 / 无视频模式装配。
 *  - 打开视频:objectURL 喂给 <video>,Clock 绑定视频,自动探测侧车弹幕(视频名.json)
 *  - 无视频:虚拟时钟纯播放弹幕
 *  - 背景色:默认跟随系统(黑/白),可设黑/白/深灰/自定义
 */
(function (global) {
  'use strict'

  const Convert = global.DanmakuConvert

  class Player {
    constructor(stageWrap, videoEl, stage, store, engine, clock) {
      this.stageWrap = stageWrap
      this.videoEl = videoEl
      this.stage = stage
      this.store = store
      this.engine = engine
      this.clock = clock

      this.videoNameEl = document.getElementById('video-name')
      this.bgSelect = document.getElementById('bg-select')
      this.bgColorEl = document.getElementById('bg-color')
      this.stageHint = document.getElementById('stage-hint')
      this.imageEl = document.getElementById('stage-image')

      this.videoUrl = null
      this.imageUrl = null
      this.fileName = null
      this.filePath = null
      this.mediaType = null // 'video' | 'image' | null
      this._mediaHidden = false // 隐藏画面状态
      this.hintDismissed = false
      this.playMode = 'stop' // stop | loop | next
      this._aspect = 'auto'
      this._roAspect = null
      this._imgDrag = null // 图片拖拽状态

      this._initBg()
      this._wireVideo()
      this._wireDragDrop()
      this._wireImageDrag()

      // 提示"取消":仅 ✕ 关闭
      const dismissBtn = document.getElementById('hint-dismiss')
      if (dismissBtn) {
        dismissBtn.addEventListener('click', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.hintDismissed = true
          this.stageHint.hidden = true
          this._hintDismissedAt = Date.now()
        })
      }
    }

    hideHint() {
      this.stageHint.hidden = true
    }

    _wireVideo() {
      const v = this.videoEl
      v.addEventListener('play', () => this.engine.play())
      v.addEventListener('playing', () => {
        this.engine.play()
        this.hideHint()
      })
      v.addEventListener('pause', () => this.engine.pause())
      v.addEventListener('waiting', () => this.engine.pause())
      v.addEventListener('seeking', () => this.engine.replay())
      v.addEventListener('loadedmetadata', () => {
        if (this.store.videoInfo) this.store.videoInfo.duration = v.duration || 0
      })
      v.addEventListener('ended', () => {
        if (this.playMode === 'loop') {
          v.currentTime = 0
          this.engine.play()
        } else if (this.playMode === 'next') {
          this.toast('没有下一集视频(自动切集)')
          this.engine.pause()
        } else {
          // 播完暂停:停留在最后一帧
          this.engine.pause()
        }
      })
    }

    /** 播放方式:stop(播完暂停)/loop(循环)/next(自动切集)。 */
    setPlayMode(mode) {
      this.playMode = mode === 'loop' || mode === 'next' ? mode : 'stop'
    }

    /** 视频比例:auto/4:3/16:9。 */
    setVideoAspect(ratio) {
      this._aspect = ratio && ratio !== 'auto' ? ratio : 'auto'
      if (this._roAspect) this._roAspect.disconnect()
      const wrap = this.stageWrap
      const v = this.videoEl
      const apply = () => {
        if (!v) return
        // 重置默认(铺满 + contain)
        v.style.width = ''
        v.style.height = ''
        v.style.left = ''
        v.style.top = ''
        v.style.transform = ''
        v.style.aspectRatio = ''
        if (this._aspect === 'auto') return
        const parts = this._aspect.split(':').map(Number)
        if (parts.length < 2 || !parts[0] || !parts[1]) return
        const wrapW = wrap.clientWidth || 800
        const wrapH = wrap.clientHeight || 450
        const r = parts[0] / parts[1]
        let vw, vh
        if (wrapW / wrapH > r) {
          vh = wrapH
          vw = wrapH * r
        } else {
          vw = wrapW
          vh = wrapW / r
        }
        v.style.width = vw + 'px'
        v.style.height = vh + 'px'
        v.style.left = '50%'
        v.style.top = '50%'
        v.style.transform = 'translate(-50%,-50%)'
        v.style.aspectRatio = this._aspect
      }
      apply()
      this._roAspect = new ResizeObserver(apply)
      this._roAspect.observe(wrap)
    }

    /* ---------- 视频打开/关闭 ---------- */

    openVideo(file) {
      if (!file) return
      // ★ 打开视频前先关闭图片
      this.closeImage()
      if (this.videoUrl) URL.revokeObjectURL(this.videoUrl)
      this.videoUrl = URL.createObjectURL(file)
      this.videoEl.src = this.videoUrl
      this.fileName = file.name
      this.filePath = file.path || '' // Electron File 有 .path;浏览器没有
      this.mediaType = 'video'
      this.videoNameEl.textContent = file.name
      this.stageHint.hidden = true

      this.clock.bindVideo(this.videoEl)
      this.store.videoInfo = {
        filename: this.fileName,
        path: this.filePath,
        duration: this.videoEl.duration || 0,
      }
      this.trySidecar()

      const p = this.videoEl.play()
      if (p && p.catch) p.catch(() => {})
    }

    closeVideo() {
      if (this.videoUrl) {
        URL.revokeObjectURL(this.videoUrl)
        this.videoUrl = null
      }
      this.videoEl.pause()
      this.videoEl.removeAttribute('src')
      this.videoEl.load()
      this.clock.unbindVideo()
      this.fileName = null
      this.filePath = null
      this.mediaType = null
      this.videoNameEl.textContent = ''
      this.stageHint.hidden = this.hintDismissed
    }

    /* ---------- 图片打开/关闭 ---------- */

    /** 打开图片:使用虚拟时钟(同无视频模式),舞台比例不跟随图片。 */
    openImage(file) {
      if (!file) return
      // ★ 打开图片前先关闭视频
      this.closeVideo()
      if (this.imageUrl) URL.revokeObjectURL(this.imageUrl)
      this.imageUrl = URL.createObjectURL(file)
      this.imageEl.src = this.imageUrl
      this.imageEl.hidden = false
      this.fileName = file.name
      this.filePath = file.path || ''
      this.mediaType = 'image'
      this.videoNameEl.textContent = file.name
      this.stageHint.hidden = true
      // 图片模式用虚拟时钟(同无视频模式)
      this.clock.unbindVideo()
      // 重置图片位置到舞台中央
      this._resetImagePosition()
    }

    closeImage() {
      if (this.imageUrl) {
        URL.revokeObjectURL(this.imageUrl)
        this.imageUrl = null
      }
      this.imageEl.removeAttribute('src')
      this.imageEl.hidden = true
      if (this.mediaType === 'image') {
        this.fileName = null
        this.filePath = null
        this.mediaType = null
        this.videoNameEl.textContent = ''
        this.stageHint.hidden = this.hintDismissed
      }
    }

    /** 重置图片到舞台中央,并还原尺寸。 */
    _resetImagePosition() {
      const img = this.imageEl
      img.style.width = ''
      img.style.height = ''
      img.style.left = '50%'
      img.style.top = '50%'
      img.style.transform = 'translate(-50%,-50%)'
    }

    /** 图片拖拽 + 边缘缩放:鼠标在图片内部可拖拽移动,在边缘可同比例缩放。 */
    _wireImageDrag() {
      const img = this.imageEl
      const EDGE = 12 // 边缘判定宽度(px)

      // mousemove 检测边缘,切换光标
      img.addEventListener('mousemove', (e) => {
        if (img.hidden || this._imgDrag) return
        const rect = img.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const atLeft = x < EDGE
        const atRight = x > rect.width - EDGE
        const atTop = y < EDGE
        const atBottom = y > rect.height - EDGE
        if ((atLeft && atTop) || (atRight && atBottom)) {
          img.style.cursor = 'nwse-resize'
        } else if ((atLeft && atBottom) || (atRight && atTop)) {
          img.style.cursor = 'nesw-resize'
        } else if (atLeft || atRight) {
          img.style.cursor = 'ew-resize'
        } else if (atTop || atBottom) {
          img.style.cursor = 'ns-resize'
        } else {
          img.style.cursor = 'grab'
        }
      })

      img.addEventListener('mousedown', (e) => {
        if (img.hidden) return
        e.preventDefault()
        const rect = img.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const atLeft = x < EDGE
        const atRight = x > rect.width - EDGE
        const atTop = y < EDGE
        const atBottom = y > rect.height - EDGE
        const isEdge = atLeft || atRight || atTop || atBottom

        if (isEdge) {
          // ★ 边缘缩放:同比例(保持宽高比)
          const wrap = this.stageWrap.getBoundingClientRect()
          this._imgDrag = {
            mode: 'resize',
            startX: e.clientX,
            startY: e.clientY,
            origW: rect.width,
            origH: rect.height,
            origLeft: rect.left,
            origTop: rect.top,
            atLeft, atRight, atTop, atBottom,
            ratio: rect.width / rect.height, // 宽高比
            wrapW: wrap.width,
            wrapH: wrap.height,
          }
          img.style.cursor = 'nwse-resize'
        } else {
          // ★ 内部拖拽:移动位置
          this._imgDrag = {
            mode: 'move',
            startX: e.clientX,
            startY: e.clientY,
            origLeft: rect.left,
            origTop: rect.top,
          }
          img.style.cursor = 'grabbing'
        }

        const onMove = (ev) => {
          if (!this._imgDrag) return
          const d = this._imgDrag
          const dx = ev.clientX - d.startX
          const dy = ev.clientY - d.startY
          if (d.mode === 'move') {
            img.style.transform = 'none'
            img.style.left = (d.origLeft + dx) + 'px'
            img.style.top = (d.origTop + dy) + 'px'
          } else if (d.mode === 'resize') {
            // ★ 同比例缩放:取鼠标移动距离的对角线投影作为缩放量
            // 右下/左上方向用 dx+dy,右上/左下方向用 dx-dy
            let delta
            if ((d.atRight && d.atBottom) || (d.atLeft && d.atTop)) {
              delta = (dx + dy) / 2
            } else if ((d.atRight && d.atTop) || (d.atLeft && d.atBottom)) {
              delta = (dx - dy) / 2
            } else if (d.atRight || d.atLeft) {
              delta = dx
            } else {
              delta = dy
            }
            // 右/下边为正向,左/上边为反向
            if (d.atLeft || d.atTop) delta = -delta
            let newW = d.origW + delta
            // 保持宽高比
            let newH = newW / d.ratio
            // 限制最小尺寸
            const MIN = 40
            if (newW < MIN) { newW = MIN; newH = newW / d.ratio }
            // 限制最大尺寸(不超过舞台)
            if (newW > d.wrapW) { newW = d.wrapW; newH = newW / d.ratio }
            if (newH > d.wrapH) { newH = d.wrapH; newW = newH * d.ratio }
            img.style.width = newW + 'px'
            img.style.height = newH + 'px'
            // 缩放时保持中心点不变(若从左/上边缩放,需补偿位置)
            if (d.atLeft || d.atTop) {
              img.style.transform = 'none'
              // 保持图片右下角不动(左/上边拖拽时)
              const offsetX = newW - d.origW
              const offsetY = newH - d.origH
              img.style.left = (d.origLeft - offsetX) + 'px'
              img.style.top = (d.origTop - offsetY) + 'px'
            } else {
              // 右/下边缩放:保持左上角不动
              img.style.transform = 'none'
              img.style.left = d.origLeft + 'px'
              img.style.top = d.origTop + 'px'
            }
          }
        }
        const onUp = () => {
          this._imgDrag = null
          img.style.cursor = 'grab'
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
      img.style.cursor = 'grab'
    }

    /* ---------- 隐藏/显示画面 ---------- */

    /** 隐藏当前视频/图片,只保留弹幕。 */
    hideMedia() {
      if (!this.mediaType) return false
      this._mediaHidden = true
      if (this.mediaType === 'video') {
        this.videoEl.style.visibility = 'hidden'
      } else if (this.mediaType === 'image') {
        this.imageEl.style.visibility = 'hidden'
      }
      return true
    }

    /** 取消隐藏,恢复画面显示。 */
    showMedia() {
      this._mediaHidden = false
      this.videoEl.style.visibility = ''
      this.imageEl.style.visibility = ''
    }

    isMediaHidden() {
      return this._mediaHidden
    }

    getVideoPath() {
      return this.filePath || ''
    }

    getVideoName() {
      return this.fileName || ''
    }

    /** 探测侧车弹幕文件;无同名文件时清空列表并提示手动加载。 */
    trySidecar() {
      global.DanmakuIO
        .checkSidecar(this.filePath, this.fileName)
        .then((res) => {
          if (res) {
            const parsed = Convert.fromEnvelope(res.text)
            if (parsed.error || !parsed.records.length) {
              this.toast('侧车文件读取失败或为空: ' + (res.name || ''))
              this._onNoSidecar()
              return
            }
            this._applyRecords(parsed, true)
            this.toast('已自动加载侧车弹幕: ' + (res.name || ''))
          } else {
            this._onNoSidecar()
          }
        })
        .catch(() => this._onNoSidecar())
    }

    _onNoSidecar() {
      this.store.clear()
      this.toast('未找到与视频同名的弹幕文件,点击「打开弹幕(JSON)」或「弹幕文件」手动加载')
    }

    _applyRecords(parsed, fromSidecar) {
      parsed.records.forEach((r) => {
        r.id = null
      })
      this.store.setComments(parsed.records)
      void fromSidecar
    }

    /* ---------- 背景色 ---------- */

    _initBg() {
      const apply = () => {
        const v = this.bgSelect.value
        let bg
        if (v === 'auto') {
          bg = window.matchMedia('(prefers-color-scheme: dark)').matches ? '#000000' : '#ffffff'
          this.bgColorEl.hidden = true
        } else if (v === 'custom') {
          bg = this.bgColorEl.value
          this.bgColorEl.hidden = false
        } else {
          bg = v
          this.bgColorEl.hidden = true
        }
        this.stageWrap.style.setProperty('--stage-bg', bg)
        this.stageWrap.style.background = bg
        if (v === 'auto') {
          this.videoEl.style.background = ''
        } else {
          this.videoEl.style.background = 'transparent'
        }
      }
      this.bgSelect.addEventListener('change', apply)
      this.bgColorEl.addEventListener('input', apply)
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
      apply()
    }

    /* ---------- 拖入视频 ---------- */

    _wireDragDrop() {
      this.stageWrap.addEventListener('dragover', (e) => {
        e.preventDefault()
      })
      this.stageWrap.addEventListener('drop', (e) => {
        e.preventDefault()
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        if (!file) return
        // ★ 拖入也识别图片:按 type/扩展名分发
        const name = (file.name || '').toLowerCase()
        const isImage = (file.type && file.type.indexOf('image/') === 0) || /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/.test(name)
        if (isImage) this.openImage(file)
        else this.openVideo(file)
      })
    }

    /* ---------- 提示 ---------- */

    /**
     * 显示轻提示。
     * @param {string} msg 消息
     * @param {{error?: boolean, duration?: number}} [opts]
     */
    toast(msg, opts) {
      const el = document.getElementById('toast')
      if (!el) return
      el.textContent = msg
      const isError = !!(opts && opts.error)
      const isWarn = !!(opts && opts.warn)
      el.classList.toggle('error', isError)
      el.classList.toggle('warn', isWarn)
      el.classList.add('show')
      clearTimeout(this._toastTimer)
      const duration = (opts && opts.duration && opts.duration > 0) ? opts.duration : (isError ? 4500 : (isWarn ? 3500 : 2600))
      this._toastTimer = setTimeout(() => {
        el.classList.remove('show')
        el.classList.remove('error')
        el.classList.remove('warn')
      }, duration)
    }
  }

  global.Player = Player
})(window)
