import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlugin } from '../index.mjs'
import { createRewriteClient, normalizeBaseURL } from '../lib/api.mjs'
import { collectProtected } from '../lib/segments.mjs'

const NARRATION = `雨是在黄昏时分落下来的。林岚站在旧书店的门口，看着街对面那盏忽明忽暗的路灯，心里忽然生出一种说不清的预感。她把手里的伞收起来，抖了抖水，推门进去。

店里没有客人，只有柜台后面那个老人，正低头擦一只瓷杯。听见门上的铜铃响，他抬起头，眯着眼睛看了她一会儿，才慢慢开口：“你来了。”

“您知道我今晚会来？”林岚问。

老人没有回答，只是把那只瓷杯推到她面前，杯子里是刚泡好的茶，热气在昏黄的灯下缓缓上升。“找你的人，已经在路上了。”他说，“你只有一炷香的时间。”

林岚握住杯子的手微微一紧。她想起三天前收到的那封信，信纸上的字迹她认得，那是她失踪了七年的哥哥的字。信里只写了一句话：不要相信任何人，包括我。

窗外的雨越下越大，雨点砸在玻璃上，像是有人在一下一下地敲门。老人忽然伸手，把墙角那盏灯拧灭了一半。屋子里暗下来，只剩柜台上一小块暖黄的光。林岚听见自己的心跳，一下，又一下，和着雨声。

她忽然想起哥哥临走前那个晚上，也是这样大的雨。他站在院门口，回头冲她笑了一下，说等他回来，就带她去看海。那年她十二岁，海在很远的地方，远到她以为一辈子都走不到。`

function polish(text) {
  return text.replace(/忽然/g, '突然').replace(/看着/g, '望着')
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function chatCompletion(text) {
  return { id: 'x', object: 'chat.completion', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: {} }
}

function fakeFetch({ transform = polish, models = ['rewrite-v9-c600-nvfp4'], calls = [] } = {}) {
  return async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init })
    const path = new URL(String(url)).pathname
    if (path.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: models.map(id => ({ id })) })
    if (!path.endsWith('/v1/chat/completions')) return new Response('not found', { status: 404 })
    const body = JSON.parse(init.body)
    return jsonResponse(chatCompletion(transform(body.messages[0].content)))
  }
}

function makeTurn(rawText = NARRATION + '\n\n<div class="status"><span>生命：100</span></div>') {
  return {
    gameId: 'game-1',
    turn: 2,
    textVersion: 'v1',
    rawText,
    text: rawText.replace(/<[^>]+>/g, ''),
    greeting: false,
    card: { id: 'card', name: '卡' },
    variables: null,
    settledAt: 1
  }
}

async function harness(options = {}) {
  const handlers = new Map()
  const settled = []
  const tasks = []
  const timelines = []
  const removed = []
  const attachments = []
  const data = { plugin: null, saved: [] }
  let current = options.turn || makeTurn()
  let credential = options.credential || ''
  let gameSettings = options.gameSettings || { auto: true }
  const edits = []
  const calls = []
  const fetchImpl = fakeFetch({ transform: options.transform || polish, calls })

  const credentials = {
    async resolve() { return credential ? { value: credential, source: 'stored' } : undefined },
    async set(ref, value) { credential = value },
    async unset() { credential = '' }
  }

  const tavern = {
    apiVersion: 3,
    onTurnSettled(handler) { settled.push(handler); return () => {} },
    onTimelineChanged(handler) { timelines.push(handler); return () => {} },
    onGameRemoved(handler) { removed.push(handler); return () => {} },
    settlementTask(definition) { tasks.push(definition); return () => {} },
    gameSettings(definition) { tavern.definition = definition },
    async getGameSettings() { return gameSettings },
    async getTurn({ gameId, turn }) {
      return gameId === current.gameId && turn === current.turn ? structuredClone(current) : null
    },
    async getTurnState({ gameId }) {
      return { gameId, turn: current.turn, textVersion: current.textVersion, settled: true, busy: false, generating: false, settling: false }
    },
    async versionSignal() { return new AbortController().signal },
    async editTurn({ gameId, turn, textVersion, text }) {
      if (gameId !== current.gameId || turn !== current.turn || textVersion !== current.textVersion) {
        throw Object.assign(new Error('版本过期'), { code: 'TAVERN_PLUGIN_STALE_VERSION' })
      }
      edits.push({ text, sourceVersion: textVersion })
      current = { ...current, textVersion: 'v' + (edits.length + 1), rawText: text, text: text.replace(/<[^>]+>/g, '') }
      return structuredClone(current)
    },
    async attach({ item }) {
      const id = 'media-' + (attachments.length + 1)
      attachments.push({ id, item, status: 'pending', removed: false })
      return { id }
    },
    async update(id, changes) {
      const item = attachments.find(value => value.id === id)
      if (item) Object.assign(item, changes)
      return item
    },
    async remove(id) {
      const item = attachments.find(value => value.id === id)
      if (item) item.removed = true
      return Boolean(item)
    },
    async readPluginData() { return data.plugin === null ? null : structuredClone(data.plugin) },
    async savePluginData({ data: value }) { data.plugin = structuredClone(value); data.saved.push(structuredClone(value)) },
    handle(name, handler) { handlers.set(name, handler); return () => {} }
  }

  const ctx = {
    credentials,
    tavern,
    get(name) { return name === 'credentials' ? credentials : undefined },
    effect(fn) { return fn() }
  }

  const plugin = createPlugin({
    fetchImpl,
    readConfig: async () => options.config || { apiKey: 'sk-test', baseURL: 'https://example.test', model: 'rewrite-v9-c600-nvfp4', temperature: 0.15 }
  })
  await plugin.apply(ctx)

  return {
    ctx, tavern, handlers, settled, tasks, timelines, removed, attachments, data, edits, calls,
    get current() { return current },
    setCurrent(value) { current = value },
    setGameSettings(value) { gameSettings = value },
    get credential() { return credential }
  }
}

