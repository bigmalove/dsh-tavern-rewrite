// 正文流式润色：正文 token 还在写的时候，按完整段落切出来先改写、先显示。
//
// 切点规则与结算后的整段润色完全一致：围栏、MVU 变量块、RunningHub 标记块整块跳过，
// 只在纯文字段落的段落边界切；改写台要求至少 400 字，切点也跟着这个下限走。

import { protectedSegments } from './segments.mjs'
import { prepareRawText } from './polish.mjs'

const PARAGRAPH_BREAK = /\n[ \t]*\n+/g
const HARD_MIN = 400

function minimumOf(minChars) {
  const raw = typeof minChars === 'function' ? minChars() : minChars
  return Math.max(HARD_MIN, Math.round(Number(raw) || HARD_MIN))
}

/**
 * plan(buffer, { eof }) 返回可以从缓冲里切走的字符数（null = 再等等）。
 * - eof 时把剩下的全部交出去；
 * - 非 eof 时只在完整段落之后切，且这一段至少有 minChars 字；
 * - 围栏/标记块没闭合时它们会被当成整段保留内容，切点自动落在它前面。
 */
export function createStreamPlanner({ minChars = HARD_MIN } = {}) {
  return function plan(buffer, { eof = false } = {}) {
    const text = String(buffer ?? '')
    if (!text) return null
    if (eof) return text.length
    // 切点至少要有 minChars 字：缓冲还短就不必扫描。
    if (text.length < minimumOf(minChars)) return null
    const minimum = minimumOf(minChars)
    let offset = 0
    for (const segment of protectedSegments(text)) {
      if (segment.kind !== 'text') {
        offset += segment.text.length
        continue
      }
      PARAGRAPH_BREAK.lastIndex = 0
      let match
      while ((match = PARAGRAPH_BREAK.exec(segment.text))) {
        const cut = offset + match.index + match[0].length
        if (cut >= minimum) return cut
      }
      offset += segment.text.length
    }
    return null
  }
}

/**
 * 改写一段正文。太短、结构校验不过、模型跑题都退回原文——
 * 流式阶段宁可少润一句，也不能在玩家眼前断字或塞进 HTML。
 */
export function createStreamRewrite({ client, settings, onSkip = () => {} } = {}) {
  return async function rewrite(text, { signal } = {}) {
    const source = String(text ?? '')
    if (!source.trim()) return source
    const result = await prepareRawText(source, { client, settings, signal })
    if (result?.status === 'ready' && typeof result.text === 'string' && result.text.trim()) return result.text
    if (result?.status === 'skipped' && result.reason === 'no-change') return source
    onSkip(result)
    return source
  }
}
