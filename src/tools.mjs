// dsh-hot-search — 面向模型的工具集。
// 全部在宿主进程内执行：索引常驻，查询不再付进程启动成本。

import { searchIndex, planFromHits } from "./line-index.mjs";

function hotError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function pickRoots(state, selector) {
  const roots = state.roots;
  if (!roots.length) throw hotError("NO_ROOT", "dsh-hot-search 未配置任何根目录（配置 roots 或设置 DSH_WORKSPACE）");
  if (!selector) return roots;
  const sel = String(selector).toLowerCase();
  const hit = roots.filter((r) => (r.label || "").toLowerCase().includes(sel) || r.path.toLowerCase().includes(sel));
  if (!hit.length) throw hotError("NO_ROOT", `找不到匹配的根: ${selector}（可用: ${roots.map((r) => r.label).join(", ")}）`);
  return hit;
}

function tokenize(pattern) {
  return String(pattern).trim().split(/\s+/).filter((s) => s !== "");
}

const OPT_ROOT = { root: { type: "string", description: "限定某个已配置的根（label 或路径片段）；缺省搜全部根" } };
const OPT_LIMIT = (dflt) => ({ limit: { type: "number", description: `返回上限（默认 ${dflt}）` } });

export function registerFind(ctx, state) {
  return ctx.tools.register({
    name: "hot_find",
    description: `文件名/路径热搜索（毫秒级，常驻索引）。支持子序列模糊：查询 "obsidain" 能命中 obsidian，中文查询同样可用（如"配置"→我的Obsidian配置.md）。
排序叠加 frecency（本次会话的使用习惯，跨重启持久）与 git 状态。用于"我记得文件名里大概有什么词"的场景。
引擎：FFF 原生 finder；原生不可用时自动降级为内置子序列匹配（能力保留）。`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "文件名/路径的模糊查询" },
        path: { type: "string", description: "只保留路径中含该子串的结果" },
        ...OPT_ROOT,
        ...OPT_LIMIT(50),
      },
      required: ["query"],
    },
    timeoutMs: 20000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          engine: { type: "string" },
          total: { type: "number" },
          tookMs: { type: "number" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                root: { type: "string" },
                score: { type: "number" },
                gitStatus: { type: "string" },
              },
              required: ["path", "root", "score"],
            },
          },
        },
        required: ["engine", "total", "tookMs", "hits"],
      },
      render: (_args, v) => {
        if (!v.hits.length) return [{ type: "text", text: `hot_find 无命中（引擎 ${v.engine}，${v.tookMs} ms）。可换更短的子序列，或用 hot_fuzzy 搜内容。` }];
        const lines = [`hot_find 命中 ${v.total} 条（引擎 ${v.engine}，${v.tookMs} ms）：`];
        v.hits.forEach((h, i) => {
          const score = h.score > 0 ? `  score=${h.score}` : "";
          const git = h.gitStatus && h.gitStatus !== "clean" ? ` [${h.gitStatus}]` : "";
          lines.push(`${i + 1}. ${h.path}${score}${git}`);
        });
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      await state.ensureFresh();
      const t0 = Date.now();
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw hotError("INVALID_ARG", "hot_find: query 不能为空");
      const limit = Number.isFinite(args.limit) ? args.limit : state.cfg.maxResults;
      const engines = new Set();
      const all = [];
      let total = 0;
      for (const root of pickRoots(state, args.root)) {
        const res = root.finder.find(query, { limit, path: args.path });
        engines.add(res.engine);
        total += res.total;
        for (const it of res.items) all.push({ ...it, root: root.label });
      }
      all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      // 只回传 schema 声明的字段：宿主对工具输出做严格校验，多余字段会被判为无效输出
      return {
        engine: [...engines].join("+"),
        total,
        tookMs: Date.now() - t0,
        hits: all.slice(0, limit).map((it) => ({
          path: it.path,
          root: it.root,
          score: Number(it.score),
          gitStatus: it.gitStatus || "",
        })),
      };
    },
  });
}

