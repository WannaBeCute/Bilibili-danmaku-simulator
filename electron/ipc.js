/**
 * electron/ipc.js:注册所有 IPC 处理器。
 * 由 main.js 注册全部文件读写与侧车探测的 IPC 处理器。
 */
'use strict'

module.exports = function registerIpc({ app, ipcMain, dialog, BrowserWindow, fs, path }) {
  /* ---------- IPC:打开文件 ---------- */
  ipcMain.handle('open-file', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win, {
      title: (opts && opts.title) || '打开文件',
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths.length) return null
    const p = res.filePaths[0]
    try {
      const text = fs.readFileSync(p, 'utf8')
      return { name: path.basename(p), path: p, text: text }
    } catch (err) {
      return { name: path.basename(p), path: p, text: null, error: err.message }
    }
  })

  /* ---------- IPC:系统 DPI 缩放系数(主屏幕)----------
   * 「自动适配屏幕DPI」用:renderer 侧 window.devicePixelRatio 会被页面自身
   * zoom 影响(缩放叠加),因此从主进程 screen API 读取原始系统缩放系数。 */
  ipcMain.handle('get-display-scale-factor', async () => {
    try {
      const { screen } = require('electron')
      const f = screen.getPrimaryDisplay().scaleFactor
      return Number.isFinite(f) && f > 0 ? f : 1
    } catch (err) {
      return 1
    }
  })

  /* ---------- IPC:保存文件 ---------- */
  ipcMain.handle('save-file', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const name = (opts && opts.name) || 'danmaku.json'
    let defaultPath = name
    if (opts && opts.defaultDir) {
      defaultPath = path.join(opts.defaultDir, name)
    }
    const res = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: defaultPath,
      filters: [{ name: '文件', extensions: [name.split('.').pop() || '*'] }],
    })
    if (res.canceled || !res.filePath) return null
    fs.writeFileSync(res.filePath, opts.text, 'utf8')
    return { name: path.basename(res.filePath), path: res.filePath }
  })

  /* ---------- IPC:静默写入指定路径(创建同名弹幕文件) ---------- */
  ipcMain.handle('save-to-path', async (event, opts) => {
    try {
      fs.writeFileSync(opts.path, opts.text, 'utf8')
      return true
    } catch (err) {
      return false
    }
  })

  /* ---------- IPC:弹幕文件库 ---------- */
  /** 自定义弹幕库文件夹路径的持久化配置文件路径(存 userData 下,避免每次启动回到默认)。 */
  function getLibConfigPath() {
    return path.join(app.getPath('userData'), 'danmaku-library-config.json')
  }
  function _readLibDirConfig() {
    try {
      const txt = fs.readFileSync(getLibConfigPath(), 'utf8')
      const obj = JSON.parse(txt || '{}')
      return (obj && typeof obj.dir === 'string' && obj.dir) ? obj.dir : null
    } catch (e) { return null }
  }
  function _writeLibDirConfig(dir) {
    try {
      fs.writeFileSync(
        getLibConfigPath(),
        JSON.stringify({ dir: dir ? String(dir) : null }, null, 2),
        'utf8'
      )
      return true
    } catch (e) { return false }
  }

  /** 本地弹幕库根目录(持久化自定义 > 默认 userData/danmaku-files)。 */
  function getDanmakuDirPath() {
    const custom = _readLibDirConfig()
    let dir = custom
    if (!dir) {
      dir = path.join(app.getPath('userData'), 'danmaku-files')
    }
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        /* ignore */
      }
    }
    return dir
  }

  ipcMain.handle('get-danmaku-dir', async () => {
    return { path: getDanmakuDirPath(), defaultPath: path.join(app.getPath('userData'), 'danmaku-files') }
  })

  /** 直接设置本地弹幕库文件夹(用于输入框手动修改后保存)。 */
  ipcMain.handle('set-danmaku-dir', async (event, opts) => {
    const dir = opts && opts.path ? String(opts.path).trim() : ''
    if (!dir) {
      // 传空 = 重置为默认(删自定义配置,回到 userData/danmaku-files)
      _writeLibDirConfig(null)
      return { path: getDanmakuDirPath(), ok: true }
    }
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      // 简单校验:必须是文件夹(存在且不是文件)
      if (!fs.statSync(dir).isDirectory()) {
        return { path: getDanmakuDirPath(), ok: false, error: '路径指向的不是文件夹' }
      }
    } catch (e) {
      return { path: getDanmakuDirPath(), ok: false, error: e.message || '设置失败' }
    }
    _writeLibDirConfig(dir)
    return { path: getDanmakuDirPath(), ok: true }
  })

  ipcMain.handle('choose-danmaku-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showOpenDialog(win, {
      title: '选择本地弹幕池文件夹',
      // ★ Windows 下仅允许选文件夹(FolderBrowserDialog 等价),不能选文件
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getDanmakuDirPath(),
    })
    if (res.canceled || !res.filePaths.length) return null
    const dir = res.filePaths[0]
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    _writeLibDirConfig(dir)
    return { path: getDanmakuDirPath() }
  })

  ipcMain.handle('list-danmaku-files', async () => {
    const dir = getDanmakuDirPath()
    let files = []
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.json'))
        .map((f) => {
          const p = path.join(dir, f)
          let mtime = 0
          try {
            mtime = fs.statSync(p).mtimeMs
          } catch (e) {
            /* ignore */
          }
          return { name: f, path: p, mtime: mtime }
        })
        .sort((a, b) => b.mtime - a.mtime)
    } catch (e) {
      /* ignore */
    }
    return { dir: dir, files: files }
  })

  ipcMain.handle('read-danmaku-file', async (event, opts) => {
    try {
      const text = fs.readFileSync(opts.path, 'utf8')
      return { text: text }
    } catch (err) {
      return null
    }
  })

  /* ---------- IPC:确保本地弹幕池存在 start.json(预览弹幕) ----------
   * 启动时调用:若本地弹幕池目录下没有 start.json,则从应用根目录的 start.json
   * 模板复制一份过去;然后读取并返回其内容。保证本地弹幕池始终至少有一个弹幕文件。*/
  ipcMain.handle('ensure-start-danmaku', async () => {
    const dir = getDanmakuDirPath()
    const target = path.join(dir, 'start.json')
    // 应用根目录的 start.json 模板(electron/ 的上一层即 app 根目录)
    const template = path.join(__dirname, '..', 'start.json')
    let created = false
    try {
      if (!fs.existsSync(target)) {
        // 本地弹幕池没有 start.json:从模板复制
        const tplText = fs.readFileSync(template, 'utf8')
        fs.writeFileSync(target, tplText, 'utf8')
        created = true
      }
      const text = fs.readFileSync(target, 'utf8')
      return { text: text, path: target, created: created }
    } catch (err) {
      return { text: null, path: target, created: created, error: err.message }
    }
  })

  /* ---------- IPC:删除本地弹幕池中的指定文件 ---------- */
  ipcMain.handle('delete-danmaku-file', async (event, opts) => {
    try {
      const p = String((opts && opts.path) || '')
      if (!p) return { ok: false, error: '路径为空' }
      if (fs.existsSync(p)) fs.unlinkSync(p)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('save-danmaku-to-dir', async (event, opts) => {
    const dir = getDanmakuDirPath()
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const name =
      'danmaku-' +
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      '-' +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds()) +
      '.json'
    try {
      fs.writeFileSync(path.join(dir, name), opts.text, 'utf8')
      return { name: name, path: path.join(dir, name) }
    } catch (err) {
      return null
    }
  })

  /* ---------- IPC:探测侧车弹幕(视频名.json 同目录) ---------- */
  ipcMain.handle('check-sidecar', async (event, opts) => {
    const videoPath = opts && opts.videoPath
    const videoName = (opts && opts.videoName) || ''
    if (!videoPath) return null
    const dir = path.dirname(videoPath)
    const base = videoName.replace(/\.[^/.]+$/, '') || path.basename(videoPath, path.extname(videoPath))
    const candidates = [path.join(dir, base + '.json'), path.join(dir, videoName + '.json')]
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) {
          const text = fs.readFileSync(c, 'utf8')
          return { name: path.basename(c), path: c, text: text }
        }
      } catch (err) {
        /* 忽略单个候选读取失败 */
      }
    }
    return null
  })

  /* ---------- IPC:确认对话框(Electron 中 window.confirm 不可靠) ---------- */
  ipcMain.handle('confirm', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['确定', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: (opts && opts.message) || '',
      title: '确认',
    })
    return res.response === 0
  })
}
