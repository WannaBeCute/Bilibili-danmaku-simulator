/**
 * 本轮验证:屏蔽重复弹幕(仅普通)、防挡字幕=下方25%、导入合并+类型识别、
 * 导出改名、弹幕文件库IPC、编辑模式右下移/删显示弹幕/关视频。
 * 运行:npx electron verify-batch5.js
 */
'use strict'

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// 注册与主进程相同的 IPC(文件读写/弹幕库)
require('./electron/ipc.js')({ app, ipcMain, dialog, BrowserWindow, fs, path })

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

    // ---- 1. 设置面板:屏蔽重复弹幕选项存在、智能防挡已删 ----
    const panelOpts = await js(`(function(){
      return {
        blockdupes: !!document.getElementById('ds-blockdupes'),
        ai: !!document.getElementById('ds-ai'),
      }
    })()`)
    console.log('PANEL-OPTS:', JSON.stringify(panelOpts))
    ok(panelOpts.blockdupes && !panelOpts.ai, '设置面板有"屏蔽重复弹幕"、无"智能防挡"')

    // ---- 2. 屏蔽重复弹幕(仅普通) ----
    const dupes = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.store.clear()
      a.store.add({ type:'normal', mode:'scroll', content:'重复内容', timeSec: 1 })
      a.store.add({ type:'normal', mode:'scroll', content:'重复内容', timeSec: 2 })
      a.store.add({ type:'normal', mode:'scroll', content:'唯一内容', timeSec: 3 })
      a.store.add({ type:'advanced', content:'高级重复', timeSec: 1.2, style:{color:'#FF0000',fontSize:36,fontFamily:'黑体',stroke:true}, rotation:{z:0,y:0}, life:{duration:5,opacityStart:1,opacityEnd:1}, motion:{moveDuration:1000,delay:0,linear:true,type:'position',path:[]}, position:{usePercent:false,startX:100,startY:100,endX:200,endY:200} })
      a.store.add({ type:'advanced', content:'高级重复', timeSec: 2.5, style:{color:'#FF0000',fontSize:36,fontFamily:'黑体',stroke:true}, rotation:{z:0,y:0}, life:{duration:5,opacityStart:1,opacityEnd:1}, motion:{moveDuration:1000,delay:0,linear:true,type:'position',path:[]}, position:{usePercent:false,startX:100,startY:100,endX:200,endY:200} })
      a.engine.setBlockDupes(true)
      a.engine.seek(3.5)
      await new Promise(r => setTimeout(r, 200))
      const seen = {}
      a.engine.normal.active.forEach(d => { seen[d.record.content] = (seen[d.record.content]||0)+1 })
      const adv = a.engine.advanced.active.length
      a.engine.setBlockDupes(false)
      return { seen, adv }
    })()`)
    console.log('DUPES:', JSON.stringify(dupes))
    ok(dupes.seen['重复内容'] === 1, '屏蔽重复弹幕:普通重复内容只保留 1 条(' + dupes.seen['重复内容'] + ')')
    ok(dupes.seen['唯一内容'] === 1, '非重复内容正常出现')
    ok(dupes.adv === 2, '高级弹幕不受屏蔽重复影响(2 条同名都出现)')

    // ---- 3. 防挡字幕 = 屏幕下方 25% ----
    const nosub = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.engine.setSubtitleAvoid(true)
      const h = a.engine.height
      const uh = a.engine.usableHeight
      a.engine.setSubtitleAvoid(false)
      const uh2 = a.engine.usableHeight
      return { h, uh, uh2, ok: Math.abs(uh - h * 0.75) < 2 && Math.abs(uh2 - h) < 2 }
    })()`)
    console.log('NOSUB:', JSON.stringify(nosub))
    ok(nosub.ok, '防挡字幕:普通弹幕活动区为下方25%裁掉')

    // ---- 4. 导入按钮合并+类型识别 ----
    const btns = await js(`(function(){
      return {
        importText: document.getElementById('btn-open-danmaku').textContent,
        oldImport: !!document.getElementById('btn-import'),
        exportText: document.getElementById('btn-export').textContent,
      }
    })()`)
    console.log('BTNS:', JSON.stringify(btns))
    ok(btns.importText === '导入弹幕' && !btns.oldImport, '按钮合并为「导入弹幕」、已删「导入XML/ASS」')
    ok(btns.exportText === '导出弹幕(JSON)', '按钮改名「导出弹幕(JSON)」')

    const imp = await js(`(async () => {
      const a = window.App
      a.store.clear()
      a.controls._importAuto(JSON.stringify({ comments: [{ type:'normal', mode:'scroll', content:'JSON导入', timeSec:1 }] }), 't.json')
      await new Promise(r => setTimeout(r, 60))
      const jsonCount = a.store.count()
      a.store.clear()
      a.controls._importAuto('<i><d p="1,1,25,16777215,0,0,0,0">XML导入</d></i>', 't.xml')
      await new Promise(r => setTimeout(r, 60))
      const xmlCount = a.store.count()
      a.store.clear()
      a.controls._importAuto('完全不是弹幕格式', 't.xxx')
      await new Promise(r => setTimeout(r, 60))
      const badCount = a.store.count()
      return { jsonCount, xmlCount, badCount }
    })()`)
    console.log('IMPORT:', JSON.stringify(imp))
    ok(imp.jsonCount === 1 && imp.xmlCount === 1 && imp.badCount === 0, '导入自动识别 JSON/XML,非法格式不导入')

    // ---- 5. 弹幕文件库 IPC ----
    const lib = await js(`(async () => {
      const dir = await window.api.getDanmakuDir()
      const saved = await window.api.saveDanmakuToDir({ text: JSON.stringify({ comments: [] }) })
      const list = await window.api.listDanmakuFiles()
      const hasFile = !!saved && list.files.some(f => f.name === saved.name)
      const timeName = saved ? /^danmaku-\\d{8}-\\d{6}\\.json$/.test(saved.name) : false
      return { dirOk: !!(dir && dir.path), savedOk: !!saved, timeName, hasFile }
    })()`)
    console.log('LIB:', JSON.stringify(lib))
    ok(lib.dirOk && lib.savedOk && lib.hasFile && lib.timeName, '弹幕文件库:目录/按时间命名保存/列表')

    // ---- 6. 编辑模式/关视频在发送栏(与弹幕同一行)、删显示弹幕 ----
    const ui = await js(`(async () => {
      const a = window.App
      const bar = document.getElementById('danmaku-bar')
      const editInBar = bar.contains(document.getElementById('pb-edit'))
      const closeInBar = bar.contains(document.getElementById('pb-closevideo'))
      const notInStage = !document.getElementById('stage').contains(document.getElementById('pb-edit'))
      const noShow = !document.getElementById('show-toggle')
      const editText = document.getElementById('pb-edit').textContent
      // 编辑按钮:文字"编辑模式",点击后常亮(active)
      document.getElementById('pb-edit').click()
      const editActive = document.getElementById('pb-edit').classList.contains('active')
      document.getElementById('pb-edit').click()
      const editOff = !document.getElementById('pb-edit').classList.contains('active')
      // 关视频不清弹幕
      const before = a.store.count()
      a.player.closeVideo()
      const after = a.store.count()
      return { editInBar, closeInBar, notInStage, noShow, keepDanmaku: before === after, editText, editActive, editOff }
    })()`)
    console.log('UI:', JSON.stringify(ui))
    ok(ui.editInBar && ui.closeInBar && ui.notInStage, '编辑模式/关视频在发送栏同一行(非舞台内)')
    ok(ui.noShow, '已删「显示弹幕」')
    ok(ui.editText === '编辑模式' && ui.editActive && ui.editOff, '编辑模式按钮:文字正确、点击常亮/再点关闭')
    ok(ui.keepDanmaku, '关闭视频不清除弹幕列表')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
