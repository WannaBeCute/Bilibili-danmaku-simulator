/**
 * undo.js:UndoManager 撤回/恢复。
 *
 * 通过 store.onBeforeMutate 在每次变更前记录快照;400ms 内的连续变更合并为一步
 * (打字/拖拽手柄都算一步)。历史上限 100。
 *
 * 恢复用 store.setComments 触发 engine 清场重放,并还原选中态与 videoInfo。
 */
(function (global) {
  'use strict'

  const MAX_HISTORY = 100
  const MERGE_MS = 400

  class UndoManager {
    constructor(store) {
      this.store = store
      this.history = [] // 变更前的快照(可撤回)
      this.future = [] // 被撤回的快照(可恢复)
      this._pending = false
      this._timer = null
      this._suppress = false
      this.onStateChange = null

      store.onBeforeMutate(() => {
        if (this._suppress) return
        if (!this._pending) {
          this.history.push(this._snapshot())
          if (this.history.length > MAX_HISTORY) this.history.shift()
          this.future.length = 0
          this._pending = true
        }
        clearTimeout(this._timer)
        this._timer = setTimeout(() => {
          this._pending = false
          this._notify()
        }, MERGE_MS)
      })
    }

    _snapshot() {
      return {
        comments: JSON.parse(JSON.stringify(this.store.comments)),
        selectedId: this.store.selectedId,
        videoInfo: this.store.videoInfo ? JSON.parse(JSON.stringify(this.store.videoInfo)) : null,
      }
    }

    _restore(snap) {
      this._suppress = true
      try {
        this.store.setComments(snap.comments)
        this.store.selectedId = snap.selectedId
        this.store.videoInfo = snap.videoInfo
        this.store._emit('select', snap.selectedId, null)
      } finally {
        this._suppress = false
      }
      this._notify()
    }

    canUndo() {
      return this.history.length > 0
    }

    canRedo() {
      return this.future.length > 0
    }

    undo() {
      if (!this.canUndo()) return false
      const prev = this._snapshot()
      this.future.push(prev)
      this._restore(this.history.pop())
      // ★ 撤回自动保存:舞台修改未点「保存/更改」就被回退,撤回恢复后直接提交当前弹幕
      this._autoCommitRestored(prev)
      return true
    }

    redo() {
      if (!this.canRedo()) return false
      const prev = this._snapshot()
      this.history.push(prev)
      this._restore(this.future.pop())
      // ★ 恢复(重做)同样自动保存:误按撤回后恢复,被恢复的修改无需再手动保存
      this._autoCommitRestored(prev)
      return true
    }

    /** ★ 撤回/恢复后自动保存:若当前选中弹幕在恢复前后发生了变化,
     *  视为「被回退又被撤回找回的未保存修改」,直接 commitEdit(等价于点了「更改」),
     *  用户不需要再点击「保存」或「更改」按钮。 */
    _autoCommitRestored(prevSnap) {
      try {
        const id = this.store.selectedId
        if (id == null) return
        const rec = this.store.get(id)
        if (!rec || rec === this.store.draft) return
        if (typeof this.store.commitEdit !== 'function') return
        const before = prevSnap && prevSnap.comments
          ? prevSnap.comments.find((c) => c.id === id) : null
        if (!before) return
        // 恢复前后内容一致:没有「找回修改」,不需要自动保存
        if (JSON.stringify(before) === JSON.stringify(rec)) return
        this.store.commitEdit(id)
        const t = document.getElementById('toast')
        if (t) {
          t.textContent = '已撤回并自动保存当前弹幕的修改'
          t.classList.remove('error')
          t.classList.add('show')
          clearTimeout(this._acToastTimer)
          this._acToastTimer = setTimeout(() => t.classList.remove('show'), 1800)
        }
      } catch (_) {}
    }

    _notify() {
      if (this.onStateChange) this.onStateChange()
    }

    clear() {
      this.history.length = 0
      this.future.length = 0
      this._pending = false
      this._notify()
    }
  }

  global.UndoManager = UndoManager
})(window)
