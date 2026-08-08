/**
 * filedialog.js:文件操作弹窗。
 *  - 打开类:拖拽文件至弹窗、点「打开文件夹」浏览、或者 Ctrl+V 粘贴文件/文本
 *  - 导出类:确认框 + 「选择保存位置」
 */
(function (global) {
  'use strict'

  const D = global.DomUtil

  class FileDialog {
    constructor() {
      this.root = D.$('#file-dialog')
      this.title = D.$('#fd-title')
      this.drop = D.$('#fd-drop')
      this.pasteHint = D.$('#fd-drop-paste')
      this.browse = D.$('#fd-browse')
      this.cancel = D.$('#fd-cancel')
      this._input = null
      this._onFile = null
      this._onSave = null
      /** 保存当前打开弹窗时绑定的 paste 监听,用于关闭时解绑 */
      this._pasteHandler = null

      this.browse.addEventListener('click', () => {
        if (this._onSave) {
          this.fireSave()
          return
        }
        if (this._input) this._input.click()
      })
      this.cancel.addEventListener('click', () => this.close())
      this.root.addEventListener('click', (e) => {
        if (e.target === this.root) this.close()
      })
      this.drop.addEventListener('dragover', (e) => {
        e.preventDefault()
        this.drop.classList.add('over')
      })
      this.drop.addEventListener('dragleave', () => this.drop.classList.remove('over'))
      this.drop.addEventListener('drop', (e) => {
        e.preventDefault()
        this.drop.classList.remove('over')
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
        if (f) this._finishFile(f)
      })
    }

    /** 打开类:title 标题,accept 过滤器,onFile 回调。 */
    open(title, accept, onFile) {
      this.title.textContent = title
      this._onFile = onFile
      this.drop.hidden = false
      // 打开类提示支持粘贴
      if (this.pasteHint) this.pasteHint.style.display = ''
      this.browse.textContent = '打开文件夹'
      this.browse.hidden = false
      this.root.hidden = false

      if (this._input) this._input.remove()
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = accept || ''
      inp.style.display = 'none'
      document.body.appendChild(inp)
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0]
        if (f) this._finishFile(f)
        inp.value = ''
      })
      this._input = inp

      // 绑定全局 CTRL+V 粘贴监听(仅当此弹窗打开时生效)
      this._unbindPaste()
      this._pasteHandler = (ev) => this._handlePaste(ev)
      // capture: true 确保在输入框自身处理之前我们先截获(否则会被文本框吞掉事件)
      // 但实际上需要避免在用户聚焦到 <input>/<textarea> 时吞掉他们的正常粘贴,
      // 所以 _handlePaste 里会做焦点判断
      document.addEventListener('paste', this._pasteHandler, true)
    }

    /** 导出类:确认框 + 选择保存位置。 */
    openSave(title, onSave) {
      this.title.textContent = title
      this._onSave = onSave
      this.drop.hidden = true
      // 导出类不支持粘贴
      if (this.pasteHint) this.pasteHint.style.display = 'none'
      this.browse.textContent = '选择保存位置'
      this.browse.hidden = false
      this.root.hidden = false
    }

    _finishFile(file) {
      const cb = this._onFile
      this.close()
      if (cb) cb(file)
    }

    /** 把纯文本包装成伪 File 对象,让现有 FileReader 流程无缝复用。 */
    _wrapTextAsFile(text, name) {
      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
        // 某些环境 File 构造函数不可用,退而用 Blob,加 name 属性模拟
        let file
        try {
          file = new File([blob], name || 'clipboard-content.txt', {
            type: 'text/plain;charset=utf-8',
            lastModified: Date.now(),
          })
        } catch (e) {
          file = blob
          file.name = name || 'clipboard-content.txt'
          file.lastModified = Date.now()
        }
        return file
      } catch (e) {
        return null
      }
    }

    /**
     * 判断当前焦点是否在可编辑输入元素里,如果是则不吞粘贴事件。
     * 避免用户在弹幕输入框/面板里粘贴时反而触发文件导入。
     */
    _isEditableFocus() {
      const a = document.activeElement
      if (!a) return false
      const tag = (a.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (a.isContentEditable) return true
      return false
    }

    /** 处理粘贴:优先文件,其次文本。只有在当前弹窗已打开且焦点不在文本框时触发。 */
    _handlePaste(ev) {
      // 弹窗关闭了就不应再处理
      if (this.root.hidden) return
      // 导出类不需要粘贴
      if (this._onSave) return
      if (this._isEditableFocus()) return

      const cd = ev.clipboardData || (window.clipboardData && window.clipboardData)
      if (!cd) return

      // 1) 优先文件:浏览器复制文件时会把文件放进 items/files
      let file = null
      try {
        if (cd.files && cd.files.length > 0) {
          file = cd.files[0]
        }
      } catch (e) { /* ignore */ }

      if (!file) {
        try {
          const items = cd.items
          if (items && items.length) {
            for (let i = 0; i < items.length; i++) {
              const it = items[i]
              if (it.kind === 'file') {
                const f = it.getAsFile && it.getAsFile()
                if (f) { file = f; break }
              }
            }
          }
        } catch (e) { /* ignore */ }
      }

      if (file) {
        ev.preventDefault()
        ev.stopPropagation()
        // 视觉反馈:短暂高亮 drop 框
        this.drop.classList.add('over')
        setTimeout(() => this.drop.classList.remove('over'), 300)
        this._finishFile(file)
        return
      }

      // 2) 纯文本:包装成 txt 文件,供下游 FileReader 读取(自动识别 JSON/XML/ASS)
      let text = null
      try {
        if (cd.getData) {
          text = cd.getData('text/plain')
        }
      } catch (e) { /* ignore */ }
      if (text && typeof text === 'string' && text.trim().length > 0) {
        ev.preventDefault()
        ev.stopPropagation()
        this.drop.classList.add('over')
        setTimeout(() => this.drop.classList.remove('over'), 300)
        const fake = this._wrapTextAsFile(text, 'clipboard-paste.txt')
        if (fake) {
          this._finishFile(fake)
        }
      }
    }

    _unbindPaste() {
      if (this._pasteHandler) {
        document.removeEventListener('paste', this._pasteHandler, true)
        this._pasteHandler = null
      }
    }

    close() {
      this._unbindPaste()
      this.root.hidden = true
      if (this._input) {
        this._input.remove()
        this._input = null
      }
      this._onFile = null
      this._onSave = null
    }

    /** 由 Controls 的导出流程调用:保存位置按钮点击。 */
    fireSave() {
      const cb = this._onSave
      this.close()
      if (cb) cb()
    }
  }

  global.FileDialog = FileDialog
})(window)
