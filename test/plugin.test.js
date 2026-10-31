import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { CONFIG_DEFAULTS, resolveConfig } from '../lib/policy.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Synthetic three-turn session: two completed turns and one open turn. */
function makeLog() {
  let seq = 0
  const events = []
  const nodes = []
  const push = (type, data = {}) => {
    events.push({ seq, type, data })
    seq += 1
    return seq - 1
  }

  nodes.push(push('system/message'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const open = turn === 3
    events.push({ seq, type: 'turn/start', data: { turn } })
    seq += 1
    nodes.push(push('user/message'))
    push('step/start')
    nodes.push(push('assistant/message', {
      usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 },
    }))
    if (!open) push('step/end')
    if (!open) {
      events.push({ seq, type: 'turn/end', data: { turn } })
      seq += 1
    }
  }
  return { events, nodes }
}

const TEST_CONFIG = resolveConfig({
  ...CONFIG_DEFAULTS,
  triggerRatio: 0.5,
  targetRatio: 0.35,
  keepRecentTurns: 1,
  keepRecentTokens: 0,
  minCompactionTokens: 50,
  minGrowthTokens: 0,
  cooldownMs: 0,
  pruneToolResults: false,
  fallbackContextWindow: 0,
  statusFile: false,
  configFile: false,
  logLevel: 'silent',
  biliOrigin: '',
})

function setup({
  totalTokens = 700,
  window = 1000,
  fail = false,
  excludeSessionIds,
  configFile = false,
  triggerRatio,
  withWebServer = false,
} = {}) {
  const log = makeLog()
  const calls = []
  const runtime = { tokens: totalTokens }
  const meter = {
    measure() {
      return {
        totalTokens: runtime.tokens,
        nodes: log.nodes.map((seq) => ({ seq, tokens: 100, heuristicTokens: 100 })),
      }
    },
  }
  const compaction = {
    async compactRegion(start, end) {
      calls.push({ start, end })
      if (fail) throw new Error('summary backend exploded')
      runtime.tokens = 250
      return { shadowedSeqs: [start, end], shadowedTokenCount: 450 }
    },
  }
  const routes = []
  const upgrades = []
  const webServer = withWebServer
    ? {
        register(definition) {
          routes.push(definition)
          return () => {}
        },
        registerUpgrade(definition) {
          upgrades.push(definition)
          return () => {}
        },
        getOrigin() {
          return 'http://127.0.0.1:51890'
        },
      }
    : undefined
  const services = { tokenMeter: meter, compaction, ...(webServer === undefined ? {} : { webServer }) }
  const handlers = new Map()
  const agent = {
    id: 'session-test',
    options: {},
    session: {
      seq: log.events.length,
      surface: { nodes: log.nodes },
      eventAt(seq) {
        return log.events[seq]
      },
      requestContext() {
        return { provider: 'test', model: 'test', contextWindow: window }
      },
      requestHeader() {
        return { config: { provider: 'test', model: 'test' } }
      },
    },
    ctx: {
      get(name) {
        return services[name]
      },
      on(name, listener) {
        handlers.set(name, listener)
        return () => handlers.delete(name)
      },
    },
  }

  const pluginHandlers = new Map()
  const commandDefinitions = []
  const cleanups = []
  const pluginCtx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    commands: {
      register(definition) {
        commandDefinitions.push(definition)
        return () => {}
      },
    },
    agents: {
      list() {
        return [agent]
      },
    },
    agentPresets: {
      serviceFor(_agent, name) {
        return services[name]
      },
    },
    on(name, listener) {
      pluginHandlers.set(name, listener)
      return () => pluginHandlers.delete(name)
    },
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
    get(name) {
      return services[name]
    },
  }

  apply(pluginCtx, {
    ...TEST_CONFIG,
    ...(excludeSessionIds === undefined ? {} : { excludeSessionIds }),
    ...(configFile ? { configFile: true } : {}),
    ...(triggerRatio === undefined ? {} : { triggerRatio }),
  })
  const preStep = handlers.get('agent/pre-step')
  const command = commandDefinitions[0]
  return { agent, preStep, command, calls, runtime, pluginHandlers, cleanups, routes, upgrades }
}

const next = async () => ({ kind: 'enter', messages: [] })
const signal = () => new AbortController().signal

test('pre-step compacts above the trigger and always calls next()', async () => {
  const { agent, preStep, calls, runtime } = setup()
  const decision = await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)

  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].start, 2)
  assert.equal(calls[0].end, 4)
  assert.equal(runtime.tokens, 250)
})

test('pre-step does nothing below the trigger', async () => {
  const { agent, preStep, calls } = setup({ totalTokens: 300 })
  const decision = await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)

  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(calls.length, 0)
})

