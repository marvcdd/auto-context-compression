English version of [WEBSOCKET_REVIEW.md](./WEBSOCKET_REVIEW.md).

# WebSocket service self-review report

Date: 2026-10-31  
Audit target: [`lib/ws.js`](./lib/ws.js) and its Host/Client integration  
Runtime: DSH Desktop, Web GUI `http://127.0.0.1:51890`, Windows, Node.js 24  
Method: line-by-line source review + unit tests + real local handshake/push verification  
Purpose: for external reviewers to re-check; does not represent an independent third-party security audit

---

## 1. Summary of conclusions

The current implementation is a minimal RFC 6455 server for **read-only state push**: it does not execute client commands, does not read or write files specified by the client, and does not issue network requests on behalf of the client. It reuses the HTTP listener that DSH has already bound, mounting through `webServer.registerUpgrade()`, and does not open an extra port.

This review round found no directly exploitable vulnerabilities such as "unauthorized remote code execution", "arbitrary file read" or "server-side request forgery (SSRF)". Several protocol/resource-boundary issues were fixed (see section 6).

However, three **residual high risks** must be stated clearly. They are not ordinary code bugs but deployment and trust-model issues:

1. **`/api/ws-token` has no user-level authentication.** Any process on this machine can fetch the token; non-browser clients can also forge `Origin`. The security of this service is therefore essentially equivalent to a "same-user trust boundary on this machine", and it must not be exposed to a LAN or the public internet.
2. **Client bundle registration uses the DSH `clientModules` private API** (`sources`, `reconcilePackage`, `compose`, `notifyGraphChanged`, `rebuilt`). After a DSH upgrade it may stop working or produce duplicate boot entries; external reviewers should focus on compatibility and lifecycle.
3. **There is no per-session authorization.** A connection holding the token can read the statistics of any known session through `hello.sessionId` or the HTTP `sessionId`; when none is found it falls back to the "latest agent". When several users share one DSH process, this leaks metadata such as titles, token usage and cost.

If the service is used only on a local single-user machine with the GUI bound to loopback, the risks above are acceptable; once port forwarding, a reverse proxy or multi-user sharing is involved, authentication and per-session authorization must be added first.

---

## 2. Scope and out of scope

### In scope

- `lib/ws.js`: handshake, Origin/Token validation, frame parsing, fragmentation, control frames, UTF-8, backpressure, heartbeat, close, client limit.
- `lib/index.js`: `/api/ws-token`, `registerUpgrade`, 1-second broadcast, plugin dispose cleanup, status data assembly.
- `client.js`: fetching the token, establishing the `WebSocket`, hello, reconnect backoff, Markdown/PNG download.
- The WebSocket-related assertions in `test/ws.test.js` and `test/plugin.test.js`.
- Real loopback handshake and two snapshot pushes.

### Out of scope

- HTTP parsing, TLS termination, authentication and reverse-proxy configuration of the DSH `webServer` itself.
- Browser same-origin policy, operating-system account isolation, disk permissions.
- The security of billion-context's ledger endpoint (`127.0.0.1:18787`) itself; this plugin only reads it.
- Supply-chain auditing (dependency packages, the Node runtime); this module has no third-party runtime dependencies.
- Formal penetration testing, fuzzing, long soak testing.

---

## 3. Architecture and data flow

```text
Browser (same-origin page)
  │  GET /auto-context-compression/api/ws-token
  ▼
DSH webServer (127.0.0.1:51890)
  │  JSON {path, protocol, token}
  ▼
Browser new WebSocket(ws(s)://location.host/auto-context-compression/ws,
                      ["dsh-auto-context-v1", token])
  │  Origin: http://127.0.0.1:51890
  │  Sec-WebSocket-Protocol: dsh-auto-context-v1, <token>
  ▼
lib/ws.js  handleUpgrade()
  │  validate path / method / Upgrade / version
  │  validate Origin (same protocol, same port, page and server both loopback)
  │  validate protocol array: [fixed protocol, token]
  │  101 Switching Protocols
  ▼
Client sends {"type":"hello","sessionId":"..."} (optional)
  ▼
Host buildLiveValue() → statusSnapshot + session + bili + websocket
  ▼
broadcast() one snapshot per second (only while clients are connected)
```

Key design decisions:

- **No extra port**: it reuses DSH's listener, is naturally same-origin, and avoids CORS, mixed content and extra firewall surface.
- **Push only, no execution**: client messages support only `hello` / `snapshot` / `ping`; there is no ability to write files, run commands, fetch URLs or change configuration.
- **Read-only data**: snapshots come from Host memory state, DSH read-only measurements and bili's read-only HTTP endpoint.
- **No third-party dependencies**: frame parsing, handshake and heartbeat are all implemented inside `lib/ws.js`.

