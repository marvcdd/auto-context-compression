/**
 * 自动上下文压缩的纯规划与配置逻辑。
 * Pure planning and configuration logic for the auto context compression plugin.
 *
 * 中文：
 * 本模块不导入 Harness，便于用普通 Node 做单元测试。运行时复用内置
 * `compaction-basic` 的持久化压缩引擎；本文件只决定“何时压缩”以及“压缩哪段旧上下文”。
 *
 * English:
 * This module has no Harness imports so it can be unit-tested with plain Node.
 * The runtime decision uses the same durable compaction engine as the built-in
 * `compaction-basic` backend; this file only decides WHEN and WHICH old surface
 * span is worth compacting.
 *
 * 本文件注释采用中英双语。Comments in this file are bilingual.
 */

/**
 * 默认值与 bundle patch 保持一致；修改时需要同步两处。
 * Defaults mirror the bundle patch; keep both in sync when changing them.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  triggerRatio: 0.5,
  targetRatio: 0.35,
  keepRecentTurns: 2,
  keepRecentTokens: 12000,
  minCompactionTokens: 8000,
  minGrowthTokens: 8000,
  cooldownMs: 60000,
  pruneToolResults: true,
  fallbackContextWindow: 0,
  statusFile: true,
  configFile: true,
  logLevel: 'info',
  excludeSessionIds: Object.freeze([]),
  // billion-context 在这个 loopback origin 暴露每会话统计；空字符串关闭集成，原生统计仍然可用。
  // billion-context exposes its per-session stats on this loopback origin.
  // Set to an empty string to disable the integration (the native stats still work).
  biliOrigin: 'http://127.0.0.1:18787',
})

const BOOLEAN_KEYS = ['enabled', 'pruneToolResults', 'statusFile', 'configFile']
const RATIO_KEYS = ['triggerRatio', 'targetRatio']
const INTEGER_KEYS = [
  'keepRecentTurns',
  'keepRecentTokens',
  'minCompactionTokens',
  'minGrowthTokens',
  'cooldownMs',
  'fallbackContextWindow',
]
const LOG_LEVELS = new Set(['silent', 'error', 'warn', 'info', 'debug'])

/**
 * 校验不可信插件配置，返回冻结且补全默认值的对象；未知键直接拒绝，
 * 避免拼写错误悄悄关闭安全开关。
 * Validate untrusted plugin config and return a frozen, fully defaulted object.
 * Unknown keys are rejected so a typo cannot silently disable a safety knob.
 * @param {unknown} raw - Loader-supplied config.
 * @returns {Readonly<typeof CONFIG_DEFAULTS>}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('auto-context-compression: config must be an object')
  }

  const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(CONFIG_DEFAULTS, key))
  if (unknown.length > 0) {
    throw new Error(`auto-context-compression: unknown config key(s): ${unknown.join(', ')}`)
  }

  const config = { ...CONFIG_DEFAULTS, ...raw }

  for (const key of BOOLEAN_KEYS) {
    if (typeof config[key] !== 'boolean') {
      throw new TypeError(`auto-context-compression: ${key} must be a boolean`)
    }
  }
  for (const key of RATIO_KEYS) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0 || config[key] >= 1) {
      throw new RangeError(`auto-context-compression: ${key} must be a number in (0, 1)`)
    }
  }
  if (config.targetRatio >= config.triggerRatio) {
    throw new RangeError('auto-context-compression: targetRatio must be less than triggerRatio')
  }
  for (const key of INTEGER_KEYS) {
    if (!Number.isInteger(config[key]) || config[key] < 0) {
      throw new RangeError(`auto-context-compression: ${key} must be a non-negative integer`)
    }
  }
  if (!LOG_LEVELS.has(config.logLevel)) {
    throw new RangeError(`auto-context-compression: logLevel must be one of ${[...LOG_LEVELS].join(', ')}`)
  }
  if (!Array.isArray(config.excludeSessionIds)
    || config.excludeSessionIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new TypeError('auto-context-compression: excludeSessionIds must be an array of non-empty session id strings')
  }
  config.excludeSessionIds = Object.freeze([...config.excludeSessionIds])

  if (typeof config.biliOrigin !== 'string' || config.biliOrigin.length === 0) {
    if (config.biliOrigin !== '') {
      throw new TypeError('auto-context-compression: biliOrigin must be a loopback HTTP origin or an empty string')
    }
  } else {
    let origin
    try {
      origin = new URL(config.biliOrigin)
    } catch {
      throw new TypeError('auto-context-compression: biliOrigin must be a valid loopback HTTP origin')
    }
    const host = origin.hostname.replace(/^\[|\]$/g, '')
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:')
      || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new TypeError('auto-context-compression: biliOrigin must be a loopback HTTP origin or an empty string')
    }
    config.biliOrigin = origin.origin
  }

  return Object.freeze(config)
}

/** 格式化 token 数量，供命令输出使用。Format a token count for command output. */
export function formatTokens(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return Math.round(number).toLocaleString('en-US')
}

