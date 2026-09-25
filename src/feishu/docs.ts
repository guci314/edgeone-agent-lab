// 读、写飞书云文档的工具族：新版文档 / 知识库 / 多维表格 / 电子表格。
//
// ── 谁的身份（2026-09-25 改成「应用优先、用户兜底」）─────────────────
// 之前一律用用户身份（user_access_token），代价是每来一个新用户都要先发 /login。
// 现在改成两层：
//   ① **应用身份**（tenant_access_token）先行 —— 它能读/写「被显式共享给机器人」
//      的文档。每份文档要在飞书里右键 → 添加文档应用共享一次，但换来的
//      是**零授权直读**：群里的任何人贴链接都能用，无需任何人 /login。
//   ② 应用身份拿不到（没共享、权限不够）时，若这个人已 /login 过，就**自动
//      换用户身份再试一次** —— 用户身份能读他自己有权限的一切。
//   ③ 两边都失败，给一条**可执行**的合并错误：要么共享给机器人，要么发 /login。
//
// ── 为什么读是三个工具、写也是三个工具 ──────────────────────────────
// 文档类型有四种，工具只有三个 —— 因为**知识库不是一种文档，是一种链接形态**。
// 每个工具都先做一次 wiki 解引用，所以 `/wiki/xxx` 在所有工具里都能直接用。
// 写只有三种：多维表格记录、电子表格区域、文档正文**追加**。新版文档的块级
// 编辑 API 又重又容易写坏版式，不值得 —— 要改已有正文，让用户自己在飞书里改。
//
// ── 和别的工具族的关系 ──────────────────────────────────────────────
// 这里六个工具读写**飞书云文档**，`_search.ts` 那个读**公开网页**，数据源不同
// 所以分文件；但约定必须一致，否则模型会看到两种风格：
//   · 返回一律 JSON 字符串；出错返回 `{ error }` 而不是抛（复用 `guarded`）
//   · 截断必须**显式标注**并给出继续读的办法，绝不能让半截内容被当成全文
//   · 前置条件不满足时给**可执行**的提示，别让模型自己猜

import { tool } from "@openai/agents";
import { z } from "zod";
import {
  FeishuError,
  feishuCall,
  feishuCallAs,
  type FeishuEnv,
  type TokenCache,
} from "./api.ts";
import { guarded } from "../shared/util.ts";
import { parseDocUrl, type DocRef } from "./oauth.ts";
import type { UserTokenManager } from "./user-token.ts";

/**
 * 一次返回多少正文。
 *
 * 给大不是好事：一份长文档整个吐进去会吃掉几万 token，而用户往往只问其中
 * 一段。给 offset/nextOffset 让模型**按需再来一次**，比一次给全更省也更快。
 */
const DOC_DEFAULT_CHARS = 10_000;
const DOC_MAX_CHARS = 30_000;

/** 电子表格的行列双上限。只卡行数挡不住「某一行特别宽」 */
const SHEET_MAX_ROWS = 100;
const SHEET_MAX_COLS = 20;

/** 多维表格。500 是接口单页上限 */
const BITABLE_DEFAULT_ROWS = 50;
const BITABLE_MAX_ROWS = 500;

/** 单个单元格/字段值的最长长度。表格里偶尔有整段文本，不截会淹掉其余列 */
const CELL_MAX_CHARS = 200;

/**
 * 刚读过的文档正文留一份，供翻页时复用。
 *
 * 按 offset 分页读一份长文档要连着调好几次，每次都重新拉一遍全文是纯浪费。
 * 只留最近三份：再多就是拿内存换一个很少发生的场景。
 */
const DOC_CACHE_MAX = 3;
const DOC_CACHE_TTL_MS = 10 * 60 * 1000;

/** 一次最多追加多少段、多少字。往文档里灌一整本书不属于这个工具的职责 */
const DOCX_WRITE_MAX_PARAS = 500;
const DOCX_WRITE_MAX_CHARS = 20_000;
/** 一次最多写多少表格单元格。超出就该让模型分批 */
const SHEET_WRITE_MAX_CELLS = 10_000;
/** 多维表格批量写。飞书接口自身的单批上限就是 500，这里取保守值 */
const BITABLE_WRITE_MAX_RECORDS = 100;

