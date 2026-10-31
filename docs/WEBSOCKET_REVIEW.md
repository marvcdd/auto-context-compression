# WebSocket 服务自审报告

> [English](./en/WEBSOCKET_REVIEW.en.md) | 简体中文

日期：2026-10-31  
审核对象：[`lib/ws.js`](../lib/ws.js) 及其 Host/Client 接入  
运行环境：DSH Desktop，Web GUI `http://127.0.0.1:51890`，Windows，Node.js 24  
审核方式：源码逐行审查 + 单元测试 + 本机真实握手/推送验证  
报告用途：交给外部审查者复查，不代表独立第三方安全审计

---

## 1. 结论摘要

当前实现是一个**只读状态推送**用的最小 RFC 6455 服务端，不执行客户端指令、不读写客户端指定的文件、不代客户端发起网络请求。它复用了 DSH 已绑定的 HTTP listener，通过 `webServer.registerUpgrade()` 挂载，不额外开端口。

本轮审查未发现“未授权远程代码执行”“任意文件读取”“服务端请求伪造（SSRF）”这一类可直接利用的漏洞。已修复若干协议/资源边界问题（见第 6 节）。

但必须明确三个**残余高风险**，它们不是普通代码 bug，而是部署与信任模型问题：

1. **`/api/ws-token` 没有用户级认证**。本机任意进程都能取到 token；非浏览器客户端还能伪造 `Origin`。因此本服务的安全性本质上等价于“本机同用户信任边界”，不能暴露到局域网/公网。
2. **客户端 bundle 注册使用了 DSH `clientModules` 私有 API**（`sources`、`reconcilePackage`、`compose`、`notifyGraphChanged`、`rebuilt`）。DSH 升级后可能失效或产生重复 boot 条目，需要外部审查者重点关注兼容性与生命周期。
3. **没有 per-session 授权**。持有 token 的连接可以通过 `hello.sessionId` 或 HTTP `sessionId` 读取任意已知会话的统计；找不到时回退到“最新 agent”。多用户共享同一 DSH 进程时会泄露标题、token 用量、成本等元数据。

如果只在本机单用户、GUI 仅绑定 loopback 的前提下使用，上述风险可接受；一旦做端口转发、反向代理、多人共用，必须先加认证与 per-session 授权。

---

## 2. 审核范围与不在范围

### 在范围内

- `lib/ws.js`：握手、Origin/Token 校验、帧解析、分片、控制帧、UTF-8、背压、心跳、关闭、客户端上限。
- `lib/index.js`：`/api/ws-token`、`registerUpgrade`、1 秒广播、插件 dispose 清理、状态数据组装。
- `client.js`：取 token、建立 `WebSocket`、hello、重连退避、下载 Markdown/PNG。
- `test/ws.test.js`、`test/plugin.test.js` 中与 WebSocket 相关的断言。
- 真实 loopback 握手与两次 snapshot 推送验证。

### 不在范围内

- DSH `webServer` 本身的 HTTP 解析、TLS 终止、认证与反向代理配置。
- 浏览器同源策略、操作系统账号隔离、磁盘权限。
- billion-context 的账本接口（`127.0.0.1:18787`）自身的安全性；本插件只读取它。
- 供应链（依赖包、Node 运行时）审计；本模块没有第三方运行时依赖。
- 正式渗透测试、模糊测试、长时间 soak test。

---

## 3. 架构与数据流

```text
浏览器 (same-origin page)
  │  GET /auto-context-compression/api/ws-token
  ▼
DSH webServer (127.0.0.1:51890)
  │  JSON {path, protocol, token}
  ▼
浏览器 new WebSocket(ws(s)://location.host/auto-context-compression/ws,
                       ["dsh-auto-context-v1", token])
  │  Origin: http://127.0.0.1:51890
  │  Sec-WebSocket-Protocol: dsh-auto-context-v1, <token>
  ▼
lib/ws.js  handleUpgrade()
  │  校验 path / method / Upgrade / version
  │  校验 Origin（同协议、同端口、page 与 server 都是 loopback）
  │  校验协议数组：[固定协议, token]
  │  101 Switching Protocols
  ▼
客户端发送 {"type":"hello","sessionId":"..."}（可选）
  ▼
Host buildLiveValue() → statusSnapshot + session + bili + websocket
  ▼
每秒 broadcast() 一次 snapshot（有客户端时才推送）
```

关键设计：

