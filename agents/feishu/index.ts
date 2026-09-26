// 飞书 Agent 入口。路由：POST /feishu
//
// ── 这个文件解决的核心矛盾 ──────────────────────────────────────────
// EdgeOne 的 `agents/` 路由**必须**带 `Makers-Conversation-Id` 请求头，
// 缺了直接 400；而飞书的 webhook 推送是它自己发的，我们没法给它加头。
//
// 所以链路被拆成两段：
//   飞书 → cloud-functions/feishu/webhook.ts  （验签/解密，加头转发）
//        → agents/feishu/index.ts             （本文件：跑模型，回飞书）
//
// 这段转发是**必须的**，不是绕远路：`agents/` 是会话模式（同一 conversation_id
// 粘性路由到同一实例、复用内存状态、单次可跑 3600 秒），`cloud-functions/` 是
// 无状态请求模式（最长 120 秒）。模型跑一个回合动辄二三十秒，还会连着调工具，
// 只有 `agents/` 撑得住。
//
// ── 为什么需要 INTERNAL_TOKEN ───────────────────────────────────────
// `agents/` 路由部署后是公网可达的。没有这道门，任何人都能拿它烧你的模型额度。
// 所以 webhook 转发时带一个自制头，这里校验。**没配就拒绝服务**（fail closed）
// —— 报错文案会直接告诉你该配什么，不会让你对着一个 401 猜。
//
// ── 后台执行能力（这套移植最大的未知数）────────────────────────────
// 飞书要求 webhook 在 3 秒内 ACK，但模型要跑二三十秒。原版靠 DO 的
// `schedule()`（storage + alarm）把工作挪出请求生命周期，EdgeOne 没有 alarm。
//
// 现在的办法是：先回 202，再在后台跑完。**「返回 Response 之后未 await 的异步
// 代码还能不能跑完」官方没有明文承诺**，所以：
//   · 有一个 `?probe=1` 自测端点，部署后先跑它（见 docs/03-验证清单.md）；
//   · 有一个 `FEISHU_DISPATCH_MODE=sync` 开关，实测不成立就切过去
//     （webhook 等整轮跑完才 ACK，飞书会重推，靠去重挡住）。
//
// ── 会话与存储 ──────────────────────────────────────────────────────
// conversation_id 就是 `fs-<chat_id>`，由 webhook 生成。平台按它做三件事：
// 粘性路由、store 归属、沙箱实例归属（一对话一沙箱）。
// `context.store.state` 是按 conversation_id 隔离的 JSON KV ——
// 原版「一个 DO 实例一个 SQLite 库」正好等价于这个。

import { sendText } from "../../src/feishu/api.ts";
import { memoryBackendStatus } from "../../src/feishu/global-memory.ts";
import { exchangeCode, redirectUri, verifyState } from "../../src/feishu/oauth.ts";
import { MemoryKv, FeishuStore, type StateKv } from "../../src/feishu/store.ts";
import { runFeishuTurn } from "../../src/feishu/turn.ts";
import type { FeishuQueueEvent } from "../../src/feishu/types.ts";
import { UserTokenManager, makeUserTokenStore } from "../../src/feishu/user-token.ts";
import {
  createHost,
  makeModelClient,
  resolveModelName,
  resolveModelRoute,
  type AgentEnv,
} from "./_host.ts";
import { clearDiag, diagCounters, recentDiag, resetCounters } from "./_diag.ts";
import { DIAG_KEY } from "./_host.ts";

