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
  try {
    const context = JSON.parse((await effects.run('docker', ['context', 'inspect'])).stdout);
    const endpoint = effects.env.DOCKER_HOST ?? context[0]?.Endpoints?.docker?.Host;
    if (effects.env.DOCKER_CONTEXT || !endpoint?.startsWith('unix://') || endpoint.includes('/.docker/desktop/')) {
      effects.out('Container recovery requires the selected remote/Desktop Docker Engine to start independently; local systemd boot cannot be verified for this context.');
      return;
    }
    const info = JSON.parse((await effects.run('docker', ['info', '--format', '{{json .SecurityOptions}}'])).stdout);
    const rootless = info.some(option => option.startsWith('name=rootless'));
    const sockets = rootless ? [`unix:///run/user/${process.getuid()}/docker.sock`] : ['unix:///var/run/docker.sock', 'unix:///run/docker.sock'];
    if (!sockets.includes(endpoint)) {
      effects.out('The selected custom Docker socket is reachable, but its boot service binding is unverified; enable and verify the service owning that Engine.');
      return;
    }
    const enabled = await effects.run('systemctl', [...(rootless ? ['--user'] : []), 'is-enabled', 'docker.service']);
    if (enabled.stdout.trim() !== 'enabled') throw new Error('persistent Docker service enablement is unverified');
    if (rootless) {
      const linger = await effects.run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']);
      if (linger.stdout.trim() !== 'yes') throw new Error('rootless user linger is disabled');
    }
    effects.out(`Docker boot service is enabled${rootless ? ' with user linger' : ''}; managed containers recover when that Engine starts.`);
  } catch {
    effects.out('Docker is reachable, but automatic host boot is not verified. Ask the operator to enable the selected Docker Engine boot service (and user linger for rootless Docker); container restart policy cannot start an unavailable Engine.');
  }
}
