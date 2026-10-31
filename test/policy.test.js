import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildTurnSegments,
  CONFIG_DEFAULTS,
  formatRatio,
  formatTokens,
  planCompaction,
  resolveConfig,
  summarizeCacheUsage,
  summarizeCompactionUsage,
} from '../lib/policy.js'

/**
 * Build a synthetic session log with contiguous sequence numbers.
 * Surface nodes are the system head, each turn's user message, and each step's
 * listed surface message types.
 */
function makeLog(turns) {
  let seq = 0
  const events = []
  const nodes = []
  const push = (type, data = {}) => {
    const event = { seq, type, data }
    events.push(event)
    seq += 1
    return event
  }

  push('system/message')
  nodes.push(0)

  turns.forEach((turn, index) => {
    push('turn/start', { turn: index + 1 })
    push('user/message')
    nodes.push(seq - 1)
    for (const step of turn.steps) {
      push('step/start')
      for (const type of step.nodes) {
        push(type)
        nodes.push(seq - 1)
      }
      if (step.open !== true) push('step/end')
    }
    if (turn.open !== true) push('turn/end', { turn: index + 1 })
  })

  return { events, nodes, seq }
}

/** Uniform token map for every surface node. */
function tokens(nodes, value) {
  return new Map(nodes.map((node) => [node, value]))
}

const baseConfig = resolveConfig({
  ...CONFIG_DEFAULTS,
  keepRecentTurns: 1,
  keepRecentTokens: 0,
  minCompactionTokens: 50,
})

test('resolveConfig applies defaults and freezes the result', () => {
  const config = resolveConfig({})
  assert.equal(config.triggerRatio, 0.5)
  assert.equal(config.targetRatio, 0.35)
  assert.ok(Object.isFrozen(config))
})

test('resolveConfig rejects unknown keys and invalid thresholds', () => {
  assert.throws(() => resolveConfig({ threshold: 0.4 }), /unknown config key/)
  assert.throws(() => resolveConfig({ triggerRatio: 0.2 }), /targetRatio must be less than triggerRatio/)
  assert.throws(() => resolveConfig({ triggerRatio: 1.2 }), /triggerRatio must be a number in \(0, 1\)/)
  assert.throws(() => resolveConfig({ cooldownMs: -1 }), /cooldownMs must be a non-negative integer/)
  assert.throws(() => resolveConfig({ logLevel: 'verbose' }), /logLevel must be one of/)
})

test('resolveConfig validates and normalizes the bili stats origin', () => {
  assert.equal(resolveConfig({}).biliOrigin, 'http://127.0.0.1:18787')
  assert.equal(resolveConfig({ biliOrigin: '' }).biliOrigin, '')
  assert.equal(resolveConfig({ biliOrigin: 'http://localhost:18787/path' }).biliOrigin, 'http://localhost:18787')
  assert.equal(resolveConfig({ biliOrigin: 'http://[::1]:18787' }).biliOrigin, 'http://[::1]:18787')
  assert.throws(() => resolveConfig({ biliOrigin: 'http://example.com:18787' }), /loopback HTTP origin/)
  assert.throws(() => resolveConfig({ biliOrigin: 'ftp://127.0.0.1:18787' }), /loopback HTTP origin/)
  assert.throws(() => resolveConfig({ biliOrigin: 'not a url' }), /valid loopback HTTP origin/)
  assert.throws(() => resolveConfig({ biliOrigin: 42 }), /loopback HTTP origin/)
})

test('resolveConfig accepts and freezes excluded session ids', () => {
  const config = resolveConfig({ excludeSessionIds: ['session-a'] })
  assert.deepEqual([...config.excludeSessionIds], ['session-a'])
  assert.ok(Object.isFrozen(config.excludeSessionIds))
  assert.throws(() => resolveConfig({ excludeSessionIds: [''] }), /array of non-empty session id strings/)
  assert.throws(() => resolveConfig({ excludeSessionIds: 'session-a' }), /array of non-empty session id strings/)
})

test('buildTurnSegments groups surface nodes per turn and excludes the system head', () => {
  const log = makeLog([
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'], open: true }], open: true },
  ])
  const segments = buildTurnSegments(log.events, log.nodes)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].complete, true)
  assert.equal(segments[0].nodes.length, 2) // user + assistant
  assert.equal(segments[1].complete, false)
  assert.ok(segments[0].nodes.every((seq) => seq !== 0))
})

