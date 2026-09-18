import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, multiselect, isCancel } from '../lib/prompt.mjs';

const choices = [{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }];
function terminal(keys) {
  const bytes = [...Buffer.from(keys)];
  const state = { output: '', restored: 0 };
  return {
    state, write: text => { state.output += text; },
    controls: { read: () => bytes.shift() ?? null, enterRaw: () => () => { state.restored++; } },
  };
}
function interactive(run) {
  const previous = process.env.OURS_ASSUME_YES;
  delete process.env.OURS_ASSUME_YES;
  try { run(); } finally {
    if (previous === undefined) delete process.env.OURS_ASSUME_YES;
    else process.env.OURS_ASSUME_YES = previous;
  }
}

test('single choice uses arrow keys and Enter; typed names and numbers cannot select', () => interactive(() => {
  const tty = terminal('first1\x1b[B\r');
  assert.equal(select(tty.write, 1, 'Choose', choices, 'first', tty.controls), 'second');
  assert.equal(tty.state.restored, 1);
  assert.ok(tty.state.output.endsWith('\x1b[?25h'));
  const wrap = terminal('\x1b[A\r');
  assert.equal(select(wrap.write, 1, 'Choose', choices, 'first', wrap.controls), 'second');
}));

test('multiselect toggles defaults with Space and returns values in display order', () => interactive(() => {
  const tty = terminal(' \x1b[B \r');
  assert.deepEqual(multiselect(tty.write, 1, 'Choose', choices, ['first'], tty.controls), ['second']);
  assert.equal(tty.state.restored, 1);
  assert.ok(tty.state.output.endsWith('\x1b[?25h'));
}));

for (const [name, keys] of [['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['EOF', ''], ['truncated arrow', '\x1b[']]) {
  test(`${name} cancels both choice modes and restores terminal and cursor`, () => interactive(() => {
    for (const prompt of [select, multiselect]) {
      const tty = terminal(keys);
      assert.throws(() => prompt(tty.write, 1, 'Choose', choices,
        prompt === select ? 'first' : ['first'], tty.controls), isCancel);
      assert.equal(tty.state.restored, 1);
      assert.ok(tty.state.output.endsWith('\x1b[?25h'));
    }
  }));
}

test('reader exceptions still restore terminal and cursor', () => interactive(() => {
  const tty = terminal('');
  tty.controls.read = () => { throw new Error('read failed'); };
  assert.throws(() => select(tty.write, 1, 'Choose', choices, 'first', tty.controls), /read failed/);
  assert.equal(tty.state.restored, 1);
  assert.ok(tty.state.output.endsWith('\x1b[?25h'));
}));
