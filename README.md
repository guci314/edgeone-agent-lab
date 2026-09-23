# edgeone-agent-lab

`cf-agent-lab`（Cloudflare Workers + Durable Objects）到 **EdgeOne Makers** 的移植版。
用 **OpenAI Agents SDK** 重写 Agent 核心，入口只有飞书 —— 没有网页聊天界面。

用户导入一个 GitHub 仓库，然后在飞书里问关于这个仓库的代码问题。

---

## ⚠️ 先读这段：这个仓库的验证状态

本地能验证的部分**已经全部验证过了**；剩下两件事必须连真实环境。

| 环节 | 状态 |
|---|---|
| 代码（约 5300 行） | ✅ 写完 |
| `npm install` | ✅ **通过** —— 104 个包，约 1 分钟 |
| `tsc --noEmit` 类型检查 | ✅ **零错误** |
| `npm test` 冒烟测试 | ✅ **73 项全通过**（验签/解密、命令解析、去重限流、generation 制、四个代码工具、webhook 端到端、回合流程） |
| `edgeone makers dev` 本地起服务 | ⚠️ **没跑成** —— 缺登录令牌（见下） |
| 真实飞书链路 | ❌ 没跑过 |

`edgeone makers dev` 起不来的原因不是代码，是**没登录**。CLI 原话：

```
You are not authenticated, and browser login is unavailable in a non-interactive
environment. Please provide a token via -t <token> or set the EDGEONE_PAGES_API_TOKEN
environment variable.
```

先 `npx edgeone login`（会开浏览器），或者把令牌塞进 `EDGEONE_PAGES_API_TOKEN`。

另外有两处**按文档推断、没有实测**的地方，写在 `docs/01-架构与移植映射.md` 的
「两个未知数」一节 —— 部署后请按 `docs/03-验证清单.md` 实测确认。

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
#      AI_GATEWAY_API_KEY   ← OpenCode Go 的密钥
#      FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_VERIFICATION_TOKEN / FEISHU_ENCRYPT_KEY
#      INTERNAL_TOKEN       ← openssl rand -hex 24

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
`generation` 制的原子切换、那个 36 字符的 `conversation_id` —— **全都不依赖平台**。
把它们从平台里剥出来单独测，改一行就能验证一次，不用等部署。

覆盖八节：A 验签解密 ｜ B 事件体解析 ｜ C 命令解析 ｜ D 去重限流 ｜
E 语料仓储 ｜ F 代码工具 ｜ G webhook 端到端 ｜ H 回合流程。

---

## 目录结构

```
edgeone-agent-lab/
├── edgeone.json                    # framework=openai-agents-sdk、超时、沙箱存活
├── index.html                      # 状态页 + 后台执行自测
│
├── agents/feishu/                  # 【会话模式】Agent 运行时，单次可跑 900 秒
│   ├── index.ts                    #   入口：POST /feishu。去重、限流、调度
│   ├── _host.ts                    #   FeishuTurnHost 实现：模型调用 + 流式卡片 + 导入
│   ├── _instructions.ts            #   系统提示词
│   └── _tools.ts                   #   工具装配 + 结果摘要
│
├── cloud-functions/feishu-webhook/ # 【请求模式】无状态，必须 3 秒内 ACK
│   └── index.ts                    #   入口：POST /feishu-webhook。验签、解密、转发
│
├── src/                            # 平台无关的业务逻辑（大部分从原版搬来）
│   ├── feishu/
│   │   ├── api.ts         ✅ 原样   # tenant_access_token、发文本
│   │   ├── card.ts        ✅ 原样   # 流式卡片（cardkit）
│   │   ├── commands.ts    🔧 微改   # 命令解析（加 /compact /clear）
│   │   ├── compact.ts     ➕ 新增   # 会话压缩的纯函数（渲染历史 / 写回形状）
│   │   ├── crypto.ts      ✅ 原样   # 验签 + AES 解密
│   │   ├── event.ts       ✅ 原样   # 事件体解析
│   │   ├── streamer.ts    ✅ 原样   # 增量 → 卡片，250ms 一拍
│   │   ├── turn.ts        🔧 微改   # 回合流程（markDone 改 await；加 /compact /clear 分发）
│   │   ├── store.ts       🔄 重写   # SQL → 按会话隔离的 JSON KV
│   │   └── types.ts       ➕ 新增   # FeishuQueueEvent 从 router.ts 挪出来
│   └── workspace/
│       ├── github.ts      ✅ 原样   # codeload URL、默认分支
│       ├── tar.ts         ✅ 原样   # 流式 tar 解析
│       ├── decode.ts      ✅ 原样   # gzip 解压
│       ├── filter.ts      ✅ 原样   # 二进制/压缩产物判定、跳过规则
│       ├── glob.ts        ✅ 原样   # ** 和 {a,b} 的 glob
│       ├── types.ts       ✅ 原样   # 语料上限常量
│       ├── serve-ingest.ts ✅ 原样  # 抓 tarball 入库（零平台依赖，原样能用）
│       ├── repo.ts        🔄 重写   # SQL → 内存索引 + 快照
│       └── tools.ts       🔧 换框架 # read/ls/find/grep：JSON Schema → zod
│
├── test/
│   └── smoke.ts                    # 冒烟测试：73 项，裸 Node 跑，不依赖 EdgeOne
│
└── docs/
    ├── 01-架构与移植映射.md         # 逐模块对照、两个未知数、刻意没做的事
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
 ├─ context.store.openaiSession()   对话记忆（平台托管，跨实例）
 ├─ context.store.state             去重 / 限流 / token 缓存 / 语料快照
 ├─ context.tools.*                 沙箱工具（commands / code_interpreter / web_search / …）
 └─ 回飞书（sendText 或流式卡片）
```

拆成两段不是绕远路，是被平台的硬约束逼出来的：`agents/` 路由**强制要求**
`Makers-Conversation-Id` 请求头，而飞书推送是它自己发的，我们加不了头。
详见 `docs/01-架构与移植映射.md` 的「为什么拆两段」。
