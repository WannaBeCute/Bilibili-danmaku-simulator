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

  /** 字体英文代码 → CSS font-family */
  var FONT_RAW_TO_CSS = {
    'SimHei': 'SimHei, "Microsoft YaHei", sans-serif',
    'SimSun': 'SimSun, serif',
    'NSimSun': '"NSimSun", "SimSun", serif',
    'FangSong': '"FangSong", serif',
    'MicrosoftYaHei': '"Microsoft YaHei", sans-serif',
  }

  /** 中文/英文字体名 → 英文代码
   *  ★ 含转义引号归一化和扩展别名映射(与 convert.js 保持一致) */
  var FONT_NAME_TO_RAW = {
    // 黑体
    '黑体': 'SimHei', 'SimHei': 'SimHei', 'Microsoft JhengHei': 'SimHei',
    // 宋体
    '宋体': 'SimSun', 'SimSun': 'SimSun', 'MS Mincho': 'SimSun',
    // 新宋体
    '新宋体': 'NSimSun', 'NSimSun': 'NSimSun',
    // 仿宋体
    '仿宋': 'FangSong', '仿宋体': 'FangSong', 'FangSong': 'FangSong',
    // 微软雅黑
    '微软雅黑': 'MicrosoftYaHei', 'MicrosoftYaHei': 'MicrosoftYaHei', 'Microsoft YaHei': 'MicrosoftYaHei',
  }
  function fontToRawCode(name) {
    if (name == null) return null
    // ★ 转义符归一化:将 \" 视作普通 " 处理
    var n = String(name).replace(/\\"/g, '"').trim()
    return FONT_NAME_TO_RAW[n] || null
  }

  /** 从 data[12] 提取字体英文代码(如 "SimHei,36" → "SimHei") */
  function extractFontRaw(data12) {
    if (data12 == null) return null
    var s = String(data12).replace(/["']/g, '').trim()
    var commaIdx = s.indexOf(',')
    if (commaIdx >= 0) s = s.substring(0, commaIdx).trim()
    return FONT_RAW_TO_CSS[s] ? s : null
  }

  /** 根据 data[12] 返回 CSS font-family（不再读取 content 文本）。*/
  function fontFamilyCss(data12) {
    var raw = extractFontRaw(data12)
    if (!raw) raw = resolveFontRawCode(data12)
    return FONT_RAW_TO_CSS[raw || 'SimHei'] || 'SimHei, "Microsoft YaHei", sans-serif'
  }
  /** 从 data[12] 提取字体英文代码 → 标准化;resolveFontRawCode 已处理别名兜底。*/
  function resolveFontRawFromData12(data12) {
    var raw = extractFontRaw(data12)
    if (raw) return raw
    return resolveFontRawCode(data12) || 'SimHei'
  }

  /** ★ 从字体原始代码或名称 → 标准化英文代码(无匹配则回退 SimHei)。
   *  含转义符归一化与完整别名匹配(与 convert.js 同一套 FONT_NAME_TO_RAW / 归一化别名表)。*/
  var FONT_ALIAS_TO_RAW = {
    // 黑体
    'simhei': 'SimHei', 'heiti': 'SimHei', 'microsoft jhenghei': 'SimHei',
    '黑体': 'SimHei', 'simhei': 'SimHei',
    // 宋体
    'simsun': 'SimSun', 'songti': 'SimSun', 'ms mincho': 'SimSun',
    '宋体': 'SimSun', 'simsun': 'SimSun',
    // 新宋体
    'nsimsun': 'NSimSun', 'xinsongti': 'NSimSun', '新宋体': 'NSimSun',
    // 仿宋体
    'fangsong': 'FangSong', 'fangsongti': 'FangSong', '仿宋': 'FangSong', '仿宋体': 'FangSong',
    // 微软雅黑
    'microsoft yahei': 'MicrosoftYaHei', 'msyh': 'MicrosoftYaHei', '微软雅黑': 'MicrosoftYaHei', 'microsoftyahei': 'MicrosoftYaHei',
  }
  function resolveFontRawCode(name) {
    if (name == null) return null
    var n = String(name).replace(/\\"/g, '"').trim()
    // 精确匹配 FONT_NAME_TO_RAW
    if (FONT_NAME_TO_RAW[n]) return FONT_NAME_TO_RAW[n]
    // 剥离引号/逗号后缀后匹配（data12 常见 "SimHei,36"）
    var bare = n.replace(/["']/g, '').trim()
    var commaIdx = bare.indexOf(',')
    if (commaIdx >= 0) bare = bare.substring(0, commaIdx).trim()
    if (FONT_NAME_TO_RAW[bare]) return FONT_NAME_TO_RAW[bare]
    if (FONT_RAW_TO_CSS[bare]) return bare
    // 最后用别名小写匹配兜底(用户指定的5类映射表)
    var low = bare.toLowerCase()
    if (FONT_ALIAS_TO_RAW[low]) return FONT_ALIAS_TO_RAW[low]
    return null
  }

  // ==================== 高级弹幕转换 ====================

  /**
   * 高级弹幕转换:仅依据 JSON 数组与 p 参数(不再解析 content 文本作为参数)。
   *  ★ 描边(data[11]=1 开, 0 关) / 线性加速(data[13]=1 关, 0 开)严格按 data 值处理。
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

    var contentText = data[4] != null ? String(data[4]) : ''

    // ===== 第3步: 解析透明度 (数组 [2] 格式: "1-0.1" 或 "0.8") =====
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

    // ===== 第4步: 组装 JSON(仅依据 data 数组 + p 参数) =====
    var pStartX = round2(num(data[0], 0))
    var pStartY = round2(num(data[1], 0))
    var pEndX = round2(num(data[7], 0))
    var pEndY = round2(num(data[8], 0))
    var isPercent = pStartX >= 0 && pStartX < 1 && pStartY >= 0 && pStartY < 1 &&
                    pEndX >= 0 && pEndX < 1 && pEndY >= 0 && pEndY < 1

    // ★ 字号:优先从 data[12] 里剥出数字部分(常见 "MicrosoftYaHei,36"),否则用 p 里的 fontSize
    var data12FontSize = null
    if (data[12] != null) {
      var m = String(data[12]).match(/(\d+)/)
      if (m) data12FontSize = parseInt(m[1], 10)
    }
    // ★ 描边: data[11]=1 → 开;=0 → 关;非法/缺失 → false(关)【严格匹配】
    var strokeVal = false
    if (data[11] === 1 || data[11] === '1') strokeVal = true
    else if (data[11] === 0 || data[11] === '0') strokeVal = false
    // ★ 线性加速: data[13]=1 → 关闭(非线性);=0 → 开启(线性);非法/缺失 → false(非线性)【严格匹配,data[13]!==1 才 linear=true 的旧逻辑修正】
    var linearVal = false
    if (data[13] === 0 || data[13] === '0') linearVal = true
    else if (data[13] === 1 || data[13] === '1') linearVal = false

    var fontFamilyCssStr = fontFamilyCss(data[12])
    var fontFamilyRawStr = resolveFontRawFromData12(data[12])

    return {
      id: generateId(index),
      sender: uidHash ? uidHash.slice(0, 8) : '匿名',
      type: 'advanced',
      content: contentText,
      time: formatTime(time),
      style: {
        color: convertColor(colorDecimal),
        fontSize: (data12FontSize != null && !isNaN(data12FontSize) ? data12FontSize : fontSizeP) || 36,
        fontFamily: fontFamilyCssStr,
        fontFamilyRaw: fontFamilyRawStr,
        stroke: strokeVal
      },
      rotation: {
        z: num(data[5], 0),
        y: num(data[6], 0)
      },
      life: {
        duration: num(data[3], 4.5),
        opacityStart: opacityStart,
        opacityEnd: opacityEnd
      },
      motion: {
        moveDuration: num(data[9], 500),
        delay: num(data[10], 0),
        linear: linearVal,
        type: 'position'
      },
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

    // ★ 字号映射:按用户规则 18→小,25→中,32→大
    // B站 XML 常见普通弹幕墙字号:18/25/32 分别对应 small/standard/large;
    // 19..25 → 中(更靠近 25),26..31 → 大(更靠近 32)。
    var fsLevel = 'standard'
    if (!isNaN(fontSizeP)) {
      if (fontSizeP <= 18) fsLevel = 'small'
      else if (fontSizeP >= 32) fsLevel = 'large'
      else if (fontSizeP >= 26) fsLevel = 'large'
      else fsLevel = 'standard'
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
