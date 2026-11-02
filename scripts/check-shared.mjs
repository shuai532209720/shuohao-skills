#!/usr/bin/env node
// 几个 skill 各带一份的同名文件必须完全相同（skill 要能单独拷走，不能互相 import，只能各放一份）。
//   node scripts/check-shared.mjs        有不一致就 exit 1
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = {
  'gpu-lease.mjs': ['skills/character-refs/scripts/gpu-lease.mjs', 'skills/novel-storyboard/scripts/gpu-lease.mjs'],
};

let bad = 0;
for (const [name, copies] of Object.entries(SHARED)) {
  const texts = copies.map((p) => readFileSync(join(root, p), 'utf8'));
  const same = texts.every((t) => t === texts[0]);
  console.log(`${same ? '✓' : '✗'} ${name}：${copies.join(' = ')}`);
  if (!same) bad++;
}
if (bad) {
  console.error(`✗ ${bad} 个共用文件不一致——改了一份就把另一份同步成一样`);
  process.exit(1);
}
