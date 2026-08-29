/**
 * after-pack.js — electron-builder `afterPack` 钩子(仅 win 打包生效)。
 *
 * 背景:`win.signAndEditExecutable: false`(非管理员必需)会跳过 electron-builder 的 rcedit,
 * 导致打包 exe 保留 Electron 默认图标。本钩子在「应用目录打包完成、生成目标产物之前」运行,
 * 用 rcedit 把 程序封面.ico 写进 appOutDir 下的应用 exe —— 这样无论构建 portable / nsis / msix,
 * 打进包里的 exe 都带自定义图标(msix/appx 的 Start 磁贴图标另由 build/appx/*.png 提供)。
 *
 * rcedit 从 electron-builder 的 winCodeSign 缓存里找(构建成功后必然已下载解压)。
 *
 * 配置:package.json build.afterPack = "electron/after-pack.js"
 * 用法:由 electron-builder 自动调用;也可 node electron/after-pack.js <appOutDir> 手动跑。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

function findRcedit() {
  const base = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(base)) return null
  let candidates = []
  try {
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, 'rcedit-x64.exe')
      if (fs.existsSync(exe)) {
        try { candidates.push({ path: exe, mtime: fs.statSync(exe).mtimeMs }) } catch (_) {}
      }
    }
  } catch (_) {}
  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].path
}

function runRcedit(rcedit, exe, icon) {
  return new Promise((resolve) => {
    execFile(rcedit, [exe, '--set-icon', icon], { windowsHide: true }, (err) => {
      if (err) console.log('[after-pack] ✗ ' + path.basename(exe) + ': ' + err.message)
      else console.log('[after-pack] ✓ ' + path.basename(exe) + ' 已嵌入自定义图标')
      resolve(!err)
    })
  })
}

async function applyIconToAppOutDir(appOutDir) {
  const root = path.resolve(__dirname, '..')
  const icon = path.join(root, '程序封面.ico')
  if (!fs.existsSync(icon)) { console.log('[after-pack] 缺少 程序封面.ico,跳过'); return }
  if (!appOutDir || !fs.existsSync(appOutDir)) { console.log('[after-pack] appOutDir 不存在: ' + appOutDir + ',跳过'); return }
  const rcedit = findRcedit()
  if (!rcedit) { console.log('[after-pack] 未找到 rcedit(winCodeSign 缓存),跳过'); return }
  const exes = fs.readdirSync(appOutDir).filter((f) => /\.exe$/i.test(f))
  for (const f of exes) await runRcedit(rcedit, path.join(appOutDir, f), icon)
}

// electron-builder afterPack 钩子入口
module.exports = async function afterPack(context) {
  try {
    const appOutDir = context && context.appOutDir
    await applyIconToAppOutDir(appOutDir)
  } catch (e) {
    console.log('[after-pack] 异常(不影响打包继续): ' + (e && e.message))
  }
}

// 支持命令行手动运行:node electron/after-pack.js <appOutDir>
if (require.main === module) {
  const arg = process.argv[2]
  applyIconToAppOutDir(arg ? path.resolve(arg) : path.join(__dirname, '..', 'dist', 'win-unpacked'))
    .then(() => process.exit(0))
    .catch((e) => { console.error('[after-pack] 异常', e); process.exit(1) })
}
