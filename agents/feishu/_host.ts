// 飞书回合的宿主实现：把「问模型」「报状态」这两件事接到
// OpenAI Agents SDK + EdgeOne 平台上。
//
// ── 这个文件在移植里扮演什么角色 ────────────────────────────────────
// 原版这些事的实现散在 `server.ts` 的 `onChatMessage` / `workspaceBegin...`
// 和 `feishuRun` 里，加起来四百多行，中间夹着 AIChatAgent 基类、DO storage、
// AI SDK 的 streamText。
//
// 移植时**没有去改 `src/feishu/turn.ts`**，而是照着它的 `FeishuTurnHost` 接口
// 写了一个新实现。这是这次移植里唯一一处「原版设计帮了大忙」的地方 ——
// 当初把宿主能力抽成接口只是为了能脱离 DO 单测，结果正好让换平台时
// 回合流程几乎一行不用动。
//
// 2026-09-25：agent 从「代码仓库问答」改成通用助手，`HostDeps.repo`
// 和 `ingest()`（抓 GitHub 仓库入库）随之删除。

import OpenAI from "openai";
import {
  Agent,
  OpenAIChatCompletionsModel,
  run,
  type Session,
} from "@openai/agents";

// 注意：这里**不 import `sendText`**。往飞书发消息是 `turn.ts` 的职责 ——
// 这个宿主只负责「问模型」，发不发、发什么由回合流程决定。
// （踩过：一开始在这里也发了一份错误提示，结果和 turn.ts 的那份重复，
//   用户同时收到两条。）
import type { FeishuEnv, TokenCache } from "../../src/feishu/api.ts";
import {
  MIN_ITEMS_TO_COMPACT,
  SUMMARY_SYSTEM_PROMPT,
  buildSummaryUserPrompt,
  compactReply,
  renderTranscript,
  summaryItem,
} from "../../src/feishu/compact.ts";
import { authStateText, makeFeishuDocTools } from "../../src/feishu/docs.ts";
import {
  GlobalMemory,
  blobMemoryBackend,
  makeMemoryTools,
  renderMemoryList,
} from "../../src/feishu/global-memory.ts";
import { ghWorkspaceConfig } from "../../src/ghworkspace/client.ts";
import { makeGithubTools } from "../../src/ghworkspace/tools.ts";
import { buildAuthorizeUrl, signState, type OAuthEnv } from "../../src/feishu/oauth.ts";
import type { StateKv } from "../../src/feishu/store.ts";
import { FeishuStreamer } from "../../src/feishu/streamer.ts";
import type { FeishuTurnHost } from "../../src/feishu/turn.ts";
import { sanitizeAndAppend } from "../../src/feishu/session-sanitize.ts";
import { UserTokenManager, makeUserTokenStore } from "../../src/feishu/user-token.ts";
import { INSTRUCTIONS, WORKSPACE_PROMPT } from "./_instructions.ts";
import { diagCounters, modelFetch, type DiagEntry } from "./_diag.ts";
import { makeSearchTools } from "./_search.ts";
import { platformTools, summarizeToolOutput, toolFailed } from "./_tools.ts";

/**
 * 模型层最后一次失败的落盘键（会话 KV）。
 * `?probe=last` 读它 —— 内存环形缓冲按实例隔离，KV 按 conversation_id 归属，
 * 换个实例也能读到。两个地方必须用同一个值。
 */
export const DIAG_KEY = "diag.lastModelFailure";

