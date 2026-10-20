// 正文分段：把「不能动的部分」和「可以润色的文字」分开。
//
// Tavern 的 editTurn() 只允许改文字段落，正文里的 HTML 块必须原样保留：
// 状态栏、美化面板、```html 围栏、脚本标签等都不能被模型改写。
// 块级 HTML / 围栏整块保留；行内 HTML、插件标记、URL、行内代码、叙事标签
// 换成占位符，只把纯文字交给改写 API，回来后再逐个还原。

// Tavern 认为属于 HTML 元素的标签名。不在这个表里、也不含 - 或 : 的标签
// 是叙事协议标记（<now_plot>、<content> 之类），按文字处理。
const HTML_ELEMENTS = new Set(('html head body title base link meta style script noscript template slot ' +
  'address article aside footer header h1 h2 h3 h4 h5 h6 hgroup main nav search section ' +
  'blockquote dd div dl dt figcaption figure hr li menu ol p pre ul a abbr b bdi bdo br cite code data dfn em i kbd mark q rp rt ruby s samp small span strong sub sup time u var wbr ' +
  'area audio img map track video embed iframe object picture source canvas svg math portal ' +
  'del ins caption col colgroup table tbody td tfoot th thead tr button datalist fieldset form input label legend meter optgroup option output progress select textarea ' +
  'details dialog summary acronym applet big center dir font frame frameset marquee noframes param strike tt xmp').split(' '))

const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))

// 独占一行的块级标签。其余元素是否算块级，再看它前后是不是换行。
const BLOCK_TAGS = new Set(('address article aside blockquote body caption colgroup dd details dialog div dl dt ' +
  'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe legend li main menu nav noscript ol p pre script section style table tbody td tfoot th thead title tr ul').split(' '))

function isNarrativeTag(tag, token) {
  return Boolean(tag) && !HTML_ELEMENTS.has(tag) && !/[-:]/.test(tag) && /^<\/?[a-z][\w]*\s*\/?\s*>$/i.test(token)
}

function push(segments, kind, text, block) {
  if (!text) return
  const previous = segments[segments.length - 1]
  const sameKind = previous && previous.kind === kind && (kind !== 'html' || previous.block === block)
  if (previous && (sameKind || !text.trim())) {
    previous.text += text
    return
  }
  segments.push(kind === 'html' ? { kind, text, block } : { kind, text })
}

function isBlockHtml(source, start, end, text) {
  const tag = ((/^<\s*([a-z][\w:-]*)/i.exec(text) || [])[1] || '').toLowerCase()
  if (BLOCK_TAGS.has(tag)) return true
  if (text.includes('\n')) return true
  const beforeLine = start === 0 || source[start - 1] === '\n'
  const afterLine = end >= source.length || source[end] === '\n' || source[end] === '\r'
  return beforeLine && afterLine
}

