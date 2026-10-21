// UI toolkit contracts for the installer's look: everything must stay curl|bash-safe and degrade
// under NO_COLOR / no-tty. Each case renders in a SUBPROCESS so the module-load-time color
// detection sees the intended environment (COLOR is decided once, on import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(dirname(HERE), 'lib', 'ui.mjs');

// Render `expr` (with the ui module bound as `ui`) in a child node and return its stdout.
function render(expr, env = {}) {
  return execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import * as ui from ${JSON.stringify('file://' + UI)}; const v = await (${expr}); process.stdout.write(String(v));`,
  ], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('banner: big logo, plain under NO_COLOR, never wraps at 80 columns', () => {
  const plain = render('ui.banner()', { NO_COLOR: '1' });
  assert.match(plain, /██/, 'has the block-letter logo');
  assert.match(plain, /ours\.network/, 'carries the wordmark');
  assert.doesNotMatch(plain, /\x1b\[/, 'NO_COLOR output has zero escape codes');
  for (const l of plain.split('\n')) assert.ok(l.length < 80, `line fits in 80 cols: ${JSON.stringify(l)}`);
  const colored = render('ui.banner()', { NO_COLOR: '', OURS_FORCE_COLOR: '1' });
  assert.match(colored, /\x1b\[38;5;\d+m/, 'colored banner uses the gradient ramp');
});

test('box: width-honest — every row is the same visible width under NO_COLOR', () => {
  const plain = render(`ui.box(['short', '', 'a much longer content line here'], 'next steps')`, { NO_COLOR: '1' });
  const rows = plain.split('\n');
  const widths = new Set(rows.map((l) => l.length));
  assert.equal(widths.size, 1, `all rows equal width, got ${[...widths].join(',')}`);
  assert.match(rows[0], /┌─ next steps ─+┐/, 'titled top border');
  assert.doesNotMatch(plain, /\x1b\[/, 'NO_COLOR box is plain');
});

test('section: numbered rule header, plain under NO_COLOR', () => {
  const plain = render(`ui.section(3, 'broker address')`, { NO_COLOR: '1' });
  assert.match(plain, /── 3 · broker address ─+/, 'rule-style header');
  assert.doesNotMatch(plain, /\x1b\[/, 'NO_COLOR section is plain');
});

test('progress: stable bar, percentage, label, and explanation stay log-friendly', () => {
  const plain = render(`ui.progress(3, 8, 'Prepare daemon', 'Install and start one shared daemon.')`, { NO_COLOR: '1' });
  assert.match(plain, /38%\s+Prepare daemon/);
  assert.match(plain, /Install and start one shared daemon\./);
  assert.match(plain, /█+·+/);
  assert.doesNotMatch(plain, /\x1b\[/);
  for (const line of plain.split('\n')) assert.ok(line.length < 80, `line fits in 80 cols: ${JSON.stringify(line)}`);
});

test('withSpinner: returns the thunk result and degrades to a static step line without a tty', () => {
  const out = render(`ui.withSpinner('working…', async () => { return 'RESULT'; })`, { NO_COLOR: '1' });
  assert.match(out, /working…/, 'label still shown without a tty');
  assert.match(out, /RESULT$/, 'thunk result is returned');
  assert.doesNotMatch(out, /\x1b\[/, 'no escape codes when not animating');
});
