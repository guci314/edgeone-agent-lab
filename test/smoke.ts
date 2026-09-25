// 冒烟测试。不依赖 EdgeOne 平台，直接用 Node 跑。
//
//   npm test
//
// ── 为什么要有这个 ──────────────────────────────────────────────────
// `edgeone makers dev` 需要登录令牌，CI/无人环境里跑不了；而这条链路里
// 真正容易错的东西（验签顺序、去重语义、那个 36 字符的 conversation_id）
// **全都不依赖平台**。所以把它们从平台里剥出来单独测。
//
// 覆盖：
//   A. crypto   —— 官方测试向量解密 + 签名计算
//   B. event    —— 事件体解析、@占位符剥离
//   C. commands —— 命令解析
//   D. store    —— 去重 / 限流 / prune / token 缓存 / 跨实例恢复
//   E. webhook  —— 端到端：假 Request → 转发 → 断言转发头
//   F. turn     —— 端到端：一条 /help 走完整回合
//   G. compact  —— 会话压缩的纯函数（渲染历史 / 写回形状 / 门槛）
//   H. oauth    —— 云文档授权：链接解析 / state 签名 / 授权链接
//   I. token    —— 用户令牌：续期、轮换不丢 refresh_token、单飞、按人分槽
//   J. doctools —— 云文档三个工具：wiki 解引用 / 翻页缓存 / 拍平 / 未授权提示
//
// 2026-09-25：原来还有两节测「仓库语料导入」（`E. repo`）和
// 「read / ls / find / grep 四个代码工具」（`F. tools`）。改成通用助手后
// `src/workspace/*` 整个删掉了，这两节连同 `seed()` 帮手一起删除。
// 字母编号顺次前移，节标题里的字母只是给人看的，不参与任何逻辑。
//
// ⚠️ 这个文件会替换全局 fetch。所有测试都在一个进程里跑，
// 每个小节自己装自己的 stub，不要跨小节依赖。

import { decryptEvent, verifySignature } from "../src/feishu/crypto.ts";
import { sanitizeAndAppend, sanitizeHistory } from "../src/feishu/session-sanitize.ts";
import { parseMessageEvent, readChallenge, readEnvelope } from "../src/feishu/event.ts";
import { HELP_TEXT, parseCommand } from "../src/feishu/commands.ts";
import {
  DOC_SCOPES,
  buildAuthorizeUrl,
  parseDocUrl,
  redirectUri,
  signState,
  tokenFresh,
  verifyState,
} from "../src/feishu/oauth.ts";
import { MemoryKv as TokenKv } from "../src/feishu/store.ts";
import {
  UserTokenManager,
  makeUserTokenStore,
  type UserTokenStore,
} from "../src/feishu/user-token.ts";
import { makeFeishuDocTools } from "../src/feishu/docs.ts";
import {
  GlobalMemory,
  InMemoryMemoryBackend,
  MAX_ENTRIES,
  MAX_VALUE_CHARS,
  blobMemoryBackend,
  makeMemoryTools,
  memoryBackendStatus,
  normalizeMemoryKey,
  projectKey,
  renderMemoryList,
  userKey,
} from "../src/feishu/global-memory.ts";
import {
  MIN_ITEMS_TO_COMPACT,
  SUMMARY_SYSTEM_PROMPT,
  compactReply,
  renderTranscript,
  summaryItem,
} from "../src/feishu/compact.ts";
import { FeishuStore, MemoryKv } from "../src/feishu/store.ts";
import { runFeishuTurn } from "../src/feishu/turn.ts";
import type { FeishuQueueEvent } from "../src/feishu/types.ts";
import { onRequest as webhook } from "../cloud-functions/feishu-webhook/index.ts";

// ── 迷你测试框架 ──────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
let section = "";

function describe(name: string, fn: () => void | Promise<void>) {
  section = name;
  const r = fn();
  return r instanceof Promise ? r : Promise.resolve(r);
}

async function it(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    const msg = `${section} › ${name}\n     ${(e as Error).message}`;
    failures.push(msg);
    console.log(`  ❌ ${name}\n     ${(e as Error).message}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}期望 ${b}，实际 ${a}`);
}

function ok(cond: unknown, what = "") {
  if (!cond) throw new Error(`${what}断言失败`);
}

const realFetch = globalThis.fetch;

/** 把 fetch 换成按 URL 路由的假实现，返回被捕获的调用列表 */
function stubFetch(handler: (url: string, init: any) => Response | undefined) {
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = handler(u, init);
    if (r) return r;
    throw new Error(`测试没有为这个请求准备响应：${u}`);
  }) as typeof fetch;
  return calls;
}

/** 飞书 API 的通用假响应 */
function feishuStub(url: string, init: any): Response | undefined {
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

  if (url.includes("tenant_access_token")) {
    return json({ code: 0, tenant_access_token: "t-fake", expire: 7200 });
  }
  if (url.includes("/cardkit/v1/cards")) {
    return json({ code: 0, data: { card_id: "c-fake" } });
  }
  if (url.includes("/im/v1/messages")) {
    return json({ code: 0, data: { message_id: "om-fake" } });
  }
  return undefined;
}

/** sha256 的十六进制小写串 —— 飞书签名就是这个形状 */
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 按 `crypto.ts` 的约定造一段飞书密文：
 * key = sha256(encryptKey)，iv（16 字节）拼在密文前面，整体 base64。
 */
async function encryptLikeFeishu(plain: string, encryptKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(plain)),
  );
  const all = new Uint8Array(iv.length + ct.length);
  all.set(iv, 0);
  all.set(ct, iv.length);
  return btoa(String.fromCharCode(...all));
}

// ═══════════════════════════════════════════════════════════════════════
// A. crypto
// ═══════════════════════════════════════════════════════════════════════

