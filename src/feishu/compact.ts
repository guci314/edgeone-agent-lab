// 手动会话压缩：把一段历史渲染成可读文本 → 交给模型摘要 → 写回一条 message。
//
// ── 为什么单独一个文件，且零依赖 ─────────────────────────────────────
// 平台给的 `openaiSession()` 是 OpenAI Agents SDK 的原生 `Session`，**没有**
// 压缩钩子（原版 CF 的 `compactAfter(200k)` 是 Cloudflare 那侧的私有扩展）。
// 所以压缩只能自己组合 `getItems / clearSession / addItems` 三步。
//
// 这三步里**真正容易错**的部分 —— 历史项怎么变成人话、写回的项长什么形状、
// 什么时候该拒绝压缩 —— 全是纯函数，不需要模型也不需要平台。
// 放到这里，`test/smoke.ts` 就能直接测（那边跑在裸 Node 里，拉不动平台 context）；
// 调模型和读写 session 的那点胶水留在 `agents/feishu/_host.ts`。
//
// 这和当初把宿主能力抽成 `FeishuTurnHost` 接口是同一个动机：
// 把「会错的东西」和「接不上的东西」分开。

/**
 * 少于这么多项就不值得压缩。
 *
 * 3 = 用户问 + 助手答 + 至少再来一条。一两项时摘要不会比原文短，
 * 压缩完反而更难读，而且用户会以为「历史被动了」—— 直接告诉他没什么可压的。
 *
 * 这个门槛顺带让 `/compact` 幂等：压完只剩一条摘要项，再发一次会被挡在这里。
 */
export const MIN_ITEMS_TO_COMPACT = 3;

/** 摘要写回时加的前缀。让后续轮次认得出「这是历史，不是新指令」 */
export const SUMMARY_PREFIX = "以下是此前对话的压缩摘要：";

/** 单条消息的字符上限。用户可能整段贴一坨代码进来，不截断会把整个 transcript 撑爆 */
const MAX_MESSAGE_CHARS = 4_000;

/** 单条工具调用 / 工具结果的字符上限。工具输出动辄上万字，摘要不需要细节 */
const MAX_TOOL_CHARS = 600;

/** 整段 transcript 的字符上限。超了就走头尾保留（见 clampTranscript） */
const MAX_TRANSCRIPT_CHARS = 120_000;

/** 超限时头部保留多少字符，其余留给尾部 */
const HEAD_CHARS = 30_000;

export const SUMMARY_SYSTEM_PROMPT = [
  "你在压缩一段「用户与代码问答助手」的对话记录，供后续轮次当作背景使用。",
  "",
  "要求：",
  "1. 用中文，结构化，不要客套话，不要复述原始对话的逐句内容。",
  "2. 必须保留以下四类信息，其余可以大胆删：",
  "   · 本会话导入过哪些仓库（写成 owner/name@ref），以及导入是否完整；",
  "   · 讨论过的问题和得出的关键结论。**代码位置引用要原样保留**（文件路径、函数名、行号）；",
  "   · 用户表达过的偏好或决定（例如「只看 src/ 下面」「这个分支才是对的」）；",
  "   · 还没做完的事、悬而未决的问题。",
  "3. 记不清的地方就写「未确认」，**不要编**。摘要会被当成事实用。",
  "4. 控制在 800 字以内。",
].join("\n");

/** 把 transcript 包成一次独立的摘要请求 */
export function buildSummaryUserPrompt(transcript: string): string {
  return `以下是对话记录（时间正序，旧 → 新）：\n\n${transcript}`;
}

/**
 * 摘要写回历史的形状。
 *
 * 用 `user` role 而不是 `assistant`：它描述的是「用户这一侧带进来的上下文」，
 * 也避免模型把它当成自己刚才说过的话而继续往下顺。`content` 直接给字符串 ——
 * SDK 的 `UserMessageItem.content` 是 `string | UserContent[]` 两种都收。
 */
export interface SummaryItem {
  role: "user";
  content: string;
}

export function summaryItem(summary: string): SummaryItem {
  return { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary.trim()}` };
}

/** 压缩成功的回执 */
export function compactReply(before: number, chars: number): string {
  return `已压缩：${before} 条历史 → 摘要（约 ${chars} 字）`;
}

/** 把历史项渲染成一段纯文本。认不出的项直接丢掉 */
export function renderTranscript(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const line = renderItem(item);
    if (line) parts.push(line);
  }
  return clampTranscript(parts.join("\n\n"));
}

function renderItem(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, any>;
  // type 缺省当 message —— 平台换实现时可能只给 role/content
  const type = String(o.type ?? "message");

  if (type === "message") {
    const text = clamp(renderContent(o.content), MAX_MESSAGE_CHARS);
    if (!text) return "";
    return `${roleLabel(o.role)}：${text}`;
  }

  if (type === "function_call") {
    return `[调用工具 ${String(o.name ?? "?")}] ${oneLine(String(o.arguments ?? ""), MAX_TOOL_CHARS)}`;
  }

  if (type === "function_call_result") {
    const out = oneLine(renderContent(o.output), MAX_TOOL_CHARS);
    return `[工具 ${String(o.name ?? "?")} 返回] ${out}`;
  }

  // 思考项刻意丢掉：它是模型的中间草稿，又长又吵。
  // 丢它的代价只是摘要少一层推理细节 —— 结论和代码位置都还在正文里。
  if (type === "reasoning") return "";

  return "";
}

function roleLabel(role: unknown): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return String(role ?? "?");
}

/** 消息内容是字符串或内容块数组，两种都收 */
function renderContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, any>;
    const t = String(p.type ?? "");
    if (t === "input_text" || t === "output_text" || t === "text") {
      if (typeof p.text === "string") parts.push(p.text);
    } else if (t === "input_image" || t === "image") {
      parts.push("[图片]");
    } else if (t === "input_file" || t === "file") {
      parts.push(`[文件 ${String(p.filename ?? "")}]`);
    } else if (t === "refusal") {
      parts.push(`[拒绝] ${String(p.refusal ?? "")}`);
    } else if (t === "audio") {
      parts.push("[语音]");
    }
  }
  return parts.join("\n").trim();
}

/** 压成一行并截断（工具输出用） */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…（截断）` : flat;
}

/**
 * 超长字符串保留头尾。
 *
 * 只留头会把「用户最后强调的约束」丢掉，只留尾会把开头那句「这个仓库是干嘛的」
 * 丢掉 —— 而摘要恰恰最需要这两端。中间的部分通常是可以重新问出来的细节。
 */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  return `${s.slice(0, head)}\n…（省略 ${s.length - max} 字）…\n${s.slice(-(max - head))}`;
}

/**
 * 整段 transcript 的超限处理。
 *
 * 头尾各留一段的理由和 `clamp()` 一样，但这里还要多一层：会话**开头**通常是
 * 「导入了哪个仓库」这类一次性事实，后面几十轮都不会再提。只保留尾部的话，
 * 摘要会丢掉仓库坐标 —— 而那是这条链路里最不能丢的东西。
 */
function clampTranscript(s: string): string {
  if (s.length <= MAX_TRANSCRIPT_CHARS) return s;
  const omitted = s.length - MAX_TRANSCRIPT_CHARS;
  return [
    s.slice(0, HEAD_CHARS),
    `……（中间省略约 ${omitted} 字，多为重复的问答往返）……`,
    s.slice(-(MAX_TRANSCRIPT_CHARS - HEAD_CHARS)),
  ].join("\n\n");
}
