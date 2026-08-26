# CLAUDE.md

## 项目
**高级弹幕模拟器**(桌面应用):滚动避让/顶底固定/B站式高级弹幕(3D 旋转、透明度渐变、缓动、起终点运动、路径跟随),含完整编辑能力。

## 目录 & 命令
- `app/`:主交付(纯 HTML+CSS+原生 JS,无构建;打包 Electron exe)。所有开发在此。
- `danmaku-anywhere/`、`danmu-lib/`:只读参考。
- `音视频 - 黑屏试验.mp4`:测试视频。

常用:`npm start` 运行;`node --check *.js` 语法;`npm run dist` 便携 exe。
**浏览器开发直接双击 `app/index.html`。** 新增 JS 必须按依赖序 `<script src>` 加入 index.html;**不用 ES module**,不得用 `fetch` 读本地文件。
**非管理员打包**:保留 `"win": {"signAndEditExecutable": false}`,设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 国内源。

## 架构(核心,压缩保留)
脚本加载即依赖:`util/*` → `data/*` → `engine/*` → `editor/*` → `player/*` → `main.js`。每个文件 IIFE,只挂 1~2 个全局,`main.js` 组装挂 `window.App`。

### 引擎
- **Clock**(统一时间源):`video` 读 `video.currentTime`;`virtual` 用 rAF 虚拟时钟。**所有动画进度一律 `clock.now()`(媒体秒)**。
- **DanmakuEngine**:rAF 主循环;`emitUpTo` 发射;`isAtMax` 限流;ResizeObserver 重建轨道。**seek 拆分**: `seek(t)` = 设时间源 + `replay()`;`replay()` = 清场重放,**不碰时间源**。`seeking` 事件只调 `replay()` 避免死循环。
- **NormalDanmaku**:CSS `translateX` 滚动;顶底用槽位栈;pause 写 `transition=none` 锁位移,resume 按剩余媒体重算。
- **AdvancedDanmaku**:双层节点(外层 `translate3d`+`opacity`,内层 `rotateZ/Y`);rAF 逐帧 `progress=(clock.now()-timeSec)*1000` 插值 position/`path`/透明度/delay/缓动。**每帧直读 record,编辑字段无需重建即时生效**。

### 数据
- **CommentStore**:唯一数据源,`onChange(event,id,field)`(事件:`replace`/`add`/`remove`/`change`/`select`)。
- 运行时 record 两种形态(`convert.js`):normal / advanced,内部 `timeSec`(秒);用户 JSON 用 `time:"hh:mm:ss[.cc]"`。
- **引擎结构性判定**:mode/type/timeSec/`field===null` 属于结构变更 → 销毁重发射;其余字段普通刷新。
- **解析器**:`parserXml.js`(B站/弹弹play XML)、`parserAss.js`(ASS/SSA);新增格式 = 新 parser + `toRuntime`。
- **io.js**:Electron 下走 `window.api` dialog+fs,浏览器用 `<input type=file>` + FileReader / Blob 下载。侧车 = 视频同名 `.json`,仅 Electron 自动加载。

### 编辑器 & 播放器
- `Editor`:切换可编辑、elementFromPoint 命中选中、坐标拾取(单点/路径连续加点,百分比自动换算)、`attachOverlay` 注入高级弹幕 overlay、**右键菜单**(删除/复制/时间/取色)。
- `Overlay`:高级弹幕选中时,舞台 SVG 标注起点(绿)/终点(红)/虚线,三个手柄 Z 旋转/Y 旋转/拖动;拖拽经 `store.updateDeep`。
- `PanelAdvanced`/`PanelNormal`:与选中 record 双向绑定,`_setVal` 值不同才写(防光标跳)。高级面板:拾取按钮、路径点增删、百分比坐标自动转换、**「当前时间」按钮**。
- `Player` / `Controls`(B站风格):底部悬浮播放条[进度/上一弹幕|播放|下一弹幕/时间/倍速/字幕/音量/设置/画中画/全屏] + 下方发送栏[弹/⚙/A + 输入 + 发送 + 编辑模式/关视频(右侧)]。

