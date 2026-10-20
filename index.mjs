import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRewriteClient, isAbort, normalizeBaseURL, RewriteError } from './lib/api.mjs'
import { prepareRawText } from './lib/polish.mjs'
import { DEFAULT_SETTINGS, normalizeSettings, publicSettings } from './lib/settings.mjs'

export const name = 'dsh-tavern-rewrite'
export const inject = ['tavern', 'credentials']

const KEY_REF = 'DSH_TAVERN_REWRITE_API_KEY'
const STATUS_KIND = name + '/status'
const CONFIG_URL = new URL('./config.json', import.meta.url)
const FIELDS = ['baseURL', 'model', 'temperature', 'maxChars', 'minChars', 'concurrency', 'timeoutMs', 'retries']
const HANDLE = {
  state: name + '/state',
  save: name + '/save',
  key: name + '/key',
  test: name + '/test',
  polish: name + '/polish',
  recent: name + '/recent'
}

function pickSettings(value) {
  const result = {}
  if (!value || typeof value !== 'object') return result
  for (const field of FIELDS) if (value[field] !== undefined) result[field] = value[field]
  return result
}

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function turnKey(gameId, turn, textVersion) {
  return String(gameId) + '\u0000' + String(turn) + '\u0000' + String(textVersion)
}

function shortReason(reason) {
  const text = String(reason ?? '').trim()
  if (!text) return ''
  return text.length > 240 ? text.slice(0, 240) + '…' : text
}

function reasonText(reason) {
  const map = {
    'no-key': '还没有配置改写 API 密钥',
    'no-raw-text': '拿不到这一轮的原始正文',
    'too-short': '正文不足 400 字，改写台不接受',
    'input_too_short': '正文不足 400 字，改写台不接受',
    'no-change': '改写前后的文字没有变化',
    'structure': '改写结果会改坏 HTML 块，已放弃',
    'structure-mismatch': '改写结果的结构校验没通过，已放弃',
    'placeholder': '模型弄丢了正文里的标记，已跳过',
    'off-topic': '改写结果偏离原文太多，已跳过',
    'too-long': '改写结果比原文长太多，已跳过',
    'too-short-output': '改写结果比原文短太多，已跳过',
    'repetition': '改写结果出现复读，已跳过',
    'truncated': '改写结果被截断，已跳过',
    'disabled': '这一局关了自动润色',
    'cancelled': '润色已取消',
    'aborted': '润色已取消',
    'manual-edit': '这一轮被手动编辑过，不再自动润色',
    'no-key-source': '还没有配置改写 API 密钥',
    'auth': 'API 密钥无效或没有权限',
    'network': '连不上改写 API',
    'timeout': '改写 API 超时',
    'rate_limit': '改写 API 忙（429）',
    'upstream': '改写 API 暂时不可用',
    'endpoint': '接口地址不对（404）',
    'config': '服务地址或设置不对',
    'TAVERN_PLUGIN_STALE_VERSION': '正文版本已经变了',
    'TAVERN_PLUGIN_BUSY': '正在生成或结算，稍后再试'
  }
  return map[reason] || shortReason(reason)
}

