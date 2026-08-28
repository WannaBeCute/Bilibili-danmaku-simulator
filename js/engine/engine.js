/**
 * engine.js:DanmakuEngine 调度主控。
 *
 *  - 单条 rAF 主循环:虚拟时钟 tick -> 发射(光标游走)-> 轨道分配发射 -> 驱动普通/高级弹幕
 *  - seek:清场 -> 光标回退 -> 进度重放(普通弹幕带进度、高级弹幕按 elapsed 就位)
 *  - 编辑:监听 store 事件,普通弹幕即时刷新节点,高级弹幕每帧读 record 自然生效;
 *         结构性变更(mode/type/timeSec)销毁重建。
 */
(function (global) {
  'use strict'

  const Track = global.Track
  const DanmakuStack = global.DanmakuStack
  const NormalRenderer = global.NormalRenderer
  const AdvancedRenderer = global.AdvancedRenderer

  function lowerBound(arr, v) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].timeSec < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  class DanmakuEngine {
    constructor(stage, store, clock, options) {
      this.stage = stage
      // ★ Bug3 第二道防线:启动时强制清空 #stage 下的全部弹幕节点。
      //   浏览器预览场景下,上一个 session 产生的弹幕节点会被当作 HTML 写回 DOM,
      //   启动时 stage 内存在非模板的残留弹幕会导致「僵尸弹幕/硬编码弹幕」。
      try {
        while (stage && stage.firstChild) stage.removeChild(stage.firstChild)
      } catch (_) {}
      this.store = store
      this.clock = clock
      this.options = Object.assign(
        {
          trackHeight: 30,
          gap: 8,
          durationSec: 5, // 普通弹幕穿越/停留时长(媒体秒)
          maxOnScreen: 200,
          distribution: 'strict', // 'strict' | 'adaptive'
        },
        options || {}
      )
      this.trackHeight = this.options.trackHeight
      this.gap = this.options.gap
      this.editable = false
      this.batchActive = false // 批量选择激活时(勾选了批量复选框)也允许节点接收鼠标事件
      this.globalStyle = { opacity: 1, fontScale: 1, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans SC", sans-serif', strokeWidth: 1 }

      // 弹幕播放设置
      this.typeFilters = { scroll: true, fixed: true, colorful: true, advanced: true }
      this.blockedWords = []
      this.areaHeight = 100 // 弹幕显示区域(纵向占用百分比)
      this.usableHeight = 0
      this.density = 'normal' // normal | more | overlap
      this.allowOverlap = false
      this.danmakuSpeed = 1 // 普通弹幕速度倍率(高级不受影响)
      this.scaleWithScreen = false // 弹幕随屏幕缩放
      // ★ 「显示缩放」:只影响弹幕坐标与大小(1px 对应的实际渲染大小),不改动舞台与 UI
      //   舞台 width/height 保持不变;在应用字号/描边/像素坐标时乘以该系数。
      //   推荐值 1=100%;与设置面板的滑块(50~200%)对应。
      this.displayScale = 1
      this._baseTrackHeight = this.options.trackHeight // 基准轨道高(用户设置);显示缩放时按比例计算 this.trackHeight
      // ★ 对使用百分比坐标的弹幕「仅坐标缩放」(默认开启):
      //   true(默认,仅坐标缩放) → 百分比高级弹幕的字号/描边等样式保持原始像素值,仅坐标按 W/H 百分比换算(B站行为)
      //   false(关闭) → 百分比高级弹幕的字号/描边等样式也应用 globalStyle.fontScale,与屏幕同比例放大(当前既有行为)
      this.percentCoordOnlyScale = true
      this._userFontScale = 1
      this.blockDupes = false // 屏蔽重复弹幕(仅普通弹幕)
      this._seenContent = new Set()
      this.subtitleAvoid = false // 防挡字幕:屏幕下方25%不出现普通弹幕
      this.showOnlyIds = null // ★ 仅展示这些 id 的弹幕(null=展示全部,Set=仅展示集合内)
      this._pinnedSourceIds = new Set() // ★ 固定展示弹幕的源 id 集合(不拷贝,直接标记原记录)

      this.width = 0
      this.height = 0
      this.rows = 0
      this.tracks = []
      this.stack = new DanmakuStack(0)

      this.normal = new NormalRenderer(this)
      this.advanced = new AdvancedRenderer(this)

      this.comments = []
      this.cursor = 0
      this.emitted = new Set() // 已发射(在屏/在 stash)的 record id,防重复发射
      this.replayWindow = this.options.durationSec
      this._advDirty = false // 暂停时仅在有高级弹幕编辑时才刷新渲染

      this._running = false
      this._raf = 0
      this._lastTs = 0
      this._resizeTimer = 0

      this._ro = new ResizeObserver(() => this.scheduleLayout())
      this._ro.observe(stage)
      this.layout()

      this._unsub = store.onChange((evt, id, field) => this.onStoreEvent(evt, id, field))
    }

    /* ---------- 布局 ---------- */

    scheduleLayout() {
      clearTimeout(this._resizeTimer)
      this._resizeTimer = setTimeout(() => this.layout(), 60)
    }

    layout() {
      const w = this.stage.clientWidth
      const h = this.stage.clientHeight
      if (!w || !h) return
      const wasReady = !!(this.width && this.height)
      this.width = w
      this.height = h
      // ★ 轨道高度(行高) = 基准高度 × 显示缩放;显示缩放只影响弹幕本身,不改变 usableHeight
      this.trackHeight = Math.max(4, Math.round(this._baseTrackHeight * this.displayScale))
      this.gap = Math.max(2, Math.round(this.options.gap * this.displayScale))
      // 防挡字幕:屏幕下方 25% 不出现普通弹幕(仅影响轨道/底部弹幕,高级不受影响)
      this.usableHeight = (h * (this.subtitleAvoid ? 75 : this.areaHeight)) / 100
      if (this.scaleWithScreen && w) {
        this._applyFontScale()
      }
      const rows = Math.max(1, Math.floor(this.usableHeight / this.trackHeight))
      if (rows !== this.rows) {
        this.rows = rows
        // 仅重建轨道,不清场重放(避免全屏/缩放时弹幕重新加载)
        this.rebuildTracks()
      }
      // ★ 首次获得尺寸时重新发射:之前因 stage 无尺寸被 emitOne 拦截的弹幕现在可以发射了
      if (!wasReady) {
        this.emitUpTo(this.clock.now())
        this.normal.emitStash()
      }
      // ★ 关闭「仅坐标缩放」时,百分比弹幕字号随舞台宽度变化,需强制刷新
      if (!this.percentCoordOnlyScale && this.advanced && Array.isArray(this.advanced.active)) {
        this.advanced.active.forEach((dm) => { if (dm) { dm._sig = ''; dm.applyTextStyle() } })
      }
    }

    rebuildTracks() {
      this.tracks = []
      for (let i = 0; i < this.rows; i++) {
        this.tracks.push(new Track(i, i * this.trackHeight, this))
      }
      this.stack.setTrackCount(this.rows)
    }

    /* ---------- 数据同步 ---------- */

    syncComments() {
      this.comments = this.store.sorted()
      this.replayWindow = this.options.durationSec
      for (const rec of this.comments) {
        if (rec.type === 'advanced' && rec.life.duration > this.replayWindow) {
          this.replayWindow = rec.life.duration
        }
      }
    }

    recomputeCursor() {
      this.cursor = lowerBound(this.comments, Math.max(0, this.clock.now() - this.replayWindow))
    }

    /* ---------- 发射 ---------- */

    emitOne(rec) {
      if (this.emitted.has(rec.id)) return true
      if (!this._isVisible(rec)) return true
      if (!this.width || !this.height) return false
      // ★ 普通弹幕:超出自身生存时长的直接跳过(标记已发射,不再上屏)。
      //   replayWindow 会随高级弹幕的生存时长扩大(可能远大于普通弹幕时长),
      //   seek/重放时若不过滤,会把窗口内早已结束的普通弹幕全部重新入列;
      //   滚动弹幕在 emitStash 中还会因"等待过久"重置 startMediaTime 满血复活,
      //   导致其他时间的弹幕在错误的跳转时间点集体出现在舞台上。
      //   固定展示弹幕(pinned)例外:它们的意义就是常驻展示,允许超龄重发。
      if (rec.type !== 'advanced' && !this._pinnedSourceIds.has(rec.id)) {
        const lifeSec = this.options.durationSec / this.danmakuSpeed
        if (this.clock.now() - rec.timeSec >= lifeSec) {
          this.emitted.add(rec.id)
          return true
        }
      }
      // 屏蔽重复弹幕(仅普通弹幕):相同内容只保留第一个
      if (this.blockDupes && rec.type === 'normal' && rec.content) {
        if (this._seenContent.has(rec.content)) return true
        this._seenContent.add(rec.content)
      }
      this.emitted.add(rec.id)
      if (rec.type === 'advanced') {
        // ★ 清除可能的 _editSpawned 实例(选中时主动 spawn 的),避免发送后重复
        this.advanced.removeById(rec.id)
        this.advanced.spawn(rec)
      } else if (rec.mode === 'scroll') {
        // ★ 传 rec.timeSec 作为 startMediaTime:seek 重放时 startScroll 中的快进逻辑
        //   能据此计算 elapsedSec = now - timeSec → progress,正确销毁已过期弹幕
        //   正常播放时 timeSec ≈ now,elapsedSec ≈ 0,等效于从头开始
        this.normal.enqueue(rec, rec.timeSec)
      } else {
        this.normal.enqueue(rec, rec.timeSec)
      }
      return true
    }

    /** 弹幕是否通过类型过滤与屏蔽词。*/
    _isVisible(rec) {
      // ★ 固定展示弹幕(源 id 集合中的记录):强制通过所有筛选
      if (rec && this._pinnedSourceIds.has(rec.id)) return true
      // ★ showOnlyIds:仅展示指定 id 集合内的弹幕(「展示当前弹幕」用,不破坏弹幕池)
      if (this.showOnlyIds && !this.showOnlyIds.has(rec.id)) return false
      if (this.blockedWords.length && rec.content) {
        const lower = rec.content.toLowerCase()
        for (const w of this.blockedWords) {
          if (w && lower.indexOf(w.toLowerCase()) !== -1) return false
        }
      }
      const f = this.typeFilters
      if (rec.type === 'advanced') return f.advanced
      const isScroll = rec.mode === 'scroll'
      const isFixed = rec.mode === 'top' || rec.mode === 'bottom'
      const isColorful = !!rec.colorful
      return (isScroll && f.scroll) || (isFixed && f.fixed) || (isColorful && f.colorful)
    }

    emitUpTo(now) {
      while (this.cursor < this.comments.length) {
        const rec = this.comments[this.cursor]
        if (rec.timeSec > now) break
        // ★ emitOne 返回 false 表示 stage 无尺寸暂未发射,不推进 cursor,等待 layout 后重试
        if (!this.emitOne(rec)) break
        this.cursor++
      }
      // ★ 固定展示弹幕:独立发射(可能在 cursor 之前但未被发射,需补发)
      if (this._pinnedSourceIds.size) this._emitPinnedUpTo(now)
    }

    isAtMax() {
      return this.normal.count + this.advanced.count >= this.options.maxOnScreen
    }

    /* ---------- 播放控制 ---------- */

    start() {
      if (this._running) return
      this._running = true
      this._lastTs = performance.now()
      this._raf = requestAnimationFrame(this._loop)
    }

    stop() {
      this._running = false
      cancelAnimationFrame(this._raf)
    }

    _loop = (ts) => {
      if (!this._running) return
      const dt = (ts - this._lastTs) / 1000
      this._lastTs = ts
      if (this.clock.playing) {
        this.clock.tick(dt)
        this.emitUpTo(this.clock.now())
        this.normal.emitStash()
      }
      // 暂停时也驱动 update:普通弹幕到点销毁用媒体时间(冻结时无副作用)。
      // 高级弹幕:播放时每帧驱动;暂停时仅在编辑(脏标记)时刷一帧,避免 60fps 写样式。
      this.normal.update()
      // 始终驱动高级弹幕(数量少;并支持"立即预览"在暂停时仍移动)
      this.advanced.update()
      this._raf = requestAnimationFrame(this._loop)
    }

    play() {
      if (this.clock.playing) return
      this.clock.play()
      this.normal.resumeAll()
    }

    pause() {
      if (!this.clock.playing) return
      this.clock.pause()
      this.normal.pauseAll()
    }

    /** 用户主动跳转:设置时间源(video 模式会设 video.currentTime)再重放。 */
    seek(t) {
      this.clock.seek(t)
      this.replay()
    }

    /**
     * 仅按当前时间重放,不设置时间源。供 video 的 seeking 事件调用,
     * 避免在 seeking 里再设 currentTime 造成无限 seek 循环(拖动进度条卡死)。
     */
    replay() {
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    clearScreen() {
      this.normal.clear()
      this.advanced.clear()
      this.stack.clear()
      this._seenContent.clear()
    }

    clearAll() {
      this.clearScreen()
      this.emitted.clear()
      this.cursor = 0
    }

    /* ---------- 预览时隐藏/复原舞台原有弹幕 ---------- */

    /**
     * 高级弹幕预览时:隐藏所有非预览的正式弹幕(普通+高级)。
     * 保持节点仍在 DOM 中但 visibility:hidden,不影响布局与状态,便于后续复原。
     */
    hideNonPreviews() {
      if (this._nonPreviewHidden) return
      this._nonPreviewHidden = true
      for (const dm of this.normal.active) {
        if (dm.node && !dm.record._preview && dm.node.style.visibility !== 'hidden') {
          dm._visibilityBackup = dm.node.style.visibility
          dm.node.style.visibility = 'hidden'
        }
      }
      for (const dm of this.advanced.active) {
        if (dm.node && !dm.record._preview && dm.node.style.visibility !== 'hidden') {
          dm._visibilityBackup = dm.node.style.visibility
          dm.node.style.visibility = 'hidden'
        }
      }
    }

    /**
     * 复原被 hideNonPreviews() 隐藏的正式弹幕。
     * 当舞台上不存在任何 _preview 弹幕时自动调用,或手动清除预览时调用。
     */
    showNonPreviews() {
      if (!this._nonPreviewHidden) return
      this._nonPreviewHidden = false
      for (const dm of this.normal.active) {
        if (dm.node && dm._visibilityBackup !== undefined) {
          dm.node.style.visibility = dm._visibilityBackup
          dm._visibilityBackup = undefined
        } else if (dm.node && dm._visibilityBackup === undefined) {
          // 兜底:没备份也恢复可见(例如seek过程中新spawn的节点不会被主动隐藏,但保险起见)
          if (dm.node.style.visibility === 'hidden' && !dm.record._preview) {
            dm.node.style.visibility = ''
          }
        }
      }
      for (const dm of this.advanced.active) {
        if (dm.node && dm._visibilityBackup !== undefined) {
          dm.node.style.visibility = dm._visibilityBackup
          dm._visibilityBackup = undefined
        } else if (dm.node && dm._visibilityBackup === undefined) {
          if (dm.node.style.visibility === 'hidden' && !dm.record._preview) {
            dm.node.style.visibility = ''
          }
        }
      }
    }

    /** 当前舞台上是否还存在 _preview 标记的虚拟弹幕。 */
    hasPreviewActive() {
      for (const dm of this.advanced.active) {
        if (dm.record && dm.record._preview) return true
      }
      return false
    }

    /* ---------- 全局样式 ---------- */

    getGlobalStyle() {
      return this.globalStyle
    }

    setGlobalStyle(patch) {
      if (patch && patch.fontScale != null) {
        this._userFontScale = patch.fontScale
        this._applyFontScale()
      } else {
        Object.assign(this.globalStyle, patch)
      }
      this._applyGlobalToNormal()
    }

    _applyFontScale() {
      if (this.scaleWithScreen && this.width) {
        this.globalStyle.fontScale = this._userFontScale * (this.width / 1280)
      } else {
        this.globalStyle.fontScale = this._userFontScale
      }
    }

    _applyGlobalToNormal() {
      // 批量激活时也允许节点接收鼠标事件,与 setBatchActive 保持一致。
      const pe = (this.editable || this.batchActive) ? 'auto' : 'none'
      for (const dm of this.normal.active) {
        if (dm.node) {
          dm.node.style.pointerEvents = pe
          dm.applyRecordStyle()
        }
      }
    }

    /* ---------- 弹幕播放设置 ---------- */

    setTypeFilters(filters) {
      Object.assign(this.typeFilters, filters)
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    setBlockedWords(list) {
      this.blockedWords = (list || []).map((w) => String(w).trim()).filter(Boolean)
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    /** ★ 设置「仅展示这些 id」筛选(null=展示全部,Set=仅展示集合内)。不破坏弹幕池数据。*/
    setShowOnlyIds(ids) {
      this.showOnlyIds = ids && ids.size ? new Set(ids) : null
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    /** ★ 固定展示弹幕源 id 集合推送:来自 DanmakuList。
     *   不拷贝弹幕,仅标记源 id;引擎中这些记录强制通过筛选,优先展示。
     *   移出时,若该记录因 showOnlyIds 被屏蔽,则从屏幕移除。*/
    setPinnedSourceIds(ids) {
      const next = new Set(Array.isArray(ids) ? ids : [])
      // 移出固定展示的记录:若当前被 showOnlyIds 屏蔽,需从屏幕移除
      for (const oldId of this._pinnedSourceIds) {
        if (!next.has(oldId)) {
          if (this.showOnlyIds && !this.showOnlyIds.has(oldId)) {
            this.advanced.removeById(oldId)
            this.normal.removeById(oldId)
            this.emitted.delete(oldId)
          }
        }
      }
      this._pinnedSourceIds = next
      // 立刻补发:新加入固定的记录可能在 cursor 之前,需补发
      this._emitPinnedUpTo(this.clock.now())
    }

    /** ★ 发射固定展示弹幕:遍历 comments 中标记为 pinned 的记录,补发 cursor 之前遗漏的。*/
    _emitPinnedUpTo(now) {
      for (const rec of this.comments) {
        if (!this._pinnedSourceIds.has(rec.id)) continue
        const t = Number.isFinite(rec.timeSec) ? rec.timeSec : 0
        if (t > now) continue
        if (this.emitted.has(rec.id)) continue
        this.emitOne(rec)
      }
    }

    setAreaHeight(pct) {
      this.areaHeight = Math.max(10, Math.min(100, pct))
      this.layout()
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    setDensity(mode) {
      this.density = mode === 'overlap' || mode === 'more' ? mode : 'normal'
      if (this.density === 'more') {
        // ★ 改 _baseTrackHeight 而非直接写 trackHeight,确保 displayScale 缩放仍生效
        this._baseTrackHeight = 20
        this.allowOverlap = false
      } else if (this.density === 'overlap') {
        this._baseTrackHeight = 30
        this.allowOverlap = true
      } else {
        this._baseTrackHeight = this.options.trackHeight
        this.allowOverlap = false
      }
      this.layout()
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    setDanmakuSpeed(v) {
      this.danmakuSpeed = v > 0 ? v : 1
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    setScaleWithScreen(on) {
      this.scaleWithScreen = !!on
      this._applyFontScale()
      this._applyGlobalToNormal()
    }

    /** ★ 设置「显示缩放」系数(仅弹幕坐标与尺寸,不改动舞台/UI)。
     *   1 = 100%(推荐),范围 0.5~2.0。
     *   改动会立即刷新:轨道高度/间隙、在屏普通弹幕样式、在屏高级弹幕样式,并重播当前时间窗口。*/
    setDisplayScale(v) {
      const next = Math.max(0.5, Math.min(2, Number.isFinite(v) ? v : 1))
      if (next === this.displayScale) return
      this.displayScale = next
      // 轨道与间隙重新计算(displayScale 已改)并强制重建轨道 + 重绘在屏弹幕
      this.layout()
      // 强制在屏普通弹幕重算字号/描边(清空缓存 sig,走 applyRecordStyle)
      if (this.normal && Array.isArray(this.normal.active)) {
        for (const dm of this.normal.active) {
          if (!dm) continue
          dm._w = 0
          dm._h = 0
          if (dm.applyRecordStyle) dm.applyRecordStyle()
        }
      }
      // 强制在屏高级弹幕重算字号/描边/坐标(清空缓存 sig,重刷样式与 update)
      if (this.advanced && Array.isArray(this.advanced.active)) {
        for (const dm of this.advanced.active) {
          if (!dm) continue
          dm._sig = ''
          if (dm.applyTextStyle) dm.applyTextStyle()
          if (dm.update) dm.update()
        }
      }
      // 结构性刷新:按新轨道布局 + 新字号宽度重播当前时间窗口,避免碰撞/重叠错乱
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      if (this.normal && typeof this.normal.emitStash === 'function') this.normal.emitStash()
    }

    /** 屏蔽重复弹幕(仅普通弹幕):相同内容只保留最先出现的那个。 */
    setBlockDupes(on) {
      this.blockDupes = !!on
      this._seenContent.clear()
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    /** 防挡字幕:屏幕下方 25% 不出现普通弹幕(底部弹幕 + 下方滚动轨道)。 */
    setSubtitleAvoid(on) {
      this.subtitleAvoid = !!on
      this.layout()
      this.clearScreen()
      this.emitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    setEditable(on) {
      this.editable = on
      this._refreshPointerEvents()
    }

    /**
     * 批量选择激活状态切换:与 editable 一样会让弹幕节点与 stage 接收鼠标事件。
     * 用于「非编辑模式但勾选了批量复选框」时,右键舞台弹幕仍然能弹出 ctxMenu。
     */
    setBatchActive(on) {
      this.batchActive = !!on
      this._refreshPointerEvents()
    }

    /**
     * 根据 editable + batchActive 综合状态,刷新所有当前活跃弹幕节点的 pointer-events。
     * 规则:只要进入编辑模式 或 批量选择激活(勾选了批量复选框),节点就接收鼠标事件,
     * 才能让 elementFromPoint 命中 [data-dm-id],contextmenu/click 才能进入 handler。
     */
    _refreshPointerEvents() {
      const pe = (this.editable || this.batchActive) ? 'auto' : 'none'
      for (const dm of this.normal.active) {
        if (dm.node) dm.node.style.pointerEvents = pe
      }
      for (const dm of this.advanced.active) {
        if (dm.node) dm.node.style.pointerEvents = pe
      }
    }

    /** 切换倍速:时钟 + 重算在播滚动弹幕的剩余过渡时长。 */
    setRate(r) {
      this.clock.setRate(r)
      this.normal.pauseAll()
      this.normal.resumeAll()
    }

    /* ---------- 编辑联动 ---------- */

    onStoreEvent(evt, id, field) {
      switch (evt) {
        case 'replace':
        case 'clear':
          // ★ 弹幕池被替换/清空时,旧的 showOnlyIds / pinnedSourceIds 已失效,重置
          this.showOnlyIds = null
          this._pinnedSourceIds.clear()
          this.clearAll()
          this.syncComments()
          // ★ 同 'add':重置 cursor 为 0 而非 recomputeCursor()。
          //   loadStartDanmaku 是异步的,若回调在用户播放后(now>0)才执行,
          //   recomputeCursor 会把 cursor 设到 max(0, now-replayWindow),
          //   导致 timeSec < (now-replayWindow) 的弹幕被跳过(如 timeSec=0)。
          //   emitted 集合已清空(clearAll),从 0 扫描会发射所有 timeSec<=now 的弹幕。
          this.cursor = 0
          this.emitUpTo(this.clock.now())
          this.normal.emitStash()
          break
        case 'add':
          this.syncComments()
          // ★ 重置 cursor 为 0 而非 recomputeCursor():新弹幕的 timeSec 可能小于
          //   (now - replayWindow),recomputeCursor 会把 cursor 设到新弹幕之后,
          //   导致 emitUpTo 跳过它(出现时间<1s 的弹幕在 now 较大时不显示)。
          //   emitted 集合会阻止已发射弹幕重复发射,所以从 0 扫描是安全的。
          this.cursor = 0
          this.emitUpTo(this.clock.now())
          this.normal.emitStash()
          break
        case 'remove':
          this.emitted.delete(id)
          this._pinnedSourceIds.delete(id)
          this.normal.removeById(id)
          this.advanced.removeById(id)
          this.syncComments()
          this.recomputeCursor()
          break
        case 'change':
          this.handleChange(id, field)
          break
        case 'select':
          // ★ 选中高级弹幕时,确保它在舞台上有一个实例(草稿/未到时间的也能显示)
          this._ensureAdvancedSpawned(id)
          break
      }
    }

    handleChange(id, field) {
      const rec = this.store.get(id)
      if (!rec) return
      const structural =
        field === null ||
        field === 'timeSec' ||
        field === 'mode' ||
        field === 'type'
      if (structural) {
        this.emitted.delete(id)
        this.normal.removeById(id)
        this.advanced.removeById(id)
        this.syncComments()
        // ★ 同 'add':重置 cursor 为 0,避免编辑后 timeSec < (now - replayWindow)
        //   时 cursor 越过该弹幕导致不发射
        this.cursor = 0
        this.emitUpTo(this.clock.now())
        this.normal.emitStash()
        // ★ 结构性变更(timeSec/mode/type)后,若弹幕仍被选中但未被 emit(未到时间),
        //   重新 spawn _editSpawned 实例,保证编辑时舞台始终可见
        if (rec.type === 'advanced' && this.store.selectedId === id) {
          const exists = this.advanced.active.find((d) => d.id === id)
          if (!exists) this.advanced.spawn(rec, { editSpawned: true })
        }
      } else if (rec.type === 'normal') {
        this.normal.refreshNode(rec)
      } else {
        this.advanced.refresh(id)
      }
    }

    /**
     * ★ 选中高级弹幕时,确保它在舞台上有一个实例。
     *   草稿弹幕(未入池)和未到出现时间的弹幕,正常情况下不会被 emit,
     *   但编辑时需要看到实时效果,所以选中时主动 spawn(打 _editSpawned 标记)。
     *   ★ 扩展:深度批量候选中的所有高级弹幕也一并 spawn(即便没有开启编辑模式),
     *     保证"只要列表里有深度批量勾选项,舞台任意时间点都可见这些弹幕 + 外框"。
     *   失去选中后,若不在正常时间范围内,由 update() 自动销毁(但仍在深度批量候选中的 id 不销毁,见 advanced.js _editSpawned 判定)。
     */
    _ensureAdvancedSpawned(id) {
      const idsToKeep = new Set()
      if (id) idsToKeep.add(id)
      // 收集深度批量候选里的所有高级 id
      try {
        const list = global.window.App && global.window.App.list
        if (list && typeof list._isDeepCandidate === 'function' && list._isDeepCandidate()) {
          for (const bid of (list._batchIds || [])) idsToKeep.add(bid)
        }
      } catch (_) {}
      // 1. 对 idsToKeep 里所有高级 rec 进行 spawn(若无实例)
      //    ★ 需求9:草稿也需要 spawn 到舞台上实时显示(静止,不运动),标记 draftSpawned
      for (const kid of idsToKeep) {
        const rec = this.store.get(kid)
        if (!rec || rec.type !== 'advanced') continue
        const isDraft = rec === this.store.draft
        const exists = this.advanced.active.find((d) => d.id === kid)
        if (exists) continue
        // ★ 修复"舞台上出现两个差不多的框":选中/新增前先清掉同 id 的预览实例,
        //   否则 预览实例 + 编辑实例 同时在舞台,两个节点重叠显示
        this.advanced.removePreviewById(kid)
        this.advanced.spawn(rec, { editSpawned: true, draftSpawned: isDraft })
      }
      // 2. 清理失去选中且不在深度批量候选中的编辑预览弹幕(传 keepId=null 会清全部非 keep,但这里我们构造一个 keep 集合)
      this.advanced.cleanupEditSpawned(idsToKeep)
    }

    /** 外部删除一条弹幕。 */
    removeDanmaku(id) {
      this.store.remove(id) // 触发 remove 事件
    }

    destroy() {
      this.stop()
      this._ro.disconnect()
      if (this._unsub) this._unsub()
      this.clearAll()
    }
  }

  global.DanmakuEngine = DanmakuEngine
})(window)
