/**
 * serialize.js:运行时数据 -> 导出内容(JSON 信封 / B站兼容 XML)。
 */
(function (global) {
  'use strict'

  const Convert = global.DanmakuConvert

  /** 构建导出 JSON 文本(带缩进)。
   *  @param store  数据存储
   *  @param [recs] 可选:只导出给定的弹幕(不指定或 null 则用 store.sorted() 全量) */
  function buildExportJson(store, recs) {
    const rows = Array.isArray(recs) && recs.length ? recs : store.sorted()
    const env = Convert.toEnvelope(rows, store.videoInfo)
    return JSON.stringify(env, null, 2)
  }

  /** 导出为 B站 / 弹弹play 兼容 XML(普通弹幕)。高级弹幕会标注在原文本中。 */
  function buildDanmakuXml(store) {
    const rows = store.sorted()
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n<i>\n'
    for (const rec of rows) {
      let mode = 1
      if (rec.mode === 'top') mode = 5
      else if (rec.mode === 'bottom') mode = 4
      const color = global.ColorUtil.hexToRgb888(rec.color) || 16777215
      const uid = rec.isUp ? '0' : (rec.sender || 'anonymous')
      const p = rec.timeSec.toFixed(2) + ',' + mode + ',25,' + color + ',' + uid + ',0,0,0'
      out += '  <d p="' + p + '">' + escXml(rec.content) + '</d>\n'
    }
    out += '</i>\n'
    return out
  }

  function escXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  global.DanmakuSerialize = {
    buildExportJson: buildExportJson,
    buildDanmakuXml: buildDanmakuXml,
  }
})(window)
