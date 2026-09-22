import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayAddress } from './gateway.mjs';
import { validateInstallation } from './plan.mjs';
import { atomicWriteConfig, snapshotConfig, restoreConfig } from './config.mjs';

// Called under the installation lock. No stored state or credentials are changed.
export async function enableGateway(record, args, effects) {
  validateInstallation(record, record.root);
  if (record.mode !== 'docker' || record.schema !== 2 || record.buildTransition || record.layoutConversion)
    throw new Error('Gateway migration requires a settled schema-2 Docker installation');
  const journal = join(record.root, 'gateway-transition.json');
  const recordPath = join(record.root, 'installation.json');
  const profilePath = join(effects.home, '.ours-client', 'profile.json');
  const paths = [recordPath, ...['docker-compose.gateway.yaml', 'nginx.conf', 'Dockerfile.gateway'].map(name => join(record.workDir, name)), profilePath];
  const snapshot = path => {
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & (path === profilePath || path === journal || path === recordPath ? 0o077 : 0o022)))
        throw new Error('Gateway migration requires private owned configuration files');
    }
    return snapshotConfig(path);
  };
  async function rollback(saved) {
    const phase = value => { saved.phase = value; atomicWriteConfig(journal, JSON.stringify(saved, null, 2) + '\n'); };
    if (saved.phase === 'switching') phase('rollback-stopping');
    if (saved.phase === 'rollback-stopping') {
      await effects.serverLifecycle(saved.candidate, 'stop');
      await effects.removeGatewayContainer(saved.candidate);
      phase('rollback-restoring');
    }
    if (saved.phase === 'preparing') phase('rollback-restoring');
    if (saved.phase === 'rollback-restoring') {
      for (let i = 0; i < paths.length; i++) restoreConfig(paths[i], saved.snapshots[i]);
      phase('rollback-restarting');
    }
    await effects.serverLifecycle(saved.original, 'start', saved.running);
    unlinkSync(journal);
  }
  if (existsSync(journal)) {
    snapshot(journal);
    const saved = JSON.parse(readFileSync(journal, 'utf8'));
    validateInstallation(saved.original, record.root);
    validateInstallation(saved.candidate, record.root);
    if (saved.schema !== 1 || !['preparing', 'switching', 'rollback-stopping', 'rollback-restoring', 'rollback-restarting'].includes(saved.phase) || !Array.isArray(saved.snapshots) || saved.snapshots.length !== paths.length
        || !Array.isArray(saved.running) || saved.running.some(name => !saved.original.services.includes(name)))
      throw new Error('Invalid retained gateway transition; operator recovery required');
    await rollback(saved);
    throw new Error('Interrupted gateway migration rolled back; repeat gateway-enable to begin a new migration');
  }
  if (record.gateway) {
    if (args.serverUrl && args.serverUrl !== gatewayAddress(record).base) throw new Error('Gateway URL is already configured; refusing implicit URL replacement');
    await effects.verifyGateway(record);
    return record;
  }
  const candidate = { ...record, gateway: { version: 1, ...(args.serverUrl ? { serverUrl: args.serverUrl } : {}) }, services: [...record.services, 'gateway'] };
  validateInstallation(candidate, record.root);
  const current = effects.readManagedClientProfile();
  const selected = current?.expectedInstanceId === record.instanceId && current.endpoint === `http://127.0.0.1:${record.port}`;
  const saved = { schema: 1, phase: 'preparing', original: record, candidate, snapshots: paths.map(snapshot), running: await effects.serverLifecycle(record, 'status') };
  // Reject old service artifacts before stopping the working deployment.
  await effects.qualifyGatewayRuntime(candidate);
  if (selected) await effects.qualifyInstalledGatewayClient(current);
  atomicWriteConfig(journal, JSON.stringify(saved, null, 2) + '\n');
  try {
    await effects.prepareGateway(candidate);
    saved.phase = 'switching';
    atomicWriteConfig(journal, JSON.stringify(saved, null, 2) + '\n');
    await effects.serverLifecycle(record, 'stop');
    await effects.serverLifecycle(candidate, 'start', [...new Set([...saved.running, 'daemon', 'cowork', 'gateway'])]);
    await effects.verifyGateway(candidate);
    if (selected) {
      const serverUrl = gatewayAddress(candidate).base;
      atomicWriteConfig(profilePath, JSON.stringify({ ...current, serverUrl, endpoint: serverUrl + '/daemon' }, null, 2) + '\n');
    }
    // Preserve the running/stopped selection; gateway follows a running daemon.
    const keep = [...saved.running, ...(saved.running.includes('daemon') ? ['gateway'] : [])];
    await effects.serverLifecycle(candidate, 'stop', candidate.services.filter(name => !keep.includes(name)));
    atomicWriteConfig(recordPath, JSON.stringify(candidate, null, 2) + '\n');
    unlinkSync(journal);
    return candidate;
  } catch (cause) {
    try { await rollback(saved); }
    catch (rollbackError) { throw new AggregateError([cause, rollbackError], 'Gateway migration and rollback failed; retained journal requires gateway-enable recovery'); }
    throw new Error('Gateway migration failed; previous routing, profile and service selection restored', { cause });
  }
}
