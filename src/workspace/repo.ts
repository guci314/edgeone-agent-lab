// 语料仓储层。只在服务端跑。
//
// ── 移植说明（原版 → EdgeOne）────────────────────────────────────────
// 原版建在 Durable Object 的 SQLite 上，三张表：`repo_meta` / `repo_files` /
// `repo_entries`。EdgeOne 没有 DO、没有 SQL，所以整个后端换成**进程内索引**，
// 外加一层可选的快照持久化。
//
// 三条设计要点**照搬不变**，它们是这个模块值得移植的部分：
// ① generation 制 —— 重导入时新语料写在新 generation 下，`finish` 那一刻才切换。
//    中途放弃或失败，agent 读到的仍是上一份完整快照，不会看到半成品。
// ② 计数器不在 ingest 过程中累加，而是在 finish 时从索引里数出来。
//    这样批次重试、同路径重复提交都不会把计数搞歪。
// ③ 查询走惰性遍历（`fileCursor` 返回可迭代对象而不是数组），grep 才能在中途
//    收手。⚠️ 这条在内存版里**只是接口形态上的保留** —— 数据本来就在内存里，
//    不存在"惰性"能省下的 IO。真正省下的是后续的字符串处理：grep 在预算用尽时
//    `break` 掉，就不再对后面的文件做 split 和正则。
//
// ── 换了后端之后，哪些保证变弱了 ────────────────────────────────────
// · **持久性**：原版语料落在 DO 的 SQLite 里，实例被驱逐、甚至几周后再来问，
//   语料都还在。内存版只在实例活着（EdgeOne 会话保活 300 秒）时有效。
//   所以加了 `RepoSnapshotStore` 这层：`finishIngest` 之后把语料序列化写进
//   `context.store.state`，实例冷启动时读回来。超过 `REPO_SNAPSHOT_MAX_BYTES`
//   就不写（KV 单值有大小压力），那时退化成纯内存。
// · **原子性**：原版所有写都在 DO 的单线程里串行执行。内存版靠 JS 单线程
//   事件循环保证同步块内不被抢占 —— 和 store.ts 里那套是同一个前提
//   （同一时刻只有一个实例在处理这个会话）。
//
// ── 一处刻意的行为改进 ──────────────────────────────────────────────
// 原版 `allPaths` / `fileCursor` 的区间扫描靠 SQL 的 `path >= prefix and
// path < prefix + '\uffff'`。内存版换成前缀比较，语义等价，但**排序**必须显式
// 维护：原版靠主键顺序，内存版靠一份排好序的路径数组。

import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  type DirEntry,
  type IngestBatchResult,
  type IngestFile,
  type RepoStatus,
  type RepoStatusName,
} from "./types.ts";
import { countLines, utf8Len } from "./filter.ts";

export interface FileRow {
  path: string;
  content: string;
  bytes: number;
  lines: number;
}

interface MetaRow {
  owner: string;
  name: string;
  ref: string;
  status: RepoStatusName;
  ingestId: string | null;
  activeGeneration: number;
  buildingGeneration: number | null;
  fileCount: number;
  totalBytes: number;
  skipped: number;
  capped: boolean;
  error: string | null;
  buildingOwner: string | null;
  buildingName: string | null;
  buildingRef: string | null;
}

function freshMeta(): MetaRow {
  return {
    owner: "",
    name: "",
    ref: "",
    status: "empty",
    ingestId: null,
    activeGeneration: 0,
    buildingGeneration: null,
    fileCount: 0,
    totalBytes: 0,
    skipped: 0,
    capped: false,
    error: null,
    buildingOwner: null,
    buildingName: null,
    buildingRef: null,
  };
}

/** 快照的线上格式。刻意做成扁平数组而不是嵌套 Map —— 要好 JSON 序列化 */
export interface RepoSnapshot {
  meta: MetaRow;
  /** 只存 active generation 的文件。building 中的半成品没有恢复价值 */
  files: FileRow[];
}

