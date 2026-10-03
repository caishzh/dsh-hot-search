# dsh-hot-search

给 DeepSeek Harness（DSH）用的**常驻热搜索**：索引活在宿主进程里，查询不再付进程启动成本。五个工具覆盖「文件名模糊」「精确/正则内容」「**中文错字容错**」「批量阅读排批次」四种检索场景。

一句话价值：**中文错字也能命中**（`自动同部` → `自动同步`），而且快——实测毫秒级。这是 FFF 的 `grep fuzzy` 做不到的：它对中文实测 0 命中（连正确词也是），本插件用自研行索引把它补齐。

## 安装

```powershell
# 方式一：npm / registry
dsh plugin add dsh-hot-search

# 方式二：本地目录（开发用；必须是绝对路径）
dsh plugin add D:\path\to\dsh-hot-search

# 方式三：tarball（预构建产物，同样不需要 allowBuilds 授权）
dsh plugin add D:\path\to\dsh-hot-search-0.1.0.tgz

# 装完确认这一层加载进来了
dsh --dump-config | Select-String hot-search
```

装完**直接可用**：没配 `roots` 时，它会索引 DSH 工作区（或进程 cwd）。要索引自己的笔记库，见下面「配置」。

> ⚠️ 别用 `--profile desktop` 验证：DSH 的 CLI 会拒绝该内置 profile。用一个新名字（`--profile demo`）即可。

## 配置

默认零配置可用。要索引自己的库，在你 profile 的 `cordis.patch.yml` 里覆盖这一行
（`config` 是**整体替换**，不是深合并；DSH 的 patch 方言只有 `insert`）：

```yaml
- id: hot-search
  config:
    roots:
      - path: D:\ObsidianNotes
        label: main
      - path: D:\notes\work
        label: work
```

全部可配置项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉等于不注册任何工具 |
| `roots` | `[]` | 要索引的根；空则回退到 `DSH_WORKSPACE` → 进程 cwd |
| `extensions` | `.md` `.txt` `.markdown` | 进入行索引的扩展名 |
| `excludeDirs` | 见 `src/config.mjs` | 目录名排除表（精确匹配；`.` 开头的一律跳过） |
| `maxFileSize` | `2 MiB` | 单文件超过就不入索引 |
| `maxIndexedBytes` | `64 MiB` | 每个根的总预算，防止大库吃满内存 |
| `refreshIntervalMs` | `120000` | 索引陈旧后自动重建的检查间隔；`0` = 不自动重建 |
| `fuzzyMaxErrors` | `0` | 模糊匹配容错字数；`0` = 按词长自动（`len//4`，短于 4 字不自动容错） |
| `watch` | `true` | FFF finder 是否文件监视（长驻进程建议开） |
| `stateDir` | `""` | frecency/历史库的**根**目录；空 = `$DSH_HOME/hot-search`，再退化到系统 cache |
| `maxResults` | `50` | 单次返回上限 |
| `promptSection` | `true` | 是否向系统提示注入用法说明 |

## 五个工具

| 工具 | 用途 | 引擎 |
| --- | --- | --- |
| `hot_find` | 文件名/路径模糊（子序列 + frecency + git 状态）。`obsidain` → `obsidian`，中文同样可用 | FFF 原生；不可用时降级为内置子序列匹配 |
| `hot_fuzzy` | **内容**检索，**中文错字容错**。`mode=fuzzy`（默认）/`literal`/`regex`，多词默认 AND、`any=true` 为 OR | 常驻行索引（自研） |
| `hot_grep` | 精确字面 / 正则内容检索 | FFF 原生（要求可用） |
| `hot_plan` | 把命中按文件聚合，输出 命中数/体积/最佳相似度/命中行号，用来决定先读哪几篇、分几批 | 常驻行索引 |
| `hot_stats` | 索引规模、构建耗时、陈旧程度、FFF 是否可用及降级原因 | — |

**怎么选**：记得个大概词 → `hot_fuzzy`；记得文件名 → `hot_find`；记得原话要跑正则 → `hot_grep`；要批量读一堆文件 → `hot_plan`。

## 实测数据

本机横截面（一个 198 篇笔记的 Obsidian 库，Windows / Node 24.21 / 独立 workspace），`mode=fuzzy` 每次 8 轮取平均：

| 项目 | 实测 |
| --- | --- |
| 索引规模 | 198 文件 / 4485 行 / 278 KB |
| 索引构建 | 31–36 ms（常驻，进程内只建一次） |
| `hot_fuzzy` 中文错字 `自动同部` | **0.80 ms**（命中 `自动同步`） |
| `hot_fuzzy` literal `同步` | 1.03 ms（15 条） |
| `hot_fuzzy` regex `^#{1,3} ` | 0.48 ms（50 条） |
| `hot_grep` plain `同步` | 1.93 ms（15 条） |
| `hot_find` `obsidain` | 2.36 ms（3 条） |

自测（9 项断言，不进宿主）：

```powershell
node dsh-hot-search\dev\hot-search-smoke.mjs
```

## 权限与隐私

- **读**：只读 `roots` 下的、匹配 `extensions` 的文本文件，用于建内存索引。不传任何内容给网络。
- **写**：只写自己的运行时状态（frecency、FFF 的 history 库），位置 = `stateDir`，默认 `$DSH_HOME/hot-search/<根目录名>-<路径哈希>`。**不会写进你被索引的仓库**，所以不会脏你的 `git status`。
- **网络**：插件本身零网络请求。
- **原生依赖**：`hot_find`/`hot_grep` 依赖 Rust 原生库 `@ff-labs/fff-node`（含平台二进制）。加载失败时**不会崩**：`hot_find` 自动降级为内置子序列匹配，`hot_grep` 明确报错并指路 `hot_fuzzy`；`hot_fuzzy`/`hot_plan`/`hot_stats` 完全不依赖它。`hot_stats` 会显示降级原因。
- **平台**：在 Windows x64 上实测。非 win-x64 平台需要 `@ff-labs/fff-node` 对应的平台二进制包；拿不到就走上面的降级路径。

## 环境要求

- Node `>=22`
- DSH `>=0.2.0-rc.1 <0.3.0`（在 `0.2.0-rc.2` 上实测）

## 开发

```powershell
pnpm install
node dev\hot-search-smoke.mjs        # 算法内核 + 9 项断言
node dev\hot-search-fff-check.mjs    # FFF 原生层 vs 降级层对照
```

> ⚠️ `pnpm` 默认的 isolated 布局下，`@ff-labs/fff-node` 的嵌套依赖（`ffi-rs` 及其平台二进制）是 pnpm 的 junction，Node 的 ESM 加载器在这里跟不过去，`hot_find` 会静默降级到内置引擎。**要用 FFF 原生引擎，请用 hoisted 布局**（DSH profile 本身就是 `nodeLinker: hoisted`，npm 也是）：
>
> ```powershell
> pnpm install --node-linker=hoisted
> ```
>
> 另外插件对 `@ff-labs/fff-bin-<platform>` 与 `ffi-rs` 各显式声明了一次，正是为了让这几个包在顶层可见——README 前半段的降级路径保证它们拿不到时功能不丢。

## License

MIT © KitaKitaCirillasz