export async function onRequest(context: any) {
  const request = context?.request;
  const method = String(request?.method ?? "POST").toUpperCase();
  const url = new URL(String(request?.url ?? "http://localhost/"));
  const mode = url.searchParams.get("mode");
  const probe = url.searchParams.get("probe");

  // ── 自测端点 ──────────────────────────────────────────────────────
  // 部署后第一件事是跑这个：确认「返回 Response 之后后台代码还能不能跑完」。
  // 两个动作要**分两次请求**，中间隔 15 秒 —— 因为要测的正是
  // 「第一个请求已经结束了，它启动的后台任务还在不在」。
  if (probe === "start") return probeStart(context, url);
  if (probe === "check") return probeCheck(context, url);
  if (probe === "env") return probeEnv(context, url);
  if (probe === "model") return probeModel(context, url);
  if (probe === "last") return probeLast(context, url);
  if (probe === "search") return probeSearch(context, url);
  if (probe === "store") return probeStore(context, url);

  if (method !== "POST") {
    return json({ error: "只接受 POST" }, 405);
  }

  const env = (context?.env ?? {}) as AgentEnv;
  const token = env.INTERNAL_TOKEN;
  if (!token) {
    return json(
      {
        error: "服务端没有配置 INTERNAL_TOKEN",
        how: "在 Makers 控制台的项目环境变量里加一个 INTERNAL_TOKEN（openssl rand -hex 24 生成），本地调试写进 .env。",
      },
      503,
    );
  }
  // 先读 body —— 令牌可以放在 body 里（见下），所以顺序不能反
  let body: any;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const got = readInternalToken(request, body);
  if (got !== token) {
    return json({ error: "内部令牌不匹配" }, 401);
  }

  const conversationId = String(context?.conversation_id ?? "");
  if (!conversationId) {
    return json(
      { error: "缺少 Makers-Conversation-Id 请求头", how: "这个路由只能由 cloud-functions/feishu/webhook.ts 转发调用。" },
      400,
    );
  }

  // ── 云文档授权回调 ────────────────────────────────────────────────
  // 这条**不是飞书消息**：它是浏览器跳转 → 中转（cf-agent-lab）转发过来的。
  // 没有 messageId，也不该走去重/限流 —— 那两个是给用户消息用的，套在这儿
  // 只会在用户重试时把第二次回调当成「重复」丢掉。
  //
  // 放在 claim 之前，且**同步返回**：中转那边的浏览器在等这个响应渲染结果页。
  if (String(body?.op ?? "") === "oauth") {
    return handleOAuthCallback(env, context, body);
  }

  const evt = normalizeEvent(body);
  if (!evt) return json({ error: "缺少 messageId / chatId / text" }, 400);

  const store = makeFeishuStore(context);
  await store.ensureSchema();

  // ── 去重 ──────────────────────────────────────────────────────────
  // 飞书在 webhook 超时后会重推同一条。判据是时间窗口（见 store.ts），
  // 所以这里返回 false 就直接 ACK —— 那条正在跑，或者刚跑完。
  const claimed = await store.claim(evt.messageId, evt.chatId, evt.openId);
  if (!claimed) {
    return json({ ok: true, skipped: "duplicate" }, 200);
  }

  // ── 限流 ──────────────────────────────────────────────────────────
  if (await store.overLimit(evt.chatId)) {
    await store.markFailed(evt.messageId, "rate limited");
    return json({ ok: true, skipped: "rate-limited" }, 200);
  }

  // ── 建宿主 ────────────────────────────────────────────────────────
  // 2026-09-25：这里原先还要 `new WorkspaceRepo(makeSnapshotStore(...))` +
  // `await repo.hydrate()` —— 语料快照（用户导入的仓库）已随仓库层删除。
  const host = createHost({
    env,
    context,
    cache: store.tokenCache(),
    kv: makeStateKv(context),
    openId: evt.openId,
    chatId: evt.chatId,
  });

  // ── 调度模式 ──────────────────────────────────────────────────────
  // async（默认）：先回 202，后台跑完
  // sync         ：跑完才回。**不依赖后台执行能力**，代价是 webhook 要等
  const dispatch = String(mode ?? env.FEISHU_DISPATCH_MODE ?? "async").toLowerCase();

  const work = async (signal?: AbortSignal): Promise<string[]> => {
    try {
      const replies = await runFeishuTurn(host, env, store, evt);
      // 一轮跑完顺手 prune 一次。原版靠 DO alarm 定期跑；
      // EdgeOne 免费版的 cron 最小间隔是 1 天，所以改成「搭车」——
      // 每轮跑完裁一次，成本几乎为零，效果够用
      await store.prune();
      return replies;
    } catch (e) {
      // 到这一步说明 turn 里的异常已经冒出来了 —— 按设计它应该自己吞掉
      // （见 turn.ts 的注释），所以能到这儿基本只剩「发消息时网络抖动」。
      // 记下来但不再抛：调用方要么已经 ACK 过（async），要么在等一个 Response
      await store.markFailed(evt.messageId, (e as Error).message);
      throw e;
    }
  };

  if (dispatch === "sync") {
    // ⚠️ 只有同步模式才把 request.signal 传下去。异步模式下这个 signal 会在
    // 响应发出时触发，把 signal 传给 run() 等于**自己掐掉后台任务**。
    const replies = await work(request?.signal);
    // 一并回显这一轮的回复。**这是自动化核对「机器人答了什么」的唯一途径** ——
    // 流式卡片的正文通过 `im/v1/messages` 读不到（只回一句「请升级至最新版本
    // 客户端」的占位）。async 那条路返回的 202 不承载业务内容，所以只在 sync 给。
    return json({ ok: true, mode: "sync", replies }, 200);
  }

  // 后台跑。不 await —— 但**故意挂一个 catch**：不挂的话未处理的 rejection
  // 会在某些运行时里变成未捕获异常，把整个实例带掉。
  void work().catch((e) => {
    console.error("[feishu] 后台回合失败：", (e as Error)?.message ?? e);
  });

  return json({ ok: true, mode: "async" }, 202);
}

// ── 云文档授权回调 ────────────────────────────────────────────────────

/**
 * 处理 OAuth 回调：用授权码换用户令牌，存进**该授权人**的槽，回飞书一条确认。
 *
 * ── 为什么回调落在这里而不是直接落在 agents 路由上 ────────────────
 * `agents/` 路由强制要求 `Makers-Conversation-Id` 头，而浏览器跳转带不了自定义头。
 * 所以飞书把浏览器重定向到中转（cf-agent-lab），由中转补上头、带上令牌再转发
 * 到这里。本函数因此拿得到 `context.store.state`（它是按 conversation_id 隔离的）。
 *
 * ── 身份从哪来 ────────────────────────────────────────────────────
 * 全从**签名过的 state** 里取（chatId / openId），不信 body 里的同名字段：
 * body 是转发方拼的，而 state 是发起 /login 时我们自己签的。中转那边也验一遍
 * 同样的签名（密钥同为 INTERNAL_TOKEN），两道关。
 */
async function handleOAuthCallback(
  env: AgentEnv,
  context: any,
  body: any,
): Promise<Response> {
  const state = await verifyState(
    String(body?.state ?? ""),
    String(env.INTERNAL_TOKEN ?? ""),
  );
  if (!state) {
    return json(
      { error: "授权状态无效或已过期。请回飞书重新发 /login 拿一条新链接。" },
      400,
    );
  }

  // 用户在授权页点了「拒绝」——飞书会带着 error 回来，不带 code。
  // 这不是故障，别报成故障
  const code = String(body?.code ?? "");
  if (!code) return json({ ok: true, denied: true }, 200);

  const kv = makeStateKv(context);
  if (!kv) return json({ error: "拿不到平台 state 存储，令牌无处可存" }, 503);

  let tok;
  try {
    // ⚠️ redirect_uri 必须和发起授权时**完全一致**，差一个字符就换不到令牌。
    // 两边都读同一个 env，所以天然一致 —— 别在这里手写字面量
    tok = await exchangeCode(env, code, redirectUri(env));
  } catch (e) {
    const msg = (e as Error).message.slice(0, 200);
    await notify(context, env, state.chatId, `云文档授权没成功：${msg}\n可以再发一次 /login 重试。`);
    return json({ error: `换令牌失败：${msg}` }, 502);
  }

  const mgr = new UserTokenManager({
    store: makeUserTokenStore(kv, state.openId),
    env,
    openId: state.openId,
  });
  await mgr.save(tok);

  await notify(
    context,
    env,
    state.chatId,
    [
      "✅ 云文档授权成功。",
      "",
      "现在可以直接把飞书文档 / 知识库 / 多维表格 / 电子表格的链接发过来提问了。",
      tok.refreshToken
        ? "（拿到了刷新令牌，之后不用反复授权。）"
        : "⚠️ 没拿到刷新令牌 —— 飞书后台的 offline_access 权限可能没开，两小时后要重新授权。",
    ].join("\n"),
  );

  return json({ ok: true });
}

