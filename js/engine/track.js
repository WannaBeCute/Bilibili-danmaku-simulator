/**
 * track.js:轨道(Track)与碰撞避让算法,移植自 danmu-lib engine.ts:_getTrack。
 *
 * 布局:舞台高度按 trackHeight 切分成 rows 条水平轨道。滚动弹幕独占一条轨道,
 * 新弹幕随机挑轨道,检查该轨道最后一条弹幕是否已走远
 * (last.getMoveDistance() >= gap + last.width) 才可复用,否则换随机轨道(不重复)。
 * 全部占满 => 返回 null(本帧放弃,弹幕留在 stash 等待)。
 *
 * 顶/底固定弹幕不占轨道,用 DanmakuStack 槽位栈(顶部从 0 起、底部从 -1 起)。
 */
(function (global) {
  'use strict'

  /** 单个水平轨道。layout 需提供 { trackHeight }。 */
  class Track {
    constructor(index, top, layout) {
      this.index = index
      this.top = top
      this.list = [] // 本轨道上所有 FacileDanmaku(滚动弹幕)
      this._layout = layout
    }

    get middle() {
      return this.top + this._layout.trackHeight / 2
    }

    /** 从尾往前找第一条“仍在移动、非暂停、未循环”的滚动弹幕。 */
    last() {
      for (let i = this.list.length - 1; i >= 0; i--) {
        const dm = this.list[i]
        if (dm && !dm.paused && !dm.ended) return dm
      }
      return null
    }

    _add(dm) {
      this.list.push(dm)
    }

    _remove(dm) {
      const i = this.list.indexOf(dm)
      if (i >= 0) this.list.splice(i, 1)
    }

    clear() {
      this.list.length = 0
    }
  }

  /** 顶/底固定弹幕槽位栈(移植 fixedDanmaku.ts DanmakuStack)。 */
  class DanmakuStack {
    constructor(trackCount) {
      this.topStack = []
      this.bottomStack = []
      this.topLen = 0
      this.bottomLen = 0
      this.setTrackCount(trackCount || 1)
    }

    setTrackCount(n) {
      n = Math.max(1, n || 1)
      this._trackCount = n
      while (this.topStack.length < n) this.topStack.push(0)
      while (this.bottomStack.length < n) this.bottomStack.push(0)
    }

    getTrackCount() {
      return this._trackCount
    }

    _getSlot(stack, len) {
      const empty = stack.findIndex((v) => v === 0)
      if (empty !== -1) return empty % this._trackCount
      return len % this._trackCount
    }

    /** placement: 'top' 返回 0..n-1;'bottom' 返回 -1..-n。 */
    push(placement) {
      if (placement === 'top') {
        const slot = this._getSlot(this.topStack, this.topLen)
        this.topLen++
        this.topStack[slot]++
        return slot
      }
      const slot = this._getSlot(this.bottomStack, this.bottomLen)
      this.bottomLen++
      this.bottomStack[slot]++
      return ~slot
    }

    remove(track, placement) {
      const slot = placement === 'top' ? track : ~track
      if (slot < 0 || slot >= this._trackCount) return
      if (placement === 'top') {
        this.topStack[slot] = Math.max(this.topStack[slot] - 1, 0)
        this.topLen = Math.max(this.topLen - 1, 0)
      } else {
        this.bottomStack[slot] = Math.max(this.bottomStack[slot] - 1, 0)
        this.bottomLen = Math.max(this.bottomLen - 1, 0)
      }
    }

    isFull(placement) {
      return placement === 'top'
        ? this.topLen >= this._trackCount
        : this.bottomLen >= this._trackCount
    }

    clear() {
      this.topStack.fill(0)
      this.bottomStack.fill(0)
      this.topLen = 0
      this.bottomLen = 0
    }
  }

  global.Track = Track
  global.DanmakuStack = DanmakuStack
})(window)
