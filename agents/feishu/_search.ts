// 联网搜索工具：`web_search`，底层走 serper（Google 结果）。
//
// ── 为什么要自己写，而不用平台内置的那个 ─────────────────────────────
// 平台内置的 `web_search` 底层是**腾讯云联网搜索（WSA）**，官方要求项目里配
// `WSA_API_KEY`，没配时一调就报：
//   web_search requires the WSA_API_KEY environment variable.
//   Set it to a valid Tencent Cloud Web Search (WSA) API key before calling web_search.
//
// 实测确认过：本项目的环境变量里从来没有这个键，所以这个工具一直是**坏的**
// （模型还会因为工具存在而先试一次、失败、再改用 browser_fetch，白烧一轮）。
//
// WSA 要单独开通、单独付费，而 serper 的 key 是现成的，所以换成它。
// 官方文档也把这条列为推荐做法：接第三方搜索时，把内置 `web_search`
// **从工具列表里过滤掉**，免得模型看到两个同名同用途的工具。
//
// ⚠️ 过滤这件事不能只在注释里说 —— 见 `_tools.ts` 的 `platformTools()`
// 第三个参数，和 `_host.ts` 里那行 `searchTools.length ? ["web_search"] : []`。
//
// ── 契约（和其它工具一致）──────────────────────────────────────────
// · 永不抛错：异常一律转成 `{ error }`，让模型自己看到并调整
// · 返回值序列化成 JSON 字符串（见 src/workspace/tools.ts 文件头的 ⚠️）
// · 搜到 0 条**不是错误**，返回空数组 + 一句提示，否则模型会反复重试同一个词

import { tool } from "@openai/agents";
import { z } from "zod";
import { guarded } from "../../src/workspace/tools.ts";

const SERPER_URL = "https://google.serper.dev/search";

/**
 * 单次搜索的超时。15 秒是原版（cf-agent-lab）的值，照搬 —— 那边实测够用，
 * 而且模型一个回合可能要搜两三次，单次拖太久会顶到平台的整体时限。
 */
const TIMEOUT_MS = 15_000;

/** serper 按条计费，卡上限。参数里也会再收窄一次 */
const MAX_RESULTS = 10;

/** 摘要截断长度。原版 300，够模型判断这条值不值得点开，又不至于把上下文吃光 */
const MAX_SNIPPET = 300;

/** 关键词长度上限，防止模型把一整段问题当查询词发过去 */
const MAX_QUERY_CHARS = 200;

interface SearchEnv {
  SERPER_API_KEY?: string;
}

interface SerperResponse {
  organic?: { title?: string; link?: string; snippet?: string }[];
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * 装配搜索工具。
 *
 * **没配 key 时返回空数组**（而不是挂一个永远报错的工具）——
 * 挂上去只会让模型每轮都先撞一次墙。这和 `platformTools()` 在
 * `SANDBOX_ENABLED=0` 时的处理是同一个思路。
 */
export function makeSearchTools(env: SearchEnv): unknown[] {
  const apiKey = String(env.SERPER_API_KEY ?? "").trim();
  if (!apiKey) return [];

  return [
    tool({
      name: "web_search",
      description:
        "用 Google 搜索公开网页，返回若干条 {title, link, snippet}。" +
        "涉及最新信息、你不确定的事实、或需要给出处时用它。" +
        "只能搜公网；仓库里的内容要用 grep / find，不要拿它当仓库搜索用。" +
        "结果里的 link 是真实可访问地址，引用时把它给出来。",
      parameters: z.object({
        query: z.string().describe("搜索关键词，越具体越好"),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe(`要几条结果，默认 5，最多 ${MAX_RESULTS}`),
      }),
      execute: async ({ query, maxResults }) =>
        json(
          await guarded(async () => {
            const q = String(query ?? "").trim().slice(0, MAX_QUERY_CHARS);
            if (!q) return { error: "query 不能为空" };

            // 模型经常把数字发成字符串，也可能给 0 或负数
            const n = Math.min(Math.max(Math.trunc(Number(maxResults) || 5), 1), MAX_RESULTS);

            let res: Response;
            try {
              res = await fetch(SERPER_URL, {
                method: "POST",
                headers: {
                  "X-API-KEY": apiKey,
                  "content-type": "application/json",
                },
                body: JSON.stringify({ q, num: n }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
              });
            } catch (e) {
              const name = (e as Error).name;
              return {
                error: `搜索请求失败：${name === "TimeoutError" ? `超过 ${TIMEOUT_MS / 1000} 秒未响应` : (e as Error).message}`,
              };
            }

            if (!res.ok) {
              // 401/403 = key 无效或额度用尽，这两种要如实说，
              // 否则模型会把「搜不到」当成「世上没有」
              const hint =
                res.status === 401 || res.status === 403
                  ? "（SERPER_API_KEY 无效或额度用尽，先告诉用户搜索不可用）"
                  : "";
              return { error: `搜索接口返回 HTTP ${res.status}${hint}` };
            }

            let data: SerperResponse;
            try {
              data = (await res.json()) as SerperResponse;
            } catch {
              return { error: "搜索接口返回的不是合法 JSON" };
            }

            const results = (data.organic ?? []).slice(0, MAX_RESULTS).map((r) => ({
              title: r.title ?? "",
              link: r.link ?? "",
              snippet: (r.snippet ?? "").slice(0, MAX_SNIPPET),
            }));

            // 空结果不是错误，但要明说「别再试同一个词」—— 不写清楚，
            // 模型会因为一个空结果连搜三次一模一样的查询（原版踩过）
            if (!results.length) {
              return { results: [], hint: "没有搜到结果。换个关键词再试，不要重复同一个查询。" };
            }
            return { results };
          }),
        ),
    }),
  ];
}
