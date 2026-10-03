---
type: overview
title: 快速上手与任务路由图
description: edgeone-agent-lab 的入口页：这是什么（EdgeOne Makers 上的飞书通用助手，OpenAI Agents SDK）、三个运行时/逻辑层各自负责什么、哪些说法已被线上实测而哪些只是文档推断，以及「我接下来要改什么」该去读哪一页的任务路由表。
tags: [quickstart, navigation, overview, onboarding, verification-status, edgeone-makers]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-03T16:28:06.187Z
sources:
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-6ba1b6f1f123db2bee92fb1c
    resource: repo://agents/feishu/index.ts
  - id: openwiki-source-28ed19af7422da0dde523305
    resource: repo://docs/01-%E6%9E%B6%E6%9E%84%E4%B8%8E%E7%A7%BB%E6%A4%8D%E6%98%A0%E5%B0%84.md
  - id: openwiki-source-29e0e549684285159e4ee7f8
    resource: repo://docs/03-%E9%AA%8C%E8%AF%81%E6%B8%85%E5%8D%95.md
  - id: openwiki-source-a007013901bad3643fe76c22
    resource: repo://edgeone.json
  - id: openwiki-source-f8d10828394c4129061d5b0e
    resource: repo://index.html
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-440a24ee5e90b3b44b230fb1
    resource: repo://src/feishu/store.ts
  - id: openwiki-source-c866a5a75b2952fb1b3a25b5
    resource: repo://src/feishu/turn.ts
  - id: openwiki-source-52891af3d1130cc7375b5e4e
    resource: repo://test/smoke.ts
  - id: openwiki-source-403a9d43fcce3607b38ceabd
    resource: repo://tools/ask-bot.mjs
generated: { by: "openwiki/0.6.1", at: "2026-10-03T16:28:06.187Z" }
---

# 快速上手与任务路由图

`edgeone-agent-lab` 是 `cf-agent-lab`（Cloudflare Workers + Durable Objects）到 **EdgeOne Makers** 的移植版：用 **OpenAI Agents SDK** 重写 Agent 核心，**飞书是唯一入口**（没有网页聊天界面）。它是一个**通用助手**——在飞书里直接问，它会搜网页、读飞书云文档、读写它自己的 GitHub 工作区仓库、跑代码算东西，并把该记住的事实**跨会话**记住。

> 2026-09-25 有过一次定位变更：原版是「代码仓库问答」，`/repo` 命令和整个 `src/workspace/` 语料层已删除。那些是**主动删掉的，不是缺口** —— 见[刻意不做的事](concepts/design-non-goals.md)。

本页是全库的分发点：先确认「这个仓库现在处于什么验证状态」，再用下面的路由表跳到你要改的那一层。**本页不重复各页内容。**

## 先看验证状态，再决定信谁

**源码与测试是唯一权威。** `docs/` 下的中文文档（`docs/01-架构与移植映射.md`、`docs/02-飞书配置.md`、`docs/03-验证清单.md`）记录的是**意图和推断**，里面混着大量「按文档写、没实测」的结论，也有过好几次被实测推翻的记录（同一类问题连错两次的情况都发生过）。本 wiki 页面同样沿用了这个标记习惯。

判断一句话能不能信，看它的出处落在哪一档：

| 档位 | 含义 | 例子 |
|---|---|---|
| ✅ 已实测 | 在线上环境跑过并留了结果 | 「返回 Response 后后台代码能跑完」（`phase: finished` / `elapsedMs: 15046`）；跨会话记忆端到端（`npm run verify:memory` 13/13）；Blob 后端可用（agents 运行时内置 `getStore`） |
| ✅ 读运行时源码得到 | 不是推断，但只在本地构建产物上核过 | 平台 session 的 `effectiveLimit = 100`（`openaiSession(cid)` 不传 `maxItems`） |
| ⚠️ 按文档写、未实测 | 风险低但没验过 | 平台沙箱工具的实际名字；`context.tools.all()` 返回的对象形状；`context.store.state` 的单值大小上限；**流事件的实际名字仍未核**（要部署后看 `/agent-metrics`，猜错的后果只是卡片少一行，不影响答案） |
| ❌ 没跑过 | 明确记在 `README.md` 里 | 飞书**入站** webhook 那一段（事件订阅链路）；出站链路已验过 |

