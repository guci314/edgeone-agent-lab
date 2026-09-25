// 跨会话记忆：一片**所有会话共享**的键空间。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// `context.store.state` 按 conversation_id 隔离 —— 物理键是
// `state/<conversation_id>/<key>`（2026-09-25 实测，见
// docs/01-架构与移植映射.md 第五节）。这对**对话历史**是对的：每个群、每个人的
// 私聊各聊各的。但「这个团队用 pnpm」「谷词负责 auth 模块」这类**事实**
// 不属于任何一个会话 —— 换个群就得重说一遍，`/clear` 之后就没了。
//
// ── 落在哪里（实测结论，不是推断）──────────────────────────────────
// EdgeOne 的 agents 运行时把裸 Blob SDK 挂在
// `globalThis.__EDGEONE_AGENT_RUNTIME__.getStore` 上，凭证由**构建期注入**：
//   · 生产：`{{PAGES_BLOB_DEPLOY_CREDENTIAL}}`，平台部署时替换
//   · 本地 dev：`DEV_BLOB_TOKEN` + `DEV_BLOB_PROJECT_ID`（CLI 用自己 token 顶上）
// 实测：set / get / list / 1MB 值 / **换进程读回** 全部通过。
//
// ⚠️ 命名空间**故意和平台自己的分开**。平台用 `memory-<projectId>`，里面装着
// `conversations/` `state/` `message_index/` 这些**线上用户数据**。本文件用
// 独立的 `agent-memory-<projectId>`，于是这里任何一个 list/get/delete 都不可能
// 碰到平台的键 —— 隔离是结构性的，不靠自觉。
//
// ── 键空间 ──────────────────────────────────────────────────────────
//   prefs/<key>              项目级长期事实（技术栈、代码风格、团队约定）
//   user/<openId>/<key>      按人的偏好（「谷词负责 auth 模块」）
//
// ⚠️ Blob 的 `set` 是**整值覆盖，没有任何可用的条件写**（2026-09-25 实测）：
//   · SDK 类型里**有** `SetOptions.onlyIfNew`，写着「only write if the key does
//     not already exist」，还有 `PreconditionFailedError` —— 但**实测它不生效**：
//     键已存在时带 onlyIfNew 写照样覆盖成功（token 模式；ambient 模式没测）。
//   · 底层 COS 其实有版本号（响应头 `x-cos-version-id`）和 etag，
//     但 SDK 没暴露 `if-match` 之类的参数，所以从这一层用不上。
//   结论：**别依赖任何条件写**。所以这里**一个事实一个键**，不搞一个大 JSON ——
//   两个会话同时记不同的事不会互相覆盖。代价是渲染时要 list + 并行 get；
//   边缘节点毫秒级返回，实测可以接受（渲染只发生在每轮提问的开头一次）。
//
//   ⚠️ 「一个 key 装一件事」这条规则**必须写在 `remember_fact` 的工具描述里**
//   （实测 2026-09-25）：它原先只存在于这段注释里，模型看不到，于是它把
//   「内部代号」和「发布分支」并成了一个 key `prefs/项目代号与发布分支`，
//   换个跑法又拆成两个 —— 行为不稳定，而且并 key 就等于把「不丢更新」这个
//   保证丢了。教训同 `decisions.md`：**提示词没说的规则，模型不会遵守。**
//
//   另：`set` 没有 TTL 参数（`SetOptions` 只有 onlyIfNew / cacheControl），
//   所以这些键**不会自己过期** —— 平台自己那层的 `expiresAt` 是
//   `createBlobBackedStore` 包出来的，我们走裸 SDK 没有它。好处是「长期记忆」
//   真的是长期的；代价是增长只能靠 MAX_ENTRIES 兜。
//
// ── 为什么要「遗忘机制」─────────────────────────────────────────────
// 无上限的记忆会无限增长，最后把上下文撑爆。所以有 `MAX_ENTRIES` 硬上限：
// 记满之后 `remember_fact` **拒绝写入**并告诉模型先删 —— 让它自己做取舍，
// 比默默丢最老的更可控（哪条还有用只有模型知道）。

