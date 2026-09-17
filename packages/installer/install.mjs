#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { realEffects } from './lib/effects.mjs';
import { runInstall } from './lib/orchestrate.mjs';
import { closeSync, makeWriter, openTty } from './lib/ui.mjs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const ttyFd = openTty();

try {
  const code = await runInstall(process.argv.slice(2), realEffects({
    write: makeWriter(ttyFd),
    ttyFd,
    env: process.env,
    version,
  }));
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`ours-install: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (ttyFd != null) {
    try { closeSync(ttyFd); } catch { /* already closed */ }
  }
}
