---
type: architecture
title: 平台约束与弱化的保证
description: EdgeOne Makers 的能力边界如何决定这套移植的每一个设计：无命名实例 RPC、无 SQL、无 alarm、免费版 cron 最小 1 天、agents 单次 900 秒；由此欠下的三笔强保证债务（去重不是分布式锁、Blob 无 CAS/TTL、会话历史恒被截到最近 100 条），它们各自在代码哪里被强制，以及恢复强保证时唯一该动的那两条窄缝。
tags: [platform-constraints, weak-guarantees, edgeone-makers, persistence, concurrency, porting]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-03T16:28:06.187Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-d219551c1f22ddfa832d3fc3
    resource: repo://agents/feishu/_diag.ts
  - id: openwiki-source-5f3aea8c254ad36759041b1d
    resource: repo://agents/feishu/_host.ts
  - id: openwiki-source-21fdb6c189926cc267545d5b
    resource: repo://agents/feishu/_instructions.ts
  - id: openwiki-source-00fdb3d166c9958ea836d71d
    resource: repo://agents/feishu/_tools.ts
  - id: openwiki-source-6ba1b6f1f123db2bee92fb1c
    resource: repo://agents/feishu/index.ts
  - id: openwiki-source-05088d06025363715c7ef1b8
    resource: repo://cloud-functions/feishu-webhook/index.ts
  - id: openwiki-source-28ed19af7422da0dde523305
    resource: repo://docs/01-%E6%9E%B6%E6%9E%84%E4%B8%8E%E7%A7%BB%E6%A4%8D%E6%98%A0%E5%B0%84.md
  - id: openwiki-source-29e0e549684285159e4ee7f8
    resource: repo://docs/03-%E9%AA%8C%E8%AF%81%E6%B8%85%E5%8D%95.md
  - id: openwiki-source-a007013901bad3643fe76c22
    resource: repo://edgeone.json
  - id: openwiki-source-f8d10828394c4129061d5b0e
    resource: repo://index.html
  - id: openwiki-source-3021d1434012afbbfcda7c3b
    resource: repo://src/feishu/compact.ts
  - id: openwiki-source-544fee4052b7cc76a362593e
    resource: repo://src/feishu/docs.ts
  - id: openwiki-source-019e2f50672ab2474e1d694a
    resource: repo://src/feishu/global-memory.ts
  - id: openwiki-source-58b162c5f00fb117440d11f5
    resource: repo://src/feishu/session-sanitize.ts
  - id: openwiki-source-440a24ee5e90b3b44b230fb1
    resource: repo://src/feishu/store.ts
  - id: openwiki-source-52891af3d1130cc7375b5e4e
    resource: repo://test/smoke.ts
generated: { by: "openwiki/0.6.1", at: "2026-10-03T16:28:06.187Z" }
---

# 平台约束与弱化的保证

这份文档记录**每一处改动的理由**，以及**哪些保证变弱了**。移植最容易出问题的不是「代码写不出来」，而是「照抄了代码但没照抄它依赖的平台保证」。

本页是[架构总览](overview.md)的另一面：那边讲「有哪些组件、谁跑在哪个运行时里」，这边讲**平台不同意什么**，以及每一处不同意在代码里留下的形状。存储分层的结构与键空间归属见[存储模型](../concepts/storage-model.md)，去重与限流的业务生命周期见[会话状态与去重](../workflows/session-compaction.md)——本页只讲这些机制的**保证强度**。

## 平台能力对照表

原版是 `cf-agent-lab`（Cloudflare Workers + Durable Objects），现在是 EdgeOne Makers。

