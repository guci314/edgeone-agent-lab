// 飞书链路的状态存储：去重、限流、token 缓存。
//
// ── 为什么整层重写 ──────────────────────────────────────────────────
// 原版建在 Durable Object 的 SQLite 上（`feishu_events` / `feishu_token` 两张表）。
// EdgeOne 没有 DO、没有 SQL，所以这两张表都得换掉。
//
// ── 换成了什么 ──────────────────────────────────────────────────────
// EdgeOne 的 `context.store.state` 正好是需要的形状：一个**按 conversation_id
// 隔离的 JSON 键值存储**，key 1~256 字符，value 任意可 JSON 序列化的东西，
// 跨实例持久化。飞书这条路上「一个会话 = 一个 conversation_id = 一个 agent
// 实例」，所以按会话隔离正好等价于原版「一个 DO 实例一个库」。
//
// ── 接口为什么从同步变成异步 ────────────────────────────────────────
// 原版的 `claim()` 是同步的，能这么写是因为 DO 单线程 + 本地 SQLite：
// 「先查再写」这个复合操作天然原子，两个 webhook 并发进来也串行执行。
// KV 读写天生异步，原子性没了。
//
// 所以这里改成 **进程内权威副本 + 写穿**：
//   · 内存里持一份完整副本，所有判定在内存里做 —— 同步语义，天然原子；
//   · 每次改动后整体写回 KV，保证跨实例/跨驱逐可恢复；
//   · 首次访问时从 KV 惰性加载（`ensure()`）。
//
// ⚠️ 这套方案的边界，必须知道：
// 它只在「同一时刻只有一个实例在处理这个会话」时正确。EdgeOne 的会话粘性路由
// （同一个 conversation_id 粘到同一实例）给了这个保证，所以成立。但它**不是
// 分布式锁** —— 哪天同一个 conversation_id 被路由到两个实例，去重就会失效
// （表现为同一条消息被回答两次）。原版的 DO 天然没有这个问题。
// 要恢复强保证，把 StateKv 换成外部数据库（MySQL/PG）加唯一索引，
// 见 docs/01-架构与移植映射.md 的「存储」一节。

import type { TokenCache } from "./api.ts";

/** 去重窗口。窗口内同一条 message_id 就是同一件事，不管它处于什么状态 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** 限流：每个会话每分钟最多处理多少条 */
const RATE_LIMIT_PER_MIN = 10;
const RATE_WINDOW_MS = 60_000;

/** 事件行的保留时长。超过就 prune 掉，否则 KV 里的数组会无限长 */
const EVENT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * KV 里最多留多少条事件。
 *
 * 有 TTL 兜底还不够 —— 一个高频群一天能刷出几万条，3 天的窗口意味着数组能长到
 * 十几万项，每次写回都要序列化整个数组。加上硬上限，超了就丢最老的。
 * 丢老事件是安全的：它们早就出了去重窗口，唯一的作用就是给 prune 记账。
 */
const MAX_EVENTS = 500;

const EVENTS_KEY = "feishu.events";
const TOKEN_KEY = "feishu.token";

/**
 * 存储后端。三个方法就够 —— 这是 `context.store.state` 的原生形状，
 * 所以线上实现是一层零成本的直通；本地测试用 `MemoryKv`。
 */
export interface StateKv {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 纯内存实现。给本地测试和「没有 state 的降级路径」用 */
export class MemoryKv implements StateKv {
  private m = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.m.get(key) as T | undefined) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.m.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
}

type EventState = "pending" | "done" | "failed";

interface EventRow {
  messageId: string;
  chatId: string;
  openId: string;
  state: EventState;
  attempts: number;
  createdAt: number;
  error?: string;
}

export class FeishuStore {
  /** null 表示还没从 KV 加载过。用 null 而不是空 Map 来区分「没加载」和「加载了但确实空」 */
  private events: Map<string, EventRow> | null = null;
  private token: { token: string; exp: number } | null = null;
  private tokenLoaded = false;

  /**
   * ⚠️ 不用 TS 的构造函数参数属性（`constructor(private kv: StateKv)`）。
   * Node 的 `--experimental-strip-types` 是 strip-only 模式，只剥类型不做代码生成，
   * 遇到参数属性直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。冒烟测试要在裸 Node 下跑，
   * 所以这里手写字段 + 赋值。EdgeOne 的构建链是否支持参数属性没验证过，显式赋值两边都安全。
   */
  private readonly kv: StateKv;

  constructor(kv: StateKv) {
    this.kv = kv;
  }

