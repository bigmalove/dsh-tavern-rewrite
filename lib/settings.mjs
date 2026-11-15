export const DEFAULT_SETTINGS = Object.freeze({
  auto: true,
  baseURL: 'https://revnovel.org/rw',
  // revnovel.org 裸改写端点（/rw/v1）当前模型为 rewrite3-27B；旧配置会自动迁移。
  model: 'rewrite3-27B',
  // 0.5–0.8 之间改写最稳定。
  temperature: 0.6,
  maxChars: 1000,
  minChars: 400,
  // 校验阈值：null = 按模型族自动（rewrite3-27B → 0.40/0.30/2.20，
  // 只润色不改写的模型 → 0.65/0.55/1.45）。改这三个数就能自己调松紧，见 lib/polish.mjs 的 resolveGates。
  recallMin: null,
  precisionMin: null,
  ratioMax: null,
  // 流式润色：正文写到一段就先改写、先显示润色版，结算后不再整段重写。
  stream: true,
  // 一段攒到多少字才送去改写；改写台最少收 400 字，所以不能低于 400。
  streamMinChars: 500,
  concurrency: 2,
  timeoutMs: 90_000,
  retries: 2
})

const LEGACY_HOSTS = new Set(['rewrite.revnovel.org'])

function isRevnovelHost(rawBaseURL) {
  try {
    const host = new URL(String(rawBaseURL || '')).hostname.toLowerCase()
    return host === 'revnovel.org' || LEGACY_HOSTS.has(host)
  } catch {
    return false
  }
}

function migrateBaseURL(rawBaseURL) {
  const cleaned = text(rawBaseURL, DEFAULT_SETTINGS.baseURL, 500).replace(/\/+$/, '')
  try {
    const url = new URL(cleaned)
    const host = url.hostname.toLowerCase()
    const path = url.pathname.replace(/\/+$/, '')
    if (LEGACY_HOSTS.has(host)) return DEFAULT_SETTINGS.baseURL
    if (host === 'revnovel.org' && (!path || /^\/(v1|api|keys|login|health)$/i.test(path))) {
      return DEFAULT_SETTINGS.baseURL
    }
  } catch { /* 保留原文本交给调用侧校验 */ }
  return cleaned
}

// 旧版或云端托管模型 id。切回裸改写端点 /rw 后，残留配置自动迁到 rewrite3-27B。
const LEGACY_MODELS = new Set([
  'rewrite-v9-c600-nvfp4',
  'rewrite-v9',
  'rewrite-v12-fp8',
  'deepseek-flash/rewrite3-27B',
  'deepseek-v4-pro/rewrite3-27B'
])

function isLegacyV9Model(model) {
  return model === 'rewrite-v9-c600-nvfp4' || model === 'rewrite-v9' || /^rewrite-v9(?:-|$)/i.test(model)
}

function isLegacyRevnovelModel(model) {
  return LEGACY_MODELS.has(model)
    || /^rewrite-v\d+(?:-|$)/i.test(model)
    || /^[^/]+\/rewrite3-27B$/i.test(model)
}

// 阈值类设置允许“空 = 自动”：空字符串、null、undefined 都回落到 null。
function optionalNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.min(max, Math.max(min, parsed))
}

function number(value, fallback, min, max, integer = false) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.min(max, Math.max(min, parsed))
  return integer ? Math.round(clamped) : clamped
}

function text(value, fallback, maximum) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maximum) : fallback
}

export function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) }
  const maxChars = number(merged.maxChars, DEFAULT_SETTINGS.maxChars, 400, 2000, true)
  const minChars = Math.min(maxChars, number(merged.minChars, DEFAULT_SETTINGS.minChars, 400, 2000, true))
  const rawBaseURL = text(merged.baseURL, DEFAULT_SETTINGS.baseURL, 500)
  const baseURL = migrateBaseURL(rawBaseURL)
  let model = text(merged.model, DEFAULT_SETTINGS.model, 200)
  let temperature = number(merged.temperature, DEFAULT_SETTINGS.temperature, 0, 1)
  if (isLegacyV9Model(model) || (isRevnovelHost(rawBaseURL) && isLegacyRevnovelModel(model))) {
    model = DEFAULT_SETTINGS.model
    // 旧默认 0.15 是给 v9 用的；新版模型在这个温度太保守。
    if (temperature <= 0.4) temperature = DEFAULT_SETTINGS.temperature
  }
  const streamMinChars = number(merged.streamMinChars, DEFAULT_SETTINGS.streamMinChars, 400, 2000, true)
  return {
    auto: merged.auto === false || merged.auto === 'false' ? false : true,
    stream: merged.stream === false || merged.stream === 'false' ? false : true,
    streamMinChars,
    baseURL,
    model,
    temperature,
    maxChars,
    minChars,
    recallMin: optionalNumber(merged.recallMin, 0.05, 0.95),
    precisionMin: optionalNumber(merged.precisionMin, 0.05, 0.95),
    ratioMax: optionalNumber(merged.ratioMax, 1.1, 3),
    concurrency: number(merged.concurrency, DEFAULT_SETTINGS.concurrency, 1, 4, true),
    timeoutMs: number(merged.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 5000, 180_000, true),
    retries: number(merged.retries, DEFAULT_SETTINGS.retries, 0, 4, true)
  }
}

// 设置页返回给浏览器时的字段（不含密钥）。
export function publicSettings(settings) {
  return {
    auto: settings.auto !== false,
    stream: settings.stream !== false,
    streamMinChars: settings.streamMinChars,
    baseURL: settings.baseURL,
    model: settings.model,
    temperature: settings.temperature,
    maxChars: settings.maxChars,
    minChars: settings.minChars,
    recallMin: settings.recallMin ?? null,
    precisionMin: settings.precisionMin ?? null,
    ratioMax: settings.ratioMax ?? null,
    concurrency: settings.concurrency,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries
  }
}
