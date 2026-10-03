// dsh-hot-search — 常驻行索引 + 内容检索内核。
//
// 与 FFF 的分工：
//   · FFF 擅长"子序列式"匹配（文件名、拉丁错字），实测对中文内容容错无效；
//   · 这里实现的是"按字符的编辑距离式"相似度，中文错一个字也能命中。
// 速度快的原因是索引常驻在宿主进程里：文件只读一次、每行预算 256 位字符指纹，
// 查询时先做位运算预筛，再对极少数候选行做窗口化 LCS 比值。

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const FP_WORDS = 8; // 256 bit

function hash32(cp) {
  let x = cp | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 把一行的字符集折进 8×32 位指纹（哈希位，允许碰撞——预筛后仍有精确校验）。 */
function fingerprintInto(text, fps, base) {
  for (let i = 0; i < FP_WORDS; i += 1) fps[base + i] = 0;
  for (let i = 0; i < text.length; i += 1) {
    const bit = hash32(text.charCodeAt(i)) & 0xff;
    fps[base + (bit >>> 5)] |= 1 << (bit & 31);
  }
}

function tokenFingerprint(token) {
  const fp = new Uint32Array(FP_WORDS);
  for (let i = 0; i < token.length; i += 1) {
    const bit = hash32(token.charCodeAt(i)) & 0xff;
    fp[bit >>> 5] |= 1 << (bit & 31);
  }
  return fp;
}

function popcount(x) {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0x3f;
}

/** 预筛：token 指纹中至少 60% 的位出现在该行指纹里。 */
function prefilter(fps, base, tokenFp, tokenBits) {
  let matched = 0;
  for (let w = 0; w < FP_WORDS; w += 1) {
    matched += popcount(fps[base + w] & tokenFp[w]);
    if (matched * 5 >= tokenBits * 3) return true;
  }
  return false;
}

/** 最长公共子序列长度（滚动数组，短窗口用）。 */
function lcsLength(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const prev = new Uint16Array(lb + 1);
  const cur = new Uint16Array(lb + 1);
  for (let i = 1; i <= la; i += 1) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j += 1) {
      cur[j] = ca === b.charCodeAt(j - 1)
        ? prev[j - 1] + 1
        : (prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1]);
    }
    prev.set(cur);
  }
  return prev[lb];
}

/** 2*LCS/(|a|+|b|)：与 Python difflib.ratio 同量级的"按字符"相似度。 */
function lcsRatio(a, b) {
  return (2 * lcsLength(a, b)) / (a.length + b.length || 1);
}

/**
 * 在行内找最相似的窗口，返回 {score, start, end}。
 *
 * 性能关键：窗口按 1 格滑动时，用 256 桶计数维护"窗口内命中了 token 指纹的位数"，
 * 得到 LCS 比值的上界并按需剪枝 —— 只有极少数窗口才真正跑 LCS DP。
 * 实测把拉丁错字查询从 85 ms 压到个位毫秒。
 */
function bestWindow(token, line, maxErrors, tokenFp, tokenBits) {
  const n = token.length;
  const len = line.length;
  if (n === 0 || len === 0 || !tokenFp) return { score: 0, start: 0, end: 0 };
  const sizes = new Set([n]);
  if (n - maxErrors >= 1) sizes.add(n - maxErrors);
  if (n + maxErrors <= len) sizes.add(n + maxErrors);
  let best = { score: 0, start: 0, end: 0 };
  const counts = new Int32Array(256);
  const bitOf = (b) => (tokenFp[b >>> 5] & (1 << (b & 31))) !== 0;

  for (const size of sizes) {
    if (size < 1 || size > len) continue;
    counts.fill(0);
    let matchedBits = 0;
    for (let i = 0; i < size; i += 1) {
      const b = hash32(line.charCodeAt(i)) & 0xff;
      if (counts[b]++ === 0 && bitOf(b)) matchedBits += 1;
    }
    for (let i = 0; i + size <= len; i += 1) {
      if (i > 0) {
        const out = hash32(line.charCodeAt(i - 1)) & 0xff;
        if (--counts[out] === 0 && bitOf(out)) matchedBits -= 1;
        const inn = hash32(line.charCodeAt(i + size - 1)) & 0xff;
        if (counts[inn]++ === 0 && bitOf(inn)) matchedBits += 1;
      }
      // 上界：LCS 不可能超过 token 长度、窗口长度、窗口内已出现的 token 位数三者最小值
      const ub = (2 * Math.min(Math.min(n, size), matchedBits)) / (n + size);
      if (ub <= best.score) continue;
      const score = lcsRatio(token, line.slice(i, i + size));
      if (score > best.score) best = { score, start: i, end: i + size };
    }
  }
  return best;
}

function normPath(p) {
  return p.split(sep).join("/");
}

