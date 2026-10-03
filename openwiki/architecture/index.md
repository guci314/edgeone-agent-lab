# 文件

- [会话路由与三种入站实现](conversation-routing-and-ingress.md) - 飞书 chat 如何映射成 EdgeOne 会话：确定性的 fs-+sha256(chat_id) 前缀 32 位、6~36 字符与字符集约束，平台按 conversation_id 做的三件事（粘性路由、store 归属、沙箱归属），以及三种必须产出同一 id 与同一事件字段的入站实现。
- [架构总览：两个运行时与可移植的 src/ 层](overview.md) - edgeone-agent-lab 的顶层组件与目录地图：EdgeOne Makers 的两个运行时（无状态请求模式的 cloud-functions/feishu-webhook 与会话模式的 agents/feishu）、平台强制的 Makers-Conversation-Id 接口、与平台无关的 src/ 业务层、静态状态页、本地-only 的 bridge 与 tools/ 脚本，以及 edgeone.json 如何把它们绑成一个可部署单元。
- [平台约束与弱化的保证](platform-constraints.md) - EdgeOne Makers 的能力边界如何决定这套移植的每一个设计：无命名实例 RPC、无 SQL、无 alarm、免费版 cron 最小 1 天、agents 单次 900 秒；由此欠下的三笔强保证债务（去重不是分布式锁、Blob 无 CAS/TTL、会话历史恒被截到最近 100 条），它们各自在代码哪里被强制，以及恢复强保证时唯一该动的那两条窄缝。
- [入站请求生命周期：从 webhook 到回复](request-lifecycle.md) - 一条飞书消息从 POST /feishu-webhook 到回复落进会话的完整控制流：raw body 先于解析、解密先于识别挑战、挑战握手先于验签、自环先于去重这四步的强制顺序及其失败后果，chat_id→conversation_id 哈希转发、agent 侧令牌门禁、去重与限流、async 202 与 sync 两种调度、模型回合，以及回复经纯文本或流式卡片回到飞书的路径。
