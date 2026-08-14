/**
 * panel-advanced.js:高级弹幕设置面板(深色)。
 * 参数约束:字号10~127整数、字体白名单、生存0~10两位小数、坐标0~9999一位小数、
 *          Z/Y旋转0~360一位小数、透明度0~0.99两位小数、内容≤255且非空。
 * 支持「当前时间」按钮与百分比坐标「自动转换」(开=像素↔百分比换算,关=坐标清0)。
 * 支持「拾取」点击舞台取坐标、路径连续加点。
 */
(function (global) {
  'use strict'

  const C = global.ColorUtil
  const round1 = (n) => Math.round(n * 10) / 10
  const round2 = (n) => Math.round(n * 100) / 100
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

  // ★ 增强模式的参数上限(86400s = 24h)
  const BOOST_MAX_LIFE = 86400
  const BOOST_MAX_MS = 86400000
  const NORM_MAX_LIFE = 10
  const NORM_MAX_MOVE = 10000
  const NORM_MAX_DELAY = 10000

  // [min, max(普通), 小数位] — 增强时 boostMax 会替换 max 字段
  const NUM_FIELDS = [
    ['#pa-style-size', 'style.fontSize', [10, 127, 0]],
    ['#pa-rot-z', 'rotation.z', [0, 360, 1]],
    ['#pa-rot-y', 'rotation.y', [0, 360, 1]],
    ['#pa-life-duration', 'life.duration', [0, NORM_MAX_LIFE, 2], BOOST_MAX_LIFE],
    ['#pa-life-opstart', 'life.opacityStart', [0, 1, 2]],
    ['#pa-life-opend', 'life.opacityEnd', [0, 1, 2]],
    ['#pa-mot-move', 'motion.moveDuration', [0, NORM_MAX_MOVE, 1], BOOST_MAX_MS],
    ['#pa-mot-delay', 'motion.delay', [0, NORM_MAX_DELAY, 1], BOOST_MAX_MS],
    ['#pa-pos-sx', 'position.startX', [0, 9999, 1]],
    ['#pa-pos-sy', 'position.startY', [0, 9999, 1]],
    ['#pa-pos-ex', 'position.endX', [0, 9999, 1]],
    ['#pa-pos-ey', 'position.endY', [0, 9999, 1]],
  ]

  /** 返回字段的 [lo, hi, dp] 三元组。对支持增强的字段,根据 boost 开关选择 hi。 */
  function getCfg(selPathCfg, boost) {
    const cfg = selPathCfg[2]
    const boostMax = selPathCfg[3]
    if (boost && boostMax != null) return [cfg[0], boostMax, cfg[2]]
    return cfg.slice()
  }

  function clampVal(v, cfg) {
    let n = parseFloat(v)
    if (isNaN(n)) return null
    const [lo, hi, dp] = cfg
    n = clamp(n, lo, hi)
    const m = Math.pow(10, dp)
    return Math.round(n * m) / m
  }

  class PanelAdvanced {
    constructor(store, root, editor, engine) {
      this.store = store
      this.root = root
      this.editor = editor
      this.engine = engine
      this.boundId = null
      this._loading = false

      this.emptyEl = root.querySelector('.pa-empty')
      this.bodyEl = root.querySelector('.pa-body')
      this.batchEl = root.querySelector('.pa-batch')
      this.sendBtn = root.querySelector('#pa-send')
      // ★ 「复制」按钮在 #panel-advanced 的父级标题栏(#panel-advanced-wrap 内),所以从 document 查找(避免 root.querySelector 找不到)
      this.copyBtn = document.getElementById('pa-copy') || (global.DomUtil && global.DomUtil.$ ? global.DomUtil.$('#pa-copy') : null)
      this.contentEl = root.querySelector('#pa-content')
      this.timeEl = root.querySelector('#pa-time')
      this.timeNowBtn = root.querySelector('#pa-time-now')
      this.senderEl = root.querySelector('#pa-sender')
      this.sentAtEl = root.querySelector('#pa-sent-at') // ★ 发送时间戳只读
      this.colorTextEl = root.querySelector('#pa-style-color-text')
      this.colorEl = root.querySelector('#pa-style-color')
      this.familyEl = root.querySelector('#pa-style-family')
      this.strokeEl = root.querySelector('#pa-style-stroke')
      this.linearEl = root.querySelector('#pa-mot-linear')
      this.motTypeEl = root.querySelector('#pa-mot-type')
      this.percentEl = root.querySelector('#pa-pos-percent')
      this.autoConvertEl = root.querySelector('#pa-auto-convert')
      // ★ 增强开关及其相关字段
      this.boostEl = root.querySelector('#pa-boost')
      this.lifeDurLabel = root.querySelector('#pa-life-duration-label')
      this.motMoveLabel = root.querySelector('#pa-mot-move-label')
      this.motDelayLabel = root.querySelector('#pa-mot-delay-label')
      this.lifeDurEl = root.querySelector('#pa-life-duration')
      this.motMoveEl = root.querySelector('#pa-mot-move')
      this.motDelayEl = root.querySelector('#pa-mot-delay')

      this._wireFields()

      // ★ 「复制」按钮:用指定的高级弹幕参数创建一个新草稿
      if (this.copyBtn) {
        this.copyBtn.addEventListener('click', () => {
          this._doCopyFromSource()
        })
      }

      // 拾取按钮
      const picks = root.querySelectorAll('.pa-pick[data-field]')
      for (const btn of picks) {
        btn.addEventListener('click', () => {
          if (this._loading) return
          this.editor.armPick(btn.getAttribute('data-field'))
        })
      }

      editor.onPickDone = () => this.refreshPickButtons()

      store.onChange((evt, id, field) => this.onStore(evt, id, field))

      // ★ 初始化:先显示空提示(否则 HTML 里的 pa-body 会在首次选中前就显示操作面板)
      this.clear()
      // ★ 初始化时先同步一次复制按钮可见性(否则永远保持 HTML 初始的 hidden)
      this._syncCopyBtnVisible()
    }

    /** ★ 执行「复制」:来源优先级 = 当前选中已入池的高级弹幕 > 全局最近一次发送成功的高级弹幕。
     * 成功后将参数深拷贝为新草稿(不影响原弹幕),面板自动绑定到草稿。*/
    _doCopyFromSource() {
      let src = this.store.getSelected()
      if (!src || src.type !== 'advanced') src = null
      // 如果当前选中的是草稿本身,就用全局最近发送的
      if (src && this.store.draft === src) src = null
      if (!src) src = global._lastSentAdvanced || null
      if (!src || src.type !== 'advanced') {
        this._toast('还没有可复制的高级弹幕;请先发送一条或选中舞台/列表里的高级弹幕')
        return
      }
      const clone = global.DanmakuConvert.cloneAdvanced(src)
      if (!clone) return
      // ★ 发送人改为全局默认发送人(默认"我"),不沿用被复制弹幕的发送人
      clone.sender = (global.App && global.App.settings && global.App.settings.defaultSender) || '我'
      // 避免与源弹幕完全同时间,偏移 10ms(视觉上无明显差别)
      clone.timeSec = Number.isFinite(clone.timeSec) ? Math.max(0, clone.timeSec + 0.01) : 0
      clone.useCurrentTime = false // 复制时不再跟随当前时间,保留源弹幕的时间点
      this.store.setDraft(clone)
      this._toast('已复制高级弹幕参数为新草稿,可修改后再「发送」')
    }

    /** ★ 「复制」按钮显示规则:
     *  - 有发送过一条高级弹幕(global._lastSentAdvanced) → 显示;
     *  - 或当前选中/加载的是高级弹幕 → 显示。
     *  - 其他情况隐藏(避免空状态点按钮只报错)。*/
    _syncCopyBtnVisible() {
      if (!this.copyBtn) return
      const hasSent = global._lastSentAdvanced && global._lastSentAdvanced.type === 'advanced'
      const hasSel = this.store.getSelected() && this.store.getSelected().type === 'advanced'
      this.copyBtn.hidden = !(hasSent || hasSel)
    }

    _rec() {
      return this.boundId ? this.store.get(this.boundId) : null
    }

    _wireFields() {
      for (const fieldDef of NUM_FIELDS) {
        const sel = fieldDef[0]
        const path = fieldDef[1]
        const input = this.root.querySelector(sel)
        if (!input) continue
        input.addEventListener('input', () => {
          if (this._loading) return
          const rec = this._rec()
          if (!rec) return
          // 坐标字段:按 usePercent 选择钳制(百分比 0~0.99 两位小数;像素 0~9999 一位小数)
          let c
          if (path.indexOf('position.') === 0) {
            c = rec.position.usePercent ? [0, 0.99, 2] : [0, 9999, 1]
          } else {
            c = getCfg(fieldDef, !!rec._boost)
          }
          const [lo, hi] = c
          const raw = parseFloat(input.value)
          // ★ 未开启增强且超范围:只提示,不阻断写入(由 clamp 钳制);但若是 life/move/delay 字段明确超范围,报 toast
          const isBoostField = fieldDef[3] != null
          if (isBoostField && !rec._boost && !isNaN(raw) && (raw < lo || raw > hi)) {
            const nameMap = {
              'life.duration': '生存时间',
              'motion.moveDuration': '运动耗时',
              'motion.delay': '延迟',
            }
            const fieldName = nameMap[path] || path
            this._toast(fieldName + ' 超出范围(' + lo + '~' + hi + ');请开启「增强」后再输入,当前已被钳制。', { error: true })
          }
          const v = clampVal(input.value, c)
          if (v == null) return
          this.store.updateDeep(this.boundId, path, v)
        })
      }

      // ★ 增强开关切换:更新 input 的 max 属性与标签文案
      if (this.boostEl) {
        this.boostEl.addEventListener('change', () => {
          if (this._loading) return
          const rec = this._rec()
          if (!rec) return
          this.store.update(rec.id, { _boost: this.boostEl.checked }, '_boost')
          this._applyBoostToFields(this.boostEl.checked)
        })
      }

      this.contentEl.addEventListener('input', () => {
        if (!this._loading) {
          this.store.update(this.boundId, { content: this.contentEl.value.slice(0, 255) }, 'content')
        }
      })
      this.senderEl.addEventListener('input', () => {
        if (!this._loading) this.store.update(this.boundId, { sender: this.senderEl.value }, 'sender')
      })
      this.timeEl.addEventListener('change', () => {
        if (this._loading) return
        const t = global.TimeUtil.strToTime(this.timeEl.value)
        if (t != null) this.store.update(this.boundId, { timeSec: round2(t) }, 'timeSec')
      })
      this.timeNowBtn.addEventListener('click', () => this.toggleNow())

      // 颜色:文本输入(多格式) + 取色器
      this.colorTextEl.addEventListener('change', () => {
        if (this._loading) return
        const hex = C.parseColor(this.colorTextEl.value)
        if (hex) {
          this.store.updateDeep(this.boundId, 'style.color', hex)
          this.colorEl.value = hex
        } else {
          this.colorTextEl.value = this._rec() ? this._rec().style.color : ''
        }
      })
      this.colorEl.addEventListener('input', () => {
        if (!this._loading) {
          const hex = this.colorEl.value.toUpperCase()
          // ★ 同步文本框显示 + 更新 style.color
          this.colorTextEl.value = hex
          this.store.updateDeep(this.boundId, 'style.color', hex)
        }
      })

      this.familyEl.addEventListener('change', () => {
        if (!this._loading) {
          this.store.updateDeep(this.boundId, 'style.fontFamily', this.familyEl.value)
          // ★ 同步 fontFamilyRaw 为英文代码(用于 XML 导出)
          const rawCode = this._fontToRawCode(this.familyEl.value)
          this.store.updateDeep(this.boundId, 'style.fontFamilyRaw', rawCode)
        }
      })
      this.strokeEl.addEventListener('change', () => {
        if (!this._loading) this.store.updateDeep(this.boundId, 'style.stroke', this.strokeEl.value === '1')
      })
      this.linearEl.addEventListener('change', () => {
        if (!this._loading) this.store.updateDeep(this.boundId, 'motion.linear', this.linearEl.value === '0')
      })
      this.motTypeEl.addEventListener('change', () => {
        if (!this._loading) {
          // 路径跟随(path)模式不符合B站要求,不开放
          if (this.motTypeEl.value === 'path') {
            this._toast('该运动模式的方法不符合b站要求,故不开放')
            // 强制回退到 position
            this._loading = true
            this.motTypeEl.value = 'position'
            this._loading = false
            this.store.updateDeep(this.boundId, 'motion.type', 'position')
          } else {
            this.store.updateDeep(this.boundId, 'motion.type', this.motTypeEl.value)
          }
        }
      })
      this.percentEl.addEventListener('change', () => this.togglePercent())
    }

    /** 「当前时间」:同普通面板。 */
    toggleNow() {
      const rec = this._rec()
      if (!rec || this._loading) return
      const on = !rec.useCurrentTime
      if (on) {
        this.store.update(
          rec.id,
          { useCurrentTime: true, timeSec: round2(this.engine.clock.now()) },
          'timeSec'
        )
      } else {
        this.store.update(rec.id, { useCurrentTime: false }, 'useCurrentTime')
      }
    }

    /**
     * 切换「按百分比」:
     *  - 自动转换(默认开):像素<->百分比 换算坐标与路径点(保留数值)
     *  - 关闭自动转换:坐标与路径点清 0
     */
    togglePercent() {
      const rec = this._rec()
      if (!rec || this._loading) return
      const target = this.percentEl.checked
      if (target === rec.position.usePercent) return
      const W = this.engine.width
      const H = this.engine.height

      const convertOne = (v, axis) => {
        if (W <= 0 || H <= 0) return v
        if (target) {
          // 像素 -> 小数百分比(0~0.99)
          return clamp(round2(v / (axis === 'x' ? W : H)), 0, 0.99)
        }
        // 小数百分比 -> 像素
        return clamp(round1(v * (axis === 'x' ? W : H)), 0, 9999)
      }

      let pos = {
        startX: convertOne(rec.position.startX, 'x'),
        startY: convertOne(rec.position.startY, 'y'),
        endX: convertOne(rec.position.endX, 'x'),
        endY: convertOne(rec.position.endY, 'y'),
      }
      let path = (rec.motion.path || []).map((pt) => ({
        x: convertOne(pt.x, 'x'),
        y: convertOne(pt.y, 'y'),
      }))
      if (!this.autoConvertEl.checked) {
        pos = { startX: 0, startY: 0, endX: 0, endY: 0 }
        path = []
      }
      pos.usePercent = target
      // ★ 切换百分比时同步调整起点/终点 XY 的 step 属性
      this._applyStepForPercent(target)
      this.store.update(rec.id, { position: pos, motion: Object.assign({}, rec.motion, { path: path }) }, 'position')
    }

    /** 起始点/结束点 X/Y 在百分比模式 step=0.01；非百分比 step=1（包括初始化）*/
    _applyStepForPercent(isPercent) {
      const step = isPercent ? 0.01 : 1
      const ids = ['#pa-pos-sx', '#pa-pos-sy', '#pa-pos-ex', '#pa-pos-ey']
      ids.forEach(id => {
        const el = this.root.querySelector(id)
        if (el) el.step = step
      })
    }

    onStore(evt, id, field) {
      if (evt === 'select') {
        this._syncCopyBtnVisible()
        // ★ 批量选择(>1)时显示"目前正在批量选择"提示,不加载单条参数
        if (this.store.selectedIds.size > 1) {
          this.showBatch()
          return
        }
        const rec = this.store.getSelected()
        if (rec && rec.type === 'advanced') this.load(rec)
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

    load(rec) {
      this._loading = true
      this.boundId = rec.id
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.add('hide')
      this.bodyEl.classList.add('show')
      this._syncCopyBtnVisible() // 已选中高级弹幕 → 复制按钮出现

      const isDraft = this.store.draft === rec
      if (this.sendBtn) {
        this.sendBtn.textContent = isDraft ? '发送' : '更改'
        this.sendBtn.title = isDraft ? '校验参数并发送' : '校验参数并更改'
      }

      this._setVal(this.contentEl, rec.content)
      this._setVal(this.senderEl, rec.sender || '')
      // ★ 发送时间戳:只读显示,不能直接编辑;发送/更改按钮触发时会写入新时间戳
      if (this.sentAtEl) this._setVal(this.sentAtEl, global.TimeUtil.tsToLocal(rec.sentAt))
      // ★ pa-time 显示格式:总是精确到小数点后两位 hh:mm:ss.cc
      //   - useCurrentTime = true:显示当前播放时钟的当前时间(固定两位小数),input 仍允许用户改(不再常亮按钮)
      //   - useCurrentTime = false:显示该弹幕的实际出现时间
      const displaySec = rec.useCurrentTime
        ? Number.isFinite(this.engine && this.engine.clock && typeof this.engine.clock.now === 'function' ? this.engine.clock.now() : 0)
          ? this.engine.clock.now()
          : 0
        : rec.timeSec
      this._setVal(this.timeEl, global.TimeUtil.timeToStr2(displaySec))
      this.timeEl.placeholder = rec.useCurrentTime ? '按当前时间(自动)' : '00:00:02.00'
      this.timeEl.disabled = false // 不再禁用,两种情况都允许用户手动改
      // ★ 移除「当前时间」按钮的常亮样式(不再 toggle active)
      void rec.useCurrentTime

      this._setVal(this.colorTextEl, rec.style.color)
      this.colorEl.value = rec.style.color
      this._setVal(this.familyEl, rec.style.fontFamily)
      this._setVal(this.strokeEl, rec.style.stroke ? '1' : '0')
      this._setVal(this.linearEl, rec.motion.linear ? '0' : '1')
      this._setVal(this.motTypeEl, rec.motion.type)
      this.percentEl.checked = !!rec.position.usePercent
      this._applyStepForPercent(!!rec.position.usePercent)
      // ★ 增强开关同步
      const boost = !!rec._boost
      if (this.boostEl) this.boostEl.checked = boost
      this._applyBoostToFields(boost)

      for (const fieldDef of NUM_FIELDS) {
        const sel = fieldDef[0]
        const path = fieldDef[1]
        const input = this.root.querySelector(sel)
        const obj = this._getByPath(rec, path)
        if (input && obj != null) {
          // ★ 若增强开且值超出普通范围,也按增强范围直接写入不钳制
          this._setVal(input, obj)
        }
      }

      // ★ 路径跟随(path)模式不符合B站要求,不开放:
      //   1. 若加载的已存数据是 path,提示并强制转成 position
      if (rec.motion.type === 'path') {
        this._toast('该运动模式的方法不符合b站要求,故不开放;当前弹幕已切换为「起始位置(position)」模式')
        this.store.updateDeep(rec.id, 'motion.type', 'position')
        this.store.updateDeep(rec.id, 'motion.path', [])
        this._loading = true
        this.motTypeEl.value = 'position'
        this._loading = false
      }
      this.refreshPickButtons()
      this._loading = false
    }

    clear() {
      this.boundId = null
      this.emptyEl.classList.remove('hide')
      if (this.batchEl) this.batchEl.classList.add('hide')
      this.bodyEl.classList.remove('show')
      this.editor.cancelPick()
      this._syncCopyBtnVisible() // 清空时保留显示条件(有最近发送过则仍显示)
      if (this.sendBtn) {
        this.sendBtn.textContent = '发送'
        this.sendBtn.title = '校验参数并发送'
      }
    }

    /** ★ 批量选择时显示提示,隐藏正文与空提示 */
    showBatch() {
      this.boundId = null
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      this.bodyEl.classList.remove('show')
      this.editor.cancelPick()
      this._syncCopyBtnVisible()
    }

    _getByPath(obj, path) {
      return path.split('.').reduce((o, k) => (o == null ? null : o[k]), obj)
    }

    _setVal(input, value) {
      if (!input) return
      const target = String(value == null ? '' : value)
      if (String(input.value) !== target) input.value = target
    }

    /** ★ 根据增强开关切换:更新 input 的 max/min 属性与标签文案(提示范围)。 */
    _applyBoostToFields(boost) {
      const loLife = 0
      const hiLife = boost ? BOOST_MAX_LIFE : NORM_MAX_LIFE
      const hiMs = boost ? BOOST_MAX_MS : NORM_MAX_MOVE
      if (this.lifeDurEl) this.lifeDurEl.max = hiLife
      if (this.motMoveEl) this.motMoveEl.max = hiMs
      if (this.motDelayEl) this.motDelayEl.max = hiMs
      if (this.lifeDurLabel) this.lifeDurLabel.textContent = '生存时间(' + loLife + '~' + hiLife + (boost ? '秒,增强' : '秒') + ')'
      if (this.motMoveLabel) this.motMoveLabel.textContent = '运动耗时(' + loLife + '~' + hiMs + (boost ? ',增强' : '') + ')'
      if (this.motDelayLabel) this.motDelayLabel.textContent = '延迟(' + loLife + '~' + hiMs + (boost ? ',增强' : '') + ')'
    }

    /** 轻量 toast,复用 player.js 同款 DOM;无 player 引用时直接写 DOM。*/
    _toast(msg, opts) {
      const el = document.getElementById('toast')
      if (!el) return
      el.textContent = msg
      const isError = !!(opts && opts.error)
      el.classList.toggle('error', isError)
      el.classList.add('show')
      clearTimeout(this._toastTimer)
      const dur = (opts && opts.duration) || 2000
      this._toastTimer = setTimeout(() => el.classList.remove('show'), dur)
    }

    /** CSS font-family 值 → 英文代码(SimHei/SimSun/NSimSun/FangSong/MicrosoftYaHei) */
    _fontToRawCode(family) {
      const s = String(family == null ? '' : family).trim()
      if (s.indexOf('Microsoft YaHei') !== -1) return 'MicrosoftYaHei'
      if (s.indexOf('SimHei') !== -1) return 'SimHei'
      if (s.indexOf('NSimSun') !== -1) return 'NSimSun'
      if (s.indexOf('SimSun') !== -1) return 'SimSun'
      if (s.indexOf('FangSong') !== -1) return 'FangSong'
      return 'SimHei'
    }

    refreshPickButtons() {
      const picking = this.editor.pickMode
      const btns = this.root.querySelectorAll('.pa-pick[data-field]')
      for (const b of btns) {
        b.classList.toggle('active', picking === 'single' && b.getAttribute('data-field') === this.editor.pickField)
      }
    }
  }

  global.PanelAdvanced = PanelAdvanced
})(window)
