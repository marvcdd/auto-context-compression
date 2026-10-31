/**
 * 自动上下文压缩（Host 插件）。
 * Auto context compression (Host plugin).
 *
 * 中文：
 * 在 agent preset 已挂载的持久化 `ctx.compaction` 引擎之上增加主动压缩策略。
 * 对每个 agent 监听 `agent/pre-step`，用 `ctx.tokenMeter` 测量最新请求压力；
 * 超过触发线后先裁剪超大工具结果，再压缩最旧、连续、工具调用配对完整的区间，
 * 保留最近的逐字上下文。所有失败都会记录日志，并让当前 step 继续执行。
 *
 * English:
 * A proactive compaction policy layered on top of the durable `ctx.compaction`
 * engine already mounted by an agent preset. For every agent we observe
 * `agent/pre-step`, measure the latest request pressure with `ctx.tokenMeter`,
 * and once the configured trigger ratio is crossed:
 *
 *   1. deterministic oversized-tool-result pruning (`toolResultPruner`), then
 *   2. summarization of the oldest contiguous, tool-pair-balanced span
 *      (`compaction.compactRegion`), retaining a verbatim recent tail.
 *
 * 本文件注释采用中英双语；中文在前，English follows。
 * Comments in this file are bilingual: Chinese first, then English.
 */
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatRatio, formatTokens, planCompaction, resolveConfig, summarizeCacheUsage, summarizeCompactionUsage } from './policy.js'
import { createBiliClient } from './bili.js'
import { createClientRegistrar } from './client-registration.js'
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

