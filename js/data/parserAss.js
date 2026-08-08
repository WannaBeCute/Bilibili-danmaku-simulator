/**
 * parserAss.js:ASS / SSA 字幕 -> 标准弹幕 JSON 转换。
 *
 * 依据 DanmakuFactory v1.70 导出的 ASS/SSA 格式实现:
 *   - [Script Info] 的 PlayResX/Y 用于坐标缩放
 *   - [V4+ Styles] 的 Format 头动态对齐列名
 *   - [Events] Dialogue 行(Text 可含逗号,需按前 9 个逗号切分)
 *
 * override 标签:
 *   \move(x1,y1,x2,y2,t1,t2)  -> position start/end, delay=t1, moveDuration=t2-t1
 *   \pos(x,y)                 -> 起始=结束,静止
 *   \fsN                      -> 字号
 *   \fnName                   -> 字体
 *   \c&HBGR& / \1c&HBGR&      -> 颜色(ASS BGR 字节反转)
 *   \alpha&Hxx&               -> 透明度
 *   \fryN \frzN               -> rotation.y / rotation.z
 *   \fade(a1,a2,a3,t1,t2,t3,t4) -> opacityStart=(255-a1)/255, opacityEnd=(255-a3)/255
 *   \fad(t1,t2)               -> 淡入淡出(近似 opacity 1 -> 0)
 *   \bN                       -> 描边
 *   \h / \N / \n              -> 空格 / 换行
 *
 * 样式名决定类型:R2L/L2R -> 滚动,TOP -> 顶部,BTM -> 底部,SP/MSG/ADV -> 高级。
 */
