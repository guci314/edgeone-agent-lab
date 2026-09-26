// 工作区仓库的读写工具（2026-09-25 从 cf-agent-lab 移植）。
//
// 这一族读写的是 **agent 自己的 GitHub 私有仓库** guci314/cf-agent-workspace
// （可写，每次写都是一次真实 commit），不是用户的任何代码。
//
// 「无需授权」的实现方式：凭证是部署时配好的 fine-grained PAT
// （GITHUB_WORKSPACE_TOKEN，只授予这一个仓库的 Contents 读写），
// 运行时用户**什么都不用做**。没配 token 就一个工具都不挂 ——
// 挂出来只会让模型反复试用一个必然失败的工具。
//
// 与 cf 原版的差异：工具定义从 AI SDK 的 `jsonSchema` 换成 `@openai/agents` 的
// zod（本仓所有工具的统一形状），返回**数组**而不是对象（_host.ts 统一展开数组）。
// 业务逻辑一行没动。
//
// 所有 execute 都过 `guarded`（shared/util.ts）：工具抛错会中断整个工具循环，
// 一律转成 `{ error }` 让模型自己看到并调整。

import { tool } from "@openai/agents";
import { z } from "zod";
import { guarded, utf8Len } from "../shared/util.ts";
import type { GhFile } from "./client.ts";
import {
  COMMIT_MAX_BYTES,
  COMMIT_MAX_FILES,
  UsageError,
  checkPath,
  commitFiles,
  deleteFile,
  getFile,
  listDir,
  putFile,
  type GhWorkspaceConfig,
} from "./client.ts";

// 这几个上限沿用 cf 那边定下的数值：契约一致，模型已有的使用习惯可以直接迁移。
//
// ⚠️ 注意 GitHub Contents API **不支持分段读取** —— 这里的 offset/limit 是在
// 取回全文之后**在本地切片**。它管的是"喂给模型的上下文有多大"，不是省流量。
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;

const LS_DEFAULT_LIMIT = 500;
const LS_MAX_LIMIT = 1000;

/** 写的内容上限。Contents API 本身能收 100MB，卡这里是别让一次工具调用
 *  把内存和模型上下文都撑爆；工作区也不该放这么大的文件。 */
const WRITE_MAX_BYTES = 256 * 1024;

/** 模型经常把数字发成字符串；空串、null、undefined 一律落到默认值 */
function toInt(v: unknown, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * `getFile` 撞到目录、`listDir` 撞到文件时会抛错 —— 但那是**用法错**，不是工具故障。
 * 让 `guarded` 兜住的话消息会带上「工具执行失败：」前缀，读起来像环境坏了，
 * 模型可能因此去重试或道歉；正确的反应是换个工具。所以在这两个形状上
 * 把异常翻成干净的 `{ error }`。
 */
async function usageError<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof UsageError) return { error: e.message };
    throw e;
  }
}

/** 工作区分支。Git Data API 要显式给分支名 */
const BRANCH = "main";

const REPO_FRAMING =
  "**工作区仓库** —— agent 自己的 GitHub 私有仓库，可读写，每次写都是一次真实的 commit。" +
  "它是**你自己的记事本**，不是用户的项目仓库 —— 里面只有你自己写过的内容。" +
  "不要假设里面有别的东西，想确认就先 ws_ls。";