/** 回飞书一条消息。失败只记日志 —— 令牌已经存好了，不该因为一句回执没发出去就报错 */
async function notify(
  context: any,
  env: AgentEnv,
  chatId: string,
  text: string,
): Promise<void> {
  if (!chatId) return;
  try {
    await sendText(env, makeFeishuStore(context).tokenCache(), chatId, text);
  } catch (e) {
    console.warn("[feishu] 授权回执发送失败：", (e as Error).message);
  }
}

// ── 自测探针 ──────────────────────────────────────────────────────────

/**
 * 探针的统一门禁：`?token=INTERNAL_TOKEN`。
 *
 * ── 为什么要抽成一个函数（2026-09-25 评审修的）──────────────────────
 * 原先每个探针各自抄一遍这三行，结果是 `probe=env` 那一处**漏了** ——
 * 而它恰恰是泄漏最多的那个（INTERNAL_TOKEN 与 SERPER_API_KEY 的长度和首尾、
 * serper key 的 FNV 指纹、env 变量名清单），实测线上 `?probe=env` 无令牌 200。
 * 讽刺的是 `probeStore` 和 `serperFingerprint` 的注释都明写着「这个端点是
 * 公网可达的」—— 说明风险是知道的，只是漏了没抄的那一支。
 *
 * **门禁按「这个端点会不会泄漏东西」开，不按「谁在用」开。** 逐个调用点
 * 手抄 = 新增一个探针就会忘一次，所以收口在这里。
 *
 * 例外只有 `probe=start` / `probe=check`：状态页要在浏览器里直接点它们，
 * 把 INTERNAL_TOKEN 塞进静态页等于公开它。它们只读写自己那个会话的
 * `probe.bg` 键，泄漏面为零（见 docs/03 的说明）。
 */
function tokenGate(context: any, url: URL): Response | null {
  const env = (context?.env ?? {}) as Record<string, unknown>;
  const expect = String(env.INTERNAL_TOKEN ?? "");
  const got = String(url.searchParams.get("token") ?? "");
  if (!expect || got !== expect) return json({ error: "需要 token=INTERNAL_TOKEN" }, 401);
  return null;
}

const PROBE_KEY = "probe.bg";

/**
 * 起一个后台任务：睡 15 秒，然后把时间戳写进 state。
 *
 * 为什么要 15 秒而不是 1 秒：太短的话任务可能在响应发出**之前**就跑完了，
 * 那样测出来的是「同步能跑」，而不是「后台能跑」—— 假的通过。
 */
/**
 * env 诊断端点：`GET /feishu?probe=env`
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────
 * 实测发现：**改云端项目环境变量不会实时生效**，跑着的 agent 用的是
 * 部署时打包进去的快照。改了 INTERNAL_TOKEN 之后请求照样 401，光看
 * 控制台根本判断不出是"值不对"还是"没生效"。
 *
 * 所以这里回显 env 的 key 列表 + INTERNAL_TOKEN 的**长度和前 4 位**
 * （不回显完整值，免得把密钥从公网漏出去）。拿它和控制台里显示的
 * 值比一下，就能分清：
 *   · key 里根本没有 INTERNAL_TOKEN → 平台没注入 / 名字写错
 *   · 指纹和控制台一致 → 值对，是调用方传错了
 *   · 指纹和控制台不一致 → 部署快照，重新部署才能生效
 */
/**
 * 搜索 key 的指纹：长度 + 首尾各 4 字符 + FNV-1a 32 位哈希。
 *
 * 不回显明文 —— 这个端点是公网可达的（这也正是 9/25 那次泄露的教训）。
 * 本地对同一个值算一次，指纹一致就说明运行时读到的值没错。
 */
function serperFingerprint(env: Record<string, unknown>): unknown {
  const k = String(env.SERPER_API_KEY ?? "");
  if (!k) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return {
    len: k.length,
    head: k.slice(0, 4),
    tail: k.slice(-4),
    fnv: h.toString(16).padStart(8, "0"),
  };
}

/**
 * 取模型出站请求/入站响应的最近记录（环形缓冲，最多 8 条）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * bot 回「没答上来：400 status code (no body)」时，`?probe=model` 是 **200** ——
 * 因为探针只发一个极简请求，不带工具、不带云文档授权。
 * 真正失败的是**真实回合**那个请求，而 SDK 把错误压成了一句话：
 * `400 status code (no body)`，既没有正文也没说是哪个字段。
 *
 * 这个端点把真实回合的出站形状（工具名、工具 schema 字符数、body 字符数）
 * 和入站原文取出来，于是「400 到底为什么」第一次有了证据。
 *
 * 用法：先 `?probe=clear` 清一下，再去飞书发一条消息复现，然后 `?probe=last`。
 */
