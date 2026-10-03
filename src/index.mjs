// dsh-hot-search — 插件入口。
//
// 常驻形态：索引在 host 进程启动时构建一次，之后所有查询都在进程内完成
// （没有进程启动开销，也没有每次重建索引的成本）。文件变更按 refreshIntervalMs
// 自动重建；FFF 那侧另有自己的文件监视。
//
// 只注入 tools。刻意不注入 settings：配置从 profile patch 层下发（该层是热重载的，
// 改动会重新 apply），少一个服务就少一个激活失败面。

import { configSchema, resolveConfig } from "./config.mjs";
import { RootIndex } from "./line-index.mjs";
import { HotFinder } from "./finder.mjs";
import { registerFind, registerGrep, registerFuzzy, registerPlan, registerStats } from "./tools.mjs";

export const name = "dsh-hot-search";
export const inject = ["tools"];
export const Config = configSchema;

const PROMPT_SECTION = `## 热搜索工具族（常驻索引，毫秒级，无需进程启动）

- **hot_find**：文件名/路径模糊搜索。子序列匹配 + frecency（使用习惯，跨重启持久）+ git 状态。中文可用（"配置" → 我的Obsidian配置.md）。用在"我记得文件名里大概有这个词"。
- **hot_fuzzy**：**内容**检索，**中文错字也能命中**（常驻行索引 + 按字符相似度）。mode=fuzzy（默认容错；短于 4 字的词自动精确，可用 minErrors 强制）/ literal（精确子串）/ regex。多词默认 AND，any=true 为 OR。**记得大概词但可能记错时优先用它。**
- **hot_plan**：把命中按文件聚合，输出 命中数/体积/最佳相似度/命中行号 的阅读计划，用来决定"先读哪几篇、分几批"（≥4 篇 subagent 并行、≥8 篇 workflow）。
- **hot_grep**：FFF 索引加速的精确字面/正则内容检索；要求 FFF 原生库可用。
- **hot_stats**：查看索引规模、构建耗时、FFF 是否可用/降级原因。

分工：**文件名** → hot_find；**内容容错（含中文错字）** → hot_fuzzy；**精确原话/正则** → hot_grep 或原生 grep；**语义/意思相近** → vault_search。`;

function buildRoots(cfg, log) {
  return (async () => {
    const roots = [];
    for (const rootCfg of cfg.roots) {
      const index = new RootIndex(rootCfg, cfg);
      const finder = new HotFinder({ rootCfg, cfg, lineIndex: index });
      try {
        await index.build();
      } catch (e) {
        index.error = e && e.message ? e.message : String(e);
        log.warn("hot-search: 行索引构建失败 %s: %s", rootCfg.path, index.error);
      }
      try {
        await finder.init();
      } catch (e) {
        finder.fffError = e && e.message ? e.message : String(e);
      }
      log.info(
        "hot-search: 根 %s 就绪（%d 文件 / %d 行 / %d KB，构建 %d ms，引擎 %s）",
        rootCfg.label || rootCfg.path,
        index.files.length,
        index.lines.length,
        Math.round(index.bytes / 1024),
        index.buildMs,
        finder.fffReady ? "fff-node" : "builtin",
      );
      roots.push({
        label: rootCfg.label || rootCfg.path,
        path: rootCfg.path,
        index,
        finder,
      });
    }
    return roots;
  })();
}

export function apply(ctx, entryConfig) {
  const cfg = resolveConfig(entryConfig);
  const log = ctx.logger || console;
  const state = {
    cfg,
    roots: [],
    ready: null,
    readyDone: false,
    error: null,
    timer: null,
    ensureFresh: null,
  };

  const rebuild = async () => {
    const next = await buildRoots(cfg, log);
    const previous = state.roots;
    state.roots = next;
    for (const r of previous) {
      try {
        r.finder.dispose();
      } catch {
        /* 释放失败不影响新索引 */
      }
    }
  };

  state.ready = (async () => {
    try {
      if (!cfg.enabled) {
        state.readyDone = true;
        return;
      }
      await rebuild();
      state.readyDone = true;
    } catch (e) {
      state.error = e && e.message ? e.message : String(e);
      log.error("hot-search: 初始化失败: %s", state.error);
    }
  })();

  state.ensureFresh = async () => {
    if (state.ready) await state.ready;
    if (!cfg.enabled) throw Object.assign(new Error("dsh-hot-search 已禁用（配置 enabled=false）"), { code: "DISABLED" });
    const stale = state.roots.some((r) => !r.index.ready || r.index.stale);
    if (stale) {
      try {
        await rebuild();
      } catch (e) {
        state.error = e && e.message ? e.message : String(e);
      }
    }
  };

  if (cfg.enabled && cfg.refreshIntervalMs > 0) {
    const tick = () => {
      if (state.roots.some((r) => r.index.stale)) {
        state.ensureFresh().catch(() => {});
      }
    };
    state.timer = setInterval(tick, Math.max(5000, Math.min(cfg.refreshIntervalMs, 60000)));
    if (state.timer.unref) state.timer.unref();
  }

  const disposers = [];
  if (cfg.enabled) {
    if (ctx.tools && typeof ctx.tools.register === "function") {
      disposers.push(registerFind(ctx, state));
      disposers.push(registerGrep(ctx, state));
      disposers.push(registerFuzzy(ctx, state));
      disposers.push(registerPlan(ctx, state));
      disposers.push(registerStats(ctx, state));
    } else {
      log.warn("hot-search: tools 服务不可用，未注册任何工具");
    }
    if (cfg.promptSection) {
      try {
        const sp = ctx.get("systemPrompt");
        if (sp && typeof sp.section === "function") {
          disposers.push(sp.section({ name: "hot-search", order: 130, text: PROMPT_SECTION }));
        }
      } catch {
        /* 没有 systemPrompt 也无所谓 */
      }
    }
  }

  ctx.effect(() => () => {
    for (const d of disposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    if (state.timer) clearInterval(state.timer);
    for (const r of state.roots) {
      try {
        r.finder.dispose();
      } catch {
        /* ignore */
      }
    }
    state.roots = [];
  });
}
