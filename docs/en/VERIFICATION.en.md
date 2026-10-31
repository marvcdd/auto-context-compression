English version of [VERIFICATION.md](../VERIFICATION.md).

# Verification record (2026-10-31)

## 1. Build and static checks

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

Test coverage: configuration validation (including `biliOrigin` loopback validation/normalization), turn/step segmentation, system-header protection, tail retention, single-turn prefix, replacement-node fallback, tool-call pairing, pre-step failure isolation, session exclusion, `config.json` hot reload, cache hit-rate aggregation, compaction summary usage aggregation, status HTTP routes, WebSocket handshake/frame limits/Origin/token, web client contract, and every `/autocompact` subcommand.

## 2. Installation and activation

Installed through `plugin_manager`'s `install_bundle`:

```text
target: <repository root>
package: dsh-auto-context-compression@0.1.0
application: applied
warnings: []
```

The package enters the profile as a local link (`link:<repository root>`); in `list_bundles` its state is `enabled: true, installed: true`.

## 3. Runtime observation (real Host)

`$DSH_HOME/auto-context-compression/status.json` is created after installation and updated on every `agent/pre-step`. Example (before the production configuration was restored, during the temporary test configuration):

```json
{
  "sessionId": "session-7749e810-7cb5-4a77-b081-65f2feb95a27",
  "tokens": 260283,
  "window": 1048576,
  "ratio": 0.2482,
  "lastSkipReason": "below-trigger",
  "available": true
}
```

This proves two things:

1. the plugin is really attached to the current Agent's `agent/pre-step` (`lastSeenAt` advances with every model request);
2. the compaction service inside the preset's isolation group was found through `agentPresets.serviceFor(agent, 'compaction')` (`available: true`).

## 4. Real compaction transaction (one-shot subagent)

To avoid compacting the interactive session, the configuration was temporarily set to:

```yaml
triggerRatio: 0.02
targetRatio: 0.01
keepRecentTurns: 1
keepRecentTokens: 4000
minCompactionTokens: 8000
pruneToolResults: false
excludeSessionIds:
  - session-7749e810-7cb5-4a77-b081-65f2feb95a27
  - session-f76bd6fd-5b02-44d6-9aca-de65a08e8337
```

Then a read-only subagent was started to read `dsh-compaction-basic/lib/index.js` (1027 lines). The persisted log of the subagent session `2bce9d16-d8fa-43ff-a328-02c127260df8` contained:

```text
seq 20 step/end
seq 21 compaction/start
seq 23 compaction/summary   (summary 3,590 chars, shadowedTokenCount 15,346)
seq 24 user/message         surfaceOp: replace(startSeq 9, endSeq 19)
seq 25 compaction/end
seq 26 step/start
...
seq 39 turn/end
```

Aggregated result:

```text
compactions: 1
tokensSaved: 14,371
ratio after: 1.07%
lastSkipReason: compacted
```

The subagent still completed its original task normally and returned a three-line answer, proving that compaction did not break tool-call pairing or the current step.

### Fix record

The first real probe failed while writing the replacement node:

```text
surface replace: node 0 holds the system prompt and may be rewritten only by
a system/message over exactly that node
```

Cause: some sessions append `system/message` after `turn/start`, and the turn segmentation treated it as an ordinary surface node. The fix was:

- `buildTurnSegments` no longer includes `system/message` in turn nodes;
- the surface fallback selector skips all leading `system/message`;
- a regression test was added: `planCompaction never includes a system head that lands inside a turn`.

After the fix, the second real probe succeeded (the seq 21–25 above).

## 5. Production configuration restoration

After the test the following was restored:

```yaml
enabled: true
triggerRatio: 0.5
targetRatio: 0.35
keepRecentTurns: 2
keepRecentTokens: 12000
minCompactionTokens: 8000
minGrowthTokens: 8000
cooldownMs: 60000
pruneToolResults: true
fallbackContextWindow: 0
statusFile: true
configFile: true
logLevel: info
excludeSessionIds: []
```

`status.json` confirmed `triggerRatio: 0.5`, `targetRatio: 0.35`, `excludeSessionIds: []`; `config.json` is currently also 0.5 / 0.35. The interactive session is no longer excluded, but the current pressure (2026-10-31 09:30:58, 311,089 / 1,048,576 ≈ 29.7%) is below the 50% trigger line, so nothing is compacted immediately.

## 6. Config file hot reload (2026-10-31 09:36)

The plugin creates the user config automatically at:

```text
$env:USERPROFILE\.dsh\auto-context-compression\config.json
```

Measured steps and results:

