// dsh-hot-search — FFF 封装层。
//
// 优先用 @ff-labs/fff-node 的原生 finder（预索引 + 子序列模糊 + frecency + git 状态）；
// 原生库不可用时降级为自有实现（子序列模糊 + 本地 frecency 文件），保证能力不丢。
//
// 注意：FFF 的 grep fuzzy 模式实测对中文无效（连正确词也 0 命中），所以这里只暴露
// plain/regex；中文内容容错走 line-index.mjs 的 hot_fuzzy。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "./state-dir.mjs";

function scoreOnce(query, target) {
  // 子序列匹配：命中越靠前、越"紧凑"越好分。
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < t.length && qi < q.length; i += 1) {
    if (t[i] === q[qi]) {
      if (first < 0) first = i;
      last = i;
      qi += 1;
    }
  }
  if (qi < q.length) return 0;
  const span = last - first + 1;
  const density = q.length / span;
  const early = 1 / (1 + first / 8);
  const exactBonus = t.includes(q) ? 0.35 : 0;
  return Math.min(1, 0.45 * density + 0.2 * early + exactBonus + 0.25);
}

/**
 * 文件名打分：先按子序列匹配；失败则允许一次相邻换位再试（如 obsidain ↔ obsidian）。
 * 换位命中乘 0.9 折扣，保证排在真正的子序列命中之后。
 */
function subsequenceScore(query, target) {
  const direct = scoreOnce(query, target);
  if (direct > 0) return direct;
  if (query.length < 3) return 0;
  let best = 0;
  for (let i = 0; i + 1 < query.length; i += 1) {
    const swapped = query.slice(0, i) + query[i + 1] + query[i] + query.slice(i + 2);
    const s = scoreOnce(swapped, target) * 0.9;
    if (s > best) best = s;
  }
  return best;
}

export class HotFinder {
  constructor({ rootCfg, cfg, lineIndex }) {
    this.root = rootCfg;
    this.cfg = cfg;
    this.lineIndex = lineIndex;
    this.fff = null;
    this.fffError = null;
    this.fffReady = false;
    // 默认落在 $DSH_HOME/hot-search（或系统 cache），不往索引根里写：
    // 那是别人的仓库，写进去会脏 git status。
    this.stateDir = resolveStateDir(cfg, rootCfg.path);
    this.frecency = new Map();
    this.frecencyDirty = false;
    this.frecencyPath = join(this.stateDir, "frecency.json");
    this.loadFrecency();
  }

