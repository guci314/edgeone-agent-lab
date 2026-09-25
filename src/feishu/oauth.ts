// 用户身份（`user_access_token`）的 OAuth：发授权链接、换 token、续期，
// 以及云文档链接的解析。
//
// ── 为什么不用 tenant_access_token ──────────────────────────────────
// 应用身份只能读「被显式共享给这个机器人」的文档 —— 每份文档都得右键加协作者。
// 用户身份读的是**用户自己有权读的一切**，代价是要走一轮 OAuth。
//
// ── 这个文件只碰两件事：URL 拼装/解析（纯函数）和两次 fetch（换 token）
// 存哪儿、什么时候刷新，是调用方的事。这样纯函数部分能在裸 Node 下测。
//
// ⚠️ 三个坑，写在最前面省得踩：
//   ① token 端点在 **accounts.feishu.cn**，不是 open.feishu.cn —— 和 api.ts 的
//      `base(env)` 不是同一个域名，所以这里自己拼 URL，不复用那个 base。
//   ② **`offline_access` 是拿到 `refresh_token` 的前提**。scope 里不带它，响应里
//      压根没有 refresh_token 字段，用户每两小时就得重新授权一次。
//   ③ 授权码**有效期 5 分钟、且只能用一次**。回调必须立刻换，不能排队重试。

/** 授权页与 token 端点跟其他 OpenAPI 不在同一个域名，见文件头 ① */
const ACCOUNTS_BASE = "https://accounts.feishu.cn";

/**
 * 要用户授予的权限。
 *
 * `offline_access` 是为了拿 refresh_token（见文件头 ②）。其余四个分别对应
 * docx / wiki / 多维表格 / 电子表格的只读。
 */
export const DOC_SCOPES = [
  "docx:document:readonly",
  "wiki:wiki:readonly",
  "bitable:app:readonly",
  "sheets:spreadsheet:readonly",
  "offline_access",
];

/** 提前多久判 access token 过期（毫秒）。留出一次请求的余量 */
export const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export interface UserToken {
  accessToken: string;
  /** 空串表示这次授权没拿到 refresh_token（没开 offline_access） */
  refreshToken: string;
  /** access token 到期的毫秒时间戳 */
  exp: number;
  /** refresh token 到期的毫秒时间戳；0 表示没有 */
  refreshExp: number;
  /** 授权人。用来发现「换了个人用同一个会话」 */
  openId: string;
  scope: string;
}

export interface OAuthEnv {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
  /**
   * 回调地址。**必须和飞书后台「安全设置 → 重定向 URL」里登记的完全一致**，
   * 差一个字符授权页就直接报错。所以不做默认值 —— 宁可启动时报清楚，也别猜。
   */
  FEISHU_OAUTH_REDIRECT_URI?: string;
  /** 给 state 签名用。和转发层（中转）共享，不额外引入密钥 */
  INTERNAL_TOKEN?: string;
}

export function redirectUri(env: OAuthEnv): string {
  const v = String(env.FEISHU_OAUTH_REDIRECT_URI ?? "").trim();
  if (!v) {
    throw new Error(
      "没有配置 FEISHU_OAUTH_REDIRECT_URI。它是 OAuth 回调地址，" +
        "必须和飞书后台「安全设置 → 重定向 URL」里登记的完全一致。",
    );
  }
  return v;
}

// ── state：既不透明也不可信，所以签名 ────────────────────────────────

export interface OAuthState {
  /**
   * 会话 id。**转发层拿它自己算出 conversation_id**，不是这里带过去的。
   *
   * 那个算法（`fs-` + sha256(chat_id) 前 32 位）是「同一会话必须永远落到同一
   * 实例」的保证，中转（cf-agent-lab 的 `edgeone-relay.ts`）里已经有一份并且
   * 每一条转发都在用。这里再存一份算好的值，等于把同一条不变量复制成两份 ——
   * 哪天要改就得两边同时改，漏一边表现为「两个会话的记忆串了」这种最难查的现象。
   */
  chatId: string;
  /** 发起授权的人。存进 token，用来识别「换了个人」；群聊里也是分槽的依据 */
  openId: string;
  /** 一次性随机数，防重放 */
  nonce: string;
  /** 发起时间（毫秒） */
  issuedAt: number;
}

