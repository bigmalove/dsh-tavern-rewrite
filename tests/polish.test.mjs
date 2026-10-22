import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectProtected, mapProseSegments, protectInline, restoreInline, splitHtml } from '../lib/segments.mjs'
import {
  bigramRecall,
  buildChunks,
  ensureOpening,
  prefillAnchor,
  prepareRawText,
  reflowParagraphs,
  splitUnits,
  validateRewrite
} from '../lib/polish.mjs'
import { createRewriteClient, isMockEcho } from '../lib/api.mjs'
import { normalizeSettings } from '../lib/settings.mjs'

const NARRATION = `雨是在黄昏时分落下来的。林岚站在旧书店的门口，看着街对面那盏忽明忽暗的路灯，心里忽然生出一种说不清的预感。她把手里的伞收起来，抖了抖水，推门进去。

店里没有客人，只有柜台后面那个老人，正低头擦一只瓷杯。听见门上的铜铃响，他抬起头，眯着眼睛看了她一会儿，才慢慢开口：“你来了。”

“您知道我今晚会来？”林岚问。

老人没有回答，只是把那只瓷杯推到她面前，杯子里是刚泡好的茶，热气在昏黄的灯下缓缓上升。“找你的人，已经在路上了。”他说，“你只有一炷香的时间。”

林岚握住杯子的手微微一紧。她想起三天前收到的那封信，信纸上的字迹她认得，那是她失踪了七年的哥哥的字。信里只写了一句话：不要相信任何人，包括我。

窗外的雨越下越大，雨点砸在玻璃上，像是有人在一下一下地敲门。老人忽然伸手，把墙角那盏灯拧灭了一半。屋子里暗下来，只剩柜台上一小块暖黄的光。林岚听见自己的心跳，一下，又一下，和着雨声。

她忽然想起哥哥临走前那个晚上，也是这样大的雨。他站在院门口，回头冲她笑了一下，说等他回来，就带她去看海。那年她十二岁，海在很远的地方，远到她以为一辈子都走不到。`

// 结构交叉检查默认读同级的 dsh-tavern 本体；独立仓库没有本体时退化为插件自己的检查。
const here = path.dirname(fileURLToPath(import.meta.url))
const tavernRoot = process.env.DSH_TAVERN_REPO || path.resolve(here, '../../dsh-tavern')
let editableReplyParts = null
try {
  ({ editableReplyParts } = await import(pathToFileURL(path.join(tavernRoot, 'tavern-plugin/lib/domain/reply-presentation.js')).href))
} catch { /* 没有本体也继续跑 */ }

function protectedShape(text) {
  if (!editableReplyParts) return collectProtected(text)
  return editableReplyParts(text).filter(part => part.kind !== 'text').map(part => part.text.trim())
}

const STRUCTURE_SAMPLES = [
  '雨停了。',
  '<b>她</b>推开门。',
  '雨停了。\n\n```html\n<div class="status">体力 9</div>\n```',
  '她推开门。\n\n<div class="status"><span>生命：100</span></div>\n\n外面很冷。',
  '正文。\n\n<details><summary>状态</summary><div>体力 9</div></details>\n\n后文。',
  '开头。<content>正文内容</content>结尾。',
  '图片 image###一个女孩站在雨里### 在段落之间。',
  '她走进来。<now_plot>她推开门。</now_plot>然后坐下。',
  '看这里 https://example.com/a?b=1 和 `code <x>` 以及 {{user}}。',
  '第一段。\n\n<status-bar>HP 10</status-bar>\n\n第二段。',
  '未闭合 <div class="x">后面全是界面',
  '<!-- 注释 -->她笑了。',
  '<script>var x = "<div>";</script>她笑了。',
  '```js\nconsole.log(1)\n```\n\n她笑了。',
  '正常文字。\n\n```html\n<script>alert(1)</script>\n```\n\n结束。',
  'A\n<div class="x">y</div>\nB',
  '正文。\n\n<UpdateVariable>{"hp":100,"items":["剑"]}</UpdateVariable>\n\n后文。',
  '正文。\n\n<InitVar>{"gold":1}</InitVar>\n\n后文。'
]

test('设置：自动润色总开关默认开，显式 false 才关', () => {
  assert.equal(normalizeSettings({}).auto, true)
  assert.equal(normalizeSettings({ auto: false }).auto, false)
  assert.equal(normalizeSettings({ auto: 'false' }).auto, false)
})

