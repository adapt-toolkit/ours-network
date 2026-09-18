import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askLine, askSecret, isCancel } from '../lib/prompt.mjs';

function promptWith(prompt, input, def = 'default') {
  const bytes = [...(typeof input === 'string' ? Buffer.from(input) : input)];
  const state = { shown: '', restored: 0 };
  const previous = process.env.OURS_ASSUME_YES;
  delete process.env.OURS_ASSUME_YES;
  try {
    state.result = prompt(text => { state.shown += text; }, 1, 'Input: ', def, {
      read: () => bytes.shift() ?? null,
      enterRaw: () => () => { state.restored++; },
    });
  } catch (error) { state.error = error; }
  finally {
    if (previous === undefined) delete process.env.OURS_ASSUME_YES;
    else process.env.OURS_ASSUME_YES = previous;
  }
  assert.equal(state.restored, 1);
  return state;
}

for (const value of ['Александр', '/home/Иван/Мои проекты', 'a😀б']) {
  test(`text input decodes UTF-8 bytes individually: ${value}`, () => {
    const state = promptWith(askLine, value + '\r');
    assert.equal(state.error, undefined);
    assert.equal(state.result, value);
    assert.equal(state.shown, `Input: ${value}\n`);
  });
}

test('backspace removes a whole Unicode code point, including astral characters', () => {
  const state = promptWith(askLine, 'Иван😀\x7fа\x08\r');
  assert.equal(state.result, 'Иван');
  assert.equal(state.shown, 'Input: Иван😀\b \bа\b \b\n');
});

test('backspace discards an incomplete code point without erasing completed text', () => {
  const state = promptWith(askLine, [...Buffer.from('Иван'), 0xd0, 0x7f, ...Buffer.from('а\r')]);
  assert.equal(state.result, 'Ивана');
  assert.equal(state.shown, 'Input: Ивана\n');
});

test('secret input preserves UTF-8 and code point backspace without echoing characters', () => {
  const state = promptWith(askSecret, 'ключ😀\x7f\r');
  assert.equal(state.result, 'ключ');
  assert.equal(state.shown, 'Input: \n');
});

for (const [name, input] of [
  ['EOF', []], ['Ctrl+D', [4]], ['Ctrl+C', [3]],
  ['EOF after text', Buffer.from('Иван')],
  ['malformed UTF-8', [0xc3, 0x28]], ['incomplete UTF-8 before Enter', [0xd0, 13]],
]) {
  for (const prompt of [askLine, askSecret]) {
    test(`${prompt.name} cancels on ${name} and restores raw mode`, () => {
      const state = promptWith(prompt, input);
      assert.ok(isCancel(state.error));
      assert.equal(state.result, undefined);
    });
  }
}

test('only explicit Enter accepts the empty default', () => {
  assert.equal(promptWith(askLine, '\r').result, 'default');
  assert.equal(promptWith(askSecret, '\r').result, 'default');
});
