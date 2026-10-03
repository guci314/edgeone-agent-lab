---
type: concept
title: 刻意不做的事与破坏性能力政策
description: 已记录的设计决定清单——agent 不自改本仓库代码、不开 drive:drive / 文档删除、不给关闭 issue 的能力、不挂 files_remove 与 browser_* 点击类工具、以及删除仓库语料层（/repo + src/workspace/*）的理由与回访前提；它们都不是待办缺口。
tags: [design-decisions, non-goals, destructive-capabilities, security-boundary, porting, scope]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-03T16:28:06.187Z
sources:
  - id: openwiki-source-6766b7a0c14857435d2077c9
    resource: repo://.github/workflows/deploy.yml
  - id: openwiki-source-5f3aea8c254ad36759041b1d
    resource: repo://agents/feishu/_host.ts
  - id: openwiki-source-21fdb6c189926cc267545d5b
    resource: repo://agents/feishu/_instructions.ts
  - id: openwiki-source-00fdb3d166c9958ea836d71d
    resource: repo://agents/feishu/_tools.ts
  - id: openwiki-source-28ed19af7422da0dde523305
    resource: repo://docs/01-%E6%9E%B6%E6%9E%84%E4%B8%8E%E7%A7%BB%E6%A4%8D%E6%98%A0%E5%B0%84.md
  - id: openwiki-source-63dcbbaaba227048cacc8dda
    resource: repo://src/feishu/commands.ts
  - id: openwiki-source-821a4925dc4808c11a468acb
    resource: repo://src/ghworkspace/issue-tools.ts
  - id: openwiki-source-a163e04aed55f7c8a360b252
    resource: repo://src/ghworkspace/issues.ts
  - id: openwiki-source-b45a71999bc8dd33833b055d
    resource: repo://src/shared/util.ts
  - id: openwiki-source-52891af3d1130cc7375b5e4e
    resource: repo://test/smoke.ts
generated: { by: "openwiki/0.6.1", at: "2026-10-03T16:28:06.187Z" }
---

# 刻意不做的事与破坏性能力政策

这份仓库有一个反复被重申的约定，写在 `docs/01-架构与移植映射.md` 第十一节里：

> 破坏性 / 面向他人的能力，默认不做；要做也得先说清护栏。

本页收拢那些**想过、明确决定不做**的能力，以及一次**主动删除**（仓库语料层）。它们都在代码和提示词里留下了痕迹，很容易被后来者读成「缺口」。**每一条都不是待办。** 要重新评估，先读这里记录的理由与回访前提。

相关背景：[平台约束与弱化的保证](../architecture/platform-constraints.md) 讲平台**不同意**什么（被动缺口），[工具契约与清单](tool-contract-and-inventory.md) 讲现在**挂上了**什么；本页讲那些**有能力却没有做**的事。

## 一条统一的规矩，五处落点

后面每一条都是同一条规矩的实例，只是作用的资源不同。把它抽出来先说，是为了让「某个能力没做」这个现象一眼就能归位：

- **破坏性**：动作不可逆，或者善后成本远高于收益；
- **面向他人**：对外可见、影响协作者，或者把决定权从人手里拿走；
- **默认不做**：不因为「技术上能做」就顺带做；要做，先想清楚「模型在什么条件下才该做、做错了谁赔」——这句话是 `docs/01-架构与移植映射.md` 讨论文档删除能力时留下的原话。

五处落点：agent 自改本仓库代码（本节下方第一节）、飞书云文档的 `drive:drive` / 删除（第二节）、关闭 GitHub issue（第三节）、平台沙箱的 `files_remove` 与 `browser_*` 交互类工具（第四节）、仓库语料层（第五节，属删除而非禁能）。

## 一、agent 自改本仓库代码：暂不做

工作区仓库里有一份评估（`cf-agent-workspace/reports/issue-self-modification.md`），结论是**技术上早已可行**，而且比最初判断的更容易：沙箱能 clone / 装依赖 / 跑通全部测试（实测过），部署链路也早已自动化 —— [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) 由 **push main** 触发，自带 `typecheck` + `npm test` 双重门禁，**agent 不需要持有任何 EdgeOne 凭证**。

所以「缺口」只剩写权限一件事：给一把能改 `edgeone-agent-lab` 自己的 PAT 就闭合了。**正因为只差这一步，这个决定才必须写下来**，否则下一个人会顺手把它做了。真正的理由不是「做不到」，而是能力一旦给出去后的后果：

- 给 agent 改自己代码的能力 = 它能改**自己的提示词、自己的工具集、自己的安全边界**。这里的「安全边界」是有具体指代的：`INTERNAL_TOKEN` 校验（见[会话路由与三种入站实现](../architecture/conversation-routing-and-ingress.md)）、`GITHUB_ISSUE_REPOS` 仓库白名单、以及本页第四节那个 `EXCLUDED` 列表。**一次错误改动就能让它自己敞开后门，而这份代码是它自己写的。**
- 护栏本身有软肋：**workflow 文件也在仓库里** —— 能改 `.github/workflows/`，就能删掉 `npm test` 那一步、绕过门禁。换句话说，那个自动化门禁并不能当成「自改」的最终防线，因为它和它保护的代码同处一个可写面。

**决定：暂时不做（2026-09-26）。** 将来要重新评估，最小起步是两条一起上：

1. **只给开 PR、不给直推 main** —— `push: [main]` 才部署，这个平台机制天然等于「改动必须经人合并才上线」，比靠提示词自觉可靠；
2. **明确禁改 `.github/workflows/`** —— 先跑一段时间观察，再谈放宽。

注意第 1 条不是新增机制，而是**复用现有部署触发条件**：`.github/workflows/deploy.yml` 的 `on: push: branches: [main]` 与 `workflow_dispatch` 已经把「上线」和「合并到 main」绑在一起。这也是为什么评估里说「只差写权限」时，术语用的是「最小起步」而不是「最小实现」——护栏是一条工作流约定，不是一段代码。

## 二、飞书云文档：不开 `drive:drive`，建了就删不掉

飞书应用**刻意没有** `drive:drive` / `space:document:delete` scope，所以它建出来的文档**删不掉也移不动**（调 delete 回 `99991672`，要求这两个 scope 之一）。删文档的 API 本身是有的（`DELETE /drive/v1/files/{token}?type=docx`，进回收站），卡点只在 scope。

⚠️ **这是有意的取舍，不是漏配**。看到「机器人建了文档却删不掉」时，**别去控制台把 scope 开上**。回访前提是先把产品问题答清楚：「模型在什么条件下才该删、删错了谁赔」。

这里还有一条被实测推翻的推断，值得一并记住，因为它把「谁来善后」这个问题弄得更复杂：

| 文档由谁建 | 用户在飞书里能打开吗 | 用户能删吗 |
|---|---|---|
| **应用身份**（2026-09-25 的旧做法，已弃用） | 看得到，但只有**只读** | 不能 —— 菜单点「删除」回 `无权限操作` |
| **用户身份**（2026-09-26 起的做法） | 看得到，可编辑 | 能 —— 文档归用户自己名下 |

结论是「由人去飞书里清」这条善后路径**只对用户身份建的文档成立**。2026-09-25 那批用应用身份建的测试文档两边都清不掉（应用缺 scope、用户缺权限）。这也是后来 `feishu_docx_create` 改成**只用用户身份、不兜底到应用身份**的直接原因之一 —— 详见[身份与授权](identity-and-authorization.md) 与 [工具契约与清单](tool-contract-and-inventory.md)。

## 三、GitHub issue：只开与评论，不给关闭

`src/ghworkspace/issue-tools.ts` 只提供两个工具：`gh_issue_create` 与 `gh_issue_comment`。**不做关闭**，理由写在文件头注释里：

> 关闭别人提的 issue 是破坏性且**面向他人**的操作，agent 误操作一次就影响协作者。

与仓库既有约定一致：`ws_rm` 只删文件不删目录，`EXCLUDED` 里也刻意排除了 `files_remove`。

这一族还有一条配套的**凭证分离**决定，虽然属于配置而非「不做」，但和上面的边界是同一次设计：issue 走独立的 `GITHUB_ISSUE_TOKEN` + `GITHUB_ISSUE_REPOS` 白名单，不复用 `GITHUB_WORKSPACE_TOKEN`。原因是 `GITHUB_WORKSPACE_TOKEN` 只授了 Contents 读写，而 GitHub 的 Issues API 不属于 Contents 权限范围 —— 复用会让「改工作区凭证」这个动作意外影响 issue 能力，反之亦然。

白名单的**空值语义**是这条边界的强制点：`ghIssueConfig()` 在 token 或白名单缺失/全非法时返回 `null`，于是整族工具一个都不挂。注释写明了为什么宁可没有工具：「只有 token 没有白名单」= 「这把 token 能开的仓库全都能开」，**那正是这个功能最不该有的形态**。`test/smoke.ts` 的 M 节钉住了这条（`ghIssueConfig({ GITHUB_ISSUE_TOKEN: "t" }) === null`）。

提示词里对应的一段（`ISSUE_PROMPT`）把重点放在边界而不是用法：「issue 发出去别人已经看到了、通知也发出去了，撤回不了」；「开之前先把标题和要点念给用户确认」；「你**关不掉** issue，要关得让用户去 GitHub 上操作」。工具描述与返回值里的 `note` 也重复了同一句 —— 「它对外可见，撤回不了」。

## 四、平台沙箱：不挂 `files_remove` 与 `browser_*` 交互类工具

`agents/feishu/_tools.ts` 的 `EXCLUDED` 常量是一份**排除**名单，`platformTools()` 用 `all().filter(...)` 把其中的名字全部摘掉：

```ts
const EXCLUDED = new Set([
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_evaluate",
  "files_remove",
]);
```

两类的理由不同，但都指向「这条链路没有对应的使用场景」：

- **`browser_*` 那四个**是「点页面元素」的操作类工具。模型在飞书里答一个问题，**没机会跟人来回确认点击目标**，挂了只会让它乱点一通。要读网页用 `browser_fetch`（这个挂着）。
- **`files_remove`** 是删文件。沙箱本来就会过期，不需要模型手动清理；留着反而多一个**误删自己刚写的数据**的机会 —— 典型的破坏性操作，收益极低。

这里还有一个**同名工具被摘掉**的例子（虽然动机是「坏的」而不是「危险的」）：平台的 `web_search` 底层依赖腾讯云 WSA，本项目没配 `WSA_API_KEY`，一调就报 `web_search requires the WSA_API_KEY environment variable.`。所以自建了一个同名的（serper，见 `agents/feishu/_search.ts`），并给 `platformTools()` 加了 `extraExcluded` 参数把它摘掉 —— 两个同名同用途的工具同时在列表里，模型选哪个全看运气。`_host.ts` 里的调用点是 `searchTools.length ? ["web_search"] : []`。

`SANDBOX_ENABLED=0`/`false`/`off` 可以让**整条**平台工具不挂，用于「先把纯搜索问答跑通」的部署阶段。这是 `platformTools()` 的开关，与 `EXCLUDED` 是两层不同的粒度。

## 五、仓库语料层（`/repo` + 整个 `src/workspace/`）：主动删除

**这是后来主动删的，不是移植时就没搬。** 移植时 `src/workspace/` 是**搬过来了、还跑通了**的：9 个文件（`repo` / `tools` / `github` / `tar` / `glob` / `filter` / `decode` / `serve-ingest` / `types`），配 `/repo owner/name` 命令、快照持久化，以及 `test/smoke.ts` 里两整节测试。删除发生在 **2026-09-25**。

删掉的原因：**助手定位变了**。用户要的是「通用助手」，不是「问某个 GitHub 仓库」。留着这套东西的代价不是几行代码，而是三件具体的事：

- 提示词里得同时照顾两种人格（「用户先导语料」和「手上什么都没有」），而这两者的工具集和行为规则是**冲突的**；
- `read` / `ls` / `grep` / `find` 这四个工具名和沙箱那族**语义重叠**，模型会在两套之间选错；
- 删掉之后「手上没有的语料」这件事不存在了，提示词能只说一件事。

这是删除而非禁能的例子，收益是**复杂度归零**：`repo.snapshot` 的 6MB 上限、generation 制的原子切换、`fileCursor` 的惰性游标曾经是这份移植里最复杂的点之一，定位一变全部消失。

删除的范围是一次改完、两边仓库都改：

| 删了什么 | 说明 |
|---|---|
| `src/workspace/` 9 个文件 | 整个目录 |
| `Command` 的 `repo` 成员 | 连带 `OWNER_RE` / `REF_RE` / `parseRepoArg` / `REPO_USAGE` |
| `turn.ts` 的 `case "repo"` | 不删编译不过（`case` 必须是联合成员） |
| `FeishuTurnHost.ingest()` | 接口从 3 个方法缩到 2 个 |
| `HostDeps.repo` + `makeSnapshotStore()` | `agents/feishu/index.ts` 里那套快照存储 |
| 提示词里的「怎么用这四个工具」 | `agents/feishu/_instructions.ts` |
| `compact.ts` 里的「导入过哪些仓库」 | 换成「引用过的来源」 |
| `test/smoke.ts` 的 E / F 两节 + `seed()` | 换成一条「`/repo` 已判成未知命令」的端到端测试 |

**没删的**：长期记忆（`global-memory.ts`）、云文档工具族（`docs.ts`）、会话压缩（`compact.ts`）、沙箱工具、webhook 转发 —— 这些和「问哪个仓库」无关。

### ⚠️ 删一层之前先看有没有别人在 import 它里面的通用零件

这是删除过程中踩出的一条规则，和上面那张表同等重要。`src/workspace/tools.ts` 里住着 `guarded()`（工具永不抛的兜底），而 `src/feishu/docs.ts` 和 `agents/feishu/_search.ts` 都在用它。**直接 `git rm` 会把两个不相干的模块一起搞崩。** 正确做法分两步：先把 `guarded()` 抽到 `src/shared/util.ts`、改完 import，再删目录。

`src/shared/util.ts` 的文件头把这条教训原样留了下来：

```ts
// `guarded` 原先住在 `src/workspace/tools.ts` —— 而 `workspace/` 是
// 「读**用户导入的**仓库快照」那一层，2026-09-25 把 agent 改成通用助手时整层删掉了。
//
// 但还有两处在用 `guarded`，所以先搬出来，别让它跟着那一层一起消失：
//   · `src/feishu/docs.ts`（飞书云文档工具族）
//   · `agents/feishu/_search.ts`（自建 web_search）
//
// 教训：**删一层之前先看有没有别人在 import 它里面的通用零件。**
```

### 残留的可观测痕迹（不是缺口）

删除后有几处「看着像问题」的现象，都是**刻意保留**的信号，不是遗留 bug：

- **`/repo` 走的是「不认识的命令」分支**，而不是被静默当成提问转发给模型。`src/feishu/commands.ts` 的 `default` 分支返回 `{ kind: "error" }`；`test/smoke.ts` 里有一条端到端测试专门守这个 —— 它的注释写明了风险方向：如果哪天 `default` 被改成 `{ kind: "ask" }`，用户发 `/repo a/b` 会拿到一段模型即兴发挥的答复，而编译器完全看不出来。
- **`_host.ts` 的 `statusText()` 改报长期记忆规模与云文档授权**，不再报「导入了哪个仓库、文件数、语料大小」。
- **`_instructions.ts` 里不再出现 `read` / `ls` / `grep` / `find`** —— 这是「删工具时必须同步删提示词」那条硬规矩的应用（「说了但手上没有的能力，模型会去调然后白烧一轮」）。

## 一点方法学：这些决定都留了「回访前提」

五条落点各自记录了重新评估的入口条件，形式不同但都很具体：

| 决定 | 回访前提 |
|---|---|
| agent 自改代码 | 只开 PR 不给直推 main **且**明确禁改 `.github/workflows/`，先观察一段时间 |
| 文档删除（`drive:drive`） | 先答清「模型在什么条件下才该删、删错了谁赔」，再谈 scope |
| issue 关闭 | 未记录 —— 当前不设条件，因为它是纯粹「面向他人」的破坏性动作 |
| `files_remove` / `browser_*` | 未记录 —— 缺的是使用场景（沙箱会过期 / 无人工确认环节），场景变了才谈 |
| 仓库语料层 | 定位若是「重新变成代码问答助手」则自然回归；删除本身没有可逆设计 |

这张表本身就是本页要守的东西：**记录理由，省得下一个人重新推一遍**；而在没有前置条件时，如实写「未记录」，比编一个模糊的门槛诚实。