test('正文分段：改写文字后 HTML 结构保持原样', () => {
  for (const sample of STRUCTURE_SAMPLES) {
    const result = mapProseSegments(sample, text => text.replace(/[。！？]/g, '！'))
    assert.deepEqual(protectedShape(result.text), protectedShape(sample), sample)
  }
})

test('正文分段：行内 HTML 与围栏各自识别', () => {
  const parts = splitHtml('<b>她</b>推开门。\n\n<div class="status">体力</div>')
  assert.equal(parts[0].kind, 'html')
  assert.equal(parts[0].block, false)
  assert.equal(parts.at(-1).kind, 'html')
  assert.equal(parts.at(-1).block, true)
})

test('行内保护：标记、URL、代码、宏、叙事标签可还原', () => {
  const source = '她拿起image###一把剑###，看了https://example.com/a?b=1和`code <x>`，又念了{{user}}。<now_plot>她推门。</now_plot>'
  const { text, items } = protectInline(source)
  assert.match(text, /【RW1】/)
  assert.match(text, /【RW2】/)
  assert.match(text, /【RW3】/)
  assert.match(text, /【RW4】/)
  assert.match(text, /【RW5】/)
  assert.match(text, /【RW6】/)
  const restored = restoreInline(text, items)
  assert.equal(restored.ok, true)
  assert.equal(restored.text, source)
})

test('行内保护：占位符丢失或重复时不还原', () => {
  const { text, items } = protectInline('A image###b### C')
  assert.equal(restoreInline(text.replace('【RW1】', ''), items).ok, false)
  assert.equal(restoreInline(text.replace('【RW1】', '【RW1】【RW1】'), items).ok, false)
})

test('collectProtected 收集 HTML、围栏、MVU 变量块和行内标记', () => {
  const values = collectProtected('开头 image###a### 中间\n\n<div class="x">y</div>\n\n```html\n<b>z</b>\n```\n\n<UpdateVariable>{"hp":1}</UpdateVariable>')
  assert.deepEqual(values, ['image###a###', '<div class="x">y</div>', '```html\n<b>z</b>\n```', '<UpdateVariable>{"hp":1}</UpdateVariable>'])
})

test('MVU 变量块整块保留，不送进改写模型', () => {
  const source = '开头。\n\n<UpdateVariable>{"hp":100,"items":["剑"]}</UpdateVariable>\n\n结尾。'
  const result = mapProseSegments(source, text => text.replace(/开头|结尾/g, '改了'))
  assert.ok(result.text.includes('<UpdateVariable>{"hp":100,"items":["剑"]}</UpdateVariable>'))
  assert.ok(result.text.includes('改了。'))
  const unclosed = mapProseSegments('开头。\n\n<updatevariable>{"hp":1}', text => '改了')
  assert.ok(unclosed.text.includes('<updatevariable>{"hp":1}'))
})

test('切句：引号和省略号留在同一句里', () => {
  assert.deepEqual(splitUnits('“你来了。”他说。\n\n“我知道。”'), ['“你来了。”', '他说。', '“我知道。”'])
  assert.deepEqual(splitUnits('她等了很久……然后走了。'), ['她等了很久……', '然后走了。'])
})

test('段落重排：一行一句时按原段落合并', () => {
  const output = splitUnits(NARRATION).join('\n')
  const paragraphs = NARRATION.split(/\n\s*\n/)
  const reflowed = reflowParagraphs(output, paragraphs)
  assert.equal(reflowed.split(/\n\s*\n/).length, paragraphs.length)
  for (const [index, paragraph] of reflowed.split(/\n\s*\n/).entries()) {
    assert.ok(bigramRecall(paragraphs[index], paragraph) > 0.9, 'paragraph ' + index)
  }
})

test('段落重排：模型合并句子时仍能对齐段落', () => {
  const paragraphs = ['门被推开的时候，风把柜台上的纸吹得哗啦一响。进来的是个穿灰呢大衣的男人。', '码头的风比城里大得多。林岚把伞收起来，看着黑沉沉的海面。']
  const output = '林岚推开门，看见一个穿着灰色大衣的男人站在柜台前，帽檐压得很低。他没有看林岚。码头的风比城里大得多，林岚将伞收起来，看着黑沉沉的海面。'
  const reflowed = reflowParagraphs(output, paragraphs)
  assert.equal(reflowed.split(/\n\s*\n/).length, 2)
  assert.ok(reflowed.startsWith('林岚推开门'))
  assert.ok(reflowed.includes('码头的风比城里大得多'))
})

