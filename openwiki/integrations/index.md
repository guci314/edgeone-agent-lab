# 文件

- [外部入站中继：CF Worker 与本地 bridge](external-ingress-relay.md) - 把飞书事件送进 EdgeOne agent 的两条平台外链路——当前生效的 CF Worker 中继（验签、解密、立即 ACK、ctx.waitUntil 后台转发带重试、EO_* 共享密钥）与保留但已停用的本机 bridge 长连接进程（EventDispatcher、自环过滤、先 ACK 再转发、launchd 常驻、sync-env 同步密钥），以及促成两者的平台限制。
- [飞书开放平台集成面](feishu-open-platform.md) - 本项目对飞书开放平台的全部依赖集中在这里——两套 API 域名（open.feishu.cn 与 accounts.feishu.cn）、租户令牌与用户令牌端点、发消息、cardkit 流式卡片、四类云文档的接口与所需 scope、以业务码为准的错误处理（FeishuError / 99991663 / 99991664 / 99991672 / 99991679）、TokenCache 注入式缓存，以及后台侧的前置配置（事件订阅、url_verification 握手、权限、发版）。
- [模型网关路由与重试诊断](model-gateway-routing.md) - 一个模型请求在这套移植里怎么被选路、怎么被修好：resolveModelRoute 为什么要求 key 与 baseURL 成对取、为什么优先 OPENCODE_* 而不是平台托管的 AI_GATEWAY_*、两家网关相反的模型名规则、x-opencode-session 头、Chat Completions 与 Responses 的模型类选择，以及那层 fetch 包装如何同时记录出站形状与入站原文并重试 SDK 会原样透出的 400。
