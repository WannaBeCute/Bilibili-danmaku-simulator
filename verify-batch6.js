/**
 * 本批验证:面板添加/发送+校验、A面板不自动关、空格控制、播放方式/视频比例、
 * 列表双击跳转+搜索、发送弹幕可选中、高级预览、overlay选定框/时间菜单、保存带时间。
 * 运行:npx electron verify-batch6.js
 */
'use strict'

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
require('./electron/ipc.js')({ app, ipcMain, dialog, BrowserWindow, fs, path })

let failures = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function ok(cond, name) {
  if (cond) console.log('  ✔ ' + name)
  else { console.log('  ✘ ' + name); failures.push(name) }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1320, height: 920, show: true,
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
    // 等待应用就绪(避免脚本加载竞态)
    for (let i = 0; i < 40; i++) {
      const ready = await js(`!!(window.App && window.App.store)`)
      if (ready) break
      await sleep(100)
    }
    await sleep(500)

    // ---- 1. 面板添加/发送/校验 ----
    const panel = await js(`(async () => {
      const a = window.App
      a.store.clear()
      document.getElementById('pn-add').click()
      const afterPn = a.store.count()
      document.getElementById('pa-add').click()
      const afterPa = a.store.count()
      // 直接用 store 加高级弹幕做校验(不依赖按钮)
      const adv = a.store.getSelected() // 草稿(添加弹幕不入池,选中即草稿)
      let err = ''
      if (adv) {
        a.store.update(adv.id, { content: '' }, 'content')
        const origToast = a.player.toast
        err = await new Promise(res => {
          a.player.toast = (m) => res(m)
          document.getElementById('pa-send').click()
        })
        a.player.toast = origToast
      }
      const hasCollapse = !!document.getElementById('pn-collapse') && !!document.getElementById('pa-collapse')
      const sel2 = a.store.getSelected()
      return { afterPn, afterPa, hasAdv: !!adv, selContent: sel2 && sel2.content, selType: sel2 && sel2.type, err: String(err), errHasMsg: typeof err === 'string' && err.indexOf('失败') !== -1, hasCollapse }
    })()`)
    console.log('PANEL:', JSON.stringify(panel))
    ok(panel.afterPn === 0 && panel.afterPa === 0, '＋添加弹幕为草稿不入池(计数仍0)')
    ok(panel.errHasMsg, '发送校验空内容并提示失败原因')
    ok(panel.hasCollapse, '面板有收纳按钮')

    // 池里补一条普通+高级(供后续测试)
    await js(`(function(){
      const a = window.App
      a.store.add({ type:'normal', mode:'scroll', content:'新弹幕测试', timeSec: 1, fontSize:'standard', color:'#FFFFFF' })
      a.store.add({ type:'advanced', content:'高级弹幕测试', timeSec: 2, sender:'我', style:{color:'#FF0000',fontSize:36,fontFamily:'黑体',stroke:true}, rotation:{z:0,y:0}, life:{duration:5,opacityStart:1,opacityEnd:1}, motion:{moveDuration:1000,delay:0,linear:true,type:'position',path:[]}, position:{usePercent:false,startX:100,startY:100,endX:200,endY:200} })
      return true
    })()`)

    // ---- 2. A 面板不自动关闭 ----
    const aPersist = await js(`(async () => {
      document.getElementById('db-a').click()
      const open = !document.getElementById('db-style-popup').hidden
      // 点击输入框外部不应关闭
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(r => setTimeout(r, 60))
      const stillOpen = !document.getElementById('db-style-popup').hidden
      document.getElementById('db-a').click()
      const closed = document.getElementById('db-style-popup').hidden
      return { open, stillOpen, closed }
    })()`)
    console.log('A-PERSIST:', JSON.stringify(aPersist))
    ok(aPersist.open && aPersist.stillOpen && aPersist.closed, 'A面板仅再次点击A才关闭')

    // ---- 3. 空格控制播放/暂停 ----
    const space = await js(`(async () => {
      const a = window.App
      a.engine.pause(); a.clock.seek(0)
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 60))
      const playing = a.clock.playing
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }))
      await new Promise(r => setTimeout(r, 60))
      const paused = !a.clock.playing
      return { playing, paused }
    })()`)
    console.log('SPACE:', JSON.stringify(space))
    ok(space.playing && space.paused, '空格键控制播放/暂停')

    // ---- 4. 设置菜单:播放方式/视频比例,无字号透明度 ----
    const settings = await js(`(function(){
      return {
        playmode: !!document.getElementById('pb-playmode'),
        aspect: !!document.getElementById('pb-aspect'),
        noFont: !document.getElementById('pb-fontscale'),
        noOpacity: !document.getElementById('pb-opacity'),
      }
    })()`)
    console.log('SETTINGS:', JSON.stringify(settings))
    ok(settings.playmode && settings.aspect && settings.noFont && settings.noOpacity, '设置菜单有播放方式/视频比例,已删字号透明度')

    // ---- 5. 列表双击跳转 ----
    const dbl = await js(`(async () => {
      const a = window.App
      const rec = a.store.sorted().find(r => r.type === 'normal') || a.store.sorted()[0]
      if (!rec) return { jumped: false }
      a.engine.pause(); a.clock.seek(0)
      const row = document.querySelector('[data-id="' + rec.id + '"]')
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await new Promise(r => setTimeout(r, 60))
      return { jumped: Math.abs(a.clock.now() - rec.timeSec) < 0.5 }
    })()`)
    console.log('DBLCLICK:', JSON.stringify(dbl))
    ok(dbl.jumped, '双击列表跳转到弹幕出现时间')

    // ---- 6. 列表搜索筛选 ----
    const search = await js(`(async () => {
      const input = document.getElementById('list-search-input')
      input.value = '新弹幕'
      input.dispatchEvent(new Event('input'))
      await new Promise(r => setTimeout(r, 60))
      const shown = document.querySelectorAll('#list-body .list-row').length
      input.value = ''
      input.dispatchEvent(new Event('input'))
      return { shown }
    })()`)
    console.log('SEARCH:', JSON.stringify(search))
    ok(search.shown >= 1, '搜索按内容筛选列表')

    // ---- 7. 发送弹幕暂停时可选中 ----
    const sendSel = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      document.getElementById('db-input').value = '可选中测试'
      document.getElementById('db-send').click()
      await new Promise(r => setTimeout(r, 100))
      const rec = a.store.sorted().find(r => r.content === '可选中测试')
      const onScreen = a.engine.normal.active.some(d => d.id === rec.id)
      const selected = a.store.selectedId === rec.id
      return { onScreen, selected }
    })()`)
    console.log('SEND-SEL:', JSON.stringify(sendSel))
    ok(sendSel.onScreen && sendSel.selected, '发送弹幕暂停时上屏且被选中')

    // ---- 8. 高级预览不入列表 ----
    const preview = await js(`(async () => {
      const a = window.App
      const rec = a.store.sorted().find(r => r.type === 'advanced')
      if (!rec) return { countUnchanged: false, onScreen: false }
      a.store.update(rec.id, { content: '预览内容' }, 'content')
      a.store.select(rec.id)
      const before = a.store.count()
      a.controls.previewAdvanced()
      await new Promise(r => setTimeout(r, 120))
      const after = a.store.count()
      const onScreen = a.engine.advanced.active.some(d => d.record._preview)
      return { countUnchanged: before === after, onScreen }
    })()`)
    console.log('PREVIEW:', JSON.stringify(preview))
    ok(preview.countUnchanged && preview.onScreen, '高级预览上屏但不入列表')

    // ---- 9. overlay 选定框(以起始点为中心)+ 角手柄 ----
    const ov = await js(`(async () => {
      const a = window.App
      const rec = a.store.sorted().find(r => r.type === 'advanced')
      a.store.select(rec.id)
      a.editor.setEnabled(true)
      await new Promise(r => setTimeout(r, 150))
      const root = document.getElementById('edit-overlay')
      const box = root.querySelector('.eo-box')
      const corners = root.querySelectorAll('.eo-corner').length
      if (!box) return { hasBox: false, corners }
      // 框中心应接近起始点像素位置
      const p = rec.position
      const spx = p.usePercent ? p.startX * a.engine.width : p.startX
      const spy = p.usePercent ? p.startY * a.engine.height : p.startY
      const sr = a.editor.stage.getBoundingClientRect()
      const startScreenX = sr.left + spx
      const startScreenY = sr.top + spy
      const r = box.getBoundingClientRect()
      const boxCx = r.left + r.width / 2, boxCy = r.top + r.height / 2
      a.editor.setEnabled(false)
      return { hasBox: true, corners, nearStart: Math.abs(boxCx - startScreenX) < 60 && Math.abs(boxCy - startScreenY) < 60 }
    })()`)
    console.log('OVERLAY-BOX:', JSON.stringify(ov))
    ok(ov.hasBox && ov.corners === 4, 'overlay选定框+四角手柄')
    ok(ov.nearStart, '选定框以起始点为中心')

    // ---- 10. 保存文件名带时间 ----
    const tsName = await js(`(function(){
      const n = window.App.controls._timestampName()
      return /^danmaku-\\d{8}-\\d{6}\\.json$/.test(n)
    })()`)
    ok(tsName, '保存文件名带时间(YYYYMMDD-HHmmss)')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
