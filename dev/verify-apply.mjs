// verify-apply.mjs — 冷启动契约测试：用 mock ctx 直接调用已安装发行版的 apply()，
// 检查 ① 导出契约 ② 工具注册 ③ 输出是否符合宿主严格校验 ④ 五个工具真能跑通。
//
// 这补上了"宿主一直没重启"的盲区：不是测文件，而是测插件入口被加载时的行为。
// 用法:
//   node dev/verify-apply.mjs <已安装插件目录> <要索引的库目录>
// 也可用环境变量提供：DSH_HOT_SEARCH_INSTALLED / DSH_HOT_SEARCH_VAULT
//
// ⚠️ 内容层面的断言（如"自动同部"命中 我的Obsidian配置）是针对作者本机的中文笔记库写的，
//    换成你自己的库后需要相应调整；契约类断言（导出/注册/输出 schema）可直接复用。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const installedRoot = process.argv[2] || process.env.DSH_HOT_SEARCH_INSTALLED;
const vaultRoot = process.argv[3] || process.env.DSH_HOT_SEARCH_VAULT;
if (!installedRoot || !vaultRoot) {
  console.error("用法: node dev/verify-apply.mjs <已安装插件目录> <要索引的库目录>");
  console.error("  也可用环境变量 DSH_HOT_SEARCH_INSTALLED / DSH_HOT_SEARCH_VAULT 提供。");
  process.exit(2);
}
const pkg = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));

const checks = [];
const check = (name, pass, extra = "") => {
  checks.push([name, pass, extra]);
  console.log(`${pass ? "  ok  " : " FAIL "} ${name}${extra ? `  (${extra})` : ""}`);
};

// --- mock ctx ---------------------------------------------------------------
const registered = new Map();
const sections = [];
const disposers = [];
const logs = [];
const ctx = {
  logger: {
    info: (...a) => logs.push(["info", a.join(" ")]),
    warn: (...a) => logs.push(["warn", a.join(" ")]),
    error: (...a) => logs.push(["error", a.join(" ")]),
  },
  get(key) {
    if (key === "systemPrompt") {
      return { section: (opts) => { sections.push(opts); return () => {}; } };
    }
    return undefined;
  },
  tools: {
    register(tool) {
      if (!tool || typeof tool.name !== "string") throw new Error("工具缺少 name");
      registered.set(tool.name, tool);
      return () => registered.delete(tool.name);
    },
  },
  effect(fn) {
    disposers.push(fn(() => () => {}));
  },
};

// --- 严格 schema 校验（模拟宿主：additionalProperties:false + required）-----
function schemaProblems(schema, value, path = "") {
  const bad = [];
  if (!schema || value === null || typeof value !== "object") return bad;
  if (schema.type === "object") {
    const props = schema.properties || {};
    const allowed = new Set(Object.keys(props));
    for (const k of Object.keys(value)) {
      if (schema.additionalProperties === false && !allowed.has(k)) {
        bad.push(`${path}${path ? "." : ""}${k} 未声明`);
      }
    }
    for (const req of schema.required || []) {
      if (!(req in value)) bad.push(`${path}${path ? "." : ""}${req} 缺失(required)`);
    }
    for (const [k, s] of Object.entries(props)) {
      if (k in value) bad.push(...schemaProblems(s, value[k], `${path}${path ? "." : ""}${k}`));
    }
  } else if (schema.type === "array" && Array.isArray(value)) {
    value.forEach((v, i) => bad.push(...schemaProblems(schema.items, v, `${path}[${i}]`)));
  }
  return bad;
}

// --- 1) 模块导出契约 --------------------------------------------------------
const mod = await import(pathToFileURL(join(installedRoot, "src", "index.mjs")).href);
check("导出 apply(ctx)", typeof mod.apply === "function");
check("导出 name", typeof mod.name === "string", mod.name);
check("导出 Config（schemastery）", !!mod.Config, mod.Config ? "ok" : "缺失");
check("导出 inject", Array.isArray(mod.inject), JSON.stringify(mod.inject));

