// 模型出站请求/入站响应的**环形记录器**。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// 「bot 回『没答上来：400 status code (no body)』」这类错误最难查：
// 错误信息是 SDK 包装过的（`400 status code (no body)` 只说了状态码），
// 而**真正的原因在出站请求里** —— 工具 schema 不合法、请求体超限、
// 多带了某个网关不认的参数，都会表现为一个光秃秃的 400。
//
// 本地用同样的 SDK + 同样的模型复现时又是 200（因为本地没有沙箱工具、
// 没有仓库语料），所以「本地能跑通」根本不能排除问题。
//
// 办法：在模型客户端上挂一层 fetch，把出站 body 的**形状**和入站响应
// 原文记下来，再用 `?probe=last` 取出来看。这样排查用的是**线上真实报文**，
// 不是推测。
//
// ⚠️ 只记形状 + 截断片段，不记完整 body（可能含仓库语料/用户提问）。
// 也**不记 Authorization 头**。

export interface DiagEntry {
  /** 记录时间（epoch ms） */
  t: number;
  /** 出站：请求形状 */
  req: {
    url: string;
    /** body 顶层字段名 */
    keys: string[];
    model?: string;
    stream?: boolean;
    messageCount?: number;
    /** 工具名列表 —— 400 的头号嫌疑 */
    toolNames?: string[];
    /** 工具 JSON Schema 总字符数（超限会 400） */
    toolsJsonChars?: number;
    /** 整个 body 的字符数 */
    bodyChars?: number;
    /** body 开头片段，用来肉眼看格式 */
    head?: string;
    /**
     * 消息序列的**压缩表示**：`s`=system `u`=user `a`=assistant `t`=tool
     * 后缀 `*` 表示这条 assistant 带 tool_calls。例：`s u a* t u`
     *
     * 为什么要有它：400 常常只在「历史里多了某种消息」之后才出现，
     * 而 bodyChars 这种总量指标看不出来 —— 得看**结构**变了没有。
     */
    msgRoles?: string;
    /** 最后 3 条消息各自有哪些字段（用来发现多带了不该带的键） */
    tailMsgs?: { role?: string; keys: string[]; contentChars: number; hasToolCalls: boolean }[];
    /**
     * 所有 assistant 消息里出现过的字段名**并集**。
     *
     * 关键用途：DeepSeek 系的模型响应里带 `reasoning_content`，
     * 如果这一层被原样回传，某些网关会直接 400。
     * 看到 assistant 的键里有 `reasoning_content` 就基本能定位。
     */
    assistantKeys?: string[];
  };
  /** 入站：响应 */
  res: {
    status: number;
    ok: boolean;
    /** 非 2xx 时保留完整正文（通常很短），2xx 只留开头 */
    text: string;
    ms: number;
    /** 响应头里的 request-id 之类，方便找上游对账 */
    reqId?: string | null;
  };
  /** 第几次尝试（0 = 第一次）。>0 说明前面失败过 */
  attempt?: number;
  /** 这一条是「即将重试」而非最终结果 */
  retried?: boolean;
}

const MAX_ENTRIES = 8;
const ring: DiagEntry[] = [];

/**
 * 模块级计数器，`?probe=last` 会带出来。
 *
 * 存在的理由：`sessionInputCallback` 是个**可选**钩子 —— 如果名字写错或
 * SDK 版本不认，它会**静默不生效**，而症状只是「偶尔还是 400」，
 * 根本分不出是钩子没挂上还是别的原因。
 *
 * 所以给它一个能被观察的副作用：每被调用一次就 +1。
 * 只要 `sessionInputCalls > 0`，就证明钩子确实挂上了。
 */
export const diagCounters = {
  /** 历史消毒钩子被调用次数（>0 = 钩子生效） */
  sessionInputCalls: 0,
  /** 累计丢掉的孤儿 tool 消息数 */
  droppedOrphanTools: 0,
  /** 累计丢掉的空 assistant 消息数 */
  droppedEmptyAssistants: 0,
};

export function resetCounters(): void {
  diagCounters.sessionInputCalls = 0;
  diagCounters.droppedOrphanTools = 0;
  diagCounters.droppedEmptyAssistants = 0;
}

export function recentDiag(): DiagEntry[] {
  // 新的在前
  return [...ring].reverse();
}

export function clearDiag(): void {
  ring.length = 0;
}