async function probeLast(context: any, url: URL): Promise<Response> {
  const denied = tokenGate(context, url);
  if (denied) return denied;

  if (url.searchParams.get("op") === "clear") {
    clearDiag();
    resetCounters();
    const kv = makeStateKv(context);
    if (kv) await kv.delete(DIAG_KEY);
    return json({ ok: true, cleared: true });
  }

  const entries = recentDiag();
  let persisted: unknown = null;
  try {
    // ⚠️ 必须读 KV：内存环形缓冲按**实例**隔离，而这次探针请求很可能被
    // 路由到另一个实例（实测就踩过：刚失败完，探针却回 count=0）。
    // 会话 KV 按 conversation_id 归属，跨实例可读。
    const kv = makeStateKv(context);
    persisted = kv ? await kv.get(DIAG_KEY) : null;
  } catch {
    /* KV 不可用就只给内存里的 */
  }

  return json({
    ok: true,
    memoryCount: entries.length,
    /**
     * ⚠️ 先看 `counters.sessionInputCalls`：它是「历史消毒钩子挂上了没有」的
     * **唯一直接证据**。这个钩子是可选参数，写错名字不会报错、只会静默不生效，
     * 症状就是「偶尔还是 400」—— 分不出是没挂上还是别的原因。
     * 它 > 0 就说明钩子在跑。
     */
    counters: diagCounters,
    persistedFailure: persisted,
    // 时间倒序，第一条就是最近那次
    entries: entries.map((e) => ({ ...e, t: new Date(e.t).toISOString() })),
    hint:
      "看 persistedFailure（跨实例可读）+ entries（本实例内存）。" +
      "重点关注 req.msgRoles / req.assistantKeys / req.attempt 和 res.text 原文。",
  });
}

/**
 * 从**运行时内部**真的打一次模型，把原始状态码和返回片段回显出来。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 之前查「模型挂了」全靠飞书里发消息看 bot 回什么，一轮十几秒，
 * 而且只能看到被包装过的错误文案。`?probe=env` 虽然能回显 baseURL / model，
 * 但那只证明**变量读到了**，不证明**请求发得出去、鉴权过得去**。
 *
 * 这个探针补上最后一段：用 `makeModelClient(env)` —— 和真实回合**同一个**
 * 工厂函数 —— 发一次最小请求。三种结果各自指向不同的病：
 *   · 200            → 链路通，问题不在模型侧
 *   · 401 `API key not found`      → 打错门了：baseURL 指着别的网关
 *   · 400 `provider prefix`        → 模型名规则不对（EdgeOne 要前缀、OpenCode 不要）
 *   · 429 / quota                  → 额度
 *   · 超时 / DNS                    → 运行时出网问题
 *
 * ⚠️ 会真实消耗一次 token（十几 token 量级），用 INTERNAL_TOKEN 挡一道。
 */
async function probeModel(context: any, url: URL): Promise<Response> {
  const env = (context?.env ?? {}) as AgentEnv;
  const denied = tokenGate(context, url);
  if (denied) return denied;

  const route = resolveModelRoute(env);
  const baseUrl = String(route.baseURL ?? "");
  const model = resolveModelName(env);
  const session = String(env.OPENCODE_SESSION ?? "");

  // 上游是哪个网关，光看 host 就能认出来，先把结论摆出来免得读的人自己拼
  let upstream = "未知";
  try {
    const h = new URL(baseUrl).host;
    if (h.endsWith("opencode.ai")) upstream = "OpenCode Go";
    else if (h.endsWith("edgeone.link")) upstream = "EdgeOne AI Gateway";
  } catch {
    upstream = "baseUrl 不是合法 URL";
  }

  // 半配（只有 key 没有地址，或反过来）在这里就挡掉。
  // 不挡的话 OpenAI SDK 会抛「The OPENAI_API_KEY environment variable is missing」——
  // 一句和真实原因（我们自己没配对）完全无关的话，够排查半天。
  if (!route.apiKey || !route.baseURL) {
    return json({
      ok: false,
      upstream,
      envSource: route.source,
      hasKey: Boolean(route.apiKey),
      hasBaseUrl: Boolean(route.baseURL),
      hint: "key 和 baseURL 必须成对配。检查 OPENCODE_API_KEY / OPENCODE_BASE_URL。",
    });
  }

  const t0 = Date.now();
  try {
    const client = makeModelClient(env);
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [{ role: "user", content: "只回复两个字：收到" }],
        max_tokens: 32,
      },
      { signal: AbortSignal.timeout(30_000) } as any,
    );
    const choice = resp?.choices?.[0] as any;
    return json({
      ok: true,
      ms: Date.now() - t0,
      upstream,
      envSource: route.source,
      baseUrl,
      model,
      sessionLabel: session || null,
      content: String(choice?.message?.content ?? "").slice(0, 120),
      finishReason: choice?.finish_reason ?? null,
      usage: resp?.usage ?? null,
    });
  } catch (e: any) {
    // OpenAI SDK 抛的错把状态码和响应体分开放，尽量都掏出来
    return json({
      ok: false,
      ms: Date.now() - t0,
      upstream,
      envSource: route.source,
      baseUrl,
      model,
      sessionLabel: session || null,
      status: e?.status ?? null,
      error: String(e?.message ?? e).slice(0, 400),
      // 401 时正文里往往有网关自己的一句话，比 SDK 的 message 更准
      body: String(e?.error ? JSON.stringify(e.error) : "").slice(0, 400) || null,
      hint:
        route.source === "未配置"
          ? "OPENCODE_API_KEY/OPENCODE_BASE_URL 没配全，AI_GATEWAY_* 兜底也没配全。key 和地址要成对。"
          : e?.status === 401
            ? "401 = 这个 baseURL 不认识这把 key。确认 baseUrl 指向的网关和 key 是同一家。"
            : e?.status === 400
              ? "400 = 模型名规则不对。EdgeOne AI Gateway 要 @makers/ 前缀，OpenCode Go 要裸名。"
              : e?.status === 429
                ? "429 = 额度或限流。"
                : undefined,
    });
  }
}

