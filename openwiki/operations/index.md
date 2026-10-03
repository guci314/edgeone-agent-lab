# 文件

- [环境变量与配置目录](configuration-and-env.md) - 这套移植的完整配置面及其失败语义：飞书应用凭证与 Encrypt Key、作为 fail-closed 门禁的 INTERNAL_TOKEN、模型路由变量与被平台托管的 AI_GATEWAY_*、调度模式、沙箱开关、记忆命名空间与 projectId 兜底、serper key、工作区与 issue 两把 GitHub token 及白名单、OAuth 回调、每用户令牌续期测试开关，以及把密钥挡在生成文档外的 OpenWiki/忽略规则。
- [部署与发布](deployment-and-release.md) - 代码怎么上线：push main 触发的 GitHub Actions 工作流（typecheck + 冒烟测试作为上线门禁）、EdgeOne Makers 的四条 deploy 规则（不带路径参数、先清陈旧 zip、overseas 区域、只上传构建产物）、NODE_OPTIONS safe-delete 卡死的成因与绕法、AI_GATEWAY_* 在部署时被重置，以及"整个项目目录会被当公网静态资源上传"这条目录布局教训。
- [诊断、探针与排障](diagnostics-and-probes.md) - 这套移植的可观测面：七个 ?probe= 自测端点各自隔离哪一层（后台执行、env 与请求头形状、模型、搜索、跨会话存储、真实回合原始报文），统一门禁 tokenGate 与两处刻意的公开例外，用于证明钩子确实跑过的诊断计数器，以及「探针是 GET、边缘会缓存」这条复验铁律和症状到层的排障表。