/** 模型调用与平台密钥 */
export interface AgentEnv extends FeishuEnv, OAuthEnv {
  /**
   * 模型路由。**优先用 OPENCODE_\*，不要用 AI_GATEWAY_\*** ——
   * 后者是平台托管的，每次 deploy 都会被 CLI 的
   * `Bound AI Gateway credentials to project` 覆盖回平台值，
   * 手写的值活不过一轮部署（实测：setEnvs 写成功、listEnvs 回读一致，
   * 部署完就变回旧值）。前者是普通自定义键，不会被碰。
   *
   * 正确取值：
   *   OPENCODE_BASE_URL = https://opencode.ai/zen/go/v1
   *   OPENCODE_MODEL    = deepseek-v4.1-flash（裸名，不带 @makers/）
   *
   * 取值逻辑见 `resolveModelRoute()`；key 和 baseURL **必须成对取**。
   */
  OPENCODE_API_KEY?: string;
  OPENCODE_BASE_URL?: string;
  OPENCODE_MODEL?: string;
  /**
   * ⚠️ 平台托管，会被 deploy 重置。只作兜底，不要指望能改。
   * 名字是模板惯例（edgeone.json 的 framework 适配读这三个名字）。
   */
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_MODEL?: string;
  /** OpenCode Go 要求的会话标签头 `x-opencode-session`，值只是个路由标签 */
  OPENCODE_SESSION?: string;
  SANDBOX_ENABLED?: string;
  /**
   * 平台注入的项目身份。**跨会话记忆要用它拼 Blob 命名空间**
   * （`agent-memory-<projectId>`），所以必须能读到。
   *
   * 三个名字都留着是因为构建产物里 `__userEnv` 同时塞了 `PAGES_PROJECT_ID` /
   * `ProjectId` / `EDGEONE_PROJECT_ID` 三个键，值一样；哪个先被平台砍掉不好说，
   * 取值时按顺序兜（见 global-memory.ts 的 blobMemoryBackend）。
   */
  PAGES_PROJECT_ID?: string;
  ProjectId?: string;
  /** 覆盖跨会话记忆的 Blob 命名空间。不设时按 `agent-memory-<projectId>` 算 */
  AGENT_MEMORY_NAMESPACE?: string;
  /**
   * serper 的 key，给自建的 `web_search` 用（见 `_search.ts`）。
   *
   * 为什么不用平台内置的 `web_search`：它底层是腾讯云 WSA，缺 `WSA_API_KEY`
   * 时报 `web_search requires the WSA_API_KEY environment variable.`，
   * 而 WSA 要单独开通付费。serper 的 key 是现成的。
   *
   * **没配时搜索工具整个不挂**，模型也就不会去撞一堵必然失败的墙。
   */
  SERPER_API_KEY?: string;
  /**
   * 工作区仓库（ws_ls / ws_read / ws_write / ws_rm）的 fine-grained PAT。
   * 只授予 guci314/cf-agent-workspace 这一个仓库的 Contents 读写。
   *
   * ⚠️ 必须是**普通环境变量**，别放进 AI_GATEWAY_* —— 那三个键每次 deploy
   * 都会被平台覆盖回平台值（见 AgentEnv 顶部那段说明）。
   *
   * 没配时工作区工具整个不挂（见 ghWorkspaceConfig 的注释）。
   */
  GITHUB_WORKSPACE_TOKEN?: string;
  /** 覆盖工作区仓库名。默认 guci314/cf-agent-workspace（见 ghworkspace/client.ts） */
  GITHUB_WORKSPACE_REPO?: string;
  /**
   * 自制内部令牌。webhook 转发时带 `x-internal-token`，agent 这边比对。
   * `agents/` 路由是公网可达的，没这道门谁都能拿它烧模型额度。
   *
   * 声明在这里（而不是只在 index.ts 里读）是为了让 `context.env` 的类型收窄 ——
   * 平台注入的 env 是个无类型的对象，把它断言成这个接口之后，
   * 下面所有读 env 的地方都有类型，不必到处 `String(env.X ?? "")`。
   */
  INTERNAL_TOKEN?: string;
  /** `async`（默认）先回 202 再跑；`sync` 跑完才回。见 index.ts 的说明 */
  FEISHU_DISPATCH_MODE?: string;
  /**
   * 把「提前多久判 access token 过期」放大，专门用来**手工验续期链路**。
   *
   * 默认提前 5 分钟判过期，意味着想看到一次真实的 refresh 得等将近两小时 ——
   * 这条最容易坏的路就成了「只能靠等」的路。设成 7200000（2 小时）之后，
   * 随便发一条读文档的请求就会走到续期分支。**平时不要设。**
   */
  FEISHU_USER_TOKEN_SKEW_MS?: string;
}

/**
 * 工具循环的轮数上限。原版 `MAX_STEPS = 24`，从 16 提上来的 ——
 * 16 那档在「列目录 → 读文件 → 写文件 → 回读校验」这类四步任务上会撞顶，
 * 因为模型常把一步拆成两三个工具调用。
 *
 * ⚠️ 这里的「一轮」和原版的「一步」口径不完全一样：AI SDK 的 `stepCountIs`
 * 数的是模型往返次数，Agents SDK 的 `maxTurns` 也是。所以两个数字可以直接对齐。
 * 撞顶不可怕，可怕的是撞顶后拿不到结论 —— 所以 Agents SDK 这侧靠
 * `result.finalOutput` 兜底：即使是被 maxTurns 截断，最后一轮的文本仍然拿得到。
 */
const MAX_TURNS = 24;

/** 输出上限。原版注释：不显式设的话默认只给 256 token，长回答会在半截被砍断 */
const MAX_OUTPUT_TOKENS = 8_192;

/**
 * 摘要请求的输出上限。
 *
 * `SUMMARY_SYSTEM_PROMPT` 自己要求「800 字以内」，2048 token 留了足够余量。
 * 不设的话默认上限很低、摘要会被砍断；给太大则容易被写成一整篇复述。
 */
const COMPACT_MAX_TOKENS = 2_048;

export interface HostDeps {
  env: AgentEnv;
  /** 平台注入的 context。`store` / `tools` 都从这里取 */
  context: any;
  cache: TokenCache;
  /** 按会话隔离的 KV，云文档令牌存这里。拿不到平台 state 时是 null（本地调试） */
  kv: StateKv | null;
  /** 这一轮的提问人。云文档授权**按人分槽**，见 user-token.ts 文件头 */
  openId: string;
  /** 这个会话的 chatId。授权 state 里要带它 —— 中转靠它算 conversation_id */
  chatId: string;
}

