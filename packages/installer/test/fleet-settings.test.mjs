import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFleetSettings } from '../lib/fleet-settings.mjs';

function fixture() {
  const model = { harness: 'codex', session: 'acp', model: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
  return { subscriptions: ['codex'], assignmentStrategy: 'one-model', reasoning: 'balanced', models: Object.fromEntries(['development', 'review', 'coordination'].map(work => [work, structuredClone(model)])) };
}

test('valid complete answers are returned unchanged without mutation', () => {
  const value = fixture(), before = structuredClone(value);
  assert.equal(validateFleetSettings(value), value);
  assert.deepEqual(value, before);
});

test('model catalog membership remains Fleet authority', () => {
  const value = fixture();
  for (const model of Object.values(value.models)) model.model = 'future-supported-model';
  assert.equal(validateFleetSettings(value), value);
});

for (const value of [null, [], {}, 'settings', 1]) test(`rejects incomplete root ${JSON.stringify(value)}`, () => {
  assert.throws(() => validateFleetSettings(value), /Fleet settings/);
});

const invalidCases = {
  'missing top field': value => { delete value.reasoning; },
  'unknown top field': value => { value.extra = true; },
  'missing work': value => { delete value.models.review; },
  'unknown work': value => { value.models.extra = value.models.review; },
  'nonobject models': value => { value.models = []; },
  'nonobject model': value => { value.models.review = null; },
  'missing model field': value => { delete value.models.review.efforts; },
  'unknown model field': value => { value.models.review.extra = true; },
  'empty subscriptions': value => { value.subscriptions = []; },
  'duplicate subscriptions': value => { value.subscriptions = ['codex', 'codex']; },
  'unknown subscription': value => { value.subscriptions = ['other']; },
  'nonarray subscriptions': value => { value.subscriptions = 'codex'; },
  'unknown strategy': value => { value.assignmentStrategy = 'automatic'; },
  'unknown reasoning': value => { value.reasoning = 'maximum'; },
  'nonstring reasoning': value => { value.reasoning = ['balanced']; },
  'unknown harness': value => { value.models.review.harness = 'other'; },
  'unknown session': value => { value.models.review.session = 'native'; },
  'empty model': value => { value.models.review.model = ' '; },
  'nonstring model': value => { value.models.review.model = 1; },
  'empty efforts': value => { value.models.review.efforts = []; },
  'nonarray efforts': value => { value.models.review.efforts = 'medium'; },
  'duplicate efforts': value => { value.models.review.efforts = ['medium', 'medium']; },
  'unknown effort': value => { value.models.review.efforts = ['medium', 'other']; },
  'unsupported reasoning effort': value => { value.models.review.efforts = ['low']; },
  'unselected subscription': value => { value.models.review.harness = 'claude-code'; },
  'inconsistent one-model assignment': value => { value.models.review.model = 'gpt-5.5'; },
};
for (const [name, change] of Object.entries(invalidCases)) test(`rejects ${name}`, () => {
  const value = fixture(); change(value);
  assert.throws(() => validateFleetSettings(value), /Fleet settings/);
});

test('per-job allows distinct models and subscribed harnesses', () => {
  const value = fixture();
  value.assignmentStrategy = 'per-job'; value.subscriptions.push('claude');
  value.models.review = { harness: 'claude-code', session: 'acp', model: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
  assert.equal(validateFleetSettings(value), value);
});
