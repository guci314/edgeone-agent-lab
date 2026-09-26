// GitHub issue 工具族：`gh_issue_create` / `gh_issue_comment`。
//
// 与 `tools.ts`（ws_* 四件）**分开一个文件、分开一份配置**，理由见 issues.ts
// 的文件头：那是 Contents 权限、这是 Issues 权限，**混用一把 token 会让
// 「改工作区凭证」这个动作意外影响 issue 能力**，反过来也一样。
//
// 只做「开 + 评论」，不做关闭：关闭别人提的 issue 是破坏性且面向他人的操作。
import { tool } from "@openai/agents";
import { z } from "zod";
import { guarded } from "../shared/util.ts";
import { UsageError } from "./client.ts";
import {
  ISSUE_BODY_MAX,
  ISSUE_TITLE_MAX,
  checkRepo,
  commentIssue,
  createIssue,
  type GhIssueConfig,
} from "./issues.ts";

/**
 * 用法错（白名单外、仓库名写错）翻成干净的 `{ error }`。
 * 同 tools.ts 的 `usageError`：被 `guarded` 包成「工具执行失败：」会读起来像
 * 环境坏了，模型可能因此去重试或道歉 —— 而正确反应是换个仓库或告诉用户去配。
 */
async function usageError<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UsageError) return { error: e.message };
    throw e;
  }
}

/** 本地先挡长度，别送上去换一个 422 —— 那种错模型看不出是哪个字段的问题 */
function checkText(title: string, body: string): string | null {
  if (!title) return "标题不能为空。";
  if (title.length > ISSUE_TITLE_MAX) {
    return `标题 ${title.length} 字，超过上限 ${ISSUE_TITLE_MAX} 字。缩短一点。`;
  }
  if (body.length > ISSUE_BODY_MAX) {
    return `正文 ${body.length} 字，超过上限 ${ISSUE_BODY_MAX} 字。分成几条 issue，或者先精简。`;
  }
  return null;
}

const ISSUE_FRAMING =
  "**GitHub issue** —— 会真的发到互联网上的仓库里，**别人看得到**，不是草稿箱。" +
  "只能开到白名单里的仓库；开出去之后你能评论，但**关不掉**。" +
  "所以开之前先跟用户确认标题和要点，别把草稿直接发出去。";

export function makeGithubIssueTools(cfg: GhIssueConfig | null): unknown[] {
  // 没配 token / 没配白名单就一个都不挂 —— 同 ghWorkspaceConfig 的规矩：
  // 配不全就当没配，别挂出一族必然失败的工具让模型反复去试
  if (!cfg) return [];

  const whitelist = cfg.repos.join("、");

  const create = tool({
    name: "gh_issue_create",
    description:
      `在指定的 GitHub 仓库里**新建一条 issue**。${ISSUE_FRAMING}\n` +
      `当前允许的仓库：${whitelist}。\n` +
      `标题 1~${ISSUE_TITLE_MAX} 字。正文用 Markdown，说清楚「问题是什么 / 怎么复现 / 期望什么」。` +
      "开完把链接给用户。",
    parameters: z.object({
      repo: z.string().describe(`"owner/name" 形式，必须在白名单内：${whitelist}`),
      title: z.string().describe(`issue 标题，1~${ISSUE_TITLE_MAX} 字`),
      body: z.string().describe("issue 正文，Markdown"),
    }),
    execute: async ({ repo, title, body }) =>
      guarded(async () => {
        const t = String(title ?? "").trim();
        const b = String(body ?? "").trim();
        const bad = checkText(t, b);
        if (bad) return { error: bad };

        const r = await usageError(() => createIssue(cfg, checkRepo(cfg, repo), t, b));
        if ("error" in r) return r;
        return {
          created: true,
          repo: String(repo).trim().toLowerCase(),
          number: r.number,
          title: r.title,
          issueUrl: r.url,
          note: "issue 已经开出去了，把 issueUrl 给用户。它对外可见，撤回不了。",
        };
      }),
  });

  const comment = tool({
    name: "gh_issue_comment",
    description:
      `给白名单仓库里**已存在**的一条 issue 加评论。${ISSUE_FRAMING}\n` +
      "只加评论，不改标题、不改正文、不关闭。要评论的 issue 号从用户给的链接里取。",
    parameters: z.object({
      repo: z.string().describe(`"owner/name" 形式，必须在白名单内：${whitelist}`),
      number: z.number().describe("issue 编号（就是链接末尾那个数字）"),
      body: z.string().describe("评论正文，Markdown"),
    }),
    execute: async ({ repo, number, body }) =>
      guarded(async () => {
        const n = Number(number);
        // 0 / 负数 / 小数都不是合法 issue 号。本地挡掉，省一轮往返
        if (!Number.isInteger(n) || n < 1) {
          return { error: `issue 号要是一个正整数，收到的是 ${JSON.stringify(number)}。` };
        }
        const b = String(body ?? "").trim();
        if (!b) return { error: "评论正文不能为空。" };
        if (b.length > ISSUE_BODY_MAX) {
          return { error: `评论 ${b.length} 字，超过上限 ${ISSUE_BODY_MAX} 字。精简一点。` };
        }

        const r = await usageError(() => commentIssue(cfg, checkRepo(cfg, repo), n, b));
        if ("error" in r) return r;
        return { commented: true, number: n, commentUrl: r.url, note: "把 commentUrl 给用户。" };
      }),
  });

  return [create, comment];
}
