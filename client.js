window.__ModuleLoader__.load({
  id: 'dsh-auto-context-compression',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'auto-context-compression'
    const PLUGIN_VERSION = '0.1.0'
    const WS_RECONNECT_MAX_MS = 10000
    const PRICE = { input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6 }

    const zh = {
      tab: '压缩',
      title: '自动上下文压缩',
      subtitle: '实时查看上下文压力、缓存命中与压缩收益',
      refresh: '刷新',
      loading: '正在读取压缩统计…',
      retry: '重试',
      running: '运行中',
      disabled: '已关闭',
      excluded: '已排除',
      inactive: '未启用',
      basic: '基本信息',
      usage: '用量统计',
      titleLabel: '标题',
      sessionLabel: '会话',
      protocol: '协议',
      client: '客户端',
      engine: '引擎',
      upstream: '上游',
      version: '插件版本',
      storage: '存储模式',
      context: '上下文',
      threshold: '压缩阈值',
      stateFile: '状态文件',
      untitled: '未命名会话',
      copy: '复制',
      copied: '已复制',
      requests: '请求',
      inputTokens: '输入 token',
      cacheHitTokens: '缓存命中 token',
      cacheHitRate: '缓存命中率',
      outputTokens: '输出 token',
      saved: '压缩节省',
      payback: '压缩回本',
      cost: '花费（估算）',
      lastInput: '最近单次输入',
      requestsSub: '本会话累计请求',
      inputSub: '未命中 {x} · 缓存写 {y}',
      cacheSub: '缓存读 $0.003/Mtok',
      hitSub: '未命中 {x}',
      outputSub: '模型输出累计',
      savedSub: '按输入价 ≈ {x}',
      paybackSub: '节省 {x} − 摘要 {y}',
      paybackEmpty: '暂无压缩记录',
      costSub: '输入 {x} · 缓存 {y} · 输出 {z}',
      lastSub: '最近一次请求上下文',
      note: '金额按 DeepSeek 参考单价估算（输入 $0.15 / 缓存读 $0.003 / 输出 $0.60 每百万 token），仅用于判断压缩是否划算，不是账单。压缩回本未计全量重放成本。',
      noData: '还没有可显示的会话数据',
      routeHint: 'Host 状态接口尚未就绪。请确认插件已启用，然后刷新页面或稍后重试。',
      stale: '暂时无法刷新，显示的是上一次数据：{x}',
      configError: '配置文件错误：{x}',
      protocolValue: 'dsh-native',
      clientValue: 'DSH Web',
      engineValue: 'compaction-basic + 主动策略',
      storageValue: 'full（统一读写/改写）',
      updated: '更新于 {x}',
      errorPrefix: '状态接口错误：{x}',
    }

    const en = {
      tab: 'Compression',
      title: 'Automatic context compression',
      subtitle: 'Live context pressure, cache hits, and compaction savings',
      refresh: 'Refresh',
      loading: 'Reading compression statistics…',
      retry: 'Retry',
      running: 'Active',
      disabled: 'Disabled',
      excluded: 'Excluded',
      inactive: 'Inactive',
      basic: 'Overview',
      usage: 'Usage',
      titleLabel: 'Title',
      sessionLabel: 'Session',
      protocol: 'Protocol',
      client: 'Client',
      engine: 'Engine',
      upstream: 'Upstream',
      version: 'Plugin version',
      storage: 'Storage mode',
      context: 'Context',
      threshold: 'Compaction threshold',
      stateFile: 'State file',
      untitled: 'Untitled session',
      copy: 'Copy',
      copied: 'Copied',
      requests: 'Requests',
      inputTokens: 'Input tokens',
      cacheHitTokens: 'Cache-hit tokens',
      cacheHitRate: 'Cache hit rate',
      outputTokens: 'Output tokens',
      saved: 'Compaction savings',
      payback: 'Compaction payback',
      cost: 'Cost (estimated)',
      lastInput: 'Last request input',
      requestsSub: 'Requests in this session',
      inputSub: 'Missed {x} · cache write {y}',
      cacheSub: 'Cache read $0.003/Mtok',
      hitSub: 'Miss rate {x}',
      outputSub: 'Model output total',
      savedSub: 'At input price ≈ {x}',
      paybackSub: 'Saved {x} − summary {y}',
      paybackEmpty: 'No compaction yet',
      costSub: 'Input {x} · cache {y} · output {z}',
      lastSub: 'Last request context',
      note: 'Amounts are estimated at DeepSeek reference prices (input $0.15 / cache read $0.003 / output $0.60 per million tokens). They are for judging compaction economics, not a bill. Payback excludes full replay cost.',
      noData: 'No session data to display yet',
      routeHint: 'The Host status endpoint is not ready. Confirm the plugin is enabled, then refresh the page or try again.',
      stale: 'Refresh failed; showing the previous data: {x}',
      configError: 'Config file error: {x}',
      protocolValue: 'dsh-native',
      clientValue: 'DSH Web',
      engineValue: 'compaction-basic + proactive policy',
      storageValue: 'full (unified read/write/rewrite)',
      updated: 'Updated {x}',
      errorPrefix: 'Status endpoint error: {x}',
    }

    const CSS = `
      .dsh-acc-root {
        --acc-bg: var(--dsw-alias-bg-base, #0b0e14);
        --acc-layer: var(--dsw-alias-bg-layer-1, #12151c);
        --acc-card: var(--dsw-alias-bg-layer-2, #171b23);
        --acc-border: var(--dsw-alias-border-l1, rgba(255,255,255,.10));
        --acc-border-strong: var(--dsw-alias-border-l2, rgba(255,255,255,.16));
        --acc-text: var(--dsw-alias-label-primary, #e6edf3);
        --acc-muted: var(--dsw-alias-label-secondary, #8b949e);
        --acc-brand: var(--dsw-alias-brand-primary, #4f8cff);
        --acc-green: var(--dsw-alias-state-success-primary, #3fb950);
        --acc-red: var(--dsw-alias-state-error-primary, #f85149);
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        min-height: 0;
        overflow: auto;
        background: var(--acc-bg);
        color: var(--acc-text);
      }
      .dsh-acc-root *, .dsh-acc-root *::before, .dsh-acc-root *::after { box-sizing: border-box; }
      .dsh-acc-inner {
        width: 100%;
        max-width: 1220px;
        margin: 0 auto;
        padding: 28px 28px 48px;
        display: flex;
        flex-direction: column;
        gap: 22px;
      }
      .dsh-acc-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        flex-wrap: wrap;
        padding-bottom: 2px;
      }
      .dsh-acc-heading { min-width: 0; }
      .dsh-acc-title {
        margin: 0;
        font-size: 22px;
        line-height: 1.25;
        font-weight: 650;
        letter-spacing: -0.02em;
      }
      .dsh-acc-subtitle {
        margin: 7px 0 0;
        color: var(--acc-muted);
        font-size: 13px;
        line-height: 1.5;
      }
      .dsh-acc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .dsh-acc-pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-height: 28px;
        padding: 4px 10px;
        border: 1px solid var(--acc-border);
        border-radius: 999px;
        color: var(--acc-muted);
        background: color-mix(in srgb, var(--acc-layer) 82%, transparent);
        font-size: 12px;
        line-height: 1;
        white-space: nowrap;
      }
      .dsh-acc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--acc-muted); flex: none; }
      .dsh-acc-dot.is-green { background: var(--acc-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc-green) 16%, transparent); }
      .dsh-acc-dot.is-red { background: var(--acc-red); box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc-red) 16%, transparent); }
      .dsh-acc-dot.is-muted { background: var(--acc-muted); }
      .dsh-acc-button {
        min-height: 28px;
        padding: 4px 11px;
        border: 1px solid var(--acc-border-strong);
        border-radius: 7px;
        background: transparent;
        color: var(--acc-text);
        font: inherit;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        transition: background .15s ease, border-color .15s ease;
      }
      .dsh-acc-button:hover { background: var(--acc-card); border-color: var(--acc-muted); }
      .dsh-acc-button:active { transform: translateY(1px); }
      .dsh-acc-button:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
      .dsh-acc-section {
        border: 1px solid var(--acc-border);
        border-radius: 14px;
        background: var(--acc-layer);
        overflow: hidden;
      }
      .dsh-acc-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 20px;
        border-bottom: 1px solid var(--acc-border);
        color: var(--acc-text);
        font-size: 13px;
        font-weight: 600;
        letter-spacing: .01em;
      }
      .dsh-acc-section-note { color: var(--acc-muted); font-size: 11px; font-weight: 400; }
      .dsh-acc-info { padding: 3px 20px; }
      .dsh-acc-row {
        display: grid;
        grid-template-columns: 150px minmax(0, 1fr);
        align-items: baseline;
        gap: 18px;
        padding: 10px 0;
        border-bottom: 1px solid color-mix(in srgb, var(--acc-border) 68%, transparent);
        min-width: 0;
      }
      .dsh-acc-row:last-child { border-bottom: 0; }
      .dsh-acc-label { color: var(--acc-muted); font-size: 12px; line-height: 1.5; }
      .dsh-acc-value {
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
        color: var(--acc-text);
        font-size: 13px;
        line-height: 1.55;
        overflow-wrap: anywhere;
      }
      .dsh-acc-value.is-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
      .dsh-acc-value.is-muted { color: var(--acc-muted); }
      .dsh-acc-copy {
        border: 0;
        padding: 1px 5px;
        border-radius: 5px;
        background: transparent;
        color: var(--acc-brand);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
        line-height: 1.4;
      }
      .dsh-acc-copy:hover { background: color-mix(in srgb, var(--acc-brand) 12%, transparent); }
      .dsh-acc-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        padding: 16px 20px 20px;
      }
      .dsh-acc-card {
        min-width: 0;
        min-height: 116px;
        padding: 14px 15px 13px;
        border: 1px solid var(--acc-border);
        border-radius: 12px;
        background: var(--acc-card);
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .dsh-acc-card-label {
        color: var(--acc-muted);
        font-size: 12px;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dsh-acc-card-value {
        color: var(--acc-text);
        font-size: 25px;
        line-height: 1.15;
        font-weight: 650;
        letter-spacing: -0.025em;
        font-variant-numeric: tabular-nums;
        overflow-wrap: anywhere;
      }
      .dsh-acc-card-value.is-green { color: var(--acc-green); }
      .dsh-acc-card-value.is-red { color: var(--acc-red); }
      .dsh-acc-card-sub {
        margin-top: auto;
        color: var(--acc-muted);
        font-size: 11px;
        line-height: 1.45;
        overflow-wrap: anywhere;
        white-space: pre-line;
      }
      .dsh-acc-banner {
        padding: 10px 13px;
        border: 1px solid color-mix(in srgb, var(--acc-red) 44%, var(--acc-border));
        border-radius: 9px;
        background: color-mix(in srgb, var(--acc-red) 8%, transparent);
        color: var(--acc-red);
        font-size: 12px;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }
      .dsh-acc-banner.is-warn {
        border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d29922) 44%, var(--acc-border));
        background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d29922) 8%, transparent);
        color: var(--dsw-alias-state-warn-primary, #d29922);
      }
      .dsh-acc-empty {
        min-height: 220px;
        border: 1px dashed var(--acc-border-strong);
        border-radius: 14px;
        padding: 28px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 9px;
        text-align: center;
        color: var(--acc-muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .dsh-acc-empty-title { color: var(--acc-text); font-size: 15px; font-weight: 600; }
      .dsh-acc-note {
        color: var(--acc-muted);
        font-size: 11px;
        line-height: 1.65;
        padding: 0 2px;
      }
      @media (max-width: 1080px) {
        .dsh-acc-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
      @media (max-width: 800px) {
        .dsh-acc-inner { padding: 20px 16px 36px; }
        .dsh-acc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 14px 14px 16px; }
        .dsh-acc-info { padding-left: 14px; padding-right: 14px; }
        .dsh-acc-section-head { padding-left: 14px; padding-right: 14px; }
        .dsh-acc-row { grid-template-columns: 110px minmax(0, 1fr); gap: 12px; }
        .dsh-acc-card-value { font-size: 22px; }
      }
      @media (max-width: 520px) {
        .dsh-acc-head { gap: 12px; }
        .dsh-acc-grid { grid-template-columns: 1fr; }
        .dsh-acc-row { grid-template-columns: 1fr; gap: 3px; }
        .dsh-acc-row .dsh-acc-label { font-size: 11px; }
      }
    `

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? ''))
    }

    function compact(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      const absolute = Math.abs(number)
      if (absolute >= 1e9) return `${(number / 1e9).toFixed(1)}B`
      if (absolute >= 1e6) return `${(number / 1e6).toFixed(1)}M`
      if (absolute >= 1e3) return `${Math.round(number / 1e3)}K`
      return String(Math.round(number))
    }

    function percent(value, digits = 1) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return `${(number * 100).toFixed(digits)}%`
    }

    function count(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return Math.round(number).toLocaleString('en-US')
    }

    function money(value) {
      if (value === null || value === undefined) return '—'
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      return `$${number.toFixed(number >= 1 ? 2 : 4)}`
    }

    function clock(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString('zh-CN', { hour12: false })
    }

    function CopyButton({ text }) {
      const [copied, setCopied] = React.useState(false)
      React.useEffect(() => {
        if (!copied) return undefined
        const timer = setTimeout(() => setCopied(false), 1500)
        return () => clearTimeout(timer)
      }, [copied])
      const onCopy = async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            area.remove()
          } catch {
            /* clipboard may be unavailable in a non-secure embed */
          }
        }
        setCopied(true)
      }
      return h('button', { type: 'button', className: 'dsh-acc-copy', onClick: onCopy, title: text },
        copied ? '已复制' : '复制')
    }

    function InfoRow({ label, value, mono = false, muted = false, copy = null }) {
      return h('div', { className: 'dsh-acc-row' },
        h('div', { className: 'dsh-acc-label' }, label),
        h('div', { className: `dsh-acc-value${mono ? ' is-mono' : ''}${muted ? ' is-muted' : ''}` },
          h('span', null, value),
          copy === null ? null : h(CopyButton, { text: copy })))
    }

    function Card({ label, value, sub, tone = '' }) {
      return h('div', { className: 'dsh-acc-card' },
        h('div', { className: 'dsh-acc-card-label' }, label),
        h('div', { className: `dsh-acc-card-value${tone ? ` is-${tone}` : ''}` }, value),
        h('div', { className: 'dsh-acc-card-sub' }, sub))
    }

    function useLiveStatus(sessionId, epoch) {
      const [state, setState] = React.useState({
        data: null,
        error: null,
        connected: false,
        phase: 'connecting',
        loadedAt: null,
      })
      React.useEffect(() => {
        let cancelled = false
        let socket = null
        let retry = null
        let attempt = 0
        const schedule = (message) => {
          if (cancelled) return
          setState((previous) => ({
            ...previous,
            connected: false,
            phase: 'reconnecting',
            error: message,
          }))
          const delay = Math.min(WS_RECONNECT_MAX_MS, 500 * (2 ** Math.min(attempt, 4)))
          attempt += 1
          retry = setTimeout(() => void connect(), delay)
        }
        const connect = async () => {
          if (cancelled) return
          setState((previous) => ({ ...previous, phase: previous.data ? 'reconnecting' : 'connecting' }))
          try {
            const response = await fetch('/auto-context-compression/api/ws-token', {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || body === null || body.ok !== true) {
              throw new Error(body?.error ?? `token HTTP ${response.status}`)
            }
            const value = body.value
            if (value === null || typeof value !== 'object' || typeof value.path !== 'string'
              || typeof value.protocol !== 'string' || typeof value.token !== 'string') {
              throw new Error('invalid websocket handshake payload')
            }
            const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
            socket = new WebSocket(`${scheme}//${window.location.host}${value.path}`, [value.protocol, value.token])
            socket.onopen = () => {
              if (cancelled) {
                socket.close()
                return
              }
              attempt = 0
              setState((previous) => ({ ...previous, connected: true, phase: 'open', error: null }))
              socket.send(JSON.stringify(sessionId.length > 0 ? { type: 'hello', sessionId } : { type: 'hello' }))
            }
            socket.onmessage = (event) => {
              if (cancelled) return
              let message
              try {
                message = JSON.parse(event.data)
              } catch {
                return
              }
              if (message?.type === 'snapshot') {
                setState((previous) => ({
                  ...previous,
                  data: message.data ?? null,
                  error: null,
                  phase: 'open',
                  loadedAt: Date.now(),
                }))
              } else if (message?.type === 'error') {
                setState((previous) => ({ ...previous, error: message.error ?? '服务器返回错误' }))
              }
            }
            socket.onerror = () => {
              if (!cancelled) setState((previous) => ({ ...previous, connected: false, error: 'WebSocket 连接错误' }))
            }
            socket.onclose = () => {
              if (cancelled) return
              socket = null
              schedule('连接已断开，正在重连…')
            }
          } catch (reason) {
            if (!cancelled) schedule(reason instanceof Error ? reason.message : String(reason))
          }
        }
        void connect()
        return () => {
          cancelled = true
          if (retry !== null) clearTimeout(retry)
          if (socket !== null) {
            socket.onclose = null
            try {
              socket.close()
            } catch {
              /* already closed */
            }
          }
        }
      }, [sessionId, epoch])
      return state
    }

    function downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function stamp() {
      return new Date().toISOString().replace(/[:.]/g, '-')
    }

    function reportValues(data) {
      const session = data?.session ?? {}
      const bili = data?.bili ?? {}
      const hasBili = data?.bili !== null && typeof data?.bili === 'object'
      const cache = session.cache ?? {}
      const payback = bili.payback ?? {}
      const cost = bili.costUsd ?? {}
      const hitRate = Number.isFinite(Number(bili.cacheHitPct))
        ? Number(bili.cacheHitPct) / 100
        : Number(cache.hitRate)
      return {
        title: bili.title ?? session.title ?? '未命名会话',
        sessionId: session.sessionId ?? '—',
        engine: typeof data?.engine === 'string'
          ? data.engine
          : hasBili
            ? 'billion-context'
            : (session.available ? 'compaction-basic' : 'unavailable'),
        requests: bili.requests ?? cache.requests,
        input: bili.inputTokens ?? cache.promptTokens,
        cached: bili.cachedTokens ?? cache.cacheReadTokens,
        output: bili.outputTokens ?? cache.outputTokens,
        hitRate,
        saved: bili.netSaved ?? session.tokensSaved,
        savedUsd: bili.savedUsd,
        cost: cost.total,
        payback: bili.savedUsd,
        context: bili.contextTokens ?? session.tokens,
        window: bili.contextWindow ?? session.window,
        lastInput: bili.lastInputTokens ?? cache.last?.promptTokens,
        paybackText: payback.spentUsd === undefined
          ? '—'
          : `花 ${money(payback.spentUsd)} · 重放 ${money(payback.replayUsd)} · 摘要 ${money(payback.sigmaUsd)}`,
      }
    }

    function reportMarkdown(data) {
      const value = reportValues(data)
      const session = data?.session ?? {}
      const bili = data?.bili ?? {}
      const cache = session.cache ?? {}
      const websocket = data?.websocket ?? {}
      return [
        `# 自动上下文压缩报告：${value.title}`,
        '',
        `- 生成时间：${new Date().toISOString()}`,
        `- 会话：${value.sessionId}`,
        `- 引擎：${value.engine}`,
        `- WebSocket：${websocket.path ?? '—'}（客户端 ${websocket.clients ?? 0}，协议 ${websocket.protocol ?? '—'}）`,
        '',
        '## 基本信息',
        '',
        `- 协议：${bili.protocol ?? 'dsh-native'}`,
        `- 客户端：${bili.client ?? 'DSH Web'}`,
        `- 上游：${bili.upstream ?? session.provider ?? '—'}`,
        `- 模型：${bili.model ?? session.model ?? '—'}`,
        `- 版本：${bili.version ?? PLUGIN_VERSION}`,
        `- 存储：${bili.storageMode ?? 'full'}`,
        `- 压缩包：${bili.pack ?? '—'}`,
        `- 上下文：${compact(value.context)} / ${compact(value.window)}（${percent(value.window > 0 ? value.context / value.window : 0)}）`,
        '',
        '## 用量统计',
        '',
        `- 请求：${count(value.requests ?? 0)}`,
        `- 输入 token：${count(value.input ?? 0)}`,
        `- 缓存命中 token：${count(value.cached ?? 0)}`,
        `- 缓存命中率：${percent(value.hitRate)}`,
        `- 输出 token：${count(value.output ?? 0)}`,
        `- 压缩节省：${count(value.saved ?? 0)} token（${money(value.savedUsd)}）`,
        `- 压缩回本：${money(value.payback)}（${value.paybackText}）`,
        `- 花费估算：${money(value.cost)}`,
        `- 最近单次输入：${count(value.lastInput ?? 0)}`,
        '',
        '## 本插件原生策略',
        '',
        `- 上下文 token：${count(session.tokens ?? 0)}`,
        `- 触发线：${percent(session.triggerRatio)}`,
        `- 目标线：${percent(session.targetRatio)}`,
        `- 已执行压缩：${count(session.compactions ?? 0)}`,
        `- 原生节省 token：${count(session.tokensSaved ?? 0)}`,
        `- 可用：${session.available === true ? '是' : `否（${session.lastSkipReason ?? 'unavailable'}）`}`,
        `- 批量裁剪字符：${count(session.prunedChars ?? 0)}`,
        `- DSH 请求数：${count(cache.requests ?? 0)}`,
        '',
        '## 说明',
        '',
        '金额按 DeepSeek 参考单价估算，不是账单。当前 profile 的线上压缩由 billion-context 账本提供；本插件的主动策略在原生 compaction 服务可用时接管。本报告由面板即时生成。',
        '',
      ].join('\n')
    }

    function imageModel(data) {
      const value = reportValues(data)
      const session = data?.session ?? {}
      const bili = data?.bili ?? {}
      return {
        title: value.title,
        subtitle: `${bili.protocol ?? 'dsh-native'} · ${bili.client ?? 'DSH Web'} · ${value.engine}`,
        basic: [
          ['会话', value.sessionId],
          ['模型', bili.model ?? session.model ?? '—'],
          ['上游', bili.upstream ?? session.provider ?? '—'],
          ['版本', bili.version ?? PLUGIN_VERSION],
          ['上下文', `${compact(value.context)} / ${compact(value.window)}`],
          ['压缩包', bili.pack ?? '—'],
        ],
        cards: [
          ['请求', count(value.requests ?? 0)],
          ['输入 token', compact(value.input ?? 0)],
          ['缓存命中 token', compact(value.cached ?? 0)],
          ['缓存命中率', percent(value.hitRate)],
          ['输出 token', compact(value.output ?? 0)],
          ['压缩节省', compact(value.saved ?? 0)],
          ['压缩回本', money(value.payback)],
          ['花费（美元）', money(value.cost)],
          ['最近单次输入', compact(value.lastInput ?? 0)],
        ],
      }
    }

    function drawRounded(g, x, y, width, height, radius, fill) {
      const r = Math.min(radius, width / 2, height / 2)
      g.beginPath()
      g.moveTo(x + r, y)
      g.arcTo(x + width, y, x + width, y + height, r)
      g.arcTo(x + width, y + height, x, y + height, r)
      g.arcTo(x, y + height, x, y, r)
      g.arcTo(x, y, x + width, y, r)
      g.closePath()
      g.fillStyle = fill
      g.fill()
    }

    function fitText(g, text, maxWidth) {
      const value = String(text ?? '—')
      if (g.measureText(value).width <= maxWidth) return value
      let end = value.length
      while (end > 1 && g.measureText(`${value.slice(0, end)}…`).width > maxWidth) end -= 1
      return `${value.slice(0, end)}…`
    }

    function renderReportImage(data) {
      return new Promise((resolve, reject) => {
        const model = imageModel(data)
        const canvas = document.createElement('canvas')
        const dpr = 2
        canvas.width = 1200 * dpr
        canvas.height = 900 * dpr
        const g = canvas.getContext('2d')
        if (g === null) {
          reject(new Error('canvas unavailable'))
          return
        }
        g.scale(dpr, dpr)
        g.fillStyle = '#0b0f17'
        g.fillRect(0, 0, 1200, 900)
        drawRounded(g, 28, 24, 1144, 852, 22, '#111823')
        g.fillStyle = '#e9f1ff'
        g.font = '700 30px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText(fitText(g, model.title, 760), 58, 62)
        g.fillStyle = '#8ea0b8'
        g.font = '14px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText(fitText(g, model.subtitle, 760), 58, 100)
        g.fillStyle = '#18324b'
        g.fillRect(28, 130, 1144, 1)

        g.fillStyle = '#7f93ad'
        g.font = '700 12px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText('基本信息', 58, 158)
        g.font = '14px "Microsoft YaHei", "PingFang SC", sans-serif'
        model.basic.forEach(([label, value], index) => {
          const column = index % 3
          const row = Math.floor(index / 3)
          const x = 58 + column * 368
          const y = 188 + row * 42
          g.fillStyle = '#7f93ad'
          g.fillText(label, x, y)
          g.fillStyle = '#dbe7f7'
          g.fillText(fitText(g, value, 300), x + 88, y)
        })

        g.fillStyle = '#7f93ad'
        g.font = '700 12px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText('用量统计', 58, 300)
        model.cards.forEach(([label, value], index) => {
          const column = index % 3
          const row = Math.floor(index / 3)
          const x = 58 + column * 368
          const y = 326 + row * 150
          drawRounded(g, x, y, 344, 126, 14, '#172233')
          g.fillStyle = '#8499b3'
          g.font = '13px "Microsoft YaHei", "PingFang SC", sans-serif'
          g.fillText(label, x + 18, y + 24)
          const green = label === '压缩节省' || label === '压缩回本'
          g.fillStyle = green ? '#5cffb0' : '#f2f7ff'
          g.font = '700 27px "Microsoft YaHei", "PingFang SC", sans-serif'
          g.fillText(fitText(g, value, 306), x + 18, y + 58)
        })

        g.fillStyle = '#6f849e'
        g.font = '12px "Microsoft YaHei", "PingFang SC", sans-serif'
        g.fillText('金额按 DeepSeek 参考单价估算，不是账单。实时数据由 WebSocket 推送。', 58, 812)
        g.fillStyle = '#43566f'
        g.fillText(`dsh-auto-context-compression v${PLUGIN_VERSION} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`, 58, 838)
        canvas.toBlob((blob) => {
          if (blob === null) reject(new Error('PNG encoding failed'))
          else resolve(blob)
        }, 'image/png')
      })
    }

    async function downloadReportFile(data) {
      downloadBlob(`auto-context-compression-${stamp()}.md`, new Blob([reportMarkdown(data)], {
        type: 'text/markdown;charset=utf-8',
      }))
    }

    async function downloadReportImage(data) {
      const blob = await renderReportImage(data)
      downloadBlob(`auto-context-compression-${stamp()}.png`, blob)
    }

    function Header({ data, error, connected, onRefresh, onDownloadReport, onDownloadImage, downloading }) {
      const session = data?.session ?? {}
      const bili = data?.bili ?? null
      const active = bili !== null || (session.available === true && session.enabled !== false && session.excluded !== true)
      const status = !connected
        ? { label: data ? '连接中断（显示旧数据）' : '正在连接 WebSocket…', dot: data ? 'is-red' : 'is-muted' }
        : !data
          ? { label: '等待首帧…', dot: 'is-muted' }
          : bili !== null
            ? { label: 'bili 压缩中 · 实时', dot: 'is-green' }
            : !session.enabled
              ? { label: '已关闭', dot: 'is-muted' }
              : session.excluded
                ? { label: '已排除', dot: 'is-muted' }
                : active
                  ? { label: '运行中 · 实时', dot: 'is-green' }
                  : { label: '待命（无 compaction 服务）', dot: 'is-muted' }
      return h('div', { className: 'dsh-acc-head' },
        h('div', { className: 'dsh-acc-heading' },
          h('h1', { className: 'dsh-acc-title' }, '自动上下文压缩'),
          h('p', { className: 'dsh-acc-subtitle' }, 'WebSocket 实时推送 · 无需刷新页面')),
        h('div', { className: 'dsh-acc-actions' },
          h('span', { className: 'dsh-acc-pill', title: error ?? undefined },
            h('span', { className: `dsh-acc-dot ${status.dot}` }),
            status.label),
          h('button', {
            type: 'button',
            className: 'dsh-acc-button',
            onClick: onDownloadReport,
            disabled: data === null || downloading,
          }, '下载报告'),
          h('button', {
            type: 'button',
            className: 'dsh-acc-button',
            onClick: onDownloadImage,
            disabled: data === null || downloading,
          }, downloading ? '生成中…' : '下载图片'),
          h('button', {
            type: 'button',
            className: 'dsh-acc-button',
            onClick: onRefresh,
            disabled: downloading,
          }, '重连')))
    }

    function Panel(props) {
      const sessionId = typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? props.sessionId : ''
      const [epoch, setEpoch] = React.useState(0)
      const [actionError, setActionError] = React.useState(null)
      const [downloading, setDownloading] = React.useState(false)
      const live = useLiveStatus(sessionId, epoch)
      const { data, error, connected, loadedAt } = live

      const download = async (kind) => {
        if (data === null || downloading) return
        setDownloading(true)
        setActionError(null)
        try {
          if (kind === 'report') await downloadReportFile(data)
          else await downloadReportImage(data)
        } catch (reason) {
          setActionError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setDownloading(false)
        }
      }

      const session = data?.session ?? {}
      const bili = data?.bili !== null && typeof data?.bili === 'object' ? data.bili : null
      const cache = session.cache ?? {}
      const usage = session.compactionUsage ?? {}
      const configFile = data?.configFile ?? {}
      const last = cache.last ?? {}
      const cost = bili?.costUsd ?? null
      const payback = bili?.payback ?? null
      const biliHit = Number(bili?.cacheHitPct)
      const hitRate = bili !== null && Number.isFinite(biliHit) ? biliHit / 100 : cache.hitRate
      const missRate = Number.isFinite(Number(hitRate)) ? 1 - Number(hitRate) : undefined
      const requests = bili?.requests ?? cache.requests
      const inputTokens = bili?.inputTokens ?? cache.promptTokens
      const cachedTokens = bili?.cachedTokens ?? cache.cacheReadTokens
      const outputTokens = bili?.outputTokens ?? cache.outputTokens
      const savedTokens = bili?.netSaved ?? session.tokensSaved
      const contextTokens = bili?.contextTokens ?? session.tokens
      const contextWindow = bili?.contextWindow ?? session.window
      const contextRatio = contextWindow > 0 ? contextTokens / contextWindow : session.ratio
      const lastInputTokens = bili?.lastInputTokens ?? last.promptTokens
      const model = typeof session.model === 'string' && session.model.length > 0
        ? (typeof session.provider === 'string' && session.provider.length > 0
          ? `${session.provider}/${session.model}`
          : session.model)
        : bili?.model ?? '—'
      const title = bili?.title ?? (typeof session.title === 'string' && session.title.length > 0 ? session.title : '未命名会话')
      const contextText = `${compact(contextTokens)} / ${compact(contextWindow)}（${percent(contextRatio)}）`
      const thresholdText = `${percent(session.triggerRatio, 0)} → ${percent(session.targetRatio, 0)}`

      const summaryUSD = (
        (usage.inputTokens ?? 0) * PRICE.input
        + (usage.cacheReadTokens ?? 0) * PRICE.cacheRead
        + (usage.cacheWriteTokens ?? 0) * PRICE.cacheWrite
        + (usage.outputTokens ?? 0) * PRICE.output
      ) / 1e6
      const legacySavedUSD = ((session.tokensSaved ?? 0) * PRICE.input) / 1e6
      const legacyNetUSD = legacySavedUSD - summaryUSD
      const legacyRequestUSD = (
        (cache.uncachedInputTokens ?? 0) * PRICE.input
        + (cache.cacheReadTokens ?? 0) * PRICE.cacheRead
        + (cache.cacheWriteTokens ?? 0) * PRICE.cacheWrite
        + (cache.outputTokens ?? 0) * PRICE.output
      ) / 1e6
      const savedUSD = bili?.savedUsd ?? legacySavedUSD
      const paybackUSD = bili?.savedUsd ?? legacyNetUSD
      const totalUSD = cost?.total ?? legacyRequestUSD + summaryUSD
      const engineText = bili !== null
        ? `独立进程-${bili.engine ?? 'server'}`
        : session.available === true
          ? 'compaction-basic + 主动策略'
          : '待命（未连接 compaction 服务）'
      const inputMiss = inputTokens !== null && cachedTokens !== null ? inputTokens - cachedTokens : null
      const paybackSub = payback !== null
        ? `花≈${money(payback.spentUsd ?? undefined)} · 全价重放${money(payback.replayUsd ?? undefined)} · 摘要${money(payback.sigmaUsd ?? undefined)}`
        : bili !== null
          ? 'bili 账本未提供回本明细'
          : ((session.compactions ?? 0) > 0
            ? `节省 ${money(legacySavedUSD)} − 摘要 ${money(summaryUSD)}`
            : '暂无压缩记录')

      const rows = [
        { label: '标题', value: title, copy: title },
        { label: '会话', value: session.sessionId ?? '—', mono: true, copy: session.sessionId ?? null },
        { label: '协议', value: bili?.protocol ?? 'dsh-native' },
        { label: '客户端', value: bili?.client ?? 'DSH Web' },
        { label: '引擎', value: engineText },
        {
          label: '上游',
          value: bili?.upstream
            ?? (typeof session.provider === 'string' && session.provider.length > 0 ? session.provider : '—'),
        },
        { label: '代理版本', value: bili?.version ?? '—' },
        { label: '插件版本', value: PLUGIN_VERSION },
        {
          label: '存储模式',
          value: bili?.storageMode ? `${bili.storageMode}（统一读写/改写）` : 'full（统一读写/改写）',
        },
        { label: '压缩提示包', value: bili?.pack ?? '—' },
        { label: '上下文', value: contextText },
        { label: '压缩阈值', value: thresholdText },
        {
          label: '主动策略',
          value: bili !== null
            ? '待命（压缩由 billion-context 接管）'
            : session.available === true
              ? '运行中'
              : '待命（无 compaction 服务）',
          muted: bili !== null || session.available !== true,
        },
        { label: '状态文件', value: data?.statusFile ?? '—', mono: true, copy: data?.statusFile ?? null },
        { label: '配置文件', value: configFile.path ?? '—', mono: true, copy: configFile.path ?? null },
      ]

      return h('div', { className: 'dsh-acc-root' },
        h('div', { className: 'dsh-acc-inner' },
          h(Header, {
            data,
            error,
            connected,
            onRefresh: () => setEpoch((value) => value + 1),
            onDownloadReport: () => void download('report'),
            onDownloadImage: () => void download('image'),
            downloading,
          }),
          error !== null && data !== null
            ? h('div', { className: 'dsh-acc-banner is-warn' }, fill('WebSocket 暂时不可用，显示上一次数据：{x}', { x: error }))
            : null,
          actionError !== null
            ? h('div', { className: 'dsh-acc-banner is-warn' }, fill('下载失败：{x}', { x: actionError }))
            : null,
          data?.configFile?.lastError
            ? h('div', { className: 'dsh-acc-banner is-warn' }, fill('配置文件错误：{x}', { x: data.configFile.lastError }))
            : null,
          data === null
            ? h('div', { className: 'dsh-acc-empty' },
              h('div', { className: 'dsh-acc-empty-title' }, error === null ? '正在连接实时通道…' : '实时通道不可用'),
              h('div', null, error === null ? '正在获取 WebSocket 能力并等待首帧。' : `WebSocket 错误：${error}`),
              h('div', null, 'Host 状态接口尚未就绪。请确认插件已启用，然后点击重连。'),
              error === null ? null : h('button', {
                type: 'button',
                className: 'dsh-acc-button',
                onClick: () => setEpoch((value) => value + 1),
              }, '重试'))
            : h(React.Fragment, null,
              h('section', { className: 'dsh-acc-section' },
                h('div', { className: 'dsh-acc-section-head' },
                  h('span', null, '基本信息'),
                  loadedAt === null ? null : h('span', { className: 'dsh-acc-section-note' }, `更新于 ${clock(new Date(loadedAt).toISOString())}`)),
                h('div', { className: 'dsh-acc-info' },
                  rows.map((row) => h(InfoRow, {
                    key: row.label,
                    label: row.label,
                    value: row.value,
                    mono: row.mono === true,
                    muted: row.muted === true,
                    copy: row.copy ?? null,
                  })))),
              h('section', { className: 'dsh-acc-section' },
                h('div', { className: 'dsh-acc-section-head' },
                  h('span', null, '用量统计'),
                  h('span', { className: 'dsh-acc-section-note' }, '实时推送 · WebSocket')),
                h('div', { className: 'dsh-acc-grid' },
                  h(Card, {
                    label: '请求',
                    value: count(requests ?? 0),
                    sub: bili !== null ? 'bili 账本累计请求' : '本会话累计请求',
                  }),
                  h(Card, {
                    label: '输入 token',
                    value: compact(inputTokens ?? 0),
                    sub: bili !== null
                      ? `未命中 ${compact(inputMiss ?? 0)} · 折合约 ${money(cost?.input ?? undefined)}\n输入价 $0.15/Mtok`
                      : `未命中 ${compact(cache.uncachedInputTokens ?? 0)} · 缓存写 ${compact(cache.cacheWriteTokens ?? 0)}`,
                  }),
                  h(Card, {
                    label: '缓存命中 token',
                    value: compact(cachedTokens ?? 0),
                    sub: bili !== null
                      ? `折合约 ${money(cost?.cacheRead ?? undefined)}\n缓存读 $0.003/Mtok`
                      : '缓存读 $0.003/Mtok',
                  }),
                  h(Card, {
                    label: '缓存命中率',
                    value: percent(hitRate),
                    sub: `未命中 ${percent(missRate)}`,
                  }),
                  h(Card, {
                    label: '输出 token',
                    value: compact(outputTokens ?? 0),
                    sub: bili !== null
                      ? `折合约 ${money(cost?.output ?? undefined)}\n输出价 $0.60/Mtok`
                      : '模型输出累计',
                  }),
                  h(Card, {
                    label: '压缩节省',
                    value: compact(savedTokens ?? 0),
                    sub: `折合约 ${money(savedUSD)}`,
                    tone: 'green',
                  }),
                  h(Card, {
                    label: '压缩回本',
                    value: bili !== null || (session.compactions ?? 0) > 0 ? `≈ ${money(paybackUSD)}` : '—',
                    sub: paybackSub,
                    tone: (bili !== null || (session.compactions ?? 0) > 0)
                      ? (paybackUSD >= 0 ? 'green' : 'red')
                      : '',
                  }),
                  h(Card, {
                    label: '花费（美元）',
                    value: `≈ ${money(totalUSD)}`,
                    sub: bili !== null
                      ? `输入 ${money(cost?.input ?? undefined)} · 缓存读 ${money(cost?.cacheRead ?? undefined)} · 缓存写 ${money(cost?.cacheWrite ?? undefined)} · 输出 ${money(cost?.output ?? undefined)}`
                      : `输入 ${money((cache.uncachedInputTokens ?? 0) * PRICE.input / 1e6)} · 缓存 ${money((cache.cacheReadTokens ?? 0) * PRICE.cacheRead / 1e6)} · 输出 ${money((cache.outputTokens ?? 0) * PRICE.output / 1e6)}`,
                  }),
                  h(Card, {
                    label: '最近单次输入',
                    value: compact(lastInputTokens ?? 0),
                    sub: '最近一次请求上下文',
                  }))),
              h('div', { className: 'dsh-acc-note' }, '金额按 DeepSeek 参考单价估算（输入 $0.15 / 缓存读 $0.003 / 输出 $0.60 每百万 token），仅用于判断压缩是否划算，不是账单。压缩回本未计全量重放成本。当前 profile 的线上压缩由 billion-context 账本提供；本插件的主动策略在原生 compaction 服务可用时自动接管。'))))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.id = 'dsh-auto-context-compression-style'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'auto-context-compression styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'auto-context-compression locale')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'auto-context',
        order: 20,
        label: () => t('tab'),
        locale: NS,
      }, Panel))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