export function registerGrep(ctx, state) {
  return ctx.tools.register({
    name: "hot_grep",
    description: `索引加速的内容检索（精确字面 / 正则），毫秒级。适合"记得原话或要跑正则"的场景。
注意：FFF 的 fuzzy 模式实测对中文无效（连正确词都 0 命中），所以中文容错请用 hot_fuzzy，本工具只做 plain/regex。
要求 FFF 原生库可用；不可用时请改用 hot_fuzzy（mode=literal 或 regex），它走常驻行索引。`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要查找的字面串或正则" },
        mode: { type: "string", description: "plain（默认）| regex" },
        context: { type: "number", description: "每处前后附带的上下文行数（默认 0）" },
        ...OPT_ROOT,
        ...OPT_LIMIT(50),
      },
      required: ["pattern"],
    },
    timeoutMs: 20000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          engine: { type: "string" },
          total: { type: "number" },
          tookMs: { type: "number" },
          warnings: { type: "array", items: { type: "string" } },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                root: { type: "string" },
                line: { type: "number" },
                text: { type: "string" },
                gitStatus: { type: "string" },
              },
              required: ["path", "root", "line", "text"],
            },
          },
        },
        required: ["engine", "total", "tookMs", "warnings", "hits"],
      },
      render: (_args, v) => {
        if (!v.hits.length) return [{ type: "text", text: `hot_grep 无命中（引擎 ${v.engine}，${v.tookMs} ms）。` }];
        const lines = [`hot_grep 命中 ${v.total} 条（引擎 ${v.engine}，${v.tookMs} ms）：`];
        v.hits.forEach((h) => lines.push(`${h.path}:${h.line}: ${h.text}`));
        if (v.warnings.length) lines.push(`注意：${v.warnings.join("；")}`);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      await state.ensureFresh();
      const t0 = Date.now();
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (!pattern) throw hotError("INVALID_ARG", "hot_grep: pattern 不能为空");
      const limit = Number.isFinite(args.limit) ? args.limit : state.cfg.maxResults;
      const all = [];
      const warnings = [];
      let total = 0;
      for (const root of pickRoots(state, args.root)) {
        if (!root.finder.fffReady) {
          warnings.push(`${root.label} 的 FFF 原生库不可用（${root.finder.fffError || "未知原因"}），跳过该根`);
          continue;
        }
        const res = root.finder.grep(pattern, { mode: args.mode, limit, context: args.context });
        total += res.total;
        for (const it of res.items) all.push({ ...it, root: root.label });
      }
      const seen = new Set();
      const hits = [];
      for (const h of all) {
        const key = `${h.path}:${h.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push(h);
        if (hits.length >= limit) break;
      }
      return { engine: "fff-node", total, tookMs: Date.now() - t0, warnings, hits };
    },
  });
}

export function registerFuzzy(ctx, state) {
  return ctx.tools.register({
    name: "hot_fuzzy",
    description: `内容检索，**中文错字也能命中**（这是 FFF 做不到、本插件补齐的能力）。常驻行索引 + 按字符相似度（LCS 比值），毫秒级。
模式：fuzzy（默认，容错；短于 4 字的词自动退回精确，可用 minErrors 强制）/ literal（精确子串）/ regex。
多个词默认 AND（空格分隔）；any=true 改为 OR。命中带相似度分数，可追到 文件:行号。
例：fuzzy "自动同部" → 命中含"自动同步"的行；literal 只认原话；regex 走正则。`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "一个或多个词（空格分隔，默认全部命中 AND）" },
        mode: { type: "string", description: "fuzzy（默认）| literal | regex" },
        any: { type: "boolean", description: "true = 任一命中即可（OR）" },
        minErrors: { type: "number", description: "强制容错字数（0-4）。缺省按词长自动：<4 字不容错" },
        folder: { type: "string", description: "限定路径子串，如 日记 或 个人数据" },
        ext: { type: "string", description: "限定扩展名，如 .md" },
        snippetChars: { type: "number", description: "每条命中正文截断长度（默认 300）" },
        ...OPT_ROOT,
        ...OPT_LIMIT(50),
      },
      required: ["pattern"],
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          engine: { type: "string" },
          total: { type: "number" },
          tookMs: { type: "number" },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                root: { type: "string" },
                line: { type: "number" },
                score: { type: "number" },
                text: { type: "string" },
              },
              required: ["path", "root", "line", "score", "text"],
            },
          },
        },
        required: ["mode", "engine", "total", "tookMs", "hits"],
      },
      render: (_args, v) => {
        if (!v.hits.length) {
          return [{ type: "text", text: `hot_fuzzy 无命中（mode=${v.mode}，${v.tookMs} ms）。库里没有找到相关内容，请如实告知用户，不要编造。可试：缩短词、改 literal/regex、放宽 folder/ext。` }];
        }
        const lines = [`hot_fuzzy 命中 ${v.total} 条（mode=${v.mode}，常驻行索引，${v.tookMs} ms）：`];
        v.hits.forEach((h, i) => lines.push(`${i + 1}. ${h.path}:${h.line}  score=${h.score}\n   ${h.text}`));
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      await state.ensureFresh();
      const t0 = Date.now();
      const tokens = tokenize(args.pattern || "");
      if (!tokens.length) throw hotError("INVALID_ARG", "hot_fuzzy: pattern 不能为空");
      const mode = ["fuzzy", "literal", "regex"].includes(args.mode) ? args.mode : "fuzzy";
      const limit = Number.isFinite(args.limit) ? args.limit : state.cfg.maxResults;
      const all = [];
      let total = 0;
      const savedMin = state.cfg.fuzzyMaxErrors;
      if (Number.isFinite(args.minErrors)) state.cfg.fuzzyMaxErrors = args.minErrors;
      try {
        for (const root of pickRoots(state, args.root)) {
          const res = searchIndex(root.index, tokens, {
            mode,
            any: args.any === true,
            limit,
            folder: args.folder,
            ext: args.ext,
            snippetChars: args.snippetChars,
          });
          total += res.total;
          for (const h of res.hits) all.push({ ...h, root: root.label });
        }
      } finally {
        state.cfg.fuzzyMaxErrors = savedMin;
      }
      all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
      const hits = all.slice(0, limit).map((h) => ({
        path: h.path, root: h.root, line: h.line, score: h.score, text: h.text,
      }));
      for (const root of state.roots) root.finder.bumpFrecency(hits.slice(0, 10).map((h) => h.path));
      return { mode, engine: "resident-line-index", total, tookMs: Date.now() - t0, hits };
    },
  });
}

export function registerPlan(ctx, state) {
  return ctx.tools.register({
    name: "hot_plan",
    description: `给"批量阅读/总结"排批次：先按内容命中把文件聚合，输出 每篇命中数 / 体积 / 最佳相似度 / 命中行号，按 命中数×体积 排序。
用于决定"先读哪几篇、分几批"，配合 subagent/workflow 做并行总结。
模式与 hot_fuzzy 一致（fuzzy/literal/regex，多词 AND，any=OR）。`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "一个或多个词（空格分隔）" },
        mode: { type: "string", description: "fuzzy（默认）| literal | regex" },
        any: { type: "boolean", description: "true = 任一命中即可（OR）" },
        folder: { type: "string", description: "限定路径子串" },
        ext: { type: "string", description: "限定扩展名" },
        rowLimit: { type: "number", description: "最多列出多少个文件（默认 20）" },
        scanLimit: { type: "number", description: "聚合前最多扫描多少条命中（默认 500）" },
        ...OPT_ROOT,
      },
      required: ["pattern"],
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "number" },
          files: { type: "number" },
          tookMs: { type: "number" },
          rows: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                root: { type: "string" },
                hits: { type: "number" },
                bytes: { type: "number" },
                best: { type: "number" },
                lines: { type: "array", items: { type: "number" } },
              },
              required: ["path", "root", "hits", "bytes", "best", "lines"],
            },
          },
        },
        required: ["total", "files", "tookMs", "rows"],
      },
      render: (_args, v) => {
        if (!v.rows.length) return [{ type: "text", text: `hot_plan 无命中（${v.tookMs} ms），无法排批次。` }];
        const lines = [`hot_plan：${v.total} 条命中分布在 ${v.files} 个文件（${v.tookMs} ms），按 命中数×体积 排序（前 ${v.rows.length}）：`, " hits   bytes   best  path  [lines]"];
        for (const r of v.rows) {
          lines.push(`${String(r.hits).padStart(5)} ${String(r.bytes).padStart(7)}  ${r.best.toFixed(2)}  ${r.path}  [${r.lines.join(",")}]`);
        }
        lines.push("建议：≥4 篇用 subagent 并行、≥8 篇用 workflow；每篇要求返回 要点/证据原文/文件:行号/置信度。");
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      await state.ensureFresh();
      const t0 = Date.now();
      const tokens = tokenize(args.pattern || "");
      if (!tokens.length) throw hotError("INVALID_ARG", "hot_plan: pattern 不能为空");
      const mode = ["fuzzy", "literal", "regex"].includes(args.mode) ? args.mode : "fuzzy";
      const scanLimit = Number.isFinite(args.scanLimit) ? args.scanLimit : 500;
      const rowLimit = Number.isFinite(args.rowLimit) ? args.rowLimit : 20;
      const rows = [];
      let total = 0;
      for (const root of pickRoots(state, args.root)) {
        const res = searchIndex(root.index, tokens, {
          mode,
          any: args.any === true,
          limit: scanLimit,
          folder: args.folder,
          ext: args.ext,
        });
        total += res.total;
        for (const r of planFromHits(res.hits, root.index)) rows.push({ ...r, root: root.label });
      }
      rows.sort((a, b) => b.hits - a.hits || b.bytes - a.bytes);
      return {
        total,
        files: rows.length,
        tookMs: Date.now() - t0,
        rows: rows.slice(0, rowLimit).map((r) => ({
          path: r.path, root: r.root, hits: r.hits, bytes: r.bytes, best: r.best, lines: r.lines,
        })),
      };
    },
  });
}

export function registerStats(ctx, state) {
  return ctx.tools.register({
    name: "hot_stats",
    description: "查看热搜索索引状态：每根的 文件数/行数/索引字节/构建耗时/陈旧程度，以及 FFF 原生引擎是否可用、降级原因、frecency 与配置摘要。",
    parameters: {
      type: "object",
      properties: { ...OPT_ROOT },
    },
    timeoutMs: 15000,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ready: { type: "boolean" },
          error: { type: "string" },
          roots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                path: { type: "string" },
                engine: { type: "string" },
                files: { type: "number" },
                lines: { type: "number" },
                bytes: { type: "number" },
                buildMs: { type: "number" },
                ageMs: { type: "number" },
                fffError: { type: "string" },
              },
              required: ["label", "path", "engine", "files", "lines", "bytes"],
            },
          },
        },
        required: ["ready", "roots"],
      },
      render: (_args, v) => {
        const lines = [`hot_stats：${v.ready ? "索引就绪" : "索引未就绪"}${v.error ? `（错误：${v.error}）` : ""}`];
        for (const r of v.roots) {
          lines.push(`· ${r.label} (${r.path})  引擎=${r.engine}`);
          lines.push(`  文件 ${r.files} / 行 ${r.lines} / ${(r.bytes / 1024).toFixed(1)} KB  构建 ${r.buildMs ?? "-"} ms  陈旧 ${r.ageMs ?? "-"} ms`);
          if (r.fffError) lines.push(`  FFF 降级原因：${r.fffError}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      await state.ready;
      const roots = [];
      for (const root of pickRoots(state, args.root)) {
        const s = root.index.stats();
        roots.push({
          label: s.label,
          path: s.path,
          engine: root.finder.fffReady ? "fff-node" : "builtin",
          files: s.files,
          lines: s.lines,
          bytes: s.bytes,
          buildMs: s.buildMs,
          ageMs: s.ageMs ?? 0,
          fffError: root.finder.fffError || "",
        });
      }
      return { ready: state.readyDone === true, error: state.error || "", roots };
    },
  });
}
