import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The curl|bash entry points run their Node check with the real `node` found on PATH.
const scripts = ['../install.sh', '../../../install.sh'].map(path => fileURLToPath(new URL(path, import.meta.url)));
function run(t, script, version) {
  const dir = mkdtempSync(join(tmpdir(), 'ours-install-sh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `node` reports the requested version; `npm` and the installer must never run on refusal.
  writeFileSync(join(dir, 'version.cjs'), `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`);
  writeFileSync(join(dir, 'node'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(join(dir, 'version.cjs'))} "$@"\n`);
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\ntouch ${JSON.stringify(join(dir, 'npm-ran'))}\nexit 1\n`);
  for (const name of ['node', 'npm']) chmodSync(join(dir, name), 0o700);
  const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, OURS_INSTALLER_MJS: join(dir, 'missing.mjs') }, input: '' });
  return { ...result, npmRan: existsSync(join(dir, 'npm-ran')) };
}
for (const script of scripts) for (const version of ['22.23.2', '24.22.0', '26.12.0', '20.20.2', '27.0.0-pre']) {
  test(`${script.includes('packages') ? 'package' : 'root'} install.sh refuses Node.js ${version} before npm`, t => {
    const result = run(t, script, version);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Node.js ${version} is not permitted`), result.stderr);
    assert.ok(result.stderr.includes('https://nodejs.org/en/blog/vulnerability/october-2026-security-releases'));
    assert.equal(result.npmRan, false);
  });
}
for (const script of scripts) test(`${script.includes('packages') ? 'package' : 'root'} install.sh passes the Node check on a patched release`, t => {
  const result = run(t, script, '22.23.4');
  assert.doesNotMatch(result.stderr, /is not permitted/);
});
