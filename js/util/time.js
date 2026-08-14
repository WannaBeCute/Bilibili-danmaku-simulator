/**
 * 时间工具:hh:mm:ss ⇄ 秒
 * 时间格式按用户 JSON 规范:"hh:mm:ss"(也兼容 "mm:ss" / "h:mm:ss.cc")
 */
(function (global) {
  'use strict'

  /**
   * "00:00:02" -> 2 (秒)。解析失败返回 null。
   * 支持 "hh:mm:ss"、"mm:ss"、"ss"、"mm:ss.cc"。负数/非法输入返回 null。
   */
  function strToTime(str) {
    if (str == null) return null
    const s = String(str).trim()
    if (s === '') return null
    // 允许纯数字
    if (/^\d+(\.\d+)?$/.test(s)) {
      return parseFloat(s)
    }
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/)
    if (!m) return null
    const h = m[1] ? parseInt(m[1], 10) : 0
    const min = parseInt(m[2], 10)
    const sec = parseInt(m[3], 10)
    if (min > 59 || sec > 59) return null
    const frac = m[4] ? parseFloat('0.' + m[4]) : 0
    return h * 3600 + min * 60 + sec + frac
  }

  /** 秒 -> "hh:mm:ss"(向下取整,用于界面显示)。 */
  function timeToStr(sec) {
    if (sec == null || isNaN(sec)) sec = 0
    sec = Math.max(0, Math.floor(sec))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const pad = (n) => String(n).padStart(2, '0')
    return pad(h) + ':' + pad(m) + ':' + pad(s)
  }

  /** 秒 -> "hh:mm:ss.cc"(固定保留两位亚秒精度,用于 pa-time 输入框;不足补 00)。 */
  function timeToStr2(sec) {
    if (sec == null || isNaN(sec)) sec = 0
    sec = Math.max(0, sec)
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const frac = sec - Math.floor(sec)
    const pad = (n) => String(n).padStart(2, '0')
    const cc = Math.min(99, Math.round(frac * 100))
    return pad(h) + ':' + pad(m) + ':' + pad(s) + '.' + String(cc).padStart(2, '0')
  }

  /** 秒 -> "hh:mm:ss.cc"(保留亚秒精度,用于 JSON 存储;整数秒不带小数)。 */
  function timeToStrPrecise(sec) {
    if (sec == null || isNaN(sec)) sec = 0
    sec = Math.max(0, sec)
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const frac = sec - Math.floor(sec)
    const pad = (n) => String(n).padStart(2, '0')
    let out = pad(h) + ':' + pad(m) + ':' + pad(s)
    if (frac > 0.0005) {
      const cc = Math.round(frac * 100)
      if (cc > 0) out += '.' + String(cc).padStart(2, '0')
    }
    return out
  }

  /** 秒 -> "mm:ss" 或 "h:mm:ss" 用于界面显示(整数秒,避免长浮点)。 */
  function fmtClock(sec) {
    if (sec == null || isNaN(sec)) sec = 0
    sec = Math.max(0, Math.floor(sec))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    const pad = (n) => String(n).padStart(2, '0')
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s)
  }

  /** 秒 -> "hh:mm:ss"(供 seek 等精确显示,不带小数). */
  function fmtClockExact(sec) {
    if (sec == null || isNaN(sec)) sec = 0
    sec = Math.max(0, Math.floor(sec))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const pad = (n) => String(n).padStart(2, '0')
    return pad(h) + ':' + pad(m) + ':' + pad(s)
  }

  /** ASS 的 "h:mm:ss.cc"(如 0:00:02.00) -> 秒。 */
  function assTimeToSec(str) {
    if (str == null) return null
    const s = String(str).trim()
    const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/)
    if (!m) return null
    const h = m[1] ? parseInt(m[1], 10) : 0
    const min = parseInt(m[2], 10)
    const sec = parseInt(m[3], 10)
    const frac = m[4] ? parseFloat('0.' + m[4]) : 0
    return h * 3600 + min * 60 + sec + frac
  }

  /** Unix 毫秒时间戳 -> "YYYY-MM-DD HH:mm:ss"(本地时区),用于面板只读显示发送时间戳。
   *  非法 -> 返回 ""。注意:sentinel 数字 0 也视为空。*/
  function tsToLocal(ms) {
    const n = Number(ms)
    if (!Number.isFinite(n) || n <= 0) return ''
    const d = new Date(n)
    if (isNaN(d.getTime())) return ''
    const p = (v) => String(v).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  /** 返回当前时刻的 Unix 毫秒时间戳(Date.now()),语义:发送/更改"发生于此刻"。 */
  function nowTs() {
    return Date.now()
  }

  global.TimeUtil = {
    strToTime: strToTime,
    timeToStr: timeToStr,
    timeToStr2: timeToStr2,
    timeToStrPrecise: timeToStrPrecise,
    fmtClock: fmtClock,
    fmtClockExact: fmtClockExact,
    assTimeToSec: assTimeToSec,
    tsToLocal: tsToLocal,
    nowTs: nowTs,
  }
})(window)
