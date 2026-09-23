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
import { exchangeCode, redirectUri, verifyState } from "../../src/feishu/oauth.ts";
import { MemoryKv, FeishuStore, type StateKv } from "../../src/feishu/store.ts";
import { runFeishuTurn } from "../../src/feishu/turn.ts";
import type { FeishuQueueEvent } from "../../src/feishu/types.ts";
import { UserTokenManager, makeUserTokenStore } from "../../src/feishu/user-token.ts";
import { WorkspaceRepo, type RepoSnapshot, type RepoSnapshotStore } from "../../src/workspace/repo.ts";
import { createHost, type AgentEnv } from "./_host.ts";

/**
 * 语料快照的大小上限。超过就不写进 KV —— 快照写不进去时退化成纯内存，
 * 实例被驱逐后需要重新导入，但**不影响本次对话**。
 *
 * 4MB 是个保守值：语料上限本身就是 4MB（MAX_TOTAL_BYTES），JSON 序列化后
 * 大概 1.2~1.5 倍，再加上平台 KV 的单值压力。调大它之前先确认平台侧的限额。
 */
const REPO_SNAPSHOT_MAX_BYTES = 6 * 1024 * 1024;

const SNAPSHOT_KEY = "repo.snapshot";

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
  if (probe === "env") return probeEnv(context);

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
  const repo = new WorkspaceRepo(makeSnapshotStore(context, conversationId));
  await repo.hydrate();

  const host = createHost({
    env,
    context,
    repo,
    cache: store.tokenCache(),
    kv: makeStateKv(context),
    openId: evt.openId,
    chatId: evt.chatId,
  });

  // ── 调度模式 ──────────────────────────────────────────────────────
  // async（默认）：先回 202，后台跑完
  // sync         ：跑完才回。**不依赖后台执行能力**，代价是 webhook 要等
  const dispatch = String(mode ?? env.FEISHU_DISPATCH_MODE ?? "async").toLowerCase();

  const work = async (signal?: AbortSignal) => {
    try {
      await runFeishuTurn(host, env, store, evt);
      // 一轮跑完顺手 prune 一次。原版靠 DO alarm 定期跑；
      // EdgeOne 免费版的 cron 最小间隔是 1 天，所以改成「搭车」——
      // 每轮跑完裁一次，成本几乎为零，效果够用
      await store.prune();
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
    await work(request?.signal);
    return json({ ok: true, mode: "sync" }, 200);
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
async function probeEnv(context: any): Promise<Response> {
  const env = (context?.env ?? {}) as Record<string, unknown>;
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
    envKeys: Object.keys(env).filter((k) => /FEISHU|INTERNAL|AI_|AGENT|SANDBOX/.test(k)).sort(),
    internalToken: v ? { len: v.length, head: v.slice(0, 4), tail: v.slice(-4) } : null,
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

/**
 * 语料快照的存储后端。
 *
 * 超过上限就**不写**（`save` 静默返回）—— 与其写一个可能被平台拒掉的超大值，
 * 不如老实退化成纯内存。`snapshot()` 那边会因此拿到 null，`persist()` 返回 false，
 * 调用方（_host.ts）会打一条 warn。
 */
function makeSnapshotStore(context: any, conversationId: string): RepoSnapshotStore | undefined {
  const kv = makeStateKv(context);
  if (!kv) return undefined;

  return {
    async load(): Promise<RepoSnapshot | null> {
      try {
        return await kv.get<RepoSnapshot>(SNAPSHOT_KEY);
      } catch {
        return null;
      }
    },
    async save(s: RepoSnapshot): Promise<void> {
      const bytes = new TextEncoder().encode(JSON.stringify(s)).length;
      if (bytes > REPO_SNAPSHOT_MAX_BYTES) {
        throw new Error(`快照 ${bytes} 字节，超过上限 ${REPO_SNAPSHOT_MAX_BYTES}`);
      }
      await kv.set(SNAPSHOT_KEY, s);
      console.log(`[repo] 快照已落盘 cid=${conversationId} ${bytes} 字节`);
    },
    async clear(): Promise<void> {
      await kv.delete(SNAPSHOT_KEY);
    },
  };
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
