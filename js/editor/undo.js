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
      this.future.push(this._snapshot())
      this._restore(this.history.pop())
      return true
    }

    redo() {
      if (!this.canRedo()) return false
      this.history.push(this._snapshot())
      this._restore(this.future.pop())
      return true
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
