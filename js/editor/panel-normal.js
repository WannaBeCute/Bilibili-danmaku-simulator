/**
 * panel-normal.js:普通弹幕设置面板(深色模式)。
 * 绑定选中普通弹幕的:模式/字号/颜色/大会员色/UP标/发送人/时间/内容。
 * 时间旁有「当前时间」按钮:点击后时间以当前播放时间为准,输入框清空且不可输入。
 * 自定义颜色输入支持 hex / rgb() / 颜色名 / 十进制,统一转十六进制。
 */
(function (global) {
  'use strict'

  const C = global.ColorUtil
  const round2 = (n) => Math.round(n * 100) / 100

  // ★ 普通弹幕面板 18 种颜色(去重、覆盖常用色+少量浅色)
  const SWATCHES = [
    { c: '#FFFFFF', n: '白' },
    { c: '#FF0000', n: '红' },
    { c: '#FF6600', n: '橙红' },
    { c: '#FF9900', n: '橙' },
    { c: '#FFFF00', n: '黄' },
    { c: '#99FF33', n: '黄绿' },
    { c: '#00FF00', n: '绿' },
    { c: '#00FFCC', n: '青' },
    { c: '#00D9FF', n: '天蓝' },
    { c: '#0066FF', n: '蓝' },
    { c: '#6600FF', n: '深紫' },
    { c: '#800080', n: '紫' },
    { c: '#FF00FF', n: '粉' },
    { c: '#FF3399', n: '洋红' },
    { c: '#996633', n: '棕' },
    { c: '#808080', n: '灰' },
    { c: '#000000', n: '黑' },
    { c: '#FFD1DC', n: '浅粉' },
  ]

  class PanelNormal {
    constructor(store, root, clock) {
      this.store = store
      this.root = root
      this.clock = clock
      this.boundId = null
      this._loading = false

      this.emptyEl = root.querySelector('.pn-empty')
      this.bodyEl = root.querySelector('.pn-body')
      this.batchEl = root.querySelector('.pn-batch')
      this.sendBtn = root.querySelector('#pn-send')
      this.segMode = root.querySelector('#pn-mode')
      this.segFont = root.querySelector('#pn-fontsize')
      this.colorsEl = root.querySelector('#pn-colors')
      this.colorfulEl = root.querySelector('#pn-colorful')
      this.isupEl = root.querySelector('#pn-isup')
      this.colorTextEl = root.querySelector('#pn-color-text')
      this.colorPickEl = root.querySelector('#pn-color-custom')
      this.senderEl = root.querySelector('#pn-sender')
      this.timeEl = root.querySelector('#pn-time')
      this.timeNowBtn = root.querySelector('#pn-time-now')
      this.sentAtEl = root.querySelector('#pn-sent-at') // ★ 发送时间戳只读
      this.contentEl = root.querySelector('#pn-content')
      // ★ 「复制」按钮(在 panel-normal 标题栏,与 #pa-copy 同位)
      this.copyBtn = document.getElementById('pn-copy') || (global.DomUtil && global.DomUtil.$ ? global.DomUtil.$('#pn-copy') : null)

      this._buildSwatches()
      this._wireSeg(this.segMode, (v) => this._set('mode', v))
      this._wireSeg(this.segFont, (v) => {
        // ★ UP 主标识锁定:字号拦截(必须保持 standard)
        if (this._rec() && this._rec().isUp) {
          this._toast('UP主标识弹幕字号固定为标准(25px)')
          this._setSegActive(this.segFont, 'standard')
          return
        }
        this._set('fontSize', v)
      })

      // ★ 「复制」按钮:用当前选中的普通弹幕参数创建新草稿
      if (this.copyBtn) {
        this.copyBtn.addEventListener('click', () => {
          this._doCopyFromSource()
        })
      }

      this.colorfulEl.addEventListener('change', () => {
        if (this._loading) return
        // ★ UP 主标识锁定:大会员色切换拦截
        if (this._rec() && this._rec().isUp) {
          this._loading = true
          this.colorfulEl.checked = false
          this._loading = false
          this._toast('UP主标识弹幕不能开启大会员色')
          return
        }
        const rec = this._rec()
        if (!rec) return
        this.store.update(
          rec.id,
          { colorful: this.colorfulEl.checked ? 60001 : undefined },
          'colorful'
        )
        // ★ 大会员色开启:锁定颜色为白色
        if (this.colorfulEl.checked) {
          this._set('color', '#FFFFFF')
        }
        this._applyUpLock()
      })
      this.isupEl.addEventListener('change', () => {
        if (this._loading) return
        const on = this.isupEl.checked
        // ★ UP 主标识开启:强制字号=标准、颜色=白色;禁用除模式外的所有样式开关
        if (on) {
          this._set('fontSize', 'standard')
          this._set('color', '#FFFFFF')
          if (this._rec() && this._rec().colorful) {
            this._set('colorful', undefined) // 清除大会员色
          }
        }
        this._set('isUp', on)
        this._applyUpLock()
      })

      // 自定义颜色:文本输入(多格式) + 取色器
      this.colorTextEl.addEventListener('change', () => {
        if (this._loading) return
        // ★ UP 主标识锁定:颜色必须为 #FFFFFF,拦截自定义颜色输入
        if (this._rec() && this._rec().isUp) {
          this.colorTextEl.value = '#FFFFFF'
          this.colorPickEl.value = '#FFFFFF'
          this._toast('UP主标识弹幕颜色固定为白色')
          return
        }
        const hex = C.parseColor(this.colorTextEl.value)
        if (hex) {
          this._set('color', hex)
          this.colorPickEl.value = hex
        } else {
          this.colorTextEl.value = this._rec() ? this._rec().color : ''
        }
      })
      this.colorPickEl.addEventListener('input', () => {
        if (this._loading) return
        // ★ UP 主标识锁定:取色器拦截
        if (this._rec() && this._rec().isUp) {
          this._loading = true
          this.colorPickEl.value = '#FFFFFF'
          this.colorTextEl.value = '#FFFFFF'
          this._loading = false
          this._toast('UP主标识弹幕颜色固定为白色')
          return
        }
        const hex = this.colorPickEl.value.toUpperCase()
        // ★ 同步文本框显示 + 更新参数
        this.colorTextEl.value = hex
        this._set('color', hex)
      })

      this.senderEl.addEventListener('input', () => {
        if (!this._loading) this._set('sender', this.senderEl.value)
      })
      this.timeEl.addEventListener('change', () => {
        if (this._loading) return
        const t = global.TimeUtil.strToTime(this.timeEl.value)
        if (t != null) this._set('timeSec', round2(t))
      })
      this.timeNowBtn.addEventListener('click', () => this.toggleNow())
      this.contentEl.addEventListener('input', () => {
        if (!this._loading) this._set('content', this.contentEl.value)
      })

      store.onChange((evt, id, field) => this.onStore(evt, id, field))
      // ★ 初始化:显示空提示(否则正文会显示默认参数值,像选中了一条弹幕一样)
      this.clear()
    }

    _rec() {
      return this.boundId ? this.store.get(this.boundId) : null
    }

    _set(field, value) {
      if (this._loading) return
      const rec = this._rec()
      if (!rec) return
      const patch = {}
      patch[field] = value
      this.store.update(rec.id, patch, field)
    }

    /** 「当前时间」:开 -> 取当前播放时间(两位小数),输入框清空禁用;关 -> 恢复输入。 */
    toggleNow() {
      const rec = this._rec()
      if (!rec || this._loading) return
      const on = !rec.useCurrentTime
      if (on) {
        this.store.update(
          rec.id,
          { useCurrentTime: true, timeSec: round2(this.clock.now()) },
          'timeSec'
        )
      } else {
        this.store.update(rec.id, { useCurrentTime: false }, 'useCurrentTime')
      }
    }

    onStore(evt, id, field) {
      if (evt === 'select') {
        // ★ 批量选择(>1)时显示"目前正在批量选择"提示,不加载单条参数
        if (this.store.selectedIds.size > 1) {
          this.showBatch()
          this._syncCopyBtnVisible()
          return
        }
        const rec = this.store.getSelected()
        if (rec && rec.type === 'normal') this.load(rec)
        else this.clear()
      } else if (evt === 'change' && id === this.boundId && !this._loading) {
        this.load(this.store.get(id))
      } else if (evt === 'remove' && id === this.boundId) {
        this.clear()
      } else if (evt === 'add' && id === this.boundId) {
        const rec = this.store.get(id)
        if (rec) this.load(rec)
      }
      this._syncCopyBtnVisible()
      void field
    }

    /** ★ 执行「复制」:来源 = 当前选中的普通弹幕(已入池)。
     *  成功后将参数深拷贝为新草稿(不影响原弹幕),发送人改为全局默认发送人(默认"我")。
     *  面板自动绑定到草稿。*/
    _doCopyFromSource() {
      let src = this.store.getSelected()
      if (!src || src.type !== 'normal') src = null
      // 如果当前选中的是草稿本身,没有可复制的源
      if (src && this.store.draft === src) src = null
      if (!src) {
        this._toast('还没有可复制的普通弹幕;请先选中舞台/列表里的普通弹幕')
        return
      }
      // 深拷贝为普通弹幕草稿
      const clone = {
        type: 'normal',
        content: String(src.content || ''),
        mode: src.mode || 'scroll',
        fontSize: src.fontSize || 'standard',
        color: src.color || '#FFFFFF',
        timeSec: Number.isFinite(src.timeSec) ? Number(src.timeSec) : 0,
        useCurrentTime: false, // 复制时保留源弹幕时间点,不跟随当前时间
      }
      if (src.colorful) clone.colorful = src.colorful
      if (src.isUp) clone.isUp = src.isUp
      // ★ 发送人改为全局默认发送人(默认"我"),不沿用被复制弹幕的发送人
      clone.sender = (global.App && global.App.settings && global.App.settings.defaultSender) || '我'
      // ★ sentAt 不沿用被复制弹幕的:草稿阶段写复制时间,发送后 add 会再次覆写为真正发送时间
      clone.sentAt = global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now()
      // 偏移 10ms 避免与源弹幕完全同时间
      clone.timeSec = Math.max(0, clone.timeSec + 0.01)
      this.store.setDraft(clone)
      this._toast('已复制普通弹幕参数为新草稿,可修改后再「发送」')
    }

    /** ★ 「复制」按钮显示规则:当前选中/加载的是普通弹幕时显示,其他隐藏。*/
    _syncCopyBtnVisible() {
      if (!this.copyBtn) return
      const hasSel = this.store.getSelected() && this.store.getSelected().type === 'normal'
      this.copyBtn.hidden = !hasSel
    }

    /** 轻量 toast,复用 #toast DOM。*/
    _toast(msg, opts) {
      const el = document.getElementById('toast')
      if (!el) return
      el.textContent = msg
      el.classList.toggle('error', !!(opts && opts.error))
      el.classList.add('show')
      clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => el.classList.remove('show'), (opts && opts.duration) || 2000)
    }

    load(rec) {
      this._loading = true
      this.boundId = rec.id
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.add('hide')
      this.bodyEl.hidden = false

      const isDraft = this.store.draft === rec
      if (this.sendBtn) {
        this.sendBtn.textContent = isDraft ? '发送' : '更改'
        this.sendBtn.title = isDraft ? '校验参数并发送' : '校验参数并更改'
      }

      this._setSegActive(this.segMode, rec.mode)
      this._setSegActive(this.segFont, rec.fontSize)

      const activeColor = rec.color || '#FFFFFF'
      const swatches = this.colorsEl.querySelectorAll('.pn-swatch')
      for (const sw of swatches) {
        sw.classList.toggle('active', sw.getAttribute('data-color') === activeColor)
      }
      this._setVal(this.colorTextEl, activeColor)
      this.colorPickEl.value = activeColor

      this.colorfulEl.checked = !!rec.colorful
      this.isupEl.checked = !!rec.isUp
      this._setVal(this.senderEl, rec.sender || '')
      // ★ 发送时间戳:只读显示,不提供手动编辑入口(发送/更改时自动更新)
      if (this.sentAtEl) this._setVal(this.sentAtEl, global.TimeUtil.tsToLocal(rec.sentAt))
      // 「当前时间」启用时:输入框清空禁用,时间以当前播放时间为准
      this.timeEl.disabled = !!rec.useCurrentTime
      this.timeEl.placeholder = rec.useCurrentTime ? '按当前时间' : '00:00:02'
      this._setVal(this.timeEl, rec.useCurrentTime ? '' : global.TimeUtil.timeToStrPrecise(rec.timeSec))
      this.timeNowBtn.classList.toggle('active', !!rec.useCurrentTime)
      this._setVal(this.contentEl, rec.content)
      this._applyUpLock()
      this._loading = false
    }

    clear() {
      this.boundId = null
      this.emptyEl.classList.remove('hide')
      if (this.batchEl) this.batchEl.classList.add('hide')
      this.bodyEl.hidden = true
      if (this.sendBtn) {
        this.sendBtn.textContent = '发送'
        this.sendBtn.title = '校验参数并发送'
      }
      this._applyUpLock()
    }

    /** ★ 批量选择时显示提示,隐藏正文与空提示 */
    showBatch() {
      this.boundId = null
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      this.bodyEl.hidden = true
    }

    _setVal(input, value) {
      if (!input) return
      const target = String(value == null ? '' : value)
      if (String(input.value) !== target) input.value = target
    }

    _buildSwatches() {
      // ★ 先清空容器,避免与 HTML 残留按钮(未绑定事件)重叠造成重复&无法交互
      this.colorsEl.innerHTML = ''
      const frag = document.createDocumentFragment()
      for (const { c, n } of SWATCHES) {
        const btn = document.createElement('button')
        btn.className = 'pn-swatch'
        btn.style.background = c
        btn.title = n + ' ' + c
        btn.setAttribute('data-color', c)
        btn.addEventListener('click', () => {
          if (this._loading) return
          // ★ UP 主标识锁定:色板点击拦截(必须保持 #FFFFFF)
          if (this._rec() && this._rec().isUp && c !== '#FFFFFF') {
            this._toast('UP主标识弹幕颜色固定为白色')
            const swatches = this.colorsEl.querySelectorAll('.pn-swatch')
            for (const sw of swatches) sw.classList.toggle('active', sw.getAttribute('data-color') === '#FFFFFF')
            return
          }
          // ★ 点击色板时同步更新文本框 + 原生取色器 value + 更新所有 swatch 高亮
          const swatches = this.colorsEl.querySelectorAll('.pn-swatch')
          for (const sw of swatches) sw.classList.toggle('active', sw === btn)
          this.colorTextEl.value = c
          if (this.colorPickEl) this.colorPickEl.value = c
          this._set('color', c)
        })
        frag.appendChild(btn)
      }
      this.colorsEl.appendChild(frag)
    }

    /** ★ UP 主标识/大会员色锁定:根据当前 rec.isUp 和 rec.colorful 状态禁用/启用样式控件。
     *  - UP主标识开启:禁用字号+色板+自定义颜色+大会员色(模式始终开启)
     *  - 大会员色开启(非UP主):禁用色板+自定义颜色(字号不禁用)*/
    _applyUpLock() {
      const rec = this._rec()
      const isUp = !!(rec && rec.isUp)
      const isColorful = !!(rec && rec.colorful)
      const colorLock = isUp || isColorful
      // 字号 seg 按钮:仅 UP主标识时置灰
      if (this.segFont) {
        this.segFont.style.opacity = isUp ? '0.45' : ''
        this.segFont.style.pointerEvents = isUp ? 'none' : 'auto'
      }
      // 色板 + 自定义颜色文本框 + 取色器:UP主 或 大会员色 时禁用
      if (this.colorsEl) {
        this.colorsEl.style.opacity = colorLock ? '0.45' : ''
        this.colorsEl.style.pointerEvents = colorLock ? 'none' : 'auto'
      }
      if (this.colorTextEl) {
        this.colorTextEl.disabled = colorLock
      }
      if (this.colorPickEl) {
        this.colorPickEl.disabled = colorLock
      }
      // 大会员色开关:仅 UP主标识时禁用
      if (this.colorfulEl) {
        this.colorfulEl.disabled = isUp
        const label = this.colorfulEl.closest && this.colorfulEl.closest('label')
        if (label) label.style.opacity = isUp ? '0.45' : ''
      }
    }

    _wireSeg(root, cb) {
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('.pn-seg-btn')
        if (!btn || btn.classList.contains('active')) return
        if (this._loading) return
        this._setSegActive(root, btn.getAttribute('data-val'))
        cb(btn.getAttribute('data-val'))
      })
    }

    _setSegActive(root, val) {
      const btns = root.querySelectorAll('.pn-seg-btn')
      for (const b of btns) {
        b.classList.toggle('active', b.getAttribute('data-val') === val)
      }
    }
  }

  global.PanelNormal = PanelNormal
})(window)
