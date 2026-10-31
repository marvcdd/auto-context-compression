English version of [SECURITY_REVIEW.md](./SECURITY_REVIEW.md).

# Whole-project security review report

Date: 2026-10-31  
Audit target: the whole `dsh-auto-context-compression@0.1.0` repository  
Method: line-by-line source review, static scanning, unit tests, real local loopback handshake and push verification  
Report nature: author self-review, not an independent third-party security audit; the conclusions are for pre-release self-checking and external re-review

## Contents

- [1. Executive summary](#1-executive-summary)
- [2. Scope and method](#2-scope-and-method)
- [3. Architecture and trust boundaries](#3-architecture-and-trust-boundaries)
- [4. Attack surface inventory](#4-attack-surface-inventory)
- [5. Findings summary](#5-findings-summary)
- [6. Detailed findings](#6-detailed-findings)
- [7. Fixed items](#7-fixed-items)
- [8. Tests and verification](#8-tests-and-verification)
- [9. Deployment checklist](#9-deployment-checklist)
- [10. Review limitations](#10-review-limitations)
- [11. File index](#11-file-index)

## 1. Executive summary

This project is a DSH Host plugin plus a native Web panel registered through `conversation.view`. The core risk is not the conversation-compaction logic but the **local web capability surface**:

- by default it listens on loopback only; the WebSocket is read-only and cannot execute client commands or read/write paths specified by the client;
- `/auto-context-compression/api/ws-token` **has no user authentication**, so any process on this machine can obtain the token; non-browser clients can also forge `Origin`. The security boundary is therefore "local single-user", not multi-tenant authentication;
- client bundle registration relies on the DSH `clientModules` **private API**, so a DSH upgrade may break the boot graph or create duplicate entries;
- fixed/mitigated in this round: the bili response body size cap, WebSocket internal error leakage, the `close()` arguments, boot-graph changes triggered by a public GET, and bili timeouts/caching;
- all 40 tests pass; a real local handshake receives two pushed frames; no hard-coded secrets, command execution, `eval`/`new Function`, `innerHTML` or runtime npm dependencies were found.

**Release conclusion**: single-user loopback operation is fine; **do not forward the GUI port to a LAN or the public internet**. If remote access is required, run it behind an authenticated HTTPS reverse proxy and additionally restrict `/auto-context-compression/*` and the WebSocket path.

## 2. Scope and method

Files reviewed:

- [`lib/index.js`](./lib/index.js): Host plugin, HTTP routes, WebSocket mounting, bili reads, status file, client registration;
- [`lib/policy.js`](./lib/policy.js): configuration validation and compaction planning;
- [`lib/ws.js`](./lib/ws.js): WebSocket handshake, frame parsing, rate limiting, heartbeat, broadcast;
- [`client.js`](./client.js): native React panel, connect/reconnect, Markdown/PNG download;
- [`package.json`](./package.json), [`cordis.patch.yml`](./cordis.patch.yml), [`icon.svg`](./icon.svg), [`locale/`](./locale/) and the tests;
- [`README.md`](./README.md), [`VERIFICATION.md`](./VERIFICATION.md), [`WEBSOCKET_REVIEW.md`](./WEBSOCKET_REVIEW.md).

Method:

1. reviewed authentication, Origin, token handling, input parsing, error handling, file reads/writes and client rendering section by section;
2. checked every entry point with `node --check`;
3. ran the 40 tests with `node --test test/*.test.js`;
4. scanned for hard-coded secrets, `child_process`, `eval`, `new Function`, `innerHTML`, dynamic dependencies and install scripts;
5. performed a real local loopback verification of token retrieval, a 101 handshake, one `hello` and two snapshot frames;
6. checked the bili read-only HTTP calls for fixed path, loopback, timeout, caching and response size.

Not done: formal verification, fuzz testing, independent penetration testing, multi-user/remote/HTTPS-terminating scenarios, and an audit of the HTTP parsing and TLS termination of the upstream DSH `webServer`.

## 3. Architecture and trust boundaries

```text
DSH Host process
  ├─ agent/pre-step compaction policy (this plugin)
  ├─ webServer
  │    ├─ GET /auto-context-compression/api/status
  │    ├─ GET /auto-context-compression/api/ws-token
  │    └─ WS  /auto-context-compression/ws
  ├─ clientModules private API → registers client.js
  ├─ status.json / config.json ($DSH_HOME)
  └─ bili loopback HTTP 127.0.0.1:18787 (read-only detail)
        ↑
Browser same-origin page (DSH Web GUI)
  └─ native React panel + fetch token + WebSocket + local download
```

Trust boundaries:

- **Local OS user**: can read the token and reach the loopback port, and is treated as trusted;
- **Same-origin browser page**: constrained by `Origin`, `Sec-Fetch-Site` and the token, but the token endpoint itself has no login state;
- **DSH Host / profile**: trusted; other plugins in the profile can in theory also read files/ports, which is same-layer trust;
- **bili local service**: read-only, fixed path, loopback; its responses are treated as untrusted input and normalized and size-capped;
- **External network**: unreachable by default; once the port is forwarded, it must be re-evaluated as an untrusted network.

## 4. Attack surface inventory

| Surface | Entry point | Capability |
| --- | --- | --- |
| HTTP status | `GET /api/status` | Reads session titles, token pressure, cache, bili statistics, config paths |
| HTTP capability | `GET /api/ws-token` | Returns the process-level WebSocket token |
| WebSocket | `/ws` | Read-only snapshots; accepts `hello` / `snapshot` / `ping` |
| Client bundle | `clientModules` registration | Executes this project's `client.js` in the page |
| Download | Browser-local Blob | Generates Markdown/PNG containing session metadata |
| Configuration | `config.json` / patch | Can change the trigger line, biliOrigin, exclusion list |
| Status file | `status.json` | Writes numbers, session ids, absolute paths, errors |
| Upstream | bili `localhost:18787` | Fixed `GET /__bili/sessions/<id>/detail` |

What does not exist: arbitrary file read/write, command execution, model-request rewriting, client-triggered compaction transactions, WebSocket binary/extension negotiation.

## 5. Findings summary

| ID | Severity | Component | Status | Summary |
| --- | --- | --- | --- | --- |
| S-01 | High (only when the port is exposed) | `/api/ws-token` | Accepted / deployment constraint | No user authentication; local processes can fetch the token, non-browsers can forge Origin |
| S-02 | High (compatibility/supply chain) | `clientModules` | Accepted | Relies on DSH private APIs to inject/rebuild the client entry |
| S-03 | Medium | status/WS | Accepted | No session-level authorization; an unmatched explicit `sessionId` falls back to the latest agent |
| S-04 | Medium | `/api/status` | Mitigated | Every GET triggers a measurement and a bili read, with no rate limit |
| S-05 | Medium | WebSocket | Accepted | Only a global `maxClients=8`; no per-IP/handshake rate limit |
| S-06 | Medium | token/transport | Accepted | Loopback HTTP has no TLS; the token appears in `Sec-WebSocket-Protocol` |
| S-07 | Medium (deployment) | HTTP listener | Accepted / deployment constraint | If the GUI binds to a non-loopback address, the HTTP status/token surface is exposed with it |
| S-08 | Low | bili reads | Mitigated | `biliOrigin` may point at another local HTTP service; the fixed path limits SSRF |
| S-09 | Low | status/config files | Accepted | Contain session ids, absolute paths, errors; rely on OS ACLs |
| S-10 | Low | error handling | Partially fixed | HTTP 500 and WS are now generic; `biliError` may still contain local errors |
| S-11 | Low | WS frame parsing | Accepted | The 4×frame cap may wrongly close a legitimate large stream; no `drain` flush |
| S-12 | Low | CSRF | Accepted | The token endpoint relies only on the optional `Sec-Fetch-Site`; non-browsers can bypass it |
| S-13 | Low | download | Accepted | Markdown/PNG contain metadata such as titles, session ids and paths |
| S-14 | Low | auditing | Accepted | Token issuance/connections are not audited; only debug logs |
| S-15 | Low | status writes | Accepted | `writeFile` is not atomic; readers may see half-written JSON |
| S-16 | Low | client integrity | Accepted | Relies on the bundle served by the same-origin Host; no SRI signature |
| S-17 | Low | WS snapshot request | Accepted | A client can send `snapshot` to trigger a build; limited to 50/s |
| S-18 | Info | secrets/dependencies/rendering | Pass | No hard-coded secrets, no runtime dependencies, no `innerHTML`/`eval` |

## 6. Detailed findings

### S-01 Unauthenticated WebSocket capability endpoint

**Location**: the `/api/ws-token` branch in [`lib/index.js`](./lib/index.js); the Origin/token validation in [`lib/ws.js`](./lib/ws.js).

**Evidence**:

```text
GET /auto-context-compression/api/ws-token
-> {ok:true, value:{path, protocol, token}}
```

This route only checks `GET` and the optional `Sec-Fetch-Site`; there is no DSH user session, cookie or signature. The token is a process-level 32-byte random value and is not bound to a tab or session. The WebSocket handshake only verifies that
`Origin` is loopback with the same protocol and port, and that `Sec-WebSocket-Protocol` is `[protocol, token]`.

**Impact**: any process on this machine (including a process of another user in the same Windows session, or a local script able to read the environment/port) can obtain the token; non-browser clients can set Origin themselves. What can be read is only panel data (titles, usage, the bili ledger, config paths); **it cannot trigger compaction, cannot write files and cannot call models**. If 51890 is port-forwarded, a remote attacker can read the same data without authentication.

**Disposition**: accepted as the "loopback single-user" boundary; the README, this report and the release checklist all explicitly forbid port forwarding. Remote scenarios should sit behind an authenticated reverse proxy, with that prefix additionally restricted.

### S-02 Private `clientModules` API dependency

**Location**: `clientDiagnostics()` / `ensureClientRegistration()` in [`lib/index.js`](./lib/index.js).

**Evidence**: registration uses the public graph query `ctx.get('clientModules')`, but the actual repair path accesses `sources`, `reconcilePackage`, `compose`, `notifyGraphChanged` and `rebuilt` through `ctx.reflect.get('clientModules')`. These are not stable public contracts.

**Impact**: after a DSH upgrade, the boot graph may not include this plugin, entries may be duplicated, or `rebuilt` may throw. The worst case is that the panel does not appear or the page fails to load; because what is injected is this repository's own [`client.js`](./client.js), it does not directly create a new remote-code-execution surface. If DSH changes bundle-resolution semantics in the future, the public `dsh.client` scan/hot-update mechanism should be adopted first.

**Disposition**: accepted and recorded; it runs only once at startup, and the public `debug=1` route no longer triggers writes. After a DSH upgrade, the regressions "`auto-context` exists in `conversation.view`" and "`clientPath` is non-empty" must be re-run.

### S-03 Missing session-level authorization

**Location**: `findAgent()` and `buildLiveValue()` in [`lib/index.js`](./lib/index.js).

**Evidence**: `findAgent(sessionId)` matches `agent.id` or `agent.session.id` exactly; when there is no match it returns `agents[agents.length - 1]`. Both HTTP and WS can pass an arbitrary `sessionId`.

**Impact**: other sessions' titles, token pressure, cache and bili ledger can be read within the same Host, but only after obtaining the token or via same-origin access. This is information exposure, not session tampering. It is unacceptable in multi-user or multi-tenant deployments.

**Disposition**: accepted as the single-user boundary; a later change can return 404 when an explicit id does not match, and bind the token to a session.

### S-04 No rate limit on the status endpoint

**Location**: `handleStatusRequest()` → `refreshState()` → `tokenMeter.measure()` + `fetchBiliDetail()` in [`lib/index.js`](./lib/index.js).

**Impact**: a same-origin page or a local script can GET at high frequency, triggering token measurements and bili requests and creating CPU/file-handle pressure. There is currently a 2-second bili cache, a 1200 ms timeout and an 8 MiB response cap, but no HTTP-layer token bucket.

**Disposition**: mitigated rather than eliminated. Production could add per-IP/per-connection rate limiting; the local single-user risk is low.

### S-05 Unlimited connection count and handshake rate

**Location**: `maxClients` and the handshake path in [`lib/ws.js`](./lib/ws.js).

**Impact**: at most 8 clients globally, with no per-IP limit; an attacker can reconnect rapidly to fill all 8 slots, or repeatedly trigger 101/401 handshakes to consume CPU. Per-connection limits of 50 messages/s and heartbeat/idle reaping are already in place.

**Disposition**: accepted; add connection/handshake limits at the reverse-proxy layer for remote deployments.

### S-06 Loopback HTTP and token location

**Location**: `new WebSocket(url, [protocol, token])` in [`client.js`](./client.js); the protocol selection in [`lib/ws.js`](./lib/ws.js).

**Impact**: local HTTP has no TLS; the token appears in the `Sec-WebSocket-Protocol` request header and may be recorded by enterprise proxies, browser extensions or debug logs. The token does not change during the plugin process lifetime, so the replay window is long.

**Disposition**: accepted for loopback single-user; remote access must use HTTPS, with a shorter token TTL and binding to a session/tab.

### S-07 Non-loopback binding

**Location**: the DSH `webServer` binding configuration, which is not in this repository.

**Impact**: if the DSH GUI listens on `0.0.0.0` or is reverse-proxied to the public internet, `/api/status` and `/api/ws-token` are exposed along with it; the WS `Origin` check will reject because the server origin is not loopback, but HTTP reads remain reachable.

**Disposition**: before deployment, confirm that `webServer.getOrigin()` is `127.0.0.1`/`localhost`; do not map 51890 directly to the public internet.

### S-08 Local SSRF surface of biliOrigin

**Location**: the `biliOrigin` validation in [`lib/policy.js`](./lib/policy.js); `fetchBiliDetail()` in [`lib/index.js`](./lib/index.js).

**Evidence**: only `http/https` with a host of `127.0.0.1`, `localhost` or `::1` is allowed; the path is fixed to `/__bili/sessions/<encoded id>/detail`; there is a 2-second cache, a 1200 ms timeout and an 8 MiB response cap.

**Impact**: a configurer can make the plugin request a fixed path on another local HTTP service, but cannot specify an arbitrary path/method/body; the response is only used for display. The configuration itself is already at the Host trust layer, so the risk is low.

**Disposition**: mitigated; if a remote bili is supported in the future, an allowlist and authentication will be needed.

### S-09 Metadata in the status/config files

**Location**: `writeStatus()` and `ensureDefaultConfigFile()` in [`lib/index.js`](./lib/index.js).

**Impact**: `status.json` contains session ids, absolute paths, the last error and the configuration; `config.json` contains biliOrigin and the exclusion list. They rely on the OS ACL of `$DSH_HOME`; there is no explicit chmod/encryption.

**Disposition**: accepted; ensure `$DSH_HOME` is readable only by the current user; do not commit status files to Git.

### S-10 Error-message leakage

**Location**: the HTTP 500 and `biliError` in [`lib/index.js`](./lib/index.js); the snapshot error in [`lib/ws.js`](./lib/ws.js).

**Status**: HTTP 500 now returns a generic `internal error` and logs the details; the WS snapshot now returns `snapshot unavailable`; `biliError` still returns the local bili connection/HTTP error text.

**Impact**: error text may expose local ports, file paths or internal state; the reader is already inside the same-origin/local trust boundary.

**Disposition**: HTTP/WS are fixed; `biliError` is kept for diagnostics and is low risk.

### S-11 Frame parsing and backpressure boundaries

**Location**: `FrameParser`, `pushSnapshot()` and `closeClient()` in [`lib/ws.js`](./lib/ws.js).

**Observations**:

- the parser caps the buffer at `maxFramePayload * 4`; a legitimate oversized streaming chunk may be misjudged as exceeding the limit and closed;
- when `socket.write()` returns false there is no `drain` callback; it relies only on the next `writableLength` check to skip;
- socket errors are logged only at debug level; the client object is cleaned up only on the next broadcast/heartbeat.

**Impact**: mainly availability/resource issues, not privilege escalation; a single user can trigger them themselves.

**Disposition**: accepted; `drain` handling and immediate cleanup can be added later.

### S-12 Incomplete CSRF protection

**Location**: the `Sec-Fetch-Site` check in [`lib/index.js`](./lib/index.js).

**Impact**: `Sec-Fetch-Site` is an optional browser header; `curl` and local scripts can omit it. Because the token endpoint itself has no authentication, the real defense is loopback + token; it must not be treated as CSRF authentication.

**Disposition**: accepted; the same trust boundary as S-01.

### S-13 Downloaded files contain metadata

**Location**: `downloadReportFile()` / `renderReportImage()` in [`client.js`](./client.js).

**Impact**: the exported Markdown/PNG contain titles, session ids, paths, usage and the bili ledger; the file is saved by the user and never uploaded automatically.

**Disposition**: accepted; the README advises against sharing exported files publicly.

### S-14 Missing connection auditing

**Location**: [`lib/ws.js`](./lib/ws.js), [`lib/index.js`](./lib/index.js).

**Impact**: only mounting/warnings are logged; token issuance, connection origins and rejection-reason counts are not recorded, so incident traceability is limited.

**Disposition**: accepted; high-security scenarios can add structured audit logs (without logging the token itself).

### S-15 Non-atomic status writes

**Location**: `writeStatus()` in [`lib/index.js`](./lib/index.js).

**Impact**: while `writeFile` runs, a reader may see truncated JSON; it is not a security vulnerability, but it affects external monitoring.

**Disposition**: accepted; it could be changed to a temporary file + rename.

### S-16 Client bundle integrity

**Location**: the `clientPath` registration in [`lib/index.js`](./lib/index.js), and [`client.js`](./client.js).

**Impact**: the browser loads `client.js` from the same-origin Host; there is no SRI/signature, so the root of trust is the local package and the DSH bundle route. Anyone able to change the package can already execute code in the Host, so this is not an extra privilege escalation, but supply-chain auditing must cover the npm package/local link.

**Disposition**: accepted; pin the version at release time and review the package contents.

### S-17 Client-triggered snapshot builds

**Location**: `message.type === 'snapshot'` in [`lib/ws.js`](./lib/ws.js).

**Impact**: a connected party can request an immediate build, triggering `refreshState()`/bili reads; it is limited by 50 messages/s and 8 clients. This is local resource consumption, not data privilege escalation.

**Disposition**: accepted.

### S-18 Secrets, dependencies and rendering

- a whole-repository scan found no private keys, cloud tokens, GitHub tokens, `sk-` keys or hard-coded passwords;
- `package.json` has no `dependencies` / `devDependencies` and no `postinstall`;
- `icon.svg` is a static SVG and contains no `<script>`;
- the client uses React text nodes; there is no `innerHTML`, `eval` or `new Function`;
- there are no `child_process` calls.

## 7. Fixed items

| Item | Fix |
| --- | --- |
| Unbounded bili response | Cap at 8 MiB after `response.text()` before `JSON.parse`; the 1200 ms timeout and 2-second cache are kept |
| WS internal error leakage | A failed snapshot returns only `snapshot unavailable`; details go to the log |
| `close()` arguments ignored | Accept `code`/`reason` and forward them to every client |
| A public GET could change the boot graph | Removed the `?rescan=1` write path; `debug=1` is read-only diagnostics |
| HTTP 500 echoed internal errors | Changed to `internal error`; details only in the log |
| Duplicate first frame | Wait for the client's `hello` after the handshake before pushing the first frame |
| Close/control frame validation | Reject a close payload of length 1, illegal close codes and keys that are not 24 characters |
| Origin/token validation | Loopback with same protocol and port, timing-safe token, strict protocol array |
| Message rate | 50 per connection per second; exceeding it closes with 1008 |

## 8. Tests and verification

```powershell
node --check lib/index.js
node --check lib/policy.js
node --check lib/ws.js
node --check lib/bili.js
node --check lib/client-registration.js
node --check client.js
node --check tools/ws-probe.mjs
node --test test/*.test.js
```

Result: **40 passed, 0 failed**. Coverage:

- configuration validation (including `biliOrigin` loopback normalization/rejection);
- compaction planning, system-header protection, tool pairing, failure isolation;
- HTTP status/405/404, cross-site 403, token not leaked;
- WS handshake, 401 for a wrong token, Origin rejection, masking/fragmentation/size/rate limiting;
- the client contract (`new WebSocket`, `downloadReportFile`, `renderReportImage`, no iframe);
- real loopback: one `hello` receives two snapshot frames.

## 9. Deployment checklist

- [ ] Confirm the DSH GUI listens only on `127.0.0.1`; do not map 51890 to a LAN or the public internet;
- [ ] Do not expose `/auto-context-compression/*` to an untrusted reverse proxy;
- [ ] Confirm `$DSH_HOME` is readable and writable only by the current user;
- [ ] Do not commit `status.json`, `config.json` or exported Markdown/PNG to Git;
- [ ] Remote access must use an authenticated HTTPS reverse proxy, and consider changing the token endpoint to user-session authentication;
- [ ] After a DSH upgrade, regress: the panel tab exists, `clientPath` is non-empty, WS receives two frames, there are no duplicate entries;
- [ ] Before release, run `node --check lib/index.js lib/policy.js lib/ws.js client.js tools/ws-probe.mjs` and `node --test test/*.test.js`, and check that `git status` shows no unexpected files.

## 10. Review limitations

- This report is an author self-review, not an independent audit;
- the HTTP parsing, TLS termination and upstream `clientModules` implementation of the DSH `webServer` were not audited;
- the bili service itself was not audited; only this plugin's fixed GET calls to it were verified;
- no real attack testing against browser extensions, enterprise proxies or malicious local processes was performed;
- no long soak, fuzz or memory/handle-leak testing was performed;
- the conclusions apply only to the current commit and DSH version; re-review after upgrading.

## 11. File index

| Content | Location |
| --- | --- |
| Host routes, token, status file | [`lib/index.js`](./lib/index.js) |
| bili ledger reader and field trimming | [`lib/bili.js`](./lib/bili.js) |
| Client-half boot registration (DSH private API) | [`lib/client-registration.js`](./lib/client-registration.js) |
| Configuration validation and compaction policy | [`lib/policy.js`](./lib/policy.js) |
| WebSocket handshake/frames/rate limiting/heartbeat | [`lib/ws.js`](./lib/ws.js) |
| Native panel, connection, download | [`client.js`](./client.js) |
| Dedicated WebSocket report | [`WEBSOCKET_REVIEW.en.md`](./WEBSOCKET_REVIEW.en.md) |
| Verification record | [`VERIFICATION.en.md`](./VERIFICATION.en.md) |
| Git/GitHub upload commands | [`GITHUB.en.md`](./GITHUB.en.md) |
| Real handshake probe | [`tools/ws-probe.mjs`](./tools/ws-probe.mjs) |
