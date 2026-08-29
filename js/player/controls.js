/**
 * controls.js:工具栏 + B站风格播放器控制条 + 弹幕发送栏装配。
 */
(function (global) {
  'use strict'

  const Convert = global.DanmakuConvert
  const D = global.DomUtil
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
  const round2 = (n) => Math.round(n * 100) / 100

  class Controls {
    constructor(store, engine, clock, editor, player, root, fileDialog) {
      this.store = store
      this.engine = engine
      this.clock = clock
      this.editor = editor
      this.player = player
      this.fileDialog = fileDialog || new global.FileDialog()

      // 工具栏
      this.btnOpenVideo = D.$('#btn-open-video')
      this.btnCreatePool = D.$('#btn-create-pool')
      this.btnDanmakuFiles = D.$('#btn-danmaku-files')
      this.btnOpenDanmaku = D.$('#btn-open-danmaku')
      this.btnExport = D.$('#btn-export')
      this.btnHideMedia = D.$('#btn-hide-media')
      this.fileVideo = D.$('#file-video')
      this.fileDanmaku = D.$('#file-danmaku')
      this.fileImport = D.$('#file-import')
      this.dmCountEl = D.$('#dm-count')
      this.stage = D.$('#stage')
      this.stageWrap = D.$('#stage-wrap')

      // 播放器控制条
      this.pbPlay = D.$('#pb-play')
      this.pbPrev = D.$('#pb-prev')
      this.pbNext = D.$('#pb-next')
      this.pbCollapse = D.$('#pb-collapse')
      this.pbProgress = D.$('#pb-progress')
      this.pbFill = D.$('#pb-fill')
      this.pbThumb = D.$('#pb-thumb')
      this.pbTime = D.$('#pb-time')
      this.pbSpeed = D.$('#pb-speed')
      this.pbSpeedMenu = D.$('#pb-speed-menu')
      this.pbSubtitle = D.$('#pb-subtitle')
      this.pbVol = D.$('#pb-vol')
      this.pbVolRange = D.$('#pb-vol-range')
      this.pbSettings = D.$('#pb-settings')
      this.pbSettingsMenu = D.$('#pb-settings-menu')
      this.pbPlaymode = D.$('#pb-playmode')
      this.pbAspect = D.$('#pb-aspect')
      this.pbPip = D.$('#pb-pip')
      this.pbFullscreen = D.$('#pb-fullscreen')
      this.pbEdit = D.$('#pb-edit')
      this.pbCloseVideo = D.$('#pb-closevideo')
      this._dmVisible = true // 弹幕显示状态(弹 按钮控制)

      // 弹幕发送栏
      this.dbNormal = D.$('#db-normal')
      this.dbSettings = D.$('#db-settings')
      this.dbSettingsPanel = D.$('#db-settings-panel')
      this.dbA = D.$('#db-a')
      this.dbStylePopup = D.$('#db-style-popup')
      this.dbStyleMode = D.$('#db-style-mode')
      this.dbStyleFont = D.$('#db-style-fontsize')
      this.dbStyleColors = D.$('#db-style-colors')
      this.dbStyleColorText = D.$('#db-style-color-text')
      this.dbStyleColorPick = D.$('#db-style-color-pick')
      this.dbStyleColorful = D.$('#db-style-colorful')
      this.dbStyleIsUp = D.$('#db-style-isup')
      this.dbInput = D.$('#db-input')
      this.dbGuide = D.$('#db-guide')
      this.dbSend = D.$('#db-send')

      this._dragging = false
      this._subtitleOn = false
      this._barTimer = null
      this._lastSeekAt = 0
      this._playMode = 'stop' // stop | loop | next
      // 发送栏默认样式(仅普通弹幕)
      this._sendStyle = { mode: 'scroll', fontSize: 'standard', color: '#FFFFFF', colorful: null }

      // ★ 当前打开的本地弹幕池文件 id/名称(Ctrl+S 直接更新对应文件)
      this._currentLibId = null
      this._currentLibName = null

      // ★ 脏状态追踪:保存基线 JSON,用于判断当前弹幕池是否有未保存改动
      this._savedBaseline = ''   // 上次成功写入磁盘时的完整 JSON 文本,空字符串=无基线(视为有改动/或空白默认)
      this._dirtyOverride = null // 若显式设置,优先用其 boolean 值(用于空池 / 创建新空池)
      this._quitPending = false  // 退出弹窗是否已在显示,避免重复弹

      // ★ 保存按钮「已保存」状态:引用 + 防抖计时器
      this._saveStateBtn = null
      this._saveStateTimer = null
      // ★ 自动写盘:开启自动保存时,编辑后延迟写盘(防抖)
      this._autoSaveTimer = null

      this._wire()
      // ★ 任何 store 数据变更(add/remove/change/replace/select)后刷新保存按钮状态(防抖)
      if (this.store && typeof this.store.onChange === 'function') {
        this.store.onChange(() => {
          this._scheduleSaveStateRefresh()
          this._scheduleAutoSave()
        })
      }
      // 初始刷新一次
      this._scheduleSaveStateRefresh()
    }

    _wire() {
      // ----- 工具栏 -----

      this.btnOpenVideo.addEventListener('click', () => {
        // 同时支持视频/音乐/图片
        this.fileDialog.open('打开视频/音乐/图片', 'video/*,.mkv,.mp4,.webm,.flv,audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,image/*,.jpg,.jpeg,.png,.gif,.webp,.bmp,.svg', (f) => {
          // 根据文件类型分发:图片 → openImage,音频 → openMusic,视频 → openVideo
          if (this._isImageFile(f)) {
            this.player.openImage(f)
            this.player.toast('已打开图片: ' + f.name + '(弹幕按无视频模式运行)')
          } else if (this._isAudioFile(f)) {
            this.player.openMusic(f)
            this.player.toast('已打开音乐: ' + f.name)
          } else {
            this.player.openVideo(f)
          }
          this._updateCloseMediaBtn()
        })
      })
      // ★ 隐藏画面按钮:点击切换隐藏/显示当前视频/图片
      this.btnHideMedia.addEventListener('click', () => {
        if (!this.player.mediaType) {
          this.player.toast('当前没有可隐藏的视频/图片')
          return
        }
        if (this.player.isMediaHidden()) {
          this.player.showMedia()
          this.btnHideMedia.classList.remove('active')
          this.player.toast('已显示画面')
        } else {
          if (this.player.hideMedia()) {
            this.btnHideMedia.classList.add('active')
            this.player.toast('已隐藏画面,只保留弹幕')
          }
        }
      })
      this.btnDanmakuFiles.addEventListener('click', () => this._openDanmakuLibrary())
      // ★ + 创建弹幕池:弹确认框(先保存/清空 → 创建新空 JSON 文件并自动打开)
      if (this.btnCreatePool) {
        this.btnCreatePool.addEventListener('click', () => this._createEmptyDanmakuPool())
      }
      // 「导入弹幕」:有未保存改动先弹三态保存确认;读取后在本地弹幕池创建新 JSON 文件并打开(不再原地替换当前池)
      this.btnOpenDanmaku.addEventListener('click', () => {
        if (this._isLocked()) return
        this.player.toast('JSON 格式直接导入;XML/ASS 格式会先转换为 JSON 再导入')
        this._promptImportGate(() => {
          this.fileDialog.open('导入弹幕(JSON/XML/ASS)', '.json,.xml,.ass,.ssa,application/json,text/xml', (f) =>
            this._readAsText(f).then((text) =>
              this._importAndCreateLibraryEntry({ name: f.name, text: text })
            )
          )
        })
      })
      this.btnExport.addEventListener('click', () => {
        if (!this.store.count()) {
          this.player.toast('没有可导出的弹幕')
          return
        }
        this._showExportModal()
      })

      // ----- 播放器控制条 -----
      this.pbPlay.addEventListener('click', () => {
        if (this.clock.playing) this.engine.pause()
        else {
          this.engine.play()
          this.player.hideHint()
        }
        this._showBarTemporarily()
      })
      this.pbPrev.addEventListener('click', () => this._jumpDanmaku(-1))
      this.pbNext.addEventListener('click', () => this._jumpDanmaku(1))

      this.pbProgress.addEventListener('mousedown', (e) => {
        e.preventDefault()
        this._dragging = true
        this.pbProgress.classList.add('dragging')
        this._seekFromEvent(e)
        const onMove = (ev) => this._seekFromEvent(ev)
        const onUp = () => {
          this._dragging = false
          this.pbProgress.classList.remove('dragging')
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          this._showBarTemporarily()
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })

      // 倍速菜单
      this.pbSpeed.addEventListener('click', (e) => {
        e.stopPropagation()
        this._toggleMenu(this.pbSpeedMenu)
      })
      D.$$('.pb-menu-item', this.pbSpeedMenu).forEach((btn) => {
        btn.addEventListener('click', () => {
          this.engine.setRate(parseFloat(btn.getAttribute('data-rate')))
          this.pbSpeedMenu.hidden = true
          this._updateSpeedLabel()
          this._showBarTemporarily()
        })
      })

      // 字幕开关
      this.pbSubtitle.addEventListener('click', () => {
        this._subtitleOn = !this._subtitleOn
        const v = this.player.videoEl
        const tracks = v && v.textTracks
        if (!tracks || !tracks.length) {
          this._subtitleOn = false
          this.player.toast('当前视频未加载字幕轨道')
          return
        }
        for (const t of Array.from(tracks)) {
          t.mode = this._subtitleOn ? 'showing' : 'hidden'
        }
        this.pbSubtitle.classList.toggle('active', this._subtitleOn)
      })

      // 音量
      this.pbVol.addEventListener('click', () => {
        const v = this.player.videoEl
        if (!v) return
        v.muted = !v.muted
        this._updateVolIcon()
      })
      this.pbVolRange.addEventListener('input', () => {
        const v = this.player.videoEl
        if (!v) return
        v.volume = parseFloat(this.pbVolRange.value)
        v.muted = false
        this._updateVolIcon()
      })

      // 设置菜单
      this.pbSettings.addEventListener('click', (e) => {
        e.stopPropagation()
        this._updatePlayModeEnabled()
        this._toggleMenu(this.pbSettingsMenu)
      })
      this._updatePlayModeEnabled()
      // 播放方式(三选一,默认播完暂停)
      this._wireRadio(this.pbPlaymode, (val) => {
        this._playMode = val
        this.player.setPlayMode(val)
      })
      // 视频比例(三选一,默认自动)
      this._wireRadio(this.pbAspect, (val) => {
        this.player.setVideoAspect(val)
      })

      // 画中画 / 全屏
      this.pbPip.addEventListener('click', () => {
        const v = this.player.videoEl
        if (v && v.requestPictureInPicture) {
          if (document.pictureInPictureElement) document.exitPictureInPicture()
          else v.requestPictureInPicture().catch(() => this.player.toast('画中画不可用'))
        }
      })
      this.pbFullscreen.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen()
        else this.stageWrap.requestFullscreen && this.stageWrap.requestFullscreen()
      })

      // 编辑模式(播放器右下)
      this.pbEdit.addEventListener('click', () => {
        const on = !this.editor.isEnabled()
        this.editor.setEnabled(on)
        this.pbEdit.classList.toggle('active', on)
        this._showBarTemporarily()
      })

      // 关闭视频/图片/音乐(不清除弹幕列表)
      this.pbCloseVideo.addEventListener('click', () => {
        const mt = this.player.mediaType
        if (!mt) {
          this.player.toast('当前没有播放媒体')
          return
        }
        const label = mt === 'image' ? '图片' : mt === 'audio' ? '音乐' : '视频'
        const msg = '确定关闭当前' + label + '吗?关闭后弹幕列表将保留。'
        global.DanmakuIO.confirmDialog(msg).then((ok) => {
          if (ok) {
            if (mt === 'image') {
              this.player.closeImage()
              this.player.toast('已关闭图片')
            } else if (mt === 'audio') {
              this.player.closeMusic()
              this.player.toast('已关闭音乐')
            } else {
              this.player.closeVideo()
              this.player.toast('已关闭视频')
            }
            this._updateCloseMediaBtn()
          }
        })
      })
      // ★ 初始化:无媒体时隐藏关闭按钮
      this._updateCloseMediaBtn()

      // 控制条折叠按钮(中间,悬停显示,收起旋转)
      // ★ 第一次打开程序时默认展开(不 collapsed),之后记住用户选择(localStorage)
      const PB_KEY = 'pb_collapsed'
      let pbCollapsedStored
      try { pbCollapsedStored = localStorage.getItem(PB_KEY) } catch (_) { pbCollapsedStored = null }
      this._pbCollapsed = pbCollapsedStored === 'true' // 第一次打开(null) → false(展开)
      const pbBar = D.$('#player-bar')
      if (pbBar) pbBar.classList.toggle('collapsed', this._pbCollapsed)
      if (this.pbCollapse) this.pbCollapse.classList.toggle('up', this._pbCollapsed)
      if (this.pbCollapse) {
        this.pbCollapse.addEventListener('click', (e) => {
          e.stopPropagation()
          this._pbCollapsed = !this._pbCollapsed
          if (pbBar) pbBar.classList.toggle('collapsed', this._pbCollapsed)
          this.pbCollapse.classList.toggle('up', this._pbCollapsed)
          try { localStorage.setItem(PB_KEY, String(this._pbCollapsed)) } catch (_) {}
        })
      }

      // 点击空白关闭菜单
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.pb-menu-wrap')) {
          this.pbSpeedMenu.hidden = true
          this.pbSettingsMenu.hidden = true
        }
      })

      // 播放条自动隐藏
      this.stageWrap.addEventListener('mousemove', () => this._showBarTemporarily())
      this.stageWrap.addEventListener('mouseleave', () => this._scheduleBarHide())
      this.stageWrap.addEventListener('dblclick', (e) => {
        // 舞台提示及其关闭按钮区域不触发双击全屏;且 ✕ 刚关闭提示后的双击也不触发
        if (e.target && e.target.closest && e.target.closest('#stage-hint')) return
        const p = this.player
        if (p._hintDismissedAt && Date.now() - p._hintDismissedAt < 500) return
        if (document.fullscreenElement) document.exitFullscreen()
        else this.stageWrap.requestFullscreen && this.stageWrap.requestFullscreen()
      })

      // ----- 弹幕发送栏 -----
      // "弹" = 弹幕显示开关
      this.dbNormal.addEventListener('click', () => {
        this._setDanmakuVisible(!this._dmVisible)
      })
      this._setDanmakuVisible(true)

      // "A" = 普通弹幕样式弹窗(仅再次点击 A 才关闭)
      this.dbA.addEventListener('click', (e) => {
        e.stopPropagation()
        this.dbStylePopup.hidden = !this.dbStylePopup.hidden
        this.dbA.classList.toggle('active', !this.dbStylePopup.hidden)
      })
      this._wireSendStyle()
      this._wireDanmakuSettings()
      this._wireDanmakuLibrary()

      this.dbGuide.addEventListener('click', () => this.player.toast('弹幕指南页面建设中'))
      this.dbSend.addEventListener('click', () => this._sendDanmaku())
      this.dbInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this._sendDanmaku()
      })

      // ★ 点击「弹幕 N」span:打开「当前弹幕池」总览窗口
      this.dmCountEl.addEventListener('click', () => {
        const list = global.window.App && global.window.App.list
        if (list && typeof list.openPoolOverview === 'function') list.openPoolOverview()
      })
      this.dmCountEl.title = '点击进入「当前弹幕池」管理展示范围与筛选'

      this.store.onChange(() => this._updateCount())
      this._updateCount()
      this._updateSpeedLabel()
    }

    /* ---------- 播放条菜单/显隐 ---------- */

    _toggleMenu(menu) {
      const willShow = menu.hidden
      this.pbSpeedMenu.hidden = true
      this.pbSettingsMenu.hidden = true
      menu.hidden = !willShow
      this._showBarTemporarily()
    }

    _anyMenuOpen() {
      return !this.pbSpeedMenu.hidden || !this.pbSettingsMenu.hidden
    }

    _showBarTemporarily() {
      this.stageWrap.classList.remove('bar-hidden')
      this._scheduleBarHide()
    }

    _scheduleBarHide() {
      clearTimeout(this._barTimer)
      this._barTimer = setTimeout(() => {
        if (!this.clock.playing) return
        if (this._anyMenuOpen() || this._dragging) return
        this.stageWrap.classList.add('bar-hidden')
      }, 2600)
    }

    /* ---------- 进度条 ---------- */

    _timelineDuration() {
      const video = this.clock.mode === 'video' ? this.clock.video : null
      if (video && video.duration && isFinite(video.duration)) return video.duration
      let max = 30
      for (const rec of this.store.comments) {
        const end = rec.type === 'advanced' ? rec.timeSec + rec.life.duration : rec.timeSec + 5
        if (end > max) max = end
      }
      return max
    }

    _seekFromEvent(e) {
      const rect = this.pbProgress.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const t = ratio * this._timelineDuration()
      const now = Date.now()
      if (now - this._lastSeekAt < 80) return
      this._lastSeekAt = now
      this.engine.seek(t)
    }

    /** 跳转到前/后一条弹幕。 */
    _jumpDanmaku(dir) {
      const now = this.clock.now()
      const comments = this.store.sorted()
      let target = null
      if (dir < 0) {
        for (let i = comments.length - 1; i >= 0; i--) {
          if (comments[i].timeSec < now - 0.05) {
            target = comments[i]
            break
          }
        }
      } else {
        for (const c of comments) {
          if (c.timeSec > now + 0.05) {
            target = c
            break
          }
        }
      }
      if (target) this.engine.seek(target.timeSec)
      else this.player.toast(dir < 0 ? '已是第一条弹幕' : '已是最后一条弹幕')
    }

    /* ---------- 播放条刷新 ---------- */

    _updateSpeedLabel() {
      if (this.pbSpeed) this.pbSpeed.textContent = '倍速 ' + this.clock.rate + 'x'
      const items = this.pbSpeedMenu ? D.$$('.pb-menu-item', this.pbSpeedMenu) : []
      for (const b of items) {
        b.classList.toggle('active', parseFloat(b.getAttribute('data-rate')) === this.clock.rate)
      }
    }

    _updateVolIcon() {
      const v = this.player.videoEl
      if (!v) return
      this.pbVol.textContent = v.muted || v.volume === 0 ? '🔇' : '🔊'
      this.pbVolRange.value = String(v.volume)
    }

    refresh() {
      const now = this.clock.now()
      const dur = this._timelineDuration()
      this.pbTime.textContent =
        global.TimeUtil.fmtClock(now) + ' / ' + global.TimeUtil.fmtClock(dur)
      this.pbPlay.textContent = this.clock.playing ? '❚❚' : '▶'
      if (!this._dragging) {
        const pct = dur > 0 ? clamp((now / dur) * 100, 0, 100) : 0
        this.pbFill.style.width = pct + '%'
        this.pbThumb.style.left = pct + '%'
      }
      this._updateSpeedLabel()
    }

    _updateCount() {
      this.dmCountEl.textContent = '弹幕 ' + this.store.count()
    }

    /* ---------- 弹幕发送栏 ---------- */

    /** 弹幕显示开关("弹" 按钮)。 */
    _setDanmakuVisible(on) {
      this._dmVisible = !!on
      this.stage.style.opacity = on ? '1' : '0'
      this.dbNormal.classList.toggle('active', !!on)
    }

    /** 发送栏"A"样式弹窗绑定。 */
    _wireSendStyle() {
      // ★ 样式弹出面板 14 种颜色(去重、常用色+少量浅色)
      const SWATCHES = [
        { c: '#FFFFFF', n: '白' }, { c: '#FF0000', n: '红' },
        { c: '#FF9900', n: '橙' }, { c: '#FFFF00', n: '黄' },
        { c: '#00FF00', n: '绿' }, { c: '#00D9FF', n: '天蓝' },
        { c: '#0066FF', n: '蓝' }, { c: '#800080', n: '紫' },
        { c: '#FF00FF', n: '粉' }, { c: '#FF3399', n: '洋红' },
        { c: '#000000', n: '黑' }, { c: '#FFD1DC', n: '浅粉' },
        { c: '#C5E3FF', n: '浅蓝' }, { c: '#D1FFD1', n: '浅绿' },
      ]
      const seg = (root, field) => {
        root.addEventListener('click', (e) => {
          const b = e.target.closest('button')
          if (!b) return
          D.$$('button', root).forEach((x) => x.classList.toggle('active', x === b))
          this._sendStyle[field] = b.getAttribute('data-val')
        })
      }
      seg(this.dbStyleMode, 'mode')
      seg(this.dbStyleFont, 'fontSize')

      // ★ 先清空容器,避免与 HTML 残留按钮(未绑定事件)重叠造成重复&无法交互
      this.dbStyleColors.innerHTML = ''
      for (const { c, n } of SWATCHES) {
        const sw = document.createElement('button')
        sw.className = 'pn-swatch' + (c === '#FFFFFF' ? ' active' : '')
        sw.style.background = c
        sw.title = n + ' ' + c
        sw.setAttribute('data-color', c)
        sw.addEventListener('click', () => {
          D.$$('.pn-swatch', this.dbStyleColors).forEach((x) => x.classList.toggle('active', x === sw))
          this._sendStyle.color = c
          this.dbStyleColorText.value = c
          this.dbStyleColorPick.value = c
        })
        this.dbStyleColors.appendChild(sw)
      }
      this.dbStyleColorText.addEventListener('change', () => {
        const hex = global.ColorUtil.parseColor(this.dbStyleColorText.value)
        if (hex) {
          this._sendStyle.color = hex
          this.dbStyleColorPick.value = hex
        } else {
          this.dbStyleColorText.value = this._sendStyle.color
        }
      })
      this.dbStyleColorPick.addEventListener('input', () => {
        this._sendStyle.color = this.dbStyleColorPick.value.toUpperCase()
        this.dbStyleColorText.value = this._sendStyle.color
      })
      this.dbStyleColorful.addEventListener('change', () => {
        this._sendStyle.colorful = this.dbStyleColorful.checked ? 60001 : null
        // ★ 大会员色开启:锁定颜色为白色,禁用颜色选择(字号不锁定)
        this._applyColorfulLock()
      })
      // ★ UP主标识开关:开启时强制字号=标准、颜色=白色,禁用除模式外的所有开关
      if (this.dbStyleIsUp) {
        this.dbStyleIsUp.addEventListener('change', () => {
          const on = this.dbStyleIsUp.checked
          if (on) {
            this._sendStyle.fontSize = 'standard'
            this._sendStyle.color = '#FFFFFF'
            this._sendStyle.colorful = null
            this._sendStyle.isUp = true
            // 更新 UI
            D.$$('button', this.dbStyleFont).forEach((b) => b.classList.toggle('active', b.getAttribute('data-val') === 'standard'))
            D.$$('.pn-swatch', this.dbStyleColors).forEach((s) => s.classList.toggle('active', s.getAttribute('data-color') === '#FFFFFF'))
            this.dbStyleColorText.value = '#FFFFFF'
            this.dbStyleColorPick.value = '#FFFFFF'
            this.dbStyleColorful.checked = false
          } else {
            this._sendStyle.isUp = false
          }
          this._applySendStyleLock()
        })
      }
    }

    /** ★ 大会员色锁定:开启时颜色锁定白色,禁用色板/自定义;关闭时恢复。字号不锁定。*/
    _applyColorfulLock() {
      const colorful = this.dbStyleColorful && this.dbStyleColorful.checked
      const isUp = this.dbStyleIsUp && this.dbStyleIsUp.checked
      if (colorful && !isUp) {
        // 大会员色开启:强制白色,禁用颜色选择
        this._sendStyle.color = '#FFFFFF'
        this.dbStyleColorText.value = '#FFFFFF'
        this.dbStyleColorPick.value = '#FFFFFF'
        D.$$('.pn-swatch', this.dbStyleColors).forEach((s) => s.classList.toggle('active', s.getAttribute('data-color') === '#FFFFFF'))
      }
      // 颜色控件禁用状态由 _applySendStyleLock 统一管理
      this._applySendStyleLock()
    }

    /** ★ 发送样式锁定:根据 UP主标识/大会员色状态禁用对应控件。*/
    _applySendStyleLock() {
      const isUp = this.dbStyleIsUp && this.dbStyleIsUp.checked
      const colorful = this.dbStyleColorful && this.dbStyleColorful.checked
      // UP主标识:禁用字号+色板+自定义颜色+大会员色
      if (this.dbStyleFont) {
        this.dbStyleFont.style.opacity = isUp ? '0.45' : ''
        this.dbStyleFont.style.pointerEvents = isUp ? 'none' : 'auto'
      }
      // 颜色相关:UP主 或 大会员色 开启时禁用
      const colorLock = isUp || colorful
      if (this.dbStyleColors) {
        this.dbStyleColors.style.opacity = colorLock ? '0.45' : ''
        this.dbStyleColors.style.pointerEvents = colorLock ? 'none' : 'auto'
      }
      if (this.dbStyleColorText) this.dbStyleColorText.disabled = colorLock
      if (this.dbStyleColorPick) this.dbStyleColorPick.disabled = colorLock
      // 大会员色开关:UP主开启时禁用
      if (this.dbStyleColorful) {
        this.dbStyleColorful.disabled = isUp
        const label = this.dbStyleColorful.closest && this.dbStyleColorful.closest('label')
        if (label) label.style.opacity = isUp ? '0.45' : ''
      }
      // UP主标识开关:大会员色开启时不禁用(用户可自由切换)
    }

    /** 齿轮弹幕设置面板。 */
    _wireDanmakuSettings() {
      const panel = this.dbSettingsPanel
      this.dbSettings.addEventListener('click', (e) => {
        e.stopPropagation()
        this.dbSettingsPanel.hidden = !this.dbSettingsPanel.hidden
        this.dbSettings.classList.toggle('active', !this.dbSettingsPanel.hidden)
      })
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#danmaku-bar')) {
          this.dbSettingsPanel.hidden = true
          this.dbSettings.classList.remove('active')
        }
      })

      // 类型过滤(可过滤高级弹幕)
      const typeBtns = D.$$('.ds-type', panel)
      for (const b of typeBtns) {
        b.addEventListener('click', () => {
          const f = b.getAttribute('data-filter')
          b.classList.toggle('active')
          const filters = {}
          filters[f] = b.classList.contains('active')
          this.engine.setTypeFilters(filters)
        })
      }

      // 高级过滤开关
      D.$('#ds-scalew').addEventListener('change', (e) => {
        this.engine.setScaleWithScreen(e.target.checked)
      })
      D.$('#ds-blockdupes').addEventListener('change', (e) => {
        this.engine.setBlockDupes(e.target.checked)
      })
      D.$('#ds-nosub').addEventListener('change', (e) => {
        this.engine.setSubtitleAvoid(e.target.checked)
      })

      // 屏蔽词
      const blockDialog = D.$('#ds-block-dialog')
      D.$('#ds-blockwords').addEventListener('click', () => {
        blockDialog.hidden = !blockDialog.hidden
        if (!blockDialog.hidden) {
          D.$('#ds-block-text').value = (this.engine.blockedWords || []).join('\n')
        }
      })
      D.$('#ds-block-save').addEventListener('click', () => {
        const list = D.$('#ds-block-text').value.split('\n').map((w) => w.trim()).filter(Boolean)
        this.engine.setBlockedWords(list)
        blockDialog.hidden = true
        this.player.toast('已保存 ' + list.length + ' 个屏蔽词')
      })
      D.$('#ds-block-cancel').addEventListener('click', () => {
        blockDialog.hidden = true
      })
      D.$('#ds-syncblocks').addEventListener('click', () => {
  // ★ 从全局设置的屏蔽列表同步到弹幕观看屏蔽词
  const app = global.window.App
  const settings = app && app.mainSettings
  if (!settings || !Array.isArray(settings.blockWords) || !settings.blockWords.length) {
    this.player.toast('全局设置中没有屏蔽词,请先在「全局设置」中添加')
    return
  }
  // 合并去重:保留当前已有的屏蔽词,追加新词
  const existing = new Set((this.engine.blockedWords || []).map((w) => w.toLowerCase()))
  const merged = (this.engine.blockedWords || []).slice()
  let added = 0
  for (const w of settings.blockWords) {
    if (!existing.has(w.toLowerCase())) {
      merged.push(w)
      existing.add(w.toLowerCase())
      added++
    }
  }
  this.engine.setBlockedWords(merged)
  // 同步到弹幕观看屏蔽词弹窗的 textarea
  const blockText = D.$('#ds-block-text')
  if (blockText) blockText.value = merged.join('\n')
  this.player.toast('已同步 ' + added + ' 个屏蔽词(共 ' + merged.length + ' 个)')
})

      // 精细视觉调节
      const area = D.$('#ds-area')
      area.addEventListener('input', () => {
        this.engine.setAreaHeight(parseInt(area.value, 10))
        D.$('#ds-area-val').textContent = area.value + '%'
      })
      D.$('#ds-density').addEventListener('change', (e) => {
        this.engine.setDensity(e.target.value)
      })
      const op = D.$('#ds-opacity')
      op.addEventListener('input', () => {
        const v = parseFloat(op.value)
        this.engine.setGlobalStyle({ opacity: v })
        D.$('#ds-opacity-val').textContent = Math.round(v * 100) + '%'
      })
      const font = D.$('#ds-font')
      font.addEventListener('input', () => {
        const v = parseFloat(font.value)
        this.engine.setGlobalStyle({ fontScale: v })
        D.$('#ds-font-val').textContent = Math.round(v * 100) + '%'
      })
      const speed = D.$('#ds-speed')
      speed.addEventListener('input', () => {
        const v = parseFloat(speed.value)
        this.engine.setDanmakuSpeed(v)
        D.$('#ds-speed-val').textContent = v < 0.8 ? '慢' : v > 1.4 ? '快' : '适中'
      })

      // 高级设置折叠
      D.$('#ds-adv-toggle').addEventListener('click', () => {
        const body = D.$('#ds-adv-body')
        body.hidden = !body.hidden
        D.$('#ds-adv-toggle').textContent = body.hidden ? '高级设置 ›' : '高级设置 ⌄'
      })
      D.$('#ds-fontfamily').addEventListener('change', (e) => {
        this.engine.setGlobalStyle({ fontFamily: e.target.value })
      })
      const stroke = D.$('#ds-stroke')
      stroke.addEventListener('input', () => {
        this.engine.setGlobalStyle({ strokeWidth: parseFloat(stroke.value) })
        D.$('#ds-stroke-val').textContent = stroke.value
      })
    }

    /** 无视频时禁用播放方式选项。 */
    _updatePlayModeEnabled() {
      const on = !!this.player.getVideoName()
      if (this.pbPlaymode) {
        D.$$('button', this.pbPlaymode).forEach((b) => {
          b.disabled = !on
        })
      }
    }

    /** 三选一互斥按钮组。 */
    _wireRadio(root, cb) {
      const btns = D.$$('button', root)
      for (const b of btns) {
        b.addEventListener('click', () => {
          for (const x of btns) x.classList.toggle('active', x === b)
          cb(b.getAttribute('data-val'))
        })
      }
    }

    /** 弹幕文件库按钮。 */
    _wireDanmakuLibrary() {
      D.$('#dl-import').addEventListener('click', () => this._importNewDanmaku())
      D.$('#dl-close').addEventListener('click', () => {
        D.$('#danmaku-library').hidden = true
      })
      // ★ 打开本地弹幕池保存位置
      const openFolderBtn = D.$('#dl-open-folder')
      if (openFolderBtn) {
        openFolderBtn.addEventListener('click', () => {
          global.DanmakuIO.getDanmakuDir().then((dir) => {
            const p = dir && dir.path
            if (!p) {
              this.player.toast('浏览器预览模式:保存位置即浏览器下载位置')
              return
            }
            global.DanmakuIO.openPath(p).then((ok) => {
              if (!ok) this.player.toast('打开失败: ' + p)
            })
          })
        })
      }
    }

    /** ★ 创建新的空白弹幕池:
     *  - 弹确认框询问是否保存当前改动。
     *  - 选"是" → 先保存当前弹幕,再创建新空文件并打开。
     *  - 选"否" → 彻底清空当前弹幕,创建新空文件并打开。 */
    _createEmptyDanmakuPool() {
      const hasUnsaved = this.hasUnsavedChanges()
      const doCreate = () => {
        this._doCreateEmptyPool()
      }
      if (hasUnsaved) {
        // ★ 自定义弹窗: 主按钮=保存并创建, 次按钮=不保存直接创建, ×/Esc=完全取消
        global.DanmakuIO.showConfirmModal({
          title: '创建新弹幕池',
          message: '创建新弹幕池会彻底清除当前的改动,请问是否保存当前的改动?此操作不可撤销！\n\n' +
                   '  · 保存并创建 = 先保存当前弹幕,再创建新弹幕池\n' +
                   '  · 不保存直接创建 = 丢弃当前改动,直接创建新的空弹幕池\n' +
                   '  · 关闭 / Esc = 取消本次创建操作',
          primaryText: '保存并创建',
          secondaryText: '不保存直接创建'
        }).then((choice) => {
          if (choice === null) return                 // × / Esc / 遮罩 → 什么都不做
          if (choice === true) {
            // 保存并创建:等待保存完成后再创建
            Promise.resolve(this.saveDanmakuFile({ silent: true })).finally(() => doCreate())
            return
          }
          // 'secondary' = 不保存直接创建
          doCreate()
        })
      } else {
        doCreate()
      }
    }

    _doCreateEmptyPool() {
      // 清空当前弹幕池
      this.store.clear()
      this._currentLibId = null
      this._currentLibName = null
      // ★ 切换弹幕池后立即清空撤回栈,避免旧弹幕池快照占用内存
      this._clearUndoHistory()
      // 保存成功后重置"已保存基线"
      this._markBaselineSaved(null)
      this._resolveSaveTextAndLabel = null // 让下一次保存走新时间戳名
      const emptyText = JSON.stringify({ version: 1, p: { timeBase: 1000 }, comments: [] }, null, 2)
      global.DanmakuIO.saveLibraryEntry('danmaku-' + this._timestampName(), emptyText).then((entry) => {
        if (entry) {
          this._currentLibId = entry.id
          this._currentLibName = entry.name
          this._markBaselineSaved(emptyText)
          // 自动打开新创建的文件
          global.DanmakuIO.readLibraryEntry(entry.id).then((r) => {
            if (r && r.text) {
              this._importAuto(r.text, { name: r.name || entry.name, mtimeMs: Date.now(), skipDirtyPrompt: true, allowEmpty: true, onDiskText: r.text })
            }
          })
          this.player.toast('已创建新弹幕池: ' + entry.name)
          this._refreshLibrary()
        } else {
          this.player.toast('创建新弹幕池失败')
        }
      })
    }

    _sendDanmaku() {
      const text = this.dbInput.value.trim()
      if (!text) {
        this.player.toast('请输入弹幕内容')
        return
      }
      const rec = Convert.makeNormal()
      rec.content = text
      rec.sender = (global.window.App && global.window.App.settings && global.window.App.settings.defaultSender) || '我'
      rec.timeSec = round2(this.clock.now())
      rec.mode = this._sendStyle.mode
      rec.fontSize = this._sendStyle.fontSize
      rec.color = this._sendStyle.color
      if (this._sendStyle.colorful) rec.colorful = this._sendStyle.colorful
      if (this._sendStyle.isUp) rec.isUp = true
      const created = this.store.add(rec) // store.add 内部已写 ctime(若无)
      this.store.select(created.id)
      this.dbInput.value = ''
      // ★ 暂停时也立即上屏,便于编辑模式选中
      if (!this.clock.playing) {
        this.engine.seek(rec.timeSec + 0.001)
      }
      this.player.toast('已发送弹幕 @' + global.TimeUtil.fmtClockExact(rec.timeSec))
      // ★ 若处于部分展示模式(engine.showOnlyIds 非空),显示黄色警告
      const list = global.window.App && global.window.App.list
      if (list && typeof list._warnIfFilterActive === 'function') list._warnIfFilterActive()
    }

    /* ---------- 数据加载/导出 ---------- */

    _readAsText(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = reject
        reader.readAsText(file)
      })
    }

    _loadJsonText(text, name) {
      const parsed = Convert.fromEnvelope(text)
      if (parsed.error) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      if (!parsed.records.length) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      parsed.records.forEach((r) => {
        r.id = null
      })
      if (parsed.videoInfo && parsed.videoInfo.filename) {
        this.store.videoInfo = parsed.videoInfo
      }
      this.store.setComments(parsed.records)
      this.player.toast('已加载 ' + parsed.records.length + ' 条弹幕 (' + (name || '') + ')')
    }

    /** 解析导入文本:ASS/XML/JSON 自动识别,返回 { records, note, parseFailed, videoInfo }。
     *  records 为解析器原始输出(未过 toRuntime,由调用方统一归一);videoInfo 仅 JSON 信封携带。
     *  供 `_importAuto`(加载)与 `_importAndCreateLibraryEntry`(写入本地弹幕池前转 JSON)共用。 */
    _parseImportText(t) {
      const stage = { width: this.engine.width, height: this.engine.height }
      let records = null
      let note = ''
      let parseFailed = false
      let videoInfo = null
      if (!t) {
        parseFailed = true
      } else if (/^\[/.test(t) && /Dialogue\s*:/i.test(t)) {
        try {
          const res = global.DanmakuAssParser.parseAss(t, stage)
          records = res.records || []
          note = 'ASS: ' + records.length + ' 条'
        } catch (e) {
          parseFailed = true
        }
      } else if (/<i[\s>]/i.test(t) || /<d\s/i.test(t) || /<\?xml/i.test(t) || t.indexOf('<d') !== -1) {
        try {
          const res = global.DanmakuXmlParser.parseXml(t)
          records = res.records || []
          note = 'XML: ' + records.length + ' 条'
          // XML 报告 error 或无任何有效记录 => 导入失败
          if (res.error) parseFailed = true
        } catch (e) {
          parseFailed = true
        }
      } else {
        try {
          const parsed = Convert.fromEnvelope(t)
          if (!parsed.error) {
            records = parsed.records || []
            note = 'JSON: ' + records.length + ' 条'
            videoInfo = parsed.videoInfo || null
          } else {
            parseFailed = true
          }
        } catch (e) {
          parseFailed = true
        }
      }
      return { records: records, note: note, parseFailed: parseFailed, videoInfo: videoInfo }
    }

    _importAuto(text, info) {
      if (this._isLocked()) return
      // 兼容旧调用:传入字符串 name → 当名称处理,mtime 用 0
      const infoObj = info && typeof info === 'object' ? info : { name: info || '', mtimeMs: 0 }
      const t = text.trim()
      const parsed = this._parseImportText(t)
      const records = parsed.records
      const note = parsed.note
      const parseFailed = parsed.parseFailed
      if (parsed.videoInfo && parsed.videoInfo.filename) {
        this.store.videoInfo = parsed.videoInfo
      }

      // 没有任何有效 records 时 = 导入失败(红框提示),
      //  ★ info.allowEmpty=true(显式创建/打开/切换弹幕池)时:comments=0 视为合法(空弹幕池),不报错。
      const allowEmpty = !!(infoObj && infoObj.allowEmpty)
      const parsedOk = !parseFailed && Array.isArray(records)
      if (parseFailed || !parsedOk || (!allowEmpty && records.length === 0)) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      // 统一过一遍 toRuntime:施加约束(字号/透明度/坐标/字体白名单等)并归一
      const normalized = records
        .map((r) => Convert.toRuntime(r))
        .filter(Boolean)
      // ★ allowEmpty:true 时 normalized.length===0 合法(空 JSON / 所有无效条都 filter 掉)
      if (normalized.length === 0 && !allowEmpty) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      // ★ 若记录缺少 ctime(例如部分 XML / ASS) → 用文件的修改时间兜底(mtimeMs),无则不写
      const fallbackTs = Number.isFinite(infoObj.mtimeMs) && infoObj.mtimeMs > 0
        ? Math.floor(infoObj.mtimeMs)
        : 0
      if (fallbackTs > 0) {
        for (let i = 0; i < normalized.length; i++) {
          const r = normalized[i]
          if (!(Number.isFinite(r.ctime) && r.ctime > 0)) r.ctime = fallbackTs
        }
      }
      normalized.forEach((r) => {
        r.id = null
      })
      this.store.setComments(normalized)
      // ★ 替换型导入:旧撤回/重做历史作废(不再能复原成前一个弹幕池),立即清空防内存占用
      this._clearUndoHistory()
      // ★ 从磁盘文件读取打开(skipDirtyPrompt=true):成功后立刻打基线,避免打开后立即判定为有改动
      if (infoObj && infoObj.skipDirtyPrompt === true && infoObj.onDiskText != null) {
        this._markBaselineSaved(infoObj.onDiskText)
      } else {
        // 用户手动触发的导入(非关联磁盘文件) → 显式标记有改动需要保存
        this._dirtyOverride = true
      }
      this.player.toast(
        normalized.length === 0
          ? ('已加载空弹幕池' + (infoObj && infoObj.name ? ' (' + infoObj.name + ')' : ''))
          : ('导入成功 ' + note)
      )

      // ★ 导入完成后:若当前「展示中的弹幕量」> 8000,弹窗询问用户是否进入「当前弹幕池」管理
      setTimeout(() => {
        const list = global.window.App && global.window.App.list
        if (!list) return
        const showing = list.getShowingRecs ? list.getShowingRecs() : list._filteredAndRanged()
        if (showing.length > 8000 && typeof list.openPoolOverview === 'function') {
          global.DanmakuIO.confirmDialog(
            '当前弹幕数量太多！直接运行可能会导致程序卡顿。\n是否需要进入「当前弹幕池」管理弹幕？\n\n（点击「确定」进入管理,「取消」直接浏览当前全部弹幕）'
          ).then((ok) => { if (ok) list.openPoolOverview() })
        }
      }, 50)
    }

    /** ★ 合并导入(「加入其他弹幕」用):JSON/XML/ASS 解析后追加(不替换)到当前弹幕池。
     *  ★ 当存在参数完全一致(普通/高级分别按 store.appendMany 的 fingerprint)的弹幕时:
     *     - 弹窗让用户选择「全部导入(包括相同内容)」或「只导入不同弹幕」
     *     - Toast 追加 " 其中参数完全相同的弹幕有 N 个"；若导入 0 条且有相同弹幕再追加 " 相同弹幕并未导入"。*/
    _mergeImportText(text, info) {
      if (this._isLocked()) return
      const infoObj = info && typeof info === 'object' ? info : { name: info || '', mtimeMs: 0 }
      const t = text.trim()
      let records = null
      let note = ''
      let parseFailed = false

      if (!t) {
        parseFailed = true
      } else if (/^\[/.test(t) && /Dialogue\s*:/i.test(t)) {
        const stage = { width: this.engine.width, height: this.engine.height }
        try {
          const res = global.DanmakuAssParser.parseAss(t, stage)
          records = res.records || []
          note = 'ASS: ' + records.length + ' 条'
        } catch (e) {
          parseFailed = true
        }
      } else if (/<i[\s>]/i.test(t) || /<d\s/i.test(t) || /<\?xml/i.test(t) || t.indexOf('<d') !== -1) {
        try {
          const res = global.DanmakuXmlParser.parseXml(t)
          records = res.records || []
          note = 'XML: ' + records.length + ' 条'
          if (res.error) parseFailed = true
        } catch (e) {
          parseFailed = true
        }
      } else {
        try {
          const parsed = Convert.fromEnvelope(t)
          if (!parsed.error) {
            records = parsed.records || []
            note = 'JSON: ' + records.length + ' 条'
            if (parsed.videoInfo && parsed.videoInfo.filename && !this.store.videoInfo) {
              this.store.videoInfo = parsed.videoInfo
            }
          } else {
            parseFailed = true
          }
        } catch (e) {
          parseFailed = true
        }
      }

      if (parseFailed || !records || records.length === 0) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      const normalized = records
        .map((r) => Convert.toRuntime(r))
        .filter(Boolean)
      if (normalized.length === 0) {
        this.player.toast(
          '导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！',
          { error: true }
        )
        return
      }
      // ★ 若缺少 ctime → 文件修改时间兜底
      const fallbackTs = Number.isFinite(infoObj.mtimeMs) && infoObj.mtimeMs > 0
        ? Math.floor(infoObj.mtimeMs)
        : 0
      if (fallbackTs > 0) {
        for (let i = 0; i < normalized.length; i++) {
          const r = normalized[i]
          if (!(Number.isFinite(r.ctime) && r.ctime > 0)) r.ctime = fallbackTs
        }
      }
      const self = this
      const before = this.store.count()
      // ★ 先 dry-run(不修改 comments)统计参数完全一致的弹幕数量 → 用户选择后再真正执行 appendMany
      const sameCount = this._countSameRecords(normalized)
      const runImport = (skipSame) => {
        const result = self.store.appendMany(normalized, skipSame ? { skipSame: true } : {})
        const added = result.added || 0
        const sameN = (typeof result.sameCount === 'number') ? result.sameCount : sameCount
        let msg
        if (added > 0) {
          msg = '已追加 ' + added + ' 条(合并 ' + note + ') 其中参数完全相同的弹幕有 ' + sameN + ' 个'
          if (added === 0 && sameN > 0) msg += ' 相同弹幕并未导入'
        } else {
          msg = '合并导入失败或未导入任何新弹幕(共解析 ' + normalized.length + ' 条,相同 ' + sameN + ' 个)'
          if (sameN > 0) msg += ' 相同弹幕并未导入'
        }
        self.player.toast(msg)
        const list = global.window.App && global.window.App.list
        if (list && typeof list.refreshPoolList === 'function') list.refreshPoolList()
        // ★ 若处于部分展示模式,显示黄色警告
        if (list && typeof list._warnIfFilterActive === 'function') list._warnIfFilterActive()
        if (added > 8000 && before + added > 8000) {
          const showing = list.getShowingRecs ? list.getShowingRecs() : list._filteredAndRanged()
          if (showing.length > 8000 && typeof list.openPoolOverview === 'function') list.openPoolOverview()
        }
      }
      // 没有完全相同的 → 直接导入
      if (sameCount <= 0) { runImport(false); return }
      // ★ 有相同:弹窗询问(如果浏览器没有 confirm API,就默认只导入不同)
      const msg = '检测到参数完全一致的弹幕 ' + sameCount + ' 条。\n\n选择「是」= 只导入不同弹幕(跳过相同内容);选择「否」= 全部导入(包括相同内容)。'
      let skipSame = true
      try {
        // 如果有 App.confirm 则用自定义弹窗,否则回退 window.confirm
        const app = global.window.App
        if (app && typeof app.confirm === 'function') {
          app.confirm(msg, { yesText: '仅导入不同', noText: '全部导入(含相同)', defaultNo: true })
            .then((ok) => { runImport(!!ok) })
            .catch(() => { runImport(true) })
          return
        } else if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const ok = window.confirm(msg + '\n\n(点击「确定」=仅导入不同;「取消」=全部导入)')
          skipSame = !!ok
        } else {
          skipSame = true
        }
      } catch (_) { skipSame = true }
      runImport(skipSame)
    }

    /** ★ dry-run 计算与现有弹幕"参数完全一致"的条数(与 store.appendMany 同 fingerprint 规则):
     *  - 普通:content + timeSec(四舍五入到 10ms) + mode + fontSize + color + isUp
     *  - 高级:content + style(color/fontSize/fontFamilyRaw/stroke) + life.duration + position(usePercent/4值) + rotation(z/y)。
     *  仅用于统计,不修改 comments。*/
    _countSameRecords(incoming) {
      if (!Array.isArray(incoming) || !incoming.length) return 0
      const store = this.store
      // 正规化现有 & 输入 timeSec
      const existing = store.comments || []
      for (let j = 0; j < existing.length; j++) store._ensureTimeSec(existing[j])
      const normIn = incoming.map((r) => { const rr = Object.assign({}, r); store._ensureTimeSec(rr); return rr })
      const fpOf = (rec) => {
        if (!rec) return ''
        const adv = (rec.type === 'advanced')
        if (adv) {
          const s = rec.style || {}, p = rec.position || {}, ro = rec.rotation || {}, l = rec.life || {}
          return 'A|c:' + String(rec.content || '') +
            '|co:' + String(s.color || '') + '|fs:' + (s.fontSize != null ? s.fontSize : '') +
            '|ff:' + String(s.fontFamilyRaw || s.fontFamily || '') + '|st:' + (s.stroke ? 1 : 0) +
            '|ld:' + (l.duration != null ? l.duration : '') +
            '|up:' + (p.usePercent ? 1 : 0) +
            '|sx:' + (p.startX != null ? p.startX : '') + '|sy:' + (p.startY != null ? p.startY : '') +
            '|ex:' + (p.endX != null ? p.endX : '') + '|ey:' + (p.endY != null ? p.endY : '') +
            '|rz:' + (ro.z != null ? ro.z : '') + '|ry:' + (ro.y != null ? ro.y : '')
        } else {
          return 'N|c:' + String(rec.content || '') +
            '|t:' + (typeof rec.timeSec === 'number' ? Math.round(rec.timeSec * 100) / 100 : '') +
            '|m:' + String(rec.mode || 'scroll') +
            '|fs:' + String(rec.fontSize != null ? rec.fontSize : '') +
            '|co:' + String(rec.color || '') + '|up:' + (rec.isUp ? 1 : 0)
        }
      }
      const set = new Set(existing.map(fpOf))
      let same = 0
      for (let i = 0; i < normIn.length; i++) {
        const fp = fpOf(normIn[i])
        if (fp && set.has(fp)) same++
      }
      return same
    }

    /** 打开一个三选项的格式选择模态,由用户点击后执行对应导出。 */
    _showExportModal() {
      const self = this
      const modalId = 'export-format-modal'
      if (document.getElementById(modalId)) return
      const wrap = document.createElement('div')
      wrap.id = modalId
      wrap.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;'
      const box = document.createElement('div')
      box.style.cssText =
        'background:#fff;color:#1e1e1e;border-radius:12px;box-shadow:0 16px 60px rgba(0,0,0,0.35);width:min(520px,96vw);overflow:hidden;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;'
      const head = document.createElement('div')
      head.style.cssText =
        'padding:18px 22px 10px;border-bottom:1px solid #eef0f4;display:flex;align-items:center;justify-content:space-between;'
      const title = document.createElement('div')
      title.style.cssText = 'font-size:16px;font-weight:600;letter-spacing:0.3px;'
      title.textContent = '选择导出格式'
      const close = document.createElement('button')
      close.textContent = '✕'
      close.style.cssText =
        'border:0;background:transparent;color:#6a6f7a;cursor:pointer;font-size:16px;width:28px;height:28px;border-radius:6px;'
      close.onmouseenter = () => (close.style.background = '#f2f3f7')
      close.onmouseleave = () => (close.style.background = 'transparent')
      close.onclick = destroy
      head.appendChild(title); head.appendChild(close)
      const body = document.createElement('div')
      body.style.cssText = 'padding:14px 18px 6px;'
      const items = [
        {
          key: 'xml',
          name: '导出为 XML',
          desc: '高级弹幕设计首选',
          ext: '.xml',
          hint: '完整保留m7弹幕多项参数，兼容性强，可在弹幕场进行发送',
        },
        {
          key: 'json',
          name: '导出为 JSON',
          desc: '仅适合本程序使用',
          ext: '.json',
          hint: '支持记录普通弹幕的多项状态，包括大会员、UP主标识等属性',
        },
        {
          key: 'ass',
          name: '导出为 ASS',
          desc: '适合某些特殊播放器使用',
          ext: '.ass',
          hint: '其实我也不知道这到底是干嘛用的。。？',
        },
      ]
      for (const it of items) {
        const row = document.createElement('button')
        row.type = 'button'
        row.dataset.key = it.key
        row.style.cssText =
          'display:block;width:100%;text-align:left;margin-bottom:10px;padding:12px 14px;border:1px solid #e4e7ef;border-radius:10px;background:#fafbfd;cursor:pointer;transition:all .12s ease;'
        row.onmouseenter = () => {
          row.style.background = '#eef4ff'
          row.style.borderColor = '#4a8cff'
          row.style.transform = 'translateY(-1px)'
        }
        row.onmouseleave = () => {
          row.style.background = '#fafbfd'
          row.style.borderColor = '#e4e7ef'
          row.style.transform = 'translateY(0)'
        }
        const line1 = document.createElement('div')
        line1.style.cssText = 'display:flex;align-items:baseline;gap:10px;'
        const big = document.createElement('span')
        big.style.cssText = 'font-size:15px;font-weight:600;color:#1e1e1e;'
        big.textContent = it.name
        const desc = document.createElement('span')
        desc.style.cssText = 'color:#4a8cff;font-size:12px;'
        desc.textContent = it.desc
        line1.appendChild(big); line1.appendChild(desc)
        const line2 = document.createElement('div')
        line2.style.cssText = 'margin-top:4px;color:#6a6f7a;font-size:12px;line-height:1.5;'
        line2.textContent = it.hint
        row.appendChild(line1); row.appendChild(line2)
        row.addEventListener('click', () => self._runExport(it.key).then(destroy))
        body.appendChild(row)
      }
      box.appendChild(head); box.appendChild(body)
      wrap.appendChild(box)
      wrap.addEventListener('click', (e) => { if (e.target === wrap) destroy() })
      document.body.appendChild(wrap)
      function destroy() {
        const el = document.getElementById(modalId)
        if (el) try { el.remove() } catch (e) { el.parentNode && el.parentNode.removeChild(el) }
      }
    }

    _runExport(key) {
      const store = this.store
      const base = (this.player.getVideoName() || 'danmaku').replace(/\.[^/.]+$/, '')
      return global.DanmakuIO.getDanmakuDir().then((dir) => {
        const opts = { defaultDir: (dir && dir.path) || '' }
        void opts
        if (key === 'json') return global.DanmakuIO.saveAsJson(store, null, base).then((ok) => ok && this.player.toast('已成功导出 JSON'))
        if (key === 'xml') return global.DanmakuIO.saveAsXml(store, null, base).then((ok) => ok && this.player.toast('已成功导出 XML'))
        if (key === 'ass') return global.DanmakuIO.saveAsAss(store, null, base).then((ok) => ok && this.player.toast('已成功导出 ASS'))
        return Promise.resolve(false)
      })
    }

    _exportJson() {
      if (!this.store.count()) {
        this.player.toast('没有可导出的弹幕')
        return
      }
      this._runExport('json')
    }

    _isLocked() {
      if (this.editor && this.editor.overlay && this.editor.overlay.isLocked()) {
        this.player.toast('当前弹幕已锁定,请先解除锁定再导入')
        return true
      }
      return false
    }

    /** 判断文件是否为图片(按扩展名/type)。 */
    _isImageFile(f) {
      const name = (f.name || '').toLowerCase()
      const type = f.type || ''
      if (type.indexOf('image/') === 0) return true
      return /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)$/.test(name)
    }

    /** 判断文件是否为音频(按扩展名/type)。 */
    _isAudioFile(f) {
      const name = (f.name || '').toLowerCase()
      const type = f.type || ''
      if (type.indexOf('audio/') === 0) return true
      return /\.(mp3|wav|flac|ogg|m4a|aac|opus|wma)$/.test(name)
    }

    /** 根据当前媒体类型更新右下角"关闭视频/图片/音乐"按钮的显隐和文本。 */
    _updateCloseMediaBtn() {
      const btn = this.pbCloseVideo
      if (!btn) return
      if (this.player.mediaType === 'video') {
        btn.textContent = '✕ 关闭视频'
        btn.title = '关闭当前视频'
        btn.hidden = false
      } else if (this.player.mediaType === 'image') {
        btn.textContent = '✕ 关闭图片'
        btn.title = '关闭当前图片'
        btn.hidden = false
      } else if (this.player.mediaType === 'audio') {
        btn.textContent = '✕ 关闭音乐'
        btn.title = '关闭当前音乐'
        btn.hidden = false
      } else {
        btn.hidden = true
      }
      // 关闭媒体时同步清除隐藏状态
      if (!this.player.mediaType && this.btnHideMedia) {
        this.btnHideMedia.classList.remove('active')
      }
    }

    /** 弹幕列表空态/「打开弹幕」入口:导入(自动识别类型)。
     *  ★ 若当前弹幕池有未保存改动,先弹"保存/不保存/取消"三态弹窗确认后再替换。 */
    openDanmakuDialog() {
      if (this._isLocked()) return
      // 先判断是否有脏数据:有 → 弹保存提示;用户同意后再打开文件选择器
      const start = () => {
        this.fileDialog.open('导入弹幕(JSON/XML/ASS)', '.json,.xml,.ass,.ssa', (f) =>
          this._readAsText(f).then((text) =>
            this._importAuto(text, { name: f.name, mtimeMs: f.lastModified || 0, allowEmpty: true })
          )
        )
      }
      if (this.hasUnsavedChanges()) {
        this._promptSaveBeforeReplace('import').then((choice) => {
          if (choice === null) return
          if (choice === true) {
            Promise.resolve(this.saveDanmakuFile({ silent: true })).finally(() => start())
            return
          }
          start()
        })
      } else {
        start()
      }
    }

    /**
     * ★ 启动时按以下顺序加载弹幕池(都失败则列表空白):
     *   1. 优先读「start.json」(本地弹幕池保存位置下);
     *   2. 没有 start.json / start.json 为空 → 加载修改时间最近的一个弹幕池文件;
     *   3. 本地弹幕池没有任何文件 → 不加载任何弹幕,列表空白。
     *
     *  打开成功后打基线 & 清空撤回栈(防止 Ctrl+Z 回退到空或旧弹幕池,占用内存)。 */
    loadStartDanmaku() {
      const io = global.DanmakuIO
      if (!io) return

      const applyText = (text, info) => {
        try {
          const parsed = Convert.fromEnvelope(text)
          if (parsed.error || !parsed.records || !parsed.records.length) return false
          const normalized = parsed.records
            .map((r) => Convert.toRuntime(r))
            .filter(Boolean)
          if (!normalized.length) return false
          normalized.forEach((r) => { r.id = null })
          if (parsed.videoInfo && parsed.videoInfo.filename) {
            this.store.videoInfo = parsed.videoInfo
          }
          this.store.setComments(normalized)
          // 打开成功后:打基线(=内容已与磁盘文件同步) & 清空撤回栈
          this._markBaselineSaved(text)
          if (info && info.libId) {
            this._currentLibId = info.libId
            this._currentLibName = info.name || null
          }
          this._clearUndoHistory()
          return true
        } catch (_) {
          return false
        }
      }

      const step1Start = (entries) =>
        new Promise((resolve) => {
          // 1) start.json 优先
          if (io.ensureStartDanmaku) {
            io.ensureStartDanmaku().then((res) => {
              if (res && res.text && applyText(res.text, { libId: res.path, name: 'start.json' })) {
                resolve(true)
                return
              }
              // start.json 为空模板(comments=[])→ 走最近修改
              resolve('fallback')
            }).catch(() => resolve('fallback'))
          } else {
            // 浏览器模式:fetch 同目录 start.json
            fetch('start.json').then((r) => (r.ok ? r.text() : null)).then((text) => {
              if (text && applyText(text, { name: 'start.json' })) resolve(true)
              else resolve('fallback')
            }).catch(() => resolve('fallback'))
          }
        })

      const step2MostRecent = (entries) =>
        new Promise((resolve) => {
          // entries:按 mtime 从新到旧;跳过 start.json(已尝试过),取第一个有效
          if (!entries || !entries.length) { resolve(false); return }
          const rest = entries.filter((e) => !/^start\.json$/i.test(String(e.name || '')))
          if (!rest.length) { resolve(false); return }
          // 2) 顺序尝试直到成功导入
          let idx = 0
          const tryNext = () => {
            if (idx >= rest.length) { resolve(false); return }
            const e = rest[idx++]
            if (!io.readLibraryEntry) { tryNext(); return }
            io.readLibraryEntry(e.id).then((r) => {
              if (r && r.text && applyText(r.text, { libId: e.id, name: e.name })) resolve(true)
              else tryNext()
            }).catch(() => tryNext())
          }
          tryNext()
        })

      // ★ 全局设置「程序启动时自动打开最近改动」:开启时跳过 start.json,直接打开最近改动的弹幕文件
      const autoOpenRecent = !!(global.window.App && global.window.App.mainSettings && global.window.App.mainSettings.autoOpenRecent)

      // 先拿 entries(浏览器模式 fallback=[]) → 默认 step1(start.json)→ 如返回 'fallback' 走 step2(最近改动);
      // autoOpenRecent 开启时直接 step2,不再尝试 start.json
      const pEntries = io.listLibraryEntries
        ? io.listLibraryEntries().then((r) => (r && r.entries) || [])
        : Promise.resolve([])

      pEntries.then((entries) => {
        if (autoOpenRecent) return step2MostRecent(entries)
        return step1Start(entries).then((r) => {
          if (r === true) return true
          return step2MostRecent(entries)
        })
      }).then((applied) => {
        // 3) 任何失败都静默结束:列表空白,不提示
        if (!applied) {
          // 仍设置基线:空池 = 无改动
          this._markBaselineSaved(null)
          this._currentLibId = null
          this._currentLibName = null
          this._clearUndoHistory()
        }
      }).catch(() => {
        try {
          this._markBaselineSaved(null)
          this._clearUndoHistory()
        } catch (_) {}
      })
    }

    /* ---------- 弹幕文件库 ---------- */

    _openDanmakuLibrary() {
      if (this._isLocked()) return
      const root = D.$('#danmaku-library')
      if (root.hidden) {
        root.hidden = false
        this._refreshLibrary()
      } else {
        root.hidden = true
      }
    }

    _refreshLibrary() {
      const list = D.$('#dl-list')
      list.innerHTML = '<div class="dl-empty">加载中…</div>'
      global.DanmakuIO.listLibraryEntries().then((res) => {
        list.innerHTML = ''
        const entries = (res.entries || []).slice().sort(function (a, b) {
          return (b.modifiedAt || 0) - (a.modifiedAt || 0)
        })
        if (!entries.length) {
          list.innerHTML = '<div class="dl-empty">(空)点击下方「导入新弹幕」添加弹幕池</div>'
          return
        }
        for (const e of entries) {
          const item = document.createElement('div')
          item.className = 'dl-item' + (String(e.id) === String(this._currentLibId || '') ? ' dl-item-current' : '')
          // ★ 正在编辑的弹幕文件 = 当前 _currentLibId,加高亮背景 #392630(CSS 中控制色值)
          const fmtTime = function (ts) {
            const d = new Date(ts || 0)
            const p = function (v) { return String(v).padStart(2, '0') }
            return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
          }
          const nameSpan = document.createElement('span')
          nameSpan.className = 'dl-col-name'
          nameSpan.textContent = e.name
          nameSpan.title = e.path || e.name
          item.appendChild(nameSpan)
          const timeSpan = document.createElement('span')
          timeSpan.className = 'dl-col-time'
          timeSpan.textContent = fmtTime(e.modifiedAt)
          item.appendChild(timeSpan)
          const countSpan = document.createElement('span')
          countSpan.className = 'dl-col-count'
          countSpan.textContent = e.count
          item.appendChild(countSpan)
          const fmtSpan = document.createElement('span')
          fmtSpan.className = 'dl-col-format'
          fmtSpan.textContent = e.format
          item.appendChild(fmtSpan)
          const actSpan = document.createElement('span')
          actSpan.className = 'dl-col-actions'
          const delBtn = document.createElement('button')
          delBtn.className = 'dl-del-btn'
          delBtn.textContent = '✕'
          delBtn.title = '删除'
          actSpan.appendChild(delBtn)
          item.appendChild(actSpan)
          // 点击行 = 打开(有未保存改动先弹三态提示)
          item.addEventListener('click', () => {
            // ★ 点击的正是当前正在编辑的弹幕文件:不重复打开
            //(避免 readLibraryEntry 用磁盘内容覆盖未保存改动、且重置 _currentLibId)
            if (String(this._currentLibId || '') === String(e.id)) {
              D.$('#danmaku-library').hidden = true
              return
            }
            const doOpen = () => {
              global.DanmakuIO.readLibraryEntry(e.id).then((r) => {
                if (r && r.text) {
                  this._currentLibId = e.id
                  this._currentLibName = e.name
                  this._importAuto(r.text, {
                    name: r.name || e.name,
                    mtimeMs: e.modifiedAt || 0,
                    skipDirtyPrompt: true,
                    onDiskText: r.text, // ★ 打开成功后用磁盘原始文本打脏基线
                    allowEmpty: true,
                  })
                  D.$('#danmaku-library').hidden = true
                } else {
                  this.player.toast('读取失败: ' + e.name)
                }
              })
            }
            // 切换前:有改动就三态提示(样式同替换导入弹窗)
            if (this.hasUnsavedChanges()) {
              this._promptSaveBeforeReplace('switch').then((choice) => {
                if (choice === null) return // × / Esc → 取消打开
                if (choice === true) {
                  Promise.resolve(this.saveDanmakuFile({ silent: true })).finally(() => doOpen())
                  return
                }
                // 'secondary' 不保存直接打开
                doOpen()
              })
            } else {
              doOpen()
            }
          })
          // 删除按钮
          delBtn.addEventListener('click', (ev) => {
            ev.stopPropagation()
            global.DanmakuIO.confirmDialog('确定删除「' + e.name + '」?').then((ok) => {
              if (!ok) return
              global.DanmakuIO.deleteLibraryEntry(e.id).then((r) => {
                if (r && r.ok) {
                  this.player.toast('已删除: ' + e.name)
                  if (this._currentLibId === e.id) {
                    this._currentLibId = null
                    this._currentLibName = null
                  }
                  this._refreshLibrary()
                } else {
                  this.player.toast('删除失败: ' + (r ? r.error : e.name))
                }
              })
            })
          })
          list.appendChild(item)
        }
      })
    }

    /** ★ 导入前统一保存确认:有未保存改动时弹三态(保存并导入 / 不保存直接导入 / 取消)。
     *  与【当前弹幕池】的「加入其他弹幕」(_mergeImportText)互不影响。 */
    _promptImportGate(run) {
      if (this.hasUnsavedChanges()) {
        this._promptSaveBeforeReplace('importNew').then((choice) => {
          if (choice === null) return
          if (choice === true) {
            Promise.resolve(this.saveDanmakuFile({ silent: true })).finally(() => run())
            return
          }
          run()
        })
      } else {
        run()
      }
    }

    /** ★ 共享:把外部文件解析并「转换为 JSON」后保存为「本地弹幕池」新条目 → 自动加载并打开。
     *  - file: { name, text }(调用侧已完成读取)
     *  - 有未保存改动时,调用侧应先经 `_promptImportGate` 弹保存确认。
     *  - 无论源是 XML/ASS/JSON,写入本地弹幕池的文件一律是转换后的 JSON(途中经 _parseImportText + toRuntime 归一)。
     *  - 与【当前弹幕池】的「加入其他弹幕」(_mergeImportText)互不影响。 */
    _importAndCreateLibraryEntry(file) {
      if (!file || !file.text) return
      const name = file.name || '未命名.json'
      const parsed = this._parseImportText(file.text.trim())
      // 解析失败 / 无有效弹幕 → 不创建空文件,红框报错返回
      if (parsed.parseFailed || !parsed.records || parsed.records.length === 0) {
        this.player.toast('导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！', { error: true })
        return
      }
      // ★ 统一过 toRuntime 归一(施加字号/透明度/坐标/字体等约束)再序列化为 JSON
      const normalized = parsed.records
        .map((r) => Convert.toRuntime(r))
        .filter(Boolean)
      if (!normalized.length) {
        this.player.toast('导入失败：你导入的文件可能没有弹幕代码，请检查内容或编码格式！', { error: true })
        return
      }
      normalized.forEach((r) => { r.id = null })
      const jsonText = global.DanmakuSerialize.buildExportJson(this.store, normalized)
      global.DanmakuIO.saveLibraryEntry(name, jsonText).then((entry) => {
        this.player.toast('已导入: ' + name)
        if (entry) {
          this._currentLibId = entry.id
          this._currentLibName = entry.name
          // ★ 保存入库成功,此时文件内容 = 转换后的 JSON,直接以此打基线 & 清空撤回(不允许撤回到导入前的旧弹幕池)
          this._markBaselineSaved(jsonText)
          this._clearUndoHistory()
        }
        this._importAuto(jsonText, { name: name, mtimeMs: Date.now(), skipDirtyPrompt: true, onDiskText: jsonText, allowEmpty: true })
      })
    }

    /** ★ 导入新弹幕(本地弹幕池):选择文件 → 保存到本地弹幕池 → 自动加载到编辑器。
     *  ★ 有未保存改动时,先弹三态保存确认,再执行导入。 */
    _importNewDanmaku() {
      this._promptImportGate(() => {
        global.DanmakuIO.readFile('.json,application/json,.xml,text/xml,.ass', '导入弹幕到本地弹幕池').then((file) => {
          if (!file || !file.text) return
          this._importAndCreateLibraryEntry(file)
          D.$('#danmaku-library').hidden = true
          this._refreshLibrary()
        })
      })
    }

    /** 按时间命名弹幕文件:danmaku-YYYYMMDD-HHmmss.json */
    _timestampName() {
      const d = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      return (
        'danmaku-' +
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds()) +
        '.json'
      )
    }

    /* ===== 脏状态追踪 + 撤回清空 辅助(用于切换/创建/导入/关闭前的改动判断) ===== */

    /** 清空撤回栈(切换/创建/替换型导入后立即调用,避免旧弹幕池快照占用内存)。 */
    _clearUndoHistory() {
      if (global.window.App && global.window.App.undo && typeof global.window.App.undo.clear === 'function') {
        global.window.App.undo.clear()
      }
    }

    /** 获取当前弹幕池的"全量 JSON 序列化文本"(用于保存基线比对)。 */
    _serializeCurrentAll() {
      try {
        return global.DanmakuSerialize.buildExportJson(this.store) || ''
      } catch (_) {
        return ''
      }
    }

    /** 标记基线:保存成功 / 成功从磁盘打开文件时调用。
     *  @param {string|null} text 已写磁盘的 JSON 文本;传 null 表示"显式当作无改动"(例如空池创建完成)。*/
    _markBaselineSaved(text) {
      if (text == null) {
        // 空场景:以当前序列化结果作为基线;若 store 也空则后续任何新增都会产生改动
        const cur = this._serializeCurrentAll()
        this._savedBaseline = cur
        this._dirtyOverride = this.store.count() === 0 ? false : null
      } else {
        // ★ 统一以「当前运行时序列化」作为基线,而非磁盘原始文本:
        //   打开/加载文件时 store 会重新生成 id、归一化 time 精度、补 isUp 默认值、video 等字段,
        //   若直接拿磁盘文本当基线,刚打开就会被误判为「有改动」→ 无改动也弹保存提示。
        //   保存成功或从磁盘打开时,store 内容即磁盘内容的语义等价物,以此打基线保证脏检测准确。
        this._savedBaseline = this._serializeCurrentAll()
        this._dirtyOverride = null // 清除强制覆盖,回到比较模式
      }
    }

    /** 当前弹幕池是否有未保存改动。
     *  判定优先级:1) `_dirtyOverride` 显式 boolean; 2) 空基线+空池=false;
     *   3) 规范化对象比较(仅比较 version/comments/video 三个语义字段,忽略 start.json 额外的 p、_ 等字段,避免格式差异误判脏)。*/
    hasUnsavedChanges() {
      if (typeof this._dirtyOverride === 'boolean') return this._dirtyOverride
      try {
        const cur = this._serializeCurrentAll()
        if (!this._savedBaseline && !cur) return false
        if (!this._savedBaseline) return true
        const normObj = function (s) {
          try {
            let txt = String(s == null ? '' : s)
            if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1) // 剥 UTF-16/UTF-8 BOM 代理项(\uFEFF)
            const o = JSON.parse(txt)
            if (!o || typeof o !== 'object') return null
            return {
              version: o.version != null ? o.version : null,
              comments: Array.isArray(o.comments) ? o.comments :
                (o.p && Array.isArray(o.p.comments)) ? o.p.comments : (Array.isArray(o) ? o : []),
              video: o.video && typeof o.video === 'object' ? o.video : null,
            }
          } catch (_) { return null }
        }
        const L = normObj(this._savedBaseline)
        const R = normObj(cur)
        if (L == null || R == null) {
          // 兜底:去全部空白字符串比较
          return String(this._savedBaseline || '').replace(/\s+/g, '') !== String(cur || '').replace(/\s+/g, '')
        }
        return JSON.stringify(L) !== JSON.stringify(R)
      } catch (_) {
        const cur = this._serializeCurrentAll()
        if (!this._savedBaseline && !cur) return false
        if (!this._savedBaseline) return true
        const norm = (s) => String(s || '').replace(/\s+/g, '')
        return norm(this._savedBaseline) !== norm(cur)
      }
    }

    /** ★ 刷新弹幕列表「保存」按钮的已保存/未保存状态:
     *  与磁盘一致(hasUnsavedChanges=false)→ 显示「已保存」+ saved 样式;有改动 → 恢复「保存」。 */
    _refreshSaveState() {
      if (!this._saveStateBtn) {
        this._saveStateBtn = (global.DomUtil && global.DomUtil.$) ? global.DomUtil.$('#list-save') : null
      }
      const btn = this._saveStateBtn
      if (!btn) return
      const clean = !this.hasUnsavedChanges()
      btn.classList.toggle('saved', clean)
      btn.textContent = clean ? '已保存' : '保存'
      btn.title = clean ? '当前改动已保存到文件' : '保存弹幕文件'
    }

    /** 防抖版刷新:store 改动事件高频(逐字段/逐条),聚合到静默后再刷新,避免大池逐次全量序列化。 */
    _scheduleSaveStateRefresh() {
      if (this._saveStateTimer) clearTimeout(this._saveStateTimer)
      this._saveStateTimer = setTimeout(() => {
        this._saveStateTimer = null
        try { this._refreshSaveState() } catch (_) {}
      }, 120)
    }

    /** ★ 自动写盘(开启「自动保存」时):编辑已有弹幕后,延迟约 800ms 静默写盘到关联文件。
     *  - 仅在已关联本地弹幕池文件(_currentLibId 有值)时执行,避免弹出保存对话框。
     *  - 无改动 / 未开启自动保存 / 仅草稿编辑时直接跳过。写盘成功后基线 & 保存按钮状态自动更新。 */
    _scheduleAutoSave() {
      if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null }
      const app = global.window.App
      const settings = app && app.mainSettings
      if (!settings || !settings.autoSave) return
      if (!this._currentLibId) return
      // ★ 只设防抖计时器;hasUnsavedChanges(全量序列化)留到触发时再判,避免逐事件全量比对拖慢输入
      this._autoSaveTimer = setTimeout(() => {
        this._autoSaveTimer = null
        try {
          if (!this.hasUnsavedChanges()) return
          this.saveDanmakuFile({ silent: true })
        } catch (_) {}
      }, 800)
    }

    /** 三态确认弹窗:保存前 / 替换导入 / 切换弹幕池 复用。
     * @param {'create'|'import'|'importNew'|'switch'|'quit'} mode
     *   - 'import'   :空态「打开弹幕」原地替换当前池。
     *   - 'importNew':工具栏「导入弹幕」/本地弹幕池「导入新弹幕」——在本地弹幕池新建 JSON 文件并打开(不是替换当前池)。
     * @returns {Promise<true | 'secondary' | null>} true=保存后执行 / 'secondary'=直接执行(不保存) / null=取消
     */
    _promptSaveBeforeReplace(mode) {
      let title = '未保存的改动'
      let primaryText = '保存并继续'
      let secondaryText = '不保存继续'
      let subject = '弹幕池'
      switch (mode) {
        case 'create':
          title = '创建新弹幕池'
          subject = '新弹幕池'
          primaryText = '保存并创建'
          secondaryText = '不保存直接创建'
          break
        case 'import':
          title = '导入弹幕(替换)'
          subject = '导入弹幕'
          primaryText = '保存并导入'
          secondaryText = '不保存直接导入'
          break
        case 'importNew':
          title = '导入弹幕'
          subject = '导入弹幕'
          primaryText = '保存并导入'
          secondaryText = '不保存直接导入'
          break
        case 'switch':
          title = '打开其他弹幕池'
          subject = '切换弹幕池'
          primaryText = '保存并打开'
          secondaryText = '不保存直接打开'
          break
        case 'quit':
          title = '退出程序'
          subject = '退出程序'
          primaryText = '保存并退出'
          secondaryText = '不保存直接退出'
          break
      }
      const leadIn = (mode === 'quit')
        ? '您有未保存的改动,请问是否保存后退出程序?此操作不可撤销！\n\n'
        : (mode === 'importNew')
            ? '导入会将弹幕内容(源文件若为 XML/ASS 将自动转换为 JSON)保存为本地弹幕池的新文件并打开,请问是否保存当前的改动?此操作不可撤销！\n\n'
            : (mode === 'import')
                ? '导入弹幕会替换掉当前编辑的弹幕池内容,请问是否保存当前的改动?此操作不可撤销！\n\n'
                : (mode === 'switch')
                    ? '切换弹幕池会彻底清除当前的改动,请问是否保存当前的改动?此操作不可撤销！\n\n'
                    : '创建新弹幕池会彻底清除当前的改动,请问是否保存当前的改动?此操作不可撤销！\n\n'
      const message =
        leadIn +
        '  · ' + primaryText + ' = 先保存当前弹幕,再继续' + subject + '\n' +
        '  · ' + secondaryText + ' = 丢弃当前改动,直接继续\n' +
        '  · 关闭 / Esc = 取消本次操作'
      return global.DanmakuIO.showConfirmModal({
        title: title,
        message: message,
        primaryText: primaryText,
        secondaryText: secondaryText,
      })
    }

    /** ★ 生成保存用 JSON 文本(带范围询问):
     *  - 如果「展示中弹幕数 < 弹幕池总数」,弹窗询问用户保存「展示中」还是「所有」。
     *  - 返回 { text, label }:label 用于 toast 说明(如"展示中 X 条/所有 Y 条")。 */
    _resolveSaveTextAndLabel() {
      return new Promise((resolve) => {
        const total = this.store.count()
        const list = global.window.App && global.window.App.list
        const showingRecs = (list && typeof list.getShowingRecs === 'function') ? list.getShowingRecs() : null
        const showingLen = showingRecs ? showingRecs.length : total

        // 范围一致或拿不到列表展示集,直接全量
        const sameScope = !showingRecs || showingLen >= total
        const finalize = (scope) => {
          if (scope === 'showing') {
            const text = global.DanmakuSerialize.buildExportJson(this.store, showingRecs)
            resolve({ text: text, label: '展示中 ' + showingLen + ' 条', recs: showingRecs })
          } else {
            const text = global.DanmakuSerialize.buildExportJson(this.store)
            resolve({ text: text, label: '所有 ' + total + ' 条', recs: null })
          }
        }
        if (sameScope) { finalize('all'); return }

        const msg =
          '检测到当前展示中的弹幕量(' + showingLen + ') ≠ 弹幕池总量(' + total + ')。\n' +
          '请选择保存范围:\n\n' +
          '   · 确定 = 保存「目前展示中的」弹幕(' + showingLen + '条)\n' +
          '   · 取消 = 保存「弹幕池内所有」弹幕(' + total + '条)'
        global.DanmakuIO.confirmDialog(msg).then((ok) => finalize(ok ? 'showing' : 'all'))
      })
    }

    /** 弹幕列表「保存」:
     *  - 已打开本地弹幕池文件(_currentLibId 有值):直接覆盖更新该文件(立即同步)。
     *  - 未打开任何本地弹幕池文件:弹出文件管理选择保存位置(默认本地弹幕池目录)。
     *  - 保存成功后关联当前文件路径,后续 Ctrl+S 等均可直接更新。
     *  - @param {Object} [opts] 可选参数:
     *    · silent=true:无弹幕时静默返回,不弹 toast;也不弹"是否创建同名弹幕文件"与"范围询问"二次弹窗(用于"保存并打开/保存并创建"这种程序化保存)。
     *    · scope='all'|'showing':强制保存范围,不传则按默认(展示数 ≠ 总数时弹询问,除非 silent=true 时强制全量)。
     *  - @returns {Promise<boolean>} 是否保存成功(便于 await 后再执行后续)。 */
    saveDanmakuFile(opts) {
      const silent = !!(opts && opts.silent)
      const forceScope = (opts && (opts.scope === 'all' || opts.scope === 'showing')) ? opts.scope : null
      if (!this.store.count()) {
        if (!silent) this.player.toast('没有可保存的弹幕')
        return Promise.resolve(false)
      }
      // ★ silent 保存:默认强制全量,不再弹"范围询问"二次弹窗
      const scopeResolve = forceScope
        ? Promise.resolve(forceScope)
        : (() => {
            const total = this.store.count()
            const list = global.window.App && global.window.App.list
            const showingRecs = (list && typeof list.getShowingRecs === 'function') ? list.getShowingRecs() : null
            const showingLen = showingRecs ? showingRecs.length : total
            const sameScope = !showingRecs || showingLen >= total
            if (sameScope || silent) return Promise.resolve('all')
            const msg =
              '检测到当前展示中的弹幕量(' + showingLen + ') ≠ 弹幕池总量(' + total + ')。\n' +
              '请选择保存范围:\n\n' +
              '   · 确定 = 保存「目前展示中的」弹幕(' + showingLen + '条)\n' +
              '   · 取消 = 保存「弹幕池内所有」弹幕(' + total + '条)'
            return global.DanmakuIO.confirmDialog(msg).then((ok) => (ok ? 'showing' : 'all'))
          })()

      return scopeResolve.then((scope) => {
        const total = this.store.count()
        const list = global.window.App && global.window.App.list
        const showingRecs = (scope === 'showing' && list && typeof list.getShowingRecs === 'function') ? list.getShowingRecs() : null
        const showingLen = showingRecs ? showingRecs.length : total
        const text = scope === 'showing' && showingRecs
          ? global.DanmakuSerialize.buildExportJson(this.store, showingRecs)
          : global.DanmakuSerialize.buildExportJson(this.store)
        const label = scope === 'showing' ? ('展示中 ' + showingLen + ' 条') : ('所有 ' + total + ' 条')

        const videoName = this.player.getVideoName()
        const videoPath = this.player.getVideoPath()
        const base = (videoName || 'danmaku').replace(/\.[^/.]+$/, '')

        const askSameName = (savedText, finalize) => {
          // silent 或无视频:直接跳过后处理
          if (silent || !videoPath) { finalize(); return }
          const sameName = base + '.json'
          global.DanmakuIO.confirmDialog('是否在当前目录创建与播放视频同名的弹幕文件(' + sameName + ')?\n下次打开该视频时将自动加载此弹幕。').then((ok) => {
            finalize()
            if (!ok) return
            const samePath = String(videoPath).replace(/[^\\/]+$/, '') + sameName
            const allText = (scope === 'showing' && showingRecs) ? global.DanmakuSerialize.buildExportJson(this.store) : savedText
            global.DanmakuIO.saveSilent(samePath, allText).then((ok2) => {
              this.player.toast(ok2 ? '已创建同名弹幕文件 ' + sameName : '创建同名文件失败')
            })
          })
        }

        // ★ 场景 A:已关联本地弹幕池文件 → 直接覆盖更新
        if (this._currentLibId && typeof global.DanmakuIO.updateLibraryEntry === 'function') {
          return global.DanmakuIO.updateLibraryEntry(this._currentLibId, text).then((res) => {
            if (res && res.ok) {
              // ★ 保存成功:立刻重打基线 & 同步文件修改时间
              this._markBaselineSaved(text)
              // ★ 重基未提交编辑快照:保存后切选/退批量不再回滚刚保存的改动
              if (this.store && typeof this.store.rebasePendingEdits === 'function') this.store.rebasePendingEdits()
              this._refreshSaveState()
              if (!silent) this.player.toast('已更新(' + label + ') ' + (this._currentLibName || this._currentLibId))
              return new Promise((resolveOK) => {
                askSameName(text, () => { /* post-action 仅 toast,不影响返回 */ })
                resolveOK(true)
              })
            } else {
              if (!silent) this.player.toast('保存失败:无法更新当前文件', { error: true })
              return false
            }
          }).catch(() => {
            if (!silent) this.player.toast('保存失败:IO 错误', { error: true })
            return false
          })
        }

        // ★ 场景 B:未关联 → 弹出文件管理选择保存位置
        const defaultName = this._timestampName()
        return global.DanmakuIO.getDanmakuDir().then((dir) => {
          const defaultDir = (dir && dir.path) || ''
          return global.DanmakuIO.saveFile(defaultName, text, { defaultDir: defaultDir, filterLabel: '弹幕 JSON' }).then(
            (res) => {
              if (!res) return false
              // 保存成功后关联当前文件(仅 Electron 下有完整 path)并重打基线
              if (res.path) {
                this._currentLibId = res.path
                this._currentLibName = res.name
              }
              this._markBaselineSaved(text)
              // ★ 重基未提交编辑快照:保存后切选/退批量不再回滚刚保存的改动
              if (this.store && typeof this.store.rebasePendingEdits === 'function') this.store.rebasePendingEdits()
              this._refreshSaveState()
              if (!silent) this.player.toast('已保存(' + label + ') ' + res.name)
              return new Promise((resolveOK) => {
                askSameName(text, () => {})
                resolveOK(true)
              })
            },
            () => false
          )
        })
      })
    }

    /** ★ 用户主动保存入口(Ctrl+S / 列表「保存」按钮):
     *  当前弹幕池已与磁盘一致(hasUnsavedChanges=false)时,提示「你已经保存了最新改动！」并跳过重写;
     *  有改动才真正写盘,写盘成功后刷新「已保存」按钮状态。 */
    saveViaUserAction() {
      if (!this.hasUnsavedChanges()) {
        this.player.toast('你已经保存了最新改动！')
        this._refreshSaveState()
        return Promise.resolve(false)
      }
      return this.saveDanmakuFile().then((ok) => {
        this._refreshSaveState()
        return ok
      })
    }

    /** 添加弹幕:创建草稿(不入池),面板绑定草稿,写好后点「发送」才入池。
     *  ★ 除正文外所有参数均继承上次草稿(store._lastDraftXxx),无历史时回退到默认值。*/
    addNew(type) {
      const defaultSender = (global.window.App && global.window.App.settings && global.window.App.settings.defaultSender) || '我'
      const nowSec = round2(this.clock.now())
      let rec
      if (type === 'advanced') {
        // ★ 先用上次草稿参数,否则默认 makeAdvanced
        rec = this.store.buildDraftFromLast('advanced') || Convert.makeAdvanced()
        rec.content = ''
        // 发送人/时间始终在新草稿中按当前规则写入,避免继承了旧的发送人/历史时间戳
        rec.sender = defaultSender
        rec.timeSec = nowSec
        rec.useCurrentTime = true
        // ctime 先写入草稿创建时间,发送 add 时会再次重写(若 add 时 rec.ctime 已存在则不覆盖)
        if (!Number.isFinite(rec.ctime) || rec.ctime <= 0) {
          rec.ctime = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
        }
      } else {
        rec = this.store.buildDraftFromLast('normal') || Convert.makeNormal()
        rec.content = ''
        rec.sender = defaultSender
        rec.timeSec = nowSec
        if (!rec.useCurrentTime) delete rec.useCurrentTime // 避免覆盖默认值逻辑
        if (!Number.isFinite(rec.ctime) || rec.ctime <= 0) {
          rec.ctime = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
        }
      }
      this.store.setDraft(rec)
      this.player.toast(
        '已创建' + (type === 'advanced' ? '高级' : '普通') + '弹幕草稿,设置完成后点击「发送」'
      )
    }

    /** 高级弹幕「预览」:用当前参数直接上屏,不入列表。immediate=true 时不受暂停影响。 */
    previewAdvanced(immediate) {
      const rec = this.store.getSelected()
      if (!rec || rec.type !== 'advanced') {
        this.player.toast('请先点击「＋ 添加弹幕」创建并选中一个高级弹幕')
        return
      }
      const v = global.DanmakuConvert.validateRecord(rec)
      if (!v.ok) {
        this.player.toast('预览失败: ' + v.error)
        return
      }
      const tmp = JSON.parse(JSON.stringify(rec))
      tmp.timeSec = this.clock.now() // 用当前时刻预览,不改发送时间
      tmp._preview = true
      if (immediate) tmp._previewImmediate = true
      // ★ 预览前:隐藏舞台上已存在的所有正式弹幕(非_preview),避免视觉干扰
      this.engine.hideNonPreviews()
      // ★ 先清除同 id 的旧预览弹幕,避免多次点预览产生重复实例
      this.engine.advanced.removePreviewById(tmp.id)
      this.engine.advanced.spawn(tmp)
      this.player.toast('预览中…')
    }

    /** 面板「发送」:校验参数合理性,失败提示原因;草稿通过后入池。 */
    validateAndSend(type) {
      const rec = this.store.getSelected()
      if (!rec || rec.type !== type) {
        this.player.toast(
          '请先点击「＋ 添加弹幕」创建并选中一个' + (type === 'normal' ? '普通' : '高级') + '弹幕'
        )
        return
      }
      const v = global.DanmakuConvert.validateRecord(rec)
      if (!v.ok) {
        this.player.toast('发送失败: ' + v.error)
        return
      }
      const isDraft = this.store.draft === rec
      if (isDraft) {
        this.store.add(rec)
        this.player.toast('发送成功 @' + global.TimeUtil.fmtClockExact(rec.timeSec))
        // ★ 若处于部分展示模式,显示黄色警告
        const listW = global.window.App && global.window.App.list
        if (listW && typeof listW._warnIfFilterActive === 'function') listW._warnIfFilterActive()
        // ★ 高级弹幕发送成功后:把该条数据深拷贝一份记录到全局,供面板「复制」按钮使用
        if (type === 'advanced') {
          global._lastSentAdvanced = global.DanmakuConvert.cloneAdvanced(rec) || global.DanmakuConvert.toRuntime(global.DanmakuConvert.fromRecord(rec))
          // ★ 立刻刷新复制按钮的显示状态(让用户在点击"发送"后即可看到复制按钮出现)
          const panelAdv = global.window && global.window.App && global.window.App.panelAdvanced
          if (panelAdv && typeof panelAdv._syncCopyBtnVisible === 'function') {
            panelAdv._syncCopyBtnVisible()
          }
        }
      } else {
        this.store.commitEdit(rec.id)
        this.player.toast('更改成功 @' + global.TimeUtil.fmtClockExact(rec.timeSec))
      }
    }

    _addNew(type) {
      const now = round2(this.clock.now())
      let rec
      if (type === 'advanced') {
        rec = Convert.makeAdvanced()
        // 草稿默认内容为空,避免空内容直接入库
        rec.content = ''
        rec.sender = '我'
        rec.timeSec = now
      } else {
        rec = Convert.makeNormal()
        rec.content = ''
        rec.sender = '我'
        rec.timeSec = now
      }
      // 内容为空(全空格也视为空)时不入库,提示用户输入
      const trimmed = (rec.content == null ? '' : String(rec.content)).trim()
      if (!trimmed) {
        this.player.toast('请先输入弹幕内容', { error: true })
        return
      }
      const created = this.store.add(rec)
      this.store.select(created.id)
      this.player.toast(
        '已新增' + (type === 'advanced' ? '高级' : '普通') + '弹幕 @' + global.TimeUtil.fmtClockExact(now)
      )
      // ★ 若处于部分展示模式,显示黄色警告
      const listW2 = global.window.App && global.window.App.list
      if (listW2 && typeof listW2._warnIfFilterActive === 'function') listW2._warnIfFilterActive()
    }
  }

  global.Controls = Controls
})(window)