两处**未经实测就当真**最容易吃亏的地方：`edgeone makers dev` 本地起不来 agent 路由（`agent-node` 不绑定端口），所以「本地能跑」「状态页能打开」这类观察**不能当证据**；以及自动化核对答案只能走 `?mode=sync` 的响应回显（流式卡片正文从 `im/v1/messages` 读不到）。

## 三个运行时 / 三个逻辑层

同一条链路被拆成三块，**每块的约束完全不同**，改代码前先确认自己站在哪一块里：

| 层 | 入口 | 模式与上限 | 负责什么 | 平台耦合 |
|---|---|---|---|---|
| **入站层** `cloud-functions/feishu-webhook/index.ts` | `POST /feishu-webhook` | 无状态请求模式，**必须 3 秒内 ACK**（硬上限 120 秒） | 证明请求可信（验签、解密、token、白名单、形状校验）→ 解析 → 补 `Makers-Conversation-Id` 头 HTTP 转发。**不碰模型** | 高，但只有一个文件 |
| **会话层** `agents/feishu/` | `POST /feishu` | 会话模式，同一 `conversation_id` 粘性路由到同一实例，单次最长 900 秒（`edgeone.json`） | 令牌门禁、去重、限流、调度、跑模型、调工具、流式回卡片 | 高：`context.store.*`、`context.tools.*`、`context.conversation_id` |
| **业务层** `src/`（`feishu/` `ghworkspace/` `shared/`） | 被上面两层 import | 纯 Node/Web 标准 API，可在裸 Node 里跑测试 | 几乎全部业务逻辑：验签解密、事件解析、命令、回合流程、存储适配、云文档工具、跨会话记忆、用户令牌、GitHub 工作区 | **零**，平台能力一律通过窄接口注入 |

**为什么必须拆两段**：平台硬约束要求**所有** `agents/*` 调用都带 `Makers-Conversation-Id` 头，缺失或不合法直接 `400`；而飞书的事件推送是飞书服务器发起的，加不了自定义头。于是这一层只能是无状态 cloud-function，它自己也不能跑模型（3 秒 ACK 撑不住二三十秒的回合）。

**改代码的默认落点就是 `src/`**：平台无关层是整个仓库里唯一可以「改一行、在裸 Node 里验一次、不用等部署」的地方。平台耦合被刻意收在两个窄接口后面（`StateKv` 3 个方法、`MemoryBackend` 4 个方法），换存储后端的改动面就在那里。

完整拓扑、每个文件的责任、`edgeone.json` 怎么把它们绑成一个可部署单元 → [架构总览](architecture/overview.md)。

## 任务路由表：我要改的东西该读哪页

