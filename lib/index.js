/**
 * Auto context compression (Host plugin).
 *
 * A proactive compaction policy layered on top of the durable `ctx.compaction`
 * engine already mounted by an agent preset. For every agent we observe
 * `agent/pre-step`, measure the latest request pressure with `ctx.tokenMeter`,
 * and once the configured trigger ratio is crossed:
 *
 *   1. deterministic oversized-tool-result pruning (`toolResultPruner`), then
 *   2. summarization of the oldest contiguous, tool-pair-balanced span
 *      (`compaction.compactRegion`), retaining a verbatim recent tail.
 *
 * The built-in `compaction-basic` policy still runs as the final safety net at
 * its own (higher) pressure threshold. This plugin never appends new event
 * types, never changes the model-visible request outside the supported
 * compaction transaction, and never fails a turn: every failure is logged and
 * the step proceeds.
 */
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatRatio, formatTokens, planCompaction, resolveConfig, summarizeCacheUsage, summarizeCompactionUsage } from './policy.js'
import { WS_PATH, WS_PROTOCOL, createWebSocketHub } from './ws.js'

export const name = 'auto-context-compression'
export const inject = ['commands', 'agents', 'agentPresets']

const STATUS_INTERVAL_MS = 2000
const CONFIG_POLL_MS = 500
const LOG_LEVEL = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }
const USAGE = [
  'Usage: /autocompact [status | cache | on | off | threshold <ratio> | target <ratio> | config]',
  '  status             show context pressure and compression totals',
  '  cache              show prompt-cache hit/miss rates for this session',
  '  on | off           toggle automatic compression for this session',
  '  threshold <ratio>  set this session trigger (0-1 or 0-100), e.g. 0.45 or 45',
  '  target <ratio>     set this session compression target, below the trigger',
  '  config             show the effective plugin configuration',
].join('\n')