test('planCompaction selects the oldest completed turn and keeps the recent tail', () => {
  const log = makeLog([
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'], open: true }], open: true },
  ])
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 100),
    totalTokens: 700,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'ok')
  assert.equal(plan.prefixSelected, false)
  assert.equal(plan.selected.length, 1)
  assert.equal(plan.range.start, 2)
  assert.equal(plan.range.end, 4)
  assert.equal(plan.selectedTokens, 200)
  assert.equal(plan.retainedTurns, 1)
})

test('planCompaction never includes a system head that lands inside a turn', () => {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'system/message', data: {} },
    { seq: 2, type: 'user/message', data: {} },
    { seq: 3, type: 'step/start', data: {} },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }] } } },
    { seq: 5, type: 'step/end', data: {} },
    { seq: 6, type: 'step/start', data: {} },
    { seq: 7, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'b' }] } } },
  ]
  const surfaceNodes = [1, 2, 4, 7]
  const plan = planCompaction({
    events,
    surfaceNodes,
    tokensBySeq: new Map(surfaceNodes.map((seq) => [seq, 100])),
    totalTokens: 700,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'ok')
  assert.equal(plan.range.start, 2)
  assert.equal(plan.range.end, 4)
})

test('planCompaction compacts a completed-step prefix of a single long turn', () => {
  const log = makeLog([
    {
      open: true,
      steps: [
        { nodes: ['assistant/message'] },
        { nodes: ['assistant/message'] },
        { nodes: ['assistant/message'], open: true },
      ],
    },
  ])
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 100),
    totalTokens: 700,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'ok')
  assert.equal(plan.prefixSelected, true)
  assert.equal(plan.range.start, 2)
  assert.equal(plan.range.end, 7)
  assert.equal(plan.selectedTokens, 300)
})

test('planCompaction refuses a single open step with no completed boundary', () => {
  const log = makeLog([
    { open: true, steps: [{ nodes: ['assistant/message'], open: true }] },
  ])
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 100),
    totalTokens: 700,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'no-eligible-span')
})

test('planCompaction skips spans below minCompactionTokens', () => {
  const log = makeLog([
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'], open: true }], open: true },
  ])
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 5),
    totalTokens: 500,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'below-minimum')
})

test('planCompaction extends the retained tail to satisfy keepRecentTokens', () => {
  const log = makeLog([
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'], open: true }], open: true },
  ])
  const config = resolveConfig({
    ...CONFIG_DEFAULTS,
    triggerRatio: 0.95,
    targetRatio: 0.25,
    keepRecentTurns: 0,
    keepRecentTokens: 450,
    minCompactionTokens: 50,
  })
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 100),
    totalTokens: 400,
    contextWindow: 1000,
    config,
  })

  assert.equal(plan.reason, 'ok')
  assert.equal(plan.retainedTurns, 2)
  assert.equal(plan.selected.length, 1) // only the oldest turn remains eligible
  assert.equal(plan.range.start, 2)
})

test('planCompaction falls back to surface order after replacement nodes', () => {
  const events = [
    { seq: 0, type: 'system/message', data: {} },
    { seq: 2, type: 'user/message', data: {} },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old' }] } } },
    { seq: 19, type: 'turn/start', data: { turn: 2 } },
    { seq: 20, type: 'user/message', data: {} },
    { seq: 21, type: 'step/start', data: {} },
    { seq: 22, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    { seq: 23, type: 'step/end', data: {} },
    { seq: 24, type: 'turn/end', data: { turn: 2 } },
    { seq: 29, type: 'turn/start', data: { turn: 3 } },
    { seq: 30, type: 'user/message', data: {} },
    { seq: 31, type: 'step/start', data: {} },
    { seq: 32, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'current' }] } } },
    { seq: 100, type: 'user/message', data: {}, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 } },
  ]
  const surfaceNodes = [0, 100, 20, 22, 30, 32]
  const plan = planCompaction({
    events,
    surfaceNodes,
    tokensBySeq: new Map(surfaceNodes.map((seq) => [seq, 100])),
    totalTokens: 600,
    contextWindow: 1000,
    config: resolveConfig({
      ...CONFIG_DEFAULTS,
      targetRatio: 0.25,
      keepRecentTurns: 2,
      keepRecentTokens: 100,
      minCompactionTokens: 50,
    }),
  })

  assert.equal(plan.reason, 'ok')
  assert.equal(plan.mode, 'prefix')
  assert.equal(plan.range.start, 100) // surface position 1, numeric seq is higher
  assert.equal(plan.range.end, 22) // surface position 3
  assert.equal(plan.selectedTokens, 300)
})