import { tool } from "@openai/agents";
import { z } from "zod";

/** 一条记忆的逻辑键前缀：项目级 */
export const PROJECT_PREFIX = "prefs/";
/** 一条记忆的逻辑键前缀：按人 */
export const USER_PREFIX = "user/";

/** 最多存多少条。记满后 remember 会拒绝并让模型先 forget */
export const MAX_ENTRIES = 100;

/** 单条事实的字符上限。事实不是文档，超了说明该拆 */
export const MAX_VALUE_CHARS = 500;

/** 注入提示词时最多显示多少条 */
const MAX_RENDER_ENTRIES = 30;
/** 注入提示词时每条最多显示多少字符 */
const MAX_RENDER_VALUE_CHARS = 200;
/** 注入提示词的整段上限（字符）。超了按条截，并说明还有多少没显示 */
const MAX_RENDER_CHARS = 3_000;

// ── 存储后端 ──────────────────────────────────────────────────────────

/**
 * 记忆的存储后端。
 *
 * 和 `store.ts` 的 `StateKv` 是**两个不同的东西**，别混：
 *   · `StateKv`（3 个方法）对应 `context.store.state`，**按会话隔离**；
 *   · `MemoryBackend`（4 个方法）对应裸 Blob，**跨会话共享**。
 * 这里多一个 `list` —— 枚举是跨会话记忆的核心能力（「我记过什么」），
 * 而 `context.store.state` 没有 list。
 */
