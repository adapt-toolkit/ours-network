import { warn } from './ui.mjs';

const NO_AUTOSTART = 'ours components that depend on Docker will not start automatically after a reboot until Docker is started';
const OPTIONAL = 'The installer does not change this for you.';

/** Persistent unit-file state only: `is-active`/a reachable Engine says nothing about the next boot. */
async function unitFileState(effects, scope) {
  // `is-enabled` reads unit files offline, so it answers even where systemd is not the init
  // system and its answer decides nothing. /run/systemd/system is sd_booted(3)'s own test.
  if (!effects.exists('/run/systemd/system')) return 'unavailable';
  try {
    if (scope.length) await effects.run('systemctl', [...scope, 'show-environment']); // a user manager must be running
    // 1 = disabled/masked, 4 = no such unit (older systemd reports that as 1 with empty output).
    const state = (await effects.run('systemctl', [...scope, 'is-enabled', 'docker.service'], { allowCodes: [1, 4] })).stdout.trim().split('\n')[0];
    if (state === 'enabled') return 'enabled';
    // enabled-runtime lives in /run and is gone after the reboot it is supposed to cover.
    if (state === 'disabled' || state === 'enabled-runtime') return 'disabled';
    if (state === 'masked' || state === 'masked-runtime') return 'masked';
    if (state === '' || state === 'not-found') return 'unavailable';
    return 'unknown';
  } catch { return 'unavailable'; } // no systemctl, or the host/session is not running systemd
}

/** Diagnose availability separately from boot enablement. Never alter host services. */
export async function reportBootReadiness(effects, record) {
  const platform = effects.platform.platform;
  if (record.mode === 'packages') {
    if (platform === 'linux') {
      try {
        const linger = await effects.run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']);
        if (linger.stdout.trim() !== 'yes') throw new Error('linger disabled');
        effects.out('Native user-service boot requires enabled package-owned units; user linger is enabled.');
      } catch { effects.out('Native user services require a login session; pre-login host boot is not verified. Ask the operator to enable user linger.'); }
    } else effects.out('Native launchd services start in the macOS GUI login session; pre-login boot and hung-process recovery are not supplied.');
    return;
  }
  if (record.mode !== 'docker' || (record.containerEngine ?? 'docker') !== 'docker') return;
  if (platform !== 'linux') {
    effects.out('Container recovery requires Docker Desktop to start at sign-in. Enable its startup setting; this installer does not arrange pre-login host boot on this platform.');
    return;
  }
  let endpoint, rootless;
  try {
    const context = JSON.parse((await effects.run('docker', ['context', 'inspect'])).stdout);
    // The CLI runs with this same environment and reports the endpoint it resolved from
    // DOCKER_HOST/DOCKER_CONTEXT; their precedence differs between its documentation and releases.
    endpoint = context[0]?.Endpoints?.docker?.Host;
    if (!endpoint?.startsWith('unix://') || endpoint.includes('/.docker/desktop/')) {
      effects.out('Container recovery requires the selected remote/Desktop Docker Engine to start independently; local systemd boot cannot be verified for this context.');
      return;
    }
    const info = JSON.parse((await effects.run('docker', ['info', '--format', '{{json .SecurityOptions}}'])).stdout);
    rootless = info.some(option => option.startsWith('name=rootless'));
  } catch {
    effects.out(warn(`Docker's start-at-boot setting could not be checked because the selected Docker Engine did not answer. If Docker is not set to start at boot, ${NO_AUTOSTART}.`));
    return;
  }
  const sockets = rootless ? [`unix:///run/user/${process.getuid()}/docker.sock`] : ['unix:///var/run/docker.sock', 'unix:///run/docker.sock'];
  if (!sockets.includes(endpoint)) {
    effects.out('The selected custom Docker socket is reachable, but its boot service binding is unverified; enable and verify the service owning that Engine.');
    return;
  }
  const scope = rootless ? ['--user'] : [];
  const enable = `${rootless ? '' : 'sudo '}systemctl ${rootless ? '--user ' : ''}enable docker.service`;
  const state = await unitFileState(effects, scope);
  if (state === 'unavailable') {
    // WSL with Docker Desktop integration, snap, OpenRC/runit and similar: a systemctl command would be wrong here.
    effects.out(warn(`Docker is running now, but no running systemd${rootless ? ' user' : ''} manager with a docker.service was found, so its start-at-boot setting cannot be checked. If Docker is not set to start at boot, ${NO_AUTOSTART}. To start them automatically, enable start-at-boot in whatever manages this Docker Engine (Docker Desktop, snap, or your init system). ${OPTIONAL}`));
    return;
  }
  if (state === 'unknown') {
    effects.out(warn(`Docker is running now, but its systemd${rootless ? ' user' : ''} docker.service is neither plainly enabled nor disabled, so start at boot is not verified. If Docker does not start at boot, ${NO_AUTOSTART}. Check it with: systemctl ${rootless ? '--user ' : ''}status docker.service`));
    return;
  }
  if (state === 'masked') {
    effects.out(warn(`Docker is running now, but its systemd${rootless ? ' user' : ''} docker.service is masked, so it cannot start at boot: ${NO_AUTOSTART}. An administrator masked it deliberately; it must be unmasked before it can be enabled. ${OPTIONAL}`));
    return;
  }
  if (state === 'disabled') {
    effects.out(warn(`Docker is running now, but it is not enabled to start at boot: ${NO_AUTOSTART}. If you want them to start automatically, run: ${enable}${rootless ? ` (and, for startup before you log in, sudo loginctl enable-linger ${effects.username()})` : ''}. ${OPTIONAL}`));
    return;
  }
  if (rootless) {
    let linger = '';
    try { linger = (await effects.run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])).stdout.trim(); } catch {}
    if (linger === 'no') {
      effects.out(warn(`Rootless Docker's user service is enabled, but user linger is off, so Docker starts only when you log in: ours components that depend on Docker will not start automatically after a reboot until then. If you want them to start at boot, run: sudo loginctl enable-linger ${effects.username()}. ${OPTIONAL}`));
      return;
    }
    if (linger !== 'yes') {
      effects.out(warn(`Rootless Docker's user service is enabled, but user linger could not be checked. If linger is off, Docker starts only when you log in and ours components that depend on Docker will not start automatically after a reboot until then. Check it with: loginctl show-user ${effects.username()} --property=Linger`));
      return;
    }
  }
  effects.out(`Docker boot service is enabled${rootless ? ' with user linger' : ''}; managed containers recover when that Engine starts.`);
}
