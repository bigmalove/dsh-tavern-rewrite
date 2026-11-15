import { RewriteError, isAbort } from './api.mjs'
import { collectProtected, mapProseSegmentsAsync } from './segments.mjs'

const HARD_MIN = 400
const MAX_OUTPUT_TOKENS = 4000
const MAX_ATTEMPTS = 3
const FATAL_CODES = new Set([
  'no-key', 'auth', 'endpoint', 'config', 'bad_request',
  'input_too_long', 'upstream-mock', 'model_not_found', 'model_offline'
])

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

/**
 * v12 在只给正文时会接着往下写；把原文的第一句作为 assistant 预填，
 * 模型就会从「改写」而不是「续写」的位置开始。返回的锚点会原样拼回去。
 */
export function prefillAnchor(value, style = 'sentence') {
  const text = String(value ?? '')
  if (!text.trim()) return ''
  if (style !== 'paragraph') {
    const first = firstSentenceOf(text)
    if (first && first.length >= 2 && /\p{L}/u.test(first) && first.length < nonWhitespaceLength(text)) return first + '\n'
  }
  const paragraph = splitParagraphs(text)[0] || text
  const trimmed = paragraph.trim()
  return trimmed && trimmed.length < nonWhitespaceLength(text) ? trimmed + '\n\n' : ''
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

/**
 * 输入里有多大比例的相邻二字组出现在输出里。
 *
 * 这个数高度依赖模型族，不能拿一套阈值套所有模型：
 * - 忠实润色模型（v9/v12）：只改标点和少量用词，通常在 0.9 以上，跑题会掉到 0.5 以下；
 * - 改写台现在的 rewrite3-27B：换词、改句式、补写描写，400–800 字中文正文实测
 *   稳定在 0.40–0.70，偶尔 0.70。用「0.9 以上」的直觉定阈值，正常输出必然被判跑题。
 * 阈值按模型族给默认值（见 resolveGates），并且和 precision 联合判定（见 validateRewrite）。
 */
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

const REPETITION_SIZE = 24
const REPETITION_RATIO = 0.12

/** 重复的 24 字窗口折算成「多出来的字数」；known 里的窗口视为原文已有，不算复读。 */
function repetitionExcess(text, known) {
  if (text.length < REPETITION_SIZE) return 0
  const counts = new Map()
  for (let index = 0; index <= text.length - REPETITION_SIZE; index += 1) {
    const gram = text.slice(index, index + REPETITION_SIZE)
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  let extra = 0
  for (const [gram, count] of counts) {
    if (count <= 1) continue
    if (known && known.has(gram)) continue
    extra += (count - 1) * REPETITION_SIZE
  }
  return extra
}

function suspiciousRepetition(input, output) {
  const source = cleanForRecall(input)
  const target = cleanForRecall(output)
  if (target.length < 80) return false
  const known = new Set()
  for (let index = 0; index <= source.length - REPETITION_SIZE; index += 1) known.add(source.slice(index, index + REPETITION_SIZE))
  const extra = repetitionExcess(target, known)
  // 原文自己就在重复（整段同一句、副歌式描写）时，改写后当然也重复；
  // 这时按原文自己的重复率放宽，否则会把正常改写判成复读整段丢掉。
  const baseline = source.length ? repetitionExcess(source, null) / source.length : 0
  const floor = Math.max(REPETITION_RATIO, baseline * 1.5 + 0.02)
  return extra > target.length * floor
}

// 校验阈值的两套默认值。数值不是拍脑袋定的：
// - faithful：给只润色不改写的模型（v9/v12），实测忠实输出 recall > 0.9；
// - rewrite：给改写台的 rewrite3-27B，用真实密钥实测 400–800 字正文，
//   recall 0.40–0.70、precision ≈ recall / ratio、ratio 0.97–1.91。
const GATE_PROFILES = Object.freeze({
  faithful: Object.freeze({ recallMin: 0.65, precisionMin: 0.55, ratioMax: 1.45 }),
  rewrite: Object.freeze({ recallMin: 0.40, precisionMin: 0.30, ratioMax: 2.20 })
})

// 输出长度硬上限：超过软上限 1.5 倍就不再保留候选，直接判失败。
const RATIO_HARD_FACTOR = 1.5
// 保留「最优候选」时长度还能放宽多少（软上限的 1.25 倍以内）。
const RELAXED_RATIO_FACTOR = 1.25
const RELAXED_RECALL_SHARE = 0.4
const RELAXED_PRECISION_SHARE = 0.5

function usableNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 按模型族选校验阈值，设置里的三个数字可以逐项覆盖（null/空 = 用模型默认值）。
 * rewrite3-27B 是降重改写模型，不是校对器：它的正常输出按「忠实润色」的阈值
 * 一定过不了，所以默认值必须跟模型族走，而不是写死一套。
 */
export function resolveGates(settings = {}) {
  const model = String(settings?.model || '')
  const base = !model || /rewrite3/i.test(model) ? GATE_PROFILES.rewrite : GATE_PROFILES.faithful
  return {
    recallMin: usableNumber(settings?.recallMin) ?? base.recallMin,
    precisionMin: usableNumber(settings?.precisionMin) ?? base.precisionMin,
    ratioMax: usableNumber(settings?.ratioMax) ?? base.ratioMax
  }
}

export function validateRewrite(input, output, { finishReason = 'stop', truncated = false, gates } = {}) {
  const text = String(output ?? '').trim()
  const limits = gates || resolveGates({})
  if (!text) return { ok: false, reason: 'empty', gates: limits }
  if (truncated) return { ok: false, reason: 'truncated', gates: limits }
  if (finishReason && finishReason !== 'stop') return { ok: false, reason: 'finish:' + finishReason, gates: limits }
  // 只改标点/空白的“润色”没有意义，交给上层换温度重试。
  if (cleanForRecall(text) === cleanForRecall(input)) return { ok: false, reason: 'no-change', gates: limits }
  const inputLength = nonWhitespaceLength(input)
  const outputLength = nonWhitespaceLength(text)
  const ratio = outputLength / Math.max(1, inputLength)
  if (ratio < 0.55) return { ok: false, reason: 'too-short', ratio, gates: limits }
  // 占位符段落里不应该出现新的 HTML 或围栏；出现了说明模型在自造结构。
  if (/(<\/?[a-z][\w:-]*\b|```)/i.test(text)) return { ok: false, reason: 'new-html', ratio, gates: limits }
  // 网文模型偶尔会在正文前补「第295章 他来了（三更）」这类标题/更新说明。
  const chapterMark = /第\s*[0-9０-９一二三四五六七八九十百千零〇两]+\s*[章节回卷]/
  if (chapterMark.test(text) && !chapterMark.test(String(input ?? ''))) return { ok: false, reason: 'new-heading', ratio, gates: limits }
  const recall = bigramRecall(input, text)
  // 反向重合度：输出里有多大比例的二组能在原文找到。只看 recall 会把
  // 「原文照抄 + 后面续写新剧情」当成忠实改写，所以两个方向都要看。
  const precision = bigramRecall(text, input)
  // 联合判定：两道指标同时偏低才算偏离原文，单道偏低不再单独否决。
  // 之前是「任一不过就整段丢弃」，而 rewrite3-27B 的 precision 正常就在 0.3–0.5，
  // 一次误判就把整段原文写回去，用户看到的是「润色了但被丢掉」。
  const recallShort = (limits.recallMin - recall) / limits.recallMin
  const precisionShort = (limits.precisionMin - precision) / limits.precisionMin
  if (recallShort > 0 && precisionShort > 0) {
    return {
      ok: false,
      reason: recallShort >= precisionShort ? 'off-topic' : 'new-content',
      recall,
      precision,
      ratio,
      soft: true,
      recallShort,
      precisionShort,
      gates: limits
    }
  }
  // 长度单独成闸：改写模型会主动补写，但补到原文 2.2 倍以上就说明它在自己编剧情。
  if (ratio > limits.ratioMax) {
    return {
      ok: false,
      reason: 'too-long',
      recall,
      precision,
      ratio,
      soft: ratio <= limits.ratioMax * RATIO_HARD_FACTOR,
      gates: limits
    }
  }
  if (suspiciousRepetition(input, text)) return { ok: false, reason: 'repetition', recall, precision, ratio, gates: limits }
  const inputEnd = String(input ?? '').trim().slice(-1)
  const outputEnd = text.slice(-1)
  if ('。！？!?”…'.includes(inputEnd) && '，,、；;：:—-'.includes(outputEnd)) return { ok: false, reason: 'cut-off', ratio, gates: limits }
  return { ok: true, recall, precision, ratio, gates: limits }
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
 * 结尾不足 minChars 的尾巴会并进前一段（允许略超 maxChars）：宁可单段多一点，
 * 也不要出现「前两段是润色后的文风、尾巴是原文」的拼接正文。
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
  // 尾巴合并放在「补足 minChars」的循环之后：循环受 maxHard 限制，
  // 1500 字 / maxChars 500 / minChars 400 时尾巴 300 字会因超 maxHard 被留下，
  // 面板只记一条「太短」，玩家看到的就是半段没润色的原文。
  // 这里宁可让最后一段超过 maxChars（最多到 2 倍、1800 字封顶），也不留半截原文：
  // 改写台单次能收 20000 字，多送一点没有代价，文风拼接才是玩家能看见的问题。
  if (groups.length >= 2) {
    const tail = groups[groups.length - 1]
    const tailLength = nonWhitespaceLength(source.slice(tail.start, tail.end))
    const previous = groups[groups.length - 2]
    const merged = nonWhitespaceLength(source.slice(previous.start, tail.end))
    if (tailLength < minChars && merged <= Math.min(1800, maxChars * 2)) {
      previous.end = tail.end
      groups.pop()
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

function placeholderCounts(value) {
  const counts = new Map()
  for (const match of String(value ?? '').matchAll(/【\s*RW\s*(\d+)\s*】/g)) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1)
  }
  return counts
}

function keepsPlaceholders(input, output) {
  const before = placeholderCounts(input)
  const after = placeholderCounts(output)
  for (const [number, count] of before) if (after.get(number) !== count) return false
  // 模型偶尔会自己编一个【RW13】出来；多出来的占位符同样不能写回正文。
  for (const number of after.keys()) if (!before.has(number)) return false
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

function maxTokensFor(text, model = '') {
  const base = Math.ceil(String(text).length * 1.15) + 80
  // rewrite3-27B 是推理模型，max_tokens 需要给 reasoning_content 留出余量，避免正文被截断。
  if (/rewrite3/i.test(String(model))) {
    return Math.min(MAX_OUTPUT_TOKENS, Math.max(1600, Math.ceil(String(text).length * 1.5) + 1200))
  }
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(600, base))
}

/** 三次都不合格时，用这个分数挑出「最像原文的那一版」。 */
function candidateScore(validation) {
  if (!validation) return -Infinity
  const recall = Number(validation.recall) || 0
  const precision = Number(validation.precision) || 0
  const ratio = Number(validation.ratio) || 1
  return recall * 0.7 + precision * 0.3 - Math.max(0, ratio - 1) * 0.15
}

/**
 * 三次都撞软阈值时，这一版还能不能写回正文。
 * 只救「差一点点」的那一版：两项指标各自最多比阈值低四成/五成，长度不超过软上限的 1.25 倍。
 * 硬伤（结构、占位符、截断、复读、标签）不会走到这里，那些失败一律保留原文。
 */
export function relaxedAcceptable(validation, { gates } = {}) {
  if (!validation || validation.ok !== false || validation.soft !== true) return false
  const limits = gates || validation.gates || resolveGates({})
  const ratio = Number(validation.ratio) || 0
  if (ratio < 0.55) return false
  if (ratio > limits.ratioMax * RELAXED_RATIO_FACTOR) return false
  const recallShort = (limits.recallMin - (Number(validation.recall) || 0)) / limits.recallMin
  const precisionShort = (limits.precisionMin - (Number(validation.precision) || 0)) / limits.precisionMin
  return recallShort <= RELAXED_RECALL_SHARE && precisionShort <= RELAXED_PRECISION_SHARE
}

async function polishChunk(chunk, { client, settings, signal, stats }) {
  const source = chunk.text
  const first = firstSentenceOf(source)
  const modelName = String(settings?.model || '')
  const gates = resolveGates(settings)
  let maxTokens = maxTokensFor(source, modelName)
  let temperature = Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.6
  let lastReason = 'rewrite-failed'
  let best = null
  const usePrefill = !/rewrite3/i.test(modelName) && !modelName.includes('/')
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // rewrite3-27B 发 assistant 预填会触发续写而非改写，直接发 user 正文；
    // 旧版/自部署裸模型（如 rewrite-v12-fp8）：1) 第一句做锚点；2) 整段做锚点；3) 不预填。
    const prefill = !usePrefill
      ? ''
      : attempt === 0
        ? prefillAnchor(source, 'sentence')
        : attempt === 1
          ? prefillAnchor(source, 'paragraph')
          : ''
    try {
      const result = await client.complete({ text: source, prefill, temperature, maxTokens, signal })
      if (result.truncated || (result.finishReason && result.finishReason !== 'stop')) {
        const reason = String(result.truncationReason || '')
        if (result.truncated && /repeat|periodic/i.test(reason)) {
          lastReason = 'repetition'
          temperature = Math.max(0.3, temperature - 0.15)
        } else {
          lastReason = 'truncated'
          maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.round(maxTokens * 1.6))
        }
        continue
      }
      let output = String(result.text ?? '').trim()
      if (!keepsPlaceholders(source, output)) {
        lastReason = 'placeholder'
        temperature = Math.min(1, temperature + 0.05)
        continue
      }
      const validation = validateRewrite(source, output, { finishReason: result.finishReason, truncated: result.truncated, gates })
      if (!validation.ok) {
        lastReason = validation.reason
        if (validation.soft && (!best || candidateScore(validation) > candidateScore(best.validation))) {
          best = { text: output, validation }
        }
        // 重试方向：偏离原文、掺新内容、过长都是「采样把模型带偏了」，
        // 降温只会把它锁在「规规矩矩逐句换词」上——实测降温三次 recall 一路下降
        // （0.559 → 0.546 → 0.483），输出反而更长。这里改成升温换采样。
        if (validation.reason === 'no-change') temperature = Math.min(1, temperature + 0.15)
        else if (validation.reason === 'too-short') maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.round(maxTokens * 1.4))
        else if (validation.soft) temperature = Math.min(1, temperature + 0.18)
        else temperature = Math.max(0.3, temperature - 0.1)
        continue
      }
      output = ensureOpening(output, first)
      return { ok: true, text: reflowParagraphs(output, chunk.paragraphs), recall: validation.recall, ratio: validation.ratio }
    } catch (error) {
      if (isAbort(error)) throw error
      // 这一段太短被服务端拒绝：只跳过这一段，不影响后面的分段。
      if (error?.code === 'input_too_short') return { ok: false, reason: 'too-short' }
      // 有的 OpenAI 兼容服务不接受 assistant 预填；这一次去掉预填再试，
      // 不要因为一个 400 就把整轮润色判死。
      if (error?.code === 'bad_request' && prefill) {
        lastReason = 'bad_request'
        continue
      }
      if (FATAL_CODES.has(error?.code)) throw error
      lastReason = error?.code || error?.message || 'rewrite-failed'
      temperature = Math.min(1, temperature + 0.1)
    }
  }
  // 三次都不合格：不把整段原文写回去，保留最接近的一版，标记成「放宽」。
  // 之前用户只有两个选择——完全没润色，或者精确匹配；「润色了但偏离偏大」被丢掉了。
  if (best && relaxedAcceptable(best.validation, { gates })) {
    const output = ensureOpening(best.text, first)
    return {
      ok: true,
      relaxed: true,
      text: reflowParagraphs(output, chunk.paragraphs),
      recall: best.validation.recall,
      ratio: best.validation.ratio
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
    if (chunk.skip) { stats.skipped += 1; stats.reasons.push('short'); return { text: chunk.text, ok: false, reason: 'short' } }
    if (stats.fatal) { stats.skipped += 1; return { text: chunk.text, ok: false, reason: 'fatal' } }
    try {
      const result = await polishChunk(chunk, { client, settings, signal, stats })
      if (result.ok) {
        stats.polished += 1
        if (result.relaxed) stats.relaxed += 1
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
      if (FATAL_CODES.has(error?.code)) stats.fatal = error
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
  // relaxed = 三段闸门都没过、但保留下来的「最优候选」段数；面板要能看见它。
  return { chunks: 0, polished: 0, relaxed: 0, skipped: 0, failed: 0, recalls: [], reasons: [], fatal: null }
}

export function summarizeStats(stats) {
  return {
    chunks: stats.chunks,
    polished: stats.polished,
    relaxed: stats.relaxed || 0,
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
    const reason = stats.chunks === 0 || stats.skipped >= stats.chunks
      ? 'too-short'
      : stats.polished === 0
        ? (stats.reasons[0] || 'no-change')
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
