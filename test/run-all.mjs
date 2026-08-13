import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = (await readdir(dir)).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n== ${f}`);
  const t0 = Date.now();
  try {
    await import(pathToFileURL(join(dir, f)).href);
    console.log(`   (${Date.now() - t0}ms)`);
  } catch (err) {
    failed++;
    console.error(`FAILED ${f}:`, err.message);
  }
}
if (failed) { console.error(`\n${failed} test file(s) FAILED`); process.exit(1); }
console.log('\nALL TEST FILES PASSED');