export interface DocToolDeps {
  env: FeishuEnv;
  /** 应用身份的 tenant token 缓存（跟发消息用的是同一份） */
  cache: TokenCache;
  /**
   * 这个会话里提问人的用户令牌。**可以为 null**（没配 kv / 本地调试）：
   * 那就只有应用身份，读不到共享文档时直接报错，而不是挂出一族永远失败的工具。
   */
  tokens: UserTokenManager | null;
}

const json = (v: unknown) => JSON.stringify(v);

/** 把一个错误压成放进合并消息里的一小段 */
const short = (e: unknown): string =>
  String((e as Error)?.message ?? e).slice(0, 160);

/**
 * 两边身份都读不到时的兜底提示。文案必须**可执行**：模型会把这句话转述给用户，
 * 说清「共享给机器人」或「发 /login」用户才知道下一步做什么。
 */
const AUTH_HINT =
  "如果这份文档本来就该能读：让用户在飞书里打开它，右上角「···」→「添加文档应用」" +
  "把它共享给机器人（无需授权即可读）；或者用户发 `/login` 完成一次授权，" +
  "之后就能以他自己的身份读写他有权限的文档。请不要自己编链接。";

/** 单元格 → 一行文本。飞书字段值的形状很杂，认不出的压成 JSON 截断 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.slice(0, CELL_MAX_CHARS);
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (Array.isArray(v)) {
    // 富文本/多选/人员都是数组。逐个拍平再拼，比 JSON.stringify 可读得多
    return v
      .map(cellText)
      .filter(Boolean)
      .join(" / ")
      .slice(0, CELL_MAX_CHARS);
  }

  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // 见过的几种：富文本 {text}、人员/选项 {name}、链接 {link}
    for (const k of ["text", "name", "link", "value"]) {
      if (typeof o[k] === "string") return (o[k] as string).slice(0, CELL_MAX_CHARS);
    }
    return JSON.stringify(o).slice(0, CELL_MAX_CHARS);
  }
  return String(v).slice(0, CELL_MAX_CHARS);
}

/** 一条记录的字段拍平成 `{字段: 文本}` */
function flattenFields(fields: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    const t = cellText(v);
    if (t) out[k] = t;
  }
  return out;
}

