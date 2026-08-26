/**
 * convert.js:用户标准 JSON(信封格式) ⇄ 运行时对象。
 *
 * 用户 JSON 信封:
 *   { "version": 1,
 *     "video": { "filename": "...", "path": "...", "duration": 123.4 },
 *     "comments": [ ...用户规格的普通/高级弹幕... ] }
 *
 * 用户普通弹幕:
 *   { id, sender, type:'normal', content, time:"hh:mm:ss",
 *     mode:'scroll'|'top'|'bottom', fontSize:'small'|'standard'|'large',
 *     color:'#FFFFFF', isUp, colorful? }
 * 用户高级弹幕:
 *   { id, sender, type:'advanced', content, time,
 *     style:{color,fontSize,fontFamily,stroke}, rotation:{z,y},
 *     life:{duration,opacityStart,opacityEnd},
 *     motion:{moveDuration,delay,linear,type,path?}, position:{usePercent,startX,startY,endX,endY} }
 */
(function (global) {
  'use strict'

  const T = global.TimeUtil
  const C = global.ColorUtil
  const DEFAULT_FONT = 'SimHei, "Microsoft YaHei", sans-serif'

  const FONT_FAMILIES = ['黑体', '宋体', '新宋体', '仿宋体', '微软雅黑']
  const FONT_ALIAS = {
    // 黑体
    simhei: '黑体', heiti: '黑体',
    'microsoft jhenghei': '黑体',
    // 宋体
    simsun: '宋体', songti: '宋体', 'ms mincho': '宋体',
    // 新宋体
    nsimsun: '新宋体', xinsongti: '新宋体',
    // 仿宋体
    fangsong: '仿宋体', fangsongti: '仿宋体',
    // 微软雅黑
    'microsoft yahei': '微软雅黑', msyh: '微软雅黑',
  }
  const FONT_CSS = {
    '黑体': 'SimHei, "Microsoft YaHei", sans-serif',
    '宋体': 'SimSun, serif',
    '新宋体': '"NSimSun", "SimSun", serif',
    '仿宋体': '"FangSong", serif',
    '微软雅黑': '"Microsoft YaHei", sans-serif',
  }

  // ★ CSS font-family → 英文代码(用于 XML data[12])
  const FONT_RAW = {
    'SimHei, "Microsoft YaHei", sans-serif': 'SimHei',
    'SimSun, serif': 'SimSun',
    '"NSimSun", "SimSun", serif': 'NSimSun',
    '"FangSong", serif': 'FangSong',
    '"Microsoft YaHei", sans-serif': 'MicrosoftYaHei',
  }
  function getFontRawCode(family) {
    const s = String(family == null ? '' : family).trim()
    return FONT_RAW[s] || 'SimHei'
  }

  // ★ 增强模式的参数上限(86400s = 24h)
  const BOOST_MAX_LIFE = 86400
  const BOOST_MAX_MS = 86400000 // 86400 * 1000
  // 普通模式的参数上限
  const NORM_MAX_LIFE = 10
  const NORM_MAX_MOVE = 10000
  const NORM_MAX_DELAY = 10000

  function makeAdvanced() {
    return {
      type: 'advanced',
      style: { color: '#FFFFFF', fontSize: 36, fontFamily: DEFAULT_FONT, stroke: true },
      rotation: { z: 0, y: 0 },
      life: { duration: 4.5, opacityStart: 1, opacityEnd: 1 },
      motion: { moveDuration: 500, delay: 0, linear: false, type: 'position', path: [] },
      position: { usePercent: false, startX: 0, startY: 0, endX: 0, endY: 0 },
      _boost: false, // ★ 增强开关,默认关闭
    }
  }

  function makeNormal() {
    return {
      type: 'normal',
      mode: 'scroll',
      fontSize: 'standard',
      color: '#FFFFFF',
      isUp: false,
    }
  }

  function normalizeMode(mode) {
    mode = String(mode == null ? 'scroll' : mode).trim().toLowerCase()
    if (mode === '1' || mode === '2' || mode === '3') return 'scroll'
    if (mode === '4') return 'bottom'
    if (mode === '5') return 'top'
    if (mode === '6') return 'scroll' // ltr 归并为 scroll
    if (mode === 'scroll' || mode === 'top' || mode === 'bottom') return mode
    return 'scroll'
  }

  function normalizeFontSize(fs) {
    const s = String(fs == null ? 'standard' : fs).trim().toLowerCase()
    if (s === 'small' || s === 'standard' || s === 'large') return s
    const n = parseFloat(fs)
    if (!isNaN(n)) {
      if (n <= 21) return 'small'
      if (n <= 31) return 'standard'
      return 'large'
    }
    return 'standard'
  }

  function normalizeColor(color, fallback) {
    const c = C.normalizeHex(color, fallback)
    return c || fallback
  }

  function num(v, def, min, max) {
    const n = parseFloat(v)
    if (isNaN(n)) return def
    if (min != null && n < min) return min
    if (max != null && n > max) return max
    return n
  }

  /** 钳制并保留指定位小数。 */
  function clampRound(v, lo, hi, dp) {
    let n = parseFloat(v)
    if (isNaN(n)) return lo
    n = Math.min(hi, Math.max(lo, n))
    const m = Math.pow(10, dp)
    return Math.round(n * m) / m
  }

  /** 按字符(码点)截断,任意字符都算长度 1。 */
  function truncateLen(str, n) {
    const arr = Array.from(String(str == null ? '' : str))
    return arr.slice(0, n).join('')
  }

  /** 字体白名单归一(含常见别名映射),非法回退默认黑体。
   *  ★ 转义符归一化:将 \" 视作普通 " 处理,剥离多余转义,确保匹配准确。*/
  function normalizeFontFamily(f, def) {
    const s = String(f == null ? '' : f).replace(/\\"/g, '"').trim()
    if (FONT_FAMILIES.indexOf(s) !== -1) return FONT_CSS[s] || s
    const alias = FONT_ALIAS[s.toLowerCase()]
    if (alias) return FONT_CSS[alias] || alias
    if (FONT_CSS[s]) return FONT_CSS[s]
    if (s.indexOf(',') !== -1 || s.indexOf('sans-serif') !== -1) return s
    return def || DEFAULT_FONT
  }

  /**
   * 把用户 JSON 弹幕对象 -> 运行时对象。非法返回 null。
   * 入参 item 可能是信封 comments 里的项,也可能是 XML/ASS 转换产生的中间对象。
   */
  function toRuntime(item) {
    if (!item || typeof item !== 'object') return null
    const type = item.type === 'advanced' ? 'advanced' : 'normal'
    let timeSec = item.timeSec
    if (timeSec == null) {
      const t = item.time != null ? T.strToTime(item.time) : null
      if (t == null) {
        // XML 可能给纯数字秒
        if (!isNaN(parseFloat(item.time))) timeSec = parseFloat(item.time)
        else return null
      } else {
        timeSec = t
      }
    }
    if (isNaN(timeSec) || timeSec < 0) return null

    const base = {
      id: item.id || null,
      sender: String(item.sender == null ? '' : item.sender),
      type: type,
      content: '',
      timeSec: timeSec,
      // ★ 发送时间戳(ms,Unix):兼容旧 JSON 里的 sentAt
      ctime: (Number.isFinite(item.ctime) && item.ctime > 0) ? Number(item.ctime)
        : (Number.isFinite(item.sentAt) && item.sentAt > 0 ? Number(item.sentAt) : 0),
    }
    if (item.useCurrentTime) base.useCurrentTime = true

    if (type === 'normal') {
      base.content = truncateLen(item.content, 100) // 普通弹幕内容 ≤ 100 字符
      base.mode = normalizeMode(item.mode)
      base.fontSize = normalizeFontSize(item.fontSize)
      base.color = normalizeColor(item.color, '#FFFFFF')
      base.isUp = !!item.isUp
      if (item.colorful != null && Number(item.colorful) !== 0) {
        base.colorful = Number(item.colorful)
      }
    } else {
      base.content = truncateLen(item.content, 255) // 高级弹幕内容 ≤ 255 字符,不可为空
      const s = item.style || {}
      const r = item.rotation || {}
      const l = item.life || {}
      const mo = item.motion || {}
      const p = item.position || {}
      const usePercent = !!p.usePercent

      // ★ 先判断是否需要自动开启增强:原始值是否超出普通范围
      const rawLifeDur = parseFloat(l && l.duration)
      const rawMoveDur = parseFloat(mo && mo.moveDuration)
      const rawDelay = parseFloat(mo && mo.delay)
      const needBoost = !!item._boost
        || (rawLifeDur != null && !isNaN(rawLifeDur) && rawLifeDur > NORM_MAX_LIFE)
        || (rawMoveDur != null && !isNaN(rawMoveDur) && rawMoveDur > NORM_MAX_MOVE)
        || (rawDelay != null && !isNaN(rawDelay) && rawDelay > NORM_MAX_DELAY)
      base._boost = needBoost
      const maxLife = needBoost ? BOOST_MAX_LIFE : NORM_MAX_LIFE
      const maxMove = needBoost ? BOOST_MAX_MS : NORM_MAX_MOVE
      const maxDelay = needBoost ? BOOST_MAX_MS : NORM_MAX_DELAY

      // 坐标:像素 0~9999 一位小数;百分比 0~0.99 两位小数(小于1的小数)
      const coordClamp = (v) => (usePercent ? clampRound(v, 0, 0.99, 2) : clampRound(v, 0, 9999, 1))
      const path = Array.isArray(mo.path)
        ? mo.path
            .map((pt) => ({ x: coordClamp(pt && pt.x), y: coordClamp(pt && pt.y) }))
            .filter((pt) => !isNaN(pt.x) && !isNaN(pt.y))
        : Array.isArray(p.path)
          ? p.path
              .map((pt) => ({ x: coordClamp(pt && pt.x), y: coordClamp(pt && pt.y) }))
              .filter((pt) => !isNaN(pt.x) && !isNaN(pt.y))
          : []
      base.style = {
        color: normalizeColor(s.color, '#FF0000'),
        fontSize: Math.round(clampRound(s.fontSize, 10, 127, 0)), // 字号 10~127 整数
        fontFamily: normalizeFontFamily(s.fontFamily, DEFAULT_FONT),
        fontFamilyRaw: s.fontFamilyRaw || getFontRawCode(normalizeFontFamily(s.fontFamily, DEFAULT_FONT)),
        stroke: s.stroke !== false,
      }
      base.rotation = {
        z: clampRound(r.z, 0, 360, 1), // Z/Y 旋转 0~360,一位小数
        y: clampRound(r.y, 0, 360, 1),
      }
      base.life = {
        duration: clampRound(l.duration, 0, maxLife, 2), // ★ 开增强时上限为 BOOST_MAX_LIFE
        opacityStart: clampRound(l.opacityStart, 0, 1, 2), // 透明度 0~1.0,两位小数
        opacityEnd: clampRound(l.opacityEnd, 0, 1, 2),
      }
      base.motion = {
        moveDuration: clampRound(mo.moveDuration, 0, maxMove, 1), // ★ 开增强时上限为 BOOST_MAX_MS
        delay: clampRound(mo.delay, 0, maxDelay, 1),            // ★ 开增强时上限为 BOOST_MAX_MS
        linear: mo.linear !== false,
        type: mo.type === 'path' ? 'path' : 'position',
        path: path,
      }
      base.position = {
        usePercent: usePercent,
        startX: coordClamp(p.startX),
        startY: coordClamp(p.startY),
        endX: coordClamp(p.endX),
        endY: coordClamp(p.endY),
      }
    }
    return base
  }

  /** 运行时对象 -> 用户 JSON 弹幕对象(输出钳制/hex/截断)。 */
  function toUserJson(rec) {
    if (!rec) return null
    const out = {
      id: rec.id,
      sender: rec.sender,
      type: rec.type,
      content: rec.content,
      time: T.timeToStrPrecise(rec.timeSec),
    }
    if (Number.isFinite(rec.ctime) && rec.ctime > 0) {
      out.ctime = Number(rec.ctime) // ★ 发送时间戳(Unix ms),非 0 才持久化(单一 ctime 字段,删除 sentAt/sentAtLocal)
    }
    if (rec.type === 'normal') {
      out.content = truncateLen(rec.content, 100)
      out.mode = rec.mode
      out.fontSize = rec.fontSize
      out.color = normalizeColor(rec.color, '#FFFFFF')
      out.isUp = !!rec.isUp
      if (rec.colorful != null && rec.colorful !== 0) out.colorful = rec.colorful
      if (rec.useCurrentTime) out.useCurrentTime = true
    } else {
      const boost = !!rec._boost
      if (boost) out._boost = true // ★ 增强模式持久化
      const maxLife = boost ? BOOST_MAX_LIFE : NORM_MAX_LIFE
      const maxMove = boost ? BOOST_MAX_MS : NORM_MAX_MOVE
      const maxDelay = boost ? BOOST_MAX_MS : NORM_MAX_DELAY
      out.content = truncateLen(rec.content, 255)
      const usePercent = !!rec.position.usePercent
      const coordClamp = (v) => (usePercent ? clampRound(v, 0, 0.99, 2) : clampRound(v, 0, 9999, 1))
      out.style = {
        color: normalizeColor(rec.style.color, '#FF0000'),
        fontSize: Math.round(clampRound(rec.style.fontSize, 10, 127, 0)),
        fontFamily: normalizeFontFamily(rec.style.fontFamily, DEFAULT_FONT),
        fontFamilyRaw: rec.style.fontFamilyRaw || getFontRawCode(rec.style.fontFamily),
        stroke: !!rec.style.stroke,
      }
      out.rotation = {
        z: clampRound(rec.rotation.z, 0, 360, 1),
        y: clampRound(rec.rotation.y, 0, 360, 1),
      }
      out.life = {
        duration: clampRound(rec.life.duration, 0, maxLife, 2), // ★ 增强时保留大值
        opacityStart: clampRound(rec.life.opacityStart, 0, 1, 2),
        opacityEnd: clampRound(rec.life.opacityEnd, 0, 1, 2),
      }
      out.motion = {
        moveDuration: clampRound(rec.motion.moveDuration, 0, maxMove, 1), // ★ 增强时保留大值
        delay: clampRound(rec.motion.delay, 0, maxDelay, 1),            // ★ 增强时保留大值
        linear: !!rec.motion.linear,
        type: rec.motion.type,
      }
      if (rec.motion.path && rec.motion.path.length) {
        out.motion.path = rec.motion.path.map((pt) => ({
          x: coordClamp(pt.x),
          y: coordClamp(pt.y),
        }))
      }
      out.position = {
        usePercent: usePercent,
        startX: coordClamp(rec.position.startX),
        startY: coordClamp(rec.position.startY),
        endX: coordClamp(rec.position.endX),
        endY: coordClamp(rec.position.endY),
      }
      if (rec.useCurrentTime) out.useCurrentTime = true
    }
    return out
  }

  /** 运行时对象数组 -> 用户 JSON 信封。 */
  function toEnvelope(comments, videoInfo) {
    return {
      version: 1,
      video: videoInfo
        ? {
            filename: videoInfo.filename || '',
            path: videoInfo.path || '',
            duration: videoInfo.duration || 0,
          }
        : null,
      comments: comments.map(toUserJson).filter(Boolean),
    }
  }

  /** 解析用户 JSON 信封 -> { videoInfo, records, invalidCount }。 */
  function fromEnvelope(json) {
    let data = json
    if (typeof json === 'string') {
      try {
        data = JSON.parse(json)
      } catch (e) {
        return { videoInfo: null, records: [], invalidCount: 0, error: 'JSON 解析失败: ' + e.message }
      }
    }
    if (!data || typeof data !== 'object') {
      return { videoInfo: null, records: [], invalidCount: 0, error: '数据格式错误' }
    }
    // 兼容两种形态:信封 {comments:[...]} 或直接数组
    const rawList = Array.isArray(data) ? data : data.comments
    const videoInfo = data && data.video && !Array.isArray(data) ? data.video : null
    if (!Array.isArray(rawList)) {
      return { videoInfo: null, records: [], invalidCount: 0, error: '缺少 comments 数组' }
    }
    let invalidCount = 0
    const records = []
    for (const item of rawList) {
      const r = toRuntime(item)
      if (r) records.push(r)
      else invalidCount++
    }
    return { videoInfo: videoInfo, records: records, invalidCount: invalidCount }
  }

  /** 校验运行时弹幕参数,返回 { ok, error }。 */
  function validateRecord(rec) {
    if (!rec) return { ok: false, error: '未选中弹幕' }
    const dec = (n, dp) => {
      const s = String(n == null ? '' : n)
      const m = s.match(/^-?\d+(?:\.(\d+))?$/)
      if (!m) return true
      return (m[1] || '').length <= dp
    }
    const len = (s) => Array.from(String(s == null ? '' : s)).length
    if (rec.type === 'normal') {
      if (len(rec.content) < 1) return { ok: false, error: '内容不能为空' }
      if (len(rec.content) > 100) return { ok: false, error: '内容超出 100 字符' }
      if (isNaN(rec.timeSec) || rec.timeSec < 0) return { ok: false, error: '出现时间非法' }
      if (!['scroll', 'top', 'bottom'].includes(rec.mode)) return { ok: false, error: '模式非法' }
      if (!global.ColorUtil.normalizeHex(rec.color)) return { ok: false, error: '颜色格式非法' }
      return { ok: true }
    }
    // 高级
    if (len(rec.content) < 1) return { ok: false, error: '内容不能为空' }
    if (len(rec.content) > 255) return { ok: false, error: '内容超出 255 字符' }
    const s = rec.style
    if (!Number.isInteger(s.fontSize) || s.fontSize < 10 || s.fontSize > 127) {
      return { ok: false, error: '字号须为 10~127 的整数' }
    }
    if (!FONT_CSS[s.fontFamily] && FONT_FAMILIES.indexOf(s.fontFamily) === -1 && s.fontFamily.indexOf(',') === -1) {
      return { ok: false, error: '字体仅限 黑体/宋体/新宋体/仿宋/微软雅黑' }
    }
    for (const k of ['z', 'y']) {
      const v = rec.rotation[k]
      if (isNaN(v) || v < 0 || v > 360 || !dec(v, 1)) return { ok: false, error: '旋转须为 0~360 一位小数' }
    }
    const boost = !!rec._boost
    const maxLife = boost ? BOOST_MAX_LIFE : NORM_MAX_LIFE
    const maxMove = boost ? BOOST_MAX_MS : NORM_MAX_MOVE
    const maxDelay = boost ? BOOST_MAX_MS : NORM_MAX_DELAY
    if (isNaN(rec.life.duration) || rec.life.duration < 0 || rec.life.duration > maxLife || !dec(rec.life.duration, 2)) {
      return { ok: false, error: boost ? ('生存时间须为 0~' + BOOST_MAX_LIFE + ' 两位小数(增强)') : '生存时间须为 0~10 两位小数' }
    }
    for (const k of ['opacityStart', 'opacityEnd']) {
      const v = rec.life[k]
      if (isNaN(v) || v < 0 || v > 1 || !dec(v, 2)) return { ok: false, error: '透明度须为 0~1 两位小数' }
    }
    const vM = rec.motion.moveDuration
    if (isNaN(vM) || vM < 0 || vM > maxMove || !dec(vM, 1)) {
      return { ok: false, error: boost ? ('运动耗时须为 0~' + BOOST_MAX_MS + ' 一位小数(增强)') : '运动耗时须为 0~10000 一位小数' }
    }
    const vD = rec.motion.delay
    if (isNaN(vD) || vD < 0 || vD > maxDelay || !dec(vD, 1)) {
      return { ok: false, error: boost ? ('延迟须为 0~' + BOOST_MAX_MS + ' 一位小数(增强)') : '延迟须为 0~10000 一位小数' }
    }
    const coordOk = (v) => {
      if (rec.position.usePercent) return !isNaN(v) && v >= 0 && v <= 0.99 && dec(v, 2)
      return !isNaN(v) && v >= 0 && v <= 9999 && dec(v, 1)
    }
    for (const k of ['startX', 'startY', 'endX', 'endY']) {
      if (!coordOk(rec.position[k])) return { ok: false, error: '坐标超出范围或小数位数超限' }
    }
    return { ok: true }
  }

  /** ★ 深拷贝一条高级弹幕运行时对象(用于「复制」按钮创建新草稿);非高级类型返回 null。
   *  ★ ctime 不沿用被复制弹幕的:复制瞬间先写入 Date.now(),最后以实际发送时为准(发送时会再次覆写)。*/
  function cloneAdvanced(src) {
    if (!src || src.type !== 'advanced') return null
    return {
      type: 'advanced',
      content: String(src.content || ''),
      sender: src.sender == null ? '' : String(src.sender),
      timeSec: Number.isFinite(src.timeSec) ? Number(src.timeSec) : 0,
      useCurrentTime: !!src.useCurrentTime,
      ctime: global.TimeUtil && typeof global.TimeUtil.nowTs === 'function' ? global.TimeUtil.nowTs() : Date.now(), // ★ 复制时间刻为草稿的 ctime(仅展示用),发送时会被重写
      style: Object.assign({}, src.style),
      rotation: Object.assign({}, src.rotation),
      life: Object.assign({}, src.life),
      motion: Object.assign({}, src.motion, { path: Array.isArray(src.motion && src.motion.path) ? src.motion.path.map((p) => Object.assign({}, p)) : [] }),
      position: Object.assign({}, src.position),
      _boost: !!src._boost, // ★ 复制时继承增强开关状态
    }
  }

  global.DanmakuConvert = {
    makeAdvanced: makeAdvanced,
    makeNormal: makeNormal,
    toRuntime: toRuntime,
    toUserJson: toUserJson,
    toEnvelope: toEnvelope,
    fromEnvelope: fromEnvelope,
    normalizeMode: normalizeMode,
    validateRecord: validateRecord,
    cloneAdvanced: cloneAdvanced,
  }
})(window)