export interface MemoryBackend {
  put(key: string, text: string): Promise<void>;
  read(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  /** 只回键，不回值 —— 值由调用方按需 read，避免一次拉全量 */
  list(prefix?: string): Promise<string[]>;
}

/** 纯内存实现。给本地测试和「拿不到平台 Blob」的降级路径用 */
export class InMemoryMemoryBackend implements MemoryBackend {
  private m = new Map<string, string>();
  async put(key: string, text: string): Promise<void> {
    this.m.set(key, text);
  }
  async read(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async remove(key: string): Promise<void> {
    this.m.delete(key);
  }
  async list(prefix = ""): Promise<string[]> {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** 平台注入的裸 Blob store 的形状。没有官方 TS 类型，按实测用法收窄 */
interface RawBlobStore {
  get(key: string, opts?: { type?: string; consistency?: string }): Promise<unknown>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; consistency?: string }): Promise<{ blobs?: { key?: string }[] }>;
}

/** 记忆后端要看的几个环境变量。写成具体形状，不用索引签名（见下面 blobMemoryBackend 的注释） */
export interface MemoryEnv {
  PAGES_PROJECT_ID?: string;
  ProjectId?: string;
  AGENT_MEMORY_NAMESPACE?: string;
}

/** 拿 process.env。`typeof process` 判断是为了浏览器/边缘环境里不炸 */
function procEnv(): Record<string, string | undefined> {
  return (typeof process !== "undefined" ? process.env : {}) as Record<string, string | undefined>;
}

/**
 * 记忆后端的解析结果。**给诊断端点用** ——
 * 「记忆不见了」有两种完全不同的病（运行时没暴露 getStore / 拿不到 projectId），
 * 没有这个就只能靠猜。见 `?probe=store` 的 `memory` 字段。
 */
export interface MemoryBackendStatus {
  available: boolean;
  namespace: string | null;
  /** projectId 是从哪个键拿到的。诊断用 —— 「到底哪个环境变量生效了」 */
  projectIdFrom: string | null;
  /** 不可用时的原因。直接给人看，不用再翻译 */
  reason: string | null;
}

/**
 * 解析记忆后端该用哪个命名空间。**只看配置，不建连接**。
 *
 * ⚠️ projectId 要**两处都找**：`context.env`（控制台里配的项目环境变量）和
 * `process.env`（运行时进程环境）。实测在 agents 运行时里
 * `PAGES_BLOB_DEPLOY_CREDENTIAL` 出现在 `process.env`，
 * 而它和 projectId 是同一批注入的 —— 只查 `context.env` 有可能整个功能静默失效。
 */
export function memoryBackendStatus(env: MemoryEnv): MemoryBackendStatus {
  const rt = (globalThis as unknown as { __EDGEONE_AGENT_RUNTIME__?: { getStore?: unknown } })
    .__EDGEONE_AGENT_RUNTIME__;
  if (typeof rt?.getStore !== "function") {
    return {
      available: false,
      namespace: null,
      projectIdFrom: null,
      reason:
        "运行时没有暴露 __EDGEONE_AGENT_RUNTIME__.getStore —— 本地裸 Node 跑，或者平台改了运行时 API",
    };
  }

  const pe = procEnv();
  const explicit = String(env.AGENT_MEMORY_NAMESPACE ?? "").trim();
  const candidates: Array<[string, string | undefined]> = [
    ["env.PAGES_PROJECT_ID", env.PAGES_PROJECT_ID],
    ["env.ProjectId", env.ProjectId],
    ["process.env.PAGES_PROJECT_ID", pe.PAGES_PROJECT_ID],
    ["process.env.ProjectId", pe.ProjectId],
    ["process.env.EDGEONE_PROJECT_ID", pe.EDGEONE_PROJECT_ID],
  ];
  const hit = candidates.find(([, v]) => String(v ?? "").trim());
  const projectId = hit ? String(hit[1]).trim() : "";

  const namespace = explicit || (projectId ? `agent-memory-${projectId}` : "");
  if (!namespace) {
    return {
      available: false,
      namespace: null,
      projectIdFrom: null,
      reason:
        "拿不到 projectId（env 和 process.env 里都没有），定位不了 Blob 命名空间；可以用 AGENT_MEMORY_NAMESPACE 显式指定",
    };
  }

  return {
    available: true,
    namespace,
    projectIdFrom: explicit ? "AGENT_MEMORY_NAMESPACE" : (hit?.[0] ?? null),
    reason: null,
  };
}

/**
 * 从运行时拿一个 Blob 后端。**拿不到就返回 null**（本地裸 Node、平台改 API），
 * 调用方据此决定「不挂记忆工具、提示词里也不提记忆」——
 * 挂一个永远失败的工具只会让模型把基础设施问题当成自己的错。
 *
 * 命名空间可以用 `AGENT_MEMORY_NAMESPACE` 覆盖（测试/多环境隔离用）。
 *
 * ⚠️ 参数类型写成具体形状（`MemoryEnv`）而不是 `Record<string, unknown>`：
 * 接口类型没有索引签名，赋不过去，调用方每次都得加断言
 * （`_tools.ts` 里踩过同一条）。
 */
export function blobMemoryBackend(env: MemoryEnv): MemoryBackend | null {
  const st = memoryBackendStatus(env);
  if (!st.available || !st.namespace) return null;

  const rt = (globalThis as unknown as { __EDGEONE_AGENT_RUNTIME__?: { getStore?: unknown } })
    .__EDGEONE_AGENT_RUNTIME__;
  const getStore = rt?.getStore as (o: { name: string }) => RawBlobStore;

  let raw: RawBlobStore;
  try {
    raw = getStore({ name: st.namespace });
  } catch {
    return null;
  }
  if (typeof raw?.get !== "function" || typeof raw?.set !== "function") return null;

  // 读一律用强一致：刚 `remember` 完的事实，下一条消息必须看得见。
  // 默认的最终一致有 60 秒窗口 —— 那段时间里「我刚让你记住的」会像没生效，
  // 用户完全没法判断是记忆坏了还是模型没听。强一致的代价只是「读取耗时略高」。
  const STRONG = { consistency: "strong" } as const;

  return {
    async put(key, text) {
      await raw.set(key, text);
    },
    async read(key) {
      const v = await raw.get(key, { type: "text", ...STRONG });
      return v == null ? null : String(v);
    },
    async remove(key) {
      await raw.delete(key);
    },
    async list(prefix = "") {
      const r = await raw.list({ prefix, ...STRONG });
      return (r?.blobs ?? [])
        .map((b) => String(b?.key ?? ""))
        .filter(Boolean)
        .sort();
    },
  };
}

// ── 键的规范化 ────────────────────────────────────────────────────────

/**
 * 把模型给的键名规范成一个安全、稳定的逻辑键片段。
 *
 * 为什么必须过这一道：键是**模型生成的**，可能带空格、斜杠、大写、表情、
 * 或者一长串废话。放任的话键空间会变成一团乱麻，`list` 出来的东西没法看。
 *
 * 规则：小写、空格转连字符、只留 `a-z0-9._-` 和 CJK（用户是中文，允许
 * 「技术栈」这种键更好读）、连续点压成一个（杜绝 `..`）、首尾的 `.`/`-` 去掉、
 * 最长 64 字符。返回 null 表示这个键不可用。
 */
export function normalizeMemoryKey(raw: string): string | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._\-\u4e00-\u9fff]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 64);
  return s || null;
}

