# edgeone-agent-lab

`cf-agent-lab`（Cloudflare Workers + Durable Objects）到 **EdgeOne Makers** 的移植版。
用 **OpenAI Agents SDK** 重写 Agent 核心，入口只有飞书 —— 没有网页聊天界面。

一个**通用助手**：在飞书里直接问，它会搜网页、读你授权的飞书云文档、跑代码算东西，
并把该记住的事实跨会话记住。

> 2026-09-25：原版是「代码仓库问答」—— 用户先发 `/repo owner/name` 导入一个 GitHub
> 仓库，再问那个仓库的代码。**`/repo` 命令和整套 `src/workspace/` 语料层已经删掉**，
> 改成上面这个通用助手。删掉的理由和迁移细节见 `docs/01-架构与移植映射.md`。

---

## ⚠️ 先读这段：这个仓库的验证状态

**核心链路已经在线上端到端跑通了**，剩下的都是「按文档写、没实测」的低风险细节。

| 环节 | 状态 |
|---|---|
| 代码（约 5800 行） | ✅ 写完 |
| `npm install` | ✅ **通过** —— 104 个包，约 1 分钟 |
| `tsc --noEmit` 类型检查 | ✅ **零错误** |
| `npm test` 冒烟测试 | ✅ **146 项全通过**（验签/解密、命令解析、去重限流、webhook 端到端、回合流程、会话压缩、云文档授权与工具族、跨会话记忆） |
| `edgeone makers dev` 本地起服务 | ⚠️ **能起来，但 agent 路由本地打不到** —— `agent-node` 不绑定端口（见下） |
| 跨会话记忆的存储层 | ✅ **已实测**（不靠文档推断：agents 运行时内置 Blob SDK） |
| 【未知数 1】返回 Response 后后台代码能否跑完 | ✅ **线上实测成立** —— `phase: finished` / `elapsedMs: 15046`，`FEISHU_DISPATCH_MODE` 保持 `async` |
| **跨会话记忆的端到端验收** | ✅ **已跑通（`npm run verify:memory`，13/13）** —— 走飞书 API，会话 A 记下 → 会话 B/C 答得出 → `/clear` 后仍记得 → 清空后新会话答不出 |
| 【未知数 2】流事件的实际名字 | ⚠️ **仍未核**（要部署后看 `/agent-metrics`）。猜错的后果只是卡片少一行，不影响答案 |
| 飞书**入站** webhook（事件订阅那一段） | ❌ 没跑过 —— 上面的验收是直调 `?mode=sync`，出站链路（真发卡片/纯文本 + 飞书 API 读回）已验证 |

`edgeone makers dev` 的三个坑（都是实测）：

1. **`agent-node` 不绑定端口** —— 日志停在 `[agent-node] Observability: openai-agents`，
   只有 `node-function`(9005) 和 `observability`(9101) 起来。**`/feishu` 本地打不到**。
2. 前端 dev server 会被跳过（`The configured dev command would recurse into edgeone itself.`），
   因为 `package.json` 的 `dev` 就是 `edgeone makers dev`。所以「打开状态页看回调地址」
   这一步只能部署后验。
3. 未登录时 CLI 直接拒绝，要 `-t <token>` 或 `EDGEONE_PAGES_API_TOKEN`；
   令牌可以从 `~/.edgeone/<sha256>`（JSON，取 `value.Token`）里捞。
   再加 `--skip-env-sync --skip-ai-gateway-sync`，否则会卡在交互式提问上。

剩下**按文档推断、没有实测**的地方，写在 `docs/01-架构与移植映射.md` 的
「两个未知数」一节 —— 其中未知数 1 已在线上验掉（✅），未知数 2 仍未核。
复验步骤见 `docs/03-验证清单.md`。

跨会话记忆的端到端验收有脚本，不需要手动点飞书：

```bash
npm run verify:memory            # 7 个阶段，13 条判据，跑完自动清理测试事实
npm run verify:memory -- --keep  # 跑完不清记忆（想留在飞书里肉眼看）
```

---

## 上手

前置：Node.js ≥ 22（冒烟测试用了 `--experimental-strip-types`）。

```bash
# 1. 装依赖
npm install

# 2. 类型检查 + 冒烟测试（都不需要登录，先跑这两个）
npm run typecheck
npm test

# 3. 装 EdgeOne CLI 并登录
npm i -g edgeone && edgeone login

# 4. 配环境变量
cp .env.example .env
#    编辑 .env，至少填：
#      OPENCODE_API_KEY     ← OpenCode Go 的密钥
#      OPENCODE_BASE_URL    ← https://opencode.ai/zen/go/v1
#      OPENCODE_MODEL       ← deepseek-v4.1-flash（裸名，不带 @makers/）
#      FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN / FEISHU_ENCRYPT_KEY
#      INTERNAL_TOKEN       ← openssl rand -hex 24
#
#    ⚠️ 别用 AI_GATEWAY_* 存自己的 key —— 那三个是平台托管的，
#    每次 deploy 都会被重置回平台值。

# 5. 本地起服务，默认 http://localhost:8088
npm run dev
```

打开 `http://localhost:8088/` 是一个状态页，上面有后台执行能力的自测按钮 ——
**先点它**，结果决定 `FEISHU_DISPATCH_MODE` 填什么。

关联线上环境变量到本地：`npm run link`（需要先在控制台建好项目）。

部署：推到 Git 仓库让 Makers 自动构建，或 `npm run deploy`。

