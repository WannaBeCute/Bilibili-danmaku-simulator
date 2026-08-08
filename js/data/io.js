/**
 * io.js:文件读写,浏览器 / Electron 双实现。
 *   - 浏览器:读用 <input type=file> + FileReader;写用 Blob + <a download>。
 *   - Electron:优先 window.api(由 preload 暴露,dialog + fs 真实落盘)。
 */
(function (global) {
  'use strict'

  const hasApi = () => !!(global.window && global.window.api && global.window.api.openFile)

  /**
   * 读取文件。返回 { name, text } 或 null(取消)。
   * @param {string} accept 过滤器
   * @param {string} title 标题(Electron 对话框)
   */
  function readFile(accept, title) {
    if (hasApi()) {
      return global.window.api
        .openFile({ accept: accept, title: title || '打开文件' })
        .then((res) => (res ? { name: res.name, text: res.text } : null))
    }
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept || ''
      input.onchange = () => {
        const file = input.files && input.files[0]
        if (!file) {
          resolve(null)
          return
        }
        const reader = new FileReader()
        reader.onload = () => resolve({ name: file.name, text: String(reader.result) })
        reader.onerror = () => resolve(null)
        reader.readAsText(file)
      }
      input.click()
    })
  }

  /**
   * 保存文件。
   * @param {string} defaultName 默认文件名
   * @param {string} text 内容
   * @param {{defaultDir?:string, filterLabel?:string}} [opts] 默认保存目录(Electron)
   * @returns {Promise<{name:string}|null>} 保存的文件名或 null(取消)
   */
  function saveFile(defaultName, text, opts) {
    opts = opts || {}
    if (hasApi()) {
      return global.window.api
        .saveFile({
          name: defaultName,
          text: text,
          filterLabel: opts.filterLabel || '',
          defaultDir: opts.defaultDir || '',
        })
        .then((res) => (res ? { name: res.name } : null))
    }
    return new Promise((resolve) => {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName || 'danmaku.json'
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        URL.revokeObjectURL(url)
        a.remove()
        resolve({ name: defaultName })
      }, 400)
    })
  }

  /**
   * Electron:按视频路径探测侧车弹幕文件(视频名.json)。
   * 浏览器模式无文件系统,返回 null。
   */
  function checkSidecar(videoPath, videoName) {
    if (!videoPath && !videoName) return Promise.resolve(null)
    if (hasApi()) {
      return global.window.api
        .checkSidecar({ videoPath: videoPath, videoName: videoName })
        .then((res) => (res ? { name: res.name, text: res.text, path: res.path } : null))
    }
    return Promise.resolve(null)
  }

  /**
   * 静默写入指定路径(用于"创建与视频同名的弹幕文件")。
   * Electron:window.api.saveToPath;浏览器:回退下载。
   * @returns {Promise<boolean>} 是否成功
   */
  function saveSilent(path, text) {
    if (hasApi() && global.window.api.saveToPath) {
      return global.window.api
        .saveToPath({ path: path, text: text })
        .then((res) => !!res)
        .catch(() => false)
    }
    // 浏览器回退:以文件名下载
    const name = String(path).split(/[\\/]/).pop() || 'danmaku.json'
    return saveFile(name, text, { filterLabel: '弹幕 JSON' }).then((res) => !!res)
  }

  /* ---------- 弹幕文件库(仅 Electron) ---------- */

  function getDanmakuDir() {
    if (hasApi()) return global.window.api.getDanmakuDir()
    return Promise.resolve({ path: null })
  }

  function listDanmakuFiles() {
    if (hasApi()) return global.window.api.listDanmakuFiles()
    return Promise.resolve({ dir: null, files: [] })
  }

  function saveDanmakuToDir(text) {
    if (hasApi()) return global.window.api.saveDanmakuToDir({ text: text })
    return Promise.resolve(null)
  }

  function readDanmakuFile(path) {
    if (hasApi()) return global.window.api.readDanmakuFile({ path: path })
    return Promise.resolve(null)
  }

  /** ★ 确保本地弹幕池存在 start.json(预览弹幕):无则从应用根目录模板创建,返回其文本。 */
  function ensureStartDanmaku() {
    if (hasApi() && global.window.api.ensureStartDanmaku) {
      return global.window.api.ensureStartDanmaku()
    }
    // 浏览器回退:fetch 根目录 start.json
    return fetch('start.json').then((r) => (r.ok ? r.text() : null)).catch(() => null).then((text) => ({
      text: text,
      path: 'start.json',
      created: false,
    }))
  }

  /** ★ 删除本地弹幕池中的指定文件。 */
  function deleteDanmakuFile(path) {
    if (hasApi() && global.window.api.deleteDanmakuFile) {
      return global.window.api.deleteDanmakuFile({ path: path })
    }
    return Promise.resolve({ ok: false, error: '非桌面版不可用' })
  }

  function chooseDanmakuDir() {
    if (hasApi()) return global.window.api.chooseDanmakuDir()
    return Promise.resolve(null)
  }

  /** 直接设置本地弹幕库根目录(用于路径输入框提交手动写的路径)。 */
  function setDanmakuDir(dir) {
    if (hasApi() && global.window.api.setDanmakuDir) {
      return global.window.api.setDanmakuDir({ path: dir != null ? String(dir) : null })
    }
    return Promise.resolve({ ok: false, path: null, error: '非桌面版不可用' })
  }

  /**
   * 确认对话框:Electron 用原生 dialog,浏览器用 window.confirm。
   * @returns {Promise<boolean>}
   */
  function confirmDialog(message) {
    if (hasApi() && global.window.api.confirm) {
      return global.window.api.confirm({ message: message })
    }
    return Promise.resolve(confirm(message))
  }

  global.DanmakuIO = {
    hasApi: hasApi,
    readFile: readFile,
    saveFile: saveFile,
    saveSilent: saveSilent,
    checkSidecar: checkSidecar,
    getDanmakuDir: getDanmakuDir,
    listDanmakuFiles: listDanmakuFiles,
    saveDanmakuToDir: saveDanmakuToDir,
    readDanmakuFile: readDanmakuFile,
    ensureStartDanmaku: ensureStartDanmaku,
    deleteDanmakuFile: deleteDanmakuFile,
    chooseDanmakuDir: chooseDanmakuDir,
    setDanmakuDir: setDanmakuDir,
    confirmDialog: confirmDialog,
  }
})(window)
