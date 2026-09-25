// 把 EdgeOne 项目里配的环境变量同步成本地 bridge 的 env 文件。
//
// 用法：
//   EDGEONE_API_TOKEN=xxx npm run sync-env
//
// ── 为什么需要 ──────────────────────────────────────────────────────
// bridge 用的 FEISHU_APP_ID / SECRET / INTERNAL_TOKEN 必须和 agent 那边
// **同一个值**（token 不一样直接 401）。手抄迟早出错，所以从云端拉。
// 云端改了这些值就再跑一次，然后重启 bridge。
//
// 注意：AGENT_URL 不在云端 env 里，这里写死（见 .env 里的注释）。
//
// ── ⚠️ 文件为什么写到项目外面（2026-09-25 血的教训）────────────────
// 这里以前写的是 `bridge/.env`（项目内）。结果 EdgeOne 部署会把**整个项目目录**
// 当静态资源上传，而静态资源是公网可读的 —— 于是
//   https://eolab.yujizi.org/bridge/.env   → 200
// 飞书 APP_SECRET / ENCRYPT_KEY / INTERNAL_TOKEN 明文挂在公网上两天。
//
// `.gitignore` 只挡 git，**挡不住部署**。项目里根本没有「部署忽略清单」这种配置
// （edgeone.json 的 schema 里没有 exclude / ignore 字段，CLI 也没有对应参数）。
// 所以结论是：**任何含密钥的文件都不能待在项目目录里**。
// 现在写到 ~/.config/edgeone-bridge/.env（项目外），部署永远碰不到它。

import { Makers } from "@edgeone/makers-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const envDir = path.join(os.homedir(), ".config", "edgeone-bridge");
const envPath = path.join(envDir, ".env");

const token = process.env.EDGEONE_API_TOKEN;
if (!token) {
  console.error("缺 EDGEONE_API_TOKEN。用法：EDGEONE_API_TOKEN=xxx npm run sync-env");
  process.exit(1);
}

const projectId = process.env.EDGEONE_PROJECT_ID || "makers-z7cwsvvsvylf";
const makers = new Makers({ token, region: "china" });
const envs = await makers.projects.listEnvs({ projectId });
const get = (k) => (envs.find((e) => e.key === k) || {}).value || "";

const keys = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_ENCRYPT_KEY",
  "INTERNAL_TOKEN",
];

const missing = keys.filter((k) => !get(k));
if (missing.length) {
  console.error("云端缺少这些变量：", missing.join(", "));
  process.exit(1);
}

const lines = [
  "# bridge 进程的环境变量。⚠️ 放在 ~/.config/edgeone-bridge/ 下（项目外），",
  "# 因为 EdgeOne 部署会把项目目录整体当静态资源上传，项目内的 .env 会公网可读。",
  `# 由 EdgeOne 项目 ${projectId} 的环境变量同步生成（npm run sync-env）`,
  "# 云端改了这些值 → 重新同步 → 重启 bridge",
  "",
  ...keys.map((k) => `${k}=${get(k)}`),
  "",
  "# 转发目标：EdgeOne 项目的 agent 路由（公网地址，从外部调用）",
  "AGENT_URL=https://eolab.yujizi.org/feishu",
  "",
];

fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
console.log("已写入", envPath);
for (const k of keys) {
  const v = get(k);
  console.log(`  ${k} = ${v.slice(0, 6)}… (len ${v.length})`);
}
