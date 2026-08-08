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

  // ★ 全局设置:默认发送人 + 启动时是否显示舞台提示。持久化到 localStorage。
  const SETTINGS_KEY = 'app_settings'
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const s = JSON.parse(raw)
        return {
          defaultSender: s.defaultSender != null ? String(s.defaultSender) : '我',
          showStageHint: s.showStageHint !== false, // 默认 true
        }
      }
    } catch (_) {}
    return { defaultSender: '我', showStageHint: true }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch (_) {}
  }
  const settings = loadSettings()
  window.App.settings = settings

  // ★ 启动时根据设置控制舞台提示显示
  if (!settings.showStageHint) {
    player.hintDismissed = true
    player.hideHint()
  }

  // ★ 设置面板:打开/保存/取消
  const settingsDialog = D.$('#settings-dialog')
  const setSenderInput = D.$('#set-default-sender')
  const setHintCheckbox = D.$('#set-show-stage-hint')
  const setDanmakuDirInput = D.$('#set-danmaku-dir')
  const setDanmakuBrowseBtn = D.$('#set-danmaku-browse')
  D.$('#btn-settings').addEventListener('click', () => {
    setSenderInput.value = settings.defaultSender
    setHintCheckbox.checked = settings.showStageHint
    // ★ 回填本地弹幕池当前保存位置
    if (window.DanmakuIO && window.DanmakuIO.getDanmakuDir) {
      window.DanmakuIO.getDanmakuDir().then((dir) => {
        if (dir) setDanmakuDirInput.value = dir
      })
    }
    settingsDialog.hidden = false
  })
  D.$('#set-cancel').addEventListener('click', () => {
    settingsDialog.hidden = true
  })
  // ★ 浏览按钮:选择本地弹幕池文件夹
  setDanmakuBrowseBtn.addEventListener('click', () => {
    if (window.DanmakuIO && window.DanmakuIO.chooseDanmakuDir) {
      window.DanmakuIO.chooseDanmakuDir().then((dir) => {
        if (dir) setDanmakuDirInput.value = dir
      })
    }
  })
  D.$('#set-save').addEventListener('click', () => {
    settings.defaultSender = setSenderInput.value.trim() || '我'
    settings.showStageHint = setHintCheckbox.checked
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
    listPanel.classList.toggle('collapsed')
  })
  D.$('#list-save').addEventListener('click', () => {
    controls.saveDanmakuFile()
  })
  D.$('#list-delete-sel').addEventListener('click', () => {
    const ids = Array.from(store.selectedIds)
    if (ids.length >= 2) store.removeMany(ids)
  })
  // 面板添加/发送/收纳
  D.$('#pn-add').addEventListener('click', () => controls.addNew('normal'))
  D.$('#pa-add').addEventListener('click', () => controls.addNew('advanced'))
  D.$('#pn-send').addEventListener('click', () => controls.validateAndSend('normal'))
  D.$('#pa-send').addEventListener('click', () => controls.validateAndSend('advanced'))
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

    // Ctrl/Cmd + S:保存当前弹幕池到本地 JSON(不自动发送草稿)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      // 仅保存 store 中已入池的记录;草稿(store.draft)不会被自动发送/写入
      if (window.App && window.App.controls && typeof window.App.controls.saveDanmakuFile === 'function') {
        window.App.controls.saveDanmakuFile()
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
})()
