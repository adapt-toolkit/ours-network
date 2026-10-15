import assert from 'node:assert/strict';
import { Given, When, Then, setDefaultTimeout } from '@cucumber/cucumber';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
setDefaultTimeout(360_000);
const here = dirname(fileURLToPath(import.meta.url));
Given('the public room layout CLI uses {string} participants', function (mode) {
  assert(['fresh', 'shared'].includes(mode)); this.mode = mode;
});
When('the YAML layout runs through native Fleet commands', async function () {
  const parent = mkdtempSync(join(realpathSync(process.platform === 'darwin' ? '/private/tmp' : tmpdir()), 'lc-'));
  this.root = join(parent, 'r');
  this.log = join(process.env.OURS_LAYOUT_REPORT_DIR, `native-${this.mode}-${Date.now()}.log`);
  const output = createWriteStream(this.log, { mode: 0o600 });
  const child = spawn(process.execPath, [join(here, 'fixture.mjs'), process.env.OURS_LAYOUT_COWORK_DIR, this.root, process.env.OURS_LAYOUT_CODEX_DIR], {
    cwd: process.env.OURS_LAYOUT_FLEET_DIR, env: { ...process.env, OURS_LAYOUT_TEST_MODE: this.mode, OURS_LAYOUT_NATIVE_CLI: '1' }, stdio: ['ignore','pipe','pipe'],
  });
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise(r => output.end(r));
  assert.equal(code, 0, readFileSync(this.log, 'utf8').slice(-8000));
  this.evidence = JSON.parse(readFileSync(join(this.root, 'summary.json'), 'utf8'));
  assert(this.evidence.native?.cli); await this.attach(JSON.stringify(this.evidence, null, 2), 'application/json');
});
Then('native CLI assignments use {int} distinct planned sessions', function (count) { assert.equal(this.evidence.native.distinctSessions, count); });
Then('native successor prompts have {string} earlier room context', function (history) { assert.equal(this.evidence.native.contextRetained, history === 'retained'); });
Then('the native layout preserves its YAML snapshot', function () { assert(this.evidence.native.yaml); assert(this.evidence.native.configSnapshotPreserved); });
Then('closing the native layout archives rooms and preserves borrowed agents', function () { assert(this.evidence.native.closed); assert(this.evidence.native.archivesRetained); if (this.mode === 'shared') assert(this.evidence.native.borrowedSurvived); });

Then('closing overlapping rooms keeps their agents alive until layout cleanup', function () { assert(this.evidence.native.overlappingConsultations); });

Then('native 3-Amigos consultations admit three distinct participants with product, developer and QA roles', function () { assert.equal(this.evidence.native.amigos.length, 2); for (const room of this.evidence.native.amigos) { assert.equal(room.activeParticipants, 3); assert.deepEqual(room.roles, ['developer', 'product', 'qa']); } });

Then('native reopening detects external closure and cleanup tolerates a stopped participant', function () { assert(this.evidence.native.nativeDriftRejected); assert(this.evidence.native.stoppedParticipantCleanup); });
