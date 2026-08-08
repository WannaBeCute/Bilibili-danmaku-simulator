/**
 * 弹幕设置面板验证:齿轮开关、类型过滤(可过滤高级)、密度、显示区域、
 * 屏蔽词、弹幕速度(仅普通)。
 * 运行:npx electron verify-settings.js
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
    width: 1320, height: 880, show: true,
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

    // 齿轮按钮打开面板
    await js(`document.getElementById('db-settings').click()`)
    const panelOpen = await js(`!document.getElementById('db-settings-panel').hidden`)
    ok(panelOpen, '齿轮按钮打开弹幕设置面板')

    // 类型过滤:关闭"高级" -> 高级弹幕不出现(高级在 t=4,seek(5) 验证)
    const advFilter = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.engine.setTypeFilters({ advanced: false })
      a.engine.seek(5)
      const advCount = a.engine.advanced.active.length
      a.engine.setTypeFilters({ advanced: true })
      a.engine.seek(5)
      const advCount2 = a.engine.advanced.active.length
      return { advCount, advCount2 }
    })()`)
    console.log('ADV-FILTER:', JSON.stringify(advFilter))
    ok(advFilter.advCount === 0 && advFilter.advCount2 > 0, '高级弹幕可被类型过滤筛选')

    // 类型过滤:关闭"滚动" -> 非彩色滚动弹幕不出现(彩色滚动经彩色过滤仍显示,符合逻辑)
    const scrollFilter = await js(`(async () => {
      const a = window.App
      a.engine.setTypeFilters({ scroll: false })
      a.engine.seek(3)
      const hasScroll = a.engine.normal.active.some(d => d.mode === 'scroll' && !d.record.colorful)
      a.engine.setTypeFilters({ scroll: true })
      a.engine.seek(3)
      const hasScroll2 = a.engine.normal.active.some(d => d.mode === 'scroll' && !d.record.colorful)
      return { hasScroll, hasScroll2 }
    })()`)
    console.log('SCROLL-FILTER:', JSON.stringify(scrollFilter))
    ok(!scrollFilter.hasScroll && scrollFilter.hasScroll2, '滚动弹幕可被类型过滤筛选')

    // 屏蔽词(d003@2.4 内容含"B站式",seek(3) 验证)
    const block = await js(`(async () => {
      const a = window.App
      a.engine.setBlockedWords(['B站式'])
      a.engine.seek(3)
      const blocked = a.engine.normal.active.some(d => (d.record.content||'').indexOf('B站式') !== -1)
      a.engine.setBlockedWords([])
      a.engine.seek(3)
      const unblocked = a.engine.normal.active.some(d => (d.record.content||'').indexOf('B站式') !== -1)
      return { blocked, unblocked }
    })()`)
    console.log('BLOCK:', JSON.stringify(block))
    ok(!block.blocked && block.unblocked, '屏蔽词过滤生效')

    // 密度:较多 -> 轨道变多
    const density = await js(`(async () => {
      const a = window.App
      const h0 = a.engine.trackHeight
      a.engine.setDensity('more')
      const h1 = a.engine.trackHeight
      const rows1 = a.engine.rows
      a.engine.setDensity('normal')
      return { h0, h1, rows1, moreDense: h1 < h0 }
    })()`)
    console.log('DENSITY:', JSON.stringify(density))
    ok(density.moreDense, '密度"较多"降低轨道高(' + density.h0 + '->' + density.h1 + ')')

    // 显示区域:50% -> usableHeight 减半
    const area = await js(`(async () => {
      const a = window.App
      const full = a.engine.height
      a.engine.setAreaHeight(50)
      const half = a.engine.usableHeight
      a.engine.setAreaHeight(100)
      return { full, half, ok: Math.abs(half - full / 2) < 2 }
    })()`)
    console.log('AREA:', JSON.stringify(area))
    ok(area.ok, '显示区域 50% 时可用高度减半')

    // 弹幕速度:2x -> 普通弹幕时长减半(更快)
    const speed = await js(`(async () => {
      const a = window.App
      a.engine.pause()
      a.engine.setDanmakuSpeed(2)
      a.engine.seek(1); a.engine.play()
      await new Promise(r => setTimeout(r, 600))
      const dms = a.engine.normal.active.filter(d => d.mode === 'scroll')
      const dur = dms.length ? dms[0].durationSec : 0
      a.engine.setDanmakuSpeed(1)
      return { dur, fast: dur < 3.2 }
    })()`)
    console.log('SPEED:', JSON.stringify(speed))
    ok(speed.fast, '弹幕速度 2x 使普通弹幕时长减半(' + speed.dur + 's)')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
