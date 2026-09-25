// 用飞书 API 验证**跨会话记忆**：一条事实在会话 A 记下，会话 B/C 答得出来。
//
// ── 为什么不能用「两个不同的群」──────────────────────────────────────
// 本应用没开 `im:chat*` 系列权限（实测 99991672），所以既列不了群也建不了群，
// 手上只有一个真实会话：bot 与 FEISHU_DEBUG_OPEN_ID 的单聊。
//
// ── 于是怎么造出「不同会话」─────────────────────────────────────────
// 平台判会话的唯一依据是 `Makers-Conversation-Id` 请求头（不是 chat_id）。
// 所以：**chatId 用真实单聊**（这样机器人真能把回复发出去，我们能从飞书读回来），
// **conversation_id 换成一个不同的值** —— 对平台来说这就是另一个会话：
// 另一个实例、另一份 session、另一份 state。
//
// 这比「两个群」其实更干净：chat 完全相同，**唯一的变量就是会话**，
// 所以 B 要是答得出，知识只可能来自跨会话的记忆，不可能来自聊天记录。
//
// ── 为什么事实必须是「猜不出来」的 ──────────────────────────────────
// 拿「用 pnpm 还是 npm」当探针是假阳性陷阱：模型本来就会猜 pnpm。
// 所以用内部代号 + 一个奇怪的发布分支 —— 不给记忆就绝不可能答对。
// 而且先问一遍做**基线**，再记、再问同一个会话，前后对比。
//
// ── 读回复的两条路 ─────────────────────────────────────────────────
//   · `?mode=sync` 的 `replies`：拿得到**卡片正文**。飞书 API 读不到卡片正文
//     （`im/v1/messages` 对卡片只回一个 image 占位），所以问答类回复靠它。
//   · 飞书 API `im/v1/messages`：拿得到 **sendText 发的纯文本**（`/memory`
//     `/forget` 这类命令走这条）。所以「记忆清单」用飞书 API 读，全链路不碰自家接口。
//
// 用法：
//   node tools/verify-memory.mjs            # 完整跑
//   node tools/verify-memory.mjs --keep     # 跑完不清记忆（想留在飞书里看）

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const KEEP = process.argv.includes("--keep");

const ENV_PATH = "/Users/guci/work/edgeone-agent-lab/.env";
const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}
for (const k of ["AGENT_URL", "INTERNAL_TOKEN", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_DEBUG_OPEN_ID"]) {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`);
    process.exit(1);
  }
}

// ⚠️ 用自定义域名，直连即可；`.edgeone.dev` 那条域名在本机必须走代理（见 tools/ask-bot.mjs）。
const AGENT_URL = env.AGENT_URL.replace("edgeone-agent-lab-kbyubp1n.edgeone.dev", "eolab.yujizi.org");
const API = "https://open.feishu.cn/open-apis";

/** 跨会话要验的那条事实。**必须是猜不出来的**，否则整个测试是假阳性 */
const FACT_KEY_HINT = "内部代号";
const FACT = "青鸟-7";
const BRANCH = "release/2026q4-migration";

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n${"─".repeat(4)} ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

let failures = 0;
/** 收一份清单，最后打印成表 —— 一屏看结论，不用往上翻 */
const results = [];
const check = (ok, label, detail = "") => {
  log(`   ${ok ? "✅" : "❌"} ${label}${detail ? `\n        ${detail}` : ""}`);
  results.push({ ok, label });
  if (!ok) failures++;
  return ok;
};

/**
 * 回复里**断言**了这条事实吗？
 *
 * ⚠️ 不能直接 `includes(FACT)` —— 实测踩过：清理之后模型回的是
 * 「我上一条答错了，向你更正……『青鸟-7』这个说法没有任何来源，那是我编的」，
 * 里面**含有**那四个字，但语义是**否认**它。字符串匹配会把这种自我纠正
 * 判成「还记得」。
 *
 * 所以：出现了事实原文，且**没有**任何否认/纠正/不确定的标志词，才算断言。
 * 反过来，问「知不知道」时也可以用 `!assertsFact()` 判「答不出来」。
 */