export function createPlugin(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const readConfig = typeof options.readConfig === 'function' ? options.readConfig : async () => {
    try {
      const raw = await readFile(CONFIG_URL, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch

  async function apply(ctx) {
    const tavern = ctx?.tavern
    if (!tavern || typeof tavern.onTurnSettled !== 'function') return
    if (Number(tavern.apiVersion) < 3) {
      console.warn('[dsh-tavern-rewrite] 需要 Tavern 插件接口 3，当前为 ' + tavern.apiVersion)
      return
    }
    let credentials = null
    try { credentials = ctx.credentials || (typeof ctx.get === 'function' ? ctx.get('credentials') : null) } catch { credentials = null }

    let pluginData = {}
    let configFile = {}
    let settings = normalizeSettings({ ...DEFAULT_SETTINGS })
    let cachedClient = null
    let cachedIdentity = ''
    const recent = []
    const prepared = new Map()
    const inFlight = new Map()
    const selfEdits = new Map()
    const selfEditPending = new Map()
    const pendingHashes = new Map()
    const lastPolished = new Map()
    const manualEdits = new Map()
    const lifecycle = new AbortController()

    function record(entry) {
      recent.unshift({ at: now(), ...entry, reason: entry.reason ? reasonText(entry.reason) : '' })
      if (recent.length > 30) recent.length = 30
    }

    function log(message) {
      console.warn('[dsh-tavern-rewrite] ' + message)
    }

    async function refreshSettings() {
      try { pluginData = (await tavern.readPluginData?.()) || {} } catch { pluginData = {} }
      configFile = await readConfig()
      settings = normalizeSettings({ ...pickSettings(configFile), ...pickSettings(pluginData) })
      cachedClient = null
      cachedIdentity = ''
    }

    await refreshSettings()

    async function resolveKey() {
      if (credentials?.resolve) {
        try {
          const hit = await credentials.resolve(KEY_REF)
          if (hit?.value) return { value: String(hit.value).trim(), source: 'credentials' }
        } catch { /* 没有凭据服务时继续看环境变量和 config.json */ }
      }
      const env = process.env.DSH_TAVERN_REWRITE_API_KEY || process.env.REWRITE_API_KEY
      if (env && env.trim()) return { value: env.trim(), source: 'env' }
      if (typeof configFile.apiKey === 'string' && configFile.apiKey.trim()) return { value: configFile.apiKey.trim(), source: 'config' }
      return { value: '', source: '' }
    }

    async function getClient() {
      const resolved = await resolveKey()
      if (!resolved.value) throw new RewriteError('还没有配置改写 API 密钥；在「润色」面板里填一个，或写进插件目录的 config.json', { code: 'no-key' })
      const identity = [resolved.value, settings.baseURL, settings.model, settings.timeoutMs, settings.retries].join('\u0000')
      if (cachedClient && cachedIdentity === identity) return cachedClient
      cachedClient = createRewriteClient({
        baseURL: settings.baseURL,
        apiKey: resolved.value,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        retries: settings.retries,
        fetchImpl
      })
      cachedIdentity = identity
      return cachedClient
    }

    function withLifecycle(signal) {
      if (lifecycle.signal.aborted) return lifecycle.signal
      return signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal
    }

    function selfSet(gameId) {
      if (!selfEdits.has(gameId)) selfEdits.set(gameId, new Set())
      return selfEdits.get(gameId)
    }
    function markSelfEdit(gameId, textVersion) {
      if (!textVersion) return
      const set = selfSet(gameId)
      set.add(textVersion)
      if (set.size > 30) set.delete(set.values().next().value)
    }
    function isSelfVersion(gameId, textVersion) {
      return Boolean(textVersion && selfEdits.get(gameId)?.has(textVersion))
    }
    function pendingSet(gameId) {
      if (!pendingHashes.has(gameId)) pendingHashes.set(gameId, new Set())
      return pendingHashes.get(gameId)
    }
    function lastMap(gameId) {
      if (!lastPolished.has(gameId)) lastPolished.set(gameId, new Map())
      return lastPolished.get(gameId)
    }
    function manualMap(gameId) {
      if (!manualEdits.has(gameId)) manualEdits.set(gameId, new Map())
      return manualEdits.get(gameId)
    }
    function isManualEdit(gameId, turn, textVersion) {
      return Boolean(textVersion && manualEdits.get(gameId)?.get(turn) === textVersion)
    }

    function preparedKey(gameId, turn, textVersion) { return turnKey(gameId, turn, textVersion) }
    function storePrepared(key, entry) {
      prepared.set(key, entry)
      while (prepared.size > 80) prepared.delete(prepared.keys().next().value)
    }
    function dropPreparedForGame(gameId) {
      const prefix = String(gameId) + '\u0000'
      for (const key of prepared.keys()) if (key.startsWith(prefix)) prepared.delete(key)
    }

    async function autoEnabled(gameId) {
      try {
        const values = await tavern.getGameSettings({ gameId })
        return values?.auto !== false
      } catch { return true }
    }

    async function attachIndicator(turn, mode) {
      if (typeof tavern.attach !== 'function') return null
      try {
        const { id } = await tavern.attach({
          gameId: turn.gameId,
          turn: turn.turn,
          textVersion: turn.textVersion,
          item: { kind: STATUS_KIND, status: 'pending', caption: '润色中…', data: { mode } }
        })
        return id
      } catch { return null }
    }

    async function finishIndicator(id, error) {
      if (!id) return
      try {
        if (error) await tavern.update(id, { status: 'failed', caption: '润色失败', error: shortReason(error) })
        else await tavern.remove(id)
      } catch { /* 指示器只是锦上添花 */ }
    }

    async function prepare({ gameId, turn, textVersion, rawText, mode, signal }) {
      const resolved = await resolveKey()
      if (!resolved.value) return { status: 'skipped', reason: 'no-key', stats: null }
      if (!rawText || typeof rawText !== 'string') return { status: 'skipped', reason: 'no-raw-text', stats: null }
      const started = now()
      try {
        const client = await getClient()
        const result = await prepareRawText(rawText, { client, settings, signal: withLifecycle(signal) })
        return { ...result, ms: now() - started, mode }
      } catch (error) {
        if (isAbort(error)) return { status: 'cancelled', reason: 'cancelled', stats: null, ms: now() - started, mode }
        return { status: 'failed', reason: shortReason(error?.message || error), stats: null, ms: now() - started, mode }
      }
    }

    async function applyEdit(turn, entry, indicator, mode) {
      if (!entry?.text || entry.text === turn.rawText) {
        record({ gameId: turn.gameId, turn: turn.turn, mode, status: 'skipped', reason: 'no-change', stats: entry?.stats || null })
        await finishIndicator(indicator)
        return { ok: false, reason: 'no-change' }
      }
      const digest = hash(entry.text)
      pendingSet(turn.gameId).add(digest)
      selfEditPending.set(turn.gameId, (selfEditPending.get(turn.gameId) || 0) + 1)
      try {
        const updated = await tavern.editTurn({
          gameId: turn.gameId,
          turn: turn.turn,
          textVersion: turn.textVersion,
          text: entry.text
        })
        if (updated?.textVersion) {
          markSelfEdit(turn.gameId, updated.textVersion)
          lastMap(turn.gameId).set(turn.turn, { hash: digest, resultVersion: updated.textVersion })
        }
        record({ gameId: turn.gameId, turn: turn.turn, mode, status: 'ready', stats: entry.stats || null, ms: entry.ms || 0 })
        await finishIndicator(indicator)
        return { ok: true, changed: true, stats: entry.stats || null }
      } catch (error) {
        const code = error?.code || ''
        if (isAbort(error) || code === 'TAVERN_PLUGIN_STALE_VERSION' || code === 'TAVERN_PLUGIN_BUSY') {
          record({ gameId: turn.gameId, turn: turn.turn, mode, status: 'skipped', reason: code || 'cancelled', stats: entry.stats || null })
          await finishIndicator(indicator, error)
          return { ok: false, reason: code || 'cancelled' }
        }
        record({ gameId: turn.gameId, turn: turn.turn, mode, status: 'failed', reason: shortReason(error?.message || error), stats: entry.stats || null })
        await finishIndicator(indicator, error)
        log('替换正文失败：' + shortReason(error?.message || error))
        return { ok: false, reason: shortReason(error?.message || error) }
      } finally {
        pendingSet(turn.gameId).delete(digest)
        const pending = (selfEditPending.get(turn.gameId) || 0) - 1
        if (pending > 0) selfEditPending.set(turn.gameId, pending)
        else selfEditPending.delete(turn.gameId)
      }
    }

    function runExclusive(key, operation) {
      if (inFlight.has(key)) return inFlight.get(key)
      const promise = Promise.resolve().then(operation).finally(() => inFlight.delete(key))
      inFlight.set(key, promise)
      return promise
    }

    async function fallbackPolish(turn) {
      const key = 'apply:' + preparedKey(turn.gameId, turn.turn, turn.textVersion)
      return await runExclusive(key, async () => {
        const signal = await tavern.versionSignal({ gameId: turn.gameId, turn: turn.turn, textVersion: turn.textVersion })
        const indicator = await attachIndicator(turn, 'auto')
        let entry
        try {
          entry = await prepare({ gameId: turn.gameId, turn: turn.turn, textVersion: turn.textVersion, rawText: turn.rawText, mode: 'auto', signal })
        } catch (error) {
          entry = { status: 'failed', reason: shortReason(error?.message || error), stats: null }
        }
        storePrepared(key, entry)
        if (entry.status === 'ready') {
          const applied = await applyEdit(turn, entry, indicator, 'auto')
          prepared.delete(key)
          return { entry, applied }
        }
        record({ gameId: turn.gameId, turn: turn.turn, mode: 'auto', status: entry.status, reason: entry.reason || '', stats: entry.stats || null })
        await finishIndicator(indicator, entry.status === 'failed' ? entry.reason : null)
        return { entry, applied: { ok: false, reason: entry.reason || entry.status } }
      })
    }

    tavern.onTurnSettled(async turn => {
      try {
        if (!turn?.gameId || !Number.isInteger(turn.turn) || !turn.textVersion) return
        if (typeof turn.rawText !== 'string') return
        if (!(await autoEnabled(turn.gameId))) return
        if (isSelfVersion(turn.gameId, turn.textVersion)) return
        if (isManualEdit(turn.gameId, turn.turn, turn.textVersion)) {
          record({ gameId: turn.gameId, turn: turn.turn, mode: 'auto', status: 'skipped', reason: 'manual-edit' })
          return
        }
        const digest = hash(turn.rawText)
        const last = lastMap(turn.gameId).get(turn.turn)
        if (last && (last.hash === digest || last.resultVersion === turn.textVersion)) {
          markSelfEdit(turn.gameId, turn.textVersion)
          return
        }
        if (pendingHashes.get(turn.gameId)?.has(digest)) {
          markSelfEdit(turn.gameId, turn.textVersion)
          pendingHashes.get(turn.gameId).delete(digest)
          return
        }
        const key = preparedKey(turn.gameId, turn.turn, turn.textVersion)
        const entry = prepared.get(key)
        if (entry) {
          prepared.delete(key)
          if (entry.status === 'ready') {
            await applyEdit(turn, entry, null, 'auto')
            return
          }
          return
        }
        await fallbackPolish(turn)
      } catch (error) {
        if (!isAbort(error)) {
          log('自动润色出错：' + shortReason(error?.message || error))
          record({ gameId: turn?.gameId || '', turn: turn?.turn || 0, mode: 'auto', status: 'failed', reason: shortReason(error?.message || error) })
        }
      }
    })

    if (typeof tavern.onTimelineChanged === 'function') {
      tavern.onTimelineChanged(({ gameId, kind, turn, textVersion }) => {
        try {
          if (!gameId) return
          if (kind === 'edit') {
            const pending = (selfEditPending.get(gameId) || 0) > 0
            if (pending) {
              const next = (selfEditPending.get(gameId) || 0) - 1
              if (next > 0) selfEditPending.set(gameId, next)
              else selfEditPending.delete(gameId)
              if (textVersion) markSelfEdit(gameId, textVersion)
            } else if (textVersion) {
              manualMap(gameId).set(turn, textVersion)
            }
            dropPreparedForGame(gameId)
            return
          }
          if (kind === 'regenerate') {
            manualMap(gameId).delete(turn)
            lastMap(gameId).delete(turn)
            dropPreparedForGame(gameId)
            return
          }
          if (kind === 'rollback' || kind === 'undo-rollback' || kind === 'fork') dropPreparedForGame(gameId)
        } catch { /* 通知只是告知 */ }
      })
    }

    if (typeof tavern.onGameRemoved === 'function') {
      tavern.onGameRemoved(({ gameId }) => {
        for (const map of [selfEdits, selfEditPending, pendingHashes, lastPolished, manualEdits]) map.delete(gameId)
        dropPreparedForGame(gameId)
      })
    }

    if (typeof tavern.gameSettings === 'function') {
      tavern.gameSettings({
        title: '正文润色',
        fields: [{
          key: 'auto',
          type: 'boolean',
          label: '每轮自动润色',
          description: '正文写完后调用改写台润色一次，再替换成润色后的正文；正文不足 400 字时跳过。',
          default: true
        }]
      })
    }

    if (typeof tavern.settlementTask === 'function') {
      tavern.settlementTask({
        name: 'rewrite',
        title: '正文润色',
        phase: 'parallel',
        async run({ gameId, turn, textVersion, rawText, text, signal }) {
          try {
            const key = preparedKey(gameId, turn, textVersion)
            if (prepared.has(key) || inFlight.has('apply:' + key)) return
            if (!(await autoEnabled(gameId))) {
              const skipped = { status: 'skipped', reason: 'disabled' }
              storePrepared(key, skipped)
              record({ gameId, turn, mode: 'auto', status: 'skipped', reason: 'disabled' })
              return
            }
            if (isSelfVersion(gameId, textVersion) || isManualEdit(gameId, turn, textVersion)) return
            const source = rawText || text || ''
            if (!source || !rawText) {
              storePrepared(key, { status: 'skipped', reason: 'no-raw-text' })
              record({ gameId, turn, mode: 'auto', status: 'skipped', reason: 'no-raw-text' })
              return
            }
            if (lastMap(gameId).get(turn)?.hash === hash(source)) { markSelfEdit(gameId, textVersion); return }
            const entry = await prepare({ gameId, turn, textVersion, rawText: source, mode: 'auto', signal })
            storePrepared(key, entry)
            record({ gameId, turn, mode: 'auto', status: entry.status === 'ready' ? 'prepared' : entry.status, reason: entry.reason || '', stats: entry.stats || null, ms: entry.ms || 0 })
          } catch (error) {
            if (isAbort(error)) return
            log('预润色出错：' + shortReason(error?.message || error))
          }
        }
      })
    }

    if (typeof tavern.handle === 'function') {
      tavern.handle(HANDLE.state, async () => {
        await refreshSettings()
        const resolved = await resolveKey()
        return {
          settings: publicSettings(settings),
          key: { configured: Boolean(resolved.value), source: resolved.source },
          recent: recent.slice(0, 12),
          apiVersion: tavern.apiVersion
        }
      })

      tavern.handle(HANDLE.save, async ({ settings: patch } = {}) => {
        if (!patch || typeof patch !== 'object') throw new Error('设置格式不对')
        const merged = { ...settings, ...pickSettings(patch) }
        let baseURL
        try { baseURL = normalizeBaseURL(merged.baseURL) } catch (error) { throw new Error(error?.message || '服务地址格式不对') }
        const next = normalizeSettings({ ...merged, baseURL })
        await tavern.savePluginData({ data: publicSettings(next) })
        settings = next
        cachedClient = null
        cachedIdentity = ''
        const resolved = await resolveKey()
        return {
          settings: publicSettings(settings),
          key: { configured: Boolean(resolved.value), source: resolved.source },
          recent: recent.slice(0, 12)
        }
      })

      tavern.handle(HANDLE.key, async ({ apiKey } = {}) => {
        if (!credentials || typeof credentials.set !== 'function') {
          throw new Error('当前环境没有凭据服务；请把 apiKey 写进插件目录的 config.json')
        }
        if (apiKey === null || apiKey === undefined || apiKey === '') {
          if (typeof credentials.unset === 'function') await credentials.unset(KEY_REF)
        } else {
          if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey) || apiKey.length > 4096) throw new Error('API 密钥格式不对')
          const trimmed = apiKey.trim()
          if (!trimmed) throw new Error('API 密钥不能为空')
          await credentials.set(KEY_REF, trimmed)
        }
        cachedClient = null
        cachedIdentity = ''
        const resolved = await resolveKey()
        return { key: { configured: Boolean(resolved.value), source: resolved.source } }
      })

      tavern.handle(HANDLE.test, async () => {
        const client = await getClient()
        const models = await client.listModels()
        return { models, model: settings.model, baseURL: settings.baseURL }
      })

      tavern.handle(HANDLE.recent, async () => ({ recent: recent.slice(0, 20) }))

      tavern.handle(HANDLE.polish, async ({ gameId, turn } = {}) => {
        if (typeof gameId !== 'string' || !gameId) throw new Error('缺少游戏 ID')
        if (!Number.isInteger(turn) || turn < 1) throw new Error('轮次不对')
        const state = await tavern.getTurnState({ gameId })
        if (!state || state.turn !== turn) throw new Error('只能润色最新一轮')
        if (!state.settled || state.busy) throw new Error('这一轮还在生成或结算，请稍后再试')
        const current = await tavern.getTurn({ gameId, turn })
        if (!current) throw new Error('这一轮还没写完')
        if (current.textVersion !== state.textVersion) throw new Error('正文已经变了，请重试')
        const key = preparedKey(gameId, turn, current.textVersion)
        prepared.delete(key)
        const signal = await tavern.versionSignal({ gameId, turn, textVersion: current.textVersion })
        const indicator = await attachIndicator(current, 'manual')
        try {
          const outcome = await runExclusive('apply:' + key, async () => {
            const entry = await prepare({ gameId, turn, textVersion: current.textVersion, rawText: current.rawText, mode: 'manual', signal })
            if (entry?.status !== 'ready') return { entry }
            const applied = await applyEdit(current, entry, indicator, 'manual')
            return { entry, applied }
          })
          const entry = outcome?.entry
          if (!entry || entry.status !== 'ready') {
            const reason = entry?.reason || entry?.status || 'failed'
            record({ gameId, turn, mode: 'manual', status: entry?.status || 'failed', reason, stats: entry?.stats || null })
            await finishIndicator(indicator, entry?.status === 'failed' ? reason : null)
            throw new Error(reasonText(reason))
          }
          if (!outcome.applied?.ok) throw new Error(reasonText(outcome.applied?.reason))
          await finishIndicator(indicator)
          return { ok: true, changed: true, stats: entry.stats || null }
        } catch (error) {
          await finishIndicator(indicator, error)
          throw error
        } finally {
          prepared.delete(key)
        }
      })
    }

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        lifecycle.abort()
        prepared.clear()
        inFlight.clear()
      })
    }
  }

  return { apply }
}

export function apply(ctx) {
  return createPlugin({}).apply(ctx)
}