// 按 HTML 元素的完整边界切分。规则与 Tavern 的 editableReplyParts 一致：
// 标准 HTML 元素、带 - 或 : 的自定义元素整块识别；叙事标签留在文字里。
// block:false 的元素（<b>、<span> 等行内标签）由外层换成占位符，
// 这样它两侧的文字不会被切成两个不足 400 字的碎片。
export function splitHtml(text) {
  const source = String(text ?? '')
  const segments = []
  const stack = []
  const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\b[^>]*>|<\/?([a-z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*?>|(`+)[\s\S]*?\2/gi
  let cursor = 0
  let start = -1
  let match
  while ((match = tokens.exec(source))) {
    if (match[2]) continue // 行内代码不是 HTML，留给后面的占位符处理
    const tag = (match[1] || '').toLowerCase()
    const closing = /^<\//.test(match[0])
    if (isNarrativeTag(tag, match[0])) continue
    if (start < 0) {
      push(segments, 'text', source.slice(cursor, match.index))
      start = match.index
    }
    if (closing) {
      const index = stack.lastIndexOf(tag)
      if (index >= 0) stack.length = index
    } else if (tag && !VOID_TAGS.has(tag) && !/\/\s*>$/.test(match[0])) {
      stack.push(tag)
      // script/style 里可能出现任意标签，只认它们自己的结束标签。
      if (['script', 'style', 'textarea', 'title'].includes(tag)) {
        const end = new RegExp('</' + tag + '\\s*>', 'gi')
        end.lastIndex = tokens.lastIndex
        const found = end.exec(source)
        if (!found) { tokens.lastIndex = source.length; break }
        tokens.lastIndex = end.lastIndex
        stack.pop()
      }
    }
    if (!stack.length) {
      const end = tokens.lastIndex
      push(segments, 'html', source.slice(start, end), isBlockHtml(source, start, end, source.slice(start, end)))
      cursor = end
      start = -1
    }
  }
  if (start >= 0) push(segments, 'html', source.slice(start), isBlockHtml(source, start, source.length, source.slice(start)))
  else push(segments, 'text', source.slice(cursor))
  return segments
}

// Markdown 围栏代码块整块保留（包括围栏本身）。围栏必须在行首才能被
// Tavern 认出来，所以它永远作为独立的块，不换成占位符。
export function splitFenced(text) {
  const source = String(text ?? '')
  const lines = source.match(/.*(?:\r?\n|$)/g) || []
  const segments = []
  let plain = ''
  let fence = null
  let fenced = ''
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '')
    if (fence === null) {
      const opening = bare.match(/^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/)
      if (opening) {
        if (plain) { push(segments, 'text', plain); plain = '' }
        fence = { character: opening[1][0], length: opening[1].length }
        fenced = line
      } else plain += line
      continue
    }
    fenced += line
    const closing = bare.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)
    if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) {
      push(segments, 'fence', fenced)
      fence = null
      fenced = ''
    }
  }
  if (fence !== null) push(segments, 'fence', fenced)
  else if (plain) push(segments, 'text', plain)
  return segments
}

// MVU 变量块：里面是运行数据，不是叙事文字，整块不能送进改写模型。
// 这类标签不含 - 或 :，Tavern 在编辑模式下把它当文字；这里提前整块保留。
const OPAQUE_BLOCKS = /<(updatevariable|initvar)\b[^>]*>/gi

export function splitOpaque(text) {
  const source = String(text ?? '')
  const segments = []
  let cursor = 0
  OPAQUE_BLOCKS.lastIndex = 0
  let match
  while ((match = OPAQUE_BLOCKS.exec(source))) {
    const openStart = match.index
    const tag = match[1]
    let end = match.index + match[0].length
    if (!/\/\s*>$/.test(match[0])) {
      const closing = new RegExp('</' + tag + '\\s*>', 'gi')
      closing.lastIndex = end
      const found = closing.exec(source)
      end = found ? closing.lastIndex : source.length
    }
    if (openStart > cursor) segments.push({ kind: 'text', text: source.slice(cursor, openStart) })
    segments.push({ kind: 'opaque', text: source.slice(openStart, end) })
    cursor = end
    OPAQUE_BLOCKS.lastIndex = end
  }
  if (cursor < source.length) segments.push({ kind: 'text', text: source.slice(cursor) })
  return segments.length ? segments : [{ kind: 'text', text: source }]
}

function protectedSegments(text) {
  const result = []
  for (const fenced of splitFenced(text)) {
    if (fenced.kind !== 'text') { result.push(fenced); continue }
    result.push(...splitOpaque(fenced.text))
  }
  return result
}

// 行内不能交给模型的内容。顺序有意义：代码 > 插件标记 > 链接 > URL > 宏 > 标签。
// 行内 HTML 元素由 splitHtml 预先变成占位符，不会走到这里。
const INLINE = new RegExp([
  '(`[^`\\n]{1,400}`)',
  '(\\b[a-z][a-z0-9_-]*###[^#\\n]{1,500}###)',
  '(!?\\[[^\\]\\n]{0,300}\\]\\([^)\\n]{1,500}\\))',
  '(https?:\\/\\/[^\\s<>"\'）】]+)',
  '(<%[\\s\\S]*?%>)',
  '(\\{\\{[\\s\\S]*?\\}\\})',
  '(\\$\\$[\\s\\S]*?\\$\\$)',
  '(\\$[^$\\n]{1,300}\\$)',
  '(<\\/?[a-z][\\w:-]*\\b[^<>]*>)'
].join('|'), 'gi')

const PLACEHOLDER = /【\s*RW\s*(\d+)\s*】/g

// 把行内保护项换成占位符。existingItems 是外层已经占用的编号
// （行内 HTML 元素），新项目从它后面接着编号。
export function protectInline(text, existingItems = []) {
  const source = String(text ?? '')
  const items = Array.isArray(existingItems) ? existingItems.slice() : []
  let index = items.length
  const protectedText = source.replace(INLINE, (match) => {
    index += 1
    items.push(match)
    return '【RW' + index + '】'
  })
  return { text: protectedText, items }
}

// 还原占位符。模型漏掉、改坏或复制占位符时返回 ok:false，调用方放弃这一块。
export function restoreInline(text, items) {
  if (!items.length) return { ok: true, text: String(text ?? '') }
  let output = String(text ?? '')
  for (let index = 0; index < items.length; index += 1) {
    const pattern = new RegExp('【\\s*RW\\s*' + (index + 1) + '\\s*】', 'g')
    const found = output.match(pattern)
    if (!found || found.length !== 1) return { ok: false, text: '' }
    output = output.replace(pattern, () => items[index])
  }
  // 模型自己又写出的 RW 编号，说明占位符被弄乱了。
  PLACEHOLDER.lastIndex = 0
  if (PLACEHOLDER.test(output)) return { ok: false, text: '' }
  return { ok: true, text: output }
}

// 收集正文里所有「必须原样保留」的片段，用来在提交前做一次结构自检。
export function collectProtected(text) {
  const result = []
  for (const fenced of protectedSegments(text)) {
    if (fenced.kind !== 'text') { result.push(fenced.text.trim()); continue }
    for (const part of splitHtml(fenced.text)) {
      if (part.kind === 'html') { result.push(part.text.trim()); continue }
      for (const match of part.text.matchAll(INLINE)) result.push(match[0])
    }
  }
  return result
}

// 把同一个文字块里的行内 HTML、标记、URL 等换成占位符，交给 edit。
function editBlock(buffer, inlineItems, edit, changed) {
  const leading = buffer.match(/^\s*/)[0]
  const trailing = buffer.match(/\s*$/)[0]
  const core = buffer.slice(leading.length, buffer.length - trailing.length)
  if (!core.trim()) return buffer
  const protectedText = protectInline(core, inlineItems)
  const next = edit(protectedText.text, protectedText.items)
  if (typeof next !== 'string') throw new TypeError('edit 必须返回字符串')
  const restored = restoreInline(next, protectedText.items)
  if (restored.ok) {
    if (restored.text !== core) changed.value = true
    return leading + restored.text + trailing
  }
  // 模型弄丢了占位符：退回这一块原文，行内 HTML 仍然原样。
  const fallback = restoreInline(core, inlineItems)
  return leading + (fallback.ok ? fallback.text : core) + trailing
}

// 把一段正文拆成「保留段」和「可润色段」。保留段原样拼回，文字段交给 edit。
export function mapProseSegments(text, edit) {
  const source = String(text ?? '')
  const changed = { value: false }
  let output = ''
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    output += editBlock(buffer, [], edit, changed)
    buffer = ''
  }
  for (const fenced of protectedSegments(source)) {
    if (fenced.kind !== 'text') { flush(); output += fenced.text; continue }
    for (const part of splitHtml(fenced.text)) {
      if (part.kind === 'text') { buffer += part.text; continue }
      // HTML 元素整块保留，不送进模型。行内标签会把前后文字切成两段，
      // 两段都不足 400 字时就不润色——这是安全的取舍，结构一定不会被改坏。
      flush()
      output += part.text
    }
  }
  flush()
  return { text: output, changed: changed.value }
}

// 异步版本：润色要调用 API，逐段等待结果。
export async function mapProseSegmentsAsync(text, edit) {
  const source = String(text ?? '')
  const changed = { value: false }
  let output = ''
  let buffer = ''
  const flush = async () => {
    if (!buffer) return
    const leading = buffer.match(/^\s*/)[0]
    const trailing = buffer.match(/\s*$/)[0]
    const core = buffer.slice(leading.length, buffer.length - trailing.length)
    if (core.trim()) {
      const protectedText = protectInline(core)
      const next = await edit(protectedText.text, protectedText.items)
      if (typeof next !== 'string') throw new TypeError('edit 必须返回字符串')
      const restored = restoreInline(next, protectedText.items)
      if (restored.ok) {
        if (restored.text !== core) changed.value = true
        output += leading + restored.text + trailing
      } else {
        const fallback = protectInline(core)
        const plain = restoreInline(core, fallback.items)
        output += leading + (plain.ok ? plain.text : core) + trailing
      }
    } else {
      output += buffer
    }
    buffer = ''
  }
  for (const fenced of protectedSegments(source)) {
    if (fenced.kind !== 'text') { await flush(); output += fenced.text; continue }
    for (const part of splitHtml(fenced.text)) {
      if (part.kind === 'text') { buffer += part.text; continue }
      await flush()
      output += part.text
    }
  }
  await flush()
  return { text: output, changed: changed.value }
}