// --- 2) apply() 冷启动 ------------------------------------------------------
const entryConfig = {
  roots: [{ path: vaultRoot, label: "main" }],
  refreshIntervalMs: 0,
  watch: false,
  promptSection: true,
  stateDir: join(tmpdir(), "dsh-hot-search-apply-test"), // 测试不碰线上状态
};
let applyError = null;
try {
  mod.apply(ctx, entryConfig);
} catch (e) {
  applyError = e;
}
check("apply() 不抛异常", !applyError, applyError ? applyError.message : "");

const want = ["hot_find", "hot_grep", "hot_fuzzy", "hot_plan", "hot_stats"];
for (const t of want) check(`注册工具 ${t}`, registered.has(t));
check("注入系统提示段", sections.length > 0 && String(sections[0].text || "").includes("hot_fuzzy"));

for (const [name, tool] of registered) {
  const hasCtor =
    tool.parameters && tool.parameters.type === "object" &&
    tool.output && tool.output.schema && typeof tool.output.render === "function" &&
    typeof tool.execute === "function";
  check(`工具 ${name} 契约完整（parameters/output.render/execute）`, hasCtor);
}

// --- 3) 真跑五个工具，并按宿主规则校验输出 ---------------------------------
const calls = [
  ["hot_stats", {}],
  ["hot_find", { query: "配置", limit: 3 }],
  ["hot_fuzzy", { pattern: "自动同部", limit: 3 }],
  ["hot_grep", { pattern: "同步", limit: 3 }],
  ["hot_plan", { pattern: "同步", rowLimit: 3 }],
];
for (const [name, args] of calls) {
  const tool = registered.get(name);
  if (!tool) continue;
  const t0 = Date.now();
  try {
    const value = await tool.execute(args);
    const ms = Date.now() - t0;
    const problems = schemaProblems(tool.output.schema, value, "");
    check(`${name} 执行且输出合法`, problems.length === 0, problems.length ? problems.join("; ") : `${ms} ms`);
    const rendered = tool.output.render(args, value);
    check(`${name} render 产出文本`, Array.isArray(rendered) && rendered.length > 0 && typeof rendered[0].text === "string");
  } catch (e) {
    check(`${name} 执行且输出合法`, false, `抛出: ${e.message}`);
  }
}

// --- 4) 断言内容层面的正确性 ------------------------------------------------
const fz = registered.get("hot_fuzzy");
const fzVal = await fz.execute({ pattern: "自动同部", limit: 5 });
check(
  "中文错字命中 自动同步（score>0.8）",
  fzVal.hits.some((h) => h.path.includes("我的Obsidian配置") && h.score > 0.8),
  fzVal.hits.map((h) => `${h.path}:${h.line}=${h.score}`).slice(0, 3).join(", "),
);
const emptyErr = await fz.execute({ pattern: "" }).then(() => null, (e) => e);
check("空 pattern 明确报错", !!emptyErr, emptyErr ? emptyErr.message : "未报错");
const rxErr = await fz.execute({ pattern: "[unclosed", mode: "regex" }).then(() => null, (e) => e);
check("非法正则明确报错", !!rxErr, rxErr ? rxErr.message.slice(0, 60) : "未报错");

// --- 5) 卸载清理不炸 --------------------------------------------------------
const statsTool = registered.get("hot_stats");
await statsTool.execute({});
let disposeError = null;
try {
  for (const fn of disposers) fn();
} catch (e) {
  disposeError = e;
}
check("dispose 不抛异常", !disposeError, disposeError ? disposeError.message : "");

const passed = checks.filter((c) => c[1]).length;
console.log(`\n${passed}/${checks.length} 通过  ·  被测包 ${pkg.name}@${pkg.version}`);
if (logs.some(([lvl]) => lvl === "error")) console.log("插件日志(错误):", logs.filter(([l]) => l === "error").join(" | "));
process.exit(passed === checks.length ? 0 : 1);
