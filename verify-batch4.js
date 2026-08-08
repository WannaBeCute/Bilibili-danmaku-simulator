/**
 * 本轮验证:文件弹窗不再启动卡死、弹幕文件按钮位置、列表多选(拖动+Ctrl)、批量删除。
 * 运行:npx electron verify-batch4.js
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')

let failures = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function ok(cond, name) {
  if (cond) console.log('  ✔ ' + name)
  else { console.log('  ✘ ' + name); failures.push(name) }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1320, height: 900, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) failures.push('console-error: ' + message)
  })
  setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 90000)
  const js = (code) => win.webContents.executeJavaScript(code)

  try {
    await win.loadFile(path.join(__dirname, 'index.html'))
    await sleep(1800)

    // ---- 1. 文件弹窗启动时隐藏(修复卡死) ----
    const fdHidden = await js(`(async () => {
      const root = document.getElementById('file-dialog')
      const hiddenOnLoad = root.hidden
      // 打开再取消
      document.getElementById('btn-open-video').click()
      await new Promise(r => setTimeout(r, 60))
      const shown = !root.hidden && getComputedStyle(root).display !== 'none'
      document.getElementById('fd-cancel').click()
      await new Promise(r => setTimeout(r, 40))
      const closed = root.hidden && getComputedStyle(root).display === 'none'
      return { hiddenOnLoad, shown, closed }
    })()`)
    console.log('FILEDIALOG:', JSON.stringify(fdHidden))
    ok(fdHidden.hiddenOnLoad, '启动时文件弹窗隐藏(不再卡在打开文件界面)')
    ok(fdHidden.shown, '点击打开视频弹出弹窗且可见')
    ok(fdHidden.closed, '取消可正常关闭')

    // ---- 2. 弹幕文件按钮在打开弹幕之后 ----
    const order = await js(`(function(){
      const g = document.querySelector('.tb-group')
      const idx = (id) => Array.prototype.indexOf.call(g.children, document.getElementById(id))
      return { danmaku: idx('btn-open-danmaku'), files: idx('btn-danmaku-files') }
    })()`)
    console.log('ORDER:', JSON.stringify(order))
    ok(order.files > order.danmaku, '「弹幕文件」按钮位于「打开弹幕(JSON)」之后')

    // ---- 3. 列表多选:拖动范围选择 + Ctrl 追加 ----
    const multi = await js(`(async () => {
      const a = window.App
      const rows = document.querySelectorAll('#list-body .list-row')
      if (rows.length < 5) return { ok: false, reason: 'few rows' }
      a.store.deselect()
      const r0 = rows[0], r2 = rows[2]
      r0.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
      const r2r = r2.getBoundingClientRect()
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: r2r.left + 10, clientY: r2r.top + 6, bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise(r => setTimeout(r, 50))
      const sel = a.store.selectedIds.size
      // Ctrl 点击第 4 行追加
      const r3 = rows[3]
      r3.dispatchEvent(new MouseEvent('mousedown', { button: 0, ctrlKey: true, bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise(r => setTimeout(r, 50))
      const sel2 = a.store.selectedIds.size
      const delBtn = document.getElementById('list-delete-sel')
      const delBtnVisible = !delBtn.hidden && delBtn.textContent.indexOf('(') !== -1
      return { ok: true, sel, sel2, delBtnVisible }
    })()`)
    console.log('MULTI:', JSON.stringify(multi))
    ok(multi.ok && multi.sel === 3, '拖动选中 3 行(' + multi.sel + ')')
    ok(multi.ok && multi.sel2 === 4, 'Ctrl+点击追加到 4 行(' + multi.sel2 + ')')
    ok(multi.delBtnVisible, '多选后显示「删除选中(N)」按钮')

    // ---- 4. 批量删除 ----
    const delMulti = await js(`(async () => {
      const a = window.App
      const before = a.store.count()
      document.getElementById('list-delete-sel').click()
      await new Promise(r => setTimeout(r, 80))
      const after = a.store.count()
      return { before, after, removed: before - after }
    })()`)
    console.log('DEL-MULTI:', JSON.stringify(delMulti))
    ok(delMulti.removed === 4, '批量删除选中的 4 条(' + delMulti.removed + ')')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
