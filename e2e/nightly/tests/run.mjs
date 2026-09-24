import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!['smoke', 'flows', 'telegram', 'rooms-agents', 'regressions-fleet', 'regressions-client', 'regressions-telegram', 'regressions-component', 'security', 'recovery'].includes(name)) {
  console.error('Usage: node /opt/ours/tests/run.mjs smoke|flows|telegram|rooms-agents|regressions-fleet|regressions-client|regressions-telegram|regressions-component [cucumber options]');
  process.exit(2);
}
const cli = '/opt/ours/node_modules/.bin/cucumber-js';
const sourceName = name === 'regressions-fleet' ? 'rooms-agents' : name;
const component = name === 'regressions-component';
const stepFile = component
  ? '/opt/ours/tests/component/regressions.mjs'
  : `/opt/ours/tests/steps/${sourceName}.mjs`;
const featureFile = component
  ? '/opt/ours/tests/component/regressions.feature'
  : `/opt/ours/tests/features/${name}.feature`;
const rawOptions = process.argv.slice(3);
const includeDeferred = rawOptions.includes('--include-deferred');
const options = rawOptions.filter(option => option !== '--include-deferred');
const dryRun = options.includes('--dry-run') || options.includes('-d');
const reportDir = process.env.OURS_E2E_REPORT_DIR ?? '/opt/ours/reports';
const reportLabel = `${name}-${process.env.CLIENT_TARGET ?? 'connector'}`.replace(/[^a-zA-Z0-9-]/g, '_');
if (!dryRun) mkdirSync(reportDir, { recursive: true });
const result = spawnSync(cli, [
  '--import', '/opt/ours/tests/steps/common.mjs',
  '--import', stepFile,
  '--format', 'progress',
  ...(!dryRun ? [
    '--format', `html:${join(reportDir, `${reportLabel}.html`)}`,
    '--format', `message:${join(reportDir, `${reportLabel}.ndjson`)}`,
    '--format', `junit:${join(reportDir, `${reportLabel}.xml`)}`,
  ] : []),
  ...(!includeDeferred ? ['--tags', 'not @todo and not @withdrawn'] : []),
  featureFile + (process.env.OURS_E2E_CASE_LINE ? `:${process.env.OURS_E2E_CASE_LINE}` : ''),
  ...options,
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (!dryRun) console.log(`Cucumber reports: ${reportDir}/${reportLabel}.{html,ndjson,xml}`);
if (!dryRun && result.status === 0 && !/<testcase[\s>]/.test(readFileSync(join(reportDir, `${reportLabel}.xml`), 'utf8'))) {
  console.error('No active scenarios selected. TODO/withdrawn checks require explicit --include-deferred.');
  process.exit(1);
}
process.exit(result.status ?? 1);