/** 把 0..1 压力比例格式化为命令输出。Format a 0..1 pressure ratio for command output. */
export function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return '0%'
  const percent = Math.round(ratio * 1000) / 10
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`
}

/** 把 usage 字段转换为非负有限数字。Coerce a usage field to a non-negative finite number. */
function usageNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * 汇总主对话的 provider prompt-cache 使用情况。
 * Aggregate provider prompt-cache usage from a session's main conversation.
 *
 * 中文：
 * DSH 将 usage 拆成 `inputTokens`（未命中）、`cacheReadTokens`（命中缓存）和
 * `cacheWriteTokens`（写入缓存）。因此 prompt 分母是三者之和；缓存写入按未命中
 * 计算，因为 provider 仍需处理这些 token。`compaction/summary` 的辅助调用不计入，
 * 本视图只覆盖正常对话请求。
 *
 * DSH normalizes usage into separate `inputTokens` (uncached prompt),
 * `cacheReadTokens` (prompt prefix served from cache), and `cacheWriteTokens`
 * (prompt tokens that seeded the cache). The prompt denominator is therefore
 * their sum; cache writes count as misses because the provider had to process
 * those tokens. Compaction summary calls are recorded on `compaction/summary`
 * rather than `assistant/message`, so this view covers normal conversation
 * requests only.
 *
 * @param {readonly {type?:string, time?:number, data?:any}[]} events
 * @returns {{
 *   requests:number,
 *   promptTokens:number,
 *   uncachedInputTokens:number,
 *   cacheReadTokens:number,
 *   cacheWriteTokens:number,
 *   outputTokens:number,
 *   hitRate:number|null,
 *   missRate:number|null,
 *   last:null|{promptTokens:number,cacheReadTokens:number,cacheWriteTokens:number,uncachedInputTokens:number,hitRate:number|null,missRate:number|null,at:number|null}
 * }}
 */
export function summarizeCacheUsage(events) {
  let requests = 0
  let uncachedInputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let last = null

  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') continue

    const input = usageNumber(usage.inputTokens)
    const read = usageNumber(usage.cacheReadTokens)
    const write = usageNumber(usage.cacheWriteTokens)
    const output = usageNumber(usage.outputTokens)
    const prompt = input + read + write
    if (prompt === 0 && output === 0) continue

    requests += 1
    uncachedInputTokens += input
    cacheReadTokens += read
    cacheWriteTokens += write
    outputTokens += output
    last = {
      promptTokens: prompt,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      uncachedInputTokens: input,
      hitRate: prompt > 0 ? read / prompt : null,
      missRate: prompt > 0 ? (input + write) / prompt : null,
      at: typeof event.time === 'number' ? event.time : null,
    }
  }

  const promptTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  return {
    requests,
    promptTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    hitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
    missRate: promptTokens > 0 ? (uncachedInputTokens + cacheWriteTokens) / promptTokens : null,
    last,
  }
}

/**
 * 汇总会话日志中压缩摘要调用的累计 usage，这是压缩成本中可明确观测的一项；
 * 重放前缀的成本无法从这些事件中观测，因此任何回本估算都只是近似值。
 * Cumulative usage of compaction summaries in a session log. This is the
 * explicit cost side of a compaction (the summarizer's own request); the
 * replayed-prefix cost is not observable from these events, so callers must
 * treat any derived break-even estimate as approximate.
 *
 * @param {readonly {type:string, data?:any}[]} events
 * @returns {{
 *   calls:number,
 *   inputTokens:number,
 *   cacheReadTokens:number,
 *   cacheWriteTokens:number,
 *   outputTokens:number,
 *   promptTokens:number
 * }}
 */
export function summarizeCompactionUsage(events) {
  let calls = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0

  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'compaction/summary') continue
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') continue

    const input = usageNumber(usage.inputTokens)
    const read = usageNumber(usage.cacheReadTokens)
    const write = usageNumber(usage.cacheWriteTokens)
    const output = usageNumber(usage.outputTokens)
    if (input === 0 && read === 0 && write === 0 && output === 0) continue

    calls += 1
    inputTokens += input
    cacheReadTokens += read
    cacheWriteTokens += write
    outputTokens += output
  }

  return {
    calls,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
  }
}

/**
 * 按 turn 分组当前 surface 节点，并保持日志顺序。
 * Group current surface nodes by turn, preserving log order.
 *
 * 中文：
 * 只收集 surface 事件；生命周期事件只用于划分边界。surface 节点已被整体替换掉的
 * turn 会被省略。
 *
 * Only surface events are collected; non-surface lifecycle events (turn/start,
 * step/end, compaction markers) merely delimit segments. A turn whose surface
 * nodes were entirely replaced away is omitted.
 *
 * @param {readonly {type:string, seq:number, data?:any}[]} events
 * @param {readonly number[]} surfaceNodes
 * @returns {{turn:number,startSeq:number,endSeq:number,nodes:number[],complete:boolean}[]}
 */
export function buildTurnSegments(events, surfaceNodes) {
  const surface = new Set(surfaceNodes)
  const segments = []
  let current = null

  for (const event of events) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue

    if (event.type === 'turn/start') {
      if (current !== null && !current.complete) current.complete = true
      current = {
        turn: event.data?.turn ?? segments.length + 1,
        startSeq: event.seq,
        endSeq: -1,
        nodes: [],
        complete: false,
      }
      segments.push(current)
      continue
    }

    if (event.type === 'turn/end') {
      if (current !== null) {
        current.complete = true
        current.endSeq = event.seq
        current = null
      }
      continue
    }

    if (current !== null && surface.has(event.seq) && event.type !== 'system/message') {
      current.nodes.push(event.seq)
    }
  }

  return segments.filter((segment) => segment.nodes.length > 0)
}

/**
 * 构造当前开放 turn 的可压缩前缀：最后一个已完成 step 之前的 surface 节点；
 * 正在执行的 step 永远保留。
 * Build the compactable prefix of the currently open turn: every surface node
 * up to the last completed step. The in-progress step is always retained.
 * @param {readonly {type:string, seq:number}[]} events
 * @param {{startSeq:number, nodes:number[], turn:number}|undefined} open
 */
function completedStepPrefix(events, open) {
  if (open === undefined) return null

  let lastStepEnd = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.seq < open.startSeq) break
    if (event.type === 'step/end') {
      lastStepEnd = event.seq
      break
    }
  }
  if (lastStepEnd < 0) return null

  const nodes = open.nodes.filter((seq) => seq <= lastStepEnd)
  if (nodes.length === 0) return null

  return {
    turn: open.turn,
    startSeq: open.startSeq,
    endSeq: lastStepEnd,
    nodes,
    complete: true,
    partial: true,
  }
}

/** 汇总一个 segment 中按路由计价后的 surface token。Sum route-priced tokens for one segment's surface nodes. */
function segmentTokens(segment, tokensBySeq) {
  let total = 0
  for (const seq of segment.nodes) total += tokensBySeq.get(seq) ?? 0
  return total
}

/** surface 仍是追加式（没有 replacement 节点）时返回 true。True when the surface is still append-only (no replacement nodes). */
function isStrictlyIncreasing(nodes) {
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index] <= nodes[index - 1]) return false
  }
  return true
}

/**
 * 校验 surface 前缀中的每个工具调用都恰好有一个后续结果，且没有孤立结果；
 * 压缩区间必须从对齐边界（第一个非 system 节点）开始。
 * Verify that every tool call inside a surface prefix has exactly one later
 * tool result, and no result appears without its call. The range must start at
 * a balanced boundary (the first non-system node).
 */
function toolPairingBalanced(surfaceNodes, eventBySeq, startIdx, endIdx) {
  const open = new Set()
  for (let index = startIdx; index <= endIdx; index += 1) {
    const event = eventBySeq.get(surfaceNodes[index])
    if (event === undefined) return false
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return false
      for (const block of content) {
        if (block?.type === 'tool-call') {
          if (typeof block.id !== 'string') return false
          open.add(block.id)
        }
      }
    } else if (event.type === 'tool/result') {
      const id = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
      if (typeof id !== 'string' || !open.has(id)) return false
      open.delete(id)
    }
  }
  return open.size === 0
}

/** 当前开放 turn 追加后缀在 surface 中的起始下标。First surface index of the currently open turn's appended suffix. */
function currentTurnSuffixStart(surfaceNodes, eventBySeq, events) {
  let lastTurnStartSeq = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'turn/start') {
      lastTurnStartSeq = events[index].seq
      break
    }
  }
  if (lastTurnStartSeq < 0) return surfaceNodes.length

  let suffixStart = surfaceNodes.length
  for (let index = surfaceNodes.length - 1; index >= 0; index -= 1) {
    const event = eventBySeq.get(surfaceNodes[index])
    if (event === undefined) break
    const append = event.surfaceOp === undefined || event.surfaceOp === 'append'
    if (!append || event.seq < lastTurnStartSeq) break
    suffixStart = index
  }
  return suffixStart
}

/**
 * surface 已经包含 replacement 节点（压缩检查点或裁剪后的工具结果）时的回退选择器。
 * Fallback selector for a surface that already contains replacement nodes
 * (compaction checkpoints or pruned tool results), where log order no longer
 * matches surface order. It compacts the oldest surface prefix up to a
 * tool-pair-balanced cut, retaining the current turn's appended suffix and a
 * token tail.
 */
function planPrefixCompaction({ events, surfaceNodes, tokensBySeq, totalTokens, contextWindow, config, targetTokens }) {
  const eventBySeq = new Map()
  for (const event of events) eventBySeq.set(event.seq, event)

  let startIdx = 0
  while (startIdx < surfaceNodes.length && eventBySeq.get(surfaceNodes[startIdx])?.type === 'system/message') {
    startIdx += 1
  }
  if (startIdx >= surfaceNodes.length - 1) return { reason: 'no-eligible-span', targetTokens }

  const suffixStart = currentTurnSuffixStart(surfaceNodes, eventBySeq, events)

  let cutIdx = surfaceNodes.length
  let tailTokens = 0
  for (let index = surfaceNodes.length - 1; index > startIdx; index -= 1) {
    tailTokens += tokensBySeq.get(surfaceNodes[index]) ?? 0
    cutIdx = index
    if (tailTokens >= config.keepRecentTokens) break
  }

  let endIdx = Math.min(cutIdx - 1, suffixStart - 1)
  while (endIdx > startIdx && !toolPairingBalanced(surfaceNodes, eventBySeq, startIdx, endIdx)) {
    endIdx -= 1
  }
  if (endIdx <= startIdx) return { reason: 'no-safe-boundary', targetTokens }

  let selectedTokens = 0
  for (let index = startIdx; index <= endIdx; index += 1) {
    selectedTokens += tokensBySeq.get(surfaceNodes[index]) ?? 0
  }
  if (selectedTokens < config.minCompactionTokens) {
    return { reason: 'below-minimum', targetTokens, selectedTokens }
  }

  return {
    reason: 'ok',
    mode: 'prefix',
    range: { start: surfaceNodes[startIdx], end: surfaceNodes[endIdx] },
    selectedTokens,
    targetTokens,
    totalTokens,
    retainedTurns: 0,
    selected: [{ nodes: surfaceNodes.slice(startIdx, endIdx + 1) }],
    prefixSelected: false,
  }
}


/**
 * 选择最旧的连续区间，把实测压力降到 `targetRatio` 附近，同时保留逐字最近尾部。
 * Choose the oldest contiguous span that reduces measured pressure toward
 * `targetRatio` while retaining a verbatim recent tail.
 *
 * 中文：
 * 只有两种区间形态，且不允许跳段：
 * 1. 最旧的一批完整 turn（不包含保留尾部），或
 * 2. 当上述区间不存在或太小时，当前开放 turn 的已完成 step 前缀。
 *
 * Two span shapes are possible, never a gap:
 * 1. a run of the oldest completed turns that are not part of the retained
 *    tail, or
 * 2. when that run is absent or too small to justify summarization, the
 *    completed-step prefix of the currently open turn.
 *
 * @param {object} input
 * @param {readonly {type:string, seq:number, data?:any}[]} input.events
 * @param {readonly number[]} input.surfaceNodes - `session.surface.nodes`
 * @param {Map<number, number>} input.tokensBySeq - route-priced node tokens
 * @param {number} input.totalTokens - measured request pressure
 * @param {number} input.contextWindow
 * @param {Readonly<typeof CONFIG_DEFAULTS>} input.config
 * @returns {{reason:string, range?:{start:number,end:number}, selectedTokens?:number, targetTokens?:number, retainedTurns?:number, selected?:object[], prefixSelected?:boolean}}
 */
export function planCompaction({ events, surfaceNodes, tokensBySeq, totalTokens, contextWindow, config }) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { reason: 'no-context-window' }
  }
  if (!Array.isArray(surfaceNodes) || surfaceNodes.length === 0) {
    return { reason: 'empty-surface' }
  }

  const targetTokens = Math.max(0, Math.floor(contextWindow * config.targetRatio))
  if (totalTokens <= targetTokens) return { reason: 'below-target', targetTokens }
  if (!isStrictlyIncreasing(surfaceNodes)) {
    return planPrefixCompaction({ events, surfaceNodes, tokensBySeq, totalTokens, contextWindow, config, targetTokens })
  }

  const turns = buildTurnSegments(events, surfaceNodes)
  if (turns.length === 0) return { reason: 'no-turns', targetTokens }

  const last = turns[turns.length - 1]
  const open = last.complete === false ? last : undefined
  const completed = turns.filter((turn) => turn.complete)
  const prefix = completedStepPrefix(events, open)

  const retained = new Set()
  const keepCount = Math.min(config.keepRecentTurns, completed.length)
  for (let index = completed.length - keepCount; index < completed.length; index += 1) {
    if (index >= 0) retained.add(completed[index])
  }

  const openTailTokens = open === undefined
    ? 0
    : segmentTokens(open, tokensBySeq) - (prefix === null ? 0 : segmentTokens(prefix, tokensBySeq))
  let tailTokens = openTailTokens
  for (const segment of retained) tailTokens += segmentTokens(segment, tokensBySeq)

  let cursor = completed.length - keepCount - 1
  while (tailTokens < config.keepRecentTokens && cursor >= 0) {
    const segment = completed[cursor]
    retained.add(segment)
    tailTokens += segmentTokens(segment, tokensBySeq)
    cursor -= 1
  }

  const candidates = completed.filter((segment) => !retained.has(segment))
  const selected = []
  let remaining = totalTokens
  for (const segment of candidates) {
    if (remaining <= targetTokens) break
    selected.push(segment)
    remaining -= segmentTokens(segment, tokensBySeq)
  }

  let selectedTokens = 0
  for (const segment of selected) selectedTokens += segmentTokens(segment, tokensBySeq)
  let prefixSelected = false

  if (selectedTokens < config.minCompactionTokens) {
    const prefixTokens = prefix === null ? 0 : segmentTokens(prefix, tokensBySeq)
    if (prefix !== null && prefixTokens >= config.minCompactionTokens) {
      selected.length = 0
      selected.push(prefix)
      selectedTokens = prefixTokens
      prefixSelected = true
    } else {
      return {
        reason: selected.length === 0 ? 'no-eligible-span' : 'below-minimum',
        targetTokens,
        selectedTokens,
        retainedTurns: retained.size,
      }
    }
  }

  const first = selected[0]
  const lastSelected = selected[selected.length - 1]
  const start = first.nodes[0]
  const end = lastSelected.nodes[lastSelected.nodes.length - 1]
  const surface = new Set(surfaceNodes)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !surface.has(start) || !surface.has(end)) {
    return { reason: 'invalid-range', targetTokens }
  }

  return {
    reason: 'ok',
    mode: 'turns',
    range: { start, end },
    selectedTokens,
    targetTokens,
    totalTokens,
    retainedTurns: retained.size,
    selected,
    prefixSelected,
  }
}
