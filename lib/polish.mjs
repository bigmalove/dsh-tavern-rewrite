import { RewriteError, isAbort } from './api.mjs'
import { collectProtected, mapProseSegmentsAsync } from './segments.mjs'

const HARD_MIN = 400
const MAX_OUTPUT_TOKENS = 4000

export function nonWhitespaceLength(value) {
  return String(value ?? '').replace(/\s/g, '').length
}

function isSentencePeriod(text, index) {
  const next = text[index]
  if (!next) return true
  if (!/[\s”’"）】」』]/.test(next)) return false
  const previous = text[index - 2]
  if (previous && /\d/.test(previous) && /\d/.test(next)) return false
  return true
}

/** 切成句子/行单位，保留句末标点和收尾引号。 */
export function splitUnits(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  const units = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let buffer = ''
    let index = 0
    while (index < trimmed.length) {
      const character = trimmed[index]
      buffer += character
      index += 1
      const ellipsis = character === '…' && (trimmed[index] === '…' || trimmed[index - 2] === '…')
      const period = character === '.' && isSentencePeriod(trimmed, index)
      if (!('。！？!?'.includes(character) || ellipsis || period)) continue
      while (index < trimmed.length && '。！？!?…'.includes(trimmed[index])) { buffer += trimmed[index]; index += 1 }
      while (index < trimmed.length && '”’」』）】》〉"\''.includes(trimmed[index])) { buffer += trimmed[index]; index += 1 }
      const unit = buffer.trim()
      if (unit) units.push(unit)
      buffer = ''
    }
    if (buffer.trim()) units.push(buffer.trim())
  }
  return units
}

export function firstSentenceOf(value) {
  return splitUnits(value)[0] || ''
}

export function splitParagraphs(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map(part => part.trim()).filter(Boolean)
}

function cleanForRecall(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(value) {
  const text = cleanForRecall(value)
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  return set
}

/** 输入和输出共有的二字组比例；忠实改写通常 0.9 以上，跑题的会掉到 0.5 以下。 */
export function bigramRecall(input, output) {
  const source = cleanForRecall(input)
  if (source.length < 2) return 1
  const inputGrams = bigrams(input)
  const target = new Set()
  const outputText = cleanForRecall(output)
  for (let index = 0; index < outputText.length - 1; index += 1) target.add(outputText.slice(index, index + 2))
  let hits = 0
  for (const gram of inputGrams) if (target.has(gram)) hits += 1
  return hits / Math.max(1, inputGrams.size)
}

function mostlyCjk(value) {
  const text = String(value ?? '').replace(/\s/g, '')
  if (!text) return true
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  return cjk / text.length > 0.2
}

function tidySpacing(value) {
  return String(value ?? '')
    .replace(/[ \t]+([，。！？；：、）】」』”’])/g, '$1')
    .replace(/([（【「『“‘])[ \t]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function joinUnits(units) {
  if (!units.length) return ''
  if (mostlyCjk(units.join(''))) {
    let text = units.join('')
    text = text.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    return tidySpacing(text)
  }
  return tidySpacing(units.join(' '))
}

function gramSet(value) {
  const text = cleanForRecall(value)
  const set = new Set()
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2))
  return set
}

// 模型通常逐句改写，但会合并/拆分句子。用单调对齐把每个输出句配回原句，
// 再按原句所属段落分组，比按字数比例切更准。
function alignParagraphs(output, paragraphs) {
  const originals = []
  paragraphs.forEach((paragraph, index) => {
    for (const text of splitUnits(paragraph)) originals.push({ text, paragraph: index })
  })
  const units = splitUnits(output)
  if (!originals.length || !units.length) return null
  if (originals.length * units.length > 9000) return null
  const originalSets = originals.map(item => gramSet(item.text))
  const unitSets = units.map(unit => gramSet(unit))
  const lengthOf = value => Math.max(1, nonWhitespaceLength(value))
  const originalLengths = originals.map(item => lengthOf(item.text))
  const unitLengths = units.map(unit => lengthOf(unit))
  const totalOriginal = originalLengths.reduce((sum, value) => sum + value, 0)
  const totalOutput = unitLengths.reduce((sum, value) => sum + value, 0)
  const originalPrefix = []
  const unitPrefix = []
  for (let index = 0, sum = 0; index < originalLengths.length; index += 1) { sum += originalLengths[index]; originalPrefix.push(sum) }
  for (let index = 0, sum = 0; index < unitLengths.length; index += 1) { sum += unitLengths[index]; unitPrefix.push(sum) }
  function score(i, j) {
    const left = originalSets[i]
    const right = unitSets[j]
    if (!left.size || !right.size) return -1
    let hits = 0
    for (const gram of left) if (right.has(gram)) hits += 1
    const recall = hits / left.size
    const lengthSimilarity = Math.min(originalLengths[i], unitLengths[j]) / Math.max(originalLengths[i], unitLengths[j])
    // 位置先验：改写大致按原顺序等长展开，避免把后一段的输出句误配到下一段。
    const positionSimilarity = 1 - Math.abs(originalPrefix[i] / totalOriginal - unitPrefix[j] / totalOutput)
    return recall * 1.25 + lengthSimilarity * 0.15 + positionSimilarity * 0.35 - 0.22
  }
  const gapOriginal = -0.3
  const gapOutput = -0.12
  const rows = originals.length
  const columns = units.length
  const dp = Array.from({ length: rows + 1 }, () => new Float64Array(columns + 1))
  const back = Array.from({ length: rows + 1 }, () => new Int8Array(columns + 1))
  for (let i = 1; i <= rows; i += 1) { dp[i][0] = dp[i - 1][0] + gapOriginal; back[i][0] = 1 }
  for (let j = 1; j <= columns; j += 1) { dp[0][j] = dp[0][j - 1] + gapOutput; back[0][j] = 2 }
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= columns; j += 1) {
      const match = dp[i - 1][j - 1] + score(i - 1, j - 1)
      const skipOriginal = dp[i - 1][j] + gapOriginal
      const skipOutput = dp[i][j - 1] + gapOutput
      if (match >= skipOriginal && match >= skipOutput) { dp[i][j] = match; back[i][j] = 0 }
      else if (skipOriginal >= skipOutput) { dp[i][j] = skipOriginal; back[i][j] = 1 }
      else { dp[i][j] = skipOutput; back[i][j] = 2 }
    }
  }
  const assigned = new Array(columns).fill(-1)
  let i = rows
  let j = columns
  let matches = 0
  while (i > 0 || j > 0) {
    const operation = i > 0 && j > 0 ? back[i][j] : (i > 0 ? 1 : 2)
    if (operation === 0) { assigned[j - 1] = originals[i - 1].paragraph; matches += 1; i -= 1; j -= 1 }
    else if (operation === 1 && i > 0) i -= 1
    else j -= 1
  }
  if (matches < Math.ceil(columns * 0.4)) return null
  let nextParagraph = assigned.find(value => value >= 0)
  if (nextParagraph === undefined) return null
  let last = nextParagraph
  for (let index = 0; index < columns; index += 1) {
    if (assigned[index] < 0) assigned[index] = last
    else last = assigned[index]
  }
  const groups = Array.from({ length: paragraphs.length }, () => [])
  for (let index = 0; index < units.length; index += 1) groups[assigned[index]].push(units[index])
  const result = groups.map(group => joinUnits(group)).filter(Boolean)
  return result.length ? result.join('\n\n') : null
}

