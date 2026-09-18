import * as fs from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installationPaths, validateInstallation, SERVER_SERVICES } from './plan.mjs';

/** The installation lock is held by the caller; installation.json selects the live side. */
export async function convertDockerInstallation(record, operation, effects) {
  validateInstallation(record, record.root);
  if (record.mode !== 'docker' || (record.schema !== 1 && !record.layoutConversion)) {
    throw new Error('Select a legacy or pending Docker installation');
  }
  const source = record.layoutConversion?.sourceRecord ?? record;
  const published = record.schema === 2;
  const writeSelection = value => effects.writeJson(join(record.root, 'installation.json'), JSON.stringify(value, null, 2) + '\n');
  const volumes = await effects.selectConversionVolumes(
    { ...source, layoutConversion: record.layoutConversion }, { allowMissingSources: published });
  if (published && !volumes.targetExists) throw new Error('Published Docker state volume is missing');

  if (!published) {
    await effects.prepareDockerConversionRuntime(source);
    if (!record.layoutConversion) {
      record = { ...source, layoutConversion: {
        version: 1, sourceRecord: source,
        runningServices: await effects.serverLifecycle(source, 'status'),
        backupPath: join(source.root, 'storage/backups', `before-layout-2-${randomUUID()}`),
      } };
      writeSelection(record);
    }
    // The full tree includes all four component volumes, even when a component
    // is not selected for restart. Exclude every former managed writer.
    await effects.retireLegacyServices({ ...source, services: [...SERVER_SERVICES] });
    const target = { ...source, schema: 2 };
    target.configPath = installationPaths(target).config;
    // Preparation initializes only owned storage; it does not issue authority.
    await effects.prepareInstallation(target);
    await effects.runDockerConversion(source, volumes, 'prepare', basename(record.layoutConversion.backupPath));
    record = { ...target, layoutConversion: record.layoutConversion };
    writeSelection(record);
  } else {
    await effects.serverLifecycle(record, 'stop');
    await effects.confirmDockerWritersStopped(record);
  }

  await effects.runDockerConversion(record, volumes, 'validate');
  const running = ['install', 'start'].includes(operation) ? record.services : record.layoutConversion.runningServices;
  await effects.serverLifecycle(record, 'start', running);
  const cleanup = await effects.runDockerConversion(record, volumes, 'cleanup');
  if (cleanup.emptyVolumes.length) {
    await effects.run('docker', ['volume', 'rm', ...cleanup.emptyVolumes.map(alias => volumes.sources[alias])]);
  }
  try {
    const stat = fs.lstatSync(source.configPath);
    // Private host files may inherit a directory's group on macOS.
    if (!stat.isFile() || stat.uid !== process.getuid()
      || (stat.mode & 0o7777) !== 0o600) throw new Error('Unsafe former installer configuration');
    fs.unlinkSync(source.configPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const finished = { ...record };
  delete finished.layoutConversion;
  writeSelection(finished);
  return finished;
}
