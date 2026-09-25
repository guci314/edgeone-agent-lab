# bridge —— 飞书长连接桥接进程

> ⚠️ **本方案已被替代，目前是备选。**
> 当前生效的链路是：飞书 webhook → **CF Worker 转发**（cf-agent-lab 的
> `src/feishu/edgeone-relay.ts`）→ EdgeOne agent。CF Worker 免费、7×24 常驻，
> 不依赖本机开机。本目录保留：如果哪天不想经过 CF，把飞书订阅方式改回
> 「长连接」、在本机跑起这个进程就能顶上，两边算法（conversation id、
> 事件字段）完全一致，切换无痕。

> ## ⚠️ 依赖已移出本目录（2026-09-25）
>
> 本目录的 `node_modules/` 和 `.npm-cache/` **已挪到 `~/.config/edgeone-bridge/`**。
>
> 原因：EdgeOne **没有部署忽略清单**，会把整个项目目录当公网静态资源上传，
> 而 CLI 的排除清单（含 `node_modules`）**只在项目根生效**。于是
> `bridge/node_modules`（47M）+ `bridge/.npm-cache`（445 文件）被完整打包上传，
> `.edgeone/assets/bridge/` 膨胀到 50M、上传 105 个批次，最后在 batch 85 崩掉：
>
> ```
> Error: ENOENT: no such file or directory,
>   open '<项目>/.edgeone/assets/bridge/.npm-cache/_cacache/...'
> ```
>
> 移走之后 assets 从 1673 文件 / 50M 降到 40 文件 / 600K，部署 1 分钟跑完。
>
> **要在本机跑这个 bridge**，依赖得装回来（但别装回项目目录，否则下次部署又会崩）：
>
> ```bash
> mkdir -p ~/.config/edgeone-bridge && cd ~/.config/edgeone-bridge
> cp <项目>/bridge/package.json <项目>/bridge/package-lock.json .
> npm install --cache ./.npm-cache --no-audit --no-fund
> # 然后把 bridge/index.mjs 也拷过来跑（.env 本来就在这个目录）
> ```
>
> **更彻底的做法**：把整个 `bridge/` 移出项目目录。本目录的源码目前仍在公网可读
> （`https://<域名>/bridge/index.mjs` → 200），虽然不含密钥（配置已移到
> `~/.config/edgeone-bridge/.env`），但没有理由公开。
> 这是个待定的目录布局决定 —— 见项目 `docs/03-验证清单.md`。


一个**跑在你自己机器上**的常驻小进程，负责把飞书消息转给 EdgeOne 的 agent。

```
飞书 ──长连接(WS)──> bridge（本目录）──HTTP 公网──> https://<域名>/feishu（EdgeOne agents 路由）
                                                        │
                                             agent 自己调飞书 API 回复
```

## 为什么要有这个进程

EdgeOne Makers 的两种 Runtime 是**分离的**：

- `cloud-functions/` 内部 `fetch` 同项目的 `agents/` 路由 → 平台直接拒
  （`404 domain endpoints match fail`，自定义域名和预设域名都一样）
- 官方文档也写明 cloud-functions 的 context 只有 `request / env / agent.store`，
  没有调 agent 的 API

但**从外部**带 `Makers-Conversation-Id` 请求 agent 路由是通的。所以把"收事件"
这一层挪到外面的常驻进程，用飞书的**长连接**模式收（不需要公网回调地址）。

这样 agents 的能力全部保留：沙箱、工具、单次 3600 秒、按 conversation_id 粘性路由。

## 跑起来

```bash
cd bridge
npm install
npm run sync-env      # 需要 EDGEONE_API_TOKEN，从云端拉飞书凭证
npm start             # 看到 "[bridge] 长连接已就绪" 就成了
```

前台跑着时终端不能关。要常驻见下面。

### 常驻（macOS / launchd）

