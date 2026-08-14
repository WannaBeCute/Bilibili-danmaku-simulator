/**
 * serialize.js:运行时数据 -> 导出内容(JSON 信封 / B站兼容 XML / ASS)。
 *
 * 导出取舍策略(本地 JSON 对应不到的数据按 B站 XML/ASS 规范作兜底或舍弃):
 *   - 发送时间戳:本项目 sentAt (Unix ms)。XML 中对应 p[4]「发送时间戳」,无则用 0。
 *   - 用户HASH(sender):XML p[6]。本地 sender 非数字/短 ASCII 会被原样塞入,符合实际兼容。
 *   - 弹幕池/弹幕ID/屏蔽等级:本项目没有,分别写 0 / (id数字或0) / 0。
 *   - mode 参数:1/2/3 = 滚动;4 = 底部;5 = 顶部;6 = 逆向(ltr,本项目视为 scroll,仍写1兼容);7 = 特殊(高级弹幕)。
 *   - 高级弹幕 XML:data[] 数组严格按用户给的 14 槽位顺序拼,对应不到的字段按 schema 兜底。
 *   - ASS:仅滚动/顶/底的文本/颜色/字号可映射,高级弹幕退化成滚动普通行。
 */
(function (global) {
  'use strict'

  const Convert = global.DanmakuConvert
  const FONT_PX = { small: 18, standard: 25, large: 36 }

  /** 构建导出 JSON 文本(带缩进)。
   *  @param store  数据存储
   *  @param [recs] 可选:只导出给定的弹幕(不指定或 null 则用 store.sorted() 全量) */
  function buildExportJson(store, recs) {
    const rows = Array.isArray(recs) && recs.length ? recs : store.sorted()
    const env = Convert.toEnvelope(rows, store.videoInfo)
    return JSON.stringify(env, null, 2)
  }

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function hashToDecimal(hash, fallback) {
    if (hash == null || hash === '') return fallback != null ? fallback : 0
    const s = String(hash)
    // 纯数字(十进制):直接转;否则一个稳定的 31 位正整数哈希
    if (/^-?\d+$/.test(s)) {
      const n = parseInt(s, 10)
      if (Number.isFinite(n)) return Math.abs(n) % 0x7FFFFFFF
    }
    let h = 0
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0
    }
    return (h >>> 0) % 0x7FFFFFFF
  }

  function idToNumber(id) {
    if (id == null) return 0
    const m = String(id).match(/\d+/)
    return m ? parseInt(m[0], 10) : 0
  }

  /**
   * 导出为 B站 / 弹弹play 兼容的完整 XML(普通 + 高级)。
   * p 参数格式:{时间},{mode},{字号},{十进制颜色},{发送时间戳},{弹幕池},{用户HASH},{弹幕ID},{屏蔽等级}
   * 高级弹幕 <d> 内容是 JSON 数组,严格 14 槽位:
   *   [0]startX,[1]startY,[2]opacity(start-end),[3]lifeDuration(s),[4]text,
   *   [5]rotZ,[6]rotY,[7]endX,[8]endY,[9]moveDuration(ms),[10]delay(ms),
   *   [11]stroke(1/0),[12]"\"FontCode\",size",[13]linearFlag(1=加速, 0=匀速)
   *
   * ★ 设计首选:XML (高级弹幕完整)
   */
  function buildDanmakuXml(store, recs) {
    const rows = Array.isArray(recs) && recs.length ? recs.slice() : store.sorted()
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<i>\n'
    for (const rec of rows) {
      const color = rec.type === 'advanced'
        ? (global.ColorUtil.hexToRgb888(rec.style.color) || 16777215)
        : (global.ColorUtil.hexToRgb888(rec.color) || 16777215)
      // 字号:普通 18/25/36;高级直接使用 style.fontSize
      let fsPx = 25
      if (rec.type === 'advanced') fsPx = rec.style.fontSize || 36
      else fsPx = FONT_PX[rec.fontSize] || 25
      // mode
      let mode = 1
      if (rec.type === 'advanced') mode = 7
      else if (rec.mode === 'top') mode = 5
      else if (rec.mode === 'bottom') mode = 4
      // 发送时间戳 Unix 秒:sentAt 是 ms,/1000
      let ts = 0
      if (Number.isFinite(rec.sentAt) && rec.sentAt > 0) ts = Math.floor(rec.sentAt / 1000)
      // 弹幕池/屏蔽等级:本项目无,写 0/10
      const pool = 0
      const block = 10
      const userHash = 'ffffffff'
      const dmId = '666666666666666666'
      const time = (Number.isFinite(rec.timeSec) ? rec.timeSec : 0).toFixed(2)
      const p = time + ',' + mode + ',' + fsPx + ',' + color + ',' + ts + ',' + pool + ',' + userHash + ',' + dmId + ',' + block

      if (rec.type === 'advanced') {
        // 高级弹幕 JSON 数组
        const pos = rec.position || {}
        const sx = pos.usePercent ? Number((pos.startX || 0).toFixed(4)) : (Number.isFinite(pos.startX) ? Math.round(pos.startX) : 0)
        const sy = pos.usePercent ? Number((pos.startY || 0).toFixed(4)) : (Number.isFinite(pos.startY) ? Math.round(pos.startY) : 0)
        const ex = pos.usePercent ? Number((pos.endX || 0).toFixed(4)) : (Number.isFinite(pos.endX) ? Math.round(pos.endX) : 0)
        const ey = pos.usePercent ? Number((pos.endY || 0).toFixed(4)) : (Number.isFinite(pos.endY) ? Math.round(pos.endY) : 0)
        const opS = (rec.life && Number.isFinite(rec.life.opacityStart)) ? rec.life.opacityStart : 1
        const opE = (rec.life && Number.isFinite(rec.life.opacityEnd)) ? rec.life.opacityEnd : 1
        const opacityStr = opS === opE
          ? (Math.round(opS * 100) / 100).toString()
          : (Math.round(opS * 100) / 100) + '-' + (Math.round(opE * 100) / 100)
        const lifeDur = (rec.life && Number.isFinite(rec.life.duration)) ? Number(rec.life.duration.toFixed(2)) : 4.5
        const text4 = String(rec.content || '')
        const rotZ = rec.rotation && Number.isFinite(rec.rotation.z) ? Number(rec.rotation.z.toFixed(1)) : 0
        const rotY = rec.rotation && Number.isFinite(rec.rotation.y) ? Number(rec.rotation.y.toFixed(1)) : 0
        const moveMs = rec.motion && Number.isFinite(rec.motion.moveDuration) ? Math.round(rec.motion.moveDuration) : 500
        const delayMs = rec.motion && Number.isFinite(rec.motion.delay) ? Math.round(rec.motion.delay) : 0
        const strokeFlag = rec.style && rec.style.stroke ? 1 : 0
        const family12 = String(
          (rec.style && (rec.style.fontFamilyRaw || pickFontName(rec.style.fontFamily))) || 'SimHei'
        )
        // data13: 1=加速, 0=匀速(不加速)
        const data13 = rec.motion && rec.motion.linear ? 0 : 1

        const arr = [
          sx, sy, opacityStr, lifeDur, text4,
          rotZ, rotY, ex, ey, moveMs, delayMs,
          strokeFlag, family12, data13
        ]
        out += '  <d p="' + p + '">' + escXml(JSON.stringify(arr)) + '</d>\n'
      } else {
        out += '  <d p="' + p + '">' + escXml(rec.content || '') + '</d>\n'
      }
    }
    out += '</i>\n'
    return out
  }

  /** 从 CSS font-family 字符串里反推字体英文代码(用于 XML 槽 data[12])。 */
  function pickFontName(family) {
    const s = String(family == null ? '' : family)
    if (s.indexOf('Microsoft YaHei') !== -1 || s === '微软雅黑') return 'MicrosoftYaHei'
    if (s.indexOf('SimHei') !== -1 || s === '黑体') return 'SimHei'
    if (s.indexOf('NSimSun') !== -1 || s === '新宋体') return 'NSimSun'
    if (s.indexOf('SimSun') !== -1 || s === '宋体') return 'SimSun'
    if (s.indexOf('FangSong') !== -1 || s === '仿宋') return 'FangSong'
    const m = s.match(/["']?([^",]+?)["']?(?:,|$)/)
    return m ? m[1].trim() : 'SimHei'
  }

  /**
   * 导出 ASS(适合某些特殊播放器使用)。
   * 参考 DanmakuFactory 格式: Script Info(PlayResX 1920 / PlayResY 1080) + V4+ Styles + Events。
   * 取舍:
   *  - 滚动弹幕 → \move(x1,y1,x2,y2) + 样式 R2L,文字走右→左
   *  - 顶部 → Alignment 8(顶部居中),位置按时间条均分若干槽
   *  - 底部 → Alignment 2(底部居中),位置均分若干槽
   *  - 高级弹幕 → 退化成滚动(保留颜色/字号/内容),复杂 3D/路径 无法在 ASS 无损表达
   *  - 颜色用 ASS &HAABBGGRR,透明度 α = 255 - opacity*255,且按 life 两端取较亮一端
   *  - 字号:本地 px → ASS px;时间用 h:mm:ss.cc
   */
  function buildDanmakuAss(store, recs) {
    const rows = Array.isArray(recs) && recs.length ? recs.slice() : store.sorted()
    const W = 1920
    const H = 1080
    const TRACK_H = 40  // 单轨道高度(ASS 画布内)
    const TOP_TRACKS = 8
    const BOTTOM_TRACKS = 8
    const SCROLL_TRACKS = Math.max(8, Math.floor((H - 80) / TRACK_H) - TOP_TRACKS - BOTTOM_TRACKS)
    // 轨道分配:滚动从上→下;顶部从 0→N-1;底部从 -1→-N(槽位栈)
    const scrollUsed = new Array(SCROLL_TRACKS).fill(0) // 时间戳(直到该轨道上的弹幕离开屏幕左侧)
    const topUsed = new Array(TOP_TRACKS).fill(0)
    const botUsed = new Array(BOTTOM_TRACKS).fill(0)

    function findTrack(arr, duration, startSec) {
      const releaseAt = startSec + duration
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] <= startSec) {
          arr[i] = releaseAt
          return i
        }
      }
      // 全部占用:复用最早释放的那一轨(视觉重叠,但不丢行)
      let best = 0
      for (let i = 1; i < arr.length; i++) if (arr[i] < arr[best]) best = i
      arr[best] = releaseAt
      return best
    }

    let script = ''
    script += '[Script Info]\n'
    script += '; Exported by Advanced Danmaku Simulator\n'
    script += 'ScriptType: v4.00+\n'
    script += 'Collisions: Normal\n'
    script += 'PlayResX: ' + W + '\n'
    script += 'PlayResY: ' + H + '\n'
    script += 'Timer: 100.0000\n'
    script += 'WrapStyle: 2\n'
    script += 'ScaledBorderAndShadow: yes\n\n'

    script += '[V4+ Styles]\n'
    script += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
    // 颜色 Primary 用 &H00FFFFFF 白;Outline &H00000000;Back 浅蓝灰便于对比
    script += 'Style: R2L,Microsoft YaHei,38,&H4BFFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,0,0,0,0,100.00,100.00,0.00,0.00,1,0.0,1.0,8,0,0,0,1\n'
    script += 'Style: TOP,Microsoft YaHei,38,&H4BFFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,0,0,0,0,100.00,100.00,0.00,0.00,1,0.0,1.0,8,0,0,0,1\n'
    script += 'Style: BOT,Microsoft YaHei,38,&H4BFFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,0,0,0,0,100.00,100.00,0.00,0.00,1,0.0,1.0,2,0,0,0,1\n'
    script += 'Style: ADV,Microsoft YaHei,38,&H4BFFFFFF,&H00FFFFFF,&H00000000,&H1E6A5149,0,0,0,0,100.00,100.00,0.00,0.00,1,0.0,1.0,7,0,0,0,1\n\n'

    script += '[Events]\n'
    script += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'

    function secToAss(s) {
      if (!Number.isFinite(s) || s < 0) s = 0
      const h = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      const sec = Math.floor(s % 60)
      const frac = Math.min(99, Math.round((s - Math.floor(s)) * 100))
      const p = (n) => String(n).padStart(2, '0')
      return h + ':' + p(m) + ':' + p(sec) + '.' + String(frac).padStart(2, '0')
    }

    function cssToAssColor(hex, alpha) {
      let r = 255, g = 255, b = 255
      if (hex && hex[0] === '#' && hex.length >= 7) {
        r = parseInt(hex.slice(1, 3), 16) | 0
        g = parseInt(hex.slice(3, 5), 16) | 0
        b = parseInt(hex.slice(5, 7), 16) | 0
      }
      const a = Math.max(0, Math.min(255, 255 - Math.round((alpha == null ? 1 : alpha) * 255)))
      const pad = (n) => String(n).toString(16).toUpperCase().padStart(2, '0')
      return '&H' + pad(a) + pad(b) + pad(g) + pad(r)
    }

    function assEscape(text) {
      // ASS 换行 \N;花括号 { } → ( ) 避免被解释为标签;其他保留
      return String(text == null ? '' : text)
        .replace(/\r\n?/g, '\n')
        .replace(/\n/g, '\\N')
        .replace(/\{/g, '(')
        .replace(/\}/g, ')')
    }

    for (const rec of rows) {
      const startSec = Number.isFinite(rec.timeSec) ? rec.timeSec : 0
      // 弹幕持续时长:普通弹幕 5s 滚动(与默认引擎一致);高级弹幕取 life.duration
      let lifeSec = 5
      if (rec.type === 'advanced' && rec.life && Number.isFinite(rec.life.duration)) lifeSec = rec.life.duration
      let color = rec.type === 'advanced' ? (rec.style.color || '#FFFFFF') : (rec.color || '#FFFFFF')
      let op = 1
      if (rec.type === 'advanced' && rec.life) {
        const s = Number.isFinite(rec.life.opacityStart) ? rec.life.opacityStart : 1
        const e = Number.isFinite(rec.life.opacityEnd) ? rec.life.opacityEnd : 1
        op = Math.max(s, e)
      }
      const assColor = cssToAssColor(color, op)
      // 字号
      let fontSize = 25
      if (rec.type === 'advanced') fontSize = (rec.style && Number.isFinite(rec.style.fontSize)) ? rec.style.fontSize : 36
      else fontSize = FONT_PX[rec.fontSize] || 25
      const textRaw = String(rec.content || '')
      if (textRaw === '') continue
      const txtEscape = assEscape(textRaw)

      let styleName = 'R2L'
      let alignment = 8
      let layer = 0
      let y = 0
      let x = 0
      let moveTag = ''
      // 决定是滚动/顶/底
      let placement = 'scroll'
      if (rec.type !== 'advanced') {
        if (rec.mode === 'top') placement = 'top'
        else if (rec.mode === 'bottom') placement = 'bottom'
      } else {
        // 高级弹幕:若固定位置(非全屏)用 ADV + pos;否则 R2L
        const pos = rec.position || {}
        const stX = Number(pos.startX), stY = Number(pos.startY)
        if (!pos.usePercent && Number.isFinite(stX) && Number.isFinite(stY) && stX >= 0 && stY >= 0 && stX <= W && stY <= H) {
          placement = 'adv'
          x = stX; y = stY
          styleName = 'ADV'; alignment = 7
          if (Number.isFinite(rec.life.duration)) lifeSec = rec.life.duration
        }
      }

      const endSec = startSec + lifeSec
      let tags = '\\c' + assColor + '\\fs' + fontSize
      if (rec.type === 'advanced' && rec.style && rec.style.stroke === false) tags += '\\bord0'
      let posLine = ''

      if (placement === 'scroll') {
        styleName = 'R2L'
        // 轨道估计:按 5s 滚动,从屏幕右侧到左侧
        const track = findTrack(scrollUsed, lifeSec, startSec)
        y = 80 + track * TRACK_H + Math.floor(TRACK_H / 2)
        // 估算文本宽度(粗略,ASS 最终渲染会做真实宽度):按 px * 1 em
        const estW = Math.max(120, fontSize * Math.min(60, Math.max(1, Array.from(textRaw).length)))
        const x1 = W + estW
        const y1 = y
        const x2 = -estW
        const y2 = y
        moveTag = '\\move(' + x1 + ',' + y1 + ',' + x2 + ',' + y2 + ')'
      } else if (placement === 'top') {
        styleName = 'TOP'; alignment = 8
        const slot = findTrack(topUsed, lifeSec, startSec)
        y = 40 + slot * TRACK_H + Math.floor(TRACK_H / 2)
        x = Math.floor(W / 2)
        tags += '\\an8'
      } else if (placement === 'bottom') {
        styleName = 'BOT'; alignment = 2
        const slot = findTrack(botUsed, lifeSec, startSec)
        y = H - 40 - slot * TRACK_H - Math.floor(TRACK_H / 2)
        x = Math.floor(W / 2)
        tags += '\\an2'
      } else {
        // adv:pos(x,y)
        tags += '\\an7\\pos(' + Math.round(x) + ',' + Math.round(y) + ')'
        if (rec.rotation) {
          if (Number.isFinite(rec.rotation.z) && Math.round(rec.rotation.z) !== 0) tags += '\\frz' + (-Math.round(rec.rotation.z))
          if (Number.isFinite(rec.rotation.y) && Math.round(rec.rotation.y) !== 0) tags += '\\fry' + Math.round(rec.rotation.y)
        }
      }

      void alignment
      const textWithTags = '{' + tags + (moveTag ? moveTag : '') + '}' + txtEscape
      // Layer:滚动 0;顶/底 1;高级 2
      if (placement === 'top' || placement === 'bottom') layer = 1
      else if (placement === 'adv') layer = 2
      script += 'Dialogue: ' + layer + ',' + secToAss(startSec) + ',' + secToAss(endSec)
        + ',' + styleName + ',ADV,0,0,0,,' + textWithTags + '\n'
    }

    return script
  }

  global.DanmakuSerialize = {
    buildExportJson: buildExportJson,
    buildDanmakuXml: buildDanmakuXml,
    buildDanmakuAss: buildDanmakuAss,
  }
})(window)
