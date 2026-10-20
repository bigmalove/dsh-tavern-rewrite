import { copyFile, mkdir, readdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.DSH_TAVERN_PLUGIN_DIR
  || path.join(os.homedir(), '.dsh', 'profile-data', 'tavern', 'data', 'plugins', 'dsh-tavern-rewrite')

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
console.log('宿主侧改动要重启 DSH/Tavern；浏览器侧刷新页面。')
if (!existsSync(targetConfig)) {
  console.log('还没有 config.json：可以在 Tavern 的「润色」面板里填密钥，或建一个 ' + targetConfig)
}
