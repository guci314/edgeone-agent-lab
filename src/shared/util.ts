// 跨模块共用的小工具。
//
// ── 为什么单独一个文件 ──────────────────────────────────────────────
// `guarded` 原先住在 `src/workspace/tools.ts` —— 而 `workspace/` 是
// 「读**用户导入的**仓库快照」那一层，2026-09-25 把 agent 改成通用助手时整层删掉了。
//
// 但还有两处在用 `guarded`，所以先搬出来，别让它跟着那一层一起消失：
//   · `src/feishu/docs.ts`（飞书云文档工具族）
//   · `agents/feishu/_search.ts`（自建 web_search）
//
// 教训：**删一层之前先看有没有别人在 import 它里面的通用零件。**
//
// ── UA / utf8Len ────────────────────────────────────────────────────
// 2026-09-25 从 cf-agent-lab 的 shared/util.ts 搬来：ghworkspace 那族工具
// （工作区 GitHub 仓库的 ws_*）移植到这个仓库时需要它们 ——
//   UA：不带 UA 的请求会被一部分端点直接拒；
//   utf8Len：ws_read 按字节预算截断行，用 UTF-16 长度会漏算中文（一字 3 字节）。

/**
 * 工具永不抛错。
 *
 * 工具抛错会**中断整个工具循环** —— 模型看不到错因，只看到这一轮断了。
 * 所以一律转成 `{ error }` 让它自己读到并调整参数。这是全仓所有工具的共同契约，
 * 所以实现只留这一份。
 */
export async function guarded<T>(
  fn: () => T | Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: `工具执行失败：${(e as Error).message}` };
  }
}

/** 出站请求的 UA。没有它的请求会被一部分端点直接拒掉 */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** 字符串的 UTF-8 字节数。截断按字节算预算时必须用它，不能用 `.length` */
export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}