test('a failing compaction is contained and the step proceeds', async () => {
  const { agent, preStep, calls } = setup({ fail: true })
  const decision = await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)

  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(calls.length, 1)
})

test('an excluded session is never compacted and reports why', async () => {
  const { agent, preStep, command, calls } = setup({ excludeSessionIds: ['session-test'] })
  await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)
  assert.equal(calls.length, 0)

  let result = await command.handler({ agent, rawInput: 'status', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /excluded by config/)
  assert.match(result.text, /Last check: excluded/)

  result = await command.handler({ agent, rawInput: 'on', commandId: 'cmd-2', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /excluded by config/)
})

test('/autocompact status reports pressure and compaction totals', async () => {
  const { agent, preStep, command } = setup()
  await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)

  const result = await command.handler({
    agent,
    rawInput: 'status',
    commandId: 'cmd-1',
    signal: signal(),
    attachments: [],
  })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Auto context compression — ON/)
  assert.match(result.text, /Context: 250 \/ 1,000 tokens \(25%\)/)
  assert.match(result.text, /Cache: 90% hit \/ 10% miss \(3 req; last 90%\)/)
  assert.match(result.text, /Compactions: 1/)
})

test('/autocompact cache shows the prompt-cache breakdown', async () => {
  const { agent, preStep, command } = setup()
  await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)

  const result = await command.handler({
    agent,
    rawInput: 'cache',
    commandId: 'cmd-1',
    signal: signal(),
    attachments: [],
  })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /Prompt cache \(main conversation requests\)/)
  assert.match(result.text, /Requests: 3/)
  assert.match(result.text, /Prompt tokens: 300/)
  assert.match(result.text, /Hit: 270 \(90%\)/)
  assert.match(result.text, /Miss: 30 \(10%\)/)
  assert.match(result.text, /uncached input: 30/)
  assert.match(result.text, /cache write: 0/)
  assert.match(result.text, /Last request: 90% hit/)
})