---

## 4. Trust boundaries

| Boundary | Trusted | Not trusted | Existing controls |
|---|---|---|---|
| Browser page ↔ Host | Same-origin page | Other sites, malicious iframes | Exact Origin validation + random token + `Sec-Fetch-Site` |
| Local process ↔ Host | Same-user local processes | Other users, remote hosts | Loopback only + token; **no OS-level authentication** |
| WebSocket client ↔ server | Connections that passed the handshake | Frame content, message rate, fragmentation | Mandatory masking, length limits, message rate, fatal UTF-8 |
| Host ↔ bili | The loopback address configured in `biliOrigin` | Content returned by bili | Read-only GET, 2 s cache, 1.2 s timeout, JSON parsing |
| Client bundle ↔ DSH | This plugin's own `client.js` | Future versions of DSH private APIs | Runtime feature detection, try/catch, inject only when missing |

**The most important boundary**: this is not a "web service with a login state". The token is a **process-level capability token**, not a user identity. Any process that can read loopback HTTP on this machine can obtain it.

---

## 5. Handshake and authentication review

### 5.1 Handshake validation order

`handleUpgrade()` checks in order:

1. the hub is not closed;
2. the socket is writable;
3. the URL pathname must be exactly `/auto-context-compression/ws`;
4. `GET`, `Upgrade: websocket`, `Connection` containing `upgrade`, `Sec-WebSocket-Version: 13`;
5. `Origin` must have the same protocol and port as `webServer.getOrigin()`, and both page and server hosts must be `127.0.0.1` / `localhost` / `::1`;
6. the number of connected clients is `< maxClients`;
7. `Sec-WebSocket-Protocol` must be exactly `[dsh-auto-context-v1, token]`;
8. `Sec-WebSocket-Key` must be standard 24-character base64 (22 characters + `==`).

If any step fails, it returns a plain-text 4xx/503 and calls `socket.end()`; it does not echo request headers, does not echo the token, and does not return HTML.

### 5.2 Origin validation

`isAllowedOrigin()` checks all of the following:

- `page.protocol === server.protocol`;
- `page.port === server.port`;
- the page hostname is loopback;
- the server hostname is loopback.

This is stricter than merely checking that `Origin` "looks like localhost": it blocks `https://127.0.0.1:51890` from connecting to `http://...`, blocks other ports and blocks LAN IPs. Non-browser clients can forge `Origin`, so Origin is not authentication; it is only a **browser-side CSWSH defense**.

### 5.3 Token validation

- The token is the base64url encoding of 32 random bytes (43 characters, about 256 bit).
- It is passed as the second value of `Sec-WebSocket-Protocol`, not in the URL/query, which reduces the chance of leaking it through access logs (proxies may still log the header).
- `tokenMatches()` uses `timingSafeEqual`; it returns early on a length mismatch (only the length leaks, and the token length is fixed, so there is no practical impact).
- The token is generated once per plugin process; after a plugin reload the old token becomes invalid and old connections are `close(1001)`.
- `/api/ws-token` returns `Cache-Control: no-store` and checks `Sec-Fetch-Site`, allowing only `same-origin` / `none`.

### 5.4 Finding: the token endpoint only blocks browser cross-site requests, not local processes

`sec-fetch-site` is a request header that browsers add automatically; curl, PowerShell and Node scripts can omit or forge it. Therefore:

```powershell
# any process on this machine can do this
$t = Invoke-RestMethod http://127.0.0.1:51890/auto-context-compression/api/ws-token
# then connect with $t.value.token
```

This is not "a missing header in the implementation" but an inherent limitation when there is no user authentication. See W-01.

---

## 6. Frame parsing and resource-limit review

### 6.1 Limits that are implemented

| Item | Limit |
|---|---|
| Client frame masking | Must be masked, otherwise 1002 |
| RSV bits | Any non-zero value is 1002 (no extensions supported) |
| Single-frame payload | `maxFramePayload` 16 KiB |
| Single message | `maxMessage` 32 KiB (fragments accumulated) |
| Parse buffer | `maxFramePayload * 4` = 64 KiB |
| Control frames | Must be FIN, payload ≤ 125 |
| Text | UTF-8 only; fatal decode failure is 1007 |
| Binary | Not supported, 1003 |
| Fragmentation | Text fragments only; control frames may be interleaved; illegal sequences are 1002 |
| Message rate | 50 per client per second; exceeding it is 1008 |
| Client count | 8 globally |
| Send backpressure | Skip when `writableLength > 1 MiB`, coalesce into pending |
| Heartbeat | Ping every 30 s; close after 90 s without pong |
| Close | Illegal close codes / a payload of length 1 are rejected |