/** 项目级逻辑键 */
export function projectKey(name: string): string | null {
  const k = normalizeMemoryKey(name);
  return k ? `${PROJECT_PREFIX}${k}` : null;
}

/** 按人的逻辑键。openId 原样用（是平台给的标识符，不含路径字符） */
export function userKey(openId: string, name: string): string | null {
  const k = normalizeMemoryKey(name);
  const who = String(openId ?? "").trim();
  if (!k || !who) return null;
  return `${USER_PREFIX}${who}/${k}`;
}

/**
 * 这条记忆归不归这个人。
 *
 * ⚠️ **权限边界只在这一个函数里实现**，别在调用点各写一遍。
 * 2026-09-25 的实测教训：这条规则原先在 `renderForPrompt` / `renderMemoryList` /
 * `forgetAll` 三处各写了一遍，也各测了一遍 —— 看起来覆盖得很好，
 * 于是**模型唯一持有的那个入口 `recall_facts` 没人想起来要加**，
 * 它在群聊里把所有人的个人记忆连内容一起返回了。
 * 三个实现 + 三条测试的冗余度，反而掩盖了第四个入口没人管。
 *
 * 所以：凡是「列出 / 读取 / 删除记忆」的路径，一律先过这个函数。
 * 新增入口时如果发现自己在手写 `startsWith(PROJECT_PREFIX)`，那就是走错路了。
 */
export function isVisibleTo(key: string, openId: string): boolean {
  if (String(key ?? "").startsWith(PROJECT_PREFIX)) return true;
  const who = String(openId ?? "").trim();
  return !!who && key.startsWith(`${USER_PREFIX}${who}/`);
}

// ── 记忆本体 ──────────────────────────────────────────────────────────

export interface MemoryEntry {
  /** 逻辑键，如 `prefs/tech-stack` */
  key: string;
  value: string;
  /** 写入时间（毫秒）。老数据可能没有 */
  at?: number;
  /** 谁写的（openId 后 6 位，够认人又不铺全量） */
  by?: string;
}

/**
 * 存在 Blob 里的一行。外面包一层信封而不是裸字符串 ——
 * 以后要加字段（置信度、来源会话）时不用迁移旧数据。
 *
 * 读的时候对不上信封就当裸文本处理（比如手工写进去的），不抛。
 */
interface Envelope {
  v: string;
  at?: number;
  by?: string;
}

function encodeEnvelope(value: string, by: string): string {
  const e: Envelope = { v: value, at: Date.now(), by: by.slice(-6) };
  return JSON.stringify(e);
}

