// The recording effects layer the orchestrator tests are written against.
//
// Shared rather than copied because this fake IS the effects contract: if it
// drifts from lib/effects.mjs, every test that uses it is testing a machine that
// does not exist. One definition, one place to notice the drift.
//
// `json`/`text` seed the filesystem; `net` seeds the probe; `harnesses` seeds
// detection; everything mutating is RECORDED rather than done — which is what
// makes it safe to walk the whole installer on a host running the live fleet.
//
// (This file lives under test/ and defines no tests of its own. Node's runner
// loads it and reports zero tests, which is the intended outcome.)
import { join, resolve } from 'node:path';

export const HOME = '/home/me';
export const OURS = resolve(HOME, '.ours');
export const TG = resolve(HOME, '.ours-tg');

export function fx({
  json = {}, text = {}, net = {}, taken = [], versions = {}, env = {}, answers = [],
  unitUnchanged = false, harnesses = [], lines = [], platform = 'linux', nodeVersion = '22.0.0',
  runFails = [], voiceReady = false, interactiveOk = true, restoreFails = [], known = [],
  restoreDoesNotTake = [], restoreChangesMode = [], packageDeps = {}, registryVersions = {},
  codexMarket = null, claudePluginInstalled = false,
  profile = null, profileVerificationError = null,
} = {}) {
  // A restore that RETURNS without the bytes landing — the case a read-back
  // catches and a returning call cannot. Distinct from `restoreFails`, which
  // throws: this one succeeds loudly and lies quietly.
  const notTaken = new Set();
  const modeDrifted = new Set();
  const recorder = { ran: [], ranEnv: [], runOptions: [], wrote: [], wroteText: [], copied: [], removedDirs: [], out: [], asked: [], askedLines: [], interactive: [], restored: [] };
  let answerIndex = 0;
  let lineIndex = 0;
  const fails = (cmd) => runFails.some((f) => cmd.join(' ').includes(f));
  return {
    packagedSourcePolicy: () => ({ packages: Object.fromEntries(
      ['sdk', 'cli', 'daemon', 'mcp', 'tg-connector', 'cowork', 'messenger-server', 'fleet', 'codex', 'claude-code']
        .map(name => [`@ours.network/${name}`, { type: 'npm', version: '2.0.1' }]),
    ) }),
    resolveSourcePolicy: async (policy, role, clients = []) => {
      const names = role === 'server' ? ['sdk', 'cli', 'daemon', 'mcp', 'tg-connector', 'cowork', 'messenger-server'] : clients;
      for (const name of names) if (!policy.packages?.[`@ours.network/${name}`]) throw new Error(`Missing source policy for @ours.network/${name}`);
      return { packages: Object.fromEntries(names.map(name => [`@ours.network/${name}`, policy.packages[`@ours.network/${name}`]])) };
    },
    withInstallationLock: async (_root, operation) => operation(),
    recorder,
    home: HOME,
    env,
    brokerUrl: 'wss://broker1.ours.network',
    version: '9.9.9',
    platform: { platform, release: '6.0.0' },
    nodeVersion,
    exists: (path) => Boolean(profile && path === env.OURS_CONFIG),
    // Detection for the selection screen. Empty by default so a test that says
    // nothing about existing daemons gets the same walk it always had: nothing
    // detected, no screen, the default state directory.
    knownStateDirs: () => known,
    username: () => 'me',
    detectHarnesses: () => harnesses,
    clipboard: () => false,
    now: () => 1,
    probe: (port) => net[port] ?? { ok: false, reason: 'connection refused' },
    isTaken: (port) => taken.includes(port),
    readJson: (p) => (Object.prototype.hasOwnProperty.call(json, p) ? json[p] : null),
    readManagedClientProfile: () => json[join(HOME, '.ours-client/profile.json')] ?? null,
    importClientProfile: ({ profile: input, sourcesPath, sources, integrations, fleetSettingsPath }) => {
      const configPath = join(HOME, '.ours-client/profile.json');
      const settings = { sourcesPath: join(HOME, '.ours-client/sources.json'), integrations,
        ...(fleetSettingsPath ? { fleetSettingsPath: join(HOME, '.ours-client/fleet-settings.json') } : {}) };
      const selected = { ...input, credentialPath: join(HOME, '.ours-client/credential') };
      json[configPath] = { ...selected, installer: settings };
      json[settings.sourcesPath] = sources ?? json[sourcesPath];
      recorder.wrote.push([configPath, JSON.stringify(json[configPath])]);
      return { configPath, profile: selected, settings };
    },
    readProfile: (path) => json[path] ?? profile,
    verifyHostProfile: async () => {
      if (profileVerificationError) throw new Error(profileVerificationError);
      return { profile, version: { instanceId: profile?.expectedInstanceId, version: 'fixture' } };
    },
    readText: (p) => (Object.prototype.hasOwnProperty.call(text, p) ? text[p] : null),
    copyDir: (from, to) => { recorder.copied.push([from, to]); },
    removeDir: (p) => { recorder.removedDirs.push(p); },
    writeJson: (p, body) => { recorder.wrote.push([p, body]); },
    writeText: (p, body) => { recorder.wroteText.push([p, body]); },
    // The rollback seam. `snapshot` returns what the file looked like before the
    // run — seeded from `json`, exactly as readJson is, so a test does not have to
    // describe the same file twice — and `restore` is RECORDED rather than done,
    // which is what lets a test assert that the bytes went back without a
    // filesystem. `restoreFails` makes the failure path reachable.
    snapshot: (p) => {
      const had = Object.prototype.hasOwnProperty.call(json, p);
      // Once a restore has been claimed but did not take, the read-back is what
      // the file ACTUALLY says — which is the whole point of reading it back.
      if (notTaken.has(p)) return { exists: true, text: had ? 'these are not the previous bytes\n' : '{}\n', mode: 0o600 };
      return { exists: had, text: had ? `${JSON.stringify(json[p], null, 2)}\n` : '', mode: modeDrifted.has(p) ? 0o644 : 0o600 };
    },
    restore: (p, snap) => {
      if (restoreFails.includes(p)) throw new Error('permission denied');
      if (restoreDoesNotTake.includes(p)) notTaken.add(p);
      if (restoreChangesMode.includes(p)) modeDrifted.add(p);
      recorder.restored.push([p, snap]);
    },
    run: async (cmd, cmdArgs, opts = {}) => {
      const invocation = [cmd, ...cmdArgs];
      recorder.ran.push(invocation);
      // Linux keeps its established unit-byte comparison. Darwin instead reads
      // the CLI's JSON `changed` field because the CLI exclusively owns the plist.
      if (cmdArgs.includes('install-service') && !unitUnchanged) {
        for (const p of Object.keys(text)) {
          if (p.includes('systemd')) text[p] = `${text[p] ?? ''}\n# rewritten`;
        }
      }
      // Recorded separately so deepEqual assertions on `ran` keep working; the
      // pair invariant is checked against this.
      recorder.ranEnv.push(opts.env ?? null);
      recorder.runOptions.push(opts);
      if (fails(invocation)) throw new Error(`${cmd} exited 1`);
      const stdout = cmdArgs.includes('install-service') && cmdArgs.includes('--json')
        ? JSON.stringify(platform === 'darwin'
          ? {
              adapter: 'launchd-user', changed: unitUnchanged ? false : true,
              unitName: 'solutions.adaptframework.ours',
              serviceFile: join(HOME, 'Library', 'LaunchAgents', 'solutions.adaptframework.ours.plist'),
            }
          : { adapter: 'systemd-user', changed: unitUnchanged ? false : true, unitName: 'ours.service' })
        : cmdArgs.includes('voice-status')
          ? JSON.stringify({ ready: voiceReady, provider: voiceReady ? 'deepgram' : '' })
          : '';
      return { ok: true, code: 0, stdout };
    },
    runInteractive: async (cmd, cmdArgs, opts = {}) => {
      recorder.interactive.push([cmd, ...cmdArgs]);
      recorder.ran.push([cmd, ...cmdArgs]);
      recorder.ranEnv.push(opts.env ?? null);
      return { ok: interactiveOk, code: interactiveOk ? 0 : 1 };
    },
    installedVersion: (pkg) => versions[pkg] ?? null,
    packageDependencies: (spec) => packageDeps[spec] ?? null,
    resolvePackageVersion: (pkg, channel) => registryVersions[`${pkg}@${channel}`] ?? (channel === 'nightly' ? '9.10.0-nightly.1' : '9.9.9'),
    codexMarketplace: async () => codexMarket,
    hasClaudePlugin: async () => claudePluginInstalled,
    installedVersions: versions,
    out: (line) => recorder.out.push(String(line)),
    ask: async (prompt) => { recorder.asked.push(prompt); return answers[answerIndex++] ?? false; },
    askLine: async (prompt, def = '') => { recorder.askedLines.push(prompt); return lines[lineIndex++] ?? def; },
  };
}

export const said = (e) => e.recorder.out.join('\n');