飞书后台怎么配见 `docs/02-飞书配置.md`。

### 为什么冒烟测试不依赖 EdgeOne

`test/smoke.ts` 用**裸 Node** 跑，不启 EdgeOne、不连飞书、不发网络请求（`fetch` 被 stub 掉了）。
理由：这条链路里最容易错的东西 —— 验签与解密的**顺序**、去重窗口的判据、
摘要写回的形状、那个 36 字符的 `conversation_id` —— **全都不依赖平台**。
把它们从平台里剥出来单独测，改一行就能验证一次，不用等部署。

覆盖十一节：A 验签解密 ｜ B 事件体解析 ｜ C 命令解析 ｜ D 去重限流 ｜
E webhook 端到端 ｜ F 回合流程 ｜ G 会话压缩 ｜ H 云文档授权 ｜
I 用户令牌管理 ｜ J 云文档工具族 ｜ K 跨会话记忆。

---

## 目录结构

```
edgeone-agent-lab/
├── edgeone.json                    # framework=openai-agents-sdk、超时、沙箱存活
├── index.html                      # 状态页 + 后台执行自测
│
├── agents/feishu/                  # 【会话模式】Agent 运行时，单次可跑 900 秒
│   ├── index.ts                    #   入口：POST /feishu。去重、限流、调度
│   ├── _host.ts                    #   FeishuTurnHost 实现：模型调用 + 流式卡片
│   ├── _instructions.ts            #   系统提示词
│   └── _tools.ts                   #   工具装配 + 结果摘要
│
├── cloud-functions/feishu-webhook/ # 【请求模式】无状态，必须 3 秒内 ACK
│   └── index.ts                    #   入口：POST /feishu-webhook。验签、解密、转发
│
├── src/                            # 平台无关的业务逻辑（大部分从原版搬来）
│   ├── shared/
│   │   └── util.ts        ➕ 新增   # guarded（工具永不抛的兜底）、UA 等通用零件
│   └── feishu/
│       ├── api.ts         ✅ 原样   # tenant_access_token、发文本
│       ├── card.ts        ✅ 原样   # 流式卡片（cardkit）
│       ├── commands.ts    🔧 微改   # 命令解析（加 /compact /clear /memory /forget；删 /repo）
│       ├── compact.ts     ➕ 新增   # 会话压缩的纯函数（渲染历史 / 写回形状）
│       ├── crypto.ts      ✅ 原样   # 验签 + AES 解密
│       ├── docs.ts        ➕ 新增   # 飞书云文档三个工具（docx / sheets / bitable）
│       ├── event.ts       ✅ 原样   # 事件体解析
│       ├── global-memory.ts ➕ 新增 # **跨会话**记忆（Blob 后端 + 三个工具 + 渲染）
│       ├── oauth.ts       ➕ 新增   # 云文档授权（state 签名、授权链接）
│       ├── session-sanitize.ts ➕ 新增 # 历史消毒（丢孤儿 tool 项）
│       ├── streamer.ts    ✅ 原样   # 增量 → 卡片，250ms 一拍
│       ├── turn.ts        🔧 微改   # 回合流程（markDone 改 await；加 /compact /clear /memory /forget 分发）
│       ├── user-token.ts  ➕ 新增   # 用户令牌：续期、轮换、单飞、按人分槽
│       ├── store.ts       🔄 重写   # SQL → 按会话隔离的 JSON KV
│       └── types.ts       ➕ 新增   # FeishuQueueEvent 从 router.ts 挪出来
│
├── test/
│   └── smoke.ts                    # 冒烟测试：146 项，裸 Node 跑，不依赖 EdgeOne
│
└── docs/
    ├── 01-架构与移植映射.md         # 逐模块对照、跨会话记忆、两个未知数、刻意没做的事
    ├── 02-飞书配置.md               # 飞书后台怎么点
    └── 03-验证清单.md               # 按顺序执行的验证步骤
```

图例：✅ 一行没改 ｜ 🔧 改了少量 ｜ 🔄 重写 ｜ ➕ 新增

---

## 一句话说清架构

```
飞书
 │  POST /feishu-webhook            ← 3 秒内必须 ACK
 ▼
cloud-functions/feishu-webhook      无状态 · 验签 · 解密 · 解析
 │  POST /feishu  + Makers-Conversation-Id: fs-<hash(chat_id)>
 ▼
agents/feishu                       会话模式 · 粘性路由 · 最长 900 秒
 ├─ context.store.openaiSession()   对话记忆（平台托管，按会话隔离）
 ├─ context.store.state             去重 / 限流 / token 缓存（按会话隔离）
 ├─ Blob (agent-memory-<projectId>) **跨会话**长期事实：prefs/* · user/<openId>/*
 ├─ context.tools.*                 沙箱工具（commands / code_interpreter / web_search / …）
 └─ 回飞书（sendText 或流式卡片）
```

> 上面两行是**按会话**的，第三行是**跨会话**的 —— 这是两片完全不同的键空间。
> 「记住这个项目用 pnpm」写在第三行，所以换个群、`/clear` 之后都还在。
> 详见 `docs/01-架构与移植映射.md` 第五节。

拆成两段不是绕远路，是被平台的硬约束逼出来的：`agents/` 路由**强制要求**
`Makers-Conversation-Id` 请求头，而飞书推送是它自己发的，我们加不了头。
详见 `docs/01-架构与移植映射.md` 的「为什么拆两段」。