function decodeEnvelope(raw: string): { value: string; at?: number; by?: string } {
  try {
    const o = JSON.parse(raw) as Partial<Envelope>;
    if (o && typeof o.v === "string") return { value: o.v, at: o.at, by: o.by };
  } catch {
    /* 不是信封就当裸文本 */
  }
  return { value: raw };
}

export class GlobalMemory {
  private readonly backend: MemoryBackend;
  /** 本实例（= 一条消息的一轮）内的读缓存。写操作会清掉它 */
  private cache: MemoryEntry[] | null = null;

  constructor(backend: MemoryBackend) {
    this.backend = backend;
  }

  /**
   * 读出所有条目。**带实例内缓存** —— 同一轮里 instructions 渲染和
   * `recall_facts` 工具会各读一次，没必要打两遍网络。
   * 任何写操作都会把缓存清掉，所以同轮内「记住 → 立刻查」也能看到。
   */
  async entries(): Promise<MemoryEntry[]> {
    if (this.cache) return this.cache;
    const keys = await this.backend.list();
    const out = await Promise.all(
      keys.map(async (key) => {
        try {
          const raw = await this.backend.read(key);
          if (raw == null) return null;
          const { value, at, by } = decodeEnvelope(raw);
          return { key, value, at, by } as MemoryEntry;
        } catch {
          // 单条读失败不该让整段记忆消失 —— 跳过它，其余的照常渲染
          return null;
        }
      }),
    );
    this.cache = out.filter((e): e is MemoryEntry => e !== null);
    return this.cache;
  }

  /**
   * 这个人**有权看到**的全部条目：项目级 + 他自己的按人记忆。
   *
   * 所有面向人与面向模型的读取都要从这里走，别直接 `entries()`
   * （理由见 `isVisibleTo` 的注释）。`entries()` 只留给「统计总数」这类
   * 不暴露内容的用途。
   */
  async visibleEntries(openId: string): Promise<MemoryEntry[]> {
    return (await this.entries()).filter((e) => isVisibleTo(e.key, openId));
  }

  /** 这条键在不在。用来区分「新建」和「覆盖」—— 上限只对新键生效 */
  private async exists(key: string): Promise<boolean> {
    return (await this.entries()).some((e) => e.key === key);
  }

  /**
   * 写入/更新一条事实。返回给模型看的一句话。
   *
   * ⚠️ 这里**没有可用的条件写**：两个会话同时写同一个键，后写的赢。
   * 别指望 `SetOptions.onlyIfNew` —— 实测不生效（见文件头）。对「偏好」这类
   * 语义是合适的（最后说的算），但别拿它当需要精确累加的地方用。
   *
   * 「先查再写」这个序列在并发下**确实可能同时判成新键**，于是 MAX_ENTRIES
   * 有可能被轻微突破（多出几条）。这是刻意接受的：上限是软保护，
   * 而为此加锁的代价远大于收益。
   */
  async remember(key: string, value: string, by: string): Promise<string> {
    const v = String(value ?? "").trim();
    if (!v) return "没写入：value 是空的。";
    if (v.length > MAX_VALUE_CHARS) {
      return `没写入：这条 ${v.length} 字符，超过单条上限 ${MAX_VALUE_CHARS}。把事实压缩一下再记。`;
    }

    const entries = await this.entries();
    const isNew = !entries.some((e) => e.key === key);
    if (isNew && entries.length >= MAX_ENTRIES) {
      // 记满就拒绝，让模型自己决定删哪条 —— 默默丢最老的会把还有用的丢掉
      return (
        `没写入：长期记忆已经记满 ${MAX_ENTRIES} 条。` +
        `先用 recall_facts 看看哪些过时了，用 forget_fact 删掉一条，再记这条。`
      );
    }

    await this.backend.put(key, encodeEnvelope(v, by));
    this.cache = null;
    return isNew ? `已记住 ${key}` : `已更新 ${key}`;
  }

  /** 删除一条。返回是否真的删掉了 */
  async forget(key: string): Promise<boolean> {
    const had = (await this.entries()).some((e) => e.key === key);
    if (!had) return false;
    await this.backend.remove(key);
    this.cache = null;
    return true;
  }

