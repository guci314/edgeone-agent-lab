// 冒烟测试。不依赖 EdgeOne 平台，直接用 Node 跑。
//
//   npm test
//
// ── 为什么要有这个 ──────────────────────────────────────────────────
// `edgeone makers dev` 需要登录令牌，CI/无人环境里跑不了；而这条链路里
// 真正容易错的东西（验签顺序、去重语义、generation 制、那个 36 字符的
// conversation_id）**全都不依赖平台**。所以把它们从平台里剥出来单独测。
//
// 覆盖：
//   A. crypto   —— 官方测试向量解密 + 签名计算
//   B. event    —— 事件体解析、@占位符剥离
//   C. commands —— 命令解析
//   D. store    —— 去重 / 限流 / prune / token 缓存 / 跨实例恢复
//   E. repo     —— 完整导入周期 + generation 制 + 快照往返 + 查询
//   F. tools    —— read / ls / find / grep 的真实调用
//   G. webhook  —— 端到端：假 Request → 转发 → 断言转发头
//   H. turn     —— 端到端：一条 /help 走完整回合
//   I. compact  —— 会话压缩的纯函数（渲染历史 / 写回形状 / 门槛）
//
// ⚠️ 这个文件会替换全局 fetch。所有测试都在一个进程里跑，
// 每个小节自己装自己的 stub，不要跨小节依赖。

