# 验证记录（2026-10-31）

## 1. 构建与静态检查

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

测试覆盖：配置校验（含 `biliOrigin` loopback 校验/规范化）、轮次/步骤分段、system 头保护、保留尾部、单轮次前缀、替换节点回退、工具调用配对、pre-step 失败隔离、会话排除、`config.json` 热加载、缓存命中率聚合、压缩摘要 usage 聚合、状态 HTTP 路由、WebSocket 握手/帧上限/Origin/token、Web 客户端契约、`/autocompact` 全部子命令。

## 2. 安装与激活

通过 `plugin_manager` 的 `install_bundle` 安装：

```text
target: <仓库根目录>
package: dsh-auto-context-compression@0.1.0
application: applied
warnings: []
```

包以本地链接（`link:<仓库根目录>`）方式进入 profile；`list_bundles` 中状态为 `enabled: true, installed: true`。

## 3. 运行时观察（真实 Host）

`$DSH_HOME/auto-context-compression/status.json` 在安装后生成，并随每个 `agent/pre-step` 更新。示例（生产配置恢复前、临时测试配置期间）：

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

这证明了两件事：

1. 插件确实挂到了当前 Agent 的 `agent/pre-step`（`lastSeenAt` 随模型请求推进）；
2. 通过 `agentPresets.serviceFor(agent, 'compaction')` 找到了 preset 隔离组内的压缩服务（`available: true`）。

## 4. 真实压缩事务（一次性子代理）

为了避免压缩交互会话，临时配置：

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

然后启动一个只读子代理读取 `dsh-compaction-basic/lib/index.js`（1027 行）。子代理会话 `2bce9d16-d8fa-43ff-a328-02c127260df8` 的持久化日志中出现：

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

聚合结果：

```text
compactions: 1
tokensSaved: 14,371
ratio after: 1.07%
lastSkipReason: compacted
```

子代理仍正常完成了原任务并返回三行答案，证明压缩没有破坏工具调用配对或当前步骤。

### 修复记录

第一次真实探测在写入替换节点时失败：

```text
surface replace: node 0 holds the system prompt and may be rewritten only by
a system/message over exactly that node
```

原因：部分会话把 `system/message` 追加在 `turn/start` 之后，轮次分段把它当成了普通表面节点。修复方式是：

- `buildTurnSegments` 不再把 `system/message` 纳入轮次节点；
- 表面回退选择器跳过所有前导 `system/message`；
- 新增回归测试 `planCompaction never includes a system head that lands inside a turn`。

修复后第二次真实探测成功（即上面的 seq 21–25）。

## 5. 生产配置恢复

测试后已恢复：

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

`status.json` 已确认 `triggerRatio: 0.5`、`targetRatio: 0.35`、`excludeSessionIds: []`；`config.json` 当前也是 0.5 / 0.35。交互会话不再被排除，但当前压力（2026-10-31 09:30:58，311,089 / 1,048,576 ≈ 29.7%）低于 50% 触发线，因此不会立即压缩。

## 6. 配置文件热加载（2026-10-31 09:36）

插件在以下路径自动生成用户配置：

```text
$env:USERPROFILE\.dsh\auto-context-compression\config.json
```

实测步骤与结果：

1. 09:36:02 首次生成 `config.json`，内容为生产默认值（triggerRatio 0.5、targetRatio 0.35）。
2. 09:36:12 将 `triggerRatio` 改为 `0.42`，不重载插件；下一个 `agent/pre-step` 读取文件，09:36:14 的 `status.json` 显示：
   ```text
   status.triggerRatio = 0.42
   configFile.reloadedAt = 2026-10-31T01:36:14.368Z
   configFile.lastError = null
   ```
3. 将 `triggerRatio` 写成字符串 `"bad"`；插件保留上一份有效配置 0.42，并在 `status.json` 中记录：
   ```text
   configFile.lastError = auto-context-compression: triggerRatio must be a number in (0, 1)
   ```
4. 恢复 `triggerRatio: 0.5`；09:36:26 的 `status.json` 回到 0.5，`lastError` 清空。

