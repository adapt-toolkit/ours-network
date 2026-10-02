import { gatewayAddress } from './gateway.mjs';
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
  // CLI client commands only accept gateway profiles in current releases. Use
  // the installed SDK against the selected local daemon and its private file.
  const identityScript = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const selection = JSON.parse(process.argv[1]);
const require = createRequire(selection.anchor);
const { attachOursClient } = await import(pathToFileURL(require.resolve('@ours.network/sdk/client')).href);
const client = await attachOursClient({ endpoint: selection.endpoint,
  expectedInstanceId: selection.instanceId, credentialPath: selection.credentialPath,
  sessionMode: 'external', leaseToken: randomUUID(), env: {} });
try {
  const result = selection.operation === 'list' ? await client.listIdentities()
    : selection.operation === 'create-role' ? { created: await client.createIdentity({ name: selection.name, bio: '',
        exposeLocal: true, localAutoAccept: true }), current: await client.currentIdentity() }
    : selection.operation === 'describe-role' ? (await client.chooseIdentity({ name: selection.name, force: false }),
        { current: await client.currentIdentity() })
    : await client.createRootIdentity({ name: selection.name, bio: '',
        exposeLocal: true, localAutoAccept: true, skipIfRootExists: true });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stdout.write(JSON.stringify({ onboardingError: error.code || 'OWNER_OPERATION_FAILED' }));
} finally {
  try { await client.releaseLease(); } finally { await client.close(); }
}
`;
  async function identityCommand(record, operation, name) {
    validateRecord(record);
    const docker = record.mode === 'docker';
    const selection = {
      operation, ...(name === undefined ? {} : { name }),
      endpoint: `http://127.0.0.1:${docker ? 3050 : record.port}`,
      instanceId: record.instanceId,
      credentialPath: docker ? '/var/lib/ours/daemon-token' : join(installationPaths(record).daemon, 'daemon-token'),
      anchor: docker ? '/opt/ours/package.json' : join(record.workDir, 'package.json'),
    };
    const args = ['--input-type=module', '-e', identityScript, JSON.stringify(selection)];
    const result = docker
      ? await compose(record, ['exec', '-T', 'daemon', 'node', ...args])
      : await effects.run(process.execPath, args, { env: localEnv(record), sensitive: true });
    if (result.code !== undefined && result.code !== 0) throw new Error('Owner identity operation failed');
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new Error('Owner identity operation returned malformed JSON'); }
    if (value?.onboardingError) {
      const error = new Error('Owner identity operation failed');
      error.code = value.onboardingError;
      throw error;
    }
    return value;
  }
  async function identities(record) {
    const rows = await identityCommand(record, 'list');
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
        await identityCommand(record, 'create-root', name);
      } catch (error) {
        // A concurrent creator is safe only
        // when the authoritative list now contains a root; other errors stay errors.
        if (error.code !== 'ROOT_EXISTS') throw error;
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
    /**
     * The person's own identity under the Human root, which Messenger runs as. An identity of that name is
     * used only when the daemon itself describes it as a permanent role of exactly the retained root;
     * nothing else is renamed or adopted.
     */
    async serverEnsureMessengerIdentity(record, name) {
      validateRecord(record);
      validateIdentityName(name);
      const listed = row => row?.kind === 'role' && row.temp === null && typeof row.cid === 'string';
      const taken = () => new Error('Requested Messenger identity name is already used by another identity; no identity was changed');
      const prior = await identities(record);
      if (!prior.root) throw new Error('Messenger identity requires the Human identity; no identity was changed');
      // The list has no parent column. What the daemon describes for the identity, bound for a moment, names its root.
      const under = (current, row) => current?.name === name && current.temporary === false && current.isRoot === false
        && current.described === true && typeof current.roleId === 'string' && current.roleId !== ''
        && typeof current.cid === 'string' && current.cid === row.cid
        && typeof current.rootCid === 'string' && current.rootCid.toLowerCase() === String(prior.root.cid).toLowerCase();
      const adopt = async rows => {
        const row = rows.rows.find(candidate => candidate.name === name);
        if (rows.root?.cid !== prior.root.cid || !listed(row)) throw taken();
        const { current } = await identityCommand(record, 'describe-role', name);
        if (!under(current, row)) throw taken();
        return row;
      };
      if (prior.rows.some(row => row.name === name)) {
        const row = await adopt(prior);
        effects.out?.(`Retained Messenger identity ${name}.`);
        return { name, cid: row.cid, created: false };
      }
      effects.out?.(`Creating Messenger identity ${name} under ${prior.root.name}; retaining ${prior.rows.length} existing identities.`);
      let result;
      try {
        result = await identityCommand(record, 'create-role', name);
      } catch (error) {
        // A concurrent creator is safe only when the authoritative list now shows that name under the same root.
        const after = await identities(record);
        if (!after.rows.some(row => row.name === name)) throw error;
        const row = await adopt(after);
        return { name, cid: row.cid, created: false };
      }
      const after = await identities(record);
      const row = after.rows.find(candidate => candidate.name === name);
      if (result?.created?.hierarchy !== 'role' || result.created.underRoot !== prior.root.name || after.root?.cid !== prior.root.cid
          || !listed(row) || result.created.info?.cid !== row.cid || !under(result.current, row))
        throw new Error('Messenger identity creation completed without a usable identity under the Human identity');
      effects.out?.(`Messenger identity ${name} is ready.`);
      return { name, cid: row.cid, created: true };
    },
    async serverEnsureHumanProfile(record, human) {
      validateRecord(record);
      for (const key of ['name', 'surname']) if (typeof human[key] !== 'string' || !human[key].trim() || human[key].length > 100 || /[\x00-\x1f\x7f]/.test(human[key])) throw new Error('Invalid Messenger human profile');
      // Messenger owns the profile lifecycle. Never rename the daemon root or
      // overwrite a profile already present on a retained installation.
      const script = `
import { readFileSync } from 'node:fs';
const selection = JSON.parse(process.argv[1]);
const token = readFileSync(selection.credentialPath, 'utf8').trim();
const base = selection.base;
async function request(path, value) {
 const response = await fetch(base + '/api/' + path, { method: value === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'X-Ours-Api-Token': token, ...(value === undefined ? {} : { 'Content-Type': 'application/json', Origin: selection.origin, 'X-Ours-Messenger-CSRF': '1' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
 if (!response.ok) { await response.body?.cancel(); throw new Error('Messenger human profile operation failed (HTTP ' + response.status + ')'); }
 return response.json();
}
const identity = await request('identity');
if (identity.humanProfile) process.stdout.write('Retained Messenger Name and Surname.');
else { await request('identity/profile', selection.human); process.stdout.write('Messenger Name and Surname initialized.'); }
`;
      const docker = record.mode === 'docker';
      const selection = { base: `http://127.0.0.1:${docker ? 8420 : record.messengerPort}`,
        // Behind the gateway Messenger accepts mutations only from the gateway origin.
        origin: record.gateway ? gatewayAddress(record).origin : `http://127.0.0.1:${record.messengerPort}`,
        credentialPath: docker ? '/credentials/messenger/daemon-token' : installationPaths(record).credentials.messenger,
        human: { name: human.name, surname: human.surname } };
      const args = ['--input-type=module', '-e', script, JSON.stringify(selection)];
      const result = docker ? await compose(record, ['exec', '-T', 'messenger', 'node', ...args])
        : await effects.run(process.execPath, args, { env: localEnv(record), sensitive: true });
      if (result.code !== undefined && result.code !== 0) throw new Error('Messenger human profile initialization failed');
      effects.out?.(result.stdout);
    },
    async prepareLocalClient(record, integrations, fleetSettingsPath) {
      validateRecord(record);
      if (!Array.isArray(integrations) || new Set(integrations).size !== integrations.length
          || integrations.some(name => !['codex', 'claude-code', 'fleet'].includes(name))) throw new Error('Client integrations must select codex, claude-code and/or fleet');
      if (fleetSettingsPath !== undefined) {
        if (typeof fleetSettingsPath !== 'string' || !isAbsolute(fleetSettingsPath) || resolve(fleetSettingsPath) !== fleetSettingsPath) throw new Error('Fleet settings path must be absolute');
        const settings = JSON.parse(readFileSync(fleetSettingsPath, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Fleet settings must be a JSON object');
      }
      const serverUrl = record.gateway ? gatewayAddress(record).base : undefined;
      const endpoint = serverUrl ? `${serverUrl}/daemon` : `http://127.0.0.1:${record.port}`;
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
        if (!current) {
          effects.out?.('Issuing a separate local client credential with the retained server authority.');
          try { await effects.serverAccess(record, 'access-issue', { output: credential }); }
          catch (cause) { throw new Error('Client credential issuance failed; existing profiles were retained', { cause }); }
        }
        const retainedCredential = current?.credentialPath ?? credential;
        const stat = privatePath(retainedCredential);
        if (stat.size > 4096 || !readFileSync(retainedCredential, 'utf8').trim()) throw new Error('Issued client credential is empty or invalid');
        const profile = {
          ...validateHostProfile({ ...(serverUrl ? { serverUrl } : {}), endpoint, expectedInstanceId: record.instanceId, credentialPath: current?.credentialPath ?? join(published, 'credential') }),
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