  loadFrecency() {
    try {
      const raw = JSON.parse(readFileSync(this.frecencyPath, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v === "object") this.frecency.set(k, { count: Number(v.count) || 0, last: Number(v.last) || 0 });
        }
      }
    } catch {
      /* 首次运行没有文件 */
    }
  }

  saveFrecency() {
    if (!this.frecencyDirty) return;
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const obj = {};
      for (const [k, v] of this.frecency) obj[k] = v;
      writeFileSync(this.frecencyPath, JSON.stringify(obj), "utf8");
      this.frecencyDirty = false;
    } catch {
      /* 写不进去就算了，不影响检索 */
    }
  }

  bumpFrecency(relPaths) {
    const now = Date.now();
    for (const rel of relPaths) {
      const cur = this.frecency.get(rel) || { count: 0, last: 0 };
      cur.count += 1;
      cur.last = now;
      this.frecency.set(rel, cur);
    }
    this.frecencyDirty = true;
  }

  frecencyBoost(rel) {
    const v = this.frecency.get(rel);
    if (!v || v.count === 0) return 1;
    const days = Math.max(0, (Date.now() - v.last) / 86400000);
    const decay = v.count / (1 + days);
    return 1 + Math.min(1.5, Math.log2(1 + decay) * 0.25);
  }

  async init() {
    try {
      const mod = await import("@ff-labs/fff-node");
      mkdirSync(this.stateDir, { recursive: true });
      const created = mod.FileFinder.create({
        basePath: this.root.path,
        frecencyDbPath: join(this.stateDir, "frecency-db"),
        historyDbPath: join(this.stateDir, "history-db"),
        disableWatch: this.cfg.watch === false,
        aiMode: true,
      });
      if (created && created.ok) {
        this.fff = created.value;
        await this.fff.waitForScan(30000);
        this.fffReady = true;
      } else {
        this.fffError = created ? String(created.error) : "unknown";
      }
    } catch (e) {
      this.fffError = e && e.message ? e.message : String(e);
    }
    return this;
  }

  info() {
    return {
      root: this.root.label || this.root.path,
      engine: this.fffReady ? "fff-node" : "builtin",
      fffError: this.fffError,
      watch: this.cfg.watch === true,
    };
  }

  /** 文件名模糊搜索：FFF 优先，降级为自有子序列匹配 + 本地 frecency。 */
  find(query, opts = {}) {
    const limit = Number.isFinite(opts.limit) ? opts.limit : this.cfg.maxResults;
    const pathFilter = opts.path ? String(opts.path).toLowerCase().replace(/\\/g, "/") : null;
    if (this.fffReady) {
      const res = this.fff.fileSearch(String(query), { pageSize: Math.max(limit, 20) });
      if (!res || !res.ok) throw new Error(`fff fileSearch 失败: ${res && res.error}`);
      let items = res.value.items.map((it) => ({
        path: it.relativePath,
        score: Number((it.totalFrecencyScore || 0).toFixed(2)),
        gitStatus: it.gitStatus || null,
        engine: "fff-node",
      }));
      if (pathFilter) items = items.filter((it) => it.path.toLowerCase().includes(pathFilter));
      items = items.slice(0, limit);
      this.bumpFrecency(items.map((i) => i.path));
      this.saveFrecency();
      return { items, total: res.value.items.length, engine: "fff-node" };
    }

    const files = this.lineIndex ? this.lineIndex.files : [];
    const scored = [];
    for (const f of files) {
      if (pathFilter && !f.rel.toLowerCase().includes(pathFilter)) continue;
      const base = subsequenceScore(String(query), f.rel);
      if (base <= 0) continue;
      scored.push({
        path: f.rel,
        score: Number((base * this.frecencyBoost(f.rel)).toFixed(2)),
        gitStatus: f.gitStatus || null,
        engine: "builtin",
      });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const items = scored.slice(0, limit);
    this.bumpFrecency(items.map((i) => i.path));
    this.saveFrecency();
    return { items, total: scored.length, engine: "builtin" };
  }

  /** 索引加速的内容检索（plain / regex）。 */
  grep(pattern, opts = {}) {
    if (!this.fffReady) {
      throw new Error("FFF 原生库不可用，hot_grep 需要它；用法等价替代：hot_fuzzy（mode=literal|regex）走常驻行索引");
    }
    const mode = opts.mode === "regex" ? "regex" : "plain";
    const res = this.fff.grep(String(pattern), {
      mode,
      pageSize: Number.isFinite(opts.limit) ? opts.limit : this.cfg.maxResults,
      smartCase: opts.smartCase !== false,
      beforeContext: Number.isFinite(opts.context) ? opts.context : 0,
      afterContext: Number.isFinite(opts.context) ? opts.context : 0,
    });
    if (!res || !res.ok) throw new Error(`fff grep 失败: ${res && res.error}`);
    const v = res.value;
    return {
      total: v.totalMatched ?? v.items.length,
      items: v.items.map((m) => ({
        path: m.relativePath,
        line: m.lineNumber,
        text: String(m.lineContent || "").trim().slice(0, 300),
        gitStatus: m.gitStatus || null,
      })),
    };
  }

  dispose() {
    this.saveFrecency();
    try {
      if (this.fff) this.fff.destroy();
    } catch {
      /* ignore */
    }
    this.fff = null;
    this.fffReady = false;
  }
}
