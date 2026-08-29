/**
 * Electron preload:通过 contextBridge 暴露文件读写 API 给渲染层。
 * 渲染层 io.js 检测 window.api 存在即走 Electron 路径。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  saveToPath: (opts) => ipcRenderer.invoke('save-to-path', opts),
  checkSidecar: (opts) => ipcRenderer.invoke('check-sidecar', opts),
  getDanmakuDir: () => ipcRenderer.invoke('get-danmaku-dir'),
  chooseDanmakuDir: () => ipcRenderer.invoke('choose-danmaku-dir'),
  // ★ 直接设置本地弹幕库根目录(用于手动输入路径后提交)
  setDanmakuDir: (opts) => ipcRenderer.invoke('set-danmaku-dir', opts),
  listDanmakuFiles: () => ipcRenderer.invoke('list-danmaku-files'),
  saveDanmakuToDir: (opts) => ipcRenderer.invoke('save-danmaku-to-dir', opts),
  readDanmakuFile: (opts) => ipcRenderer.invoke('read-danmaku-file', opts),
  // ★ 确保本地弹幕池存在 start.json(预览弹幕),无则从模板创建
  ensureStartDanmaku: () => ipcRenderer.invoke('ensure-start-danmaku'),
  // ★ 删除本地弹幕池中的指定文件
  deleteDanmakuFile: (opts) => ipcRenderer.invoke('delete-danmaku-file', opts),
  // ★ confirm:Electron 中 window.confirm() 不可靠,用原生 dialog 替代
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  // ★ 打开系统文件管理器定位到目录或文件
  openPath: (opts) => ipcRenderer.invoke('open-path', opts),
  // ★ 在系统默认浏览器打开外部 URL(双击标题跳转仓库)
  openExternal: (opts) => ipcRenderer.invoke('open-external', opts),
  // ★ 显示缩放:读取系统 DPI 系数(用于"自动适配屏幕DPI"计算 1px 的标准物理大小)
  getDisplayScaleFactor: () => ipcRenderer.invoke('get-display-scale-factor'),
})
