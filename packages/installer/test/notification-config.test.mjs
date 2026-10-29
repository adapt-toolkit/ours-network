import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationConfig, upgradeFleetMissionCapability } from '../assets/scripts/runtime/notification-config.mjs';

const fleet = config => config.producers.find(p => p.source === 'fleet');
const messenger = config => config.producers.find(p => p.source === 'messenger');

test('fresh configuration grants mission ownership only to Fleet', () => {
  const config = notificationConfig();
  assert.deepEqual(fleet(config).capabilities, ['mission-ownership']);
  assert.equal(messenger(config).capabilities, undefined);
  assert.equal(config.users[0].capabilities, undefined);
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), false);
});

test('legacy upgrade changes only Fleet capabilities, preserving credentials, keys and custom settings', () => {
  const config = notificationConfig(); delete fleet(config).capabilities;
  config.custom = { retained: true }; messenger(config).capabilities = ['message-capability'];
  const before = structuredClone(config);
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), true);
  delete fleet(config).capabilities;
  assert.deepEqual(config, before);
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), true);
  const upgraded = structuredClone(config);
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), false);
  assert.deepEqual(config, upgraded);
});

test('retains an authorized host repair and adds to existing Fleet capabilities without replacing them', () => {
  const config = notificationConfig(); fleet(config).capabilities = ['retained'];
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), true);
  assert.deepEqual(fleet(config).capabilities, ['retained', 'mission-ownership']);
  const before = structuredClone(config);
  assert.equal(upgradeFleetMissionCapability(config, fleet(config).token), false);
  assert.deepEqual(config, before);
});

test('mismatched delivery credential, ambiguous producers or a different account fail without mutation', () => {
  for (const mutate of [c => {}, c => c.producers.push({ ...fleet(c) }), c => fleet(c).userId = 'other',
    c => fleet(c).source = 'other', c => fleet(c).capabilities = 'mission-ownership']) {
    const config = notificationConfig(); delete fleet(config).capabilities; mutate(config);
    const before = structuredClone(config);
    assert.throws(() => upgradeFleetMissionCapability(config, 'mismatched'), /configuration differs|binding differs|capabilities are invalid/);
    assert.deepEqual(config, before);
  }
});

test('malformed capabilities are refused even with the correct Fleet delivery token', () => {
  for (const capabilities of [null, 'mission-ownership', [42]]) {
    const config = notificationConfig(); fleet(config).capabilities = capabilities;
    const before = structuredClone(config);
    assert.throws(() => upgradeFleetMissionCapability(config, fleet(config).token), /capabilities are invalid/);
    assert.deepEqual(config, before);
  }
});
