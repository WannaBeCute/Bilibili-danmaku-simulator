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
      // ★ 固定(起始点=结束点)开关:单条 + 批量
      this.fixedEl = root.querySelector('#pa-pos-fixed')
      this.posExEl = root.querySelector('#pa-pos-ex')
      this.posEyEl = root.querySelector('#pa-pos-ey')
      this.endPickBtn = root.querySelector('.pa-pick[data-field="end"]')
      this.batchFixedEl = root.querySelector('#pa-batch-pos-fixed')
      this.batchEndPickBtn = root.querySelector('.pa-pick[data-field="batch-end"]')
      // ★ 导入歌词(lrc):按钮 + 歌词模式提示 + 歌词说明条
      this.lrcBtn = root.querySelector('#pa-import-lrc')
      this.lrcTipEl = root.querySelector('#pa-lrc-tip')
      this.lrcInfoEl = root.querySelector('#pa-lrc-info')
      this._lrcMode = false
      this._lrcRecId = null
      // ★ 歌词模式缓存:完整LRC文本与解析结果(草稿 content 只写第一条,用于舞台预览)
      this._lrcFullText = null
      this._lrcParsed = null

      this._wireFields()
      this._wireBatchCoordInputs()

      // ★ 批量「固定(起始点=结束点)」开关
      if (this.batchFixedEl) {
        this.batchFixedEl.addEventListener('change', () => {
          if (this._loading) return
          this._applyBatchFixed(this.batchFixedEl.checked)
        })
      }

      // ★ 「复制」按钮:用指定的高级弹幕参数创建一个新草稿
      if (this.copyBtn) {
        this.copyBtn.addEventListener('click', () => {
          this._doCopyFromSource()
        })
      }
      // ★ 「返回批量」按钮:从批量偏离态的单选弹幕回到深度批量激活态
      //   ★ 若当前是未保存的草稿(深度批量期间点了"添加弹幕"),直接删除草稿 + 清理舞台实例,
      //     防止出现"僵尸草稿":添加草稿后返回批量,草稿不入池但实例留在舞台上无法删除
      if (this.backBatchBtn) {
        this.backBatchBtn.addEventListener('click', () => {
          const store = this.store
          const list = global.window.App && global.window.App.list
          const engine = global.window.App && global.window.App.engine
          // 1. 清理未保存的草稿
          if (store.draft) {
            const draftId = store.draft.id
            if (draftId && engine && engine.advanced) {
              engine.advanced.removeById(draftId)
            }
            store.draft = null
          }
          // 2. 回到深度批量态
          if (list && list._batchIds && list._batchIds.size >= 2) {
            store.selectRange(Array.from(list._batchIds))
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
      // ★ 初始化回补:构造前 store 可能已经有选中记录(与 panel-normal 同样的原因)
      {
        const cur = this.store.getSelected()
        const size = this.store.selectedIds ? this.store.selectedIds.size : 0
        if (size > 1) {
          // 仅全部高级选中 → showBatch(true);否则 showBatch(false) 走浅批量态
          let allAdv = true
          if (size >= 2) {
            for (const sid of this.store.selectedIds) {
              const r = this.store.get(sid)
              if (!r || r.type !== 'advanced') { allAdv = false; break }
            }
          }
          this.showBatch(allAdv)
        } else if (cur && cur.type === 'advanced') this.load(cur)
      }
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

    /** ★ 「导入歌词(lrc)」按钮显示规则:仅在「添加新弹幕」面板(绑定草稿,按钮为「发送」)显示;
     *  修改已有弹幕的面板(按钮为「更改」)不显示;批量/清空态隐藏。歌词模式中保持可见(显示为「退出歌词导入」)。*/
    _syncLrcBtnVisible() {
      if (!this.lrcBtn) return
      const rec = this._rec()
      const isDraft = !!(rec && this.store.draft === rec)
      this.lrcBtn.hidden = !(isDraft || this._lrcMode)
    }

    _wireFields() {
      for (const fieldDef of NUM_FIELDS) {
        const sel = fieldDef[0]
        const path = fieldDef[1]
        const input = this.root.querySelector(sel)
        if (!input) continue
        // ★ 输入过程态(input):只在值「合法且在范围内」时写入 store,不回写输入框。
        //   中间态(如想输 50 先敲"5"、清空、超出范围)不立即钳制回写,
        //   否则输入框会被 load() 的 _setVal 强制改值,导致无法正常输入数字。
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
          // ★ 非数字(清空/中间态)或超范围:不写入,等 change(失焦/回车)时做最终钳制
          if (isNaN(raw)) return
          const isBoostField = fieldDef[3] != null
          if (raw < lo || raw > hi) {
            if (isBoostField && !rec._boost) {
              const nameMap = {
                'life.duration': '生存时间',
                'motion.moveDuration': '运动耗时',
                'motion.delay': '延迟',
              }
              const fieldName = nameMap[path] || path
              this._toast(fieldName + ' 超出范围(' + lo + '~' + hi + ');请开启「增强」后再输入,失焦后将按范围钳制。', { error: true })
            }
            return
          }
          this.store.updateDeep(this.boundId, path, raw)
          // ★ 固定模式:起始点变更时,结束点同步保持相等
          if (rec.position.fixed) {
            if (path === 'position.startX') this.store.updateDeep(this.boundId, 'position.endX', raw)
            else if (path === 'position.startY') this.store.updateDeep(this.boundId, 'position.endY', raw)
          }
        })
        // ★ 最终态(change/失焦):做范围钳制 + 小数位规整,并把规整后的值写回输入框
        input.addEventListener('change', () => {
          if (this._loading) return
          const rec = this._rec()
          if (!rec) return
          let c
          if (path.indexOf('position.') === 0) {
            c = rec.position.usePercent ? [0, 0.99, 2] : [0, 9999, 1]
          } else {
            c = getCfg(fieldDef, !!rec._boost)
          }
          const v = clampVal(input.value, c)
          if (v == null) {
            // 清空/非法:恢复为当前记录值
            this._setVal(input, this._getByPath(rec, path))
            return
          }
          if (String(v) !== String(input.value)) this._setVal(input, v)
          this.store.updateDeep(this.boundId, path, v)
          // ★ 固定模式:起始点变更时,结束点同步保持相等
          if (rec.position.fixed) {
            if (path === 'position.startX') this.store.updateDeep(this.boundId, 'position.endX', v)
            else if (path === 'position.startY') this.store.updateDeep(this.boundId, 'position.endY', v)
          }
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

      // ★ 固定(起始点=结束点)开关:开启时结束点=起始点并禁用结束点输入;关闭时恢复可编辑
      if (this.fixedEl) {
        this.fixedEl.addEventListener('change', () => {
          if (this._loading) return
          const rec = this._rec()
          if (!rec) return
          const on = this.fixedEl.checked
          const pos = Object.assign({}, rec.position, { fixed: on })
          if (on) {
            // 结束点立即与起始点保持相等
            pos.endX = rec.position.startX
            pos.endY = rec.position.startY
          }
          this.store.update(rec.id, { position: pos }, 'position')
          this._applyFixedUI(on)
          if (on) this._toast('已固定:结束点=起始点,舞台上仅显示起始点')
        })
      }

      // ★ 一键反向:交换起始点与结束点坐标(舞台经 store change 事件同步互换)
      this.swapBtn = document.getElementById('pa-pos-swap')
      if (this.swapBtn) {
        this.swapBtn.addEventListener('click', () => {
          if (this._loading) return
          const rec = this._rec()
          if (!rec || !rec.position) return
          const p = rec.position
          if (p.fixed) {
            this._toast('固定模式(起始点=结束点)下无需反向')
            return
          }
          const pos = Object.assign({}, p, {
            startX: p.endX,
            startY: p.endY,
            endX: p.startX,
            endY: p.startY,
          })
          this.store.update(rec.id, { position: pos }, 'position')
          this._toast('已互换起始点与结束点')
        })
      }

      // ★ 导入歌词(lrc):打开导入弹窗;歌词模式下点击 = 退出歌词模式
      if (this.lrcBtn) {
        this.lrcBtn.addEventListener('click', () => {
          if (this._loading) return
          if (this._lrcMode) {
            this._exitLrcMode()
            this._toast('已退出歌词导入,面板恢复可编辑')
            return
          }
          this._openLrcImport()
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

    /** 「当前时间」:一键获取当前播放时间写入「出现时间」输入框(固定该时间点)。
     *  写入期间短暂打开 _loading,避免 onStore change 触发的 load(rec) 回滚 UI 写入。 */
    toggleNow() {
      const rec = this._rec()
      if (!rec || this._loading) return
      const now = round2(this.engine.clock.now())
      const str = global.TimeUtil && typeof global.TimeUtil.timeToStr2 === 'function'
        ? global.TimeUtil.timeToStr2(now)
        : (global.TimeUtil && typeof global.TimeUtil.timeToStrPrecise === 'function'
          ? global.TimeUtil.timeToStrPrecise(now)
          : String(now))
      this._loading = true
      try {
        this.timeEl.disabled = false
        this.timeEl.placeholder = '00:00:02.00'
        this._setVal(this.timeEl, str)
        if (this.timeNowBtn) this.timeNowBtn.classList.remove('active')
      } finally {
        this._loading = false
      }
      this.store.update(rec.id, { useCurrentTime: false, timeSec: now }, 'timeSec')
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

      // ★ 基于原 position 浅拷贝,保留 fixed / usePercent 以外的所有已有字段(切换百分比不应影响「固定」开关)
      let pos = Object.assign({}, rec.position, {
        startX: convertOne(rec.position.startX, 'x'),
        startY: convertOne(rec.position.startY, 'y'),
        endX: convertOne(rec.position.endX, 'x'),
        endY: convertOne(rec.position.endY, 'y'),
      })
      let path = (rec.motion.path || []).map((pt) => ({
        x: convertOne(pt.x, 'x'),
        y: convertOne(pt.y, 'y'),
      }))
      if (!this.autoConvertEl.checked) {
        pos = Object.assign({}, rec.position, { startX: 0, startY: 0, endX: 0, endY: 0 })
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

    // ==================== ★ 导入歌词(lrc) ====================

    /** ★ 打开LRC导入弹窗(复用 FileDialog,与「导入弹幕」「打开视频/图片」一致)。 */
    _openLrcImport() {
      const app = global.window.App
      const fd = (app && app.controls && app.controls.fileDialog) || new global.FileDialog()
      fd.open('导入歌词(LRC)', '.lrc,.txt,text/plain', (f) => {
        const read = (typeof f.text === 'function')
          ? f.text()
          : new Promise((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => resolve(String(r.result))
            r.onerror = reject
            r.readAsText(f)
          })
        read.then((text) => this._applyLrcText(text)).catch(() => {
          this._toast('导入失败:无法读取歌词文件', { error: true })
        })
      })
    }

    /** ★ 解析LRC文本为 [{time, text}] 按时间升序。
     *  支持 [mm:ss.xx] / [mm:ss:xx] / [mm:ss] 及一行多时间戳;忽略 [ti:] [ar:] 等元数据行。 */
    _parseLrc(text) {
      const out = []
      const lines = String(text == null ? '' : text).split(/\r\n|\n|\r/)
      // 数字时间戳:[00:12.34] [00:12:34] [00:12]
      const tsRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
      // 字母开头的元数据标签:[ti:] [ar:] [by:] [offset:] 等
      const metaRe = /\[[a-zA-Z#][^\]]*\]/g
      for (const raw of lines) {
        if (!raw) continue
        const cleaned = raw.replace(metaRe, '') // 先去掉元数据标签
        const textPart = cleaned.replace(tsRe, '').trim()
        if (!textPart) continue // 空行/纯元数据行
        let m
        tsRe.lastIndex = 0
        while ((m = tsRe.exec(cleaned)) !== null) {
          const min = parseInt(m[1], 10)
          const sec = parseInt(m[2], 10)
          const fracStr = m[3] || '0'
          const frac = parseInt(fracStr, 10) / Math.pow(10, fracStr.length)
          const t = min * 60 + sec + frac
          if (Number.isFinite(t) && t >= 0) out.push({ time: t, text: textPart })
        }
      }
      out.sort((a, b) => a.time - b.time)
      return out
    }

    /** ★ 导入前准备:确保面板绑定的是「草稿」(非草稿/未选中时基于当前参数克隆出新草稿),返回草稿。 */
    _prepareLrcDraft() {
      let rec = this._rec()
      if (rec && this.store.draft === rec) return rec
      const Convert = global.DanmakuConvert
      const clone = (rec && rec.type === 'advanced') ? Convert.cloneAdvanced(rec) : Convert.makeAdvanced()
      if (!clone) return null
      clone.content = ''
      clone.sender = (global.App && global.App.settings && global.App.settings.defaultSender) || '我'
      clone.useCurrentTime = false
      this.store.setDraft(clone)
      return clone
    }

    /** ★ 应用导入的LRC文本:写入正文、默认出现时间 00:00:00、进入歌词模式。
     *  任何环节失败都必须回滚:面板恢复导入前的可编辑状态,按钮文案保持「导入歌词(lrc)」。 */
    _applyLrcText(text) {
      const items = this._parseLrc(text)
      if (!items.length) {
        this._toast('导入失败:未识别到有效的LRC歌词行(需要 [分:秒.毫秒] 时间戳)', { error: true })
        return
      }
      let rec = null
      try {
        rec = this._prepareLrcDraft()
        if (!rec) {
          this._toast('导入失败:无法创建高级弹幕草稿', { error: true })
          return
        }
        const lrcRaw = String(text)
        // ★ 先保存完整LRC到面板缓存(_setLrcMode 依赖它来给草稿 content 写第一条歌词)
        this._lrcFullText = lrcRaw
        this._lrcParsed = items
        // 出现时间默认 00:00:00(可修改,作为全部歌词弹幕的时间基准)
        this.store.update(rec.id, { timeSec: 0, useCurrentTime: false }, 'timeSec')
        this._lrcRecId = rec.id
        this._setLrcMode(true, lrcRaw)
      } catch (e) {
        // ★ 回滚:退出歌词模式(恢复正文可编辑/按钮文案/锁定项),面板保持导入前状态
        try { this._setLrcMode(false) } catch (_) { /* 尽力而为 */ }
        if (rec) {
          this._setVal(this.contentEl, rec.content || '')
        } else {
          this._setVal(this.contentEl, '')
        }
        this._syncLrcBtnVisible()
        this._toast('导入失败:' + ((e && e.message) ? e.message : '未知错误,请重试'), { error: true })
        return
      }
      this._toast('已导入 ' + items.length + ' 行歌词;修改「出现时间」可调整歌词弹幕的出现时间')
    }

    /** ★ 歌词模式UI开关:on=禁用正文/生命与运动周期(透明度除外)/增强/运动方式/强制固定坐标。
     *  - 舞台只显示/预览第一条歌词(草稿 content 只写第一条歌词;完整LRC存 _lrcFullText)
     *  - 坐标固定开关强制开启(结束点=起始点)
     *  - 「空间与坐标定位」里的"运动方式"禁用
     *  - 正文 div 外(同层下方)显示说明条 */
    _setLrcMode(on, lrcText) {
      this._lrcMode = !!on
      const lockIds = [
        '#pa-life-duration', '#pa-mot-move', '#pa-mot-delay', '#pa-mot-linear',
        '#pa-boost', '#pa-pos-fixed',
      ]
      this.contentEl.disabled = !!on
      // 歌词模式下解除 255 截断;退出时恢复
      // ★ 不能赋 -1:Chrome 对 textarea.maxLength 赋负值会抛异常,
      //   导致导入流程半途而废(正文已禁用但按钮文案未切换)—— 用移除/恢复属性代替
      if (on) this.contentEl.removeAttribute('maxlength')
      else this.contentEl.setAttribute('maxlength', '255')
      for (const id of lockIds) {
        const el = this.root.querySelector(id)
        if (el) el.disabled = !!on
      }
      // ★ 「空间与坐标定位」里的"运动方式"select 也禁用(歌词模式 start=end 静止,不需要运动方式)
      if (this.motTypeEl) this.motTypeEl.disabled = !!on
      if (this.lrcTipEl) this.lrcTipEl.hidden = !on
      if (this.lrcInfoEl) this.lrcInfoEl.hidden = !on
      if (this.lrcBtn) {
        this.lrcBtn.textContent = on ? '退出歌词导入' : '导入歌词(lrc)'
        this.lrcBtn.title = on ? '退出歌词导入模式,恢复面板可编辑' : '导入LRC歌词:按时间戳批量生成歌词弹幕'
        this.lrcBtn.classList.toggle('lrc-active', !!on)
      }
      // 增强开关/固定开关容器置灰(disabled 的 checkbox 本身 display:none)
      const boostSwitch = this.boostEl ? this.boostEl.closest('.pa-boost-switch') : null
      const fixedSwitch = this.fixedEl ? this.fixedEl.closest('.pa-boost-switch') : null
      if (boostSwitch) boostSwitch.classList.toggle('lrc-locked', !!on)
      if (fixedSwitch) fixedSwitch.classList.toggle('lrc-locked', !!on)
      const rec = this._rec()
      if (on && rec) {
        // 1. 强制开启坐标"固定(起始点=结束点)"(歌词弹幕静止显示)
        if (!rec.position.fixed) {
          const pos = Object.assign({}, rec.position, {
            fixed: true,
            endX: rec.position.startX,
            endY: rec.position.startY,
          })
          this.store.update(rec.id, { position: pos }, 'position')
        }
        // 2. 强制关闭"增强"(歌词模式最大生存10s,与普通上限一致)
        if (rec._boost) this.store.update(rec.id, { _boost: false }, '_boost')
        // 3. 同步面板开关值
        if (this.fixedEl) this.fixedEl.checked = true
        if (this.boostEl) this.boostEl.checked = false
        this._applyFixedUI(true)
        this._applyBoostToFields(false)
        // 4. 解析并缓存完整LRC;草稿 content 只写第一条歌词(舞台只渲染第一条预览)
        const lrcRaw = lrcText != null ? lrcText : this._lrcFullText
        if (lrcRaw != null) {
          const items = this._parseLrc(lrcRaw)
          this._lrcParsed = items
          if (items.length) {
            const firstLyric = Array.from(items[0].text).slice(0, 255).join('')
            this.store.update(rec.id, { content: firstLyric }, 'content')
          }
          // 5. 面板正文显示完整LRC(仅展示用,不可编辑)
          this._setVal(this.contentEl, lrcRaw)
        }
        // 6. 出现时间显示 00:00:00
        this._setVal(this.timeEl, global.TimeUtil.timeToStr2(0))
      }
      if (!on) {
        this._lrcRecId = null
        this._lrcFullText = null
        this._lrcParsed = null
        // 退出时恢复运动方式可用
        if (this.motTypeEl) this.motTypeEl.disabled = false
      }
    }

    /** ★ 退出歌词导入:恢复面板可编辑,回到「添加新弹幕」面板(草稿保留,正文清空)。 */
    _exitLrcMode() {
      const rec = this._rec()
      this._setLrcMode(false)
      if (rec) {
        this.store.update(rec.id, { content: '' }, 'content')
        this._setVal(this.contentEl, '')
      }
      // ★ 确保仍绑定草稿(新增面板,「发送」按钮),LRC按钮恢复为「导入歌词(lrc)」并可见
      this._syncLrcBtnVisible()
      if (this.sendBtn && rec && this.store.draft === rec) {
        this.sendBtn.textContent = '发送'
        this.sendBtn.title = '校验参数并发送'
      }
    }

    /** ★ 歌词模式发送:按LRC时间戳批量生成高级弹幕。
     *  - 出现时间 = 面板出现时间 + LRC时间戳
     *  - 生存时间 = 到下一句的间隔(最后一句 10s),钳制 0.5~10s
     *  - 全部应用当前面板样式(颜色/字号/字体/描边/旋转/透明度/运动/坐标)
     *  - 参数源:以当前草稿记录的样式/坐标为准,歌词从面板缓存(不是 content 字段)获取。*/
    sendLrcDanmaku() {
      const rec = this._rec()
      if (!rec || rec.type !== 'advanced') {
        this._toast('请先创建并选中一个高级弹幕再导入歌词', { error: true })
        return
      }
      const items = (this._lrcParsed && this._lrcParsed.length) ? this._lrcParsed : this._parseLrc(this._lrcFullText || this.contentEl.value)
      if (!items.length) {
        this._toast('未识别到有效歌词行,请重新导入LRC', { error: true })
        return
      }
      const Convert = global.DanmakuConvert
      const baseTime = Number.isFinite(rec.timeSec) ? rec.timeSec : 0
      let added = 0
      let failed = 0
      let lastAdded = null
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const next = items[i + 1]
        let dur = next ? next.time - it.time : 10
        if (!Number.isFinite(dur) || dur <= 0) dur = 10
        dur = Math.round(clamp(dur, 0.5, NORM_MAX_LIFE) * 100) / 100
        const clone = Convert.cloneAdvanced(rec)
        if (!clone) { failed++; continue }
        clone.content = Array.from(it.text).slice(0, 255).join('')
        clone.timeSec = Math.round((baseTime + it.time) * 100) / 100
        clone.life.duration = dur
        clone.useCurrentTime = false
        clone.ctime = NaN // 让 store.add 写入当前时间戳
        const v = Convert.validateRecord(clone)
        if (!v.ok) { failed++; continue }
        lastAdded = this.store.add(clone)
        added++
      }
      // 退出歌词模式 + 恢复面板
      this._setLrcMode(false)
      this.store.draft = null
      this.boundId = null
      // add() 已把 draft 清空但 selectedId 仍指向旧草稿(未入池):避免悬空引用
      if (this.store.selectedId != null && !this.store.get(this.store.selectedId)) {
        this.store.selectedId = null
        this.store.selectedIds = new Set()
      }
      if (lastAdded) {
        this.store.select(lastAdded.id)
        // ★ 选择被锁定态否决时兜底刷新面板
        if (this.boundId !== lastAdded.id) this.clear()
      } else {
        this.clear()
      }
      if (added > 0) {
        this._toast('已发送 ' + added + ' 条歌词弹幕' + (failed ? '(跳过 ' + failed + ' 条非法行)' : ''))
      } else {
        this._toast('发送失败:没有可用的歌词行', { error: true })
      }
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
          // ★ 已回到深度批量激活态:隐藏「返回批量」按钮(之前漏掉导致按钮残留)
          this._showBackToBatchBtn(false)
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
      } else if (evt === 'replace' || evt === 'clear') {
        // ★ 批量删除/整体替换时:重新判定深度批量/偏离态,避免批量面板残留
        //   (removeMany/appendMany/setComments 均触发 replace;clear 触发 clear)
        try {
          const list = global.window.App && global.window.App.list
          // 深度批量集合中已被删除的幽灵id立即清理(从 store/comments 中已不存在)
          if (list && list._batchIds) {
            const keep = new Set()
            for (const bid of list._batchIds) { if (this.store.get(bid)) keep.add(bid) }
            list._batchIds.clear()
            keep.forEach((k) => list._batchIds.add(k))
          }
          // 若当前选中集或深度集因此不再满足深度批量条件,按选择集重新判定显示
          if (this.store.selectedIds.size > 1) {
            if (typeof this.store.isDeepBatchAdvanced === 'function' && this.store.isDeepBatchAdvanced()) {
              this.showBatch(true)
              this._showBackToBatchBtn(false)
            } else {
              const hasDeep = !!(list && typeof list._isDeepCandidate === 'function' && list._isDeepCandidate())
              if (hasDeep) this.showBatchDeviated()
              else this.showBatch(false)
              this._showBackToBatchBtn(false)
            }
          } else if (this.store.selectedIds.size === 1) {
            const rec = this.store.getSelected()
            if (rec && rec.type === 'advanced') this.load(rec)
            else this.clear()
          } else {
            this.clear()
          }
        } catch (_) { this.clear() }
      }
      this._syncCopyBtnVisible()
      void field
    }

    load(rec) {
      // ★ 僵尸弹幕修复:切到其他弹幕(非当前草稿)时,丢弃未发送的旧草稿及其舞台实例
      this._discardDraftIfNeeded(rec)
      this._loading = true
      this.boundId = rec.id
      // ★ 歌词模式仅对导入时的那条草稿生效:加载其他弹幕时自动退出(恢复面板可编辑)
      if (this._lrcMode && rec.id !== this._lrcRecId) this._setLrcMode(false)
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
      // ★ LRC按钮仅在「添加新弹幕」(草稿)面板显示;修改面板(更改)隐藏
      this._syncLrcBtnVisible()

      // ★ 歌词模式:正文框保持显示完整LRC文本(草稿 content 仅存第一条歌词供舞台渲染/预览)
      if (this._lrcMode && rec.id === this._lrcRecId && this._lrcFullText != null) {
        this._setVal(this.contentEl, this._lrcFullText)
      } else {
        this._setVal(this.contentEl, rec.content)
      }
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
      // ★ 固定(起始点=结束点)开关恢复:结束点输入框禁用 + 值与起始点保持相等
      const fixed = !!rec.position.fixed
      if (this.fixedEl) this.fixedEl.checked = fixed
      this._applyFixedUI(fixed)
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

      // ★ 固定模式:结束点输入框始终显示与起始点相等的值
      if (fixed) {
        this._setVal(this.posExEl, rec.position.startX)
        this._setVal(this.posEyEl, rec.position.startY)
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

    /** ★ 丢弃未发送的草稿弹幕(严重bug修复:僵尸弹幕残留)。
     *  添加新高级弹幕但没点「发送」时,草稿会被 spawn 到舞台上(draftSpawned);
     *  若此时点击其他地方(面板隐藏/切选其他弹幕/进入批量态),旧逻辑只把面板清了,
     *  store.draft 和舞台实例都还在 → 舞台上残留一条无法删除的"僵尸弹幕"。
     *  这里在面板离开草稿态时统一清理:移除舞台实例 + 清空 store.draft。
     *  ★ 只处理「高级」草稿(本面板创建的):普通面板的草稿由普通面板/store 自己管理。
     *    绝不能动普通草稿——否则点普通面板「＋ 添加弹幕」后这里把 store.draft 清空,
     *    普通面板的「发送/当前时间」就取不到草稿 → 一直提示"还没创建新弹幕"/按钮无反应。
     *  @param {Object} [keepRec] 若传入且正是当前草稿(如 load(draft) 自身),则不清理 */
    _discardDraftIfNeeded(keepRec) {
      const store = this.store
      if (!store || !store.draft) return
      if (store.draft.type !== 'advanced') return
      if (keepRec && keepRec === store.draft) return
      const draftId = store.draft.id
      try {
        const engine = global.window.App && global.window.App.engine
        if (engine && engine.advanced && draftId) engine.advanced.removeById(draftId)
      } catch (_) {}
      store.draft = null
    }

    clear() {
      this.boundId = null
      // ★ 僵尸弹幕修复:面板清空(无选中)时,未发送的草稿一并丢弃
      this._discardDraftIfNeeded(null)
      // ★ 清空面板时退出歌词模式
      if (this._lrcMode) this._setLrcMode(false)
      this._syncLrcBtnVisible()
      this.emptyEl.classList.remove('hide')
      if (this.batchEl) this.batchEl.classList.add('hide')
      if (this.batchBodyEl) this.batchBodyEl.classList.add('hide') // 清空时也隐藏批量坐标表单
      this.bodyEl.classList.remove('show')
      // ★ 清空(非选中态):批量底部操作栏隐藏
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = true
      // ★ 拾取模式中不取消拾取(防御:拾取点击不应被面板刷新打断)
      if (!this.editor.pickMode) this.editor.cancelPick()
      this._syncCopyBtnVisible() // 清空时保留显示条件(有最近发送过则仍显示)
      if (this.sendBtn) {
        this.sendBtn.textContent = '发送'
        this.sendBtn.title = '校验参数并发送'
      }
    }

    /** ★ 偏离态批量:只显示 pa-batch 文本,隐藏所有表单/底部栏(用于「深度批量候选存在,但当前单选/轻度多选其他弹幕」)。*/
    showBatchDeviated() {
      this.boundId = null
      // ★ 僵尸弹幕修复:进入批量偏离态时丢弃未发送草稿
      this._discardDraftIfNeeded(null)
      if (this._lrcMode) this._setLrcMode(false)
      this._syncLrcBtnVisible()
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      if (this.batchBodyEl) this.batchBodyEl.classList.add('hide') // ★ 偏离态:隐藏批量坐标表单
      this.bodyEl.classList.remove('show')
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = true // ★ 偏离态:隐藏批量底部栏
      if (!this.editor.pickMode) this.editor.cancelPick()
      this._syncCopyBtnVisible()
    }

    /** ★ 批量选择时显示提示;激活态(isDeepAdvanced=true)额外显示「批量坐标表单 + 底部批量操作栏」。
     * @param {boolean} [isDeepAdvanced=false] 是否处于深度批量纯高级激活态*/
    showBatch(isDeepAdvanced) {
      const deep = !!isDeepAdvanced
      this.boundId = null
      // ★ 僵尸弹幕修复:进入批量面板时丢弃未发送草稿(除非...批量态不可能绑定草稿)
      this._discardDraftIfNeeded(null)
      if (this._lrcMode) this._setLrcMode(false)
      this._syncLrcBtnVisible()
      this.emptyEl.classList.add('hide')
      if (this.batchEl) this.batchEl.classList.remove('hide')
      this.bodyEl.classList.remove('show')
      // ★ 仅激活态:显示批量坐标表单 + 底部批量 4 控件
      if (this.batchBodyEl) {
        if (deep) {
          this.batchBodyEl.classList.remove('hide')
          // 初始化批量坐标输入框:用当前批量选中的所有弹幕的联合 bbox 左上角像素(逻辑 px,非屏幕 px)作为初值
          this._fillBatchCoordInputs()
          // ★ 同步批量「固定」开关状态(根据选中弹幕的 fixed 标记)
          this._syncBatchFixedUI()
        } else {
          this.batchBodyEl.classList.add('hide')
        }
      }
      if (this.batchSendRowEl) this.batchSendRowEl.hidden = !deep
      // ★ 拾取模式中不取消拾取(防御:拾取点击触发的面板刷新不应打断拾取)
      if (!this.editor.pickMode) this.editor.cancelPick()
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
      // ★ 修复:delta = 输入框新值 − 当前该字段的最小值(与 _fillBatchCoordInputs 逻辑一致)
      //   而不是混合 start/end 的 boxMin,否则 start 和 end 不重合时偏移计算错误
      const computeMin = (coord) => {
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
        let minV = Infinity
        for (const id of ids) {
          const rec = self.store.get(id)
          if (!rec || !rec.position) continue
          const up = !!rec.position.usePercent
          let v
          if (coord === 'startX') v = toLogPx(rec.position.startX, 'x', up)
          else if (coord === 'startY') v = toLogPx(rec.position.startY, 'y', up)
          else if (coord === 'endX') v = toLogPx(rec.position.endX, 'x', up)
          else if (coord === 'endY') v = toLogPx(rec.position.endY, 'y', up)
          if (v < minV) minV = v
        }
        return isFinite(minV) ? minV : null
      }
      const applyDelta = (which) => {
        const list = global.window.App && global.window.App.list
        const ids = list && list._batchIds ? list._batchIds : (self.store.selectedIds || new Set())
        if (!ids || ids.size < 2) return
        const displayScale = (self.engine.displayScale != null && isFinite(self.engine.displayScale)) ? Number(self.engine.displayScale) : 1
        const W = self.engine.width
        const H = self.engine.height
        let hasPercent = false, applied = 0
        const readCoord = (el) => {
          const n = parseFloat(el && el.value)
          return isFinite(n) ? Math.round(n) : null
        }
        if (which === 'S') {
          const sxV = readCoord(self.batchSxEl), syV = readCoord(self.batchSyEl)
          const minSX = computeMin('startX'), minSY = computeMin('startY')
          if (sxV == null || syV == null || minSX == null || minSY == null) return
          const dX = sxV - minSX, dY = syV - minSY
          for (const id of ids) {
            const rec = self.store.get(id)
            if (!rec || !rec.position) continue
            const up = !!rec.position.usePercent
            if (up) hasPercent = true
            const toLogX = (u) => up ? (u * W / (displayScale > 0 ? displayScale : 1)) : u
            const toLogY = (u) => up ? (u * H / (displayScale > 0 ? displayScale : 1)) : u
            const oSX = toLogX(rec.position.startX), oSY = toLogY(rec.position.startY)
            if (!isFinite(oSX) || !isFinite(oSY)) continue
            // ★ Bug 修复:拾取/修改批量「起始点」只平移起始点,绝不联动改写结束点
            //   (旧逻辑会把 end 一起平移,clamp 后可能塌缩成 (0,1) 之类的错误值)
            //   固定(fixed)弹幕例外:end 本身就等于 start,需保持相等关系
            const fixed = !!rec.position.fixed
            let nEX = null, nEY = null
            if (fixed) {
              const oEX = toLogX(rec.position.endX), oEY = toLogY(rec.position.endY)
              if (isFinite(oEX) && isFinite(oEY)) {
                nEX = clamp(Math.round(oEX + dX), 0, 9999)
                nEY = clamp(Math.round(oEY + dY), 0, 9999)
              }
            }
            const nSX = clamp(Math.round(oSX + dX), 0, 9999)
            const nSY = clamp(Math.round(oSY + dY), 0, 9999)
            const pos = Object.assign({}, rec.position, {
              fixed: fixed,
              usePercent: false,
              startX: nSX,
              startY: nSY,
            })
            if (fixed && nEX != null) { pos.endX = nEX; pos.endY = nEY }
            self.store.update(id, { position: pos }, 'position')
            applied++
          }
        } else if (which === 'E') {
          const exV = readCoord(self.batchExEl), eyV = readCoord(self.batchEyEl)
          const minEX = computeMin('endX'), minEY = computeMin('endY')
          if (exV == null || eyV == null || minEX == null || minEY == null) return
          const dX = exV - minEX, dY = eyV - minEY
          for (const id of ids) {
            const rec = self.store.get(id)
            if (!rec || !rec.position) continue
            // 固定模式下结束点输入框被禁用,跳过(保持 end=start)
            if (rec.position.fixed) continue
            const up = !!rec.position.usePercent
            if (up) hasPercent = true
            const toLogX = (u) => up ? (u * W / (displayScale > 0 ? displayScale : 1)) : u
            const toLogY = (u) => up ? (u * H / (displayScale > 0 ? displayScale : 1)) : u
            const oEX = toLogX(rec.position.endX), oEY = toLogY(rec.position.endY)
            if (!isFinite(oEX) || !isFinite(oEY)) continue
            // ★ Bug 修复:批量「结束点」只平移结束点,起始点保持不动
            self.store.update(id, {
              position: Object.assign({}, rec.position, {
                usePercent: false,
                endX: clamp(Math.round(oEX + dX), 0, 9999),
                endY: clamp(Math.round(oEY + dY), 0, 9999),
              })
            }, 'position')
            applied++
          }
        }
        if (applied > 0) {
          if (hasPercent) self._toast('已相对偏移 ' + applied + ' 条弹幕(百分比已转换为 px)')
          else self._toast('已相对偏移 ' + applied + ' 条弹幕(px)')
          // 偏移后刷新初值,方便继续微调
          self._fillBatchCoordInputs()
        }
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

    /** ★ 固定(起始点=结束点):控制单条结束点输入框与「拾取结束」按钮的禁用状态。 */
    _applyFixedUI(on) {
      if (this.posExEl) this.posExEl.disabled = on
      if (this.posEyEl) this.posEyEl.disabled = on
      if (this.endPickBtn) this.endPickBtn.disabled = on
    }

    /** ★ 批量「固定」开关:应用到所有深度批量选中的弹幕(end=start + fixed 标记)并禁用批量结束点输入。 */
    _applyBatchFixed(on) {
      const list = global.window.App && global.window.App.list
      const ids = list && list._batchIds ? list._batchIds : (this.store.selectedIds || new Set())
      let applied = 0
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || !rec.position) continue
        const pos = Object.assign({}, rec.position, { fixed: !!on })
        if (on) {
          pos.endX = rec.position.startX
          pos.endY = rec.position.startY
        }
        this.store.update(id, { position: pos }, 'position')
        applied++
      }
      this._applyBatchFixedUI(!!on)
      this._fillBatchCoordInputs()
      if (on && applied > 0) this._toast('已固定:结束点=起始点,可拖拽批量起始点整体移动')
    }

    /** ★ 批量固定 UI:禁用批量结束点输入框 + 「拾取结束」按钮。 */
    _applyBatchFixedUI(on) {
      if (this.batchExEl) this.batchExEl.disabled = on
      if (this.batchEyEl) this.batchEyEl.disabled = on
      if (this.batchEndPickBtn) this.batchEndPickBtn.disabled = on
    }

    /** ★ 进入/刷新批量面板时:根据所有选中弹幕的 fixed 标记同步开关与禁用状态(全部 fixed 才算开)。 */
    _syncBatchFixedUI() {
      if (!this.batchFixedEl) return
      const list = global.window.App && global.window.App.list
      const ids = list && list._batchIds ? list._batchIds : new Set()
      let n = 0, nFixed = 0
      for (const id of ids) {
        const rec = this.store.get(id)
        if (!rec || !rec.position) continue
        n++
        if (rec.position.fixed) nFixed++
      }
      const on = n > 0 && n === nFixed
      this._loading = true
      try { this.batchFixedEl.checked = on } catch (_) {}
      this._loading = false
      this._applyBatchFixedUI(on)
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
      // ★ 两个输入框的值都已写好,只需触发一次 change(applyDelta 会同时读 X/Y)
      //   旧实现连发两次 change,第二次基于已刷新的最小值重算,虽幂等但多余且易引入竞态
      const evt = new Event('change', { bubbles: true })
      const targetEl = (field === 'batch-start') ? this.batchSxEl : this.batchExEl
      if (targetEl) targetEl.dispatchEvent(evt)
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
      // ★ 应用前范围:与面板输入校验一致(增强/百分比感知)
      const boostOn = !!get('pa-unify-boost')
      const pctOn = !!get('pa-unify-pos-percent')
      const hiLife = boostOn ? BOOST_MAX_LIFE : NORM_MAX_LIFE
      const hiMs = boostOn ? BOOST_MAX_MS : NORM_MAX_MOVE
      const posHi = pctOn ? 0.99 : 9999
      const posDp = pctOn ? 2 : 1
      const tasks = []
      // ★ 格式校验:勾选了但值非法时,提示并中止应用(与高级弹幕面板行为一致)
      if (get('pa-unify-content')) {
        const c = val('pa-unify-content-val')
        if (!c || !String(c).trim()) {
          this._toast('弹幕正文不能为空', { error: true })
          return
        }
        tasks.push({ path: 'content', value: String(c).slice(0, 255) })
      }
      if (get('pa-unify-time')) {
        const t = global.TimeUtil.strToTime(val('pa-unify-time-val'))
        if (t == null) {
          this._toast('出现时间格式不正确(应为 00:00:00.00 形式)', { error: true })
          return
        }
        tasks.push({ path: 'timeSec', value: round2(t) })
      }
      if (get('pa-unify-sender')) tasks.push({ path: 'sender', value: val('pa-unify-sender-val') || '' })
      if (get('pa-unify-color')) {
        const hex = C2 && C2.parseColor ? C2.parseColor(val('pa-unify-color-text')) : null
        if (!hex) {
          this._toast('颜色格式不正确', { error: true })
          return
        }
        tasks.push({ path: 'style.color', value: hex })
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
      if (get('pa-unify-life-dur')) { const n = num('pa-unify-life-dur-val'); if (n != null) tasks.push({ path: 'life.duration', value: round2(clamp(n, 0, hiLife)) }) }
      if (get('pa-unify-life-opstart')) { const n = num('pa-unify-life-opstart-val'); if (n != null) tasks.push({ path: 'life.opacityStart', value: round2(clamp(n, 0, 1)) }) }
      if (get('pa-unify-life-opend')) { const n = num('pa-unify-life-opend-val'); if (n != null) tasks.push({ path: 'life.opacityEnd', value: round2(clamp(n, 0, 1)) }) }
      // ★ 运动方式:不开放 path,只接受 position
      if (get('pa-unify-mot-type') && val('pa-unify-mot-type-val') !== 'path') tasks.push({ path: 'motion.type', value: 'position' })
      if (get('pa-unify-mot-linear')) tasks.push({ path: 'motion.linear', value: val('pa-unify-mot-linear-val') === '0' })
      if (get('pa-unify-mot-move')) { const n = num('pa-unify-mot-move-val'); if (n != null) tasks.push({ path: 'motion.moveDuration', value: round1(clamp(n, 0, hiMs)) }) }
      if (get('pa-unify-mot-delay')) { const n = num('pa-unify-mot-delay-val'); if (n != null) tasks.push({ path: 'motion.delay', value: round1(clamp(n, 0, hiMs)) }) }
      // ★ 空间与坐标定位:「按百分比」(控制 usePercent)、「自动转换」(仅影响弹窗内输入值转换,不直接改数据)
      if (get('pa-unify-pos-mode') && val('pa-unify-pos-mode-val') !== 'path') tasks.push({ path: 'motion.type', value: 'position' })
      if (get('pa-unify-pos-percent')) {
        tasks.push({ path: 'position.usePercent', value: true })
      }
      if (get('pa-unify-pos-sx')) { const n = num('pa-unify-pos-sx-val'); if (n != null) tasks.push({ path: 'position.startX', value: Math.round(clamp(n, 0, posHi) * Math.pow(10, posDp)) / Math.pow(10, posDp) }) }
      if (get('pa-unify-pos-sy')) { const n = num('pa-unify-pos-sy-val'); if (n != null) tasks.push({ path: 'position.startY', value: Math.round(clamp(n, 0, posHi) * Math.pow(10, posDp)) / Math.pow(10, posDp) }) }
      if (get('pa-unify-pos-ex')) { const n = num('pa-unify-pos-ex-val'); if (n != null) tasks.push({ path: 'position.endX', value: Math.round(clamp(n, 0, posHi) * Math.pow(10, posDp)) / Math.pow(10, posDp) }) }
      if (get('pa-unify-pos-ey')) { const n = num('pa-unify-pos-ey-val'); if (n != null) tasks.push({ path: 'position.endY', value: Math.round(clamp(n, 0, posHi) * Math.pow(10, posDp)) / Math.pow(10, posDp) }) }

      if (!tasks.length) {
        this._toast('请至少勾选一个参数并填写目标值', { error: true })
        return
      }
      let applied = 0
      const idsArr = Array.isArray(batchIds) ? batchIds : Array.from(batchIds)
      for (const id of idsArr) {
        const rec = this.store.get(id)
        if (!rec || rec.type !== 'advanced' || rec === this.store.draft) continue
        for (const t of tasks) {
          this.store.updateDeep(id, t.path, t.value)
        }
        applied++
      }
      if (applied === 0 && idsArr.length > 0) {
        this._toast('所选弹幕已被删除,请重新选择后再操作', { error: true })
        this._closeUnifyModal()
        return
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
      // ★ 颜色行:色块在前(同一列纵向排列),颜色代码输入框在后
      const cf = h('div', { class: 'pa-field pa-color-line' })
      cf.appendChild(h('input', { type: 'color', id: 'pa-unify-color' }))
      cf.appendChild(h('input', { type: 'text', id: 'pa-unify-color-text', placeholder: '#FFFFFF' }))
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
      // tools row:「运动方式」 + 「按百分比」 + 「自动转换」(自动转换px↔百分比,与高级面板 togglePercent 同逻辑)
      const tr = h('div', { class: 'pa-row pa-coord-tools' })
      const mk = h('label', { class: 'pa-unify-check' })
      mk.appendChild(h('input', { type: 'checkbox', id: 'pa-unify-pos-mode' }))
      mk.appendChild(document.createTextNode('运动方式'))
      tr.appendChild(mk)
      const mf = h('div', { class: 'pa-field' })
      const posModeSel = select('pa-unify-pos-mode-val', [['position','起始位置'],['path','路径跟随(不开放)',true]], 'position')
      mf.appendChild(posModeSel)
      tr.appendChild(mf)
      // 按百分比(控制是否 usePercent)
      const pk = h('label', { class: 'pa-unify-check' })
      const ppCb = h('input', { type: 'checkbox', id: 'pa-unify-pos-percent' })
      pk.appendChild(ppCb)
      pk.appendChild(document.createTextNode('按百分比'))
      tr.appendChild(pk)
      const pf = h('div', { class: 'pa-field pa-field-check' })
      const pl = h('label')
      // ★ 原「启用」→「自动转换」:勾选后在 px 与百分比单位之间互转(逻辑与高级面板 togglePercent 一致)
      const ac = h('input', { type: 'checkbox', id: 'pa-unify-auto-convert' })
      pl.appendChild(ac)
      pl.appendChild(document.createTextNode(' 自动转换'))
      pf.appendChild(pl)
      tr.appendChild(pf)
      g6.appendChild(tr)
      // ★ 辅助:把某个数值输入从当前 px↔百分比 双向转换;转换后同时写回输入框的 value/min/max/step
      const W = this.engine.width, H = this.engine.height
      const convertInput = (id, axis, toPercent) => {
        const el = document.getElementById(id)
        if (!el) return
        const n = parseFloat(el.value)
        if (isNaN(n) || W <= 0 || H <= 0) return
        let result
        if (toPercent) result = Math.min(0.99, Math.max(0, Math.round(n / (axis === 'x' ? W : H) * 100) / 100))
        else result = Math.min(9999, Math.max(0, Math.round(n * (axis === 'x' ? W : H) * 10) / 10))
        el.value = String(result)
        el.min = toPercent ? '0' : '0'
        el.max = toPercent ? '0.99' : '9999'
        el.step = toPercent ? '0.01' : '1'
      }
      ppCb.addEventListener('change', () => {
        const toPct = ppCb.checked
        const autoOn = !!(ac && ac.checked)
        if (autoOn) {
          convertInput('pa-unify-pos-sx-val', 'x', toPct)
          convertInput('pa-unify-pos-sy-val', 'y', toPct)
          convertInput('pa-unify-pos-ex-val', 'x', toPct)
          convertInput('pa-unify-pos-ey-val', 'y', toPct)
        } else {
          // ★ 未勾选「自动转换」:坐标清 0(与高级面板 autoConvert.checked=false 切换百分比逻辑一致)
          const sxEl = document.getElementById('pa-unify-pos-sx-val')
          const syEl = document.getElementById('pa-unify-pos-sy-val')
          const exEl = document.getElementById('pa-unify-pos-ex-val')
          const eyEl = document.getElementById('pa-unify-pos-ey-val')
          if (sxEl) sxEl.value = '0'
          if (syEl) syEl.value = '0'
          if (exEl) exEl.value = '0'
          if (eyEl) eyEl.value = '0'
          const dp = toPct ? '0.99' : '9999'
          const st = toPct ? '0.01' : '1'
          ;[sxEl, syEl, exEl, eyEl].forEach((e) => { if (e) { e.max = dp; e.step = st } })
        }
      })
      // start row(每个坐标字段未勾选时,对应的数值输入框置灰不可编辑)
      const sr = h('div', { class: 'pa-row pa-coord' })
      const mkSx = h('label',{class:'pa-unify-check'})
      const cbSx = h('input',{type:'checkbox',id:'pa-unify-pos-sx'})
      mkSx.appendChild(cbSx); mkSx.appendChild(document.createTextNode('起始点 X')); sr.appendChild(mkSx)
      const inpSx = numInput('pa-unify-pos-sx-val',0,0,9999,1)
      sr.appendChild(h('div',{class:'pa-field'},[inpSx]))
      const mkSy = h('label',{class:'pa-unify-check'})
      const cbSy = h('input',{type:'checkbox',id:'pa-unify-pos-sy'})
      mkSy.appendChild(cbSy); mkSy.appendChild(document.createTextNode('起始点 Y')); sr.appendChild(mkSy)
      const inpSy = numInput('pa-unify-pos-sy-val',0,0,9999,1)
      sr.appendChild(h('div',{class:'pa-field'},[inpSy]))
      g6.appendChild(sr)
      // end row
      const er = h('div', { class: 'pa-row pa-coord' })
      const mkEx = h('label',{class:'pa-unify-check'})
      const cbEx = h('input',{type:'checkbox',id:'pa-unify-pos-ex'})
      mkEx.appendChild(cbEx); mkEx.appendChild(document.createTextNode('结束点 X')); er.appendChild(mkEx)
      const inpEx = numInput('pa-unify-pos-ex-val',0,0,9999,1)
      er.appendChild(h('div',{class:'pa-field'},[inpEx]))
      const mkEy = h('label',{class:'pa-unify-check'})
      const cbEy = h('input',{type:'checkbox',id:'pa-unify-pos-ey'})
      mkEy.appendChild(cbEy); mkEy.appendChild(document.createTextNode('结束点 Y')); er.appendChild(mkEy)
      const inpEy = numInput('pa-unify-pos-ey-val',0,0,9999,1)
      er.appendChild(h('div',{class:'pa-field'},[inpEy]))
      g6.appendChild(er)
      // ★ 工具行:未勾选"运动方式"→ select 置灰(保持原行为)
      const modeCb = tr.querySelector('#pa-unify-pos-mode')
      const syncMode = () => {
        posModeSel.disabled = !modeCb.checked
        posModeSel.classList.toggle('pa-unify-disabled', !modeCb.checked)
      }
      modeCb.addEventListener('change', syncMode)
      syncMode()
      // ★ 起始点/结束点 X/Y:未勾选 → 对应数值输入框置灰(锁定)
      const bindLock = (cb, inp) => {
        const sync = () => {
          inp.disabled = !cb.checked
          inp.classList.toggle('pa-unify-disabled', !cb.checked)
        }
        cb.addEventListener('change', sync)
        sync()
      }
      bindLock(cbSx, inpSx); bindLock(cbSy, inpSy)
      bindLock(cbEx, inpEx); bindLock(cbEy, inpEy)
      this._unifyContent.appendChild(g6)

      // ★ 参数合理性校验:与高级弹幕面板同款「过程态/最终态」分离模式
      //   输入过程不拦截(允许中间态),change(失焦/回车)时钳制到范围并按小数位规整回写
      this._wireUnifyValidation()
    }

    /** ★ 批量统一参数面板:数字输入的最终态校验 + 增强/百分比开关的动态范围同步。 */
    _wireUnifyValidation() {
      const boostEl = document.getElementById('pa-unify-boost')
      const pctEl = document.getElementById('pa-unify-pos-percent')
      const isBoost = () => !!(boostEl && boostEl.checked)
      const wireNum = (vid, getRange) => {
        const el = document.getElementById(vid)
        if (!el) return
        const defv = el.value // 构建时默认值:清空/非法输入时恢复
        el.addEventListener('change', () => {
          const raw = String(el.value).trim()
          if (raw === '') { el.value = defv; return }
          const n = parseFloat(raw)
          if (isNaN(n)) { el.value = defv; return }
          const c = getRange()
          const m = Math.pow(10, c[2])
          el.value = String(Math.round(clamp(n, c[0], c[1]) * m) / m)
        })
      }
      wireNum('pa-unify-size-val', () => [10, 127, 0])
      wireNum('pa-unify-rot-z-val', () => [0, 360, 1])
      wireNum('pa-unify-rot-y-val', () => [0, 360, 1])
      wireNum('pa-unify-life-dur-val', () => [0, isBoost() ? BOOST_MAX_LIFE : NORM_MAX_LIFE, 2])
      wireNum('pa-unify-life-opstart-val', () => [0, 1, 2])
      wireNum('pa-unify-life-opend-val', () => [0, 1, 2])
      wireNum('pa-unify-mot-move-val', () => [0, isBoost() ? BOOST_MAX_MS : NORM_MAX_MOVE, 1])
      wireNum('pa-unify-mot-delay-val', () => [0, isBoost() ? BOOST_MAX_MS : NORM_MAX_DELAY, 1])
      const posRange = () => (pctEl && pctEl.checked) ? [0, 0.99, 2] : [0, 9999, 1]
      wireNum('pa-unify-pos-sx-val', posRange)
      wireNum('pa-unify-pos-sy-val', posRange)
      wireNum('pa-unify-pos-ex-val', posRange)
      wireNum('pa-unify-pos-ey-val', posRange)

      // ★ 「增强」开关:切换时同步受影响字段的 max,并把当前值钳制到新范围
      if (boostEl) {
        boostEl.addEventListener('change', () => {
          const hiLife = isBoost() ? BOOST_MAX_LIFE : NORM_MAX_LIFE
          const hiMs = isBoost() ? BOOST_MAX_MS : NORM_MAX_MOVE
          const adjust = (vid, hiV, dp) => {
            const el = document.getElementById(vid)
            if (!el) return
            el.max = String(hiV)
            const n = parseFloat(el.value)
            if (!isNaN(n)) {
              const m = Math.pow(10, dp)
              el.value = String(Math.round(clamp(n, 0, hiV) * m) / m)
            }
          }
          adjust('pa-unify-life-dur-val', hiLife, 2)
          adjust('pa-unify-mot-move-val', hiMs, 1)
          adjust('pa-unify-mot-delay-val', hiMs, 1)
        })
      }

      // ★ 「按百分比」开关:切换时同步坐标输入范围(0~0.99 两位小数 ↔ 0~9999 一位小数)
      if (pctEl) {
        pctEl.addEventListener('change', () => {
          const pct = pctEl.checked
          const vids = ['pa-unify-pos-sx-val', 'pa-unify-pos-sy-val', 'pa-unify-pos-ex-val', 'pa-unify-pos-ey-val']
          for (const vid of vids) {
            const el = document.getElementById(vid)
            if (!el) continue
            el.max = pct ? '0.99' : '9999'
            el.step = pct ? '0.01' : '1'
            const n = parseFloat(el.value)
            if (!isNaN(n)) {
              const m = Math.pow(10, pct ? 2 : 1)
              el.value = String(Math.round(clamp(n, 0, pct ? 0.99 : 9999) * m) / m)
            }
          }
        })
      }
    }
  }

  global.PanelAdvanced = PanelAdvanced
})(window)