/**
 * 从**运行时内部**真的发一次 serper 搜索请求，把原始状态码和结果回显出来。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 「工具能不能用」这件事被两层遮着：模型得先跑起来（网关鉴权/额度），
 * 才会去调工具。模型一挂，搜索就完全测不了 —— 于是没法回答
 * 「到底是搜索坏了，还是模型坏了」。
 *
 * 这两层现在各有各的探针：`?probe=model` 管上面那层，本端点管下面这层。
 * 于是「搜索失败」能一次定位到是哪一层：
 *   · model 探针 200 + search 探针 200 → 两层都好，问题在提示词/工具描述
 *   · model 探针失败 → 先修模型，搜索根本轮不到
 *
 * 这个探针把模型那层摘掉，只测「运行时 → serper」这一段：
 *   · 200 + 有结果 → 出网正常、key 有效，问题在模型侧
 *   · 401/403      → key 或额度问题
 *   · 超时/DNS 错  → 运行时出网被限制（EdgeOne 侧没有代理，只能直连）
 *
 * ⚠️ 会消耗一次 serper 配额，所以用 INTERNAL_TOKEN 挡一道，不公开。
 */
async function probeSearch(context: any, url: URL): Promise<Response> {
  const env = (context?.env ?? {}) as Record<string, unknown>;
  const denied = tokenGate(context, url);
  if (denied) return denied;

  const key = String(env.SERPER_API_KEY ?? "").trim();
  if (!key) return json({ ok: false, error: "没有 SERPER_API_KEY" }, 503);

  const q = String(url.searchParams.get("q") ?? "EdgeOne Makers").slice(0, 100);
  const t0 = Date.now();
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 3 }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return json({
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      // 直连出网时，serper 在 Google Cloud 上；这个 IP 能说明运行时走的哪条路
      query: q,
      titles: (parsed?.organic ?? []).map((r: any) => r?.title ?? "").slice(0, 3),
      bodyHead: res.ok ? null : text.slice(0, 200),
    });
  } catch (e) {
    return json({
      ok: false,
      ms: Date.now() - t0,
      error: `${(e as Error).name}: ${(e as Error).message}`,
      hint: "超时或 DNS 失败 = 运行时出网被限制，不是 key 的问题。",
    });
  }
}

async function probeEnv(context: any, url: URL): Promise<Response> {
  const denied = tokenGate(context, url);
  if (denied) return denied;

  // 交叉类型：既要按 AgentEnv 取已知字段（有类型），又要按 Record 遍历所有键
  // （`Object.keys` 只认索引签名，光 `as AgentEnv` 会报「缺 FEISHU_APP_ID」）
  const env = (context?.env ?? {}) as AgentEnv & Record<string, unknown>;
  const route = resolveModelRoute(env);
  const v = String(env.INTERNAL_TOKEN ?? "");
  const req = context?.request;
  // 请求头是不是**真的**穿过平台网关到了 agent —— 之前 401 查了半天，
  // 最后发现是自定义头在网关侧就被剥掉了，env 那边根本没问题。
  const headers: Record<string, string> = {};
  try {
    req?.headers?.forEach?.((val: string, key: string) => {
      headers[key] = String(val).slice(0, 60);
    });
  } catch {}
  const h = req?.headers;
  const gotHeader = readInternalToken(req, null);
  return json({
    ok: true,
    /**
     * ⚠️ 这个正则决定「哪些变量在探针里看得见」，漏一个就会把人带沟里。
     *
     * 踩过两次：
     *   · 漏了 SERPER → 「运行时到底有没有这个 key」看不出来，
     *     误判成环境变量没生效，白排查半天（现在另有 serperFingerprint）
     *   · 漏了 OPENCODE → OPENCODE_SESSION 不显示，就分不清
     *     「会话头没配」和「配了没生效」
     *   · 漏了 GITHUB → 加了 issue 那族工具之后，GITHUB_ISSUE_TOKEN/REPOS 在这里
     *     同样隐身（2026-09-26 补）
     * 加新变量时记得同步这里，或者干脆按前缀白名单放宽。
     *
     * ⚠️ 这里只列**变量名**、不回显值，所以把密钥类变量放进来是安全的 ——
     * 本端点另有 tokenGate 门禁。要看「值对不对」得另给指纹（如 serper 那样），
     * 别在这里回显。
     */
    envKeys: Object.keys(env)
      .filter((k) => /FEISHU|INTERNAL|AI_|AGENT|SANDBOX|SERPER|OPENCODE|GITHUB/.test(k))
      .sort(),
    internalToken: v ? { len: v.length, head: v.slice(0, 4), tail: v.slice(-4) } : null,
    /**
     * 搜索 key 的**指纹**，不是明文。
     *
     * 踩过：这里原来的过滤正则没有 SERPER，于是「运行时到底有没有这个 key」
     * 一直看不出来 —— 误判成环境变量没生效，白排查半天。
     * 现在给一个 sha256 前 12 位，本地算一次比一下就知道值对不对。
     */
    serper: serperFingerprint(env),
    /**
     * 模型名与网关地址（都不是密钥，可以直接回显）。
     *
     * 这两个值要**成对**读：模型名的规则由网关决定，而且两家是相反的
     * （EdgeOne AI Gateway 要 `@makers/` 前缀，OpenCode Go 要裸名）。
     * 只看其中一个会误判 —— 曾出现「model 是裸名」被当成配置错误，
     * 实际那时 baseUrl 才是真问题。
     *
     * ⚠️ 这里只证明变量读到了，不证明请求发得出去。要那个结论用 `?probe=model`。
     */
    model: resolveModelName(env),
    /**
     * 模型路由到底走了哪一组变量。**这是排查时第一个要看的东西**。
     *
     * ⚠️ 只看 `baseUrl` 会被误导：`AI_GATEWAY_*` 是平台托管的，
     * 就算控制台里改了、回读也对了，deploy 之后它还是会变回平台值。
     * 所以真正生效的是 `envSource` —— 显示 `AI_GATEWAY_*` 就说明
     * `OPENCODE_*` 没配全，路由退回了托管的那组。
     */
    envSource: route.source,
    baseUrl: String(route.baseURL ?? ""),
    opencodeSession: String(env.OPENCODE_SESSION ?? "") || null,
    /** 托管的那组现在是什么值（用来确认「被 deploy 重置了」这个现象） */
    managedAiGateway: {
      baseUrl: String(env.AI_GATEWAY_BASE_URL ?? "") || null,
      model: String(env.AI_GATEWAY_MODEL ?? "") || null,
    },
    requestShape: {
      ctor: req?.constructor?.name ?? null,
      keys: Object.keys(req ?? {}).slice(0, 30),
      headersType: h === undefined ? "undefined" : h === null ? "null" : typeof h,
      headersCtor: h?.constructor?.name ?? null,
      headersIsHeaders: typeof h?.get === "function",
      headersKeys: h && typeof h === "object" ? Object.keys(h).slice(0, 30) : [],
    },
    headerPairs: headers,
    gotInternalToken: gotHeader
      ? { len: gotHeader.length, head: gotHeader.slice(0, 4), tail: gotHeader.slice(-4) }
      : null,
    match: gotHeader === v,
    hint: "看 requestShape.headersIsHeaders：false 说明不是标准 Headers，只能靠 body 传令牌。",
  });
}