/**
 * 解析模型名。**裸名**（`deepseek-v4.1-flash`），因为路由指向 OpenCode Go。
 *
 * ⚠️ 两个网关的模型名规则是**相反**的，换端点时必须一起改，否则错得很像：
 *   · EdgeOne AI Gateway：必须带 provider 前缀，免费档 `@makers/<model>`，
 *     写裸名 → 400 `Model ID must include provider prefix`
 *   · OpenCode Go：必须写裸名，带前缀 → 404
 * 踩过：只把 baseURL 换成 opencode.ai 而留着 `@makers/` 前缀，报 404，
 * 看起来像「模型不存在」，实际是前缀没摘。
 *
 * 取值优先级：`OPENCODE_MODEL` > `AI_GATEWAY_MODEL` > 硬编码兜底。
 * 为什么优先前者见 `resolveModelRoute` 的注释。
 */
export function resolveModelName(env: AgentEnv): string {
  return env.OPENCODE_MODEL || env.AI_GATEWAY_MODEL || "deepseek-v4.1-flash";
}

/**
 * 解析「key + baseURL」这一对。**必须成对取，不能各取一半**。
 *
 * ── 为什么不能混着用 ────────────────────────────────────────────────
 * 踩过：key 是 OpenCode Go 的、baseURL 却指着 EdgeOne AI Gateway，
 * 稳定拿到 401 `API key not found`，看着像密钥失效，其实是打错了门。
 * 所以这里按**来源**整体决定：认得出 OPENCODE_* 就两个都用它，
 * 否则两个都退回 AI_GATEWAY_*。绝不出现「key 来自 A、地址来自 B」。
 *
 * ── 为什么要另起 OPENCODE_* 这个名字 ─────────────────────────────────
 * `AI_GATEWAY_*` 是**平台托管**的：实测用 setEnvs 写进去、listEnvs 回读
 * 确认成功（baseURL len 34 → 29），但跑一次 `deploy` 之后它自己变回了旧值 ——
 * 因为 CLI 每次部署都会 `Bound AI Gateway credentials to project`，
 * 用平台的值覆盖这三个键。手写的值活不过一轮部署。
 *
 * 对照组：`OPENCODE_SESSION` 同样是自定义键，从来没被重置过。
 * 所以问题出在**名字**，不是写入能力 —— 早先的结论
 * 「setEnvs 改不了 AI_GATEWAY_*」描述对了现象、说错了原因。
 *
 * 兜底保留 AI_GATEWAY_* 是为了本地调试和「万一没配 OPENCODE_*」时不至于跑不起来。
 */
export function resolveModelRoute(env: AgentEnv): {
  apiKey: string | undefined;
  baseURL: string | undefined;
  /** 用的是哪一组变量，回显给探针用 */
  source: "OPENCODE_*" | "AI_GATEWAY_*" | "未配置";
} {
  const ocKey = env.OPENCODE_API_KEY?.trim();
  const ocUrl = env.OPENCODE_BASE_URL?.trim();
  if (ocKey && ocUrl) return { apiKey: ocKey, baseURL: ocUrl, source: "OPENCODE_*" };

  const gwKey = env.AI_GATEWAY_API_KEY?.trim();
  const gwUrl = env.AI_GATEWAY_BASE_URL?.trim();
  if (gwKey && gwUrl) return { apiKey: gwKey, baseURL: gwUrl, source: "AI_GATEWAY_*" };

  // 半配的情况（只有 key 没有地址）当作没配，免得又出现「打错门」
  return { apiKey: undefined, baseURL: undefined, source: "未配置" };
}

/**
 * 按运行时 env 建一个模型客户端。
 *
 * 抽成**模块级导出**（而不是留在 createHost 里的闭包）是为了让
 * `?probe=model` 能走**完全相同**的一条路：同一份 env、同一个 baseURL、
 * 同一组请求头。探针要是自己另拼一份配置，测过的就不是线上真正跑的那条路了。
 *
 * 走用户自己的 OpenCode Go 订阅池，不用平台的免费模型 ——
 * 免费额度是账号级的 50 万 token，带工具的一轮问答多搜几个网页就没了。
 */
export function makeModelClient(env: AgentEnv, onFailure?: (e: DiagEntry) => void): OpenAI {
  const route = resolveModelRoute(env);
  return new OpenAI({
    apiKey: route.apiKey,
    baseURL: route.baseURL,
    // OpenCode Go 要求带这个头，缺了会被直接拒。值只是个路由标签。
    // 原版用的是 AI SDK 的 createOpenAICompatible({ headers })，
    // 这里对应 OpenAI Node SDK 的 defaultHeaders。
    defaultHeaders: env.OPENCODE_SESSION
      ? { "x-opencode-session": env.OPENCODE_SESSION }
      : undefined,
    // 挂一层记录器：出站请求形状 + 入站响应都留在环形缓冲里，
    // 用 `?probe=last` 取。模型返回光秃秃的 400 时，**唯一**能看出
    // 原因的地方就是这里（SDK 的 message 不含响应正文）。
    //
    // ⚠️ 它还做**重试**：OpenAI SDK 的内置重试只认 408/409/429/5xx，
    // 而实测 OpenCode Go 会间歇性返回 400（残缺响应体）—— SDK 不重试，
    // 用户就直接看到「没答上来：400 status code (no body)」。
    // 见 _diag.ts 的 isRetryable()。
    fetch: modelFetch({ onFailure }),
  });
}