- **不新开端口**：复用 DSH 的 listener，天然同源，避免 CORS、混合内容和额外防火墙面。
- **只推送、不执行**：客户端消息只支持 `hello` / `snapshot` / `ping`，没有文件、命令、URL、配置写入能力。
- **只读数据**：snapshot 来自 Host 内存状态、DSH 只读测量和 bili 只读 HTTP 接口。
- **无第三方依赖**：帧解析、握手、心跳全部在 `lib/ws.js` 内实现。

---

## 4. 信任边界

| 边界 | 信任什么 | 不信任什么 | 现有控制 |
|---|---|---|---|
| 浏览器页面 ↔ Host | 同源页面 | 其它网站、恶意 iframe | Origin 精确校验 + 随机 token + `Sec-Fetch-Site` |
| 本机进程 ↔ Host | 同用户本机进程 | 其它用户、远程主机 | 仅 loopback + token；**没有 OS 级认证** |
| WebSocket 客户端 ↔ 服务端 | 已通过握手的连接 | 帧内容、消息频率、分片 | 掩码强制、长度上限、消息速率、UTF-8 fatal |
| Host ↔ bili | `biliOrigin` 配置的 loopback 地址 | bili 返回内容 | 只读 GET、2 秒缓存、1.2 秒超时、JSON 解析 |
| Client bundle ↔ DSH | 本插件自己的 `client.js` | DSH 私有 API 的未来版本 | 运行时特性探测、try/catch、缺失时才注入 |

**最重要的边界**：本服务不是“有登录态的 Web 服务”。token 是**进程级能力令牌**，不是用户身份。任何能读本机回环 HTTP 的进程都能拿到它。

---

## 5. 握手与鉴权审查

### 5.1 握手校验顺序

`handleUpgrade()` 依次检查：

1. hub 未关闭；
2. socket 可写；
3. URL pathname 必须严格等于 `/auto-context-compression/ws`；
4. `GET`、`Upgrade: websocket`、`Connection` 包含 `upgrade`、`Sec-WebSocket-Version: 13`；
5. `Origin` 必须与 `webServer.getOrigin()` 同协议、同端口，且 page/server 主机都在 `127.0.0.1` / `localhost` / `::1`；
6. 已连接客户端数 `< maxClients`；
7. `Sec-WebSocket-Protocol` 必须恰好是 `[dsh-auto-context-v1, token]`；
8. `Sec-WebSocket-Key` 必须是 24 字符标准 base64（22 字符 + `==`）。

任何一步失败都返回纯文本 4xx/503，并 `socket.end()`；不回显请求头、不回显 token、不返回 HTML。

### 5.2 Origin 校验

`isAllowedOrigin()` 同时检查：

- `page.protocol === server.protocol`；
- `page.port === server.port`；
- page hostname 是 loopback；
- server hostname 是 loopback。

这比只检查 `Origin` 是否“看起来像 localhost”更严格：它阻止 `https://127.0.0.1:51890` 连 `http://...`、阻止其它端口、阻止局域网 IP。非浏览器客户端可以伪造 `Origin`，所以 Origin 不是身份认证，只是**浏览器侧 CSWSH 防线**。

### 5.3 Token 校验

- token 为 32 字节随机数的 base64url（43 字符，约 256 bit）。
- 通过 `Sec-WebSocket-Protocol` 第二个值传递，不放在 URL/query，降低访问日志泄露概率（但代理仍可能记录 header）。
- `tokenMatches()` 使用 `timingSafeEqual`；长度不等时提前返回（只泄露长度，token 长度固定，无实际影响）。
- token 每个插件进程生成一次；插件重载后旧 token 失效，旧连接被 `close(1001)`。
- `/api/ws-token` 返回 `Cache-Control: no-store`，并检查 `Sec-Fetch-Site` 只允许 `same-origin` / `none`。

### 5.4 发现：token endpoint 只防浏览器跨站，不防本机进程

`sec-fetch-site` 是浏览器自动加的请求头，curl、PowerShell、Node 脚本都可以不带或伪造。因此：

```powershell
# 本机任意进程都可以这样做
$t = Invoke-RestMethod http://127.0.0.1:51890/auto-context-compression/api/ws-token
# 然后用 $t.value.token 连接
```

这不是“实现漏了某个 header”，而是没有用户认证时的固有限制。见 W-01。

---

## 6. 帧解析与资源限制审查

### 6.1 已实现的限制

