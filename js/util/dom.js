/**
 * DOM 小工具:选择器、创建元素、事件、防抖、双 rAF。
 */
(function (global) {
  'use strict'

  function $(sel, root) {
    return (root || document).querySelector(sel)
  }

  function $$(sel, root) {
    return Array.from((root || document).querySelectorAll(sel))
  }

  /** 创建元素:el('div', 'cls a b', html)。 */
  function el(tag, cls, html) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (html != null) node.innerHTML = html
    return node
  }

  function on(node, evt, fn, opts) {
    node.addEventListener(evt, fn, opts)
    return () => node.removeEventListener(evt, fn, opts)
  }

  function debounce(fn, ms) {
    let t = null
    return function () {
      const args = arguments
      const self = this
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        t = null
        fn.apply(self, args)
      }, ms)
    }
  }

  /** 等两帧后回调(等浏览器完成样式布局/字体渲染后测量尺寸)。 */
  function nextFrame(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn))
  }

  function raf(fn) {
    return requestAnimationFrame(fn)
  }

  function cancelRaf(id) {
    cancelAnimationFrame(id)
  }

  global.DomUtil = {
    $: $,
    $$: $$,
    el: el,
    on: on,
    debounce: debounce,
    nextFrame: nextFrame,
    raf: raf,
    cancelRaf: cancelRaf,
  }
})(window)
