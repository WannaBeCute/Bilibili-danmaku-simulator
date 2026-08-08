/**
 * 本轮新需求验证:时钟两位小数、百分比0~0.99小数、overlay拖拽不跳(0,0)、
 * 撤回/恢复、右键菜单、发送栏(弹开关/无彩/A弹窗)。
 * 运行:npx electron verify-batch2.js
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

    // ---- 1. 时钟两位小数 ----
    const prec = await js(`(async () => {
      const a = window.App
      a.engine.seek(0); a.engine.play()
      await new Promise(r => setTimeout(r, 1300))
      const t = a.clock.now()
      const s = String(t)
      const dp = s.split('.')[1] || ''
      return { t, dp: dp.length, ok: dp.length <= 2 }
    })()`)
    console.log('CLOCK-PREC:', JSON.stringify(prec))
    ok(prec.ok, '播放时间最多两位小数(' + prec.t + ')')

    // ---- 2. 发送栏:无"彩"按钮 ----
    const noCai = await js(`!document.getElementById('db-colorful')`)
    ok(noCai, '发送栏已删除"彩"按钮')

    // ---- 3. 发送栏:"弹"为显示开关 + A 弹窗 ----
    const bar = await js(`(async () => {
      const a = window.App
      const stage = a.controls.stage
      const beforeOp = stage.style.opacity
      document.getElementById('db-normal').click() // 关闭弹幕
      const afterClick = stage.style.opacity
      document.getElementById('db-normal').click() // 再开
      const afterAgain = stage.style.opacity
      // A 弹窗
      document.getElementById('db-a').click()
      const popupOpen = !document.getElementById('db-style-popup').hidden
      document.getElementById('db-a').click()
      const popupClosed = document.getElementById('db-style-popup').hidden
      return { beforeOp, afterClick, afterAgain, popupOpen, popupClosed }
    })()`)
    console.log('BAR:', JSON.stringify(bar))
    ok(bar.afterClick === '0' && bar.afterAgain !== '0', '"弹"按钮切换弹幕显示')
    ok(bar.popupOpen && bar.popupClosed, 'A 弹窗开合')

    // ---- 4. 百分比 0~0.99 小数换算 ----
    const pct = await js(`(async () => {
      const a = window.App
      const adv = a.store.sorted().find(r => r.type === 'advanced')
      a.store.select(adv.id)
      const panel = a.panelAdvanced
      panel.autoConvertEl.checked = true
      panel.percentEl.checked = true
      panel.togglePercent()
      await new Promise(r => setTimeout(r, 80))
      const p = a.store.get(adv.id).position
      const fraction = p.usePercent && p.startX > 0 && p.startX < 1 && Math.abs(p.startX * a.engine.width - 220) < 5
      // 引擎换算:percent 值 * 宽 = 像素
      a.engine.seek(a.store.get(adv.id).timeSec + 0.01); a.engine.play()
      await new Promise(r => setTimeout(r, 300))
      const dm = a.engine.advanced.active.find(d => d.id === adv.id)
      return { usePercent: p.usePercent, startX: p.startX, fraction, rendered: !!dm }
    })()`)
    console.log('PCT:', JSON.stringify(pct))
    ok(pct.fraction, '百分比为 0~0.99 小数(220px ≈ ' + pct.startX + ')')

    // ---- 5. overlay 拖拽不跳 (0,0) —— 像素模式 ----
    const drag1 = await js(`(async () => {
      const a = window.App
      const adv = a.store.sorted().find(r => r.type === 'advanced')
      a.store.select(adv.id)
      a.editor.setEnabled(true)
      await new Promise(r => setTimeout(r, 200))
      // 切回像素模式
      if (a.store.get(adv.id).position.usePercent) {
        const panel = a.panelAdvanced
        panel.autoConvertEl.checked = true
        panel.percentEl.checked = false
        panel.togglePercent()
      }
      await new Promise(r => setTimeout(r, 100))
      const marker = document.querySelector('#edit-overlay .eo-marker.start')
      if (!marker) return { ok: false, reason: 'no marker' }
      const rect = marker.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const before = a.store.get(adv.id).position.startX
      marker.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 40, clientY: cy, bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      const after = a.store.get(adv.id).position.startX
      return { ok: true, before, after, delta: after - before, moved: Math.abs(after - before - 40) < 3, notZero: after > 0 }
    })()`)
    console.log('DRAG-PX:', JSON.stringify(drag1))
    ok(drag1.ok && drag1.moved && drag1.notZero, '像素模式拖起始点不跳(0,0)且按增量移动')

    // ---- 6. overlay 拖拽不跳 —— 百分比模式 ----
    const drag2 = await js(`(async () => {
      const a = window.App
      const adv = a.store.sorted().find(r => r.type === 'advanced')
      const panel = a.panelAdvanced
      panel.autoConvertEl.checked = true
      panel.percentEl.checked = true
      panel.togglePercent()
      await new Promise(r => setTimeout(r, 150))
      const marker = document.querySelector('#edit-overlay .eo-marker.end')
      if (!marker) return { ok: false, reason: 'no end marker' }
      const rect = marker.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const before = a.store.get(adv.id).position.endX
      marker.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + 20, clientY: cy, bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      const after = a.store.get(adv.id).position.endX
      return { ok: true, before, after, notZero: after > 0 && after < 1, moved: after > before }
    })()`)
    console.log('DRAG-PCT:', JSON.stringify(drag2))
    ok(drag2.ok && drag2.notZero && drag2.moved, '百分比模式拖结束点不跳(0,0)且正确移动')

    // ---- 7. 撤回/恢复 ----
    const undoTest = await js(`(async () => {
      const a = window.App
      const rec = a.store.sorted()[0]
      const origContent = rec.content
      a.store.update(rec.id, { content: '撤回测试' }, 'content')
      await new Promise(r => setTimeout(r, 500))
      a.store.add({ type: 'normal', mode: 'scroll', content: '临时弹幕', timeSec: 0 })
      await new Promise(r => setTimeout(r, 500))
      const afterAdd = a.store.count()
      a.undo.undo()
      const afterUndo1 = a.store.count()
      a.undo.undo()
      const contentAfter = a.store.get(rec.id).content
      const undo2 = a.undo.undo()
      a.undo.redo()
      a.undo.redo()
      const contentAfterRedo = a.store.get(rec.id).content
      return { afterAdd, afterUndo1, contentAfter, undo2, contentAfterRedo, origContent }
    })()`)
    console.log('UNDO:', JSON.stringify(undoTest))
    ok(undoTest.afterUndo1 === undoTest.afterAdd - 1, '撤回撤销新增')
    ok(undoTest.contentAfter === undoTest.origContent, '撤回撤销内容修改')
    ok(undoTest.contentAfterRedo === '撤回测试', '恢复内容修改')

    // ---- 8. 历史上限:≥50 且 ≤100(强制每次独立,验证容量) ----
    const cap = await js(`(async () => {
      const a = window.App
      const rec = a.store.sorted()[0]
      for (let i = 0; i < 60; i++) {
        a.store.update(rec.id, { content: 'cap' + i }, 'content')
        // 强制重置合并窗口,使每次成为独立撤回步骤
        if (a.undo._timer) clearTimeout(a.undo._timer)
        a.undo._pending = false
      }
      await new Promise(r => setTimeout(r, 50))
      return { len: a.undo.history.length }
    })()`)
    console.log('UNDO-CAP:', JSON.stringify(cap))
    ok(cap.len >= 50 && cap.len <= 100, '撤回历史上限 50~100(' + cap.len + ')')

    // ---- 9. 右键菜单:复制/删除 ----
    const ctx = await js(`(async () => {
      const a = window.App
      const menu = document.querySelector('.ctx-menu')
      if (!menu) return { exists: false }
      const rec = a.store.sorted()[0]
      const before = a.store.count()
      menu.dataset.id = rec.id
      menu.querySelector('button:nth-child(1)').click() // 复制
      await new Promise(r => setTimeout(r, 60))
      const afterDup = a.store.count()
      const dupOk = afterDup === before + 1
      const dupRec = a.store.sorted().find(r => r.content === rec.content && r.id !== rec.id)
      const rec2 = a.store.sorted()[0]
      const beforeDel = a.store.count()
      menu.dataset.id = rec2.id
      menu.querySelector('button:nth-child(2)').click() // 删除
      await new Promise(r => setTimeout(r, 60))
      const afterDel = a.store.count()
      return { exists: true, dupOk, delOk: afterDel === beforeDel - 1, hasDup: !!dupRec }
    })()`)
    console.log('CTX:', JSON.stringify(ctx))
    ok(ctx.exists && ctx.dupOk && ctx.hasDup, '右键菜单"复制"生成副本')
    ok(ctx.delOk, '右键菜单"删除"移除弹幕')

    console.log('RESULT:', failures.length ? 'FAIL → ' + failures.join(' | ') : 'PASS')
    app.exit(failures.length ? 1 : 0)
  } catch (err) {
    console.log('VERIFY EXCEPTION: ' + (err && err.stack ? err.stack : err))
    app.exit(2)
  }
})