/** 把模型一行一句的输出重新排回原段落。 */
export function reflowParagraphs(output, paragraphs) {
  const original = (paragraphs || []).map(part => String(part).trim()).filter(Boolean)
  const units = splitUnits(output)
  if (!units.length) return String(output ?? '').trim()
  if (original.length <= 1) return joinUnits(units)
  const grouped = splitParagraphs(output)
  if (grouped.length === original.length) {
    const direct = grouped.map(part => joinUnits(splitUnits(part))).filter(Boolean)
    if (direct.length === original.length) return direct.join('\n\n')
  }
  const sentenceCounts = original.map(part => Math.max(1, splitUnits(part).length))
  if (sentenceCounts.reduce((sum, value) => sum + value, 0) === units.length) {
    const result = []
    let cursor = 0
    for (const count of sentenceCounts) {
      result.push(joinUnits(units.slice(cursor, cursor + count)))
      cursor += count
    }
    return result.filter(Boolean).join('\n\n')
  }
  const aligned = alignParagraphs(output, original)
  if (aligned) return aligned
  const lengths = original.map(part => Math.max(1, nonWhitespaceLength(part)))
  const totalOriginal = lengths.reduce((sum, value) => sum + value, 0)
  const unitLengths = units.map(unit => Math.max(1, nonWhitespaceLength(unit)))
  const totalOutput = unitLengths.reduce((sum, value) => sum + value, 0)
  const result = []
  let cursor = 0
  let consumed = 0
  let prefix = 0
  for (let index = 0; index < original.length; index += 1) {
    prefix += lengths[index]
    if (index === original.length - 1) { result.push(joinUnits(units.slice(cursor))); break }
    const target = totalOutput * prefix / totalOriginal
    const group = []
    const reserve = original.length - index - 1
    while (cursor < units.length - reserve && (group.length === 0 || consumed < target)) {
      group.push(units[cursor])
      consumed += unitLengths[cursor]
      cursor += 1
    }
    result.push(joinUnits(group))
  }
  const kept = result.filter(Boolean)
  return kept.length ? kept.join('\n\n') : joinUnits(units)
}