结论：用户只需编辑 `config.json` 即可自定义触发线/目标/保留量等，保存后下一次模型请求生效，无需重装或重启；非法文件不会破坏当前有效配置。

## 7. 缓存命中/未命中率（2026-10-31 09:47）

插件从会话的 `assistant/message.usage` 聚合：

```text
promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
hitRate      = cacheReadTokens / promptTokens
missRate     = (inputTokens + cacheWriteTokens) / promptTokens
```

真实 `status.json`（当前交互会话，09:47:43）：

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

`/autocompact status` 显示摘要行，`/autocompact cache` 显示上述明细；同样的 `cache` 对象写入 `status.json` 的 `sessions[]`。压缩摘要辅助调用记录在 `compaction/summary`，不计入主对话命中率。

## 8. 原生 Web 面板与 bili 账本（2026-10-31 10:16）

新增原生 React `conversation.view` 页签 **压缩**（id `auto-context`，order 20），不改动现有 `上下文`（`bili-context`）页。`cordis_inspect_query` 的 `Slots.listSubTree` 确认注册顺序：

```text
chat            order 0
trajectory      order 10
auto-context    order 20   active true
bili-context    order 30
```

Host 提供只读接口：

```text
GET http://127.0.0.1:51890/auto-context-compression/api/status
```

实测返回：

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

这些数值与用户提供的截图中 608 / 166.0M / 164.3M / 99.0% / 525K / 119.4M / ≈$0.2449 / ≈$1.07 / 468K 对齐。数据源是 bili 的：

```text
GET http://127.0.0.1:18787/__bili/sessions/<sessionId>/detail
```

面板金额与回本按 bili 账本展示，并标注“估算、非账单”。当 bili 不存在或设置 `biliOrigin: ""` 时，回退到 DSH 的 `assistant/message` / `compaction/summary` 聚合。

### 为什么主动策略显示待命

`plugin_manager list_plugins` 显示：

```text
include:bili-compaction-gate   active
include:compaction-basic        enabled:false / fiberPhase:null
include:command-compact         enabled:false
include:tool-result-pruner      enabled:false
```

`billion-context/dsh.bundle.patch.yml` 把原生 `compaction-basic` 设为 `auto: false`，并由 `bili-compaction-gate` 在 wire 层接管。此时 `serviceFor(agent, 'compaction')` 返回 `undefined`，所以 `available:false` / `lastSkipReason:"no-compaction-service"` 是正确状态；面板显示 **待命（压缩由 billion-context 接管）**，绿色收益来自 bili 账本。不要同时强开两套压缩。

### 客户端注册说明

`clientModules` 在 Host 启动时扫描 `dsh.client`；运行中热装本插件时，包可能尚未进入 boot graph。当前实现会在初始化时检查 graph，缺失时通过兼容路径调用 `reconcilePackage` / `compose` / `notifyGraphChanged` 注册自身，已存在时调用 `rebuilt` 刷新客户端 bundle；页面刷新后出现 **压缩** 页签。若 Host 重启，则走正常启动扫描。该兼容路径不修改 profile，也不写死会话数据。公开的 `?debug=1` 只读诊断，不再接受 `rescan=1` 触发注册/重建。

### 本轮测试

```text
node --check lib/index.js   -> ok
node --check lib/policy.js  -> ok
node --check lib/ws.js      -> ok
node --check client.js      -> ok
node --test test/*.test.js  -> 40 passed, 0 failed
```

## 9. 实时 WebSocket 与下载（2026-10-31 10:29）

### 9.1 协议与端点

```text
GET  /auto-context-compression/api/ws-token
WS   /auto-context-compression/ws
协议  dsh-auto-context-v1
```

`ws-token` 返回 `{ok:true,value:{path,protocol,token}}`；浏览器用
`new WebSocket(ws(s)://location.host + path, [protocol, token])` 握手。握手成功后客户端发送
`{"type":"hello","sessionId":"<可选>"}`，服务端立即推一帧，随后由 Host 的 1 秒定时器广播；
客户端断线后按 0.5s → 10s 指数退避重连，不需要刷新页面。

### 9.2 真实握手与主动推送

