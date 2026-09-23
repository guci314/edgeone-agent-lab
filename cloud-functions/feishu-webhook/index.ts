// 飞书事件回调入口。路由：POST /feishu-webhook
//
// ── 移植说明（原版 → EdgeOne）────────────────────────────────────────
// 原版是 `src/feishu/router.ts`，挂在 Worker 的 `/api/feishu/event` 上，
// 处理完直接 `getAgentByName(env.ChatAgent, "fs-" + chatId)` 拿 DO stub、
// 调 `stub.feishuEnqueue(...)`。
//
// EdgeOne 没有「按名字取实例、主动调它的方法」的 API —— conversation_id 只能从
// 请求头进，不能从代码里指定。所以这里改成 **HTTP 转发**：自己补上
// `Makers-Conversation-Id` 头，POST 给同项目下的 agent 路由。
//
// ── 检查顺序是踩出来的，不要重排 ────────────────────────────────────
// 下面每一步的位置都有理由，原版的注释里写明了踩坑经过。三条最关键的：
//   ① 拿**原始字符串**再解析：签名是对未解析的 body 算的
//   ② 解密排在识别挑战之前：url_verification 的挑战体同样是加密的
//   ③ 挑战握手**不验签**且排在验签之前：飞书文档原文说安全校验
//      「不包括请求网址校验」。放错位置会让飞书后台一直报
//      「Challenge code没有返回」
//   ④ 自环防护排在去重之前：我们自己发的消息也会推回来
//
// ── 为什么这个文件不能挂在 agents/ 下 ───────────────────────────────
// agents/ 路由强制要求 `Makers-Conversation-Id`，而飞书推送是它自己发的，
// 我们加不了头。所以这一层必须是无状态的 cloud-function。
// 它只做「证明请求可信 → 解析 → 转发」，**不碰模型** —— 模型跑二三十秒，
// 这里必须在 3 秒内 ACK。

import { decryptEvent, verifySignature } from "../../src/feishu/crypto.ts";
import { parseMessageEvent, readChallenge, readEnvelope } from "../../src/feishu/event.ts";

interface FeishuEnv {
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_VERIFICATION_TOKEN?: string;
  /** 配了这个才有签名校验。生产上应该配 */
  FEISHU_ENCRYPT_KEY?: string;
  /** 逗号分隔的 open_id 白名单。空/未设 = 不限制 */
  FEISHU_ALLOWED_OPEN_IDS?: string;
  /** 转发目标。默认同项目的 /feishu */
  AGENT_URL?: string;
  INTERNAL_TOKEN?: string;
}

// 只放行飞书真的会发出来的 chat_id 形状。这不是洁癖：一个签名有效但构造出来的
// payload 能刷出无限多个会话实例（每个实例一份内存 + 一份 store 命名空间）。
// 允许 `_` 和 `-` 是保守起见 —— 我见过的都是纯字母数字，但没必要为了洁癖
// 在某个真实 id 上栽跟头（原版在本机测试时就先被自己的正则挡了一次）。
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,64}$/;

const MAX_TEXT_CHARS = 4000;

/**
 * ⚠️ 这里**不能**照抄原版的 `fs-${chatId}`。
 *
 * EdgeOne 的 `Makers-Conversation-Id` 有硬性格式要求：长度 6~36 字符，
 * 只允许 `0-9 a-z A-Z - _ .`，不合法直接 400。
 * 而飞书的 chat_id 形如 `oc_` + 32 位十六进制 = 35 字符，前面再加 `fs-`
 * 就是 38 字符 —— **超限**。
 *
 * 这个坑的阴险之处在于：本地用短 chat_id 测试一切正常，线上真实会话全部 400，
 * 而 400 是 agent 路由返回的，webhook 那边只会看到「转发失败」。
 *
 * 所以改成哈希：`fs-` + SHA-256 前 32 位十六进制 = 35 字符，稳定落在区间内，
 * 且同一个 chat_id 永远映射到同一个 conversation_id（这是粘性路由的前提）。
 */
