English version of [README.md](./README.md).

# Auto Context Compression

A plugin for DeepSeek Harness that proactively compacts long sessions before the context window fills up, and shows context pressure, cache hits, compaction savings and cost estimates in the **Compression** tab of the Web UI.

In profiles without another compaction gateway, the `compaction-basic` service built into DeepSeek Harness compacts automatically when pressure reaches about **80%** (subject to the output reservation and the headroom cap). This plugin moves the trigger point of the same persistent compaction engine earlier, to a configurable **50%**, and performs deterministic tool-result pruning before summarizing, so long sessions fall back to the target level earlier and more smoothly.

The plugin only uses public capabilities that Harness already provides: `agent/pre-step`, `ctx.tokenMeter`, `ctx.toolResultPruner` and `ctx.compaction.compactRegion`. It adds no new Session event types and does not rewrite model requests, so fork / resume / replay / `/compact` all remain compatible.

> **Actual situation of the local profile**: `billion-context` is currently installed. It takes over automatic compaction at the wire layer and actively disables the native `compaction-basic` / `command-compact`. In this state the plugin's **proactive compaction policy stays on standby**, to avoid conflicting with bili's checkpoints; the Web panel switches to bili's ledger to show the real savings. If bili is uninstalled or the native compaction service is restored, the proactive policy resumes automatically. See [Relationship with billion-context](#relationship-with-billion-context).

## Code layout

- [`lib/index.js`](./lib/index.js): Host entry, pre-step policy, status and HTTP/WS routes;
- [`lib/policy.js`](./lib/policy.js): compaction span selection and config validation (core, kept as one file);
- [`lib/ws.js`](./lib/ws.js): WebSocket handshake, frame parsing, rate limiting and heartbeat (protocol core, kept as one file);
- [`lib/bili.js`](./lib/bili.js): billion-context ledger reader, response-size cap and field trimming;
- [`lib/client-registration.js`](./lib/client-registration.js): boot registration and read-only diagnostics for the client half (isolates DSH private APIs);
- [`client.js`](./client.js): native React panel, live connection, report/image downloads. DSH `dsh.client` loads a single bundle, so this stays one file and needs no build step.

## How it works

On every `agent/pre-step` of every Agent:

1. Compute the current request pressure with `tokenMeter.measure(session)` and read the context window from `session.requestContext().contextWindow`.
2. If the pressure is below the trigger ratio (50% by default), let the request through.
3. If the pressure is above the trigger ratio, call `toolResultPruner.pruneSession()` first to prune oversized tool results; if the pressure is already below the trigger line after pruning, skip summarizing.
4. If it is still above the line, select a **contiguous** piece of old history whose **tool calls and results are fully paired**:
   - prefer the oldest complete turn that is not retained;
   - if there is only one very long in-progress turn, select the prefix made of that turn's "completed steps";
   - if the surface has already been replaced (for example compacted/pruned before), fall back to selecting, in surface order, the prefix "from the beginning to the safe cut point".
5. Call `compaction.compactRegion(start, end, agent, signal)`; the Harness compaction engine performs the summary, the persistent replacement and the token accounting.
6. Keep the most recent `keepRecentTurns` complete turns, plus at least `keepRecentTokens` of the original tail.

By default each pass compresses pressure from 50% to about 35%. The built-in 80% policy is still kept as the last safety net.

## Installation

Install this repository from the plugin manager in the Harness Web UI. The `install_bundle` target must be an absolute path; run `(Resolve-Path .).Path` in the repository root and use the output as the target.

After installation:

- **Auto Context Compression** (自动上下文压缩) appears in the plugin list;
- the pre-step observer is attached to both new and existing sessions;
- when native compaction is available, the flow above runs before every model request; when bili has taken over, it is skipped and the reason is recorded;
- the session page's tab bar gains a **Compression** (`auto-context`) tab, between **Trajectory** and **Context**.

## Web panel

The **Compression** tab is a native React view (not an iframe) that receives read-only state pushes from the Host over a same-origin WebSocket, normally one frame per second; it no longer polls:

```text
GET  /auto-context-compression/api/ws-token
WS   /auto-context-compression/ws
```

`ws-token` returns a temporary capability token for this process; the browser handshakes with `new WebSocket(url, ["dsh-auto-context-v1", token])` and then sends `{"type":"hello"}` to subscribe. When the connection drops, the client reconnects with exponential backoff (0.5 s → 10 s); no page refresh is needed. The HTTP `/api/status` endpoint is still kept for debugging, external probes and `curl`.

The panel contains:

- **Basic information**: title, session id, protocol, client, engine, upstream, proxy version, plugin version, storage mode, compaction prompt pack, context level, compaction threshold, proactive policy state, state/config file paths;
- **Usage statistics**: requests, input tokens, cache-hit tokens, cache hit rate, output tokens, compaction savings, compaction payback, cost (USD), last request input;
- **Download**: `Download report` generates Markdown, `Download image` draws a PNG on a browser canvas; both are generated locally from the current page data and never uploaded to a server;
- Amounts are estimated with DeepSeek reference prices (input $0.15 / cache read $0.003 / output $0.60 per million tokens); they only help judge whether compaction pays off, and are not a bill.

When `billion-context` is present, the endpoint prefers its per-session ledger (`requests/inputTokens/cachedTokens/outputTokens/netSaved/savedUsd/costUsd/payback`), so the green cards show bili's actual compaction savings; otherwise it falls back to the DSH `assistant/message` and `compaction/summary` data aggregated by this plugin. `status.json` remains a pure file-based diagnostic channel that does not depend on the web service.

## Commands

Type in any session:

```
/autocompact                # same as status
/autocompact status         # current token pressure, trigger line, cache hit rate, compaction count
/autocompact cache          # cache hit/miss token breakdown
/autocompact on             # enable automatic compaction for this session
/autocompact off            # disable automatic compaction for this session
/autocompact threshold 45   # set this session's trigger line to 45%
/autocompact threshold 0.45 # same as above
/autocompact target 20      # set this session's compaction target to 20% (must be below the trigger line)
/autocompact config         # show the effective configuration
```

`on` / `off` / `threshold` / `target` are overrides **for this session, inside this process**; after a restart the values return to the configuration defaults.

## Cache hit and miss rate

`/autocompact status` shows a summary line:

```text
Cache: 90.6% hit / 9.4% miss (29 req; last 94.2%)
```

`/autocompact cache` shows the breakdown:

```text
Prompt cache (main conversation requests)
  Requests: 29
  Prompt tokens: 3,200,000
  Hit: 2,900,000 (90.6%)
  Miss: 300,000 (9.4%)
    uncached input: 280,000
    cache write: 20,000
  Output tokens: 120,000
  Last request: 94.2% hit · 161,152 read / 161,376 prompt at ...
```

Calculation (from the `usage` of every `assistant/message` in the session):

- `promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`
- `hitRate = cacheReadTokens / promptTokens`
- `missRate = (inputTokens + cacheWriteTokens) / promptTokens`

Here `inputTokens` is input that missed the cache, `cacheReadTokens` is the part served from the cached prefix, and `cacheWriteTokens` is the part written to the cache by this request, which still counts as a miss. Auxiliary calls such as compaction summaries are recorded in `compaction/summary` and are not included in the main-conversation hit rate. When the adapter does not return cache fields, the output is `no provider usage recorded yet`.

The same data is also written to `sessions[].cache` in `status.json` for external monitoring.

## Customizing the trigger with the config file (recommended)

On first load the plugin creates a user config file here:

```
$DSH_HOME/auto-context-compression/config.json
```

On Windows `$DSH_HOME` is usually `$env:USERPROFILE\.dsh`, that is:

```
$env:USERPROFILE\.dsh\auto-context-compression\config.json
```

The file is a JSON object; you may write only the keys you want to change, or keep the full template. For example, to move the trigger line to 35% and the target to 20%:

```json
{
  "triggerRatio": 0.35,
  "targetRatio": 0.2
}
```

After saving, **no restart or reinstall is needed**: the plugin reads the file directly at most once every 500 ms per `agent/pre-step`, so the next model request uses the new values. `/autocompact status` and `/autocompact config` force an immediate re-read.

Merge priority (highest to lowest):

1. the current session's `/autocompact threshold` / `/autocompact target` overrides;
2. `config.json`;
3. the defaults in the bundle's `cordis.patch.yml` and the profile patch.

If the JSON is malformed, contains unknown keys, or has invalid ratios, the plugin keeps the last valid configuration, logs a warning, and reports the error in `configFile.lastError` of `status.json` and in `/autocompact status`; it never blocks the conversation. Set `configFile` to `false` to disable file overrides (patch configuration only).

## Configuration

