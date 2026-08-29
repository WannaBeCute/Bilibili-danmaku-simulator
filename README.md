# B站弹幕模拟器

这是一个可以高度自定义编辑B站弹幕的程序，这里的高级弹幕指的是广义上的意思，也就是m7弹幕，可以在编辑器里自由拖拽，变形，甚至可以多个高级弹幕批量修改，并且每次做完弹幕都可以直接预览，效果与B站实际效果没有太大的差别

目前支持滚动弹幕，固定弹幕(顶部和底部)，高级弹幕。暂不支持逆向弹幕，bas弹幕，flash格式代码

可导入XML/ASS/JSON格式的弹幕文件，也可以导出XML/ASS/JSON格式的弹幕文件

> 目前项目还未完善，~~特别是：部分文本字体效果还未达到与B站渲染效果一致，比如微软雅黑下的“█”~~ 这个已经修复了，但是和B站实际效果还是差了些，啧。除了这个，目前体验上还有很多需要优化的地方

##  完整程序下载

直接点击下面的下载链接即可下载

> **国内用户推荐使用下列链接（密码：0000）**

| 版本 | 下载链接 | 说明 |
| :--- | :--- | :--- |
| **MSIX 安装版** | [点击下载](https://wwbli.lanzouq.com/i8Fsu45ar1be) | 推荐，运行快，如果运行无反应请重启电脑再尝试|
| **便携版(免安装版)** | [点击下载](https://wwbli.lanzouq.com/ipk3p45aqz0b) | 下载即用，适合携带 |

## 项目参考来源

> 本项目参考了前辈的部分源码,利用 **Claude + Trae** 开发,是 **Vibe Coding** 产物。

代码层面的移植(均为 MIT 协议,详见 [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES)):

- **轨道碰撞避让**与**滚动位移算法**:移植自 [danmu-lib](https://github.com/Mr-Quin/danmu-lib) `engine.ts` / `track.ts`
- **顶/底固定弹幕槽位栈** `DanmakuStack`:移植自 danmaku-anywhere `packages/danmaku-engine/src/plugins/fixedDanmaku.ts`

本项目采用 [MIT](./LICENSE) 协议。

<details>
  <summary><h2>部分功能展示 <small>（点击可展开）</small></h2></summary>

- **播放**
  - 打开本地视频同步播放弹幕(`<video>` 元素)，不播放视频时,以**虚拟时钟**纯播放弹幕
    ![Image](https://github.com/user-attachments/assets/c7baedc2-76c3-44df-9636-236ed444372b)
  - 背景色可设:跟随系统(默认)/ 黑 / 白 / 深灰 / 自定义
    ![Image](https://github.com/user-attachments/assets/9aa09dfb-724d-42c2-9dd5-7d62f61abc4e)
  - 弹幕展示设置
    ![Image](https://github.com/user-attachments/assets/1035444d-50db-4780-b5e7-687a771cb638)
  - 当前弹幕池功能，可选择展示哪些弹幕
    ![Image](https://github.com/user-attachments/assets/25115674-8ae3-497c-b693-b42e99e63f44)
- **编辑**
  - 右下角开启「编辑模式」→ 点击屏幕上任一弹幕选中(虚线高亮) → Ctrl+鼠标点击批量多选高级弹幕批量编辑
    ![Image](https://github.com/user-attachments/assets/a76f9194-909d-4250-bf37-02a4308a46db)
    ![Image](https://github.com/user-attachments/assets/0aac0b27-9fe6-44cd-b586-0e19b779ab61)
  - **普通弹幕面板**:模式(滚动/顶部/底部)、字号(小/标准/大)、色板、大会员专属渐变色、UP 主标识、发送人、时间、内容
    ![Image](https://github.com/user-attachments/assets/3ebf1731-a53c-46ef-bed3-2f408eba289f)
  - **高级弹幕面板**:正文、时间、外观样式(颜色/字号/字体/描边)、空间旋转(Z/Y 轴)、生命周期(生存时间/透明度渐变)、运动周期(耗时/延迟/线性/位置或路径)、坐标(像素/百分比 + 点击舞台「拾取」取坐标)
    ![Image](https://github.com/user-attachments/assets/1275d5fc-0196-4607-af3b-3e11208d7e74)
    - **导入歌词**:可导入歌词文件(lrc)，生成歌词弹幕
      ![Image](https://github.com/user-attachments/assets/413ed520-0601-4483-bd35-257e0b8acf6d)
- **数据**
  - 可导入或导出 XML/JSON/ASS 格式的弹幕文件，目前程序用的是JSON
    ![Image](https://github.com/user-attachments/assets/c1869efd-4254-4c9d-bf12-fce3acb98c14)
  - 【本地弹幕池】功能可以记录最近编辑过的弹幕池
    ![Image](https://github.com/user-attachments/assets/1829e420-44a2-4a1e-8172-50049f17358c)

</details>

## 目录结构

```
app/
├─ index.html            # 入口(双击浏览器直接打开即可开发测试)
├─ css/                  # 布局/舞台(播放器画面)/双面板/列表样式
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

本项目采用 [MIT](./LICENSE) 协议。

## 运行

解压好项目后，直接双击 `index.html`在浏览器打开即可体验，也可以安装打包好的程序。
