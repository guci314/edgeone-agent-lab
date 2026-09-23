// 用户身份令牌（user_access_token）的持有与续期。
//
// ── 为什么单独一个文件，不并进 store.ts ──────────────────────────────
// store.ts 管的是「这条消息处理过没有 / 限流」，落点是 `feishu.events`；
// 这里管的是「这个人的云文档授权还有效吗」，落点是 `feishu.userToken.<openId>`。
// 两者的生命周期、归属维度、读写时机都不一样，混在一张表里只会互相牵连。
//
// ── 为什么按 openId 分槽 ─────────────────────────────────────────────
// 一个飞书会话 = 一个平台 conversation_id = 一份 KV。但**人**不等于会话：
// 群聊里一个会话背后是很多人。需求本身写的是「读**用户**有权限的文档」，
// 所以令牌属于人，不属于会话。共用一个槽的话，群里最后授权的那个人会把
// 自己的文档权限**出借给全群** —— 这是隐私事故，不是 bug。

import type { StateKv } from "./store.ts";
import {
  TOKEN_SAFETY_MS,
  refreshUserToken,
  tokenFresh,
  type OAuthEnv,
  type UserToken,
} from "./oauth.ts";

/** 一个授权人的令牌槽。和 store.ts 的 `StateKv` 同一个后端，只是 key 不同 */
export interface UserTokenStore {
  get(): Promise<UserToken | null>;
  set(v: UserToken): Promise<void>;
  clear(): Promise<void>;
}

export function makeUserTokenStore(kv: StateKv, openId: string): UserTokenStore {
  const key = `feishu.userToken.${openId}`;
  return {
    get: () => kv.get<UserToken>(key),
    set: (v) => kv.set(key, v),
    clear: () => kv.delete(key),
  };
}

/** 取令牌的结果。拿不到时带**原因**，好让工具把话说明白而不是只说「失败」 */
export type TokenResult = { token: string } | { needAuth: true; reason: string };

export interface UserTokenManagerOpts {
  store: UserTokenStore;
  env: OAuthEnv;
  openId: string;
  /** 提前多久判过期。默认 5 分钟；测试用 FEISHU_USER_TOKEN_SKEW_MS 放大它 */
  skewMs?: number;
}

export class UserTokenManager {
  private readonly store: UserTokenStore;
  private readonly env: OAuthEnv;
  private readonly openId: string;
  private readonly skewMs: number;

  private current: UserToken | null = null;
  private loaded = false;
  /**
   * 正在进行的续期。**单飞**用 —— 一次工具循环里模型可能连着调三四个文档工具，
   * 它们会同时发现令牌过期。没有这个的话就是三四个并发 refresh，
   * 而飞书每次续期都轮换 refresh_token：后到的那些用一个已经被作废的令牌，
   * 全部失败，用户看到的是「刚授权完就说授权失效」。
   */
  private inflight: Promise<TokenResult> | null = null;

  constructor(opts: UserTokenManagerOpts) {
    // 不用 TS 的构造函数参数属性：Node 的 --experimental-strip-types 是
    // strip-only 模式，遇到参数属性直接报错。冒烟测试要在裸 Node 下跑。
    this.store = opts.store;
    this.env = opts.env;
    this.openId = opts.openId;
    this.skewMs = opts.skewMs ?? TOKEN_SAFETY_MS;
  }

  /** 只看不刷新。`/status` 和「授权了没」的判断用它 */
  async peek(): Promise<UserToken | null> {
    await this.load();
    return this.current;
  }

  /**
   * 拿一个**当前可用**的 access token。
   *
   * 顺序要紧：先看内存副本够不够新 → 不够就续期 → 续不了才说要重新授权。
   * 反过来写（先判「有没有 refresh_token」）会让每次调用都白跑一次判断。
   */
  async accessToken(): Promise<TokenResult> {
    await this.load();
    const cur = this.current;

    if (tokenFresh(cur, Date.now(), this.skewMs)) {
      return { token: (cur as UserToken).accessToken };
    }
    if (!cur) return { needAuth: true, reason: "这个会话还没有授权过。" };
    if (!cur.refreshToken) {
      return {
        needAuth: true,
        reason: "上次授权没有拿到 refresh_token（授权时缺 offline_access），已经过期了。",
      };
    }
    if (cur.refreshExp && cur.refreshExp <= Date.now()) {
      return { needAuth: true, reason: "refresh_token 过期了。" };
    }

    if (!this.inflight) {
      this.inflight = this.doRefresh(cur).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * 把内存副本标记成过期，下次取会强制续期。
   *
   * 给 99991663（令牌无效）用：令牌可能被用户在飞书侧主动撤销，那时它的
   * `exp` 还没到，光看时间是发现不了的 —— 只有真调一次才知道。
   *
   * **刻意不回写 KV**：内存里标记过期就够了，KV 里那份仍然是有效的旧值。
   * 万一续期也失败、进程又刚好被驱逐，下一个实例读到的还是那份能用的令牌，
   * 而不是一个被我们标记坏的记录。
   */
  async invalidate(): Promise<void> {
    await this.load();
    if (this.current) this.current = { ...this.current, exp: 0 };
  }

  /** 丢掉授权（`/logout`）。返回本来有没有，好在回执里说实话 */
  async forget(): Promise<boolean> {
    await this.load();
    const had = this.current !== null;
    this.current = null;
    this.loaded = true;
    await this.store.clear();
    return had;
  }

  /** 换回来之后落盘。授权回调和续期都走这里，保证写入形状一致 */
  async save(v: UserToken): Promise<UserToken> {
    await this.load();
    const merged = this.merge(v);
    this.current = merged;
    await this.store.set(merged);
    return merged;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.current = (await this.store.get()) ?? null;
    this.loaded = true;
  }

  /**
   * 把新拿到的凭据并进现有记录。
   *
   * ⚠️ **这一处是整条链路最容易自伤的地方**：飞书续期时**轮换** refresh_token，
   * 但响应里不保证每次都带新值。照着响应整个覆盖的话，一次没带就写成空串，
   * 而那个空串是唯一的长效凭据 —— 表现是「用着用着突然要重新授权」，
   * 而且重新授权一次又能好一阵，极难归因。所以新值优先、旧值兜底。
   */
  private merge(v: UserToken): UserToken {
    return {
      ...v,
      refreshToken: v.refreshToken || this.current?.refreshToken || "",
      refreshExp: v.refreshExp || this.current?.refreshExp || 0,
      openId: this.openId,
    };
  }

  private async doRefresh(cur: UserToken): Promise<TokenResult> {
    try {
      return { token: (await this.save(await refreshUserToken(this.env, cur.refreshToken))).accessToken };
    } catch (e) {
      // 跨实例竞争：同一个会话理论上粘在一台实例上，但没有硬保证。另一台可能
      // 已经续过并把新 refresh_token 写回去了，而手上这个已经作废。重读一次再试。
      const again = await this.store.get();
      if (again?.refreshToken && again.refreshToken !== cur.refreshToken) {
        this.current = again;
        try {
          const next = await this.save(await refreshUserToken(this.env, again.refreshToken));
          return { token: next.accessToken };
        } catch {
          /* 还是不行，落到下面统一处理 */
        }
      }

      // 续不回来了。**清掉本地的坏记录**，否则下次又拿它去撞同一堵墙。
      // （清的是本地槽，用户重新 /login 会写一份新的。）
      this.current = null;
      await this.store.clear();
      return {
        needAuth: true,
        reason: `授权已失效（${(e as Error).message.slice(0, 120)}）`,
      };
    }
  }
}
