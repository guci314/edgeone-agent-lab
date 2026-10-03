# 文件

- [跨会话长期记忆：Blob 后端、命名空间隔离与可见性边界](cross-session-memory.md) - 一片所有飞书会话共享的事实键空间，落在裸 Blob 的 agent-memory-<projectId> 命名空间里；一条事实一个键、信封编码、MAX_ENTRIES 软上限、isVisibleTo 统一权限边界、每轮提示词快照与实时 recall_facts 的分工，以及后端拿不到时的静默降级。
- [刻意不做的事与破坏性能力政策](design-non-goals.md) - 已记录的设计决定清单——agent 不自改本仓库代码、不开 drive:drive / 文档删除、不给关闭 issue 的能力、不挂 files_remove 与 browser_* 点击类工具、以及删除仓库语料层（/repo + src/workspace/*）的理由与回访前提；它们都不是待办缺口。
- [身份模型：应用身份与用户身份](identity-and-authorization.md) - 飞书链路里两种身份如何使用——tenant_access_token（应用身份）用于共享文档与发消息，user_access_token（用户身份）按 openId 分槽用于更广的文档范围与新建文档；包含 scope 清单与 offline_access 前提、签名 state 作为回调唯一可信的身份来源、refresh token 的单飞续期与新旧值合并，以及新建文档为何拒绝退回应用身份。
- [提示词契约与模型行为规则](prompt-contract.md) - 把系统提示词、按配置拼接的段落、工具描述、字段说明和摘要提示词统一当成对模型生效的契约：每句能力声明必须对应一个真实挂着的工具，规则只写在模型看得见的地方（代码注释等于没写），记忆读数三条规则与快照机制，来源分离，以及飞书纯文本回执不渲染 Markdown 而卡片渲染的排版分野。
- [存储模型：三个键空间](storage-model.md) - 飞书链路上的三个互相隔离的持久化域——按会话隔离的平台 state（feishu.events / feishu.token / feishu.userToken.<openId>）、平台托管的对话历史（openaiSession）、以及跨会话共享的 Blob 命名空间 agent-memory-<projectId>；含它们的物理前缀、读写入口、隔离规则，和取代原版 SQLite 表的「进程内权威副本 + 写穿」模式。
- [工具契约、工具族清单与挂载规则](tool-contract-and-inventory.md) - 模型能看到的每一个工具的完整清单（平台沙箱工具减去 EXCLUDED、自建 web_search、飞书云文档七个、记忆三个、工作区 ws_* 加 ws_commit、gh_issue_*），全仓统一的工具契约（永不抛错转 { error }、返回 JSON 字符串、截断必须显式标注并给出续读办法），按配置完整性决定工具族挂载与提示词段落同开同关的规则，以及 summarizeToolOutput / toolFailed 这套把工具结果压成卡片一行的耦合实现。
