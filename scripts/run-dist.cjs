const path = require('node:path')
const { spawnSync } = require('node:child_process')

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function pad(v) {
  return String(v).padStart(2, '0')
}

const now = new Date()
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const outputDir = `release/build-${stamp}`

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electronBuilderCmd = process.platform === 'win32'
  ? path.join(projectRoot(), 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(projectRoot(), 'node_modules', '.bin', 'electron-builder')

function projectRoot() {
  return path.resolve(__dirname, '..')
}

run(npmCmd, ['run', 'build'])
run(electronBuilderCmd, [`--config.directories.output=${outputDir}`])

console.log(`[dist] build complete: ${outputDir}`)