(function (global) {
  'use strict'

  const T = global.TimeUtil
  const C = global.ColorUtil

  /** 按前 n 个逗号切分(Text 字段可能含逗号)。 */
  function splitFields(line, n) {
    const parts = []
    let i = 0
    for (let k = 0; k < n - 1; k++) {
      const j = line.indexOf(',', i)
      if (j === -1) {
        parts.push(line.slice(i))
        for (; k < n - 1; k++) parts.push('')
        return parts
      }
      parts.push(line.slice(i, j))
      i = j + 1
    }
    parts.push(line.slice(i))
    return parts
  }

  /** 提取内容与 override 标签序列。 */
  function stripOverrides(text) {
    let content = ''
    const tags = []
    let i = 0
    while (i < text.length) {
      if (text[i] === '{') {
        const j = text.indexOf('}', i)
        if (j === -1) break
        const block = text.slice(i + 1, j)
        for (const part of block.split('\\')) {
          if (part) tags.push(part)
        }
        i = j + 1
      } else {
        content += text[i]
        i++
      }
    }
    content = content.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ')
    return { content: content, tags: tags }
  }

  function parseTag(tag) {
    // 标签 = 字母开头标识(允许 \1c 这种数字+字母)+ 值;如 fs50、fry56、move(...)、alpha&H00、fnSimHei
    const m = tag.match(/^([a-zA-Z0-9]*[a-zA-Z])(.*)$/)
    if (!m) return null
    const name = m[1].toLowerCase()
    let raw = m[2]
    if (raw && raw[0] === '(' && raw[raw.length - 1] === ')') {
      raw = raw.slice(1, -1)
    }
    return { name: name, raw: raw }
  }

  function numList(raw) {
    if (raw == null) return []
    return raw.split(',').map((s) => parseFloat(s.trim()))
  }

  /**
   * 解析 ASS 文本。
   * @param {string} text
   * @param {{width:number,height:number}} [stage] 舞台尺寸(用于坐标缩放)
   * @returns {{records:Array, invalidCount:number, error?:string}}
   */
  function parseAss(text, stage) {
    const lines = text.split(/\r?\n/)
    let section = ''
    let playResX = 1920
    let playResY = 1080
    const styles = {}
    const records = []
    let invalidCount = 0
    let eventFormat = null

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('[')) {
        section = line.replace(/[\[\]]/g, '').toLowerCase()
        continue
      }
      if (section === 'script info') {
        const m = line.match(/^PlayResX\s*:\s*([\d.]+)/i)
        if (m) playResX = parseFloat(m[1])
        const m2 = line.match(/^PlayResY\s*:\s*([\d.]+)/i)
        if (m2) playResY = parseFloat(m2[1])
      } else if (section === 'v4+ styles' || section === 'v4 styles' || section === 'styles') {
        if (/^format\s*:/i.test(line)) {
          eventFormat = null // 重置,避免误用
          const fmt = line.replace(/^format\s*:/i, '').split(',').map((s) => s.trim())
          styles._fmt = fmt
        } else if (/^style\s*:/i.test(line)) {
          const fmt = styles._fmt
          if (!fmt) continue
          const fields = splitFields(line.replace(/^style\s*:/i, ''), fmt.length)
          const obj = {}
          fmt.forEach((name, idx) => {
            obj[name.toLowerCase()] = fields[idx] != null ? fields[idx].trim() : ''
          })
          if (obj.name) styles[obj.name] = obj
        }
      } else if (section === 'events') {
        if (/^format\s*:/i.test(line)) {
          eventFormat = line.replace(/^format\s*:/i, '').split(',').map((s) => s.trim())
        } else if (/^dialogue\s*:/i.test(line)) {
          if (!eventFormat) continue
          const body = line.replace(/^dialogue\s*:/i, '')
          const fields = splitFields(body, eventFormat.length)
          const ev = {}
          eventFormat.forEach((name, idx) => {
            ev[name.toLowerCase()] = fields[idx] != null ? fields[idx].trim() : ''
          })
          const rec = dialogueToRecord(ev, styles, playResX, playResY, stage)
          if (rec) records.push(rec)
          else invalidCount++
        }
      }
    }

    return { records: records, invalidCount: invalidCount }
  }

  function dialogueToRecord(ev, styles, playResX, playResY, stage) {
    const startSec = T.assTimeToSec(ev.start)
    const endSec = T.assTimeToSec(ev.end)
    if (startSec == null || endSec == null || startSec < 0) return null

    const style = styles[ev.style] || {}
    const { content, tags } = stripOverrides(ev.text || '')
    if (!content.trim()) return null

    // 收集 override
    let color = C.assColorToHex(style.primarycolour, '#FFFFFF')
    let fontSize = parseFloat(style.fontsize) || 36
    let fontFamily = style.fontname || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif'
    let rotY = 0
    let rotZ = 0
    let opStart = null // null = 未指定(用样式 alpha)
    let opEnd = null
    let move = null // {x1,y1,x2,y2,t1,t2}
    let pos = null // {x,y}
    let stroke = null
    let alpha = null

    for (const tag of tags) {
      const parsed = parseTag(tag)
      if (!parsed) continue
      const n = parsed.name
      const vals = numList(parsed.raw)
      if (n === 'move' && vals.length >= 4) {
        move = {
          x1: vals[0], y1: vals[1], x2: vals[2], y2: vals[3],
          t1: vals[4] != null ? vals[4] : 0, t2: vals[5] != null ? vals[5] : 0,
        }
      } else if (n === 'pos' && vals.length >= 2) {
        pos = { x: vals[0], y: vals[1] }
      } else if (n === 'fs' && vals.length) {
        fontSize = vals[0]
      } else if (n === 'fn') {
        if (parsed.raw) fontFamily = parsed.raw
      } else if (n === 'c' || n === '1c' || n === '2c' || n === '3c' || n === '4c') {
        color = C.assColorToHex('&H' + parsed.raw.replace(/^&?H/i, '').replace(/&$/, ''), color)
      } else if (n === 'fry' && vals.length) {
        rotY = vals[0]
      } else if (n === 'frz' && vals.length) {
        rotZ = vals[0]
      } else if (n === 'fade' && vals.length >= 3) {
        opStart = C.assAlphaToOpacity(vals[0])
        opEnd = C.assAlphaToOpacity(vals[2])
      } else if (n === 'fad' && vals.length >= 2) {
        opStart = 0.2
        opEnd = 0.0
      } else if (n === 'alpha' && parsed.raw) {
        const a = parseInt(parsed.raw.replace(/&?H/i, ''), 16)
        alpha = isNaN(a) ? null : a
      } else if (n === 'b') {
        const bv = parseInt(parsed.raw || '0', 10)
        stroke = bv === 0 ? false : true
      } else if (n === 'an') {
        // 对齐方式,暂忽略(统一按中心锚点)
      }
    }

    // 样式默认描边:默认开启(除 \\b0 显式关闭外)
    if (stroke == null) {
      stroke = true
    }
    if (opStart == null) opStart = alpha != null ? C.assAlphaToOpacity(alpha) : 1
    if (opEnd == null) opEnd = opStart

    // 坐标缩放
    const k = stage && stage.width && stage.height
      ? Math.min(stage.width / playResX, stage.height / playResY)
      : 1
    const sx = (v) => Math.round(v * k)

    // 类型判定:样式名或高级专属标签(\move/\pos 普通弹幕也用,不算)
    const styleUpper = (ev.style || '').toUpperCase()
    const hasAdvTags = tags.some((t) => {
      const p = parseTag(t)
      return p && /^(fade|fry|frz|alpha)$/i.test(p.name)
    })
    const isAdvanced = /SP|MSG|ADV|SPECIAL/.test(styleUpper) || hasAdvTags

    if (isAdvanced) {
      let startX = 0, startY = 0, endX = 0, endY = 0
      let motionType = 'position'
      let moveDuration = 0
      let delay = 0
      let path = []
      if (move) {
        startX = sx(move.x1); startY = sx(move.y1)
        endX = sx(move.x2); endY = sx(move.y2)
        delay = move.t1
        moveDuration = move.t2 > move.t1 ? move.t2 - move.t1 : 0
        motionType = 'position'
      } else if (pos) {
        startX = sx(pos.x); startY = sx(pos.y)
        endX = startX; endY = startY
        moveDuration = 0
        motionType = 'position'
      }
      return {
        id: null,
        sender: ev.name || 'ASS导入',
        type: 'advanced',
        content: content,
        timeSec: startSec,
        style: {
          color: color,
          fontSize: Math.max(4, Math.round(fontSize * k)),
          fontFamily: fontFamily,
          stroke: !!stroke,
        },
        rotation: { z: rotZ, y: rotY },
        life: {
          duration: Math.max(0.1, endSec - startSec),
          opacityStart: opStart,
          opacityEnd: opEnd,
        },
        motion: {
          moveDuration: moveDuration,
          delay: delay,
          linear: true,
          type: motionType,
          path: path,
        },
        position: {
          usePercent: false,
          startX: startX,
          startY: startY,
          endX: endX,
          endY: endY,
        },
      }
    }

    // 普通弹幕
    let mode = 'scroll'
    if (/TOP/.test(styleUpper)) mode = 'top'
    else if (/BTM|BOT/.test(styleUpper)) mode = 'bottom'
    const fs = parseFloat(fontSize)
    const fontSizeClass = fs <= 21 ? 'small' : fs <= 31 ? 'standard' : 'large'
    return {
      id: null,
      sender: ev.name || 'ASS导入',
      type: 'normal',
      content: content,
      timeSec: startSec,
      mode: mode,
      fontSize: fontSizeClass,
      color: color,
      isUp: false,
    }
  }

  global.DanmakuAssParser = { parseAss: parseAss }
})(window)
