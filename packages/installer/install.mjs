#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { realEffects } from './lib/effects.mjs';
import { installerFailure } from './lib/diagnostics.mjs';
import { runWorkspaceSetup } from './lib/workspace-setup.mjs';
import { runSetup } from './lib/setup.mjs';
import { closeSync, makeWriter, openTty } from './lib/ui.mjs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const ttyFd = openTty();

try {
  const args=process.argv.slice(2);
  const workspace=args.some(v=>v==='--setup-workspace' || v.startsWith('--setup-workspace=') || v==='--setup-workspace-file' || v.startsWith('--setup-workspace-file='));
  const execute=workspace ? (args,effects)=>runWorkspaceSetup(args,effects,runSetup) : runSetup;
  const code = await execute(args, realEffects({
    write: makeWriter(ttyFd),
    ttyFd,
    env: process.env,
    version,
  }));
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`ours-install: ${installerFailure(error)}\n`);
  process.exitCode = 1;
} finally {
  if (ttyFd != null) {
    try { closeSync(ttyFd); } catch { /* already closed */ }
  }
}