/**
 * 建跨会话记忆。**拿不到平台 Blob 时返回 null**，不退化成本地内存。
 *
 * 为什么不用 `InMemoryMemoryBackend` 兜底：一个「这一轮记得、下一条消息就没了」
 * 的记忆比没有记忆更坏 —— 用户会以为它真记住了，然后被它的遗忘搞糊涂。
 * 宁可明确地没有（`/memory` 会直说接不上），也不要假的。
 *
 * 抽成模块级导出是为了让诊断端点能和真实回合走**同一条**取值路 ——
 * `?probe=store` 的 `memory` 字段就是 `memoryBackendStatus(env)` 的输出，
 * 和这里 `blobMemoryBackend(env)` 用的是同一个解析函数。
 */
export function makeGlobalMemory(env: AgentEnv): GlobalMemory | null {
  const backend = blobMemoryBackend(env);
  return backend ? new GlobalMemory(backend) : null;
}

export function createHost(deps: HostDeps): FeishuTurnHost {
  const { env, context, cache } = deps;

  // ⚠️ 模型名与客户端都从**模块级函数**取（见上面的 resolveModelName /
  // makeModelClient）—— 这样 `?probe=model` 和真实回合走的是同一条路。
  const MODEL_NAME = resolveModelName(env);

  // 模型客户端只建一次。每个实例（= 每个飞书会话）一份，
  // 这样底层 HTTP 连接池能复用 —— 每回合重建会白白多一次 TLS 握手。
  //
  // 这里用 const 而不是惰性 getter：OpenAI 客户端构造很便宜，
  // 而且挂了诊断回调之后，越早建越好 —— 惰性会让失败发生在getClient之前，
  // 那段失败就拿不到诊断信息了。`/compact` 也直接复用这一个实例。
  //
  // 失败时把最后一次失败的记录落进**会话 KV**：内存环形缓冲是按实例隔离的，
  // 而 `?probe=last` 那次请求很可能被路由到**另一个实例**，就读不到了。
  // 实测就踩过：明明刚失败过，探针却回 count=0。
  // KV 按 conversation_id 归属（跟探针用的是同一个 id），所以任何实例都能读到。
  const client = makeModelClient(env, (e: DiagEntry) => {
    void deps.kv?.set(DIAG_KEY, e).catch(() => {
      /* 诊断落盘失败不影响业务 */
    });
  });

  let model: OpenAIChatCompletionsModel | null = null;
  const getModel = (): OpenAIChatCompletionsModel => {
    if (model) return model;

    // ⚠️ 用 OpenAIChatCompletionsModel 而不是默认的 Responses API：
    // OpenCode Go 只兼容 Chat Completions。用错模型类会得到 404 而不是
    // 「不支持这个端点」这种看得懂的错。
    model = new OpenAIChatCompletionsModel(client, MODEL_NAME);
    return model;
  };

  const session = (): Session | undefined => {
    // 平台按 conversation_id 提供 OpenAI Agents SDK 的原生 Session 实现，
    // 零配置、跨实例持久化。原版对应的是 `agents/sessions` 那套
    // （cf_agents_session_messages 表 + createCompactFunction 压缩）。
    //
    // ⚠️ 两者不通用：原版的会话压缩（COMPACT_AFTER_TOKENS=200k）是
    // `onCompaction` 钩子驱动的，平台这套没有等价的钩子。见
    // docs/01-架构与移植映射.md 的「会话压缩」一节。
    try {
      const cid = context?.conversation_id;
      if (cid && context?.store?.openaiSession) {
        return context.store.openaiSession(cid);
      }
    } catch {
      /* 本地没有平台 context 时退化成无记忆，不该因此跑不起来 */
    }
    return undefined;
  };

  /**
   * 生成摘要。**刻意不走 `run(agent, …)`**。
   *
   * 走 Agent run 的话这一回合本身会被写进 session —— 压缩的前提是「拿全量历史
   * 再清空」，而 run() 会在我们读到历史和清空之间往里塞东西，顺序一乱就白压。
   * 直接打模型的 Chat Completions 就没有这个问题：它不接触 session，天然干净。
   *
   * 也不给工具：摘要是纯文本任务，带上工具只会让它多绕几圈。
   */
  const summarize = async (transcript: string): Promise<string> => {
    const resp = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: buildSummaryUserPrompt(transcript) },
      ],
      max_tokens: COMPACT_MAX_TOKENS,
    });
    // 思考模型的正式答案仍在 content 里；reasoning_content 那一路是草稿，不要
    return String(resp?.choices?.[0]?.message?.content ?? "").trim();
  };

  /**
   * 云文档令牌管理器。
   *
   * **每个回合建一个**（createHost 一次 = 一轮消息），工具族闭包捕获它 ——
   * 于是同一轮里模型连着调多个文档工具时，它们共用同一个「内存副本 + 单飞续期」，
   * 不会各续各的（见 user-token.ts 里 inflight 的注释）。
   *
   * 没有 kv 或没有 openId 时是 null：文档工具**照样挂**（2026-09-25 起应用身份
   * 不依赖它），只是这个人没有「用户身份兜底」这层，读不到没共享的文档时
   * callDoc 会直接报应用身份的错误。
   */
  const userTokens =
    deps.kv && deps.openId
      ? new UserTokenManager({
          store: makeUserTokenStore(deps.kv, deps.openId),
          env,
          openId: deps.openId,
          skewMs: Number(env.FEISHU_USER_TOKEN_SKEW_MS) || undefined,
        })
      : null;

  /**
   * 自建联网搜索。**在 createHost 里算一次**（不是每回合重算）——
   * 它只取决于 env 里的 key，而 key 一个实例生命周期内不会变。
   *
   * 拿到它之后要把平台内置的同名工具摘掉，否则两个 web_search 同时在
   * 工具列表里，模型可能选中那个坏的（缺 WSA_API_KEY）。
   */
  const searchTools = makeSearchTools(env);

  /**
   * 工作区仓库（ws_* 四个工具，agent 自己的 GitHub 私有仓库）。
   *
   * **在 createHost 里算一次**：cfg 只取决于 env，一个实例生命周期内不会变；
   * 没配 GITHUB_WORKSPACE_TOKEN 时返回 null，工具一个都不挂 —— 挂一族
   * 必然失败的工具只会让模型反复去撞（规矩同 searchTools 的挂载条件）。
   */
  const ghCfg = ghWorkspaceConfig(env);

  /**
   * 跨会话记忆。**每个回合建一个**（createHost 一次 = 一轮消息）——
   * 实例内带读缓存，所以同一轮里「instructions 渲染」和「recall_facts」
   * 只会打一次网络；而 remember/forget 会把缓存清掉，
   * 于是同一轮内「刚记住 → 立刻查」也看得到。
   */
  const memory = makeGlobalMemory(env);

  /**
   * 记忆文本**一轮只渲染一次**（快照）。
   *
   * ── 为什么必须快照（2026-09-25 实测踩出来的）──────────────────────
   * `instructions` 传函数时，SDK 是**每次模型调用**都重新求值一次 ——
   * `@openai/agents-core/dist/run.mjs` 的 `#prepareModelCall` 里
   * `await executionAgent.getSystemPrompt(...)`，而它在一轮的轮次循环里被反复调用。
   *
   * 于是出现一个很坏的现象：一轮里模型先调 `remember_fact` 写了两条，
   * 下一次模型调用时**系统提示词变了** —— 从「（目前还是空的）」变成列出那两条。
   * 而模型可能在这之前刚调过 `recall_facts`（那时确实是空的，返回 0 合法），
   * 于是它同时看到「提示词里有 2 条」和「工具说 0 条」，判定成「我的读取不稳定」，
   * 接着在飞书里**当众撤回一个正确的答案**，下一轮又撤回上一条撤回。
   * 用户看到的是「它反复横跳，不可信」——这比记不住更伤。
   *
   * 快照之后：本轮内提示词稳定（就是本轮开头那一刻的记忆），
   * 「现在到底有什么」由 `recall_facts` 负责 —— 职责分开，不会互相打脸。
   */
  let memorySnapshot: string | null = null;
  const memoryText = async (): Promise<string> => {
    // 调用点已经保证 memory 非空，但 TS 不会跨闭包收窄，这里显式挡一次
    if (!memory) return "";
    if (memorySnapshot === null) memorySnapshot = await memory.renderForPrompt(deps.openId);
    return memorySnapshot;
  };

  /**
   * 基础提示词。工作区仓库那段**按配置拼接**：没配 PAT 时工具不存在，
   * 提示词也不能提 —— 「说了但手上没有的能力，模型会去调然后白烧一轮」
   * （规矩见 _instructions.ts 文件头）。记忆那段是每轮快照，单独拼。
   */
  const baseInstructions = INSTRUCTIONS + (ghCfg ? WORKSPACE_PROMPT : "");

  const buildAgent = (): Agent =>
    new Agent({
      // 名字只是个标识（会出现在日志和 trace 里），不参与行为。
      // 2026-09-25 从 `code-repo-reader` 改成 `general-assistant`。
      name: "general-assistant",
      // ⚠️ `instructions` 这里是**函数**而不是字符串：长期记忆必须在每轮开头
      // 动态拼进去。`@openai/agents` 的 `Agent.instructions` 支持
      // `(runContext, agent) => string | Promise<string>`
      // （见 node_modules/@openai/agents-core/dist/agent.d.ts）。
      //
      // 函数本身会被反复调用，但里面的记忆文本是快照（见上面的 memoryText）。
      //
      // 拿不到记忆（本地调试 / 运行时没暴露 Blob）时**退回静态字符串** ——
      // 不只是省一次 await，更重要的是提示词里不会出现「你有长期记忆」这种
      // 骗人的话（模型会去调一个没挂上的工具）。
      instructions: memory
        ? async () => baseInstructions + (await memoryText())
        : baseInstructions,
      model: getModel(),
      modelSettings: { maxTokens: MAX_OUTPUT_TOKENS },
      tools: [
        // 2026-09-25：这里原先第一项是 `...makeWorkspaceTools(repo)`
        // （read / ls / grep / find，读用户导入的仓库）。仓库层删除后不再有它。
        // 跨会话记忆的三个工具（remember_fact / forget_fact / recall_facts）。
        // 挂不上就整个不挂，理由同上。
        ...((memory ? makeMemoryTools(memory, deps.openId) : []) as any[]),
        // 云文档读写（六个工具）。应用身份（tenant token）只要有应用凭证就可用
        // —— 读的是共享给机器人的文档；用户身份有则带上，应用读不到时兜底。
        // 所以挂载条件只需要应用凭证齐备，**不再要求这个人 /login 过**。
        ...(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET
          ? (makeFeishuDocTools({ env, cache, tokens: userTokens }) as any[])
          : []),
        // 工作区仓库（agent 自己的 GitHub 私有仓库）。没配 PAT 就整个不挂
        ...(ghCfg ? (makeGithubTools(ghCfg) as any[]) : []),
        // 自建 web_search（serper）。挂了它就必须摘掉平台内置的那个
        ...(searchTools as any[]),
        // 平台内置沙箱工具。类型是平台注入的「framework 适配对象」，
        // 拿不到官方 TS 类型，所以这里按 unknown[] 收进来
        ...(platformTools(
          context,
          env,
          searchTools.length ? ["web_search"] : [],
        ) as any[]),
      ],
    });

  return {
    async ask(text, messageId, chatId) {
      // ── 流式卡片 ──────────────────────────────────────────────────
      // 先试着起一张流式卡片。起不来（比如后台没开卡片权限）就退回
      // 「攒完整段再发一条纯文本」—— 流式是体验，不是正确性。
      const streamer = new FeishuStreamer(env, cache, chatId);
      const streaming = await streamer.start();

      let answer = "";
      try {
        const agent = buildAgent();
        // `stream: true` 返回 StreamedRunResult，`.toStream()` 给异步事件流
        const result = await run(agent, text, {
          stream: true,
          session: session(),
          maxTurns: MAX_TURNS,
          // ⚠️ 必须过滤历史，否则会话会被**永久毒死**。
          //
          // 会话历史按窗口取（最近 N 条）。窗口一旦从「assistant 声明
          // tool_calls → tool 结果」这一对的中间切开，开头就会剩下一条
          // 没有对应 assistant 的孤儿 tool 消息；协议上非法，网关稳定 400。
          // 之后每一轮都带着这个非法开头 → 这个会话再也问不出东西，
          // 只有 /clear 能救。实测踩过：三次重试全 400，同一问题换个会话就正常。
          //
          // 详见 src/feishu/session-sanitize.ts 的文件头。
          sessionInputCallback: (history: any[], newItems: any[]) => {
            // 计数器让「钩子到底挂上没有」可观测 —— 这个钩子静默失效时
            // 症状只是「偶尔还是 400」，没法归因。见 _diag.ts 的 diagCounters。
            diagCounters.sessionInputCalls++;
            return sanitizeAndAppend(history, newItems, (drop) => {
              // 丢东西说明窗口切歪了 —— 记进诊断，别静默
              diagCounters.droppedOrphanTools += drop.droppedOrphanTools;
              diagCounters.droppedEmptyAssistants += drop.droppedEmptyAssistants;
              void deps.kv
                ?.set(DIAG_KEY, {
                  t: Date.now(),
                  kind: "history-sanitized",
                  ...drop,
                })
                .catch(() => {});
            });
          },
        });

        for await (const event of result.toStream()) {
          if (!streaming) {
            // 没卡片就只攒文本，不往飞书推任何东西
            const d = answerDelta(event);
            if (d) answer += d;
            continue;
          }
          applyEvent(streamer, event);
        }

        // 最终答案。优先用 SDK 的 finalOutput（它包含工具循环收敛后的完整文本），
        // 拿不到才退回我们自己攒的增量 —— 两者不一致时以 SDK 为准，
        // 因为增量事件名一旦对不上（比如换了模型厂商），攒出来的就是空的。
        const final = pickFinalText((result as any).finalOutput);
        if (final) answer = final;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);

        if (streaming) {
          // 卡片已经建出来了，把原因写在卡片上就够 —— 而且**不能**再抛。
          // 抛出去的话 turn.ts 的 catch 会再发一条纯文本，
          // 用户会同时收到「卡片上写着失败」和「一条文本说失败」两份。
          await streamer.fail(`没答上来：${msg}`);
          return { text: `没答上来：${msg}`, streamed: true };
        }

        // 没有卡片：交给 turn.ts 去发纯文本。**这里不能自己发** ——
        // 它的 catch 本来就会发一条，两处都发就是重复。
        throw e;
      }

      if (streaming) {
        // fallbackText 是一道保险：增量一个都没收到时，卡片会永远停在「…」，
        // 而调用方又因为 streamed=true 不再补发文本消息 —— 用户什么都看不到
        await streamer.finish(answer);
        return { text: answer, streamed: true };
      }

      return { text: answer, streamed: false };
    },

    // 2026-09-25：这里原有 `async ingest(owner, name, ref)`（抓 GitHub 仓库入库 +
    // 落 KV 快照）。agent 改成通用助手后整条链路删除，`FeishuTurnHost` 里也
    // 没有这个方法了 —— 留着会编译不过（对象字面量多出未知属性）。

    async statusText() {
      // 2026-09-25：这里原先报「当前导入了哪个仓库、文件数、语料大小」。
      // 仓库层删除后改报**长期记忆规模**和**云文档授权**这两件事。
      const lines: string[] = [];

      if (memory) {
        const n = (await memory.entries()).length;
        lines.push(`长期记忆：${n} 条（跨会话共享，看清单发 /memory）`);
      } else {
        lines.push("长期记忆：这个环境接不上（多半是本地调试）。");
      }

      // 授权是**按人**的，和记忆不是一回事 —— 换个同事来问，授权状态就不一样
      if (userTokens) lines.push(await authStateText(userTokens, deps.openId));
      return lines.join("\n");
    },

    async loginUrl() {
      if (!userTokens) {
        return "这个会话拿不到提问人身份，云文档授权用不了。";
      }
      // state 的签名密钥直接用 INTERNAL_TOKEN：中转那边有同一个值
      // （EO_INTERNAL_TOKEN），所以两边都能验，不必再多分发一个密钥。
      // 这个路由本身就是 fail-closed 的，走到这里必然已经有值。
      const state = await signState(
        {
          chatId: deps.chatId,
          openId: deps.openId,
          nonce: crypto.randomUUID(),
          issuedAt: Date.now(),
        },
        String(env.INTERNAL_TOKEN ?? ""),
      );

      // buildAuthorizeUrl 会在没配 FEISHU_OAUTH_REDIRECT_URI 时抛错。
      // **故意不在这里兜成默认值**：回调地址错一个字符，用户看到的是飞书的
      // 一个报错页，完全无从判断原因；宁可现在就说清楚是配置缺了。
      const url = buildAuthorizeUrl(env, state);

      // ⚠️ **不要在这段里用 Markdown**（加粗、反引号）。命令回执走的是
      // `sendText`，发的是飞书**纯文本消息**——它不渲染 Markdown，`**x**`
      // 会原样显示成星号。Markdown 只在流式卡片那条路上有得渲染，
      // 别把两边的排版规则搞混。
      return [
        "点下面这条链接完成一次授权，之后就能直接贴飞书文档 / 知识库 / 多维表格 / 电子表格的链接提问了。",
        "",
        url,
        "",
        "授权后能以你自己的身份读写你有权限的文档；共享给机器人的文档不需要这个授权也能读。" +
        "随时发 /logout 撤销。",
      ].join("\n");
    },

    async logout() {
      if (!userTokens) return "这个会话没有云文档授权。";
      const had = await userTokens.forget();
      return had
        ? "已撤销云文档授权。再读文档需要重新发 /login。"
        : "本来就没有授权，没什么可撤销的。";
    },

    async compact() {
      const s = session();
      if (!s) {
        return "这个会话没接上平台的会话存储（多半是本地调试环境），没有可压缩的历史。";
      }

      const items = await s.getItems();
      if (items.length < MIN_ITEMS_TO_COMPACT) {
        return `这个会话只有 ${items.length} 项历史，没什么可压缩的。`;
      }

      const summary = await summarize(renderTranscript(items));

      // ⚠️ 摘要空着就**什么都别动**。此前清了 session 却没东西写回，
      // 等于把整个对话记忆抹掉 —— 而用户只是想让它变短。宁可这次失败重来。
      if (!summary) {
        return "摘要没生成出来（模型返回了空内容）。历史原样保留，稍后再试一次。";
      }

      // 顺序要紧：历史已经取完（上面的 getItems），才轮到清空 + 写回。
      // 写回的**只有这一条摘要** —— 「用户发了 /compact」这个动作本身不留痕，
      // 否则下次压缩又会把这条指令当成历史项压一遍。
      await s.clearSession();
      await s.addItems([summaryItem(summary)]);

      return compactReply(items.length, summary.length);
    },

    async clear() {
      const s = session();
      if (!s) {
        return "这个会话没接上平台的会话存储（多半是本地调试环境），没有可清的历史。";
      }
      await s.clearSession();
      // ⚠️ 这句**必须点名长期记忆不动**。不写的话用户会以为 `/clear` 能把记忆
      // 一起抹掉 —— 而记忆在另一个 Blob 命名空间里，这个命令结构上就碰不到它。
      // 要删记忆只有 /forget 一条路。
      //
      // （2026-09-25：原先这里还补一句「导入的仓库还在，发 /status 可以看」——
      //   仓库层已删除，那句随之去掉。）
      const extra = memory ? "\n\n长期记忆不受影响（那是跨会话的，删它用 /forget）。" : "";
      return `会话已清空，之前的对话记忆没了。${extra}`;
    },

    async memoryText() {
      return renderMemoryList(memory, deps.openId);
    },

    async forgetMemory(key) {
      if (!memory) {
        return "这个环境接不上跨会话记忆（多半是本地调试），没什么可删的。";
      }
      const k = key.trim();

      // `/forget all confirm` —— 清空**这个人的视野**（项目级 + 他自己的）。
      // 为什么非要二次确认：记忆是跨会话的，删掉之后别的群也看不到了，
      // 而且没有回收站。误删一条还能重记，误清空就得重新教一遍。
      if (k === "all confirm") {
        const n = await memory.forgetAll(deps.openId);
        return n ? `已清掉 ${n} 条长期记忆。` : "本来就没有可清的长期记忆。";
      }
      if (k === "all") {
        return [
          "这会删掉全部项目级记忆，别的会话也看不到了，而且不能恢复。",
          "",
          "确认就发：/forget all confirm",
        ].join("\n");
      }
      if (!k) {
        return "用法：/forget <键名> 删一条（键名见 /memory）。清空发 /forget all confirm。";
      }

      // 人打键名不会带 prefs/ 前缀，走宽松匹配
      const hit = await memory.forgetLoose(k, deps.openId);
      return hit
        ? `已删掉 ${hit}。`
        : `没找到「${k}」。发 /memory 看一下现有的键名。`;
    },
  };
}