### 关键约束 & 约定(保留)
- **convert 钳制**:高级字号 10~127 整数、字体仅白名单、生存 0~10 两位小数、像素坐标 0~9999 一位小数、百分比 0~0.99 两位小数、Z/Y 旋转 0~360 一位小数、透明度 0~1.0 两位小数、内容 ≤255(普通 ≤100);JSON color 一律 hex。**时间**:clock.now() 统一两位小数;JSON `time` 用 `hh:mm:ss.cc`。
- **播放设置(仅普通弹幕)**:类型过滤、屏蔽词、显示区域、密度、滚动速度、字号随屏幕缩放、描边粗细。**高级弹幕以上全部用自身参数不变**。
- **`.fd` / `#stage-hint` 不能设无条件 `display:flex`**(会覆盖 `hidden` 属性)。用 `:not([hidden]){display:flex} + [hidden]{display:none !important}`。
- **`#danmaku-bar` 必须有 `position:relative`**(设置/A 弹窗 absolute 依赖)。
- **空格键控制播放/暂停**(preventDefault)。
- **滚动弹幕 transitionend 必须调 destroy()**(仅 end 泄漏节点导致选中框残留)。
- **增强**:UndoManager(Ctrl+Z/Y,400ms 合并,上限100);列表左键拖动范围多选 + Ctrl 追加/拖动追加,批量≥2弹批量菜单(时间/颜色/批量删除,MAX_BATCH=200),批量舞台虚线选中框(框外6px粉虚线)+ 手柄(平移/删除/取消);列表拖拽边缘自动滚动。
- **播放方式/设置**:播完暂停/循环/自动切集;视频比例 auto/4:3/16:9。设置面板:屏蔽重复(仅普通)、防挡字幕=屏幕下方25%(仅普通,高级不受影响)。
- **导入/导出**:工具栏「导入弹幕」(JSON 直导,XML/ASS 转,非法 toast 红框"导入失败:你导入的文件可能没有弹幕代码...") + 「导出 JSON」;「弹幕文件」打开**弹幕文件库**(Electron:userData/danmaku-files,按创建时间命名 `danmaku-YYYYMMDD-HHmmss.json`);IPC 统一在 `electron/ipc.js`。编辑/关视频按钮在**发送栏右侧**;关视频不清弹幕;**双击全屏判定排除 `#stage-hint`**。
- **文件弹窗 CTRL+V 粘贴**:FileDialog 打开类弹窗期间,焦点不在输入框时,支持粘贴文件(clipboardData.files)或文本(JSON/XML/ASS 转 Blob)。
- **弹幕内容策略**:高级弹幕 textarea 支持换行(真实换行符换行,`\n`字面删);普通弹幕强制单行;█/_(特殊宽度字符)改用 span 宽度对齐构造。
- **大会员渐变(colorful)**:白字 + 加肥3px透明描边 + background-clip:text 裁剪 5 色渐变(左→右:#f2509e→#ce5ba7→#8272ba→#6b7abf→#5499cb),双层 DOM(下层描边层 + 上层白字填充),z-index 1 覆盖;fallback:单色描边。
- **ctxMenu 要点**:`ctx-menu` 容器 click 事件 stopPropagation 防冒泡到 document 导致点击任何子元素立即关闭;批量激活(列表复选框>0)时舞台单击弹幕不弹 overlay(跳过 select),但右键弹幕仍弹操作菜单(删除 enabled 前置检查);取色 `_startColorPick` 监听注册延迟到下一 macrotask(避免被取色按钮自身 click 误触发立即退出);颜色写回区分 `rec.type==='advanced'`(updateDeep `style.color`)vs normal(update 顶层 `color`)。
- **暂停拖动进度条普通弹幕继续移动修复**:normal startScroll/startFixed 生成后,`_resumePlaying===false`(引擎暂停状态)时新弹幕直接 `pause()`,锁位移,恢复播放时再 resume;或在 emitStash/spawn 后额外 `pauseAll()` 一次,保证 seek 后暂停态的所有新弹幕静止。
- **草稿系统 & 高级预览**:`store.setDraft(record)` 创建草稿不入池,点「发送」校验才 add;高级预览临时上屏不入列表,`_previewImmediate` 用 performance.now() 驱动(暂停仍动);引擎 rAF 始终 `advanced.update()`。

### 最近功能(需保持认知,持续追加)
- overlay 选定框重做:`.eo-box`(点击聚焦 `#pa-content` 编辑、右键弹 `adv-menu`) + 四角 `.eo-corner`(拖拽改 fontSize 10~127);画层 line→box→corners→markers→handles;非编辑模式显示 `.dm-selected`,编辑模式隐藏改用 overlay。
- 面板:普通/高级头部「＋ 添加弹幕」+ 底部「发送」(validateAndSend 校验范围/小数位,toast 原因);标题 flex-wrap 防溢出;可收纳 collapsed。
- 列表:双击行 seek 到该弹幕时间;选中自动滚动;搜索框+高级筛选(时间范围/类型/子类型/发送人);flex:1 占满;`#list-resize` 手柄拖拽调高。
- **#dm-count 悬停变白 + 点击打开「当前弹幕池」总览**(不展开正文)。
- **Ctrl+S 保存当前改动(包括拖拽/批量等)**:调用 controls.saveDanmakuFile(),**草稿不会自动发送**。
- **列表 Ctrl+A 轻度全选**:`list.selectAllShowing()` 全选当前展示的弹幕(light 批量)。
- **显示缩放(仅弹幕坐标与尺寸,UI 与舞台不变)**:
  - 修正对象:之前错误地通过 `window.api.applyDisplayScale`(Electron webFrame)或 `document.body.style.zoom` 缩放整个应用,现已全部移除,改为只在 `DanmakuEngine` 内引入 `displayScale` 系数(0.5~2.0,默认 1=100%)。
  - 核心规则:`displayScale` 只影响「1px 对应的实际渲染大小」:普通弹幕字号×fontScale×displayScale、描边宽×displayScale、轨道高度=`_baseTrackHeight×displayScale`、gap=`options.gap×displayScale`;**高级弹幕仅像素坐标与 path 节点×displayScale**(百分比坐标弹幕保持 B 站语义,字号/描边不随 displayScale 线性化);`engine.width/height/usableHeight` 与 DOM UI 完全不变。
  - 新增 API:`engine.setDisplayScale(v)`(范围钳制 0.5~2.0)。调用时会:1)按新 displayScale 重算 trackHeight/gap 并重建轨道;2)在屏普通弹幕清空 `_w/_h` 缓存 + 重刷 `applyRecordStyle`;3)在屏高级弹幕清空 `_sig` 缓存 + 重刷 `applyTextStyle` + 立即 `update()`;4)按新轨道/新字号宽度 `clearScreen+replay` 当前窗口,避免碰撞错乱。
  - 修复 `setDensity` 会直接写 `trackHeight` 抵消 displayScale 的 bug:改为只改 `_baseTrackHeight`(more=20 / overlap=30 / normal=options.trackHeight),由 `layout()` 统一乘 displayScale 计算最终 `trackHeight`。
  - UI:`#set-display-scale` 滑块 `min=50 max=200 step=1`(原 step=5 改为 1,百分之一精度);下方说明文案改为「调整弹幕(1px 对应的实际渲染大小)的显示比例;程序界面和舞台大小保持不变(默认 100% 为推荐值)」,避免误解为整体 UI 缩放;tooltip 也同步更新。
  - 自动 DPI:`settings.autoDpi` 开启时,仍通过 `window.api.getDisplayScaleFactor()`(preload.js 保留此 API)取系统 DPI,作为 `displayScale` 写入引擎;关闭时用滑块值。`applyDisplayScaleFromSettings()` 已不再触碰 `body.zoom` / `webFrame`。
  - 高级弹幕 sig 增加 displayScale 感知:像素坐标弹幕在 sig 中追加 `'S' + displayScale`,百分比坐标弹幕不加,保证拖动缩放在屏弹幕强制刷新;描边 shadow 同样仅在像素坐标时乘 displayScale,百分比时保持 B 站原 1px+3px glow。

