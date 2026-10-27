import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const test of ['test-blank-analytics.mjs','test-blank-storage.mjs','test-pwa-manifest.mjs','test-pwa-worker.mjs']) {
  const run = spawnSync(process.execPath,[test],{cwd,stdio:'inherit'});
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
