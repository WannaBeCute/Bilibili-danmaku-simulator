/**
 * Electron 冒烟验证:加载应用 -> 播放 -> seek -> 选中 -> 截图。
 * 运行:npx electron verify.js
 * 输出 verify-shot.png 与状态,控制台错误即失败。
 */
'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

let failures = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  win.webContents.on('console-message', (e, level, message) => {
    const tag = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG'
    console.log('[' + tag + '] ' + message)
    if (level >= 3) failures.push(message)
  })
  win.webContents.on('did-fail-load', (e, code, desc) => {
    failures.push('load-fail: ' + code + ' ' + desc)
  })
  win.webContents.on('render-process-gone', (e, details) => {
    failures.push('render-gone: ' + details.reason)
  })

  // 超时兜底,避免挂死
  setTimeout(() => {
    console.log('TIMEOUT reached, exiting with FAIL')
    app.exit(1)
  }, 45000)

  try {
    await win.loadFile(path.join(__dirname, 'index.html'))
    await sleep(2500)

    // 基础状态
    let state = await win.webContents.executeJavaScript(`(function(){
      const app = window.App
      return {
        hasApp: !!app,
        comments: app.store.count(),
        width: app.engine.width,
        height: app.engine.height,
        rows: app.engine.rows,
        clock: app.clock.now(),
      }
    })()`)
    console.log('INIT:', JSON.stringify(state))
    if (!state.hasApp) failures.push('window.App 未挂载')
    if (!state.comments) failures.push('演示弹幕未加载')

    // 播放(虚拟时钟),等 3 秒应出现弹幕
    await win.webContents.executeJavaScript('window.App.engine.play()')
    await sleep(3000)
    state = await win.webContents.executeJavaScript(`(function(){
      const app = window.App
      return {
        clock: app.clock.now(),
        normalActive: app.engine.normal.active.length,
        advActive: app.engine.advanced.active.length,
        dmNodes: document.querySelectorAll('#stage .dm').length,
        tracks: app.engine.tracks.length,
      }
    })()`)
    console.log('PLAYING:', JSON.stringify(state))
    if (state.normalActive + state.advActive === 0) failures.push('播放后无活跃弹幕')

    // seek 到 8s:应有高级弹幕
    await win.webContents.executeJavaScript('window.App.engine.seek(8)')
    await sleep(1200)
    state = await win.webContents.executeJavaScript(`(function(){
      const app = window.App
      return {
        clock: app.clock.now(),
        advActive: app.engine.advanced.active.length,
        dmNodes: document.querySelectorAll('#stage .dm').length,
      }
    })()`)
    console.log('SEEK8:', JSON.stringify(state))
    if (state.advActive === 0) failures.push('seek(8) 后无高级弹幕')

    // 编辑:选中第一条弹幕
    await win.webContents.executeJavaScript(
      'window.App.store.select(window.App.store.comments[0].id)'
    )
    await sleep(400)
    const sel = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".dm-selected").length'
    )
    console.log('SELECTED nodes:', sel)
    if (sel === 0) failures.push('选中后无 .dm-selected 高亮')

    // 截图
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(__dirname, 'verify-shot.png'), img.toPNG())
    console.log('screenshot: verify-shot.png')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
