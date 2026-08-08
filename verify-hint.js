/**
 * 舞台提示关闭验证:用 sendInputEvent 发送真实鼠标点击(走完整事件管线),
 * 测 ✕ 与盒子任意位置都能关闭;双击 ✕ 不触发全屏。
 * 运行:npx electron verify-hint.js
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
  setTimeout(() => { console.log('TIMEOUT'); app.exit(1) }, 30000)
  const js = (code) => win.webContents.executeJavaScript(code)

  const click = async (x, y, double) => {
    const count = double ? 2 : 1
    win.webContents.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: 'left', clickCount: count })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: 'left', clickCount: count })
    if (double) {
      win.webContents.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: 'left', clickCount: 2 })
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: 'left', clickCount: 2 })
    }
  }

  try {
    await win.loadFile(path.join(__dirname, 'index.html'))
    await sleep(1500)

    // 命中检测:✕ 与盒子都是可点目标
    const pts = await js(`(function(){
      const hint = document.getElementById('stage-hint')
      hint.hidden = false
      const btn = document.getElementById('hint-dismiss')
      const br = btn.getBoundingClientRect()
      const box = document.querySelector('.stage-hint-box')
      const xr = box.getBoundingClientRect()
      const hitBtn = document.elementFromPoint(br.left + br.width/2, br.top + br.height/2)
      const hitBtnOk = hitBtn === btn || (hitBtn && hitBtn.closest && hitBtn.closest('#hint-dismiss') === btn)
      const hitBox = document.elementFromPoint(xr.left + 10, xr.top + 10)
      const hitBoxOk = hitBox && hitBox.closest && hitBox.closest('.stage-hint-box')
      const shown = getComputedStyle(hint).display !== 'none'
      return { bx: br.left + br.width/2, by: br.top + br.height/2, tx: xr.left + 10, ty: xr.top + 10, hitBtnOk, hitBoxOk, btnW: br.width, btnH: br.height, shown }
    })()`)
    console.log('HIT:', JSON.stringify(pts))
    ok(pts.hitBtnOk, '✕ 可命中')
    ok(pts.hitBoxOk, '盒子可命中')
    ok(pts.shown, '提示初始可见(display 非 none)')

    // 真实点击 ✕ -> 关闭(检查 hidden 属性 + 实际 display)
    await js(`document.getElementById('stage-hint').hidden = false`)
    await sleep(80)
    await click(pts.bx, pts.by, false)
    await sleep(150)
    const closedByBtn = await js(`(function(){
      const h = document.getElementById('stage-hint')
      return { hidden: h.hidden, display: getComputedStyle(h).display }
    })()`)
    console.log('CLOSED-BTN:', JSON.stringify(closedByBtn))
    ok(closedByBtn.hidden && closedByBtn.display === 'none', '真实点击 ✕ 后提示隐藏且实际不显示')

    // 重置,真实点击盒子文本区域 -> 不应关闭(仅 ✕ 关闭)
    await js(`document.getElementById('stage-hint').hidden = false`)
    await sleep(80)
    await click(pts.tx, pts.ty, false)
    await sleep(150)
    const boxNoClose = await js(`(function(){
      const h = document.getElementById('stage-hint')
      return { hidden: h.hidden, display: getComputedStyle(h).display }
    })()`)
    console.log('BOX-CLICK:', JSON.stringify(boxNoClose))
    ok(!boxNoClose.hidden && boxNoClose.display !== 'none', '点盒子文本不关闭(仅 ✕ 关闭)')

    // 重置,双击 ✕ 不触发全屏
    await js(`document.getElementById('stage-hint').hidden = false`)
    await sleep(80)
    await click(pts.bx, pts.by, true)
    await sleep(200)
    const fs = await js(`!!document.fullscreenElement`)
    ok(!fs, '双击 ✕ 不触发全屏')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
