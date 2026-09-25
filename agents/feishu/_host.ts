// 飞书回合的宿主实现：把「问模型」「导仓库」「报状态」三件事接到
// OpenAI Agents SDK + EdgeOne 平台上。
//
// ── 这个文件在移植里扮演什么角色 ────────────────────────────────────
// 原版这三件事的实现散在 `server.ts` 的 `onChatMessage` / `workspaceBegin...`
// 和 `feishuRun` 里，加起来四百多行，中间夹着 AIChatAgent 基类、DO storage、
// AI SDK 的 streamText。
//
// 移植时**没有去改 `src/feishu/turn.ts`**，而是照着它的 `FeishuTurnHost` 接口
// 写了一个新实现。这是这次移植里唯一一处「原版设计帮了大忙」的地方 ——
// 当初把宿主能力抽成三个方法只是为了能脱离 DO 单测，结果正好让换平台时
// 回合流程一行不用动。

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
import { buildAuthorizeUrl, signState, type OAuthEnv } from "../../src/feishu/oauth.ts";
import type { StateKv } from "../../src/feishu/store.ts";
import { FeishuStreamer } from "../../src/feishu/streamer.ts";
import type { FeishuTurnHost } from "../../src/feishu/turn.ts";
import { UserTokenManager, makeUserTokenStore } from "../../src/feishu/user-token.ts";
import { makeWorkspaceTools } from "../../src/workspace/tools.ts";
import type { WorkspaceRepo } from "../../src/workspace/repo.ts";
import { serveIngest } from "../../src/workspace/serve-ingest.ts";
import { INSTRUCTIONS } from "./_instructions.ts";
import { makeSearchTools } from "./_search.ts";
import { platformTools, summarizeToolOutput, toolFailed } from "./_tools.ts";