async function walk(dir, cfg, out, budget) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (budget.bytes >= budget.limit) return;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.startsWith(".") && ent.name !== ".") continue;
      if (cfg.excludeDirs.includes(ent.name)) continue;
      await walk(full, cfg, out, budget);
      continue;
    }
    if (!ent.isFile()) continue;
    const lower = ent.name.toLowerCase();
    const dot = lower.lastIndexOf(".");
    const ext = dot >= 0 ? lower.slice(dot) : "";
    if (!cfg.extensions.includes(ext)) continue;
    let info;
    try {
      info = await stat(full);
    } catch {
      continue;
    }
    if (info.size > cfg.maxFileSize) {
      out.skippedSize += 1;
      continue;
    }
    if (budget.bytes + info.size > budget.limit) continue;
    budget.bytes += info.size;
    out.paths.push({ abs: full, size: info.size, mtimeMs: info.mtimeMs });
  }
}

/** 读 git status（仅当根下存在 .git）；失败静默返回空表。 */
async function readGitStatus(rootAbs, statusMap) {
  try {
    await stat(join(rootAbs, ".git"));
  } catch {
    return;
  }
  await new Promise((resolve) => {
    execFile(
      "git",
      ["-C", rootAbs, "status", "--porcelain", "-z"],
      { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (!err && typeof stdout === "string") {
          for (const chunk of stdout.split("\0")) {
            if (chunk.length < 4) continue;
            const code = chunk.slice(0, 2).trim();
            const file = normPath(chunk.slice(3));
            statusMap.set(file, code === "??" ? "untracked" : "modified");
          }
        }
        resolve();
      },
    );
  });
}

export class RootIndex {
  constructor(rootCfg, cfg) {
    this.path = rootCfg.path;
    this.label = rootCfg.label || rootCfg.path;
    this.cfg = cfg;
    this.files = [];
    this.lines = []; // {file, no, text}
    this.fps = null;
    this.lower = null;
    this.bytes = 0;
    this.skippedSize = 0;
    this.builtAt = 0;
    this.buildMs = 0;
    this.error = null;
  }

  get ready() {
    return this.builtAt > 0;
  }

  get stale() {
    const ttl = this.cfg.refreshIntervalMs;
    return ttl > 0 && this.builtAt > 0 && Date.now() - this.builtAt > ttl;
  }

  async build() {
    const t0 = Date.now();
    const files = [];
    const acc = { paths: [], skippedSize: 0 };
    const budget = { bytes: 0, limit: this.cfg.maxIndexedBytes };
    const statusMap = new Map();
    await readGitStatus(this.path, statusMap);
    await walk(this.path, this.cfg, acc, budget);

    const lines = [];
    const fpsParts = [];
    for (const p of acc.paths) {
      let text;
      try {
        text = await readFile(p.abs, "utf8");
      } catch {
        continue;
      }
      const fileIdx = files.length;
      const rel = normPath(relative(this.path, p.abs));
      files.push({
        abs: p.abs,
        rel,
        size: p.size,
        mtimeMs: p.mtimeMs,
        gitStatus: statusMap.get(rel) || null,
      });
      const body = text.split(/\r?\n/);
      for (let i = 0; i < body.length; i += 1) {
        const raw = body[i];
        if (raw.length > 4000) continue; // 超长行（base64 之类）不入索引
        const trimmed = raw.trim();
        if (trimmed === "") continue;
        const base = lines.length * FP_WORDS;
        // 先扩容再写指纹；指纹按小写计算，使 ASCII 大小写不敏感（CJK 不受影响）
        while (fpsParts.length < base + FP_WORDS) fpsParts.push(0);
        fingerprintInto(hasAsciiLetters(raw) ? raw.toLowerCase() : raw, fpsParts, base);
        lines.push({ file: fileIdx, no: i + 1, text: raw });
      }
    }

    this.files = files;
    this.lines = lines;
    this.fps = Uint32Array.from(fpsParts);
    this.lower = null;
    this.bytes = budget.bytes;
    this.skippedSize = acc.skippedSize;
    this.builtAt = Date.now();
    this.buildMs = Date.now() - t0;
    this.error = null;
    return this;
  }

  /** 懒构建小写缓存（仅当查询含 ASCII 字母时才付这份内存）。 */
  lowerLines() {
    if (this.lower === null) {
      const arr = new Array(this.lines.length);
      for (let i = 0; i < this.lines.length; i += 1) arr[i] = this.lines[i].text.toLowerCase();
      this.lower = arr;
    }
    return this.lower;
  }

  stats() {
    return {
      label: this.label,
      path: this.path,
      files: this.files.length,
      lines: this.lines.length,
      bytes: this.bytes,
      skippedSize: this.skippedSize,
      buildMs: this.buildMs,
      ageMs: this.builtAt ? Date.now() - this.builtAt : null,
    };
  }
}

function hasAsciiLetters(s) {
  return /[A-Za-z]/.test(s);
}

function errorsFor(token, cfg) {
  if (cfg.fuzzyMaxErrors > 0) return cfg.fuzzyMaxErrors;
  return Math.min(3, Math.floor(token.length / 4));
}

