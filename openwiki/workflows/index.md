# 文件

- [命令分派与控制流：从一条消息到一个动作](commands-and-control.md) - 一条飞书文本怎样被 parseCommand 判成 Command 联合的某个成员，runFeishuTurn 的 switch 如何把它路由到宿主方法或模型，safeReply 与 ask 分支的两种异常策略（吞掉 vs 让它冒出去）各自为什么，以及 sent[] 记录为什么让 ?mode=sync 成为唯一机器可读的答复通道。
- [飞书云文档读写工具族的端到端流程](feishu-doc-read-write.md) - 七个云文档工具从链接解析到落盘的完整路径——docx/sheets/bitable/wiki 四种链接形态与 wiki 解引用、读走「应用身份优先、用户身份兜底」而新建只认用户身份、逐次翻页与显式截断契约、单元格与字段的拍平与每调上限、只能追加的写入模型，以及可执行的合并授权错误文案。
- [GitHub 工作区工具与自动部署闭环](github-workspace-and-deployment.md) - agent 自己的 GitHub 工作区：ws_ls / ws_read / ws_write / ws_rm / ws_commit 五个工具背后的 Contents 与 Git Data API 客户端（sha 自动解析、base64 折行容忍、base_tree 保留、一次提交的上限），为什么 projects/<名字>/ 目录是可部署单元，写入 → commit → CI → 双平台部署 → .deploy-status.json 回读的闭环，以及独立凭证与白名单的 gh_issue_* 工具族。
- [云文档 OAuth 授权流程：从 /login 到令牌落盘](oauth-authorization-flow.md) - 飞书云文档用户身份授权的完整往返——FEISHU_OAUTH_REDIRECT_URI 拼出授权链接、用 INTERNAL_TOKEN 签名的 state 携带 chatId/openId、浏览器经中转补 Makers-Conversation-Id 头后落到 agent 的 op="oauth" 分支（排在去重之前并同步返回）、授权码换令牌、按 openId 落槽，以及成功/拒绝回执与 /status 的授权状态。
- [会话压缩：手动 /compact 与自动压缩](session-compaction.md) - 对话历史的两种压缩路径：平台 session 的三步组合（getItems → 摘要 → clearSession → addItems）与静默施加的 100 条窗口、手动与自动共用的唯一实现 runCompact 及其两条安全约束、挂在截断标记上的 shouldCompact 判据、自动压缩在流式收尾中的位置，以及让静默失效可观测的两个诊断计数器。
- [模型流式输出、工具事件与卡片渲染](tool-invocation-and-streaming.md) - 一轮模型回合如何变成用户看得见的回答：建 Agent（模型类、maxTurns、输出上限、工具列表、instructions 的字符串/函数两种形态）、消费 Agents SDK 的流、把 raw_model_stream_event 与 run_item_stream_event 映射到飞书卡片的分段（思考 / 工具调用 / 工具结果 / 答案）、同步 push 与 250ms 出网队列、卡片起不来时退回单条纯文本、以及 finalOutput 优先于自攒增量。