function suspiciousRepetition(input, output) {
  const source = cleanForRecall(input)
  const target = cleanForRecall(output)
  if (target.length < 80) return false
  const size = 24
  if (target.length < size) return false
  const known = new Set()
  for (let index = 0; index <= source.length - size; index += 1) known.add(source.slice(index, index + size))
  const counts = new Map()
  for (let index = 0; index <= target.length - size; index += 1) {
    const gram = target.slice(index, index + size)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  let extra = 0
  for (const [gram, count] of counts) if (count > 1 && !known.has(gram)) extra += (count - 1) * size
  return extra > target.length * 0.12
}

export function validateRewrite(input, output, { finishReason = 'stop', truncated = false } = {}) {
  const text = String(output ?? '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (truncated) return { ok: false, reason: 'truncated' }
  if (finishReason && finishReason !== 'stop') return { ok: false, reason: 'finish:' + finishReason }
  const inputLength = nonWhitespaceLength(input)
  const outputLength = nonWhitespaceLength(text)
  const ratio = outputLength / Math.max(1, inputLength)
  if (ratio < 0.55) return { ok: false, reason: 'too-short', ratio }
  if (ratio > 1.65) return { ok: false, reason: 'too-long', ratio }
  // 占位符段落里不应该出现新的 HTML 或围栏；出现了说明模型在自造结构。
  if (/(<\/?[a-z][\w:-]*\b|```)/i.test(text)) return { ok: false, reason: 'new-html', ratio }
  const recall = bigramRecall(input, text)
  if (recall < 0.65) return { ok: false, reason: 'off-topic', recall, ratio }
  if (suspiciousRepetition(input, text)) return { ok: false, reason: 'repetition', ratio }
  const inputEnd = String(input ?? '').trim().slice(-1)
  const outputEnd = text.slice(-1)
  if ('。！？!?”…'.includes(inputEnd) && '，,、；;：:—-'.includes(outputEnd)) return { ok: false, reason: 'cut-off', ratio }
  return { ok: true, recall, ratio }
}

function charRecall(input, output) {
  const source = new Set(cleanForRecall(input))
  if (!source.size) return 1
  const target = new Set(cleanForRecall(output))
  let hits = 0
  for (const character of source) if (target.has(character)) hits += 1
  return hits / source.size
}

export function ensureOpening(output, first) {
  if (!first) return output
  // 用字面重合（而不是二字组）判断开头是否被改写掉了：模型换一种说法时
  // 二字组会大幅下降，但只要人物、地点、动作的字还在，就不算丢掉。
  const text = String(output ?? '')
  const window = text.slice(0, Math.max(80, first.length * 2))
  if (charRecall(first, window) >= 0.32) return text
  return first + '\n\n' + text.trim()
}

function paragraphSpans(text) {
  const spans = []
  let start = 0
  const separator = /\n[ \t]*\n+/g
  let match
  while ((match = separator.exec(text))) {
    if (match.index > start) spans.push({ start, end: match.index })
    start = separator.lastIndex
  }
  if (start < text.length) spans.push({ start, end: text.length })
  return spans.filter(span => text.slice(span.start, span.end).trim())
}

function unitSpans(text) {
  const spans = []
  let cursor = 0
  for (const unit of splitUnits(text)) {
    const index = text.indexOf(unit, cursor)
    if (index < 0) continue
    spans.push({ start: index, end: index + unit.length })
    cursor = index + unit.length
  }
  return spans
}

function splitLongSpan(text, span, maxChars) {
  const raw = text.slice(span.start, span.end)
  const units = unitSpans(raw)
  const pieces = []
  let start = 0
  let end = 0
  let length = 0
  for (const unit of units) {
    const unitLength = nonWhitespaceLength(raw.slice(unit.start, unit.end))
    if (length > 0 && length + unitLength > maxChars) {
      pieces.push({ start: span.start + start, end: span.start + end })
      start = unit.start
      length = 0
    }
    end = unit.end
    length += unitLength
  }
  if (end > start) pieces.push({ start: span.start + start, end: span.start + end })
  if (!pieces.length) {
    // 没有句子标点的超长段：硬切，保证每块不超过 maxChars。
    for (let cursor = 0; cursor < raw.length; cursor += maxChars) {
      pieces.push({ start: span.start + cursor, end: span.start + Math.min(raw.length, cursor + maxChars) })
    }
    return pieces
  }
  // 单个句子本身比 maxChars 还长：继续硬切，避免一次送太多。
  const hard = []
  for (const piece of pieces) {
    if (piece.end - piece.start <= maxChars) { hard.push(piece); continue }
    for (let cursor = piece.start; cursor < piece.end; cursor += maxChars) {
      hard.push({ start: cursor, end: Math.min(piece.end, cursor + maxChars) })
    }
  }
  return hard
}

/**
 * 在文字里按段落分组，每组尽量 >= minChars、<= maxChars。
 * 返回的 start/end 是相对整段文字的偏移，拼回去时不会丢掉段落间空白。
 */
export function buildChunks(text, settings = {}) {
  const source = String(text ?? '')
  const maxChars = Math.max(400, Number(settings.maxChars) || 1000)
  const minChars = Math.min(maxChars, Math.max(HARD_MIN, Number(settings.minChars) || 400))
  const maxHard = Math.min(1800, Math.round(maxChars * 1.5))
  const spans = []
  for (const span of paragraphSpans(source)) {
    if (nonWhitespaceLength(source.slice(span.start, span.end)) > maxChars) spans.push(...splitLongSpan(source, span, maxChars))
    else spans.push(span)
  }
  const groups = []
  let current = null
  for (const span of spans) {
    const length = nonWhitespaceLength(source.slice(span.start, span.end))
    if (!current) { current = { start: span.start, end: span.end }; continue }
    const currentLength = nonWhitespaceLength(source.slice(current.start, current.end))
    const gap = Math.max(0, span.start - current.end)
    const combined = currentLength + gap + length
    if (currentLength < minChars && combined <= maxHard) { current.end = span.end; continue }
    if (combined > maxChars) { groups.push(current); current = { start: span.start, end: span.end }; continue }
    current.end = span.end
  }
  if (current) groups.push(current)
  let changed = true
  while (changed) {
    changed = false
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]
      const length = nonWhitespaceLength(source.slice(group.start, group.end))
      if (length >= minChars) continue
      const previous = groups[index - 1]
      const next = groups[index + 1]
      if (previous) {
        const previousLength = nonWhitespaceLength(source.slice(previous.start, previous.end))
        if (previousLength + (group.start - previous.end) + length <= maxHard) {
          previous.end = group.end
          groups.splice(index, 1)
          changed = true
          break
        }
      }
      if (next) {
        const nextLength = nonWhitespaceLength(source.slice(next.start, next.end))
        if (length + (next.start - group.end) + nextLength <= maxHard) {
          group.end = next.end
          groups.splice(index + 1, 1)
          changed = true
          break
        }
      }
    }
  }
  return groups.map(group => {
    const chunkText = source.slice(group.start, group.end)
    const contentLength = nonWhitespaceLength(chunkText)
    return {
      start: group.start,
      end: group.end,
      text: chunkText,
      paragraphs: splitParagraphs(chunkText),
      contentLength,
      skip: contentLength < minChars
    }
  })
}

function placeholderNumbers(value) {
  const numbers = new Set()
  for (const match of String(value ?? '').matchAll(/【\s*RW\s*(\d+)\s*】/g)) numbers.add(match[1])
  return numbers
}

function keepsPlaceholders(input, output) {
  for (const number of placeholderNumbers(input)) {
    const pattern = new RegExp('【\\s*RW\\s*' + number + '\\s*】', 'g')
    const found = String(output ?? '').match(pattern) || []
    if (found.length !== 1) return false
  }
  return true
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const count = Math.max(1, Math.min(limit, items.length))
  async function run() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: count }, run))
  return results
}

function maxTokensFor(text) {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(600, Math.ceil(String(text).length * 1.15) + 80))
}

async function polishChunk(chunk, { client, settings, signal, stats }) {
  const first = firstSentenceOf(chunk.text)
  const apiInput = chunk.text
  let maxTokens = maxTokensFor(apiInput)
  let temperature = settings.temperature
  let lastReason = 'rewrite-failed'
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await client.complete({ text: apiInput, temperature, maxTokens, signal })
      if (result.truncated || (result.finishReason && result.finishReason !== 'stop')) {
        lastReason = result.truncated ? 'truncated:' + (result.truncationReason || '') : 'finish:' + result.finishReason
        maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.round(maxTokens * 1.6))
        temperature = Math.max(0.05, temperature - 0.05)
        continue
      }
      let output = String(result.text ?? '').trim()
      if (!keepsPlaceholders(apiInput, output)) { lastReason = 'placeholder'; temperature = Math.max(0.05, temperature - 0.05); continue }
      const validation = validateRewrite(chunk.text, output, { finishReason: result.finishReason, truncated: result.truncated })
      if (!validation.ok) {
        lastReason = validation.reason
        temperature = Math.max(0.05, temperature - 0.05)
        continue
      }
      output = ensureOpening(output, first)
      return { ok: true, text: reflowParagraphs(output, chunk.paragraphs), recall: validation.recall, ratio: validation.ratio }
    } catch (error) {
      if (isAbort(error)) throw error
      if (['input_too_short', 'no-key', 'auth', 'endpoint', 'config', 'bad_request', 'upstream-mock'].includes(error?.code)) throw error
      lastReason = error?.code || error?.message || 'rewrite-failed'
      temperature = Math.max(0.05, temperature - 0.05)
    }
  }
  return { ok: false, reason: lastReason }
}

/** 润色一段纯文字（占位符还在里面）。返回的字符串也带占位符，由外层还原。 */
export async function polishProseText(core, { client, settings, signal, stats }) {
  const text = String(core ?? '')
  if (!text.trim()) return text
  const chunks = buildChunks(text, settings)
  stats.chunks += chunks.length
  if (!chunks.length) return text
  const results = await mapLimit(chunks, settings.concurrency, async chunk => {
    if (chunk.skip) { stats.skipped += 1; return { text: chunk.text, ok: false, reason: 'short' } }
    if (stats.fatal) { stats.skipped += 1; return { text: chunk.text, ok: false, reason: 'fatal' } }
    try {
      const result = await polishChunk(chunk, { client, settings, signal, stats })
      if (result.ok) {
        stats.polished += 1
        if (Number.isFinite(result.recall)) stats.recalls.push(result.recall)
        return result
      }
      stats.failed += 1
      stats.reasons.push(result.reason)
      return { text: chunk.text, ok: false, reason: result.reason }
    } catch (error) {
      if (isAbort(error)) throw error
      stats.failed += 1
      stats.reasons.push(error?.code || error?.message || 'rewrite-failed')
      if (['no-key', 'auth', 'endpoint', 'config', 'upstream-mock'].includes(error?.code)) stats.fatal = error
      return { text: chunk.text, ok: false, reason: error?.code || 'rewrite-failed' }
    }
  })
  let output = ''
  let cursor = 0
  for (let index = 0; index < chunks.length; index += 1) {
    output += text.slice(cursor, chunks[index].start)
    output += results[index].text
    cursor = chunks[index].end
  }
  output += text.slice(cursor)
  return output
}

export function createStats() {
  return { chunks: 0, polished: 0, skipped: 0, failed: 0, recalls: [], reasons: [], fatal: null }
}

export function summarizeStats(stats) {
  return {
    chunks: stats.chunks,
    polished: stats.polished,
    skipped: stats.skipped,
    failed: stats.failed,
    recall: stats.recalls.length ? Math.round((stats.recalls.reduce((sum, value) => sum + value, 0) / stats.recalls.length) * 1000) / 1000 : null,
    reasons: [...new Set(stats.reasons)].slice(0, 4)
  }
}

/**
 * 润色整轮 rawText：HTML / 代码围栏 / 插件标记 / URL 等全部保留，
 * 只改文字。返回 { status, text?, reason?, stats }。
 */
export async function prepareRawText(rawText, { client, settings, signal } = {}) {
  const original = String(rawText ?? '')
  const stats = createStats()
  if (!original.trim()) return { status: 'skipped', reason: 'empty', stats }
  const mapped = await mapProseSegmentsAsync(original, async core => {
    if (stats.fatal) return core
    return await polishProseText(core, { client, settings, signal, stats })
  })
  const summary = summarizeStats(stats)
  if (stats.fatal) {
    const reason = stats.fatal.code || stats.fatal.message || 'fatal'
    return { status: reason === 'no-key' ? 'skipped' : 'failed', reason, stats: summary }
  }
  if (mapped.text === original) {
    const reason = stats.chunks === 0
      ? 'too-short'
      : stats.polished === 0
        ? (stats.reasons[0] || (stats.skipped >= stats.chunks ? 'too-short' : 'no-change'))
        : 'no-change'
    return { status: 'skipped', reason, stats: summary }
  }
  const before = collectProtected(original)
  const after = collectProtected(mapped.text)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return { status: 'failed', reason: 'structure', stats: summary }
  }
  return { status: 'ready', text: mapped.text, stats: summary }
}