The configuration lives in the `auto-context-compression` row of `cordis.patch.yml`; it can also be overridden by id in the profile's `cordis.patch.yml`.

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Default switch for new sessions |
| `triggerRatio` | `0.5` | Compaction is considered once this pressure ratio is reached; must be greater than `targetRatio` |
| `targetRatio` | `0.35` | Target pressure ratio, used to decide how much old history to compact |
| `keepRecentTurns` | `2` | Number of recent complete turns kept verbatim |
| `keepRecentTokens` | `12000` | Lower bound of the recent token tail kept verbatim |
| `minCompactionTokens` | `8000` | Candidate ranges smaller than this token count are not worth summarizing |
| `minGrowthTokens` | `8000` | At least this many tokens must have grown since the last compaction before compacting again |
| `cooldownMs` | `60000` | Minimum interval between two compaction attempts |
| `pruneToolResults` | `true` | Prune oversized tool results before summarizing |
| `fallbackContextWindow` | `0` | Fallback window used when the window cannot be read; `0` means do not guess |
| `statusFile` | `true` | Write the diagnostic status file |
| `configFile` | `true` | Allow `$DSH_HOME/auto-context-compression/config.json` to override the configuration |
| `biliOrigin` | `http://127.0.0.1:18787` | billion-context local stats origin; only loopback HTTP(S) is allowed, set to `""` to disable |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `excludeSessionIds` | `[]` | Ids of sessions that are never compacted automatically (for example the session being debugged) |

All keys are optional; unknown keys raise an error when the plugin loads, so a typo cannot silently turn the protection off.

`excludeSessionIds` is a hard exclusion: an excluded session is not compacted automatically even after `/autocompact on`; it is restored only once the id is removed from the configuration.

## Status file

When `statusFile` is enabled, the plugin maintains:

```
$DSH_HOME/auto-context-compression/status.json
```

It contains the plugin version, the effective configuration, the `configFile` path / last error / last reload time, global statistics, and, for the most recent 30 sessions, the token count, window, pressure ratio, cache hit/miss breakdown (`sessions[].cache`), compaction count, saved tokens, last skip reason and errors. It records only numbers and session ids, never conversation content. Use it to confirm that the plugin really runs before every request, whether the config file was accepted, and why no compaction happened.

## Relationship with billion-context

`billion-context`'s bundle patch:

- sets the HOST-PLANE `compaction-basic` to `auto: false`, and disables the nested `@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-command-compact`;
- provides its own gate service through `bili-compaction-gate`, doing automatic compaction at the wire layer;
- deliberately keeps `bili-compaction-gate` always on, because sessions using its preset would otherwise wait for the gate forever.

Therefore, in the local profile:

- `agentPresets.serviceFor(agent, 'compaction')` returns `undefined`, and the panel's `Proactive policy` shows **Standby (compaction taken over by billion-context)**; this is the correct state, not a plugin failure;
- the panel's green savings cards read bili's `/__bili/sessions/<id>/detail` ledger instead, the same data used by bili's own "Context" page;
- do not force both `compaction-basic` and the bili gate on at the same time: the two checkpoint sets overwrite each other, and bili will also turn the native row off again.

To let this plugin's own proactive policy take over compaction, disable billion-context (including `bili-compaction-gate`) in the profile and confirm that `compaction-basic` is available. Choose one of the two modes; running both is not recommended.

## Security boundary

- **No new event types**: only the existing Harness `compaction/*` transactions are used.
- **No splitting of tool calls**: prefix selection requires tool calls and results to be fully paired; otherwise the cut point moves back.
- **No touching in-progress steps**: the current unfinished turn/step is kept by default; only completed boundaries are compacted.
- **Never blocking the conversation**: any failure in measuring, planning, pruning or summarizing is only logged, and `next()` is called anyway; when native compaction is available it remains the last safety net.
- **No duplicate summarization**: summaries are produced by the persistent engine of `compaction-basic`; this plugin only decides when and which range to compact. When the native service is unavailable (for example taken over by bili), the proactive policy stays on standby and does not generate summaries itself.
- **Single-turn protection**: a single-step turn that never produced `step/end` has no safe cut point, so the plugin skips it and leaves it to the built-in policy.
- **WebSocket is read-only**: only `hello` / `snapshot` / `ping` are supported; client commands are never executed, and paths specified by the client are never read or written; the Origin must be same-origin loopback, and a process-level token is also required.
- **Local trust boundary**: `/api/ws-token` has no user login state; any process on this machine can fetch the token. The panel is suitable for single-user loopback only; do not expose the GUI port to a LAN or the public internet. See [WEBSOCKET_REVIEW.en.md](./WEBSOCKET_REVIEW.en.md).

## Verification

