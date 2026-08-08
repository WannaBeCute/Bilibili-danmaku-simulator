/**
 * 本轮功能验证:设置面板可见性、A弹窗可见、◀◀▶▶符号、暂停冻结普通弹幕、
 * 滚动弹幕节点不泄漏(选中框不残留)、文件弹窗、列表保存按钮、无同名弹幕清空。
 * 运行:npx electron verify-batch3.js
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

    // ---- 1. 设置面板可见(不再弹出屏幕外) ----
    const vis = await js(`(async () => {
      document.getElementById('db-settings').click()
      await new Promise(r => setTimeout(r, 80))
      const el = document.getElementById('db-settings-panel')
      const r = el.getBoundingClientRect()
      const open = !el.hidden
      const inView = open && r.top > 0 && r.bottom < window.innerHeight && r.width > 100
      document.getElementById('db-settings').click()
      // A 弹窗可见
      document.getElementById('db-a').click()
      await new Promise(r => setTimeout(r, 80))
      const a = document.getElementById('db-style-popup').getBoundingClientRect()
      const aInView = a.top > 0 && a.bottom < window.innerHeight
      document.getElementById('db-a').click()
      return { open, inView, rTop: r.top, aInView }
    })()`)
    console.log('VISIBLE:', JSON.stringify(vis))
    ok(vis.open && vis.inView, '弹幕设置面板在视口内可见(修复打不开)')
    ok(vis.aInView, 'A 弹窗在视口内可见')

    // ---- 2. ◀◀ ▶▶ 符号 ----
    const sym = await js(`document.getElementById('pb-prev').textContent + '|' + document.getElementById('pb-next').textContent`)
    console.log('SYM:', sym)
    ok(sym === '◀◀|▶▶', '上一集/下一集符号 ◀◀ ▶▶')

    // ---- 1b. 舞台提示:刚打开(无视频)可见;✕ 取消后不再出现 ----
    const hint = await js(`(async () => {
      const a = window.App
      const hintEl = document.getElementById('stage-hint')
      const visibleOnLoad = !hintEl.hidden
      document.getElementById('hint-dismiss').click()
      const hiddenAfterDismiss = hintEl.hidden
      a.player.closeVideo()
      await new Promise(r => setTimeout(r, 60))
      const stillHidden = hintEl.hidden
      return { visibleOnLoad, hiddenAfterDismiss, stillHidden }
    })()`)
    console.log('HINT:', JSON.stringify(hint))
    ok(hint.visibleOnLoad, '刚打开程序(无视频)时提示可见')
    ok(hint.hiddenAfterDismiss && hint.stillHidden, '✕ 取消后提示不再出现(含关闭视频后)')

    // ---- 3. 列表保存按钮存在 ----
    const saveBtn = await js(`!!document.getElementById('list-save')`)
    ok(saveBtn, '弹幕列表右侧有「保存」按钮')

    // ---- 4. 文件弹窗:点打开视频弹出、含拖拽区与文件夹按钮 ----
    const fd = await js(`(async () => {
      document.getElementById('btn-open-video').click()
      await new Promise(r => setTimeout(r, 80))
      const root = document.getElementById('file-dialog')
      const shown = !root.hidden
      const hasDrop = !!document.getElementById('fd-drop')
      const hasBrowse = document.getElementById('fd-browse').textContent === '打开文件夹'
      document.getElementById('fd-cancel').click()
      return { shown, hasDrop, hasBrowse, closed: root.hidden }
    })()`)
    console.log('FILEDIALOG:', JSON.stringify(fd))
    ok(fd.shown && fd.hasDrop && fd.hasBrowse && fd.closed, '文件弹窗(拖拽区+打开文件夹)可开可关')

    // ---- 5. 暂停冻结普通弹幕 ----
    const pause = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.engine.seek(0); a.engine.play()
      let dm = null
      for (let i = 0; i < 40; i++) {
        dm = a.engine.normal.active.find(d => d.mode === 'scroll' && d.moving)
        if (dm) break
        await new Promise(r => setTimeout(r, 100))
      }
      if (!dm) return { spawned: false }
      a.engine.pause()
      const pos1 = dm.node.style.transform
      await new Promise(r => setTimeout(r, 600))
      const pos2 = dm.node.style.transform
      const frozen = pos1 === pos2 && dm.paused
      a.engine.play()
      return { spawned: true, frozen, pos1, pos2, paused: dm.paused }
    })()`)
    console.log('PAUSE:', JSON.stringify(pause))
    ok(pause.spawned && pause.frozen, '暂停后普通弹幕冻结不动')

    // ---- 6. 滚动弹幕节点不泄漏(走完被销毁,无选中框残留) ----
    const leak = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.engine.seek(1)
      a.engine.play()
      for (let i = 0; i < 50; i++) {
        if (document.querySelectorAll('#stage [data-dm-id="d001"]').length === 0) {
          return { leftover: 0, waited: i }
        }
        await new Promise(r => setTimeout(r, 200))
      }
      return { leftover: document.querySelectorAll('#stage [data-dm-id="d001"]').length, timedOut: true }
    })()`)
    console.log('LEAK:', JSON.stringify(leak))
    ok(leak.leftover === 0, '滚动弹幕走完后节点销毁(无残留框)')

    // ---- 7. 无同名弹幕:打开视频后清空 ----
    const noSide = await js(`(async () => {
      const a = window.App
      a.player._onNoSidecar()
      await new Promise(r => setTimeout(r, 100))
      return { count: a.store.count(), listEmpty: document.querySelectorAll('#list-body .list-empty').length > 0 }
    })()`)
    console.log('NOSIDECAR:', JSON.stringify(noSide))
    ok(noSide.count === 0 && noSide.listEmpty, '无同名弹幕时清空列表并显示提示')

    // ---- 8. 无媒体时 resize 不清场(全屏不重载弹幕) ----
    const resize = await js(`(async () => {
      const a = window.App
      a.engine.seek(2); a.engine.play()
      await new Promise(r => setTimeout(r, 1200))
      const before = a.engine.normal.active.length
      // 模拟尺寸变化(全屏会改变 stage 尺寸)
      a.engine.layout()
      const after = a.engine.normal.active.length
      a.engine.pause()
      return { before, after, kept: after >= before }
    })()`)
    console.log('RESIZE:', JSON.stringify(resize))
    ok(resize.kept, '尺寸变化不清场(全屏不重载弹幕)')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
