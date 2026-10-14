import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { askSecret } from '../lib/prompt.mjs';

test('secret prompt fails closed when terminal echo cannot be disabled', () => {
  const fd = openSync('/dev/null', 'r+');
  let shown = '';
  try {
    const result = askSecret((s) => { shown += s; }, fd, 'Hidden key: ');
    assert.equal(result, null, 'does not fall back to an echoing cooked read');
    assert.match(shown, /Hidden key/);
  } finally {
    closeSync(fd);
  }
});
