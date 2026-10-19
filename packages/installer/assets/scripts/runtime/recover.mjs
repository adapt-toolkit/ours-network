import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';

// Exit status after the recovery budget is spent: the container stops and its
// restart policy, the only outer supervisor, starts a fresh one.
export const EXHAUSTED_EXIT_CODE = 75;
// Probe output is never logged; only these fixed classifications survive.
const PROBE_CLASSES = new Set(['liveness:unreachable', 'liveness:timeout', 'liveness:http',
  'readiness:timeout', 'readiness:auth', 'readiness:instance', 'readiness:capability', 'readiness:error']);
const probeClass = output => {
  const match = /^OURS_PROBE ([a-z:]+)$/m.exec(output);
  return match && PROBE_CLASSES.has(match[1]) ? match[1] : null;
};

// The container owns recovery; no Docker socket, host service or stored state is
// accessed. Every launch re-enters the locked, provenance-checking entrypoint.
export async function runRecovery({ command, health, dependency, graceMs = 90_000,
  intervalMs = 5_000, probeTimeoutMs = 15_000,
  killAfterMs = 20_000, retries = 3, failures = 3, healthyResetMs = 600_000,
  maxBackoffMs = 300_000, ownerPidEnvironment, log = console.error }) {
  let stopping = false, active;
  const probes = new Set();
  const controller = new AbortController();
  const pause = ms => sleep(ms, undefined, { signal: controller.signal }).catch(() => {});
  const processFields = id => {
    try {
      const stat = readFileSync(`/proc/${id}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    } catch { return null; }
  };
  const groups = child => {
    if (!child?.pid) return [];
    child.groups ??= new Set([child.pid]);
    // Cowork's serve supervisor explicitly marks a detached worker with its
    // owner PID. The marker survives owner death, unlike PPID ancestry. No
    // unrelated process or unmarked group is selected, including Docker exec.
    if (ownerPidEnvironment && !child.probe) for (const id of readdirSync('/proc')) {
      if (!/^\d+$/.test(id)) continue;
      try {
        const env = readFileSync(`/proc/${id}/environ`, 'utf8').split('\0');
        if (!env.includes(`${ownerPidEnvironment}=${child.pid}`)) continue;
        const fields = processFields(id);
        if (fields && !['Z', 'X'].includes(fields[0])) child.groups.add(Number(fields[2]));
      } catch { /* foreign or exited process */ }
    }
    return [...child.groups].filter(pid => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  };
  const signalGroup = (child, signal, all = true) => {
    const selected = all ? groups(child) : child?.pid ? [child.pid] : [];
    for (const pid of selected) try { process.kill(-pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const launch = (args, probe = false) => {
    const child = spawn(args[0], args.slice(1), { detached: true,
      stdio: probe ? ['ignore', 'pipe', 'ignore'] : 'inherit', env: { ...process.env, OURS_RECOVERY_CHILD: '1' } });
    child.probe = probe;
    child.done = new Promise(resolve => {
      child.once('error', () => { child.spawnFailed = true; resolve(1); });
      child.once('exit', (code) => resolve(code ?? 1));
    });
    return child;
  };
  const groupAlive = child => {
    const selected = groups(child);
    return readdirSync('/proc').some(id => {
      if (!/^\d+$/.test(id)) return false;
      const fields = processFields(id);
      return fields && selected.includes(Number(fields[2])) && !['Z', 'X'].includes(fields[0]);
    });
  };
  const terminate = async child => {
    groups(child);
    // Graceful shutdown reaches only the owning entrypoint; Cowork retains
    // exclusive IPC control of its worker until the force-kill boundary.
    signalGroup(child, 'SIGTERM', false);
    let timer;
    await Promise.race([child.done, new Promise(resolve => { timer = setTimeout(() => {
      signalGroup(child, 'SIGKILL'); resolve();
    }, killAfterMs); })]);
    clearTimeout(timer);
    // A leader may exit before a stubborn grandchild. Kill the remaining group
    // even when child.done won the race, then await kernel lock release.
    signalGroup(child, 'SIGKILL');
    await child.done;
    const deadline = Date.now() + killAfterMs;
    while (groupAlive(child)) {
      if (Date.now() >= deadline) throw new Error('Recovery refused: child process group did not stop');
      await sleep(25);
    }
  };
  // Resolves { ok, reason, ms }; reason is ok, timeout, spawn, an allowlisted
  // class reported by the probe, or exit:<code>.
  const probe = async args => {
    const started = Date.now();
    const child = launch(args, true);
    probes.add(child);
    let output = '', timer, timedOut = false;
    child.stdout?.on('data', chunk => { if (output.length < 512) output += chunk.toString('utf8').slice(0, 512); });
    const code = await Promise.race([child.done, new Promise(resolve => {
      timer = setTimeout(() => { timedOut = true; signalGroup(child, 'SIGKILL'); resolve(1); }, probeTimeoutMs);
    })]);
    clearTimeout(timer);
    await terminate(child);
    child.stdout?.destroy();
    probes.delete(child);
    const ok = code === 0 && !timedOut;
    const reason = ok ? 'ok' : timedOut ? 'timeout' : child.spawnFailed ? 'spawn' : probeClass(output) ?? `exit:${code}`;
    return { ok, reason, ms: Date.now() - started };
  };
  const stop = () => { stopping = true; controller.abort(); signalGroup(active, 'SIGTERM', false); for (const child of probes) signalGroup(child, 'SIGKILL'); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    let recoveries = 0;
    while (!stopping) {
      if (recoveries > retries) {
        // Never strand a running container without its service: exit visibly
        // and let the container restart policy apply its own backoff.
        log(`OURS recovery exhausted (${retries} automatic attempts without ${Math.round(healthyResetMs / 1000)}s of continuous readiness); children stopped. Exiting with status ${EXHAUSTED_EXIT_CODE} for the container restart policy.`);
        process.exitCode = EXHAUSTED_EXIT_CODE;
        break;
      }
      // A dependency outage is a wait, not a local failure. Never spend a
      // consumer's circuit on daemon boot order, restart or unavailability.
      if (dependency) {
        let waiting = false;
        while (!stopping && !(await probe(dependency)).ok) {
          if (!waiting) log('OURS waiting for the authenticated daemon; recovery budget retained');
          waiting = true;
          await pause(intervalMs);
        }
      }
      if (stopping) break;
      if (recoveries) log(`OURS recovery attempt ${recoveries}/${retries}`);
      active = launch(command);
      let exited = false, monitoring = true;
      const generation = new AbortController();
      const wait = ms => sleep(ms, undefined, { signal: generation.signal }).catch(() => {});
      const cancel = () => generation.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      active.done.then(() => { exited = true; generation.abort(); });
      const watch = async () => {
        await wait(graceMs);
        let failed = 0, healthySince = null;
        while (monitoring && !stopping && !exited) {
          const result = await probe(health);
          if (!monitoring || stopping || exited) break;
          if (result.ok) {
            failed = 0;
            healthySince ??= Date.now();
            // Only an unbroken readiness interval restores the budget; any
            // failed or timed-out probe, including a dependency outage, restarts it.
            if (recoveries && Date.now() - healthySince >= healthyResetMs) {
              log(`OURS recovery budget restored after ${Math.round((Date.now() - healthySince) / 1000)}s of continuous readiness`);
              recoveries = 0;
            }
          } else {
            healthySince = null;
            if (dependency && !(await probe(dependency)).ok) failed = 0;
            else {
              failed += 1;
              log(`OURS health probe failed (${failed}/${failures}): ${result.reason} after ${result.ms}ms`);
            }
          }
          if (failed >= failures) { log('OURS service health failed repeatedly; stopping children before recovery'); return; }
          await wait(intervalMs);
        }
      };
      const watching = watch();
      await Promise.race([active.done, watching]);
      monitoring = false; generation.abort();
      await terminate(active);
      await watching;
      controller.signal.removeEventListener('abort', cancel);
      active = undefined;
      if (!stopping) {
        if (!dependency || (await probe(dependency)).ok) recoveries++;
        // Exponential backoff between attempts; a dependency outage keeps the base interval.
        await pause(Math.min(maxBackoffMs, intervalMs * 2 ** Math.max(0, recoveries - 1)));
      }
    }
  } finally {
    if (active) await terminate(active);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = process.argv[2], runtime = process.env.OURS_RUNTIME_ROOT ?? '/opt/ours';
  const health = {
    daemon: ['node', `${runtime}/docker/healthcheck.mjs`],
    telegram: ['/bin/sh', `${runtime}/docker/health-telegram.sh`],
    cowork: ['/bin/sh', `${runtime}/docker/health-cowork.sh`],
    messenger: ['node', `${runtime}/docker/health-messenger.mjs`],
  }[service];
  if (!health) throw new Error('Unknown recovery service');
  const entry = service === 'daemon' ? 'entrypoint.sh' : `start-${service}.sh`;
  await runRecovery({ command: ['/bin/sh', '-e', `${runtime}/docker/${entry}`], health,
    ...(service === 'cowork' ? { ownerPidEnvironment: 'OURS_COWORK_SUPERVISOR_PID' } : {}),
    ...(service !== 'daemon' ? { dependency: ['node', `${runtime}/docker/dependency-ready.mjs`, service] } : {}) });
}
