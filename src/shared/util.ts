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
// （cf-agent-lab 那边的同名文件还多带一个 `utf8Len` / `UA` —— 那是 ghworkspace
//   需要的；这个仓库没有那一族，所以这里只留真正被用到的。）

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