export function makeGithubTools(cfg: GhWorkspaceConfig | null): unknown[] {
  // 没配凭证就一个工具都不挂 —— 挂出来只会让模型反复试用一个必然失败的工具
  if (!cfg) return [];

  const ls = tool({
    name: "ws_ls",
    description:
      `列出${REPO_FRAMING}\n` +
      "path 是仓库内的相对目录，省略时列出仓库根目录。目录名以 / 结尾。" +
      `默认最多返回 ${LS_DEFAULT_LIMIT} 条，目录在前、同级按名称升序。` +
      "如果 path 指向的是文件，会让你改用 ws_read。",
    parameters: z.object({
      path: z.string().optional().describe("目录路径，省略表示仓库根目录"),
      limit: z.number().optional().describe(`最多返回多少条，默认 ${LS_DEFAULT_LIMIT}`),
    }),
    execute: async ({ path, limit }) =>
      guarded(async () => {
        const dir = String(path ?? "")
          .trim()
          .replace(/^\.\/+/, "")
          .replace(/^\/+/, "")
          .replace(/\/+$/, "");
        // 根目录是空串，是合法的；非空才校验
        if (dir) {
          const c = checkPath(dir);
          if (c.error) return { error: c.error };
        }

        const lim = toInt(limit, LS_DEFAULT_LIMIT, 1, LS_MAX_LIMIT);
        const listed = await usageError(() => listDir(cfg, dir));
        if ("error" in listed) return listed;
        const entries = listed;
        // 目录在前、同级按名称升序
        entries.sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
        );

        const truncated = entries.length > lim;
        const shown = truncated ? entries.slice(0, lim) : entries;
        return {
          path: dir || ".",
          entries: shown.map((e) => ({
            name: e.type === "dir" ? e.name + "/" : e.name,
            type: e.type,
            ...(e.type === "file" ? { size: e.size } : {}),
          })),
          count: shown.length,
          truncated,
          ...(shown.length === 0 ? { note: "这个目录是空的" } : {}),
          ...(truncated ? { hint: `只显示了前 ${lim} 条，用 path 缩小到子目录` } : {}),
        };
      }),
  });

  const read = tool({
    name: "ws_read",
    description:
      `读取${REPO_FRAMING}里某个文件的文本内容，返回带行号的内容。\n` +
      "path 是仓库内相对路径，例如 notes/hello.md。" +
      "offset 是起始行号（从 1 开始），limit 是最多读多少行。" +
      `返回内容最多 ${READ_MAX_LINES} 行或 ${READ_MAX_BYTES / 1000}KB，以先到者为准，且绝不返回半行；` +
      "被截断时 truncated=true 并给出 nextOffset，用它继续读下一段。" +
      "⚠️ 超过 1MB 的文件 GitHub 的 Contents API 根本不返回内容，这里会直接报错而不是给你一个空文件。" +
      "工作区不该放这么大的文件。读之前先用 ws_ls 确认路径。",
    parameters: z.object({
      path: z.string().describe("仓库内相对路径，如 notes/hello.md"),
      offset: z.number().optional().describe("起始行号，从 1 开始，默认 1"),
      limit: z.number().optional().describe("最多读多少行，默认读到上限为止"),
    }),
    execute: async ({ path, offset, limit }) =>
      guarded(async () => {
        const c = checkPath(path);
        if (c.error) return { error: c.error };

        const got = await usageError(() => getFile(cfg, c.path));
        // ⚠️ 必须先判 null 再用 `in`：getFile 拿 null 表示「文件不存在」——那是正常
        // 结果而不是异常。对 null 用 `in` 会直接抛 TypeError，于是**读一个不存在的
        // 文件**这条最常见的路径反而变成工具崩溃。（cf 那边第一版就踩过这个。）
        if (got !== null && "error" in got) return got;
        const f = got as GhFile | null;
        if (!f) {
          // ⚠️ 这里不能只说「文件不存在」。`getFile` 的 404 → null 会把**两种完全不同的
          // 情况合并**：路径确实不存在（常见），和"这把 PAT 根本没被授权访问这个仓库"
          // （罕见但致命，比如仓库名配错了）。后者会让每一次读都报"文件不存在"，
          // 把模型引向"去找文件"这个错误方向。所以给一句可自查的提示。
          return {
            error:
              `工作区仓库里没有 ${c.path}。用 ws_ls 看目录，或 ws_write 创建它。` +
              `（自查：如果 ws_ls 连根目录都列不出来，那是凭证没被授权这个仓库，不是文件不存在。）`,
          };
        }
        if (f.binary) {
          return { error: `${c.path} 看起来是二进制文件（${f.size} 字节），读不出文本。` };
        }

        const lines = f.text.split("\n");
        // 结尾换行会切出一个空元素，那不是一行
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

        const totalLines = lines.length;
        const start = toInt(offset, 1, 1, Number.MAX_SAFE_INTEGER);
        const want = toInt(limit, READ_MAX_LINES, 1, READ_MAX_LINES);

        if (totalLines === 0) {
          return { path: c.path, startLine: 1, endLine: 0, totalLines: 0, content: "", truncated: false };
        }
        if (start > totalLines) {
          return {
            path: c.path,
            startLine: start,
            endLine: totalLines,
            totalLines,
            content: "",
            truncated: false,
            note: `起始行超出文件末尾（本文件共 ${totalLines} 行）`,
          };
        }

        const out: string[] = [];
        let bytes = 0;
        let i = start - 1;
        const stop = Math.min(i + want, totalLines);
        let lineClipped = false;

        while (i < stop) {
          const rendered = `${String(i + 1).padStart(6, " ")}\t${lines[i]}`;
          const cost = utf8Len(rendered) + 1;
          if (bytes + cost > READ_MAX_BYTES) break;
          out.push(rendered);
          bytes += cost;
          i++;
        }

        // 第一行就超预算（压缩过的产物常见）。必须吐点东西出去，
        // 否则 truncated + nextOffset 等于原地打转。
        if (out.length === 0 && i < stop) {
          const budget = READ_MAX_BYTES - 40;
          const raw = lines[i];
          const cut = Math.min(raw.length, budget);
          out.push(`${String(i + 1).padStart(6, " ")}\t${raw.slice(0, cut)} …[本行过长，已截断]`);
          i++;
          lineClipped = true;
        }

        const truncated = i < totalLines;
        return {
          path: c.path,
          sha: f.sha,
          startLine: start,
          endLine: i,
          totalLines,
          content: out.join("\n"),
          truncated,
          ...(truncated ? { nextOffset: i + 1 } : {}),
          ...(lineClipped ? { note: "文件里有超长行，已按字节预算截断显示" } : {}),
        };
      }),
  });

  const write = tool({
    name: "ws_write",
    description:
      `在工作区仓库里新建或覆盖一个文件，产生一次**真实的 commit**（用户在 GitHub 上看得见）。\n` +
      "content 是文件的**完整新内容**，不是补丁 —— 要改一处也得给出全文。" +
      "message 是 commit 说明，省略会用一个默认值；写得具体些，之后翻历史时有用。" +
      "sha 通常**不用传**：覆盖已有文件时工具会自己读当前 sha（等于「最后写入者胜」）。" +
      "只有你想防住「别人在我读之后改了这个文件」时才显式传 sha。" +
      `覆盖已有文件前先用 ws_read 看一眼现状，别盖掉别人的改动。上限 ${WRITE_MAX_BYTES / 1024}KB。`,
    parameters: z.object({
      path: z.string().describe("仓库内相对路径，如 notes/hello.md"),
      content: z.string().describe("文件的完整内容"),
      message: z.string().optional().describe("commit 说明，省略则自动生成"),
      sha: z.string().optional().describe("通常省略。只在需要防覆盖时才传"),
    }),
    execute: async ({ path, content, message, sha }) =>
      guarded(async () => {
        const c = checkPath(path);
        if (c.error) return { error: c.error };

        const text = String(content ?? "");
        const bytes = utf8Len(text);
        if (bytes > WRITE_MAX_BYTES) {
          return {
            error: `内容 ${bytes} 字节，超过上限 ${WRITE_MAX_BYTES}。工作区不适合放这么大的文件，拆开写。`,
          };
        }

        const msg = (String(message ?? "").trim() || `agent: write ${c.path}`).slice(0, 200);
        const put = await usageError(() => putFile(cfg, c.path, text, msg, sha));
        if ("error" in put) return put;
        return {
          ok: true,
          path: c.path,
          sha: put.sha,
          commit: put.commit,
          created: put.created,
          bytes,
        };
      }),
  });

  const rm = tool({
    name: "ws_rm",
    description:
      `删除工作区仓库里的一个文件，产生一次**真实的 commit**。\n` +
      "GitHub 上的历史还在，能从提交记录里找回，但别指望这个 —— 删之前先用 ws_ls / ws_read 确认路径。" +
      "不能删目录：Contents API 一次只能删一个文件，目录要逐个文件删。",
    parameters: z.object({
      path: z.string().describe("要删除的文件路径"),
      message: z.string().optional().describe("commit 说明，省略则自动生成"),
    }),
    execute: async ({ path, message }) =>
      guarded(async () => {
        const c = checkPath(path);
        if (c.error) return { error: c.error };

        // 先探一下它是文件还是目录。getFile 撞到目录会抛「是目录不是文件」，
        // 那句话对 ws_read 是对的，对 ws_rm 得换成"目录不能一次删"。
        let f: GhFile | null;
        try {
          f = await getFile(cfg, c.path);
        } catch (e) {
          if (/是目录/.test((e as Error).message)) {
            return {
              error:
                `${c.path} 是目录，不能一次删除。用 ws_ls 列出里面的文件，逐个 ws_rm；` +
                "目录本身会在最后一个文件删掉后消失（git 不跟踪空目录）。",
            };
          }
          throw e;
        }
        if (!f) return { error: `工作区仓库里没有 ${c.path}（先 ws_ls 确认路径）` };

        const msg = (String(message ?? "").trim() || `agent: delete ${c.path}`).slice(0, 200);
        const del = await usageError(() => deleteFile(cfg, c.path, msg, f.sha));
        if ("error" in del) return del;
        return { ok: true, path: c.path, deleted: true, commit: del.commit };
      }),
  });

  // ── ws_commit：一次提交多个文件 ─────────────────────────────────────
  //
  // 为什么需要它：`ws_write` 一次一个文件 = 一个 commit。而 `projects/<名字>/`
  // 下面每个目录都是**一个接自动部署的项目** —— 调一次往往动五六个文件，
  // 那就是五六个 commit、跑五次 CI、部署五次中间态。这个工具把这批合成一个。
  const commit = tool({
    name: "ws_commit",
    description:
      "把**多个文件一次提交**到工作区仓库（一个 commit，不是 N 个）。" +
      "改 `projects/` 下面那些会自动部署的项目时**优先用它** —— " +
      "分成多次 ws_write 会触发多次部署，中间态还可能部署失败。\n" +
      "只送本次改动的文件就行：没提到的文件 GitHub 那边原样保留。" +
      `一次最多 ${COMMIT_MAX_FILES} 个文件 / 合计 ${Math.round(COMMIT_MAX_BYTES / 1024)} KB。`,
    parameters: z.object({
      message: z.string().describe("commit 说明，一句话说清这次改了什么"),
      files: z
        .array(
          z.object({
            path: z.string().describe("仓库内相对路径"),
            content: z.string().describe("文件的完整内容（覆盖式，不是补丁）"),
          }),
        )
        .describe("要写入/覆盖的文件"),
      remove: z.array(z.string()).optional().describe("要删除的路径，可选"),
    }),
    execute: async ({ message, files, remove }) =>
      guarded(async () => {
        const msg = String(message ?? "").trim().slice(0, 200);
        if (!msg) return { error: "message 不能为空 —— 提交说明是以后查历史的唯一线索。" };

        const list = Array.isArray(files) ? files : [];
        const del = Array.isArray(remove) ? remove.map((p) => String(p ?? "").trim()).filter(Boolean) : [];
        if (!list.length && !del.length) return { error: "files 和 remove 都是空的，没什么可提交的。" };
        if (list.length > COMMIT_MAX_FILES) {
          return { error: `一次最多 ${COMMIT_MAX_FILES} 个文件，收到 ${list.length} 个。分两批提交。` };
        }

        const out: { path: string; content: string }[] = [];
        let bytes = 0;
        for (const f of list) {
          const c = checkPath(f?.path);
          if (c.error) return { error: c.error };
          const text = String(f?.content ?? "");
          bytes += utf8Len(text);
          out.push({ path: c.path, content: text });
        }
        for (const p of del) {
          const c = checkPath(p);
          if (c.error) return { error: c.error };
        }
        if (bytes > COMMIT_MAX_BYTES) {
          return {
            error: `这批内容合计 ${Math.round(bytes / 1024)} KB，超过上限 ${Math.round(
              COMMIT_MAX_BYTES / 1024,
            )} KB。拆成几次提交。`,
          };
        }

        const r = await usageError(() => commitFiles(cfg, BRANCH, msg, out, del));
        if ("error" in r) return r;
        return {
          ok: true,
          commit: r.commit,
          commitUrl: r.url,
          changed: r.count,
          note:
            "已提交到 main。如果改的是 projects/ 下的项目，GitHub Actions 会自动跑测试并部署 —— " +
            "但**结果你看不到**，要如实告诉用户去 Actions 页面看。",
        };
      }),
  });

  return [ls, read, write, rm, commit];
}
