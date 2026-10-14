import { join } from 'node:path';
import { SOURCE_ROOT, SELECTED, pack, run } from './build-common.mjs';
const source = join(SOURCE_ROOT, 'sdk');
run(['npm', 'ci', '--no-audit', '--no-fund'], source);
if (SELECTED.has('@ours.network/daemon')) run(['bash', 'scripts/compile-mufl.sh'], source);
run(['npm', 'run', 'build'], source);
if (SELECTED.has('@ours.network/cli')) run(['npm', 'run', 'build:cli'], source);
pack(source, '@ours.network/sdk', 'sdk');
pack(join(source, 'packages/cli'), '@ours.network/cli', 'sdk');

if (SELECTED.has('@ours.network/daemon')) {
  run(['npm', 'run', 'build:daemon'], source);
  pack(join(source, 'packages/daemon'), '@ours.network/daemon', 'sdk');
}
