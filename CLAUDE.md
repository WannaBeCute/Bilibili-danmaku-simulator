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
- **批量统一面板颜色同步 + 右键菜单改动持久化**(2026-08-29,verify-ctx-menu.js 回归):
  - **批量统一参数弹窗颜色栏同步**:`_buildUnifyContent` 颜色行原先把色块 id 也写成 `pa-unify-color` 与勾选 checkbox 撞 id,且无双向同步。修复:色块改用 `pa-unify-color-swatch`,`input` 时写回 `pa-unify-color-text`(大写 hex);代码框 `input`/`change` 用 `ColorUtil.parseColor` 解析成功后写回色块(非法值不改色块)。
  - **右键菜单改时间/颜色立即提交、退出不回滚**:新增 `store.commitEditId(id)`(把该条 `_editSnapshots` + `_batchSnapshots` 重基到当前态,不动 ctime 不发事件)。在单选菜单(editor.js 色块 input / 时间 ± / 时间输入提交)与批量菜单(list.js 色块 input / 使用当前颜色 / 时间 ±)的每次 `store.update/updateDeep` 后调用,保证退出菜单/退出批量不再回滚。
  - **右键菜单「保存」= 等效 Ctrl+S**:单弹菜单 `#ctx-menu-save` 改为:草稿先 `validateAndSend` 发送入池,随后 `controls.saveViaUserAction()`(写盘 + 列表保存按钮刷新「已保存」);已入池直接 `saveViaUserAction()`。批量菜单新增 `#batch-menu-save`「保存」按钮(绿强调,base.css `.batch-btn-save`)同样调 `saveViaUserAction()`。