  /**
   * 宽松删除：**人**手打键名时不会带 `prefs/` 前缀（他会打「技术栈」而不是
   * 「prefs/技术栈」）。依次试「原样」→「当项目级」→「当这个人的」，
   * 命中第一个就删。返回真正删掉的键名；全都没中返回 null。
   *
   * 模型走 `forget_fact` 那条路不经过这里 —— 它看到的是完整键名，
   * 而且「没找到」这条信息对它有用（可以据此改用 recall_facts 核对）。
   */
  async forgetLoose(rawKey: string, openId: string): Promise<string | null> {
    const raw = String(rawKey ?? "").trim();
    if (!raw) return null;

    const candidates = [raw];
    const pk = projectKey(raw);
    if (pk) candidates.push(pk);
    const uk = openId ? userKey(openId, raw) : null;
    if (uk) candidates.push(uk);

    for (const c of candidates) {
      // ⚠️ 手打键名这条路也能删别人的（人可以在群里照着 /memory 的提示猜出
      // `user/ou_xxx/xxx` 的形状），所以同样要过可见性
      if (!isVisibleTo(c, openId)) continue;
      if (await this.forget(c)) return c;
    }
    return null;
  }

  /** 清空这个 openId 名下的**全部**记忆（项目级 + 这个人自己的）。给 /forget all 用 */
  async forgetAll(openId: string): Promise<number> {
    const mine = await this.visibleEntries(openId);
    await Promise.all(mine.map((e) => this.backend.remove(e.key).catch(() => {})));
    this.cache = null;
    return mine.length;
  }

