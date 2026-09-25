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
// ── ⚠️ 代理：分域名，别一刀切 ────────────────────────────────────────
// 2026-09-23 实测（同一时刻、同一 URL、同一请求头，打 `.edgeone.dev`）：
//   经代理 127.0.0.1:7890 → 202 ✅
//   直连                 → 401 ❌（腾讯 HTML 错误页，响应头 `x-eop-msg: eo_time missing`）
// 那个 `eo_time missing` 是边缘的通用挡板文案，**与请求内容无关**，
// 别照它去猜"少传了什么参数"。
//
// 2026-09-25 补测（条件变了，结论要分开记）：
//   · `.edgeone.dev`（AGENT_URL）  → **必须走代理**（直连 401，经代理 400/202）
//   · `eolab.yujizi.org`（自定义域名）→ **直连就行**（直连、经代理都是 400）
//   所以「打 EdgeOne 必须走代理」只对 `.edgeone.dev` 成立，别推广。
//
// ── 踩过的坑（2026-09-25 又踩一次）────────────────────────────────────
// 原来这里只 `delete NO_PROXY`，然后 `if (!ALL_PROXY) all_proxy = 7890`。
// 在本机各会话普遍设着 `NO_PROXY=*` 的年代这没问题；但现在环境里
// **`HTTPS_PROXY=127.0.0.1:53513`（另一个端口）是设着的**，而 curl 解析
// https 代理的优先级是 `HTTPS_PROXY` > `ALL_PROXY` —— 于是 all_proxy=7890
// 被静默忽略，请求走了 53513，稳定 401。
//
// 所以现在**显式用 `-x` 指定代理**，并把所有代理类环境变量清干净，
// 让 curl 没有别的选择。想换代理端口就设 `EO_PROXY`。
const PROXY = process.env.EO_PROXY || "http://127.0.0.1:7890";

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
  // 显式 -x 指定代理，见文件头的说明：环境里的 HTTPS_PROXY 会压过 all_proxy
  const args = ["-sS", "-m", "60", "-x", PROXY, "-X", method, "-o", "-", "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body !== undefined) args.push("-d", body);
  args.push(url);
  // 把所有代理类变量清干净，让上面那个 -x 成为唯一来源（否则会被环境里的
  // HTTPS_PROXY 覆盖掉，就是 9/25 那次 401 的原因）
  const cleanEnv = { ...process.env };
  for (const k of [
    "NO_PROXY", "no_proxy",
    "HTTP_PROXY", "http_proxy",
    "HTTPS_PROXY", "https_proxy",
    "ALL_PROXY", "all_proxy",
  ]) {
    delete cleanEnv[k];
  }
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
  // 401 + 腾讯 HTML 页 = 边缘挡板，**不是**业务鉴权失败（别去查 INTERNAL_TOKEN）。
  // 判据：响应体里有 "Tencent Edgeone" 这种 HTML 标题，或 x-eop-msg: eo_time missing。
  if (res.status === 401 && /Tencent Edgeone|<html/i.test(res.text)) {
    console.log(
      `\n💡 这是边缘挡板（eo_time missing），不是 INTERNAL_TOKEN 的问题。\n` +
        `   AGENT_URL 是 .edgeone.dev 域名时必须经代理访问。当前用的代理是 ${PROXY}。\n` +
        `   换端口：EO_PROXY=http://127.0.0.1:<port> node tools/ask-bot.mjs "…"\n` +
        `   测代理是否可用：curl -s -o /dev/null -w '%{http_code}\\n' -x ${PROXY} "${env.AGENT_URL}"（400 就是通的）`,
    );
  }
  process.exit(1);
}
console.log("\n===== 机器人回复 =====");
for (const r of replies) console.log("---\n" + r);