/** 生成用于日志和命令输出的简短安全错误文本。Short, safe error text for logs and command output. */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Host 插件入口；`rawConfig` 来自 bundle patch 或 profile patch。
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
  const biliClient = createBiliClient({ getOrigin: () => config.biliOrigin, log })
  const clientRegistrar = createClientRegistrar({
    ctx,
    packageName: 'dsh-auto-context-compression',
    clientBundlePath,
    clientBundleBase,
    log,
  })
  let wsHub = null

  /**
   * 按配置的日志级别写入 Host logger。
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
   * 应用新的有效配置；显式 `/autocompact` 会话覆盖优先于文件变更，
   * 排除列表始终重新计算。
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

  /** 配置文件缺失时，从当前有效 Loader 配置生成默认文件。Create the user config file from the effective Loader config when absent. */
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
   * 按轮询间隔重读用户配置文件；格式错误时保留上一版有效配置，
   * 并把错误写进状态文件。
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
   * 优先从 agent 的 preset 隔离组解析服务。`agent.ctx` 是外层上下文，
   * 看不到子组服务，因此 `agentPresets.serviceFor` 才是 `compaction` 和
   * `toolResultPruner` 的权威入口；Host 平面服务仍可沿普通上下文链获取。
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
      /* 未绑定 agent 或 preset 缺少该服务，不算错误。An unbound agent or missing preset service is not an error. */
    }
    try {
      const local = agent?.ctx?.get?.(serviceName)
      if (local !== undefined) return local
    } catch {
      /* 可选服务缺失，不算错误。A missing optional service is not an error. */
    }
    try {
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  /** 获取或创建内存中的每会话视图。Get or create the in-memory per-session view. */
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

  /** 最新的路由上下文窗口；只有显式配置时才回退。Latest routed context window, falling back only when explicitly set. */
  function contextWindowFor(agent) {
    const requestContext = agent?.session?.requestContext?.()
    const window = requestContext?.contextWindow
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) return window
    return config.fallbackContextWindow > 0 ? config.fallbackContextWindow : 0
  }

  /** 截取 turn/step 分段所需的持久日志前缀。Snapshot the durable log prefix needed for turn/step segmentation. */
  function eventsOf(session) {
    const events = []
    const end = session.seq
    for (let seq = 0; seq < end; seq += 1) {
      const event = session.eventAt(seq)
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /** 构造状态文件与 HTTP API 共用的单会话视图。Build one session entry shared by the status file and the HTTP API. */
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

  /** 复制当前进程的状态文件负载。Copy the payload of a status file for the current process. */
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
   * 从持久日志提取低成本展示元数据：最新标题、路由 provider/model、
   * 压缩摘要累计 usage；事件缺失时保留旧值。
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
   * 刷新会话视图但不触发压缩；只读状态 API 的 GET 绝不能改变模型可见 surface。
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

  /** 解析客户端传入的 session id；找不到时回退到最新 agent。Resolve the agent for a client-supplied session id, newest as fallback. */
  function findAgent(sessionId) {
    const agents = ctx.agents?.list?.() ?? []
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const exact = agents.find((agent) => String(agent.id) === sessionId || String(agent.session?.id) === sessionId)
      if (exact !== undefined) return exact
    }
    return agents.length > 0 ? agents[agents.length - 1] : undefined
  }

  /** 发送一个 JSON 响应，并吞掉刷新导致的断连。Send one JSON response, swallowing the disconnect that a refresh causes. */
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
      /* 浏览器可能在轮询途中关闭标签页。The browser may have closed the tab while a poll was in flight. */
    }
  }

  /** 构造 HTTP 路由和 WebSocket 共用的精确负载。Build the exact payload consumed by the HTTP route and the WebSocket. */
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
    const bili = state === null ? { value: null, error: null } : await biliClient.fetchDetail(state.id)
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

  /** Web 客户端 bundle 的只读启动图/工厂诊断。Read-only boot graph/factory diagnostics for the Web client bundle. */
  /** 当前会话 agent 的只读 preset/service 诊断。Read-only preset/service diagnostics for the active session agent. */
  function agentDiagnostics(agent) {
    let preset = null
    try {
      preset = ctx.agentPresets?.composedPreset?.(agent?.ctx)
    } catch {
      /* 该类型的 agent 可能尚未组合 preset。A preset may not be composed for this agent kind. */
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

  /** 处理 GET /auto-context-compression/api/status 与 /api/ws-token。GET /auto-context-compression/api/status and /api/ws-token. */
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
          client: clientRegistrar.diagnostics(false),
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
   * webServer 可能晚于本插件挂载（非 Web Host 中也可能不存在），
   * 因此重试注册，不能阻塞插件启动。
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
                  /* 已经断开。Already gone. */
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
          /* server 可能已经释放。Server may already be disposed. */
        }
      }
      if (typeof offUpgrade === 'function') {
        try {
          offUpgrade()
        } catch {
          /* server 可能已经释放。Server may already be disposed. */
        }
      }
    })
  }

  /**
   * 写诊断状态文件，默认节流；失败是尽力而为，状态上报绝不能干扰模型 step。
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
   * 一次 pre-step 决策；总是 resolve，异常只记录日志，保证 agent turn 继续。
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
          // 裁剪失败可能已经提交了部分 replacement；重新测量，避免按旧 surface 规划。
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

  /** `/autocompact status` 使用的一行缓存摘要。One-line cache summary for `/autocompact status`. */
  function cacheSummaryLine(cache) {
    if (cache === null || cache.requests === 0 || cache.hitRate === null) {
      return 'Cache: no provider usage recorded yet'
    }
    const last = cache.last?.hitRate === null || cache.last?.hitRate === undefined
      ? ''
      : `; last ${formatRatio(cache.last.hitRate)}`
    return `Cache: ${formatRatio(cache.hitRate)} hit / ${formatRatio(cache.missRate)} miss (${cache.requests} req${last})`
  }

  /** `/autocompact cache` 使用的详细 prompt-cache 视图。Detailed prompt-cache view for `/autocompact cache`. */
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

  /** `/autocompact status` 的人类可读状态。Human-readable status for `/autocompact status`. */
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
      /* 保留上一次已知值。Keep the last known value. */
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

  /** 执行一次 `/autocompact` 调用。Execute one `/autocompact` invocation. */
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

  /** 为每个 live agent id 只挂载一次 agent 作用域 pre-step 观察器。Attach one agent-scoped pre-step observer, once per live agent id. */
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
        /* agent 上下文可能已经释放。The agent context may already be disposed. */
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
        /* 卸载期间尽力清理。Best effort during unload. */
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
  clientRegistrar.ensure()
  void writeStatus(true)

  // 每个已连接面板每秒推送一次权威快照；hub 会合并慢客户端，避免无界排队。
  // Push the authoritative snapshot once per second to every connected panel.
  // The hub coalesces slow clients, so this interval cannot queue unbounded work.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (wsHub !== null && wsHub.clientCount > 0) wsHub.broadcast()
    }, 1000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  // Host 重载可能发生在 agent 创建之后，从而错过 `agent/created`，让该会话
  // 一直未被观察。定期对账 live agent 列表，让状态与自动压缩无需新 turn 即可恢复。
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
