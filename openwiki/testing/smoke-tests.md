---
type: testing
title: 冒烟测试套件：平台无关的 13 节（A~M）与全局 fetch 桩
description: test/smoke.ts 的选材原则与执行模型——裸 Node 跑 --experimental-strip-types、单一进程里替换全局 fetch、每节自装桩互不依赖；A~M 十三节各自钉住什么；以及「断言抄实现」这类假信心陷阱与它留下的三处结构性缺口。
tags: [testing, smoke-tests, fetch-stubbing, ci-gate, false-confidence, platform-independence, node-strip-types]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-03T16:28:06.187Z
sources:
  - id: openwiki-source-6766b7a0c14857435d2077c9
    resource: repo://.github/workflows/deploy.yml
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-3021d1434012afbbfcda7c3b
    resource: repo://src/feishu/compact.ts
  - id: openwiki-source-019e2f50672ab2474e1d694a
    resource: repo://src/feishu/global-memory.ts
  - id: openwiki-source-440a24ee5e90b3b44b230fb1
    resource: repo://src/feishu/store.ts
  - id: openwiki-source-d5d93d36114face9fb3efbe3
    resource: repo://src/feishu/user-token.ts
  - id: openwiki-source-52891af3d1130cc7375b5e4e
    resource: repo://test/smoke.ts
  - id: openwiki-source-403a9d43fcce3607b38ceabd
    resource: repo://tools/ask-bot.mjs
generated: { by: "openwiki/0.6.1", at: "2026-10-03T16:28:06.187Z" }
---

# 冒烟测试套件：平台无关的 13 节（A~M）与全局 fetch 桩

`test/smoke.ts` 是这个仓库唯一的自动化测试文件，也是每个开发者在装完依赖后跑的第一条命令。它由一个极小的自研框架驱动（`describe` / `it` / `eq` / `ok`，见 [test/smoke.ts](../../test/smoke.ts) 第 83 行起），没有测试运行器、没有断言库、没有配置文件。

入口是 `package.json` 的 `test` 脚本：

```bash
npm test     # node --experimental-strip-types test/smoke.ts
```

## 为什么要有这个套件：把「不依赖平台的那部分」剥出来

这一点决定了整个文件的形状：

- `edgeone makers dev` 需要登录令牌，CI 和无人环境里跑不了；
- 而这条链路里真正容易错的东西 —— **验签与解密的顺序**、去重窗口的判据、35 字符的 `conversation_id`、`docx v1` 段落载荷的字段名 —— **全都不依赖 EdgeOne 平台**；
- 于是把它们从平台里剥出来，用裸 Node 直接跑，改一行就能验一次，不必等部署。

因此有一条硬边界：**套件不开服务、不连飞书、不发真实网络请求**。所有出站 HTTP 都被 `fetch` 桩接住；没有桩的请求会被桩自己抛错（`测试没有为这个请求准备响应：<url>`），而不是悄悄打到真实端点。

对照另一边：[端到端验证脚本](end-to-end-verification.md)负责「真跑起来会不会成立」，它们对着**已部署**的 agent 打真实请求，需要 `AGENT_URL` / `INTERNAL_TOKEN` 等凭证；`npm test` 不需要任何凭证。两套工具的分工是「平台无关的判据 vs. 线上是否成立」，互补而不重叠。

### 它是部署门禁的一部分

`.github/workflows/deploy.yml` 在 `push main` 时先跑 `npm install`，再依次跑 `npm run typecheck` 与 `npm test`，**两个都过了才执行 `edgeone makers deploy`**。也就是说测试挂掉的表现是「没上线」，而不是「上线了但功能不对」。这两步既不依赖 EdgeOne、也不连飞书，所以它们的失败总是代码问题，永远不会是环境抖动 —— 这正是能把它当门禁用的前提。部署链路本身见[部署与发布](../operations/deployment-and-release.md)。

## 执行模型：一个进程、一套全局 fetch、每节自己装桩

带 `--experimental-strip-types` 的 Node 在**一个进程**里跑完整个文件，A~M 十三节是同一份顶层作用域里顺次 `await` 的 `describe(...)` 调用（不是 `node:test` 那样的独立用例）。

由此产生三条必须遵守的规矩：

