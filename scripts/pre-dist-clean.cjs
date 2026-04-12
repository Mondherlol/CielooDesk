const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const winUnpackedDir = path.join(projectRoot, 'release', 'win-unpacked')

function killLikelyLockingProcessesOnWindows() {
  if (process.platform !== 'win32') return
  if (!fs.existsSync(winUnpackedDir)) return

  const normalizedTarget = winUnpackedDir.replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$target = (Resolve-Path '${normalizedTarget}').Path

# Kill known app process names first.
Get-Process -Name 'CielooPos','electron' | Stop-Process -Force

# Kill any process whose executable lives in release\\win-unpacked.
Get-CimInstance Win32_Process |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like "$target*") } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
`

  spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
  })
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeWithRetries(targetPath, retries = 8, delayMs = 350) {
  let lastError = null
  for (let i = 0; i < retries; i += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true })
      return
    } catch (err) {
      lastError = err
      if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY')) {
        throw err
      }
      sleep(delayMs)
    }
  }
  throw lastError
}

if (fs.existsSync(winUnpackedDir)) {
  killLikelyLockingProcessesOnWindows()
  try {
    removeWithRetries(winUnpackedDir)
  } catch (err) {
    const code = err && err.code ? String(err.code) : 'UNKNOWN'
    console.warn(`[predist] cleanup skipped (${code}): ${winUnpackedDir}`)
  }
}

console.log('[predist] release/win-unpacked cleaned')
