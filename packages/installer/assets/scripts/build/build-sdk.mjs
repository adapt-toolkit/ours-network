import { join } from 'node:path';
import { SOURCE_ROOT, SELECTED, pack, run } from './build-common.mjs';
const source = join(SOURCE_ROOT, 'sdk');
run(['npm', 'ci', '--no-audit', '--no-fund'], source);
run(['bash', 'scripts/compile-mufl.sh'], source);
run(['npm', 'run', 'build'], source);
if (SELECTED.has('@ours.network/cli')) run(['npm', 'run', 'build:cli'], source);
pack(source, '@ours.network/sdk', 'sdk');
pack(join(source, 'packages/cli'), '@ours.network/cli', 'sdk');
