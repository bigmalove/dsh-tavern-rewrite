export const DEFAULT_SETTINGS = Object.freeze({
  auto: true,
  baseURL: 'https://rewrite.revnovel.org',
  model: 'rewrite-v9-c600-nvfp4',
  temperature: 0.15,
  maxChars: 1000,
  minChars: 400,
  concurrency: 2,
  timeoutMs: 90_000,
  retries: 2
})

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
  return {
    auto: merged.auto === false || merged.auto === 'false' ? false : true,
    baseURL: text(merged.baseURL, DEFAULT_SETTINGS.baseURL, 500).replace(/\/+$/, ''),
    model: text(merged.model, DEFAULT_SETTINGS.model, 200),
    temperature: number(merged.temperature, DEFAULT_SETTINGS.temperature, 0, 1),
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
