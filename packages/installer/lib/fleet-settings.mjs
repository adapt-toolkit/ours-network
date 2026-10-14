// Structural preflight adapted from @ours.network/fleet src/init-wizard.ts
// (readInitSettings/generateSetup), shipped in Fleet 1.2.0-nightly.1.
// This checks complete answers before installer effects, without duplicating
// Fleet's evolving model catalog. Fleet init remains authoritative for model
// membership, exact capability arrays, and its packaged preset validation.
const WORKS = ['development', 'review', 'coordination'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const REASONING = { quick: 'low', balanced: 'medium', thorough: 'high' };
const fail = message => { throw new Error(`Fleet settings ${message}`); };
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    fail(`${label} must contain exactly ${keys.join(', ')}`);
}
function uniqueSelection(value, choices, label) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
    || value.some(item => !choices.includes(item)))
    fail(`${label} must be a nonempty unique selection of ${choices.join(', ')}`);
}

export function validateFleetSettings(value) {
  exactKeys(value, ['subscriptions', 'assignmentStrategy', 'models', 'reasoning'], 'answers');
  uniqueSelection(value.subscriptions, ['codex', 'claude'], 'subscriptions');
  if (!['one-model', 'per-job'].includes(value.assignmentStrategy)) fail('assignmentStrategy must be one-model or per-job');
  if (typeof value.reasoning !== 'string' || !Object.hasOwn(REASONING, value.reasoning)) fail('reasoning must be quick, balanced, or thorough');
  exactKeys(value.models, WORKS, 'models');
  const tuples = new Set();
  for (const work of WORKS) {
    const model = value.models[work];
    exactKeys(model, ['harness', 'session', 'model', 'efforts'], `${work} model`);
    if (!['codex', 'claude-code'].includes(model.harness)) fail(`${work} harness must be codex or claude-code`);
    if (model.session !== 'acp') fail(`${work} session must be acp`);
    if (typeof model.model !== 'string' || !model.model.trim()) fail(`${work} model must be a nonempty string`);
    uniqueSelection(model.efforts, EFFORTS, `${work} efforts`);
    if (!model.efforts.includes(REASONING[value.reasoning])) fail(`${work} efforts do not support the selected reasoning`);
    if (!value.subscriptions.includes(model.harness === 'codex' ? 'codex' : 'claude'))
      fail(`${work} uses a harness outside the selected subscriptions`);
    tuples.add(JSON.stringify([model.harness, model.session, model.model]));
  }
  if (value.assignmentStrategy === 'one-model' && tuples.size !== 1)
    fail('one-model assignment requires the same model for development, review, and coordination');
  return value;
}