```powershell
cd <repository root>
node --check lib/index.js
node --check lib/policy.js
node --check lib/ws.js
node --check lib/bili.js
node --check lib/client-registration.js
node --check client.js
node --test test/*.test.js   # 40 passed
```

The tests cover:

- configuration validation (unknown keys, ratios, integers, log level, exclusion list);
- turn/step segmentation, and protection of a system header that lands inside a turn;
- keeping the recent turns and the token tail;
- the completed-step prefix of a single turn;
- the surface-order fallback after a replacement node;
- tool-call pairing;
- the `agent/pre-step` compaction path, failure isolation, and `next()` always being called;
- session exclusion;
- `config.json` hot reload: changing the trigger line needs no reload, an invalid file is ignored and reported;
- cache hit-rate aggregation and the `/autocompact cache` breakdown;
- compaction summary usage aggregation;
- the status HTTP routes (read-only, GET/405/404);
- `/api/ws-token`, `registerUpgrade` mounting, cross-site request 403, status not leaking the token;
- the WebSocket handshake, Origin/token rejection, masking/fragmentation/size limits, 401 for a bad capability;
- the web client contract (native `conversation.view`, `new WebSocket`, Markdown/PNG downloads, no iframe);
- validation and normalization of the bili stats source;
- `/autocompact` status / cache / on / off / threshold / target / config.

For real post-install verification, check `status.json`: the current session should appear in `sessions[]`, and `tokens` and `lastSkipReason` should update with every model request. In a profile where native compaction is available, `compactions` and `tokensSaved` grow once pressure passes the trigger line, and the log shows `auto-context-compression: compacted ...`; in the current bili-managed profile the proactive policy shows `no-compaction-service`, which is expected behavior.

On 2026-10-31 a one-shot subagent was used for a real compaction verification (native compaction was still available at that time): with a temporary threshold of 2% and the interactive session excluded, the subagent session produced a complete `compaction/start → compaction/summary → user/message(replace) → compaction/end` transaction, saving 14,371 tokens, and the subagent still completed its answer normally. The production configuration of 50% / 35% was restored afterwards. Evidence: [VERIFICATION.en.md](./VERIFICATION.en.md).

## Known limitations

- Configuration is adjusted through `$DSH_HOME/auto-context-compression/config.json`, `cordis.patch.yml`, or `/autocompact threshold` / `/autocompact target`; the Web panel is a read-only observation page and offers no configuration writes.
- The session-level `on` / `off` / `threshold` / `target` overrides are not persisted; after a restart the values return to the configuration defaults.
- Compaction granularity is bounded by the safety rules: a turn with only one in-progress step is not compacted at that step; it is handled when the next step completes, or when the built-in 80% policy fires.
- The cache hit rate only counts `assistant/message` usage of the main conversation, not compaction-summary auxiliary calls; it cannot be computed when the model adapter does not return `cacheReadTokens` / `cacheWriteTokens`.
- Summary quality depends on the summarizing ability of the currently routed model; the plugin does not replace the model and does not rewrite prompts.
- In the current profile, live compaction is performed by billion-context; the proactive policy does not run until the native compaction service is restored.
- Panel amounts use fixed reference prices, while the bili ledger returns its own estimates; neither is a bill.
- The WebSocket token is a process-level capability token and is not bound to a tab or a session; same-user processes on this machine can read the token, so the security boundary is loopback single-user, not multi-tenant authentication. Do not port-forward it.
- The client bundle depends on the `clientModules` boot scan; when the plugin is hot-installed into a running Host, the plugin tries to register itself through a compatibility path (using a DSH private API). If the tab disappears after a DSH upgrade, refresh or restart the Host; the long-term fix is to switch to the upstream public client scan mechanism.
- The live panel needs the page to load the new client bundle once; after that, data pushes, reconnects and downloads do not require a page refresh.

## Documentation

- [GITHUB.en.md](./GITHUB.en.md): complete command checklist for uploading to GitHub;
- [SECURITY_REVIEW.en.md](./SECURITY_REVIEW.en.md): whole-project security review report;
- [WEBSOCKET_REVIEW.en.md](./WEBSOCKET_REVIEW.en.md): dedicated WebSocket self-review;
- [VERIFICATION.en.md](./VERIFICATION.en.md): test and real-world verification record.

Chinese originals:

- [README.md](./README.md)
- [GITHUB.md](./GITHUB.md)
- [SECURITY_REVIEW.md](./SECURITY_REVIEW.md)
- [WEBSOCKET_REVIEW.md](./WEBSOCKET_REVIEW.md)
- [VERIFICATION.md](./VERIFICATION.md)
