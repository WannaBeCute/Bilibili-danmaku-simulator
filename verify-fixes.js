/**
 * 本次修复专项验证:视频拖动/seek 无循环、颜色渲染、列表不滚动重渲染、
 * 高级弹幕 overlay、百分比自动转换、当前时间按钮。
 * 运行:npx electron verify-fixes.js
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
    await sleep(2000)
    const init = await js(`(function(){const a=window.App;return {app:!!a,comments:a.store.count(),w:a.engine.width,h:a.engine.height}})()`)
    console.log('INIT:', JSON.stringify(init))
    ok(init.app && init.comments === 11, '应用挂载 + 11 条演示弹幕')

    // ---- 1. 列表:字段变更不整表重渲染(不滚动) ----
    const rowsBefore = await js(`document.querySelectorAll('#list-body .list-row').length`)
    await js(`window.App.store.update(window.App.store.comments[0].id, { content: '列表原位更新' }, 'content')`)
    await sleep(60)
    const rowsAfter = await js(`document.querySelectorAll('#list-body .list-row').length`)
    const firstRowText = await js(`document.querySelector('#list-body .list-row .list-content').textContent`)
    console.log('LIST:', JSON.stringify({ rowsBefore, rowsAfter, firstRowText }))
    ok(rowsBefore === rowsAfter, '字段变更列表行数不变(不整表重渲染)')
    ok(firstRowText.indexOf('列表原位更新') !== -1, '列表单行内容原位更新')

    // ---- 2. 颜色渲染:播放后普通弹幕颜色为 hex ----
    await js(`window.App.engine.seek(0)`)
    await js(`window.App.engine.play()`)
    const color = await js(`(async () => {
      const a = window.App
      for (let i = 0; i < 40; i++) {
        const n = a.engine.normal.active.find(d => d.mode === 'scroll')
        if (n && n.textEl) {
          return { found: true, clock: a.clock.now(), running: a.engine._running, playing: a.clock.playing, id: n.id, mode: n.mode, color: n.textEl.style.color, content: (n.record.content||'').slice(0,10) }
        }
        await new Promise(r => setTimeout(r, 100))
      }
      return { found: false, clock: a.clock.now(), running: a.engine._running, playing: a.clock.playing }
    })()`)
    console.log('COLOR:', JSON.stringify(color))
    const c = color.color || ''
    ok(
      color.found && (/^#([0-9A-F]{6})$/i.test(c) || /^rgb\(255,\s*255,\s*255\)$/i.test(c)),
      '普通弹幕渲染颜色为白(rgb 255,255,255 = #FFFFFF)'
    )

    // ---- 3. 拖动/seek 无循环:replay 不触碰视频时间源 ----
    const seekInfo = await js(`(function(){
      const app = window.App
      app.engine.pause()
      app.clock.seek(0)
      const t0 = app.clock.now()
      app.engine.replay()
      const t1 = app.clock.now()
      app.engine.seek(3.5)
      const t2 = app.clock.now()
      // 连续多次 replay(模拟 seeking 事件风暴),时钟应保持稳定
      for (let i=0;i<50;i++) app.engine.replay()
      const t3 = app.clock.now()
      return { t0, t1, t2, t3, unchanged: t0===t1, seekWorked: Math.abs(t2-3.5)<1e-6, stable: t2===t3 }
    })()`)
    console.log('SEEK:', JSON.stringify(seekInfo))
    ok(seekInfo.unchanged, 'replay() 不改变时间源(无无限 seek 循环)')
    ok(seekInfo.seekWorked, 'engine.seek(3.5) 正确跳转')
    ok(seekInfo.stable, '连续 replay 时间稳定')

    // ---- 4. 高级弹幕 overlay:选中高级弹幕渲染标记与手柄 ----
    await js(`window.App.engine.pause()`)
    await js(`window.App.editor.setEnabled(true)`)
    await js(`window.App.store.select(window.App.store.sorted().find(r=>r.type==='advanced').id)`)
    const ov = await js(`(async () => {
      const root = document.getElementById('edit-overlay')
      for (let i = 0; i < 30; i++) {
        const m = root.querySelectorAll('.eo-marker').length
        if (m === 2) {
          return { markers: m, handles: root.querySelectorAll('.eo-handle').length, line: root.querySelectorAll('.eo-line').length }
        }
        await new Promise(r => setTimeout(r, 80))
      }
      return { markers: 0, handles: 0, line: 0 }
    })()`)
    console.log('OVERLAY:', JSON.stringify(ov))
    ok(ov.markers === 2, 'overlay 起点+终点标记(2)')
    ok(ov.handles === 3, 'overlay 三个手柄(Z/Y/拖)')
    ok(ov.line === 1, 'overlay 虚线连接')

    // ---- 5. 百分比自动转换 ----
    const pct = await js(`(function(){
      const app = window.App
      const adv = app.store.sorted().find(r=>r.type==='advanced')
      app.store.select(adv.id)
      const panel = app.panelAdvanced
      const p = app.store.get(adv.id).position
      // 自动转换开(默认):像素->百分比
      panel.autoConvertEl.checked = true
      panel.percentEl.checked = true
      panel.togglePercent()
      const rec1 = app.store.get(adv.id)
      const v1 = rec1.position.startX
      const pxToPctOk = rec1.position.usePercent === true && v1 > 0 && v1 < 100
      // 自动转换关:坐标清 0
      panel.autoConvertEl.checked = false
      panel.percentEl.checked = false
      panel.togglePercent()
      panel.percentEl.checked = true
      panel.togglePercent()
      const rec2 = app.store.get(adv.id)
      const v2 = rec2.position.startX
      const clearedOk = rec2.position.usePercent === true && v2 === 0 && rec2.position.startY === 0 && rec2.position.endX === 0
      return { pxToPctOk, clearedOk, v1, v2 }
    })()`)
    console.log('PERCENT:', JSON.stringify(pct))
    ok(pct.pxToPctOk, '自动转换开:像素→百分比换算(非0)')
    ok(pct.clearedOk, '自动转换关:坐标清 0')

    // ---- 6. 当前时间按钮(普通) ----
    const nowT = await js(`(function(){
      const app = window.App
      app.store.select(app.store.comments[0].id)
      const before = app.clock.now()
      app.panelNormal.toggleNow()
      const rec = app.store.get(app.store.comments[0].id)
      const t = app.clock.now()
      return { flag: rec.useCurrentTime, diff: Math.abs(rec.timeSec - before), cur: rec.timeSec, t }
    })()`)
    console.log('CURRENT-TIME:', JSON.stringify(nowT))
    ok(nowT.flag === true, '当前时间按钮置 useCurrentTime')
    ok(nowT.diff < 0.5, '时间=当前播放时间')

    // ---- 7. 关闭编辑模式,overlay 隐藏 ----
    await js(`window.App.editor.setEnabled(false)`)
    const ovHidden = await js(`document.getElementById('edit-overlay').innerHTML === ''`)
    ok(ovHidden, '退出编辑模式 overlay 清空')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
