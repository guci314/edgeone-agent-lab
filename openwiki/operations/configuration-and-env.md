---
type: operations
title: 环境变量与配置目录
description: 这套移植的完整配置面及其失败语义：飞书应用凭证与 Encrypt Key、作为 fail-closed 门禁的 INTERNAL_TOKEN、模型路由变量与被平台托管的 AI_GATEWAY_*、调度模式、沙箱开关、记忆命名空间与 projectId 兜底、serper key、工作区与 issue 两把 GitHub token 及白名单、OAuth 回调、每用户令牌续期测试开关，以及把密钥挡在生成文档外的 OpenWiki/忽略规则。
tags: [configuration, environment-variables, secrets, fail-closed, feature-gating, openwiki]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-03T16:28:06.187Z
sources:
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-e119253b3c3737247dc63f2a
    resource: repo://.openwikiignore
  - id: openwiki-source-5f3aea8c254ad36759041b1d
    resource: repo://agents/feishu/_host.ts
  - id: openwiki-source-9b86e908de1b14e27863884a
    resource: repo://agents/feishu/_search.ts
  - id: openwiki-source-00fdb3d166c9958ea836d71d
    resource: repo://agents/feishu/_tools.ts
  - id: openwiki-source-6ba1b6f1f123db2bee92fb1c
    resource: repo://agents/feishu/index.ts
  - id: openwiki-source-05088d06025363715c7ef1b8
    resource: repo://cloud-functions/feishu-webhook/index.ts
  - id: openwiki-source-29e0e549684285159e4ee7f8
    resource: repo://docs/03-%E9%AA%8C%E8%AF%81%E6%B8%85%E5%8D%95.md
  - id: openwiki-source-a007013901bad3643fe76c22
    resource: repo://edgeone.json
  - id: openwiki-source-019e2f50672ab2474e1d694a
    resource: repo://src/feishu/global-memory.ts
  - id: openwiki-source-93cffa43ae17466eb61c6c8e
    resource: repo://src/feishu/oauth.ts
  - id: openwiki-source-f2a7e3bf7337527676418fb8
    resource: repo://src/ghworkspace/client.ts
  - id: openwiki-source-a163e04aed55f7c8a360b252
    resource: repo://src/ghworkspace/issues.ts
  - id: openwiki-source-52891af3d1130cc7375b5e4e
    resource: repo://test/smoke.ts
generated: { by: "openwiki/0.6.1", at: "2026-10-03T16:28:06.187Z" }
---

# 环境变量与配置目录

这套移植的所有可调行为都收在环境变量里 —— 线上配在 Makers 控制台的「环境变量」，本机调试写进根目录 `.env`（`edgeone makers link` 可以把控制台的值同步下来）。本页按**能力**分组讲每个变量启用了什么、缺了会**静默**消失什么工具或功能，以及几条容易踩的配置时序。

配置面有一条贯穿全仓的规矩：**配不全就当没配**。半配的 key 或凭证不会被当成"再试一次也许能行"，而是整个能力不挂载 —— 挂一族必然失败的工具只会让模型每轮都先去撞一次墙。这条规矩同时体现在模型路由（`resolveModelRoute`）、搜索、工作区、issue 和记忆上。

> 密钥的注入与"改完要重新部署"的时序见[部署与发布](deployment-and-release.md)；探针如何回显配置见[诊断与探针](diagnostics-and-probes.md)；模型两家的规则差异见[模型网关路由与重试诊断](../integrations/model-gateway-routing.md)。

## 密钥绝不进 wiki：`.openwikiignore`

最优先的一条不是某个变量，而是**让密钥不被写进文档**的规则。

根目录的 `.env` 里是**活的密钥**（`FEISHU_APP_SECRET` / `FEISHU_ENCRYPT_KEY` / `INTERNAL_TOKEN` / `AI_GATEWAY_API_KEY` / `SERPER_API_KEY` / `GITHUB_WORKSPACE_TOKEN` / `GITHUB_ISSUE_TOKEN` / `OPENCODE_API_KEY`）。`.gitignore` 已经把 `.env` 挡住不让提交，但 **OpenWiki 不读 `.gitignore`，只读 `.openwikiignore`**；它读取的是**工作区**而不是 git 索引 —— 于是即使 `.env` 没被提交，OpenWiki 照样会把它当语料读进去，把密钥写进 `openwiki/` 下的页面，而 `openwiki/` 本身是要提交进 git 的，等于二次泄露。（这个仓库已经有过一次 `.env` 经 EdgeOne 部署被公开的事故。）