const DENIAL = ["更正", "答错", "我编的", "编的", "没有来源", "没有任何来源", "是空的", "空的", "不知道", "查不到", "没记", "抱歉"];
function assertsFact(text) {
  if (!text.includes(FACT)) return false;
  return !DENIAL.some((w) => text.includes(w));
}

// ── 飞书 API ────────────────────────────────────────────────────────
async function feishu(path, { method = "GET", body, tok } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return r.json();
}

let _tok = null;
async function tenantToken() {
  if (_tok) return _tok;
  const r = await feishu("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    body: { app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET },
  });
  if (!r.tenant_access_token) throw new Error(`取 tenant_access_token 失败：${JSON.stringify(r).slice(0, 200)}`);
  _tok = r.tenant_access_token;
  return _tok;
}

/** 给用户发一条消息，借响应拿到这个单聊的 chat_id（没开 im:chat:readonly 时的绕法） */
async function resolveChatId() {
  const d = await feishu("/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    tok: await tenantToken(),
    body: {
      receive_id: env.FEISHU_DEBUG_OPEN_ID,
      msg_type: "text",
      content: JSON.stringify({ text: "[自检] 跨会话记忆验证开始，下面几条消息是自动发的。" }),
    },
  });
  if (d.code !== 0 || !d.data?.chat_id) throw new Error(`拿 chat_id 失败：${JSON.stringify(d).slice(0, 300)}`);
  return d.data.chat_id;
}

/** 读群里最近的纯文本消息（sendText 发的那些）。飞书 API 读不到卡片正文，这是已知限制 */
async function readRecentTexts(chatId, n = 12) {
  const d = await feishu(
    `/im/v1/messages?container_id_type=chat&container_id=${chatId}&page_size=${n}&sort_type=ByCreateTimeDesc`,
    { tok: await tenantToken() },
  );
  if (d.code !== 0) throw new Error(`读消息历史失败：${JSON.stringify(d).slice(0, 300)}`);
  return (d.data?.items ?? [])
    .filter((it) => it.msg_type === "text")
    .map((it) => {
      let text = "";
      try {
        text = JSON.parse(it.body?.content ?? "{}").text ?? "";
      } catch {
        /* 忽略 */
      }
      return { id: it.message_id, at: Number(it.create_time), text, sender: it.sender?.id };
    });
}

