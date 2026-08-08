/**
 * 核心逻辑冒烟测试(纯 Node,无浏览器依赖):
 *   - 时间/颜色工具
 *   - ASS 解析(用真实 弹幕代码.txt)
 *   - B站 XML 解析
 *   - JSON 信封转换往返
 */
const fs = require('fs')
const path = require('path')

// 模拟浏览器全局:IIFE 挂到 window
global.window = global
global.navigator = { userAgent: 'node' }
global.requestAnimationFrame = () => 0
global.cancelAnimationFrame = () => {}

function load(file) {
  require(path.join(__dirname, 'js', file))
}

;['util/time.js', 'util/color.js', 'data/convert.js', 'data/parserAss.js', 'data/parserXml.js', 'data/serialize.js', 'data/store.js'].forEach(load)

const T = global.TimeUtil
const C = global.ColorUtil
let fail = 0
function ok(cond, name) {
  if (cond) console.log('  ✔ ' + name)
  else { console.log('  ✘ ' + name); fail++ }
}

console.log('== 时间工具 ==')
ok(T.strToTime('00:00:02') === 2, 'strToTime 00:00:02 -> 2')
ok(T.strToTime('01:02:03') === 3723, 'strToTime 01:02:03 -> 3723')
ok(T.strToTime('00:05') === 5, 'strToTime mm:ss -> 5')
ok(T.timeToStr(2) === '00:00:02', 'timeToStr 2 -> 00:00:02')
ok(T.assTimeToSec('0:00:02.00') === 2, 'assTimeToSec 0:00:02.00 -> 2')
ok(T.assTimeToSec('0:00:08.66') > 8.65 && T.assTimeToSec('0:00:08.66') < 8.67, 'assTimeToSec 8.66')

console.log('== 颜色工具 ==')
ok(C.rgb888ToHex(16777215) === '#FFFFFF', 'rgb888ToHex 16777215 -> #FFFFFF')
ok(C.hexToRgb888('#FF0000') === 16711680, 'hexToRgb888 #FF0000 -> 16711680')
ok(C.assColorToHex('&H0203FE') === '#FE0302', 'assColorToHex &H0203FE -> #FE0302')
ok(C.assColorToHex('&H4BFFFFFF') === '#FFFFFF', 'assColorToHex &H4BFFFFFF(带alpha) -> #FFFFFF')
ok(C.assAlphaToOpacity(0) === 1, 'alpha 0 -> opacity 1')
ok(Math.abs(C.assAlphaToOpacity(229) - 0.102) < 0.01, 'alpha 229 -> opacity ~0.102')

console.log('== ASS 解析(弹幕代码.txt) ==')
const assText = fs.readFileSync(path.join(__dirname, '弹幕代码.txt'), 'utf8')
const assRes = global.DanmakuAssParser.parseAss(assText, { width: 1920, height: 1080 })
console.log('  解析出 ' + assRes.records.length + ' 条')
ok(assRes.records.length === 9, '应解析出 9 条(DanmakuFactory 样例)')
const adv = assRes.records.find((r) => r.type === 'advanced' && r.content.includes('高级弹幕'))
if (adv) {
  console.log('  adv:', JSON.stringify(adv).slice(0, 400))
  ok(adv.timeSec === 2, '高级弹幕出现时间 2s')
  ok(Math.abs(adv.life.duration - 6.66) < 0.01, 'life.duration ~6.66')
  ok(adv.rotation.z === 57 && adv.rotation.y === 56, 'rotation z=57 y=56')
  ok(adv.style.color === '#FE0302', '颜色字节反转 #FE0302')
  ok(adv.style.fontSize === 50, 'fontSize 50')
  ok(adv.style.fontFamily === 'Microsoft YaHei', 'fontFamily 继承样式(\\fn 空值=重置)')
  ok(adv.motion.delay === 1000 && adv.motion.moveDuration === 8000, 'delay 1000 moveDuration 8000')
  ok(adv.position.startX === 289 && adv.position.startY === 204, 'startX/Y 289/204')
  ok(adv.position.endX === 507 && adv.position.endY === 339, 'endX/Y 507/339')
  ok(Math.abs(adv.life.opacityStart - 1) < 0.01, 'opacityStart ~1(ASS原始,不透明)')
  ok(Math.abs(adv.life.opacityEnd - 0.102) < 0.01, 'opacityEnd ~0.102')
}
const top = assRes.records.find((r) => r.type === 'normal' && r.mode === 'top')
ok(!!top && top.content.includes('顶部'), 'TOP 样式 -> normal/top(仅\\pos 不算高级)')
const scrolls = assRes.records.filter((r) => r.type === 'normal' && r.mode === 'scroll')
ok(scrolls.length >= 4, 'R2L 样式 -> normal/scroll 至少 4 条')
// 缩放测试:1280x720 舞台坐标应 *0.667
const assRes2 = global.DanmakuAssParser.parseAss(assText, { width: 1280, height: 720 })
const adv2 = assRes2.records.find((r) => r.type === 'advanced' && r.content.includes('高级弹幕'))
ok(adv2 && adv2.position.startX === 193, '坐标按 PlayRes 缩放 289*0.667≈193')
ok(adv2 && adv2.style.fontSize === 33, '字号按 PlayRes 缩放 50*0.667≈33')