  /**
   * 渲染注入系统提示词的那一段。
   *
   * **按人过滤**：项目级 `prefs/*` 全显示，但 `user/*` 只显示**提问人自己**的。
   * 群聊里把别人的个人偏好铺进上下文既是噪声也是越界。
   */
  async renderForPrompt(openId: string): Promise<string> {
    const visible = await this.visibleEntries(openId);

    const head =
      "\n\n## 长期记忆（跨会话共享，不是本会话的对话历史）\n" +
      "下面是**之前会话**里记下的长期事实。和本次问题相关时直接采用，不要再问用户一遍。\n";

    if (!visible.length) {
      return (
        head +
        "\n（目前还是空的）\n" +
        "当你得知值得跨会话保留的事实 —— 用户的长期偏好、团队约定、技术栈、" +
        "谁负责哪块 —— 用 remember_fact 记下来。**不要记**一次性的东西" +
        "（这次问的是哪个仓库、某个问题的答案），那些属于对话历史。\n"
      );
    }

    const lines: string[] = [];
    let chars = 0;
    let shown = 0;
    for (const e of visible.slice(0, MAX_RENDER_ENTRIES)) {
      const v = e.value.length > MAX_RENDER_VALUE_CHARS
        ? `${e.value.slice(0, MAX_RENDER_VALUE_CHARS)}…`
        : e.value;
      const line = `- ${e.key}：${v}`;
      if (chars + line.length > MAX_RENDER_CHARS) break;
      lines.push(line);
      chars += line.length;
      shown++;
    }

    const hidden = visible.length - shown;
    const tail =
      `\n（共 ${visible.length} 条` +
      (hidden > 0 ? `，这里只显示了 ${shown} 条；其余让用户发 /memory 看` : "") +
      "）\n" +
      "学到新的长期事实用 remember_fact；发现记错了或过时了，用 forget_fact 删掉。\n";

    return `${head}\n${lines.join("\n")}\n${tail}`;
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────

function json(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * 造跨会话记忆的三个工具。
 *
 * ⚠️ 工具**不是**「顺手多给几个」—— 每个工具都会出现在模型的选择空间里，
 * 多一个就多一分选错的概率。这三个各自不可替代：
 *   · remember_fact 写（模型自己判断什么值得跨会话留）
 *   · forget_fact   删（发现过时/记错时）
 *   · recall_facts  读全量（提示词里只渲染前 N 条，剩下的靠这个取）
 *
 * 为什么读那条不能省：提示词有渲染预算，条数多了必然截断。
 * 截断了却没法自己查，模型就只能对用户说「我不知道」—— 那记忆就白存了。
 */
export function makeMemoryTools(memory: GlobalMemory, openId: string) {
  const remember = tool({
    name: "remember_fact",
    description:
      "把一条**值得跨会话保留**的长期事实写进长期记忆，所有会话共享。" +
      "适合记：用户的长期偏好（「回答用中文，给行号」）、团队约定（「注释写为什么，不写做了什么」）、" +
      "技术栈（「这个团队用 pnpm + TypeScript」）、谁负责哪块。 " +
      "**不要记**一次性的东西：这次问的是哪个仓库、某个问题的答案、临时结论 —— 那些属于对话历史，不是长期事实。" +
      // ── 「一个 key 装一件事」必须写在这里 ────────────────────────────
      // 实测（2026-09-25）：这条规则原本只写在文件头的注释里，**模型看不到**，
      // 于是它把「内部代号」和「发布分支」并成了一个 key
      // `prefs/项目代号与发布分支` —— 换个跑法又拆成两个。行为不稳定。
      // 而整个设计「一条事实一个键」的意义就在于避免丢更新（写入是整值覆盖、
      // 没有可用的条件写），并成一个 key 就把这个保证丢了。
      "**一个 key 只装一件事。** 不相关的两件事（比如「内部代号」和「发布分支」）" +
      "要拆成两个 key —— 写入是整值覆盖、没有条件写，塞进同一个 key 里" +
      "两个人同时改就会互相覆盖。同一件事的细节才写在同一句里。 " +
      "scope 用 project 表示整个团队都适用，用 user 表示只跟提问人自己有关。" +
      `单条最多 ${MAX_VALUE_CHARS} 字，超过就先压缩。 ` +
      "写入会立刻生效，同一轮里后续的读取也能看到。",
    parameters: z.object({
      key: z
        .string()
        .describe(
          "这条事实的短标识，**一件事一个 key**，如 技术栈 / 代码风格 / 内部代号 / 发布分支。" +
            "别把两件不相关的事塞进一个 key（会互相覆盖）。同一个 key 再写就是覆盖更新",
        ),
      value: z.string().describe(`事实内容，一句话说清，最多 ${MAX_VALUE_CHARS} 字`),
      scope: z
        .enum(["project", "user"])
        .optional()
        .describe("project=整个团队适用（默认）；user=只跟提问人自己有关"),
    }),
    execute: async ({ key, value, scope }) => {
      const logical =
        scope === "user" ? userKey(openId, key) : projectKey(key);
      if (!logical) {
        return json({
          error: `key 不能用：${JSON.stringify(key)}。换成短的字母/数字/中文标识，比如 技术栈。`,
        });
      }
      if (scope === "user" && !openId) {
        return json({ error: "拿不到提问人身份，记不了按人的记忆。改用 scope=project。" });
      }
      return json({ result: await memory.remember(logical, value, openId) });
    },
  });

  const forget = tool({
    name: "forget_fact",
    description:
      "从长期记忆里删掉一条。key 要和 recall_facts 或系统提示词里显示的**完全一致**（含 prefs/ 或 user/ 前缀）。 " +
      "只能删项目级（prefs/…）和**自己的**按人记忆 —— 别人的个人记忆删不了，也不该删。" +
      "只在事实确实过时、或用户明确要求删掉时用；不确定就先问用户。",
    parameters: z.object({
      key: z.string().describe("要删的逻辑键，如 prefs/技术栈"),
    }),
    execute: async ({ key }) => {
      const k = String(key ?? "").trim();
      // ⚠️ 删和读用同一条可见性规则（见 isVisibleTo）：**能看到的才能删**。
      // 少了这一道，群里的 A 可以让 bot 把 B 的个人记忆删掉 ——
      // 而 B 根本看不到发生过什么。
      if (k && !isVisibleTo(k, openId)) {
        return json({
          error:
            `删不了 ${k}：那是别人的个人记忆。按人记忆只有本人能看和删；` +
            `你能删的是项目级（prefs/…）或自己的 user/${openId}/…。`,
        });
      }
      const ok = await memory.forget(k);
      return json({
        result: ok ? `已删掉 ${k}` : `没找到 ${k}。用 recall_facts 看一下现有的键。`,
      });
    },
  });

  const recall = tool({
    name: "recall_facts",
    description:
      "列出长期记忆里的条目（系统提示词里只显示了前若干条，需要完整清单时用这个）。" +
      "返回 key 和内容。想知道「我之前记过什么」时用。" +
      "看到的是**项目级 + 提问人自己的**按人记忆 —— 别人的个人记忆不在这里面，这是有意的。",
    parameters: z.object({
      prefix: z
        .string()
        .optional()
        .describe("可选，只看某一类：prefs/ 看项目级，user/ 看提问人自己的"),
    }),
    execute: async ({ prefix }) => {
      const p = String(prefix ?? "").trim();
      // ⚠️ 这里**必须**走 visibleEntries，不能用 entries()。
      // 实测（2026-09-25 评审）：这个工具原先返回全部条目，包括
      // `user/<别人的openId>/*` 的**内容** —— 而 renderForPrompt / /memory /
      // forgetAll 三处都按人过滤了，只有模型手上这个入口漏了。
      // 群聊里任何人问一句「把长期记忆列出来」就能拿到别人的个人事实。
      const visible = await memory.visibleEntries(openId);
      const hit = p ? visible.filter((e) => e.key.startsWith(p)) : visible;
      return json({
        total: hit.length,
        entries: hit.map((e) => ({ key: e.key, value: e.value })),
      });
    },
  });

  return [remember, forget, recall];
}

/**
 * 给 `/memory` 命令用的纯文本清单。
 *
 * ⚠️ 走 `sendText` 发的是飞书**纯文本消息**，不渲染 Markdown ——
 * 所以这里不要用 `**加粗**`、反引号，会原样显示成星号。
 */
export async function renderMemoryList(
  memory: GlobalMemory | null,
  openId: string,
): Promise<string> {
  if (!memory) {
    return "这个环境接不上跨会话记忆（多半是本地调试，或运行时没暴露 Blob）。";
  }
  const all = await memory.entries();
  if (!all.length) {
    return "还没有任何长期记忆。\n\n问我一些能沉淀下来的事（团队技术栈、代码风格、谁负责哪块），我会记下来，之后换个群也记得。";
  }

  // 可见性走同一个函数，别在这里重写一遍 —— 见 isVisibleTo 的注释
  const visible = await memory.visibleEntries(openId);
  const project = visible.filter((e) => e.key.startsWith(PROJECT_PREFIX));
  const own = visible.filter((e) => e.key.startsWith(`${USER_PREFIX}${openId}/`));
  const others = all.length - visible.length;

  const lines: string[] = [];
  lines.push(`长期记忆共 ${all.length} 条（跨会话共享）：`);

  if (project.length) {
    lines.push("");
    lines.push("【项目级 · 所有会话都看得到】");
    for (const e of project) lines.push(`- ${e.key}：${e.value}`);
  }
  if (own.length) {
    lines.push("");
    lines.push("【只跟你有关】");
    for (const e of own) lines.push(`- ${e.key}：${e.value}`);
  }
  if (others > 0) {
    // 别人的按人记忆不显示内容 —— 群聊里那是越界
    lines.push("");
    lines.push(`（另有 ${others} 条是别人的个人记忆，不在这里显示）`);
  }

  lines.push("");
  lines.push(`删掉一条：/forget <键名>    清空你自己的：/forget all confirm`);
  return lines.join("\n");
}