/** 轮询等一条**新出现的**、含关键字的纯文本（命令类回复走这条路） */
async function waitForText(chatId, { contains, since, timeoutMs = 90_000 }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const items = await readRecentTexts(chatId);
    const hit = items.find((m) => m.at > since && m.text.includes(contains));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

// ── agent 直调（拿卡片正文的唯一途径）────────────────────────────────
const convOf = (seed) => `fs-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;

async function ask(conversationId, chatId, text, label) {
  const messageId = `om_vm${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const startedAt = Date.now();
  const res = await fetch(`${AGENT_URL}?mode=sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "Makers-Conversation-Id": conversationId },
    body: JSON.stringify({
      messageId,
      chatId,
      chatType: "p2p",
      openId: env.FEISHU_DEBUG_OPEN_ID,
      text,
      token: env.INTERNAL_TOKEN,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json().catch(() => null);
  const replies = json?.replies ?? [];
  const body = replies.join("\n").trim();
  log(`\n▶ [${label}] 发：${text}`);
  log(`  ← ${res.status} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  log(`  ${body ? body.replace(/\n/g, "\n  ") : JSON.stringify(json).slice(0, 300)}`);
  return { status: res.status, replies, body, at: startedAt };
}

// ══════════════════════════════════════════════════════════════════════
// 开始
// ══════════════════════════════════════════════════════════════════════

hr("准备：飞书 API + 会话 id");
const chatId = await resolveChatId();
// ⚠️ 每次跑都用**新的会话 id**（带一个 run nonce）。
// 上一版复用固定 id，结果第二次跑时阶段 1 的「基线」被上一轮的会话历史污染了 ——
// 模型在历史里见过那条事实，于是基线判据假失败。会话 id 必须一轮一换。
const RUN = randomBytes(3).toString("hex");
const CONV_A = convOf(`${chatId}#A-${RUN}`); // 会话 A：让它记住
const CONV_B = convOf(`${chatId}#B-${RUN}`); // 会话 B：同一个群，**另一个会话**
const CONV_C = convOf(`${chatId}#C-${RUN}`); // 会话 C：第三个，从没出现过
// 会话 D：**只**用于「清理之后」的复查。
// 为什么不能复用 C：C 在阶段 4/4.5 里自己答过那条事实，会话历史里还留着，
// 清理后它会从上文复述出来 → 假失败（实测踩过，见阶段 7 注释）。
const CONV_D = convOf(`${chatId}#D-${RUN}`);

log(`  run nonce            = ${RUN}`);
log(`  chat_id（真实单聊）  = ${chatId}`);
log(`  会话 A conversation  = ${CONV_A}`);
log(`  会话 B conversation  = ${CONV_B}   ← 与 A 不同`);
log(`  会话 C conversation  = ${CONV_C}   ← 与 A、B 都不同`);
log(`  会话 D conversation  = ${CONV_D}   ← 只用于清理后的复查`);
check(new Set([CONV_A, CONV_B, CONV_C, CONV_D]).size === 4, "四个 conversation_id 互不相同");

// ── 阶段 1：基线。B 还不知道这条事实 ────────────────────────────────
hr("阶段 1 · 基线（还没记，B 必须答不出来）");
const base = await ask(
  CONV_B,
  chatId,
  `这个项目的${FACT_KEY_HINT}是什么？发布分支用哪个？如果不知道就直说不知道。`,
  "B 基线",
);
const baseKnows = base.body.includes(FACT);
check(!baseKnows, `B 在记忆为空时**没有**说出「${FACT}」`, baseKnows ? "⚠️ 它猜到了 —— 这条探针不成立，得换一个更刁的事实" : "");

// ── 阶段 2：会话 A 记下事实 ────────────────────────────────────────
hr("阶段 2 · 在会话 A 里记下事实");
const rec = await ask(
  CONV_A,
  chatId,
  `记住一条长期事实：这个项目的${FACT_KEY_HINT}是「${FACT}」，发布分支固定用 ${BRANCH}。请用 remember_fact 记下来。`,
  "A 记忆",
);
check(/记下|已记|记住/.test(rec.body), "A 回执里出现了「记下了」这类确认", rec.body.slice(0, 200));

// ── 阶段 3：会话 B **同一个会话**再问一次 ─────────────────────────
// 这是整场最关键的一步：**同一个 conversation**，基线时答不出、现在答得出，
// 中间唯一的变量就是那条共享记忆。
hr("阶段 3 · 回到会话 B 再问（同一个会话，唯一变量是共享记忆）");
const after = await ask(CONV_B, chatId, `这个项目的${FACT_KEY_HINT}是什么？发布分支用哪个？`, "B 复问");
check(after.body.includes(FACT), `B 说出了「${FACT}」`, `实际：${after.body.slice(0, 300)}`);
check(after.body.includes(BRANCH) || after.body.includes("2026q4"), "B 也说出了发布分支");

// ── 阶段 4：第三个会话 C ──────────────────────────────────────────
hr("阶段 4 · 会话 C（第三个会话，从没参与过）");
const c = await ask(CONV_C, chatId, `这个项目的${FACT_KEY_HINT}是什么？`, "C 首次提问");
check(c.body.includes(FACT), `C 也说出了「${FACT}」`, `实际：${c.body.slice(0, 300)}`);

// ── 阶段 4.5：连续问两次，必须**口径一致**（不许反复撤回）────────────
// 线上实测踩过：模型同时看到「提示词快照里有 2 条」和「recall_facts 返回 0 条」，
// 就判定成「读取不稳定」，然后在飞书里当众撤回一个正确答案，下一轮又撤回撤回。
// 这条判据专门盯那个毛病。
hr("阶段 4.5 · 同一个会话连问两次，口径必须一致");
const again = await ask(CONV_C, chatId, `再确认一次：这个项目的${FACT_KEY_HINT}是什么？`, "C 复问");
check(again.body.includes(FACT), "第二次仍然答得出（没有把自己撤回掉）", `实际：${again.body.slice(0, 300)}`);
const flipFlop = ["我编的", "没有任何来源", "上一条答错", "撤回"].some((w) => again.body.includes(w));
check(!flipFlop, "第二次没有出现「我编的 / 撤回」这类自我否定", `实际：${again.body.slice(0, 300)}`);

// ── 阶段 5：用**飞书 API**读记忆清单（命令走 sendText，飞书能读到）──
hr("阶段 5 · 飞书 API 读 /memory（纯文本，不经自家接口）");
const mark = Date.now();
await ask(CONV_C, chatId, "/memory", "C /memory");
const listed = await waitForText(chatId, { contains: FACT, since: mark });
if (listed) {
  log(`  ← 飞书 API 读到的原文：\n     ${listed.text.replace(/\n/g, "\n     ")}`);
  check(true, "飞书 API 读到了记忆清单，里面含这条事实");
} else {
  check(false, "飞书 API 没读到含该事实的纯文本消息", "可能是 /memory 没走 sendText，或消息还没落库");
}

// ── 阶段 6：/clear 只清对话，不该清记忆 ───────────────────────────
hr("阶段 6 · 在 A 发 /clear，再问（记忆不该被清）");
await ask(CONV_A, chatId, "/clear", "A /clear");
const afterClear = await ask(CONV_A, chatId, `这个项目的${FACT_KEY_HINT}是什么？`, "A 清空后");
check(afterClear.body.includes(FACT), `清空对话历史后 A 仍然记得「${FACT}」`, `实际：${afterClear.body.slice(0, 300)}`);

// ── 阶段 7：清理 ──────────────────────────────────────────────────
if (KEEP) {
  hr("阶段 7 · 跳过清理（--keep）");
  log("  ⚠️ 测试事实仍留在长期记忆里，记得手动 /forget all confirm");
} else {
  hr("阶段 7 · 清理测试事实");
  const m2 = Date.now();
  await ask(CONV_A, chatId, "/forget all confirm", "A 清理");
  const gone = await waitForText(chatId, { contains: "已清掉", since: m2, timeoutMs: 45_000 });
  check(!!gone, "清理回执出现", gone ? gone.text : "没等到「已清掉」");

  // 硬判据用 /memory（确定性，不过模型）：必须说「还没有任何长期记忆」
  const m3 = Date.now();
  await ask(CONV_C, chatId, "/memory", "C 清理后 /memory");
  const empty = await waitForText(chatId, { contains: "还没有任何长期记忆", since: m3, timeoutMs: 45_000 });
  check(!!empty, "清理后 /memory 说记忆是空的", empty ? empty.text : "没等到「还没有任何长期记忆」");

  // 软判据用模型：它不该再断言这条事实。
  //
  // ⚠️⚠️ **必须换一个全新的会话 D，不能在 C 里问。**
  // 实测踩过（2026-09-25，这一条是本脚本最后一个假失败）：
  // 在 C 里问，C 答得头头是道，还说「实时确认过，没变」——
  // 但 `/memory` 明明说记忆是空的。原因不是记忆没清掉，
  // 而是**阶段 4/4.5 里 C 自己答过这条事实，那段对话还留在 C 的会话历史里**，
  // 模型是从自己的上文里复述的，跟长期记忆一点关系没有。
  // 用全新会话 D 问才是真正的判据 —— 实测 D 回「还没导入仓库，我读不到任何代码」。
  //
  // 顺带记一笔：C 那句「实时确认过」是**编的**（它压根没调 recall_facts）。
  // 这属于模型对自己的行为说谎，不是记忆层的问题，但值得知道。
  const after = await ask(CONV_D, chatId, `这个项目的${FACT_KEY_HINT}是什么？`, "D 清理后复查（全新会话）");
  check(!assertsFact(after.body), `清理后全新会话 D 不再断言「${FACT}」`, `实际：${after.body.slice(0, 260)}`);
}

hr("汇总");
for (const r of results) log(`  ${r.ok ? "✅" : "❌"}  ${r.label}`);
log("");
hr(failures === 0 ? "结论：✅ 跨会话记忆成立" : `结论：❌ ${failures} 项不成立`);
process.exit(failures === 0 ? 0 : 1);