test('插件：后台结算并行预润色，结算后替换正文且不重复替换', async () => {
  const h = await harness()
  assert.equal(h.tasks.length, 1)
  assert.equal(h.tasks[0].title, '正文润色')
  assert.equal(h.tasks[0].phase, 'parallel')
  const turn = h.current
  await h.tasks[0].run({ ...turn, signal: new AbortController().signal })
  await h.settled[0](turn)
  assert.equal(h.edits.length, 1)
  assert.ok(h.edits[0].text.includes('突然'))
  assert.ok(h.edits[0].text.includes('<div class="status"><span>生命：100</span></div>'))
  assert.deepEqual(collectProtected(h.current.rawText), collectProtected(turn.rawText))
  const afterFirst = h.current
  await h.settled[0](afterFirst)
  assert.equal(h.edits.length, 1, '重入的 onTurnSettled 不再替换')
})

test('插件：没有预润色时在结算后补一次', async () => {
  const h = await harness()
  await h.settled[0](h.current)
  assert.equal(h.edits.length, 1)
  assert.equal(h.attachments.length, 1)
  assert.equal(h.attachments[0].removed, true, '替换后移除占位提示')
})

test('插件：本局关闭自动润色时不替换', async () => {
  const h = await harness({ gameSettings: { auto: false } })
  await h.tasks[0].run({ ...h.current, signal: new AbortController().signal })
  await h.settled[0](h.current)
  assert.equal(h.edits.length, 0)
  const state = await h.handlers.get('dsh-tavern-rewrite/state')({})
  assert.ok(state.recent.some(entry => entry.reason.includes('关了自动润色')))
})

test('插件：玩家手动编辑后不自动覆盖，重新生成后恢复', async () => {
  const h = await harness()
  const turn = h.current
  h.timelines[0]({ gameId: turn.gameId, kind: 'edit', turn: turn.turn, textVersion: turn.textVersion })
  await h.settled[0](turn)
  assert.equal(h.edits.length, 0)
  const regenerated = { ...turn, textVersion: 'v2' }
  h.setCurrent(regenerated)
  h.timelines[0]({ gameId: turn.gameId, kind: 'regenerate', turn: turn.turn, textVersion: 'v2' })
  await h.settled[0](regenerated)
  assert.equal(h.edits.length, 1)
})

test('插件：手动润色当前这一轮', async () => {
  const h = await harness()
  const result = await h.handlers.get('dsh-tavern-rewrite/polish')({ gameId: 'game-1', turn: 2 })
  assert.equal(result.ok, true)
  assert.equal(h.edits.length, 1)
  assert.ok(h.edits[0].text.includes('突然'))
  await assert.rejects(h.handlers.get('dsh-tavern-rewrite/polish')({ gameId: 'game-1', turn: 1 }), /最新一轮/)
})

