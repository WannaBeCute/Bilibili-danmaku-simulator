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
      // ★ 对使用百分比坐标的弹幕「仅坐标缩放」(默认开启):
      //   true(默认,仅坐标缩放) → 百分比高级弹幕的字号/描边等样式保持原始像素值,仅坐标按 W/H 百分比换算(B站行为)
      //   false(关闭) → 百分比高级弹幕的字号/描边等样式也应用 globalStyle.fontScale,与屏幕同比例放大(当前既有行为)
      this.percentCoordOnlyScale = true
      this._userFontScale = 1
      this.blockDupes = false // 屏蔽重复弹幕(仅普通弹幕)
      this._seenContent = new Set()
      this.subtitleAvoid = false // 防挡字幕:屏幕下方25%不出现普通弹幕
      this.showOnlyIds = null // ★ 仅展示这些 id 的弹幕(null=展示全部,Set=仅展示集合内)
      this._pinnedRecs = []   // ★ 固定展示副本(独立于主 comments,来自 DanmakuList.setPinnedRecs 推送)
      this._pinnedEmitted = new Set() // ★ 固定展示副本已发射 id 集合(和主 emitted 分开)

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
      // ★ 固定展示副本(来自 DanmakuList 的 pinned 小列表):
      //   - 强制通过:showOnlyIds / 屏蔽词 / 类型过滤 / 范围/筛选 UI 都不影响它
      //   - 标记:rec._isPinnedCopy === true
      if (rec && rec._isPinnedCopy) return true
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
      // ★ pinned 副本也要同步到该时间点(独立发射集合)
      if (this._pinnedRecs.length) this._emitPinnedUpTo(now)
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
      this._pinnedEmitted.clear()
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
      this._pinnedEmitted.clear()
      this.recomputeCursor()
      this.emitUpTo(this.clock.now())
      this.normal.emitStash()
    }

    /** ★ 固定展示副本推送:来自 DanmakuList,新增/移除时同步到引擎。
     *   - pinned 副本独立于主 comments,不影响主列表存储;
     *   - 强制优先展示(优先于主 comment 发射);
     *   - 不经过范围/筛选/showOnlyIds。*/
    setPinnedRecs(recs) {
      const arr = Array.isArray(recs) ? recs.slice() : []
      const now = this.clock.now()
      // 把不再存在的 pinned 副本从屏幕上移除:
      const nextIds = new Set(arr.map((r) => r.id))
      for (const old of this._pinnedRecs) {
        if (!nextIds.has(old.id)) {
          // 移除屏幕上该副本节点
          this.advanced.removeById(old.id)
          this.normal.removeById(old.id)
          this._pinnedEmitted.delete(old.id)
        }
      }
      this._pinnedRecs = arr.sort((a, b) => {
        const at = Number.isFinite(a.timeSec) ? a.timeSec : 0
        const bt = Number.isFinite(b.timeSec) ? b.timeSec : 0
        return at - bt
      })
      // 立刻发射到当前时间(pinned 时间到了就显示)
      this._emitPinnedUpTo(now)
    }

    /** ★ 发射 pinned 副本到指定时间(时间 <= now 且 _pinnedEmitted 未发射的)。*/
    _emitPinnedUpTo(now) {
      for (const rec of this._pinnedRecs) {
        const t = Number.isFinite(rec.timeSec) ? rec.timeSec : 0
        if (t > now) continue
        if (this._pinnedEmitted.has(rec.id)) continue
        // 提前设置 layer 标志(用于高级渲染 priority)
        rec._pinnedLayer = true
        if (this.emitOne(rec)) this._pinnedEmitted.add(rec.id)
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
        this.trackHeight = 20
        this.allowOverlap = false
      } else if (this.density === 'overlap') {
        this.trackHeight = 30
        this.allowOverlap = true
      } else {
        this.trackHeight = this.options.trackHeight
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
          // ★ 弹幕池被替换/清空时,旧的 showOnlyIds 已失效,重置为展示全部
          this.showOnlyIds = null
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
     *   失去选中后,若不在正常时间范围内,由 update() 自动销毁。
     */
    _ensureAdvancedSpawned(id) {
      if (!id) {
        // 取消选中:清理失去选中的编辑预览弹幕
        this.advanced.cleanupEditSpawned(null)
        return
      }
      const rec = this.store.get(id)
      if (!rec || rec.type !== 'advanced') {
        // 切换到普通弹幕或草稿不存在:清理失去选中的编辑预览弹幕
        this.advanced.cleanupEditSpawned(id)
        return
      }
      // 清理其他失去选中的编辑预览弹幕(保留当前选中的)
      this.advanced.cleanupEditSpawned(id)
      // 已有实例则不重复 spawn
      const exists = this.advanced.active.find((d) => d.id === id)
      if (exists) return
      // 主动 spawn,打 _editSpawned 标记
      this.advanced.spawn(rec, { editSpawned: true })
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
