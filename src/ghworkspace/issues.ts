// 让 agent 能往 **GitHub issue** 里写东西：开 issue、加评论。
//
// ── 为什么是独立的一份配置，不复用 client.ts 那个 ─────────────────────
// `GITHUB_WORKSPACE_TOKEN` 是 fine-grained PAT，**只授了 cf-agent-workspace 的
// Contents 读写**。GitHub 的 Issues API 不属于 Contents 权限范围 —— 拿现有
// token 提 issue 会 403。所以这不是「加个工具」，是**一次扩权**，必须用独立的
// token，否则「改工作区 token」这个动作会意外影响 issue 能力，反之亦然。
//
// ── 为什么只做「开 issue + 评论」，不做关闭 ──────────────────────────
// 开 issue 可逆（能关）；关闭别人提的 issue 是**破坏性且面向他人**的操作，
// agent 误操作一次就影响协作者。和仓库既有约定一致：`ws_rm` 只删文件不删目录，
// `EXCLUDED` 里也刻意排除了 `files_remove`。
//
// ── token 绝不进错误信息 ────────────────────────────────────────────
// 错误信息会被模型读、被飞书卡片渲染、被用户复制出去。所以下面所有错误只带
// **GitHub 自己返回的 message**，绝不回显请求头。`test/smoke.ts` 里有断言钉住。
import { UA } from "../shared/util.ts";
import { UsageError } from "./client.ts";

/** 只为本地测试指向 mock。生产不要设 */
const DEFAULT_API_BASE = "https://api.github.com";

/** 写要落一条记录，比读慢。理由同 client.ts：等的久好过明明能成却报错 */
const WRITE_TIMEOUT_MS = 30_000;

/** 标题/正文的上限。GitHub 标题上限是 256，留点余量；正文给 65536（API 上限） */
export const ISSUE_TITLE_MAX = 250;
export const ISSUE_BODY_MAX = 60_000;

export interface GhIssueConfig {
  token: string;
  /** 白名单：只有这里面列的 "owner/name" 能开 issue。**至少一条，否则视为没配** */
  repos: readonly string[];
  apiBase: string;
}

export interface GhIssueEnv {
  GITHUB_ISSUE_TOKEN?: string;
  /** 逗号分隔的 "owner/name" 白名单 */
  GITHUB_ISSUE_REPOS?: string;
  GITHUB_API_BASE?: string;
}

/**
 * **配不全就当没配**，返回 null —— 和 `ghWorkspaceConfig` 同一条规矩。
 *
 * 白名单为空时**必须**返回 null：没有白名单就意味着「这把 token 能开的仓库
 * 全都能开」，那正是这个功能最不该有的形态。宁可没有工具，也不要挂出一族
 * 能往任意仓库写公开内容的工具。
 */
export function ghIssueConfig(env: GhIssueEnv): GhIssueConfig | null {
  const token = (env.GITHUB_ISSUE_TOKEN ?? "").trim();
  if (!token) return null;

  const repos = (env.GITHUB_ISSUE_REPOS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s));
  if (!repos.length) return null;

  return {
    token,
    // GitHub 的 owner/repo **大小写不敏感**。统一小写存，比对时才不会因为
    // 用户写成 `Guci314/X` 而误判成「不在白名单」
    repos: repos.map((r) => r.toLowerCase()),
    apiBase: (env.GITHUB_API_BASE ?? "").trim().replace(/\/+$/, "") || DEFAULT_API_BASE,
  };
}

/**
 * 白名单校验。不在名单里就抛 `UsageError`（模型自己能纠正，不是环境故障），
 * 并把**允许的仓库名列出来** —— 只说「不允许」模型会去猜或者道歉。
 */
export function checkRepo(cfg: GhIssueConfig, raw: unknown): string {
  const repo = String(raw ?? "").trim().toLowerCase();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new UsageError(`仓库名要写成 "owner/name" 的形式，收到的是 ${JSON.stringify(raw)}。`);
  }
  if (!cfg.repos.includes(repo)) {
    throw new UsageError(
      `${repo} 不在允许开 issue 的仓库白名单里。当前白名单：${cfg.repos.join("、")}。` +
        `要加仓库得改 EdgeOne 的 GITHUB_ISSUE_REPOS 环境变量，这是配置改动，不是你能自己解决的。`,
    );
  }
  return repo;
}

