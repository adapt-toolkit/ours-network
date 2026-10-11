import test from 'node:test';
import assert from 'node:assert/strict';
import { reportBootReadiness } from '../lib/boot-readiness.mjs';

const uid = process.getuid();
const ROOTFUL = 'unix:///var/run/docker.sock', ROOTLESS = `unix:///run/user/${uid}/docker.sock`;
const failure = (message, code) => Object.assign(new Error(message), code === undefined ? {} : { code });
// `systemctl` is either a unit-file state (systemd exits 1 for disabled/masked and 4 for a
// missing unit, which the real effects layer raises unless allowed) or an Error to throw.
const EXIT = { enabled: 0, 'enabled-runtime': 0, static: 0, disabled: 1, masked: 1, 'not-found': 4, '': 1 };
async function report({ endpoint = ROOTFUL, rootless = false, systemctl = 'enabled', linger = 'yes', env = {}, docker = true, systemd = true, userManager = true, platform = 'linux', record = { mode: 'docker' } } = {}) {
  const messages = [], calls = [];
  const effects = { platform: { platform }, env, username: () => 'alice', exists: path => systemd && path === '/run/systemd/system', out: m => messages.push(m), run: async (cmd, args, { allowCodes = [] } = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'docker' && args[0] === 'context') return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: endpoint } } }]) };
    if (cmd === 'docker') { if (!docker) throw failure('Cannot connect to the Docker daemon'); return { stdout: JSON.stringify(rootless ? ['name=seccomp,profile=builtin', 'name=rootless'] : ['name=seccomp,profile=builtin']) }; }
    if (cmd === 'systemctl' && args.at(-1) === 'show-environment') { if (!userManager) throw failure('Failed to connect to user scope bus'); return { stdout: 'PATH=/usr/bin\n' }; }
    if (cmd === 'systemctl') {
      if (systemctl instanceof Error) throw systemctl;
      if (EXIT[systemctl] !== 0 && !allowCodes.includes(EXIT[systemctl])) throw failure(`systemctl exited ${EXIT[systemctl]}`);
      return { code: EXIT[systemctl], stdout: systemctl === '' ? '' : `${systemctl}\n` };
    }
    if (cmd === 'loginctl') { if (linger instanceof Error) throw linger; return { stdout: `${linger}\n` }; }
    throw failure(`unexpected command ${cmd}`);
  } };
  await reportBootReadiness(effects, record);
  // Read-only: the only systemctl verb is is-enabled, and nothing is enabled, started or lingered.
  for (const call of calls) {
    if (call[0] === 'systemctl') assert(['is-enabled docker.service', '--user is-enabled docker.service', '--user show-environment'].includes(call.slice(1).join(' ')), call.join(' '));
    if (call[0] === 'loginctl') assert.equal(call[1], 'show-user');
    assert(!call.some(arg => ['enable', 'start', 'restart', 'unmask', 'enable-linger', 'sudo'].includes(arg)), call.join(' '));
  }
  return { text: messages.join('\n'), calls };
}
const NO_AUTOSTART = /ours components that depend on Docker will not start automatically after a reboot/;
const ANY_ENABLE = /systemctl (--user )?enable/;