| 项目 | 限制 |
|---|---|
| 客户端帧掩码 | 必须 masked，否则 1002 |
| RSV 位 | 非 0 直接 1002（不支持扩展） |
| 单帧 payload | `maxFramePayload` 16 KiB |
| 单条消息 | `maxMessage` 32 KiB（分片累计） |
| 解析缓冲 | `maxFramePayload * 4` 64 KiB |
| 控制帧 | 必须 FIN，payload ≤ 125 |
| 文本 | 只接受 UTF-8；fatal 解码失败 1007 |
| 二进制 | 不支持，1003 |
| 分片 | 只支持 text 分片；控制帧可穿插；不合法序列 1002 |
| 消息频率 | 每客户端 50 条/秒，超出 1008 |
| 客户端数 | 全局 8 |
| 发送背压 | `writableLength > 1 MiB` 时跳过，合并 pending |
| 心跳 | 30 秒 ping，90 秒无 pong 关闭 |
| 关闭 | 非法 close code / 长度 1 的 payload 拒绝 |

### 6.2 已修复的具体问题

1. **close payload 长度为 1**：RFC 6455 要求 close payload 为 0 或 ≥2 字节；原实现会读 0 字节并当作 1000。已改为 1002。
2. **非法 close code**：1004/1005/1006/1015 以及 <1000、>4999 已拒绝。
3. **Origin 过宽**：原实现只检查 page host 是 loopback，未检查 server host 与端口；已收紧为 page/server 都 loopback、同协议、同端口。
4. **握手 key 过宽**：原实现接受任意非空字符串；已收紧为标准 24 字符 base64。
5. **消息频率无上限**：已加 50 条/秒。
6. **重复首帧**：连接建立时发一次 snapshot、收到 `hello` 又发一次，客户端可能在同一 tick 收到两帧；已移除握手时的主动 snapshot，改由 `hello` 触发首帧。

### 6.3 仍存在的低风险问题

- **W-07 解析缓冲上限可能误杀合法大块**：`push()` 在解析前检查 `buffer.length + chunk.length > maxFramePayload * 4`。如果客户端在一个 TCP chunk 中塞入大量小帧，总量超过 64 KiB，即使每帧都合规也会被 1009 关闭。浏览器实际不会这样发；低风险。
- **W-08 没有 drain 后立即 flush**：发送背压时 `pending` 只会在下一次 1 秒广播时重试。最坏多等 1 秒，不影响正确性。
- **W-09 socket error 未立即清理**：`socket.on('error')` 只记日志；通常随后会触发 `close`，但若只 error 不 close，客户端会留在 set 里直到心跳超时。低风险。
- **W-10 错误文本可能包含内部信息**：`pushSnapshot()` 把 `getSnapshot` 的 `error.message` 原样发给客户端；当前错误多来自本机 bili 请求，可能包含路径/端口。建议对外用通用错误码，详细错误只写 Host 日志。

---

## 7. 发现清单（供外部审查逐项复核）