- **导入弹幕细节修正**(2026-08-29,verify-save-flow.js 第 B2/B3 项):
  - **本地弹幕池文件一律存转换后的 JSON**:`_importAndCreateLibraryEntry(file)` 先经 `_parseImportText`(从 `_importAuto` 抽取的 ASS/XML/JSON 识别助手)解析,再 `toRuntime` 归一,`buildExportJson(this.store, normalized)` 序列化为 JSON,最后 `saveLibraryEntry(name, jsonText)` 入库——无论源是 XML/ASS/JSON,池文件都是 JSON。解析失败/无有效弹幕则红框报错、不建空文件。
  - **导入保存提示不再说「替换」**:`_promptImportGate` 改用新 mode `'importNew'`(文案:「导入会将弹幕内容(源文件若为 XML/ASS 将自动转换为 JSON)保存为本地弹幕池的新文件并打开,请问是否保存当前的改动?…」);`'import'`(「替换当前编辑的弹幕池内容」)仅剩空态「打开弹幕」`openDanmakuDialog` 使用。
  - **打包 exe 图标嵌入**:`win.signAndEditExecutable: false`(非管理员必需)会同时跳过 rcedit,导致打包 exe 保留 Electron 默认图标。用 **`electron/after-pack.js` afterPack 钩子**(`package.json build.afterPack`):在打包完成、生成目标前从 winCodeSign 缓存找 `rcedit-x64.exe`,给 `appOutDir` 里的应用 exe 写 `--set-icon 程序封面.ico`,带**截断护栏**(rcedit 会截断 exe 追加的 overlay 数据 → 尺寸明显变小则回滚原始文件,保证 exe 可用)。
  - **⚠️ 绝不能 rcedit 便携版 SFX**:electron-builder 的 portable = 7z SFX,应用数据是追加在 PE 之后的 overlay;rcedit 重写 exe 会**截断这段 7z 数据**(实测 portable 从 ~71MB 被截成 54KB,直接打不开,退出码 2)。曾用过的 `electron/fix-icons.js` 因会改 portable 外层 exe 而**已删除**,改图标只走 afterPack(它改的是包内的应用 exe,无 overlay,安全;便携版外层 SFX 图标保持默认,属已知取舍)。
  - **⚠️ NSIS 安装器(setup.exe)绝不能在编译后再改**:NSIS 内置 CRC 完整性校验,任何 post-build 修改(rcedit 改图标、手动签名)都会让安装时报「Installer integrity check has failed」。安装器图标改用 `nsis.installerIcon/uninstallerIcon`(makensis 编译期嵌入,安全)。`fix-icons.js` 明确只处理 app exe + portable,不碰 setup.exe。
  - **MSIX/AppX 磁贴图标**:electron-builder 从 `build/appx/*.png` 读磁贴/Logo 资源(StoreLogo/Square44/71/150/310/Wide310x150/SplashScreen),已用 sharp 从 `程序封面-cropped.svg` 生成(方形 cover、宽磁贴 contain);`.gitignore` 白名单加了 `build/appx/`。新增 `build.appx`(displayName/publisherDisplayName;`publisher` 由你的证书/环境提供,勿写死)。
  - **afterPack 钩子 `electron/after-pack.js`**:在「应用目录打包完成、生成目标前」用 rcedit 把 程序封面.ico 写进 appOutDir 的 exe——无论 portable / nsis / msix 哪个目标,包里的 exe 都带自定义图标(且不依赖 fix-icons 事后脚本)。`package.json build.afterPack` 已配置。`npm run dist:msix` = `electron-builder --win appx`(AppX 目标,产物 .appx)。
  - **⚠️ 本机构建 appx 需要「开发者模式」**:app-builder 会下载并解压 winCodeSign(内含 darwin 符号链接);非管理员且未开启开发者模式时解压失败(「客户端没有所需的特权」)。若在本机构建 appx/msix:设置 → 隐私和安全性 → 开发者选项 → 开启「开发人员模式」;或改用已缓存/可解压的环境。构建时需 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`(否则从 GitHub 下载会超时)及签名证书(`CSC_LINK` 或 appx 相关发布者配置)。
  - **手动签名 NSIS 安装器的正确姿势**:不能在 electron-builder 完成后再签名(会破坏 CRC)。要么在 electron-builder 构建流程里签名(其内部会在签名后重打 NSIS 头),要么不签名直接使用(仅 SmartScreen 提示未知发布者)。
- **保存/导入/脏检测一体化修复**(2026-08-29,verify-save-flow.js 回归):
  - **脏检测修正**:`_markBaselineSaved(text)` 一律以「当前运行时序列化」`_serializeCurrentAll()` 打基线(而非磁盘原始文本)。打开文件时 store 会重生成 id、归一 time 精度、补 isUp 默认值/video,旧实现拿磁盘文本当基线导致刚打开就误判「有改动」→ 无改动也弹保存提示。现在:打开即干净、编辑才脏、保存后回干净。
  - **保存按钮「已保存」状态**:`#list-save` 干净时显示「已保存」+ `.saved` 样式(base.css 新增绿态),编辑后 120ms 防抖恢复「保存」。`controls._refreshSaveState()/_scheduleSaveStateRefresh()`,构造器订阅 `store.onChange` 刷新。
  - **无改动时 Ctrl+S/保存**:`controls.saveViaUserAction()`(main.js Ctrl+S 与 #list-save 均改用它)——无改动 → toast「你已经保存了最新改动！」并跳过重写;有改动才写盘。
  - **保存后快照重基防回滚**:新增 `store.rebasePendingEdits()`(把 `_editSnapshots/_batchSnapshots` 重基到当前状态,不改 ctime 不发事件),`saveDanmakuFile` 两分支写盘成功后调用。修复「编辑后没点更改→切选/退批量被回滚,保存写的是已回滚内容」。
  - **工具栏「导入弹幕」改造**:有未保存改动时弹三态保存确认(`_promptImportGate`,与本地弹幕池「导入新弹幕」一致);导入 = `_importAndCreateLibraryEntry(file)` 在本地弹幕池**新建 JSON 文件** → `_currentLibId` 关联 → 打开(不再原地替换当前池)。共享助手 `_importAndCreateLibraryEntry`/`_promptImportGate`,【当前弹幕池】「加入其他弹幕」(`_mergeImportText`)未动。导入保存提示文案改为「导入会创建新的本地弹幕池文件并替换当前编辑的弹幕池内容…」。
  - **自动写盘(开启自动保存)**:`settings.autoSave` 开启且已关联本地文件时,编辑已有弹幕后约 800ms 防抖 `saveDanmakuFile({silent:true})` 静默写盘;无关联文件不写盘(避免弹保存对话框);写盘后基线/保存按钮状态自动更新。入口 `controls._scheduleAutoSave()`(构造器 store.onChange 触发)。
  - **图标修正**:`程序封面.ico` 相对源 `程序封面-cropped.svg` 上下颠倒(此前生成误加 `.flip()`,对比 Chromium 渲染 svg 的差异:no-flip≈10 / flip≈30)。已用 sharp 从 svg **不带 flip** 重新生成 7 尺寸(16/24/32/48/64/128/256)PNG 装入 ICO 容器,`electron/main.js` BrowserWindow 图标与打包图标均指向该文件自动修正。
- **全局设置「程序启动时自动打开最近改动」**(`settings.autoOpenRecent`,默认 false):
  - DOM:`#set-auto-open-recent` 复选框,放在「程序启动时显示舞台操作提示」下方;注释:「开启此开关后,下次启动程序将不再自动打开本地弹幕池目录下的start.json,而是直接打开目录下的最近改动的弹幕文件」。
  - 持久化:main.js `loadSettings` 读 `s.autoOpenRecent === true`,默认返回 `autoOpenRecent: false`;打开/重置/保存三处已接线。
  - 行为:`controls.loadStartDanmaku()` 读取 `global.window.App.mainSettings.autoOpenRecent`;开启时跳过 step1(start.json / ensureStartDanmaku),直接 `step2MostRecent` 打开本地弹幕池目录下 mtime 最新的非 start.json 弹幕文件;关闭时维持原逻辑(start.json → 失败 fallback 最近改动)。
  - 回归:`npx electron verify-startup-recent.js`(20 项断言,含 loadStartDanmaku 分支打桩验证)。
- **本地弹幕池重复打开当前文件被阻止**:`controls._refreshLibrary()` 库行点击回调开头加守卫 `String(this._currentLibId||'')===String(e.id)` → 仅关闭弹窗直接 return,**不调用 readLibraryEntry**(避免用磁盘内容静默覆盖未保存改动、重置 _currentLibId)。点击其它文件仍正常打开。
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

### 三连修复(2026-08-29,verify-bugfix.js 回归)
- **普通面板「＋ 添加弹幕」永远发不出去 + 「当前时间」无反应**:根因是 `PanelAdvanced.clear()` → `_discardDraftIfNeeded(null)` 无条件把 `store.draft` 清空。当普通草稿被创建(setDraft 发 select)时,高级面板的 select 监听会因"选中不是高级"走到 `clear()`,把普通草稿一并删掉 → `validateAndSend` 用 `store.getSelected()` 取到 null,一直提示"请先点击「＋ 添加弹幕」创建并选中一个普通弹幕"。修复:`_discardDraftIfNeeded` 开头加 `if (store.draft.type !== 'advanced') return`,**只清理高级草稿(本面板自己的),绝不碰普通草稿**。
- **启动时编辑模式默认为开启**:工作区 index.html 被误序列化回 `<body class="editing">` + `#pb-edit` 的 `active` 类(HEAD 本来没有)。修复:删掉这两处类;`Editor.enabled` 默认仍 false,由 `setEnabled(on)` 才动态 toggle body 类/按钮 active。
- **高级草稿变"僵尸弹幕"**(不发送点普通「＋ 添加弹幕」/列表 → 旧高级草稿舞台实例残留,列表无、无法删除):根因是 `store.setDraft` 直接覆盖 `this.draft` 但没移除旧草稿已 spawn 到舞台的实例(`cleanupEditSpawned` 因 `elapsed≈0` 保留它)。修复:setDraft 开头,若已有 id 不同的旧草稿,先 `engine.advanced.removeById(oldId)` + `engine.normal.removeById(oldId)` 再替换(与 `store.select` 里的清理一致)。
- 回归验证:`npx electron verify-bugfix.js`(22 项断言,含"修复前会失败/修复后全过"对照)。

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

## 最近大改动(2026-08-28 多轮)

### 0. 本地弹幕池核心 bug 修复
- **保存逻辑缺失**:`controls.saveDanmakuFile()` 改为**智能二合一**:若当前打开的是本地弹幕池文件(`_currentLibId` 存在)→ 直接 `updateLibraryEntry` 更新原文件(**不弹文件管理器**)即"保存";否则走 **"另存为"**(弹文件选择器,默认本地弹幕池目录),对应工具栏按钮改名为「另存为」。
- **文件修改时间频繁刷新根因**:`listLibraryEntries()` 把渲染端的循环 `readDanmakuFile` 全搬到主进程 `list-danmaku-files` 一次性解析 meta,避免每次刷新库列表写 `modifiedAt = Date.now()` 触发系统 mtime 变更。
- **全局设置路径 "[object Object]"**:`getDanmakuDir()` 返回对象,`setDanmakuDirInput.value = dir.path || dir.defaultPath || ''`(main.js 两处回填统一)。

### 1. 本地弹幕池 UI 重塑
- **📂 打开文件夹图标**:从 dl-header 操作列移到 `danmaku-library` 弹窗标题栏(「本地弹幕池」字样右侧并列),点击 `openPath(dir.path)` 打开本地保存位置(Electron 端 `shell.openPath`,预览模式 toast 提示)。
- **「+ 创建弹幕池」按钮**:仿照 tb-btn 样式,放在工具栏「打开视频/音乐/图片」右边、「本地弹幕池」左边(非底部 dl-btns)。点击弹**自定义确认弹窗**(`global.DanmakuIO.showConfirmModal`)三态语义:
  - **主按钮「保存并创建」**→ 先调用 saveDanmakuFile(智能保存不弹管理器)→ 再 `_doCreateEmptyPool` 清库 + 在 userData 目录生成空 JSON 并打开。
  - **次按钮「不保存直接创建」**→ 直接清空并创建。
  - **× 关闭 / Esc / 遮罩点击**→ **完全取消创建操作**,什么都不做(返回 `null` 分支)。
- **「本地弹幕池」↔「导入弹幕」按钮顺序调换**:工具栏现顺序 = `打开视频/音乐/图片 → +创建弹幕池 → 本地弹幕池 → 导入弹幕 → 导出弹幕`。
- **本地弹幕池列表硬编码清空**:删除 index.html 里 `#dl-list` 中 3 条 `danmaku-danmaku-20260828-*.json` 示例条目。

### 2. 打开视频/音乐/图片(含音频后台播放)
- 工具栏按钮改名「打开视频/音乐/图片」,文件选择器 accept 加 `audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac`。
- **`Player.openMusic(file)`**(player.js):动态创建隐藏 `<audio>` 元素,`preload=metadata` → `canplaythrough` 后 clock 绑定 audio currentTime,舞台黑色背景,`clock.setLength(audio.duration)`,与视频共用 `_bindClock()` 生命周期。
- **`Player.closeMusic()`**:`revokeObjectURL` + audio 元素移除 + length 清 0 + 舞台黑屏。
- **Controls 分发**:`_isAudioFile(name)` 按扩展名判断,调用 `openMusic()`;关闭按钮 `_updateCloseMediaBtn` 显示「✕ 关闭音乐」(与视频/图片不同标签)。

### 3. 全局设置扩展(已在上游修正)
- **百分比仅坐标缩放(修复 fixed 丢失)**:panel-advanced.js `togglePercent()` 和批量偏移 S 分支构造新 position 时用 `Object.assign` 保留 `fixed` 字段,防 `store.update` 整体替换后 `fixed=true` 被冲掉。
- **LRC 导入失败**:去掉 `contentEl.maxLength = -1`(Chrome 会抛异常),改为移除原生限制。

### 4. 右侧面板拖拽条(已按用户要求彻底回退)
- 尝试在 `#side` 内外加 `.side-resizer`(flex 子 + negative margin 覆盖层、`_wireResizer()` 三事件监听、localStorage 持久化 danmaku-side-width、拖拽方向 `startW - dx`,#side max-width 从 420→600)。
- **用户要求彻底删除**:index.html 移除 `<div id="side-resizer">`;base.css 删除 `.side-resizer/.resizing/.side-resizing` 所有定义并把 #side max-width 改回 420px;controls.js 删除构造器里 `this._wireResizer()` 调用,以及整个 `_wireResizer()` 60 行方法(约 L1717-1778)。最终状态同前一轮原始代码。

### 5. 普通弹幕选中框(编辑模式状态搞反 修复)
- 根因:`engine/normal.js:105` 和 `engine/advanced.js:127` 条件为 `if (!this.engine.editable...)`→ 非编辑模式反而加 `.dm-selected`。
- **修复**:三处统一改为 `if (this.engine.editable && this.engine.store.selectedId === this.id)`:
  - `engine/normal.js buildNode` — 新建时加选中框
  - `engine/advanced.js buildNode` — 同上
  - `editor/editor.js applySelection(id)` — 动态选中时:原注释写的是「编辑模式隐藏,非编辑模式显示」,逻辑 `if (id && !this.enabled)`;改为 `if (id && this.enabled)` 只有编辑模式开启时才给节点加 `.dm-selected` 描边。深度批量纯高级(描边高亮)保留,不受此条件影响。

### 6. 当前弹幕池排版损坏修复
- 根因:前几轮的清理脚本(清僵尸弹幕 dp-row)误删 HTML 结构时,损坏了 `danmaku-pool` 区块:
  1. L731 出现孤立 `</div>`,导致结构断裂。
  2. `#dp-filter-panel` 写成 `<div … hidden=""></div>`(空容器)但筛选表单挂在外层,**完全不在 hidden 容器内**,打开即显示且不可控。
  3. `#dp-list` 残留 `</tbody></table></div></div>` 垃圾闭合标签。
  4. **`#dp-list-table-wrap` 完全缺失**(`list._renderPoolList()` 第一判断就是 `if (!list || !tableWrap) return`,没有这个 id **弹幕池列表永远空白**)。
  5. 「展示列」panel 是空 div(`dp-columns-panel`),`#dp-cols-apply`、`#dp-cols-close`、所有 `data-col` 复选框全部无。
  6. 筛选控件缺 `dp-f-text`(内容关键字)、`dp-f-from` / `dp-f-to`(出现时间 from~to),导致 `_syncPoolControlsFromState` 同步时这几个永远 undefined。
- **修复**:整块重写 `id=danmaku-pool` HTML 结构,严格顺序:title → dp-info → dp-controls(10 个按钮/控件)→ dp-columns-panel(10 个 data-col 复选 + cols-close/cols-apply 两个按钮)→ dp-filter-panel(3 行筛选:内容+时间范围 / 类型子类型发送人 / 清空应用按钮)→ dp-list(包含 `#dp-list-table-wrap` 子 div)→ dp-jump。最终所有 20+ id 都可在 JS 绑定中命中,`_renderPoolList()` 的 `tableWrap!==undefined` 不再提前 return。

### 7. 彻底清除所有硬编码&僵尸弹幕
- 「打开程序总是弹本地弹幕池」:根因 ① 前几轮浏览器调试时 `class=confirm-modal` 被序列化回源码(用户误保存);② 舞台 `.dm.dm-normal selected`(d043 那条"方法")和 `data-dm-id="d001"`("欢迎使用…") / `d002`(高级编辑模式引导) 三组弹幕渲染 DOM 被写入 index.html。
- 「start.json 仍有 demo 弹幕导致启动时自动加载」:根因 `controls.loadStartDanmaku()` 在启动时调用 ensureStartDanmaku→读 start.json→如果 comments 非空就灌进 store。
- **清理动作**:
  1. index.html 舞台区域删除所有 class 为 `dm dm-normal`、`dm dm-advanced`、`dm-preview` 的 div(合计 2.6KB)。
  2. `#list-body` 清空唯一硬编码行 `.list-row selected data-id="d043"`;`#list-count` 从 `(1)` → `(0)`。
  3. `danmaku-pool` 区块在结构重建时同时清了所有 dp-row 残留(见第 6 条)。
  4. 确认 `danmaku-library` / `danmaku-pool` / `file-dialog` / `settings-dialog` 四个 `.fd` 全部带 `hidden=""`。
  5. **start.json 改为最小空模板**:`{"version":1,"p":{"timeBase":1000},"comments":[]}`。这样首次启动、本地弹幕池里没有 start.json 时复制进 userData 的也是空弹幕池,不再出现"欢迎使用 B 站弹幕模拟器"等 demo 弹幕。
- 唯一保留的"友善文案"是底部发送栏输入框的 placeholder「发个友善的弹幕见证当下」——UI 引导文本,非数据。

### 8. 自定义通用确认弹窗 `showConfirmModal`(用于 + 创建弹幕池等场景)
- **位置**:新增在 `js/data/io.js` confirmDialog 之后,导出 `showConfirmModal: showConfirmModal`,供 controls 等 renderer 调用。
- **调用约定**:返回 `Promise<true | 'secondary' | null>` 三态,真 boolean / string / null 三分支分别对应主按钮 / 次按钮 / 完全取消(×关闭 / Esc / 点遮罩),**不再混用 boolean**(避免次按钮语义和「取消整个流程」混为一谈)。
- **视觉**:新增 `.confirm-modal`(fadeIn)、`.cm-box`(缩放弹出动画)、`.cm-close`(× 右上角 hover 白 + 半透底,title="关闭(完全取消)")、`.cm-primary` / `.cm-secondary`(fd-btn 风格,主按钮用 accent 蓝)。CSS 块在 base.css `.fd-title` 之后插入,约 80 行。
- 键盘支持:**Enter → true**,**Esc → null**。
- 注意:其它位置老 `confirmDialog`(删除文件 / 侧车提示等)保留 boolean 语义不动,仅新 +创建 场景用三态。

### 9. 打包 & 应用图标配置(源:程序封面-cropped.svg → 图标:程序封面.ico)
- **图标源**:`程序封面-cropped.svg`(915×957 矢量,大尺寸)。最终打包 exe/安装包图标与运行时窗口图标统一用 **`程序封面.ico`**(已用 sharp 从 svg 重新生成,含 16/24/32/48/64/128/256 七种尺寸,32 位深)。
- **`package.json`**(electron-builder 打包图标):
  - `build.icon = "程序封面.ico"`(顶层与 `win.icon` 同)——Windows 打包图标。
  - `build.files` 含 `"up_pb.svg"`、`"程序封面-cropped.svg"`、`"程序封面.ico"`(svg 源 + ico 产物都进安装包/resources)。
- **`electron/main.js` BrowserWindow.icon** = `程序封面.ico`(Windows 下 .svg 不可直接作为 BrowserWindow.icon,必须 .ico)。
- **换图标流程**:改 `程序封面-cropped.svg` → 用 sharp 重生成多尺寸 ico(`sharp(svg).resize(16..256,{fit:'cover'}).png()` 组装 ICO 容器)→ 覆盖 `程序封面.ico`。
- **旧命名已废弃**:早期文档里的 `程序封面.svg`(无 `-cropped`)文件不存在,勿再引用。

### 10. 其它
- 清理脚本 `_check.js / _check2.js / _clean.js / _clean2.js / _clean_final.js` 均已从项目根目录删除,避免残留临时文件。
- 所有改动文件均通过 `node --check` 语法校验(js/main、js/player/controls、js/data/io、js/engine/normal+advanced、js/editor/editor+list、electron/main、electron/ipc+preload)。
- 「+创建弹幕池」自定义弹窗在屏幕中间弹出,宽 380px,最大 z-index 400(比 .fd 默认 300 高,盖在本地弹幕池/当前弹幕池弹窗之上),保证不会被遮挡。

### 11. 撤回栈 + 脏状态 + 退出拦截 + 启动加载(2026-08-29 本轮)
#### 11.1 切换/创建/替换导入后清空撤回栈,防止弹幕池持续占用内存
- 引入 `Controls._clearUndoHistory() → App.undo.clear()`:统一清空 `UndoManager.history & future`,以下 5 个替换型操作后均调用:
  1. `_importAuto` 所有替换型导入分支(包括工具栏导入、库行打开、库导入新弹幕、创建新空池后打开);
  2. `_doCreateEmptyPool` 清库时;
  3. `_importNewDanmaku` 保存入库成功后;
  4. 启动 `loadStartDanmaku` 无论成功/失败(含空池兜底);
- `UndoManager.clear()` 本身保留 `store` 引用,仅 length=0 两个数组并 `_notify`,不会破坏后续 onBeforeMutate 快照订阅。

#### 11.2 脏状态追踪 `hasUnsavedChanges()` + 基线 `_markBaselineSaved(text)`
- Controls 新增三个字段:`_savedBaseline`(上次成功写入磁盘的完整 JSON 文本)、`_dirtyOverride`(显式 boolean 优先级最高,用于空池/手动导入场景)、`_quitPending`(退出弹窗防重入)。
- 基线打标点:① 创建空池(空 JSON 文本)、② saveDanmakuFile 两分支成功写盘后、③ 库行点击切换打开(磁盘原始文本)、④ 库导入新弹幕入库成功后(导入原文本)、⑤ 启动 loadStartDanmaku 导入成功/空池兜底。
- 脏判定避免格式误判:`hasUnsavedChanges()` 做「规范化对象比较」— JSON.parse 前先剥 `\uFEFF`(UTF-8/16 BOM 代理项)后 parse,只比较 `version / comments(兼容 p.comments 旧结构) / video` 三字段,忽略 start.json 残留的 `p:{timeBase}`、`_` 等无关字段;parse 失败退化到去空白字符串比较。
- **BOM 双端清除**:Electron ipc.js 注册通用 `_stripBom()`,在 4 处文件读取(`open-file / read-danmaku-file / list-danmaku-files 快速 meta / ensure-start-danmaku`)与 3 处弹幕文件写入(`save-file / save-to-path / save-library-entry`)统一剥除 BOM,保证磁盘与渲染层基线都无 BOM 字符;`io.js` fetch('start.json') 浏览器兜底分支也在 resolve 返回前剥 BOM,避免部分环境 `JSON.parse('\uFEFF{...}')` SyntaxError 与脏判定误判。
- 所有「未保存改动」询问入口统一走 `hasUnsavedChanges()`:(工具栏导入/库切换/库导入/创建/退出共 5 处),不再只用 `store.count() > 0`(旧逻辑只看条数会把"打开已有文件未编辑"也判为有改动)。

#### 11.3 创建/导入/切换三弹窗红字「此操作不可撤销！」+ 样式一致
- `io.js showConfirmModal` 改造:正文不再用 `textContent`,改为「HTML 转义 → 正则替换标记短语为红字 span(color:#ff4d4f;font-weight:700) → `\n` 转 `<br>`」。`base.css .cm-message` 改为 `white-space:normal;word-break:break-word`。
- 提取 `Controls._promptSaveBeforeReplace(mode: 'create'|'import'|'switch'|'quit')` 统一三态弹窗,按钮名与导语按 mode 动态拼接:
  - **create**(创建新弹幕池):主「保存并创建」、次「不保存直接创建」、导语"创建新弹幕池会彻底清除当前的改动,请问是否保存当前的改动?**此操作不可撤销！**"
  - **import**(替换导入弹幕):主「保存并导入」、次「不保存直接导入」;"导入弹幕会替换掉当前弹幕池的内容,请问是否保存当前的改动?**此操作不可撤销！**"
  - **switch**(【本地弹幕池】里切换弹幕池=新需求):主「保存并打开」、次「不保存直接打开」;"切换弹幕池会彻底清除当前的改动,请问是否保存当前的改动?**此操作不可撤销！**"
  - **quit**(退出程序):主「保存并退出」、次「不保存直接退出」;"您有未保存的改动,请问是否保存后退出程序?**此操作不可撤销！**"
- ×/Esc/遮罩点击 → 全部返回 `null`,=**完全取消本次操作**(不切换、不导入、不创建、不退出),与图中行为一致。
- 入口脏检查:4 处(`openDanmakuDialog/库行click/_importNewDanmaku/_createEmptyDanmakuPool`)均先 `if (hasUnsavedChanges()) 弹三态`,无脏直接执行;主按钮选择时 `Promise.resolve(saveDanmakuFile({silent:true})).finally(执行)`,保存成败都继续。

#### 11.4 保存逻辑完整性梳理 + 文件 mtime 自动刷新
- 保存唯一入口 `Controls.saveDanmakuFile(opts?)` 返回 `Promise<boolean>` 便于 await 串行化:
  - **场景 A 已关联本地文件(_currentLibId 有值)** → `DanmakuIO.updateLibraryEntry(id, text) → window.api.saveToPath → ipc save-to-path → fs.writeFileSync(path, text, 'utf8')`。`fs.writeFileSync` 在 Windows 下会把对应文件的 **修改时间(mtimeMs)自动刷新为系统当前时间**,因此刷新【本地弹幕池】时 `fs.statSync(p).mtimeMs` 会看到时间戳变化,不需要额外 utimesSync。
  - **场景 B 未关联文件** → `DanmakuIO.saveFile(默认名+默认本地弹幕池目录) → 原生 saveFile dialog → writeFileSync → 返回路径 → 赋值 _currentLibId=res.path`,后续 Ctrl+S 走场景 A。
  - 保存成功 **一定会** `_markBaselineSaved(text)` 重打基线。
- 编辑器"保存"(=面板「更改」按钮或 Ctrl+S)链路:`validateAndSend → store.commitEdit(rec.id)` 修改 store.comments 数组中记录字段 → 用户继续点工具栏「另存为/保存」按钮(快捷键 Ctrl+Shift+S 或按钮)时 `saveDanmakuFile()` 构建新 JSON → `writeFileSync` 覆盖磁盘并刷新 **stat mtime**(系统级自动完成)。
- Ctrl+S(单条弹幕的面板更改)不是文件保存,文件保存只能由 `#btn-save / saveDanmakuFile()` 触发,保证用户不会误操作覆盖磁盘文件。

#### 11.5 程序关闭前弹三态保存提示(× = 取消退出,保留程序不关闭)
- **Electron 主进程** [electron/main.js](file:///e:/Admin/file/高级弹幕模拟器开发/app/electron/main.js#L34-L53):在 `mainWindow.on('close', e)` 拦截,`e.preventDefault()` 禁止直接关闭,require(`./ipc.js`).`quitFlowRequestCheck(win)` 调用 `win.webContents.executeJavaScript('window.__quitFlowCheck()')`(30 秒超时兜底防卡死)。返回 `{allowQuit:true}`(或 null/异常)则跳过拦截并 `mainWindow.destroy()`,否则保持窗口打开(=取消退出)。
- **Electron ipc.js** 导出 `quitFlowRequestCheck(win)` 独立函数(不污染 IPC 注册命名空间);异常/超时都 resolve true(允许退出),避免用户关不掉程序。
- **渲染层 js/main.js** 末尾挂 `window.__quitFlowCheck()`,返回 Promise<`{allowQuit:boolean}`>:
  - 无脏 → `{allowQuit:true}` 立即通过。
  - 有脏 → 调 `_promptSaveBeforeReplace('quit')` 三态:
    - `null`(×/Esc/遮罩) → `{allowQuit:false}` **取消退出,不执行任何保存,仅关闭弹窗**;
    - `true`(保存并退出) → `await saveDanmakuFile({silent:true})` 尽力保存后 `{allowQuit:true}`;
    - `'secondary'`(不保存直接退出) → `{allowQuit:true}`。
  - `_quitPending` 防重入:弹窗未处理完再次收到 close → 取消退出(保留上下文)。
- **浏览器预览兜底**:main.js 末尾 `window.addEventListener('beforeunload')` 脏时写 `e.returnValue = 提示文字`,浏览器原生弹离开提示(Electron 被 main.close 拦截不触发 beforeunload)。

#### 11.6 启动加载策略:start.json → 最近修改弹幕池 → 空白
- 重写 `Controls.loadStartDanmaku()`:三步走,都失败静默不 toast:
  1. **优先 start.json**:Electron 走 `ensureStartDanmaku()`(本地弹幕池目录无则从应用模板复制,保证不会丢失存在性);浏览器 `fetch('start.json')`。解析成功 + comments 非空 → 打开为当前弹幕池(打基线、记录 `_currentLibId=path`、清撤回)。
  2. **空则 fallback**:`io.listLibraryEntries()` 取 entries 按 mtime 降序,**跳过 start.json(已尝试过)** 顺序 `readLibraryEntry` 尝试,第一个 comments 非空即打开,成功同上。
  3. **都不行 → 空列表**:空基线、`_currentLibId=Name=null`,清撤回,让用户去「导入弹幕 / +创建」。
- 空 start.json(`comments=[]`)不再导致舞台显示 demo 弹幕,用户也不会"明明没弹却被问是否保存"。

## 本地标准 JSON(简化)
普通:`{id,sender,type:"normal",content,time:"hh:mm:ss[.cc]",mode:"scroll|top|bottom",fontSize:"small|standard|large",color,isUp,colorful?}`。
高级:`{id,sender,type:"advanced",content,time,style:{color,fontSize,fontFamily,stroke},rotation:{z,y},life:{duration,opacityStart,opacityEnd},motion:{moveDuration,delay,linear,type:"position"},position:{usePercent,startX,startY,endX,endY}}`。
XML→本地:mode=7 高级 `<d>` 文本是 JSON 数组,映射表见 `parserXml.js`(content 文本正则提取参数优先级 > 数组值)。
