/** Human bootstrap and local client handoff through the existing owner interfaces. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installationPaths } from './plan.mjs';
import { validateHostProfile } from './target.mjs';

export function validateIdentityName(name) {
  if (typeof name !== 'string' || [...name].length < 1 || [...name].length > 64 || name !== name.normalize('NFC')
      || /[\\/\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)
      || ['.', '..', 'contact-book', 'root.json', 'bindings.json'].includes(name)) {
    throw new Error('Invalid Human identity name; use 1–64 NFC characters without reserved names or path/control characters');
  }
}
function privatePath(path, directory = false) {
  const stat = lstatSync(path);
  if (!(directory ? stat.isDirectory() : stat.isFile()) || realpathSync(path) !== path
      || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    throw new Error('Onboarding requires an owned private ' + (directory ? 'directory' : 'regular credential file'));
  }
  return stat;
}
function validateRecord(record) {
  if (!record || !['packages', 'docker'].includes(record.mode) || typeof record.root !== 'string'
      || !isAbsolute(record.root) || resolve(record.root) !== record.root
      || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) throw new Error('Invalid local server selection');
  validateHostProfile({ endpoint: `http://127.0.0.1:${record.port}`, expectedInstanceId: record.instanceId, credentialPath: join(record.root, 'client', 'credential') });
}

export function createServerOnboarding(effects, { compose, localEnv, bin }) {
  async function identityCommand(record, args) {
    const result = record.mode === 'docker'
      ? await compose(record, ['exec', '-T', 'daemon', 'node', '/opt/ours/node_modules/@ours.network/cli/dist/cli.js', ...args, '--config', '/var/lib/ours/config.json', '--state-dir', '/var/lib/ours', '--json'])
      : await effects.run(bin(record, 'ours'), [...args, '--config', record.configPath, '--state-dir', installationPaths(record).daemon, '--json'], { env: localEnv(record) });
    if (result.code !== undefined && result.code !== 0) throw new Error('Owner identity operation failed');
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('Owner identity operation returned malformed JSON'); }
  }
  async function identities(record) {
    const rows = await identityCommand(record, ['identity', 'list']);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string'
        || (!['root', 'role'].includes(row.kind) && !['reconciling', 'awaiting-root', 'migration-failed', 'refresh-failed'].includes(row.status))
        || (row.kind && (typeof row.cid !== 'string' || !row.cid)))) throw new Error('Owner identity list is malformed');
    const roots = rows.filter(row => row.kind === 'root');
    if (roots.length > 1) throw new Error('Owner identity list contains multiple Human roots');
    return { rows, root: roots[0] };
  }
  function retained({ rows, root }) {
    effects.out?.(`Retained ${rows.length} existing ${rows.length === 1 ? 'identity' : 'identities'}; Human identity: ${root.name}.`);
    return { name: root.name, cid: root.cid, created: false };
  }
  return {
    async serverListIdentities(record) { return (await identities(record)).rows; },
    async serverEnsureIdentity(record, name) {
      validateRecord(record);
      validateIdentityName(name);
      const prior = await identities(record);
      if (prior.root) return retained(prior);
      if (prior.rows.some(row => row.name === name)) throw new Error('Requested Human identity name already exists; no identity was changed');
      effects.out?.(`Creating Human identity ${name}; retaining ${prior.rows.length} existing identities.`);
      try {
        await identityCommand(record, ['identity', 'create-root', '--name', name, '--skip-if-root-exists', 'true']);
      } catch (error) {
        // ROOT_EXISTS is currently a CLI error. A concurrent creator is safe only
        // when the authoritative list now contains a root; other errors stay errors.
        const after = await identities(record);
        if (after.root) return retained(after);
        throw error;
      }
      const after = await identities(record);
      if (!after.root) throw new Error('Human identity creation completed without a visible root');
      if (after.root.name !== name) return retained(after);
      effects.out?.(`Human identity ${after.root.name} is ready.`);
      return { name: after.root.name, cid: after.root.cid, created: true };
    },
    async prepareLocalClient(record, integrations, fleetSettingsPath) {
      validateRecord(record);
      if (!Array.isArray(integrations) || !integrations.length || new Set(integrations).size !== integrations.length
          || integrations.some(name => !['codex', 'claude-code', 'fleet'].includes(name))) throw new Error('Client integrations must select codex, claude-code and/or fleet');
      if (fleetSettingsPath !== undefined) {
        if (typeof fleetSettingsPath !== 'string' || !isAbsolute(fleetSettingsPath) || resolve(fleetSettingsPath) !== fleetSettingsPath) throw new Error('Fleet settings path must be absolute');
        const settings = JSON.parse(readFileSync(fleetSettingsPath, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Fleet settings must be a JSON object');
      }
      const endpoint = `http://127.0.0.1:${record.port}`;
      const current = effects.readManagedClientProfile();
      if (current && (current.endpoint !== endpoint || current.expectedInstanceId !== record.instanceId)) throw new Error('Managed client already selects another server; no credential was issued');
      privatePath(record.root, true);
      const root = join(record.root, 'client');
      if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
      privatePath(root, true);
      const stage = mkdtempSync(join(root, '.pending-'));
      const published = join(root, 'issued-' + randomUUID());
      const credential = join(stage, 'credential');
      try {
        effects.out?.('Issuing a separate local client credential with the retained server authority.');
        try { await effects.serverAccess(record, 'access-issue', { output: credential }); }
        catch { throw new Error('Client credential issuance failed; existing profiles were retained'); }
        const stat = privatePath(credential);
        if (stat.size > 4096 || !readFileSync(credential, 'utf8').trim()) throw new Error('Issued client credential is empty or invalid');
        const profile = {
          ...validateHostProfile({ endpoint, expectedInstanceId: record.instanceId, credentialPath: join(published, 'credential') }),
          installer: { integrations: [...integrations], ...(fleetSettingsPath !== undefined ? { fleetSettingsPath } : {}) },
        };
        writeFileSync(join(stage, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        // Publish the complete pair in one rename. Managed-default activation and
        // package/source selection remain the normal client installer's job.
        renameSync(stage, published);
        effects.out?.('Local client profile is ready for authenticated client setup.');
        return { configPath: join(published, 'profile.json'), profile };
      } finally { rmSync(stage, { recursive: true, force: true }); }
    },
  };
}