因此 `.openwikiignore` 显式排除 `.env` / `.env.local` / `.env.*.local`，同时排掉 `node_modules/`、`.edgeone/`、`.npm-cache/`、`dist/` 这些体积大头。`.env.example` 是脱敏模板，**刻意保留** —— 它对理解配置结构有用，且不含真实值。

语法是 gitignore 风格：last-match-wins、`!` 取反、前导 `/` 锚定仓库根、尾随 `/` 仅匹配目录、大小写不敏感。

## 飞书应用凭证：文档工具族的门

| 变量 | 作用 | 缺了会怎样 |
|---|---|---|
| `FEISHU_APP_ID` | 自建应用 App ID（`cli_` 开头） | 云文档工具族整个不挂；webhook 返 503 |
| `FEISHU_APP_SECRET` | 应用密钥 | 同上；取 tenant token 会 401 |
| `FEISHU_VERIFICATION_TOKEN` | 事件订阅页的 Verification Token | webhook 不认事件来源（503） |
| `FEISHU_ENCRYPT_KEY` | 加密策略里的 Encrypt Key | 验签那一步整个跳过 —— **没有任何请求来源证明**，任何人都能伪造事件推送 |

`FEISHU_ENCRYPT_KEY` 强烈建议配：不配它就没有 `X-Lark-Signature` 这道证明，只剩明文比对 Verification Token。本地调试可以先不配（明文 JSON 就能测通链路），等链路通了再配上、重新部署。