function pathAllowed(rel, folder, ext) {
  const r = rel.toLowerCase();
  if (folder && !r.includes(String(folder).replace(/\\/g, "/").toLowerCase())) return false;
  if (ext && !r.endsWith(String(ext).toLowerCase())) return false;
  return true;
}

/**
 * 内容检索。mode: literal | fuzzy | regex。
 * fuzzy 是"按字符相似度"的容错匹配（中文错字可用）；字面与正则与 rg 语义一致。
 */
export function searchIndex(index, patterns, opts = {}) {
  const cfg = index.cfg;
  const mode = opts.mode || "fuzzy";
  const any = opts.any === true;
  const limit = Number.isFinite(opts.limit) ? opts.limit : cfg.maxResults;
  const folder = opts.folder || null;
  const ext = opts.ext || null;
  const hits = [];
  const tokens = patterns.map((p) => String(p));
  const needLower = mode !== "regex" && tokens.some(hasAsciiLetters);
  const lowerCache = needLower ? index.lowerLines() : null;
  const tokenFps = [];
  const tokenBits = [];
  const tokenErrors = [];
  const thresholds = [];
  for (const token of tokens) {
    if (mode === "fuzzy") {
      const err = errorsFor(token, cfg);
      tokenErrors.push(err);
      thresholds.push(err > 0 ? 1 - err / token.length : 1);
      const fp = tokenFingerprint(token.toLowerCase());
      tokenFps.push(fp);
      let bits = 0;
      for (let w = 0; w < FP_WORDS; w += 1) bits += popcount(fp[w]);
      tokenBits.push(bits);
    } else {
      tokenErrors.push(0);
      thresholds.push(1);
      tokenFps.push(null);
      tokenBits.push(0);
    }
  }
  const loweredTokens = tokens.map((t) => t.toLowerCase());
  const regexes = mode === "regex"
    ? tokens.map((t) => {
        try {
          return new RegExp(t);
        } catch (e) {
          throw new Error(`非法正则 ${t}: ${e.message}`);
        }
      })
    : null;

  for (let i = 0; i < index.lines.length; i += 1) {
    const line = index.lines[i];
    const file = index.files[line.file];
    if (!pathAllowed(file.rel, folder, ext)) continue;
    const text = line.text;
    const low = lowerCache ? lowerCache[i] : text;

    let scoreSum = any ? 0 : 1;
    let matchedTokens = 0;
    let bestStart = -1;
    let bestEnd = -1;

    for (let t = 0; t < tokens.length; t += 1) {
      let score = 0;
      let start = -1;
      let end = -1;
      if (mode === "regex") {
        const m = regexes[t].exec(text);
        if (m) {
          score = 1;
          start = m.index;
          end = m.index + m[0].length;
        }
      } else if (mode === "literal") {
        const at = low.indexOf(loweredTokens[t]);
        if (at >= 0) {
          score = 1;
          start = at;
          end = at + loweredTokens[t].length;
        }
      } else {
        const err = tokenErrors[t];
        if (err <= 0) {
          const at = low.indexOf(loweredTokens[t]);
          if (at >= 0) {
            score = 1;
            start = at;
            end = at + loweredTokens[t].length;
          }
        } else {
          const base = i * FP_WORDS;
          if (prefilter(index.fps, base, tokenFps[t], tokenBits[t])) {
            const w = bestWindow(loweredTokens[t], low, err, tokenFps[t], tokenBits[t]);
            if (w.score >= thresholds[t]) {
              score = w.score;
              start = w.start;
              end = w.end;
            }
          }
        }
      }
      if (score > 0) {
        matchedTokens += 1;
        if (any) scoreSum = Math.max(scoreSum, score);
        else scoreSum = Math.min(scoreSum, score);
        if (start >= 0 && (bestStart < 0 || start < bestStart)) {
          bestStart = start;
          bestEnd = end;
        }
      } else if (!any) {
        matchedTokens = -1;
        break;
      }
    }
    if (matchedTokens <= 0) continue;
    if (!any && matchedTokens !== tokens.length) continue;

    hits.push({
      root: index.label,
      path: file.rel,
      abs: file.abs,
      line: line.no,
      score: Number(scoreSum.toFixed(3)),
      gitStatus: file.gitStatus,
      text: text.trim().slice(0, opts.snippetChars || 300),
      matchStart: bestStart,
      matchEnd: bestEnd,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return { hits: hits.slice(0, limit), total: hits.length, mode };
}

/** 把命中聚合成"读哪些文件、每篇命中几处"的阅读计划。 */
export function planFromHits(hits, rootIndex) {
  const byPath = new Map();
  for (const h of hits) {
    let row = byPath.get(h.path);
    if (!row) {
      const file = rootIndex.files.find((f) => f.rel === h.path);
      row = { path: h.path, hits: 0, best: 0, lines: [], bytes: file ? file.size : 0 };
      byPath.set(h.path, row);
    }
    row.hits += 1;
    row.best = Math.max(row.best, h.score);
    if (row.lines.length < 6) row.lines.push(h.line);
  }
  return [...byPath.values()].sort((a, b) => b.hits - a.hits || b.bytes - a.bytes);
}