### 6.2 Specific issues that were fixed

1. **close payload of length 1**: RFC 6455 requires a close payload of 0 or ≥2 bytes; the original implementation read 0 bytes and treated it as 1000. Changed to 1002.
2. **Illegal close codes**: 1004/1005/1006/1015 as well as <1000 and >4999 are now rejected.
3. **Origin too permissive**: the original only checked that the page host was loopback, not the server host and port; it is now tightened to both page/server loopback, same protocol and same port.
4. **Handshake key too permissive**: the original accepted any non-empty string; it is now tightened to standard 24-character base64.
5. **No message-rate cap**: 50 per second was added.
6. **Duplicate first frame**: a snapshot was sent when the connection was established and again on `hello`, so the client could receive two frames in the same tick; the proactive snapshot at handshake time was removed and `hello` now triggers the first frame.

### 6.3 Low-risk issues that remain

- **W-07 The parse-buffer cap may wrongly kill a legitimate large batch**: `push()` checks `buffer.length + chunk.length > maxFramePayload * 4` before parsing. If a client packs many small frames into one TCP chunk totaling more than 64 KiB, it is closed with 1009 even though every frame is compliant. Real browsers do not send data this way; low risk.
- **W-08 No immediate flush after drain**: under send backpressure, `pending` is only retried on the next 1-second broadcast. At worst this adds one second of delay and does not affect correctness.
- **W-09 Socket errors are not cleaned up immediately**: `socket.on('error')` only logs; usually `close` follows, but if only an error occurs without a close, the client stays in the set until the heartbeat times out. Low risk.
- **W-10 Error text may contain internal information**: `pushSnapshot()` sends `getSnapshot`'s `error.message` to the client verbatim; current errors mostly come from local bili requests and may contain paths/ports. Recommendation: return generic error codes to clients and write detailed errors only to the Host log.

---

## 7. Findings list (for item-by-item external review)

| ID | Severity | Status | Location | Issue | Impact | Recommendation |
|---|---|---|---|---|---|---|
| W-01 | **High (deployment)** | Residual | `/api/ws-token` + `handleUpgrade` | The token endpoint has no user authentication; local processes can fetch the token, and non-browsers can forge Origin | A same-user process on this machine can read the statistics of all sessions; if the port is forwarded, a remote attacker can read them too | Do not expose the port; add OS/reverse-proxy authentication; bind the token to a user/session; consider a Unix socket |
| W-02 | **High (compatibility)** | Residual | `ensureClientRegistration()` / `clientDiagnostics()` | Uses the `clientModules` private `sources/reconcilePackage/compose/notifyGraphChanged/rebuilt` | A DSH upgrade may break it, produce duplicate entries or corrupt the boot order | Prefer the Host boot scan; add version detection; re-run regression after upgrades; upstream should provide a public API |
| W-03 | Medium | Residual | `hello.sessionId` / HTTP `sessionId` | No per-session authorization; any sessionId can be read, falling back to the latest agent when not found | Metadata leaks under multi-user/multi-tenant use | Maintain an allowlist of sessions; bind the token to a session; reject unknown ids |
| W-04 | Medium | Residual | The whole listener | HTTP by default, no TLS; token and data in plaintext | Eavesdropping if proxied or sniffed; low risk on a loopback single machine | Loopback only; use an HTTPS/WSS reverse proxy when remote access is needed |
| W-05 | Medium | Residual | `maxClients` / handshake | 8 clients globally, no per-IP / connection-rate limit | A local process holding the token can occupy all connection slots and block the panel | Per-IP limits, handshake rate limiting, shorter idle timeouts |
| W-06 | Medium | Residual | `Sec-WebSocket-Protocol` | The token appears in a header and may be recorded by proxy logs; the token is not bound to a tab and can be replayed until the plugin reloads | After a log leak it can be reused by the same machine or the same network segment | Do not log that header; one-time/short-TTL tokens; bind to a session |
| W-07 | Low | Residual | `FrameParser.push()` | The parse buffer capped at 4×maxFrame may wrongly kill a compliant large batch | An extreme client is closed with 1009 | Relax to `maxMessage + maxFramePayload` or parse incrementally |
| W-08 | Low | Residual | `pushSnapshot()` / `sendJson()` | No drain event; pending waits for the next broadcast | Up to 1 second of delay under backpressure | Listen for `drain` and flush immediately |
| W-09 | Low | Residual | `handleUpgrade()` socket error | An error is only logged and the client is not removed immediately | In rare cases the connection slot is released late | Call `closeClient()` on error |
| W-10 | Low | Residual | `pushSnapshot()` catch | Internal error text is sent to the client | Leaks low-sensitivity information such as local paths/ports | Return generic error codes, write details to the log |
| W-11 | Info | Design | `FrameParser` | `permessage-deflate` is not supported; non-zero RSV is rejected | No compression, slightly higher bandwidth; smaller attack surface | Keep it unsupported unless clearly needed |
| W-12 | Fixed | Closed | First frame after the handshake | A snapshot was sent both on connect and on hello | Duplicate first frame, wasted bandwidth | Proactive snapshot at handshake removed |
| W-13 | Fixed | Closed | `FrameParser` | close payload length 1, illegal close codes, key validation, too-permissive Origin, unlimited message rate | Protocol/resource-boundary issues | Fixed, with tests |
| W-14 | Info | Accepted | `tokenMatches()` | Early return on length mismatch | Only the fixed length leaks; no practical impact | Keep as is |
| W-15 | Info | Accepted | Client download | Markdown/PNG are generated locally by the browser, never uploaded | Data only lands in the user's download directory | Tell the user the files contain session metadata |
| W-16 | Fixed | Closed | `GET /api/status?debug=1` | The public `rescan=1` parameter could trigger `clientModules` injection/rebuild | A same-origin script or a local-process GET could change the boot graph | The parameter was removed; private registration/rebuild now runs only during plugin initialization |

