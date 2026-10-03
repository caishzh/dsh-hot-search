// hot-search-fff-check.mjs — 验证插件的 FFF 层（真原生）与降级层（原生不可用时）。
import { RootIndex } from '../src/line-index.mjs';
import { HotFinder } from '../src/finder.mjs';

const cfg = {
  extensions: ['.md', '.txt'],
  excludeDirs: ['.obsidian', '.trash', '.git', 'node_modules', '.dsh-tools', '.dsh'],
  maxFileSize: 2 * 1024 * 1024,
  maxIndexedBytes: 64 * 1024 * 1024,
  refreshIntervalMs: 0,
  fuzzyMaxErrors: 0,
  maxResults: 50,
  watch: false,
  stateDir: 'D:\\dsh-plugins\\dsh-hot-search\\dev\\.state',
};
const rootCfg = { path: 'D:\\ObsidianNotes', label: 'main' };

const index = new RootIndex(rootCfg, cfg);
await index.build();
const finder = new HotFinder({ rootCfg, cfg, lineIndex: index });
await finder.init();
console.log('engine info:', JSON.stringify(finder.info()));

function time(label, fn, runs = 5) {
  let last;
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const s = process.hrtime.bigint();
    last = fn();
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const n = Array.isArray(last.items) ? last.items.length : (last.total ?? '?');
  console.log(`${label}: avg ${avg.toFixed(2)} ms -> ${n} 条 (engine=${last.engine ?? 'fff'})`);
  for (const it of (last.items || []).slice(0, 3)) {
    console.log(`     ${it.path}${it.line ? `:${it.line}` : ''}  ${String(it.text || '').slice(0, 60)}`);
  }
  return last;
}

console.log('\n--- FFF 原生层 ---');
time('find("obsidain")  [拉丁错字]', () => finder.find('obsidain'));
time('find("配置")       [中文文件名]', () => finder.find('配置'));
time('find("数据同步")   [中文文件名]', () => finder.find('数据同步'));
time('grep("同步", plain)', () => finder.grep('同步', { mode: 'plain' }));
time('grep("Obsidian", regex)', () => finder.grep('Obsidian', { mode: 'regex' }));

console.log('\n--- 降级层（销毁原生 finder 后，模拟原生不可用）---');
finder.dispose();
time('find("obsidain")  [内置子序列]', () => finder.find('obsidain'));
time('find("配置")       [内置子序列]', () => finder.find('配置'));
try {
  finder.grep('同步', { mode: 'plain' });
  console.log('grep: 未按预期抛错（应提示改用 hot_fuzzy）');
} catch (e) {
  console.log(`grep 正确拒绝并给出替代：${e.message.slice(0, 60)}...`);
}
console.log('\nfrecency 记录数:', finder.frecency.size);