| 能力 | Cloudflare（原版） | EdgeOne Makers（现在） | 差距 |
|---|---|---|---|
| 有状态计算单元 | Durable Object | `agents/` 会话模式 | 等价 |
| 按名字取实例、调方法 | `getAgentByName(env.ChatAgent, name)` 原生 RPC | ❌ **没有** | **硬缺口** |
| 会话身份 | URL 路径里的实例名 | `Makers-Conversation-Id` 请求头 | 载体变了 |
| 强一致 SQL | `ctx.storage.sql`（每实例一个 SQLite） | ❌ **没有** | **硬缺口** |
| 按会话隔离的 KV | 自己建表 | `context.store.state`（JSON KV） | 等价，但弱一致 |
| **跨会话共享的存储** | 自己建表（DO SQLite / KV） | **Blob**（agents 运行时内置 `getStore`） | 等价，但**无 CAS、无 TTL** |
| 对话记忆 | `agents/sessions` + `cf_agents_session_messages` 表 | `context.store.openaiSession()` | 等价，但**没有压缩钩子**、窗口锁死 100 条 |
| 延迟作业 / 重试 | `this.schedule()`（storage + alarm，自带退避重试） | ❌ **没有 alarm** | **硬缺口** |
| 定时任务 | Cron Triggers（最小 1 分钟） | cron-tick（免费版**最小 1 天**） | 免费版基本不可用 |
| 代码沙箱 | 自建（Judge0 / 阿里云 FC 云沙箱） | `context.tools.*` 内置 14 个工具 | **更强** |
| 单次执行上限 | 30 秒（Worker）/ DO 可配 | `agents/` 最长 900 秒（`edgeone.json`） | 更强 |
| 静态资源 | `env.ASSETS` | 项目根目录自动托管 | 等价 |

能力数字与超时来自 `edgeone.json`（`agents.timeout: 900`、`agents.sandbox.timeout: 900`）和 `docs/01-架构与移植映射.md` 第一节。

三个「硬缺口」里，两个（无 RPC 寻址、无 SQL）用别的机制绕过去了，第三个（无 alarm）**没绕过去，只是换了个做法**，而且那个做法依赖一个当时未实测的平台行为。

## 三个硬缺口各自的下场

### 缺口一：没有「按名字取实例、调方法」

`cloud-functions/` 拿到的 `context` 只有 `request / env / agent.store`，**没有任何「调用某个 agent」的能力**。`context.agent.store` 是共享数据（读写对话消息），不是调用入口。

后果是转发只能自己 `fetch` 同项目下的 agent 路由，并且必须自己补上 `Makers-Conversation-Id`。这条路由不是可选项：**所有** `agents/*` 调用都必须带这个头，缺了平台直接回 `400`。而飞书的事件推送是飞书服务器发起的，我们加不了自定义请求头 —— 所以链路必须拆成「无状态转发层 + 会话模式 agent」两段。

这条约束还咬掉了一个次级问题：**OAuth 回调也是浏览器跳转触发的，同样带不了自定义头**，所以它也得走中转，落在 `handleOAuthCallback()` 里并**同步返回**（中转那边的浏览器在等响应渲染结果页），且**不走去重/限流**。

### 缺口二：没有 SQL

原版两张表（`feishu_events` 去重 / 限流、`feishu_token` 缓存）建在 DO 的 SQLite 上。`context.store.state` 恰好是需要的形状：**按 conversation_id 隔离的 JSON KV**，key 1~256 字符，value 任意可 JSON 序列化，跨实例持久化。飞书这条路上「一个会话 = 一个 conversation_id = 一个 agent 实例」，所以按会话隔离正好等价于原版「一个 DO 实例一个库」。

代价是**接口从同步变成异步**，因为 KV 读写天生异步。原版的 `claim()` 能同步写，是因为 DO 单线程 + 本地 SQLite 让「先查再写」天然原子；KV 没有这个保证。所以 `FeishuStore` 改成 **进程内权威副本 + 写穿**：判定全在内存做（同步语义、天然原子），改完整体写回 KV，首次访问时惰性 `ensureSchema()` 从 KV 加载。

### 缺口三：没有 alarm —— 唯一没真正解决的一处

原版 webhook 立刻 ACK，工作交给 DO 的 alarm：

```ts
await this.schedule(new Date(), "feishuRun", evt, {
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 4000 },
});
```

原版注释写清了为什么不用 `waitUntil()`：后者绑在请求上，DO 被驱逐就静默丢失消息。

EdgeOne 免费版 cron 最小间隔是 **1 天**，等于没有定时能力，也没有 `schedule()`。所以改成：**agent 先回 202，再在后台跑完整个回合**（`FEISHU_DISPATCH_MODE` 默认 `async`）。