| 我要做的事 | 先读 | 会同时牵动的 |
|---|---|---|
| 加一个新工具 | [工具契约、工具族与挂载规则](concepts/tool-contract-and-inventory.md) | 工具的**挂载条件**与提示词里对应能力段落的**拼接条件必须一致**（说了但手上没有的工具，模型会去调然后白烧一轮）；卡片渲染见[工具调用与流式渲染](workflows/tool-invocation-and-streaming.md) |
| 加一个新命令 | [命令分派与控制流](workflows/commands-and-control.md) | `src/feishu/commands.ts` 的 `kind` 联合 + `src/feishu/turn.ts` 的 `switch` + `FeishuTurnHost` 方法 + 测试；未知命令**绝不能**落进模型即兴回答 |
| 改跨会话记忆的行为 | [跨会话长期记忆](concepts/cross-session-memory.md) | 可见性边界收口在 `isVisibleTo` 一个函数上；「一条事实一个键」这类规则必须写在**模型看得见的地方**，写进代码注释等于没写 |
| 改飞书云文档读写 | [飞书云文档读写工具](workflows/feishu-doc-read-write.md) | 读走「应用身份优先、用户兜底」，**建文档只走用户身份且不兜底**（有意的门槛，别加回应用身份兜底） |
| 走一遍授权链路 / 排查「读不了文档」 | [云文档授权流程](workflows/oauth-authorization-flow.md)、[身份模型：应用身份 vs 用户身份](concepts/identity-and-authorization.md) | `user_access_token` 按 `openId` 分槽存；回调落在 agent 路由的 `op="oauth"` 分支且**排在去重之前、同步返回** |
| 改会话记忆/压缩 | [会话压缩：手动与自动](workflows/session-compaction.md) | 平台 session 有**静默施加的 100 条窗口**；压缩有两条安全约束（没摘要不清空、先读完再清） |
| 改提示词 | [提示词契约与模型行为规则](concepts/prompt-contract.md) | 提示词段落按环境**条件拼接**；「我必须说清哪些规则是给模型看的」 |
| 加/改环境变量 | [环境与配置目录](operations/configuration-and-env.md) | 每个变量的**失败语义**（fail closed / 静默降级 / 工具不挂）；⚠️ `AI_GATEWAY_*` 是平台托管的，每次 deploy 会被重置，别拿来存自己的 key |
| 排查「答案不对 / 卡片坏了 / 记忆没生效」 | [诊断、探针与排障](operations/diagnostics-and-probes.md) | 探针的令牌门禁按「泄漏面」开；状态页那两个探针是**故意公开**的 |
| 改模型路由 / 排查模型报错 | [模型网关路由与重试诊断](integrations/model-gateway-routing.md) | 两个网关的**模型名规则正好相反**；`reasoning_effort` 由模型类决定 |
| 改入站方式（webhook / 中继 / 本机 bridge） | [会话路由与三种入站实现](architecture/conversation-routing-and-ingress.md)、[外部入站：CF 中继与本机 bridge](integrations/external-ingress-relay.md) | 三种实现必须产出**完全相同**的 `conversation_id` 和事件字段；浏览器跳转那条必须补头转发 |
| 改飞书 API 调用 | [飞书开放平台集成面](integrations/feishu-open-platform.md) | 业务码错误处理（`99991663`/`99991664`/`99991672`/`99991679` 各自指向不同动作） |
| 改 GitHub 工作区 / issue 工具 | [GitHub 工作区工具与自动部署循环](workflows/github-workspace-and-deployment.md) | `projects/<name>/` 是部署单元，所以「一次提交多文件只产生一个 commit」是硬要求；issue 工具带白名单 |
| 加测试 | [冒烟测试套件](testing/smoke-tests.md) | 裸 Node + `--experimental-strip-types`：**不能用构造函数参数属性**（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）；`fetch` 被全局 stub |
| 上线前验证 / 排查「部署了但不对」 | [端到端验证脚本与执行顺序](testing/end-to-end-verification.md) | 有明确的**假阳性陷阱**清单（可猜到的探针事实、被当成肯定的否定回答、复用的 conversation_id、按实例计数的计数器） |
| 部署、发布门禁 | [部署与发布](operations/deployment-and-release.md) | push main → GitHub Actions：`typecheck` + `npm test` 是**硬门禁**，挂了不上线 |
| 判断「某个能力没做」是不是缺口 | [刻意不做的事与破坏性能力政策](concepts/design-non-goals.md) | agent 自改代码、删除文档、关 issue 都是**明确决定不做**的，别当成待办去补 |
| 搞清楚「什么保证被弱化了」 | [平台约束与弱化的保证](architecture/platform-constraints.md) | 无 RPC 寻址、无 SQL、无 alarm、Job 无 CAS/TTL、去重不是分布式锁 |
| 看一条消息的完整生命周期 | [入站请求生命周期：从 webhook 到回复](architecture/request-lifecycle.md) | 检查顺序是踩出来的，**不要重排** |
| 状态存在哪、为什么不混用 | [存储模型：三个键空间](concepts/storage-model.md) | 按会话的平台 state / 平台托管的对话历史 / 跨会话 Blob 命名空间 |

## 上手：跑起来的第一组命令

前置：Node.js ≥ 22（冒烟测试用 `--experimental-strip-types`）。

