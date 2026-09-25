// 工具装配。
//
// ── 现在的四个来源（2026-09-25 改成通用助手之后）────────────────────
//   makeSearchTools(env)               → web_search                  （自己实现，serper，见 _search.ts）
//   context.tools.*                    → 平台内置沙箱工具            （见下）
//   src/feishu/docs.ts                 → feishu_doc_read / feishu_sheet_read / feishu_bitable_read
//   src/feishu/global-memory.ts        → remember_fact / forget_fact / recall_facts
//
// ── 原版（cf-agent-lab）有四个来源，两个已不在 ──────────────────────
//   makeWorkspaceTools(repo)           → read / ls / grep / find      ← **已删除**
//   makeGithubTools(ghworkspace)       → ws_ls / ws_read / ws_write   ← 未移植
//     （前者读用户导入的仓库快照，随仓库层一起删；后者见 docs/01-架构与移植映射.md）
//
// ── 为什么平台工具能替掉原版的 run_python 族 ────────────────────────
// EdgeOne 的 `context.tools` 把沙箱能力原子化成了 14 个工具，其中我们需要的：
//   · code_interpreter    ← 替掉原版接 Judge0 / 阿里云沙箱的 run_python
//   · commands            ← 原版没有的能力（能跑 shell）
//   · files_* / browser_* ← 原版没有。files_* 是**沙箱里的**临时工作目录，
//                           不是用户的磁盘，也不是长期存储（见 _instructions.ts 里那句）
//
// ⚠️ **`web_search` 一开始也是从平台拿的，后来换成了自建**（见 `_search.ts`）：
// 平台那个底层是腾讯云 WSA，本项目没配 `WSA_API_KEY`，一调就报
// `web_search requires the WSA_API_KEY environment variable.` —— 是坏的。
// 所以 `platformTools()` 多了一个 `extraExcluded` 参数：自建的那个挂上时，
// 必须把平台这个同名的摘掉，否则模型可能选中坏的。
//
// ⚠️ 工具名的来源是官方文档《Using the Agent Framework》里的表。它列的名字是
// `commands` / `files_read` / ... / `code_interpreter` / `web_search`。
// 这些名字是模型用来选工具的唯一依据，写错就等于工具不存在 ——
// 部署后请对着本地 `/agent-metrics` 面板确认一遍实际注册的名字。
// （`web_search` 现在是我们自己挂的那个，名字故意保持一样，模型无需知道来源变了。）

/** `context.tools` 的形状（平台注入，无类型声明可用，这里按文档收窄） */
export interface PlatformTools {
  all(): unknown[];
  get(name: string): unknown;
  files(): unknown[];
  browser(): unknown[];
}

/**
 * 平台工具里我们不挂的那几个。
 *
 * `browser_*` 那几个是「点页面元素」的操作类工具：模型在飞书里答一个问题，
 * 没机会跟人来回确认点击目标，挂了只会让它乱点一通。要读网页用 `browser_fetch`。
 * `files_remove` 是删文件 —— 沙箱本来就会过期，不需要模型手动清理，
 * 留着反而多一个误删自己刚写的数据的机会。
 */
const EXCLUDED = new Set([
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_evaluate",
  "files_remove",
]);

/**
 * 把平台沙箱工具收进来。
 *
 * 用 `all()` 而不是 `files()` + 单独 get —— 因为我们几乎要全套（除了上面那几个）。
 * 用 `get()` 逐个点名的话，哪天平台加了新工具，这里不会自动跟上。
 *
 * `SANDBOX_ENABLED` 设成 0/false/off 时整条不挂：部署时想先把「纯搜索问答」
 * 跑通、把沙箱留到后面再开，这个开关有用。
 *
 * ⚠️ env 的类型是 `{ SANDBOX_ENABLED?: string }` 而不是 `Record<string, string|undefined>`：
 * 接口类型没有索引签名，不能直接赋给 Record，那样调用方每次都得加断言。
 */
