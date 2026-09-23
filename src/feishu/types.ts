// 飞书链路里跨模块共用的几个类型。
//
// 原版 `FeishuQueueEvent` 定义在 `src/feishu/router.ts` 里 —— 而 router 是
// 依赖 `getAgentByName`（Cloudflare DO 原生 RPC）的那一层，EdgeOne 上没有对应物，
// 所以整个 router 被换成了 `cloud-functions/feishu/webhook.ts`。
// 类型本身跟平台无关，单独挪出来，免得 turn.ts 去 import 一个不存在的模块。

/** 一条待处理的飞书消息。webhook 解析出来 → 交给 agent 的回合流程 */
export interface FeishuQueueEvent {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  openId: string;
  text: string;
}