| ID | 严重度 | 状态 | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|---|---|
| W-01 | **高（部署）** | 残余 | `/api/ws-token` + `handleUpgrade` | token endpoint 无用户认证；本机进程可取 token，非浏览器可伪造 Origin | 本机同用户进程可读所有会话统计；若端口被转发，远程攻击者可读 | 不暴露端口；加 OS/反向代理认证；token 绑定用户/会话；考虑 Unix socket |
| W-02 | **高（兼容性）** | 残余 | `ensureClientRegistration()` / `clientDiagnostics()` | 使用 `clientModules` 私有 `sources/reconcilePackage/compose/notifyGraphChanged/rebuilt` | DSH 升级可能失效、重复条目或 boot 顺序异常 | 优先依赖 Host 启动扫描；加版本探测；升级后回归；上游提供公开 API |
| W-03 | 中 | 残余 | `hello.sessionId` / HTTP `sessionId` | 无 per-session 授权；任意 sessionId 可读，找不到回退最新 agent | 多用户/多租户下元数据泄露 | 维护允许的 session 列表；token 绑定 session；拒绝未知 id |
| W-04 | 中 | 残余 | 整个 listener | 默认 HTTP，无 TLS；token 和数据明文 | 若被代理/抓包可窃听；loopback 单机风险低 | 仅 loopback；需要远程时用 HTTPS/WSS 反向代理 |
| W-05 | 中 | 残余 | `maxClients` / 握手 | 全局 8 个客户端，无 per-IP / 连接速率限制 | 持有 token 的本机进程可占满连接槽，阻止面板连接 | per-IP 限制、握手速率限制、空闲连接更短 |
| W-06 | 中 | 残余 | `Sec-WebSocket-Protocol` | token 出现在 header，可能被代理日志记录；token 不绑定标签页，可重放至插件重载 | 日志泄露后可被本机/同网段复用 | 不记录该 header；一次性/短 TTL token；绑定 session |
| W-07 | 低 | 残余 | `FrameParser.push()` | 解析缓冲 4×maxFrame 上限可能误杀合规大块 | 极端客户端被 1009 关闭 | 按 `maxMessage + maxFramePayload` 放宽或增量解析 |
| W-08 | 低 | 残余 | `pushSnapshot()` / `sendJson()` | 无 drain 事件，pending 等下一轮广播 | 背压时最多 1 秒延迟 | 监听 `drain` 并立即 flush |
| W-09 | 低 | 残余 | `handleUpgrade()` socket error | error 只记日志，不立即移除 client | 罕见情况下连接槽延迟释放 | error 时调用 `closeClient()` |
| W-10 | 低 | 残余 | `pushSnapshot()` catch | 内部错误文本发给客户端 | 泄露本机路径/端口等低敏信息 | 返回通用错误码，详情写日志 |
| W-11 | 信息 | 设计 | `FrameParser` | 不支持 `permessage-deflate`，RSV 非 0 拒绝 | 无压缩，带宽略高；安全面更小 | 保持不支持，除非明确需要 |
| W-12 | 已修复 | 关闭 | 握手后首帧 | 连接时和 hello 各发一次 snapshot | 重复首帧、浪费带宽 | 已移除握手主动 snapshot |
| W-13 | 已修复 | 关闭 | `FrameParser` | close payload 长度 1、非法 close code、key 校验、Origin 过宽、无限消息速率 | 协议/资源边界问题 | 已修复并有测试 |
| W-14 | 信息 | 接受 | `tokenMatches()` | 长度不等提前返回 | 只泄露固定长度，无实际影响 | 保持 |
| W-15 | 信息 | 接受 | 客户端下载 | Markdown/PNG 由浏览器本地生成，不上传 | 数据只落在用户下载目录 | 提示用户文件含会话元数据 |
| W-16 | 已修复 | 关闭 | `GET /api/status?debug=1` | 公开的 `rescan=1` 参数可触发 `clientModules` 注入/重建 | 同源脚本或本机进程的 GET 可改变 boot graph | 已移除该参数；私有注册/重建只在插件初始化时执行 |

---

## 8. 具体失败场景推演

### 场景 A：恶意网站尝试跨站 WebSocket

1. 恶意页面执行 `new WebSocket('ws://127.0.0.1:51890/auto-context-compression/ws', ['dsh-auto-context-v1', 'guess'])`。
2. 浏览器自动带 `Origin: https://evil.example`。
3. `isAllowedOrigin()` 因协议/端口/loopback 不匹配返回 403。
4. 即使 Origin 被绕过，没有 token 也在 401 被拒。

结论：浏览器侧 CSWSH 被 Origin + token 双重阻断。

### 场景 B：本机恶意进程

1. 进程 GET `/api/ws-token`，拿到 token。
2. 用任意 HTTP 客户端伪造 `Origin: http://127.0.0.1:51890`，带 `Sec-WebSocket-Protocol: dsh-auto-context-v1, <token>` 握手。
3. 握手成功，发送 `hello`，读取 snapshot。

结论：**当前无法阻止**。这是本机同用户信任模型的边界；与“本机进程可以读 `status.json`”同级。若不可接受，应改用 Unix domain socket + OS ACL，或在 DSH 层加用户认证。

### 场景 C：端口被转发到局域网

1. 攻击者访问 `http://host:51890/auto-context-compression/api/ws-token`。
2. 取 token；用脚本伪造 loopback Origin 连接。
3. 读取会话标题、token 用量、成本。

结论：**高风险**。当前 Origin 校验只防浏览器，不防脚本；不要将 DSH GUI 端口暴露到非 loopback。若必须远程访问，前置带认证的反向代理，并限制 `/auto-context-compression/*`。

### 场景 D：恶意帧 / 资源耗尽

1. 未掩码帧 → 1002。
2. 单帧 >16 KiB → 1009。
3. 分片累计 >32 KiB → 1009。
4. 二进制 → 1003。
5. 非法 UTF-8 → 1007。
6. >50 条/秒 → 1008。
7. 超过 8 个客户端 → 503。

结论：单连接资源有界；全局连接数有上限；没有发现无限内存增长路径。仍有 W-05 的连接槽占用问题。

### 场景 E：慢客户端 / 背压

1. 客户端不读数据，`writableLength` 增长。
2. 超过 1 MiB 后 `sendJson()` 不再写，只置 `pending`。
3. 下一轮广播重试；仍慢则继续跳过。
4. 90 秒无 pong → 1001 关闭。