---

## 8. Concrete failure-scenario walkthroughs

### Scenario A: a malicious website attempts a cross-site WebSocket

1. The malicious page executes `new WebSocket('ws://127.0.0.1:51890/auto-context-compression/ws', ['dsh-auto-context-v1', 'guess'])`.
2. The browser automatically sends `Origin: https://evil.example`.
3. `isAllowedOrigin()` returns 403 because the protocol/port/loopback do not match.
4. Even if Origin were bypassed, the missing token is rejected with 401.

Conclusion: browser-side CSWSH is blocked twice, by Origin and by the token.

### Scenario B: a malicious local process

1. The process GETs `/api/ws-token` and obtains the token.
2. It uses any HTTP client to forge `Origin: http://127.0.0.1:51890` and handshakes with `Sec-WebSocket-Protocol: dsh-auto-context-v1, <token>`.
3. The handshake succeeds; it sends `hello` and reads snapshots.

Conclusion: **this cannot be prevented at present**. It is the boundary of the local same-user trust model, on the same level as "a local process can read `status.json`". If that is unacceptable, switch to a Unix domain socket + OS ACL, or add user authentication at the DSH layer.

### Scenario C: the port is forwarded to a LAN

1. The attacker accesses `http://host:51890/auto-context-compression/api/ws-token`.
2. It obtains the token and uses a script to forge a loopback Origin and connect.
3. It reads session titles, token usage and cost.

Conclusion: **high risk**. The current Origin validation only protects browsers, not scripts; do not expose the DSH GUI port beyond loopback. If remote access is required, put an authenticated reverse proxy in front and restrict `/auto-context-compression/*`.

### Scenario D: malicious frames / resource exhaustion

1. Unmasked frame → 1002.
2. Single frame >16 KiB → 1009.
3. Accumulated fragments >32 KiB → 1009.
4. Binary → 1003.
5. Invalid UTF-8 → 1007.
6. More than 50 per second → 1008.
7. More than 8 clients → 503.

Conclusion: per-connection resources are bounded; the global connection count has a cap; no unbounded memory growth path was found. The W-05 connection-slot occupation issue remains.

### Scenario E: slow client / backpressure

1. The client stops reading and `writableLength` grows.
2. Above 1 MiB, `sendJson()` stops writing and only sets `pending`.
3. The next broadcast retries; if the client is still slow, sends continue to be skipped.
4. After 90 s without a pong → closed with 1001.

Conclusion: nothing queues without bound; the cost is at most one second of delay for a slow client (W-08).

---

## 9. Tests and verification evidence

### 9.1 Automated tests

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

`test/ws.test.js` covers:

- parsing masked text frames;
- rejection of unmasked frames;
- fragmentation and maxMessage;
- strict Origin/token validation;
- a valid 101 handshake;
- 401 for a wrong capability.

