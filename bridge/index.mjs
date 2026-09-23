// 飞书长连接 → EdgeOne Makers agent 路由的桥接进程。
//
// ── 为什么需要这个进程 ──────────────────────────────────────────────
// EdgeOne Makers 的两类 Runtime 是**分离**的：cloud-functions 内部
// `fetch` 同项目的 agents 路由会被平台拒绝
// （`404 domain endpoints match fail` —— 实测，自定义域名和预设域名都一样）。
// 官方文档也写明 cloud-functions 的 context 只有 `request / env / agent.store`，
// 没有调用 agent 的 API。
//
// 但从**外部**带 `Makers-Conversation-Id` 请求 `https://<域名>/feishu` 是通的
// （实测 200）。所以把「接事件」这一层挪到外面的常驻进程：
//
//   飞书 ──长连接──> 本进程 ──HTTP(公网)──> EdgeOne agents 路由
//
// 长连接模式还有个副作用是**不需要公网回调地址**，飞书不再往我们域名推送，
// 那条 500 的链路直接绕开。
//
// ── 和原 webhook 的分工 ────────────────────────────────────────────
// 本进程只做「收事件 → 转发」，**不碰模型、不回复**。回复是 agent 那边
// 自己调飞书 API 发的（agents/feishu 里有 FEISHU_APP_ID/SECRET）。
// 去重、自环防护、命令解析都在 agent 侧，这里只做最粗的两层过滤。
//
// ── 运行 ───────────────────────────────────────────────────────────
//   cd bridge && npm install && npm start        # 需要 ../bridge/.env
// 常驻建议用 launchd（见 bridge/README.md）。
//
// ⚠️ 这个目录**不参与 EdgeOne 部署**（部署只认 agents/ 与 cloud-functions/），
//    它是跑在你自己机器/服务器上的独立进程。

import { createHash } from "node:crypto";
import { WSClient, EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_VERIFICATION_TOKEN,
  FEISHU_ENCRYPT_KEY,
  INTERNAL_TOKEN,
  AGENT_URL = "https://eolab.yujizi.org/feishu",
} = process.env;

for (const [k, v] of Object.entries({
  FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_VERIFICATION_TOKEN, INTERNAL_TOKEN,
})) {
  if (!v) {
    console.error(`[bridge] 缺少环境变量 ${k}，退出。把值写进 bridge/.env 再启动。`);
    process.exit(1);
  }
}

/**
 * conversation_id 必须和原 webhook 的算法**完全一致**，否则同一个群
 * 会落到不同的会话实例上，记忆和沙箱全串。
 * 平台要求：6~36 字符，只允许 0-9 a-z A-Z - _ .
 */
function conversationIdFor(chatId) {
  const hex = createHash("sha256").update(chatId).digest("hex");
  return `fs-${hex.slice(0, 32)}`;
}

function readText(message) {
  if (message?.message_type !== "text") return null;
  try {
    return JSON.parse(message.content ?? "{}").text ?? null;
  } catch {
    return null;
  }
}

async function forward(evt) {
  const res = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 平台按这个头做粘性路由 + store 归属 + 沙箱归属
      "Makers-Conversation-Id": conversationIdFor(evt.chatId),
      "x-internal-token": INTERNAL_TOKEN,
    },
    // 令牌**两个地方都放**：header 和 body。
    // 实测这个 runtime 的 request.headers 不是标准 Headers 实例（普通对象），
    // agent 侧两种形态都读；都发是为了哪条路被平台改了都还能过。
    body: JSON.stringify({ ...evt, token: INTERNAL_TOKEN }),
    // agent 在 async 模式下 200ms 就回 202，这个上限只是兜底。
    // 超时不重试 —— 飞书长连接本身不重推，重推会造成重复回答
    signal: AbortSignal.timeout(110_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body: body.slice(0, 300) };
}

const dispatcher = new EventDispatcher({
  verificationToken: FEISHU_VERIFICATION_TOKEN,
  encryptKey: FEISHU_ENCRYPT_KEY,
}).register({
  "im.message.receive_v1": async (data) => {
    const msg = data?.message;
    const chatId = String(msg?.chat_id ?? "");
    const messageId = String(msg?.message_id ?? "");

    // 自环防护：我们自己发的回执也会推回来，不过滤 bot 会跟自己聊起来
    if (data?.sender?.sender_type === "app") return { code: 0 };

    const text = readText(msg);
    if (!text) return { code: 0 };
    if (!chatId || !messageId) return { code: 0 };

    // ── 立刻 ACK，转发放到后台 ────────────────────────────────────
    // 实测：handler 里 `await` 转发（约 4 秒）会超过飞书的 ACK 时限，
    // 飞书把同一条消息**再推一次** —— 日志里就是「同一个 messageId
    // 先 202 后 200」成对出现。第二次靠 agent 的去重挡住了（返回
    // duplicate），不会重复回答，但白白多跑一次。
    //
    // 所以这里不等转发结果，直接回 {code:0} 让 SDK 立刻 ACK。
    // agent 那边本来就是 async 模式（202 就返回），链路不会丢。
    const t0 = Date.now();
    void forward({
      messageId,
      chatId,
      chatType: String(msg?.chat_type ?? ""),
      openId: String(data?.sender?.sender_id?.open_id ?? ""),
      text,
    })
      .then((r) => {
        console.log(
          `[bridge] ${messageId} → ${r.status} (${Date.now() - t0}ms)` +
            (r.status >= 300 ? ` body=${r.body}` : ""),
        );
      })
      .catch((e) => {
        // 长连接不重推，转发失败这条就丢了。agent 侧的去重也用不上。
        console.error(`[bridge] ${messageId} 转发失败 (${Date.now() - t0}ms)：`, e.message);
      });

    return { code: 0 };
  },
});

const ws = new WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: LoggerLevel.info,
  onReady: () => console.log("[bridge] 长连接已就绪"),
  onError: (err) => console.error("[bridge] 长连接错误：", err?.message ?? err),
});

console.log(`[bridge] 启动中 → ${AGENT_URL}`);
await ws.start({ eventDispatcher: dispatcher });
