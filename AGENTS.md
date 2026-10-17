<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

---

# AGENTS.md（仓库契约）

## 项目是什么

edgeone-agent-lab：飞书通用助手（OpenAI Agents SDK），cf-agent-lab 的 EdgeOne Makers 移植版，装完即用、测试不依赖平台。

## 仓库布局

- `src/feishu/` —— 飞书侧：验签、事件解析、命令、会话压缩、OAuth、云文档工具
- `src/ghworkspace/` —— GitHub 工作区与 issue 工具族（`gh_` 前缀）
- `src/shared/` —— 跨模块共享（util 等）
- `bridge/`、`cloud-functions/` —— 各自独立的子包/部署件（自有 package.json）
- `test/smoke.ts` —— 唯一测试入口，190 项冒烟（替换全局 fetch，纯本地）
- `tools/` —— 运维脚本（ask-bot、verify-*）

## 依赖边界

- `src/` 内只允许单向依赖：`feishu` / `ghworkspace` → `shared`；**feishu 与 ghworkspace 互不 import**（实测零交叉）
- 新依赖进根 `package.json`；bridge/cloud-functions 各自独立
- 保持「零平台依赖可测」：核心逻辑必须能在没有 EdgeOne/飞书 网络的环境跑测试

## 测试（authoritative gates）

- 行为改动 → `npm test`（唯一测试入口，190 项，纯本地）
- 类型面改动 → `npm run typecheck`（`tsc --noEmit`，`strict: true`）
- 两者都过才算完成；跑不了必须写明具体原因 + 本该跑的命令

## 禁改清单（除非工单点名）

- `.github/workflows/`、`deploy.sh`、`edgeone.json`、`wrangler.jsonc` —— CI/部署/平台配置
- AGENTS.md 内 `OPENWIKI:START/END` 标记块 —— 由工具再生，不要手改

## 风格

- TypeScript strict、ESM（`type: module`）、import 源带 `.ts` 扩展（Node type-stripping）
- 最小改动；复用既有模式；注释只写非显然理由（跟随既有注释密度）
- 提交信息中文 conventional（`feat(scope):` / `docs:` 等）；agent 提交额外带 `RALPH:` 前缀

## 沙箱内不可用（验证时降级到上述 gates）

- EdgeOne 平台登录态（`edgeone makers dev/deploy` 需令牌）
- 真实飞书 / 外网调用（测试已全部 stub）
