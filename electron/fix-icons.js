/**
 * fix-icons.js — 打包后给生成的 exe 嵌入自定义图标。
 *
 * 背景:package.json 的 `win.signAndEditExecutable: false`(非管理员打包必需,避免解压 winCodeSign
 * 内含 darwin 符号链接失败)会同时跳过 electron-builder 的 rcedit 步骤,导致生成的 exe/安装包
 * 保留 Electron 默认图标。本脚本在 electron-builder 完成后,手动用 rcedit 把 程序封面.ico 写进:
 *   - dist/win-unpacked/<app>.exe(实际运行/被安装的应用本体)
 *   - dist/DanmuSimulator-*-portable.exe(便携版外层 exe)
 *
 * ⚠️ 绝对不能处理 NSIS 的 setup.exe:NSIS 安装器内置 CRC 完整性校验,任何在编译之后
 * 修改安装器 .exe 的操作(rcedit 改图标、手动签名)都会让它报「Installer integrity check has failed」。
 * 安装器图标由 package.json 的 `nsis.installerIcon` 在 makensis 编译期嵌入,无需(也不应)事后修改。
 *
 * rcedit 从 electron-builder 的 winCodeSign 缓存里找(构建成功后必然已下载解压)。
 *
 * 用法:node electron/fix-icons.js(在 app/ 目录下执行)
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const ROOT = path.join(__dirname, '..')
const ICON = path.join(ROOT, '程序封面.ico')

/** 在 winCodeSign 缓存里找最新的 rcedit-x64.exe */
function findRcedit() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(base)) return null
  let candidates = []
  try {
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, 'rcedit-x64.exe')
      if (fs.existsSync(exe)) {
        try { candidates.push({ path: exe, mtime: fs.statSync(exe).mtimeMs }) }
        catch (_) {}
      }
    }
  } catch (_) {}
  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].path
}

function runRcedit(rcedit, exe) {
  return new Promise((resolve) => {
    const args = [exe, '--set-icon', ICON]
    execFile(rcedit, args, { windowsHide: true }, (err) => {
      if (err) console.log('[fix-icons] ✗ ' + path.basename(exe) + ': ' + err.message)
      else console.log('[fix-icons] ✓ ' + path.basename(exe))
      resolve(!err)
    })
  })
}

async function main() {
  if (!fs.existsSync(ICON)) { console.log('[fix-icons] 缺少 程序封面.ico,跳过'); return 1 }
  const rcedit = findRcedit()
  if (!rcedit) { console.log('[fix-icons] 未找到 rcedit(winCodeSign 缓存),跳过'); return 1 }

  const targets = []
  const unpacked = path.join(ROOT, 'dist', 'win-unpacked')
  if (fs.existsSync(unpacked)) {
    for (const f of fs.readdirSync(unpacked)) {
      if (/\.exe$/i.test(f)) targets.push(path.join(unpacked, f))
    }
  }
  const distDir = path.join(ROOT, 'dist')
  if (fs.existsSync(distDir)) {
    for (const f of fs.readdirSync(distDir)) {
      // ★ 只处理 portable 外层 exe;setup.exe(NSIS)绝不能碰,否则破坏其 CRC 完整性校验
      if (/portable\.exe$/i.test(f)) targets.push(path.join(distDir, f))
    }
  }
  if (!targets.length) { console.log('[fix-icons] 未找到可处理的 exe,跳过'); return 1 }

  let ok = 0
  for (const t of targets) { if (await runRcedit(rcedit, t)) ok++ }
  console.log('[fix-icons] 完成 ' + ok + '/' + targets.length)
  return ok > 0 ? 0 : 1
}

main().then((code) => process.exit(code)).catch((e) => { console.error('[fix-icons] 异常', e); process.exit(1) })