1. **`fetch` 是全局的，被整体替换。** 桩函数 `stubFetch(handler)` 覆盖 `globalThis.fetch`，返回一份「被捕获的调用列表」`{ url, init }[]`，供断言检查转发头、转发体、请求方法与认证头。文件末尾用一开始存下的 `realFetch` 还原。任何一节调用 `stubFetch` 都会**作废前一节的桩**。
2. **小节之间不许互相依赖。** 每节自己装自己的桩、自己造自己的假响应；`ENV` 也是每节各自定义的字面量（`const ENV = {...}` 在 D/E/F/H/I/J/L/M 里各写了一份）。跨节共享状态只在一处出现：`describe` 把 `section` 这个模块级变量设成当前节名，纯粹用于失败信息的前缀（`A. crypto 验签与解密 › 官方测试向量能解出 hello world`）。
3. **失败不中断，最后汇总。** `it()` 捕获异常、计入 `failures` 并打印，继续跑下一条；收尾时若 `failures` 非空则 `process.exitCode = 1`。所以一次运行能拿到全部失败项 —— 但一条去改 `globalThis` 的测试若中途抛错，残状态会污染后续小节。

被替换的全局不只是 `fetch`：K 节的两条测试会临时改写 `globalThis.__EDGEONE_AGENT_RUNTIME__` 与 `process.env.PAGES_PROJECT_ID` / `ProjectId` / `EDGEONE_PROJECT_ID`，用 `try/finally` 还原 —— 这个 `finally` 是必需的，漏掉会让「记忆后端不可用」这类判据在后面的测试里假通过。

### strip-only TypeScript 的反向约束

套件跑在 `--experimental-strip-types` 下，Node 只**剥类型、不做代码生成**。后果是一条会反咬一口的语法禁令：`src/` 里**不能**使用 TypeScript 的构造函数参数属性。

```ts
// ❌ ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
constructor(private kv: StateKv) {}
```

