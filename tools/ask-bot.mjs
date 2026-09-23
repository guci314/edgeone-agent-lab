// 无头向「代码仓库助手」提问：直接给 EdgeOne agent 投递合成事件，再从飞书 API 读回复。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// 正常链路是「飞书网页版发消息 → webhook → cf-agent-lab 中转 → agent」，
// 但飞书网页版（bcn5w8565b6a.feishu.cn）会索要通知/本地网络权限，而 Chromium
// 刻意不允许脚本点这类弹窗 —— 每轮测试都要人工点一次。这条路径把浏览器整个拿掉。
//
// ── 为什么能这么绕 ──────────────────────────────────────────────────
// agent 的 normalizeEvent 只认 {messageId, chatId, chatType, openId, text}，
// **不验飞书签名**：签名是 cf-agent-lab 中转那层做的。所以本机可以直接打 agent。
//
// ── ⚠️ 打 EdgeOne 必须走代理 ────────────────────────────────────────
// 2026-09-23 实测（同一时刻、同一 URL、同一请求头）：
//   经代理 127.0.0.1:7890 → 202 ✅
//   直连                 → 401 ❌（腾讯 HTML 错误页，响应头 `x-eop-msg: eo_time missing`）
// 那个 `eo_time missing` 是边缘的通用挡板文案，**与请求内容无关**，
// 别照它去猜"少传了什么参数"。
//
// 踩过的坑：本机各会话普遍设着 `NO_PROXY=*`（claude-ds 那套启动脚本为加速自家
// 端点而设）。**curl 并不认这个通配**，所以"默认环境"下 curl 其实走了 ALL_PROXY，
// 于是能通；而我一开始把 *_PROXY 全删掉想"确保直连"，反而稳定 401。
// 别再删代理变量了 —— 这里显式用代理。
//
// 另一条同时踩到的：Node 的 fetch/https.request 和 Python 的 urllib 也全 401，
// 当时误判成"OpenSSL 的 TLS 指纹被挡"。真正原因同上——它们没走代理。
//
// 用法: node ask-bot.mjs "问题文本"
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const ENV_PATH = "/Users/guci/work/edgeone-agent-lab/.env";
// 提问人的 open_id（该应用命名空间下的）。**必须从 .env 读**，不写死在代码里：
// 它是用户身份令牌的存放键（令牌按 openId 分槽），用错人就会以为"没授权"。
// 拿法见 docs/03-验证清单.md —— 或让机器人回一条消息，用 /status 看它显示的那串。
const API = "https://open.feishu.cn/open-apis";

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

/** 经 curl 发一次请求。⚠️ 别换成 fetch，见文件头。 */
async function curl(url, { method = "GET", headers = {}, body } = {}) {
  const args = ["-sS", "-m", "60", "-X", method, "-o", "-", "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body !== undefined) args.push("-d", body);
  args.push(url);
  // ⚠️ 必须走代理（见文件头）。这里**清掉 NO_PROXY** 而不是清代理本身，
  // 否则 curl 会直连 → 401。
  const cleanEnv = { ...process.env };
  delete cleanEnv.NO_PROXY;
  delete cleanEnv.no_proxy;
  if (!cleanEnv.ALL_PROXY && !cleanEnv.all_proxy) cleanEnv.all_proxy = "http://127.0.0.1:7890";
  const { stdout, stderr } = await execFileP("curl", args, { env: cleanEnv, maxBuffer: 8 << 20 });
  if (stderr && /curl:/.test(stderr)) throw new Error(stderr.trim().slice(0, 200));
  const idx = stdout.lastIndexOf("\n");
  const status = Number(stdout.slice(idx + 1));
  const text = stdout.slice(0, idx);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（比如边缘的 HTML 错误页）就留在 text 里 */
  }
  return { status, text, json };
}

async function feishu(path, init) {
  const tok = await tenantToken();
  const r = await curl(API + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, ...(init?.headers ?? {}) },
  });
  if (r.json?.code !== 0) throw new Error(`飞书 ${path} → ${r.json?.code} ${r.json?.msg}`);
  return r.json.data;
}

let _tok = null;
async function tenantToken() {
  if (_tok) return _tok;
  const r = await curl(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  if (!r.json?.tenant_access_token) throw new Error(`取 tenant_access_token 失败：${r.text.slice(0, 200)}`);
  _tok = r.json.tenant_access_token;
  return _tok;
}

/**
 * 本机无头取得 p2p 会话 id 的办法：给用户发一条消息，**响应里带回 chat_id**。
 * 这比 `im/v1/chats` 省一个 scope（那个要 im:chat:readonly，本应用没开）。
 */
async function resolveChatId() {
  const d = await feishu("/im/v1/messages?receive_id_type=open_id", {
    method: "POST",
    body: JSON.stringify({
      receive_id: env.FEISHU_DEBUG_OPEN_ID,
      msg_type: "text",
      content: JSON.stringify({ text: "[自检] 建立无头测试通道，可忽略。" }),
    }),
  });
  return d.chat_id;
}

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error('用法: node ask-bot.mjs "问题文本"');
  process.exit(1);
}

const chatId = await resolveChatId();
const conversationId = `fs-${createHash("sha256").update(chatId).digest("hex").slice(0, 32)}`;
console.log(`chat_id      = ${chatId}`);
console.log(`conversation = ${conversationId}`);

// ⚠️ 必须 `?mode=sync`：只有同步模式会把这一轮的回复放进 HTTP 响应（`replies`）。
// async 那条回的是 202，不承载业务内容；而去读飞书消息也拿不到答案 ——
// 流式卡片的正文通过 `im/v1/messages` 只回一句「请升级至最新版本客户端」的占位。
const messageId = `om_dbg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const res = await curl(`${env.AGENT_URL}?mode=sync`, {
  method: "POST",
  headers: { "content-type": "application/json", "Makers-Conversation-Id": conversationId },
  body: JSON.stringify({
    messageId,
    chatId,
    chatType: "p2p",
    openId: env.FEISHU_DEBUG_OPEN_ID,
    text: question,
    token: env.INTERNAL_TOKEN,
  }),
});
console.log(`agent → ${res.status}`);

const replies = res.json?.replies;
if (!Array.isArray(replies)) {
  console.log("没有拿到 replies：", res.text.slice(0, 400));
  process.exit(1);
}
console.log("\n===== 机器人回复 =====");
for (const r of replies) console.log("---\n" + r);
