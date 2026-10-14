import { join } from 'node:path';
import { SOURCE_ROOT, SELECTED, pack, run } from './build-common.mjs';
const source = join(SOURCE_ROOT, 'mcp');
run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
for (const [directory, name] of [['core', 'mcp'], ['codex', 'codex'], ['claude-code', 'claude-code'], ['installer', 'install']]) {
  if (!SELECTED.has('@ours.network/' + name)) continue;
  if (name !== 'install') run(['npm', 'run', 'build', '--workspace', '@ours.network/' + name], source);
  pack(join(source, 'packages', directory), '@ours.network/' + name, 'mcp');
}