### 快捷键一览(全局,非输入框聚焦时生效)
| 快捷键 | 功能 |
|---|---|
| `Ctrl+S` | 保存当前弹幕池到本地 JSON(不自动发送草稿) |
| `Ctrl+Z` | 撤回(UndoManager,400ms 合并,上限 100) |
| `Ctrl+Y` | 恢复 |
| `Ctrl+A` | 列表轻度全选当前展示中的所有弹幕 |
| `Ctrl+C` | 复制当前选中(描边框)的单条弹幕为新草稿(发送人改为全局默认发送人,默认"我") |
| `Ctrl+D` | 直接删除当前选中的弹幕(单条或多条批量) |
| `Space` | 播放/暂停 |
| `Escape` | 退出取色/拾取坐标模式 + 关闭右键菜单 |
| `Ctrl+V` | 文件弹窗打开期间粘贴文件或文本(JSON/XML/ASS 自动转 Blob) |

### 弹幕池对话框内快捷键(打开「当前弹幕池」时生效)
| 快捷键 | 功能 |
|---|---|
| `Ctrl+Z` | 撤回(同全局) |
| `Ctrl+D` | 删除弹幕池中选中的弹幕(Ctrl+点击多选后批量删除) |
| `Ctrl+A` | 全选弹幕池当前展示中的所有弹幕 |
| `Ctrl+C` | 提示错误"不能在弹幕池里进行复制操作!" |
| `Escape` | 关闭弹幕池右键菜单 |
- **顶/底弹幕显示修复**:`startFixed` 中弹幕实际高度因 `line-height:1.3`(standard 25px→h≈33)略大于 `trackHeight`(30),导致 `top` 计算为负被 `destroy()`。修复:`engine.height===0` 时销毁(未 layout);`top<0` 钳制为 0,`top+h>engine.height` 时钳制为 `engine.height-h`,保证顶/底弹幕正常显示。`spawnFixed` 的 measure 仅等 `getWidth()!==0`(≤20 次 rAF),不主动调 `layout()`/不等 width-height。
- **预览弹幕 = start.json**:启动时 `controls.loadStartDanmaku()` 调 `DanmakuIO.ensureStartDanmaku()`:本地弹幕池目录无 `start.json` 则从应用根目录模板复制一份,再读取加载为预览弹幕(`store.setComments`,静默无 toast)。保证本地弹幕池始终至少有一个弹幕文件;用户删除后回到导入引导(列表空态),重启时自动重新生成。新增 IPC:`ensure-start-danmaku`、`delete-danmaku-file`(ipc.js/preload.js/io.js)。本地弹幕池列表项支持**右键删除文件**(确认弹窗→`deleteDanmakuFile`→刷新列表)。
- **彻底移除 `#pa-path-area`**(高级面板路径跟随编辑区):删除 index.html、stage.css 相关样式定义、panel-advanced.js 引用。`motion.type==='path'` 不开放,加载时自动 toast 强制转 position 且清 path(已在 load)。
- **高级弹幕「复制」按钮**:
  - 默认 hidden,出现在「＋ 添加弹幕」左侧(靠在 pa-add 左边);
  - **显示条件**:① 发送过一条高级弹幕(存 `global._lastSentAdvanced`),或 ② 当前选中了任意高级弹幕;
  - **点击逻辑**:来源优先级 = 当前选中(入池非草稿)的高级弹幕 > `global._lastSentAdvanced`(最近一次发送成功);深拷贝 `DanmakuConvert.cloneAdvanced(src)`,偏移 timeSec +0.01s、useCurrentTime=false,setDraft 创建新草稿,面板自动绑定,可改后再发送。