这件事的地基是「返回 Response 之后，未 await 的异步代码还能不能跑完」，而**官方文档没有明文承诺**。理论依据是有的（会话模式、粘性路由、实例空闲 300 秒内保活），但「应该会」不等于「会」——有些运行时在响应发出后冻结事件循环。所以做成了可自测的：

- `?probe=start` 立刻返回，后台睡 15 秒后写标记；`?probe=check` 隔 16 秒读那个标记；
- 为什么是 15 秒而不是 1 秒：太短的话任务可能在响应发出**之前**就跑完了，测出来的是「同步能跑」，是假的通过。

**已实测成立**：`{"phase":"finished","elapsedMs":15046}`，`FEISHU_DISPATCH_MODE` 保持 `async`。万一实测不成立，退路是 `sync` —— agent 跑完才返回，webhook 跟着等，飞书 3 秒后判超时并重推，重推被 agent 侧去重挡住，而回答本来就走 `sendText`/卡片发出去、不依赖 webhook 的响应体。

⚠️ 只有 `sync` 模式才把 `request.signal` 传下去：异步模式下这个 signal 会在响应发出时触发，传进 `run()` 等于自己掐掉后台任务。

> **未实测的相邻前提**：自动压缩（`autoCompactNote()`）**刻意没有**走「后台不 await」那条路。那条路的实测**只覆盖模型回合**，压缩是又一跳异步（还要再调一次模型），能不能跑完是另一个未验证前提，所以它被 `await` 掉，位置放在「答案已流式显示完、`streamer.finish` 之前」。

## 三笔弱化的保证

下面每一条都写清：**弱在哪、在代码哪里被强制、恢复强保证的唯一接口在哪**。这三条是本页的核心。

### 一、去重**不是**分布式锁

`FeishuStore` 的「进程内权威副本 + 写穿」只在**「同一时刻只有一个实例在处理这个会话」**时正确。EdgeOne 的会话粘性路由给了这个保证，所以成立 —— 但它**不是**分布式锁。

- **失效表现**：哪天同一个 `conversation_id` 被路由到两个实例，去重会失效，表现为**同一条消息被回答两次**。
- **为什么原版没这个问题**：DO 天然单实例 + 本地 SQLite，「先查再写」原子。
- **代码里强制的地方**：`src/feishu/store.ts` 的文件头注释（「这套方案的边界，必须知道」）与 `claim()` 的实现 —— 判定全部走内存里的 `Map`，`ensureSchema()` 只负责把 KV 里的历史读进来，`persistEvents()` 整体写回。
- **钉住它的测试**：`test/smoke.ts` 的 D 节。判据是**时间窗口**而不是 `state` —— 窗口内同一条 `message_id` 就是同一件事，不管它处于什么状态（`markDone` 之后窗口内仍然拦住）；窗口外同 id 再出现视为用户又发了一遍。另有「事件数组有条数上限」一条守 `MAX_EVENTS`。

恢复强保证的缝：把 `StateKv` 换成外部 MySQL/PG，加 `unique(message_id)` 索引。`StateKv` 只有三个方法（`get` / `set` / `delete`）—— 见下面「恢复强保证的缝」。

### 二、Blob 没有 CAS，也没有 TTL

跨会话长期记忆落在 Blob（命名空间 `agent-memory-<projectId>`，走运行时暴露的裸 `getStore({ name })`）。它欠两条保证。

**（a）没有任何可用的条件写。** SDK 的类型定义里**有** `SetOptions.onlyIfNew`，注释写着「only write if the key does not already exist」，还配了个 `PreconditionFailedError` —— 看着就是现成的 CAS。**但实测它不生效**：键已存在时带 `onlyIfNew` 写照样覆盖成功。底层 COS 其实有版本号（响应头 `x-cos-version-id`）和 etag，只是 SDK 没暴露 `if-match` 这类参数，从这一层用不上。

后果与对策：

