// dsh-hot-search — 设置 schema（schemastery）+ 归一化默认值。
// 分层：schema 默认 → entry config（profile patch 的 config:）→ 用户 settings（若宿主支持）。

import Schema from "schemastery";

export const name = "dsh-hot-search";

export const configSchema = Schema.object({
  enabled: Schema.boolean().default(true),
  /** 要索引的根目录。为空时按 DSH_WORKSPACE → 进程 cwd 兜底。 */
  roots: Schema.array(
    Schema.object({
      path: Schema.string().required(),
      label: Schema.string(),
    }),
  ).default([]),
  /** 进入行索引的扩展名。 */
  extensions: Schema.array(Schema.string()).default([".md", ".txt", ".markdown"]),
  /** 目录名排除表（与目录名精确匹配；`.` 开头的目录另行一律跳过）。 */
  excludeDirs: Schema.array(Schema.string()).default([
    ".obsidian", ".trash", ".git", ".github", "node_modules",
    ".dsh-tools", ".dsh", "__pycache__", ".venv", "venv", "dist", "build",
  ]),
  /** 单文件大小上限（字节），超过不入索引。 */
  maxFileSize: Schema.number().min(1024).default(2 * 1024 * 1024),
  /** 单个根的总索引字节上限，防止大库把内存吃满。 */
  maxIndexedBytes: Schema.number().min(1024).default(64 * 1024 * 1024),
  /** 索引陈旧多久后自动重建（毫秒）。0 = 不自动重建。 */
  refreshIntervalMs: Schema.number().min(0).default(120000),
  /** 模糊匹配的默认容错字数。0 = 按词长自动（len//4，短词 0）。 */
  fuzzyMaxErrors: Schema.number().min(0).max(4).default(0),
  /** FFF finder 是否启用文件监视（长驻进程建议开着，目录变化即时可见）。 */
  watch: Schema.boolean().default(true),
  /** frecency / 查询历史库的根目录。空 = $DSH_HOME/hot-search，再退化到系统 cache 目录（绝不写进索引根）。 */
  stateDir: Schema.string().default(""),
  /** 单次返回上限。 */
  maxResults: Schema.number().min(1).max(500).default(50),
  /** 是否向系统提示注入一段用法说明。 */
  promptSection: Schema.boolean().default(true),
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  roots: [],
  extensions: [".md", ".txt", ".markdown"],
  excludeDirs: [
    ".obsidian", ".trash", ".git", ".github", "node_modules",
    ".dsh-tools", ".dsh", "__pycache__", ".venv", "venv", "dist", "build",
  ],
  maxFileSize: 2 * 1024 * 1024,
  maxIndexedBytes: 64 * 1024 * 1024,
  refreshIntervalMs: 120000,
  fuzzyMaxErrors: 0,
  watch: true,
  stateDir: "",
  maxResults: 50,
  promptSection: true,
});

function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normRoots(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r.path === "string" && r.path.trim() !== "")
    .map((r) => ({
      path: r.path.trim().replace(/[\\/]+$/, ""),
      label: typeof r.label === "string" && r.label.trim() !== "" ? r.label.trim() : undefined,
    }));
}

export function resolveConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  let roots = normRoots(src.roots);
  if (roots.length === 0) {
    const fallback = process.env.DSH_WORKSPACE || process.cwd();
    if (typeof fallback === "string" && fallback.trim() !== "") {
      roots = [{ path: fallback.trim().replace(/[\\/]+$/, ""), label: "workspace" }];
    }
  }
  const exts = Array.isArray(src.extensions) && src.extensions.length > 0
    ? src.extensions.map((e) => String(e).trim().toLowerCase()).map((e) => (e.startsWith(".") ? e : `.${e}`))
    : [...DEFAULT_CONFIG.extensions];
  return {
    enabled: src.enabled !== false,
    roots,
    extensions: exts,
    excludeDirs: Array.isArray(src.excludeDirs) && src.excludeDirs.length > 0
      ? src.excludeDirs.map(String)
      : [...DEFAULT_CONFIG.excludeDirs],
    maxFileSize: clampInt(src.maxFileSize, DEFAULT_CONFIG.maxFileSize, 1024, 512 * 1024 * 1024),
    maxIndexedBytes: clampInt(src.maxIndexedBytes, DEFAULT_CONFIG.maxIndexedBytes, 1024, 4096 * 1024 * 1024),
    refreshIntervalMs: clampInt(src.refreshIntervalMs, DEFAULT_CONFIG.refreshIntervalMs, 0, 24 * 3600 * 1000),
    fuzzyMaxErrors: clampInt(src.fuzzyMaxErrors, DEFAULT_CONFIG.fuzzyMaxErrors, 0, 4),
    watch: src.watch !== false,
    stateDir: typeof src.stateDir === "string" ? src.stateDir.trim() : "",
    maxResults: clampInt(src.maxResults, DEFAULT_CONFIG.maxResults, 1, 500),
    promptSection: src.promptSection !== false,
  };
}