- **pa-time 时间格式**(高级弹幕时间输入框):
  - 总是精确到小数点后两位 `hh:mm:ss.cc`(用 `TimeUtil.timeToStr2`);
  - 未勾选用当前时间时:显示该弹幕的 `timeSec`;
  - 勾选用当前时间(`useCurrentTime=true`)时:显示当前播放时钟 `engine.clock.now()` 的 `hh:mm:ss.cc`(不是空字符串/占位);timeEl 不再禁用(允许手动改);
  - **「当前时间」按钮不再常亮**:删除 `.pn-now.active` 样式,代码不再 toggle active class。
- **启动默认不开启编辑模式**:移除 `<body class="editing">` 上的 `editing` 类,以及 `#pb-edit` 按钮上的 `active` 类(两处均为写死导致启动时编辑模式激活的根因)。Editor.constructor `this.enabled=false` 保持不变。
- **增强开关(高级弹幕「生命与运动周期」右侧)**:
  - DOM:`index.html` 中 `.pa-group-title-row` 容器(title + `label.pa-boost-switch` 包裹 checkbox#pa-boost + slider + "增强" 文字);标签加 id 动态更新范围文案;CSS 仿 iOS 开关(选中蓝 #00aeec,未选灰,120ms 过渡)。
  - 数据:`record._boost` 默认 `false`,`makeAdvanced()` 默认 `false`,`cloneAdvanced(src)` 继承 `!!src._boost`,`toUserJson` 输出 `_boost: true` 时持久化。
  - 范围:普通=生存 0~10 / moveDur 0~10000 / delay 0~10000;增强=生存 0~86400 / moveDur 0~86400000 / delay 0~86400000(常量 `BOOST_MAX_LIFE=86400`,`BOOST_MAX_MS=86400000`)。
  - 切换逻辑:panel-advanced.js `_wireFields` 监听 change,`store.update(rec.id, {_boost})` → `_applyBoostToFields(boost)` 同步 `input.max` 与 `label` 文案(如"生存时间(0~10秒)"→"生存时间(0~86400秒,增强)");`load(rec)` 时读取 `rec._boost` 还原 checkbox 与范围。
  - 输入校验:NUM_FIELDS 数组第4元素可选 `boostMax`,`getCfg(fieldDef, boost)` 按增强选 hi;未增强时超 range 弹 toast 错误提示(`fieldName 超出范围(lo~hi);请开启「增强」后再输入,当前已被钳制。`),值仍 clamp 写入(不阻断)。
  - validateRecord:`rec._boost` 为真时用 BOOST_MAX 校验,错误信息附加"(增强)"标记。
  - 外部文件导入(XML/ASS→toRuntime):若原始 life/move/delay 任一超普通范围 → 自动置 `_boost=true` + 用 BOOST_MAX 上限 clamp,**不丢弃弹幕**。
- **<1s 滚动/顶底弹幕不显示根因与修复**:
  1. `emitOne` 阶段若 stage 无尺寸(`engine.width===0`),直接返回 false 且不写入 `emitted`,避免标记后永不重试;`emitUpTo` 遇 false 则 break 不推进 cursor,等 layout 后重试。`layout()` 首次尺寸就绪时(`!wasReady && width>0`)再调用 `emitUpTo(clock.now())` + `emitStash()`。
  2. onStoreEvent `'add'` / `handleChange` 结构性变更:原 `recomputeCursor()` 按 `now - replayWindow` 定位,导致 timeSec 在 `(now - replayWindow, now]` 区间内的新弹幕被跳过;改为 `this.cursor = 0` 从头扫描(靠 emitted 去重,安全)。
  3. 暂停状态大字号弹幕立即被销毁:原先启动 transition 再 `pause()`,时序上浏览器会立即 fire `transitionend` → `_onEnd` → `destroy()`;改为暂停状态下直接 `transition:none` + 静态 transform,`paused=true` 但不创建 transition,彻底避免 `transitionend` 误触发。
- **大字号(普通弹幕)与其他字号重叠 & 不显示**:
  - `NormalDanmaku` 新增 `this.tracks: Track[]`(多轨道占用数组),`end()` 从所有占用轨道移除。
  - `getTrack(record)` 重写:按 `FONT_SIZE_PX[fontSize] * 1.3`(含 line-height)估算高度,`needRows = ceil(h / trackHeight)`;找从 `i` 开始的连续 `needRows` 个空闲轨道,返回 `{ track, tracks }`;allowOverlap 时仍直返 track0。
  - `spawnScroll(rec, startMT, trackInfo)`:把弹幕 `track` 设为起始、`tracks` 为所有占用,并对每条轨道调用 `t._add(dm)`,保证后续轨道复用判空时能命中。
  - `startScroll` y 坐标:基于 `tracks[0].top ~ tracks[n-1].top + trackHeight` 块的居中位置 `blockMiddle - h/2`,再钳制 `y<0→0`、`y+h>height→height-h`(与 startFixed 对齐)。
- **engine.gap 未定义 bug**:`engine.js constructor` 新增 `this.gap = this.options.gap` 显式赋值(原只有 this.trackHeight,导致 `getTrack` 中 `gap + lastWidth = NaN`,轨道复用判断永远 false)。
- **滚动弹幕轨道分配:从上到下顺序,先发在上后发在下**:`NormalRenderer.getTrack` 原用 `Math.floor(Math.random() * rows)` 随机选轨道,改为 `for (let i = 0; i < rows; i++)` 从 0→N-1 顺序遍历,优先选择最上方第一个满足「last.getMoveDistance() >= gap + lastWidth」或空(last=null)的轨道并返回;allowOverlap 时仍直返 `tracks[0]`。顶/底 DanmakuStack 原本就支持正确方向(top 先发在上=栈向下 grow;bottom 先发在下=栈向上 grow),无需改动。
- **删除 index.html 所有写死的测试弹幕 DOM**:`#stage` 容器清空原来写死的 `.danmaku-wrap > .danmaku-sample`(01、02、03三条滚动/顶/底测试弹幕);`#list-body` 容器清空 27 条硬编码的 `.list-row`(演示数据"测试内容 1~27");`#dp-list tbody` 清空所有写死的 `<tr class="dp-row">`(演示行 d0001~d0010);对应的计数显示(dm-count/list-count 等)重置为 0/0。保证所有弹幕 DOM 由 JS 动态生成,不存在无法删除的写死节点。
- **轻度批量选择状态清除(点击程序任意位置)**:当 `store.selectedIds.size > 1`(批量选中)且 `store._batchIds.size === 0`(非深度批量)时,在 `document.addEventListener('mousedown', ...)` 回调中,若 `e.target.closest('#stage, #list-body, .list-row, #dp-list')` 但没有命中当前选中行,则调用 `store.clearSelection(false)` 清空 selectedIds(保留 _batchIds 不影响深度选择)。仅在"批量选中数 > 1"(有描边框的单条不执行)时触发。
- **弹幕池列表拖拽移出 div 自动加速滚动(修复)**:原 `tbody.addEventListener('mousemove')` 仅在 tbody 内触发,鼠标移出 `<div id="dp-list">` 后事件不冒泡,导致无法追踪拖拽位置。修复:把 `mousemove/mouseup` 升级为 `document.addEventListener` 全局监听;`mousemove` 时用 `document.elementFromPoint(e.clientX, e.clientY)` 回查鼠标悬停行,据此续选/反选;同时滚动加速逻辑按边界距离计算目标速度(1~8px/帧,加速公式 `speed += (targetSpeed - speed) * 0.12`,鼠标回 div 内时 `speed *= 0.85` 衰减),与普通列表 `#list-body` 拖拽自动加速完全对齐。
- **启动时「当前弹幕池」不自动弹出**:HTML 根节点 `#danmaku-pool` 补加 `hidden` 属性(之前缺失导致 CSS `.fd` 不生效,页面一上来就显示);同时 main.js 启动流程移除任何默认调用 `list.openPoolOverview()` 的代码,保证仅用户点击「弹幕 n」span 才弹出。
- **「展示当前弹幕」改为非破坏性,不丢失弹幕池数据**:原 `_applyShowingAsPool` 直接 `store.setComments(filtered)` 替换整个弹幕池,导致筛选/范围外的弹幕永久丢失。改为新增 `engine.setShowOnlyIds(ids: Set<id> | null)`:舞台发射时在 `_isVisible(rec)` 前置判断 `showOnlyIds && !showOnlyIds.has(rec.id) → return false`,仅展示指定 id 集合;替换弹幕池(`store.setComments` / `clearAll`)或关闭筛选时把 `showOnlyIds = null` 恢复全部展示。弹幕池数据始终完整不被截断。
- **【当前弹幕池】右键菜单:删除所有复制相关入口**(HTML + list.js 逻辑,包括「复制」「复制(从消失时间开始)」两项,以及对应事件绑定与 DOM 控制);固定展示弹幕右侧菜单也移除所有复制开关。
- **复制弹幕 timeSec 变 0 修复**:新增 `store._ensureTimeSec(rec)`(从 `time` 字符串 `hh:mm:ss.cc` 解析,统一到 0.01s 精度),在 `get()`、`setComments()`、`appendMany()`、`duplicate()` / `duplicateFromEndTime()` 等所有数据入口强制规范化;`duplicateFromEndTime` 改为 `endSec = (src.timeSec||0) + lifeSec`(不再依赖 undefined→NaN→0)。
- **start.json 更新 + 替换策略**:3 条高级预览弹幕默认 `fontFamily` 改为 `"SimHei, \"Microsoft YaHei\", sans-serif"`(`fontFamilyRaw=SimHei`),并补充 `timeSec` 字段。**下次替换 start.json 时按以下流程**:
  1. 只改应用根目录模板 `app/start.json`。
  2. 确认每条弹幕都有 `time` 字符串 + 数值型 `timeSec` 两者一致(解析后 `Math.round(sec*100)/100 === timeSec`)。
  3. 高级弹幕 `style.fontFamilyRaw` 保留原字体(中文用 `SimHei`),`style.fontFamily` 按 `FONT_FAMILY[fontFamilyRaw].style` 生成(带逗号 fallback),禁止直接手写 fontFamily 但 fontFamilyRaw 不同步。
  4. 预览字段顺序保持:`id/type/time/timeSec/content/sender/style/rotation/life/motion/position`。
  5. 代码层面:保证 `DanmakuIO.ensureStartDanmaku()` 仅当 userData 目录不存在该文件时才从新模板复制;若需强制升级本地 userData 已存在的旧 start.json,需在 ensure 里额外做"本地内容指纹比对模板"或加版本号字段(例如 `_templateVer`)来判定是否覆盖旧文件。
- **【加入其他弹幕】重复弹幕处理策略**(controls.js `_mergeImportText` + `_countSameRecords`):
  - **fingerprint 规则**(与 store.appendMany 对齐):
    - 普通:content + timeSec(四舍五入到 0.01s) + mode + fontSize + color + isUp
    - 高级:content + style(color/fontSize/fontFamilyRaw/stroke) + life.duration + position(usePercent/4值) + rotation(z/y)
  - **流程**:dry-run 统计 sameCount(不修改 comments)→ sameCount>0 弹窗询问「仅导入不同 / 全部导入(含相同)」(App.confirm 优先,回退 window.confirm,失败默认仅导入不同);sameCount=0 直接导入。
  - **Toast 提示**:成功导入时追加 ` 其中参数完全相同的弹幕有 N 个`;若导入 0 条且相同弹幕>0,再追加 ` 相同弹幕并未导入`。

## 本地标准 JSON(简化)
普通:`{id,sender,type:"normal",content,time:"hh:mm:ss[.cc]",mode:"scroll|top|bottom",fontSize:"small|standard|large",color,isUp,colorful?}`。
高级:`{id,sender,type:"advanced",content,time,style:{color,fontSize,fontFamily,stroke},rotation:{z,y},life:{duration,opacityStart,opacityEnd},motion:{moveDuration,delay,linear,type:"position"},position:{usePercent,startX,startY,endX,endY}}`。
XML→本地:mode=7 高级 `<d>` 文本是 JSON 数组,映射表见 `parserXml.js`(content 文本正则提取参数优先级 > 数组值)。