test('/autocompact on and off toggle the session policy', async () => {
  const { agent, preStep, command, calls } = setup()

  let result = await command.handler({ agent, rawInput: 'off', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)
  assert.equal(calls.length, 0)

  result = await command.handler({ agent, rawInput: 'on', commandId: 'cmd-2', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  await preStep({ agent, signal: signal(), turn: 1, step: 2, messages: [] }, next)
  assert.equal(calls.length, 1)
})

test('/autocompact threshold changes when compression begins', async () => {
  const { agent, preStep, command, calls } = setup({ totalTokens: 540 })

  let result = await command.handler({ agent, rawInput: 'threshold 0.6', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)
  assert.equal(calls.length, 0, '54% pressure is below the 60% session threshold')

  result = await command.handler({ agent, rawInput: 'threshold 40', commandId: 'cmd-2', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  await preStep({ agent, signal: signal(), turn: 1, step: 2, messages: [] }, next)
  assert.equal(calls.length, 1, '54% pressure is above the 40% session threshold')
})

test('/autocompact rejects invalid thresholds and unknown verbs', async () => {
  const { agent, command } = setup()

  let result = await command.handler({ agent, rawInput: 'threshold 0.1', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /greater than the session target/)

  result = await command.handler({ agent, rawInput: 'threshold nope', commandId: 'cmd-2', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')

  result = await command.handler({ agent, rawInput: 'bogus', commandId: 'cmd-3', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage/)
})

test('/autocompact target stays below the session trigger', async () => {
  const { agent, command } = setup()

  let result = await command.handler({ agent, rawInput: 'target 0.6', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /less than the session trigger/)

  result = await command.handler({ agent, rawInput: 'target 0.2', commandId: 'cmd-2', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')

  result = await command.handler({ agent, rawInput: 'threshold 0.15', commandId: 'cmd-3', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /greater than the session target \(20%\)/)

  result = await command.handler({ agent, rawInput: 'status', commandId: 'cmd-4', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /target: 20%/)
})

test('/autocompact config returns the effective configuration', async () => {
  const { agent, command } = setup()
  const result = await command.handler({ agent, rawInput: 'config', commandId: 'cmd-1', signal: signal(), attachments: [] })
  assert.equal(result.kind, 'success')
  const parsed = JSON.parse(result.text)
  assert.equal(parsed.triggerRatio, 0.5)
  assert.equal(parsed.statusFile, false)
  assert.equal(parsed.configFilePath, null)
})

test('config.json changes the trigger on the next step without a plugin reload', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-compact-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { agent, preStep, command, calls, runtime } = setup({ totalTokens: 600, configFile: true })
    assert.equal(calls.length, 0)

    // 60% pressure exceeds the initial 50% trigger.
    await preStep({ agent, signal: signal(), turn: 1, step: 1, messages: [] }, next)
    assert.equal(calls.length, 1)

    const configPath = path.join(home, 'auto-context-compression', 'config.json')
    assert.ok(existsSync(configPath), 'the plugin should create a user config file')
    const file = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(file.triggerRatio, 0.5)

    // Raise the trigger to 90%: the same 60% pressure must no longer compact.
    file.triggerRatio = 0.9
    writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    runtime.tokens = 600
    await sleep(1100)
    await preStep({ agent, signal: signal(), turn: 1, step: 2, messages: [] }, next)
    assert.equal(calls.length, 1)

    // Lower it to 40%: the file change is picked up on the next step.
    file.triggerRatio = 0.4
    writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    runtime.tokens = 600
    await sleep(1100)
    await preStep({ agent, signal: signal(), turn: 1, step: 3, messages: [] }, next)
    assert.equal(calls.length, 2)

    // A malformed file is ignored and surfaced in status, not thrown.
    writeFileSync(configPath, '{"triggerRatio": "bad"}\n', 'utf8')
    await sleep(1100)
    const status = await command.handler({ agent, rawInput: 'status', commandId: 'cmd-1', signal: signal(), attachments: [] })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /Config file error:/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

async function invokeRoute(route, request) {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(value) {
      this.body = value
    },
  }
  await route.handler(request, response)
  return response
}

test('the status HTTP route exposes live stats without compacting', async () => {
  const { routes, calls } = setup({ withWebServer: true })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/auto-context-compression/api')

  const response = await invokeRoute(routes[0], {
    method: 'GET',
    url: '/auto-context-compression/api/status?sessionId=session-test',
  })

  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /application\/json/)
  assert.equal(response.headers['cache-control'], 'no-store')
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.session.sessionId, 'session-test')
  assert.equal(payload.value.session.tokens, 700)
  assert.equal(payload.value.session.cache.requests, 3)
  assert.equal(payload.value.session.compactionUsage.calls, 0)
  assert.match(payload.value.statusFile, /status\.json$/)
  assert.equal(calls.length, 0, 'a GET must never trigger compaction')
})

test('the status route rejects unsupported methods and paths', async () => {
  const { routes } = setup({ withWebServer: true })
  let response = await invokeRoute(routes[0], {
    method: 'POST',
    url: '/auto-context-compression/api/status',
  })
  assert.equal(response.statusCode, 405)

  response = await invokeRoute(routes[0], {
    method: 'GET',
    url: '/auto-context-compression/api/unknown',
  })
  assert.equal(response.statusCode, 404)
})

test('the WebSocket capability route and upgrade registration are mounted', async () => {
  const { routes, upgrades } = setup({ withWebServer: true })
  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].path, '/auto-context-compression/ws')
  assert.equal(typeof upgrades[0].handler, 'function')

  let response = await invokeRoute(routes[0], {
    method: 'GET',
    url: '/auto-context-compression/api/ws-token',
  })
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.path, '/auto-context-compression/ws')
  assert.equal(payload.value.protocol, 'dsh-auto-context-v1')
  assert.match(payload.value.token, /^[A-Za-z0-9_-]{43}$/)

  response = await invokeRoute(routes[0], {
    method: 'GET',
    url: '/auto-context-compression/api/ws-token',
    headers: { 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(response.statusCode, 403)
})

test('the status route advertises realtime metadata but never the token', async () => {
  const { routes } = setup({ withWebServer: true })
  const response = await invokeRoute(routes[0], {
    method: 'GET',
    url: '/auto-context-compression/api/status?sessionId=session-test',
  })
  assert.equal(response.statusCode, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.value.websocket.path, '/auto-context-compression/ws')
  assert.equal(payload.value.websocket.protocol, 'dsh-auto-context-v1')
  assert.equal(typeof payload.value.websocket.clients, 'number')
  assert.equal(JSON.stringify(payload.value.websocket).includes('token'), false)
})

test('the client bundle is a native conversation view without an iframe', () => {
  const root = path.resolve(import.meta.dirname, '..')
  const client = readFileSync(path.join(root, 'client.js'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /conversation\.view/)
  assert.match(client, /id: 'auto-context'/)
  assert.match(client, /\/auto-context-compression\/api\/ws-token/)
  assert.match(client, /new WebSocket/)
  assert.match(client, /downloadReportFile/)
  assert.match(client, /renderReportImage/)
  assert.doesNotMatch(client, /<iframe/i)
  assert.doesNotMatch(client, /setInterval\(\(\) => void load/)

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.files.includes('client.js'))
  assert.ok(pkg.files.includes('lib/ws.js'))
})
