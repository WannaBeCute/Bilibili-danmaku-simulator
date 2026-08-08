/**
 * 真实视频 seek 回归:验证拖动进度条不会造成无限 seek 循环(卡死),
 * 且 seek 后弹幕按时间出现。
 * 运行:npx electron verify-video.js
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
const VIDEO = 'file:///E:/Admin/file/高级弹幕模拟器开发/音视频 - 黑屏试验.mp4'

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
    await sleep(1500)

    // 加载真实视频
    const meta = await js(`(async () => {
      const a = window.App
      const v = a.player.videoEl
      v.src = '${VIDEO}'
      await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }))
      a.clock.bindVideo(v)
      return { dur: v.duration, mode: a.clock.mode }
    })()`)
    console.log('VIDEO-META:', JSON.stringify(meta))
    ok(meta.dur > 0, '视频加载成功 duration>0')
    ok(meta.mode === 'video', '时钟切换为 video 模式')

    // 模拟拖动:多次 seek + seeking 事件风暴
    const seek = await js(`(async () => {
      const a = window.App
      const v = a.player.videoEl
      a.engine.pause()
      for (let i = 0; i < 15; i++) a.engine.seek(1 + i * 1.5)
      for (let i = 0; i < 30; i++) v.dispatchEvent(new Event('seeking'))
      const seekedFired = await new Promise(res => {
        let done = false
        const to = setTimeout(() => { if (!done) { done = true; res(false) } }, 2500)
        v.addEventListener('seeked', () => { if (!done) { done = true; clearTimeout(to); res(true) } }, { once: true })
      })
      return { seekedFired, alive: a.engine._running, currentTime: v.currentTime, dur: v.duration }
    })()`)
    console.log('SEEK-STORM:', JSON.stringify(seek))
    ok(seek.seekedFired, 'seek 正常完成(未陷入无限循环)')
    ok(seek.alive, '引擎循环存活(未卡死)')

    // seek 后弹幕按时间出现(视频模式)
    const danmaku = await js(`(async () => {
      const a = window.App
      const v = a.player.videoEl
      v.currentTime = 3
      a.engine.replay()
      await new Promise(r => setTimeout(r, 400))
      return {
        clock: v.currentTime,
        normalActive: a.engine.normal.active.length,
        nodes: document.querySelectorAll('#stage .dm').length,
        anyScroll: a.engine.normal.active.some(d => d.mode === 'scroll'),
      }
    })()`)
    console.log('DANMAKU-AT-TIME:', JSON.stringify(danmaku))
    ok(danmaku.anyScroll && danmaku.normalActive > 0, '视频 seek 到 3s 后弹幕按时间出现')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