export function platformTools(
  context: { tools?: PlatformTools },
  env: { SANDBOX_ENABLED?: string },
  /**
   * 额外要摘掉的工具名。
   *
   * 目前只有一个用处：我们自己挂了 `web_search`（见 `_search.ts`）时，
   * 把平台内置的同名工具摘掉 —— 两个同名同用途的工具同时在列表里，
   * 模型选哪个全看运气，而内置那个在本项目里是**坏的**（缺 WSA_API_KEY）。
   * 官方文档接第三方搜索时也要求这么做。
   */
  extraExcluded: readonly string[] = [],
): unknown[] {
  const flag = String(env.SANDBOX_ENABLED ?? "1").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return [];

  const bag = context.tools;
  if (!bag || typeof bag.all !== "function") return [];

  const skip = new Set([...EXCLUDED, ...extraExcluded]);

  try {
    return bag
      .all()
      .filter((t) => !skip.has(String((t as { name?: unknown })?.name ?? "")));
  } catch {
    // 平台工具拿不到不该让整个 Agent 起不来 —— 搜索和云文档是主路径，沙箱是增强
    return [];
  }
}

/**
 * 把工具结果的形状压成**一行**给飞书卡片看。
 *
 * 卡片是给人在手机上看的，工具的完整返回值动辄几千字 —— 全倒进去会把真正的
 * 回答淹掉，而且飞书卡片本来就不适合读长文本。所以每类结果只挑最值得看的字段。
 *
 * 这段是从原版 server.ts 的 summarizeToolOutput 搬过来的，分支顺序是踩出来的，
 * 不是想出来的：
 *   · 先看 `error`：自己实现的那些工具（搜索 / 云文档 / 记忆）失败时返回的就是它
 *   · 再看 `ok === false`：**平台沙箱工具**失败时返回的是 `{ok:false, status, stderr}`，
 *     没有 `error` 字段。只看 error 会把它们判成成功，卡片上出现一个骗人的 ✅
 *   · 然后 stdout 首行：code_interpreter / commands 的主要产出
 */
export function summarizeToolOutput(output: unknown): string {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.error === "string") return `失败：${o.error.slice(0, 80)}`;
    if (o.ok === false) {
      const why = String(o.status ?? "").trim();
      const err = typeof o.stderr === "string" ? o.stderr.trim().split("\n").pop() ?? "" : "";
      return `失败：${(why || err || "见详情").slice(0, 80)}`;
    }
    if (typeof o.stdout === "string" && o.stdout.trim()) {
      return o.stdout.trim().split("\n")[0].slice(0, 100);
    }
    if (typeof o.matchCount === "number") return `命中 ${o.matchCount} 条`;
    if (Array.isArray(o.paths)) return `${o.paths.length} 个路径`;
    if (Array.isArray(o.entries)) return `${o.entries.length} 个条目`;
    if (typeof o.totalLines === "number") return `共 ${o.totalLines} 行`;

    // 自建 web_search（见 _search.ts）。字段名 results 是它独有的，
    // 不会和上面任何一个撞。空数组走 else 分支，卡片上显示「无结果」
    if (Array.isArray(o.results)) return o.results.length ? `${o.results.length} 条结果` : "无结果";

    // 云文档那三个工具（见 src/feishu/docs.ts）。字段名是各自独有的，
    // 特意挑的：不跟上面那些重名，免得卡片上把「表格 3 行」显示成「3 个条目」。
    // ⚠️ 顺序要紧 —— `count` 太通用（多维表格记录数），必须排在最后，
    // 否则会抢在更具体的字段（totalChars / rowCount / tableList）前面命中
    if (typeof o.totalChars === "number") {
      return o.truncated ? `文档共 ${o.totalChars} 字（还没读完）` : `文档 ${o.totalChars} 字`;
    }
    if (typeof o.rowCount === "number") return `表格 ${o.rowCount} 行`;
    if (Array.isArray(o.tableList)) return `${o.tableList.length} 张数据表`;
    if (typeof o.count === "number") return `${o.count} 条记录`;
  }
  return "完成";
}

/** 工具结果是成功还是失败。和上面同一套判据，两处必须一起改 */
export function toolFailed(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return "error" in o || o.ok === false;
}