  /**
   * 幂等初始化。原版这里是建表 DDL（每实例跑一次即可），这里改成
   * 「把 KV 里的历史读进内存」。所有公开方法都会先调它，第一次之后是空转。
   */
  async ensureSchema(): Promise<void> {
    if (this.events === null) {
      const raw = await this.kv.get<EventRow[]>(EVENTS_KEY);
      const rows = Array.isArray(raw) ? raw : [];
      this.events = new Map(rows.map((r) => [r.messageId, r]));
    }
    if (!this.tokenLoaded) {
      this.token = await this.kv.get<{ token: string; exp: number }>(TOKEN_KEY);
      this.tokenLoaded = true;
    }
  }

  /**
   * 认领一条事件。返回 true 表示「这条该我处理」，false 表示「重复推送，跳过」。
   *
   * 判据是**时间窗口**，不是 state：窗口内出现同一条 message_id 就是同一件事，
   * 不管它处于什么状态。这样才能挡住飞书的重试 —— 它会在我们还没答完的时候
   * 重推同一条（因为 webhook 那边可能已经超时了）。
   *
   * 窗口外同 id 再出现，视为用户又发了一遍，重置成 pending 放行。
   */
  async claim(messageId: string, chatId: string, openId: string): Promise<boolean> {
    await this.ensureSchema();
    const rows = this.events!;
    const now = Date.now();
    const hit = rows.get(messageId);

    if (hit) {
      hit.attempts += 1;
      if (now - hit.createdAt < DEDUPE_WINDOW_MS) {
        await this.persistEvents();
        return false;
      }
      hit.state = "pending";
      hit.attempts = 1;
      hit.createdAt = now;
      hit.chatId = chatId;
      hit.openId = openId;
      delete hit.error;
      await this.persistEvents();
      return true;
    }

    rows.set(messageId, {
      messageId,
      chatId,
      openId,
      state: "pending",
      attempts: 1,
      createdAt: now,
    });
    await this.persistEvents();
    return true;
  }

  async markDone(messageId: string): Promise<void> {
    await this.ensureSchema();
    const hit = this.events!.get(messageId);
    if (!hit) return;
    hit.state = "done";
    delete hit.error;
    await this.persistEvents();
  }

  async markFailed(messageId: string, error: string): Promise<void> {
    await this.ensureSchema();
    const hit = this.events!.get(messageId);
    if (!hit) return;
    hit.state = "failed";
    // 原版截到 500 字符，保持一致 —— 错误文本只给排查用，不该把 KV 撑大
    hit.error = error.slice(0, 500);
    await this.persistEvents();
  }

  /** 这个会话最近一分钟处理了多少条 */
  async recentCount(chatId: string): Promise<number> {
    await this.ensureSchema();
    const since = Date.now() - RATE_WINDOW_MS;
    let n = 0;
    for (const r of this.events!.values()) {
      if (r.chatId === chatId && r.createdAt >= since) n++;
    }
    return n;
  }

  async overLimit(chatId: string): Promise<boolean> {
    return (await this.recentCount(chatId)) >= RATE_LIMIT_PER_MIN;
  }

  /** 丢掉过期的行。返回丢掉了几条。 */
  async prune(now = Date.now()): Promise<number> {
    await this.ensureSchema();
    const rows = this.events!;
    let removed = 0;
    for (const [id, r] of rows) {
      if (now - r.createdAt > EVENT_TTL_MS) {
        rows.delete(id);
        removed++;
      }
    }
    if (removed > 0) await this.persistEvents();
    return removed;
  }

  /**
   * tenant_access_token 的缓存。
   *
   * 按会话各存一份是有意的：token 是应用级的（所有会话共用同一个），
   * 各存一份会多取几次，但省掉了「跨会话共享状态」这件事 —— 而共享状态正是
   * 这套按会话隔离的 KV 最不擅长的。取 token 是每两小时一次的调用，
   * 这点浪费可以接受。
   */
  tokenCache(): TokenCache {
    return {
      get: async () => {
        await this.ensureSchema();
        return this.token;
      },
      set: async (v) => {
        this.token = v;
        this.tokenLoaded = true;
        await this.kv.set(TOKEN_KEY, v);
      },
    };
  }

  /** 把内存副本整体写回 KV。先按 TTL 和条数上限裁一遍，避免数组无限增长。 */
  private async persistEvents(): Promise<void> {
    const rows = this.events!;
    const now = Date.now();

    for (const [id, r] of rows) {
      if (now - r.createdAt > EVENT_TTL_MS) rows.delete(id);
    }

    let list = [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
    if (list.length > MAX_EVENTS) {
      list = list.slice(list.length - MAX_EVENTS);
      this.events = new Map(list.map((r) => [r.messageId, r]));
    }

    await this.kv.set(EVENTS_KEY, list);
  }
}
