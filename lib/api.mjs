const USER_AGENT = 'dsh-tavern-rewrite/0.1 (+https://github.com/flizzywine/dsh-tavern)'

export class RewriteError extends Error {
  constructor(message, { code = 'rewrite', status = 0, retryable = false, aborted = false } = {}) {
    super(message)
    this.name = 'RewriteError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.aborted = aborted
  }
}

export function isAbort(error) {
  return Boolean(error?.aborted || error?.name === 'AbortError' || error?.code === 'aborted')
}

export function normalizeBaseURL(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new RewriteError('服务地址不能为空', { code: 'config' })
  let url
  try { url = new URL(raw) } catch { throw new RewriteError('服务地址格式不对：' + raw.slice(0, 120), { code: 'config' }) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RewriteError('服务地址必须以 http:// 或 https:// 开头', { code: 'config' })
  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length)
  if (path.endsWith('/v1')) path = path.slice(0, -3)
  // 用户可能直接粘贴了改写台的文档页 /api；那不是 API 前缀。
  if (path === '/api' && /(^|\.)revnovel\.org$/i.test(url.hostname)) path = ''
  url.pathname = path || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function endpoint(baseURL, path) {
  return baseURL + '/v1/' + path
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new RewriteError('已取消', { code: 'aborted', aborted: true })); return }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new RewriteError('已取消', { code: 'aborted', aborted: true }))
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function errorBody(response) {
  let text = ''
  try { text = await response.text() } catch { /* 忽略 */ }
  let message = text
  let code = ''
  try {
    const data = JSON.parse(text)
    if (data && typeof data.error === 'object' && data.error !== null) {
      message = data.error.message || JSON.stringify(data.error)
      code = typeof data.error.code === 'string' ? data.error.code : ''
    } else if (data && typeof data.error === 'string') {
      message = data.error
    }
  } catch { /* 纯文本错误 */ }
  return { message: String(message || response.statusText || '').trim().slice(0, 600), code }
}

export function createRewriteClient({
  baseURL,
  apiKey,
  model,
  timeoutMs = 90_000,
  retries = 2,
  fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new RewriteError('当前环境没有 fetch，无法调用改写 API', { code: 'config' })
  const base = normalizeBaseURL(baseURL)
  const key = String(apiKey ?? '').trim()
  if (!key) throw new RewriteError('未配置改写 API 密钥', { code: 'no-key' })
  const selectedModel = String(model || 'rewrite-v9-c600-nvfp4').trim()

  function redact(message) {
    const text = String(message ?? '')
    if (key.length < 8) return text
    return text.split(key).join('***')
  }

  function signalFor(signal) {
    if (signal?.aborted) return null
    const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs))
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  async function request(path, init, signal) {
    if (signal?.aborted) throw new RewriteError('已取消', { code: 'aborted', aborted: true })
    let response
    try {
      response = await fetchImpl(endpoint(base, path), {
        ...init,
        signal: signalFor(signal),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          Authorization: 'Bearer ' + key,
          ...(init?.headers || {})
        }
      })
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        if (signal?.aborted) throw new RewriteError('已取消', { code: 'aborted', aborted: true })
        throw new RewriteError('改写 API 请求超时', { code: 'timeout', retryable: true })
      }
      throw new RewriteError('连不上改写 API：' + redact(error?.message || error), { code: 'network', retryable: true })
    }
    if (!response.ok) {
      const body = await errorBody(response)
      const message = redact(body.message)
      if (response.status === 401 || response.status === 403) {
        throw new RewriteError('API 密钥无效或没有权限（HTTP ' + response.status + '）', { code: 'auth', status: response.status })
      }
      if (response.status === 404) {
        throw new RewriteError('接口不存在（HTTP 404），请检查服务地址是否填对', { code: 'endpoint', status: 404 })
      }
      if (response.status === 400 && body.code === 'input_too_short') {
        throw new RewriteError(message || '输入太短', { code: 'input_too_short', status: 400 })
      }
      if (response.status === 400) {
        throw new RewriteError(message || '改写请求格式不对（HTTP 400）', { code: 'bad_request', status: 400 })
      }
      if (response.status === 429) {
        throw new RewriteError('改写 API 忙（HTTP 429），稍后重试', { code: 'rate_limit', status: 429, retryable: true })
      }
      if (response.status >= 500) {
        throw new RewriteError('改写 API 暂时不可用（HTTP ' + response.status + '）', { code: 'upstream', status: response.status, retryable: true })
      }
      throw new RewriteError(message || '改写 API 返回 HTTP ' + response.status, { code: 'http', status: response.status })
    }
    let data
    try { data = await response.json() } catch { throw new RewriteError('改写 API 返回的不是 JSON', { code: 'bad_response', retryable: true }) }
    return data
  }

  async function withRetry(operation, signal) {
    let last
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try { return await operation() } catch (error) {
        last = error
        if (isAbort(error) || !error?.retryable || attempt >= retries || signal?.aborted) throw error
        await wait(600 * (2 ** attempt), signal)
      }
    }
    throw last
  }

  return {
    baseURL: base,
    model: selectedModel,
    async complete({ text, temperature = 0.15, maxTokens = 1200, signal } = {}) {
      const body = JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: String(text ?? '') }],
        temperature,
        max_tokens: Math.max(128, Math.round(Number(maxTokens) || 1200)),
        stream: false
      })
      const data = await withRetry(() => request('chat/completions', { method: 'POST', body }, signal), signal)
      const choice = Array.isArray(data?.choices) ? data.choices[0] : null
      const content = choice?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new RewriteError('改写 API 没有返回文字', { code: 'empty', retryable: true })
      }
      return {
        text: content,
        finishReason: choice?.finish_reason || '',
        truncated: data?.revnovel?.truncated === true,
        truncationReason: data?.revnovel?.reason || '',
        usage: data?.usage || null
      }
    },
    async listModels({ signal } = {}) {
      const data = await withRetry(() => request('models', { method: 'GET' }, signal), signal)
      const models = Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(value => typeof value === 'string') : []
      return models
    }
  }
}
