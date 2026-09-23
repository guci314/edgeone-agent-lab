// 工具装配。
//
// ── 原版有四个来源 ──────────────────────────────────────────────────
//   makeTools(env)                     → web_search / fetch_page（自己写的抓页）
//   makeWorkspaceTools(repo)           → read / ls / grep / find
//   makeSandboxTools(repo, env, warm)  → run_python / install_python_package
//   makeGithubTools(ghworkspace)       → ws_ls / ws_read / ws_write / ws_delete
//
// ── EdgeOne 版变成三个来源 ──────────────────────────────────────────
//   makeWorkspaceTools(repo)           → read / ls / grep / find        （自己实现，见 src/workspace/tools.ts）
//   context.tools.*                    → 平台内置沙箱工具              （替换掉原版的 web_search + run_python 两族）
//   （ghworkspace 未移植，见 docs/01-架构与移植映射.md）
//
// ── 为什么平台工具能替掉两族 ────────────────────────────────────────
// EdgeOne 的 `context.tools` 把沙箱能力原子化成了 14 个工具，其中我们需要的：
//   · web_search      ← 替掉原版自己写的 web_search
//   · code_interpreter← 替掉原版接 Judge0 / 阿里云沙箱的 run_python
//   · commands        ← 原版没有的能力（能跑 shell）
//   · files_* / browser_* ← 原版没有，但正好是「把仓库文件喂进沙箱」的替代品
//
// 换掉之后有一个**真实的能力变化**必须知道：原版的 run_python 有
// `files` 参数，能把仓库里指定文件的内容一起送进沙箱；平台工具没有这个联动，
// 模型要先把文件内容读出来、再写进沙箱（files_write）或直接嵌进代码。
// 这个差别写进了系统提示词，让模型自己走两步。
//
// ⚠️ 工具名的来源是官方文档《Using the Agent Framework》里的表。它列的名字是
// `commands` / `files_read` / ... / `code_interpreter` / `web_search`。
// 这些名字是模型用来选工具的唯一依据，写错就等于工具不存在 ——
// 部署后请对着本地 `/agent-metrics` 面板确认一遍实际注册的名字。

/** `context.tools` 的形状（平台注入，无类型声明可用，这里按文档收窄） */
export interface PlatformTools {
  all(): unknown[];
  get(name: string): unknown;
  files(): unknown[];
  browser(): unknown[];
}

/** 平台工具里我们不挂的那几个。理由：和代码问答无关，挂了只会分散模型的注意力 */
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
 * `SANDBOX_ENABLED` 设成 0/false/off 时整条不挂：部署时想先把「纯代码问答」
 * 跑通、把沙箱留到后面再开，这个开关有用。
 *
 * ⚠️ env 的类型是 `{ SANDBOX_ENABLED?: string }` 而不是 `Record<string, string|undefined>`：
 * 接口类型没有索引签名，不能直接赋给 Record，那样调用方每次都得加断言。
 */
export function platformTools(
  context: { tools?: PlatformTools },
  env: { SANDBOX_ENABLED?: string },
): unknown[] {
  const flag = String(env.SANDBOX_ENABLED ?? "1").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return [];

  const bag = context.tools;
  if (!bag || typeof bag.all !== "function") return [];

  try {
    return bag
      .all()
      .filter((t) => !EXCLUDED.has(String((t as { name?: unknown })?.name ?? "")));
  } catch {
    // 平台工具拿不到不该让整个 Agent 起不来 —— 代码问答是主路径，沙箱是增强
    return [];
  }
}

/**
 * 把工具结果的形状压成**一行**给飞书卡片看。
 *
 * 卡片是给人在手机上看的，工具的完整返回值动辄几千字 —— 全倒进去会把真正的
 * 回答淹掉，而且飞书卡片本来就不适合读长文本。所以每类结果只挑最值得看的字段。
 *
 * 这段是从原版 server.ts 的 summarizeToolOutput 搬过来的，一个分支没动 ——
 * 它的分支顺序是踩出来的，不是想出来的：
 *   · 先看 `error`：我们自己那四个工具失败时返回的就是它
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
  }
  return "完成";
}

/** 工具结果是成功还是失败。和上面同一套判据，两处必须一起改 */
export function toolFailed(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, unknown>;
  return "error" in o || o.ok === false;
}