test('planCompaction skips when the whole surface is the current turn suffix', () => {
  const events = [
    { seq: 0, type: 'system/message', data: {} },
    { seq: 10, type: 'turn/start', data: { turn: 1 } },
    { seq: 11, type: 'user/message', data: {} },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } },
    { seq: 20, type: 'user/message', data: {}, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 } },
  ]
  const surfaceNodes = [0, 20, 11, 12]
  const plan = planCompaction({
    events,
    surfaceNodes,
    tokensBySeq: new Map(surfaceNodes.map((seq) => [seq, 100])),
    totalTokens: 400,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'no-safe-boundary')
})

test('planCompaction returns below-target when pressure is already low', () => {
  const log = makeLog([
    { steps: [{ nodes: ['assistant/message'] }] },
    { steps: [{ nodes: ['assistant/message'], open: true }], open: true },
  ])
  const plan = planCompaction({
    events: log.events,
    surfaceNodes: log.nodes,
    tokensBySeq: tokens(log.nodes, 10),
    totalTokens: 20,
    contextWindow: 1000,
    config: baseConfig,
  })

  assert.equal(plan.reason, 'below-target')
})

test('format helpers stay compact and stable', () => {
  assert.equal(formatTokens(1048576), '1,048,576')
  assert.equal(formatRatio(0.5), '50%')
  assert.equal(formatRatio(0.1234), '12.3%')
})

test('summarizeCacheUsage aggregates hit/miss tokens and keeps the last request', () => {
  const cache = summarizeCacheUsage([
    {
      type: 'assistant/message',
      time: 1000,
      data: { usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 } },
    },
    {
      type: 'assistant/message',
      time: 2000,
      data: { usage: { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 7 } },
    },
    { type: 'compaction/summary', data: { usage: { inputTokens: 999, cacheReadTokens: 0 } } },
    { type: 'assistant/message', data: {} },
  ])

  assert.equal(cache.requests, 2)
  assert.equal(cache.promptTokens, 210)
  assert.equal(cache.uncachedInputTokens, 30)
  assert.equal(cache.cacheReadTokens, 170)
  assert.equal(cache.cacheWriteTokens, 10)
  assert.equal(cache.outputTokens, 12)
  assert.ok(Math.abs(cache.hitRate - 170 / 210) < 1e-12)
  assert.ok(Math.abs(cache.missRate - 40 / 210) < 1e-12)
  assert.equal(cache.last.promptTokens, 110)
  assert.equal(cache.last.cacheReadTokens, 80)
  assert.equal(cache.last.at, 2000)
})

test('summarizeCacheUsage reports no rates without usage', () => {
  const cache = summarizeCacheUsage([{ type: 'assistant/message', data: { usage: {} } }])
  assert.equal(cache.requests, 0)
  assert.equal(cache.hitRate, null)
  assert.equal(cache.missRate, null)
  assert.equal(cache.last, null)
})

test('summarizeCompactionUsage aggregates summary requests only', () => {
  const usage = summarizeCompactionUsage([
    {
      type: 'compaction/summary',
      data: { usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 50 } },
    },
    {
      type: 'compaction/summary',
      data: { usage: { inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5, outputTokens: 10 } },
    },
    {
      type: 'assistant/message',
      data: { usage: { inputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 999 } },
    },
    { type: 'compaction/summary', data: { usage: {} } },
  ])

  assert.equal(usage.calls, 2)
  assert.equal(usage.inputTokens, 120)
  assert.equal(usage.cacheReadTokens, 980)
  assert.equal(usage.cacheWriteTokens, 5)
  assert.equal(usage.outputTokens, 60)
  assert.equal(usage.promptTokens, 1105)
})

test('summarizeCompactionUsage is empty without summary events', () => {
  const usage = summarizeCompactionUsage([{ type: 'assistant/message', data: {} }])
  assert.deepEqual(usage, {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    promptTokens: 0,
  })
})
