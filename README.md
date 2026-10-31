# 自动上下文压缩（Auto Context Compression）

> [English](./README.en.md) | 简体中文

面向 DeepSeek Harness 的插件：在上下文窗口被填满之前主动压缩长会话，并在 Web UI 的 **压缩** 标签页里展示上下文压力、缓存命中、压缩收益与花费估算。

在没有其他压缩网关的 profile 中，DeepSeek Harness 自带的 `compaction-basic` 会在压力达到约 **80%**（并受输出预留与 headroom 上限约束）时自动压缩。本插件把同一个持久化压缩引擎的触发点提前到可配置的 **50%**，并在摘要之前先做确定性的工具结果裁剪，让长会话更早、更平滑地回落到目标水位。

插件只使用 Harness 已有的公开能力：`agent/pre-step`、`ctx.tokenMeter`、`ctx.toolResultPruner` 与 `ctx.compaction.compactRegion`。它不新增 Session 事件类型，也不改写模型请求，因此 fork / resume / replay / `/compact` 都保持兼容。

> **本机 profile 的实际情况**：当前安装了 `billion-context`，它会在 wire 层接管自动压缩，并主动禁用原生 `compaction-basic` / `command-compact`。此时本插件的**主动压缩策略保持待命**，避免与 bili 的 checkpoint 冲突；Web 面板会改用 bili 的账本展示真实收益。若卸载 bili 或恢复原生 compaction 服务，主动策略会自动恢复。详见 [与 billion-context 的关系](#与-billion-context-的关系)。

## 代码结构

- [`lib/index.js`](lib/index.js)：Host 入口、pre-step 策略、状态与 HTTP/WS 路由；
- [`lib/policy.js`](lib/policy.js)：压缩区间选择与配置校验（核心，保持单文件）；
- [`lib/ws.js`](lib/ws.js)：WebSocket 握手、帧解析、限流与心跳（协议核心，保持单文件）；
- [`lib/bili.js`](lib/bili.js)：billion-context 账本读取、响应体上限与字段裁剪；
- [`lib/client-registration.js`](lib/client-registration.js)：客户端半区的启动注册与只读诊断（隔离 DSH 私有 API）；
- [`client.js`](client.js)：原生 React 面板、实时连接、报告/图片下载。DSH 的 `dsh.client` 只加载一个 bundle，因此保持单文件，不引入构建步骤。

## 工作方式

每个 Agent 的每个 `agent/pre-step`：

1. 用 `tokenMeter.measure(session)` 计算当前请求压力，并从 `session.requestContext().contextWindow` 读取上下文窗口。
2. 低于触发比例（默认 50%）时直接放行。
3. 超过触发比例时，先调用 `toolResultPruner.pruneSession()` 裁剪超大的工具结果；如果裁剪后已低于触发线，就跳过摘要。
4. 仍然超线时，选择一段**连续、工具调用配对完整**的旧历史：
   - 优先选择最旧的、未被保留的完整轮次；
   - 如果只有一个很长的进行中轮次，则选择该轮次中“已完成步骤”的前缀；
   - 表面已被替换过（例如已经压缩/裁剪过）时，退化为按表面顺序选择“从头到安全切点”的前缀。
5. 调用 `compaction.compactRegion(start, end, agent, signal)`，由 Harness 的压缩引擎完成摘要、持久化替换与 token 记账。
6. 保留最近 `keepRecentTurns` 个完整轮次，以及至少 `keepRecentTokens` 的原文尾部。

默认每次把压力从 50% 压到约 35%。内置的 80% 策略仍然保留，作为最后一道安全网。

## 安装

在 Harness Web UI 的插件管理器中安装本仓库。`install_bundle` 的 target 必须是绝对路径；在本仓库根目录执行 `(Resolve-Path .).Path`，把输出作为 target 即可。

安装后：

- 插件清单中会出现 **自动上下文压缩 / Auto Context Compression**；
- 新会话与已存在会话都会挂上预检观察器；
- 原生 compaction 可用时，模型请求前会自动执行上述流程；被 bili 接管时会跳过并记录原因；
- 会话页的标签栏会增加 **压缩**（`auto-context`）页，位置在 **轨迹** 与 **上下文** 之间。

## Web 面板

**压缩** 标签页是原生 React 视图（不是 iframe），通过同源 WebSocket 接收 Host 的只读状态推送，正常情况每 1 秒一帧；不再轮询：

```text
GET  /auto-context-compression/api/ws-token
WS   /auto-context-compression/ws
```

`ws-token` 返回本次进程的临时能力令牌；浏览器用 `new WebSocket(url, ["dsh-auto-context-v1", token])` 握手，随后发送 `{"type":"hello"}` 订阅。连接断开时客户端指数退避重连（0.5 秒→10 秒），不需要刷新页面。HTTP 的 `/api/status` 仍保留，用于调试、外部探测和 `curl`。

面板包含：

- **基本信息**：标题、会话 id、协议、客户端、引擎、上游、代理版本、插件版本、存储模式、压缩提示包、上下文水位、压缩阈值、主动策略状态、状态/配置文件路径；
- **用量统计**：请求、输入 token、缓存命中 token、缓存命中率、输出 token、压缩节省、压缩回本、花费（美元）、最近单次输入；
- **下载**：`下载报告` 生成 Markdown，`下载图片` 在浏览器 canvas 里绘制 PNG；两者都由当前页面数据本地生成，不上传到服务器；
- 金额按 DeepSeek 参考单价估算（输入 $0.15 / 缓存读 $0.003 / 输出 $0.60 每百万 token），只用于判断压缩是否划算，不是账单。

当 `billion-context` 存在时，接口优先采用它的 per-session 账本（`requests/inputTokens/cachedTokens/outputTokens/netSaved/savedUsd/costUsd/payback`），因此绿色卡片显示的是 bili 实际压缩收益；否则回退到本插件自己聚合的 DSH `assistant/message` 与 `compaction/summary` 数据。`status.json` 仍然是纯文件诊断通道，不依赖 Web 服务。

## 命令

在任意会话中输入：

```
/autocompact                # 等同 status
/autocompact status         # 当前 token 压力、触发线、缓存命中率、已压缩次数
/autocompact cache          # 缓存命中/未命中的 token 明细
/autocompact on             # 本会话开启自动压缩
/autocompact off            # 本会话关闭自动压缩
/autocompact threshold 45   # 本会话触发线改为 45%
/autocompact threshold 0.45 # 同上
/autocompact target 20      # 本会话压缩目标改为 20%（必须低于触发线）
/autocompact config         # 查看生效配置
```

`on` / `off` / `threshold` / `target` 是**本会话、本进程内**的覆盖，重启后回到配置默认值。

## 缓存命中与未命中率

`/autocompact status` 会显示一行摘要：

```text
Cache: 90.6% hit / 9.4% miss (29 req; last 94.2%)
```

`/autocompact cache` 显示明细：

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

计算口径（来自会话里每次 `assistant/message` 的 `usage`）：

- `promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`
- `hitRate = cacheReadTokens / promptTokens`
- `missRate = (inputTokens + cacheWriteTokens) / promptTokens`

其中 `inputTokens` 是未命中缓存的输入，`cacheReadTokens` 是命中前缀缓存的部分，`cacheWriteTokens` 是本次写入缓存、仍属于未命中的部分。压缩摘要这类辅助调用记录在 `compaction/summary`，不计入主对话命中率。适配器不返回缓存字段时显示 `no provider usage recorded yet`。

同样的数据也会写入 `status.json` 的 `sessions[].cache`，便于外部监控。

## 用配置文件自定义触发线（推荐）

插件首次加载时会在以下位置生成用户配置文件：

```
$DSH_HOME/auto-context-compression/config.json
```

Windows 下 `$DSH_HOME` 通常等于 `$env:USERPROFILE\.dsh`，即：

```
$env:USERPROFILE\.dsh\auto-context-compression\config.json
```

文件是一个 JSON 对象，可以只写想改的键，也可以保留完整模板。例如把触发线改到 35%、目标压到 20%：

```json
{
  "triggerRatio": 0.35,
  "targetRatio": 0.2
}
```

保存后**不需要重启或重装**：插件每个 `agent/pre-step` 最多每 500ms 直接读取一次文件，下一次模型请求就会使用新值。`/autocompact status` 和 `/autocompact config` 会立即强制重新读取。

合并优先级（从高到低）：

1. 当前会话的 `/autocompact threshold` / `/autocompact target` 覆盖；
2. `config.json`；
3. bundle 的 `cordis.patch.yml` 与 profile patch 中的默认值。

如果 JSON 格式错误、出现未知键、或比例不合法，插件会保留上一份有效配置，在日志中警告，并在 `status.json` 的 `configFile.lastError` 和 `/autocompact status` 中显示错误，不会阻断对话。把 `configFile` 设为 `false` 可关闭文件覆盖（只使用 patch 配置）。

## 配置

配置位于 `cordis.patch.yml` 的 `auto-context-compression` 行；也可以在 profile 的 `cordis.patch.yml` 中按 id 覆盖。

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 新会话的默认开关 |
| `triggerRatio` | `0.5` | 达到该压力比例后考虑压缩，必须大于 `targetRatio` |
| `targetRatio` | `0.35` | 目标压力比例，用于决定压缩多少旧历史 |
| `keepRecentTurns` | `2` | 原样保留的最近完整轮次数 |
| `keepRecentTokens` | `12000` | 原样保留的最近 token 尾部下限 |
| `minCompactionTokens` | `8000` | 小于该 token 量的候选区间不值得摘要 |
| `minGrowthTokens` | `8000` | 上次压缩后至少再增长这么多 token 才再次压缩 |
| `cooldownMs` | `60000` | 两次压缩尝试之间的最小间隔 |
| `pruneToolResults` | `true` | 摘要前先裁剪超大的工具结果 |
| `fallbackContextWindow` | `0` | 无法读取窗口时的后备窗口；`0` 表示不猜 |
| `statusFile` | `true` | 写入诊断状态文件 |
| `configFile` | `true` | 允许 `$DSH_HOME/auto-context-compression/config.json` 覆盖配置 |
| `biliOrigin` | `http://127.0.0.1:18787` | billion-context 本地统计源；仅允许 loopback HTTP(S)，设为 `""` 可关闭 |
| `logLevel` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `excludeSessionIds` | `[]` | 永不自动压缩的会话 id 列表（例如正在调试的会话） |

所有键都是可选的；未知键会在插件加载时报错，避免拼写错误静默关闭保护。

`excludeSessionIds` 是硬排除：被排除的会话即使执行 `/autocompact on` 也不会自动压缩；从配置中移除 id 后才会恢复。

## 状态文件

启用 `statusFile` 时，插件会维护：

```
$DSH_HOME/auto-context-compression/status.json
```

包含插件版本、生效配置、`configFile` 路径/最近错误/最近重载时间、全局统计，以及最近 30 个会话的 token 数、窗口、压力比例、缓存命中/未命中明细（`sessions[].cache`）、压缩次数、节省 token、最近一次跳过原因与错误。它只记录数字与会话 id，不记录对话内容。可用它确认插件确实在每次请求前执行、配置文件是否被接受，以及为什么没有压缩。

## 与 billion-context 的关系

`billion-context` 的 bundle patch 会：

- 把 HOST-PLANE 的 `compaction-basic` 设为 `auto: false`，并禁用嵌套的 `@deepseek-ai/dsh-compaction-basic` / `@deepseek-ai/dsh-command-compact`；
- 通过 `bili-compaction-gate` 提供自己的 gate 服务，在 wire 层做自动压缩；
- 特意保留 `bili-compaction-gate` 常开，否则使用其 preset 的会话会一直等待 gate。

因此在本机 profile 中：

- `agentPresets.serviceFor(agent, 'compaction')` 返回 `undefined`，面板的 `主动策略` 会显示 **待命（压缩由 billion-context 接管）**，这是正确状态，不是插件故障；
- 面板的绿色收益卡片改为读取 bili 的 `/__bili/sessions/<id>/detail` 账本，和 bili 自带的“上下文”页使用同一份数据；
- 不要同时强行打开 `compaction-basic` 和 bili gate：两套 checkpoint 会互相覆盖，bili 也会再次把原生行关掉。

要让本插件自己的主动策略接管压缩，需要在 profile 中停用 billion-context（包括 `bili-compaction-gate`），并确认 `compaction-basic` 可用。两种模式二选一，不建议并存。

## 安全边界

- **不新增事件类型**：只走 Harness 既有的 `compaction/*` 事务。
- **不拆工具调用**：前缀选择要求工具调用与结果完全配对；不满足就向前回退切点。
- **不动进行中的步骤**：当前未完成轮次/步骤默认保留；只压缩已完成的边界。
- **不阻塞对话**：任何测量、规划、裁剪、摘要失败都只记录并继续 `next()`；原生 compaction 可用时它仍是最后安全网。
- **不重复造摘要**：摘要由 `compaction-basic` 的持久化引擎执行；本插件只决定何时、压缩哪一段。原生服务不可用时（例如被 bili 接管）主动策略直接待命，不会自行生成摘要。
- **单轮次保护**：一个从未出现 `step/end` 的单步轮次没有安全切点，本插件会跳过，交给内置策略。
- **WebSocket 只读**：只支持 `hello` / `snapshot` / `ping`，不执行客户端指令，不读写客户端指定路径；Origin 必须是同源 loopback，另需进程级 token。
- **本机信任边界**：`/api/ws-token` 没有用户登录态；本机任意进程可取 token。面板仅适合单用户 loopback，不要把 GUI 端口暴露到局域网/公网。详见 [WEBSOCKET_REVIEW.md](./WEBSOCKET_REVIEW.md)。

## 验证

```powershell
cd <仓库根目录>
node --check lib/index.js
node --check lib/policy.js
node --check lib/ws.js
node --check lib/bili.js
node --check lib/client-registration.js
node --check client.js
node --test test/*.test.js   # 40 passed
```

测试覆盖：

- 配置校验（未知键、比例、整数、日志级别、排除列表）；
- 轮次/步骤分段，以及落在轮次内部的 system 头保护；
- 保留最近轮次与 token 尾部；
- 单轮次已完成步骤前缀；
- 替换节点之后的表面顺序回退；
- 工具调用配对；
- `agent/pre-step` 压缩路径、失败隔离、`next()` 恒被调用；
- 会话排除；
- `config.json` 热加载：改触发线无需重载、错误文件被忽略并上报；
- 缓存命中率聚合与 `/autocompact cache` 明细；
- 压缩摘要 usage 聚合；
- 状态 HTTP 路由（只读、GET/405/404）；
- `/api/ws-token`、`registerUpgrade` 挂载、跨站请求 403、状态不泄露 token；
- WebSocket 握手、Origin/Token 拒绝、掩码/分片/大小限制、非法 capability 401；
- Web 客户端契约（原生 `conversation.view`、`new WebSocket`、Markdown/PNG 下载、无 iframe）；
- bili 统计源校验与规范化；
- `/autocompact` 的 status / cache / on / off / threshold / target / config。

安装后的真实验证可查看 `status.json`：`sessions[]` 中应出现当前会话，并随每次模型请求更新 `tokens` 与 `lastSkipReason`。在原生 compaction 可用的 profile 中，压力超过触发线时 `compactions` 与 `tokensSaved` 会增加，日志中出现 `auto-context-compression: compacted ...`；当前 bili 接管的 profile 中主动策略会显示 `no-compaction-service`，这是预期行为。

2026-10-31 已用一次性子代理做过真实压缩验证（当时原生 compaction 仍可用）：临时阈值 2%、排除交互会话后，子代理会话产生了完整的 `compaction/start → compaction/summary → user/message(replace) → compaction/end` 事务，节省 14,371 tokens，且子代理仍正常完成回答。随后已恢复 50% / 35% 的生产配置。证据见 [VERIFICATION.md](./VERIFICATION.md)。

## 已知限制

- 配置通过 `$DSH_HOME/auto-context-compression/config.json`、`cordis.patch.yml` 或 `/autocompact threshold` / `/autocompact target` 调整；Web 面板是只读观测页，不提供写配置。
- `on` / `off` / `threshold` / `target` 的会话级覆盖不持久化，重启后回到配置默认值。
- 压缩粒度受安全边界约束：只有一个进行中步骤时不会压缩该步骤；它会在下一步完成、或原生 80% 策略触发时处理。
- 缓存命中率只统计主对话的 `assistant/message` usage，不包含压缩摘要辅助调用；模型适配器不返回 `cacheReadTokens` / `cacheWriteTokens` 时无法计算。
- 摘要质量取决于当前路由模型的总结能力；插件不替换模型、不改写 prompt。
- 当前 profile 的线上压缩由 billion-context 完成；主动策略在原生 compaction 服务恢复前不会执行。
- 面板金额使用固定参考单价，bili 账本返回的是它自己的估算值；两者都不是账单。
- WebSocket token 是进程级能力令牌，不绑定标签页或会话；本机同用户进程可读取 token，因此安全边界是 loopback 单用户，不是多租户认证。不要做端口转发。
- 客户端 bundle 依赖 `clientModules` 的启动扫描；运行中热装插件时，本插件会尝试用兼容路径注册自身（使用了 DSH 私有 API）。若 DSH 升级后标签页消失，刷新或重启 Host；长期方案是改用上游公开的客户端扫描机制。
- 实时面板需要页面加载一次新的 client bundle；之后数据推送、重连、下载都不需要刷新页面。

## 文档

- [GITHUB.md](GITHUB.md)：上传到 GitHub 的完整命令清单；
- [SECURITY_REVIEW.md](SECURITY_REVIEW.md)：全项目安全审查报告；
- [WEBSOCKET_REVIEW.md](WEBSOCKET_REVIEW.md)：WebSocket 专项自审；
- [VERIFICATION.md](VERIFICATION.md)：测试与真实验证记录。

英文版：

- [README.en.md](README.en.md)
- [GITHUB.en.md](GITHUB.en.md)
- [SECURITY_REVIEW.en.md](SECURITY_REVIEW.en.md)
- [WEBSOCKET_REVIEW.en.md](WEBSOCKET_REVIEW.en.md)
- [VERIFICATION.en.md](VERIFICATION.en.md)
