import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), extra = [], env = { ...process.env };
let report = join(here, '../../reports', `layouts-${Date.now()}`), dry = false;
for (let n = 0; n < args.length; n++) {
  const key = args[n];
  if (key === '--dry-run') { dry = true; extra.push(key); }
  else if (['--fleet', '--cowork', '--codex', '--report-dir', '--scratch-dir'].includes(key)) {
    if (!args[n + 1]) throw Error(`value required: ${key}`);
    const value = resolve(args[++n]);
    if (key === '--report-dir') report = value;
    else if (key === '--scratch-dir') env.OURS_LAYOUT_SCRATCH_DIR = value;
    else env[`OURS_LAYOUT_${key.slice(2).toUpperCase()}_DIR`] = value;
  } else if (['--tags', '--name'].includes(key)) { extra.push(key, args[++n]); }
  else throw Error(`unknown option: ${key}`);
}
if (!dry) for (const key of ['FLEET','COWORK','CODEX']) if (!env[`OURS_LAYOUT_${key}_DIR`]) throw Error(`--${key.toLowerCase()} is required; no production-path fallback`);
mkdirSync(report, { recursive: true }); env.OURS_LAYOUT_REPORT_DIR = report;
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@cucumber/cucumber')), '../bin/cucumber.js');
const child = spawnSync(process.execPath, [cli, '--import', join(here, 'steps.mjs'),
  '--format', 'progress', ...['--format', `html:${join(report, 'layouts.html')}`, '--format', `junit:${join(report, 'layouts.xml')}`, '--format', `message:${join(report, 'layouts.ndjson')}`],
  join(here, 'features/*.feature'), ...extra], { env, stdio: 'inherit', cwd: here });
if (child.error) throw child.error;
if (child.status === 0 && !/<testcase[\s>]/.test(readFileSync(join(report, 'layouts.xml'), 'utf8'))) throw Error('No selected scenarios');
console.log(`Layout reports: ${report}`); process.exit(child.status ?? 1);
