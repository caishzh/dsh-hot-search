// hot-search-selftest.mjs — 自包含自测：在临时目录里造一份固定语料，跑完即删。
//
// 与 dev/hot-search-smoke.mjs 的分工：
//   · hot-search-smoke.mjs 是「本机基准」——索引真实的笔记库（硬编码 D:\ObsidianNotes），
//     只为看耗时和真实命中，**只能在有那个库的机器上跑**，不适合当 CI 门禁。
//   · 本文件是「CI 门禁」——语料与期望值都写死，任何机器、任何平台结果一致，
//     不读本机任何路径，也不需要 node_modules（只 import 纯 Node 内置模块的 line-index）。
//
// 只查正确性，不报耗时（CI 机器性能无参考价值）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// 固定语料。含「同步」的行恰好 4 行（下面 literal 断言钉死这个数）：
//   个人数据/我的Obsidian配置.md -> 2 行（自动同步 / 同步 状态）
//   个人数据/S3备份.md           -> 1 行（同步 归档到 S3）
//   Template/日记模板.md         -> 1 行（同步 提示）
const FIXTURES = {
  '个人数据/我的Obsidian配置.md': [
    '# 我的 Obsidian 配置',
    '',
    '自动同步 开关说明。',
    '同步 状态：已开启。',
    'S3 备份说明。',
  ].join('\n'),
  '个人数据/S3备份.md': ['同步 归档到 S3。', 'S3 存储桶：notes。'].join('\n'),
  'Template/日记模板.md': ['## 标题', '### 小节', '同步 提示。'].join('\n'),
  'notes/plain.txt': ['obsidian', 'nothing to see here'].join('\n'),
};

const EXPECTED_LITERAL_LINES = 4;

const root = mkdtempSync(join(tmpdir(), 'dsh-hot-search-selftest-'));
let ok = true;
try {
  for (const [rel, body] of Object.entries(FIXTURES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${body}\n`, 'utf8');
  }

  const index = new RootIndex({ path: root, label: 'selftest' }, cfg);
  await index.build();
  console.log(`语料: ${root}`);
  console.log(`索引: files=${index.files.length} lines=${index.lines.length} bytes=${index.bytes}`);

  const q = (label, patterns, opts) => {
    const res = searchIndex(index, patterns, opts);
    console.log(`  ${label} -> total=${res.total} mode=${res.mode}`);
    return res;
  };

  const fuzzyCJK = q('fuzzy 自动同部（CJK 1 错字 → 应命中 自动同步）', ['自动同部'], { mode: 'fuzzy', folder: '个人数据' });
  const shortToken = q('fuzzy 同部（2 字 → 只精确，期望 0）', ['同部'], { mode: 'fuzzy', folder: '个人数据' });
  const short3Exact = q('fuzzy 同步部（3 字 → len//4=0，只精确，期望 0）', ['同步部'], { mode: 'fuzzy', folder: '个人数据' });
  cfg.fuzzyMaxErrors = 1;
  const short3Forced = q('fuzzy 同步部 + fuzzyMaxErrors=1（显式放开 → 应命中）', ['同步部'], { mode: 'fuzzy', folder: '个人数据' });
  cfg.fuzzyMaxErrors = 0;
  const literal = q('literal 同步', ['同步'], { mode: 'literal' });
  const mixed = q('literal AND 同步+S3', ['同步', 'S3'], { mode: 'literal' });
  const anyOr = q('literal OR 同步|S3', ['同步', 'S3'], { mode: 'literal', any: true });
  const latin = q('fuzzy obsidain（拉丁错字）', ['obsidain'], { mode: 'fuzzy' });
  const regex = q('regex ^#{1,3} 限 Template', ['^#{1,3} '], { mode: 'regex', folder: 'Template' });
  const plan = planFromHits(literal.hits, index);
  console.log(`  plan -> ${plan.length} 个文件`);

  const checks = [
    ['语料 4 个文件都进了索引', index.files.length === 4],
    ['CJK 错字命中：含「自动同步」的行，score > 0.8', fuzzyCJK.hits.some((h) => h.text.includes('自动同步') && h.score > 0.8)],
    ['短词默认不容错（2 字 同部 → 0 命中）', shortToken.total === 0],
    ['3 字词默认也不容错（同步部 → 0 命中）', short3Exact.total === 0],
    ['显式 fuzzyMaxErrors=1 能放开短词（同步部 → 有命中）', short3Forced.total > 0],
    [`literal 同步 = ${EXPECTED_LITERAL_LINES} 行`, literal.total === EXPECTED_LITERAL_LINES],
    ['多词 AND 收窄', mixed.total > 0 && mixed.total < literal.total],
    ['OR 放宽', anyOr.total > literal.total],
    ['拉丁错字 obsidain 有命中', latin.total >= 1],
    ['regex 在 Template 下命中 ≥ 2 行', regex.total >= 2],
    ['plan 聚合非空', plan.length >= 1],
  ];

  console.log('\n--- 断言 ---');
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
