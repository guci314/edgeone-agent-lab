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

import { MemoryKv, FeishuStore, type StateKv } from "../../src/feishu/store.ts";
import { runFeishuTurn } from "../../src/feishu/turn.ts";
import type { FeishuQueueEvent } from "../../src/feishu/types.ts";
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
  const got = String(request?.headers?.get?.("x-internal-token") ?? "");
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

  let body: any;
  try {
    body = await readJson(request);
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
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

// ── 自测探针 ──────────────────────────────────────────────────────────

const PROBE_KEY = "probe.bg";

/**
 * 起一个后台任务：睡 15 秒，然后把时间戳写进 state。
 *
 * 为什么要 15 秒而不是 1 秒：太短的话任务可能在响应发出**之前**就跑完了，
 * 那样测出来的是「同步能跑」，而不是「后台能跑」—— 假的通过。
 */
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