结论：不会无限排队；代价是慢客户端最多延迟 1 秒（W-08）。

---

## 9. 测试与验证证据

### 9.1 自动化测试

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

`test/ws.test.js` 覆盖：

- 带掩码文本帧解析；
- 未掩码帧拒绝；
- 分片与 maxMessage；
- Origin/token 严格校验；
- 合法 101 握手；
- 错误 capability 401。

`test/plugin.test.js` 覆盖：

- `/api/ws-token` 返回 path/protocol/token；
- `registerUpgrade` 被调用；
- 跨站 `Sec-Fetch-Site` 403；
- status 只暴露 websocket 元数据、不暴露 token；
- 客户端静态契约包含 `new WebSocket` / 下载函数 / 无 iframe。

### 9.2 真实 loopback 验证

```text
GET http://127.0.0.1:51890/auto-context-compression/api/ws-token
-> {ok:true, value:{path:"/auto-context-compression/ws",
                    protocol:"dsh-auto-context-v1",
                    token:"<43 chars>"}}
```

[`tools/ws-probe.mjs`](../tools/ws-probe.mjs) 真实握手并接收 snapshot：

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

已确认客户端 bundle 由 Host 提供且包含 `new WebSocket`、`/api/ws-token`、`downloadReportFile`、`downloadReportImage`、`renderReportImage`。

### 9.3 实时推送验证（修复重复首帧后）

Host 重载后，[`tools/ws-probe.mjs`](../tools/ws-probe.mjs) 只发送一次 `hello`，收到两帧：

```text
snapshot 1: elapsed 312ms, engine billion-context, requests 608, savedUsd 0.2449
snapshot 2: elapsed 671ms, engine billion-context, requests 608, savedUsd 0.2449
```

第二帧由 Host 的 1 秒广播定时器主动推送，期间没有新的客户端请求。第二帧到达时间受全局
tick 相位影响，可能小于 1 秒；这不影响“无需轮询即可收到新帧”的结论。

### 9.4 尚未完成的验证

- 浏览器真实页面上的下载按钮点击与 PNG 渲染效果（没有 DOM/截图工具，需要人工目视）。
- 长时间运行（>1 小时）内存/句柄 soak test。
- 反向代理 / HTTPS / 非 loopback 场景。

---

## 10. 上线前建议（按优先级）

1. **不要把 51890 暴露到非 loopback**；如果必须远程，使用带认证的 HTTPS 反向代理，并禁止外部访问 `/auto-context-compression/*`。
2. 给 token endpoint 增加**用户会话认证**，或把 WebSocket 改为 Unix domain socket / 命名管道，使用 OS ACL。
3. 为每个标签页/会话签发**短 TTL、绑定 session 的 token**，不要用进程级永久 token。
4. 为 `clientModules` 注入加**版本黑名单/白名单**与启动自检；DSH 升级后先跑回归，不要静默注入。
5. 增加 per-IP 连接上限、握手速率限制和 `drain` flush。
6. 把 `error.message` 从客户端响应中移除，只返回错误码。
7. 在 README/部署文档中明确写：**本面板的安全边界 = 本机单用户 loopback**。

---

## 11. 审核限制

- 本报告是作者自审，不是独立安全审计；没有做形式化验证、模糊测试或渗透测试。
- 未审计 DSH `webServer` 的 HTTP 解析与 TLS 终止；这些属于上游。
- 未审计 bili 的 HTTP 服务；只验证了本插件对它的只读调用。
- 未验证所有浏览器/代理组合；`Sec-WebSocket-Protocol` 在部分企业代理上可能被改写或记录。
- 动态验证只在本机 loopback 进行；没有在多人、远程、HTTPS 终止场景下测试。

---

## 12. 代码位置索引

| 内容 | 位置 |
|---|---|
| WebSocket 握手/帧/心跳/限流 | [`lib/ws.js`](../lib/ws.js) |
| `/api/ws-token`、`registerUpgrade`、1 秒广播、dispose | [`lib/index.js`](../lib/index.js) |
| 浏览器连接、重连、下载 Markdown/PNG | [`client.js`](../client.js) |
| WebSocket 单元测试 | [`test/ws.test.js`](../test/ws.test.js) |
| 路由/客户端契约测试 | [`test/plugin.test.js`](../test/plugin.test.js) |
| 真实握手探针 | [`tools/ws-probe.mjs`](../tools/ws-probe.mjs) |
| 运行状态与 bili 账本 | `http://127.0.0.1:51890/auto-context-compression/api/status` |
| WebSocket token | `http://127.0.0.1:51890/auto-context-compression/api/ws-token` |