1. At 09:36:02 `config.json` was generated for the first time, with the production defaults (triggerRatio 0.5, targetRatio 0.35).
2. At 09:36:12 `triggerRatio` was changed to `0.42` without reloading the plugin; the next `agent/pre-step` read the file, and `status.json` at 09:36:14 showed:
   ```text
   status.triggerRatio = 0.42
   configFile.reloadedAt = 2026-10-31T01:36:14.368Z
   configFile.lastError = null
   ```
3. `triggerRatio` was written as the string `"bad"`; the plugin kept the last valid configuration 0.42 and recorded in `status.json`:
   ```text
   configFile.lastError = auto-context-compression: triggerRatio must be a number in (0, 1)
   ```
4. `triggerRatio: 0.5` was restored; `status.json` at 09:36:26 went back to 0.5 and `lastError` was cleared.

Conclusion: users only need to edit `config.json` to customize the trigger line/target/retention; the values take effect on the next model request without reinstalling or restarting, and an invalid file does not damage the currently valid configuration.

## 7. Cache hit/miss rate (2026-10-31 09:47)

The plugin aggregates from the session's `assistant/message.usage`:

```text
promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
hitRate      = cacheReadTokens / promptTokens
missRate     = (inputTokens + cacheWriteTokens) / promptTokens
```

Real `status.json` (current interactive session, 09:47:43):

```text
requests            : 229
promptTokens        : 63,136,760
cacheReadTokens     : 62,721,664
cacheWriteTokens    : 0
uncachedInputTokens : 415,096
outputTokens        : 191,052
hitRate             : 99.34%
missRate            : 0.66%
last request        : 99.94% hit (375,808 read / 376,019 prompt)
```

`/autocompact status` shows the summary line, `/autocompact cache` shows the breakdown above; the same `cache` object is written to `sessions[]` in `status.json`. Compaction-summary auxiliary calls are recorded in `compaction/summary` and are not counted in the main-conversation hit rate.

## 8. Native Web panel and bili ledger (2026-10-31 10:16)

A native React `conversation.view` tab, **Compression** (id `auto-context`, order 20), was added without changing the existing **Context** (`bili-context`) page. `Slots.listSubTree` from `cordis_inspect_query` confirmed the registration order:

```text
chat            order 0
trajectory      order 10
auto-context    order 20   active true
bili-context    order 30
```

The Host provides the read-only endpoint:

```text
GET http://127.0.0.1:51890/auto-context-compression/api/status
```

Measured response:

```text
engine       : billion-context
biliOrigin   : http://127.0.0.1:18787
biliError    : null
title        : 五分钟视频介绍三角函数
requests     : 608
inputTokens  : 165,992,938
cachedTokens : 164,251,776
outputTokens : 524,618
netSaved     : 119,428,907
savedUsd     : 0.2449
contextTokens: 468,026
lastInput    : 468,026
cost.total   : 1.068700428
payback      : spent 0.1157 / replay 0.1113 / sigma 0.0056
```

These values match 608 / 166.0M / 164.3M / 99.0% / 525K / 119.4M / ≈$0.2449 / ≈$1.07 / 468K in the screenshot provided by the user. The data source is bili's:

```text
GET http://127.0.0.1:18787/__bili/sessions/<sessionId>/detail
```

Panel amounts and payback are displayed from the bili ledger, labeled "estimated, not a bill". When bili is absent, or `biliOrigin: ""` is set, it falls back to DSH's `assistant/message` / `compaction/summary` aggregation.

### Why the proactive policy shows standby

`plugin_manager list_plugins` shows:

```text
include:bili-compaction-gate   active
include:compaction-basic        enabled:false / fiberPhase:null
include:command-compact         enabled:false
include:tool-result-pruner      enabled:false
```

`billion-context/dsh.bundle.patch.yml` sets the native `compaction-basic` to `auto: false`, and `bili-compaction-gate` takes over at the wire layer. At this point `serviceFor(agent, 'compaction')` returns `undefined`, so `available:false` / `lastSkipReason:"no-compaction-service"` is the correct state; the panel shows **Standby (compaction taken over by billion-context)** and the green savings come from the bili ledger. Do not force both compaction stacks on at the same time.

### Client registration notes

`clientModules` scans `dsh.client` when the Host starts; when this plugin is hot-installed into a running Host, the package may not be in the boot graph yet. The current implementation checks the graph during initialization and, when the entry is missing, registers itself through a compatibility path that calls `reconcilePackage` / `compose` / `notifyGraphChanged`; when the entry exists, it calls `rebuilt` to refresh the client bundle; the **Compression** tab appears after a page refresh. A Host restart goes through the normal boot scan. This compatibility path does not modify the profile and does not hard-code session data. The public `?debug=1` read-only diagnostic no longer accepts `rescan=1` to trigger registration/rebuild.

### Tests this round

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

## 9. Live WebSocket and downloads (2026-10-31 10:29)

### 9.1 Protocol and endpoints

