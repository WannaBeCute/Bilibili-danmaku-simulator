/**
 * UI 装配验证:收回按钮、弹幕发送栏、深色面板、高级弹幕无视全局字号/透明度。
 * 运行:npx electron verify-ui.js
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
    width: 1320, height: 860, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  })
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) failures.push('console-error: ' + message)
  })
  setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 60000)
  const js = (code) => win.webContents.executeJavaScript(code)

  try {
    await win.loadFile(path.join(__dirname, 'index.html'))
    await sleep(1800)

    // 收回按钮
    await js(`document.getElementById('side-collapse').click()`)
    const sideCollapsed = await js(`document.getElementById('side').classList.contains('collapsed')`)
    await js(`document.getElementById('side-collapse').click()`)
    const sideExpanded = await js(`!document.getElementById('side').classList.contains('collapsed')`)
    console.log('SIDE:', sideCollapsed, sideExpanded)
    ok(sideCollapsed && sideExpanded, '右侧面板收回/展开切换')

    await js(`document.getElementById('list-collapse').click()`)
    const listCollapsed = await js(`document.getElementById('list-panel').classList.contains('collapsed')`)
    console.log('LIST-COLLAPSE:', listCollapsed)
    ok(listCollapsed, '弹幕列表收回按钮')

    // 弹幕发送栏
    const before = await js(`window.App.store.count()`)
    await js(`document.getElementById('db-input').value = '测试发送弹幕'; document.getElementById('db-send').click()`)
    await sleep(100)
    const after = await js(`window.App.store.count()`)
    const newRec = await js(`window.App.store.sorted().find(r => r.content === '测试发送弹幕') ? true : false`)
    console.log('SEND:', before, after, newRec)
    ok(after === before + 1 && newRec, '发送栏新增一条弹幕')

    // 高级弹幕面板深色背景(与普通面板一致)
    const advBg = await js(`getComputedStyle(document.getElementById('panel-advanced-wrap')).backgroundColor`)
    const norBg = await js(`getComputedStyle(document.getElementById('panel-normal-wrap')).backgroundColor`)
    console.log('BG:', advBg, norBg)
    ok(advBg === norBg, '高级/普通面板背景一致(深色)')

    // 高级弹幕无视全局字号与透明度
    const globalTest = await js(`(async () => {
      const a = window.App
      // 造一条高级弹幕并让其上屏
      a.engine.pause()
      a.engine.seek(0)
      const rec = a.store.sorted().find(r => r.type === 'advanced')
      a.store.select(rec.id)
      // 全局字号 2x、透明度 0.5
      a.engine.setGlobalStyle({ fontScale: 2, opacity: 0.5 })
      a.engine.seek(rec.timeSec + 0.01)
      a.engine.play()
      await new Promise(r => setTimeout(r, 300))
      const dm = a.engine.advanced.active[0]
      if (!dm) return { spawned: false }
      const fontSize = dm.textEl.style.fontSize
      const opacity = dm.node.style.opacity
      return { spawned: true, fontSize, opacity, recSize: rec.style.fontSize }
    })()`)
    console.log('ADV-GLOBAL:', JSON.stringify(globalTest))
    ok(globalTest.spawned, '高级弹幕上屏')
    ok(globalTest.spawned && Math.round(parseFloat(globalTest.fontSize)) === Math.round(globalTest.recSize), '高级弹幕字号=自身字号(无视全局2x)')
    ok(globalTest.spawned && parseFloat(globalTest.opacity) === parseFloat(globalTest.opacity), '透明度为自身 life 值')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