/** 模型调用与平台密钥 */
export interface AgentEnv extends FeishuEnv, OAuthEnv {
  AI_GATEWAY_API_KEY?: string;
  AI_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_MODEL?: string;
  OPENCODE_SESSION?: string;
  SANDBOX_ENABLED?: string;
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export interface HostDeps {
  env: AgentEnv;
  /** 平台注入的 context。`store` / `tools` 都从这里取 */
  context: any;
  repo: WorkspaceRepo;
  cache: TokenCache;
  /** 按会话隔离的 KV，云文档令牌存这里。拿不到平台 state 时是 null（本地调试） */
  kv: StateKv | null;
  /** 这一轮的提问人。云文档授权**按人分槽**，见 user-token.ts 文件头 */
  openId: string;
  /** 这个会话的 chatId。授权 state 里要带它 —— 中转靠它算 conversation_id */
  chatId: string;
}

export function createHost(deps: HostDeps): FeishuTurnHost {
  const { env, context, repo, cache } = deps;

  // ⚠️ 默认值必须带 `@makers/` 前缀。EdgeOne AI Gateway 的模型名**一律要求
  // provider 前缀**，免费档是 `@makers/<model>`；写成裸 `deepseek-v4.1-flash`
  // 会直接 404。移植前这里是 OpenCode Go 的默认值，前缀规则不同。
  const MODEL_NAME = env.AI_GATEWAY_MODEL ?? "@makers/deepseek-v4.1-flash";

  // 模型客户端只建一次。每个实例（= 每个飞书会话）一份，
  // 这样底层 HTTP 连接池能复用 —— 每回合重建会白白多一次 TLS 握手。
  //
  // 单独抽成 getClient()（而不是留在 getModel() 里）是因为 `/compact` 要**绕过
  // Agent run** 直接发一次摘要请求，走的是同一个客户端、同一份凭证。
  let client: OpenAI | null = null;
  const getClient = (): OpenAI => {
    if (client) return client;

    // 走用户自己的 OpenCode Go 订阅池，不用平台的免费模型 ——
    // 免费额度是账号级的 50 万 token，代码问答读几个文件就没了。
    //
    // 变量名沿用 AI_GATEWAY_*：edgeone.json 的 framework 适配和模板惯例都读这三个
    // 名字，换成 OpenCode Go 只需要改值。
    client = new OpenAI({
      apiKey: env.AI_GATEWAY_API_KEY,
      baseURL: env.AI_GATEWAY_BASE_URL,
      // OpenCode Go 要求带这个头，缺了会被直接拒。值只是个路由标签。
      // 原版用的是 AI SDK 的 createOpenAICompatible({ headers })，
      // 这里对应 OpenAI Node SDK 的 defaultHeaders。
      defaultHeaders: env.OPENCODE_SESSION
        ? { "x-opencode-session": env.OPENCODE_SESSION }
        : undefined,
    });
    return client;
  };

  let model: OpenAIChatCompletionsModel | null = null;
  const getModel = (): OpenAIChatCompletionsModel => {
    if (model) return model;

    // ⚠️ 用 OpenAIChatCompletionsModel 而不是默认的 Responses API：
    // OpenCode Go 只兼容 Chat Completions。用错模型类会得到 404 而不是
    // 「不支持这个端点」这种看得懂的错。
    model = new OpenAIChatCompletionsModel(getClient(), MODEL_NAME);
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
    const resp = await getClient().chat.completions.create({
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
   * 于是同一轮里模型连着调三个文档工具时，它们共用同一个「内存副本 + 单飞续期」，
   * 不会各续各的（见 user-token.ts 里 inflight 的注释）。
   *
   * 没有 kv 或没有 openId 时不建也不挂工具。挂一个永远回「未授权」的工具，
   * 只会让模型把幻觉当成权限问题，白绕几圈。
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

  const buildAgent = (): Agent =>
    new Agent({
      name: "code-repo-reader",
      instructions: INSTRUCTIONS,
      model: getModel(),
      modelSettings: { maxTokens: MAX_OUTPUT_TOKENS },
      tools: [
        ...makeWorkspaceTools(repo),
        // 用户身份读飞书云文档。工具拿不到 context，只能靠闭包捕获上面的管理器
        ...(userTokens ? (makeFeishuDocTools({ env, tokens: userTokens }) as any[]) : []),
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

    async ingest(owner, name, ref) {
      // serveIngest 是从原版原样搬过来的（它只依赖 repo / github / tar / filter，
      // 零 Cloudflare 依赖），所以这里只是调它 + 落一次快照。
      const r = await serveIngest(repo, owner, name, ref);

      // 落快照。失败不影响这次导入的可用性 —— 语料已经在内存里了，
      // 只是实例被驱逐后需要重新导入。所以吞掉结果，只在日志里留个痕。
      const saved = await repo.persist();
      if (!saved) console.warn("[ingest] 快照未落盘，实例被驱逐后需要重新导入");

      const lines = [
        `已导入 ${owner}/${name}@${ref}`,
        `${r.fileCount} 个文件，${fmtBytes(r.totalBytes)}`,
      ];
      if (r.skipped > 0) lines.push(`跳过 ${r.skipped} 个（二进制 / 压缩产物 / 被规则排除）`);
      if (r.capped) {
        // ⚠️ 必须说清楚语料是部分的。不写这句，模型会把「搜不到」当成
        // 「仓库里没有」，而实际上是根本没导入进来
        const why =
          r.truncatedBy === "entries"
            ? "文件条目太多"
            : r.truncatedBy === "time"
              ? "抓取超时"
              : "达到语料大小上限";
        lines.push(`⚠️ 语料只收了一部分（${why}），搜不到的内容不代表仓库里没有`);
      }
      lines.push("现在可以直接问这个仓库的问题了。");
      return lines.join("\n");
    },

    async statusText() {
      const lines: string[] = [];
      const st = repo.status();

      if (st.activeGeneration === 0 || st.fileCount === 0) {
        lines.push("还没有导入仓库。发 `/repo owner/name` 导入一个 GitHub 仓库（也可以直接粘链接）。");
      } else {
        lines.push(`当前仓库：${st.owner}/${st.name}@${st.ref}`);
        lines.push(`文件数：${st.fileCount}`);
        lines.push(`语料大小：${fmtBytes(st.totalBytes)}`);
        if (st.capped) lines.push("⚠️ 语料只收了一部分");
      }

      // 授权状态和仓库状态是**两件事**，各自独立 —— 没导仓库也可能授权过云文档
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
        "权限是只读的，只能读你自己有权限的文档。随时发 /logout 撤销。",
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
      // 只说清了对话 —— 语料（repo 快照）在另一个键里，不受影响。
      // 不写这句的话，用户会以为要重新 /repo 一遍。
      return "会话已清空，之前的对话记忆没了。导入的仓库还在（发 /status 可以看）。";
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