```text
GET  /auto-context-compression/api/ws-token
WS   /auto-context-compression/ws
protocol  dsh-auto-context-v1
```

`ws-token` returns `{ok:true,value:{path,protocol,token}}`; the browser handshakes with
`new WebSocket(ws(s)://location.host + path, [protocol, token])`. After a successful handshake the client sends
`{"type":"hello","sessionId":"<optional>"}`, the server pushes one frame immediately, and the Host's 1-second timer broadcasts afterwards;
after a disconnect the client reconnects with exponential backoff 0.5 s → 10 s, with no page refresh needed.

### 9.2 Real handshake and unsolicited push

`tools/ws-probe.mjs` completed a real 101 handshake over a loopback socket and sent `hello` exactly once:

```text
snapshot 1: elapsed 4ms,   engine billion-context, requests 608, savedUsd 0.2449
snapshot 2: elapsed 496ms, engine billion-context, requests 608, savedUsd 0.2449
```

The second frame was not triggered by a client request; it was pushed by the Host's broadcast timer. The arrival time of the second frame is affected by the phase of the global 1-second tick and may be shorter than 1 second; this only demonstrates that "new frames arrive without polling", and does not imply a fixed 1-second interval.
(This round also removed the duplicate first frame that was sent during the handshake as well as on `hello`; `hello` now triggers the first frame.)

### 9.3 Client bundle and page registration

`GET /plugins/??dsh-auto-context-compression/client.js&rev=35b709464d74` returns 200 (45,809 bytes), containing:

```text
new WebSocket
/api/ws-token
downloadReportFile
downloadReportImage
renderReportImage
conversation.view
```

The `conversation.view` occupants in `Slots.listSubTree` are still:

```text
chat          order 0
trajectory    order 10
auto-context  order 20  active true
bili-context  order 30
```

### 9.4 Automated tests

`node --test test/*.test.js` -> **40 passed, 0 failed**. New coverage:

- `test/ws.test.js`: masked text, unmasked rejection, fragmentation/size limits, strict Origin/token validation, valid 101, 401 for a bad capability;
- `test/plugin.test.js`: `ws-token` route, `registerUpgrade` mounting, cross-site `Sec-Fetch-Site` 403, status exposing only websocket metadata and not the token;
- client static contract: `new WebSocket`, download functions, no iframe/legacy polling.

### 9.5 Download

The panel offers two buttons:

- `Download report`: the client generates Markdown (basic information, usage, savings/payback/cost, proactive policy, WebSocket metadata, estimation disclaimer);
- `Download image`: the client draws a dark PNG on a 1200×900 @2x canvas, with the same content as the panel.

Both are generated locally in the browser and downloaded through a Blob; no file content is sent to the Host. The actual button clicks and PNG visuals require manual confirmation on the page; automation can only verify that the functions exist and the static contract holds.

### 9.6 Self-review report

The self-review, threat model, residual risks and fix record of the WebSocket code are in
[WEBSOCKET_REVIEW.en.md](./WEBSOCKET_REVIEW.en.md). Summary of conclusions: no remotely exploitable unauthenticated
code execution or arbitrary file read/write was found; the main residual risks are the token endpoint having no user
authentication, the `clientModules` private API compatibility, and the lack of per-session authorization. The deployment
boundary must remain loopback single-user.

## 10. Not covered / limitations

- The Web panel is a read-only observation page; configuration is still adjusted through `$DSH_HOME/auto-context-compression/config.json`, `cordis.patch.yml` and the `/autocompact` commands.
- The cache hit rate only counts `assistant/message` usage of the main conversation, not compaction-summary auxiliary calls; it cannot be computed when the adapter does not return cache fields.
- The session-level `on/off/threshold/target` overrides live in memory only and return to the configuration defaults after a restart.
- Summary quality is determined by the routed model; the plugin does not replace the model and does not rewrite prompts.
- A real summary call produces one extra model request (in verification, usage: input 16,689 / output 3,332 tokens); this is the inherent cost of context compaction.
- The local profile has compaction taken over by billion-context; this plugin's proactive policy only runs after the native compaction service is restored.
- Amounts are fixed reference prices / bili ledger estimates, not a bill; the payback estimate does not include the full replay cost.
- The WebSocket is suitable only for loopback single-user: the token is a process-level capability token with no user authentication; do not expose the GUI port to a LAN or the public internet. See [WEBSOCKET_REVIEW.en.md](./WEBSOCKET_REVIEW.en.md).
- No real browser click-through download, long soak test, HTTPS/reverse proxy, or non-loopback scenario was verified.
- The live panel still needs the page to load the new client bundle the first time; afterwards pushes/reconnects/downloads need no refresh. Client registration depends on DSH's private `clientModules` compatibility path, so it needs regression testing after a Host upgrade.