// ── 事件映射 ──────────────────────────────────────────────────────────

/**
 * 把 SDK 的流事件映射到飞书卡片。
 *
 * ⚠️ 事件名是这套移植里**最需要实测确认**的一处。原版用的是 AI SDK 的
 * `onChunk({ chunk })`，`chunk.type` 只有四个值（reasoning-delta / text-delta /
 * tool-input-start / tool-result），很直白。Agents SDK 换成了两层：
 * `raw_model_stream_event`（模型原始分片）和 `run_item_stream_event`（运行项）。
 *
 * 下面处理的是**官方模板里出现过的那两个**：
 *   · `raw_model_stream_event` + `data.type === 'output_text_delta'` → 答案增量
 *   · `run_item_stream_event` + `name === 'tool_called'` → 工具调用
 * 另外两个（工具结果、思考增量）是按同一套规律推的，**没实测过**。
 * 部署后请在本地 `/agent-metrics` 面板里把实际事件名核一遍，对不上就改这里 ——
 * 对不上的表现是「卡片上只有答案，没有 🔧/✅ 那一串」，不影响正确性。
 */
function applyEvent(streamer: FeishuStreamer, event: any): void {
  if (event?.type === "raw_model_stream_event") {
    const d = answerDelta(event);
    if (d) {
      streamer.push(d);
      return;
    }
    const r = reasoningDelta(event);
    if (r) streamer.pushReasoning(r);
    return;
  }

  if (event?.type === "run_item_stream_event") {
    if (event.name === "tool_called") {
      const name = event.item?.name ?? event.item?.rawItem?.name;
      if (name) streamer.pushToolCall(String(name));
      return;
    }
    if (event.name === "tool_output") {
      // 工具结果的形状随工具而异，压成一行给卡片看
      const out = event.item?.output ?? event.item?.rawItem?.output;
      streamer.pushToolResult(!toolFailed(out), summarizeToolOutput(out));
      return;
    }
  }
}