/** 1 → A、27 → AA */
function colName(n: number): string {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function makeFeishuDocTools(deps: DocToolDeps): unknown[] {
  const { env, cache, tokens } = deps;

  // 翻页缓存。key 是文档 token，值是刚拉到的全文
  const docCache = new Map<string, { title: string; text: string; at: number }>();

  /**
   * 用**用户身份**发一次请求，遇上「令牌无效」就续期重试**一次**。
   *
   * 重试放在这里而不是 `feishuCallAs` 里：只有令牌管理器知道怎么续期，
   * 而 api.ts 那层刻意不碰这件事（续期要落盘，埋在通用 helper 里调用方就
   * 看不见那次写回了，见 api.ts 的注释）。
   */
  const callUser = async (mgr: UserTokenManager, method: string, path: string, body?: unknown) => {
    const t = await mgr.accessToken();
    if ("needAuth" in t) throw new Error(`${t.reason} 请让用户发 \`/login\` 重新授权。`);
    try {
      return await feishuCallAs(env, t.token, method, path, body);
    } catch (e) {
      // 99991663/99991664 = access token 无效。可能是用户在飞书侧撤销了授权，
      // 那种情况 exp 还没到，光看时间发现不了
      if (e instanceof FeishuError && (e.code === 99991663 || e.code === 99991664)) {
        await mgr.invalidate();
        const t2 = await mgr.accessToken();
        if ("needAuth" in t2) throw new Error(`${t2.reason} 请让用户发 \`/login\` 重新授权。`);
        return await feishuCallAs(env, t2.token, method, path, body);
      }
      throw e;
    }
  };

  /**
   * 云文档的统一入口：**应用身份优先，用户身份兜底**。
   *
   * 应用身份走 `feishuCall`（自带 tenant token 的取用和失效重试）。它失败
   * （多半是文档没共享给机器人）且这个人有用户令牌时，换用户身份再试一次；
   * 两边都失败则给合并错误 —— 模型需要知道两条路都试过了，才不会自己再重试一遍。
   *
   * ⚠️ 不按错误码过滤「该不该兜底」：飞书各产品的权限错误码不统一
   * （docx / bitable / sheets / wiki 各一套），白名单迟早漏。代价是模型自己
   * 写错参数（如 table_id 不存在）时多打一次注定失败的请求，可接受。
   */
  const callDoc = async (method: string, path: string, body?: unknown) => {
    let appErr: unknown;
    try {
      return await feishuCall(env, cache, method, path, body);
    } catch (e) {
      appErr = e;
    }
    if (!tokens) throw appErr;
    try {
      return await callUser(tokens, method, path, body);
    } catch (userErr) {
      throw new Error(
        `应用身份读不到（${short(appErr)}）；用户身份也读不到（${short(userErr)}）。${AUTH_HINT}`,
      );
    }
  };

  /** 把用户给的链接变成「操作哪个 token」。wiki 在这里解引用 */
  const resolveLink = async (
    url: string,
  ): Promise<DocRef | { kind: "unknown"; reason: string }> => {
    const ref = parseDocUrl(url);
    if (ref.kind !== "wiki") return ref;

    // ⚠️ wiki 链接里的 token 是**节点 token**，不是文档 token。少了这一步，
    // 所有知识库链接都会以「找不到文档」告终
    const r = await callDoc(
      "GET",
      `/wiki/v2/spaces/get_node?token=${encodeURIComponent(ref.token)}&obj_type=wiki`,
    );
    const node = r.data?.node as { obj_token?: string; obj_type?: string } | undefined;
    if (!node?.obj_token || !node.obj_type) {
      return {
        kind: "unknown",
        reason: "这个知识库链接解不出底层文档（节点不存在，或者没有该知识库的阅读权限）。",
      };
    }
    switch (node.obj_type) {
      case "docx":
      case "doc":
        return { kind: "docx", token: node.obj_token };
      // 知识库里的表格/多维表格，`obj_type` 的名字和 URL 里的不一样。
      // 原始链接里的 ?table= / ?sheet= 要一并带过去 —— 新建的多维表格默认就落在
      // 知识库，链接里那个 table 参数能省掉「先列表、再读记录」的一轮往返。
      case "bitable":
        return {
          kind: "bitable",
          token: node.obj_token,
          ...(ref.tableId ? { tableId: ref.tableId } : {}),
        };
      case "sheet":
        return {
          kind: "sheets",
          token: node.obj_token,
          ...(ref.sheetId ? { sheetId: ref.sheetId } : {}),
        };
      default:
        return {
          kind: "unknown",
          reason: `这个知识库节点挂的是 ${node.obj_type}，目前只支持文档 / 多维表格 / 电子表格。`,
        };
    }
  };

  /**
   * 每个工具都从这里起步：解链接。
   *
   * 返回 `stop` 表示到此为止，把它原样当工具结果返回。
   * 不再在这里查授权 —— 身份的事归 callDoc，授权提示跟着它的错误走。
   */
  const start = async (url: string) => {
    const ref = await resolveLink(url);
    if (ref.kind === "unknown") return { stop: { error: ref.reason } };
    return { ref };
  };

  /**
   * 类型对不上时给一句能自纠的话。
   *
   * ⚠️ **必须点名该用哪个工具**。只说「请换对应的工具」等于让模型去猜，
   * 而它猜错的代价是再撞一次墙 —— 这句话存在的意义就是省掉那一轮。
   * 读工具来问就推荐读工具，写工具来问就推荐写工具。
   */
  const RIGHT_TOOL: Record<string, { read: string; write: string }> = {
    docx: { read: "feishu_doc_read", write: "feishu_docx_write" },
    sheets: { read: "feishu_sheet_read", write: "feishu_sheet_write" },
    bitable: { read: "feishu_bitable_read", write: "feishu_bitable_write" },
  };
  const wrongKind = (ref: DocRef, toolName: string): { error: string } => {
    const pair = RIGHT_TOOL[ref.kind];
    const right = pair ? pair[toolName.endsWith("_write") ? "write" : "read"] : null;
    return {
      error: right
        ? `这个链接是「${ref.kind}」，${toolName} 处理不了。请改用 ${right}。`
        : `这个链接是「${ref.kind}」，文档工具族都处理不了。告诉用户目前只支持文档 / 电子表格 / 多维表格。`,
    };
  };

  const docUrl = (ref: DocRef) =>
    ref.kind === "docx" ? `https://feishu.cn/docx/${ref.token}` : "";

  // ── feishu_doc_read ───────────────────────────────────────────────
  const docRead = tool({
    name: "feishu_doc_read",
    description:
      "读取一份飞书云文档的正文。url 可以是 /docx/ 链接，也可以直接是知识库 /wiki/ 链接。" +
      "共享给机器人的文档无需用户授权即可读。默认返回前 10000 字；被截断时返回 truncated=true 和 nextOffset，" +
      "用它再读下一段，直到 truncated 为 false。读全之前不要对整篇文档下结论。",
    parameters: z.object({
      url: z.string().describe("飞书文档链接，形如 https://xxx.feishu.cn/docx/xxxx 或 /wiki/xxxx"),
      offset: z.number().optional().describe("从第几个字符开始读，默认 0。翻页时用上次返回的 nextOffset"),
      limit: z.number().optional().describe(`最多读多少字符，默认 ${DOC_DEFAULT_CHARS}，上限 ${DOC_MAX_CHARS}`),
    }),
    execute: async ({ url, offset, limit }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "docx") return wrongKind(ref, "feishu_doc_read");

          const now = Date.now();
          let hit = docCache.get(ref.token);
          if (hit && now - hit.at > DOC_CACHE_TTL_MS) hit = undefined;

          if (!hit) {
            const body = await callDoc(
              "GET",
              `/docx/v1/documents/${encodeURIComponent(ref.token)}/raw_content`,
            );
            // 标题单独一次请求，**失败不影响正文** —— 它只是让模型多点上下文
            let title = "";
            try {
              const meta = await callDoc(
                "GET",
                `/docx/v1/documents/${encodeURIComponent(ref.token)}`,
              );
              title = String(meta.data?.document?.title ?? "");
            } catch {
              /* 标题拿不到就空着 */
            }
            hit = { title, text: String(body.data?.content ?? ""), at: now };
            // 超上限先丢最老的（Map 保持插入序）
            if (docCache.size >= DOC_CACHE_MAX) {
              const oldest = docCache.keys().next().value;
              if (oldest !== undefined) docCache.delete(oldest);
            }
            docCache.set(ref.token, hit);
          }

          const total = hit.text.length;
          if (total === 0) {
            return {
              kind: "docx",
              title: hit.title,
              docUrl: docUrl(ref),
              content: "",
              offset: 0,
              totalChars: 0,
              truncated: false,
              note: "这个文档读出来是空的（可能是空文档，或者没有阅读权限）。",
            };
          }

          const startAt = Math.min(Math.max(Math.trunc(Number(offset) || 0), 0), total);
          const want = Math.min(Math.max(Math.trunc(Number(limit) || DOC_DEFAULT_CHARS), 1), DOC_MAX_CHARS);
          const end = Math.min(startAt + want, total);
          const content = hit.text.slice(startAt, end);
          const truncated = end < total;

          return {
            kind: "docx",
            title: hit.title,
            docUrl: docUrl(ref),
            content,
            offset: startAt,
            chars: content.length,
            totalChars: total,
            truncated,
            ...(truncated
              ? {
                  nextOffset: end,
                  note: `这份文档共 ${total} 字，这次给了第 ${startAt}~${end} 字。`,
                }
              : {}),
          };
        }),
      ),
  });

  // ── feishu_sheet_read ─────────────────────────────────────────────
  const sheetRead = tool({
    name: "feishu_sheet_read",
    description:
      "读取飞书电子表格的一块区域。url 可以是 /sheets/ 链接，也可以是知识库 /wiki/ 链接。" +
      "不给 range 时自动读第一个工作表的前若干行；给了就按 range 读（形如 `Sheet1!A1:D20`）。" +
      `行列都有上限（${SHEET_MAX_ROWS} 行 × ${SHEET_MAX_COLS} 列），超过会标注 truncated。`,
    parameters: z.object({
      url: z.string().describe("电子表格链接"),
      range: z.string().optional().describe("要读的区域，如 Sheet1!A1:D20。留空则读第一个工作表"),
    }),
    execute: async ({ url, range }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "sheets") return wrongKind(ref, "feishu_sheet_read");

          const token = encodeURIComponent(ref.token);
          let sheetName = "";
          let totalRows: number | undefined;
          let totalCols: number | undefined;
          // 我们自己算出来的窗口行数，用来判「有没有被裁」。调用方显式给了 range
          // 时保持 undefined —— 他指定了要哪块，就不该再报「没读完」。
          let askedRows: number | undefined;
          let target = range?.trim() ?? "";

          if (!target) {
            // 没给 range 就得先问「有哪些工作表」，取第一张，顺带把规模带回去
            const list = await callDoc("GET", `/sheets/v3/spreadsheets/${token}/sheets/query`);
            const sheets = (list.data?.sheets ?? []) as {
              sheet_id?: string;
              title?: string;
              grid_properties?: { row_count?: number; column_count?: number };
            }[];
            const first = sheets[0];
            if (!first?.sheet_id) {
              return {
                error: "这个表格里没读到工作表。可以让用户给一个 range（形如 `xxxx!A1:D20`）再试。",
              };
            }
            sheetName = first.title ?? "";
            totalRows = first.grid_properties?.row_count;
            totalCols = first.grid_properties?.column_count;
            // 只取到上限，别把整张表拖下来 —— 几万行的表会直接撑爆上下文
            const rows = Math.min(totalRows ?? SHEET_MAX_ROWS, SHEET_MAX_ROWS);
            const cols = Math.min(totalCols ?? SHEET_MAX_COLS, SHEET_MAX_COLS);
            askedRows = rows;
            target = `${first.sheet_id}!A1:${colName(cols)}${rows}`;
          } else if (ref.sheetId && !target.includes("!")) {
            // 链接里的 ?sheet=<id> 是工作表 id，可以当 range 的前缀
            target = `${ref.sheetId}!${target}`;
          }

          const r = await callDoc(
            "GET",
            `/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(target)}`,
          );

          const vr = r.data?.valueRange as
            | { range?: string; values?: unknown[][] }
            | undefined;
          // 防御：不同版本这个字段可能在 data 层也可能在 valueRange 里
          const values = (vr?.values ?? (r.data?.values as unknown[][]) ?? []) as unknown[][];

          // ⚠️ 飞书把**整个网格**回给你，空行空列也占位（新建表默认 200 行 × 20 列）。
          // 原样吐出去实测有两个后果，都撞到了：
          //   ① 一份只有 4 行数据的表变成 100 行制表符，白烧掉一大截上下文；
          //   ② 下面按「网格比窗口大」判 truncated，那对新表**永远成立**
          //      （totalRows 200 > 读到的 100），于是每次都报「只读了一部分」，
          //      模型信了、反复重读 —— 实测它为一个 4 行就够的表格连调了 8 次。
          // 所以先把尾部全空的行列剪掉，再判断到底有没有被裁。
          const rawRows = values.length;
          const rawCols = values.reduce((m, row) => Math.max(m, (row ?? []).length), 0);
          const grid = values
            .slice(0, SHEET_MAX_ROWS)
            .map((row) => (row ?? []).slice(0, SHEET_MAX_COLS).map(cellText));

          while (grid.length && (grid[grid.length - 1] ?? []).every((c) => !c)) grid.pop();
          let width = grid.reduce((m, r) => Math.max(m, r.length), 0);
          while (width > 0 && grid.every((r) => !(r[width - 1] ?? ""))) width--;

          const lines = grid.map((r) => r.slice(0, width).join("\t"));
          const rowCount = lines.length;
          const colCount = width;

          // 「被裁」的判据：**剪掉尾部空行之后，内容仍然顶在窗口边缘**。
          //
          // 两个反例各自排除了一个错误判据：
          //   · 「网格比窗口大」——新表网格恒为 200 行，据此判定等于每次喊狼来了；
          //   · 「服务端把窗口填满了」——飞书就是会**补空行填满**，恒真，同样没用。
          // 真正的信号是：尾部一行空行都没剪掉（rowCount === rawRows），说明内容
          // 一直延续到我们请求的边界，后面才可能还有。
          // 显式给了 range 时不算 —— 调用方指定了要哪块，不该再报「没读完」。
          const contentAtEdge = rowCount >= rawRows;
          const windowFull = askedRows !== undefined && rawRows >= askedRows;
          const gridBigger = totalRows === undefined || totalRows > rowCount;
          const truncated = (windowFull && contentAtEdge && gridBigger) || rawCols > SHEET_MAX_COLS;

          return {
            kind: "sheets",
            sheetUrl: `https://feishu.cn/sheets/${ref.token}`,
            sheet: sheetName || undefined,
            range: vr?.range ?? target,
            // 给的是**有内容的范围**，不是整个网格
            text: lines.join("\n"),
            rowCount,
            colCount,
            ...(totalRows !== undefined ? { totalRows } : {}),
            ...(totalCols !== undefined ? { totalCols } : {}),
            truncated,
            ...(truncated
              ? {
                  note:
                    "读到的区域已经顶到上限，后面可能还有内容。" +
                    "换一个更大的 range（或直接指定要读的那几行）再读一次。",
                }
              : {}),
          };
        }),
      ),
  });

  // ── feishu_bitable_read ───────────────────────────────────────────
  const bitableRead = tool({
    name: "feishu_bitable_read",
    description:
      "读飞书多维表格。url 可以是 /base/ 链接，也可以是知识库 /wiki/ 链接。" +
      "不给 table_id 时先返回这个多维表格里有哪些数据表（含 table_id 和表名）；" +
      "带上 table_id 才读记录。记录里的字段值已经拍平成文本。",
    parameters: z.object({
      url: z.string().describe("多维表格链接"),
      table_id: z.string().optional().describe("数据表 id。第一次不传，从返回的 tableList 里挑"),
      limit: z.number().optional().describe(`最多读多少条记录，默认 ${BITABLE_DEFAULT_ROWS}，上限 ${BITABLE_MAX_ROWS}`),
    }),
    execute: async ({ url, table_id, limit }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "bitable") return wrongKind(ref, "feishu_bitable_read");

          const app = encodeURIComponent(ref.token);
          // 链接里可能带了 ?table=<id>（/base/ 的 query，或 wiki 链接解引用后带过来的），
          // 那就直接用它
          const tableId = table_id?.trim() || ref.tableId || "";
          // 这个 id 是**链接里带过来的**，不是模型自己挑的 —— 所以下面出错要兜底
          const fromLink = !table_id?.trim() && !!ref.tableId;

          /** 先列出有哪些数据表。没给 table_id，或链接里那个用不了时都走这儿 */
          const listTables = async () => {
            const t = await callDoc("GET", `/bitable/v1/apps/${app}/tables?page_size=100`);
            const list = (t.data?.items ?? []) as { table_id?: string; name?: string }[];
            if (!list.length) {
              return { error: "这个多维表格里没有数据表（或者没有阅读权限）。" };
            }
            return {
              kind: "bitable",
              appUrl: `https://feishu.cn/base/${ref.token}`,
              tableList: list.map((x) => ({ table_id: x.table_id, name: x.name })),
              note: "用 table_id 再调一次，才会返回记录。",
            };
          };

          if (tableId) {
            const n = Math.min(
              Math.max(Math.trunc(Number(limit) || BITABLE_DEFAULT_ROWS), 1),
              BITABLE_MAX_ROWS,
            );
            try {
              const r = await callDoc(
                "GET",
                `/bitable/v1/apps/${app}/tables/${encodeURIComponent(tableId)}/records?page_size=${n}`,
              );
              const items = (r.data?.items ?? []) as {
                record_id?: string;
                fields?: Record<string, unknown>;
              }[];
              const hasMore = !!r.data?.has_more;

              return {
                kind: "bitable",
                appUrl: `https://feishu.cn/base/${ref.token}`,
                table: { table_id: tableId, name: r.data?.table?.name ?? "" },
                records: items.map((x) => ({
                  record_id: x.record_id,
                  fields: flattenFields(x.fields),
                })),
                count: items.length,
                hasMore,
                ...(hasMore ? { note: "还有更多记录，调大 limit 继续读。" } : {}),
              };
            } catch (e) {
              // ⚠️ 链接里的 `table` 参数**不保证**是 OpenAPI 的 table_id —— 实测从
              // 地址栏拷下来的链接，表格停在「页面」侧栏时那个值是另一套 id。
              // 所以失败就退回「先列表」，别把一条模型看不懂的报错丢出去。
              // 模型**自己**传的 table_id 不兜底：那是它的选择，写错了就该让它看见。
              if (!fromLink) throw e;
            }
          }

          return await listTables();
        }),
      ),
  });

  // ── feishu_bitable_write ──────────────────────────────────────────
  const bitableWrite = tool({
    name: "feishu_bitable_write",
    description:
      "往飞书多维表格**新增**记录，或**按 record_id 更新**已有记录。" +
      "机器人需要对这份多维表格有编辑权限（用户共享时勾上「可编辑」）。" +
      "写字段值时一律给文本，飞书会按字段类型自动转换；写之前建议先 feishu_bitable_read 看一眼字段名和现有取值。" +
      "要改已有记录必须先读一次拿到 record_id。",
    parameters: z.object({
      url: z.string().describe("多维表格链接"),
      table_id: z.string().describe("数据表 id（feishu_bitable_read 不带 table_id 调一次就能看到）"),
      action: z.enum(["add", "update"]).describe("add=新增记录；update=按 record_id 更新已有记录"),
      records: z
        .array(
          z.object({
            record_id: z.string().optional().describe("action=update 时每条必填；add 时省略"),
            fields: z
              .record(z.string(), z.string())
              .describe("字段名 → 值。值一律按文本给，飞书按字段类型转换"),
          }),
        )
        .min(1)
        .max(BITABLE_WRITE_MAX_RECORDS)
        .describe(`要写的记录，一次最多 ${BITABLE_WRITE_MAX_RECORDS} 条`),
    }),
    execute: async ({ url, table_id, action, records }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "bitable") return wrongKind(ref, "feishu_bitable_write");

          // update 缺 record_id 是模型自己的参数错，当场说清，别送到飞书去挨一顿
          // 看不懂的报错
          if (action === "update") {
            const bad = records.find((r) => !r.record_id?.trim());
            if (bad) {
              return {
                error:
                  "action=update 时每条记录都必须带 record_id。先用 feishu_bitable_read 读一次拿到；" +
                  "要新增记录请用 action=add。",
              };
            }
          }

          const app = encodeURIComponent(ref.token);
          const tid = encodeURIComponent(table_id.trim());
          const path =
            action === "add"
              ? `/bitable/v1/apps/${app}/tables/${tid}/records/batch_create`
              : `/bitable/v1/apps/${app}/tables/${tid}/records/batch_update`;
          const r = await callDoc(action === "add" ? "POST" : "PUT", path, {
            records: records.map((x) => ({
              ...(action === "update" ? { record_id: x.record_id!.trim() } : {}),
              fields: x.fields,
            })),
          });
          const written = ((r.data?.records as unknown[]) ?? []).length;

          return {
            kind: "bitable",
            action,
            ...(action === "add" ? { added: written } : { updated: written }),
            table_id: table_id.trim(),
            appUrl: `https://feishu.cn/base/${ref.token}`,
            note: "字段值按文本提交，飞书按字段类型自动转换；某个字段转换失败时整批都会被拒，拆开写能定位是哪个字段。",
          };
        }),
      ),
  });

  // ── feishu_sheet_write ────────────────────────────────────────────
  const sheetWrite = tool({
    name: "feishu_sheet_write",
    description:
      "往飞书电子表格写一块区域（覆盖式写入，会盖掉区域里已有的内容）。" +
      "机器人需要对这份表格有编辑权限。range 要带工作表前缀（形如 `Sheet1!A1:C3`），" +
      "前缀可以直接用 feishu_sheet_read 返回的 range；链接里带 ?sheet= 时可以只写 `A1:C3`。" +
      "values 的行列数要和 range 对得上；数值直接给数字，别全包成字符串。",
    parameters: z.object({
      url: z.string().describe("电子表格链接"),
      range: z.string().describe("要写的区域，如 Sheet1!A1:C3"),
      values: z
        .array(z.array(z.union([z.string(), z.number(), z.boolean()])))
        .min(1)
        .describe("二维数组，第一行通常是表头。行列数要和 range 一致"),
    }),
    execute: async ({ url, range, values }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "sheets") return wrongKind(ref, "feishu_sheet_write");

          let target = range.trim();
          if (!target.includes("!")) {
            if (ref.sheetId) {
              // 链接里的 ?sheet=<id> 是工作表 id，可以当 range 的前缀
              target = `${ref.sheetId}!${target}`;
            } else {
              return {
                error:
                  "range 要带工作表前缀，形如 Sheet1!A1:C3。先用 feishu_sheet_read 读一次，" +
                  "它返回的 range 可以直接拿来用。",
              };
            }
          }

          const rows = values.length;
          const cols = values.reduce((m, row) => Math.max(m, (row ?? []).length), 0);
          if (rows * cols > SHEET_WRITE_MAX_CELLS) {
            return {
              error: `要写 ${rows}×${cols}=${rows * cols} 个单元格，超过一次写入的上限 ${SHEET_WRITE_MAX_CELLS}。分几次写。`,
            };
          }

          const token = encodeURIComponent(ref.token);
          await callDoc("PUT", `/sheets/v2/spreadsheets/${token}/values`, {
            valueRange: { range: target, values },
          });

          return {
            kind: "sheets",
            updatedCells: rows * cols,
            range: target,
            sheetUrl: `https://feishu.cn/sheets/${ref.token}`,
            note: "写入是**覆盖式**的：区域里原有的内容会被盖掉。想先看看有什么就读一次。",
          };
        }),
      ),
  });

  // ── feishu_docx_write ─────────────────────────────────────────────
  const docxWrite = tool({
    name: "feishu_docx_write",
    description:
      "往飞书云文档的**末尾追加**正文（只能追加，不能修改或删除已有内容 —— 要改就让用户自己在飞书里改）。" +
      "机器人需要对这份文档有编辑权限。content 用换行分段，每个非空行成为一个段落；" +
      "适合往文档里补一段结论、记录一条新内容。",
    parameters: z.object({
      url: z.string().describe("飞书文档链接，形如 https://xxx.feishu.cn/docx/xxxx 或 /wiki/xxxx"),
      content: z
        .string()
        .min(1)
        .describe("要追加的正文。换行分段，每个非空行一个段落；Markdown 语法不会被渲染，就是纯文本"),
    }),
    execute: async ({ url, content }) =>
      json(
        await guarded(async () => {
          const s = await start(url);
          if ("stop" in s) return s.stop;
          const ref = s.ref;
          if (ref.kind !== "docx") return wrongKind(ref, "feishu_docx_write");

          // 空行丢掉：正文里它只是 Markdown 的分段符，落进文档反而多出空段落
          const paras = content
            .split("\n")
            .map((l) => l.replace(/\s+$/, ""))
            .filter((l) => l.length > 0);
          if (!paras.length) return { error: "content 里没有实际内容。" };
          if (paras.length > DOCX_WRITE_MAX_PARAS || content.length > DOCX_WRITE_MAX_CHARS) {
            return {
              error: `一次最多追加 ${DOCX_WRITE_MAX_PARAS} 段 / ${DOCX_WRITE_MAX_CHARS} 字，分几次追加。`,
            };
          }

          const doc = encodeURIComponent(ref.token);
          await callDoc("POST", `/docx/v1/documents/${doc}/blocks/${doc}/children`, {
            // index=-1 = 追加到文档末尾。这也是这个工具「只能追加」的实现根基
            index: -1,
            children: paras.map((line) => ({
              block_type: 2,
              paragraph: { elements: [{ text_run: { content: line } }] },
            })),
          });

          return {
            kind: "docx",
            appended: paras.length,
            docUrl: docUrl(ref),
            note: "已追加到文档末尾。这个工具改不了已有内容。",
          };
        }),
      ),
  });

  return [docRead, sheetRead, bitableRead, bitableWrite, sheetWrite, docxWrite];
}

/** 给 `/logout` 和状态展示用：这个会话背后的人授权了没 */
export async function authStateText(tokens: UserTokenManager, openId: string): Promise<string> {
  const tok = await tokens.peek();
  if (!tok) {
    return "云文档：未授权（共享给机器人的文档无需授权可读；发 /login 后能以你的身份读写你有权限的文档）";
  }
  const when = tok.exp ? new Date(tok.exp).toISOString().slice(0, 16).replace("T", " ") : "未知";
  const rtf = tok.refreshToken ? "有刷新令牌" : "⚠️ 无刷新令牌（两小时后要重新授权）";
  return `云文档：已授权（${openId.slice(0, 12)}…，访问令牌有效到 ${when} UTC，${rtf}）`;
}