云文档读写六个工具（`feishu_*_read` / `*_write` / `feishu_docx_create`）的挂载条件只需要 **`FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 齐备**（应用身份 tenant token），**不要求这个用户 `/login` 过**。改完飞书后台权限要**发一个新版本**才生效；已经授权过的老用户要重新发 `/login` 才拿得到新加的写权限。

## `INTERNAL_TOKEN`：fail-closed 的内部令牌

`INTERNAL_TOKEN` 是这套链路里**唯一一个"没配就拒绝服务"**的变量，而且这个门开在两端。

`agents/feishu` 路由部署后是**公网可达**的，没有这道门任何人都能拿它烧模型额度。所以：

- `agents/feishu/index.ts`：`env.INTERNAL_TOKEN` 为空 → **503**，附带一句"该配什么"的指引；令牌不匹配 → **401**。这是 fail-closed，不是 fail-open。
- `cloud-functions/feishu-webhook/index.ts`：同样在入口检查，没配就 503。

它同时兼任第二重身份：**OAuth `state` 的 HMAC 签名密钥**。发起 `/login` 时用 `INTERNAL_TOKEN` 签 state，回调进来时用同一个密钥验签。中转层（cf-agent-lab）持有同一个值（`EO_INTERNAL_TOKEN`），两侧必须同值 —— 于是不必再多分发一个密钥。身份（`chatId` / `openId`）全从**签名过的 state** 里取，不信 body 里的同名字段。

取令牌的写法刻意兼容三种形态：标准 `Headers`、普通对象（含大小写变体）、以及**请求 body**。原因是实测发现这个 runtime 里的 `context.request.headers` 不是标准 `Headers` 实例（`headers.get` 是 undefined），原来的 `request.headers.get("x-internal-token")` 恒等于空串，导致所有转发一律 401 而报错文案只说"不匹配"。把令牌放进 body 是兜底 —— header 这条路在平台侧不可控，body 一定能到。

> 生成方式：`openssl rand -hex 24`。

## 模型路由：`OPENCODE_*` 与平台托管的 `AI_GATEWAY_*`

这一组是配置里最容易"错得很像"的地方，完整机制见[模型网关路由与重试诊断](../integrations/model-gateway-routing.md)。这里只从配置面归纳：

| 变量 | 说明 |
|---|---|
| `OPENCODE_API_KEY` / `OPENCODE_BASE_URL` | **必须成对配**。只配一半会被当成完全没配 |
| `OPENCODE_MODEL` | **裸名**（`deepseek-v4.1-flash`），不带 `@makers/` 前缀 |
| `OPENCODE_SESSION` | `x-opencode-session` 头的值；只是个路由标签，同项目内保持一致 |
| `AI_GATEWAY_API_KEY` / `AI_GATEWAY_BASE_URL` / `AI_GATEWAY_MODEL` | **平台托管，每次 deploy 会被覆盖回平台值**。只作兜底 |

`resolveModelRoute(env)` 按**来源**整体决定，绝不各取一半：`OPENCODE_*` 两个都非空就用它（`source = "OPENCODE_*"`），否则退回 `AI_GATEWAY_*`，两组都没配全返回 `{ undefined, undefined, "未配置" }`。模型名是另一个函数、另一套优先级：`OPENCODE_MODEL` → `AI_GATEWAY_MODEL` → 硬编码兜底 `deepseek-v4.1-flash`。

为什么不能用 `AI_GATEWAY_*` 存自定义凭证：`edgeone.json` 的 framework 适配读这三个名字，CLI 每次 `edgeone makers deploy` 都会执行 `Bound AI Gateway credentials to project`，用平台的值覆盖它们。实测 `setEnvs` 写入成功、`listEnvs` 回读也一致（`baseURL` 长度 34 → 29），跑完一次部署就变回旧值。对照组 `OPENCODE_SESSION` 是自定义键，从来没被重置过 —— 问题出在**名字**，不是写入能力。因此**任何自定义凭证都必须放普通键**（如 `GITHUB_WORKSPACE_TOKEN`），别塞进 `AI_GATEWAY_*`。

## 调度模式：`FEISHU_DISPATCH_MODE`

`async`（默认）：agent 先回 **202**，再在后台跑完整个回合，webhook 立刻 ACK 飞书。
`sync`：agent 跑完才返回，webhook 要等，但**不依赖后台执行能力**。

这个开关存在的原因是 EdgeOne 官方没有明文承诺"返回 Response 之后未 await 的异步代码还能不能跑完"。部署后先用 `/feishu?probe=start` → `?probe=check` 实测，实测结果决定填哪个：`verdict` 为 ✅ 就保持 `async`，为 ❌ 就切 `sync`。模式还可以被**请求的 `?mode=` 查询参数**覆盖（`sync` 模式下响应体里带 `replies`，是自动化核对"机器人答了什么"的唯一途径，因为流式卡片正文通过 `im/v1/messages` 读不到）。

## 沙箱开关：`SANDBOX_ENABLED`

平台内置的沙箱工具族（`commands` / `code_interpreter` / `files_*` / `browser_*`）通过 `context.tools.all()` 收进来。`SANDBOX_ENABLED` 设成 `0` / `false` / `off` 就**整条不挂** —— 部署时想先把"纯搜索问答"跑通、把沙箱留到后面再开，这个开关有用。取值不区分大小写，未设即视为 `1`。

即使开着，也有一组工具被**刻意排除**：`browser_screenshot` / `browser_click` / `browser_type` / `browser_evaluate`（要跟人来回确认点击目标，飞书里没这个机会）与 `files_remove`（沙箱本来就会过期，不需要模型手动清理）。当自建的 `web_search` 挂上时，平台内置的同名工具也会被摘掉。

> ⚠️ 沙箱的启停影响工具清单，与[工具契约与清单](../concepts/tool-contract-and-inventory.md)里的挂载条件表互为对照。

## `SERPER_API_KEY`：自建联网搜索的门

平台内置的 `web_search` 底层是腾讯云 WSA，本项目从没配 `WSA_API_KEY`，一调就报 `web_search requires the WSA_API_KEY environment variable.` —— 是**坏的**，而模型只因工具存在就会先试一次、失败、再改道，白烧一轮。

所以 `web_search` 改成自建、底层走 serper。`SERPER_API_KEY` 为空时 `makeSearchTools` 返回空数组 —— **搜索工具整个不挂**，模型也就不会去撞一堵必然失败的墙。挂了自建搜索就必须把平台内置的同名工具摘掉，否则两个同名同用途的工具同时在列表里，模型选哪个全看运气。

## 工作区仓库：`GITHUB_WORKSPACE_TOKEN`

启用的工具族：`ws_ls` / `ws_read` / `ws_write` / `ws_rm`（外加 `ws_commit`），面向 agent 自己的 GitHub 私有仓库，每次写都是一次真实 commit。

| 变量 | 说明 |
|---|---|
| `GITHUB_WORKSPACE_TOKEN` | fine-grained PAT，**只授默认仓库的 Contents: Read and write**。必须是**普通环境变量**，别放进 `AI_GATEWAY_*` |
| `GITHUB_WORKSPACE_REPO` | 覆盖仓库名。默认 `guci314/cf-agent-workspace`，一般不用配 |
| `GITHUB_API_BASE` | **只为本地测试指向 mock，生产不要设** |

**没配 TOKEN 时 `ghWorkspaceConfig` 返回 null，工具一个都不挂**。仓库名认不出 `owner/name` 形状也当作没配 —— 宁可没有工具，也不要拿一个拼错的仓库名去 404（那种错看起来像"仓库不存在"，实际是配置问题）。

## GitHub issue：一把**独立**的 PAT 与一条白名单

启用的工具族：`gh_issue_create` / `gh_issue_comment`。

| 变量 | 说明 |
|---|---|
| `GITHUB_ISSUE_TOKEN` | **必须是另一把 PAT**：工作区那把只授 Contents，而 Issues API 不属于 Contents 权限范围，拿它提 issue 会 403。GitHub 侧权限只要 Issues: Read and write |
| `GITHUB_ISSUE_REPOS` | 逗号分隔的 `owner/name` 白名单 |

两条规则都关乎安全：

- **白名单留空 = 整族工具不挂。** 没有白名单就意味着"这把 token 能开的仓库全都能开"，而 issue 是对外可见的副作用，不能这样。测试直接钉住了这一点：只有 token 没有白名单 `ghIssueConfig` 返回 null，白名单里全是非法格式也等于没有白名单。
- **两把 token 必须分开。** 混用一把会让"改工作区凭证"这个动作意外影响 issue 能力，反之亦然。

白名单比对**大小写不敏感**（GitHub 的 `owner/repo` 本就不分大小写），配置写 `Owner/One` 而模型传 `owner/one` 不该被判成白名单外；命中失败时错误信息会**列出允许的仓库名**，只说"不允许"模型会去猜或者道歉。

## 云端存储与跨会话记忆：`projectId` 兜底与命名空间

跨会话记忆落在**不带会话前缀**的 Blob 命名空间里，而定位它需要 platform 注入的 projectId。

| 变量 | 说明 |
|---|---|
| `AGENT_MEMORY_NAMESPACE` | 显式覆盖记忆的 Blob 命名空间。不设时按 `agent-memory-<projectId>` 算 |
| `PAGES_PROJECT_ID` / `ProjectId` / `EDGEONE_PROJECT_ID` | 平台注入；三处按顺序兜，值一样 |

`memoryBackendStatus(env)` 依次查 `env.PAGES_PROJECT_ID` → `env.ProjectId` → `process.env.PAGES_PROJECT_ID` → `process.env.ProjectId` → `process.env.EDGEONE_PROJECT_ID`，**两处都找**（`context.env` 与 `process.env`）—— 实测 agents 运行时里 `PAGES_BLOB_DEPLOY_CREDENTIAL` 出现在 `process.env`，只查 `context.env` 有可能让整个功能静默失效。

拿不到 `__EDGEONE_AGENT_RUNTIME__.getStore` 或拿不到 projectId 时返回 `available: false` 与一句可直接给人看的原因。此时 `blobMemoryBackend` 返回 null，**记忆工具整个不挂、提示词里也不提"你有长期记忆"** —— 挂一个永远失败的工具只会让模型把基础设施问题当成自己的错。`?probe=store` 的 `memory` 字段就是同一个解析函数的输出。

## 用户令牌与 OAuth

| 变量 | 说明 |
|---|---|
| `FEISHU_OAUTH_REDIRECT_URI` | OAuth 回调地址。**刻意没有默认值** |
| `FEISHU_USER_TOKEN_SKEW_MS` | 把"提前多久判 access token 过期"放大，专供手工验续期链路。**平时不要设** |

`FEISHU_OAUTH_REDIRECT_URI` 必须和飞书后台「安全设置 → 重定向 URL」登记的完全一致，差一个字符授权页就直接报错。所以 `redirectUri()` 在没配时**抛错**而不是猜一个默认值 —— 猜一个的话用户看到的是飞书的一个报错页，完全不知道原因；宁可现在就说清楚是配置缺了。回调换令牌时也读同一个 env，两边天然一致。

`FEISHU_USER_TOKEN_SKEW_MS` 默认提前 5 分钟判过期，意味着想验一次真实的续期得等将近两小时 —— 这条最容易坏的路就成了"只能靠等"的路。设成 `7200000`（2 小时）后，随便读一次文档就会走到续期分支。测试里有"skewMs 放大后新鲜令牌也会被判过期"一条钉住这个行为。

## 入站侧可选变量

| 变量 | 归属 | 说明 |
|---|---|---|
| `FEISHU_ALLOWED_OPEN_IDS` | webhook | 逗号分隔的 open_id 白名单；**空 / 未设 = 不限制**。名单外静默 ACK（故意不回"你没权限"，那等于告诉对方这个端点存在） |
| `AGENT_URL` | webhook | 覆盖转发目标。默认 `${origin}/feishu` |
| `FEISHU_DEBUG_OPEN_ID` | 本机工具 | `tools/ask-bot.mjs` 无头测试通道用的**提问人** open_id。填错人会一路报"未授权"（用户令牌按 openId 分槽） |

## 配置面的时序与不变量

几条每次改配置都要想一遍的规矩：

- **改云端项目环境变量不会实时生效。** 跑着的 agent 用的是**部署时打包进去的快照**。实测踩过：改了 `INTERNAL_TOKEN` 之后请求照样 401，光看控制台根本判断不出是"值不对"还是"没生效" —— 所以才有了 `?probe=env` 回显变量名清单 + `INTERNAL_TOKEN` 的长度和前 4 位。**改完要重新部署**（`gh workflow run deploy.yml` 触发一次即可）。
- **加新变量要同步探针的 key 过滤正则。** `?probe=env` 用一个按名字过滤的白名单正则（`/FEISHU|INTERNAL|AI_|AGENT|SANDBOX|SERPER|OPENCODE|GITHUB/`）决定"哪些变量在探针里看得见"，漏一个那个变量就在探针里**隐身**。踩过两次：漏 `SERPER`、漏 `GITHUB` —— 都导致"运行时到底有没有这个 key"看不出来，误判成环境变量没生效。
- **平台托管键（`AI_GATEWAY_*`）永远别指望能改**，自定义凭证一律放普通键。
- **密钥绝不回显。** 探针只回显变量名、长度、首尾各 4 字符或指纹（如 `serperFingerprint` 的 FNV-1a 哈希），不回显明文；GitHub 那两把 token 只出现在请求头里，绝不进任何错误信息（错误信息会被模型读、被飞书卡片渲染、被用户复制出去）。
- **`INTERNAL_TOKEN` 与 OAuth state 共用同一个密钥**，改动它等于同时改动两道关的门禁与授权签名 —— 两侧（中转与 agent）必须同步。

## 相关页面

- [部署与发布](deployment-and-release.md) —— 环境变量如何进入部署快照、改完为什么要重新部署
- [诊断与探针](diagnostics-and-probes.md) —— `?probe=env` / `?probe=model` / `?probe=store` 如何把配置问题变成可判断的结论
- [工具契约与清单](../concepts/tool-contract-and-inventory.md) —— 每个环境变量门控着哪一族工具、缺了各自消失什么
- [模型网关路由与重试诊断](../integrations/model-gateway-routing.md) —— `OPENCODE_*` 与 `AI_GATEWAY_*` 的完整规则
