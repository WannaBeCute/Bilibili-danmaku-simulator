/**
 * Electron 主进程:创建窗口、桥接文件读写与侧车探测。
 */
'use strict'

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#1e1e1e',
    title: 'B站弹幕模拟器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // ★ 移除默认菜单栏,避免其快捷键(Ctrl+R 刷新等)干扰应用
  Menu.setApplicationMenu(null)
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
