// 端到端验证**自动压缩在生产上真的会触发**（`npm run verify:autocompact`）。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// 自动压缩的判据是「renderTranscript 渲染出来超 12 万字」，而那要十几轮满长度
// 对话才堆得到。冒烟测试只钉得住判据本身（纯函数），**触发那一段只能真跑**：
// 判据恒 false、`session()` 拿不到、压缩抛错被吞 —— 三种坏法症状都是
// 「什么都没发生」，光看聊天记录分不出来。
//
// ── 怎么在不刷屏的前提下验 ──────────────────────────────────────────
// 两个既有事实凑出来的办法（`ask-bot.mjs` 里就写着，只是不在显眼处）：
//   ① 回复可以从 `?mode=sync` 的 **HTTP 响应**里读，不必去读飞书聊天；
//   ② 会话身份是 **`Makers-Conversation-Id` 请求头**，不是 chat_id。
// 于是用**假 chat_id + 独立 conversation id**：消息只会尝试发到那个不存在的
// chat（发不出去，整轮回 500），**一条都不会打到真人聊天里**。
//
// ⚠️ 代价：那一轮回 500，读不到回复 —— 但压缩代码在 `ask()` 里**已经跑完了**
// （发送失败发生在 `ask()` 返回之后）。所以改成读**诊断计数器**
// （`?probe=last` 的 `counters`）来看它有没有真的执行。
//
// ⚠️ `diagCounters` 是**按实例**的内存计数，实例由 conversation id 粘性路由。
// 所以脚本**必须自己先清零**再跑；不清的话读到的可能是上一轮攒下的值，
// 「涨到 1」就是假阳性 —— 这个坑第一版真踩了。
//
// ⚠️ 别用管道跑（`| tail`）：console.log 一进管道就被缓冲，进程结束前读不到
// 一个字。进度一律用 `appendFileSync` 落盘。
import { appendFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const PROGRESS = "/tmp/verify-autocompact.log";
const say = (s) => {
  appendFileSync(PROGRESS, s + "\n");
  console.log(s);
};

const PROXY = process.env.EO_PROXY || "http://127.0.0.1:7890";
const ENV_PATH = new URL("../.env", import.meta.url).pathname;

const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].trim();
}
for (const k of ["AGENT_URL", "INTERNAL_TOKEN", "FEISHU_DEBUG_OPEN_ID"]) {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`);
    process.exit(1);
  }
}

/** 经 curl 发一次请求。别换成 fetch（代理与环境变量的坑见 ask-bot.mjs 文件头） */
async function curl(url, { method = "GET", headers = {}, body } = {}) {
  const args = ["-sS", "-m", "180", "-x", PROXY, "-X", method, "-o", "-", "-w", "\n%{http_code}"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  if (body !== undefined) args.push("-d", body);
  args.push(url);
  const cleanEnv = { ...process.env };
  for (const k of ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
    delete cleanEnv[k];
  }
  const { stdout } = await execFileP("curl", args, { env: cleanEnv, maxBuffer: 32 << 20 });
  const idx = stdout.lastIndexOf("\n");
  const text = stdout.slice(0, idx);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（边缘 HTML 错误页）留在 text 里 */
  }
  return { status: Number(stdout.slice(idx + 1)), text, json };
}

// 独立会话，跟真实聊天无关；名字随意但要是 6~36 个 [0-9a-zA-Z-_.]
const CONV = process.env.PROBE_CONV || `probe-autocompact-${Date.now().toString(36)}`;
// 假 chat_id：消息只会尝试发到这里，发不出去 —— 这正是「不打扰真人」的关键
const FAKE_CHAT = "oc_probe0000000000000000000000autocompact";

// 每轮约 7000 字，渲染时被 MAX_MESSAGE_CHARS 钳到 4000；用户消息 + 助手复述
// ⇒ 每轮贡献约 8000 渲染字。判据线是 12 万字，所以约 15 轮越过。
const FILLER = "这是一段用于撑大上下文的中性文本，不含任何指令或问题。".repeat(250);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 30);

const probe = () =>
  curl(`${env.AGENT_URL}?probe=last&token=${env.INTERNAL_TOKEN}&_=${Date.now()}`, {
    headers: { "Makers-Conversation-Id": CONV },
  });

say(`conversation = ${CONV}`);
say(`chatId       = ${FAKE_CHAT}（假的，不会发到真人聊天）`);
say(`进度也写进 ${PROGRESS}\n`);

// ⚠️ 先清零。见文件头：计数器按实例算，不清零就可能读到上一轮攒下的值
const cleared = await curl(`${env.AGENT_URL}?probe=last&op=clear&token=${env.INTERNAL_TOKEN}`, {
  headers: { "Makers-Conversation-Id": CONV },
});
say(`清零计数器：${JSON.stringify(cleared.json)}`);

for (let i = 1; i <= MAX_ROUNDS; i++) {
  const t0 = Date.now();
  const res = await curl(`${env.AGENT_URL}?mode=sync`, {
    method: "POST",
    headers: { "content-type": "application/json", "Makers-Conversation-Id": CONV },
    body: JSON.stringify({
      messageId: `om_auto_${Date.now().toString(36)}_${i}`,
      chatId: FAKE_CHAT,
      chatType: "p2p",
      openId: env.FEISHU_DEBUG_OPEN_ID,
      text: `请把下面这段原样复述一遍，不要解释、不要总结：\n${FILLER}\n（这是第 ${i} 轮）`,
      token: env.INTERNAL_TOKEN,
    }),
  });

  // 预期 500（发不出去），这不是失败 —— 压缩在 ask() 里已经跑完了
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const c = (await probe()).json?.counters ?? {};
  say(
    `第 ${String(i).padStart(2)} 轮（${secs}s，agent=${res.status}）：` +
      `compactWanted=${c.compactWanted ?? "?"} autoCompactions=${c.autoCompactions ?? "?"}`,
  );

  if ((c.autoCompactions ?? 0) > 0) {
    say("\n✅ 自动压缩在生产上确实触发并成功了。");
    say(`   compactWanted=${c.compactWanted} → 判据判定该压`);
    say(`   autoCompactions=${c.autoCompactions} → 摘要非空、写回完成`);
    process.exit(0);
  }
  if (res.status !== 500 && !Array.isArray(res.json?.replies)) {
    say(`  ⚠️ 这一轮不是预期的 500：${res.text.slice(0, 200)}`);
  }
}

say(`\n❌ 跑满 ${MAX_ROUNDS} 轮仍未触发。`);
say("   先确认计数器**真的**清成 0 了（不然可能一直在读旧值）；");
say("   再确认这一轮确实跑到了 ask() 里（sessionInputCalls 有没有涨）。");
process.exit(1);