`tools/ws-probe.mjs` 经真实 loopback socket 完成 101 握手，只发送一次 `hello`：

```text
snapshot 1: elapsed 4ms,   engine billion-context, requests 608, savedUsd 0.2449
snapshot 2: elapsed 496ms, engine billion-context, requests 608, savedUsd 0.2449
```

第二帧不是由客户端请求触发，而是 Host 的广播定时器推送。第二次到达时间受全局 1 秒 tick
相位影响，可能小于 1 秒；这只说明“无需轮询即可收到新帧”，不代表固定 1 秒间隔。
（本轮同时移除了握手时与 `hello` 重复发首帧的问题，改由 `hello` 触发首帧。）

### 9.3 客户端 bundle 与页面注册

`GET /plugins/??dsh-auto-context-compression/client.js&rev=35b709464d74` 返回 200（45,809 bytes），内容包含：

```text
new WebSocket
/api/ws-token
downloadReportFile
downloadReportImage
renderReportImage
conversation.view
```

`Slots.listSubTree` 的 `conversation.view` occupants 仍为：

```text
chat          order 0
trajectory    order 10
auto-context  order 20  active true
bili-context  order 30
```

### 9.4 自动化测试

`node --test test/*.test.js` -> **40 passed, 0 failed**。新增覆盖：

- `test/ws.test.js`：掩码文本、未掩码拒绝、分片/大小上限、Origin/token 严格校验、合法 101、错误 capability 401；
- `test/plugin.test.js`：`ws-token` 路由、`registerUpgrade` 挂载、跨站 `Sec-Fetch-Site` 403、status 只暴露 websocket 元数据不暴露 token；
- 客户端静态契约：`new WebSocket`、下载函数、无 iframe/旧轮询。

### 9.5 下载

面板提供两个按钮：

- `下载报告`：客户端生成 Markdown（基本信息、用量、节省/回本/成本、主动策略、WebSocket 元数据、估算声明）；
- `下载图片`：客户端在 1200×900 @2x canvas 上绘制深色 PNG，内容与面板一致。

两者都在浏览器本地生成并通过 Blob 下载，不向 Host 发送文件内容。实际按钮点击/PNG 视觉
需要人工在页面上确认；自动化只能验证函数存在与静态契约。

### 9.6 自审报告

WebSocket 代码的自审、威胁模型、残余风险与修复记录见
[WEBSOCKET_REVIEW.md](./WEBSOCKET_REVIEW.md)。结论摘要：未发现远程无鉴权代码执行/任意文件
读写；主要残余风险是 token endpoint 无用户认证、`clientModules` 私有 API 兼容性、以及没有
per-session 授权。部署边界必须保持 loopback 单用户。

## 10. 未覆盖/限制

- Web 面板是只读观测页；配置仍通过 `$DSH_HOME/auto-context-compression/config.json`、`cordis.patch.yml` 与 `/autocompact` 命令调整。
- 缓存命中率只统计主对话 `assistant/message` 的 usage，不含压缩摘要辅助调用；适配器不返回缓存字段时无法计算。
- 会话级 `on/off/threshold/target` 覆盖只存在内存中，重启后回到配置默认值。
- 摘要质量由路由模型决定；插件不替换模型、不改写 prompt。
- 真实摘要调用会产生一次额外的模型请求（验证中 usage: input 16,689 / output 3,332 tokens），这是上下文压缩的固有成本。
- 本机 profile 由 billion-context 接管压缩；本插件的主动策略要等原生 compaction 服务恢复后才会执行。
- 金额为固定参考单价 / bili 账本估算，不是账单；回本估算未计全量重放成本。
- WebSocket 仅适用于 loopback 单用户：token 是进程级能力令牌，没有用户认证；不要将 GUI 端口暴露到局域网/公网。详见 `WEBSOCKET_REVIEW.md`。
- 没有做浏览器真实点击下载、长时间 soak test、HTTPS/反向代理、非 loopback 场景验证。
- 实时面板首次出现仍需要页面加载新的 client bundle；之后推送/重连/下载不需要刷新。客户端注册依赖 DSH `clientModules` 私有兼容路径，Host 升级后需回归。