await describe("A. crypto 验签与解密", async () => {
  await it("官方测试向量能解出 hello world", async () => {
    // 这条向量来自 crypto.ts 文件头的注释 —— 当初就是它证明
    // 「WebCrypto 的 AES-CBC 已经自动去填充」，推翻了「要自己剥 PKCS#7」的判断
    const plain = await decryptEvent(
      "P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=",
      "test key",
    );
    eq(plain, "hello world");
  });

  await it("签名 = sha256(timestamp + nonce + key + rawBody) 的十六进制", async () => {
    const ts = "1700000000";
    const nonce = "abc";
    const key = "k";
    const body = '{"a":1}';
    const data = new TextEncoder().encode(ts + nonce + key + body);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    ok(await verifySignature(body, ts, nonce, key, hex), "正确签名应通过");
    ok(!(await verifySignature(body, ts, nonce, key, hex.toUpperCase().slice(0, 10))), "错误签名应失败");
  });

  await it("缺 timestamp / nonce / signature 一律判失败", async () => {
    ok(!(await verifySignature("x", "", "n", "k", "s")));
    ok(!(await verifySignature("x", "t", "", "k", "s")));
    ok(!(await verifySignature("x", "t", "n", "k", "")));
  });

  await it("密文长度不合法时报错而不是静默返回空", async () => {
    let threw = false;
    try {
      await decryptEvent("YWJj", "key");
    } catch {
      threw = true;
    }
    ok(threw, "短密文应抛错");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. event
// ═══════════════════════════════════════════════════════════════════════

await describe("B. 事件体解析", async () => {
  const event = {
    header: { event_type: "im.message.receive_v1", token: "vt" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "group",
        message_type: "text",
        content: '{"text":"@_user_1 帮我看看 src/a.ts"}',
        mentions: [{ key: "@_user_1", name: "bot" }],
      },
    },
  };

  await it("解析出五个字段", () => {
    const m = parseMessageEvent(event)!;
    eq(m.messageId, "om_1");
    eq(m.chatId, "oc_1");
    eq(m.chatType, "group");
    eq(m.openId, "ou_1");
  });

  await it("@占位符被剥掉、空格被压掉，但换行保留", () => {
    eq(parseMessageEvent(event)!.text, "帮我看看 src/a.ts");

    const multi = structuredClone(event);
    multi.event.message.content = '{"text":"@_user_1 第一行\\n  第二行"}';
    eq(parseMessageEvent(multi)!.text, "第一行\n  第二行");
  });

  await it("非文本消息 / 非消息事件一律返回 null（静默忽略，不是错误）", () => {
    const img = structuredClone(event);
    img.event.message.message_type = "image";
    eq(parseMessageEvent(img), null);

    const other = structuredClone(event);
    other.header.event_type = "im.chat.updated_v1";
    eq(parseMessageEvent(other), null);
  });

  await it("challenge 握手体识别", () => {
    eq(readChallenge({ type: "url_verification", challenge: "c-1", token: "vt" }), "c-1");
    eq(readChallenge({ type: "event_callback" }), null);
  });

  await it("envelope 取出事件类型与 token", () => {
    const e = readEnvelope(event)!;
    eq(e.eventType, "im.message.receive_v1");
    eq(e.token, "vt");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. commands
// ═══════════════════════════════════════════════════════════════════════

await describe("C. 命令解析", async () => {
  await it("不带斜杠 = 提问", () => {
    eq(parseCommand("这个函数干嘛的"), { kind: "ask", text: "这个函数干嘛的" });
  });

  await it("/repo 已经不是命令了（改成通用助手后去掉）", () => {
    // 关键：`/repo xxx` 必须被判成「不认识的命令」→ `{ kind: "error" }`，
    // **不能**掉进 `case "ask"` 被当成普通提问送给模型。
    // 否则用户发 `/repo a/b` 会得到一段模型即兴发挥的答复，而不是明确的
    // 「没这个命令」—— 那才是真正难排查的故障。
    eq(parseCommand("/repo sindresorhus/is-stream"), {
      kind: "error",
      message: "不认识的命令 /repo。发 /help 看看有什么。",
    });
    eq(parseCommand("/repo a/b@dev").kind, "error");
    eq(parseCommand("/导入 a/b").kind, "error");
    // 命令名大小写不敏感，`/REPO` 同样落到 error 分支
    eq(parseCommand("/REPO a/b").kind, "error");
  });

  await it("/status /help 与中文别名", () => {
    eq(parseCommand("/status").kind, "status");
    eq(parseCommand("/状态").kind, "status");
    eq(parseCommand("/help").kind, "help");
    eq(parseCommand("/帮助").kind, "help");
    eq(parseCommand("/不认识").kind, "error");
  });

  await it("/compact /clear 与中文别名", () => {
    eq(parseCommand("/compact").kind, "compact");
    eq(parseCommand("/压缩").kind, "compact");
    eq(parseCommand("/CLEAR").kind, "clear", "命令名大小写不敏感");
    eq(parseCommand("/清空").kind, "clear");
  });

  await it("带了多余参数的 /compact 也照常识别（参数被忽略）", () => {
    eq(parseCommand("/compact 现在").kind, "compact");
  });

  await it("/login /logout 与中文别名", () => {
    eq(parseCommand("/login").kind, "login");
    eq(parseCommand("/授权").kind, "login");
    eq(parseCommand("/logout").kind, "logout");
    eq(parseCommand("/退出授权").kind, "logout");
    // 别把 /login 认成 /lo… 之类的近邻命令
    eq(parseCommand("/log").kind, "error");
  });

  await it("帮助文案里列出了两个授权命令", () => {
    ok(HELP_TEXT.includes("/login"), "应列出 /login");
    ok(HELP_TEXT.includes("/logout"), "应列出 /logout");
  });

  await it("/memory /forget 与中文别名", () => {
    eq(parseCommand("/memory").kind, "memory");
    eq(parseCommand("/记忆").kind, "memory");
    eq(parseCommand("/forget 技术栈"), { kind: "forget", key: "技术栈" });
    eq(parseCommand("/忘记 prefs/技术栈"), { kind: "forget", key: "prefs/技术栈" });
    // 光秃秃的 /forget 也要认 —— 宿主会回一段用法，比在这里报「参数缺失」有用。
    // （用户打一个不完整的命令时想看的是用法，不是一句错误提示。）
    eq(parseCommand("/forget"), { kind: "forget", key: "" });
  });

  await it("帮助文案里列出了记忆相关命令", () => {
    ok(HELP_TEXT.includes("/memory"), "应列出 /memory");
    ok(HELP_TEXT.includes("/forget"), "应列出 /forget");
  });

  await it("别把 /forget 认成 /for… 之类的近邻命令", () => {
    eq(parseCommand("/for").kind, "error");
    eq(parseCommand("/memories").kind, "error");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. store
// ═══════════════════════════════════════════════════════════════════════

await describe("D. 飞书状态存储", async () => {
  await it("第一次 claim 放行，窗口内重复 claim 拦住", async () => {
    const s = new FeishuStore(new MemoryKv());
    eq(await s.claim("m1", "c1", "o1"), true, "首次");
    eq(await s.claim("m1", "c1", "o1"), false, "重复");
    eq(await s.claim("m1", "c1", "o1"), false, "再重复");
  });

  await it("markDone 之后窗口内仍然拦住（判据是时间窗口不是状态）", async () => {
    const s = new FeishuStore(new MemoryKv());
    await s.claim("m1", "c1", "o1");
    await s.markDone("m1");
    eq(await s.claim("m1", "c1", "o1"), false);
  });

  await it("窗口外的同 id 视为新消息，重新放行", async () => {
    const s = new FeishuStore(new MemoryKv());
    await s.claim("m1", "c1", "o1");
    // 手动把时间往前挪 11 分钟（去重窗口是 10 分钟）
    const kv = (s as any).kv as MemoryKv;
    const rows = (await kv.get<any[]>("feishu.events"))!;
    rows[0].createdAt = Date.now() - 11 * 60 * 1000;
    await kv.set("feishu.events", rows);
    const s2 = new FeishuStore(kv);
    eq(await s2.claim("m1", "c1", "o1"), true, "窗口外");
  });

  await it("recentCount 只数窗口内的，overLimit 到 10 条触发", async () => {
    const s = new FeishuStore(new MemoryKv());
    for (let i = 0; i < 10; i++) await s.claim(`m${i}`, "c1", "o1");
    eq(await s.recentCount("c1"), 10);
    eq(await s.overLimit("c1"), true);
    eq(await s.recentCount("c2"), 0);
    eq(await s.overLimit("c2"), false);
  });

  await it("prune 清掉过期事件", async () => {
    const kv = new MemoryKv();
    const s = new FeishuStore(kv);
    await s.claim("old", "c1", "o1");
    const rows = (await kv.get<any[]>("feishu.events"))!;
    rows[0].createdAt = Date.now() - 4 * 24 * 60 * 60 * 1000; // 4 天前，TTL 是 3 天
    await kv.set("feishu.events", rows);
    const s2 = new FeishuStore(kv);
    eq(await s2.prune(), 1);
  });

  await it("token 缓存跨实例恢复（换实例仍读得到）", async () => {
    const kv = new MemoryKv();
    await new FeishuStore(kv).tokenCache().set({ token: "tk", exp: 12345 });
    eq((await new FeishuStore(kv).tokenCache().get())?.token, "tk");
  });

  await it("事件数组有条数上限（不会无限增长）", async () => {
    const kv = new MemoryKv();
    const s = new FeishuStore(kv);
    for (let i = 0; i < 560; i++) await s.claim(`m${i}`, "c1", "o1");
    const rows = (await kv.get<any[]>("feishu.events"))!;
    ok(rows.length <= 500, `应 ≤500，实际 ${rows.length}`);
  });
});

/**
 * 调一个 `tool()` 产出的工具。
 *
 * ⚠️ 踩过的坑：`invoke` 的第二个参数是 **JSON 字符串**，不是参数对象。
 * 签名（`@openai/agents-core/dist/tool.d.ts`）：
 *   invoke(runContext, input: string, details?) => Promise<string | Result>
 * 内部先 `parser(input)`，解析失败会抛 `InvalidToolInputError`，再被
 * `toolErrorFunction` 兜成一个 **`"An error occurred while running the tool"` 字符串
 * 返回 —— 不抛异常。所以传对象进去的表现是「每个工具都返回一段英文错误文本」，
 * 第一次跑测试时看到的是十几条 `Unexpected token 'A', "An error o"...`。
 *
 * runContext 传 `{}` 就够：云文档工具和记忆工具的 execute 都只吃参数、不碰 runContext。
 */
async function callTool(t: any, args: any): Promise<any> {
  if (typeof t?.invoke !== "function") {
    throw new Error(`tool 上没有 invoke，keys=${Object.keys(t ?? {}).join(",")}`);
  }
  const out = await t.invoke({}, JSON.stringify(args));
  return typeof out === "string" ? JSON.parse(out) : out;
}

// ═══════════════════════════════════════════════════════════════════════
// E. webhook 端到端
// ═══════════════════════════════════════════════════════════════════════

await describe("E. 飞书 webhook 端到端", async () => {
  const ENV = {
    FEISHU_APP_ID: "cli_x",
    FEISHU_APP_SECRET: "s",
    FEISHU_VERIFICATION_TOKEN: "vt",
    INTERNAL_TOKEN: "internal-token",
  };

  // 真实飞书 chat_id 的形状：oc_ + 32 位十六进制 = 35 字符
  const REAL_CHAT_ID = "oc_0123456789abcdef0123456789abcdef";

  const messageEvent = (over: any = {}) => ({
    header: { event_type: "im.message.receive_v1", token: "vt" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
      message: {
        message_id: "om_1",
        chat_id: REAL_CHAT_ID,
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"/help"}',
      },
    },
    ...over,
  });

  const post = (body: unknown, url = "https://app.example/feishu-webhook") =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  await it("challenge 握手原样回声（且不验签）", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: post({ type: "url_verification", challenge: "c-123", token: "vt" }),
      env: ENV,
    });
    eq(res.status, 200);
    eq(await res.json(), { challenge: "c-123" });
  });

  await it("challenge 的 token 不对 → 401", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: post({ type: "url_verification", challenge: "c", token: "错的" }),
      env: ENV,
    });
    eq(res.status, 401);
  });

  await it("正常消息：回 ACK 且转发一次", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const res = await webhook({ request: post(messageEvent()), env: ENV });
    eq(res.status, 200);
    eq(await res.json(), { code: 0 });

    const fwd = calls.filter((c) => c.url.includes("/feishu") && !c.url.includes("webhook"));
    eq(fwd.length, 1, "转发次数");
  });

  await it("⭐ conversation_id 落在 6~36 字符且字符集合法（原版写法会超限）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    await webhook({ request: post(messageEvent()), env: ENV });

    const cid = calls[0].init.headers["Makers-Conversation-Id"] as string;
    ok(cid, "必须带 Makers-Conversation-Id");
    ok(cid.length >= 6 && cid.length <= 36, `长度 ${cid.length} 越界：${cid}`);
    ok(/^[0-9a-zA-Z._-]+$/.test(cid), `字符集不合法：${cid}`);
    ok(cid.startsWith("fs-"), `应以 fs- 开头：${cid}`);

    // 把那个坑做成断言：原版写法 fs-${chatId} 是 38 字符
    eq(`fs-${REAL_CHAT_ID}`.length, 38, "原版写法长度");
    ok(`fs-${REAL_CHAT_ID}`.length > 36, "原版写法确实超限 —— 这就是当初会全线 400 的原因");
  });

  await it("同一个 chat 永远映射到同一个 conversation_id（粘性路由的前提）", async () => {
    const a = stubFetch(() => new Response("{}", { status: 202 }));
    await webhook({ request: post(messageEvent()), env: ENV });
    const first = a[0].init.headers["Makers-Conversation-Id"];

    const b = stubFetch(() => new Response("{}", { status: 202 }));
    await webhook({ request: post(messageEvent()), env: ENV });
    const second = b[0].init.headers["Makers-Conversation-Id"];

    eq(first, second);
  });

  await it("不同 chat 映射到不同的 conversation_id", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const other = messageEvent();
    other.event.message.chat_id = "oc_ffffffffffffffffffffffffffffffff";
    await webhook({ request: post(messageEvent()), env: ENV });
    await webhook({ request: post(other), env: ENV });
    ok(calls[0].init.headers["Makers-Conversation-Id"] !== calls[1].init.headers["Makers-Conversation-Id"]);
  });

  await it("转发时带上内部令牌", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    await webhook({ request: post(messageEvent()), env: ENV });
    eq(calls[0].init.headers["x-internal-token"], "internal-token");
  });

  await it("自环防护：sender_type=app 不转发（必须先于去重）", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const e = messageEvent();
    e.event.sender.sender_type = "app";
    const res = await webhook({ request: post(e), env: ENV });
    eq(res.status, 200);
    eq(calls.length, 0, "不该有任何转发");
  });

  await it("chat_id 形状不合法 → 静默忽略", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const e = messageEvent();
    e.event.message.chat_id = "恶意构造的id";
    await webhook({ request: post(e), env: ENV });
    eq(calls.length, 0);
  });

  await it("超长文本 → 静默忽略", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const e = messageEvent();
    e.event.message.content = JSON.stringify({ text: "x".repeat(4001) });
    await webhook({ request: post(e), env: ENV });
    eq(calls.length, 0);
  });

  await it("白名单生效", async () => {
    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const res = await webhook({
      request: post(messageEvent()),
      env: { ...ENV, FEISHU_ALLOWED_OPEN_IDS: "ou_别人" },
    });
    eq(res.status, 200);
    eq(calls.length, 0);
  });

  await it("body 不是合法 JSON → 400", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({ request: post("不是 json"), env: ENV });
    eq(res.status, 400);
  });

  await it("非 POST → 405", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: new Request("https://app.example/feishu-webhook", { method: "GET" }),
      env: ENV,
    });
    eq(res.status, 405);
  });

  await it("缺应用凭证 → 503（fail closed）", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({ request: post(messageEvent()), env: { INTERNAL_TOKEN: "x" } });
    eq(res.status, 503);
  });

  await it("缺 INTERNAL_TOKEN → 503（否则转发必被 agent 拒）", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: post(messageEvent()),
      env: { FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b", FEISHU_VERIFICATION_TOKEN: "vt" },
    });
    eq(res.status, 503);
  });

  await it("agent 返回 4xx/5xx → webhook 回 500（让飞书重推）", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "boom" }), { status: 401 }));
    const res = await webhook({ request: post(messageEvent()), env: ENV });
    eq(res.status, 500);
  });

  await it("配了 Encrypt Key 时签名不对 → 401", async () => {
    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: post(messageEvent()),
      env: { ...ENV, FEISHU_ENCRYPT_KEY: "ek" },
    });
    eq(res.status, 401);
  });

  await it("配了 Encrypt Key 时签名正确 → 放行", async () => {
    const ek = "ek";
    const body = JSON.stringify(messageEvent());
    const ts = "1700000000";
    const nonce = "n1";
    const sig = await sha256hex(ts + nonce + ek + body);

    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const res = await webhook({
      request: new Request("https://app.example/feishu-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-request-timestamp": ts,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": sig,
        },
        body,
      }),
      env: { ...ENV, FEISHU_ENCRYPT_KEY: ek },
    });
    eq(res.status, 200);
    eq(calls.length, 1);
  });

  /**
   * ⚠️ 这条原来写坏了：只构造了密文、**没配 Encrypt Key**，于是 webhook 不做解密、
   * 拿到 `{encrypt: "..."}` 后 token 取到空串 → 401，而测试注释自己还写着
   * 「不配 key 时不会尝试解密 —— 这条只验证不崩」。断言 200 是自相矛盾的。
   *
   * 现在按真实链路走：配 key + 密文 + 对**原始 body**算签名，验证
   * 「解密排在验签之前」这个顺序确实成立（签名算的是加密后的那串，不是明文）。
   */
  await it("加密事件体：解密 → 验签 → 转发（顺序不能反）", async () => {
    const ek = "test key";
    const encrypt = await encryptLikeFeishu(JSON.stringify(messageEvent()), ek);
    const raw = JSON.stringify({ encrypt });
    const ts = "1700000000";
    const nonce = "n1";
    const sig = await sha256hex(ts + nonce + ek + raw);

    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const res = await webhook({
      request: new Request("https://app.example/feishu-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-request-timestamp": ts,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": sig,
        },
        body: raw,
      }),
      env: { ...ENV, FEISHU_ENCRYPT_KEY: ek },
    });
    eq(res.status, 200);
    eq(calls.length, 1, "解密后应该转发一次");

    // 转发的是**解出来的**事件体，不是那坨密文
    const fwd = JSON.parse(calls[0].init.body);
    eq(fwd.text, "/help");
    eq(fwd.chatId, REAL_CHAT_ID);
  });

  await it("加密事件体：签名对不上 → 401（密文不能绕过验签）", async () => {
    const ek = "test key";
    const encrypt = await encryptLikeFeishu(JSON.stringify(messageEvent()), ek);
    const raw = JSON.stringify({ encrypt });

    const calls = stubFetch(() => new Response("{}", { status: 202 }));
    const res = await webhook({
      request: new Request("https://app.example/feishu-webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lark-request-timestamp": "1700000000",
          "x-lark-request-nonce": "n1",
          "x-lark-signature": "deadbeef",
        },
        body: raw,
      }),
      env: { ...ENV, FEISHU_ENCRYPT_KEY: ek },
    });
    eq(res.status, 401);
    eq(calls.length, 0);
  });

  await it("加密的挑战体也能解出来（url_verification 同样是密文）", async () => {
    const ek = "test key";
    const encrypt = await encryptLikeFeishu(
      JSON.stringify({ type: "url_verification", challenge: "c-enc", token: "vt" }),
      ek,
    );

    stubFetch(() => new Response("{}"));
    const res = await webhook({
      request: post({ encrypt }),
      // ⚠️ 挑战握手不验签（飞书文档：安全校验不含请求网址校验），所以不带签名头
      env: { ...ENV, FEISHU_ENCRYPT_KEY: ek },
    });
    eq(res.status, 200);
    eq(await res.json(), { challenge: "c-enc" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// F. turn 端到端
// ═══════════════════════════════════════════════════════════════════════

await describe("F. 回合流程", async () => {
  const ENV = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s" };

  /**
   * 宿主 stub。
   *
   * ⚠️ 2026-09-25 之前这里还有个 `ghStub`（飞书 + GitHub 的混合假响应），
   * 专为 `/repo owner/name` 服务 —— 那条路径会先调 `resolveDefaultBranch()`
   * 去问 `api.github.com`，只 stub 飞书的话那一步会抛
   * 「测试没有为这个请求准备响应」。`/repo` 删掉后它没有任何使用者，一并删除。
   */
  const host = (over: Partial<any> = {}) => ({
    ask: async () => ({ text: "答案是 42", streamed: false }),
    statusText: async () => "会话 oc_1\n对话消息 3 条",
    compact: async () => "已压缩：8 条历史 → 摘要（约 300 字）",
    clear: async () => "会话已清空",
    loginUrl: async () => "点这条链接授权：\nhttps://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_x",
    logout: async () => "已撤销云文档授权。",
    memoryText: async () => "长期记忆共 0 条（跨会话共享）：",
    forgetMemory: async (k: string) => `已删掉 ${k}。`,
    ...over,
  });

  const evt = (text: string): FeishuQueueEvent => ({
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "p2p",
    openId: "ou_1",
    text,
  });

  const sentTexts = (calls: { url: string; init: any }[]) =>
    calls
      .filter((c) => c.url.includes("/im/v1/messages"))
      .map((c) => JSON.parse(c.init.body).content)
      .map((c) => JSON.parse(c).text as string);

  await it("/help 发出命令列表并标记完成", async () => {
    const calls = stubFetch(feishuStub);
    const store = new FeishuStore(new MemoryKv());
    await store.claim("om_1", "oc_1", "ou_1");
    await runFeishuTurn(host() as any, ENV, store, evt("/help"));

    const texts = sentTexts(calls);
    eq(texts.length, 1);
    ok(texts[0].includes("/status"), texts[0]);
    // 帮助里不该再出现已经删掉的 /repo
    ok(!texts[0].includes("/repo"), texts[0]);
    eq((await store as any).events.get("om_1").state, "done");
  });

  await it("/status 走 host.statusText", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/status"));
    eq(sentTexts(calls)[0], "会话 oc_1\n对话消息 3 条");
  });

  await it("/login 发出的是宿主给的链接，不是模型编的", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/login"));
    const texts = sentTexts(calls);
    eq(texts.length, 1);
    // 链接必须**原样**出现。授权链接错一个字符就是飞书的一个报错页，
    // 用户完全无从判断 —— 所以这条路径不走模型
    ok(texts[0].includes("https://accounts.feishu.cn/open-apis/authen/v1/authorize"), texts[0]);
  });

  await it("/logout 走 host.logout", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/退出授权"));
    eq(sentTexts(calls)[0], "已撤销云文档授权。");
  });

  await it("/memory 走 host.memoryText", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(
      host({ memoryText: async () => "长期记忆共 1 条（跨会话共享）：\n- prefs/技术栈：pnpm" }) as any,
      ENV,
      new FeishuStore(new MemoryKv()),
      evt("/memory"),
    );
    ok(sentTexts(calls)[0].includes("prefs/技术栈"), sentTexts(calls)[0]);
  });

  await it("/forget 把键名原样透传给宿主（空参数也透传）", async () => {
    const seen: string[] = [];
    const calls = stubFetch(feishuStub);
    const h = host({
      forgetMemory: async (k: string) => {
        seen.push(k);
        return "已删掉 prefs/技术栈。";
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/forget 技术栈"));
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/forget"));

    // 空串也要原样传下去 —— 「用法说明」由宿主回（只有它知道有哪些键、
    // 以及清空需要什么确认词），turn 这一层不该自己编文案
    eq(seen, ["技术栈", ""]);
    eq(sentTexts(calls)[0], "已删掉 prefs/技术栈。");
  });

  await it("/memory 上宿主抛错时兜住，而不是静默", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(
      host({
        memoryText: async () => {
          throw new Error("blob 连不上");
        },
      }) as any,
      ENV,
      new FeishuStore(new MemoryKv()),
      evt("/memory"),
    );
    // 不兜的话用户那边一条消息都收不到，看起来像 bot 死了
    ok(sentTexts(calls)[0].includes("blob 连不上"), sentTexts(calls)[0]);
  });

  await it("host.loginUrl 抛错时也发得出一条消息", async () => {
    // 比如没配 FEISHU_OAUTH_REDIRECT_URI —— buildAuthorizeUrl 会抛。
    // 不兜的话用户一条消息都收不到，看起来像 bot 死了
    const calls = stubFetch(feishuStub);
    const h = host({
      loginUrl: async () => {
        throw new Error("没有配置 FEISHU_OAUTH_REDIRECT_URI");
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/login"));
    ok(sentTexts(calls)[0].includes("没有配置 FEISHU_OAUTH_REDIRECT_URI"), sentTexts(calls)[0]);
  });

  await it("/repo 走不通了：回一句「不认识的命令」，且不发给模型", async () => {
    // 改成通用助手后 `/repo` 被删。这条端到端测试守的是**它不会静默变成提问**：
    // 如果哪天 parseCommand 的 default 分支被改成 `{ kind: "ask" }`，
    // 用户发 `/repo a/b` 会拿到一段模型即兴发挥的答复，而宿主 stub 的 ask
    // 会被调到 —— 下面那个 `asked` 断言就会炸。
    let asked = false;
    const calls = stubFetch(feishuStub);
    const h = host({
      ask: async () => {
        asked = true;
        return { text: "答案是 42", streamed: false };
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/repo a/b"));

    const texts = sentTexts(calls);
    eq(texts.length, 1, "只该回一条提示");
    eq(asked, false, "不该走到模型");
    ok(texts[0].includes("不认识的命令"), texts[0]);
    ok(!texts[0].includes("答案是 42"), texts[0]);
  });

  await it("提问：模型失败时**必须**发出提示而不是静默（原版踩过的坑）", async () => {
    const calls = stubFetch(feishuStub);
    const h = host({
      ask: async () => {
        throw new Error("模型凭证没配");
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("问题"));

    const texts = sentTexts(calls);
    eq(texts.length, 1, "必须有一条消息发出去");
    ok(texts[0].includes("没答上来"), texts[0]);
  });

  await it("提问：streamed=true 时不再补发文本（否则会重复）", async () => {
    const calls = stubFetch(feishuStub);
    const h = host({ ask: async () => ({ text: "已在卡片里", streamed: true }) });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("问题"));
    eq(sentTexts(calls).length, 0);
  });

  await it("提问：模型返回空串时用兜底文案", async () => {
    const calls = stubFetch(feishuStub);
    const h = host({ ask: async () => ({ text: "   ", streamed: false }) });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("问题"));
    ok(sentTexts(calls)[0].includes("模型没有返回任何内容"), sentTexts(calls)[0]);
  });

  await it("/compact 走 host.compact 并回执", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/compact"));
    const texts = sentTexts(calls);
    eq(texts.length, 1);
    ok(texts[0].includes("已压缩"), texts[0]);
  });

  await it("/clear 走 host.clear 并回执", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/clear"));
    eq(sentTexts(calls)[0], "会话已清空");
  });

  /**
   * 这条守的是「异常不许静默」：compact/clear 抛出去的话，异步模式下用户
   * **一条消息都收不到**。上面 ask 那条早就踩过同样的坑，这里同样要有一条。
   */
  await it("/compact 抛错时仍发出一条消息（不能静默）", async () => {
    const calls = stubFetch(feishuStub);
    const h = host({
      compact: async () => {
        throw new Error("模型 429");
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/compact"));
    const texts = sentTexts(calls);
    eq(texts.length, 1, "必须有一条消息发出去");
    ok(texts[0].includes("处理失败") && texts[0].includes("429"), texts[0]);
  });

  await it("元命令自己不留痕：/compact 不调用 host.ask", async () => {
    stubFetch(feishuStub);
    let asked = 0;
    const h = host({
      ask: async () => {
        asked++;
        return { text: "不该被调到", streamed: false };
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/compact"));
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/clear"));
    eq(asked, 0, "元命令走的是 host.compact / host.clear，不是 ask");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// G. 会话压缩（纯函数）
// ═══════════════════════════════════════════════════════════════════════

await describe("G. 会话压缩的纯函数", async () => {
  await it("门槛是 3 项，且这个门槛让 /compact 幂等", () => {
    eq(MIN_ITEMS_TO_COMPACT, 3);
    // 压完只剩「一条摘要」 → 再压一次会被挡在门槛外，不会把摘要又压一遍
    ok(1 < MIN_ITEMS_TO_COMPACT);
  });

  await it("用户/助手消息渲染成带角色标签的文本", () => {
    const t = renderTranscript([
      { role: "user", content: "is-stream 怎么判断" },
      { role: "assistant", content: "看 src/index.js:12" },
    ]);
    eq(t, "用户：is-stream 怎么判断\n\n助手：看 src/index.js:12");
  });

  await it("内容块数组（SDK 的 input_text / output_text）也能渲染", () => {
    const t = renderTranscript([
      { role: "user", content: [{ type: "input_text", text: "第一段" }, { type: "input_image" }] },
      { role: "assistant", content: [{ type: "output_text", text: "第二段" }] },
    ]);
    eq(t, "用户：第一段\n[图片]\n\n助手：第二段");
  });

  await it("type 缺省的项也当消息处理（平台换实现时的兜底）", () => {
    eq(renderTranscript([{ role: "user", content: "裸形状" }]), "用户：裸形状");
  });

  await it("工具调用与返回各渲染成一行", () => {
    const t = renderTranscript([
      { type: "function_call", name: "grep", arguments: '{"pattern":"x"}' },
      { type: "function_call_result", name: "grep", output: '{"matchCount":0}' },
    ]);
    eq(t, '[调用工具 grep] {"pattern":"x"}\n\n[工具 grep 返回] {"matchCount":0}');
  });

  await it("思考项被丢掉（又长又吵，结论在正文里）", () => {
    const t = renderTranscript([
      { type: "reasoning", content: [{ type: "reasoning_text", text: "嗯……让我想想……" }] },
      { role: "user", content: "问题" },
    ]);
    eq(t, "用户：问题");
  });

  await it("空历史渲染成空串", () => {
    eq(renderTranscript([]), "");
    eq(renderTranscript([{ role: "user", content: "   " }]), "");
  });

  await it("超长消息保留头尾（中段省略）", () => {
    const t = renderTranscript([{ role: "user", content: `开头${"x".repeat(9000)}结尾` }]);
    ok(t.startsWith("用户：开头"), t.slice(0, 30));
    ok(t.endsWith("结尾"), t.slice(-10));
    ok(t.includes("省略"), "应标注省略");
    ok(t.length < 9000, `应显著短于原文，实际 ${t.length}`);
  });

  await it("整段 transcript 超限时保留头和尾（会话开头的出发点不能丢）", () => {
    const items = [
      { role: "user", content: "帮我盯一下 https://example.com/report 这份周报，只看交付时间" },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "user",
        content: `第${i}轮问：${"很长的内容".repeat(900)}`,
      })),
    ];
    const t = renderTranscript(items);
    ok(t.length <= 120_100, `应被截到上限附近，实际 ${t.length}`);
    ok(t.includes("https://example.com/report"), "开头的来源链接必须留下");
    ok(t.includes("中间省略"), "应有省略标注");
    ok(t.includes("第39轮问"), "尾部的最近讨论必须留下");
  });

  await it("摘要写回的形状：user role + 固定前缀", () => {
    const item = summaryItem("  这里是摘要  ");
    eq(item.role, "user");
    ok(item.content.startsWith("以下是此前对话的压缩摘要："), item.content);
    ok(item.content.includes("这里是摘要"), "两端的空白应被 trim");
  });

  await it("回执文案带上条数和字数", () => {
    eq(compactReply(12, 345), "已压缩：12 条历史 → 摘要（约 345 字）");
  });

  await it("摘要 prompt 点名了四类必须保留的信息", () => {
    for (const k of ["来源", "结论", "偏好", "还没做完"]) {
      ok(SUMMARY_SYSTEM_PROMPT.includes(k), `prompt 里应提到「${k}」`);
    }
    ok(SUMMARY_SYSTEM_PROMPT.includes("不要编"), "必须明确禁止编造");
    // 改成通用助手后不该再要求模型记「导入了哪个仓库」—— 那个能力已经没了
    ok(!SUMMARY_SYSTEM_PROMPT.includes("仓库"), "不该残留仓库问答时代的保留项");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// H. 云文档授权：链接解析 / state 签名 / 授权链接
// ═══════════════════════════════════════════════════════════════════════

await describe("H. 云文档授权（纯函数）", async () => {
  await it("parseDocUrl 认得五种链接形态", () => {
    eq(parseDocUrl("https://x.feishu.cn/docx/AbCd1234"), { kind: "docx", token: "AbCd1234" });
    eq(parseDocUrl("https://x.feishu.cn/wiki/WkNode99"), { kind: "wiki", token: "WkNode99" });
    eq(parseDocUrl("https://x.feishu.cn/base/BtApp77"), { kind: "bitable", token: "BtApp77" });
    eq(parseDocUrl("https://x.feishu.cn/sheets/ShTok55"), { kind: "sheets", token: "ShTok55" });
    // 旧版文档链接：飞书会重定向到 /docx，但我们得先认得它
    eq(parseDocUrl("https://x.feishu.cn/docs/OldDoc1"), { kind: "docx", token: "OldDoc1" });
  });

  await it("parseDocUrl 带出 ?table= / ?sheet= 子标识", () => {
    eq(parseDocUrl("https://x.feishu.cn/base/Bt?table=tbl1&view=v1"), {
      kind: "bitable",
      token: "Bt",
      tableId: "tbl1",
    });
    eq(parseDocUrl("https://x.feishu.cn/sheets/Sh?sheet=sid1"), {
      kind: "sheets",
      token: "Sh",
      sheetId: "sid1",
    });
    // 知识库链接一样会带子标识：新建的多维表格/电子表格默认就落在知识库，
    // 用户从地址栏拷下来的正是这个形状
    eq(parseDocUrl("https://x.feishu.cn/wiki/Wk?table=tbl1&view=v1"), {
      kind: "wiki",
      token: "Wk",
      tableId: "tbl1",
    });
    eq(parseDocUrl("https://x.feishu.cn/wiki/Wk?sheet=sid1"), {
      kind: "wiki",
      token: "Wk",
      sheetId: "sid1",
    });
  });

  await it("parseDocUrl 认其他租户前缀和 lark 域名", () => {
    eq(parseDocUrl("acme.feishu.cn/docx/T1").kind, "docx", "租户子域 + 无协议头");
    eq(parseDocUrl("https://acme.larksuite.com/docx/T2").kind, "docx", "国际版");
    eq((parseDocUrl("https://x.feishu.cn/docx/T3?from=chat#frag") as any).token, "T3", "query 和 hash 不能干扰");
  });

  // 认不出时返回的是 {kind:"unknown", reason}，成功时是 {kind, token} —— 断言只要那一半
  const why = (u: string) => (parseDocUrl(u) as { reason?: string }).reason ?? "";

  await it("parseDocUrl 对认不出的东西给可读理由，而不是抛", () => {
    ok(why("https://example.com/docx/T1").includes("不是飞书文档"), "外站域名");
    ok(why("https://x.feishu.cn/file/F1").includes("/file/"), "云空间文件应给具体理由");
    ok(why("https://x.feishu.cn/docx/").includes("没有文档 token"), "缺 token");
    ok(why("").includes("没有给链接"), "空串");
  });

  await it("state 签名能过，篡改/换密钥/过期都过不了", async () => {
    const secret = "s3cret";
    const st = { chatId: "oc_1", openId: "ou_1", nonce: "n", issuedAt: Date.now() };
    const raw = await signState(st, secret);

    eq((await verifyState(raw, secret))?.chatId, "oc_1");
    eq(await verifyState(raw, "wrong"), null, "换密钥");
    eq(await verifyState(raw.slice(0, -2) + "zz", secret), null, "改签名");
    eq(await verifyState("nodot", secret), null, "格式不对");
    eq(await verifyState((await signState({ ...st, issuedAt: Date.now() - 20 * 60_000 }, secret)), secret), null, "过期 20 分钟");
  });

  await it("签名 wire format 和中转（node:crypto）对得上", async () => {
    // ⚠️ 这条是**跨仓库**的守门测试。state 的签名在两处各实现了一遍
    // （本仓库用 WebCrypto，cf-agent-lab 的中转用 node:crypto），
    // 只要有一边的 base64url 填充或 HMAC 参数不同，整条授权链路就会静默
    // 断在「链接无效」上 —— 而那个报错完全指不出是这里。
    //
    // 下面这串是**真的**用本仓库 signState 签出来的，密钥 test-secret-abc。
    // 中转侧的 verify 用同一对输入验过（见交付说明里的实测记录）。
    const RAW =
      "eyJjaGF0SWQiOiJvY19hYmMxMjMiLCJvcGVuSWQiOiJvdV94eXo3ODkiLCJub25jZSI6Im4xIiwiaXNzdWVkQXQiOjE3NTg2MDAwMDAwMDB9" +
      ".wsYFQ-kzm6QBTIzUQtOnSNYBcNeyvTFivOsqxkG4ubE";
    // issuedAt 是固定的过去时刻，所以拿它验会过期 —— 这里只验签名部分能否解出内容：
    // 重新签一次同样的 payload，确认签名可复现
    const again = await signState(
      { chatId: "oc_abc123", openId: "ou_xyz789", nonce: "n1", issuedAt: 1758600000000 },
      "test-secret-abc",
    );
    eq(again, RAW, "同样的输入必须签出同样的串（签名可复现，否则中转验不过）");
    ok(!again.includes("="), "base64url 不能带填充 —— node 的 digest('base64url') 也不带");
  });

  await it("scope 里必须有 offline_access", () => {
    // 少了它响应里**根本没有 refresh_token 字段**，用户每两小时要重新授权一次。
    // 这是整件事最容易漏、也最难在测试环境发现的一条
    ok(DOC_SCOPES.includes("offline_access"), "offline_access 是拿 refresh_token 的前提");
    for (const s of ["docx:document:readonly", "wiki:wiki:readonly", "bitable:app:readonly", "sheets:spreadsheet:readonly"]) {
      ok(DOC_SCOPES.includes(s), `缺 scope：${s}`);
    }
  });

  await it("授权链接的各个参数都对", () => {
    const url = buildAuthorizeUrl(
      {
        FEISHU_APP_ID: "cli_x",
        FEISHU_APP_SECRET: "s",
        FEISHU_OAUTH_REDIRECT_URI: "https://agent.example/api/feishu/oauth",
      },
      "STATE.VAL",
    );
    const u = new URL(url);
    eq(u.host, "accounts.feishu.cn", "授权页在 accounts 域名，不在 open.feishu.cn");
    eq(u.pathname, "/open-apis/authen/v1/authorize");
    eq(u.searchParams.get("client_id"), "cli_x");
    eq(u.searchParams.get("response_type"), "code");
    eq(u.searchParams.get("redirect_uri"), "https://agent.example/api/feishu/oauth");
    eq(u.searchParams.get("state"), "STATE.VAL");
    // scope 用空格分隔，URL 里编码成 %20（不是 +）
    ok(url.includes("%20"), "scope 之间应是 %20");
    ok(u.searchParams.get("scope")!.includes("offline_access"));
  });

  await it("没配 redirect_uri 时明确报错，而不是给个默认值", () => {
    // 默认值是错的概率极高（必须和飞书后台登记的完全一致），
    // 猜一个的话用户看到的是飞书的一个报错页，完全不知道原因
    let threw = "";
    try {
      redirectUri({ FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s" });
    } catch (e) {
      threw = (e as Error).message;
    }
    ok(threw.includes("FEISHU_OAUTH_REDIRECT_URI"), threw);
  });

  await it("tokenFresh 的提前量可以被放大（为了能手工验续期）", () => {
    const t = { accessToken: "a", refreshToken: "r", exp: Date.now() + 10 * 60_000, refreshExp: 0, openId: "", scope: "" };
    ok(tokenFresh(t), "10 分钟后过期，默认提前 5 分钟，算新鲜");
    ok(!tokenFresh(t, Date.now(), 60 * 60_000), "提前量放大到 1 小时就判过期 —— 续期链路这下能在一次调用里验到");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// I. 用户令牌管理器
// ═══════════════════════════════════════════════════════════════════════

await describe("I. 用户令牌管理器", async () => {
  const ENV = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s" };
  const NOW = Date.now();

  const tok = (over: Record<string, unknown> = {}) => ({
    accessToken: "at-old",
    refreshToken: "rt-old",
    exp: NOW + 3600_000,
    refreshExp: NOW + 30 * 86400_000,
    openId: "ou_1",
    scope: "docx:document:readonly",
    ...over,
  });

  /** 可外部改写的令牌槽。让测试能从 fetch 桩里同步地模拟「别的实例刚写回」 */
  const slot = (initial: ReturnType<typeof tok> | null) => {
    const box: { cur: any; writes: any[] } = { cur: initial, writes: [] };
    const store: UserTokenStore = {
      get: async () => box.cur,
      set: async (v) => {
        box.cur = v;
        box.writes.push(v);
      },
      clear: async () => {
        box.cur = null;
        box.writes.push(null);
      },
    };
    return { box, store };
  };

  const tokenReply = (over: Record<string, unknown> = {}) =>
    new Response(
      JSON.stringify({
        access_token: "at-new",
        refresh_token: "rt-new",
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
        scope: "docx:document:readonly",
        ...over,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  await it("没记录过 → needAuth，且不发任何请求", async () => {
    const { store } = slot(null);
    const calls = stubFetch(() => undefined);
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    const r = await mgr.accessToken();
    ok("needAuth" in r, "应返回 needAuth");
    eq(calls.length, 0, "不该发请求");
  });

  await it("令牌还新鲜 → 直接用，不发续期请求", async () => {
    const { store } = slot(tok());
    const calls = stubFetch(() => undefined);
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    eq(await mgr.accessToken(), { token: "at-old" });
    eq(calls.length, 0, "这个也要发请求的话，每次工具调用都白跑一次网络");
  });

  await it("过期 → 续期一次并把新令牌落盘", async () => {
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    const calls = stubFetch((url) => (url.includes("/oauth/v3/token") ? tokenReply() : undefined));
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    eq(await mgr.accessToken(), { token: "at-new" });
    eq(calls.length, 1);
    eq(box.cur.accessToken, "at-new", "必须落盘，否则每个回合都要续一次");
    ok(decodeURIComponent(calls[0].init.body).includes("grant_type=refresh_token"), "走的是 refresh_token 授权");
  });

  await it("响应没带 refresh_token 时保留旧的（最要命的一条）", async () => {
    // 飞书续期时轮换 refresh_token，但不保证每次都回传新值。照着响应整个覆盖
    // 的话，一次没带就写成空串 —— 而那是唯一的长效凭据。表现是「用着用着
    // 突然要重新授权」，重新授权一次又能好一阵，极难归因
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    stubFetch((url) =>
      url.includes("/oauth/v3/token") ? tokenReply({ refresh_token: undefined }) : undefined,
    );
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    await mgr.accessToken();
    eq(box.cur.refreshToken, "rt-old", "旧的 refresh_token 必须留下来");
  });

  await it("响应带了新的 refresh_token 时用新的", async () => {
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    stubFetch((url) => (url.includes("/oauth/v3/token") ? tokenReply() : undefined));
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    await mgr.accessToken();
    eq(box.cur.refreshToken, "rt-new");
  });

  await it("并发取令牌只续一次（单飞）", async () => {
    // 一轮工具循环里模型可能连着调三四个文档工具，它们同时发现令牌过期。
    // 没有单飞就是三四次并发续期，而每次续期都轮换 refresh_token ——
    // 后到的那些拿一个已作废的令牌，全部失败，用户看到「刚授权完就说失效」
    const { store } = slot(tok({ exp: NOW - 1000 }));
    const calls = stubFetch((url) => (url.includes("/oauth/v3/token") ? tokenReply() : undefined));
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });

    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => mgr.accessToken()));
    eq(calls.length, 1, "五次并发只该发一次续期请求");
    for (const r of rs) eq(r, { token: "at-new" });
  });

  await it("续期失败先重读一次（另一个实例可能刚轮换过）", async () => {
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    let n = 0;
    const calls = stubFetch((url) => {
      if (!url.includes("/oauth/v3/token")) return undefined;
      n++;
      if (n === 1) {
        // 模拟：我们手上的 rt-old 已被作废，但另一台实例刚写回了 rt-fresh
        box.cur = tok({ accessToken: "at-x", refreshToken: "rt-fresh", exp: NOW - 1000 });
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return tokenReply({ refresh_token: "rt-3" });
    });
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    eq(await mgr.accessToken(), { token: "at-new" });
    eq(calls.length, 2, "第二次用的是重读回来的 rt-fresh");
    ok(decodeURIComponent(calls[1].init.body).includes("rt-fresh"), "重试要用新读到的令牌");
  });

  await it("续期怎么都不行 → 清掉坏记录并要重新授权", async () => {
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    stubFetch((url) =>
      url.includes("/oauth/v3/token")
        ? new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    const r = await mgr.accessToken();
    ok("needAuth" in r, "应要重新授权");
    eq(box.cur, null, "坏的记录要清掉，否则下次又拿它去撞同一堵墙");
  });

  await it("没有 refresh_token 且已过期 → 直接要重新授权", async () => {
    const { store } = slot(tok({ exp: NOW - 1000, refreshToken: "" }));
    const calls = stubFetch(() => undefined);
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    const r = await mgr.accessToken();
    ok("needAuth" in r && r.reason.includes("offline_access"), JSON.stringify(r));
    eq(calls.length, 0, "没得续就别发请求");
  });

  await it("peek 只看不续，forget 清干净", async () => {
    const { box, store } = slot(tok({ exp: NOW - 1000 }));
    const calls = stubFetch(() => undefined);
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    eq((await mgr.peek())?.accessToken, "at-old");
    eq(calls.length, 0, "peek 是给 /status 用的，不能有副作用");
    eq(await mgr.forget(), true);
    eq(await mgr.peek(), null);
    eq(box.cur, null);
    eq(await mgr.forget(), false, "第二次说「本来就没有」");
  });

  await it("invalidate 之后下次取会强制续期", async () => {
    // 99991663 用得上：令牌被用户在飞书侧撤销时 exp 还没到，看时间是发现不了的
    const { store } = slot(tok());
    const calls = stubFetch((url) => (url.includes("/oauth/v3/token") ? tokenReply() : undefined));
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    await mgr.invalidate();
    eq(await mgr.accessToken(), { token: "at-new" });
    eq(calls.length, 1);
  });

  await it("skewMs 放大后新鲜令牌也会被判过期", async () => {
    const { store } = slot(tok());
    const calls = stubFetch((url) => (url.includes("/oauth/v3/token") ? tokenReply() : undefined));
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1", skewMs: 7200_000 });
    eq(await mgr.accessToken(), { token: "at-new" });
    eq(calls.length, 1, "提前量 2 小时 > 剩余 1 小时，所以要续期");
  });

  await it("不同 openId 用不同的槽（群聊里各授权各的）", async () => {
    const kv = new TokenKv();
    await makeUserTokenStore(kv, "ou_A").set(tok({ accessToken: "at-A" }));
    await makeUserTokenStore(kv, "ou_B").set(tok({ accessToken: "at-B" }));

    const a = new UserTokenManager({ store: makeUserTokenStore(kv, "ou_A"), env: ENV, openId: "ou_A" });
    const b = new UserTokenManager({ store: makeUserTokenStore(kv, "ou_B"), env: ENV, openId: "ou_B" });
    eq((await a.peek())?.accessToken, "at-A");
    eq((await b.peek())?.accessToken, "at-B");
    // A 退出不该影响 B
    await a.forget();
    eq(await a.peek(), null);
    eq((await b.peek())?.accessToken, "at-B", "共用一个槽的话，群里最后授权的人会把自己的权限出借给全群");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// J. 云文档工具族
// ═══════════════════════════════════════════════════════════════════════

await describe("J. 云文档工具族", async () => {
  const ENV = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s" };

  const DOC_TEXT = "第一段。".repeat(5) + "第二段内容。".repeat(5);

  /** 三个工具共用的假飞书。按 URL 片段路由 */
  const docStub = (url: string): Response | undefined => {
    const json = (v: unknown) =>
      new Response(JSON.stringify({ code: 0, ...(v as object) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/docx/v1/documents/DOC1/raw_content")) return json({ data: { content: DOC_TEXT } });
    if (url.includes("/docx/v1/documents/DOC1")) return json({ data: { document: { title: "设计文档" } } });

    // wiki 节点：node token 是 WKBT，底层其实是多维表格 BT1
    if (url.includes("/wiki/v2/spaces/get_node") && url.includes("WKBT")) {
      return json({ data: { node: { obj_token: "BT1", obj_type: "bitable" } } });
    }
    // wiki 节点：node token 是 WKNODE，底层其实是 DOC1
    if (url.includes("/wiki/v2/spaces/get_node")) return json({ data: { node: { obj_token: "DOC1", obj_type: "docx" } } });

    if (url.includes("/sheets/v3/spreadsheets/SH1/sheets/query")) {
      return json({ data: { sheets: [{ sheet_id: "sid1", title: "Sheet1", grid_properties: { row_count: 3, column_count: 2 } }] } });
    }
    if (url.includes("/sheets/v2/spreadsheets/SH1/values/")) {
      return json({
        data: {
          valueRange: {
            range: "sid1!A1:B3",
            values: [
              ["名称", "数量"],
              ["甲", 1],
              ["乙", [{ text: "带链接", link: "https://x" }]],
            ],
          },
        },
      });
    }

    // SH2 模仿飞书**真实**的响应形状：整个网格都回、空行补到窗口满
    // （新建表 grid_properties 就是 200 行 × 20 列）。SH1 那种「只回有内容的
    // 三行」是理想化的，实测不会发生 —— 正因如此 SH1 掩盖了这个 bug。
    if (url.includes("/sheets/v3/spreadsheets/SH2/sheets/query")) {
      return json({
        data: {
          sheets: [
            { sheet_id: "sid2", title: "Sheet1", grid_properties: { row_count: 200, column_count: 20 } },
          ],
        },
      });
    }
    if (url.includes("/sheets/v2/spreadsheets/SH2/values/")) {
      return json({
        data: {
          valueRange: {
            range: "sid2!A1:T100",
            values: [
              ["城市", "销量", "负责人"],
              ["杭州", 1280, "张三"],
              ["哈尔滨", 77, "李四"],
              ["乌鲁木齐", 9, "王五"],
              ...Array.from({ length: 96 }, () => Array<string>(20).fill("")),
            ],
          },
        },
      });
    }

    if (url.includes("/bitable/v1/apps/BT1/tables?") || url.endsWith("/bitable/v1/apps/BT1/tables")) {
      return json({ data: { items: [{ table_id: "tbl1", name: "任务表" }, { table_id: "tbl2", name: "人表" }] } });
    }
    // 实测存在「链接里的 table 参数不是 OpenAPI 的 table_id」这种情况：
    // 从地址栏拷的链接、表格停在「页面」侧栏时，那个值是另一套 id
    if (url.includes("/bitable/v1/apps/BT1/tables/notatable/records")) {
      return new Response(JSON.stringify({ code: 1254005, msg: "TableIdNotFound" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/bitable/v1/apps/BT1/tables/tbl1/records")) {
      return json({
        data: {
          items: [
            { record_id: "rec1", fields: { 任务: [{ text: "写文档" }], 负责人: [{ name: "张三" }], 完成: true } },
            { record_id: "rec2", fields: { 任务: "读代码", 负责人: [], 完成: false } },
          ],
          has_more: true,
        },
      });
    }
    return undefined;
  };

  /** 建一套「已授权」的工具 */
  const tools = async (skewMs?: number) => {
    const kv = new TokenKv();
    const store = makeUserTokenStore(kv, "ou_1");
    await store.set({
      accessToken: "at-1",
      refreshToken: "rt-1",
      exp: Date.now() + 3600_000,
      refreshExp: Date.now() + 86400_000,
      openId: "ou_1",
      scope: "",
    });
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1", skewMs });
    const list = makeFeishuDocTools({ env: ENV, tokens: mgr }) as any[];
    return Object.fromEntries(list.map((t) => [t.name, t]));
  };

  await it("三个工具都注册了，名字是 feishu_ 前缀", async () => {
    const t = await tools();
    eq(Object.keys(t).sort(), ["feishu_bitable_read", "feishu_doc_read", "feishu_sheet_read"]);
  });

  await it("读 docx：返回标题、正文、字数", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/docx/DOC1" });
    eq(r.title, "设计文档");
    eq(r.content, DOC_TEXT);
    eq(r.totalChars, DOC_TEXT.length);
    eq(r.truncated, false);
  });

  await it("读 docx：截断时给 nextOffset，且翻页不再重新拉一次全文", async () => {
    const t = await tools();
    const calls = stubFetch(docStub);
    const r1 = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/docx/DOC1", limit: 10 });
    eq(r1.truncated, true);
    eq(r1.content, DOC_TEXT.slice(0, 10));
    eq(r1.nextOffset, 10);
    ok(r1.note.includes(String(DOC_TEXT.length)), "截断提示里要说全文多少字");

    const before = calls.length;
    const r2 = await callTool(t.feishu_doc_read, {
      url: "https://x.feishu.cn/docx/DOC1",
      offset: r1.nextOffset,
      limit: 10,
    });
    eq(r2.content, DOC_TEXT.slice(10, 20));
    eq(calls.length, before, "翻页不该重新拉全文 —— 那正是缓存存在的理由");
  });

  await it("读 wiki 链接：先解节点，再用 obj_token 读正文", async () => {
    const t = await tools();
    const calls = stubFetch(docStub);
    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/wiki/WKNODE" });
    eq(r.content, DOC_TEXT);

    const node = calls.find((c) => c.url.includes("get_node"));
    ok(node, "必须调 get_node 解引用");
    ok(node!.url.includes("obj_type=wiki"), "要带 obj_type=wiki");
    // ⚠️ 最容易发的一处错：拿节点 token 去读正文，于是所有 wiki 链接都「找不到文档」
    ok(calls.some((c) => c.url.includes("/docx/v1/documents/DOC1/raw_content")), "正文必须用 obj_token(DOC1)，不是节点 token");
    ok(!calls.some((c) => c.url.includes("/documents/WKNODE/")), "不能用节点 token 当文档 token");
  });

  await it("类型对不上时给出「该换哪个工具」的提示", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/sheets/SH1" });
    ok(r.error.includes("feishu_sheet_read"), r.error);
  });

  await it("读电子表格：拿到 sheet 名、行列数和拍平后的文本", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_sheet_read, { url: "https://x.feishu.cn/sheets/SH1" });
    eq(r.sheet, "Sheet1");
    eq(r.rowCount, 3);
    eq(r.colCount, 2);
    ok(r.text.includes("名称\t数量"), r.text);
    ok(r.text.includes("甲\t1"), r.text);
    // 单元格是对象（富文本带链接）时要拍平成文本，不能把 JSON 倒给模型
    ok(r.text.includes("带链接"), r.text);
    ok(!r.text.includes("file_token"), "不该出现原始 JSON 字段");
  });

  // 回归：飞书把整个网格补空行回给你是**常态**，据此报 truncated 会让模型反复重读
  // （实测一个 4 行数据的表被它连读了 8 次）。尾部空行还必须剪掉，不然白烧上下文。
  await it("电子表格：尾部空行要剪掉，且不能因此误报 truncated", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_sheet_read, { url: "https://x.feishu.cn/sheets/SH2" });
    eq(r.rowCount, 4, "96 行补位空行应被剪掉");
    eq(r.colCount, 3, "17 列补位空列应被剪掉");
    eq(r.truncated, false, "内容没顶到窗口边缘，不该报「只读了一部分」");
    eq(r.note, undefined, "不截断就不该带催促模型重读的提示");
    eq(r.totalRows, 200, "网格大小仍要如实报出来，别瞒着模型");
    ok(r.text.includes("哈尔滨\t77\t李四"), r.text);
    ok(!r.text.includes("\t\t\t\t"), "剪完不该还剩一串空列");
  });

  await it("电子表格：内容顶到窗口边缘时才报 truncated", async () => {
    const t = await tools();
    // 窗口 100 行全是有内容的行 —— 后面可能还有，这时候必须提醒
    stubFetch((url) => {
      if (url.includes("/sheets/v3/spreadsheets/SH3/sheets/query")) {
        return new Response(
          JSON.stringify({ code: 0, data: { sheets: [{ sheet_id: "sid3", title: "S", grid_properties: { row_count: 200, column_count: 2 } }] } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/sheets/v2/spreadsheets/SH3/values/")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              valueRange: {
                values: Array.from({ length: 100 }, (_, i) => [`行${i}`, i]),
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return undefined;
    });
    const r = await callTool(t.feishu_sheet_read, { url: "https://x.feishu.cn/sheets/SH3" });
    eq(r.rowCount, 100);
    eq(r.truncated, true);
    ok(typeof r.note === "string" && r.note.includes("顶到上限"), r.note);
  });

  await it("多维表格：不给 table_id 先列表", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, { url: "https://x.feishu.cn/base/BT1" });
    eq(r.tableList.length, 2);
    eq(r.tableList[0], { table_id: "tbl1", name: "任务表" });
    eq(r.records, undefined, "这一步还不该返回记录");
  });

  await it("多维表格：给了 table_id 读记录，字段值拍平成文本", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, { url: "https://x.feishu.cn/base/BT1", table_id: "tbl1" });
    eq(r.count, 2);
    eq(r.hasMore, true);
    eq(r.records[0].fields["任务"], "写文档", "富文本数组应拍平");
    eq(r.records[0].fields["负责人"], "张三", "人员字段应取 name");
    eq(r.records[0].fields["完成"], "true");
    eq(r.records[1].fields["任务"], "读代码");
  });

  await it("链接里带了 ?table= 就直接用，不再多余问一次", async () => {
    const t = await tools();
    const calls = stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, {
      url: "https://x.feishu.cn/base/BT1?table=tbl1",
    });
    eq(r.count, 2, "应直接读到记录");
    ok(!calls.some((c) => c.url.includes("/tables?page_size")), "不该再去列一次数据表");
  });

  await it("wiki 形态的多维表格链接：解引用之后也要带上 ?table=", async () => {
    const t = await tools();
    const calls = stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, {
      url: "https://x.feishu.cn/wiki/WKBT?table=tbl1&view=v1",
    });
    eq(r.count, 2, "wiki 解出是 bitable，就该直接读到记录");
    eq(r.records[0].fields["任务"], "写文档");
    // 新建的多维表格默认落在知识库，所以这条不是边缘场景 —— 少了它每次都白跑一轮
    ok(!calls.some((c) => c.url.includes("/tables?page_size")), "不该再去列一次数据表");
  });

  await it("链接里的 table 参数不可用：退回列表，而不是把报错丢给模型", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, {
      url: "https://x.feishu.cn/wiki/WKBT?table=notatable",
    });
    eq(r.tableList?.length, 2, "应退回「先列出有哪些数据表」");
    eq(r.records, undefined);
    eq(r.error, undefined, "能兜住就别报错");
  });

  await it("模型自己给的 table_id 写错了就照实报错，不兜底", async () => {
    const t = await tools();
    stubFetch(docStub);
    const r = await callTool(t.feishu_bitable_read, {
      url: "https://x.feishu.cn/base/BT1",
      table_id: "notatable",
    });
    ok(typeof r.error === "string" && r.error.length > 0, "该让它看见错误，而不是偷偷换成别的表");
  });

  await it("没授权时给的是「发 /login」的可执行提示，而且不发任何请求", async () => {
    const kv = new TokenKv();
    const mgr = new UserTokenManager({
      store: makeUserTokenStore(kv, "ou_new"),
      env: ENV,
      openId: "ou_new",
    });
    const t = Object.fromEntries(
      (makeFeishuDocTools({ env: ENV, tokens: mgr }) as any[]).map((x) => [x.name, x]),
    );
    const calls = stubFetch(() => undefined);

    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/docx/DOC1" });
    ok(r.error.includes("/login"), r.error);
    eq(calls.length, 0, "没授权就别浪费一次网络往返");
  });

  await it("令牌失效(99991663) → 续期后自动重试一次", async () => {
    const kv = new TokenKv();
    const store = makeUserTokenStore(kv, "ou_1");
    await store.set({
      accessToken: "at-stale",
      refreshToken: "rt-1",
      exp: Date.now() + 3600_000,
      refreshExp: Date.now() + 86400_000,
      openId: "ou_1",
      scope: "",
    });
    const mgr = new UserTokenManager({ store, env: ENV, openId: "ou_1" });
    const t = Object.fromEntries(
      (makeFeishuDocTools({ env: ENV, tokens: mgr }) as any[]).map((x) => [x.name, x]),
    );

    let docCalls = 0;
    const calls = stubFetch((url) => {
      if (url.includes("/oauth/v3/token")) {
        return new Response(
          JSON.stringify({ access_token: "at-fresh", refresh_token: "rt-2", expires_in: 7200 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/raw_content")) {
        docCalls++;
        // 第一次说令牌无效 —— 模拟用户在飞书侧撤销了授权（exp 还没到）
        if (docCalls === 1) {
          return new Response(JSON.stringify({ code: 99991663, msg: "token invalid" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ code: 0, data: { content: "正文" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return docStub(url);
    });

    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/docx/DOC1" });
    eq(r.content, "正文", "应重试成功");
    eq(docCalls, 2, "该重试恰好一次");
    ok(calls.some((c) => c.url.includes("/oauth/v3/token")), "重试前要先续期");
    // 重试用的是新令牌
    const retry = calls.filter((c) => c.url.includes("/raw_content"))[1];
    eq(retry.init.headers.authorization, "Bearer at-fresh");
  });

  await it("网络抛错时返回 { error }，不把异常抛出去", async () => {
    // 工具抛错会中断整个工具循环 —— 契约是永不抛
    // （实现上靠 `src/shared/util.ts` 的 `guarded()` 兜住）
    const t = await tools();
    stubFetch(() => {
      throw new Error("网络炸了");
    });
    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/docx/DOC1" });
    ok(r.error.includes("工具执行失败"), r.error);
    ok(r.error.includes("网络炸了"), r.error);
  });

  await it("认不出的链接走到工具时也是 { error }，不是空转", async () => {
    const t = await tools();
    stubFetch(() => undefined); // 不该有请求
    const r = await callTool(t.feishu_doc_read, { url: "https://x.feishu.cn/slides/S1" });
    ok(typeof r.error === "string" && r.error.length > 0, JSON.stringify(r));
  });
});

// ── 会话历史消毒（session-sanitize）────────────────────────────────────
//
// 这一组守的是「会话被永久毒死」那个坑：窗口从 tool_calls 对中间切开后，
// 开头会剩下孤儿 tool 消息，网关稳定 400，只有 /clear 能救。
// 消毒函数是纯函数，所以能在这里把各种切歪的情况钉死。

// 没有 group 辅助函数，用一个注释段代替（和文件里其它分组一致）
{
  const A = (id?: string, content = ""): any =>
    id
      ? { role: "assistant", content, tool_calls: [{ id, type: "function", function: { name: "t", arguments: "{}" } }] }
      : { role: "assistant", content };
  const T = (id: string): any => ({ role: "tool", tool_call_id: id, content: "结果" });
  const U = (text: string): any => ({ role: "user", content: text });
  const S: any = { role: "system", content: "你是助手" };

  await it("正常序列原样保留，一条都不丢", async () => {
    const input = [S, U("问"), A("c1"), T("c1"), A(undefined, "答")];
    const r = sanitizeHistory(input);
    eq(r.items.length, 5, JSON.stringify(r));
    eq(r.droppedOrphanTools, 0);
    eq(r.droppedEmptyAssistants, 0);
  });

  await it("⚠️ 开头就是孤儿 tool（窗口切歪的典型症状）→ 丢掉", async () => {
    // 这就是线上那个角色序列 `s t t a u ...` 的形状
    const input = [S, T("gone1"), T("gone2"), A(undefined, "答"), U("新问题")];
    const r = sanitizeHistory(input);
    eq(r.droppedOrphanTools, 2, JSON.stringify(r));
    eq(r.items.length, 3, "只剩 system / assistant / user");
    eq(r.items[0].role, "system");
    eq(r.items[1].role, "assistant");
    eq(r.items[2].role, "user");
  });

  await it("中间夹的孤儿 tool 也丢，但不影响配对的那些", async () => {
    const input = [S, A("c1"), T("c1"), T("孤儿"), A("c2"), T("c2")];
    const r = sanitizeHistory(input);
    eq(r.droppedOrphanTools, 1);
    eq(r.items.length, 5, JSON.stringify(r.items.map((i: any) => i.role)));
  });

  await it("同一个 callId 只能被消费一次（重复 tool 结果算孤儿）", async () => {
    const input = [S, A("c1"), T("c1"), T("c1")];
    const r = sanitizeHistory(input);
    eq(r.droppedOrphanTools, 1, "第二个 T(c1) 认领不到声明方");
    eq(r.items.length, 3);
  });

  await it("空 assistant（无文本无 tool_calls）丢掉", async () => {
    const input = [S, A(undefined, ""), U("问")];
    const r = sanitizeHistory(input);
    eq(r.droppedEmptyAssistants, 1, JSON.stringify(r));
    eq(r.items.length, 2);
  });

  await it("有 tool_calls 但没文本的 assistant **必须留**（不是空的）", async () => {
    const input = [S, A("c1"), T("c1")];
    const r = sanitizeHistory(input);
    eq(r.droppedEmptyAssistants, 0);
    eq(r.items.length, 3);
  });

  await it("sanitizeAndAppend：历史在前、本轮在后，顺序不变", async () => {
    const history = [S, T("orphan"), A(undefined, "旧答")];
    const out = sanitizeAndAppend(history, [U("本轮问题")]);
    eq(out.length, 3, JSON.stringify(out));
    eq(out[0].role, "system");
    eq(out[1].role, "assistant");
    eq(out[2].role, "user");
    eq((out[2] as any).content, "本轮问题");
  });

  await it("sanitizeAndAppend：丢了东西要回调（用于落诊断，别静默）", async () => {
    let reported: any = null;
    sanitizeAndAppend([S, T("orphan")], [U("问")], (d) => {
      reported = d;
    });
    ok(reported && reported.droppedOrphanTools === 1, JSON.stringify(reported));
  });

  await it("什么都没丢时不回调（避免正常回合也写 KV）", async () => {
    let called = false;
    sanitizeAndAppend([S, U("问"), A(undefined, "答")], [U("再问")], () => {
      called = true;
    });
    eq(called, false);
  });

  await it("空历史 / 只有本轮输入时不出错", async () => {
    const r = sanitizeHistory([] as any[]);
    eq(r.items.length, 0);
    const out = sanitizeAndAppend([], [U("你好")]);
    eq(out.length, 1);
    eq((out[0] as any).role, "user");
  });
}

// ═══════════════════════════════════════════════════════════════════════
// K. 跨会话记忆
// ═══════════════════════════════════════════════════════════════════════

await describe("K. 跨会话记忆", async () => {
  await it("键名规范化：空格 / 大写 / 中文 / 危险串 / 超长", () => {
    eq(normalizeMemoryKey("Tech Stack"), "tech-stack");
    // 中文保留 —— 用户是中文，键叫「技术栈」比叫 tech-stack 更好读
    eq(normalizeMemoryKey("技术栈"), "技术栈");
    // 斜杠被剥掉、连续点被压成一个 —— 杜绝 `..` 这种路径穿越形状
    eq(normalizeMemoryKey("../../etc/passwd"), "etcpasswd");
    eq(normalizeMemoryKey("a".repeat(200)).length, 64);
    eq(normalizeMemoryKey("   "), null);
    eq(normalizeMemoryKey("///"), null);
  });

  await it("项目级 / 按人的逻辑键", () => {
    eq(projectKey("技术栈"), "prefs/技术栈");
    eq(userKey("ou_x", "负责模块"), "user/ou_x/负责模块");
    // 没有 openId 就造不出按人的键 —— 调用方据此回一句「改用 project」
    eq(userKey("", "负责模块"), null);
  });

  await it("remember → entries → forget 往返", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    // 用真实形状的 openId（ou_ + 一长串），因为 by 是截尾的，短假名会掩盖截断逻辑
    const alice = "ou_9f3c2a1b7e4d";
    eq(await m.remember("prefs/技术栈", "pnpm + TypeScript", alice), "已记住 prefs/技术栈");
    // 同一个键再写是**更新**，不是新增 —— 这是「一条事实一个键」的用法
    eq(
      await m.remember("prefs/技术栈", "pnpm + TypeScript，不用 yarn", alice),
      "已更新 prefs/技术栈",
    );

    const all = await m.entries();
    eq(all.length, 1);
    eq(all[0].value, "pnpm + TypeScript，不用 yarn");
    // by 只留后 6 位：/memory 列表里够区分人，又不至于把完整 openId 摊在记忆值里
    eq(all[0].by, "1b7e4d", "by 应只留 openId 后 6 位");
    ok(all[0].by !== alice, "别把完整 openId 写进去");
    ok(typeof all[0].at === "number", "应记下写入时间");

    eq(await m.forget("prefs/技术栈"), true);
    eq(await m.forget("prefs/技术栈"), false, "删第二次应返回 false");
    eq((await m.entries()).length, 0);
  });

  await it("recall 在写入前后读数不同是**正常**的（线上踩过，别当成 bug）", async () => {
    // 线上真实序列：模型先 recall（记忆是空的 → 0 条），再 remember 两条。
    // 那时它同时看到「系统提示词末尾列着 2 条」和「工具返回 0 条」，
    // 就判定成「我的读取不稳定」，然后在飞书里当众撤回了一个正确答案。
    //
    // 结论是**代码没问题**（list 写后立即可见，实测过），纯粹是提示词末尾的
    // 清单是**本轮快照**、而 recall 是实时查询。这个测试把「合法序列」钉住，
    // 免得以后有人看到 0 → 2 的变化去改存储层。
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    const tools = makeMemoryTools(m, "ou_alice");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const r0 = await callTool(byName.recall_facts, {});
    eq(r0.total, 0, "写入前查就是 0 条 —— 这不是故障");

    await callTool(byName.remember_fact, { key: "内部代号", value: "青鸟-7" });
    await callTool(byName.remember_fact, { key: "发布分支", value: "release/2026q4" });

    const r1 = await callTool(byName.recall_facts, {});
    eq(r1.total, 2, "写入后立刻查就该看到 —— 写后读必须一致");
    eq(r1.entries.map((e: any) => e.key).sort(), ["prefs/内部代号", "prefs/发布分支"]);
  });

  await it("「一个 key 装一件事」这条规则**写在工具描述里**（线上踩过：只写在注释里等于没写）", async () => {
    // 实测 2026-09-25：这条规则原先只在 global-memory.ts 的文件头注释里，
    // 模型看不到 —— 于是它把「内部代号」和「发布分支」并成了一个 key
    // `prefs/项目代号与发布分支`，换个跑法又拆成两个，行为不稳定。
    // 并 key 的代价是丢掉「不丢更新」这个保证（写入是整值覆盖、无条件写）。
    //
    // 这个测试不验模型行为（验不了），只钉住「规则确实在模型看得见的地方」——
    // 免得以后有人重构工具描述时把它删了，重演同一个坑。
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    const tools = makeMemoryTools(m, "ou_alice");
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));

    ok(
      String(byName.remember_fact.description).includes("一个 key 只装一件事"),
      "remember_fact 的描述里要有「一个 key 只装一件事」",
    );
    // 反例也要有 —— 抽象的「别合并」不如举出实测里真被合并的那两个
    ok(
      String(byName.remember_fact.description).includes("发布分支"),
      "最好举出真实被合并过的例子（内部代号 / 发布分支），比抽象说法有效",
    );
    ok(
      String(byName.remember_fact.parameters?.properties?.key?.description ?? "").includes("一件事一个 key"),
      "key 的字段说明里也要带一遍（模型读字段说明比读整段描述更细）",
    );
  });

  await it("recall_facts 支持按前缀过滤", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    const tools = makeMemoryTools(m, "ou_alice");
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await callTool(byName.remember_fact, { key: "技术栈", value: "pnpm" });
    await callTool(byName.remember_fact, { key: "负责模块", value: "auth", scope: "user" });

    const proj = await callTool(byName.recall_facts, { prefix: "prefs/" });
    eq(proj.total, 1);
    eq(proj.entries[0].key, "prefs/技术栈");
    const mine = await callTool(byName.recall_facts, { prefix: "user/" });
    eq(mine.total, 1);
    eq(mine.entries[0].key, "user/ou_alice/负责模块");
  });

  await it("空值 / 超长值被拒绝，且不落盘", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    ok((await m.remember("prefs/a", "   ", "ou_x")).includes("value 是空的"));
    ok((await m.remember("prefs/b", "x".repeat(MAX_VALUE_CHARS + 1), "ou_x")).includes("超过单条上限"));
    eq((await m.entries()).length, 0);
  });

  await it("记满 MAX_ENTRIES 后拒绝新键，但更新旧键仍然可以", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    for (let i = 0; i < MAX_ENTRIES; i++) await m.remember(`prefs/k${i}`, "v", "ou_x");

    ok((await m.remember("prefs/新键", "v", "ou_x")).includes("已经记满"));
    // ⚠️ 更新已有键必须不受上限影响 —— 否则记满之后连改错都改不了
    eq(await m.remember("prefs/k0", "改过", "ou_x"), "已更新 prefs/k0");
  });

  await it("渲染只显示提问人自己的按人记忆", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    await m.remember("prefs/技术栈", "pnpm", "ou_alice");
    await m.remember("user/ou_alice/负责模块", "auth", "ou_alice");
    await m.remember("user/ou_bob/负责模块", "支付", "ou_bob");

    const forAlice = await m.renderForPrompt("ou_alice");
    ok(forAlice.includes("prefs/技术栈"), "项目级应可见");
    ok(forAlice.includes("user/ou_alice/负责模块"), "自己的按人记忆应可见");
    ok(!forAlice.includes("支付"), "别人的按人记忆不该出现");

    // 第三个人：项目级能看，两份按人的都看不到
    const forCarol = await m.renderForPrompt("ou_carol");
    ok(forCarol.includes("prefs/技术栈"));
    ok(!forCarol.includes("auth"));
    ok(!forCarol.includes("支付"));
  });

  await it("渲染预算：条数超了就截断并说明还有多少", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    for (let i = 0; i < 40; i++) {
      await m.remember(`prefs/k${String(i).padStart(2, "0")}`, "v", "ou_x");
    }
    const s = await m.renderForPrompt("ou_x");
    ok(s.includes("共 40 条"), s.slice(0, 300));
    ok(s.includes("只显示了 30 条"), "应说明被截断，否则模型以为自己看到了全部");
  });

  await it("空记忆时给出「可以记什么」的指引，而不是一片空白", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    const s = await m.renderForPrompt("ou_x");
    ok(s.includes("还是空的"));
    ok(s.includes("remember_fact"), "要告诉模型有这个工具，否则它不会想到去用");
  });

  await it("forgetLoose：人不带 prefs/ 前缀也能删掉", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    await m.remember("prefs/技术栈", "pnpm", "ou_x");
    // 用户会打「技术栈」而不是「prefs/技术栈」
    eq(await m.forgetLoose("技术栈", "ou_x"), "prefs/技术栈");
    eq(await m.forgetLoose("技术栈", "ou_x"), null, "删第二次应找不到");
  });

  await it("forgetAll 只清项目级 + 自己的，不碰别人的", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    await m.remember("prefs/a", "1", "ou_alice");
    await m.remember("user/ou_alice/b", "2", "ou_alice");
    await m.remember("user/ou_bob/c", "3", "ou_bob");

    eq(await m.forgetAll("ou_alice"), 2);
    const left = await m.entries();
    eq(left.length, 1);
    eq(left[0].key, "user/ou_bob/c");
  });

  await it("裸文本（不是信封）也能读出来，不抛", async () => {
    // 手工往 Blob 里写一行、或者以后信封格式改了，都不该让整段记忆消失
    const be = new InMemoryMemoryBackend();
    await be.put("prefs/raw", "手写进去的一行");
    const m = new GlobalMemory(be);
    const all = await m.entries();
    eq(all.length, 1);
    eq(all[0].value, "手写进去的一行");
  });

  await it("单条读失败不影响其余条目", async () => {
    const be = new InMemoryMemoryBackend();
    await be.put("prefs/good", JSON.stringify({ v: "好的一条" }));
    await be.put("prefs/bad", JSON.stringify({ v: "坏的" }));
    // 让某一条的 read 抛错
    const orig = be.read.bind(be);
    be.read = async (k: string) => {
      if (k === "prefs/bad") throw new Error("这一条读挂了");
      return orig(k);
    };
    const m = new GlobalMemory(be);
    const all = await m.entries();
    eq(all.length, 1);
    eq(all[0].key, "prefs/good");
  });

  await it("renderMemoryList：别人的按人记忆只报条数，不显示内容", async () => {
    const m = new GlobalMemory(new InMemoryMemoryBackend());
    await m.remember("prefs/a", "1", "ou_alice");
    await m.remember("user/ou_bob/c", "别人的秘密", "ou_bob");
    const s = await renderMemoryList(m, "ou_alice");
    ok(s.includes("prefs/a"));
    ok(!s.includes("别人的秘密"), "群聊里显示别人的个人记忆是越界");
    ok(s.includes("另有 1 条"));
  });

  await it("拿不到记忆后端时 renderMemoryList 直说，而不是假装空", async () => {
    const s = await renderMemoryList(null, "ou_x");
    ok(s.includes("接不上"), s);
  });

  await it("memoryBackendStatus：能指出「记忆为什么不见了」", () => {
    const g = globalThis as any;
    const saved = g.__EDGEONE_AGENT_RUNTIME__;
    const savedPid = process.env.PAGES_PROJECT_ID;
    const savedPid2 = process.env.ProjectId;
    const savedPid3 = process.env.EDGEONE_PROJECT_ID;

    try {
      // 病一：运行时没暴露 getStore（本地裸 Node / 平台改了 API）
      delete g.__EDGEONE_AGENT_RUNTIME__;
      const noRt = memoryBackendStatus({ PAGES_PROJECT_ID: "makers-x" });
      eq(noRt.available, false);
      // ⚠️ 就算 projectId 有，运行时不在也得说不可用 —— 否则诊断会把病因指错
      ok(noRt.reason!.includes("getStore"), noRt.reason!);

      g.__EDGEONE_AGENT_RUNTIME__ = { getStore: () => ({}) };
      delete process.env.PAGES_PROJECT_ID;
      delete process.env.ProjectId;
      delete process.env.EDGEONE_PROJECT_ID;

      // 病二：拿不到 projectId
      const noPid = memoryBackendStatus({});
      eq(noPid.available, false);
      ok(noPid.reason!.includes("projectId"), noPid.reason!);

      const okSt = memoryBackendStatus({ PAGES_PROJECT_ID: "makers-abc" });
      eq(okSt.available, true);
      eq(okSt.namespace, "agent-memory-makers-abc");
      eq(okSt.projectIdFrom, "env.PAGES_PROJECT_ID", "诊断要能说清是哪个变量生效了");

      // ⚠️ process.env 里也要兜 —— 实测 agents 运行时把 Blob 凭证注入在
      // process.env，只查 context.env 有整个功能静默失效的风险
      process.env.ProjectId = "makers-fromproc";
      const fromProc = memoryBackendStatus({});
      eq(fromProc.namespace, "agent-memory-makers-fromproc");
      eq(fromProc.projectIdFrom, "process.env.ProjectId");
      delete process.env.ProjectId;

      // 两处都有时 env 赢（控制台配的项目变量该覆盖进程环境）
      process.env.PAGES_PROJECT_ID = "makers-proc";
      eq(memoryBackendStatus({ PAGES_PROJECT_ID: "makers-env" }).namespace, "agent-memory-makers-env");

      // 显式覆盖优先于一切
      const over = memoryBackendStatus({ PAGES_PROJECT_ID: "makers-env", AGENT_MEMORY_NAMESPACE: "x" });
      eq(over.namespace, "x");
      eq(over.projectIdFrom, "AGENT_MEMORY_NAMESPACE");
    } finally {
      if (savedPid !== undefined) process.env.PAGES_PROJECT_ID = savedPid;
      else delete process.env.PAGES_PROJECT_ID;
      if (savedPid2 !== undefined) process.env.ProjectId = savedPid2;
      else delete process.env.ProjectId;
      if (savedPid3 !== undefined) process.env.EDGEONE_PROJECT_ID = savedPid3;
      else delete process.env.EDGEONE_PROJECT_ID;
      if (saved === undefined) delete g.__EDGEONE_AGENT_RUNTIME__;
      else g.__EDGEONE_AGENT_RUNTIME__ = saved;
    }
  });

  await it("blobMemoryBackend：运行时没暴露 getStore 时返回 null", () => {
    const g = globalThis as any;
    const saved = g.__EDGEONE_AGENT_RUNTIME__;
    delete g.__EDGEONE_AGENT_RUNTIME__;
    try {
      eq(blobMemoryBackend({ PAGES_PROJECT_ID: "makers-x" }), null);
    } finally {
      if (saved !== undefined) g.__EDGEONE_AGENT_RUNTIME__ = saved;
    }
  });

  await it("blobMemoryBackend：命名空间按 projectId 拼，可用 env 覆盖", () => {
    const g = globalThis as any;
    const saved = g.__EDGEONE_AGENT_RUNTIME__;
    const savedEnv = process.env.PAGES_PROJECT_ID;
    const savedEnv2 = process.env.ProjectId;
    const savedEnv3 = process.env.EDGEONE_PROJECT_ID;
    const names: string[] = [];

    g.__EDGEONE_AGENT_RUNTIME__ = {
      getStore: (o: any) => {
        names.push(o.name);
        return {
          get: async () => null,
          set: async () => {},
          delete: async () => {},
          list: async () => ({ blobs: [] }),
        };
      },
    };

    try {
      // 三个候选键都要清掉，否则「没有 projectId」这一条会假通过
      delete process.env.PAGES_PROJECT_ID;
      delete process.env.ProjectId;
      delete process.env.EDGEONE_PROJECT_ID;

      // 命名空间**故意和平台自己的 memory-<projectId> 分开** ——
      // 那边装着 conversations/ state/ 这些线上用户数据，不能共用一个键空间
      ok(blobMemoryBackend({ PAGES_PROJECT_ID: "makers-abc" }) !== null);
      eq(names[0], "agent-memory-makers-abc");

      blobMemoryBackend({ PAGES_PROJECT_ID: "makers-abc", AGENT_MEMORY_NAMESPACE: "custom-ns" });
      eq(names[1], "custom-ns");

      // 没有 projectId 也没有覆盖 → 拿不到，返回 null
      // （不硬编一个共享命名空间：多项目共用会串数据）
      eq(blobMemoryBackend({}), null);
    } finally {
      if (savedEnv !== undefined) process.env.PAGES_PROJECT_ID = savedEnv;
      else delete process.env.PAGES_PROJECT_ID;
      if (savedEnv2 !== undefined) process.env.ProjectId = savedEnv2;
      else delete process.env.ProjectId;
      if (savedEnv3 !== undefined) process.env.EDGEONE_PROJECT_ID = savedEnv3;
      else delete process.env.EDGEONE_PROJECT_ID;
      if (saved === undefined) delete g.__EDGEONE_AGENT_RUNTIME__;
      else g.__EDGEONE_AGENT_RUNTIME__ = saved;
    }
  });
});

// ── 收尾 ──────────────────────────────────────────────────────────────

globalThis.fetch = realFetch;

console.log("");
if (failures.length === 0) {
  console.log(`✅ 全部通过：${passed} 项`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项\n`);
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
}