`test/plugin.test.js` covers:

- `/api/ws-token` returning path/protocol/token;
- `registerUpgrade` being called;
- 403 for a cross-site `Sec-Fetch-Site`;
- status exposing only websocket metadata and not the token;
- the client static contract containing `new WebSocket` / download functions / no iframe.

### 9.2 Real loopback verification

```text
GET http://127.0.0.1:51890/auto-context-compression/api/ws-token
-> {ok:true, value:{path:"/auto-context-compression/ws",
                    protocol:"dsh-auto-context-v1",
                    token:"<43 chars>"}}
```

[`tools/ws-probe.mjs`](./tools/ws-probe.mjs) performs a real handshake and receives a snapshot:

```json
{
  "engine": "billion-context",
  "title": "五分钟视频介绍三角函数",
  "requests": 608,
  "savedUsd": 0.2449,
  "sessionId": "session-e868cc50-18ce-40c1-811b-a933a7c01fa4",
  "websocket": {
    "path": "/auto-context-compression/ws",
    "protocol": "dsh-auto-context-v1",
    "clients": 1
  }
}
```

It was confirmed that the client bundle is served by the Host and contains `new WebSocket`, `/api/ws-token`, `downloadReportFile`, `downloadReportImage` and `renderReportImage`.

### 9.3 Live push verification (after fixing the duplicate first frame)

After a Host reload, [`tools/ws-probe.mjs`](./tools/ws-probe.mjs) sends `hello` only once and receives two frames:

```text
snapshot 1: elapsed 312ms, engine billion-context, requests 608, savedUsd 0.2449
snapshot 2: elapsed 671ms, engine billion-context, requests 608, savedUsd 0.2449
```

The second frame was actively pushed by the Host's 1-second broadcast timer, with no new client request in between. The arrival time of the second frame is affected by the phase of the global
tick and may be shorter than 1 second; this does not affect the conclusion that "new frames arrive without polling".

### 9.4 Verification not yet completed

- Clicking the download buttons on a real browser page and the PNG rendering result (there is no DOM/screenshot tool; this needs human visual confirmation).
- A long-running (>1 hour) memory/handle soak test.
- Reverse proxy / HTTPS / non-loopback scenarios.

---

## 10. Pre-release recommendations (in priority order)

1. **Do not expose 51890 beyond loopback**; if remote access is required, use an authenticated HTTPS reverse proxy and deny external access to `/auto-context-compression/*`.
2. Add **user-session authentication** to the token endpoint, or move the WebSocket to a Unix domain socket / named pipe with OS ACLs.
3. Issue a **short-TTL, session-bound token** for each tab/session instead of using a process-level permanent token.
4. Add a **version blacklist/allowlist** and a startup self-check for the `clientModules` injection; after a DSH upgrade, run regression first and do not inject silently.
5. Add a per-IP connection limit, handshake rate limiting and a `drain` flush.
6. Remove `error.message` from client responses and return only error codes.
7. State explicitly in the README/deployment documentation: **the security boundary of this panel = local single-user loopback**.

---

## 11. Review limitations

- This report is an author self-review, not an independent security audit; no formal verification, fuzz testing or penetration testing was performed.
- The HTTP parsing and TLS termination of the DSH `webServer` were not audited; they belong to upstream.
- bili's HTTP service was not audited; only this plugin's read-only calls to it were verified.
- Not every browser/proxy combination was verified; `Sec-WebSocket-Protocol` may be rewritten or logged by some enterprise proxies.
- Dynamic verification was performed only on local loopback; no multi-user, remote, or HTTPS-terminating scenario was tested.

---

## 12. Code location index

| Content | Location |
|---|---|
| WebSocket handshake/frames/heartbeat/rate limiting | [`lib/ws.js`](./lib/ws.js) |
| `/api/ws-token`, `registerUpgrade`, 1-second broadcast, dispose | [`lib/index.js`](./lib/index.js) |
| Browser connection, reconnect, Markdown/PNG download | [`client.js`](./client.js) |
| WebSocket unit tests | [`test/ws.test.js`](./test/ws.test.js) |
| Route/client contract tests | [`test/plugin.test.js`](./test/plugin.test.js) |
| Real handshake probe | [`tools/ws-probe.mjs`](./tools/ws-probe.mjs) |
| Runtime status and bili ledger | `http://127.0.0.1:51890/auto-context-compression/api/status` |
| WebSocket token | `http://127.0.0.1:51890/auto-context-compression/api/ws-token` |
