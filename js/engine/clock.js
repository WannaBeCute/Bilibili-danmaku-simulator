/**
 * Clock:统一时间源。
 *   mode='video'   -> now() = video.currentTime(媒体时间,随播放推进、暂停冻结、seek 跳变)
 *   mode='virtual' -> now() = virtualTime(由 tick(dt) 驱动,受 rate 缩放)
 *
 * 所有弹幕动画进度都以 clock.now()(媒体秒)为基准:
 *   - 暂停时 now() 冻结 => 动画自然停
 *   - seek 时 now() 跳变 => 动画进度自动重算
 *   - 倍速时 virtual 模式由 rate 缩放,video 模式直接读 currentTime
 */
(function (global) {
  'use strict'

  class Clock {
    constructor() {
      this.mode = 'virtual' // 'virtual' | 'video'
      this.video = null
      this.virtualTime = 0
      this.playing = false
      this.rate = 1
    }

    /** 当前媒体时间(秒),统一保留两位小数,避免浮点精度过高。暂停冻结、seek 跳变、倍速由外部驱动。 */
    now() {
      let t
      if (this.mode === 'video' && this.video) {
        t = this.video.currentTime
      } else {
        t = this.virtualTime
      }
      return Math.round(t * 100) / 100
    }

    setMode(mode) {
      this.mode = mode
    }

    bindVideo(video) {
      this.video = video
      if (video) this.mode = 'video'
    }

    unbindVideo() {
      this.video = null
      this.mode = 'virtual'
    }

    /** 虚拟模式:每帧调用,按倍速推进时钟。 */
    tick(dtSec) {
      if (this.mode !== 'virtual' || !this.playing) return
      this.virtualTime += dtSec * this.rate
      if (this.virtualTime < 0) this.virtualTime = 0
    }

    play() {
      if (this.playing) return
      this.playing = true
      if (this.mode === 'video' && this.video) {
        const p = this.video.play()
        if (p && p.catch) p.catch(() => {})
      }
    }

    pause() {
      if (!this.playing) return
      this.playing = false
      if (this.mode === 'video' && this.video) {
        try {
          this.video.pause()
        } catch (e) {
          /* noop */
        }
      }
    }

    /** 跳转(媒体秒)。video 模式会设置 currentTime 并触发 seeking。 */
    seek(t) {
      t = Math.max(0, isNaN(t) ? 0 : t)
      if (this.mode === 'video' && this.video) {
        try {
          this.video.currentTime = t
        } catch (e) {
          /* noop */
        }
      } else {
        this.virtualTime = t
      }
    }

    setRate(rate) {
      rate = Number(rate)
      if (isNaN(rate) || rate <= 0) rate = 1
      this.rate = rate
      if (this.mode === 'video' && this.video) {
        try {
          this.video.playbackRate = rate
        } catch (e) {
          /* noop */
        }
      }
    }
  }

  global.Clock = Clock
})(window)