import { decryptEvent, verifySignature } from "../src/feishu/crypto.ts";
import { parseMessageEvent, readChallenge, readEnvelope } from "../src/feishu/event.ts";
import { parseCommand } from "../src/feishu/commands.ts";
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
import { WorkspaceRepo, type RepoSnapshot, type RepoSnapshotStore } from "../src/workspace/repo.ts";
import { makeWorkspaceTools } from "../src/workspace/tools.ts";
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

  await it("/repo owner/name", () => {
    eq(parseCommand("/repo sindresorhus/is-stream"), {
      kind: "repo",
      owner: "sindresorhus",
      name: "is-stream",
    });
  });

  await it("GitHub 链接、@分支、/tree/ 三种写法都认", () => {
    eq(parseCommand("/repo https://github.com/a/b.git").kind, "repo");
    eq(parseCommand("/repo a/b@dev"), { kind: "repo", owner: "a", name: "b", ref: "dev" });
    eq(parseCommand("/repo github.com/a/b/tree/feature/x"), {
      kind: "repo",
      owner: "a",
      name: "b",
      ref: "feature/x",
    });
  });

  await it("非法字符被挡住", () => {
    eq(parseCommand("/repo a/b;rm -rf /").kind, "error");
    eq(parseCommand("/repo").kind, "error");
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

// ═══════════════════════════════════════════════════════════════════════
// E. repo
// ═══════════════════════════════════════════════════════════════════════

await describe("E. 语料仓储", async () => {
  const FILES = [
    { path: "README.md", content: "# demo\n" },
    { path: "src/a.ts", content: "export const x = 1;\nexport function f() {\n  return x;\n}\n" },
    { path: "src/deep/b.ts", content: "import { x } from '../a.ts';\nconsole.log(x);\n" },
  ];

  await it("完整导入周期：begin → batch → finish", () => {
    const r = new WorkspaceRepo();
    const { generation } = r.beginIngest("o", "n", "main", "ing1");
    eq(generation, 1);
    const batch = r.ingestBatch("ing1", FILES);
    eq(batch.accepted, 3);
    const fin = r.finishIngest("ing1", 0, false);
    eq(fin.fileCount, 3);
    eq(r.status().status, "ready");
    eq(r.status().owner, "o");
    eq(r.activeGeneration(), 1);
  });

  await it("readFile / hasFile", () => {
    const r = seed();
    ok(r.readFile("src/a.ts")!.content.includes("export function f"));
    ok(r.hasFile("README.md"));
    eq(r.readFile("nope.ts"), null);
  });

  await it("listDir：目录在前、文件在后，且父目录被自动建出来", () => {
    const r = seed();
    eq(r.listDir("", 10).map((e) => e.name + (e.kind === "d" ? "/" : "")), ["src/", "README.md"]);
    eq(r.listDir("src", 10).map((e) => e.name + (e.kind === "d" ? "/" : "")), ["deep/", "a.ts"]);
    eq(r.listDir("src/deep", 10).map((e) => e.name), ["b.ts"]);
    eq(r.listDir("不存在", 10), []);
  });

  await it("allPaths 有序且按前缀过滤", () => {
    const r = seed();
    eq(r.allPaths("", 100), ["README.md", "src/a.ts", "src/deep/b.ts"]);
    eq(r.allPaths("src/", 100), ["src/a.ts", "src/deep/b.ts"]);
  });

  await it("fileCursor 预筛：只返回内容命中的文件", () => {
    const r = seed();
    eq([...r.fileCursor("", { needle: "console", ci: false })].map((f) => f.path), [
      "src/deep/b.ts",
    ]);
    eq([...r.fileCursor("", { needle: "CONSOLE", ci: true })].map((f) => f.path), [
      "src/deep/b.ts",
    ]);
    eq([...r.fileCursor("", { needle: "CONSOLE", ci: false })].length, 0);
    eq([...r.fileCursor("", undefined)].length, 3);
  });

  await it("generation 制：失败的重新导入不让旧语料失效", () => {
    const r = seed();
    r.beginIngest("o2", "n2", "dev", "ing2");
    r.failIngest("ing2", "抓取失败");
    eq(r.status().status, "ready", "应退回 ready 而不是 error");
    ok(r.readFile("src/a.ts") !== null, "旧语料必须还在");
    eq(r.status().owner, "o", "owner 不该被 building 值污染");
  });

  await it("generation 制：成功的重新导入原子切换，旧语料被清掉", () => {
    const r = seed();
    r.beginIngest("o2", "n2", "dev", "ing2");
    r.ingestBatch("ing2", [{ path: "only.md", content: "x\n" }]);
    r.finishIngest("ing2", 0, false);
    eq(r.activeGeneration(), 2);
    eq(r.status().owner, "o2");
    eq(r.status().fileCount, 1);
    eq(r.readFile("src/a.ts"), null, "旧 generation 应被删");
    eq(r.allPaths("", 100), ["only.md"]);
  });

  await it("陈旧批次被静默丢弃（不污染新 generation）", () => {
    const r = new WorkspaceRepo();
    r.beginIngest("o", "n", "main", "ing1");
    const res = r.ingestBatch("旧的-ingestId", FILES);
    eq(res.accepted, 0);
    eq(r.finishIngest("ing1", 0, false).fileCount, 0);
  });

  await it("重复路径后者覆盖前者（对应原版的 insert or replace）", () => {
    const r = new WorkspaceRepo();
    r.beginIngest("o", "n", "main", "i");
    r.ingestBatch("i", [{ path: "a.ts", content: "v1\n" }]);
    r.ingestBatch("i", [{ path: "a.ts", content: "v2\n" }]);
    eq(r.finishIngest("i", 0, false).fileCount, 1);
    eq(r.readFile("a.ts")!.content, "v2\n");
  });

  await it("reset 回到未导入状态", () => {
    const r = seed();
    r.reset();
    eq(r.status().status, "empty");
    eq(r.status().fileCount, 0);
    eq(r.readFile("src/a.ts"), null);
  });

  await it("快照往返：落盘 → 新实例 hydrate → 语料还在", async () => {
    const box: { v: RepoSnapshot | null } = { v: null };
    const store: RepoSnapshotStore = {
      load: async () => box.v,
      save: async (s) => {
        box.v = s;
      },
      clear: async () => {
        box.v = null;
      },
    };

    const a = new WorkspaceRepo(store);
    a.beginIngest("o", "n", "main", "i");
    a.ingestBatch("i", FILES);
    a.finishIngest("i", 0, false);
    ok(await a.persist(), "persist 应成功");
    ok(box.v !== null, "快照应已写入");

    const b = new WorkspaceRepo(store);
    await b.hydrate();
    eq(b.status().owner, "o");
    eq(b.status().fileCount, 3);
    eq(b.readFile("src/a.ts")!.content, FILES[1].content);
    eq(b.listDir("src", 10).map((e) => e.name + (e.kind === "d" ? "/" : "")), ["deep/", "a.ts"]);
    eq(b.allPaths("", 100), ["README.md", "src/a.ts", "src/deep/b.ts"]);
  });

  await it("没有快照后端时 persist 返回 false 而不是抛错", async () => {
    const r = seed();
    eq(await r.persist(), false);
  });
});

function seed(): WorkspaceRepo {
  const r = new WorkspaceRepo();
  r.beginIngest("o", "n", "main", "i");
  r.ingestBatch("i", [
    { path: "README.md", content: "# demo\n" },
    { path: "src/a.ts", content: "export const x = 1;\nexport function f() {\n  return x;\n}\n" },
    { path: "src/deep/b.ts", content: "import { x } from '../a.ts';\nconsole.log(x);\n" },
  ]);
  r.finishIngest("i", 0, false);
  return r;
}

// ═══════════════════════════════════════════════════════════════════════
// F. tools
// ═══════════════════════════════════════════════════════════════════════

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
 * runContext 传 `{}` 就够：这四个工具的 execute 只吃参数、不碰 runContext。
 */
async function callTool(t: any, args: any): Promise<any> {
  if (typeof t?.invoke !== "function") {
    throw new Error(`tool 上没有 invoke，keys=${Object.keys(t ?? {}).join(",")}`);
  }
  const out = await t.invoke({}, JSON.stringify(args));
  return typeof out === "string" ? JSON.parse(out) : out;
}

await describe("F. 代码工具（read / ls / find / grep）", async () => {
  const tools = makeWorkspaceTools(seed());
  const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));

  await it("四个工具都注册上了", () => {
    eq(Object.keys(byName).sort(), ["find", "grep", "ls", "read"]);
  });

  await it("read 返回带行号的内容", async () => {
    const r = await callTool(byName.read, { path: "src/a.ts" });
    eq(r.path, "src/a.ts");
    eq(r.totalLines, 4);
    ok(r.content.includes("     1\texport const x = 1;"), `实际：${r.content}`);
    eq(r.truncated, false);
  });

  await it("read 支持 offset / limit", async () => {
    const r = await callTool(byName.read, { path: "src/a.ts", offset: 2, limit: 2 });
    eq(r.startLine, 2);
    eq(r.endLine, 3);
    eq(r.truncated, true);
    eq(r.nextOffset, 4);
  });

  await it("read 不存在的文件返回 error 而不是抛错", async () => {
    const r = await callTool(byName.read, { path: "nope.ts" });
    ok(typeof r.error === "string" && r.error.includes("文件不存在"), JSON.stringify(r));
  });

  await it("ls 目录带 / 后缀", async () => {
    const r = await callTool(byName.ls, {});
    eq(r.entries, ["src/", "README.md"]);
  });

  await it("ls 指向文件时报错并提示用 read", async () => {
    const r = await callTool(byName.ls, { path: "README.md" });
    ok(r.error.includes("不是目录"), JSON.stringify(r));
  });

  await it("find 支持 ** 与 {a,b}", async () => {
    eq((await callTool(byName.find, { glob: "**/*.ts" })).paths, ["src/a.ts", "src/deep/b.ts"]);
    eq((await callTool(byName.find, { glob: "src/**/*.{ts,md}" })).paths, ["src/a.ts", "src/deep/b.ts"]);
    eq((await callTool(byName.find, { glob: "*.md" })).paths, ["README.md"]);
  });

  await it("grep 命中行号与内容", async () => {
    const r = await callTool(byName.grep, { pattern: "export" });
    eq(r.matchCount, 2);
    eq(r.matches[0].path, "src/a.ts");
    eq(r.matches[0].line, 1);
  });

  await it("grep 搜不到返回空列表而不是错误", async () => {
    const r = await callTool(byName.grep, { pattern: "zzzzz不存在" });
    eq(r.matchCount, 0);
    eq(r.error, undefined);
    ok(typeof r.note === "string");
  });

  await it("grep literal=true 按普通字符串（点号不当通配）", async () => {
    eq((await callTool(byName.grep, { pattern: "a.ts", literal: true })).matchCount, 1);
    eq((await callTool(byName.grep, { pattern: "aXts", literal: false })).matchCount, 0);
  });

  await it("grep 挡住嵌套量词（灾难性回溯）", async () => {
    const r = await callTool(byName.grep, { pattern: "(a+)+" });
    ok(r.error.includes("嵌套量词"), JSON.stringify(r));
  });

  await it("没导语料时四个工具都给出可执行的提示", async () => {
    const empty = makeWorkspaceTools(new WorkspaceRepo());
    const t = Object.fromEntries(empty.map((x: any) => [x.name, x]));
    for (const name of ["read", "ls", "find", "grep"]) {
      const args: any = name === "read" ? { path: "a" } : name === "find" ? { glob: "*" } : name === "grep" ? { pattern: "a" } : {};
      const r = await callTool(t[name], args);
      ok(r.error.includes("/repo"), `${name} 的提示应引导用户发 /repo，实际：${JSON.stringify(r)}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// G. webhook 端到端
// ═══════════════════════════════════════════════════════════════════════

await describe("G. 飞书 webhook 端到端", async () => {
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
// H. turn 端到端
// ═══════════════════════════════════════════════════════════════════════

await describe("H. 回合流程", async () => {
  const ENV = { FEISHU_APP_ID: "cli_x", FEISHU_APP_SECRET: "s" };

  /**
   * 飞书 + GitHub 的混合假响应。
   *
   * ⚠️ `/repo owner/name` 不带 `@分支` 时，`runFeishuTurn` 会先调
   * `resolveDefaultBranch()` 去问 GitHub —— 那是**另一个域名**。
   * 只 stub 飞书的话这一步会抛「测试没有为这个请求准备响应」，
   * 被 turn.ts 的 catch 接住，于是只发出「确认一下链接…」那一条，
   * 「先回执再报结果」就永远只有 1 条消息。
   */
  const ghStub = (url: string, init: any): Response | undefined => {
    if (url.includes("api.github.com/repos/")) {
      return new Response(JSON.stringify({ default_branch: "main" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return feishuStub(url, init);
  };

  const host = (over: Partial<any> = {}) => ({
    ask: async () => ({ text: "答案是 42", streamed: false }),
    ingest: async () => "已导入 a/b@main：3 个文件",
    statusText: async () => "当前仓库：a/b@main",
    compact: async () => "已压缩：8 条历史 → 摘要（约 300 字）",
    clear: async () => "会话已清空",
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
    ok(texts[0].includes("/repo owner/name"), texts[0]);
    eq((await store as any).events.get("om_1").state, "done");
  });

  await it("/status 走 host.statusText", async () => {
    const calls = stubFetch(feishuStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/status"));
    eq(sentTexts(calls)[0], "当前仓库：a/b@main");
  });

  await it("/repo 先回执再报结果", async () => {
    const calls = stubFetch(ghStub);
    await runFeishuTurn(host() as any, ENV, new FeishuStore(new MemoryKv()), evt("/repo a/b"));
    const texts = sentTexts(calls);
    eq(texts.length, 2);
    ok(texts[0].includes("正在抓取"), texts[0]);
    ok(texts[1].includes("已导入"), texts[1]);
  });

  await it("/repo 抓取失败时说清楚，并提示可以显式写分支", async () => {
    const calls = stubFetch(feishuStub);
    const h = host({
      ingest: async () => {
        throw new Error("导入失败：仓库不存在");
      },
    });
    await runFeishuTurn(h as any, ENV, new FeishuStore(new MemoryKv()), evt("/repo a/b@main"));
    ok(sentTexts(calls).some((t) => t.includes("导入失败")), JSON.stringify(sentTexts(calls)));
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
// I. 会话压缩（纯函数）
// ═══════════════════════════════════════════════════════════════════════

await describe("I. 会话压缩的纯函数", async () => {
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

  await it("整段 transcript 超限时保留头和尾（仓库坐标在开头，不能丢）", () => {
    const items = [
      { role: "user", content: "导入了 sindresorhus/is-stream@main" },
      ...Array.from({ length: 40 }, (_, i) => ({
        role: "user",
        content: `第${i}轮问：${"很长的内容".repeat(900)}`,
      })),
    ];
    const t = renderTranscript(items);
    ok(t.length <= 120_100, `应被截到上限附近，实际 ${t.length}`);
    ok(t.includes("sindresorhus/is-stream@main"), "头部的仓库坐标必须留下");
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
    for (const k of ["仓库", "代码位置", "偏好", "还没做完"]) {
      ok(SUMMARY_SYSTEM_PROMPT.includes(k), `prompt 里应提到「${k}」`);
    }
    ok(SUMMARY_SYSTEM_PROMPT.includes("不要编"), "必须明确禁止编造");
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
