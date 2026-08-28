/**
 * Electron 主进程:创建窗口、桥接文件读写与侧车探测。
 */
'use strict'

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null
/** 防止 close 事件递归触发拦截(用户已选择退出时跳过) */
let _allowQuit = false

function createWindow() {
  // Windows 平台 icon 用 .ico（SVG 运行时 BrowserWindow.icon 在 Windows 下偶发白方/加载失败）
  const iconPath = path.join(__dirname, '..', '程序封面.ico')
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#1e1e1e',
    title: 'B站弹幕模拟器',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // ★ 移除默认菜单栏,避免其快捷键(Ctrl+R 刷新等)干扰应用
  Menu.setApplicationMenu(null)

  // ★ 关闭前拦截:有未保存改动 → 弹"保存/不保存/取消"三态弹窗;× 关闭弹窗=取消退出
  mainWindow.on('close', async (e) => {
    if (_allowQuit) return
    e.preventDefault()
    try {
      const { quitFlowRequestCheck } = require('./ipc.js')
      const ok = await quitFlowRequestCheck(mainWindow)
      if (ok) {
        _allowQuit = true
        // setImmediate 避免同一 tick 内 destroy 导致 Electron 警告
        setImmediate(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy() })
      }
      // else: 取消退出,保持窗口
    } catch (err) {
      // 异常兜底:允许退出
      console.error('quit flow error:', err)
      _allowQuit = true
      setImmediate(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy() })
    }
  })

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'))
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ---------- 注册全部 IPC(open-file/save-file/弹幕文件库/侧车等) ---------- */
require('./ipc.js')({ app: app, ipcMain: ipcMain, dialog: dialog, BrowserWindow: BrowserWindow, fs: fs, path: path })