test('开头检查：只补真正丢掉的开头，不补换一种说法的开头', () => {
  const rain = '雨是在黄昏时分落下来的。'
  assert.ok(ensureOpening('林岚站在旧书店的门口，看着街面。', rain).startsWith(rain))
  const door = '门被推开的时候，风把柜台上的纸吹得哗啦一响。'
  assert.equal(ensureOpening('林岚推开门，看见一个穿着灰色大衣的男人站在柜台前。', door), '林岚推开门，看见一个穿着灰色大衣的男人站在柜台前。')
  assert.equal(ensureOpening('雨在黄昏时落下。林岚站在门口。', rain), '雨在黄昏时落下。林岚站在门口。')
})

test('切块：覆盖正文、不重叠、长段会继续切', () => {
  const settings = normalizeSettings({ maxChars: 600, minChars: 400 })
  const chunks = buildChunks(NARRATION + '\n\n' + NARRATION, settings)
  assert.ok(chunks.length >= 2)
  let cursor = 0
  for (const chunk of chunks) {
    assert.ok(chunk.start >= cursor)
    assert.ok(chunk.end > chunk.start)
    assert.ok(chunk.contentLength <= 900, 'chunk too large: ' + chunk.contentLength)
    cursor = chunk.end
  }
  assert.equal(cursor, (NARRATION + '\n\n' + NARRATION).length)
  const long = '甲'.repeat(1400)
  const longChunks = buildChunks(long, settings)
  assert.ok(longChunks.length >= 2)
  assert.ok(longChunks.every(chunk => chunk.contentLength <= 900))
})

test('校验：忠实改写通过，跑题、截断、新 HTML、复读不通过', () => {
  const faithful = splitUnits(NARRATION).join('\n').replace(/忽然/g, '突然')
  assert.equal(validateRewrite(NARRATION, faithful).ok, true)
  assert.equal(validateRewrite(NARRATION, '“我回来了。”“欢迎回家。”林岚愣了愣，她确实回家了。').ok, false)
  assert.equal(validateRewrite(NARRATION, NARRATION).ok, false)
  assert.equal(validateRewrite(NARRATION, NARRATION).reason, 'no-change')
  assert.equal(validateRewrite(NARRATION, NARRATION, { truncated: true }).ok, false)
  assert.equal(validateRewrite(NARRATION, NARRATION, { finishReason: 'length' }).ok, false)
  assert.equal(validateRewrite(NARRATION, NARRATION.replace('她把手里的伞收起来', '<div>伞</div>她把手里的伞收起来')).ok, false)
  const titled = NARRATION.replace('雨是在黄昏时分落下来的。', '雨是在黄昏时分落下来的。第295章 他来了（三更）')
  assert.equal(validateRewrite(NARRATION, titled).reason, 'new-heading')
  const repeated = NARRATION + '\n\n' + '她忽然想起哥哥临走前那个晚上，也是这样大的雨。' .repeat(8)
  assert.equal(validateRewrite(NARRATION, repeated).ok, false)
})

function fakeClient(transform) {
  let calls = 0
  return {
    get calls() { return calls },
    async complete({ text }) {
      calls += 1
      return { text: transform(text), finishReason: 'stop', truncated: false }
    }
  }
}

test('整轮润色：状态栏、标记行、段落都保留', async () => {
  const raw = NARRATION.replace('她把手里的伞收起来', 'image###一个女孩站在雨中的旧书店门口###她把手里的伞收起来') + '\n\n<div class="status"><span>生命：100</span></div>'
  const client = fakeClient(text => text.replace(/忽然/g, '突然').replace(/看着/g, '望着'))
  const result = await prepareRawText(raw, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.equal(result.status, 'ready')
  assert.deepEqual(protectedShape(result.text), protectedShape(raw))
  assert.ok(result.text.includes('image###一个女孩站在雨中的旧书店门口###'))
  assert.ok(result.text.includes('<div class="status"><span>生命：100</span></div>'))
  assert.equal(result.text.split(/\n\s*\n/).filter(part => !part.includes('<div')).length, 7)
})

test('整轮润色：不足 400 字跳过', async () => {
  const client = fakeClient(text => text.replace(/雨/g, '雪'))
  const result = await prepareRawText('雨停了。', { client, settings: normalizeSettings({}) })
  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'too-short')
})