- 设计上**不能依赖任何条件写**。所以键空间按「**一条事实一个键**」铺（`prefs/<key>`、`user/<openId>/<key>`），而不是一个大 JSON —— 两个会话同时记**不同**的事不会互相覆盖；搞成一个大 JSON 的话，并发写就是丢数据。代价是渲染时要 `list` + 并行 `get`。
- 两个会话同时写**同一个键**，**后写的赢**。对「偏好」这类语义是合适的（最后说的算），但别拿它当需要精确累加的地方用。
- ⚠️「一个 key 只装一件事」这条规则必须落在**模型看得见的地方**。实测它原先只存在于 `global-memory.ts` 的文件头注释里 —— 那是给读代码的人看的，模型看不到 —— 于是模型把「内部代号」和「发布分支」并成了一个 key。现在它写在 `remember_fact` 的**工具描述 + `key` 字段说明**里，并由 `test/smoke.ts` 断言钉住不被重构删掉。教训：**提示词没说的规则，模型不会遵守。**
- 代码里强制的地方：`global-memory.ts` 的文件头与 `remember()` 的实现注释（「这里没有可用的条件写」）；读一律显式要 `consistency: "strong"`（默认的最终一致有 60 秒窗口，「我刚让你记住的」那段时间会像没生效）。

**（b）键不会过期。** `set` **没有 TTL 参数**（`SetOptions` 只有 `onlyIfNew` / `cacheControl`）；平台自己那层的 `expiresAt` 是 `createBlobBackedStore` 包出来的，我们走裸 SDK 没有它 —— 读出来的值是**原样**的，平台不再包一层信封。

好处是「长期记忆」真的是长期的；代价是没有 TTL 兜底，「记错了一条忘了删」会一直在，并且每轮都注入提示词。所以增长只能靠两个软上限管：

| 上限 | 值 | 在哪生效 |
|---|---|---|
| `MAX_ENTRIES` | 100 | `remember()` —— 记满之后**拒绝新键**并让模型先 `forget`；更新已有键不受影响 |
| `MAX_VALUE_CHARS` | 500 | `remember()` —— 单条上限，超了让模型先压缩 |
| 渲染预算 | 30 条 / 3000 字符 | `renderForPrompt()` —— 超了按条截断**并说明还有多少没显示**，否则模型以为自己看到了全部 |

⚠️ **`MAX_ENTRIES` 是软上限**：判据是「先查再写」（`entries()` → `some(e => e.key === key)`），并发下两个写入方可能同时判成新键，能轻微突破它。这是刻意接受的：上限是软保护，为此加锁的代价远大于收益，渲染预算兜住了后果。

恢复强保证的缝：把 `MemoryBackend` 换成外部 Redis/PG 加事务。接口只有四个方法（`put` / `read` / `remove` / `list`）。

### 三、会话历史恒被截到最近 100 条

平台的 session 实现（`.edgeone/agent-node/server.mjs` 的 `createOpenAISession`）：

```js
async getItems(limit) {
  const effectiveLimit = Math.min(limit ?? maxItems, MAX_LIMIT);   // MAX_LIMIT = 100
  const messages = await memory.getMessages({ conversationId, limit: effectiveLimit, order: "desc" });
  return messages.reverse().map(…).filter(…);
}
```

而 SDK 取历史时**不传 limit**（`@openai/agents-core` 的 `runner/sessionPersistence.js` 里 `const history = await session.getItems()`），本项目调 `context.store.openaiSession(cid)` 也没传 `maxItems` ⇒ `effectiveLimit = 100`。**这条比「没有自动压缩」重要得多**，三个后果：

- **模型看不到 100 条以前的对话。** 平台在没人被告知的情况下就丢了 —— 不报错、不留痕。所以「会话会无限增长、迟早撞窗口」这个担忧是**错的方向**；真正会撞的是「100 条里有大块工具输出」这种**单条很大**的情况。
- **`/compact` 也只压得到这 100 条。** 更早的内容压不回来，它已经不在 session 里了。所以 `/compact` 的语义是「把最近 100 条压成摘要」，**不是**「把整段对话压成摘要」。
- 想拿「字符数」当自动压缩阈值**在 100 条以内够得着**：每条消息渲染上限 4000 字，约 30 条就顶到 `MAX_TRANSCRIPT_CHARS`(120k) 的渲染上限。

