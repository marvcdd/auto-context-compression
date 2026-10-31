# 全项目安全审查报告

> [English](./SECURITY_REVIEW.en.md) | 简体中文

日期：2026-10-31  
审查对象：`dsh-auto-context-compression@0.1.0` 全仓库  
审查方式：源码逐行审查、静态扫描、单元测试、本机 loopback 真实握手与推送验证  
报告性质：作者自审，不是独立第三方安全审计；结论用于上线前自查和外部复查

## 目录

- [1. 执行摘要](#1-执行摘要)
- [2. 范围与方法](#2-范围与方法)
- [3. 架构与信任边界](#3-架构与信任边界)
- [4. 攻击面清单](#4-攻击面清单)
- [5. 发现汇总](#5-发现汇总)
- [6. 详细发现](#6-详细发现)
- [7. 已修复项](#7-已修复项)
- [8. 测试与验证](#8-测试与验证)
- [9. 部署清单](#9-部署清单)
- [10. 审查限制](#10-审查限制)
- [11. 文件索引](#11-文件索引)

## 1. 执行摘要

本项目是一个 DSH Host 插件，外加一个通过 `conversation.view` 注册的原生 Web 面板。核心风险不在对话压缩逻辑，而在**本机 Web 能力面**：

- 默认只监听 loopback，WebSocket 只读，不能执行客户端指令、不能读写客户端指定路径；
- `/auto-context-compression/api/ws-token` **没有用户认证**，本机任意进程可以取得 token；非浏览器客户端还能伪造 `Origin`。因此安全边界是“本机单用户”，不是多租户认证；
- 客户端 bundle 注册依赖 DSH `clientModules` 的**私有 API**，DSH 升级可能破坏启动图或产生重复入口；
- 本次已修复/缓解：bili 响应体大小上限、WebSocket 内部错误外泄、`close()` 参数、公开 GET 触发 boot graph 变更、bili 超时/缓存；
- 40 个测试全部通过；本机真实握手能收到两帧推送；未发现硬编码密钥、命令执行、`eval`/`new Function`、`innerHTML` 或运行时 npm 依赖。

**上线结论**：单用户 loopback 可以运行；**不要把 GUI 端口转发到局域网/公网**。如果必须远程访问，应在带认证的 HTTPS 反向代理后使用，并额外限制 `/auto-context-compression/*` 与 WebSocket 路径。

## 2. 范围与方法

审查文件：

- [`lib/index.js`](lib/index.js)：Host 插件、HTTP 路由、WebSocket 挂载、bili 读取、状态文件、客户端注册；
- [`lib/policy.js`](lib/policy.js)：配置校验与压缩计划；
- [`lib/ws.js`](lib/ws.js)：WebSocket 握手、帧解析、限流、心跳、广播；
- [`client.js`](client.js)：原生 React 面板、连接/重连、Markdown/PNG 下载；
- [`package.json`](package.json)、[`cordis.patch.yml`](cordis.patch.yml)、[`icon.svg`](icon.svg)、[`locale/`](locale/) 与测试；
- [`README.md`](README.md)、[`VERIFICATION.md`](VERIFICATION.md)、[`WEBSOCKET_REVIEW.md`](WEBSOCKET_REVIEW.md)。

方法：

1. 逐段审查认证、Origin、token、输入解析、错误处理、文件读写和客户端渲染；
2. `node --check` 检查全部入口；
3. `node --test test/*.test.js` 运行 40 个测试；
4. 扫描硬编码密钥、`child_process`、`eval`、`new Function`、`innerHTML`、动态依赖和安装脚本；
5. 在本机 loopback 上完成 token 获取、101 握手、一次 `hello`、两帧 snapshot 的真实验证；
6. 对 bili 的只读 HTTP 调用做固定路径、loopback、超时、缓存和响应大小检查。

未做：形式化验证、模糊测试、独立渗透测试、多人/远程/HTTPS 终止场景、DSH 上游 `webServer` 的 HTTP 解析与 TLS 终止审计。

## 3. 架构与信任边界

```text
DSH Host 进程
  ├─ agent/pre-step 压缩策略（本插件）
  ├─ webServer
  │    ├─ GET /auto-context-compression/api/status
  │    ├─ GET /auto-context-compression/api/ws-token
  │    └─ WS  /auto-context-compression/ws
  ├─ clientModules 私有 API → 注册 client.js
  ├─ status.json / config.json（$DSH_HOME）
  └─ bili loopback HTTP 127.0.0.1:18787（只读 detail）
        ↑
浏览器同源页面（DSH Web GUI）
  └─ 原生 React 面板 + fetch token + WebSocket + 本地下载
```

信任边界：

- **本机 OS 用户**：能读 token、能访问 loopback 端口，视为受信；
- **同源浏览器页面**：通过 `Origin`、`Sec-Fetch-Site` 与 token 约束，但 token endpoint 本身无登录态；
- **DSH Host / profile**：受信；profile 内其他插件理论上也能读文件/端口，属于同层信任；
- **bili 本地服务**：只读、固定路径、loopback；其返回内容视为不可信输入，做字段归一化与大小限制；
- **外部网络**：默认不可达；一旦端口转发，必须重新评估为不可信网络。

## 4. 攻击面清单

| 面 | 入口 | 能力 |
| --- | --- | --- |
| HTTP 状态 | `GET /api/status` | 读取会话标题、token 压力、缓存、bili 统计、配置路径 |
| HTTP 能力 | `GET /api/ws-token` | 返回进程级 WebSocket token |
| WebSocket | `/ws` | 只读 snapshot；接受 `hello` / `snapshot` / `ping` |
| 客户端 bundle | `clientModules` 注册 | 在页面内执行本项目 `client.js` |
| 下载 | 浏览器本地 Blob | 生成 Markdown/PNG，含会话元数据 |
| 配置 | `config.json` / patch | 可改触发线、biliOrigin、排除列表 |
| 状态文件 | `status.json` | 写入数字、会话 id、绝对路径、错误 |
| 上游 | bili `localhost:18787` | 固定 `/__bili/sessions/<id>/detail` GET |

不存在：任意文件读写、命令执行、模型请求改写、压缩事务由客户端触发、WebSocket 二进制/扩展协商。

## 5. 发现汇总

| ID | 严重度 | 组件 | 状态 | 摘要 |
| --- | --- | --- | --- | --- |
| S-01 | 高（仅端口暴露时） | `/api/ws-token` | 接受/部署约束 | 无用户认证；本机进程可取 token，非浏览器可伪造 Origin |
| S-02 | 高（兼容/供应链） | `clientModules` | 接受 | 依赖 DSH 私有 API 注入/重建客户端入口 |
| S-03 | 中 | status/WS | 接受 | 无会话级授权；显式 `sessionId` 未命中时回退到最新 agent |
| S-04 | 中 | `/api/status` | 缓解 | 每次 GET 触发测量与 bili 读取，无速率限制 |
| S-05 | 中 | WebSocket | 接受 | 只有全局 `maxClients=8`，无 per-IP/握手速率限制 |
| S-06 | 中 | token/传输 | 接受 | loopback HTTP 无 TLS；token 出现在 `Sec-WebSocket-Protocol` |
| S-07 | 中（部署） | HTTP 监听 | 接受/部署约束 | 若 GUI 绑定非 loopback，HTTP 状态/token 面随之暴露 |
| S-08 | 低 | bili 读取 | 缓解 | `biliOrigin` 可指向本机其他 HTTP 服务；固定路径限制 SSRF |
| S-09 | 低 | 状态/配置文件 | 接受 | 含会话 id、绝对路径、错误；依赖 OS ACL |
| S-10 | 低 | 错误处理 | 部分修复 | HTTP 500 与 WS 已通用化；`biliError` 仍可能含本机错误 |
| S-11 | 低 | WS 帧解析 | 接受 | 4×frame 上限可能误关合法大流水；无 `drain` 刷新 |
| S-12 | 低 | CSRF | 接受 | token endpoint 仅靠可选 `Sec-Fetch-Site`，非浏览器可绕过 |
| S-13 | 低 | 下载 | 接受 | Markdown/PNG 含标题、会话 id、路径等元数据 |
| S-14 | 低 | 审计 | 接受 | 不记录 token 签发/连接审计；仅 debug 日志 |
| S-15 | 低 | 状态写盘 | 接受 | `writeFile` 非原子，读取方可能看到半截 JSON |
| S-16 | 低 | 客户端完整性 | 接受 | 依赖同源 Host 提供的 bundle，无 SRI 签名 |
| S-17 | 低 | WS snapshot 请求 | 接受 | 客户端可发 `snapshot` 触发一次构建；50 条/秒限流 |
| S-18 | 信息 | 密钥/依赖/渲染 | 通过 | 无硬编码密钥、无运行时依赖、无 `innerHTML`/`eval` |

## 6. 详细发现

### S-01 未认证的 WebSocket 能力端点

**位置**：[`lib/index.js`](lib/index.js) 中 `/api/ws-token` 分支；[`lib/ws.js`](lib/ws.js) 的 Origin/token 校验。

**证据**：

```text
GET /auto-context-compression/api/ws-token
-> {ok:true, value:{path, protocol, token}}
```

该路由只检查 `GET` 和可选的 `Sec-Fetch-Site`，没有 DSH 用户会话、cookie 或签名。token 是进程级 32 字节随机值，不绑定标签页/会话；WebSocket 握手只验证：
`Origin` 为 loopback 同协议同端口，`Sec-WebSocket-Protocol` 为 `[协议, token]`。

**影响**：本机任意进程（包括另一个用户同一 Windows 会话下的进程、或能读环境/端口的本地脚本）可以取得 token；非浏览器客户端可自行设置 Origin。能读到的仅是面板数据（标题、用量、bili 账本、配置路径），**不能触发压缩、不能写文件、不能调用模型**。若 51890 被端口转发，远程攻击者可在无认证情况下读取同样的数据。

**处置**：接受为“loopback 单用户”边界；README、报告和上线清单均明确禁止端口转发。远程场景应放在认证反向代理后，并额外限制该前缀。

### S-02 clientModules 私有 API 依赖

**位置**：[`lib/index.js`](lib/index.js) 的 `clientDiagnostics()` / `ensureClientRegistration()`。

**证据**：注册使用 `ctx.get('clientModules')` 的公开图查询，但实际修复路径访问 `ctx.reflect.get('clientModules')` 的 `sources`、`reconcilePackage`、`compose`、`notifyGraphChanged`、`rebuilt`。这些不是稳定公开契约。

**影响**：DSH 升级后可能：启动图不包含本插件、重复入口、或 `rebuilt` 抛错。最坏情况是面板不出现或页面加载错误；由于注入的是本仓库 [`client.js`](client.js)，不会直接引入新的远程代码执行面。若 DSH 未来改变 bundle 解析语义，应优先改用公开的 `dsh.client` 扫描/热更新机制。

**处置**：接受并记录；启动时只执行一次，公开 `debug=1` 路由不再触发写操作。升级 DSH 后必须回归“`conversation.view` 中存在 `auto-context`”与 `clientPath` 非空。

### S-03 缺少会话级授权

**位置**：[`lib/index.js`](lib/index.js) 的 `findAgent()` 与 `buildLiveValue()`。

**证据**：`findAgent(sessionId)` 精确匹配 `agent.id` 或 `agent.session.id`；未命中时返回 `agents[agents.length - 1]`。HTTP 和 WS 都可传任意 `sessionId`。

**影响**：同一 Host 内可读取其他会话的标题、token 压力、缓存与 bili 账本；但只能在已获得 token/同源访问的前提下。它是信息暴露，不是会话篡改。多用户或多租户部署下不可接受。

**处置**：接受为单用户边界；后续可改为“显式 id 未命中返回 404”，并将 token 绑定到会话。

### S-04 状态接口无速率限制

**位置**：[`lib/index.js`](lib/index.js) 的 `handleStatusRequest()` → `refreshState()` → `tokenMeter.measure()` + `fetchBiliDetail()`。

**影响**：同源页面或本机脚本可高频 GET，触发 token 测量和 bili 请求，造成 CPU/文件句柄压力。当前有 2 秒 bili 缓存、1200ms 超时、8MiB 响应上限，但没有 HTTP 层令牌桶。

**处置**：缓解而非根除。生产可加 per-IP/每连接速率限制；本机单用户风险较低。

### S-05 连接数与握手无限速

**位置**：[`lib/ws.js`](lib/ws.js) 的 `maxClients` 与握手路径。

**影响**：全局最多 8 个客户端，但没有 per-IP 限制；攻击者可快速重连、占满 8 个槽位，或反复触发 101/401 握手消耗 CPU。已限制单连接 50 条消息/秒、心跳/空闲回收。

**处置**：接受；远程部署时在反向代理层加连接/握手限制。

### S-06 loopback HTTP 与 token 位置

**位置**：[`client.js`](client.js) 的 `new WebSocket(url, [protocol, token])`；[`lib/ws.js`](lib/ws.js) 的协议选择。

**影响**：本地 HTTP 无 TLS；token 出现在 `Sec-WebSocket-Protocol` 请求头，可能被企业代理、浏览器扩展或调试日志记录。token 在插件进程生命周期内不变，重放窗口较长。

**处置**：接受为 loopback 单用户；远程必须 HTTPS，并缩短 token TTL、绑定会话/标签页。

### S-07 非 loopback 监听

**位置**：DSH `webServer` 的绑定配置，不在本仓库内。

**影响**：如果 DSH GUI 监听 `0.0.0.0` 或被反向代理到公网，`/api/status` 与 `/api/ws-token` 会随同暴露；WS 的 `Origin` 检查会因 server origin 非 loopback 而拒绝，但 HTTP 读取仍然可达。

**处置**：部署前确认 `webServer.getOrigin()` 为 `127.0.0.1`/`localhost`；不要把 51890 直接映射到公网。

### S-08 biliOrigin 的本机 SSRF 面

**位置**：[`lib/policy.js`](lib/policy.js) 的 `biliOrigin` 校验；[`lib/index.js`](lib/index.js) 的 `fetchBiliDetail()`。

**证据**：只允许 `http/https` 且 host 为 `127.0.0.1`、`localhost`、`::1`；路径固定为 `/__bili/sessions/<encoded id>/detail`；2 秒缓存、1200ms 超时、8MiB 响应上限。

**影响**：配置者可让插件请求本机其他 HTTP 服务的固定路径，但无法指定任意路径/方法/请求体；响应只用于展示。配置本身已在 Host 信任层，风险低。

**处置**：缓解；若未来支持远程 bili，需要 allowlist 和认证。

### S-09 状态/配置文件中的元数据

**位置**：[`lib/index.js`](lib/index.js) 的 `writeStatus()`、`ensureDefaultConfigFile()`。

**影响**：`status.json` 含会话 id、绝对路径、最后错误、配置；`config.json` 含 biliOrigin、排除列表。它们依赖 `$DSH_HOME` 的 OS ACL；没有显式 chmod/加密。

**处置**：接受；确保 `$DSH_HOME` 仅当前用户可读；不要把状态文件提交到 Git。

### S-10 错误信息外泄

**位置**：[`lib/index.js`](lib/index.js) 的 HTTP 500 与 `biliError`；[`lib/ws.js`](lib/ws.js) 的 snapshot 错误。

**现状**：HTTP 500 已改为通用 `internal error` 并记录日志；WS snapshot 已改为 `snapshot unavailable`；`biliError` 仍会返回本机 bili 的连接/HTTP 错误文本。

**影响**：错误文本可能暴露本机端口、文件路径或内部状态；读取者已在同源/本机信任边界内。

**处置**：HTTP/WS 已修复；`biliError` 作为诊断保留，低风险。

### S-11 帧解析与背压边界

**位置**：[`lib/ws.js`](lib/ws.js) 的 `FrameParser`、`pushSnapshot()`、`closeClient()`。

**观察**：

- 解析器把缓冲上限设为 `maxFramePayload * 4`；一个合法的超大流水 chunk 可能被误判为超限并关闭；
- `socket.write()` 返回 false 时没有 `drain` 回调，只依赖下一次 `writableLength` 检查跳过；
- socket 错误只记 debug 日志，客户端对象要等下次广播/心跳才清理。

**影响**：主要是可用性/资源问题，不是越权；单用户可自行触发。

**处置**：接受；后续可加 `drain` 事件与即时清理。

### S-12 CSRF 保护不完整

**位置**：[`lib/index.js`](lib/index.js) 的 `Sec-Fetch-Site` 检查。

**影响**：`Sec-Fetch-Site` 是可选的浏览器头；`curl`、本地脚本可以不带。由于 token endpoint 本身无认证，真正的防线是 loopback + token；不能把它当作 CSRF 认证。

**处置**：接受；与 S-01 同一信任边界。

### S-13 下载文件包含元数据

**位置**：[`client.js`](client.js) 的 `downloadReportFile()` / `renderReportImage()`。

**影响**：导出的 Markdown/PNG 含标题、会话 id、路径、用量与 bili 账本；文件由用户主动保存，不会自动上传。

**处置**：接受；README 提示不要把导出文件公开分享。

### S-14 缺少连接审计

**位置**：[`lib/ws.js`](lib/ws.js)、[`lib/index.js`](lib/index.js)。

**影响**：只记录挂载/警告，不记录 token 签发、连接来源、拒绝原因计数；事故追溯能力有限。

**处置**：接受；高安全场景可增加结构化审计日志（不要记录 token 本身）。

### S-15 状态文件非原子写

**位置**：[`lib/index.js`](lib/index.js) 的 `writeStatus()`。

**影响**：`writeFile` 期间读取方可能看到截断 JSON；不是安全漏洞，但会影响外部监控。

**处置**：接受；可改为临时文件 + rename。

### S-16 客户端 bundle 完整性

**位置**：[`lib/index.js`](lib/index.js) 的 `clientPath` 注册、[`client.js`](client.js)。

**影响**：浏览器从同源 Host 加载 `client.js`；没有 SRI/签名，信任根是本地包与 DSH bundle 路由。能改包的人已经能在 Host 执行代码，因此不构成额外提权，但供应链审计需覆盖 npm 包/本地链接。

**处置**：接受；发布时固定版本并审查包内容。

### S-17 客户端可触发 snapshot 构建

**位置**：[`lib/ws.js`](lib/ws.js) 的 `message.type === 'snapshot'`。

**影响**：连接者可请求一次即时构建，触发 `refreshState()`/bili 读取；受 50 条/秒限制和 8 客户端限制。属于本地资源消耗，不是数据越权。

**处置**：接受。

### S-18 密钥、依赖与渲染

- 全仓库扫描未发现私钥、云 token、GitHub token、`sk-` 密钥或硬编码密码；
- `package.json` 无 `dependencies` / `devDependencies`，无 `postinstall`；
- `icon.svg` 是静态 SVG，不含 `<script>`；
- 客户端使用 React 文本节点，没有 `innerHTML`、`eval`、`new Function`；
- 无 `child_process` 调用。

## 7. 已修复项

| 项 | 修复 |
| --- | --- |
| bili 响应无界 | `response.text()` 后限制 8MiB，再 `JSON.parse`；保留 1200ms 超时与 2 秒缓存 |
| WS 内部错误外泄 | snapshot 失败只回 `snapshot unavailable`，细节写日志 |
| `close()` 参数被忽略 | 接受 `code`/`reason` 并转发给每个客户端 |
| 公开 GET 触发启动图变更 | 移除 `?rescan=1` 的写路径；`debug=1` 只读诊断 |
| HTTP 500 回显内部错误 | 改为 `internal error`，细节只写日志 |
| 重复首帧 | 握手后等客户端 `hello` 再推第一帧 |
| 关闭帧/控制帧校验 | 拒绝长度为 1 的 close payload、非法 close code、非 24 字符 key |
| Origin/token 校验 | loopback 同协议同端口、timing-safe token、严格协议数组 |
| 消息速率 | 每连接 50 条/秒；超限 1008 关闭 |

## 8. 测试与验证

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

结果：**40 passed, 0 failed**。覆盖：

- 配置校验（含 `biliOrigin` loopback 规范化/拒绝）；
- 压缩计划、system 头保护、工具配对、失败隔离；
- HTTP status/405/404、跨站 403、不泄露 token；
- WS 握手、错误 token 401、Origin 拒绝、掩码/分片/大小/限流；
- 客户端契约（`new WebSocket`、`downloadReportFile`、`renderReportImage`、无 iframe）；
- 真实 loopback：一次 `hello` 收到两帧 snapshot。

## 9. 部署清单

- [ ] 确认 DSH GUI 只监听 `127.0.0.1`，不要把 51890 映射到局域网/公网；
- [ ] 不要把 `/auto-context-compression/*` 暴露给不可信反向代理；
- [ ] 确认 `$DSH_HOME` 仅当前用户可读写；
- [ ] 不要把 `status.json`、`config.json`、导出的 Markdown/PNG 提交到 Git；
- [ ] 远程访问必须使用带认证的 HTTPS 反向代理，并评估把 token endpoint 改为用户会话认证；
- [ ] DSH 升级后回归：面板 tab 存在、`clientPath` 非空、WS 收到两帧、没有重复入口；
- [ ] 发布前运行 `node --check lib/index.js lib/policy.js lib/ws.js client.js tools/ws-probe.mjs` 与 `node --test test/*.test.js`，并检查 `git status` 无未预期文件。

## 10. 审查限制

- 本报告是作者自审，不是独立审计；
- 未审计 DSH `webServer` 的 HTTP 解析、TLS 终止和 `clientModules` 上游实现；
- 未审计 bili 服务本身，只验证本插件对它的固定 GET；
- 未做浏览器扩展、企业代理、恶意本地进程的实攻测试；
- 未做长时间 soak、fuzz、内存/句柄泄漏测试；
- 结论只适用于当前 commit 与 DSH 版本；升级后应重新审查。

## 11. 文件索引

| 内容 | 位置 |
| --- | --- |
| Host 路由、token、状态文件 | [`lib/index.js`](lib/index.js) |
| bili 账本读取与字段裁剪 | [`lib/bili.js`](lib/bili.js) |
| 客户端半区启动注册（DSH 私有 API） | [`lib/client-registration.js`](lib/client-registration.js) |
| 配置校验与压缩策略 | [`lib/policy.js`](lib/policy.js) |
| WebSocket 握手/帧/限流/心跳 | [`lib/ws.js`](lib/ws.js) |
| 原生面板、连接、下载 | [`client.js`](client.js) |
| WebSocket 专项报告 | [`WEBSOCKET_REVIEW.md`](WEBSOCKET_REVIEW.md) |
| 验证记录 | [`VERIFICATION.md`](VERIFICATION.md) |
| Git/GitHub 上传命令 | [`GITHUB.md`](GITHUB.md) |
| 真实握手探针 | [`tools/ws-probe.mjs`](tools/ws-probe.mjs) |
