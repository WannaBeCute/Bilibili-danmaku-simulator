# 高级弹幕模拟器
基于 Electron + 原生 JS + DOM 渲染的**桌面弹幕模拟器**:
目前支持滚动弹幕，固定弹幕(顶部和底部)，高级弹幕。暂不支持逆向弹幕，bas弹幕，flash格式代码
可导入XML/ASS/JSON格式的弹幕文件，也可以导出XML/ASS/JSON格式的弹幕文件

> 目前项目还未完善，特别是：部分文本字体效果还未达到与B站渲染效果一致，比如微软雅黑下的“█”,在B站里长度几乎为1em，方块之间几乎没有空隙（在高级弹幕作品，常用于填充背景）。所以当前项目还在研究不同字体下特殊字符的渲染效果差别。
## 项目参考来源

> 本项目参考了前辈的一些源码,运用 **Claude + Trae** 开发,属于 **Vibe Coding** 产物。

代码层面的移植(上游均为 MIT 协议,详见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES)):

- **轨道碰撞避让**与**滚动位移算法**:移植自 [danmu-lib](https://github.com/Mr-Quin/danmu-lib) `engine.ts` / `track.ts`
- **顶/底固定弹幕槽位栈** `DanmakuStack`:移植自 danmaku-anywhere `packages/danmaku-engine/src/plugins/fixedDanmaku.ts`

本项目采用 [MIT](./LICENSE) 协议。

## 功能

- **播放**
  - 打开本地视频同步播放弹幕(`<video>` 元素)
  - 不播放视频时,以**虚拟时钟**纯播放弹幕
  - 背景色可设:跟随系统(默认)/ 黑 / 白 / 深灰 / 自定义
  - 播放/暂停、进度条(两种模式通用 seek)、倍速(0.5~2x)、全局字号/透明度
- **编辑**
  - 工具栏开启「编辑模式」→ 点击屏幕上任一弹幕选中(虚线高亮)
  - **普通弹幕面板**(深色):类型(普通/字幕)、模式(滚动/顶部/底部)、字号(小/标准/大)、色板、大会员专属渐变色、UP 主标识、发送人、时间、内容
  - **高级弹幕面板**(浅色):正文、时间、外观样式(颜色/字号/字体/描边)、空间旋转(Z/Y 轴)、生命周期(生存时间/透明度渐变)、运动周期(耗时/延迟/线性/位置或路径)、坐标(像素/百分比 + 点击舞台「拾取」取坐标 + 路径连续加点)
  - 改动**实时生效**;弹幕列表可增删/选中
- **数据**
  - 导出为标准 JSON(带 video 标注),**侧车自动关联**:打开视频自动加载同目录「视频名.json」,保存默认存视频同目录
  - 导入 B站 XML、弹弹play XML、**ASS/SSA** 字幕(后台自动转换),也支持 JSON

## 目录结构

```
app/
├─ index.html            # 入口(双击浏览器直接打开即可开发测试)
├─ css/                  # 布局/舞台/双面板/列表样式
├─ js/
│  ├─ util/              # 时间/颜色/DOM 工具
│  ├─ data/              # store、JSON 转换、XML/ASS 解析、序列化、文件 IO
│  ├─ engine/            # Clock 统一时间源、轨道碰撞、普通弹幕、高级弹幕、调度主控
│  ├─ editor/            # 编辑模式/命中/拾取、双面板、列表
│  ├─ player/            # 视频/虚拟双模式、控制条
│  └─ main.js            # 装配启动(含演示弹幕)
├─ electron/             # Electron 主进程/preload(文件读写 + 侧车探测)
└─ package.json          # electron + electron-builder 配置
```

## 运行

浏览器直接开发测试:双击 `index.html`。

```bash
npm install          # 安装 electron / electron-builder(首次)
npm start            # Electron 窗口运行
npm run dist         # 构建便携版单 exe(dist/DanmuSimulator-*.exe)
```

## JSON 数据格式

信封(含 video 标注):

```json
{
  "version": 1,
  "video": { "filename": "ep01.mp4", "path": "D:/video/ep01.mp4", "duration": 1234.5 },
  "comments": []
}
```

普通弹幕:

```json
{
  "id": "d001", "sender": "uid", "type": "normal",
  "content": "你好世界", "time": "00:00:02",
  "mode": "scroll", "fontSize": "standard", "color": "#FFFFFF",
  "isUp": false, "colorful": 60001
}
```

高级弹幕:

```json
{
  "id": "d002", "sender": "用户昵称", "type": "advanced",
  "content": "高级弹幕", "time": "00:00:02",
  "style": { "color": "#FF0000", "fontSize": 36, "fontFamily": "黑体", "stroke": true },
  "rotation": { "z": 57, "y": 56 },
  "life": { "duration": 4.5, "opacityStart": 1, "opacityEnd": 0.1 },
  "motion": { "moveDuration": 8000, "delay": 1000, "linear": true, "type": "position", "path": [] },
  "position": { "usePercent": false, "startX": 289, "startY": 204, "endX": 507, "endY": 339 }
}
```

> 时间 `time` 用 `hh:mm:ss`(小数秒写作 `hh:mm:ss.cc`,导入导出不丢精度)。

## 实现原理(简述)

- **轨道碰撞避让**(移植 danmu-lib `engine.ts:_getTrack`):舞台按轨道高切 N 条水平轨道,随机挑轨道、检查最后一条弹幕 `已移动距离 ≥ gap + 自身宽` 才可复用,全满 strict 丢弃;滚动弹幕独占轨道。
- **滚动动画**:CSS transition(`transform: translateX`),位移用解析式 `(now - start) / D * (W + w)` 计算(供碰撞),暂停时写回当前位置、恢复按剩余时长重放。
- **顶/底固定**:槽位栈(顶从 0、底从 -1 起排),满则丢弃。
- **高级弹幕**:双层节点(外层 `translate3d`+`opacity` 由运动写死,内层 `rotateZ/rotateY`),rAF 逐帧按媒体时间插值 position/path、透明度渐变、delay 与缓动;**每帧直读 record,编辑即时生效**。
- **时间轴**:`Clock` 统一视频模式(`video.currentTime`)与虚拟模式(倍速 rAF 时钟);暂停/seek/倍速天然同步。
