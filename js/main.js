/**
 * main.js:启动装配。组装 store/engine/editor/panels/list/player/controls,加载演示弹幕。
 */
(function () {
  'use strict'

  const D = window.DomUtil

  const store = new window.CommentStore()
  const clock = new window.Clock()
  const stage = D.$('#stage')
  const engine = new window.DanmakuEngine(stage, store, clock, {})
  const editor = new window.Editor(stage, store, engine)
  const panelNormal = new window.PanelNormal(store, D.$('#panel-normal'), clock)
  const panelAdvanced = new window.PanelAdvanced(store, D.$('#panel-advanced'), editor, engine)
  const list = new window.DanmakuList(store, D.$('#list-body'), D.$('#list-count'))
  const player = new window.Player(D.$('#stage-wrap'), D.$('#video'), stage, store, engine, clock)
  const fileDialog = new window.FileDialog()
  const controls = new window.Controls(store, engine, clock, editor, player, null, fileDialog)
  const overlay = new window.EditOverlay(D.$('#edit-overlay'), store, engine, editor)
  editor.attachOverlay(overlay)
  engine._onAdvEnded = () => overlay.onAdvEnded()
  store.setLockVeto(() => !overlay.isLocked())
  const undo = new window.UndoManager(store)

  window.App = {
    store: store,
    engine: engine,
    clock: clock,
    editor: editor,
    player: player,
    controls: controls,
    panelNormal: panelNormal,
    panelAdvanced: panelAdvanced,
    list: list,
    overlay: overlay,
    undo: undo,
    settings: null, // ★ 全局设置(下方初始化)
  }

  // ★ 全局设置:默认发送人 + 启动时是否显示舞台提示 + 百分比仅坐标缩放。持久化到 localStorage。
  const SETTINGS_KEY = 'app_settings'
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const s = JSON.parse(raw)
        return {
          defaultSender: s.defaultSender != null ? String(s.defaultSender) : '我',
          showStageHint: s.showStageHint !== false, // 默认 true
          // ★ 百分比高级弹幕「仅坐标缩放」:默认开启(B站实际行为)
          percentOnlyScale: s.percentOnlyScale !== false,
          autoSave: s.autoSave === true, // 默认 false
          blockWords: Array.isArray(s.blockWords) ? s.blockWords : [],
          // ★ 显示缩放(默认 1=100% 推荐值) + 自动适配屏幕 DPI(默认关)
          displayScale: Number.isFinite(s.displayScale) && s.displayScale > 0 ? s.displayScale : 1,
          autoDpi: s.autoDpi === true,
          // ★ 程序启动时自动打开最近改动的弹幕文件(默认 false = 打开 start.json)
          autoOpenRecent: s.autoOpenRecent === true,
        }
      }
    } catch (_) {}
    return { defaultSender: '我', showStageHint: true, percentOnlyScale: true, autoSave: false, blockWords: [], displayScale: 1, autoDpi: false, autoOpenRecent: false }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch (_) {}
  }
  const settings = loadSettings()
  window.App.settings = settings
  window.App.mainSettings = settings // ★ 供 controls.js 访问(如屏蔽词同步)

  /** ★ 应用「显示缩放」到弹幕坐标(1px 对应的实际渲染大小)。
   *   - 只改动弹幕渲染(字号/描边/像素坐标/轨道高度);程序 UI 与舞台尺寸保持不变。
   *   - autoDpi 开启时用系统 DPI 系数;否则用手动滑块值。系数统一钳制在 0.5~2.0。*/
  function applyDisplayScaleFromSettings() {
    const finish = (factor) => {
      const f = Math.min(2, Math.max(0.5, factor || 1))
      // ★ 不再缩放整个应用(body.zoom / webFrame.setZoomFactor),仅在引擎内缩放弹幕。
      if (window.App && window.App.engine && typeof window.App.engine.setDisplayScale === 'function') {
        window.App.engine.setDisplayScale(f)
      }
    }
    if (settings.autoDpi) {
      if (window.api && typeof window.api.getDisplayScaleFactor === 'function') {
        window.api.getDisplayScaleFactor().then(finish).catch(() => finish(settings.displayScale))
      } else {
        // 浏览器回退:devicePixelRatio(含浏览器缩放,仅作近似)
        finish(window.devicePixelRatio || settings.displayScale)
      }
    } else {
      finish(settings.displayScale)
    }
  }

  // ★ 启动时根据设置控制舞台提示显示
  if (!settings.showStageHint) {
    player.hintDismissed = true
    player.hideHint()
  } else if (!player.hintDismissed) {
    // ★ 开启时启动要显示舞台提示(HTML 默认 hidden,需主动显示)
    player.stageHint.hidden = false
  }
  // ★ 启动时应用显示缩放
  applyDisplayScaleFromSettings()

  // ★ 设置面板:打开/保存/取消
  const settingsDialog = D.$('#settings-dialog')
  const setSenderInput = D.$('#set-default-sender')
  const setHintCheckbox = D.$('#set-show-stage-hint')
  const setPercentOnlyScaleCheckbox = D.$('#set-percent-only-scale')
  const setAutoSaveCheckbox = D.$('#set-auto-save')
  const setAutoOpenRecentCheckbox = D.$('#set-auto-open-recent')
  const setBlockWordsTextarea = D.$('#set-block-words')
  const setDanmakuDirInput = D.$('#set-danmaku-dir')
  const setDanmakuBrowseBtn = D.$('#set-danmaku-browse')
  // ★ 显示缩放控件
  const setDisplayScaleSlider = D.$('#set-display-scale')
  const setDisplayScaleVal = D.$('#set-display-scale-val')
  const setAutoDpiCheckbox = D.$('#set-auto-dpi')

  /** 滑块联动:更新百分比文案 + 勾选自动 DPI 时禁用滑块 */
  function syncDisplayScaleUI() {
    if (!setDisplayScaleSlider || !setDisplayScaleVal) return
    const v = Number(setDisplayScaleSlider.value) || 100
    setDisplayScaleVal.textContent = v + '%'
    const auto = !!(setAutoDpiCheckbox && setAutoDpiCheckbox.checked)
    setDisplayScaleSlider.disabled = auto
    setDisplayScaleSlider.style.opacity = auto ? '0.45' : '1'
    setDisplayScaleSlider.title = auto
      ? '已开启自动适配屏幕DPI,手动缩放不可用'
      : '拖动调整显示缩放(50%~200%)'
    updateDpiLabel()
  }

  /** ★ DPI 标签:显示当前实际应用的 DPI(96 × 缩放系数)。
   *   自动 DPI 开启时从系统 API 取系数(浏览器回退 devicePixelRatio);否则按手动滑块值计算。 */
  function updateDpiLabel() {
    const el = D.$('#set-dpi-val')
    if (!el) return
    const show = (factor) => {
      const f = Number(factor)
      if (!Number.isFinite(f) || f <= 0) { el.textContent = 'DPI = ?'; return }
      const dpi = Math.round(96 * f * 100) / 100
      el.textContent = 'DPI = ' + dpi
    }
    const auto = !!(setAutoDpiCheckbox && setAutoDpiCheckbox.checked)
    if (auto) {
      if (window.api && typeof window.api.getDisplayScaleFactor === 'function') {
        window.api.getDisplayScaleFactor().then(show).catch(() => show(window.devicePixelRatio || 1))
      } else {
        show(window.devicePixelRatio || 1)
      }
    } else {
      show((Number(setDisplayScaleSlider.value) || 100) / 100)
    }
  }
  if (setDisplayScaleSlider) {
    setDisplayScaleSlider.addEventListener('input', syncDisplayScaleUI)
  }
  if (setAutoDpiCheckbox) {
    setAutoDpiCheckbox.addEventListener('change', syncDisplayScaleUI)
  }

  // ★ 启动时把 percentOnlyScale 设置同步到 engine(引擎本身默认 true 兜底)
  if (window.App && window.App.engine && typeof settings.percentOnlyScale === 'boolean') {
    window.App.engine.percentCoordOnlyScale = settings.percentOnlyScale
  }
  // ★ 启动时把 autoSave 同步到 store
  if (window.App && window.App.store) {
    window.App.store.autoSave = !!settings.autoSave
  }
  // ★ 双击窗口左上角标题「B站弹幕模拟器」→ 默认浏览器打开项目仓库
  const tbTitleEl = D.$('.tb-title')
  if (tbTitleEl) {
    tbTitleEl.addEventListener('dblclick', () => {
      const url = 'https://github.com/WannaBeCute/Bilibili-danmaku-simulator'
      if (window.DanmakuIO && window.DanmakuIO.openExternal) window.DanmakuIO.openExternal(url)
      else if (window.open) window.open(url, '_blank')
    })
  }

  D.$('#btn-settings').addEventListener('click', () => {
    setSenderInput.value = settings.defaultSender
    setHintCheckbox.checked = settings.showStageHint
    if (setPercentOnlyScaleCheckbox) setPercentOnlyScaleCheckbox.checked = settings.percentOnlyScale
    if (setAutoSaveCheckbox) setAutoSaveCheckbox.checked = settings.autoSave
    if (setAutoOpenRecentCheckbox) setAutoOpenRecentCheckbox.checked = settings.autoOpenRecent
    if (setBlockWordsTextarea) setBlockWordsTextarea.value = (settings.blockWords || []).join('\n')
    // ★ 回填显示缩放(滑块按百分数存储/展示)
    if (setDisplayScaleSlider) {
      setDisplayScaleSlider.value = String(Math.round(settings.displayScale * 100))
    }
    if (setAutoDpiCheckbox) setAutoDpiCheckbox.checked = !!settings.autoDpi
    syncDisplayScaleUI()
    // ★ 回填本地弹幕池当前保存位置
    if (window.DanmakuIO && window.DanmakuIO.getDanmakuDir) {
      window.DanmakuIO.getDanmakuDir().then((dir) => {
        if (dir) setDanmakuDirInput.value = dir.path || dir.defaultPath || ''
      })
    }
    settingsDialog.hidden = false
  })
  D.$('#set-cancel').addEventListener('click', () => {
    settingsDialog.hidden = true
  })
  // ★ 使用默认:除屏蔽列表外全部恢复为默认值
  D.$('#set-reset').addEventListener('click', () => {
    const preservedBlockWords = (settings.blockWords || []).slice()
    setSenderInput.value = '我'
    setHintCheckbox.checked = true
    if (setPercentOnlyScaleCheckbox) setPercentOnlyScaleCheckbox.checked = true
    if (setAutoSaveCheckbox) setAutoSaveCheckbox.checked = false
    if (setAutoOpenRecentCheckbox) setAutoOpenRecentCheckbox.checked = false
    // ★ 显示缩放恢复默认:100% + 关闭自动 DPI
    if (setDisplayScaleSlider) setDisplayScaleSlider.value = '100'
    if (setAutoDpiCheckbox) setAutoDpiCheckbox.checked = false
    syncDisplayScaleUI()
    // 屏蔽列表保持不变
    if (setBlockWordsTextarea) setBlockWordsTextarea.value = preservedBlockWords.join('\n')
    // 弹幕池保存位置清空
    setDanmakuDirInput.value = ''
    player.toast('已恢复默认(屏蔽列表除外),请点击「保存」确认生效')
  })
  // ★ 浏览按钮:选择本地弹幕池文件夹
  setDanmakuBrowseBtn.addEventListener('click', () => {
    if (window.DanmakuIO && window.DanmakuIO.chooseDanmakuDir) {
      window.DanmakuIO.chooseDanmakuDir().then((dir) => {
        if (dir) setDanmakuDirInput.value = dir.path || ''
      })
    }
  })
  D.$('#set-save').addEventListener('click', () => {
    settings.defaultSender = setSenderInput.value.trim() || '我'
    settings.showStageHint = setHintCheckbox.checked
    const prevPercent = !!settings.percentOnlyScale
    const newPercent = setPercentOnlyScaleCheckbox ? !!setPercentOnlyScaleCheckbox.checked : true
    settings.percentOnlyScale = newPercent
    // ★ 同步到 engine
    if (window.App && window.App.engine) {
      window.App.engine.percentCoordOnlyScale = settings.percentOnlyScale
      // ★ 刷新已在屏的高级弹幕文本(字号缓存 sig 已含 usePercent;强制刷新一次)
      if (window.App.engine.advanced && Array.isArray(window.App.engine.advanced.active)) {
        window.App.engine.advanced.active.forEach((dm) => { if (dm) { dm._sig = ''; dm.applyTextStyle() } })
      }
    }
    // ★ 当用户「从关闭 -> 开启」仅坐标缩放时,弹 toast 提示 B 站注意事项
    if (!prevPercent && newPercent) {
      player.toast('B站的百分比弹幕是仅坐标缩放的,大小不会变,设计弹幕时需注意')
    }
    // ★ 保存 autoSave 设置并同步到 store
    settings.autoSave = setAutoSaveCheckbox ? !!setAutoSaveCheckbox.checked : false
    if (window.App && window.App.store) {
      window.App.store.autoSave = settings.autoSave
    }
    // ★ 保存「程序启动时自动打开最近改动」设置(启动逻辑 loadStartDanmaku 读取)
    settings.autoOpenRecent = setAutoOpenRecentCheckbox ? !!setAutoOpenRecentCheckbox.checked : false
    // ★ 保存屏蔽列表
    settings.blockWords = setBlockWordsTextarea
      ? setBlockWordsTextarea.value.split('\n').map((w) => w.trim()).filter(Boolean)
      : []
    // ★ 保存显示缩放设置并立即应用
    settings.displayScale = setDisplayScaleSlider
      ? Math.min(2, Math.max(0.5, (Number(setDisplayScaleSlider.value) || 100) / 100))
      : 1
    settings.autoDpi = setAutoDpiCheckbox ? !!setAutoDpiCheckbox.checked : false
    applyDisplayScaleFromSettings()
    // ★ 保存本地弹幕池保存位置
    const dirVal = setDanmakuDirInput.value.trim()
    if (window.DanmakuIO && window.DanmakuIO.setDanmakuDir) {
      window.DanmakuIO.setDanmakuDir(dirVal).then((ok) => {
        if (ok === false) {
          player.toast('保存位置设置失败')
          return
        }
        // 重新 ensure start.json 在新位置
        if (window.DanmakuIO.ensureStartDanmaku) {
          window.DanmakuIO.ensureStartDanmaku().then(() => {})
        }
      })
    }
    saveSettings(settings)
    settingsDialog.hidden = true
    player.toast('设置已保存')
  })

  // 撤回/恢复按钮 + 快捷键
  const btnUndo = D.$('#btn-undo')
  const btnRedo = D.$('#btn-redo')
  const refreshUndo = () => {
    btnUndo.disabled = !undo.canUndo()
    btnRedo.disabled = !undo.canRedo()
  }
  undo.onStateChange = refreshUndo
  refreshUndo()
  btnUndo.addEventListener('click', () => undo.undo())
  btnRedo.addEventListener('click', () => undo.redo())

  // 右侧面板收回 / 弹幕列表收回
  const side = D.$('#side')
  const sideBtn = D.$('#side-collapse')
  sideBtn.addEventListener('click', () => {
    side.classList.toggle('collapsed')
  })
  const listPanel = D.$('#list-panel')
  D.$('#list-collapse').addEventListener('click', () => {
    // ★ 逻辑与普通弹幕面板一致:切换 collapsed 的同时,清理拖拽产生的内联 height/flex
    // (否则即使加了 collapsed,内联 height 仍撑开整个 section,无法真正收起)
    const willCollapse = !listPanel.classList.contains('collapsed')
    listPanel.classList.toggle('collapsed', willCollapse)
    if (willCollapse) {
      listPanel.style.flex = ''
      listPanel.style.height = ''
    }
  })
  D.$('#list-save').addEventListener('click', () => {
    controls.saveViaUserAction()
  })
  D.$('#list-delete-sel').addEventListener('click', () => {
    const ids = Array.from(store.selectedIds)
    // ★ 单选也允许删除(之前只处理 >=2,单选点击无反应)
    if (ids.length >= 1) {
      // ★ 范围校验
      const list = window.App && window.App.list
      if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete(ids)) {
        player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
        return
      }
      store.removeMany(ids)
    }
  })
  // 面板添加/发送/收纳
  D.$('#pn-add').addEventListener('click', () => controls.addNew('normal'))
  D.$('#pa-add').addEventListener('click', () => controls.addNew('advanced'))
  D.$('#pn-send').addEventListener('click', () => controls.validateAndSend('normal'))
  // ★ 歌词模式:点击「发送」按LRC时间戳批量生成歌词弹幕;否则走普通校验发送
  D.$('#pa-send').addEventListener('click', () => {
    if (panelAdvanced._lrcMode) { panelAdvanced.sendLrcDanmaku(); return }
    controls.validateAndSend('advanced')
  })
  D.$('#pn-collapse').addEventListener('click', () => {
    D.$('#panel-normal-wrap').classList.toggle('collapsed')
  })
  D.$('#pa-collapse').addEventListener('click', () => {
    D.$('#panel-advanced-wrap').classList.toggle('collapsed')
  })
  D.$('#pa-preview').addEventListener('click', () => controls.previewAdvanced(D.$('#pa-immediate').checked))
  // ★ 一键清除所有预览弹幕(仅 _preview 标记的,不影响正式弹幕)
  D.$('#pa-clear-preview').addEventListener('click', () => {
    engine.advanced.clearPreviews()
    player.toast('已清除所有预览')
  })

  // ★ 深度批量纯高级弹幕:批量底部 4 控件(与单选功能完全一致)
  if (D.$('#pa-batch-preview')) {
    D.$('#pa-batch-preview').addEventListener('click', () => {
      // ★ C7:预览「所有」被深度批量选中的高级弹幕(原先只预览第一条 + hideNonPreviews 把其他选中弹幕也隐藏了)
      const list = App.list
      const batchSet = list && list._batchIds && list._batchIds.size ? list._batchIds : store.selectedIds
      const advRecs = []
      for (const id of batchSet) {
        const r = store.get(id)
        if (r && r.type === 'advanced') advRecs.push(r)
      }
      if (!advRecs.length) {
        player.toast('请先选中至少一条高级弹幕再预览')
        return
      }
      const nowSec = (engine.clock && typeof engine.clock.now === 'function') ? engine.clock.now() : 0
      const immediate = !!(D.$('#pa-batch-immediate') && D.$('#pa-batch-immediate').checked)
      // ★ 隐藏所有非预览的正式弹幕(含被批量选中的正式弹幕);预览副本(_preview)可见
      engine.hideNonPreviews && engine.hideNonPreviews()
      for (const rec of advRecs) {
        const v = window.DanmakuConvert.validateRecord(rec)
        if (!v.ok) continue
        const tmp = JSON.parse(JSON.stringify(rec))
        tmp.timeSec = nowSec
        tmp._preview = true
        if (immediate) tmp._previewImmediate = true
        engine.advanced.removePreviewById(tmp.id)
        engine.advanced.spawn(tmp)
      }
      player.toast('批量预览中…(展示 ' + advRecs.length + ' 条当前参数)')
    })
  }
  if (D.$('#pa-batch-clear-preview')) {
    D.$('#pa-batch-clear-preview').addEventListener('click', () => {
      engine.advanced.clearPreviews()
      player.toast('已清除所有预览')
    })
  }
  if (D.$('#pa-batch-change')) {
    D.$('#pa-batch-change').addEventListener('click', () => {
      // 批量提交:相当于给每个被批量改动的弹幕点一次「更改」,更新 ctime + 固化快照
      const n = store.commitBatch ? store.commitBatch() : 0
      if (n > 0) player.toast('批量改动已保存(' + n + '条)')
      else player.toast('当前批量选中的弹幕暂无可保存改动')
    })
  }
  // 立即展示效果开关(批量):与单选行为完全相同,不自动联动单选的勾选
  // (允许用户在单选/批量状态下各自保持偏好)

  // 列表拖拽调整高度
  const listResize = D.$('#list-resize')
  if (listResize) {
    listResize.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = listPanel.offsetHeight
      // 计算高度下限:非 flex 子元素(除 #list-body 外所有可见元素)总高度 + list-body 最小 60px
      // 避免 list-resize 被 #side-inner 的 overflow:hidden 裁剪到可视范围外,无法再次拖动
      const calcMinH = () => {
        let fixed = 0
        for (const c of listPanel.children) {
          if (c.id === 'list-body') continue
          if (c.hidden || c.style.display === 'none') continue
          fixed += c.offsetHeight || 0
        }
        return Math.max(120, fixed + 60)
      }
      const minH = calcMinH()
      const maxH = window.innerHeight - 260
      const onMove = (ev) => {
        const h = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH))
        listPanel.style.flex = 'none'
        listPanel.style.height = h + 'px'
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    })
  }

  // ★ 启动时加载本地弹幕池中的 start.json 作为预览弹幕(无则自动从根目录创建)
  controls.loadStartDanmaku()

  engine.start()

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'

    // ═══════════════════════════════════════════════════════════════════
    // Ctrl/Cmd + S = 保存当前弹幕池到磁盘文件(覆盖当前已关联文件,无关联则弹选择)
    //   · 歌词模式特殊:歌词模式下 Ctrl+S = 发送 LRC 弹幕,因保存优先级在歌词模式无意义
    //   · 输入框内:Ctrl+S 仍保存文件(防止用户写弹幕文本时想顺手保存)
    // ═══════════════════════════════════════════════════════════════════
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      const app = window.App
      // ★ 歌词模式:Ctrl+S 按 LRC 时间戳批量生成歌词弹幕
      if (app && app.panelAdvanced && app.panelAdvanced._lrcMode) {
        app.panelAdvanced.sendLrcDanmaku()
        return
      }
      // 正常 Ctrl+S:保存弹幕池文件(无改动时提示「你已经保存了最新改动！」并跳过重写)
      if (app && app.controls && typeof app.controls.saveViaUserAction === 'function') {
        app.controls.saveViaUserAction()
      }
      return
    }

    // ═══════════════════════════════════════════════════════════════════
    // Ctrl/Cmd + Enter = 发送 / 更改当前面板内容
    //   (原本错误绑在 Ctrl+S 上;对应用户"点面板发送按钮/更改按钮"的手动行为)
    //   · 歌词模式:保持歌词批量发送
    //   · 输入焦点时生效(用户在正文输入时 Ctrl+Enter 提交)
    // ═══════════════════════════════════════════════════════════════════
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === '⏎' || e.key === '\n')) {
      const ae = document.activeElement
      const aeTag = ae && ae.tagName
      const isInputLike = ae && (aeTag === 'INPUT' || aeTag === 'TEXTAREA' || aeTag === 'SELECT' || ae.isContentEditable)
      const shouldSend = !isTyping || isInputLike
      if (shouldSend) {
        e.preventDefault()
        const app = window.App
        if (app && app.panelAdvanced && app.panelAdvanced._lrcMode) {
          app.panelAdvanced.sendLrcDanmaku()
          return
        }
        const rec = app && app.store ? app.store.getSelected() : null
        if (rec && app.controls && typeof app.controls.validateAndSend === 'function') {
          app.controls.validateAndSend(rec.type || 'advanced')
        } else if (app && app.store && app.store.draft && app.controls && typeof app.controls.validateAndSend === 'function') {
          app.store.select(app.store.draft.id)
          app.controls.validateAndSend(app.store.draft.type || 'advanced')
        }
      }
      return
    }

    if (isTyping) return

    // ★ 弹幕池对话框打开时:快捷键路由到弹幕池逻辑
    const poolDialog = D.$('#danmaku-pool')
    const poolOpen = poolDialog && !poolDialog.hidden
    if (poolOpen) {
      // Ctrl+Z:撤回(在弹幕池里也生效)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo.undo()
        return
      }
      // Ctrl+D:删除弹幕池中选中的弹幕
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        const deleted = list.poolDeleteSelected()
        if (!deleted) player.toast('请先在弹幕池中选中要删除的弹幕')
        return
      }
      // Ctrl+A:弹幕池全选
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        list.poolSelectAll()
        return
      }
      // Ctrl+C:弹幕池里不能复制,提示错误
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        player.toast('不能在弹幕池里进行复制操作!', { error: true })
        return
      }
      // 其他快捷键(Space/Escape)在弹幕池里也生效
      if (e.code === 'Escape') {
        // 逐级关闭:导入弹窗 → 右键菜单 → 弹幕池
        const fileDialog = D.$('#file-dialog')
        if (fileDialog && !fileDialog.hidden) {
          fileDialog.hidden = true
          return
        }
        const ctxMenu = D.$('#dp-ctx-menu')
        if (ctxMenu && !ctxMenu.hidden) {
          list._hidePoolCtxMenu()
          return
        }
        // 最后关闭弹幕池
        list.closePoolOverview()
        return
      }
      return
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undo.undo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      undo.redo()
      return
    }
    // Ctrl/Cmd + A(非输入框):列表轻度全选展示中所有弹幕
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      const list = window.App && window.App.list
      if (list && typeof list.selectAllShowing === 'function') list.selectAllShowing()
      return
    }
    // ★ Ctrl/Cmd + C(非输入框):复制当前选中(描边框)的单条弹幕
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      if (store.selectedIds.size === 1) {
        e.preventDefault()
        const id = Array.from(store.selectedIds)[0]
        const copy = store.duplicate(id)
        if (copy) {
          store.select(copy.id)
          player.toast('已复制弹幕(发送人: ' + (copy.sender || '我') + ')')
        }
      }
      return
    }
    // ★ Ctrl/Cmd + D(非输入框):直接删除当前选中的弹幕(单条或多条)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (store.selectedIds.size >= 1) {
        e.preventDefault()
        const ids = Array.from(store.selectedIds)
        // ★ 范围校验
        const list = window.App && window.App.list
        if (list && typeof list._validateRangeBeforeDelete === 'function' && !list._validateRangeBeforeDelete(ids)) {
          player.toast('发生错误！修改后的弹幕无法满足你设定好的展示范围,要继续进行操作请调整展示设置。', { error: true })
          return
        }
        store.removeMany(ids)
        player.toast('已删除 ' + ids.length + ' 条弹幕')
      }
      return
    }
    if (e.code === 'Space') {
      // 空格键控制播放/暂停;preventDefault 避免误触发聚焦按钮
      e.preventDefault()
      if (clock.playing) engine.pause()
      else {
        engine.play()
        player.hideHint()
      }
      return
    } else if (e.code === 'Escape') {
      // 全局 Escape:先关闭文件弹窗,再处理 editor 相关
      const fileDialog = D.$('#file-dialog')
      if (fileDialog && !fileDialog.hidden) {
        fileDialog.hidden = true
        return
      }
      editor.cancelPick()
      editor.hideCtxMenu()
    }
  })

  // 周期性刷新控制条 UI
  setInterval(() => controls.refresh(), 200)

  /* ===== 关闭程序前弹三态保存提示(Electron 主进程 close 拦截 → executeJavaScript 调用此函数) ===== */
  /** 协议:返回 Promise<{ allowQuit: boolean }>。
   *  - 无未保存改动 → 直接 { allowQuit: true }
   *  - 有未保存改动 → showConfirmModal 三态:保存并退出→true,不保存直接退出→true,×/Esc/遮罩→false。 */
  window.__quitFlowCheck = function () {
    return new Promise(function (resolve) {
      function safeResolve(v) {
        try { resolve(v) } catch (_) {}
      }
      try {
        const app = window.App
        if (!app || !app.controls || typeof app.controls.hasUnsavedChanges !== 'function') {
          safeResolve({ allowQuit: true })
          return
        }
        if (!app.controls.hasUnsavedChanges()) {
          safeResolve({ allowQuit: true })
          return
        }
        // 防重入:上一个弹窗未处理完再触发时,默认取消退出(保留用户上下文)
        if (app.controls._quitPending) {
          safeResolve({ allowQuit: false })
          return
        }
        app.controls._quitPending = true
        // 复用已有的 _promptSaveBeforeReplace('quit')
        const prompt = typeof app.controls._promptSaveBeforeReplace === 'function'
          ? app.controls._promptSaveBeforeReplace('quit')
          : (function () {
              if (!global.DanmakuIO || !global.DanmakuIO.showConfirmModal) return Promise.resolve('secondary')
              return global.DanmakuIO.showConfirmModal({
                title: '退出程序',
                message: '您有未保存的改动,请问是否保存后退出程序?此操作不可撤销！\n\n' +
                  '  · 保存并退出 = 先保存当前弹幕,再退出程序\n' +
                  '  · 不保存直接退出 = 丢弃当前改动\n' +
                  '  · 关闭 / Esc = 取消本次退出操作',
                primaryText: '保存并退出',
                secondaryText: '不保存直接退出',
              })
            })()
        prompt.then(function (choice) {
          if (choice === null) {
            app.controls._quitPending = false
            safeResolve({ allowQuit: false }) // ×/Esc → 取消退出
            return
          }
          const finalize = function () {
            app.controls._quitPending = false
            safeResolve({ allowQuit: true })
          }
          if (choice === true) {
            // 保存并退出:尽力保存,保存失败也允许退出(避免用户卡死无法关闭)
            try {
              const pr = app.controls.saveDanmakuFile({ silent: true })
              if (pr && typeof pr.then === 'function') pr.then(finalize, finalize)
              else finalize()
            } catch (_) { finalize() }
            return
          }
          // 'secondary' 不保存直接退出
          finalize()
        }, function () {
          app.controls._quitPending = false
          safeResolve({ allowQuit: true }) // Promise 异常兜底:允许退出
        })
      } catch (err) {
        console.error('quitFlow renderer error:', err && err.message ? err.message : err)
        safeResolve({ allowQuit: true })
      }
    })
  }
  // 浏览器预览模式兜底:beforeunload 返回字符串提示(Electron 不走这里,因为主进程负责 close)
  window.addEventListener('beforeunload', function (e) {
    try {
      const app = window.App
      if (app && app.controls && typeof app.controls.hasUnsavedChanges === 'function' && app.controls.hasUnsavedChanges()) {
        const msg = '您有未保存的改动,确定要离开吗?'
        e.preventDefault()
        e.returnValue = msg
        return msg
      }
    } catch (_) {}
  })
})()