test('enabled rootful Docker reports boot readiness without advice', async () => {
  const { text, calls } = await report();
  assert.match(text, /Docker boot service is enabled; managed containers recover/);
  assert.doesNotMatch(text, ANY_ENABLE);
  assert.doesNotMatch(text, NO_AUTOSTART);
  assert(calls.some(call => call.join(' ') === 'systemctl is-enabled docker.service'));
  assert(!calls.some(call => call[0] === 'loginctl'));
});
test('running but disabled rootful Docker explains the reboot consequence and offers the enable command', async () => {
  const { text } = await report({ systemctl: 'disabled' });
  assert.match(text, /Docker is running now, but it is not enabled to start at boot/);
  assert.match(text, NO_AUTOSTART);
  assert.match(text, /If you want them to start automatically, run: sudo systemctl enable docker\.service\./);
  assert.match(text, /installer does not change this for you/);
  assert.doesNotMatch(text, /--user|linger|--now/);
});
test('enabled-runtime does not survive the reboot and is reported as not enabled', async () => {
  const { text } = await report({ systemctl: 'enabled-runtime' });
  assert.match(text, /not enabled to start at boot/);
  assert.match(text, /sudo systemctl enable docker\.service/);
});
test('masked Docker is not offered an enable command that would fail', async () => {
  const { text } = await report({ systemctl: 'masked' });
  assert.match(text, /docker\.service is masked/);
  assert.match(text, NO_AUTOSTART);
  assert.doesNotMatch(text, ANY_ENABLE);
});
test('an indeterminate unit-file state is neither called enabled nor given an enable command', async () => {
  const { text } = await report({ systemctl: 'static' });
  assert.match(text, /start at boot is not verified/);
  assert.doesNotMatch(text, ANY_ENABLE);
  assert.doesNotMatch(text, /boot service is enabled/);
});
for (const [name, systemctl] of [
  ['systemctl is not installed (OpenRC/runit host)', failure('spawn systemctl ENOENT', 'ENOENT')],
  ['the host is not booted with systemd (WSL, container)', ''],
  ['docker.service does not exist (snap or Docker Desktop WSL integration)', 'not-found'],
  ['systemctl fails unexpectedly', failure('Failed to connect to bus')],
]) test(`no systemctl command is recommended when ${name}`, async () => {
  const { text } = await report({ systemctl });
  assert.match(text, /no running systemd manager with a docker\.service was found, so its start-at-boot setting cannot be checked/);
  assert.match(text, NO_AUTOSTART);
  assert.match(text, /Docker Desktop, snap, or your init system/);
  assert.doesNotMatch(text, /systemctl (--user )?(enable|status)|sudo/);
  assert.doesNotMatch(text, /boot service is enabled/);
});
// `systemctl is-enabled` reads unit files offline and answers on a host whose init is not systemd.
for (const systemctl of ['enabled', 'disabled']) test(`an installed ${systemctl} unit on a host not booted with systemd proves nothing`, async () => {
  const { text, calls } = await report({ systemd: false, systemctl });
  assert.match(text, /no running systemd manager with a docker\.service was found/);
  assert.match(text, NO_AUTOSTART);
  assert.doesNotMatch(text, /systemctl|sudo|boot service is enabled/);
  assert(!calls.some(call => call[0] === 'systemctl'));
});
for (const systemctl of ['enabled', 'disabled']) test(`rootless Docker without a running user manager ignores an installed ${systemctl} unit`, async () => {
  const { text, calls } = await report({ endpoint: ROOTLESS, rootless: true, userManager: false, systemctl });
  assert.match(text, /no running systemd user manager with a docker\.service was found/);
  assert.doesNotMatch(text, /systemctl|sudo|boot service is enabled/);
  assert(!calls.some(call => call.includes('is-enabled')));
});
test('disabled rootless Docker gets the user-scope command without sudo, plus linger', async () => {
  const { text, calls } = await report({ endpoint: ROOTLESS, rootless: true, systemctl: 'disabled' });
  assert(calls.some(call => call.join(' ') === 'systemctl --user is-enabled docker.service'));
  assert.match(text, NO_AUTOSTART);
  assert.match(text, /run: systemctl --user enable docker\.service \(and, for startup before you log in, sudo loginctl enable-linger alice\)/);
  assert.doesNotMatch(text, /sudo systemctl/);
});
test('enabled rootless Docker without linger is distinguished from a disabled service', async () => {
  const { text } = await report({ endpoint: ROOTLESS, rootless: true, linger: 'no' });
  assert.match(text, /user service is enabled, but user linger is off, so Docker starts only when you log in/);
  assert.match(text, /run: sudo loginctl enable-linger alice\./);
  assert.doesNotMatch(text, ANY_ENABLE);
});
test('unreadable linger is reported as unverified, not as off or enabled', async () => {
  const { text } = await report({ endpoint: ROOTLESS, rootless: true, linger: failure('loginctl failed') });
  assert.match(text, /user linger could not be checked\. If linger is off, Docker starts only when you log in/);
  assert.match(text, /Check it with: loginctl show-user alice --property=Linger/);
  assert.doesNotMatch(text, /linger is off, so|enable-linger/);
  assert.doesNotMatch(text, /boot service is enabled/);
});
test('enabled rootless Docker with linger reports boot readiness', async () => {
  const { text } = await report({ endpoint: ROOTLESS, rootless: true });
  assert.match(text, /Docker boot service is enabled with user linger/);
});
for (const [name, options] of [
  ['remote context', { endpoint: 'ssh://remote' }],
  ['Docker Desktop for Linux', { endpoint: 'unix:///home/test/.docker/desktop/docker.sock' }],
  ['DOCKER_CONTEXT naming a remote Engine', { endpoint: 'tcp://10.0.0.5:2376', env: { DOCKER_CONTEXT: 'other' } }],
]) test(`${name} is not checked against local systemd`, async () => {
  const { text, calls } = await report({ ...options, systemctl: 'disabled' });
  assert.match(text, /cannot be verified for this context/);
  assert(!calls.some(call => call[0] === 'systemctl'));
  assert.doesNotMatch(text, /systemctl/);
});
test('DOCKER_CONTEXT naming the local Engine is judged by its resolved endpoint', async () => {
  const rootful = await report({ env: { DOCKER_CONTEXT: 'default' }, systemctl: 'disabled' });
  assert.match(rootful.text, /run: sudo systemctl enable docker\.service\./);
  const rootless = await report({ endpoint: ROOTLESS, rootless: true, env: { DOCKER_CONTEXT: 'rootless' }, systemctl: 'disabled' });
  assert.match(rootless.text, /run: systemctl --user enable docker\.service /);
});
// With both variables set, only the endpoint the CLI resolved picks the guidance: Docker's
// documentation and its releases disagree on which variable wins, so neither is read here.
test('a remote resolved endpoint is not overruled by a local DOCKER_HOST', async () => {
  const { text, calls } = await report({ endpoint: 'ssh://remote', env: { DOCKER_CONTEXT: 'remote', DOCKER_HOST: ROOTFUL }, systemctl: 'disabled' });
  assert.match(text, /cannot be verified for this context/);
  assert.doesNotMatch(text, /systemctl/);
  assert(!calls.some(call => call[0] === 'systemctl'));
});
test('a local resolved endpoint is not overruled by a remote DOCKER_HOST', async () => {
  const { text } = await report({ env: { DOCKER_CONTEXT: 'default', DOCKER_HOST: 'tcp://ignored:2376' }, systemctl: 'disabled' });
  assert.match(text, /run: sudo systemctl enable docker\.service\./);
});
test('a custom socket is not checked against docker.service', async () => {
  const { text, calls } = await report({ endpoint: 'unix:///task/docker.sock', env: { DOCKER_HOST: 'unix:///task/docker.sock' }, systemctl: 'disabled' });
  assert.match(text, /boot service binding is unverified/);
  assert(!calls.some(call => call[0] === 'systemctl'));
  assert.doesNotMatch(text, /systemctl/);
});
test('an unanswering Engine is not described as running or enabled', async () => {
  const { text, calls } = await report({ docker: false });
  assert.match(text, /could not be checked because the selected Docker Engine did not answer/);
  assert.match(text, NO_AUTOSTART);
  assert.doesNotMatch(text, /running now|systemctl/);
  assert(!calls.some(call => call[0] === 'systemctl'));
});
test('Docker Desktop platforms and the Podman engine keep their own guidance', async () => {
  const mac = await report({ platform: 'darwin' });
  assert.match(mac.text, /Docker Desktop to start at sign-in/);
  assert.equal(mac.calls.length, 0);
  const podman = await report({ record: { mode: 'docker', containerEngine: 'podman' } });
  assert.equal(podman.text, '');
  assert.equal(podman.calls.length, 0);
});
