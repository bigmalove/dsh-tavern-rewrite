import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SETTINGS } from '../lib/settings.mjs'

// 发版最容易漏的三处：package.json 版本、请求 UA 里的版本、README 顶部的版本说明。
// 这里把它们绑在一起，漏一处测试就红。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function read(rel) {
  return readFile(path.join(root, rel), 'utf8')
}

test('发版一致性：package.json 版本与 UA 一致', async () => {
  const pkg = JSON.parse(await read('package.json'))
  const api = await read('lib/api.mjs')
  const ua = /dsh-tavern-rewrite\/(\d+\.\d+\.\d+) \(/.exec(api)
  assert.ok(ua, 'lib/api.mjs 里找不到 dsh-tavern-rewrite/<version> 形式的 User-Agent')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(ua[1], pkg.version, 'USER_AGENT 版本必须和 package.json 一致')
})

test('发版一致性：README 顶部有当前版本的说明', async () => {
  const pkg = JSON.parse(await read('package.json'))
  const readme = await read('README.md')
  assert.ok(
    readme.includes('> ' + pkg.version + '：'),
    'README 里要有以 "> ' + pkg.version + '：" 开头的一段版本说明'
  )
})

test('配置示例：字段都存在于默认设置里', async () => {
  const example = JSON.parse(await read('config.example.json'))
  const known = new Set(Object.keys(DEFAULT_SETTINGS))
  const unknown = Object.keys(example).filter(key => !known.has(key))
  assert.deepEqual(unknown, [], 'config.example.json 出现了默认设置里没有的字段')
})

test('配置示例：覆盖流式润色的两个开关', async () => {
  const example = JSON.parse(await read('config.example.json'))
  assert.equal(example.stream, DEFAULT_SETTINGS.stream)
  assert.equal(example.streamMinChars, DEFAULT_SETTINGS.streamMinChars)
})
