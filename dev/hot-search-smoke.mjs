// hot-search-smoke.mjs — 不进宿主，直接验证行索引内核的正确性与速度。
// 关键对照：中文错字必须命中（FFF 做不到），短词默认不容错（避免噪声）。
//
// ⚠️ 这是「本机基准脚本」，**不是 CI 门禁**：下面硬编码了本机的笔记库
//    D:\ObsidianNotes，换台机器（或 CI 的 Ubuntu）就没有这个库，索引 0 文件、
//    断言会全挂。要跑 CI 门禁请用 dev/hot-search-selftest.mjs（自包含语料，任何机器结果一致）。
import { RootIndex, searchIndex, planFromHits } from '../src/line-index.mjs';

const cfg = {
  extensions: ['.md', '.txt'],
  excludeDirs: ['.obsidian', '.trash', '.git', 'node_modules', '.dsh-tools', '.dsh'],
  maxFileSize: 2 * 1024 * 1024,
  maxIndexedBytes: 64 * 1024 * 1024,
  refreshIntervalMs: 0,
  fuzzyMaxErrors: 0,
  maxResults: 50,
};

const t0 = Date.now();
const index = new RootIndex({ path: 'D:\\ObsidianNotes', label: 'main' }, cfg);
await index.build();
console.log(`build: ${Date.now() - t0} ms  files=${index.files.length} lines=${index.lines.length} bytes=${index.bytes} skipped=${index.skippedSize}`);

function run(label, patterns, opts = {}, runs = 5) {
  let res;
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const s = process.hrtime.bigint();
    res = searchIndex(index, patterns, opts);
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\n${label}: ${avg.toFixed(2)} ms avg  total=${res.total} mode=${res.mode}`);
  for (const h of res.hits.slice(0, 3)) {
    console.log(`   ${h.path}:${h.line}  score=${h.score}  ${h.text.slice(0, 70)}`);
  }
  return res;
}

const fuzzyCJK = run('fuzzy "自动同部" (CJK 1 typo -> should hit 自动同步)', ['自动同部'], { mode: 'fuzzy', folder: '个人数据' });
const shortToken = run('fuzzy "同部" (2 chars -> exact only, expect 0)', ['同部'], { mode: 'fuzzy', folder: '个人数据' });
cfg.fuzzyMaxErrors = 1;
const forced = run('fuzzy "同部" with minErrors=1 (opt-in noise)', ['同部'], { mode: 'fuzzy', folder: '个人数据' });
cfg.fuzzyMaxErrors = 0;
const literal = run('literal "同步" (expect 15 hits)', ['同步'], { mode: 'literal' });
const mixed = run('literal AND "同步 S3"', ['同步', 'S3'], { mode: 'literal' });
const anyOr = run('literal OR "同步 S3" (any)', ['同步', 'S3'], { mode: 'literal', any: true });
const latin = run('fuzzy "obsidain" (latin typo)', ['obsidain'], { mode: 'fuzzy' });
const regex = run('regex "^#{1,3} " folder=Template', ['^#{1,3} '], { mode: 'regex', folder: 'Template' });
const plan = planFromHits(literal.hits, index);
console.log(`\nplan: ${plan.length} files`);
for (const r of plan.slice(0, 5)) console.log(`   hits=${r.hits} bytes=${r.bytes} best=${r.best} ${r.path} [${r.lines.join(',')}]`);

console.log('\n--- 断言 ---');
const checks = [
  ['CJK 错字命中 自动同步（命中 我的Obsidian配置.md 且分数 >0.8）', fuzzyCJK.hits.some((h) => h.path.includes('我的Obsidian配置') && h.score > 0.8)],
  ['短词默认不容错（0 命中）', shortToken.total === 0],
  ['显式 minErrors=1 能放开短词', forced.total > 0],
  ['literal 同步 = 15 命中', literal.total === 15],
  ['多词 AND 收窄', mixed.total <= literal.total],
  ['OR 放宽', anyOr.total >= literal.total],
  ['拉丁错字有命中', latin.total >= 1],
  ['正则可用', regex.total >= 1],
  ['plan 聚合非空', plan.length >= 1],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