function summarizeReq(url: string, body: unknown): DiagEntry["req"] {
  // keys 声明成必填（有它就说明 body 是对象），非对象时给空数组占位
  const out: DiagEntry["req"] = { url, keys: [] };
  if (!body || typeof body !== "object") {
    out.head = typeof body === "string" ? body.slice(0, 300) : String(body ?? "").slice(0, 300);
    return out;
  }
  const b = body as Record<string, any>;
  out.keys = Object.keys(b);
  out.model = b.model;
  out.stream = b.stream;
  if (Array.isArray(b.messages)) {
    out.messageCount = b.messages.length;
    out.msgRoles = b.messages
      .map((m: any) => {
        const c = m?.role === "system" ? "s" : m?.role === "user" ? "u" : m?.role === "assistant" ? "a" : m?.role === "tool" ? "t" : "?";
        return Array.isArray(m?.tool_calls) && m.tool_calls.length ? `${c}*` : c;
      })
      .join(" ");
    out.tailMsgs = b.messages.slice(-3).map((m: any) => ({
      role: m?.role,
      keys: Object.keys(m ?? {}),
      contentChars: typeof m?.content === "string" ? m.content.length : 0,
      hasToolCalls: Array.isArray(m?.tool_calls) && m.tool_calls.length > 0,
    }));
    const ak = new Set<string>();
    for (const m of b.messages) {
      if (m?.role === "assistant") for (const k of Object.keys(m)) ak.add(k);
    }
    out.assistantKeys = [...ak].sort();
  }
  if (Array.isArray(b.tools)) {
    out.toolNames = b.tools.map((t: any) => t?.function?.name ?? t?.name ?? "?").slice(0, 40);
    try {
      out.toolsJsonChars = JSON.stringify(b.tools).length;
    } catch {
      /* 循环引用等，忽略 */
    }
  }
  try {
    const s = JSON.stringify(b);
    out.bodyChars = s.length;
    out.head = s.slice(0, 600);
  } catch {
    /* 忽略 */
  }
  return out;
}

/**
 * 哪些失败值得重试。
 *
 * ⚠️ OpenAI SDK **自带的重试不管 400**（它只重 408/409/429/5xx）。而实测
 * OpenCode Go 会**间歇性**返回 400，响应体还是个残缺对象
 * `{"model":"deepseek-v4.1-flash"}` —— 既没有 `error` 也没有 `code`，
 * 看着像上游抖了一下就把连接掐了。这种 400 原样透给用户，就是
 * 「没答上来：400 status code (no body)」。
 *
 * 判据（三条任一）：
 *   · 5xx / 429        —— 常规可重试
 *   · 400 + 正文不是合法 JSON  —— 多半是被截断的残包
 *   · 400 + 正文是 JSON 但没有 error/code 字段 —— 观察到的那种残缺对象
 *
 * 真·参数错误的 400 会带 `error`/`code`，不会命中，所以不会白重试。
 */
function isRetryable(status: number, text: string): boolean {
  if (status >= 500 || status === 429 || status === 408) return true;
  if (status !== 400) return false;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object" && (j.error || j.code || j.message)) return false;
    return true; // 合法 JSON 但没有错误描述 → 残缺对象
  } catch {
    return true; // 不是合法 JSON → 残包
  }
}

/** 重试的退避毫秒数；长度 = 最多重试几次 */
const RETRY_BACKOFF_MS = [600, 1500];

/**
 * 模型调用专用 fetch：**记录 + 重试**。
 *
 * 两件事放一起是因为都要在「拿到响应但还没交给 SDK」这一刻做判断，
 * 拆成两层反而要 clone 两次。
 *
 * @param opts.onFailure 只在最终失败时回调一次（用于落到会话 KV，
 *   这样换个实例也能用 `?probe=last` 看到 —— 内存环形缓冲做不到）。
 */
export function modelFetch(
  opts: { inner?: typeof fetch; onFailure?: (e: DiagEntry) => void } = {},
): typeof fetch {
  const inner = opts.inner ?? fetch;
  return (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* 非 JSON，原样留着 */
      }
    }
    const reqSummary = summarizeReq(url, body);

    // 只有 body 是字符串（OpenAI SDK 就是这么发的）才能安全重放
    const replayable = typeof init?.body === "string";

    for (let attempt = 0; ; attempt++) {
      const entry: DiagEntry = {
        t: Date.now(),
        req: reqSummary,
        attempt,
        res: { status: 0, ok: false, text: "", ms: 0 },
      };
      const t0 = Date.now();

      let res: Response;
      try {
        res = await inner(input, init);
      } catch (e) {
        entry.res = {
          status: 0,
          ok: false,
          text: `fetch 抛错: ${(e as Error).name}: ${(e as Error).message}`,
          ms: Date.now() - t0,
        };
        push(entry);
        // 网络层异常也重试（连不上 ≠ 请求本身有问题）
        if (replayable && attempt < RETRY_BACKOFF_MS.length) {
          await sleep(RETRY_BACKOFF_MS[attempt]);
          continue;
        }
        opts.onFailure?.(entry);
        throw e;
      }

      entry.res.ms = Date.now() - t0;
      entry.res.status = res.status;
      entry.res.ok = res.ok;
      try {
        entry.res.reqId =
          res.headers.get("x-request-id") ?? res.headers.get("x-tt-logid") ?? res.headers.get("cf-ray") ?? null;
      } catch {
        /* 忽略 */
      }

      if (res.ok) {
        // 成功的响应体可能很大，不读（clone 也不读，避免额外内存）
        entry.res.text = "(ok，未读取正文)";
        push(entry);
        return res;
      }

      // 失败：读正文用于判断 + 诊断
      try {
        entry.res.text = (await res.clone().text()).slice(0, 1200);
      } catch {
        entry.res.text = "(读响应正文失败)";
      }
      push(entry);

      if (replayable && attempt < RETRY_BACKOFF_MS.length && isRetryable(res.status, entry.res.text)) {
        entry.retried = true;
        await sleep(RETRY_BACKOFF_MS[attempt]);
        continue;
      }

      opts.onFailure?.(entry);
      return res;
    }
  }) as typeof fetch;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function push(e: DiagEntry): void {
  ring.push(e);
  while (ring.length > MAX_ENTRIES) ring.shift();
}