console.log('== B站 XML 解析 ==')
// Node 无 DOMParser,用正则 mock
global.DOMParser = function () {
  this.parseFromString = function (text, type) {
    const els = []
    const re = /<d[^>]*p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/gi
    let m
    while ((m = re.exec(text))) {
      const el = {
        _p: m[1],
        _t: m[2].replace(/<[^>]+>/g, '').trim(),
        getAttribute(n) {
          return n === 'p' ? this._p : null
        },
      }
      Object.defineProperty(el, 'textContent', { get() { return this._t } })
      els.push(el)
    }
    return { getElementsByTagName(tag) { return tag === 'd' ? els : [] } }
  }
}
const xml = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><d p="0.00,1,25,16777215,123456789,0,0,0">第一条弹幕</d><d p="3.50,4,25,16711680,0,0,0,0">底部弹幕</d><d p="6.00,5,25,65280,0,0,0,0">顶部弹幕</d></i>`
const xmlRes = global.DanmakuXmlParser.parseXml(xml)
console.log('  解析出 ' + xmlRes.records.length + ' 条')
ok(xmlRes.records.length === 3, '3 条')
ok(xmlRes.records[0].mode === 'scroll' && xmlRes.records[0].color === '#FFFFFF', '滚动白字')
ok(xmlRes.records[1].mode === 'bottom' && xmlRes.records[1].color === '#FF0000', '底部红字')
ok(xmlRes.records[2].mode === 'top' && xmlRes.records[2].isUp === true, '顶部且 isUp(uid=0)')

console.log('== JSON 信封转换往返 ==')
const store = new global.CommentStore()
const demo = [
  { type: 'normal', mode: 'scroll', content: '你好', timeSec: 1.5, fontSize: 'standard', color: '#FFFFFF', isUp: false },
  { type: 'advanced', content: '高级', timeSec: 3, style: { color: '#FF0000', fontSize: 36, fontFamily: '黑体', stroke: true }, rotation: { z: 10, y: 20 }, life: { duration: 4.5, opacityStart: 1, opacityEnd: 0.1 }, motion: { moveDuration: 8000, delay: 1000, linear: true, type: 'position', path: [] }, position: { usePercent: false, startX: 100, startY: 100, endX: 300, endY: 200 } },
]
const recs = demo.map((d) => global.DanmakuConvert.toRuntime(d))
recs.forEach((r) => store.add(r))
store.videoInfo = { filename: 'test.mp4', path: '/x/test.mp4', duration: 60 }
const envText = global.DanmakuSerialize.buildExportJson(store)
ok(typeof envText === 'string' && envText.includes('"video"'), '导出含 video 标注')
const parsed = global.DanmakuConvert.fromEnvelope(envText)
ok(parsed.records.length === 2, '往返 2 条')
ok(parsed.records[0].timeSec === 1.5, '时间往返 1.5s(保精度)')
const env0 = JSON.parse(envText).comments[0]
ok(env0.time === '00:00:01.50', '用户JSON time 为 hh:mm:ss.cc')
ok(env0.content === '你好' && env0.mode === 'scroll' && env0.color === '#FFFFFF', '普通弹幕字段完整')
ok(parsed.videoInfo.filename === 'test.mp4', 'video 标注往返')
ok(parsed.records[1].motion.moveDuration === 8000, '高级弹幕参数往返')

console.log('== 高级弹幕参数约束(toRuntime 钳制) ==')
const advIn = {
  type: 'advanced', content: 'x'.repeat(300), timeSec: 1,
  style: { color: 'red', fontSize: 999, fontFamily: 'Arial', stroke: true },
  rotation: { z: -50, y: 500 },
  life: { duration: 99, opacityStart: 1, opacityEnd: 0.551 },
  motion: { moveDuration: 8000, delay: 0, linear: true, type: 'position', path: [] },
  position: { usePercent: false, startX: 50000, startY: -3, endX: 10.55, endY: 20 },
}
const advRt = global.DanmakuConvert.toRuntime(advIn)
ok(advRt.content.length === 255, '高级内容截断到 255')
ok(advRt.style.color === '#FF0000', '颜色名 red -> #FF0000')
ok(advRt.style.fontSize === 127, '字号钳制 127')
ok(advRt.style.fontFamily === '黑体', '非法字体回退黑体')
ok(advRt.rotation.z === 0 && advRt.rotation.y === 360, '旋转钳制 0~360')
ok(advRt.life.duration === 10, '生存时间钳制 10')
ok(advRt.life.opacityStart === 1 && advRt.life.opacityEnd === 0.55, '透明度钳制0~1.0且两位小数(0.551->0.55)')
ok(advRt.position.startX === 9999 && advRt.position.startY === 0, '坐标钳制 0~9999')
ok(advRt.position.endX === 10.6, '坐标一位小数(10.55->10.6)')

console.log('== 普通弹幕内容截断 ==')
const norIn = { type: 'normal', mode: 'scroll', content: 'a'.repeat(150), timeSec: 1 }
ok(global.DanmakuConvert.toRuntime(norIn).content.length === 100, '普通内容截断到 100')

console.log('\n' + (fail ? '✘ ' + fail + ' 项失败' : '✔ 全部通过'))
process.exit(fail ? 1 : 0)