export interface RepoSnapshotStore {
  load(): Promise<RepoSnapshot | null>;
  save(s: RepoSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class WorkspaceRepo {
  private meta: MetaRow = freshMeta();
  /** generation → (path → FileRow)。保留旧 generation 是为了让 building 与 active 并存 */
  private gens = new Map<number, Map<string, FileRow>>();
  /** generation → (dir → (name → kind))。目录索引，ls 用 */
  private entries = new Map<number, Map<string, Map<string, "f" | "d">>>();
  /** active generation 的路径有序数组，find 用。finish/reset 时重建 */
  private sortedPaths: string[] = [];

  /** ⚠️ 同 store.ts：不用 TS 参数属性，Node strip-only 模式不支持。见 store.ts 的注释 */
  private readonly snapshots?: RepoSnapshotStore;

  constructor(snapshots?: RepoSnapshotStore) {
    this.snapshots = snapshots;
  }

  /**
   * 幂等初始化。原版是建表 DDL（每实例跑一次），这里改成「从快照恢复」。
   * 与 store.ts 的 `ensureSchema` 同一个套路：调用方 await 一次即可。
   */
  async hydrate(): Promise<void> {
    if (!this.snapshots) return;
    if (this.meta.activeGeneration > 0 || this.gens.size > 0) return;

    const snap = await this.snapshots.load();
    if (!snap) return;

    this.meta = { ...freshMeta(), ...snap.meta };
    const m = new Map<string, FileRow>();
    for (const f of snap.files ?? []) m.set(f.path, f);
    this.gens.set(this.meta.activeGeneration, m);
    this.entries.set(this.meta.activeGeneration, buildEntryIndex(m));
    this.rebuildSorted();
  }

  /** 供宿主持久化用。没配快照后端时返回 null */
  snapshot(): RepoSnapshot | null {
    if (!this.snapshots) return null;
    if (this.meta.activeGeneration === 0) return null;
    const files = [...(this.gens.get(this.meta.activeGeneration)?.values() ?? [])];
    return { meta: this.meta, files };
  }

  /** 导入完成后落一次快照。失败不该让导入失败，所以吞掉异常并返回是否成功 */
  async persist(): Promise<boolean> {
    if (!this.snapshots) return false;
    const snap = this.snapshot();
    if (!snap) return false;
    try {
      await this.snapshots.save(snap);
      return true;
    } catch {
      return false;
    }
  }

  // ── 元信息 ──────────────────────────────────────────────────────────

  activeGeneration(): number {
    return this.meta.activeGeneration;
  }

  status(): RepoStatus {
    const m = this.meta;
    return {
      status: m.status,
      owner: m.owner,
      name: m.name,
      ref: m.ref,
      fileCount: m.fileCount,
      totalBytes: m.totalBytes,
      activeGeneration: m.activeGeneration,
      capped: m.capped,
    };
  }

  // ── 导入 ────────────────────────────────────────────────────────────

  beginIngest(
    owner: string,
    name: string,
    ref: string,
    ingestId: string,
  ): { generation: number } {
    const generation = this.meta.activeGeneration + 1;

    // 先清掉这个 generation 的残留。上一轮如果导入失败，已经有行写进来了，
    // 而 activeGeneration 没动 —— 不清的话这次会**合并**进上次的半截数据，
    // 让本该被替换掉的文件活到新快照里
    this.gens.delete(generation);
    this.entries.delete(generation);

    // owner/name/ref 先写进 building*，**要等 finish 成功才提升为正式值**。
    // 否则一次失败的导入会留下"元信息说的是 A 仓库、语料其实是 B 仓库"的矛盾状态，
    // 而 system prompt 正是拿这三个字段告诉模型它在看哪个仓库 —— 会把模型带偏。
    this.meta = {
      ...this.meta,
      buildingOwner: owner,
      buildingName: name,
      buildingRef: ref,
      status: "ingesting",
      ingestId,
      buildingGeneration: generation,
      capped: false,
      error: null,
    };
    return { generation };
  }

  /**
   * 写入一批文件（外加它们的父目录索引）。
   *
   * 调用方传过来的东西**不可信** —— 单文件大小、文件数、总字节数都在这里重校验
   * 一遍，不能只靠上游自己过滤。
   */
  ingestBatch(ingestId: string, files: IngestFile[]): IngestBatchResult {
    const t0 = Date.now();
    const m = this.meta;

    if (
      m.status !== "ingesting" ||
      m.ingestId !== ingestId ||
      m.buildingGeneration === null
    ) {
      // 陈旧批次：可能是上一轮导入的残留请求，静默丢弃
      return { accepted: 0, bytes: 0, ms: 0, capped: true };
    }

    const gen = m.buildingGeneration;
    const table = this.gens.get(gen) ?? new Map<string, FileRow>();
    this.gens.set(gen, table);

    let totals = this.generationTotals(gen);
    let accepted = 0;
    let bytes = 0;
    let capped = false;

    for (const f of files) {
      if (totals.count >= MAX_FILES || totals.bytes >= MAX_TOTAL_BYTES) {
        capped = true;
        break;
      }

      const path = String(f.path ?? "").replace(/^\/+/, "");
      if (!path) continue;

      const content = String(f.content ?? "");
      const n = utf8Len(content);
      if (n > MAX_FILE_BYTES) {
        capped = true;
        continue;
      }

      // 原版是 `insert or replace`：同路径重复提交时后者覆盖前者。
      // Map.set 天然就是这个语义
      table.set(path, { path, content, bytes: n, lines: countLines(content) });

      accepted++;
      bytes += n;
      totals = { count: totals.count + 1, bytes: totals.bytes + n };
    }

    // 目录索引按批重建（而不是逐文件增量维护）：批内通常只有几十个文件，
    // 重建比增量更新的分支少、不容易错
    this.entries.set(gen, buildEntryIndex(table));

    // ms 交给调用方做自适应攒批的输入（见 ingest.ts）
    return { accepted, bytes, ms: Date.now() - t0, capped };
  }

  private generationTotals(gen: number): { count: number; bytes: number } {
    const table = this.gens.get(gen);
    if (!table) return { count: 0, bytes: 0 };
    let count = 0;
    let bytes = 0;
    for (const f of table.values()) {
      count++;
      bytes += f.bytes;
    }
    return { count, bytes };
  }

  finishIngest(
    ingestId: string,
    skipped: number,
    capped: boolean,
  ): { fileCount: number; totalBytes: number } {
    const m = this.meta;
    if (
      m.status !== "ingesting" ||
      m.ingestId !== ingestId ||
      m.buildingGeneration === null
    ) {
      throw new Error("导入会话已失效，请重新导入");
    }

    const gen = m.buildingGeneration;
    // 计数从索引里数出来，不依赖过程中的累加 —— 批次重试不会把它搞歪
    const totals = this.generationTotals(gen);

    // generation 单调递增，所以"所有旧快照"就是所有编号更小的
    for (const g of [...this.gens.keys()]) if (g < gen) this.gens.delete(g);
    for (const g of [...this.entries.keys()]) if (g < gen) this.entries.delete(g);

    // 到这里才把 building* 提升为正式元信息 —— 和语料切换同一拍完成
    this.meta = {
      ...m,
      status: "ready",
      ingestId: null,
      buildingGeneration: null,
      owner: m.buildingOwner ?? m.owner,
      name: m.buildingName ?? m.name,
      ref: m.buildingRef ?? m.ref,
      buildingOwner: null,
      buildingName: null,
      buildingRef: null,
      activeGeneration: gen,
      fileCount: totals.count,
      totalBytes: totals.bytes,
      skipped,
      capped,
    };
    this.rebuildSorted();

    return { fileCount: totals.count, totalBytes: totals.bytes };
  }

  failIngest(ingestId: string, error: string): void {
    const m = this.meta;
    if (m.ingestId !== ingestId) return;

    // 导入失败**不该让已有语料变得不可用** —— 只要上一份快照还在，
    // 状态就退回 ready，工具照常工作；错误文本留着给用户看。
    // （原版在这里踩过：原来无条件写 'error'，一次失败的重新导入就把好端端的
    //  仓库变成读不了）
    const usable = m.activeGeneration > 0 && m.fileCount > 0;

    this.meta = {
      ...m,
      status: usable ? "ready" : "empty",
      error: error.slice(0, 500),
      ingestId: null,
      buildingGeneration: null,
      buildingOwner: null,
      buildingName: null,
      buildingRef: null,
    };
  }

  /** 清空语料（回到未导入状态） */
  reset(): void {
    this.gens.clear();
    this.entries.clear();
    this.sortedPaths = [];
    this.meta = {
      ...freshMeta(),
      activeGeneration: this.meta.activeGeneration + 1,
    };
  }

  // ── 查询（工具用）──────────────────────────────────────────────────

  readFile(path: string): FileRow | null {
    return this.gens.get(this.meta.activeGeneration)?.get(path) ?? null;
  }

  hasFile(path: string): boolean {
    return this.gens.get(this.meta.activeGeneration)?.has(path) ?? false;
  }

  listDir(dir: string, limit: number): DirEntry[] {
    const idx = this.entries.get(this.meta.activeGeneration);
    if (!idx) return [];
    const here = idx.get(dir);
    if (!here) return [];

    // 原版是 `order by kind asc, name asc` —— 'd' < 'f'，所以目录在前
    return [...here.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => (a.kind === b.kind ? cmp(a.name, b.name) : a.kind < b.kind ? -1 : 1))
      .slice(0, limit);
  }

  /** 某目录下的全部文件路径（已排序）。glob 匹配在 JS 里做，见 tools.ts 的说明。 */
  allPaths(prefix: string, limit: number): string[] {
    const out: string[] = [];
    for (const p of this.sortedPaths) {
      if (!p.startsWith(prefix)) continue;
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 惰性游标 —— grep 靠它在中途停下（`for...of` + `break`）。
   *
   * `prefilter` 是候选预筛。原版用 SQL 的 `instr()` 把整表扫描缩到只碰命中行；
   * 内存版用它换来的收益是**不做 split 和正则** —— 对几 MB 的语料，
   * 一次 `includes()` 比一次 split 便宜得多，所以这一层保留是有意义的。
   *
   * ⚠️ 原版这里是生成器（真惰性，一个文件一个文件地取）。这里返回的是数组，
   * 但**调用方照旧用 `for...of`**，所以 `break` 仍然能省下后续文件的行切分与
   * 正则匹配 —— 省的不是 IO，是 CPU。
   */
  fileCursor(
    prefix: string,
    prefilter?: { needle: string; ci: boolean },
  ): Iterable<{ path: string; content: string; bytes: number }> {
    const table = this.gens.get(this.meta.activeGeneration);
    if (!table) return [];

    const out: { path: string; content: string; bytes: number }[] = [];
    const needle = prefilter ? (prefilter.ci ? prefilter.needle.toLowerCase() : prefilter.needle) : null;

    for (const p of this.sortedPaths) {
      if (!p.startsWith(prefix)) continue;
      const row = table.get(p);
      if (!row) continue;

      if (needle !== null) {
        const hay = prefilter!.ci ? row.content.toLowerCase() : row.content;
        if (!hay.includes(needle)) continue;
      }

      out.push({ path: row.path, content: row.content, bytes: row.bytes });
    }
    return out;
  }

  private rebuildSorted(): void {
    const table = this.gens.get(this.meta.activeGeneration);
    this.sortedPaths = table ? [...table.keys()].sort(cmp) : [];
  }
}

/** 为 `a/b/c.ts` 建 `a/b/c.ts`(f)、`a/b`(d)、`a`(d) 三条索引。同一目录重复出现时只留一条 */
function buildEntryIndex(files: Map<string, FileRow>): Map<string, Map<string, "f" | "d">> {
  const idx = new Map<string, Map<string, "f" | "d">>();

  const put = (dir: string, name: string, kind: "f" | "d") => {
    let here = idx.get(dir);
    if (!here) {
      here = new Map();
      idx.set(dir, here);
    }
    // 目录标记优先：同一个名字既可能是文件也可能是目录时（不该发生），
    // 让目录赢 —— 显示成 `name/` 至少能提示"这里还有下一层"
    if (kind === "d" || !here.has(name)) here.set(name, kind);
  };

  for (const path of files.keys()) {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    put(dir, name, "f");

    let parent = dir;
    while (parent) {
      const cut = parent.lastIndexOf("/");
      const pdir = cut === -1 ? "" : parent.slice(0, cut);
      const pname = cut === -1 ? parent : parent.slice(cut + 1);
      put(pdir, pname, "d");
      parent = pdir;
    }
  }
  return idx;
}

/** 按 UTF-16 码元比较。对 ASCII 路径等价于字典序，和原版 SQLite 的 BINARY 一致 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