test('整轮润色：服务端不接受预填时退回无预填请求', async () => {
  let calls = 0
  const client = {
    async complete({ text, prefill }) {
      calls += 1
      if (prefill) throw Object.assign(new Error('assistant prefill not supported'), { code: 'bad_request', status: 400 })
      return { text: text.replace(/忽然/g, '突然'), finishReason: 'stop', truncated: false }
    }
  }
  const result = await prepareRawText(NARRATION, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.equal(result.status, 'ready')
  assert.ok(calls >= 2)
  assert.ok(result.text.includes('突然'))
})

test('整轮润色：模型跑题时放弃，保留原文', async () => {
  const client = fakeClient(() => '“我回来了。”\n“欢迎回家。”\n林岚愣了愣，她确实回家了。她放下背包，转身看向对方。')
  const result = await prepareRawText(NARRATION, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.notEqual(result.status, 'ready')
  assert.equal(result.text, undefined)
})

test('整轮润色：模型弄丢占位符时跳过该段', async () => {
  const raw = NARRATION.replace('她把手里的伞收起来', 'image###一个女孩站在雨中的旧书店门口###她把手里的伞收起来')
  const client = fakeClient(text => text.replace(/【RW\d+】/g, '').replace(/忽然/g, '突然'))
  const result = await prepareRawText(raw, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.notEqual(result.status, 'ready')
})

test('整轮润色：模型自造占位符时放弃', async () => {
  const client = fakeClient(text => text.replace('她把手里的伞收起来', '【RW99】她把手里的伞收起来').replace(/忽然/g, '突然'))
  const result = await prepareRawText(NARRATION, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.notEqual(result.status, 'ready')
})

test('整轮润色：模型加 HTML 时放弃', async () => {
  const client = fakeClient(text => text.replace('她把手里的伞收起来', '<div>伞</div>她把手里的伞收起来'))
  const result = await prepareRawText(NARRATION, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.notEqual(result.status, 'ready')
})

test('mock 模式：只在开头出现的回显提示会被识别', () => {
  assert.equal(isMockEcho('【mock 模式：模型未接入，以下为原文回显】\n\n正文'), true)
  assert.equal(isMockEcho('  \n【MOCK 模式：模型未接入】'), true)
  assert.equal(isMockEcho('正文里提到 mock 模式不算回显'), false)
  assert.equal(isMockEcho(''), false)
})

test('mock 模式：改写台回显原文时整轮放弃，不返回可替换的正文', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    const body = JSON.parse(init.body)
    return new Response(JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '【mock 模式：模型未接入，以下为原文回显】\n\n' + body.messages[0].content },
        finish_reason: 'stop'
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = createRewriteClient({ baseURL: 'https://rewrite.revnovel.org', apiKey: 'sk-test', fetchImpl })
  const result = await prepareRawText(NARRATION, { client, settings: normalizeSettings({ maxChars: 1000, minChars: 400 }) })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'upstream-mock')
  assert.equal(result.text, undefined)
  assert.equal(calls.length, 1, '命中 mock 后不再继续请求后面的分段')
})

test('预填：第一句做锚点，整段做锚点时取第一段', () => {
  assert.equal(prefillAnchor('第一句。第二句。'), '第一句。\n')
  assert.equal(prefillAnchor('第一句。第二句。', 'paragraph'), '')
  assert.equal(prefillAnchor('第一段第一句。第一段第二句。\n\n第二段。', 'paragraph'), '第一段第一句。第一段第二句。\n\n')
  assert.equal(prefillAnchor('只有一句'), '')
})

test('设置：旧 v9 模型和低温自动迁移到 v12', () => {
  const migrated = normalizeSettings({ model: 'rewrite-v9-c600-nvfp4', temperature: 0.15 })
  assert.equal(migrated.model, 'rewrite-v12-fp8')
  assert.equal(migrated.temperature, 0.6)

  const customTemperature = normalizeSettings({ model: 'rewrite-v9', temperature: 0.8 })
  assert.equal(customTemperature.model, 'rewrite-v12-fp8')
  assert.equal(customTemperature.temperature, 0.8)

  const customModel = normalizeSettings({ model: 'my-rewrite', temperature: 0.1 })
  assert.equal(customModel.model, 'my-rewrite')
  assert.equal(customModel.temperature, 0.1)
})
