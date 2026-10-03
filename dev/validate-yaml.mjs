// validate-yaml.mjs <file> — 用本目录的 js-yaml 校验 YAML 文件，打印条目概要。
// 用途：改 profile 的 cordis.patch.yml 前先验证，避免把组合配置写坏导致启动失败。
import { readFileSync } from "node:fs";

const mod = await import("js-yaml");
const yaml = mod.default ?? mod;

try {
  const doc = yaml.load(readFileSync(process.argv[2], "utf8"));
  if (Array.isArray(doc)) {
    console.log(`YAML_OK entries=${doc.length}`);
    doc.slice(0, 40).forEach((e, i) => {
      const id = e && e.id ? e.id : e && e.insert ? `insert(${e.insert.length})` : "?";
      const cfg = e && e.config ? ` config=${JSON.stringify(e.config).slice(0, 140)}` : "";
      console.log(`  [${i}] ${id}${cfg}`);
    });
  } else {
    console.log(`YAML_OK but not an array: ${typeof doc}`);
  }
  process.exit(0);
} catch (e) {
  console.log(`YAML_ERROR ${e.message}`);
  process.exit(1);
}