/** 答案增量。只有这一条是官方模板里确认过的 */
function answerDelta(event: any): string {
  if (event?.type !== "raw_model_stream_event") return "";
  const d = event.data;
  if (d?.type === "output_text_delta" && typeof d.delta === "string") return d.delta;
  return "";
}

/**
 * 思考增量。
 *
 * 原版能拿到思考是因为 OpenCode Go 的 Chat Completions 会返回 `reasoning_content`
 * （流式分片里也带），AI SDK 把它暴露成 `reasoning-delta`。
 * Agents SDK 走 Chat Completions 时怎么暴露这一路**我没核实出来** ——
 * 下面按 Responses API 的两个已知名字猜了，猜不中的后果只是「卡片上不显示思考」，
 * 答案本身不受影响。
 */
function reasoningDelta(event: any): string {
  if (event?.type !== "raw_model_stream_event") return "";
  const d = event.data;
  const t = String(d?.type ?? "");
  if (
    (t === "response.reasoning_summary_text.delta" ||
      t === "response.reasoning_text.delta" ||
      t === "reasoning_content_delta") &&
    typeof d?.delta === "string"
  ) {
    return d.delta;
  }
  return "";
}

/**
 * 从 `finalOutput` 里取纯文本。
 *
 * `finalOutput` 的静态类型是 `string | undefined`，但实际取决于最后一个
 * output item 的类型 —— 万一是别的形状，取不到就返回空串让调用方退回增量。
 */
function pickFinalText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}