```bash
npm install
npm run typecheck     # tsc --noEmit，零错误
npm test              # 裸 Node 跑 test/smoke.ts，190 项，不启 EdgeOne / 不连飞书
```

这两条**不需要登录、不需要部署、不发网络请求**，改完任何 `src/` 逻辑都先跑它们。它们能覆盖最容易错的那几件事（验签与解密的**顺序**、去重判据、摘要写回形状、那个 35 字符的 `conversation_id`），因为这些东西全都不依赖平台。

要继续往下走：

```bash
npm i -g edgeone && edgeone login   # dev 之前必须先登录
cp .env.example .env                # 按注释填；变量清单见「环境与配置目录」
npm run dev                         # 默认 http://localhost:8088
```

⚠️ 本地 dev 有三个实测坑：`agent-node` 不绑定端口（**`/feishu` 本地打不到**）、前端 dev server 会被跳过（状态页只能部署后看）、不加 `--skip-env-sync --skip-ai-gateway-sync` 会卡在交互式提问上。

部署之后**第一件事**是跑状态页上的「后台执行能力自测」（或 `?probe=start` / 隔 16 秒再 `?probe=check`）：它的结果决定 `FEISHU_DISPATCH_MODE` 填 `async` 还是 `sync`。当前线上结论是 ✅ 成立，保持 `async`。

## 全库页面地图

- **架构**：[总览](architecture/overview.md) · [入站请求生命周期](architecture/request-lifecycle.md) · [会话路由与三种入站实现](architecture/conversation-routing-and-ingress.md) · [平台约束与弱化的保证](architecture/platform-constraints.md)
- **概念**：[身份模型：应用身份 vs 用户身份](concepts/identity-and-authorization.md) · [工具契约与工具族](concepts/tool-contract-and-inventory.md) · [存储模型：三个键空间](concepts/storage-model.md) · [跨会话长期记忆](concepts/cross-session-memory.md) · [提示词契约](concepts/prompt-contract.md) · [刻意不做的事](concepts/design-non-goals.md)
- **工作流**：[命令分派与控制流](workflows/commands-and-control.md) · [工具调用与流式渲染](workflows/tool-invocation-and-streaming.md) · [会话压缩](workflows/session-compaction.md) · [云文档读写](workflows/feishu-doc-read-write.md) · [云文档授权流程](workflows/oauth-authorization-flow.md) · [GitHub 工作区与自动部署循环](workflows/github-workspace-and-deployment.md)
- **集成**：[飞书开放平台集成面](integrations/feishu-open-platform.md) · [模型网关路由与重试诊断](integrations/model-gateway-routing.md) · [外部入站：CF 中继与本机 bridge](integrations/external-ingress-relay.md)
- **运维**：[环境与配置目录](operations/configuration-and-env.md) · [部署与发布](operations/deployment-and-release.md) · [诊断、探针与排障](operations/diagnostics-and-probes.md)
- **测试**：[冒烟测试套件](testing/smoke-tests.md) · [端到端验证脚本与执行顺序](testing/end-to-end-verification.md)

## 几条一上手就该知道的规矩

- **源码与测试是权威**，本页和 `docs/` 都可能有未核实的推断；本页已把「未实测」的地方点出来，但覆盖面不完整 —— 有疑问就回去读源码。
- **别照搬原版（Cloudflare）的保证。** 移植最容易出的错不是「代码写不出来」，而是「照抄了代码但没照抄它依赖的平台保证」。原版 `fs-${chatId}` 就是典型：本地短 id 测试一切正常，线上真实会话全部 400。
- **含密钥的文件一律不能待在项目目录里。** EdgeOne 会把整个项目目录当公网静态资源上传（`edgeone.json` 没有 exclude / ignore 字段），`.gitignore` 挡 git、挡不住部署 —— 这里已经出过一次 `.env` 被公开的事故。
- **不要手改 `openwiki/` 下生成的页面**；wiki 由定时 workflow 刷新，改行为请改源码与 `docs/`。
- **不要把「某个能力被砍掉了」当成待办。** 破坏性能力（删除类）和 agent 自改代码都是想过并明确决定不做的，理由记在[刻意不做的事](concepts/design-non-goals.md)。