/** state 的有效期。授权码本身 5 分钟失效，这里给宽一点覆盖整个来回 */
export const STATE_TTL_MS = 15 * 60 * 1000;

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmacB64(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

/** 常数时间比较，别用 `===` */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 把 state 编成 `base64url(payload).base64url(hmac)`。
 *
 * ⚠️ **签名是必须的**：state 会经过浏览器、飞书、以及中转三层，中间每一层
 * 都可能被人替换。不签名的话，任何人构造一个 state 就能把**自己的**授权码
 * 塞进别人的会话 —— 结果是受害者会话里存了攻击者的令牌，之后每次提问都在
 * 用攻击者的文档权限回答。中转那边也验一遍（用同一个密钥），两道关。
 */
export async function signState(state: OAuthState, secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${await hmacB64(secret, payload)}`;
}

/**
 * 验签并解出 state。任何一步不对就返回 null —— 调用方一律当成「无效回调」处理。
 */
export async function verifyState(raw: string, secret: string): Promise<OAuthState | null> {
  const dot = String(raw ?? "").indexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  if (!safeEqual(sig, await hmacB64(secret, payload))) return null;

  let state: OAuthState;
  try {
    state = JSON.parse(b64urlDecode(payload)) as OAuthState;
  } catch {
    return null;
  }
  if (!state?.chatId || !state?.openId) return null;
  // 过期的 state 一律作废：留太久等于给重放敞着门
  if (!Number.isFinite(state.issuedAt) || Date.now() - state.issuedAt > STATE_TTL_MS) return null;

  return state;
}

// ── 授权链接 ──────────────────────────────────────────────────────────

export function buildAuthorizeUrl(
  env: OAuthEnv,
  state: string,
  scopes: readonly string[] = DOC_SCOPES,
): string {
  const u = new URL(`${ACCOUNTS_BASE}/open-apis/authen/v1/authorize`);
  u.searchParams.set("client_id", env.FEISHU_APP_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri(env));
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("state", state);
  // ⚠️ `URLSearchParams` 把空格序列化成 `+`，不是 `%20`。OAuth 的 scope 是
  // 空格分隔的列表，有些服务端把 `+` 当字面量 —— 那样整个 scope 会变成
  // 一个不存在的长名字，授权页要么报错、要么授不到任何权限。
  // 两种解码其实都合规，但这个参数不值得赌，显式写成 %20。
  return u.toString().replace(/\+/g, "%20");
}

// ── 换 token / 续期 ───────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  // 出错时 Feishu 走 OAuth 标准字段；老接口走 code/msg。两种都认
  error?: string;
  error_description?: string;
  code?: number;
  msg?: string;
}

async function requestToken(form: Record<string, string>): Promise<UserToken> {
  const res = await fetch(`${ACCOUNTS_BASE}/oauth/v3/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`飞书 token 端点返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (!json.access_token) {
    const why =
      json.error_description || json.error || json.msg || `HTTP ${res.status}`;
    throw new Error(`飞书没有返回 access_token：${why}`);
  }

  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? "",
    // expires_in 单位是秒（通常 7200）
    exp: now + Number(json.expires_in ?? 7200) * 1000,
    refreshExp: json.refresh_token_expires_in
      ? now + Number(json.refresh_token_expires_in) * 1000
      : 0,
    openId: "",
    scope: json.scope ?? "",
  };
}

/** 用授权码换 token。**授权码 5 分钟失效且只能用一次**，失败要重新授权而不是重试 */
export async function exchangeCode(
  env: OAuthEnv,
  code: string,
  redirect: string,
): Promise<UserToken> {
  return requestToken({
    grant_type: "authorization_code",
    client_id: env.FEISHU_APP_ID,
    client_secret: env.FEISHU_APP_SECRET,
    code,
    redirect_uri: redirect,
  });
}

/**
 * 续期。
 *
 * ⚠️ **飞书会轮换 refresh_token** —— 响应里的新值必须落盘，否则下一次续期
 * 用的还是旧的，而旧的已经作废了。这是这类流程最常见的自伤。
 */
export async function refreshUserToken(env: OAuthEnv, refreshToken: string): Promise<UserToken> {
  return requestToken({
    grant_type: "refresh_token",
    client_id: env.FEISHU_APP_ID,
    client_secret: env.FEISHU_APP_SECRET,
    refresh_token: refreshToken,
  });
}

/**
 * 这个 token 现在还够用吗（留了提前量）。
 *
 * `skewMs` 可覆盖，是为了**能手工验续期链路**：默认提前 5 分钟判过期，
 * 意味着想看到一次真实的 refresh 得等将近两小时。用
 * `FEISHU_USER_TOKEN_SKEW_MS=7200000` 把提前量拉到 2 小时，一次调用就走到
 * 续期分支 —— 否则这条最容易坏的路只能靠「等两小时再看」来验。
 */
export function tokenFresh(
  tok: UserToken | null,
  now: number = Date.now(),
  skewMs: number = TOKEN_SAFETY_MS,
): boolean {
  return !!tok?.accessToken && tok.exp > now + skewMs;
}

// ── 云文档链接解析 ────────────────────────────────────────────────────

export type DocRef =
  | { kind: "docx"; token: string }
  | { kind: "wiki"; token: string; tableId?: string; sheetId?: string }
  | { kind: "bitable"; token: string; tableId?: string }
  | { kind: "sheets"; token: string; sheetId?: string }
  | { kind: "unknown"; reason: string };

/**
 * 把用户贴的链接解析成「去哪读」。
 *
 * ⚠️ 最容易错的一条：**wiki 链接里的 token 不是文档 token**，是知识库的
 * 节点 token。必须再调一次 `wiki/v2/spaces/get_node` 才能解出真正的 obj_token。
 * 少了这一步，所有 wiki 链接都会以「找不到文档」告终。
 *
 * 兼容的形态（都是实测见过的）：
 *   /docx/<id>            新版文档
 *   /docs/<id>            旧版文档（飞书会重定向到 /docx）
 *   /wiki/<node>          知识库节点（非文档的节点还可能带 ?table= / ?sheet=）
 *   /base/<app_token>     多维表格，可带 ?table=<table_id>&view=<view_id>
 *   /sheets/<token>       电子表格，可带 ?sheet=<sheet_id>
 * 域名带任意租户前缀（xxx.feishu.cn），也认 larksuite.com / larkoffice.com。
 */
export function parseDocUrl(raw: string): DocRef {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: "unknown", reason: "没有给链接" };

  // 用户可能只贴 `xxx.feishu.cn/docx/abc`（没有协议头，从地址栏拷的）
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { kind: "unknown", reason: "这不是一个能解析的链接" };
  }

  const host = u.hostname.toLowerCase();
  if (!/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(host)) {
    return { kind: "unknown", reason: `不是飞书文档的域名（${host}）` };
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  const token = parts[1] ?? "";

  if (!token) return { kind: "unknown", reason: "链接里没有文档 token" };

  switch (head) {
    case "docx":
    case "docs":
      return { kind: "docx", token };
    case "wiki": {
      // 知识库链接同样可能带 ?table= / ?sheet=。别看着它挂的是 /wiki/ 就丢掉：
      // 飞书里**新建的多维表格和电子表格默认就落在知识库**，用户从地址栏拷下来的
      // 链接大多是这个形状。这两个参数要留到解出节点、知道底层是什么之后再用
      // （见 docs.ts 的 resolveLink）。
      const tableId = u.searchParams.get("table") ?? undefined;
      const sheetId = u.searchParams.get("sheet") ?? undefined;
      return {
        kind: "wiki",
        token,
        ...(tableId ? { tableId } : {}),
        ...(sheetId ? { sheetId } : {}),
      };
    }
    case "base": {
      const tableId = u.searchParams.get("table") ?? undefined;
      return tableId ? { kind: "bitable", token, tableId } : { kind: "bitable", token };
    }
    case "sheets": {
      const sheetId = u.searchParams.get("sheet") ?? undefined;
      return sheetId ? { kind: "sheets", token, sheetId } : { kind: "sheets", token };
    }
    default:
      return {
        kind: "unknown",
        reason: `认不出这种链接（/${head}/…）。支持文档 /docx/、知识库 /wiki/、多维表格 /base/、电子表格 /sheets/`,
      };
  }
}