test('插件：设置、密钥和连接测试', async () => {
  const h = await harness()
  const initial = await h.handlers.get('dsh-tavern-rewrite/state')({})
  assert.equal(initial.key.configured, true)
  assert.equal(initial.key.source, 'config')
  assert.equal(initial.settings.baseURL, 'https://example.test')

  const saved = await h.handlers.get('dsh-tavern-rewrite/save')({ settings: { temperature: 0.1, baseURL: 'https://example.test/v1', maxChars: '700' } })
  assert.equal(saved.settings.temperature, 0.1)
  assert.equal(saved.settings.baseURL, 'https://example.test')
  assert.equal(saved.settings.maxChars, 700)
  assert.equal(h.data.plugin.apiKey, undefined, '密钥不写进插件数据')

  const keySaved = await h.handlers.get('dsh-tavern-rewrite/key')({ apiKey: 'sk-new' })
  assert.equal(keySaved.key.configured, true)
  assert.equal(keySaved.key.source, 'credentials')
  assert.equal(h.credential, 'sk-new')

  const cleared = await h.handlers.get('dsh-tavern-rewrite/key')({ apiKey: '' })
  assert.equal(cleared.key.configured, true)
  assert.equal(cleared.key.source, 'config')

  const tested = await h.handlers.get('dsh-tavern-rewrite/test')({})
  assert.deepEqual(tested.models, ['rewrite-v9-c600-nvfp4'])
})

test('API：地址归一化', () => {
  assert.equal(normalizeBaseURL('https://rewrite.revnovel.org/api'), 'https://rewrite.revnovel.org')
  assert.equal(normalizeBaseURL('https://rewrite.revnovel.org/v1/'), 'https://rewrite.revnovel.org')
  assert.equal(normalizeBaseURL('https://rewrite.revnovel.org'), 'https://rewrite.revnovel.org')
  assert.equal(normalizeBaseURL('http://127.0.0.1:8080/v1/chat/completions'), 'http://127.0.0.1:8080')
  assert.equal(normalizeBaseURL('https://example.test/api'), 'https://example.test/api')
})

test('API：请求头、返回解析与错误码', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse(chatCompletion('润色后的文字'))
  }
  const client = createRewriteClient({ baseURL: 'https://rewrite.revnovel.org/api', apiKey: 'sk-test', model: 'm', fetchImpl })
  const result = await client.complete({ text: '原文', temperature: 0.15, maxTokens: 800 })
  assert.equal(result.text, '润色后的文字')
  assert.equal(calls[0].url, 'https://rewrite.revnovel.org/v1/chat/completions')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test')
  assert.match(calls[0].init.headers['User-Agent'], /dsh-tavern-rewrite/)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.messages[0].content, '原文')
  assert.equal(body.max_tokens, 800)
  assert.equal(body.stream, false)

  const short = createRewriteClient({
    baseURL: 'https://rewrite.revnovel.org', apiKey: 'sk-test', fetchImpl: async () =>
      jsonResponse({ error: { message: '输入太短了', code: 'input_too_short' } }, 400)
  })
  await assert.rejects(short.complete({ text: '太短' }), error => error.code === 'input_too_short')

  const unauthorized = createRewriteClient({
    baseURL: 'https://rewrite.revnovel.org', apiKey: 'sk-test', fetchImpl: async () =>
      jsonResponse({ error: { message: 'bad key' } }, 401)
  })
  await assert.rejects(unauthorized.complete({ text: '原文' }), error => error.code === 'auth' && /401/.test(error.message))
})

test('API：429 会重试，5xx 最终失败', async () => {
  let attempts = 0
  const retrying = createRewriteClient({
    baseURL: 'https://127.0.0.1:9', apiKey: 'sk-test', retries: 1,
    fetchImpl: async () => {
      attempts += 1
      return attempts === 1 ? jsonResponse({ error: { message: 'busy' } }, 429) : jsonResponse(chatCompletion('好'))
    }
  })
  const result = await retrying.complete({ text: '原文' })
  assert.equal(result.text, '好')
  assert.equal(attempts, 2)

  let failures = 0
  const broken = createRewriteClient({
    baseURL: 'https://127.0.0.1:9', apiKey: 'sk-test', retries: 1,
    fetchImpl: async () => { failures += 1; return new Response('error code: 502', { status: 502 }) }
  })
  await assert.rejects(broken.complete({ text: '原文' }), error => error.code === 'upstream' && error.status === 502)
  assert.equal(failures, 2)
})
