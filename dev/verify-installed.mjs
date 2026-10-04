// verify-installed.mjs — 验收「已安装的发行版」（不是开发副本）。
// 直接 import 安装目录里的 src，避免"测的是我本地改过的代码"这种自欺。
//
// 用法:
//   node dev/verify-installed.mjs <已安装插件目录> <要索引的库目录>
// 也可用环境变量提供：DSH_HOT_SEARCH_INSTALLED / DSH_HOT_SEARCH_VAULT
//
// 例（从 DSH 的 shell 里跑）:
//   node dev/verify-installed.mjs "$DSH_HOME/profiles/desktop/node_modules/dsh-hot-search" D:/notes
//
// ⚠️ 下文"断言结果"里的具体文件名/计数（如 我的Obsidian配置、folder=个人数据、literal=15）
//    是针对作者本机那个中文笔记库写的。换成你自己的库后，请把这些期望值改成你的库的实际情况
//    （否则它们会 FAIL，那是语料不匹配，不是插件坏了）。与语料无关的契约类断言可直接复用。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const installedRoot = process.argv[2] || process.env.DSH_HOT_SEARCH_INSTALLED;
const vaultRoot = process.argv[3] || process.env.DSH_HOT_SEARCH_VAULT;
if (!installedRoot || !vaultRoot) {
  console.error("用法: node dev/verify-installed.mjs <已安装插件目录> <要索引的库目录>");
  console.error("  也可用环境变量 DSH_HOT_SEARCH_INSTALLED / DSH_HOT_SEARCH_VAULT 提供。");
  console.error('  例: node dev/verify-installed.mjs "$DSH_HOME/profiles/desktop/node_modules/dsh-hot-search" /path/to/your/vault');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
console.log(`installed: ${pkg.name}@${pkg.version}`);
console.log(`engines  : node ${pkg.engines?.node} | dsh ${pkg.engines?.dsh}`);
console.log(`deps     : ${Object.entries(pkg.dependencies || {}).map(([k, v]) => `${k}@${v}`).join(", ")}`);

const src = (f) => pathToFileURL(join(installedRoot, "src", f)).href;
const { RootIndex, searchIndex, planFromHits } = await import(src("line-index.mjs"));
const { HotFinder } = await import(src("finder.mjs"));
const stateDir = await import(src("state-dir.mjs"));

const cfg = {
  extensions: [".md", ".txt"],
  excludeDirs: [".obsidian", ".trash", ".git", "node_modules", ".dsh-tools", ".dsh"],
  maxFileSize: 2 * 1024 * 1024,
  maxIndexedBytes: 64 * 1024 * 1024,
  refreshIntervalMs: 0,
  fuzzyMaxErrors: 0,
  maxResults: 50,
  watch: false,
  stateDir: "",
};
const rootCfg = { path: vaultRoot, label: "main" };

console.log("\n--- 状态目录解析（本脚本进程环境下的结果；不等于 DSH 宿主进程的落点）---");
console.log("base    :", stateDir.resolveStateBaseDir(cfg));
console.log("forRoot :", stateDir.resolveStateDir(cfg, vaultRoot));

const index = new RootIndex(rootCfg, cfg);
const t0 = Date.now();
await index.build();
const elapsedBuild = Date.now() - t0;
console.log(`index   : ${index.files.length} files / ${index.lines.length} lines / ${(index.bytes / 1024).toFixed(1)} KB / build ${elapsedBuild} ms`);

function timed(fn, runs = 8) {
  let last;
  const ts = [];
  for (let i = 0; i < runs; i += 1) {
    const s = process.hrtime.bigint();
    last = fn();
    ts.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return { last, avg: ts.reduce((a, b) => a + b, 0) / ts.length };
}

const checks = [];
const check = (name, pass, extra = "") => checks.push([name, pass, extra]);

// 1) 中文错字容错（相对 FFF 的核心差异能力）
const cjk = timed(() => searchIndex(index, ["自动同部"], { mode: "fuzzy", folder: "个人数据", limit: 50 }));
const cjkHit = cjk.last.hits.find((h) => h.path.includes("我的Obsidian配置") && h.score > 0.8);
check("中文错字命中 自动同步（score>0.8）", !!cjkHit, cjkHit ? `score=${cjkHit.score} avg=${cjk.avg.toFixed(2)}ms` : `total=${cjk.last.total}`);

// 2) 短词默认退回精确（不产生噪声）
const shortDefault = searchIndex(index, ["同部"], { mode: "fuzzy", folder: "个人数据", limit: 50 });
check("短词默认精确（0 命中）", shortDefault.total === 0, `total=${shortDefault.total}`);

// 3) 显式 minErrors 可放开
cfg.fuzzyMaxErrors = 1;
const forced = searchIndex(index, ["同部"], { mode: "fuzzy", folder: "个人数据", limit: 50 });
cfg.fuzzyMaxErrors = 0;
check("minErrors=1 放开短词", forced.total > 0, `total=${forced.total}`);

// 4) literal 计数
const literal = timed(() => searchIndex(index, ["同步"], { mode: "literal", limit: 500 }));
check("literal 同步 命中", literal.last.total > 0, `total=${literal.last.total} avg=${literal.avg.toFixed(2)}ms`);

// 5) regex
const rx = searchIndex(index, ["^#{1,3} "], { mode: "regex", folder: "Template", limit: 50 });
check("regex 可用", rx.total > 0, `total=${rx.total}`);

// 6) AND 收窄 / OR 放宽
const andR = searchIndex(index, ["同步", "S3"], { mode: "literal", limit: 500 });
const orR = searchIndex(index, ["同步", "S3"], { mode: "literal", any: true, limit: 500 });
check("AND 收窄 / OR 放宽", andR.total < orR.total, `and=${andR.total} or=${orR.total}`);

// 7) 阅读计划
const plan = planFromHits(literal.last.hits, index);
check("plan 聚合非空", plan.length > 0, `files=${plan.length}`);

// 8) 非法正则必须抛错而不是静默
let threw = false;
try {
  searchIndex(index, ["[unclosed"], { mode: "regex" });
} catch {
  threw = true;
}
check("非法正则抛错", threw);

// 9) 路径过滤
const filtered = searchIndex(index, ["同步"], { mode: "literal", folder: "日记", limit: 500 });
check("folder 过滤生效", filtered.hits.every((h) => h.path.startsWith("日记/")), `total=${filtered.total}`);

// 10) FFF 原生层 + 与 literal 互校 + 降级层
const finder = new HotFinder({ rootCfg, cfg, lineIndex: index });
await finder.init();
check("FFF 原生引擎加载", finder.fffReady, finder.info().engine + (finder.fffError ? ` err=${finder.fffError}` : ""));

const findCJK = timed(() => finder.find("配置", { limit: 10 }));
check("hot_find 中文文件名命中", findCJK.last.items.length > 0, `items=${findCJK.last.items.length} avg=${findCJK.avg.toFixed(2)}ms`);

const grepSync = timed(() => finder.grep("同步", { mode: "plain", limit: 20 }));
check("hot_grep 与 literal 计数互校", grepSync.last.total === literal.last.total, `grep=${grepSync.last.total} literal=${literal.last.total} avg=${grepSync.avg.toFixed(2)}ms`);

finder.dispose();
const fbCJK = finder.find("配置", { limit: 10 });
const fbTypo = finder.find("obsidain", { limit: 10 });
check("降级层：中文文件名仍命中", fbCJK.items.length > 0, `items=${fbCJK.items.length} engine=${fbCJK.engine}`);
check("降级层：拉丁错字仍命中（换位容错）", fbTypo.items.length > 0, `items=${fbTypo.items.length}`);

// 11) 不污染被索引的仓库
check("状态未写进笔记库（无 .dsh-tools/hot-search）", !existsSync(join(vaultRoot, ".dsh-tools", "hot-search")));

console.log("\n--- 断言结果 ---");
let ok = true;
for (const [n, p, e] of checks) {
  if (!p) ok = false;
  console.log(`${p ? "PASS" : "FAIL"}  ${n}${e ? `  (${e})` : ""}`);
}
console.log(`\n${checks.filter((c) => c[1]).length}/${checks.length} 通过  ·  索引构建 ${elapsedBuild} ms`);
process.exit(ok ? 0 : 1);