async function probeStart(context: any, url: URL): Promise<Response> {
  const kv = makeStateKv(context);
  if (!kv) return json({ error: "拿不到 context.store.state" }, 503);

  const mark = {
    startedAt: Date.now(),
    // 记下这次请求的 run id，方便在 /agent-metrics 里对链路
    runId: String(context?.runId ?? context?.run_id ?? ""),
  };
  await kv.set(PROBE_KEY, { ...mark, phase: "started" });
  const probeKey = PROBE_KEY;

  void (async () => {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      await kv.set(probeKey, { ...mark, phase: "finished", finishedAt: Date.now() });
      console.log("[probe] 后台任务跑完了");
    } catch (e) {
      console.error("[probe] 后台任务写回失败：", e);
    }
  })();

  return json({
    ok: true,
    hint: "已返回。15 秒后用同一个 Makers-Conversation-Id 请求 ?probe=check，看 phase 是不是 finished。",
    check: `${url.origin}${url.pathname}?probe=check`,
  }, 202);
}

async function probeCheck(context: any, _url: URL): Promise<Response> {
  const kv = makeStateKv(context);
  if (!kv) return json({ error: "拿不到 context.store.state" }, 503);
  const v = await kv.get<Record<string, unknown>>(PROBE_KEY);
  if (!v) return json({ ok: false, verdict: "没有记录 —— probe=start 没跑过，或者 state 没生效" }, 200);

  const elapsed = v.finishedAt ? Number(v.finishedAt) - Number(v.startedAt) : null;
  const finished = v.phase === "finished";
  return json({
    ok: true,
    phase: v.phase,
    elapsedMs: elapsed,
    verdict: finished
      ? "✅ 后台执行可用 —— 用默认的 FEISHU_DISPATCH_MODE=async"
      : "❌ 后台任务没跑完（响应发出后进程被回收了）—— 把 FEISHU_DISPATCH_MODE 改成 sync",
    raw: v,
  }, 200);
}

// ── 跨会话记忆的可行性实测（?probe=store）─────────────────────────────
//
// ── 为什么要有这个端点 ──────────────────────────────────────────────
// 目标是「跨会话记忆」，而 `context.store.state` 按 conversation_id 隔离，
// 换个会话就是空白 —— 所以必须找到一片**不带会话前缀**的键空间。
//
// 读 `.edgeone/agent-node/server.mjs`（agents 运行时的打包产物）发现：
//   · `context.store` 是 `createBlobBackedStore(blob, "agent-store", "agent-feishu")`
//     —— 一个**纯 key 前缀包装器**，前缀是**路由名**（不是会话名）；
//   · 运行时把裸 Blob SDK 挂在 `globalThis.__EDGEONE_AGENT_RUNTIME__.getStore`；
//   · 平台自己有个共享命名空间常量 `AGENT_SHARED_STORE_NAME = "agent-store"`。
//
// 由此推出三条候选路，本端点就是用来**实测哪条真的跨会话**：
//   A. 裸 Blob：`getStore({name:"agent-store"})` + 自己起的键前缀
//   B. 路由 store：`context.store.set(...)`（按上面推断是路由级、跨会话可见）
//   C. 会话 state：`context.store.state.set(...)`（预期**不**跨会话，做对照）
//
// ── 用法 ────────────────────────────────────────────────────────────
//   ① GET ?probe=store                     看形状（不写任何东西）
//   ② GET ?probe=store&op=write            三条路各写一个带时间戳的探针键
//   ③ GET ?probe=store&op=read             **换一个 Makers-Conversation-Id** 再跑
//                                          三条路各自的 verdict 就是答案
//
// 所有写入都在 `probe-*` 前缀下，不碰 `feishu.*` 那些真键。
// （2026-09-25 前这里还提过 `repo.snapshot` —— 语料快照已随仓库层删除。）

const PROBE_GLOBAL_PREFIX = "probe-global/";
const PROBE_ROUTE_PREFIX = "probe-route/";
const PROBE_STATE_PREFIX = "probe-state/";