```bash
cp launchd/com.guci.feishu-bridge.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.guci.feishu-bridge.plist
launchctl list | grep feishu-bridge      # 确认在跑
tail -f /tmp/feishu-bridge.log
```

Linux 服务器同理，写个 systemd unit；或者 `docker run -d` / `pm2 start`。
唯一的要求是**网络能出公网 + 进程别死**。

## 环境变量（`~/.config/edgeone-bridge/.env`）

| 变量 | 来源 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 云端 | 建立长连接用 |
| `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` | 云端 | 事件验签/解密 |
| `INTERNAL_TOKEN` | 云端 | **必须和 agent 侧同一个值**，否则 agent 返 401 |
| `AGENT_URL` | 写死 | 默认 `https://eolab.yujizi.org/feishu` |

云端改了这些值 → `npm run sync-env` → 重启 bridge。

⚠️ **env 文件放在项目目录外（`~/.config/edgeone-bridge/.env`），不要挪回 `bridge/.env`。**
2026-09-25 踩过：EdgeOne 部署会把**整个项目目录**当静态资源上传，静态资源公网可读 ——
`https://eolab.yujizi.org/bridge/.env` 曾返回 200，飞书 APP_SECRET / ENCRYPT_KEY /
INTERNAL_TOKEN 明文挂在网上两天。`.gitignore` 只挡 git，**挡不住部署**；平台也没有
「部署忽略清单」这种配置（`edgeone.json` 的 schema 里没有 exclude / ignore 字段）。
结论：**含密钥的文件一律不能待在项目目录里。**

## 两个已经踩过的坑（改代码前先看）

### 1. `request.headers` 在这个 runtime 里不是标准 Headers

Makers 的 agents runtime 传进来的 `context.request.headers` 是**普通对象**
（`typeof headers.get === "undefined"`），不是 `Headers` 实例。
原来的 `request.headers.get("x-internal-token")` 恒等于 `""`，
于是**所有转发一律 401**，而报错只说"不匹配"，根本看不出是取不到。

现在 agent 侧三种形态都读（Headers 实例 / 普通对象 / body），
bridge 这边 header 和 body `token` 字段**都发**，哪条路通都能过。

诊断端点（都要带 `Makers-Conversation-Id` 头和 `token=INTERNAL_TOKEN`）：

| 端点 | 看什么 |
|---|---|
| `?probe=env` | env 指纹 + request 结构 + `match`；`model` / `baseUrl` / `opencodeSession` |
| `?probe=model` | 真的打一次模型，回显 `upstream`（哪个网关）+ 状态码 |
| `?probe=search` | 真的打一次 serper，回显原始状态码和结果标题 |

`?probe=env` 只证明变量**读到了**，不证明请求**发得出去**。要后者用 `?probe=model`。
详见 `docs/03-验证清单.md` 的「诊断探针」。

### 2. handler 里不能 `await` 转发

实测：同步等转发（约 4 秒）会超过飞书的 ACK 时限，飞书把同一条消息**再推一次**。
日志里表现为同一个 messageId 成对出现（`→ 202` 然后 `→ 200`）。
第二次靠 agent 的去重挡住了（返 `duplicate`），不重复回答，但白白多跑一次。

所以现在收到事件**立刻 ACK**（`return {code:0}`），转发放到后台。

## 改了云端 env 之后为什么还是 401

实测：**改云端项目环境变量不会实时生效**，agent 用的是部署时打包的快照
（至少边缘节点切换要一两分钟）。所以：

1. 改云端 env
2. **重新部署**（`npm run deploy`，在项目根目录）
3. 边缘节点切完（一分钟内）再测
4. `npm run sync-env` + 重启 bridge

排查顺序：`?probe=env` 看 `match` 字段 → `false` 就比对指纹 → 指纹一致还 401 就是还没切完。

## 这个目录不参与部署

EdgeOne 部署只认 `agents/` 和 `cloud-functions/`。这里的东西**只在本地/服务器跑**。