async function conversationIdFor(chatId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chatId));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `fs-${hex.slice(0, 32)}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 一律回 200 + `{}`。飞书只关心「收到没有」，业务上的忽略不该触发它的重推 */
const ACK = () => json({ code: 0 });

export async function onRequest(context: any): Promise<Response> {
  const request = context?.request as Request | undefined;
  const env = (context?.env ?? {}) as FeishuEnv;

  try {
    return await handleEvent(request, env);
  } catch (e) {
    // 500 会让飞书重推，这正是我们想要的（可能只是临时故障）。
    // 去重那一层在 agent 里，重推不会导致重复回答
    return json({ error: (e as Error).message }, 500);
  }
}

async function handleEvent(request: Request | undefined, env: FeishuEnv): Promise<Response> {
  if (!request) return json({ error: "拿不到 request" }, 500);
  if (request.method !== "POST") return json({ error: "方法不支持" }, 405);

  // fail closed：没配应用凭证就没有任何可信度可言，别让门静默敞开
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_VERIFICATION_TOKEN) {
    return json({ error: "服务端未配置飞书应用凭证" }, 503);
  }
  if (!env.INTERNAL_TOKEN) {
    return json(
      { error: "服务端未配置 INTERNAL_TOKEN", how: "生成一个随机串，配在项目环境变量里。它同时被 agents/feishu 校验。" },
      503,
    );
  }

  // ⚠️ 必须先拿原始字符串。签名是对**未经解析的 body** 算的，
  // 先 JSON.parse 再 stringify 回去，键序和空白一变签名就永远对不上
  const raw = await request.text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body 不是合法 JSON" }, 400);
  }

  const encryptKey = env.FEISHU_ENCRYPT_KEY;

  // 先解密（配了 Encrypt Key 时）。注意**顺序**：url_verification 的挑战体同样是
  // 加密的，所以解密要排在识别挑战之前。
  if (encryptKey && typeof (body as { encrypt?: string })?.encrypt === "string") {
    const plain = await decryptEvent((body as { encrypt: string }).encrypt, encryptKey);
    try {
      body = JSON.parse(plain);
    } catch {
      return json({ error: "解密后的内容不是合法 JSON" }, 400);
    }
  }

  // ── 请求网址校验握手 ────────────────────────────────────────────────
  // ⚠️ 这一步**不做签名校验**，而且必须排在签名校验之前。
  // 飞书文档原文：安全校验适用于「接收到开放平台推送的事件时（不包括请求网址校验）」。
  // 回一个 challenge 本身没有任何副作用（只是原样回声），所以这里放宽是安全的。
  const challenge = readChallenge(body);
  if (challenge !== null) {
    if (String((body as { token?: string }).token ?? "") !== env.FEISHU_VERIFICATION_TOKEN) {
      return json({ error: "verification token 不匹配" }, 401);
    }
    return json({ challenge });
  }

  // ── 事件推送才校验签名 ──────────────────────────────────────────────
  if (encryptKey) {
    const ok = await verifySignature(
      raw,
      request.headers.get("x-lark-request-timestamp") ?? "",
      request.headers.get("x-lark-request-nonce") ?? "",
      encryptKey,
      request.headers.get("x-lark-signature") ?? "",
    );
    if (!ok) return json({ error: "签名校验失败" }, 401);
  }
  // 没配 Encrypt Key 就只剩明文 token 比对 —— 安全性明显更弱，
  // 但至少不比飞书给的方案差。生产上应该配 Encrypt Key。

  const envelope = readEnvelope(body);
  if (!envelope) return ACK();
  if (envelope.token !== env.FEISHU_VERIFICATION_TOKEN) {
    return json({ error: "token 不匹配" }, 401);
  }

  if (envelope.eventType !== "im.message.receive_v1") return ACK();

  const msg = parseMessageEvent(body);
  if (!msg) return ACK();

  // ⚠️ 自环防护必须在**去重之前**。我们自己也往会话里发消息（「正在抓取…」、
  // 以及回答），那些消息同样会变成 im.message.receive_v1 事件推回来 ——
  // 不过滤的话 bot 会跟自己的回执聊起来。
  const senderType = (body as any).event?.sender?.sender_type;
  if (senderType === "app") return ACK();

  if (!msg.openId) return ACK();

  const allow = (env.FEISHU_ALLOWED_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length > 0 && !allow.includes(msg.openId)) {
    return ACK(); // 静默忽略：回一条"你没权限"等于告诉对方这个端点存在
  }

  if (!CHAT_ID_RE.test(msg.chatId)) return ACK();
  if (!msg.text || msg.text.length > MAX_TEXT_CHARS) return ACK();

  // ── 转发给 agent ────────────────────────────────────────────────────
  const conversationId = await conversationIdFor(msg.chatId);
  const agentUrl = env.AGENT_URL || `${new URL(request.url).origin}/feishu`;

  let res: Response;
  try {
    res = await fetch(agentUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        // 平台按这个头做粘性路由 + store 归属 + 沙箱归属
        "Makers-Conversation-Id": conversationId,
        "x-internal-token": env.INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        messageId: msg.messageId,
        chatId: msg.chatId,
        chatType: msg.chatType,
        openId: msg.openId,
        text: msg.text,
      }),
      // 上限压到 110 秒：cloud-functions 的硬上限是 120 秒，留 10 秒余量。
      // async 模式下 agent 200 毫秒就返回 202，这个上限用不到；
      // sync 模式下它决定「最多等多久」，等不到就让飞书重推（去重会挡住）
      signal: AbortSignal.timeout(110_000),
    });
  } catch (e) {
    // 转发失败 → 500 → 飞书重推。这是**期望**的行为
    return json({ error: `转发给 agent 失败：${(e as Error).message}` }, 500);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return json({ error: `agent 返回 HTTP ${res.status}`, detail: detail.slice(0, 300) }, 500);
  }

  return ACK();
}

export default onRequest;