/** 把一个对象自身的 + 原型链上的键都收上来（平台的 store 大量用 getter，只看 own 会漏） */
function collectKeys(o: any): string[] {
  if (!o || (typeof o !== "object" && typeof o !== "function")) return [];
  const set = new Set<string>();
  let cur = o;
  let depth = 0;
  while (cur && cur !== Object.prototype && depth < 4) {
    for (const k of Object.getOwnPropertyNames(cur)) set.add(k);
    cur = Object.getPrototypeOf(cur);
    depth++;
  }
  return [...set].sort();
}

/** 凭证类的值不打印原文，只报长度 / 首尾 / 是不是没被替换的占位符 */
function redactEnvValue(k: string, v: string | undefined): unknown {
  const s = String(v ?? "");
  if (!/CREDENTIAL|TOKEN|SECRET|KEY|PASSWORD/i.test(k)) return s;
  return {
    len: s.length,
    head: s.slice(0, 4),
    tail: s.slice(-4),
    // 还是 {{...}} 形态 = 构建期没替换掉 → ambient 模式必然失败
    isUnreplacedPlaceholder: s.startsWith("{{") && s.endsWith("}}"),
  };
}

async function probeStore(context: any, url: URL): Promise<Response> {
  // ⚠️ 必须挡令牌：`op=write` 会往**共享**命名空间里写键，`op=shape` 会回显
  // 存储相关的环境变量名。（门禁的例外只有状态页那两个，理由见 tokenGate）
  const denied = tokenGate(context, url);
  if (denied) return denied;

  const op = url.searchParams.get("op") ?? "shape";
  const cid = String(context?.conversation_id ?? "");
  const out: Record<string, unknown> = { op, conversationId: cid };

  // ── ① 形状：context.store 到底有哪些口子 ──────────────────────────
  const store = context?.store ?? null;
  out.contextStore = {
    present: !!store,
    ctor: store?.constructor?.name ?? null,
    keys: collectKeys(store),
    stateKeys: collectKeys(store?.state),
    // 有 list 就说明它就是个裸 KV；没有则说明是包装过的
    hasList: typeof store?.list === "function",
  };
  out.contextTopKeys = collectKeys(context).slice(0, 60);

  // ── ①.5 跨会话记忆：走和真实回合**同一个**解析函数 ─────────────────
  // 「记忆不见了」只有两种病，这个字段直接指出是哪一种，不用猜。
  out.memory = memoryBackendStatus((context?.env ?? {}) as Record<string, string | undefined>);

  // ── ② 运行时暴露面 ────────────────────────────────────────────────
  const rt = (globalThis as any).__EDGEONE_AGENT_RUNTIME__ ?? null;
  out.runtime = {
    present: !!rt,
    keys: collectKeys(rt),
    getStoreType: typeof rt?.getStore,
  };

  // ── ③ 环境变量里与存储/项目身份相关的 ─────────────────────────────
  const pe = (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
  out.storageEnv = Object.fromEntries(
    Object.entries(pe)
      .filter(([k]) => /^(PAGES_|EDGEONE_|ProjectId$|PROJECT_ID$)/.test(k))
      .map(([k, v]) => [k, redactEnvValue(k, v)]),
  );

  if (op === "shape") {
    out.next = [
      "① GET ?probe=store&op=write 写三条探针键",
      "② **换一个 Makers-Conversation-Id** 再 GET ?probe=store&op=read",
      "③ 看三条路各自的 verdict：哪条 foreign>0，哪条就是可用的跨会话键空间",
    ];
    return json(out);
  }

  const getStoreFn = rt?.getStore;
  const results: Record<string, unknown> = {};

  // ⚠️ 命名空间必须用运行时真正在用的那个：`memory-<projectId>`。
  // 早先以为 `context.store` 落在 `agent-store`，实测那个命名空间**根本不存在**
  // （`resolveRouteStore` 这条路由级 store 在 agents 路由下从未被调用）。
  // 用错名字会在账号里凭空建一个垃圾命名空间。
  const projectId = String(
    (pe.PAGES_PROJECT_ID ?? pe.ProjectId ?? pe.EDGEONE_PROJECT_ID ?? "").trim(),
  );
  const memoryNs = projectId ? `memory-${projectId}` : "";
  results.namespace = memoryNs || "(拿不到 projectId)";

  // ── A. 裸 Blob：自己起键前缀，理论上完全不带会话维度 ──────────────
  try {
    if (typeof getStoreFn !== "function") throw new Error("运行时未暴露 getStore");
    if (!memoryNs) throw new Error("拿不到 projectId，无法定位命名空间");
    const raw = getStoreFn({ name: memoryNs });

    if (op === "write") {
      const key = `${PROBE_GLOBAL_PREFIX}${Date.now()}-${cid.slice(0, 8)}`;
      await raw.set(key, JSON.stringify({ cid, at: new Date().toISOString() }));
      results.blob = { wrote: key };
    } else {
      const listed = await raw.list({ prefix: PROBE_GLOBAL_PREFIX });
      const keys: string[] = (listed?.blobs ?? []).map((b: any) => String(b.key));
      const rows: unknown[] = [];
      for (const k of keys.slice(-20)) {
        try {
          rows.push({ key: k, value: await raw.get(k, { type: "text" }) });
        } catch (e) {
          rows.push({ key: k, error: (e as Error).message });
        }
      }
      const foreign = rows.filter((r: any) => {
        try {
          return JSON.parse(String(r.value)).cid !== cid;
        } catch {
          return false;
        }
      });
      results.blob = {
        total: keys.length,
        rows,
        foreignCount: foreign.length,
        verdict: foreign.length
          ? `✅ 跨会话可见 —— 读到 ${foreign.length} 条别的会话写的键`
          : keys.length
            ? "⚠️ 只看到本会话写的键（换个 conversation_id 再跑一次 read）"
            : "❌ 一条都没读到",
      };
    }
  } catch (e) {
    results.blob = { error: (e as Error).message, name: (e as Error).name };
  }

  // ── B. 路由 store：context.store.get/set（推断是路由级，跨会话可见）──
  try {
    const rs = store;
    if (!rs || typeof rs.set !== "function") throw new Error("context.store.set 不可用");
    const key = `${PROBE_ROUTE_PREFIX}${cid.slice(0, 8)}`;
    if (op === "write") {
      await rs.set(key, { cid, at: new Date().toISOString() });
      results.routeStore = { wrote: key };
    } else {
      const v = await rs.get(key);
      const all = typeof rs.list === "function"
        ? await rs.list({ prefix: PROBE_ROUTE_PREFIX }).catch((e: Error) => ({ error: e.message }))
        : null;
      results.routeStore = {
        readOwnKey: v,
        ownKeyVisible: v != null,
        list: all,
      };
    }
  } catch (e) {
    results.routeStore = { error: (e as Error).message, name: (e as Error).name };
  }

  // ── C. 会话 state：预期**不**跨会话（对照组，用来确认隔离确实存在）──
  try {
    const kv = makeStateKv(context);
    if (!kv) throw new Error("context.store.state 不可用");
    const key = `${PROBE_STATE_PREFIX}${cid.slice(0, 8)}`;
    if (op === "write") {
      await kv.set(key, { cid, at: new Date().toISOString() });
      results.sessionState = { wrote: key };
    } else {
      const v = await kv.get(key);
      results.sessionState = {
        readOwnKey: v,
        ownKeyVisible: v != null,
        note: "这里读不到是**正常**的 —— 本会话没写过这个 key。要验证隔离，需要在本会话 write 一次。",
      };
    }
  } catch (e) {
    results.sessionState = { error: (e as Error).message, name: (e as Error).name };
  }

  out.results = results;
  out.hint =
    op === "write"
      ? "已写入。现在**换一个 Makers-Conversation-Id** 跑 ?probe=store&op=read"
      : "blob.foreignCount > 0 = 裸 Blob 可跨会话；routeStore.ownKeyVisible = 路由 store 可跨会话（且按路由名共享，注意别串数据）。";
  return json(out);
}

// ── 平台适配层 ────────────────────────────────────────────────────────

/**
 * 取按会话隔离的 JSON KV。
 *
 * 形状有两处差异要抹平：`agents/` 下是 `context.store.state`，
 * `cloud-functions/` 下是 `context.agent.store.state`。这里两种都认。
 */
function makeStateKv(context: any): StateKv | null {
  const bag =
    context?.store?.state ??
    context?.agent?.store?.state ??
    null;
  if (!bag || typeof bag.get !== "function" || typeof bag.set !== "function") return null;

  return {
    get: <T>(key: string) => bag.get(key) as Promise<T | null>,
    set: (key: string, value: unknown) => bag.set(key, value) as Promise<void>,
    delete: (key: string) => bag.delete(key) as Promise<void>,
  };
}

/** FeishuStore 的存储后端。拿不到平台 state 时退化成纯内存（本地调试用） */
function makeFeishuStore(context: any): FeishuStore {
  const kv = makeStateKv(context);
  if (!kv) {
    console.warn("[feishu] 拿不到 context.store.state，退化成纯内存（重启即丢）");
    return new FeishuStore(new MemoryKv());
  }
  return new FeishuStore(kv);
}

// ── 小工具 ────────────────────────────────────────────────────────────

/**
 * 读请求体。
 *
 * 平台文档说 `context.request.body` 是**已解析好的对象**；但它同时也说
 * `context.request` 是标准 Web Request（有 `.text()` / `.json()`）。
 * 两种都认，免得平台换实现时整条链路静默失效。
 */
/**
 * 取 `x-internal-token`。
 *
 * ── 为什么写得这么绕 ──────────────────────────────────────────────
 * 实测：这个 runtime 里的 `context.request.headers` **不是标准 Headers 实例**
 * （`typeof headers.get` 是 undefined，`forEach` 也没有）。原来的
 * `request.headers.get("x-internal-token")` 恒等于 ""，
 * 于是所有转发一律 401 —— 而报错文案只会说"不匹配"，看不出是根本取不到。
 *
 * 所以这里三种形态都试：标准 Headers、普通对象（含大小写变体）、以及 body。
 * 放 body 里是兜底：header 这条路在平台侧不可控，body 一定能到。
 */
function readInternalToken(request: any, body: any): string {
  const h = request?.headers;
  if (typeof h?.get === "function") {
    const v = h.get("x-internal-token") ?? h.get("X-Internal-Token");
    if (v) return String(v);
  }
  if (h && typeof h === "object") {
    const v = h["x-internal-token"] ?? h["X-Internal-Token"] ?? h["x-internal-Token"];
    if (v) return String(v);
  }
  // 兜底：body 里的 token 字段。bridge 两个都发，哪个到了都能过。
  return String(body?.token ?? "");
}

async function readJson(request: any): Promise<any> {
  if (request?.body && typeof request.body === "object") return request.body;
  if (typeof request?.text === "function") {
    const raw = await request.text();
    return raw ? JSON.parse(raw) : null;
  }
  if (typeof request?.json === "function") return await request.json();
  return null;
}

/** 收窄成内部事件。字段名不合法就返回 null（调用方回 400） */
function normalizeEvent(body: any): FeishuQueueEvent | null {
  if (!body || typeof body !== "object") return null;
  const messageId = String(body.messageId ?? "");
  const chatId = String(body.chatId ?? "");
  const text = String(body.text ?? "");
  if (!messageId || !chatId) return null;

  return {
    messageId,
    chatId,
    chatType: body.chatType === "group" ? "group" : "p2p",
    openId: String(body.openId ?? ""),
    text,
  };
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
