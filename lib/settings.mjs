export const DEFAULT_SETTINGS = Object.freeze({
  auto: true,
  baseURL: 'https://rewrite.revnovel.org',
  // 改写台 2026-10 起只提供 rewrite-v12-fp8；旧配置里的 v9 会自动迁移。
  model: 'rewrite-v12-fp8',
  // v12 温度太低会原样回显，0.5–0.8 之间改写最稳定。
  temperature: 0.6,
  maxChars: 1000,
  minChars: 400,
  concurrency: 2,
  timeoutMs: 90_000,
  retries: 2
})

// 旧版默认模型。服务端已经删掉这些 id，配置里残留时直接迁到当前默认值，
// 否则用户升级插件后仍会一直收到 404 model_not_found。
const LEGACY_MODELS = new Set(['rewrite-v9-c600-nvfp4', 'rewrite-v9'])

function isLegacyModel(model) {
  return LEGACY_MODELS.has(model) || /^rewrite-v9(?:-|$)/i.test(model)
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
  let model = text(merged.model, DEFAULT_SETTINGS.model, 200)
  let temperature = number(merged.temperature, DEFAULT_SETTINGS.temperature, 0, 1)
  if (isLegacyModel(model)) {
    model = DEFAULT_SETTINGS.model
    // 旧默认 0.15 是给 v9 用的；v12 在这个温度基本只会回显。
    if (temperature <= 0.4) temperature = DEFAULT_SETTINGS.temperature
  }
  return {
    auto: merged.auto === false || merged.auto === 'false' ? false : true,
    baseURL: text(merged.baseURL, DEFAULT_SETTINGS.baseURL, 500).replace(/\/+$/, ''),
    model,
    temperature,
    maxChars,
    minChars,
    concurrency: number(merged.concurrency, DEFAULT_SETTINGS.concurrency, 1, 4, true),
    timeoutMs: number(merged.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 5000, 180_000, true),
    retries: number(merged.retries, DEFAULT_SETTINGS.retries, 0, 4, true)
  }
}

// 设置页返回给浏览器时的字段（不含密钥）。
export function publicSettings(settings) {
  return {
    auto: settings.auto !== false,
    baseURL: settings.baseURL,
    model: settings.model,
    temperature: settings.temperature,
    maxChars: settings.maxChars,
    minChars: settings.minChars,
    concurrency: settings.concurrency,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries
  }
}
