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
      // 剥 UTF-8 BOM:浏览器 fetch text() 会保留 EF BB BF 成 \uFEFF,JSON.parse('\uFEFF{...}') 在部分环境报错
      text: typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text,
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

  /* ---------- 本地弹幕池:双通道(localStorage / 磁盘) ---------- */

  var LIB_KEY = 'danmakuLibrary'

  function detectFormat(name) {
    var ext = (name || '').split('.').pop().toLowerCase()
    if (ext === 'xml') return 'XML'
    if (ext === 'ass') return 'ASS'
    return 'JSON'
  }

  function parseDanmakuMeta(text, name) {
    var fmt = detectFormat(name)
    var count = 0
    try {
      if (fmt === 'JSON') {
        var data = JSON.parse(text)
        var arr = Array.isArray(data) ? data : (data.p ? data.p.comments : (data.comments || []))
        count = Array.isArray(arr) ? arr.length : 0
      } else if (fmt === 'XML') {
        count = (String(text).match(/<d\s/g) || []).length
      } else if (fmt === 'ASS') {
        count = (String(text).match(/^Dialogue:/gm) || []).length
      }
    } catch (_) {}
    return { count: count, format: fmt }
  }

  function listLibraryEntries() {
    if (hasApi()) {
      return global.window.api.listDanmakuFiles().then(function (res) {
        if (!res.files.length) return { dir: res.dir, entries: [] }
        // ★ Electron 端已在主进程一次性解析好 count/format,无需 renderer 再读文件
        var entries = res.files.map(function (f) {
          return {
            id: f.path,
            name: f.name,
            path: f.path,
            modifiedAt: f.mtime || Date.now(),
            count: f.count || 0,
            format: f.format || 'JSON',
          }
        })
        return { dir: res.dir, entries: entries }
      })
    }
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    return Promise.resolve({ dir: null, entries: entries })
  }

  function saveLibraryEntry(name, text) {
    var meta = parseDanmakuMeta(text, name)
    if (hasApi()) {
      return global.window.api.saveDanmakuToDir({ text: text }).then(function (res) {
        return res ? { id: res.path || res.name, name: res.name, modifiedAt: Date.now(), count: meta.count, format: meta.format } : null
      })
    }
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    var id = 'lib-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    var entry = { id: id, name: name, modifiedAt: Date.now(), count: meta.count, format: meta.format, text: text }
    entries.push(entry)
    try { localStorage.setItem(LIB_KEY, JSON.stringify(entries)) } catch (_) {}
    return Promise.resolve(entry)
  }

  function readLibraryEntry(id) {
    if (hasApi()) {
      return global.window.api.readDanmakuFile({ path: id })
    }
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    var entry = null
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) { entry = entries[i]; break }
    }
    return Promise.resolve(entry ? { text: entry.text, name: entry.name } : null)
  }

  function deleteLibraryEntry(id) {
    if (hasApi()) {
      return global.window.api.deleteDanmakuFile({ path: id })
    }
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    entries = entries.filter(function (e) { return e.id !== id })
    try { localStorage.setItem(LIB_KEY, JSON.stringify(entries)) } catch (_) {}
    return Promise.resolve({ ok: true })
  }

  function updateLibraryEntry(id, text) {
    var meta = parseDanmakuMeta(text, String(id).split(/[\\/]/).pop())
    if (hasApi() && global.window.api.saveToPath) {
      return global.window.api.saveToPath({ path: id, text: text }).then(function (res) {
        return { ok: !!res, count: meta.count }
      }).catch(function () { return { ok: false } })
    }
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].id === id) {
        entries[i].text = text
        entries[i].modifiedAt = Date.now()
        entries[i].count = meta.count
        break
      }
    }
    try { localStorage.setItem(LIB_KEY, JSON.stringify(entries)) } catch (_) {}
    return Promise.resolve({ ok: true, count: meta.count })
  }

  function getLibraryEntryIdByName(name) {
    var raw = null
    try { raw = localStorage.getItem(LIB_KEY) } catch (_) {}
    var entries = raw ? JSON.parse(raw) : []
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === name) return entries[i].id
    }
    return null
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

  /** ★ 通用自定义确认弹窗(带右上角 × 关闭按钮、标题、主/次按钮)。
   *  @param {Object} opts
   *    - title: 弹窗标题
   *    - message: 正文内容(支持 \n 换行)
   *    - primaryText: 主按钮文字(默认"确定")
   *    - secondaryText: 次按钮文字(默认"取消")
   *  @returns {Promise<true | 'secondary' | null>}
   *    true      = 主按钮
   *    'secondary' = 次按钮
   *    null      = × / Esc / 遮罩点击(完全取消操作)
   */
  function showConfirmModal(opts) {
    const o = opts || {}
    return new Promise(function (resolve) {
      const el = document.createElement('div')
      el.className = 'confirm-modal'
      el.innerHTML =
        '<div class="cm-box" role="dialog" aria-modal="true">' +
          '<div class="cm-title">' + (o.title || '确认') + '</div>' +
          '<button class="cm-close" title="关闭(完全取消)">✕</button>' +
          '<div class="cm-message"></div>' +
          '<div class="cm-btns">' +
            '<button class="cm-secondary">' + (o.secondaryText || '取消') + '</button>' +
            '<button class="cm-primary">' + (o.primaryText || '确定') + '</button>' +
          '</div>' +
        '</div>'
      // ★ 正文支持 \n 换行,且对"此操作不可撤销！"等标记短语自动用红色强调
      var rawMsg = String(o.message == null ? '' : o.message)
      // 先按 HTML 规则转义,再替换标记为红字 span,最后把 \n 转 <br>
      var escaped = rawMsg
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
      escaped = escaped.replace(/此操作不可撤销！|此操作不可撤销!/g,
        '<span style="color:#ff4d4f;font-weight:700;">此操作不可撤销！</span>')
      el.querySelector('.cm-message').innerHTML = escaped.replace(/\n/g, '<br>')
      document.body.appendChild(el)

      let settled = false
      const cleanup = function () {
        if (settled) return
        settled = true
        el.remove()
        document.removeEventListener('keydown', onKey)
      }
      const resolveWith = function (val) {
        try { cleanup() } catch (_) {}
        resolve(val)
      }

      const onKey = function (e) {
        // 避免输入框里的 Enter/Esc 也触发
        const ae = document.activeElement
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); resolveWith(null) }        // Esc = 完全取消
        else if (e.key === 'Enter') { e.preventDefault(); resolveWith(true) }
      }
      document.addEventListener('keydown', onKey)

      // ★ 三态/关闭按钮:直接绑在按钮节点上,避免父级事件代理(e.target.classes)的漏判问题
      //   (例如按钮内部未来出现 <span> 等子元素时,closest 仍然能正确定位到按钮)
      const btnPri = el.querySelector('.cm-primary')
      const btnSec = el.querySelector('.cm-secondary')
      const btnCls = el.querySelector('.cm-close')
      if (btnPri) btnPri.addEventListener('click', function (ev) { ev.stopPropagation(); resolveWith(true) })
      if (btnSec) btnSec.addEventListener('click', function (ev) { ev.stopPropagation(); resolveWith('secondary') })
      if (btnCls) btnCls.addEventListener('click', function (ev) { ev.stopPropagation(); resolveWith(null) })

      // 遮罩(confirm-modal 最外层)点击 = 完全取消
      el.addEventListener('click', function (e) {
        if (e.target === el) resolveWith(null)
      })

      // 自动聚焦主按钮(放 body 插入下一帧后执行,规避某些情况下 focus 被抢占失败)
      setTimeout(function () {
        const p = el.querySelector('.cm-primary')
        if (p) {
          p.focus({ preventScroll: true })
        } else {
          // 兜底:如果主按钮缺失(异常 HTML),聚焦 cm-box 避免 Enter/Esc 被外部吞
          const b = el.querySelector('.cm-box')
          if (b) b.tabIndex = -1, b.focus({ preventScroll: true })
        }
      }, 10)
    })
  }

  /** ★ 打开系统文件管理器定位到目录或文件。
   *  Electron:shell.openPath / shell.showItemInFolder;浏览器:无操作(无文件系统)。
   * @returns {Promise<boolean>} 是否成功 */
  function openPath(p) {
    if (hasApi() && global.window.api.openPath) {
      return global.window.api.openPath({ path: p }).then(function (res) { return !!(res && res.ok) })
    }
    // 浏览器模式:提示用户这是浏览器预览,无法打开本地路径
    console.warn('[DanmakuIO.openPath] 浏览器预览模式下无法打开路径: ' + p)
    return Promise.resolve(false)
  }

  /** ★ 在系统默认浏览器打开外部 URL(双击标题跳转仓库)。
   *  Electron:shell.openExternal;浏览器预览:window.open 兜底。
   * @returns {Promise<boolean>} 是否成功 */
  function openExternal(url) {
    if (hasApi() && global.window.api.openExternal) {
      return global.window.api.openExternal({ url: url }).then(function (res) { return !!(res && res.ok) })
    }
    try { window.open(url, '_blank'); return Promise.resolve(true) } catch (_) {}
    return Promise.resolve(false)
  }

  /** ★ 保存当前弹幕为本地 JSON(仅适合本程序使用)。
   * @returns {Promise<boolean>} 是否成功 */
  function saveAsJson(store, recs, fileName) {
    const text = global.DanmakuSerialize.buildExportJson(store, recs)
    const name = (fileName && fileName.length ? fileName : defaultNamePrefix()) + '.json'
    return saveFile(name, text, { filterLabel: '弹幕 JSON(本程序专用)' }).then((res) => !!res)
  }

  /** ★ 保存当前弹幕为 B站兼容 XML(高级弹幕完整,设计首选)。
   * @returns {Promise<boolean>} 是否成功 */
  function saveAsXml(store, recs, fileName) {
    const text = global.DanmakuSerialize.buildDanmakuXml(store, recs)
    const name = (fileName && fileName.length ? fileName : defaultNamePrefix()) + '.xml'
    return saveFile(name, text, { filterLabel: '弹幕 XML(高级弹幕设计首选)' }).then((res) => !!res)
  }

  /** ★ 保存当前弹幕为 ASS(适合某些特殊播放器使用)。
   * @returns {Promise<boolean>} 是否成功 */
  function saveAsAss(store, recs, fileName) {
    const text = global.DanmakuSerialize.buildDanmakuAss(store, recs)
    const name = (fileName && fileName.length ? fileName : defaultNamePrefix()) + '.ass'
    return saveFile(name, text, { filterLabel: '弹幕 ASS(适合特殊播放器)' }).then((res) => !!res)
  }

  function defaultNamePrefix() {
    const today = new Date()
    const p = (v) => String(v).padStart(2, '0')
    return 'danmaku-' + today.getFullYear() + p(today.getMonth() + 1) + p(today.getDate()) + '-' + p(today.getHours()) + p(today.getMinutes()) + p(today.getSeconds())
  }

  global.DanmakuIO = {
    hasApi: hasApi,
    readFile: readFile,
    saveFile: saveFile,
    saveSilent: saveSilent,
    saveAsJson: saveAsJson,
    saveAsXml: saveAsXml,
    saveAsAss: saveAsAss,
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
    showConfirmModal: showConfirmModal,
    openPath: openPath,
    openExternal: openExternal,
    listLibraryEntries: listLibraryEntries,
    saveLibraryEntry: saveLibraryEntry,
    readLibraryEntry: readLibraryEntry,
    deleteLibraryEntry: deleteLibraryEntry,
    updateLibraryEntry: updateLibraryEntry,
    getLibraryEntryIdByName: getLibraryEntryIdByName,
    parseDanmakuMeta: parseDanmakuMeta,
  }
})(window)