`FeishuStore`（[src/feishu/store.ts](../../src/feishu/store.ts#L104-L114)）与 `UserTokenManager`（[src/feishu/user-token.ts](../../src/feishu/user-token.ts#L66-L73)）因此都写成「手写字段 + 构造器里显式赋值」，两处的注释都写明了原因。**测试的运行时选择因此对生产代码的写法有约束**：想让某个模块被冒烟测试覆盖，它就不能用参数属性。

### 调工具的方式：`invoke` 的第二个参数是 JSON 字符串

工具类测试（J/K/L/M）都走一个 `callTool(t, args)` 帮手，它调用 `t.invoke({}, JSON.stringify(args))` 并把字符串结果 `JSON.parse` 回来。文件里用一大段注释记下了这个坑：`@openai/agents-core` 的 `invoke(runContext, input: string, details?)` 会先 `parser(input)`，解析失败被 `toolErrorFunction` 兜成一个英文错误字符串返回而**不抛异常**。所以传对象进去的表现是「每个工具都返回一段英文错误文本」，极难归因 —— 第一次跑测试时看到的是十几条 `Unexpected token 'A'`。`runContext` 传 `{}` 就够，因为这些工具的 `execute` 只吃参数、不碰 `runContext`。

## 十三节各自钉住什么

节标题里的字母只是给人看的，不参与任何逻辑（文件头明确写了这一点）。

| 节 | 覆盖 | 代表性判据 |
|---|---|---|
| A | crypto 验签与解密 | 官方测试向量解出 `hello world`；签名 = `sha256(timestamp + nonce + key + rawBody)` 十六进制；缺 timestamp/nonce/signature 一律失败；密文长度不合法**抛错**而非静默返回空 |
| B | 事件体解析 | `parseMessageEvent` 取出五个字段、剥 `@_user_1` 占位符并压缩空格但保留换行；非文本消息 / 非 `im.message.receive_v1` 一律 `null`（静默忽略）；`readChallenge`、`readEnvelope` |
| C | 命令解析 | 无斜杠 = 提问；中英文别名（`/状态`、`/帮助`、`/压缩`、`/清空`、`/授权`、`/退出授权`、`/记忆`、`/忘记`）；**命令名大小写不敏感**；`/repo`、`/log`、`/for`、`/memories` 必须落 `error` 而不是被当普通提问；`HELP_TEXT` 里列出了 `/login` `/logout` `/memory` `/forget` |
| D | 飞书状态存储 | 首次 `claim` 放行、窗口内重复拦住；`markDone` 之后窗口内**仍然**拦住（判据是时间窗口不是状态）；窗口外重新放行；`recentCount` / `overLimit`（10 条）只数窗口内；`prune` 清过期；token 缓存跨实例恢复；事件数组有条数上限（≤500） |
| E | 飞书 webhook 端到端（假 `Request`） | challenge 回声且不验签、token 不对 401；正常消息回 `{code:0}` 且转发一次；**`conversation_id` 落在 6~36 字符**且 `fs-` 前缀；粘性路由（同 chat 同 id、不同 chat 不同 id）；`x-internal-token`；自环防护（`sender_type=app` 不转发）；`chat_id` 形状不合法 / 超长文本 / 白名单外静默忽略；非 JSON 400、非 POST 405、缺凭证 503、agent 报错回 500；**配了 Encrypt Key 时「解密 → 验签 → 转发」的顺序**（签名算的是**原始 body**，不是明文） |
| F | 回合流程（`runFeishuTurn` + 宿主 stub） | `/help` 的文案里不再出现已删掉的 `/repo`；`/status` `/memory` `/forget` `/compact` `/clear` `/login` `/logout` 各自路由到宿主方法；`/forget` 把键名**原样**（含空串）透传；宿主抛错时仍发得出消息（`模型没答上来` / `处理失败`）；`streamed=true` 时不再补发文本；`/repo` 不走到模型 |
| G | 会话压缩的纯函数 | `MIN_ITEMS_TO_COMPACT = 3`（让 `/compact` 幂等）；`renderTranscript` 的角色标签、内容块数组、工具调用行、丢弃思考项、头尾保留的中段省略；`shouldCompact` 的**等价判据是「renderTranscript 会不会被截断」**；摘要写回形状（`user` role + 固定前缀）；`SUMMARY_SYSTEM_PROMPT` 点名四类必须保留的信息且不留仓库时代的残留 |
| H | 云文档授权（纯函数） | `parseDocUrl` 认得五种链接形态（`docx` / `wiki` / `base` / `sheets` / 旧版 `docs`）、带出 `?table=` `?sheet=` 子标识、认租户子域与 `larksuite.com`、认不出时给可读 `reason` 而不抛；`signState` / `verifyState` 篡改/换密钥/过期都过不了，且 wire format 与中转（`node:crypto`）对得上；`DOC_SCOPES` 必须含 `offline_access`；授权链接的域名与参数；`redirectUri` 没配时**明确抛错** |
| I | 用户令牌管理器 | 没记录 → `needAuth` 且不发请求；新鲜令牌直接用；过期 → 续期一次并落盘；**响应没带 `refresh_token` 时保留旧值**；并发取令牌**单飞**；续期失败先重读一次；怎么都不行时清掉坏记录并要重新授权；`peek` 无副作用、`forget` 幂等；`invalidate` 绕过时间判据；不同 `openId` 用不同槽 |
| J | 云文档工具族 | 七个 `feishu_` 工具的注册名；新建文档只发 `title`、追加打到**新建出来的 id**、正文失败时**链接照样给出**、字段名是 `text` 不是 `paragraph`；两条**身份**测试（建文档全程不取租户令牌 / 未授权时**不退回应用身份**）；`99991679` 的「旧授权不会自动带新 scope」文案；读 docx 的翻页缓存；wiki 先 `get_node` 再用 `obj_token`；电子表格尾部空行剪掉且不误报 `truncated`；多维表格的表列表 / `?table=` 兜底 / 字段拍平；身份三层（应用优先 → 用户兜底 → 报可执行错误）；工具永不抛，转 `{ error }` |
| K | 跨会话记忆 | 键名规范化（中文保留、剥斜杠、压连续点、截 64 字符）；`isVisibleTo` 的权限边界（前缀相近的不同人不放行）；`remember`/`entries`/`forget` 往返、`by` 只留 openId 后 6 位；**`recall_facts` 不返回别人的按人记忆**；`forget_fact` / `forgetLoose` 删不掉别人的；`MAX_ENTRIES` / `MAX_VALUE_CHARS` 上限（更新旧键不受上限影响）；`renderForPrompt` 的可见性与截断说明；`memoryBackendStatus` 的两种病因与 projectId 五个来源的优先级；`blobMemoryBackend` 的命名空间隔离 |
| L | 工作区 GitHub 仓库（`ws_*`） | 五个工具注册名与「没配 TOKEN 一个都不挂」；`ws_ls` 目录在前带 `/`；`ws_read` base64 解码 + 行号；`ws_write` 覆盖自动带 `sha`、新建不带；`ws_rm` 先取 sha；404 的三种原因要全说；`ws_commit` **多文件只产生一个 commit**、`base_tree` 保证未提到的文件原样保留、`sha: null` 表达删除、本地挡掉超 60 文件 / 空说明 / 空集合 / 路径越界 |
| M | GitHub issue 工具族（`gh_issue_*`） | 没配 token **或**没配白名单 → 整族不挂；白名单大小写不敏感；白名单外拒绝且**列出允许哪些**、一个请求都不发；开 issue 的请求体只含 `title`/`body`；评论号必须是正整数；**token 绝不出现在错误信息里**；401 要说清「需要人去换凭证」 |

### 表里看不到的几组

除了 A~M 十三节，文件里还有一段**没有字母编号**的注释分组，用裸块 `{ ... }` 包起来：会话历史消毒（`src/feishu/session-sanitize.ts` 的 `sanitizeHistory` / `sanitizeAndAppend`）。它守的是「会话被永久毒死」那个坑 —— 窗口从 `tool_calls` 对中间切开后，开头剩下孤儿 `tool` 消息，网关稳定 400，只有 `/clear` 能救。因为消毒函数是纯函数，各种切歪的形状都能在这里钉死：开头/中间的孤儿 tool、同一个 callId 被消费两次、空 assistant 丢弃、**有 `tool_calls` 但没文本的 assistant 必须留**、丢弃时要回调（用于落诊断）而没丢时不回调。

## 三条最贵的断言，和它们想防的东西

这套测试的价值集中在少数几条「换个写法就会失效」的断言上。

### 1. 把「假信心陷阱」本身做成断言（J 节的 `paragraph` / `text`）

`feishu_docx_write` 的段落载荷字段名曾经被写错：测试里的期望值写的是 `paragraph`，**和刚写完的实现是同一份误解**，于是测试一直绿，而真实 API 每次都回 `1770001 invalid param` —— 直到 2026-09-25 用真实凭证才撞出来。

现在文件里同时钉住三层：

- 正断言 `para.text.elements[0].text_run.content` 是段落文本；
- 反断言 `!("paragraph" in para)`，并把教训写在断言旁边；
- 新建文档那条断言也复用了同一个判据（`!("paragraph" in cb.children[0])`）。

**可迁移的规则**：断言里的字段名、字符串、形状必须来自**真实响应或规格**，不能来自刚写完的实现。桩测试能挡住「发出去的形状不对」，前提是期望值本身得对。判据的另一半同源：[端到端验证](end-to-end-verification.md)里的「事实必须不可猜」与「`includes(keyword)` 判不出否认」讲的都是同一件事 —— 复制来的不变量是假信心。

### 2. 身份敏感的测试必须显式断言授权头（J 节的 `⚠️` 两条）

同一节里那 4 条「建文档」测试曾经全是绿的，却**区分不出用的是哪个身份** —— 桩函数按 URL 路由，谁发的都接。也就是说：把身份从应用改成用户，它们一条都不会红。这正是上面那个字段名 bug 能长期全绿的原因。

现在这两条测试直接断言「谁发的」：

- 建文档走用户身份时，`tenant_access_token` 的调用次数**必须是 0**（取了就说明有人在试应用身份），且建 + 追加两跳的 `authorization` 头都必须是 `Bearer at-1`；
- 未授权时**不许偷偷退回应用身份**：`tenant_access_token` 与 `POST /docx/v1/documents` 的调用次数都为 0，并给出 `/login` 这条路。

J 节还有一条同类的三层断言：`feishu_doc_read` 的 `raw_content` 必须恰好发三次，认证头依次是 `Bearer tt-1`（应用）→ `Bearer at-stale`（用户，被判无效）→ `Bearer at-fresh`（续期后重试）。**只断言「最终读到了正文」是不够的** —— 那不能区分「真的按三层兜底」和「一步就成功了」。身份模型本身见[身份模型：应用身份与用户身份](../concepts/identity-and-authorization.md)。

### 3. 把「为什么这里必须失败」也做成断言

有些断言的真正作用不是验证一处行为，而是**防止某段解释被后人当成冗余删掉**：

- `eq(\`fs-${REAL_CHAT_ID}\`.length, 38)` —— 原版写法 `fs-${chatId}` 是 38 字符、超过平台 36 字符上限，这就是当初全线 400 的原因。把那个坑本身做成断言，比在注释里写一句话更难被删。
- H 节那条**跨仓库**的守门测试：`signState` 的 wire format 必须签出固定的串（`eyJjaGF0SWQi...wsYFQ-kz...`），且 `!again.includes("=")`。本仓库用 WebCrypto、中转用 `node:crypto`，只要有一边的 base64url 填充或 HMAC 参数不同，整条授权链路就会静默断在「链接无效」上，而那个报错完全指不出是这里。
- G 节把 `renderTranscript(items).includes("中间省略约")` 单独钉住：`shouldCompact` 的判据挂在 `compact.ts` 的 `CLAMP_MARKER` 上，谁把省略文案改短，`length > 120000` 会静默失效 —— 而这句断言会拦住那样的改动。**自动压缩从此永不触发、还一声不吭**，是这里要防的失败形态。

## 弱化与缺口：这套测试**不**保证什么

### 断言方向全是「白盒」的

套件几乎全部是纯函数与桩驱动的白盒测试。它精确验证「给定这些输入，代码发出的请求是什么形状」，但**没有任何一条**证据来自真实飞书或 GitHub 的响应。所以：

- 桩的**形状**本身可能是错的（SH1 那种「只回有内容的三行」是理想化的，实测不会发生 —— 正因如此它掩盖了「飞书把整个网格补空行回给你」那个 bug，直到 SH2 按真实形状构造才暴露出来）；
- 之前那条「加密事件体但不配 Encrypt Key」的测试**自相矛盾**：只构造了密文、没配 key，断言却写 200，而实际路径会因为 token 取到空串回 401。现在按真实链路走（配 key + 密文 + 对**原始 body** 算签名），顺带验证「解密排在验签之前」这个顺序。

### 覆盖面刻意停在三处的上游

以下都不是「测试没写全」，而是**它们按定义需要真环境**：

- **真实的飞书入站 webhook（事件订阅）**。README 记录得很直接：入站那一段**没跑过** —— 验收全是直调 `?mode=sync` 或投合成事件。E 节的端到端是「合成 `Request` → 转发」，它验的是**转发层的逻辑**，不是「飞书后台把事件推给我们」这一跳。
- **`shouldCompact` 在真实会话里的触发**。G 节只钉得住判据本身（纯函数），而「判据真的会触发」需要十几轮满长度对话才堆得到，只能由 `npm run verify:autocompact` 用诊断计数器证明。
- **平台侧静默施加的配置**。`context.store.openaiSession()` 的 100 条窗口、平台沙箱工具的实际注册名、`context.tools.all()` 在 `openai-agents-sdk` 下返回的对象形状 —— 套件按文档假设它们，验不到。

### 「绿了」距离「验过了」有多远

改动相关代码时，正确的读法是：**`npm test` 绿 = 平台无关的判据没坏**，不等于这条链路验过了。飞书事件订阅、流事件的实际名字、生产会话窗口这三块都没有自动化证据，它们列在[端到端验证脚本](end-to-end-verification.md)的「尚未端到端验证的区域」一节里，是接着要跑的东西。

## 维护这套测试：四条不变量

1. **每节自带桩，绝不跨节依赖。** 新加一节时自己 `stubFetch(...)`、自己定义 `ENV`。忘了装桩的表现是「测试没有为这个请求准备响应」——这是设计好的失败方式，别去改成静默跳过。
2. **改用例别改断言的理由。** 这一类的断言（`fs-` 长度 38、`paragraph` 不存在、中间省略标记、wire format 固定串）都带着一段解释它们**为什么存在**的注释，改动前先读那段注释。这些注释本身就是防止「重构时删掉判据」的主要机制。
3. **新增工具族 / 命令时同步补一节或一节内的分组。** 已知的挂载与门禁关系是：工具族的挂载条件在 `_host.ts`，而描述里出现的能力段必须用**同一个**条件拼接；命令的 `kind` 联合一改，`turn.ts` 的 `switch` 就编译不过。测试是这两处之外的最后一道。
4. **失败要能自我解释。** 沿用仓库里通行的风格：断言消息写清「期望什么、实际什么、以及为什么这条重要」（`ok(cid.length >= 6 && cid.length <= 36, \`长度 ${cid.length} 越界：${cid}\`)`）。这条链路里最贵的成本是**误诊**，不是执行时间。

## 与其他页面的边界

- 平台无关判据之外的那一半（对已部署 agent 的真实验证、假阳性清单、执行顺序）：见[端到端验证脚本与执行顺序](end-to-end-verification.md)；
- `npm test` 与 `typecheck` 在部署流程里的位置、`edgeone makers deploy` 的坑：见[部署与发布](../operations/deployment-and-release.md)；
- 被测试钉住的存储语义（去重窗口、写穿、KV 形状）：见[存储模型](../concepts/storage-model.md)与[平台约束与弱化的保证](../architecture/platform-constraints.md)；
- 被测试钉住的记忆语义（命名空间隔离、可见性、后端解析）：见[跨会话长期记忆](../concepts/cross-session-memory.md)；
- 被测试钉住的工具契约（七个文档工具、截断语义、可执行错误文案）：见[工具契约与清单](../concepts/tool-contract-and-inventory.md)；
- 飞书侧的验签向量、`offline_access`、身份不退回：见[飞书开放平台集成](../integrations/feishu-open-platform.md)。
