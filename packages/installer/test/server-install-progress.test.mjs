import test from 'node:test';
import assert from 'node:assert/strict';
import { runServerCommand } from '../lib/orchestrate.mjs';

const labels = ['Package selection', 'Prerequisite checks', 'Installation setup', 'Runtime preparation', 'Service shutdown', 'Credential initialization', 'Credential delivery', 'Build verification', 'Service startup'];
function fixture(mode, failAt) {
  const events = [];
  const failure = new Error('fixture stage failed');
  const sources = { packages: {} };
  const stage = async label => {
    const announcement = events.at(-1);
    assert.equal(announcement.type, 'out', `announce ${label} before awaiting it`);
    assert(announcement.text.includes(label), `missing ${label} announcement`);
    assert(!announcement.text.includes('100%'), 'do not report completion before startup succeeds');
    events.push({ type: 'effect', label });
    if (label === failAt) throw failure;
  };
  const effects = {
    out: text => events.push({ type: 'out', text: String(text).replace(/\x1b\[[0-9;]*m/g, '') }),
    withInstallationLock: async (_root, action) => action(),
    readJson: () => null,
    newInstallation: (root, selectedMode) => ({ schema: 2, root, mode: selectedMode, sourcesPath: `${root}/sources.json` }),
    packagedSourcePolicy: () => sources,
    resolveSourcePolicy: async () => { await stage(labels[0]); return sources; },
    serverPreflight: async () => stage(labels[1]),
    initializeSelection: async () => stage(labels[2]),
    writeJson: () => events.push({ type: 'write' }),
    prepareInstallation: async () => stage(labels[3]),
    serverLifecycle: async (_record, operation) => stage(operation === 'stop' ? labels[4] : labels[8]),
    serverAccess: async (_record, operation) => stage(operation === 'access-init' ? labels[5] : labels[6]),
    recordInstallationBuild: async () => stage(labels[7]),
  };
  return { effects, events, failure, args: { operation: 'install', stateDir: '/private/progress-fixture', mode } };
}

for (const mode of ['docker', 'packages']) {
  test(`${mode} install announces every stage before work and completes after readiness`, async () => {
    const f = fixture(mode);
    assert.equal(await runServerCommand(f.args, f.effects), 0);
    assert.deepEqual(f.events.filter(event => event.type === 'effect').map(event => event.label), labels);
    assert.equal(f.events.filter(event => event.type === 'write').length, 1);
    const output = f.events.filter(event => event.type === 'out').map(event => event.text);
    for (const label of labels) assert(output.some(line => line.includes(`${label} complete`)));
    const complete = f.events.findIndex(event => event.type === 'out' && event.text.includes('100%'));
    const startup = f.events.findIndex(event => event.type === 'effect' && event.label === 'Service startup');
    assert(complete > startup);
    assert(f.events[complete].text.includes('Installation complete'));
    assert(output.some(line => line.includes(mode === 'docker' ? 'Prepare the Docker runtime' : 'native runtime packages')));
  });

  for (const label of labels) {
    test(`${mode} install reports ${label} failure without later stages or completion`, async () => {
      const f = fixture(mode, label);
      await assert.rejects(runServerCommand(f.args, f.effects), error => error === f.failure);
      assert.deepEqual(f.events.filter(event => event.type === 'effect').map(event => event.label), labels.slice(0, labels.indexOf(label) + 1));
      const output = f.events.filter(event => event.type === 'out').map(event => event.text).join('\n');
      assert(output.includes(`stopped during ${label.toLowerCase()}`));
      assert(!output.includes(`${label} complete`));
      assert(!output.includes('100%'));
      assert(!output.includes('Installation complete'));
    });
  }
}

test('runtime preparation progress is visible while long preparation is pending', async () => {
  const f = fixture('docker');
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.effects.prepareInstallation = async () => { began(); await pending; };
  const run = runServerCommand(f.args, f.effects);
  await started;
  assert(f.events.at(-1).text.includes('Runtime preparation'));
  assert(!f.events.some(event => event.type === 'out' && event.text.includes('Runtime preparation complete')));
  release();
  await run;
});