/** Short, safe error text for logs and command output. */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Host plugin entry. `ctx` is the plugin context; `rawConfig` is the Loader
 * config from the bundle patch or the profile patch.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  let config = resolveConfig(rawConfig)
  const logger = ctx.logger
  const sessions = new Map()
  const disposers = new Map()
  const totals = { attempts: 0, compactions: 0, tokensSaved: 0, prunedChars: 0 }
  let disposed = false
  let writingStatus = false
  let statusQueued = false
  let lastStatusWriteAt = 0
  let lastConfigCheckAt = 0
  let configFileMtimeMs = 0
  let configFileSize = -1
  let configFileError = null
  let configFileReloadedAt = 0

  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const statusDir = path.join(home, 'auto-context-compression')
  const statusPath = path.join(statusDir, 'status.json')
  const configPath = path.join(statusDir, 'config.json')
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const clientBundlePath = path.join(packageRoot, 'client.js')
  const clientBundleBase = pathToFileURL(`${packageRoot}${path.sep}`).href
  const biliCache = { sessionId: null, at: 0, value: null, error: null }
  let wsHub = null

  /**
   * Log through the Host logger at the configured verbosity.
   * @param {'error'|'warn'|'info'|'debug'} level
   * @param {string} message
   */
  function log(level, message) {
    if ((LOG_LEVEL[level] ?? 0) > (LOG_LEVEL[config.logLevel] ?? 0)) return
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'debug' ? 'debug' : 'info'
    const sink = logger?.[method]
    if (typeof sink === 'function') sink.call(logger, `auto-context-compression: ${message}`)
  }

  /**
   * Apply a new effective configuration. Explicit `/autocompact` session
   * overrides win over file changes; otherwise trigger, target, and the default
   * enabled flag follow the file. Exclusion is always recomputed.
   * @param {Readonly<typeof CONFIG_DEFAULTS>} next
   */
  function applyConfig(next) {
    const previous = config
    config = next
    for (const state of sessions.values()) {
      if (state.triggerCustom !== true) state.triggerRatio = next.triggerRatio
      if (state.targetCustom !== true) state.targetRatio = next.targetRatio
      if (state.enabledCustom !== true) state.enabled = next.enabled
      state.excluded = next.excludeSessionIds.includes(state.id)
    }
    configFileError = null
    configFileReloadedAt = Date.now()
    if (previous.triggerRatio !== next.triggerRatio || previous.targetRatio !== next.targetRatio) {
      log('info', `config reloaded: trigger ${formatRatio(next.triggerRatio)}, target ${formatRatio(next.targetRatio)}`)
    }
  }

  /** Create the user config file from the effective Loader config when absent. */
  function ensureDefaultConfigFile() {
    if (!config.configFile) return
    try {
      if (existsSync(configPath)) return
      mkdirSync(statusDir, { recursive: true })
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
      const stat = statSync(configPath)
      configFileMtimeMs = stat.mtimeMs
      configFileSize = stat.size
      log('info', `created config file at ${configPath}`)
    } catch (error) {
      configFileError = errorText(error)
      log('warn', `could not create config file: ${configFileError}`)
    }
  }

  /**
   * Re-read the user config file at most once per poll interval. A malformed
   * file is ignored (the previous effective config stays active) and reported
   * in the status file.
   * @param {boolean} force - bypass the poll interval
   */
  function reloadConfigFromFile(force = false) {
    if (!config.configFile) return
    const now = Date.now()
    if (!force && now - lastConfigCheckAt < CONFIG_POLL_MS) return
    lastConfigCheckAt = now

    let raw
    try {
      raw = readFileSync(configPath, 'utf8')
    } catch {
      return
    }

    try {
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('config.json must contain a JSON object')
      }
      const next = resolveConfig({ ...config, ...parsed })
      if (JSON.stringify(next) === JSON.stringify(config)) {
        configFileError = null
        configFileReloadedAt = Date.now()
      } else {
        applyConfig(next)
      }
    } catch (error) {
      configFileError = errorText(error)
      log('warn', `config file ignored: ${configFileError}`)
    }
  }

  /**
   * Resolve a service from the agent's isolated preset group first. `agent.ctx`
   * is the outer agent context and cannot see child-group services, so the
   * preset registry's `serviceFor` is the authoritative lookup for `compaction`
   * and `toolResultPruner`. Host-plane services remain reachable through the
   * normal context chain.
   */
  function serviceFor(agent, serviceName) {
    try {
      const preset = ctx.agentPresets?.serviceFor?.(agent, serviceName)
      if (preset !== undefined) return preset
    } catch {
      /* an unbound agent or a missing preset service is not an error */
    }
    try {
      const local = agent?.ctx?.get?.(serviceName)
      if (local !== undefined) return local
    } catch {
      /* a missing optional service is not an error */
    }
    try {
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  /** Get or create the in-memory per-session view. */
  function ensureState(agent) {
    const id = String(agent?.id ?? 'unknown')
    let state = sessions.get(id)
    if (state === undefined) {
      state = {
        id,
        enabled: config.enabled,
        enabledCustom: false,
        excluded: config.excludeSessionIds.includes(id),
        triggerRatio: config.triggerRatio,
        triggerCustom: false,
        targetRatio: config.targetRatio,
        targetCustom: false,
        available: false,
        compacting: false,
        lastSeenAt: 0,
        tokens: 0,
        window: 0,
        ratio: 0,
        lastAttemptAt: 0,
        lastCompactionAt: 0,
        tokensAfterLastCompaction: 0,
        compactions: 0,
        tokensSaved: 0,
        prunedChars: 0,
        cache: null,
        cacheAt: 0,
        title: null,
        model: null,
        provider: null,
        compactionUsage: null,
        lastSkipReason: 'never',
        lastError: null,
      }
      sessions.set(id, state)
    }
    return state
  }

  /** Latest routed context window, falling back only when explicitly set. */
  function contextWindowFor(agent) {
    const requestContext = agent?.session?.requestContext?.()
    const window = requestContext?.contextWindow
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) return window
    return config.fallbackContextWindow > 0 ? config.fallbackContextWindow : 0
  }

  /** Snapshot the durable log prefix needed for turn/step segmentation. */
  function eventsOf(session) {
    const events = []
    const end = session.seq
    for (let seq = 0; seq < end; seq += 1) {
      const event = session.eventAt(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /** Build one session entry shared by the status file and the HTTP API. */
  function sessionView(state) {
    return {
      sessionId: state.id,
      enabled: state.enabled,
      excluded: state.excluded,
      available: state.available,
      triggerRatio: state.triggerRatio,
      targetRatio: state.targetRatio,
      tokens: state.tokens,
      window: state.window,
      ratio: Math.round(state.ratio * 10000) / 10000,
      compactions: state.compactions,
      tokensSaved: state.tokensSaved,
      prunedChars: state.prunedChars,
      cache: state.cache,
      title: state.title,
      model: state.model,
      provider: state.provider,
      compactionUsage: state.compactionUsage,
      lastSeenAt: state.lastSeenAt > 0 ? new Date(state.lastSeenAt).toISOString() : null,
      lastCompactionAt: state.lastCompactionAt > 0 ? new Date(state.lastCompactionAt).toISOString() : null,
      lastSkipReason: state.lastSkipReason,
      lastError: state.lastError,
    }
  }

  /** Copy the payload of a status file for the current process. */
  function statusSnapshot() {
    const now = Date.now()
    const views = [...sessions.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .slice(0, 30)
      .map(sessionView)
    return {
      version: 1,
      plugin: name,
      updatedAt: new Date(now).toISOString(),
      config: { ...config },
      statusFile: statusPath,
      configFile: {
        path: configPath,
        enabled: config.configFile,
        lastError: configFileError,
        reloadedAt: configFileReloadedAt > 0 ? new Date(configFileReloadedAt).toISOString() : null,
      },
      totals: { ...totals },
      sessions: views,
    }
  }

  /**
   * Derive cheap display metadata from the durable log: the latest session
   * title, the routed provider/model, and cumulative compaction-summary usage.
   * Missing events simply leave the previous value in place.
   * @param {readonly {type:string, data?:any}[]} events
   */
  function sessionExtras(events) {
    let title = null
    let model = null
    let provider = null
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'session/title') {
        const value = event.data?.title
        if (typeof value === 'string' && value.length > 0) title = value
      } else if (event.type === 'request/context') {
        if (typeof event.data?.provider === 'string' && event.data.provider.length > 0) provider = event.data.provider
        if (typeof event.data?.model === 'string' && event.data.model.length > 0) model = event.data.model
      }
    }
    return { title, model, provider, compactionUsage: summarizeCompactionUsage(events) }
  }

  /**
   * Refresh a session view without triggering compression. Used by the read-only
   * status API; a GET must never mutate the model-visible surface.
   * @param {any} agent
   */
  function refreshState(agent) {
    const state = ensureState(agent)
    state.lastSeenAt = Date.now()
    if (agent?.session === undefined || agent.session === null) {
      state.lastSkipReason = 'no-session'
      return state
    }

    try {
      const events = eventsOf(agent.session)
      state.cache = summarizeCacheUsage(events)
      state.cacheAt = Date.now()
      const extras = sessionExtras(events)
      if (extras.title !== null) state.title = extras.title
      if (extras.model !== null) state.model = extras.model
      if (extras.provider !== null) state.provider = extras.provider
      state.compactionUsage = extras.compactionUsage
    } catch (error) {
      log('debug', `status scan failed: ${errorText(error)}`)
    }

    state.window = contextWindowFor(agent)
    state.available = serviceFor(agent, 'compaction') !== undefined
    const meter = serviceFor(agent, 'tokenMeter')
    if (meter !== undefined && typeof meter.measure === 'function') {
      try {
        const measurement = meter.measure(agent.session)
        state.tokens = measurement.totalTokens
        state.ratio = state.window > 0 ? measurement.totalTokens / state.window : 0
      } catch (error) {
        log('debug', `status measurement failed: ${errorText(error)}`)
      }
    }
    return state
  }

  /** Resolve the agent for a client-supplied session id, newest as fallback. */
  function findAgent(sessionId) {
    const agents = ctx.agents?.list?.() ?? []
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const exact = agents.find((agent) => String(agent.id) === sessionId || String(agent.session?.id) === sessionId)
      if (exact !== undefined) return exact
    }
    return agents.length > 0 ? agents[agents.length - 1] : undefined
  }

  /** Send one JSON response, swallowing the disconnect that a refresh causes. */
  function sendJson(response, statusCode, payload) {
    try {
      response.statusCode = statusCode
      response.setHeader('content-type', 'application/json; charset=utf-8')
      response.setHeader('cache-control', 'no-store')
      response.setHeader('x-content-type-options', 'nosniff')
      response.setHeader('referrer-policy', 'no-referrer')
      response.setHeader('cross-origin-resource-policy', 'same-origin')
      response.end(JSON.stringify(payload))
    } catch {
      /* the browser may have closed the tab while a poll was in flight */
    }
  }

  function textValue(value) {
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  function numberValue(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  /**
   * Trim a billion-context session detail to the fields the panel needs.
   * billion-context owns the live compression transport in this profile, so its
   * ledger (not our dormant compactRegion policy) is the truthful UI source.
   */
  function normalizeBiliDetail(detail) {
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

  /** Read billion-context's per-session ledger; cache briefly and never throw. */
  async function fetchBiliDetail(sessionId) {
    if (config.biliOrigin.length === 0 || sessionId.length === 0) return { value: null, error: null }
    const now = Date.now()
    if (biliCache.sessionId === sessionId && now - biliCache.at < 2000) {
      return { value: biliCache.value, error: biliCache.error }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const response = await fetch(
        `${config.biliOrigin}/__bili/sessions/${encodeURIComponent(sessionId)}/detail`,
        { headers: { accept: 'application/json' }, signal: controller.signal },
      )
      if (!response.ok) throw new Error(`bili HTTP ${response.status}`)
      const body = await response.text()
      if (Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) throw new Error('bili detail response is too large')
      let detail
      try {
        detail = JSON.parse(body)
      } catch {
        throw new Error('bili detail is not valid JSON')
      }
      const value = normalizeBiliDetail(detail)
      if (value === null) throw new Error('bili detail is not an object')
      biliCache.sessionId = sessionId
      biliCache.at = Date.now()
      biliCache.value = value
      biliCache.error = null
      return { value, error: null }
    } catch (error) {
      const message = errorText(error)
      biliCache.sessionId = sessionId
      biliCache.at = Date.now()
      biliCache.value = null
      biliCache.error = message
      log('debug', `bili stats unavailable: ${message}`)
      return { value: null, error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Build the exact payload consumed by the HTTP route and the WebSocket. */
  async function buildLiveValue(agent, refresh = false) {
    const state = agent === undefined || agent === null
      ? null
      : refresh === true
        ? refreshState(agent)
        : ensureState(agent)
    const value = {
      ...statusSnapshot(),
      session: state === null ? null : sessionView(state),
      websocket: {
        path: WS_PATH,
        protocol: WS_PROTOCOL,
        clients: wsHub?.clientCount ?? 0,
      },
    }
    const bili = state === null ? { value: null, error: null } : await fetchBiliDetail(state.id)
    value.bili = bili.value
    value.biliError = bili.error
    value.biliOrigin = config.biliOrigin || null
    value.engine = bili.value !== null
      ? 'billion-context'
      : state?.available === true
        ? 'compaction-basic'
        : 'unavailable'
    return value
  }

  wsHub = createWebSocketHub({
    getOrigin: () => {
      const server = ctx.get('webServer')
      return server.getOrigin()
    },
    getSnapshot: (sessionId, refresh) => buildLiveValue(findAgent(sessionId), refresh === true),
    log: (level, message) => log(level, message),
  })

  /** Read-only boot graph/factory diagnostics for the Web client bundle. */
  function clientDiagnostics(forceScan = false) {
    let modules
    try {
      modules = ctx.get('clientModules')
    } catch {
      return { available: false }
    }
    if (modules === undefined || modules === null) return { available: false }
    const result = { available: true }
    let raw
    try {
      raw = ctx.reflect?.get?.('clientModules')
      result.reflect = raw !== undefined
      if (raw !== undefined) {
        result.rawDirty = raw.dirty instanceof Set
        result.rawFlush = typeof raw.flush === 'function'
        result.loaderNames = (raw.ctx?.loader?.entries?.() ?? [])
          .map((entry) => entry.options.name)
          .filter((name) => typeof name === 'string' && name.includes('auto-context'))
        result.loaderCount = raw.ctx?.loader?.entries?.().length ?? 0
        result.loaderSample = (raw.ctx?.loader?.entries?.() ?? [])
          .map((entry) => entry.options.name)
          .slice(0, 12)
      }
    } catch (error) {
      result.reflectError = errorText(error)
    }
    if (forceScan) {
      const errors = []
      const target = raw ?? modules
      const packageName = 'dsh-auto-context-compression'
      const already = (modules.graph?.()?.entries ?? []).some((entry) => entry.id === packageName)
      if (already && raw !== undefined && typeof raw.rebuilt === 'function') {
        try {
          const rev = raw.rebuilt(packageName)
          result.rebuilt = rev ?? null
        } catch (error) {
          result.rebuiltError = errorText(error)
        }
      } else if (!already && raw !== undefined && raw.sources instanceof Map) {
        try {
          const sourceKey = `manual\0${packageName}`
          raw.sources.set(sourceKey, {
            packageName,
            loaderName: packageName,
            baseUrl: clientBundleBase,
            sourceKey,
            meta: {
              clientPath: clientBundlePath.replace(/\\/g, '/'),
              inject: ['@deepseek-ai/dsh-client-ui-conversation'],
              external: [],
              immediately: true,
            },
          })
          raw.reconcilePackage(packageName)
          raw.composed = raw.compose()
          raw.notifyGraphChanged()
          result.injected = true
        } catch (error) {
          result.injectError = errorText(error)
        }
      } else {
        try {
          target.dirty?.add(packageName)
          target.flush?.((error) => errors.push(errorText(error)))
          result.rescan = packageName
        } catch (error) {
          result.rescanError = errorText(error)
        }
      }
      if (errors.length > 0) result.rescanErrors = errors
    }
    try {
      result.loaderEntries = (ctx.loader?.entries?.() ?? [])
        .map((entry) => ({
          id: entry.options.id ?? null,
          name: entry.options.name ?? null,
          disabled: entry.disabled === true,
          hasFiber: entry.fiber !== undefined,
        }))
        .filter((entry) => typeof entry.name === 'string' && entry.name.includes('auto-context'))
    } catch (error) {
      result.loaderError = errorText(error)
    }
    try {
      const graph = modules.graph()
      result.rev = graph?.rev ?? null
      result.entries = (graph?.entries ?? []).map((entry) => ({
        id: entry.id,
        url: entry.url,
        immediately: entry.immediately === true,
        external: entry.external === true,
      }))
      result.batches = (graph?.batches ?? []).map((batch) => ({
        phase: batch.phase,
        url: batch.url,
        entries: (batch.entries ?? []).map((entry) => entry.id),
      }))
    } catch (error) {
      result.graphError = errorText(error)
    }
    try {
      result.clientPath = modules.clientPath('dsh-auto-context-compression') ?? null
    } catch (error) {
      result.pathError = errorText(error)
    }
    return result
  }

  /** Register the client half when the host missed the startup scan. */
  function ensureClientRegistration() {
    try {
      const after = clientDiagnostics(true)
      if (after.injected === true) log('info', 'client bundle registered at runtime')
      if (after.rebuilt !== undefined && after.rebuilt !== null) {
        log('debug', `client bundle revision refreshed: ${after.rebuilt}`)
      }
    } catch (error) {
      log('debug', `client registration skipped: ${errorText(error)}`)
    }
  }

  /** Read-only preset/service diagnostics for the active session agent. */
  function agentDiagnostics(agent) {
    let preset = null
    try {
      preset = ctx.agentPresets?.composedPreset?.(agent?.ctx)
    } catch {
      /* a preset may not be composed for this agent kind */
    }
    let presetId = null
    if (typeof preset === 'string') {
      presetId = preset
    } else if (preset !== null && preset !== undefined) {
      presetId = preset.id ?? preset.name ?? null
      if (typeof presetId !== 'string') presetId = null
    }
    return {
      agentId: String(agent?.id ?? ''),
      sessionId: String(agent?.session?.id ?? ''),
      presetId,
      presetKeys: preset !== null && typeof preset === 'object' ? Object.keys(preset).slice(0, 30) : [],
      hasCompaction: serviceFor(agent, 'compaction') !== undefined,
      hasTokenMeter: serviceFor(agent, 'tokenMeter') !== undefined,
    }
  }

  /** GET /auto-context-compression/api/status and /api/ws-token. */
  async function handleStatusRequest(request, response) {
    if (request.method !== 'GET') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const fetchSite = request.headers?.['sec-fetch-site']
    if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      sendJson(response, 403, { ok: false, error: 'cross-site request rejected' })
      return
    }
    let url
    try {
      url = new URL(request.url ?? '/', 'http://localhost')
    } catch {
      sendJson(response, 400, { ok: false, error: 'bad request url' })
      return
    }
    if (url.pathname === '/auto-context-compression/api/ws-token') {
      if (wsHub === null) {
        sendJson(response, 503, { ok: false, error: 'websocket hub unavailable' })
        return
      }
      sendJson(response, 200, {
        ok: true,
        value: {
          path: WS_PATH,
          protocol: WS_PROTOCOL,
          token: wsHub.token,
        },
      })
      return
    }
    if (url.pathname !== '/auto-context-compression/api/status') {
      sendJson(response, 404, { ok: false, error: 'not found' })
      return
    }
    try {
      const agent = findAgent(url.searchParams.get('sessionId'))
      if (agent === undefined) {
        sendJson(response, 404, { ok: false, error: 'no live agent' })
        return
      }
      const value = await buildLiveValue(agent, true)
      if (url.searchParams.get('debug') === '1') {
        value.diagnostics = {
          client: clientDiagnostics(false),
          agent: agentDiagnostics(agent),
        }
      }
      sendJson(response, 200, { ok: true, value })
    } catch (error) {
      log('warn', `status request failed: ${errorText(error)}`)
      sendJson(response, 500, { ok: false, error: 'internal error' })
    }
  }

  /**
   * The webServer service can mount after this plugin (or not exist at all in
   * non-Web hosts), so retry registration without failing plugin startup.
   */
  function registerStatusRoute() {
    let off = null
    let offUpgrade = null
    let upgradeFailed = false
    let warned = false
    const attempt = () => {
      if (disposed || (off !== null && (offUpgrade !== null || upgradeFailed))) return
      let server
      try {
        server = ctx.get('webServer')
      } catch {
        return
      }
      if (server === undefined || server === null || typeof server.register !== 'function') return
      if (off === null) {
        try {
          off = server.register({
            kind: 'prefix',
            path: '/auto-context-compression/api',
            handler: handleStatusRequest,
          })
          log('info', 'status API mounted at /auto-context-compression/api/status')
        } catch (error) {
          if (!warned) {
            warned = true
            log('warn', `status API registration failed: ${errorText(error)}`)
          }
        }
      }
      if (off !== null && offUpgrade === null && !upgradeFailed) {
        if (typeof server.registerUpgrade !== 'function') {
          upgradeFailed = true
          log('warn', 'webServer.registerUpgrade unavailable; live WebSocket disabled')
          return
        }
        try {
          offUpgrade = server.registerUpgrade({
            path: WS_PATH,
            handler: (request, socket, head) => {
              Promise.resolve(wsHub.handleUpgrade(request, socket, head)).catch((error) => {
                log('warn', `websocket upgrade failed: ${errorText(error)}`)
                try {
                  socket.destroy()
                } catch {
                  /* already gone */
                }
              })
            },
          })
          log('info', `websocket endpoint mounted at ${WS_PATH}`)
        } catch (error) {
          upgradeFailed = true
          log('warn', `websocket registration failed: ${errorText(error)}`)
        }
      }
    }
    attempt()
    const timer = setInterval(attempt, 1000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => {
      clearInterval(timer)
      if (typeof off === 'function') {
        try {
          off()
        } catch {
          /* server may already be disposed */
        }
      }
      if (typeof offUpgrade === 'function') {
        try {
          offUpgrade()
        } catch {
          /* server may already be disposed */
        }
      }
    })
  }

  /**
   * Write the diagnostic status file, throttled unless forced. Failures are
   * best-effort: status reporting must never disturb a model step.
   * @param {boolean} force
   */
  async function writeStatus(force = false) {
    if (!config.statusFile || disposed) return
    const now = Date.now()
    if (!force && now - lastStatusWriteAt < STATUS_INTERVAL_MS) return
    if (writingStatus) {
      statusQueued = true
      return
    }
    writingStatus = true
    lastStatusWriteAt = now
    try {
      await fs.mkdir(statusDir, { recursive: true })
      await fs.writeFile(statusPath, `${JSON.stringify(statusSnapshot(), null, 2)}\n`, 'utf8')
    } catch (error) {
      log('debug', `status file write failed: ${errorText(error)}`)
    } finally {
      writingStatus = false
      if (statusQueued) {
        statusQueued = false
        void writeStatus(true)
      }
    }
  }

  /**
   * One pre-step decision. Always resolves; errors are recorded and logged so
   * the agent turn proceeds unaffected.
   * @param {any} agent
   * @param {AbortSignal|undefined} signal
   */
  async function consider(agent, signal) {
    reloadConfigFromFile()
    const state = ensureState(agent)
    const now = Date.now()
    state.lastSeenAt = now
    if (agent?.session !== undefined && agent.session !== null && (state.cache === null || now - state.cacheAt >= 2000)) {
      try {
        const events = eventsOf(agent.session)
        state.cache = summarizeCacheUsage(events)
        const extras = sessionExtras(events)
        if (extras.title !== null) state.title = extras.title
        if (extras.model !== null) state.model = extras.model
        if (extras.provider !== null) state.provider = extras.provider
        state.compactionUsage = extras.compactionUsage
        state.cacheAt = now
      } catch (error) {
        log('debug', `cache usage scan failed: ${errorText(error)}`)
      }
    }

    if (!state.enabled) {
      state.lastSkipReason = 'disabled'
      return
    }
    if (state.excluded) {
      state.lastSkipReason = 'excluded'
      return
    }
    if (signal?.aborted === true) {
      state.lastSkipReason = 'aborted'
      return
    }
    if (agent?.session === undefined || agent.session === null) {
      state.lastSkipReason = 'no-session'
      return
    }

    const meter = serviceFor(agent, 'tokenMeter')
    if (meter === undefined || typeof meter.measure !== 'function') {
      state.available = false
      state.lastSkipReason = 'no-token-meter'
      return
    }
    const compaction = serviceFor(agent, 'compaction')
    if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
      state.available = false
      state.lastSkipReason = 'no-compaction-service'
      return
    }
    state.available = true

    let measurement
    try {
      measurement = meter.measure(agent.session)
    } catch (error) {
      state.lastSkipReason = 'measure-failed'
      state.lastError = errorText(error)
      log('warn', `token measurement failed: ${state.lastError}`)
      return
    }

    const window = contextWindowFor(agent)
    const ratio = window > 0 ? measurement.totalTokens / window : 0
    state.tokens = measurement.totalTokens
    state.window = window
    state.ratio = ratio

    if (window <= 0) {
      state.lastSkipReason = 'no-context-window'
      await writeStatus()
      return
    }
    if (ratio < state.triggerRatio) {
      state.lastSkipReason = 'below-trigger'
      await writeStatus()
      return
    }
    if (state.lastAttemptAt > 0 && now - state.lastAttemptAt < config.cooldownMs) {
      state.lastSkipReason = 'cooldown'
      await writeStatus()
      return
    }
    if (
      state.lastCompactionAt > 0
      && measurement.totalTokens - state.tokensAfterLastCompaction < config.minGrowthTokens
    ) {
      state.lastSkipReason = 'min-growth'
      await writeStatus()
      return
    }

    if (config.pruneToolResults) {
      const pruner = serviceFor(agent, 'toolResultPruner')
      if (pruner !== undefined && typeof pruner.pruneSession === 'function') {
        try {
          const pruned = pruner.pruneSession(agent.session)
          if (pruned !== null && pruned !== undefined && Array.isArray(pruned.pruned) && pruned.pruned.length > 0) {
            state.prunedChars += pruned.charsRemoved ?? 0
            totals.prunedChars += pruned.charsRemoved ?? 0
            measurement = meter.measure(agent.session)
            state.tokens = measurement.totalTokens
            state.ratio = window > 0 ? measurement.totalTokens / window : 0
            log('info', `pruned ${pruned.pruned.length} oversized tool result(s), saving ${pruned.charsRemoved ?? 0} chars`)
          }
        } catch (error) {
          state.lastError = errorText(error)
          log('warn', `tool-result pruning skipped: ${state.lastError}`)
          // A failed prune may have committed replacements before throwing;
          // remeasure rather than planning against a stale surface snapshot.
          try {
            measurement = meter.measure(agent.session)
            state.tokens = measurement.totalTokens
            state.ratio = window > 0 ? measurement.totalTokens / window : 0
          } catch (measureError) {
            state.lastSkipReason = 'prune-failed'
            state.lastError = errorText(measureError)
            await writeStatus()
            return
          }
        }
      }
      if (measurement.totalTokens / window < state.triggerRatio) {
        state.lastSkipReason = 'pruned-below-trigger'
        await writeStatus()
        return
      }
    }

    let plan
    try {
      const tokensBySeq = new Map()
      for (const node of measurement.nodes) tokensBySeq.set(node.seq, node.tokens)
      plan = planCompaction({
        events: eventsOf(agent.session),
        surfaceNodes: agent.session.surface.nodes,
        tokensBySeq,
        totalTokens: measurement.totalTokens,
        contextWindow: window,
        config: { ...config, triggerRatio: state.triggerRatio, targetRatio: state.targetRatio },
      })
    } catch (error) {
      state.lastSkipReason = 'plan-failed'
      state.lastError = errorText(error)
      log('warn', `compaction planning failed: ${state.lastError}`)
      return
    }

    if (plan.reason !== 'ok') {
      state.lastSkipReason = `plan:${plan.reason}`
      await writeStatus()
      return
    }

    state.lastAttemptAt = now
    state.compacting = true
    totals.attempts += 1
    const before = measurement.totalTokens
    const from = plan.range.start
    const to = plan.range.end
    log(
      'info',
      `compacting ${plan.selected.length} segment(s), surface positions ${from}-${to}, ~${formatTokens(plan.selectedTokens)} tokens at ${formatRatio(ratio)} pressure`,
    )

    try {
      const result = await compaction.compactRegion(from, to, agent, signal)
      if (signal?.aborted === true) {
        state.lastSkipReason = 'aborted'
        return
      }
      const after = meter.measure(agent.session)
      const saved = Math.max(0, before - after.totalTokens)
      state.compactions += 1
      state.tokensSaved += saved
      state.lastCompactionAt = Date.now()
      state.tokensAfterLastCompaction = after.totalTokens
      state.tokens = after.totalTokens
      state.ratio = window > 0 ? after.totalTokens / window : 0
      state.lastSkipReason = 'compacted'
      state.lastError = null
      totals.compactions += 1
      totals.tokensSaved += saved
      log(
        'info',
        `compacted ${result?.shadowedSeqs?.length ?? plan.selected.length} node(s), ~${formatTokens(saved)} tokens saved, now ${formatRatio(state.ratio)} pressure`,
      )
    } catch (error) {
      state.lastSkipReason = 'compaction-failed'
      state.lastError = errorText(error)
      log('warn', `compaction failed: ${state.lastError}`)
    } finally {
      state.compacting = false
      await writeStatus(true)
    }
  }

  /** One-line cache summary for `/autocompact status`. */
  function cacheSummaryLine(cache) {
    if (cache === null || cache.requests === 0 || cache.hitRate === null) {
      return 'Cache: no provider usage recorded yet'
    }
    const last = cache.last?.hitRate === null || cache.last?.hitRate === undefined
      ? ''
      : `; last ${formatRatio(cache.last.hitRate)}`
    return `Cache: ${formatRatio(cache.hitRate)} hit / ${formatRatio(cache.missRate)} miss (${cache.requests} req${last})`
  }

  /** Detailed prompt-cache view for `/autocompact cache`. */
  function cacheText(agent) {
    const cache = summarizeCacheUsage(eventsOf(agent.session))
    if (cache.requests === 0 || cache.promptTokens === 0) {
      return 'No provider prompt-cache usage recorded yet.\nThe routed adapter may not report cacheReadTokens/cacheWriteTokens.'
    }

    const lines = [
      'Prompt cache (main conversation requests)',
      `  Requests: ${cache.requests}`,
      `  Prompt tokens: ${formatTokens(cache.promptTokens)}`,
      `  Hit: ${formatTokens(cache.cacheReadTokens)} (${formatRatio(cache.hitRate)})`,
      `  Miss: ${formatTokens(cache.uncachedInputTokens + cache.cacheWriteTokens)} (${formatRatio(cache.missRate)})`,
      `    uncached input: ${formatTokens(cache.uncachedInputTokens)}`,
      `    cache write: ${formatTokens(cache.cacheWriteTokens)}`,
      `  Output tokens: ${formatTokens(cache.outputTokens)}`,
    ]
    if (cache.last !== null) {
      const last = cache.last
      const suffix = last.at === null ? '' : ` at ${new Date(last.at).toISOString()}`
      lines.push(
        `  Last request: ${formatRatio(last.hitRate)} hit · ${formatTokens(last.cacheReadTokens)} read / ${formatTokens(last.promptTokens)} prompt${suffix}`,
      )
    }
    return lines.join('\n')
  }

  /** Human-readable status for `/autocompact status`. */
  async function statusText(agent, state) {
    const lines = [`Auto context compression — ${state.enabled ? 'ON' : 'OFF'} (session)`]
    if (state.excluded) lines.push('This session is excluded by config (excludeSessionIds).')

    let measurement = null
    try {
      const meter = serviceFor(agent, 'tokenMeter')
      if (meter !== undefined && typeof meter.measure === 'function') measurement = meter.measure(agent.session)
    } catch (error) {
      lines.push(`Context measurement failed: ${errorText(error)}`)
    }

    if (measurement !== null) {
      const window = contextWindowFor(agent)
      const ratio = window > 0 ? measurement.totalTokens / window : 0
      state.tokens = measurement.totalTokens
      state.window = window
      state.ratio = ratio
      if (window > 0) {
        lines.push(`Context: ${formatTokens(measurement.totalTokens)} / ${formatTokens(window)} tokens (${formatRatio(ratio)})`)
      } else {
        lines.push(`Context: ${formatTokens(measurement.totalTokens)} tokens (window unknown)`)
      }
    }

    let cache = state.cache
    try {
      cache = summarizeCacheUsage(eventsOf(agent.session))
      state.cache = cache
      state.cacheAt = Date.now()
    } catch {
      /* keep the last known value */
    }
    lines.push(cacheSummaryLine(cache))

    lines.push(
      `Trigger: ${formatRatio(state.triggerRatio)} · target: ${formatRatio(state.targetRatio)} · retain: ${config.keepRecentTurns} turn(s) / ${formatTokens(config.keepRecentTokens)} tokens`,
    )
    lines.push(
      `Compactions: ${state.compactions} · saved: ${formatTokens(state.tokensSaved)} tokens · pruned: ${formatTokens(state.prunedChars)} chars`,
    )
    lines.push(`Last compaction: ${state.lastCompactionAt > 0 ? new Date(state.lastCompactionAt).toISOString() : 'never'}`)
    lines.push(`Last check: ${state.lastSkipReason}`)
    if (!state.available) lines.push('Compaction service: unavailable in this agent preset')
    if (state.lastError !== null) lines.push(`Last error: ${state.lastError}`)
    if (config.statusFile) lines.push(`Status file: ${statusPath}`)
    if (config.configFile) lines.push(`Config file: ${configPath}`)
    if (configFileError !== null) lines.push(`Config file error: ${configFileError}`)
    return lines.join('\n')
  }

  /** Execute one `/autocompact` invocation. */
  async function handleCommand(invocation) {
    reloadConfigFromFile(true)
    const agent = invocation.agent
    const state = ensureState(agent)
    const raw = String(invocation.rawInput ?? '').trim()
    const parts = raw.length === 0 ? ['status'] : raw.split(/\s+/)
    const verb = String(parts[0] ?? 'status').toLowerCase()

    switch (verb) {
      case 'status': {
        const text = await statusText(agent, state)
        void writeStatus(true)
        return { kind: 'success', text }
      }
      case 'cache': {
        const text = cacheText(agent)
        void writeStatus(true)
        return { kind: 'success', text }
      }
      case 'on': {
        if (state.excluded) {
          return {
            kind: 'error',
            text: 'This session is excluded by config (excludeSessionIds); remove its id from the plugin config to enable compression.',
          }
        }
        state.enabled = true
        state.enabledCustom = true
        state.lastSkipReason = 'enabled-manually'
        void writeStatus(true)
        return { kind: 'success', text: 'Auto context compression is ON for this session.' }
      }
      case 'off': {
        state.enabled = false
        state.enabledCustom = true
        state.lastSkipReason = 'disabled-manually'
        void writeStatus(true)
        return { kind: 'success', text: 'Auto context compression is OFF for this session.' }
      }
      case 'threshold': {
        if (parts.length !== 2) return { kind: 'error', text: `Missing threshold.\n${USAGE}` }
        const value = Number(parts[1])
        if (!Number.isFinite(value)) return { kind: 'error', text: `Not a number: ${parts[1]}` }
        const ratio = value > 1 ? value / 100 : value
        if (!(ratio > 0 && ratio < 1)) {
          return { kind: 'error', text: 'Threshold must be in (0, 1) or (0, 100) percent.' }
        }
        if (ratio <= state.targetRatio) {
          return {
            kind: 'error',
            text: `Threshold must be greater than the session target (${formatRatio(state.targetRatio)}).`,
          }
        }
        state.triggerRatio = ratio
        state.triggerCustom = true
        state.lastSkipReason = 'threshold-updated'
        void writeStatus(true)
        return { kind: 'success', text: `Trigger threshold for this session set to ${formatRatio(ratio)}.` }
      }
      case 'target': {
        if (parts.length !== 2) return { kind: 'error', text: `Missing target.\n${USAGE}` }
        const value = Number(parts[1])
        if (!Number.isFinite(value)) return { kind: 'error', text: `Not a number: ${parts[1]}` }
        const ratio = value > 1 ? value / 100 : value
        if (!(ratio > 0 && ratio < 1)) {
          return { kind: 'error', text: 'Target must be in (0, 1) or (0, 100) percent.' }
        }
        if (ratio >= state.triggerRatio) {
          return {
            kind: 'error',
            text: `Target must be less than the session trigger (${formatRatio(state.triggerRatio)}).`,
          }
        }
        state.targetRatio = ratio
        state.targetCustom = true
        state.lastSkipReason = 'target-updated'
        void writeStatus(true)
        return { kind: 'success', text: `Compression target for this session set to ${formatRatio(ratio)}.` }
      }
      case 'config': {
        return {
          kind: 'success',
          text: JSON.stringify({ ...config, configFilePath: config.configFile ? configPath : null }, null, 2),
        }
      }
      default:
        return { kind: 'error', text: USAGE }
    }
  }

  /** Attach one agent-scoped pre-step observer, once per live agent id. */
  function attachAgent(agent) {
    if (agent === undefined || agent === null) return
    const id = String(agent.id)
    if (disposers.has(id)) return

    const state = ensureState(agent)
    const compaction = serviceFor(agent, 'compaction')
    if (compaction === undefined || typeof compaction.compactRegion !== 'function') {
      state.available = false
      state.lastSkipReason = 'no-compaction-service'
      log('debug', `agent ${id}: no compaction service in its preset; automatic compression is inactive`)
      return
    }
    state.available = true

    if (typeof agent.ctx?.on !== 'function') {
      state.lastSkipReason = 'no-agent-context'
      log('warn', `agent ${id}: no agent context; cannot observe pre-step`)
      return
    }

    const off = agent.ctx.on('agent/pre-step', async (payload, next) => {
      try {
        await consider(payload?.agent ?? agent, payload?.signal)
      } catch (error) {
        log('warn', `unexpected pre-step failure: ${errorText(error)}`)
      }
      return typeof next === 'function' ? next() : next
    })
    disposers.set(id, off)
    log('debug', `agent ${id}: proactive compression observer attached`)
  }

  ctx.on('agent/created', ({ agent } = {}) => {
    attachAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    const id = String(agent?.id ?? '')
    const off = disposers.get(id)
    if (typeof off === 'function') {
      try {
        off()
      } catch {
        /* the agent context may already be disposed */
      }
    }
    disposers.delete(id)
    sessions.delete(id)
  })

  ctx.effect(() => () => {
    disposed = true
    try {
      wsHub?.close(1001, 'plugin disposed')
    } catch {
      /* best effort during unload */
    }
    for (const off of disposers.values()) {
      try {
        off()
      } catch {
        /* best effort during unload */
      }
    }
    disposers.clear()
    sessions.clear()
  })

  ensureDefaultConfigFile()
  reloadConfigFromFile(true)
  log('info', `ready (trigger ${formatRatio(config.triggerRatio)}, target ${formatRatio(config.targetRatio)})`)
  for (const agent of (ctx.agents?.list?.() ?? [])) attachAgent(agent)
  registerStatusRoute()
  ensureClientRegistration()
  void writeStatus(true)

  // Push the authoritative snapshot once per second to every connected panel.
  // The hub coalesces slow clients, so this interval cannot queue unbounded work.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (wsHub !== null && wsHub.clientCount > 0) wsHub.broadcast()
    }, 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // A host reload can happen after an agent was created and miss the
  // `agent/created` event, which would leave that session unobserved until a
  // restart. Reconcile the live agent list cheaply so status and automatic
  // compression recover without requiring a new turn.
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const agent of (ctx.agents?.list?.() ?? [])) attachAgent(agent)
    }, 2000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  const commands = ctx.commands ?? ctx.get('commands')
  if (commands === undefined || typeof commands.register !== 'function') {
    log('warn', 'commands service unavailable; /autocompact will not be registered')
    return
  }
  ctx.effect(() => commands.register({
    name: 'autocompact',
    description: 'Show or control proactive automatic context compression',
    input: { hint: 'status | cache | on | off | threshold <ratio> | target <ratio> | config' },
    handler: async (invocation) => {
      try {
        return await handleCommand(invocation)
      } catch (error) {
        return { kind: 'error', text: `autocompact failed: ${errorText(error)}` }
      }
    },
  }))
}