interface GhIssue {
  number: number;
  url: string;
  title: string;
}

async function req(
  cfg: GhIssueConfig,
  repo: string,
  path: string,
  init: { method: string; body?: string },
  timeoutMs: number,
): Promise<Response> {
  const url = `${cfg.apiBase}/repos/${repo}${path}`;
  try {
    return await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as Error).name;
    throw new Error(
      name === "TimeoutError" || name === "AbortError"
        ? `连接 GitHub 超时（等了 ${Math.round(timeoutMs / 1000)} 秒）`
        : `连不上 GitHub：${(e as Error).message}`,
    );
  }
}

/**
 * 把失败响应翻译成「下一步该怎么做」。每种状态码指向**不同的动作**。
 *
 * ⚠️ 只提取响应体里的 `message`，**永远不碰请求头** —— token 泄漏面就在这里。
 */
async function fail(res: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const j = (await res.json()) as { message?: string };
    detail = String(j.message ?? "").slice(0, 200);
  } catch {
    /* 不是 JSON 就算了，不影响下面的判断 */
  }
  const suffix = detail ? `（GitHub 说：${detail}）` : "";

  if (res.status === 401) {
    throw new Error(`GitHub 拒绝了这个凭证：PAT 无效、已过期或被撤销。这需要人去重新生成并更新环境变量。${suffix}`);
  }
  if (res.status === 403) {
    const limited = res.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(
      limited
        ? `GitHub 限流了，过一会儿再试。${suffix}`
        : `${what}需要这把 PAT 有 Issues: Read and write 权限。现在被拒了 —— 这是配置问题，不是你能自己解决的。${suffix}`,
    );
  }
  if (res.status === 404) {
    // 和 client.ts 同一个坑：GitHub 对「仓库不存在」「PAT 没授权访问它」**故意**
    // 都回 404，避免泄漏私有仓库是否存在。所以三种可能都要列出来。
    throw new UsageError(
      `${what}：GitHub 回 404。可能是①仓库名写错了；②它不在白名单里；` +
        `③这把 PAT 没有被授权访问这个仓库。GitHub 故意让这几种情况回同一个码。${suffix}`,
    );
  }
  if (res.status === 410) {
    throw new UsageError(`${what}：这个 issue 被锁定了，不能再评论。${suffix}`);
  }
  if (res.status === 422) {
    throw new UsageError(`${what}：GitHub 拒绝了内容（多半是标题或正文格式/长度不合规）。${suffix}`);
  }
  throw new Error(`GitHub 返回 HTTP ${res.status}${suffix}`);
}

/** 开一条 issue。返回 number 和网页链接 */
export async function createIssue(
  cfg: GhIssueConfig,
  repo: string,
  title: string,
  body: string,
): Promise<GhIssue> {
  const res = await req(
    cfg,
    repo,
    "/issues",
    { method: "POST", body: JSON.stringify({ title, body }) },
    WRITE_TIMEOUT_MS,
  );
  if (!res.ok) await fail(res, "开 issue");
  const j = (await res.json()) as { number?: number; html_url?: string; title?: string };
  const number = Number(j.number ?? 0);
  if (!number || !j.html_url) {
    throw new Error("GitHub 没有返回 issue 编号/链接，内容可能没写进去。别把链接给用户。");
  }
  return { number, url: String(j.html_url), title: String(j.title ?? title) };
}

/** 给已有 issue 加一条评论 */
export async function commentIssue(
  cfg: GhIssueConfig,
  repo: string,
  number: number,
  body: string,
): Promise<{ url: string }> {
  const res = await req(
    cfg,
    repo,
    `/issues/${number}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
    WRITE_TIMEOUT_MS,
  );
  if (!res.ok) await fail(res, `给 issue #${number} 加评论`);
  const j = (await res.json()) as { html_url?: string };
  if (!j.html_url) throw new Error("GitHub 没有返回评论链接，内容可能没写进去。");
  return { url: String(j.html_url) };
}
