// 会话历史消毒：清掉**孤儿工具消息**，让历史始终是模型能接受的结构。
//
// ── 为什么需要它（2026-09-25 实测的坑）────────────────────────────────
// 现象：某个会话问着问着就开始**稳定**回「没答上来：400 status code (no body)」，
// 换任何问题都一样，`?probe=last` 显示三次重试（attempt 0/1/2）全部 400，
// 响应体还是个残缺对象 `{"model":"deepseek-v4.1-flash"}`。
// 但**同一个问题在别的会话里完全正常**，`/clear` 之后本会话也立刻恢复正常。
//
// 看请求里的角色序列才明白：
//
//   s t t a u a* t a u a u u a a u u a u a a u a u u a a u ...
//
// 以 `s t t` 开头 —— **system 后面直接跟了两条 tool 消息**。
// 而 tool 消息（`role:"tool"`）在协议上**必须**紧跟在一条带
// `tool_calls` 的 assistant 消息后面，用 `tool_call_id` 对应上。
// 孤立的 tool 消息是非法结构，网关直接 400。
//
// 为什么会变成这样：会话历史是**按窗口**取的（`getItems(limit)` 返回最近 N 条）。
// 一旦窗口从「一对 tool_calls / tool 结果」的中间切开，开头就会剩下
// 一条没有对应 assistant 的 tool 消息。之后每一轮都带着这个非法开头，
// 于是**永久 400** —— 这就是「一个会话被毒死、再也救不回来」的机制。
//
// ── 修法 ────────────────────────────────────────────────────────────
// 在把历史交给模型之前走一遍这个函数：
//   · 维护「已被 assistant 声明但还没被消费」的 tool_call_id 集合；
//   · tool 消息只有在集合里才保留（消费掉），否则丢弃；
//   · 顺手丢掉「既没文本也没工具调用」的空 assistant 消息。
//
// 丢弃孤儿 tool 消息会**损失一点上下文**（那次工具调用确实发生过），
// 但换来的是请求合法 —— 而原来的做法是整轮直接失败。
//
// ⚠️ 这个函数是**纯函数**，不碰网络也不碰存储，所以能单测。

/** 只描述我们真正用到的字段；其余原样透传 */
export interface ChatLikeItem {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string }[];
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface SanitizeResult<T> {
  items: T[];
  /** 丢掉的孤儿 tool 消息数 */
  droppedOrphanTools: number;
  /** 丢掉的空 assistant 消息数 */
  droppedEmptyAssistants: number;
}

function hasVisibleContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content != null;
}

/**
 * 消毒会话历史。
 *
 * 保持**原有顺序**，只做删除 —— 不重排、不改写内容，
 * 免得引入更难查的问题。
 */
export function sanitizeHistory<T extends ChatLikeItem>(items: readonly T[]): SanitizeResult<T> {
  const out: T[] = [];
  // 已被 assistant 声明、等待 tool 结果来消费的 callId
  const pending = new Set<string>();
  let droppedOrphanTools = 0;
  let droppedEmptyAssistants = 0;

  for (const it of items) {
    const role = it?.role;

    if (role === "assistant") {
      const calls = Array.isArray(it.tool_calls) ? it.tool_calls : [];
      // 先登记：后面来的 tool 消息要靠它认领
      for (const c of calls) {
        if (c && typeof c.id === "string" && c.id) pending.add(c.id);
      }
      // 空 assistant（无文本、无工具调用）没有信息量，且部分网关会挑刺
      if (calls.length === 0 && !hasVisibleContent(it.content)) {
        droppedEmptyAssistants++;
        continue;
      }
      out.push(it);
      continue;
    }

    if (role === "tool") {
      const id = typeof it.tool_call_id === "string" ? it.tool_call_id : "";
      // 认领不到「声明方」的就是孤儿 —— 正是那个让请求永久 400 的东西
      if (!id || !pending.has(id)) {
        droppedOrphanTools++;
        continue;
      }
      pending.delete(id);
      out.push(it);
      continue;
    }

    // system / user / 其它：原样保留
    out.push(it);
  }

  return { items: out, droppedOrphanTools, droppedEmptyAssistants };
}

/**
 * 给 `run()` 的 `sessionInputCallback` 用：消毒历史 + 拼上本轮输入。
 *
 * 语义要和 SDK 的默认行为一致（历史在前、本轮在后），
 * 只是中间插了一道过滤。
 */
export function sanitizeAndAppend<T extends ChatLikeItem>(
  history: readonly T[],
  newItems: readonly T[],
  onDrop?: (r: Omit<SanitizeResult<T>, "items">) => void,
): T[] {
  const r = sanitizeHistory(history);
  if (r.droppedOrphanTools || r.droppedEmptyAssistants) {
    onDrop?.({ droppedOrphanTools: r.droppedOrphanTools, droppedEmptyAssistants: r.droppedEmptyAssistants });
  }
  return [...r.items, ...newItems];
}
