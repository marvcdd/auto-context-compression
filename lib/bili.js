/**
 * billion-context 账本读取器。
 * Reader for the billion-context ledger.
 *
 * bili 在当前 profile 里接管了线上压缩，所以面板的请求数、缓存、压缩收益
 * 与花费都来自它的每会话 detail。本模块只做三件事：固定 loopback origin、
 * 限制响应体大小、把字段裁剪成面板契约；它从不抛错，失败会降级成 `null`。
 * bili owns live compression in this profile, so the panel reads requests,
 * cache, savings and cost from its per-session detail. This module only pins a
 * loopback origin, bounds the response size, and trims fields to the panel
 * contract; it never throws and degrades failures to `null`.
 */

const CACHE_TTL_MS = 2000
const REQUEST_TIMEOUT_MS = 1200
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

function textValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function safeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 把 bili 的 session detail 裁剪成原生面板需要的字段。
 * Trim a bili session detail to the fields the native panel needs.
 * @param {unknown} detail
 * @returns {object | null}
 */
export function normalizeBiliDetail(detail) {
  if (detail === null || typeof detail !== 'object') return null
  const inputTokens = numberValue(detail.inputTokens)
  const cachedTokens = numberValue(detail.cachedTokens)
  const cost = detail.costUsd !== null && typeof detail.costUsd === 'object' ? detail.costUsd : null
  return {
    title: textValue(detail.title),
    protocol: textValue(detail.protocol),
    upstream: textValue(detail.upstreamOrigin)?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? null,
    client: textValue(detail.clientHint),
    engine: textValue(detail.engineLane),
    version: textValue(detail.biliVersion),
    storageMode: textValue(detail.storageMode),
    pack: textValue(detail.activePack),
    model: textValue(detail.model),
    requests: numberValue(detail.requests),
    inputTokens,
    cachedTokens,
    outputTokens: numberValue(detail.outputTokens),
    cacheHitRate: inputTokens !== null && inputTokens > 0 && cachedTokens !== null ? cachedTokens / inputTokens : null,
    cacheHitPct: numberValue(detail.cacheHitPct),
    contextTokens: numberValue(detail.contextTokens ?? detail.contextBest?.tokens),
    lastInputTokens: numberValue(detail.lastInputTokens ?? detail.contextTokens),
    contextWindow: numberValue(detail.contextWindow),
    tokensSaved: numberValue(detail.tokensSaved),
    netSaved: numberValue(detail.netSaved),
    savedUsd: numberValue(detail.savedUsd),
    grossSaved: numberValue(detail.grossSaved),
    foldCount: numberValue(detail.foldCount),
    blocks: numberValue(detail.blocks),
    payback: detail.payback !== null && typeof detail.payback === 'object' ? detail.payback : null,
    costUsd: cost === null ? null : {
      input: numberValue(cost.input),
      cacheRead: numberValue(cost.cacheRead),
      cacheWrite: numberValue(cost.cacheWrite),
      output: numberValue(cost.output),
      total: numberValue(cost.total),
      estimated: cost.estimated === true,
    },
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * 创建带短缓存和超时的 bili 读取器。
 * Create a bili reader with a short cache and a hard timeout.
 * @param {{ getOrigin: () => string, log?: (level: string, message: string) => void }} options
 */
export function createBiliClient({ getOrigin, log = () => {} }) {
  const cache = { sessionId: null, at: 0, value: null, error: null }

  /**
   * 读取一个会话的 bili 账本；缓存 2 秒，失败返回 `{value:null,error}`。
   * Read one session's bili ledger; cache for 2s and return `{value:null,error}` on failure.
   * @param {string} sessionId
   * @returns {Promise<{value: object | null, error: string | null}>}
   */
  async function fetchDetail(sessionId) {
    const origin = getOrigin()
    if (typeof origin !== 'string' || origin.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) {
      return { value: null, error: null }
    }
    const now = Date.now()
    if (cache.sessionId === sessionId && now - cache.at < CACHE_TTL_MS) {
      return { value: cache.value, error: cache.error }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetch(
        `${origin}/__bili/sessions/${encodeURIComponent(sessionId)}/detail`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      )
      if (!response.ok) throw new Error(`bili HTTP ${response.status}`)
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('bili detail response is too large')
      let detail
      try {
        detail = JSON.parse(body)
      } catch {
        throw new Error('bili detail is not valid JSON')
      }
      const value = normalizeBiliDetail(detail)
      if (value === null) throw new Error('bili detail is not an object')
      cache.sessionId = sessionId
      cache.at = Date.now()
      cache.value = value
      cache.error = null
      return { value, error: null }
    } catch (error) {
      const message = safeError(error)
      cache.sessionId = sessionId
      cache.at = Date.now()
      cache.value = null
      cache.error = message
      log('debug', `bili stats unavailable: ${message}`)
      return { value: null, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  return { fetchDetail }
}
