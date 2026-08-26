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
      this.batchBodyEl = root.querySelector('.pa-batch-body') // ★ 激活态:批量修改坐标等表单
      this.batchCoordWarnEl = document.getElementById('pa-batch-coord-warn')
      this.batchSxEl = document.getElementById('pa-batch-sx')
      this.batchSyEl = document.getElementById('pa-batch-sy')
      this.batchExEl = document.getElementById('pa-batch-ex')
      this.batchEyEl = document.getElementById('pa-batch-ey')
      this.sendBtn = root.querySelector('#pa-send')
      // ★ 批量底部操作栏(立即展示效果 / 清除预览 / 预览 / 更改) —— 仅在深度批量纯高级时显示
      this.batchSendRowEl = root.querySelector('.pa-batch-send-row')
      this.batchImmEl = document.getElementById('pa-batch-immediate')
      this.batchClearPrevBtn = document.getElementById('pa-batch-clear-preview')
      this.batchPrevBtn = document.getElementById('pa-batch-preview')
      this.batchChangeBtn = document.getElementById('pa-batch-change')
      // ★ 「复制」按钮在 #panel-advanced 的父级标题栏(#panel-advanced-wrap 内),所以从 document 查找(避免 root.querySelector 找不到)
      this.copyBtn = document.getElementById('pa-copy') || (global.DomUtil && global.DomUtil.$ ? global.DomUtil.$('#pa-copy') : null)
      this.backBatchBtn = document.getElementById('pa-back-batch')
      this.contentEl = root.querySelector('#pa-content')
      this.timeEl = root.querySelector('#pa-time')
      this.timeNowBtn = root.querySelector('#pa-time-now')
      this.senderEl = root.querySelector('#pa-sender')
      this.ctimeEl = root.querySelector('#pa-sent-at') // ★ ctime(发送时间戳)只读
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
      this._wireBatchCoordInputs()

      // ★ 「复制」按钮:用指定的高级弹幕参数创建一个新草稿
      if (this.copyBtn) {
        this.copyBtn.addEventListener('click', () => {
          this._doCopyFromSource()
        })
      }
      // ★ 「返回批量」按钮:从批量偏离态的单选弹幕回到深度批量激活态
      if (this.backBatchBtn) {
        this.backBatchBtn.addEventListener('click', () => {
          const list = global.window.App && global.window.App.list
          if (list && list._batchIds && list._batchIds.size >= 2) {
            this.store.selectRange(Array.from(list._batchIds))
          }
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

      // batch unify button
      this._unifyBtn = document.getElementById('pa-batch-unify')
      this._unifyModal = document.getElementById('pa-batch-unify-modal')
      this._unifyContent = document.getElementById('pa-batch-unify-content')
      this._unifyCloseBtn = document.getElementById('pa-batch-unify-close')
      this._unifyCancelBtn = document.getElementById('pa-batch-unify-cancel')
      this._unifyApplyBtn = document.getElementById('pa-batch-unify-apply')
      if (this._unifyBtn) this._unifyBtn.addEventListener('click', () => this._openUnifyModal())
      if (this._unifyCloseBtn) this._unifyCloseBtn.addEventListener('click', () => this._closeUnifyModal())
      if (this._unifyCancelBtn) this._unifyCancelBtn.addEventListener('click', () => this._closeUnifyModal())
      if (this._unifyApplyBtn) this._unifyApplyBtn.addEventListener('click', () => this._applyUnifyParams())
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._unifyModal && !this._unifyModal.hidden) this._closeUnifyModal()
      })

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
        // 判定:是否有「深度批量候选」(list._batchIds 自身满足 >=2 且全高级非草稿,无关于 selectedIds 匹配与否)
        let hasDeepCandidate = false
        try {
          const list = global.window.App && global.window.App.list
          if (list && list._isDeepCandidate && typeof list._isDeepCandidate === 'function') {
            hasDeepCandidate = !!list._isDeepCandidate()
          }
        } catch (_) { hasDeepCandidate = false }
        const size = this.store.selectedIds ? this.store.selectedIds.size : 0
        const isDeepActive = typeof this.store.isDeepBatchAdvanced === 'function' ? this.store.isDeepBatchAdvanced() : false

        // ★ 优先级:
        //  - 深度激活态(selectedIds 与 list._batchIds 完全一致且全高级>=2):完整批量面板
        //  - 深度候选偏离态 + 单选某弹幕:显示该弹幕的操作面板(D8),保留 _batchIds
        //  - 深度候选偏离态 + 多选:只显示 pa-batch 文本
        //  - 普通多选(size>1,但非深度候选):显示 pa-batch 文本
        //  - 单选高级(type==advanced):load 单弹面板
        //  - 其他(无选中或单选普通):显示空提示
        if (isDeepActive) {
          this.showBatch(true)
          return
        }
        if (hasDeepCandidate) {
          if (size === 1) {
            // D8: 批量偏离态下单选某弹幕 → 显示该弹幕操作面板
            const rec = this.store.getSelected()
            if (rec && rec.type === 'advanced') {
              this.load(rec)
              this._showBackToBatchBtn(true)
            } else {
              this.clear()
              this._showBackToBatchBtn(false)
            }
          } else {
            this.showBatchDeviated()
            this._showBackToBatchBtn(false)
          }
          return
        }
        this._showBackToBatchBtn(false)
        if (size > 1) {
          this.showBatch(false)
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
      if (this.batchBodyEl) this.batchBodyEl.classList.add('hide') // 单选时隐藏批量坐标表单
      this.bodyEl.classList.add('show')
      // ★ 单选加载:隐藏批量底部操作栏(避免与单选正文重合)
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = true
      this._syncCopyBtnVisible() // 已选中高级弹幕 → 复制按钮出现

      const isDraft = this.store.draft === rec
      if (this.sendBtn) {
        this.sendBtn.textContent = isDraft ? '发送' : '更改'
        this.sendBtn.title = isDraft ? '校验参数并发送' : '校验参数并更改'
      }

      this._setVal(this.contentEl, rec.content)
      this._setVal(this.senderEl, rec.sender || '')
      // ★ ctime(发送时间戳):只读显示,不能直接编辑;发送/更改按钮触发时会写入新时间戳
      if (this.ctimeEl) this._setVal(this.ctimeEl, global.TimeUtil.tsToLocal(rec.ctime))
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
      if (this.batchBodyEl) this.batchBodyEl.classList.add('hide') // 清空时也隐藏批量坐标表单
      this.bodyEl.classList.remove('show')
      // ★ 清空(非选中态):批量底部操作栏隐藏
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = true
      this.editor.cancelPick()
      this._syncCopyBtnVisible() // 清空时保留显示条件(有最近发送过则仍显示)
      if (this.sendBtn) {
        this.sendBtn.textContent = '发送'
        this.sendBtn.title = '校验参数并发送'
      }
    }

    /** ★ 偏离态批量:只显示 pa-batch 文本,隐藏所有表单/底部栏(用于「深度批量候选存在,但当前单选/轻度多选其他弹幕」)。*/
    showBatchDeviated() {
      this.boundId = null
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      if (this.batchBodyEl) this.batchBodyEl.classList.add('hide') // ★ 偏离态:隐藏批量坐标表单
      this.bodyEl.classList.remove('show')
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = true // ★ 偏离态:隐藏批量底部栏
      this.editor.cancelPick()
      this._syncCopyBtnVisible()
    }

    /** ★ 批量选择时显示提示;激活态(isDeepAdvanced=true)额外显示「批量坐标表单 + 底部批量操作栏」。
     * @param {boolean} [isDeepAdvanced=false] 是否处于深度批量纯高级激活态*/
    showBatch(isDeepAdvanced) {
      const deep = !!isDeepAdvanced
      this.boundId = null
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      this.bodyEl.classList.remove('show')
      // ★ 仅激活态:显示批量坐标表单 + 底部批量 4 控件
      if (this.batchBodyEl) {
        if (deep) {
          this.batchBodyEl.classList.remove('hide')
          // 初始化批量坐标输入框:用当前批量选中的所有弹幕的联合 bbox 左上角像素(逻辑 px,非屏幕 px)作为初值
          this._fillBatchCoordInputs()
        } else {
          this.batchBodyEl.classList.add('hide')
        }
      }
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = !deep
      this.editor.cancelPick()
      this._syncCopyBtnVisible()
    }

    /** ★ 深度批量激活态:把「批量选中的所有弹幕联合 bbox 的左上角」作为批量修改坐标的初值,
     *  单位统一换算成「逻辑像素(存盘时的 px,按 displayScale 反向换算)」。
     *  若有任意弹幕用百分比 → 自动转换成 px 并显示提示。*/
    _fillBatchCoordInputs() {
      if (!this.batchSxEl) return
      try {
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : new Set()
        if (ids.size < 2) return
        const displayScale = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
        const W = this.engine.width
        const H = this.engine.height
        // 1. 判断是否有百分比坐标弹幕(需要提示)
        let hasPercent = false
        // 2. 所有弹幕的 startX/Y(逻辑坐标:若百分比 → 按 displayScale 转换成逻辑 px)的最小值,作为初值
        let minSX = Infinity, minSY = Infinity
        let minEX = Infinity, minEY = Infinity
        for (const id of ids) {
          const rec = this.store.get(id)
          if (!rec || !rec.position) continue
          const usePct = !!rec.position.usePercent
          if (usePct) hasPercent = true
          const toLogicalPxX = (u) => {
            if (usePct) {
              // 百分比 → 屏幕像素 × W → 再 ÷ displayScale 得逻辑 px(需求:全部统一为 px 单位)
              const screenPx = u * W
              return displayScale > 0 ? (screenPx / displayScale) : screenPx
            }
            return u // 已经是逻辑 px
          }
          const toLogicalPxY = (u) => {
            if (usePct) {
              const screenPx = u * H
              return displayScale > 0 ? (screenPx / displayScale) : screenPx
            }
            return u
          }
          const sx = toLogicalPxX(rec.position.startX)
          const sy = toLogicalPxY(rec.position.startY)
          const ex = toLogicalPxX(rec.position.endX)
          const ey = toLogicalPxY(rec.position.endY)
          if (sx < minSX) minSX = sx
          if (sy < minSY) minSY = sy
          if (ex < minEX) minEX = ex
          if (ey < minEY) minEY = ey
        }
        if (!isFinite(minSX)) return
        this.batchSxEl.value = String(Math.round(minSX))
        this.batchSyEl.value = String(Math.round(minSY))
        this.batchExEl.value = String(Math.round(minEX))
        this.batchEyEl.value = String(Math.round(minEY))
        // 百分比 → 显示提示
        if (this.batchCoordWarnEl) {
          if (hasPercent) this.batchCoordWarnEl.classList.remove('hide')
          else this.batchCoordWarnEl.classList.add('hide')
        }
      } catch (_) {}
    }

    /** ★ 绑定批量坐标 4 个输入框:修改任意一个即做「相对偏移」。
     *  逻辑:以「批量框左上角(boxMinXlog, boxMinYlog 逻辑 px)」为相对位置,
     *  SX/SY 改 → 起始点的相对量 dx=新值−boxMinXlog / dy=新值−boxMinYlog;
     *  EX/EY 改 → 结束点的相对量。每条弹幕:
     *    新 起始X = 原 起始X + dx,新 结束X = 原 结束X + dx(X 同理)。
     *  若该弹幕原来是百分比 → 自动转为 px(按 displayScale 换算)并提示。*/
    _wireBatchCoordInputs() {
      if (!this.batchSxEl) return
      const self = this
      const computeBoxMin = () => {
        // 展回到逻辑 px 的「批量框左上角」(取所有 起始/结束 坐标的最小值)
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : (self.store.selectedIds || new Set())
        if (!ids || ids.size < 2) return null
        const displayScale = (self.engine.displayScale != null && isFinite(self.engine.displayScale)) ? Number(self.engine.displayScale) : 1
        const W = self.engine.width
        const H = self.engine.height
        const toLogPx = (u, axis, usePct) => {
          if (usePct) {
            const screenPx = u * (axis === 'x' ? W : H)
            return displayScale > 0 ? (screenPx / displayScale) : screenPx
          }
          return u
        }
        let minX = Infinity, minY = Infinity
        for (const id of ids) {
          const rec = self.store.get(id)
          if (!rec || !rec.position) continue
          const up = !!rec.position.usePercent
          minX = Math.min(minX, toLogPx(rec.position.startX, 'x', up), toLogPx(rec.position.endX, 'x', up))
          minY = Math.min(minY, toLogPx(rec.position.startY, 'y', up), toLogPx(rec.position.endY, 'y', up))
        }
        return (isFinite(minX) && isFinite(minY)) ? { x: minX, y: minY } : null
      }
      const applyDelta = (which) => {
        const box = computeBoxMin()
        if (!box) return
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : (self.store.selectedIds || new Set())
        const displayScale = (self.engine.displayScale != null && isFinite(self.engine.displayScale)) ? Number(self.engine.displayScale) : 1
        const W = self.engine.width
        const H = self.engine.height
        let hasPercent = false
        let applied = 0
        const readCoord = (el) => {
          const n = parseFloat(el && el.value)
          return isFinite(n) ? Math.round(n) : null
        }
        const sxV = readCoord(self.batchSxEl); const syV = readCoord(self.batchSyEl)
        const exV = readCoord(self.batchExEl); const eyV = readCoord(self.batchEyEl)
        if (sxV == null || syV == null || exV == null || eyV == null) return
        // 相对量:输入值 − 批量框左上角
        const relSX = sxV - box.x, relSY = syV - box.y
        const relEX = exV - box.x, relEY = eyV - box.y
        for (const id of ids) {
          const rec = self.store.get(id)
          if (!rec || !rec.position) continue
          const up = !!rec.position.usePercent
          if (up) hasPercent = true
          // 转到逻辑 px 原值
          const toLogX = (u) => up ? ((u * W / (displayScale > 0 ? displayScale : 1))) : u
          const toLogY = (u) => up ? ((u * H / (displayScale > 0 ? displayScale : 1))) : u
          const oSX = toLogX(rec.position.startX), oSY = toLogY(rec.position.startY)
          const oEX = toLogX(rec.position.endX), oEY = toLogY(rec.position.endY)
          // 统一切到 px 模式
          self.store.updateDeep(id, 'position.usePercent', false)
          if (which === 'S') {
            self.store.updateDeep(id, 'position.startX', clamp(...[oSX + relSX, 0, 9999]))
            self.store.updateDeep(id, 'position.startY', clamp(...[oSY + relSY, 0, 9999]))
          } else {
            self.store.updateDeep(id, 'position.endX', clamp(...[oEX + relEX, 0, 9999]))
            self.store.updateDeep(id, 'position.endY', clamp(...[oEY + relEY, 0, 9999]))
          }
          applied++
        }
        if (hasPercent) self._toast('已将 ' + applied + ' 条弹幕相对偏移(由百分比自动转换为像素 px,displayScale=' + displayScale + ')')
        else self._toast('已相对偏移 ' + applied + ' 条弹幕(px)')
        // 偏移后刷新初值,方便继续微调
        self._fillBatchCoordInputs()
      }
      const wire = (el, which) => {
        if (!el) return
        el.addEventListener('change', () => applyDelta(which))
      }
      wire(self.batchSxEl, 'S')
      wire(self.batchSyEl, 'S')
      wire(self.batchExEl, 'E')
      wire(self.batchEyEl, 'E')
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
        const field = b.getAttribute('data-field')
        if (field && field.indexOf('batch-') === 0) {
          b.classList.toggle('active', picking === 'single' && this.editor.pickField === field)
        } else {
          b.classList.toggle('active', picking === 'single' && field === this.editor.pickField)
        }
      }
    }

    setBatchPickCoords(field, x, y) {
      if (!this.batchSxEl) return
      const displayScale = (this.engine.displayScale != null && isFinite(this.engine.displayScale)) ? Number(this.engine.displayScale) : 1
      const toLogPx = (px) => displayScale > 0 ? Math.round(px / displayScale) : Math.round(px)
      const lx = clamp(toLogPx(x), 0, 9999)
      const ly = clamp(toLogPx(y), 0, 9999)
      if (field === 'batch-start') {
        this._setVal(this.batchSxEl, lx)
        this._setVal(this.batchSyEl, ly)
      } else if (field === 'batch-end') {
        this._setVal(this.batchExEl, lx)
        this._setVal(this.batchEyEl, ly)
      }
      const evt = new Event('change', { bubbles: true })
      if (field === 'batch-start') {
        this.batchSxEl.dispatchEvent(evt)
        this.batchSyEl.dispatchEvent(evt)
      } else {
        this.batchExEl.dispatchEvent(evt)
        this.batchEyEl.dispatchEvent(evt)
      }
      this._toast('已拾取坐标(' + lx + ', ' + ly + '),批量偏移已应用')
    }

    _openUnifyModal() {
      if (!this._unifyModal) return
      this._buildUnifyContent()
      this._unifyModal.hidden = false
    }

    _closeUnifyModal() {
      if (!this._unifyModal) return
      this._unifyModal.hidden = true
    }

    _applyUnifyParams() {
      // ★ 遍历深度批量选中的高级弹幕,根据弹窗中勾选的参数与目标值更新对应字段
      let batchIds = null
      try {
        const list = global.window.App && global.window.App.list
        if (list && list._batchIds && list._batchIds.size >= 2) batchIds = list._batchIds
      } catch (_) {}
      if (!batchIds) {
        this._toast('请先深度批量选中至少 2 条高级弹幕', { error: true })
        return
      }
      const get = (cid) => { const el = document.getElementById(cid); return el && el.checked }
      const val = (vid) => { const el = document.getElementById(vid); return el ? el.value : '' }
      const num = (vid) => { const n = parseFloat(val(vid)); return isNaN(n) ? null : n }
      const C2 = global.ColorUtil
      const tasks = []
      if (get('pa-unify-content')) tasks.push({ path: 'content', value: val('pa-unify-content-val') })
      if (get('pa-unify-time')) {
        const t = global.TimeUtil.strToTime(val('pa-unify-time-val'))
        if (t != null) tasks.push({ path: 'timeSec', value: round2(t) })
      }
      if (get('pa-unify-sender')) tasks.push({ path: 'sender', value: val('pa-unify-sender-val') || '' })
      if (get('pa-unify-color')) {
        const hex = C2 && C2.parseColor ? C2.parseColor(val('pa-unify-color-text')) : null
        if (hex) tasks.push({ path: 'style.color', value: hex })
      }
      if (get('pa-unify-font')) {
        const f = val('pa-unify-font-val')
        tasks.push({ path: 'style.fontFamily', value: f })
        tasks.push({ path: 'style.fontFamilyRaw', value: this._fontToRawCode(f) })
      }
      if (get('pa-unify-size')) { const n = num('pa-unify-size-val'); if (n != null) tasks.push({ path: 'style.fontSize', value: clamp(Math.round(n), 10, 127) }) }
      if (get('pa-unify-stroke')) tasks.push({ path: 'style.stroke', value: val('pa-unify-stroke-val') === '1' })
      if (get('pa-unify-rot-z')) { const n = num('pa-unify-rot-z-val'); if (n != null) tasks.push({ path: 'rotation.z', value: round1(clamp(n, 0, 360)) }) }
      if (get('pa-unify-rot-y')) { const n = num('pa-unify-rot-y-val'); if (n != null) tasks.push({ path: 'rotation.y', value: round1(clamp(n, 0, 360)) }) }
      if (get('pa-unify-boost')) tasks.push({ path: '_boost', value: true })
      if (get('pa-unify-life-dur')) { const n = num('pa-unify-life-dur-val'); if (n != null) tasks.push({ path: 'life.duration', value: round2(clamp(n, 0, 10)) }) }
      if (get('pa-unify-life-opstart')) { const n = num('pa-unify-life-opstart-val'); if (n != null) tasks.push({ path: 'life.opacityStart', value: round2(clamp(n, 0, 1)) }) }
      if (get('pa-unify-life-opend')) { const n = num('pa-unify-life-opend-val'); if (n != null) tasks.push({ path: 'life.opacityEnd', value: round2(clamp(n, 0, 1)) }) }
      // ★ 运动方式:不开放 path,只接受 position
      if (get('pa-unify-mot-type') && val('pa-unify-mot-type-val') !== 'path') tasks.push({ path: 'motion.type', value: 'position' })
      if (get('pa-unify-mot-linear')) tasks.push({ path: 'motion.linear', value: val('pa-unify-mot-linear-val') === '0' })
      if (get('pa-unify-mot-move')) { const n = num('pa-unify-mot-move-val'); if (n != null) tasks.push({ path: 'motion.moveDuration', value: round1(clamp(n, 0, 10000)) }) }
      if (get('pa-unify-mot-delay')) { const n = num('pa-unify-mot-delay-val'); if (n != null) tasks.push({ path: 'motion.delay', value: round1(clamp(n, 0, 10000)) }) }
      // ★ 空间与坐标定位:已删除「启用百分比」「启用自动转换」开关,只保留按百分比(直接控制 usePercent)
      if (get('pa-unify-pos-mode') && val('pa-unify-pos-mode-val') !== 'path') tasks.push({ path: 'motion.type', value: 'position' })
      if (get('pa-unify-pos-percent')) {
        const el = document.getElementById('pa-unify-pos-percent-val')
        tasks.push({ path: 'position.usePercent', value: !!(el && el.checked) })
      }
      if (get('pa-unify-pos-sx')) { const n = num('pa-unify-pos-sx-val'); if (n != null) tasks.push({ path: 'position.startX', value: round1(clamp(n, 0, 9999)) }) }
      if (get('pa-unify-pos-sy')) { const n = num('pa-unify-pos-sy-val'); if (n != null) tasks.push({ path: 'position.startY', value: round1(clamp(n, 0, 9999)) }) }
      if (get('pa-unify-pos-ex')) { const n = num('pa-unify-pos-ex-val'); if (n != null) tasks.push({ path: 'position.endX', value: round1(clamp(n, 0, 9999)) }) }
      if (get('pa-unify-pos-ey')) { const n = num('pa-unify-pos-ey-val'); if (n != null) tasks.push({ path: 'position.endY', value: round1(clamp(n, 0, 9999)) }) }

      if (!tasks.length) {
        this._toast('请至少勾选一个参数并填写目标值', { error: true })
        return
      }
      let applied = 0
      for (const id of batchIds) {
        const rec = this.store.get(id)
        if (!rec || rec.type !== 'advanced' || rec === this.store.draft) continue
        for (const t of tasks) {
          this.store.updateDeep(id, t.path, t.value)
        }
        applied++
      }
      this._toast('已对 ' + applied + ' 条弹幕统一参数(共 ' + tasks.length + ' 个字段)')
      this._closeUnifyModal()
    }

    _showBackToBatchBtn(show) {
      if (this.backBatchBtn) this.backBatchBtn.hidden = !show
    }

    _buildUnifyContent() {
      if (!this._unifyContent) return
      const h = (tag, attrs, children) => {
        const el = document.createElement(tag)
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k])
        if (children) {
          if (Array.isArray(children)) children.forEach(c => { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) })
          else el.appendChild(typeof children === 'string' ? document.createTextNode(children) : children)
        }
        return el
      }
      // ★ row(checkId, valueEls):勾选 id 与一个或多个值元素绑定;
      //   未勾选时,所有值元素置灰(disabled + pa-unify-disabled 类),不能交互
      const label = (text, checkId, valEl) => {
        const wrap = h('div', { class: 'pa-row' })
        const cb = h('input', { type: 'checkbox', id: checkId })
        const lbl = h('label', { class: 'pa-unify-check' }, [cb, document.createTextNode(text)])
        wrap.appendChild(lbl)
        const field = h('div', { class: 'pa-field' })
        const items = Array.isArray(valEl) ? valEl : [valEl]
        items.forEach(v => field.appendChild(v))
        wrap.appendChild(field)
        // ★ 交互:勾选/取消勾选时,切换值元素的 disabled 状态(未勾选=置灰不能交互)
        const sync = () => {
          const dis = !cb.checked
          items.forEach(el2 => {
            if (!el2 || el2.tagName === 'OPTION') return
            el2.disabled = dis
            if (dis) el2.classList.add('pa-unify-disabled')
            else el2.classList.remove('pa-unify-disabled')
          })
        }
        cb.addEventListener('change', sync)
        // 初始:未勾选 → 置灰
        sync()
        return wrap
      }
      const numInput = (id, val, min, max, step) =>
        h('input', { type: 'number', id: id, value: val, min: min, max: max, step: step })
      const textInput = (id, val, placeholder) =>
        h('input', { type: 'text', id: id, value: val || '', placeholder: placeholder || '' })
      // ★ select:options 数组中 [value,label,disabled] 第三项可禁用某项(用于禁用"路径跟随")
      const select = (id, options, val) => {
        const sel = h('select', { id: id })
        for (const o of options) {
          const opt = h('option', { value: o[0] }, o[1])
          if (o[0] === val) opt.setAttribute('selected', 'selected')
          if (o[2]) opt.setAttribute('disabled', 'disabled')
          sel.appendChild(opt)
        }
        return sel
      }
      const groupTitle = (text) => h('div', { class: 'pa-group-title' }, text)
      const group = (title, rows) => {
        const g = h('div', { class: 'pa-group' })
        g.appendChild(groupTitle(title))
        rows.forEach(r => g.appendChild(r))
        return g
      }
      const groupTitleRow = (title, extra) => {
        const row = h('div', { class: 'pa-group-title-row' })
        row.appendChild(groupTitle(title))
        if (extra) row.appendChild(extra)
        return row
      }

      this._unifyContent.innerHTML = ''
      this._unifyContent.appendChild(h('div', { class: 'pa-unify-hint' }, '勾选需要统一的参数,填写目标值后点击「应用统一参数」(未勾选的输入框置灰不可交互)'))

      // 1. 弹幕正文
      this._unifyContent.appendChild(group('弹幕正文', [
        label('弹幕正文', 'pa-unify-content', h('textarea', { id: 'pa-unify-content-val', rows: '2', maxlength: '255', placeholder: '输入弹幕内容…' }))
      ]))

      // 2. 基础信息
      this._unifyContent.appendChild(group('基础信息', [
        label('出现时间', 'pa-unify-time', textInput('pa-unify-time-val', '', '00:00:00.00')),
        label('发送人', 'pa-unify-sender', textInput('pa-unify-sender-val', '', '昵称'))
      ]))

      // 3. 外观样式
      const cf = h('div', { class: 'pa-field pa-color-line' })
      cf.appendChild(h('input', { type: 'text', id: 'pa-unify-color-text', placeholder: '#FFFFFF' }))
      cf.appendChild(h('input', { type: 'color', id: 'pa-unify-color' }))
      cf.appendChild(h('button', { class: 'pa-color-pick', id: 'pa-unify-color-pick', title: '点击后再点弹幕拾取颜色' }, '取色'))
      this._unifyContent.appendChild(group('外观样式', [
        label('颜色', 'pa-unify-color', cf),
        label('字体', 'pa-unify-font', select('pa-unify-font-val', [['SimHei','黑体'],['SimSun','宋体'],['NSimSun','新宋体'],['FangSong','仿宋'],['MicrosoftYaHei','微软雅黑']], 'SimHei')),
        label('字号', 'pa-unify-size', numInput('pa-unify-size-val', 25, 10, 127, 1)),
        label('加粗描边', 'pa-unify-stroke', select('pa-unify-stroke-val', [['0','否'],['1','是']], '0'))
      ]))

      // 4. 空间旋转
      this._unifyContent.appendChild(group('空间旋转(0~360)', [
        label('Z轴翻转', 'pa-unify-rot-z', numInput('pa-unify-rot-z-val', 0, 0, 360, 1)),
        label('Y轴翻转', 'pa-unify-rot-y', numInput('pa-unify-rot-y-val', 0, 0, 360, 1))
      ]))

      // 5. 生命与运动周期
      const bs = h('label', { class: 'pa-boost-switch' })
      bs.appendChild(h('input', { type: 'checkbox', id: 'pa-unify-boost' }))
      bs.appendChild(h('span', { class: 'pa-boost-slider' }))
      bs.appendChild(h('span', { class: 'pa-boost-label' }, '增强'))
      const g5 = h('div', { class: 'pa-group' })
      g5.appendChild(groupTitleRow('生命与运动周期', bs))
      ;[
        label('生存时间', 'pa-unify-life-dur', numInput('pa-unify-life-dur-val', 0, 0, 10, 0.01)),
        label('起始透明度', 'pa-unify-life-opstart', numInput('pa-unify-life-opstart-val', 1, 0, 1, 0.01)),
        label('结束透明度', 'pa-unify-life-opend', numInput('pa-unify-life-opend-val', 1, 0, 1, 0.01)),
        // ★ 禁用"路径跟随"选项(加 disabled 属性,不能点击)
        label('运动方式', 'pa-unify-mot-type', select('pa-unify-mot-type-val', [['position','起始位置'],['path','路径跟随(不开放)',true]], 'position')),
        label('线性运动', 'pa-unify-mot-linear', select('pa-unify-mot-linear-val', [['0','是'],['1','否(缓动)']], '0')),
        label('运动耗时', 'pa-unify-mot-move', numInput('pa-unify-mot-move-val', 0, 0, 10000, 0.1)),
        label('延迟', 'pa-unify-mot-delay', numInput('pa-unify-mot-delay-val', 0, 0, 10000, 0.1))
      ].forEach(r => g5.appendChild(r))
      this._unifyContent.appendChild(g5)

      // 6. 空间与坐标定位
      const g6 = h('div', { class: 'pa-group' })
      g6.appendChild(groupTitle('空间与坐标定位'))
      // tools row:仅保留「运动方式」(禁用 path) + 「按百分比」(直接控制 usePercent,无需"启用"开关)
      //   ★ 删除多余的「启用百分比」「启用自动转换」开关
      const tr = h('div', { class: 'pa-row pa-coord-tools' })
      const mk = h('label', { class: 'pa-unify-check' })
      mk.appendChild(h('input', { type: 'checkbox', id: 'pa-unify-pos-mode' }))
      mk.appendChild(document.createTextNode('运动方式'))
      tr.appendChild(mk)
      const mf = h('div', { class: 'pa-field' })
      // ★ 同样禁用"路径跟随"
      const posModeSel = select('pa-unify-pos-mode-val', [['position','起始位置'],['path','路径跟随(不开放)',true]], 'position')
      mf.appendChild(posModeSel)
      tr.appendChild(mf)
      const pk = h('label', { class: 'pa-unify-check' })
      const ppCb = h('input', { type: 'checkbox', id: 'pa-unify-pos-percent' })
      pk.appendChild(ppCb)
      pk.appendChild(document.createTextNode('按百分比'))
      tr.appendChild(pk)
      const pf = h('div', { class: 'pa-field pa-field-check' })
      const pl = h('label')
      const ppVal = h('input', { type: 'checkbox', id: 'pa-unify-pos-percent-val' })
      pl.appendChild(ppVal)
      pl.appendChild(document.createTextNode(' 启用'))
      pf.appendChild(pl)
      tr.appendChild(pf)
      // ★ 简化交互:勾选"按百分比"即同步启用,不允许独立操作 pos-percent-val
      ppVal.disabled = true
      ppVal.classList.add('pa-unify-disabled')
      ppCb.addEventListener('change', () => { ppVal.checked = ppCb.checked })
      g6.appendChild(tr)
      // start row
      const sr = h('div', { class: 'pa-row pa-coord' })
      ;(() => { const c = h('label',{class:'pa-unify-check'}); c.appendChild(h('input',{type:'checkbox',id:'pa-unify-pos-sx'})); c.appendChild(document.createTextNode('起始点 X')); sr.appendChild(c) })()
      sr.appendChild(h('div',{class:'pa-field'},[numInput('pa-unify-pos-sx-val',0,0,9999,1)]))
      ;(() => { const c = h('label',{class:'pa-unify-check'}); c.appendChild(h('input',{type:'checkbox',id:'pa-unify-pos-sy'})); c.appendChild(document.createTextNode('起始点 Y')); sr.appendChild(c) })()
      sr.appendChild(h('div',{class:'pa-field'},[numInput('pa-unify-pos-sy-val',0,0,9999,1)]))
      g6.appendChild(sr)
      // end row
      const er = h('div', { class: 'pa-row pa-coord' })
      ;(() => { const c = h('label',{class:'pa-unify-check'}); c.appendChild(h('input',{type:'checkbox',id:'pa-unify-pos-ex'})); c.appendChild(document.createTextNode('结束点 X')); er.appendChild(c) })()
      er.appendChild(h('div',{class:'pa-field'},[numInput('pa-unify-pos-ex-val',0,0,9999,1)]))
      ;(() => { const c = h('label',{class:'pa-unify-check'}); c.appendChild(h('input',{type:'checkbox',id:'pa-unify-pos-ey'})); c.appendChild(document.createTextNode('结束点 Y')); er.appendChild(c) })()
      er.appendChild(h('div',{class:'pa-field'},[numInput('pa-unify-pos-ey-val',0,0,9999,1)]))
      g6.appendChild(er)
      // ★ 对工具行的"运动方式"也应用"未勾选→置灰"逻辑
      const modeCb = tr.querySelector('#pa-unify-pos-mode')
      const syncMode = () => {
        posModeSel.disabled = !modeCb.checked
        posModeSel.classList.toggle('pa-unify-disabled', !modeCb.checked)
      }
      modeCb.addEventListener('change', syncMode)
      syncMode()
      this._unifyContent.appendChild(g6)
    }
  }

  global.PanelAdvanced = PanelAdvanced
})(window)
