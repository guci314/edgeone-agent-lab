// 把 EdgeOne 项目里配的环境变量同步成本地 bridge/.env。
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

import { Makers } from "@edgeone/makers-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");

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
  "# bridge 进程的环境变量（本地文件，不进 git、不部署到 EdgeOne）",
  `# 由 EdgeOne 项目 ${projectId} 的环境变量同步生成（npm run sync-env）`,
  "# 云端改了这些值 → 重新同步 → 重启 bridge",
  "",
  ...keys.map((k) => `${k}=${get(k)}`),
  "",
  "# 转发目标：EdgeOne 项目的 agent 路由（公网地址，从外部调用）",
  "AGENT_URL=https://eolab.yujizi.org/feishu",
  "",
];

fs.writeFileSync(envPath, lines.join("\n"));
console.log("已写入", envPath);
for (const k of keys) {
  const v = get(k);
  console.log(`  ${k} = ${v.slice(0, 6)}… (len ${v.length})`);
}
