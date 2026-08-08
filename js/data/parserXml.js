/**
 * parserXml.js: B站 / 弹弹play XML 弹幕解析。
 *
 * 按照 B站/弹弹play XML 弹幕规范实现:
 *  - 普通弹幕(mode 1/4/5/6): 从 p 属性 + 纯文本生成 normal record
 *  - 高级弹幕(mode 7): 从 p 属性 + JSON 数组 + content 文本提取参数,
 *    优先级: content文本提取 > JSON数组值 > p参数兜底
 *
 * 输出 records 需再经 Convert.toRuntime 转为运行时格式。
 */
(function (global) {
  'use strict'

  const C = global.ColorUtil

  // ==================== 工具函数 ====================

  /**
   * 颜色转换: 十进制 → #FFFFFF
   */
  function convertColor(decimal) {
    var n = parseInt(decimal, 10)
    if (isNaN(n)) return '#FFFFFF'
    return '#' + n.toString(16).padStart(6, '0').toUpperCase()
  }

  /**
   * 时间格式化: 秒 → hh:mm:ss
   */
  function formatTime(seconds) {
    var h = Math.floor(seconds / 3600)
    var m = Math.floor((seconds % 3600) / 60)
    var s = Math.floor(seconds % 60)
    return String(h).padStart(2, '0') + ':' +
           String(m).padStart(2, '0') + ':' +
           String(s).padStart(2, '0')
  }

  /**
   * 生成唯一ID
   */
  function generateId(index) {
    return 'd' + String(index + 1).padStart(4, '0')
  }

  /**
   * 安全 JSON.parse,兼容 XML 实体编码
   */
  function tryParseArray(text) {
    var t = (text || '').trim()
    if (t.charCodeAt(0) !== 91) return null // 必须以 [ 开头
    try {
      var arr = JSON.parse(t)
      return Array.isArray(arr) ? arr : null
    } catch (_) {
      // 尝试修复 XML 实体编码
      try {
        var fixed = t
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
        var arr2 = JSON.parse(fixed)
        return Array.isArray(arr2) ? arr2 : null
      } catch (e2) {
        return null
      }
    }
  }

  /**
   * 安全数字转换
   */
  function num(v, def) {
    if (v === null || v === undefined || v === '') return def
    var n = Number(v)
    return isNaN(n) ? def : n
  }

  /**
   * 保留最多两位小数 (不补零,不取整)
   */
  function round2(v) {
    if (v == null || isNaN(v)) return v
    return Math.round(v * 100) / 100
  }

  // ==================== content 文本参数提取 ====================

  /**
   * 从 content 文本中提取参数(优先级最高)
   * 示例文本: "弹幕颜色#FE0302 字体大小50 文本字体 微软雅黑 Z轴 57 Y轴 56 ..."
   */
  function extractParamsFromContent(text) {
    var result = {}
    if (!text) return result

    // 颜色: #FE0302
    var colorMatch = text.match(/#([0-9A-Fa-f]{6})/)
    if (colorMatch) result.color = '#' + colorMatch[1].toUpperCase()

    // 字体大小: 字体大小50
    var sizeMatch = text.match(/字体大小(\d+)/)
    if (sizeMatch) result.fontSize = parseInt(sizeMatch[1], 10)

    // 字体: 文本字体 微软雅黑
    var fontMatch = text.match(/文本字体\s*([^\s]+)/)
    if (fontMatch) result.fontFamily = fontMatch[1]

    // 描边: 文字描边 开/关
    if (text.indexOf('文字描边 开') >= 0) result.stroke = true
    else if (text.indexOf('文字描边 关') >= 0) result.stroke = false

    // Z轴旋转: Z轴翻转57 或 Z轴 57
    var rotZMatch = text.match(/Z轴(?:翻转)?\s*([\d.]+)/)
    if (rotZMatch) result.rotationZ = parseFloat(rotZMatch[1])

    // Y轴旋转
    var rotYMatch = text.match(/Y轴(?:翻转)?\s*([\d.]+)/)
    if (rotYMatch) result.rotationY = parseFloat(rotYMatch[1])

    // 生存时间: 生存时间 6.66
    var durMatch = text.match(/生存时间\s*([\d.]+)/)
    if (durMatch) result.duration = parseFloat(durMatch[1])

    // 透明度: 衰弱透明度 1~0.1
    var opMatch = text.match(/衰弱透明度\s*([\d.]+)\s*[~\-]\s*([\d.]+)/)
    if (opMatch) {
      result.opacityStart = parseFloat(opMatch[1])
      result.opacityEnd = parseFloat(opMatch[2])
    }

    // 运动耗时: 运动耗时8000
    var moveMatch = text.match(/运动耗时\s*([\d.]+)/)
    if (moveMatch) result.moveDuration = parseFloat(moveMatch[1])

    // 延迟时间: 延迟时间 1000 或 延迟时间（毫秒） 1000
    var delayMatch = text.match(/延迟时间(?:[（(].*?[)）])?\s*([\d.]+)/)
    if (delayMatch) result.delay = parseFloat(delayMatch[1])

    // 线性加速: 线性加速 开/关
    if (text.indexOf('线性加速 开') >= 0) result.linear = true
    else if (text.indexOf('线性加速 关') >= 0) result.linear = false

    // 起始位置: 起始位置 (289,204) 或 X1 289 Y1 204
    var startMatch = text.match(/起始位置\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)
    if (startMatch) {
      result.startX = parseFloat(startMatch[1])
      result.startY = parseFloat(startMatch[2])
    } else {
      // 备用格式: X1 289 Y1 204
      var x1Match = text.match(/X1\s*([\d.]+)/)
      var y1Match = text.match(/Y1\s*([\d.]+)/)
      if (x1Match) result.startX = parseFloat(x1Match[1])
      if (y1Match) result.startY = parseFloat(y1Match[1])
    }

    // 结束位置: 结束位置 (507,339) 或 X2 507 Y2 339
    var endMatch = text.match(/结束位置\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/)
    if (endMatch) {
      result.endX = parseFloat(endMatch[1])
      result.endY = parseFloat(endMatch[2])
    } else {
      var x2Match = text.match(/X2\s*([\d.]+)/)
      var y2Match = text.match(/Y2\s*([\d.]+)/)
      if (x2Match) result.endX = parseFloat(x2Match[1])
      if (y2Match) result.endY = parseFloat(y2Match[1])
    }

    return result
  }

  // ==================== 高级弹幕转换 ====================

  /**
   * 高级弹幕转换: 按照 md 规范,优先级 content提取 > 数组值 > p参数
   */
  function convertAdvancedDanmaku(xmlContent, pParts, index) {
    // ===== 第1步: 解析 p 参数 =====
    var time = parseFloat(pParts[0])
    var fontSizeP = parseInt(pParts[2], 10)
    var colorDecimal = parseInt(pParts[3], 10)
    var uidHash = pParts[6] || ''

    // ===== 第2步: 解析 JSON 数组 =====
    var data = tryParseArray(xmlContent)
    if (!data) return null

    // ===== 第3步: 从 content 文本提取精确参数 =====
    var contentText = data[4] != null ? String(data[4]) : ''
    var extracted = extractParamsFromContent(contentText)

    // ===== 第4步: 解析透明度 (数组 [2] 格式: "1-0.1" 或 "0.8") =====
    var opacityStart = 1, opacityEnd = 1
    if (data[2] != null) {
      var opStr = String(data[2])
      var opParts = opStr.split('-')
      if (opParts.length >= 2) {
        opacityStart = parseFloat(opParts[0]) || 1
        opacityEnd = parseFloat(opParts[1]) || 1
      } else {
        var opVal = parseFloat(opStr)
        if (!isNaN(opVal)) { opacityStart = opVal; opacityEnd = opVal }
      }
    }

    // ===== 第5步: 组装 JSON (优先级: extracted > data > p) =====
    // 坐标值 (先算出再判断百分比模式)
    var pStartX = round2(extracted.startX != null ? extracted.startX : num(data[0], 0))
    var pStartY = round2(extracted.startY != null ? extracted.startY : num(data[1], 0))
    var pEndX = round2(extracted.endX != null ? extracted.endX : num(data[7], 0))
    var pEndY = round2(extracted.endY != null ? extracted.endY : num(data[8], 0))
    // 4 个坐标值均在 0~0.99 范围内 → 百分比模式
    var isPercent = pStartX >= 0 && pStartX < 1 && pStartY >= 0 && pStartY < 1 &&
                    pEndX >= 0 && pEndX < 1 && pEndY >= 0 && pEndY < 1

    return {
      // 基础信息
      id: generateId(index),
      sender: uidHash ? uidHash.slice(0, 8) : '匿名',
      type: 'advanced',

      // 内容与时间
      content: contentText,
      time: formatTime(time),

      // 外观样式
      style: {
        color: extracted.color || convertColor(colorDecimal),
        fontSize: extracted.fontSize ||
                  (data[12] != null ? parseInt(String(data[12]).replace(/[^\d]/g, ''), 10) || fontSizeP : fontSizeP) || 36,
        fontFamily: extracted.fontFamily ||
                    (data[12] != null ? String(data[12]).replace(/["']/g, '') : '') || 'SimHei',
        stroke: extracted.stroke != null ? extracted.stroke : false
      },

      // 空间旋转
      rotation: {
        z: extracted.rotationZ != null ? extracted.rotationZ : num(data[5], 0),
        y: extracted.rotationY != null ? extracted.rotationY : num(data[6], 0)
      },

      // 生命周期
      life: {
        duration: extracted.duration != null ? extracted.duration : num(data[3], 4.5),
        opacityStart: extracted.opacityStart != null ? extracted.opacityStart : opacityStart,
        opacityEnd: extracted.opacityEnd != null ? extracted.opacityEnd : opacityEnd
      },

      // 运动轨迹
      motion: {
        moveDuration: extracted.moveDuration != null ? extracted.moveDuration : num(data[9], 500),
        delay: extracted.delay != null ? extracted.delay : num(data[10], 0),
        linear: extracted.linear != null ? extracted.linear : (data[13] !== 1),
        type: 'position'
      },

      // 坐标定位
      position: {
        usePercent: isPercent,
        startX: pStartX,
        startY: pStartY,
        endX: pEndX,
        endY: pEndY
      }
    }
  }

  // ==================== 普通弹幕转换 ====================

  /**
   * 普通弹幕转换: mode 1/2/3=滚动, 4=底部, 5=顶部, 6=逆向滚动
   */
  function convertNormalDanmaku(text, pParts, index) {
    var time = parseFloat(pParts[0])
    var modeNum = parseInt(pParts[1], 10)
    var fontSizeP = parseFloat(pParts[2])
    var colorDecimal = parseInt(pParts[3], 10)
    var uid = pParts[4] || ''
    var pool = parseInt(pParts[5], 10)

    var mode = 'scroll'
    if (modeNum === 4) mode = 'bottom'
    else if (modeNum === 5) mode = 'top'
    else if (modeNum === 6) mode = 'scroll'

    // 字号映射
    var fsLevel = 'standard'
    if (!isNaN(fontSizeP)) {
      if (fontSizeP <= 21) fsLevel = 'small'
      else if (fontSizeP <= 31) fsLevel = 'standard'
      else fsLevel = 'large'
    }

    return {
      id: generateId(index),
      sender: uid || '匿名',
      type: 'normal',
      content: text,
      time: formatTime(time),
      mode: mode,
      fontSize: fsLevel,
      color: convertColor(colorDecimal),
      isUp: uid === '0'
    }
  }

  // ==================== 主解析函数 ====================

  /**
   * 解析 XML 文本 → { records, invalidCount, error? }
   * records 为中间态数组(区分 normal/advanced),需再经 Convert.toRuntime。
   */
  function parseXml(text) {
    var doc
    try {
      doc = new DOMParser().parseFromString(text, 'text/xml')
    } catch (e) {
      return { records: [], invalidCount: 0, error: 'XML 解析失败: ' + e.message }
    }
    if (!doc) return { records: [], invalidCount: 0, error: '无法解析 XML' }

    var els = Array.from(doc.getElementsByTagName('d'))
    if (!els.length) {
      return { records: [], invalidCount: 0, error: '未找到 <d> 弹幕元素' }
    }

    var records = []
    var invalidCount = 0
    var validIndex = 0

    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      var p = el.getAttribute('p')
      var rawText = (el.textContent || '').trim()
      if (p == null) { invalidCount++; continue }

      var parts = p.split(',')
      var time = parseFloat(parts[0])
      if (isNaN(time) || time < 0) { invalidCount++; continue }

      var modeNum = parseInt(parts[1], 10)

      if (modeNum === 7) {
        // ===== 高级弹幕 =====
        var rec = convertAdvancedDanmaku(rawText, parts, validIndex)
        if (!rec) { invalidCount++; continue }
        records.push(rec)
        validIndex++
      } else if (modeNum === 1 || modeNum === 2 || modeNum === 3 ||
                 modeNum === 4 || modeNum === 5 || modeNum === 6) {
        // ===== 普通弹幕 =====
        if (rawText === '') { invalidCount++; continue }
        records.push(convertNormalDanmaku(rawText, parts, validIndex))
        validIndex++
      } else {
        // 8=代码 9=BAS 等不支持的模式
        invalidCount++
      }
    }

    return { records: records, invalidCount: invalidCount }
  }

  global.DanmakuXmlParser = { parseXml: parseXml }
})(window)