**这条在代码里怎么被承认**：`src/feishu/compact.ts` 的 `shouldCompact()` 注释明写「**刻意不用「条数」当判据**」，理由是平台窗口本来就锁死在最近 100 条，拿条数触发只会白压一次（历史太短时摘要比原文还长，压了是负收益）。`test/smoke.ts` 有一条测试专门钉这一点：100 条短消息渲染出来离 120k 差得远，`shouldCompact` 必须是 `false`。

**出处与未实测的部分**：以上三条是读运行时源码得到的，**不是推断**。**未实测**的是「生产环境的 `maxItems` 会不会被平台调过」—— `.edgeone/` 是 CLI 从平台运行时模板生成的本地产物，理论上与线上同源，但这只能靠部署后打探针证实。

### 附带的一条：压缩钩子不存在，只能自己组合

平台的 `openaiSession()` 给的是 OpenAI Agents SDK 的原生 `Session`（`getItems` / `addItems` / `popItem` / `clearSession`），**没有暴露压缩钩子** —— 原版 `compactAfter(200_000)` + `onCompaction` 是 Cloudflare 那侧的私有扩展。所以压缩只能自己组合三步：`getItems()` → 调模型生成摘要 → `clearSession()` → `addItems([摘要])`。

两条安全约束写进了**唯一的实现** `runCompact()`（手动 `/compact` 与自动压缩共用，两处各写一遍迟早漏一条，而漏了就是「抹掉整段对话记忆」级别的事故）：

1. **摘要为空就什么都不动** —— 宁可这次失败重来，也不能清完没东西写回；
2. **先取完历史再清空** —— 顺序反了就是把整段记忆抹掉。

自动压缩的挂载点是 `ask()` 的回合末尾，判据是 `shouldCompact()`，只看一条：`renderTranscript(items)` 会不会被截断。**不写成 `renderTranscript(items).length > MAX_TRANSCRIPT_CHARS`** —— 它碰巧也能用，但正确性压在那约 31 个字的省略提示长度上，文案一改就**静默失效**；改用 `.includes(CLAMP_MARKER)`，且 `clampTranscript` 与 `shouldCompact` **两处共用同一个常量**。

⚠️ 压缩请求**刻意不走 `run(agent, …)`**：走 Agent run 的话这一回合会被写进 session，而压缩要求「读到全量历史 → 清空 → 只写回摘要」，中间插进别的项顺序就乱了。直接打一次 Chat Completions 天然不污染历史。

## 恢复强保证的缝

移植时刻意留了两条窄缝，**只动这两处就够**，不需要改架构：

