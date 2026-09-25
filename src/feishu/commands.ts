// 飞书消息里的命令解析。零依赖纯函数。
//
// 2026-09-25：agent 从「代码仓库问答」改成通用助手，`/repo`（导入 GitHub 仓库）
// 连同它依赖的 `OWNER_RE` / `REF_RE`、以及 `parseRepoArg` 一起删掉了。
// 这里曾经还有一份和网页 `workspace-panel.tsx` 里 `parseRepo` 刻意重复的解析实现，
// 也随仓库层一起没了（那个文件在 cf-agent-lab，本仓库从来没有网页入口）。

export type Command =
  | { kind: "ask"; text: string }
  | { kind: "status" }
  | { kind: "compact" }
  | { kind: "clear" }
  | { kind: "memory" }
  | { kind: "forget"; key: string }
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "help" }
  | { kind: "error"; message: string };

export const HELP_TEXT = [
  "发消息直接问就行。",
  "",
  "/status                 看当前会话的状态（含云文档授权）",
  "/compact                把当前对话压成摘要，聊长了用一次，省上下文",
  "/clear                  清空当前会话的对话记忆",
  "/memory                 看长期记忆（跨会话共享，换个群也还在）",
  "/forget <键名>          删掉一条长期记忆；/forget all confirm 清空",
  "/login                  授权读取飞书云文档（点一次链接即可，之后能直接贴文档链接提问）",
  "/logout                 撤销云文档授权",
  "/help                   看这一段",
  "",
  "每个飞书会话（单聊、每个群）各自独立：对话记忆互不影响。",
  "只有长期记忆是跨会话的 —— 技术栈、代码风格这类事实记一次，哪里都记得。",
].join("\n");

/**
 * 把一条消息解析成命令。不带斜杠的一律当成提问。
 */
export function parseCommand(raw: string): Command {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "ask", text };

  // 只按空白切，命令名大小写不敏感
  const sp = text.search(/\s/);
  const head = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : text.slice(sp).trim();

  switch (head) {
    case "/status":
    case "/状态":
      return { kind: "status" };
    case "/compact":
    case "/压缩":
      return { kind: "compact" };
    case "/clear":
    case "/清空":
      return { kind: "clear" };
    case "/memory":
    case "/记忆":
      return { kind: "memory" };
    case "/forget":
    case "/忘记":
      // ⚠️ 参数**故意允许为空**：用户打一个光秃秃的 `/forget` 时想看的是用法，
      // 由宿主回一段「用法 + 怎么看键名」。在这里报「参数缺失」既没用又显得像出错。
      return { kind: "forget", key: arg };
    case "/login":
    case "/授权":
      return { kind: "login" };
    case "/logout":
    case "/退出授权":
      return { kind: "logout" };
    case "/help":
    case "/帮助":
    case "/?":
      return { kind: "help" };
    default:
      return {
        kind: "error",
        message: `不认识的命令 ${head}。发 /help 看看有什么。`,
      };
  }
}
