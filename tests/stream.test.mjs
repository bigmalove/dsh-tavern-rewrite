import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlugin } from '../index.mjs'
import { createStreamPlanner } from '../lib/stream.mjs'

// 20 个字一句，方便算切点。
const NARRATION = `雨是在黄昏时分落下来的。林岚站在旧书店的门口，看着街对面那盏忽明忽暗的路灯，心里忽然生出一种说不清的预感。她把手里的伞收起来，抖了抖水，推门进去。

店里没有客人，只有柜台后面那个老人，正低头擦一只瓷杯。听见门上的铜铃响，他抬起头，眯着眼睛看了她一会儿，才慢慢开口：“你来了。”

“您知道我今晚会来？”林岚问。

老人没有回答，只是把那只瓷杯推到她面前，杯子里是刚泡好的茶，热气在昏黄的灯下缓缓上升。“找你的人，已经在路上了。”他说，“你只有一炷香的时间。”

林岚握住杯子的手微微一紧。她想起三天前收到的那封信，信纸上的字迹她认得，那是她失踪了七年的哥哥的字。信里只写了一句话：不要相信任何人，包括我。

窗外的雨越下越大，雨点砸在玻璃上，像是有人在一下一下地敲门。老人忽然伸手，把墙角那盏灯拧灭了一半。屋子里暗下来，只剩柜台上一小块暖黄的光。林岚听见自己的心跳，一下，又一下，和着雨声。

她起身走到窗边，掀开帘子的一角。雨幕里，长街尽头有一盏灯笼正慢慢靠近，一晃一晃，像是被什么人提在手里。灯笼的光落在积水里，映出一小片摇晃的暖色。林岚忽然想起老人刚才那句话，转过身想再问一句，柜台后面却已经空了，只剩那只瓷杯还在冒着热气。`

const SENTENCE = '雨落在旧书店的门口，街灯忽明忽暗。'

function body(paragraphs, perParagraph = 20) {
  return Array.from({ length: paragraphs }, () => SENTENCE.repeat(perParagraph)).join('\n\n')
}

test('流式切点：不足阈值不切，够了才在段落边界切', () => {
  const plan = createStreamPlanner({ minChars: 400 })
  assert.equal(plan(body(1, 10)), null)
  // 一段只有 300 多字：要等第二段收尾，切点才是完整的段落边界。
  assert.equal(plan(body(2)), null)
  const text = body(3)
  const cut = plan(text)
  assert.equal(typeof cut, 'number')
  assert.ok(cut >= 400)
  assert.ok(text.slice(0, cut).endsWith('\n\n'))
})

test('流式切点：eof 时把剩下的全部交出去', () => {
  const plan = createStreamPlanner({ minChars: 400 })
  assert.equal(plan('短句。', { eof: true }), '短句。'.length)
})

test('流式切点：未闭合的围栏/标记块不切在里面', () => {
  const plan = createStreamPlanner({ minChars: 400 })
  const prefix = body(3)
  const fenced = prefix + '\n```html\n<div class="status">生命：100\n\n' // 围栏未闭合
  const cut = plan(fenced)
  assert.equal(typeof cut, 'number')
  const taken = fenced.slice(0, cut)
  assert.ok(!taken.includes('```'), '切点不能落在围栏内部')
})

test('流式切点：RunningHub 标记块没闭合时不切进块里', () => {
  const plan = createStreamPlanner({ minChars: 400 })
  const text = body(3) + '\n[[RH:SHOT]] 一个雨夜的书店，暖黄灯光 [[/RH]]\n\n' + body(1, 30)
  const cut = plan(text)
  assert.equal(typeof cut, 'number')
  const taken = text.slice(0, cut)
  assert.equal((taken.match(/\[\[RH:SHOT\]\]/g) || []).length, (taken.match(/\[\[\/RH\]\]/g) || []).length)
})

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function streamHarness({ transform = text => text.replace(/忽然/g, '突然'), stream = true } = {}) {
  const handlers = new Map()
  const settled = []
  const edits = []
  const requests = []
  const rewriters = []
  let settings = { auto: true }
  const current = { gameId: 'game-1', turn: 2, textVersion: 'v1', rawText: '原文', text: '原文', greeting: false, card: { id: 'card', name: '卡' }, variables: null }

  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/v1/models')) return jsonResponse({ object: 'list', data: [{ id: 'rewrite3-27B' }] })
    if (!path.endsWith('/v1/chat/completions')) return new Response('not found', { status: 404 })
    const body = JSON.parse(init.body)
    requests.push(body)
    return jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content: transform(body.messages.at(-1).content) }, finish_reason: 'stop' }] })
  }
  const credentials = { async resolve() { return { value: 'sk-test', source: 'stored' } } }
  const tavern = {
    apiVersion: 8,
    onTurnSettled(handler) { settled.push(handler) },
    onGameRemoved() {},
    gameSettings() {},
    settlementTask() {},
    replyRewriter(definition) { rewriters.push(definition); return () => { const at = rewriters.indexOf(definition); if (at >= 0) rewriters.splice(at, 1) } },
    async getGameSettings() { return settings },
    async getTurn() { return structuredClone(current) },
    async getTurnState() { return { gameId: 'game-1', turn: 2, textVersion: 'v1', settled: true, busy: false } },
    async versionSignal() { return new AbortController().signal },
    async editTurn({ text }) { edits.push(text); return structuredClone({ ...current, text }) },
    async attach() { return { id: 'm1' } },
    async update() {}, async remove() {},
    async readPluginData() { return { stream, auto: true } },
    async savePluginData() {},
    handle(name, handler) { handlers.set(name, handler) }
  }
  const ctx = { credentials, tavern, get: name => name === 'credentials' ? credentials : undefined, effect: fn => fn() }
  return { ctx, tavern, fetchImpl, handlers, settled, edits, requests, rewriters, current, setSettings: value => { settings = value } }
}

test('插件：默认注册流式改写器，并真的走润色 API', async () => {
  const h = streamHarness()
  await createPlugin({ fetchImpl: h.fetchImpl, readConfig: async () => ({ baseURL: 'https://example.test', model: 'rewrite3-27B' }) }).apply(h.ctx)
  assert.equal(h.rewriters.length, 1)
  const output = await h.rewriters[0].rewrite(NARRATION, { sessionId: 'game-1', turn: 2 })
  assert.ok(output.includes('突然'))
  assert.equal(h.requests.length, 1)
})

test('插件：流式改写过的轮次在结算时不再整段重写', async () => {
  const h = streamHarness()
  await createPlugin({ fetchImpl: h.fetchImpl, readConfig: async () => ({ baseURL: 'https://example.test', model: 'rewrite3-27B' }) }).apply(h.ctx)
  await h.rewriters[0].rewrite(NARRATION, { sessionId: 'game-1', turn: 2 })
  await h.settled[0]({ gameId: 'game-1', turn: 2, textVersion: 'v1', rawText: h.current.rawText, text: h.current.text })
  assert.equal(h.edits.length, 0)
})

test('插件：关闭流式润色后不注册改写器', async () => {
  const h = streamHarness({ stream: false })
  await createPlugin({ fetchImpl: h.fetchImpl, readConfig: async () => ({ baseURL: 'https://example.test', model: 'rewrite3-27B' }) }).apply(h.ctx)
  assert.equal(h.rewriters.length, 0)
})