```ts
// 会话 KV：线上直通 context.store.state，本地测试用 MemoryKv
export interface StateKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

// 跨会话记忆后端：裸 Blob，本地测试用 InMemoryMemoryBackend
export interface MemoryBackend {
  put(key: string, text: string): Promise<void>;
  read(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

按投入从小到大：

1. **去重的强保证** —— 把 `StateKv` 换成外部 MySQL/PG，加 `unique(message_id)` 索引。改动局部。
2. **记忆的并发写** —— 把 `MemoryBackend` 换成外部 Redis/PG 加事务。
3. **定时清理** —— 用 GitHub Actions（最小间隔 5 分钟）当外部调度器打一个清理端点，替代原版的 DO alarm。现在只能靠「每轮对话跑完搭车 prune 一次」（`agents/feishu/index.ts` 的 `work()` 里 `await store.prune()`），成本几乎为零但只在高频会话里才真的跑。
4. ~~会话压缩自动化~~ —— 已完成（见上）。

`MemoryBackend` 比 `StateKv` 多一个 `list`：枚举是跨会话记忆的核心能力（「我记过什么」），而 `context.store.state` 没有 list。两者是**两个不同的东西**，别混。

## 实测行为与文档推断的分界

这份仓库对「实测」和「按文档/源码推」分得很清，本页保持同样的标记。**别把下面的 ⚠️ 当成待办，也别把下面的 ✅ 当成永久结论** —— 换域名、换运行时版本后要重跑。

### 已实测（有真实报文或线上结果）

| 事实 | 怎么验的 |
|---|---|
| 返回 Response 后后台代码能跑完 | `?probe=start` / `?probe=check` 线上实测：`phase: finished`、`elapsedMs: 15046` |
| agents 运行时暴露裸 Blob SDK | 读构建产物 + 裸 Node `import server.mjs`：`getStore` 是函数，7 个键都在 |
| Blob 跨会话可见 | `?probe=store&op=write` 在会话 A 写、**换一个 conversation_id** 读，`blob.foreignCount > 0` |
| `onlyIfNew` 不生效 | 键已存在时带 `onlyIfNew` 写照样覆盖成功（token 模式；ambient 模式没测） |
| `set` 没有 TTL 参数 | `SetOptions` 只有 `onlyIfNew` / `cacheControl` |
| 我们写的值没有信封 | 同一凭证下对比：平台的 `memory-<projectId>` 读到 `{"__eo_pages_store_v":…}`，我们的 `agent-memory-<projectId>` 读到原样字符串 |
| `context.store.state` 是按会话隔离的 | `state/<conversation_id>/<key>` 布局在平台命名空间的 list 里清晰可见（255 个键） |
| `context.request.headers` **不是**标准 `Headers` 实例 | `typeof headers.get === "undefined"`，`forEach` 也没有 → 原来的取头恒等于 `""`，所有转发一律 401 |
| 改云端环境变量不实时生效 | 跑着的 agent 用的是部署时打包进去的快照；`AI_GATEWAY_*` 每次 deploy 都被覆盖回平台值 |
| 同一个 `chat_id` + 不同 `Makers-Conversation-Id` = 不同会话 | `verify-memory.mjs` 用四个会话证明会话身份是**请求头**、不是 chat_id |

### 未实测 / 按文档或源码推（风险已知）

| # | 未知数 | 怎么测 | 猜错的后果 |
|---|---|---|---|
| 1 | **流事件的实际名字**（`run_item_stream_event` 的 `tool_output`、思考增量） | 部署后打开 `/agent-metrics` 看真实事件名 | 卡片上少一行（只有答案，没有 🔧/✅ 串），**不影响答案正确性** —— 最终答案优先取 `result.finalOutput` |
| 2 | **平台工具的实际名字**（`commands` / `code_interpreter` / `files_*` …） | 对着 `/agent-metrics` 核一遍 | 名字是模型选工具的唯一依据，写错等于工具不存在 |
| 3 | `context.tools.all()` 在 `openai-agents-sdk` 框架下返回的对象形状 | 文档说是「lightweight function-tool compatible object」 | `_tools.ts` 按 `unknown[]` 收，不做形状假设 |
| 4 | `context.store.state` 的单值大小上限 | 文档没给数字 | 现在存的最大东西是 `feishu.events` 那 500 条去重记录（几十 KB 量级），离任何合理上限都很远 |
| 5 | 生产环境的 `maxItems` 会不会被平台调过 | 部署后打探针 | 见上面「会话历史恒被截到最近 100 条」 |
| 6 | `.edgeone/` 产物与线上运行时是否同源 | 只能靠部署后探针 | 上面那条 100 条的结论建立在这个前提上 |

未知数 1、2 的性质是「**猜错只会少显示，不会算错**」，所以可以带着不确定性上线；3、4 已经被代码用防御性写法兜住（不做形状假设、离上限很远）；5、6 是**结论的适用范围**问题，不是功能缺口。

## 平台强加的边界条件（不是缺口，是约束）

这几条不欠保证，但决定了代码的形状，改动前必须知道：

### `Makers-Conversation-Id` 的形状会静默 400

长度 6~36 字符，只允许 `0-9 a-z A-Z - _ .`。飞书 chat_id 是 `oc_` + 32 位十六进制（35 字符），原版照抄的 `fs-${chatId}` 是 38 字符 —— **超限**，而且本地测试用短 id 时一切正常，线上真实会话全挂，转发层只会看到「转发失败」，看不出是长度问题。

所以改成 `fs-` + `SHA-256(chatId)` 前 32 位十六进制，恒 35 字符，且**必须是确定性的** —— 哈希是粘性路由能成立的前提，不能换成随机 id。`test/smoke.ts` 把这个坑本身做成断言：`fs-${REAL_CHAT_ID}` 是 38 字符且超限。

⚠️ 同一条哈希算法在仓库里有**多份独立副本**（webhook、bridge、外部 CF 中继、验证脚本），改一处漏一处就是「两个会话记忆串了」这类最难查的现象。

### `cloud-functions/` 是无状态请求模式，最长 120 秒

飞书要求 webhook 在 3 秒内 ACK，而模型跑一个回合动辄二三十秒还会连着调工具 —— 所以**转发层绝不能跑模型**。转发层的 `fetch` 超时被压到 110 秒（留 10 秒余量）。对照 `agents/` 的 900 秒。

### 改云端环境变量要重新部署

跑着的 agent 用的是部署时打包进去的**快照**。实测踩过：改了 `INTERNAL_TOKEN` 之后请求照样 401，光看控制台判断不出是「值不对」还是「没生效」。所以才有了 `?probe=env` 回显变量名清单 + `INTERNAL_TOKEN` 的**长度和前 4 位**（不回显完整值）。加新环境变量时要同步 `probeEnv` 里的过滤正则，漏一个那个变量就在探针里**隐身**。

### 平台托管的 `AI_GATEWAY_*` 改不动

每次 `edgeone makers deploy` 都会 `[cli] Bound AI Gateway credentials to project`，把这 `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` / `AI_GATEWAY_MODEL` 三个键覆盖回平台值 —— 手写的值活不过一轮部署（实测：`setEnvs` 写成功、`listEnvs` 回读一致，部署完就变回去）。对照组是 `OPENCODE_SESSION`，同样是自定义键却从来没被重置过：**问题出在名字，不是写入能力**。所以自定义模型配置必须放普通键里。

### 没有部署忽略清单

`edgeone.json` 的 schema 里**没有** exclude / ignore 字段，EdgeOne 会把整个项目目录当公网静态资源上传（`bridge/` 的源码因此公网可读）。曾经把 `.env` 明文挂在网上两天。**含密钥的文件一律不能待在项目目录里** —— `.gitignore` 只挡 git，挡不住部署。同理 `.openwikiignore` 必须显式排掉 `.env`（OpenWiki 不读 `.gitignore`，而且读的是**工作区**不是 git 索引）。

### 沙箱按会话自动管理

平台按 `conversation_id` 分配沙箱实例并自动保温，不需要像原版那样自己存句柄（原版在 KV 里存了个 `sandbox` 键）。代价是沙箱的生命周期由平台决定，模型不能假定跨调用保留文件 —— 这条必须写进提示词（`files_*` 是**沙箱里的临时工作目录**，不是用户的磁盘，也不是长期存储）。

### 边缘会缓存 GET 探针

「改完代码 → 打探针复验」时必须加 cache-buster（`&_=$(date +%s)`）。带 `Cache-Control: no-cache` **请求头没用**。已有把缓存误诊成「构建没生效 / 部署没上去」的实测记录。

## 刻意接受的取舍（不是漏配）

平台没有阻止我们做下面这些事，是代码里**有意不做**的。三处是同一条规矩：**破坏性 / 面向他人的能力，默认不做；要做也得先说清护栏。**

- **不给应用开 `drive:drive` / `space:document:delete`** —— 所以建出来的文档删不掉也移不动。删除是不可逆的破坏性操作。
- **`feishu_docx_create` 只用用户身份、不兜底到应用身份** —— 应用身份建的文档用户只有**只读**（实测：菜单是「申请编辑权限」、打字打不进、删回「无权限操作」），而**两边都清不掉**。退回应用身份等于又造一篇删不掉的死文档。钉住它的是 `callUserOnly` 与两条带 `authorization` 断言的测试。
- **平台工具里 `files_remove` 不挂** —— 这条链路没有任何需要删文件的场景。
- **`gh_issue_*` 没有关闭 issue 的能力** —— 关闭别人提的 issue 是破坏性且面向他人的操作。

## 一句话总结

平台给不了的，代码用「换一种做法 + 明确写下弱在哪」来还债；能力差距里只有一条（会话窗口 100 条）是**在没人被告知的情况下被平台丢掉的**，而它恰好是最容易被误判为「会话会无限增长」的那条。要恢复强保证，只动 `StateKv`（3 个方法）或 `MemoryBackend`（4 个方法）的实现 —— 这两条缝是刻意留窄的。
