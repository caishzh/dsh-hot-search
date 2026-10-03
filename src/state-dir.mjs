// dsh-hot-search — 状态目录解析。
//
// frecency / 查询历史库属于"插件自己的运行时数据"，不是索引数据：
// 放进用户的仓库会污染 git status，也让多人共享一份笔记库时互相打架。
// 所以优先级是：用户显式配置 → $DSH_HOME/hot-search → 系统 cache 目录。
// 无论落在哪里，每个根再用「目录名 + 路径哈希」分子目录，避免多根互相覆盖。

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** 去掉末尾分隔符；根目录本身保持原样。 */
function stripTrailingSep(p) {
  let out = p;
  while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
    if (/^[A-Za-z]:[\\/]?$/.test(out)) break; // "C:\" 不要再削
    out = out.slice(0, -1);
  }
  return out;
}

function normalizeDir(p) {
  return stripTrailingSep(String(p).trim().replace(/\\/g, sep).replace(/\//g, sep));
}

function safeHome() {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/**
 * 状态根目录：用户配置优先，其次 DSH_HOME，最后系统 cache 目录。
 * 注意这里不创建目录，只算路径——写盘由调用方在真正需要时做。
 */
export function resolveStateBaseDir(cfg = {}) {
  const configured = typeof cfg.stateDir === "string" ? cfg.stateDir.trim() : "";
  if (configured) return normalizeDir(configured);

  const dshHome = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  if (dshHome) return join(normalizeDir(dshHome), "hot-search");

  switch (process.platform) {
    case "win32": {
      const local = process.env.LOCALAPPDATA || process.env.APPDATA;
      const home = safeHome();
      if (local) return join(normalizeDir(local), "dsh-hot-search");
      if (home) return join(normalizeDir(home), "AppData", "Local", "dsh-hot-search");
      return join(process.cwd(), ".dsh-hot-search-state");
    }
    case "darwin": {
      const home = safeHome();
      return home ? join(normalizeDir(home), "Library", "Caches", "dsh-hot-search") : join(process.cwd(), ".dsh-hot-search-state");
    }
    default: {
      const xdg = typeof process.env.XDG_CACHE_HOME === "string" ? process.env.XDG_CACHE_HOME.trim() : "";
      if (xdg) return join(normalizeDir(xdg), "dsh-hot-search");
      const home = safeHome();
      return home ? join(normalizeDir(home), ".cache", "dsh-hot-search") : join(process.cwd(), ".dsh-hot-search-state");
    }
  }
}

/** 路径哈希，用来给每个根分一个稳定子目录（8 字节，够用且短）。 */
export function rootHash(rootPath) {
  return createHash("sha1").update(String(rootPath)).digest("hex").slice(0, 16);
}

/** 把根路径折成一个不会在 Windows 上踩到非法字符的目录名。 */
export function rootSlug(rootPath, fallback = "root") {
  const base = basename(stripTrailingSep(String(rootPath)));
  const cleaned = base
    .replace(/[^0-9A-Za-z\u4e00-\u9fff._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

/** 某个根的最终状态目录：<base>/<slug>-<hash8>。 */
export function resolveStateDir(cfg, rootPath) {
  const base = resolveStateBaseDir(cfg);
  const hash = rootHash(rootPath).slice(0, 8);
  const slug = rootSlug(rootPath);
  return resolve(join(base, `${slug}-${hash}`));
}
