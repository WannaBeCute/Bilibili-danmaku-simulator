/**
 * 颜色工具:
 *  - 十进制 RGB(16777215) ⇄ "#RRGGBB"(B站 XML / 弹幕标准)
 *  - ASS 颜色 &HAABBGGRR 字节反转 -> "#RRGGBB"
 *  - ASS alpha(0~255) -> opacity(0~1)
 */
(function (global) {
  'use strict'

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

  /** 十进制 RGB -> "#RRGGBB"。 */
  function rgb888ToHex(n) {
    n = clamp(Math.round(Number(n) || 0), 0, 16777215)
    return '#' + n.toString(16).padStart(6, '0').toUpperCase()
  }

  /** "#RRGGBB" / "#RGB" -> 十进制 RGB。非法返回 null。 */
  function hexToRgb888(hex) {
    if (typeof hex !== 'string') return null
    let h = hex.trim().replace(/^#/, '')
    if (h.length === 3) {
      h = h.split('').map((c) => c + c).join('')
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
    return parseInt(h, 16)
  }

  /** 规范化任意颜色输入 -> "#RRGGBB"(保留 alpha 外的通道)。非法返回 fallback。 */
  function normalizeHex(color, fallback) {
    if (typeof color !== 'string') return fallback || '#FFFFFF'
    let c = color.trim()
    if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toUpperCase()
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      return '#' + c.slice(1).split('').map((x) => x + x).join('').toUpperCase()
    }
    if (/^[0-9a-fA-F]{6}$/.test(c)) return '#' + c.toUpperCase()
    if (/^\d+$/.test(c)) {
      const hex = rgb888ToHex(Number(c))
      if (hex) return hex
    }
    return fallback || '#FFFFFF'
  }

  /**
   * ASS 颜色值 -> "#RRGGBB"。
   * ASS 的 &H... 按 AABBGGRR 字节序存储,需要字节反转。
   * 示例:&H0203FE -> #FE0302。支持带 alpha 的 &HAABBGGRR(忽略 alpha 通道)。
   */
  function assColorToHex(val, fallback) {
    fallback = fallback || '#FFFFFF'
    if (typeof val !== 'string') return fallback
    let s = val.trim().toUpperCase()
    const m = s.match(/^&H([0-9A-F]+)&?$/)
    if (!m) return fallback
    const hex = m[1]
    if (hex.length < 6) return fallback
    // 取最后 6 位: BBGGRR
    const bbggrr = hex.slice(-6)
    const rr = bbggrr.slice(4, 6)
    const gg = bbggrr.slice(2, 4)
    const bb = bbggrr.slice(0, 2)
    return '#' + rr + gg + bb
  }

  /** ASS alpha 值(0~255,0=不透明) -> opacity(0~1)。 */
  function assAlphaToOpacity(alpha) {
    const a = clamp(Number(alpha) || 0, 0, 255)
    return Math.round(((255 - a) / 255) * 1000) / 1000
  }

  /** opacity(0~1) -> ASS alpha(0~255) 整数。 */
  function opacityToAssAlpha(opacity) {
    const op = clamp(Number(opacity) || 0, 0, 1)
    return Math.round(255 - op * 255)
  }

  /** 任意颜色输入 -> "#RRGGBB"。支持 hex / rgb() / 颜色名 / 十进制 RGB。非法返回 null。 */
  function parseColor(str) {
    if (typeof str !== 'string') return null
    const s = str.trim()
    if (!s) return null
    // 十六进制
    if (/^#?[0-9a-fA-F]{6}$/.test(s) || /^#?[0-9a-fA-F]{3}$/.test(s)) {
      return normalizeHex(s)
    }
    // 十进制 RGB
    if (/^\d+$/.test(s)) {
      const hex = rgb888ToHex(Number(s))
      if (hex) return hex
    }
    // rgb() / rgba()
    const rgb = (m) =>
      '#' +
      [m[1], m[2], m[3]]
        .map((v) => Math.round(clamp(Number(v), 0, 255)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
    let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
    if (m) return rgb(m)
    // 颜色名(经浏览器解析为 rgb)
    if (typeof document !== 'undefined') {
      try {
        const el = document.createElement('div')
        el.style.color = s
        if (!el.style.color) return null
        document.body.appendChild(el)
        const css = getComputedStyle(el).color
        document.body.removeChild(el)
        m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
        if (m) return rgb(m)
      } catch (e) {
        /* ignore */
      }
    }
    return null
  }

  global.ColorUtil = {
    clamp: clamp,
    rgb888ToHex: rgb888ToHex,
    hexToRgb888: hexToRgb888,
    normalizeHex: normalizeHex,
    assColorToHex: assColorToHex,
    assAlphaToOpacity: assAlphaToOpacity,
    opacityToAssAlpha: opacityToAssAlpha,
    parseColor: parseColor,
  }
})(window)
