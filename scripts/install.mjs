import { copyFile, mkdir, readdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 本机可能同时存在两个 Tavern：桌面/Next 用 ~/.dsh，独立 CLI 服务用 ~/.dsh-tavern。
// 插件只有装进「当前 Tavern 实际使用的那份数据目录」才会被加载，所以逐个探测。
function candidates() {
  if (process.env.DSH_TAVERN_PLUGIN_DIR) return [process.env.DSH_TAVERN_PLUGIN_DIR]
  const home = os.homedir()
  const found = []
  for (const rootDir of ['.dsh-tavern', '.dsh', '.dsh-desktop']) {
    const plugins = path.join(home, rootDir, 'profile-data', 'tavern', 'data', 'plugins')
    if (existsSync(plugins)) found.push(path.join(plugins, 'dsh-tavern-rewrite'))
  }
  return found.length ? found : [path.join(home, '.dsh', 'profile-data', 'tavern', 'data', 'plugins', 'dsh-tavern-rewrite')]
}

const targets = candidates()

for (const target of targets) {
  await mkdir(path.join(target, 'lib'), { recursive: true })
  for (const file of ['package.json', 'index.mjs', 'client.js', 'README.md', 'config.example.json']) {
    await copyFile(path.join(root, file), path.join(target, file))
  }
  for (const file of await readdir(path.join(root, 'lib'))) {
    if (file.endsWith('.mjs')) await copyFile(path.join(root, 'lib', file), path.join(target, 'lib', file))
  }

  const targetConfig = path.join(target, 'config.json')
  const sourceConfig = path.join(root, 'config.json')
  if (!existsSync(targetConfig) && existsSync(sourceConfig)) {
    await copyFile(sourceConfig, targetConfig)
    await chmod(targetConfig, 0o600)
  }

  console.log('已更新 ' + target)
  if (!existsSync(targetConfig)) {
    console.log('  没有 config.json；这不影响使用，密钥请在 Tavern 的「revnovel润色」面板里配置。')
  }
}

console.log('宿主侧改动要重启 Tavern 服务；浏览器侧刷新页面。')
