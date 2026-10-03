# 文件

- [端到端验证脚本与执行顺序](end-to-end-verification.md) - 面向已部署 agent 的生产验证工具链：npm run ask 的无头合成回合、verify:memory 的跨会话记忆七阶段、verify:autocompact 用诊断计数器证明自动压缩真的触发，以及必须从开发机而不是部署运行时读回复的取值路径与五类假阳性陷阱清单。
- [冒烟测试套件：平台无关的 13 节（A~M）与全局 fetch 桩](smoke-tests.md) - test/smoke.ts 的选材原则与执行模型——裸 Node 跑 --experimental-strip-types、单一进程里替换全局 fetch、每节自装桩互不依赖；A~M 十三节各自钉住什么；以及「断言抄实现」这类假信心陷阱与它留下的三处结构性缺口。
