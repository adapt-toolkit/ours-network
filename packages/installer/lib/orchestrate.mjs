import { enableGateway } from './gateway-transition.mjs';
import { executeLegacyMigration } from './legacy-migration.mjs';
// ours-install v3 — the orchestrator.
//
// This is the part that cannot be pure: it walks the flow, renders the screens
// and runs the commands. Everything it DECIDES comes from lib/target.mjs,
// lib/plan.mjs, lib/components.mjs, lib/rerun.mjs and lib/uninstall.mjs, which
// stay pure and separately tested.
//
// The seam is `effects`: every side effect the run can have arrives through one
// injected object, so the whole orchestration is testable without a socket, a
// filesystem, a subprocess or a terminal. That is not a testing convenience — it
// is what makes `--dry-run` trustworthy, because a dry run is the same walk with
// the mutating effects replaced by a recorder.
//
// Effects contract (all injected; the real ones live in lib/effects.mjs):
//   probe(port)            -> { ok: true, stateDir } | { ok: false, reason }
//   isTaken(port)          -> boolean
//   readJson(path)         -> object | null
//   readText(path)         -> string | null
//   writeJson(path, text)  -> void          (atomic; never called on a dry run)
//   run(cmd, args)         -> { ok, code, stdout }   (never on a dry run)
//   installedVersion(pkg)  -> string | null
//   out(line)              -> void
//   ask(prompt, default)   -> boolean       (never called when assumeYes)
//   now()                  -> number

import { basename, dirname, join, resolve } from 'node:path';
import { parseNetworkArgs, validateHostProfile, parseInstallArgs, resolveTarget, resolveProfileSelection, profileEnv, InstallUsageError } from './target.mjs';
import { clientPackageNames, selectSourcePackages, validateInstallation, SERVER_SERVICES, planDaemonConfig, planServiceInstall, serviceInstallCommand } from './plan.mjs';
import {
  COMPONENTS,
  planComponentSelection, planMcpAttachment, planTgAttachment, planCoworkAttachment,
  tgConfigPath, coworkConfigPath, summarizeComponentRun, componentSpec, componentByKey,
} from './components.mjs';
import { planHarnessPlugins, planFleet, buildHandoffPromptV3, restartHints, shellQuote } from './extras.mjs';
import { summarizeRun } from './rerun.mjs';
import { configJournal, reportRollback } from './journal.mjs';
import { detectDaemons, planDaemonSelection, resolveSelection } from './detect.mjs';
import { detectPlatform, resolveChannel } from './logic.mjs';
import { daemonEnv } from './effects.mjs';
import {
  buildClaudeMarketplace, buildCodexMarketplace, marketplaceJson, marketplacePaths,
  validateChannelVersion,
} from './marketplace.mjs';
import { USAGE } from './usage.mjs';
import { ok, info, warn, heading, banner, box, c, progress } from './ui.mjs';

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;

export async function resolveExactSuite(args, effects) {
  const packages = {};
  for (const key of ['mcp', 'claude-code', 'codex']) {
    const version = await effects.resolvePackageVersion(`@ours.network/${key}`, args.channel);
    const checked = validateChannelVersion(version, args.channel);
    if (!checked.ok) return { ok: false, reason: `${key}: ${checked.reason}` };
    packages[key] = checked.version;
  }
  const versions = new Set(Object.values(packages));
  if (versions.size !== 1) {
    return { ok: false, reason: `the ${args.channel} dist-tags are not lockstep (${Object.entries(packages).map(([k, v]) => `${k}=${v}`).join(', ')})` };
  }
  return { ok: true, channel: args.channel, version: versions.values().next().value, packages };
}

/**
 * A dry run prints what it WOULD do and performs no mutation. The prefix is the
 * existing installer's, kept so the two flows read the same.
 */
const wouldPrefix = (label) => `[dry-run] would: ${label}`;

/**
 * One mutating step. `dryRun` is checked HERE, once, rather than at each call
 * site — a side effect that forgets the check is the way a dry run stops being
 * one, and there is exactly one place to get it wrong.
 */
async function perform(effects, dryRun, label, thunk) {
  if (dryRun) {
    effects.out(info(wouldPrefix(label)));
    return { performed: false, dryRun: true };
  }
  const result = await thunk();
  effects.out(ok(label));
  return { performed: true, ...(result ?? {}) };
}

const reason = (error) => (error instanceof Error ? error.message : String(error));

function clientDiagnostic(error) {
  return reason(error)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|credential)\s*["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 700);
}

function clientRetry(effects, imported, integrations) {
  effects.out(info(`Saved server connection: ${imported.configPath}.`));
  if (integrations.includes('fleet') && !imported.settings.fleetSettingsPath) {
    effects.out(info('Saved profile and settings retained. Run ours-install, choose Connect to an existing server, and reuse the saved profile to finish the interactive Fleet configuration.'));
    return;
  }
  const args = ['client', 'install', '--config', imported.configPath, '--integrations', integrations.join(',') || 'none', '--sources', imported.settings.sourcesPath];
  if (imported.settings.fleetSettingsPath) args.push('--fleet-settings', imported.settings.fleetSettingsPath);
  const command = `ours-install client install ${args.slice(2).map((value, i) => i % 2 === 0 ? value : shellQuote(value)).join(' ')}`;
  effects.out(info(`Saved profile and settings retained; re-run ${command}`));
}

function explainClientFailure(effects, name, row) {
  const label = { codex: 'Codex', 'claude-code': 'Claude Code', fleet: 'Fleet' }[name];
  const command = name === 'claude-code' ? 'claude' : name;
  if (row?.note === 'not installed') {
    effects.out(warn(`${label}: executable not found on PATH. Install ${label} or make its executable available in this shell, then check ${command} --version before retrying.`));
  } else if (row?.manual) {
    effects.out(warn(`${label}: cannot register the plugin automatically — ${clientDiagnostic(row.note)}. Use the real executable (check ${command} --version), or register the displayed local marketplace manually.`));
  } else {
    effects.out(warn(`${label}: ${row?.failedStep ?? 'integration setup'} failed. ${clientDiagnostic(row?.detail ?? row?.note ?? 'The integration did not report successful completion. Review the messages above.')} Fix the reported command error before retrying.`));
    if (row?.failedCommand) effects.out(info(`Failed command: ${row.failedCommand.map(shellQuote).join(' ')}`));
  }
}


function semverMajor(version) {
  const match = /^(?:[~^<>= ]*)(\d+)\./.exec(String(version ?? '').trim());
  return match ? Number(match[1]) : null;
}

function incompatibleUpgrade(target, cliDependencies) {
  if (target.action !== 'update' || !target.daemonVersion) return null;
  const runningMajor = semverMajor(target.daemonVersion);
  const targetRange = cliDependencies?.['@ours.network/sdk'];
  const targetMajor = semverMajor(targetRange);
  if (runningMajor === null) {
    return { unknown: true, runningMajor: null, runningVersion: target.daemonVersion };
  }
  if (targetMajor === null) {
    return { unknown: true, runningMajor, runningVersion: target.daemonVersion };
  }
  return runningMajor !== targetMajor
    ? { unknown: false, runningMajor, runningVersion: target.daemonVersion, targetMajor, targetRange }
    : null;
}

async function prepareIncompatibleUpgrade(args, effects, target, cliPkg, mismatch) {
  const dir = target.stateDir;
  const configPath = join(dir, 'config.json');
  const owner = effects.readJson(join(dir, 'ours-cli-daemon.json'))?.owner === '@ours.network/daemon' ? ['ours-daemon'] : ['ours', 'daemon'];
  if (mismatch.unknown) {
    effects.out(warn(`ours: cannot verify whether ${cliPkg} can restore daemon v${mismatch.runningVersion}. Nothing was changed.`));
    effects.out(info('Check npm registry access and re-run; compatibility checks fail closed.'));
    return { refused: { reason: 'compatibility-unknown', exitCode: EXIT_REFUSED } };
  }

  effects.out(warn(
    `ours: daemon v${mismatch.runningVersion} cannot be restored by the requested major v${mismatch.targetMajor}; major upgrades are intentionally incompatible.`,
  ));
  if (resolve(dir) === resolve(effects.home) || dirname(resolve(dir)) === resolve(dir)) {
    effects.out(info(`Automatic purge is not available for the broad state path ${dir}. Back it up and remove it manually.`));
    return { refused: { reason: 'incompatible-major-broad-path', exitCode: EXIT_REFUSED } };
  }
  // Backups live one directory below a non-daemon container. Putting a copied
  // state beside ~/.ours under another `.ours*` name makes daemon discovery see
  // the backup as a second live target on the next installer run.
  const backupPath = join(
    dirname(dir),
    '.ours-backups',
    `${basename(dir)}-before-v${mismatch.targetMajor}-${effects.now()}`,
  );
  if (args.dryRun) {
    effects.out(info(`[dry-run] would ask to stop the old daemon, copy its complete state to ${backupPath}, remove its service/state, and initialize v${mismatch.targetMajor}.`));
    return { refused: { reason: 'incompatible-major-dry-run', exitCode: EXIT_REFUSED } };
  }
  if (args.assumeYes) {
    effects.out(info('This purge is never accepted through OURS_ASSUME_YES. Re-run interactively to confirm the backup and reset.'));
    return { refused: { reason: 'incompatible-major-unattended', exitCode: EXIT_REFUSED } };
  }
  if (effects.readJson(join(dir, 'ours-cli-daemon.json')) === null) {
    effects.out(info('The daemon is not CLI-managed. Stop its external launcher, back up and remove its state/service, then re-run the installer.'));
    return { refused: { reason: 'incompatible-major-external', exitCode: EXIT_REFUSED } };
  }
  const confirmed = await effects.ask(
    `Back up all daemon state to ${backupPath}, purge the incompatible daemon and service, and install v${mismatch.targetMajor}?`,
    false,
  );
  if (!confirmed) {
    effects.out(info(`Nothing was changed. Back up ${dir}, remove the old daemon service/state, and re-run when ready.`));
    return { refused: { reason: 'incompatible-major-declined', exitCode: EXIT_REFUSED } };
  }

  await perform(effects, false, 'stop the incompatible daemon', () => effects.run(
    owner[0], [...owner.slice(1), 'stop', '--state-dir', dir, '--config', configPath], { stream: true },
  ));
  try {
    await perform(effects, false, `back up complete daemon state to ${backupPath}`, () => effects.copyDir(dir, backupPath));
  } catch (error) {
    try {
      await effects.run(owner[0], [...owner.slice(1), 'start', '--state-dir', dir, '--config', configPath], { stream: true });
      effects.out(ok('backup failed, but the old daemon was started again'));
    } catch {
      effects.out(warn(`backup failed and the old daemon did not restart; its state is still untouched at ${dir}`));
    }
    throw error;
  }
  try {
    await perform(effects, false, 'remove the incompatible daemon boot service', () => effects.run(
      owner[0], [...owner.slice(1), 'uninstall-service', '--yes', '--state-dir', dir, '--config', configPath], { stream: true },
    ));
  } catch (error) {
    try {
      await effects.run(owner[0], [...owner.slice(1), 'start', '--state-dir', dir, '--config', configPath], { stream: true });
      effects.out(ok(`service removal failed, but the old daemon was started again; backup retained at ${backupPath}`));
    } catch {
      effects.out(warn(`service removal failed and the old daemon did not restart; state remains at ${dir} and the backup is at ${backupPath}`));
    }
    throw error;
  }
  await perform(effects, false, `remove incompatible state at ${dir}`, () => effects.removeDir(dir));
  effects.out(ok(`backup retained at ${backupPath}`));
  return { purged: true, backupPath };
}

/**
 * A step that is allowed to fail without ending the run.
 *
 * Everything after the daemon phase is an EXTRA: a harness plugin, ours-fleet,
 * voice. None of them is a reason to undo a daemon that came up correctly, and
 * v2's golden rule — never dead-end — is the same rule stated for a whole phase
 * rather than one harness. So a failure here is one honest line plus whatever
 * the caller wants to say about retrying, and the walk continues.
 */
async function attempt(effects, dryRun, label, thunk, formatReason = reason) {
  try {
    return { ok: true, ...(await perform(effects, dryRun, label, thunk)) };
  } catch (error) {
    effects.out(warn(`${label} — did not complete: ${formatReason(error)}`));
    return { ok: false, error };
  }
}

/**
 * The pair, for one child invocation, from a plan that says it can carry one.
 *
 * lib/extras.mjs states the INTENT (`env: { OURS_CONFIG }` or `{}`); daemonEnv
 * builds the whole thing. The two are deliberately not the same object: a plan
 * is pure and knows only the state directory, while a pair also needs the port,
 * and it is the half-pair — one name set, the rest defaulted to ~/.ours — that
 * silently attaches a child to a daemon the operator never chose.
 */
function pairFor(plan, target) {
  return plan && plan.env && Object.keys(plan.env).length > 0
    ? target.mode === 'host-profile' ? profileEnv(target) : daemonEnv(target.stateDir, target.port)
    : undefined;
}

/**
 * Which daemon is this run for?
 *
 * Never asks for a path, but when several daemons are detected
 * it shows them and lets the operator pick, because choosing from what was found
 * is not prompting for a state directory.
 *
 * Runs BEFORE the daemon phase and only changes `args.stateDir`. Everything
 * downstream — resolveTarget, the refusals, the journal — is untouched and does
 * not know a screen happened, which is what keeps the flags path byte-identical.
 */
export async function runSelectionPhase(args, effects) {
  const detected = detectDaemons({
    candidates: effects.knownStateDirs(),
    exists: effects.exists,
    readJson: effects.readJson,
  });
  const plan = planDaemonSelection({
    candidates: detected,
    stateDirExplicit: args.stateDirExplicit,
    portExplicit: args.portExplicit,
    assumeYes: args.assumeYes,
    home: effects.home,
  });

  if (plan.action === 'flags' || plan.action === 'create') return { ...plan, detected };
  if (plan.action === 'use') {
    // A question with one answer is not a choice, it is a keystroke tax — but the
    // operator still has to be TOLD which daemon this run is about.
    effects.out(info(`using the ours daemon at ${plan.stateDir}${plan.only.port ? ` (port ${plan.only.port})` : ''} — the only one found`));
    args.stateDir = plan.stateDir;
    return { ...plan, detected };
  }

  effects.out(heading('Which ours daemon is this for?'));
  plan.candidates.forEach((candidate, index) => {
    effects.out(`  ${index + 1}) ${candidate.stateDir}${candidate.port ? `   port ${candidate.port}` : ''}`);
  });
  if (plan.createOption.stateDir) {
    effects.out(`  ${plan.candidates.length + 1}) create a new one at ${plan.createOption.stateDir}`);
  }
  const answer = await effects.askLine(`Choose 1-${plan.candidates.length + (plan.createOption.stateDir ? 1 : 0)}: `, '1');
  const chosen = resolveSelection(answer, plan);
  if (chosen.action === 'invalid') {
    // Refused rather than guessed. Interpreting an unrecognised answer as a path
    // would reintroduce the forbidden "type a state directory" prompt through the
    // through the back door.
    effects.out(warn(`ours: ${chosen.reason}. Nothing was changed.`));
    effects.out(info('Re-run and pick one of the numbers, or name a daemon directly with --state-dir.'));
    return { action: 'refuse', exitCode: EXIT_REFUSED, detected };
  }
  args.stateDir = chosen.stateDir;
  effects.out(ok(chosen.action === 'create'
    ? `creating a new daemon at ${chosen.stateDir}`
    : `using the ours daemon at ${chosen.stateDir}`));
  return { ...chosen, detected };
}

/**
 * Run the daemon half of an installation and return the target decision plus step
 * outcomes, or a refusal.
 */
export async function runDaemonPhase(args, effects, exactSuite = null) {
  const target = await resolveTarget({
    stateDir: args.stateDir,
    port: args.port,
    portExplicit: args.portExplicit,
    probe: effects.probe,
    readJson: effects.readJson,
    readText: effects.readText,
    isTaken: effects.isTaken,
  });

  if (target.action === 'refuse') {
    effects.out(warn(`ours: refusing to continue — ${target.message}`));
    if (target.reason === 'foreign-daemon') {
      effects.out(info('Fix: re-run with --port for a free port, or with --state-dir naming the state directory that daemon actually owns.'));
    }
    if (target.reason === 'port-mismatch') {
      effects.out(info('Re-run without --port to use the recorded port. Nothing was written.'));
    }
    return { refused: target };
  }

  const dir = target.stateDir;
  let creating = target.action === 'create';
  effects.out(heading(creating ? `target ${dir} — creating a daemon here` : `target ${dir} — daemon found on port ${target.port}`));
  if (target.stalePidRecord) {
    effects.out(info(`a PID record names port ${target.stalePidRecord} but nothing answers there; treating it as stale`));
  }
  if (target.defaultPortHeldBy) {
    // Reported, never silent: the operator should know why this daemon did not
    // get the port they might have expected, and whose daemon has it.
    const held = target.defaultPortHeldBy;
    effects.out(info(`port ${held.port} is held by another ours daemon${held.stateDir ? ` (state directory ${held.stateDir})` : ''}; this one uses ${target.port}`));
  }
  if (target.reservedNotice) {
    effects.out(info(`port ${target.reservedNotice} is the Telegram connector's default port`));
  }

  // Asked ONCE, and only when this run is creating the daemon — an existing
  // daemon's broker is its own record, and re-asking would invite an operator to
  // change it from a screen that is not about changing it. The broker question
  // stays in v3: it is orthogonal to --state-dir/--port, so it
  // does not violate the rule that state-directory and port values never appear
  // in prompts.
  if (creating) args.brokerUrl = await askBroker(args, effects);

  const steps = [];

  // The operator CLI owns the shared daemon; ours-mcp is the per-session stdio
  // adapter each harness spawns. Both are required, but only `ours daemon`
  // participates in lifecycle or service management.
  const mcpPkg = exactSuite?.packages?.mcp
    ? `@ours.network/mcp@${exactSuite.packages.mcp}`
    : componentSpec(componentByKey('mcp'), args.channel);
  // Inspect the runtime package SDK compatibility before replacing the owner.
  const cliPkg = args.channel === 'nightly' ? '@ours.network/cli@nightly' : '@ours.network/cli';
  const daemonPkg = args.channel === 'nightly' ? '@ours.network/daemon@nightly' : '@ours.network/daemon';
  if (!creating && target.daemonVersion) {
    const mismatch = incompatibleUpgrade(target, effects.packageDependencies(daemonPkg));
    if (mismatch) {
      const prepared = await prepareIncompatibleUpgrade(args, effects, target, daemonPkg, mismatch);
      if (prepared.refused) return { target, refused: prepared.refused, steps };
      creating = prepared.purged === true;
      target.backupPath = prepared.backupPath;
      target.action = 'create';
    }
  }
  await perform(effects, args.dryRun, `MCP server installed (npm i -g ${mcpPkg})`, () => effects.run('npm', ['i', '-g', mcpPkg]));
  steps.push({ id: 'mcp-package', changed: true, packageRefresh: true });
  await perform(effects, args.dryRun, 'daemon runtime installed', () => effects.run('npm', ['i', '-g', daemonPkg]));
  // A retained global unit still points into the old CLI package. Rewrite and
  // activate that owned unit before npm replaces its executable with thin CLI.
  let migratedService;
  if (!creating) {
    const retained = planServiceInstall({ stateDir: dir, home: effects.home, readText: effects.readText, platform: effects.platform?.platform });
    if (retained.unitPath && effects.readText(retained.unitPath) !== null) {
      try { migratedService = await runServicePhase(args, effects, dir, target.port); }
      catch (error) { await recoverDaemon(args, effects, dir, join(dir, 'config.json'), target.port); throw error; }
      if (migratedService.refused) return { target, refused: migratedService.refused, steps };
    }
  }
  await perform(effects, args.dryRun, `ours CLI installed (npm i -g ${cliPkg})`, () => effects.run('npm', ['i', '-g', cliPkg]));
  steps.push({ id: 'cli', changed: true, packageRefresh: true });

  // The config file — merged, never rewritten, and untouched when it already
  // matches. No provenance marker is written: --purge works on any state
  // directory, so a `createdBy` key would have no consumer, and
  // an unread key in a user's config file is future confusion for nothing.
  const configPath = join(dir, 'config.json');
  const merged = planDaemonConfig(
    effects.readJson(configPath),
    { port: target.port, stateDir: dir, brokerUrl: args.brokerUrl },
  );
  // THE BYTES AND THE DAEMON THEY DESCRIBE ARE ONE UNIT OF WORK.
  //
  // config.json is written here, and only the two steps AFTER it make what it says
  // true. Without the journal, a start or a service install that failed left a
  // file naming a port nothing listens on — and the next run reads that file FIRST
  // (lib/target.mjs findDaemon), probes the wrong port, and has only the
  // ours-cli-daemon.json lookup between it and creating a SECOND daemon on this
  // state directory. Two writers on one state_data.bin is the corruption case that
  // lookup exists to prevent; this is what stops the installer from setting up the
  // conditions for it.
  const journal = configJournal(effects, { dryRun: args.dryRun });
  let serviceUnsupported = null;
  if (merged.changed) {
    journal.snapshot(configPath);
    await perform(effects, args.dryRun, `write ${configPath} (port ${target.port})`, () => effects.writeJson(configPath, merged.text));
  } else {
    effects.out(ok(`${configPath} already correct — not touched`));
  }
  steps.push({ id: 'config', changed: merged.changed, reason: merged.changed ? undefined : 'already correct' });

  try {
    if (creating) {
      await perform(effects, args.dryRun, `start the daemon on port ${target.port}`, () => effects.run('ours-daemon', [ 'start', '--config', configPath], { stream: true }));
      steps.push({ id: 'start', changed: true });
    } else {
      await perform(effects, args.dryRun, `restart the daemon on port ${target.port}`, () => effects.run('ours-daemon', [ 'restart', '--config', configPath], { stream: true }));
      steps.push({ id: 'restart', changed: true });
    }

    const service = migratedService ?? await runServicePhase(args, effects, dir, target.port);
    if (service.unsupported) serviceUnsupported = service.unsupported;
    if (service.refused) {
      // A REFUSAL IS A FAILURE TO REACH THE STATE, not a special case. An unknown
      // unit file stops the run just as a failed start does, and it stops it with
      // config.json already rewritten — indistinguishable to the operator. Same
      // rollback, same report. Every exit path that leaves written bytes
      // describing a state we did not reach gets this treatment.
      rollBack(effects, journal, args, 'the daemon did not reach the state its config describes — putting the config back');
      return { target, refused: service.refused, steps };
    }
    steps.push(service.step);
  } catch (error) {
    // THE DAEMON MAY BE DOWN, AND NOT BECAUSE ANYTHING ASKED IT TO BE.
    //
    // `install-service` can STOP a running daemon before it fails — it installs a
    // unit that will own the process, and a failure after that point leaves nothing
    // running. v3 simply ended the run there, so a person who typed ours-install
    // and got an error was also, silently, left without the daemon they had before.
    // The nightly flow re-runs `start` and, crucially, tells the two outcomes
    // apart: "the service failed but the daemon is back" is a bad evening, and "the
    // service failed AND it will not come back" is the one that needs a human now.
    const recovery = error?.servicePlan ? await recoverDaemon(args, effects, dir, configPath, target.port) : null;
    rollBack(effects, journal, args, 'the daemon did not reach the state its config describes — putting the config back', {
      replacedUnit: error?.servicePlan?.action === 'adopt' ? error.servicePlan.unitPath : null,
    });
    if (recovery) {
      effects.out(recovery.recovered
        ? ok('your daemon is running again — nothing was committed, and the service is unchanged')
        : warn('and the daemon did NOT come back up — start it yourself before anything else: '
          + `ours-daemon start --config ${configPath}`));
    }
    throw error;
  }

  return { target, steps, serviceUnsupported };
}

/**
 * Put the daemon back after a failed boot-service install.
 *
 * Only attempted when the failure came from the SERVICE step (`error.servicePlan`
 * is what says so) — a daemon that never started has nothing to recover, and
 * running `start` after a failed `start` would just fail again with a second, less
 * useful error on top of the first.
 *
 * A dry run recovers nothing because it stopped nothing. The recovery's own failure
 * is REPORTED, never thrown: the caller is already carrying the real error, and
 * losing it to a second one would hide what actually went wrong.
 */
async function recoverDaemon(args, effects, dir, configPath, port) {
  if (args.dryRun) return null;
  try {
    await effects.run('ours-daemon', [ 'start', '--config', configPath]);
    return { recovered: true };
  } catch (recoveryError) {
    return { recovered: false, reason: reason(recoveryError) };
  }
}

/**
 * One rollback, one report, one function — because a rollback whose report is
 * missing reads to the operator exactly like a run that quietly did nothing, and
 * with four call sites the way to guarantee the report is to make it impossible to
 * skip.
 *
 * Package installs are deliberately named as not-rolled-back: by every call site
 * at least one has run, and saying so is the honest boundary rather than an
 * apology.
 *
 * `replacedUnit` is the substitute for something this package must NOT do. A
 * legacy ours-mcp unit adopted under --force cannot be put back: writing unit
 * bytes into ~/.config/systemd/user would break the invariant that systemd is
 * reached only through `ours daemon install-service`, and without a daemon-reload
 * it would not even mean anything. So the unit is NAMED instead — the one
 * informational line the operator already scrolled past, repeated at the moment it
 * matters. This is a report, not a fix, and it is recorded as still-open in the
 * behaviour inventory rather than allowed to look covered.
 */
function rollBack(effects, journal, args, why, { packagesInstalled = true, replacedUnit = null } = {}) {
  if (args.dryRun) return;
  effects.out(warn(why));
  const reported = reportRollback(effects, journal.restoreAll(), { packagesInstalled });
  if (replacedUnit) {
    effects.out(warn(`${replacedUnit} was already replaced with the CLI-managed unit and is NOT restored — the older ours-mcp unit is gone. Your state directory is untouched; re-run ours-install once the cause above is fixed.`));
  }
  return reported;
}

/**
 * Install the boot service, including the legacy-unit case.
 *
 * A legacy ours-mcp unit is adopted SILENTLY, with one informational line naming
 * the file. `--force` is passed ONLY here, only for a unit
 * positively identified as ours-mcp's, and never for one we cannot identify.
 */
export async function runServicePhase(args, effects, dir, port) {
  const plan = planServiceInstall({
    stateDir: dir, home: effects.home, readText: effects.readText, platform: effects.platform?.platform,
  });
  // NOT a refusal and NOT a failure: this is retained for platforms with no CLI
  // service adapter. Linux and macOS both take the normal install path.
  if (plan.action === 'unsupported') {
    effects.out(warn(`ours: ${plan.message}`));
    effects.out(info(`Your daemon is installed and running now. To start it after a reboot, run:  ${plan.manual.join(' ')} ${join(dir, 'config.json')}`));
    effects.out(info('Nothing else in this run depends on the boot service.'));
    return { step: { id: 'service', changed: false, reason: 'not available on this platform' }, plan, unsupported: plan };
  }
  if (plan.action === 'refuse') {
    effects.out(warn(`ours: refusing to continue — ${plan.message}`));
    return { refused: plan };
  }
  const adopting = plan.action === 'adopt';
  if (adopting) effects.out(info(plan.notice));
  const command = serviceInstallCommand({ stateDir: dir, adoptLegacyUnit: adopting });
  // The service definition's bytes BEFORE are retained for Linux's established
  // reporting path. On Darwin the CLI's JSON result is authoritative because it
  // owns the LaunchAgent and launchctl transaction end to end.
  const unitBefore = plan.unitPath ? effects.readText(plan.unitPath) : null;
  let outcome;
  try {
    outcome = await perform(effects, args.dryRun, `boot service ${plan.unit} installed and enabled`, () => effects.run(command[0], command.slice(1)));
  } catch (error) {
    // The plan travels with the failure so the caller's rollback can say WHICH
    // unit was replaced. It cannot re-derive that afterwards: once --force has
    // rewritten the file, classifying it again reports a cli-managed unit and the
    // fact that a legacy one was adopted is gone.
    error.servicePlan = plan;
    throw error;
  }
  // Ours now, by the same byte comparison the CLI used to do. A dry run changed
  // nothing by definition; an unreadable file either side is treated as "changed",
  // which is the safe direction for a summary line.
  const changed = args.dryRun
    ? false
    : plan.platform === 'darwin'
      ? readChanged(outcome.stdout)
      : (() => {
          const after = plan.unitPath ? effects.readText(plan.unitPath) : null;
          if (unitBefore === null || after === null) return true;
          return unitBefore !== after;
        })();
  return { step: { id: 'service', changed, reason: changed ? undefined : 'unit unchanged' }, plan };
}

// The CLI's --json plan, when we can read it. Deliberately lenient: this is a
// summary line, not a decision, and it must never throw on unexpected output.
function readChanged(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return true;
  try {
    const parsed = JSON.parse(stdout);
    return typeof parsed?.changed === 'boolean' ? parsed.changed : true;
  } catch {
    return true;
  }
}

/**
 * THE QUESTION NOBODY WAS ASKING.
 *
 * The public installer has one product, not a package-selection questionnaire:
 * MCP, Telegram, and cowork are all installed. Explicit injected answers remain
 * only as a compatibility/test seam for callers that deliberately omit a piece.
 */
export async function askComponents(args, effects) {
  // The product is the complete stack. Asking the operator to reconstruct that
  // product from package names was choice theatre and made unattended installs
  // incomplete. Explicit injected answers remain a test/compatibility seam.
  return { ...(args.answers ?? {}) };
}

/**
 * A component that fails is reported with its retry command and
 * the run CONTINUES — a failed component is never a reason to undo a successful
 * one, or to undo the daemon.
 */
export async function runComponentPhase(args, effects, target, exactSuite = null) {
  const dir = target.stateDir;
  const endpoint = `http://127.0.0.1:${target.port}`;
  const isDefaultStateDir = dir === join(effects.home, '.ours');
  const answers = await askComponents(args, effects);
  const chosen = planComponentSelection({
    answers,
    installed: args.installed ?? {},
    assumeYes: args.assumeYes,
  });

  const results = [];
  for (const component of chosen) {
    if (component.action === 'skip' || component.action === 'leave-alone') {
      effects.out(info(`${component.label} — ${component.action === 'skip' ? 'not installed' : 'left as it is'}`));
      results.push({ key: component.key, state: 'skipped' });
      continue;
    }
    try {
      results.push(await attachComponent(component, { args, effects, dir, endpoint, isDefaultStateDir, exactSuite }));
    } catch (error) {
      // Reported with its reason and the exact manual command; the run continues.
      // The retry carries the CHANNEL — a nightly run that hands the operator a
      // stable retry command sends them straight into the split-brain install
      // this phase exists to avoid.
      const retrySpec = component.key === 'mcp' && exactSuite?.packages?.mcp
        ? `@ours.network/mcp@${exactSuite.packages.mcp}` : componentSpec(component, args.channel);
      const retry = `npm i -g ${retrySpec}`;
      effects.out(warn(`${component.label} failed: ${error instanceof Error ? error.message : String(error)}`));
      effects.out(info(`retry manually: ${retry}`));
      results.push({ key: component.key, state: 'failed', reason: String(error?.message ?? error), retry });
    }
  }
  return summarizeComponentRun(results);
}

async function attachComponent(component, { args, effects, dir, endpoint, isDefaultStateDir, exactSuite }) {
  if (component.key === 'mcp') {
    const plan = planMcpAttachment({ stateDir: dir, isDefaultStateDir, channel: args.channel });
    const exact = exactSuite?.packages?.mcp ? `@ours.network/mcp@${exactSuite.packages.mcp}` : plan.install[3];
    await perform(effects, args.dryRun, `install ${exact}`, () => effects.run('npm', ['i', '-g', exact]));
    if (Object.keys(plan.harnessEnv).length > 0) {
      effects.out(info(`harness registration carries OURS_CONFIG=${plan.harnessEnv.OURS_CONFIG}`));
    }
    return { key: 'mcp', state: 'installed' };
  }

  if (component.key === 'tg') {
    const path = tgConfigPath(effects.home, effects.env);
    const plan = planTgAttachment({
      existing: effects.readJson(path),
      endpoint,
      stateDir: dir,
      brokerUrl: args.brokerUrl,
      assumeYes: args.assumeYes,
      channel: args.channel,
    });
    if (plan.action === 'skip-repoint') {
      effects.out(info('the Telegram connector points at another daemon; never repointed non-interactively'));
      return { key: 'tg', state: 'skipped' };
    }
    if (plan.action === 'confirm-repoint') {
      // Moving a connector is not recoverable by re-running the way a replaced
      // unit file is: the operator's routes would be talking to a daemon they
      // never chose. So this one asks.
      if (!(await effects.ask(plan.prompt, false))) {
        effects.out(info('left where it is'));
        return { key: 'tg', state: 'skipped' };
      }
    }
    await perform(effects, args.dryRun, `install ${plan.install[3]}`, () => effects.run(plan.install[0], plan.install.slice(1)));
    const journal = configJournal(effects, { dryRun: args.dryRun });
    if (plan.changed) {
      journal.snapshot(path);
      await perform(effects, args.dryRun, `write ${path}`, () => effects.writeJson(path, `${JSON.stringify(plan.config, null, 2)}\n`));
    } else {
      effects.out(ok(`${path} already points here — not touched`));
    }
    try {
      await perform(effects, args.dryRun, 'Telegram connector service installed', () => effects.run(plan.service[0], plan.service.slice(1)));
    } catch (error) {
      rollBack(effects, journal, args, 'the Telegram connector service did not come up — putting its daemon selection back');
      throw error;
    }
    effects.out(ok('Telegram connector installed as a durable service on the shared daemon.'));
    return { key: 'tg', state: 'installed', note: 'configured; service running' };
  }

  const path = coworkConfigPath(effects.home, effects.env);
  // cowork is the ONE component installed before its plan exists, because the
  // version floor applies to what is now on disk rather than what was requested
  // — so the spec is built here rather than read off the plan. It still goes
  // through componentSpec, so the channel reaches it like every other package.
  const spec = componentSpec(component, args.channel);
  await perform(effects, args.dryRun, `install ${spec}`, () => effects.run('npm', ['i', '-g', spec]));
  // The installed version is read AFTER installing, because the floor applies to
  // what is now on disk rather than what was requested. Read by the BARE package
  // name: `npm ls -g` knows nothing about the dist-tag it was installed from.
  const plan = planCoworkAttachment({
    existing: effects.readJson(path),
    endpoint,
    stateDir: dir,
    installedVersion: effects.installedVersion(component.pkg),
    channel: args.channel,
    // The broker is a value the INSTALLER knows and cowork cannot guess — the one
    // the operator chose in this run. `home` is for cowork's OWN state directory,
    // never the daemon's.
    brokerUrl: args.brokerUrl,
    home: effects.home,
  });
  if (plan.action === 'refuse' || plan.action === 'leave-embedded') {
    effects.out(warn(`cowork: ${plan.message}`));
    return { key: 'cowork', state: 'skipped', reason: plan.reason };
  }
  // Same unit of work, and cowork's version is the worse failure: its boot is
  // fail-closed on this block, so a written block with a service that never came up
  // does not fall back to embedded mode — it does not start at all.
  const journal = configJournal(effects, { dryRun: args.dryRun });
  if (plan.changed) {
    journal.snapshot(path);
    await perform(effects, args.dryRun, `write ${path}`, () => effects.writeJson(path, `${JSON.stringify(plan.config, null, 2)}\n`));
  } else {
    effects.out(ok(`${path} already points here — not touched`));
  }
  try {
    await perform(effects, args.dryRun, 'cowork service installed', () => effects.run(plan.service[0], plan.service.slice(1)));
  } catch (error) {
    rollBack(effects, journal, args, 'the cowork service did not come up — putting its config back, which leaves cowork embedded as it was');
    throw error;
  }
  return { key: 'cowork', state: 'installed' };
}

/**
 * The broker question (v2's Step 0a, deliberately kept).
 *
 * Consent-first, with the undo built in: a mistaken custom address is one
 * keystroke back to the standard broker, because the alternative is an operator
 * whose agents cannot find each other and no obvious way back.
 */
export async function askBroker(args, effects) {
  const standard = args.brokerUrl;
  // Custom deployments remain available through OURS_BROKER_URL. The ordinary
  // install is intentionally linear and explains the standard safe default.
  effects.out(info(effects.env.OURS_BROKER_URL
    ? 'All services use the end-to-end encrypted broker configured in OURS_BROKER_URL.'
    : 'All services use the standard end-to-end encrypted ours broker.'));
  return standard;
}

/**
 * Pre-flight: the two disasters worth catching before anything is touched.
 *
 * Carried over from the v2 body deliberately. Native Windows and a Node older
 * than 22 are not "the install went badly", they are "this cannot work here",
 * and finding that out after the daemon package is on disk helps nobody.
 *
 * NOT carried over: v2 also exited when no harness was found. Under v3 the
 * daemon is the product and the harness plugins are one extra among several, so
 * a machine with no harness still gets a working daemon and is told what is
 * missing. That is a deliberate divergence from v2, recorded here rather than
 * discovered.
 */
export function runPreflight(effects) {
  effects.out(heading('Checking your machine'));
  const plat = detectPlatform({
    platform: effects.platform?.platform,
    release: effects.platform?.release ?? '',
    env: effects.env,
  });
  if (!plat.supported) {
    if (plat.os === 'windows') {
      effects.out(warn(`${plat.label} isn't supported directly yet.`));
      effects.out(info('Install this inside WSL (Windows Subsystem for Linux), then re-run there:'));
      effects.out(info('https://learn.microsoft.com/windows/wsl/install'));
    } else {
      effects.out(warn(`Platform "${plat.label}" isn't supported. ours runs on Linux, macOS, or WSL.`));
    }
    return { ok: false, platform: plat };
  }
  effects.out(ok(`Platform: ${plat.label} (supported)`));
  const version = String(effects.nodeVersion ?? '0');
  if (Number.parseInt(version.split('.')[0], 10) < 22) {
    effects.out(warn(`Node.js ${version} — ours needs v22 or newer. Update Node and re-run.`));
    return { ok: false, platform: plat, node: version };
  }
  effects.out(ok(`Node.js ${version}`));
  return { ok: true, platform: plat, node: version };
}

/**
 * The human identity: `ours identity create-root`.
 *
 * It needs the operator CLI and a reachable daemon. Already-exists is a friendly keep, never an error, and
 * an unreachable daemon gets the exact retry command rather than "ask your agent
 * later"; the hand-off's identity step is the fallback for both failures.
 */
export async function runIdentityPhase(args, effects, { target, mcpReady }) {
  effects.out(heading('Your human identity'));
  if (!mcpReady) {
    effects.out(info('this needs the MCP server, which this run did not install — re-run ours-install to add both.'));
    return { key: 'identity', label: 'Human identity', state: 'skipped', note: 'no MCP server' };
  }
  effects.out(info('This is you — the human. Your agents act on your behalf, and it lets you message'));
  effects.out(info('people. (Internally this is your ours root; you just give it a name.)'));

  const fallback = effects.username();
  const name = (args.assumeYes
    ? fallback
    : String(await effects.askLine(`What name should others see?  [${fallback}]: `, fallback) || fallback)).trim() || fallback;

  const env = daemonEnv(target.stateDir, target.port);
  if (args.dryRun) {
    effects.out(info(wouldPrefix(`ours identity create-root --name "${name}"`)));
    return { key: 'identity', label: 'Human identity', state: 'installed', note: name };
  }
  try {
    await effects.run('ours', ['identity', 'create-root', '--name', name, '--json'], { env });
    effects.out(ok(`Your human identity "${name}" is created.`));
    return { key: 'identity', label: 'Human identity', state: 'installed', note: name };
  } catch (error) {
    const text = reason(error);
    if (/already exists/.test(text)) {
      effects.out(ok('You already have a human identity — keeping it.'));
      return { key: 'identity', label: 'Human identity', state: 'current', note: 'existing identity kept' };
    }
    if (/not running|not reachable|ECONNREFUSED|connect/i.test(text)) {
      effects.out(warn("The daemon isn't reachable yet — couldn't create your human identity."));
      effects.out(info(`Fix: run 'ours-daemon start --config ${env.OURS_CONFIG}', then 'ours identity create-root --config ${env.OURS_CONFIG} --name "${name}"'.`));
      return { key: 'identity', label: 'Human identity', state: 'failed', note: 'daemon not reachable' };
    }
    effects.out(warn(`Couldn't create your human identity: ${text.split('\n')[0]}`));
    effects.out(info(`Retry any time: 'ours identity create-root --config ${env.OURS_CONFIG} --name "${name}"'.`));
    return { key: 'identity', label: 'Human identity', state: 'failed', note: 'create-root failed' };
  }
}

/**
 * Install harness plugins after the daemon and components are ready.
 *
 * Two things this phase must never do, both inherited rules rather than new
 * ones. It never DRIVES a command it could not identify — an alias or a wrapper
 * that would not answer `--version` is printed as manual steps instead. And it
 * never CLAIMS the pair travelled when it did not: Claude Code's and Codex's
 * registrations cannot carry a value, so for a non-default state directory they
 * get the exact export line and no promise. Hermes' writer is ours, so its
 * invocation carries the whole pair and the claim is true.
 */
export async function runHarnessPhase(args, effects, { target, isDefaultStateDir, exactSuite = null }) {
  effects.out(heading('Harness plugins'));
  const detected = (await effects.detectHarnesses()).filter(h => !args.clientIntegrations || args.clientIntegrations.includes(h.name));
  for (const name of args.clientIntegrations ?? []) {
    if (name !== 'fleet' && !detected.some(h => h.name === name)) detected.push({ name, status: 'absent' });
  }
  for (const h of detected) {
    if (h.status === 'ok') effects.out(ok(`'${h.command ?? h.name}'  → ${h.detail ?? 'real program'} (its plugin can be installed)`));
    else if (h.status === 'alias') effects.out(warn(`'${h.command ?? h.name}'  → ${h.detail} (I won't call it — manual steps below)`));
    else if (h.status === 'unsafe') effects.out(warn(`'${h.command ?? h.name}'  → on your PATH but didn't answer safely (manual steps below)`));
    else effects.out(info(`'${h.command ?? h.name}'  → not installed (skipped)`));
  }
  if (detected.every((h) => h.status === 'absent')) {
    effects.out(info('No Claude Code, Codex or Hermes found — install one and re-run to wire it up.'));
    effects.out(info('Your daemon is unaffected; nothing else in this run depends on a harness.'));
    return args.clientIntegrations ? detected.map(h => ({ key: h.name, state: 'skipped', note: 'not installed' })) : [];
  }

  const plans = planHarnessPlugins({
    harnesses: detected.map((h) => ({ name: h.name, status: h.status })),
    stateDir: target.stateDir,
    isDefaultStateDir,
    configPath: target.mode === 'host-profile' ? target.configPath : null,
    channel: args.channel,
    assumeYes: true,
    answers: {},
  });

  const rows = [];
  const markets = marketplacePaths(effects.home);
  for (const plan of plans) {
    const row = { key: plan.name, label: `${plan.label} plugin` };
    if (plan.action === 'skip') {
      if (plan.reason !== 'not installed') effects.out(info(`${plan.label} — ${plan.reason}`));
      rows.push({ ...row, state: 'skipped', note: plan.reason });
      continue;
    }
    if (plan.action === 'manual' && exactSuite?.localPackages?.[plan.name]) {
      const root = await effects.prepareClientMarketplace(plan.name, exactSuite.localPackages[plan.name]);
      effects.out(warn(`${plan.label} requires manual registration of exact local marketplace ${root}; ${target.managed ? 'the saved client default is retained' : `keep OURS_CONFIG=${target.configPath}`}.`));
      rows.push({ ...row, state: 'failed', note: plan.reason, manual: true });
      continue;
    }
    if (plan.action === 'manual') {
      // NEVER a dead end: the plugin is still installable, by hand, and the run
      // says so instead of pretending the harness does not exist.
      let manual = plan.manual;
      if (exactSuite && (plan.name === 'claude-code' || plan.name === 'codex')) {
        const isClaude = plan.name === 'claude-code';
        const root = isClaude ? markets.claudeRoot : markets.codexRoot;
        const manifest = isClaude ? markets.claudeManifest : markets.codexManifest;
        const value = isClaude
          ? buildClaudeMarketplace(exactSuite.packages['claude-code'], exactSuite.channel)
          : buildCodexMarketplace(exactSuite.packages.codex, exactSuite.channel);
        await perform(effects, args.dryRun, `write exact ${plan.name} marketplace ${manifest}`, () => effects.writeJson(manifest, marketplaceJson(value)));
        manual = isClaude
          ? [`/plugin marketplace add ${root}`, '/plugin install ours']
          : [`codex plugin marketplace add ${root}`, 'codex plugin add ours@ours-codex-marketplace', `npm i -g @ours.network/codex@${exactSuite.packages.codex}`];
      }
      effects.out(warn(`${plan.label} — ${plan.reason}; install it yourself with:`));
      for (const step of manual) effects.out(info(`  ${step}`));
      if (plan.envLine) effects.out(info(`Before later native launches, set:  ${plan.envLine}`));
      rows.push({ ...row, state: 'skipped', note: plan.reason, manual: true });
      continue;
    }

    let steps = plan.steps;
    let manual = plan.manual;
    if (exactSuite?.localPackages?.[plan.name]) {
      const registration = await effects.prepareClientMarketplace(plan.name, exactSuite.localPackages[plan.name]);
      const steps = plan.name === 'codex'
        ? [['codex', 'plugin', 'marketplace', 'add', registration], ['codex', 'plugin', 'add', 'ours@ours-codex-marketplace']]
        : [['claude', 'plugin', 'marketplace', 'add', registration], ['claude', 'plugin', await effects.hasClaudePlugin() ? 'update' : 'install', 'ours@ours.network']];
      let failure = null;
      for (const step of steps) {
        const outcome = await attempt(effects, false, step.join(' '), () => effects.run(step[0], step.slice(1), { env: profileEnv(target) }), clientDiagnostic);
        if (!outcome.ok) {
          failure = { failedCommand: step, failedStep: step[2] === 'marketplace' ? `Register ${plan.label} marketplace` : `Install ${plan.label} plugin`, detail: clientDiagnostic(outcome.error) };
          break;
        }
      }
      effects.out(info(target.managed ? `Native ${plan.name} launches use the saved client default.` : `Native ${plan.name} launches must retain OURS_CONFIG=${target.configPath}.`));
      rows.push({ ...row, state: failure ? 'failed' : 'installed', ...(failure ?? {}) });
      continue;
    }

    if (exactSuite && (plan.name === 'claude-code' || plan.name === 'codex')) {
      const isClaude = plan.name === 'claude-code';
      const root = isClaude ? markets.claudeRoot : markets.codexRoot;
      const manifest = isClaude ? markets.claudeManifest : markets.codexManifest;
      const value = isClaude
        ? buildClaudeMarketplace(exactSuite.packages['claude-code'], exactSuite.channel)
        : buildCodexMarketplace(exactSuite.packages.codex, exactSuite.channel);
      await perform(effects, args.dryRun, `write exact ${plan.name} marketplace ${manifest}`, () => effects.writeJson(manifest, marketplaceJson(value)));
      if (!isClaude) {
        const current = await effects.codexMarketplace();
        const source = current?.marketplaceSource;
        if (current && !(source?.sourceType === 'local' && source?.source === root)) {
          await perform(effects, args.dryRun, 'remove moving Codex marketplace source', () => effects.run('codex', ['plugin', 'marketplace', 'remove', 'ours-codex-marketplace']));
        }
      }
      steps = isClaude
        ? [['claude', 'plugin', 'marketplace', 'add', root], ['claude', 'plugin', await effects.hasClaudePlugin() ? 'update' : 'install', 'ours@ours.network']]
        : [['codex', 'plugin', 'marketplace', 'add', root], ['codex', 'plugin', 'add', 'ours@ours-codex-marketplace'], ['npm', 'i', '-g', `@ours.network/codex@${exactSuite.packages.codex}`]];
      manual = isClaude
        ? [`/plugin marketplace add ${root}`, '/plugin install ours']
        : [`codex plugin marketplace add ${root}`, 'codex plugin add ours@ours-codex-marketplace', `npm i -g @ours.network/codex@${exactSuite.packages.codex}`];
    }

    const env = pairFor(plan, target);
    let failed = null;
    for (const step of steps) {
      const outcome = await attempt(effects, args.dryRun, step.join(' '), () => effects.run(step[0], step.slice(1), env ? { env } : {}));
      if (!outcome.ok) { failed = outcome; break; }
    }
    if (failed) {
      effects.out(info(`${plan.label} can still be installed by hand:`));
      for (const step of manual) effects.out(info(`  ${step}`));
      rows.push({ ...row, state: 'failed', note: 'install step failed' });
      continue;
    }
    if (plan.envLine) {
      // This harness cannot persist the selected daemon pair. Say exactly what is
      // true and how the operator can configure it explicitly.
      effects.out(warn(`${plan.label}'s registration cannot carry a value, so it will attach to the DEFAULT daemon.`));
      effects.out(info(`Add this to your shell profile so it uses this one instead:  ${plan.envLine}`));
    }
    rows.push({ ...row, state: 'installed', note: plan.envLine ? 'needs the env line above' : 'ready' });
  }
  return rows;
}

/** Install Fleet and let its interactive wizard publish the owned configuration. */
export async function runFleetPhase(args, effects, { target, isDefaultStateDir }) {
  effects.out(heading('ours-fleet (your always-online agent team)'));
  effects.out(info('This makes your harnesses PERSISTENT: they stop being just a terminal session and'));
  effects.out(info('become always-online agents that survive a reboot.'));
  const plan = planFleet({
    home: effects.home, stateDir: target.stateDir, isDefaultStateDir,
    configPath: target.mode === 'host-profile' ? target.configPath : null,
    settingsPath: args.fleetSettingsPath ?? null,
    wanted: true, channel: args.channel,
  });
  if (plan.action === 'skip') {
    effects.out(info('skipped cleanly — re-run ours-install any time to add it.'));
    return { key: 'fleet', label: plan.label, state: 'skipped' };
  }
  const install = args.acquiredFleet ? { ok: true } : await attempt(effects, args.dryRun, plan.install.join(' '), () => effects.run(plan.install[0], plan.install.slice(1)));
  // Fleet owns its v2 manifest, roles, models and permissions. With no prepared
  // settings, its wizard keeps the user's terminal while this invocation carries
  // the selected daemon; --settings makes the same call strictly noninteractive.
  const initEnv = target.mode === 'host-profile' ? profileEnv(target) : daemonEnv(target.stateDir, target.port);
  const initRunner = args.fleetSettingsPath ? effects.run : effects.runInteractive;
  const init = install.ok
    ? await attempt(effects, args.dryRun, `${plan.init.join(' ')} (${args.fleetSettingsPath ? 'prepared' : 'interactive'} Fleet configuration)`, async () => {
      const result = await initRunner(args.acquiredFleet || plan.init[0], plan.init.slice(1), { env: initEnv });
      if (!result?.ok) throw new Error(`ours-fleet init exited ${result?.code ?? 'without a status'}`);
      return result;
    })
    : install;
  if (!init.ok) {
    const selection = target.mode === 'host-profile'
      ? `OURS_CONFIG=${shellQuote(target.configPath)} ` : '';
    effects.out(info(`retry manually: ${selection}${plan.init.map(shellQuote).join(' ')}`));
    return { key: 'fleet', label: plan.label, state: 'failed', note: 'ours-fleet init failed' };
  }
  if (!args.dryRun && effects.readText(plan.configPath) === null) {
    effects.out(warn(`Fleet initialization returned without publishing ${plan.configPath}; configuration was not published.`));
    return { key: 'fleet', label: plan.label, state: 'failed', note: 'Fleet configuration was not published' };
  }
  effects.out(ok('ours-fleet installed and initialized; no fleet roles were started.'));
  if (plan.instruction) effects.out(info(plan.instruction));
  return { key: 'fleet', label: plan.label, state: 'installed', note: `configured at ${plan.configPath}; stopped` };
}

/** Voice configuration belongs to the shared daemon, not the MCP adapter. */
export async function runVoicePhase(args, effects, { target, mcpReady }) {
  effects.out(heading('Voice messages'));
  effects.out(info('Voice transcription setup is not managed by ours-mcp. Existing daemon configuration is left unchanged.'));
  return { key: 'voice', label: 'Voice transcription', state: 'skipped', note: 'configure on the shared daemon' };
}

/**
 * The final screen and the copy-paste hand-off.
 *
 * The hand-off is the installer's actual product: everything it could not do
 * conversationally is handed to an agent that can. Steps for pieces this run did
 * not install drop out and the rest renumber, so nobody is told to configure
 * something they do not have.
 */
export async function endScreen(args, effects, { summary, target, isDefaultStateDir, brokerUrl }) {
  const rule = '═'.repeat(64);
  effects.out('');
  effects.out(`  ${c.cyan(rule)}`);
  effects.out(`  ${c.bold('ours.network — install complete')}`);
  effects.out(`  ${c.gray(`State directory: ${target.stateDir}   •   Port: ${target.port}`)}`);
  effects.out(`  ${c.gray(`Broker: ${brokerUrl === effects.brokerUrl ? 'standard' : 'custom'}`)}`);
  effects.out(`  ${c.cyan(rule)}`);
  for (const row of summary) {
    const mark = row.state === 'failed' ? c.red('✗') : row.state === 'skipped' ? c.gray('·') : c.green('✓');
    const state = (row.state === 'installed' || row.state === 'current')
      ? (row.note || 'ready')
      : row.state === 'skipped'
        ? c.gray(`skipped${row.note ? ` (${row.note})` : ''}`)
        : c.red(`needs attention${row.note ? ` — ${row.note}` : ''}`);
    effects.out(`  ${mark} ${String(row.label).padEnd(26)}${(row.version ? `v${row.version}` : '').padEnd(9)}${state}`);
  }
  effects.out('');
  effects.out(summary.some((r) => r.state === 'failed')
    ? `  ${c.yellow('Some pieces need a hand — see the notes above; re-run ours-install after fixing.')}`
    : `  ${c.green('Everything installed cleanly. No problems.')}`);

  // Said BEFORE the hand-off prompt, because it is the only thing here the
  // operator must do himself for any of the rest to work. A harness that was
  // running when its plugin landed spawns no ours MCP server until it restarts,
  // and someone who goes back to that harness, finds no ours tools and reads a
  // successful install as a failed one is the exact outcome this prevents.
  const restarts = restartHints(summary);
  if (restarts.length > 0) {
    effects.out('');
    effects.out(`  ${c.bold('Before this works:')} your harness spawns the ours MCP server when it starts, so`);
    effects.out('  a harness that was already open has not picked it up yet.');
    for (const hint of restarts) effects.out(`  ${c.green('→')} ${hint.action}`);
  }

  const has = (key) => summary.some((r) => r.key === key && (r.state === 'installed' || r.state === 'current'));
  if (has('fleet')) {
    effects.out('');
    effects.out(`  ${c.bold('Installed but intentionally stopped')}`);
    if (has('fleet')) {
      effects.out(`  ${c.gray('• Fleet: review the generated coordinator/watchdog config, then run')}`);
      effects.out(`    ${c.cyan('ours-fleet doctor && ours-fleet config && ours-fleet up')}`);
      effects.out(`    ${c.cyan('ours-fleet ls')}`);
    }
  }

  const { text, empty } = buildHandoffPromptV3({
    identity: !has('identity'),
    fleet: has('fleet'),
    telegram: has('tg'),
    stateDir: target.stateDir,
    isDefaultStateDir,
  });
  if (empty) {
    effects.out('');
    effects.out(`  ${c.green("You're all set — open your harness and just start talking to your agent.")}`);
  } else {
    effects.out('');
    effects.out(`  ${c.gray('─'.repeat(64))}`);
    effects.out(`  ${c.bold('ONE LAST STEP')} — paste this prompt into Claude Code, Codex, or Hermes.`);
    effects.out(`  ${c.gray('─'.repeat(64))}`);
    effects.out('');
    effects.out(box(text.split('\n'), 'paste this into your agent'));
    if (!args.dryRun && effects.clipboard(text)) effects.out(`  ${c.gray('(copied to your clipboard.)')}`);
  }
  effects.out('');
  effects.out(`  ${c.gray('Re-run  ')}${c.cyan('ours-install')}${c.gray('  any time to add a skipped piece or update.')}`);
  effects.out(`  ${c.cyan(rule)}`);
}

/**
 * The whole run. Returns an exit code: 0, or 2 for any refusal.
 *
 * The order is not arbitrary and is the one thing here worth reading twice:
 *
 *   daemon → components → identity → harness plugins → ours-fleet → voice
 *
 * The daemon comes first because everything else attaches to one. The COMPONENTS
 * come second because `ours-mcp` is what the identity step and the voice step
 * both invoke, and under v3 it is a component rather than the daemon — so
 * anything that shells out to it has to wait for this phase, which is exactly
 * why v2's placement of those two steps could not simply be carried across.
 *
 * Every refusal in this specification applies unchanged in non-interactive mode
 * and exits 2 without writing anything — OURS_ASSUME_YES suppresses questions,
 * never a refusal.
 */
export async function runInstall(argv, effects) {
  if (!argv.length && effects.interactive) {
    const selection = await effects.askLine('Install server (packages/docker) or connect client (client/profile path): ', effects.readManagedClientProfile() ? 'client' : 'packages');
    if (['packages', 'docker'].includes(selection)) {
      const root = await effects.askLine('Private installation root: ', join(effects.home, '.ours-install'));
      argv = ['server', 'install', '--mode', selection, '--state-dir', root];
    } else argv = ['client', 'install', ...(selection === 'client' ? [] : ['--config', selection])];
  }
  if (['server', 'client'].includes(argv[0])) {
    try {
      const command = parseNetworkArgs(argv);
      if (command.role === 'server') return await runServerCommand(command, effects);
      return await runClientCommand(command, effects);
    } catch (error) {
      effects.out(warn(`ours-install: ${reason(error)}`));
      return EXIT_REFUSED;
    }
  }
  let args;
  try {
    args = parseInstallArgs(argv, effects.env, { home: effects.home });
  } catch (error) {
    if (error instanceof InstallUsageError) {
      effects.out(warn(`ours: ${error.message}`));
      return EXIT_REFUSED;
    }
    throw error;
  }
  if (args.help) { effects.out(USAGE); return EXIT_OK; }
  if (args.version) { effects.out(`ours-install v${effects.version ?? '?'}`); return EXIT_OK; }

  args.brokerUrl = args.brokerUrl ?? effects.brokerUrl;
  // THE INSTALLER'S OWN VERSION IS THE CHANNEL SIGNAL WHEN NOTHING SAYS OTHERWISE.
  //
  // resolveChannel falls back to `selfVersion` only when the environment is
  // silent, and this call passed no selfVersion — so a NIGHTLY installer with no
  // OURS_CHANNEL set resolved to `latest` and installed the whole stack at latest.
  // That is what put fleet@latest and a stable ours-mcp on a nightly machine.
  //
  // The v2 bin has always done this correctly (install.mjs:53 passes pkgVersion());
  // the v3 orchestrator dropped the argument. @ours.network/install is published on
  // BOTH dist-tags from one lockstep bump, so its own version is the only thing
  // that distinguishes a nightly installer from a stable one when the operator has
  // said nothing.
  args.channel = resolveChannel(effects.env.OURS_CHANNEL ?? effects.env.OURS_INSTALL_CHANNEL, effects.version);

  effects.out(banner());
  effects.out(heading(`ours: target ${args.stateDir}${args.portExplicit ? `, port ${args.port}` : ''}`));
  if (args.dryRun) effects.out(info('dry-run: nothing will be installed or changed'));
  effects.out(progress(1, 8, 'Check the host', 'Verify the platform and Node.js before changing anything.'));

  // An unsupported platform is not a refusal of an incoherent selection, it is a
  // machine this cannot run on. v2 exited 0 there and so does this, so a script
  // that wrapped the old installer keeps its meaning.
  if (!runPreflight(effects).ok) return EXIT_OK;

  const exactSuite = await resolveExactSuite(args, effects);
  if (!exactSuite.ok) {
    effects.out(warn(`Release suite could not be resolved safely: ${exactSuite.reason}. Nothing was changed.`));
    return EXIT_REFUSED;
  }
  effects.out(ok(`Release channel: ${exactSuite.channel} → exact lockstep suite v${exactSuite.version}`));

  let profileSelection;
  try {
    profileSelection = resolveProfileSelection({
      args, env: effects.env, home: effects.home, exists: effects.exists, readProfile: effects.readProfile,
    });
  } catch (error) {
    if (error instanceof InstallUsageError) {
      effects.out(warn(`ours: ${error.message}. Nothing was changed.`));
      return EXIT_REFUSED;
    }
    throw error;
  }
  if (profileSelection.mode === 'host-profile') {
    try {
      await effects.verifyHostProfile(profileSelection.configPath);
    } catch (error) {
      effects.out(warn(`External daemon validation failed: ${reason(error)}. Nothing was changed.`));
      return EXIT_REFUSED;
    }
    const target = { ...profileSelection, endpoint: profileSelection.profile.endpoint };
    effects.out(ok(`Validated external daemon at ${target.endpoint}; installing client attachments only.`));
    const summary = [];
    const mcp = await attempt(effects, args.dryRun, `npm i -g @ours.network/mcp@${exactSuite.packages.mcp}`,
      () => effects.run('npm', ['i', '-g', `@ours.network/mcp@${exactSuite.packages.mcp}`]));
    summary.push({ key: 'mcp', label: 'MCP client', state: mcp.ok ? 'installed' : 'failed' });
    summary.push(...await runHarnessPhase(args, effects, { target, isDefaultStateDir: false, exactSuite }));
    summary.push(await runFleetPhase(args, effects, { target, isDefaultStateDir: false }));
    effects.out(info('Telegram, cowork, messenger, voice, daemon state, and daemon services remain Compose-owned.'));
    const failed = summary.some((row) => row.state === 'failed');
    if (failed) effects.out(warn(`Client setup for external daemon ${target.endpoint} is incomplete; shared profile and credential kept.`));
    else effects.out(ok(`Client setup for external daemon ${target.endpoint} complete; shared profile and credential kept.`));
    return failed ? EXIT_REFUSED : EXIT_OK;
  }

  // Which daemon, before anything is decided about it. Only args.stateDir can
  // change here; every refusal downstream is unaffected.
  effects.out(progress(2, 8, 'Choose one daemon', 'Reuse the only detected daemon or create one coherent shared target.'));
  const selection = await runSelectionPhase(args, effects);
  if (selection.action === 'refuse') return EXIT_REFUSED;

  effects.out(progress(3, 8, 'Prepare the shared daemon', 'Install the CLI, write config, start it, and enable boot persistence.'));
  const daemon = await runDaemonPhase(args, effects, exactSuite);
  if (daemon.refused) return EXIT_REFUSED;
  const target = daemon.target;
  const isDefaultStateDir = target.stateDir === join(effects.home, '.ours');

  const summary = [{
    key: 'core',
    label: 'ours core (daemon)',
    state: target.action === 'create' ? 'installed' : 'current',
    note: `port ${target.port}`,
  }];
  // A future supported runtime may still lack a CLI service adapter. Do not
  // render that partial state as success.
  if (daemon.serviceUnsupported) {
    summary.push({
      key: 'service',
      label: 'Boot service',
      state: 'failed',
      note: `not available on ${daemon.serviceUnsupported.platform === 'darwin' ? 'macOS' : daemon.serviceUnsupported.platform} — start the daemon yourself after a reboot`,
    });
  }

  effects.out(progress(4, 8, 'Install the complete stack', 'Attach MCP, Telegram, and cowork to the same daemon; run both shims as durable services.'));
  const components = await runComponentPhase(args, effects, target, exactSuite);
  for (const component of COMPONENTS) {
    const state = components.installed.includes(component.key) ? 'installed'
      : components.failed.some((f) => f.key === component.key) ? 'failed' : 'skipped';
    summary.push({
      key: component.key,
      label: component.label,
      state,
      version: state === 'installed' && !args.dryRun ? (effects.installedVersion(component.pkg) ?? '') : '',
      note: components.failed.find((f) => f.key === component.key)?.reason
        ?? (state === 'installed' && component.key === 'tg' ? 'configured; service running'
          : state === 'installed' && component.key === 'cowork' ? 'configured; service running' : undefined),
    });
  }
  const mcpReady = components.installed.includes('mcp');

  effects.out(progress(5, 8, 'Create the Human identity', 'Create the daemon root identity once, or keep the existing one.'));
  summary.push(await runIdentityPhase(args, effects, { target, mcpReady }));
  effects.out(progress(6, 8, 'Wire detected harnesses', 'Install the ours plugin into each safe Claude Code, Codex, or Hermes installation.'));
  summary.push(...await runHarnessPhase(args, effects, { target, isDefaultStateDir, exactSuite }));
  effects.out(progress(7, 8, 'Configure the fleet', 'Install Fleet and run its native configuration wizard; roles remain stopped.'));
  summary.push(await runFleetPhase(args, effects, { target, isDefaultStateDir }));
  summary.push(await runVoicePhase(args, effects, { target, mcpReady }));

  const changes = summarizeRun(daemon.steps);
  if (!changes.changedAnything) {
    effects.out(ok('everything already correct — nothing changed except refreshed packages'));
  }
  for (const failure of components.failed) {
    effects.out(warn(`${failure.key} did not install: ${failure.reason}`));
  }
  effects.out(progress(8, 8, 'Finish', 'Summarize what is running, what is stopped, and the exact next commands.'));
  await endScreen(args, effects, { summary, target, isDefaultStateDir, brokerUrl: args.brokerUrl });
  return EXIT_OK;
}


export async function runServerCommand(args, effects) {
  if (args.operation === 'status') return executeServerCommand(args, effects);
  return effects.withInstallationLock(args.stateDir, () => args.migrateFrom
    ? executeLegacyMigration(args, effects, executeServerCommand)
    : executeServerCommand(args, effects));
}

async function executeServerCommand(args, effects) {
  const recordPath = join(args.stateDir, 'installation.json');
  let record = effects.readJson(recordPath);
  const existing = record !== null;
  if (existing) {
    record = validateInstallation(record, args.stateDir);
    if (args.containerEngine && args.containerEngine !== (record.containerEngine ?? 'docker')) throw new Error('Conflicting container engine; explicit migration is required');
    if (args.mode && args.mode !== record.mode) throw new Error('Conflicting runtime mode; retained installation was not changed');
    if (args.operation !== 'update' && args.sources && (record.sourcePolicyHash
      ? effects.sourcePolicyHash(args.sources) !== record.sourcePolicyHash
      : effects.readText(args.sources) !== effects.readText(record.sourcesPath))) throw new Error('Conflicting source selection; use explicit server update');
  } else {
    if (args.operation !== 'install' || !args.mode) throw new Error('First server install requires --mode');
    record = effects.newInstallation(args.stateDir, args.mode, args);
    for (const key of ['port', 'coworkPort', 'messengerPort']) if (args[key] !== undefined) record[key] = args[key];
  }
  if (effects.readJson(join(record.root, 'gateway-transition.json')) && args.operation !== 'gateway-enable' && args.operation !== 'status') throw new Error('Interrupted gateway migration; run server gateway-enable before other changes');
  if (args.serverUrl && args.operation === 'install') {
    if (!record.gateway) throw new Error('Use server gateway-enable to migrate an existing Docker installation');
    if (existing && record.gateway.serverUrl !== args.serverUrl) throw new Error('Conflicting gateway server URL');
    record.gateway = { ...record.gateway, serverUrl: args.serverUrl };
  }
  if (record.layoutConversion && !['install', 'start', 'stop', 'status'].includes(args.operation)) {
    throw new Error('Layout conversion is incomplete; resume with server install or server start before changing state or authority');
  }
  if (record.buildTransition && !['stop', 'status', record.buildTransition.operation].includes(args.operation)) {
    throw new Error(`Server build activation is incomplete; repeat server ${record.buildTransition.operation} before other mutations`);
  }
  const showInstallProgress = args.operation === 'install' && !(existing && (record.schema === 1 || record.layoutConversion));
  const installStageCount = (existing ? 7 : 9) + (args.identityName ? 2 : 0);
  let completedInstallStages = 0;
  const installStage = async (label, explanation, action) => {
    if (!showInstallProgress) return action();
    effects.out(progress(completedInstallStages, installStageCount, label, explanation));
    try {
      const result = await action();
      completedInstallStages += 1;
      effects.out(ok(`${label} complete`));
      return result;
    } catch (error) {
      effects.out(warn(`Server installation stopped during ${label.toLowerCase()}.`));
      throw error;
    }
  };
  if ((!existing || args.operation === 'update') && !record.buildTransition) {
    args.resolvedSources = await installStage('Package selection', 'Resolve the selected server packages before installation.', async () => {
      const policy = args.sourcePolicy ?? (args.sources ? effects.readJson(args.sources) : effects.packagedSourcePolicy());
      return effects.resolveSourcePolicy(policy, 'server');
    });
  }
  if (!existing && args.sources) record.sourcePolicyHash = effects.sourcePolicyHash(args.sources);
  await installStage('Prerequisite checks', record.mode === 'docker' ? 'Check Docker Engine and Docker Compose.' : 'Check native tools and the user service manager.', () => effects.serverPreflight(record, args.operation, {
    existing, sourcePath: args.sources ?? record.sourcesPath, sourceManifest: args.resolvedSources, identityName: args.identityName,
  }));
  if (existing && (record.schema === 1 || record.layoutConversion)
    && ['install', 'start', 'restart', 'update', 'rebuild'].includes(args.operation)) {
    record = record.mode === 'docker'
      ? await effects.convertDockerInstallation(record, args.operation)
      : await effects.convertPackageInstallation(record, args.operation);
    if (['install', 'start', 'restart'].includes(args.operation)) {
      effects.out(ok(`Server ${args.operation} completed after layout conversion for ${record.root}`));
      return EXIT_OK;
    }
  }
  if (args.operation === 'stop' && record.layoutConversion) {
    await effects.stopPendingConversion(record);
  } else if (args.operation === 'install') {
    if (!existing) {
      await installStage('Installation setup', 'Save the selected packages and installation settings.', async () => {
        await effects.initializeSelection(record, args.resolvedSources);
        effects.writeJson(recordPath, JSON.stringify(record, null, 2) + '\n');
      });
    }
    await installStage('Runtime preparation', record.mode === 'docker' ? 'Prepare the Docker runtime. Downloads and builds may take several minutes.' : 'Download and prepare the native runtime packages. This may take several minutes.', () => effects.prepareInstallation(record));
    // A repeated setup repairs delivery with the retained master and exact packages.
    await installStage('Service shutdown', 'Stop managed services before configuring access.', () => effects.serverLifecycle(record, 'stop'));
    await installStage('Credential initialization', 'Initialize or retain the installation credentials.', () => effects.serverAccess(record, 'access-init', { migrate: !!args.migrate }));
    await installStage('Credential delivery', 'Prepare access for the selected services.', () => effects.serverAccess(record, 'access-issue'));
    await installStage('Build verification', 'Record the installed runtime and selected package versions.', () => effects.recordInstallationBuild(record));
    if (args.identityName) {
      await installStage('Daemon startup', 'Start the daemon and restore its retained identities.', () => effects.serverLifecycle(record, 'start', ['daemon']));
      const identity = await installStage('Human identity', 'Keep the existing Human identity, or create it on a fresh daemon.', () => effects.serverEnsureIdentity(record, args.identityName));
      record.messengerIdentity = identity.name;
      effects.writeJson(recordPath, JSON.stringify(record, null, 2) + '\n');
      await installStage('Application startup', 'Start the selected applications and check readiness.', () => effects.serverLifecycle(record, 'start', record.services.filter(name => name !== 'daemon')));
    } else {
      await installStage('Service startup', 'Start the daemon and selected services, then check readiness.', () => effects.serverLifecycle(record, 'start'));
    }
    if (record.gateway) await effects.verifyGateway(record);
    if (showInstallProgress) effects.out(progress(installStageCount, installStageCount, 'Installation complete', 'The selected services are ready.'));
  } else if (args.operation === 'gateway-enable') {
    await enableGateway(record, args, effects);
  } else if (['backup', 'restore', 'reset'].includes(args.operation)) {
    await effects.serverMaintenance(record, args);
  } else if (['update', 'rebuild'].includes(args.operation)) {
    await effects.serverBuildTransition(record, args);
  } else if (args.operation === 'access-issue') {
    await effects.serverAccess(record, 'access-issue', { output: args.output });
  } else if (args.operation === 'access-replace') {
    const running = await effects.serverLifecycle(record, 'status');
    await effects.serverLifecycle(record, 'stop');
    await effects.serverAccess(record, 'access-replace');
    try {
      await effects.serverAccess(record, 'access-issue');
      await effects.serverLifecycle(record, 'start', running);
    } catch (error) {
      effects.out(warn(`The API master has changed; setup is incomplete: ${reason(error)}. Repeat server install to repair delivery without another replacement.`));
      return EXIT_REFUSED;
    }
    effects.out(info('Separately configured clients require newly issued replacement credentials.'));
  } else if (args.operation === 'restart') {
    const running = await effects.serverLifecycle(record, 'status');
    await effects.serverLifecycle(record, 'stop');
    await effects.serverLifecycle(record, 'start', running);
  } else {
    const running = await effects.serverLifecycle(record, args.operation);
    if (args.operation === 'status') effects.out(JSON.stringify({
      mode: record.mode, instanceId: record.instanceId, schema: record.schema, running,
      ...(record.buildTransition ? { buildTransition: record.buildTransition.phase } : {}),
      ...(record.layoutConversion ? {
        layoutConversion: record.schema === 1 ? 'preparation-pending' : 'activation-pending',
      } : {}),
    }));
    if (args.operation === 'status') return EXIT_OK;
  }
  effects.out(ok(`Server ${args.operation} completed for ${record.root}`));
  return EXIT_OK;
}

export async function runClientCommand(command, effects) {
  const managedPath = join(effects.home, '.ours-client', 'profile.json');
  const saved = effects.readManagedClientProfile();
  let configPath = command.config;
  if (!configPath && saved) {
    if (!command.preset && effects.interactive && !await effects.ask(`Reuse saved client server ${saved.endpoint}?`, true))
      throw new InstallUsageError('Saved client default retained; use an explicit prepared profile to validate replacement input');
    configPath = managedPath;
  }
  let profile;
  if (configPath) profile = validateHostProfile(effects.readProfile(configPath));
  else if (!command.preset && effects.interactive) {
    const endpoint = await effects.askLine('Server HTTP or HTTPS endpoint: ', 'http://127.0.0.1:3050');
    const credentialPath = await effects.askLine('Private issued-token file: ', '');
    if (!credentialPath) throw new InstallUsageError('Client setup requires an issued-token file');
    profile = await effects.discoverClientProfile(endpoint, credentialPath);
  }
  if (!profile) throw new InstallUsageError('client install requires a complete network profile; supply --config or use the interactive client setup');
  if (saved && (saved.endpoint !== profile.endpoint || saved.expectedInstanceId !== profile.expectedInstanceId))
    throw new InstallUsageError('Managed client already selects another server; existing default was not changed');
  for (const name of ['OURS_API_TOKEN', 'OURS_PORT', 'OURS_STATE_DIR', 'OURS_DAEMON_ID']) {
    if (effects.env[name]?.trim()) throw new InstallUsageError(`${name} conflicts with client profile selection`);
  }
  effects.out(info(`Selected server ${profile.endpoint} (instance ${profile.expectedInstanceId}).`));
  await effects.verifyHostProfile(configPath || profile);
  const settings = saved?.installer ?? (configPath ? effects.readJson(configPath)?.installer : undefined);
  const settingsBase = saved ? dirname(managedPath) : configPath ? dirname(configPath) : process.cwd();
  let integrations = command.integrations ?? settings?.integrations;
  if (!integrations && !command.preset && effects.interactive) {
    integrations = [];
    for (const name of ['codex', 'claude-code', 'fleet']) if (await effects.ask(`Install ${name}?`, name !== 'fleet')) integrations.push(name);
  }
  if (!Array.isArray(integrations) || integrations.some(name => !['codex', 'claude-code', 'fleet'].includes(name)) || new Set(integrations).size !== integrations.length) throw new InstallUsageError('installer.integrations must be an array of codex, claude-code and/or fleet; use an empty array for CLI only');
  let fleetSettingsPath = command.preset ? command.fleetSettingsPath : settings?.fleetSettingsPath;
  if (command.nonInteractive && integrations.includes('fleet') && !fleetSettingsPath) throw new InstallUsageError('Fleet in CLI mode requires --fleet-settings; no interactive wizard will be opened');
  if (fleetSettingsPath !== undefined && (typeof fleetSettingsPath !== 'string' || !fleetSettingsPath))
    throw new InstallUsageError('installer.fleetSettingsPath must be a non-empty path when supplied');
  if (fleetSettingsPath) fleetSettingsPath = resolve(settingsBase, fleetSettingsPath);
  const selectedClients = clientPackageNames(integrations);
  let sourcesPath = settings?.sourcesPath;
  let resolvedSources;
  if (command.sourcePolicy) {
    resolvedSources = await effects.resolveSourcePolicy(command.sourcePolicy, 'client', selectedClients);
    sourcesPath = undefined;
  } else if (saved) sourcesPath = resolve(settingsBase, sourcesPath);
  else {
    if (sourcesPath) sourcesPath = resolve(settingsBase, sourcesPath);
    const policy = sourcesPath ? effects.readJson(sourcesPath) : effects.packagedSourcePolicy();
    resolvedSources = await effects.resolveSourcePolicy(policy, 'client', selectedClients);
  }
  effects.out(progress(0, 4, 'Client configuration', 'Prepare the selected integrations and private connection profile.'));
  if (profile.serverUrl && integrations.includes('fleet')) await effects.qualifyGatewayClient({ profile, sourcesPath, sources: resolvedSources, integrations, refresh: !!command.preset });
  const imported = effects.importClientProfile({ profile, sourcesPath, sources: resolvedSources, integrations, fleetSettingsPath, refresh: !!command.preset });
  let phase = 'Validate saved server connection';
  try {
    await effects.verifyHostProfile(imported.configPath);
    effects.out(progress(1, 4, 'Client packages', 'Acquire and verify the selected client package versions.'));
    phase = 'Acquire client packages';
    const exactSuite = await effects.acquireClientPackages(imported.configPath, imported.settings.sourcesPath, integrations, { refresh: !!command.preset });
    const args = { assumeYes: true, dryRun: false, channel: 'latest', clientIntegrations: integrations,
      acquiredFleet: exactSuite.fleetBin, fleetSettingsPath: imported.settings.fleetSettingsPath };
    const target = { mode: 'host-profile', managed: true, configPath: imported.configPath, profile: imported.profile, endpoint: imported.profile.endpoint };
    effects.out(progress(2, 4, 'Client integrations', 'Register the selected agent integrations.'));
    phase = 'Register client integrations';
    const summary = await runHarnessPhase(args, effects, { target, isDefaultStateDir: false, exactSuite });
    if (integrations.includes('fleet')) {
      effects.out(progress(3, 4, 'Fleet configuration', 'Apply prepared settings or open the selected Fleet wizard.'));
      phase = 'Configure Fleet';
      summary.push(await runFleetPhase(args, effects, { target, isDefaultStateDir: false }));
    }
    const incomplete = integrations.filter(name => !summary.some(row => row.key === name && row.state === 'installed'));
    if (effects.env.OURS_CONFIG && resolve(effects.env.OURS_CONFIG) !== imported.configPath)
      effects.out(warn('This shell has an explicit OURS_CONFIG override. Unset it for new clients to use the saved default; installer did not edit your shell.'));
    if (incomplete.length) {
      effects.out(warn(`Client setup incomplete (${incomplete.join(', ')}). The selected client integrations need attention:`));
      for (const name of incomplete) explainClientFailure(effects, name, summary.find(row => row.key === name));
      clientRetry(effects, imported, integrations);
    } else effects.out(ok(`Client setup complete. New clients discover ${imported.configPath}; no OURS_CONFIG export is required.`));
    if (!incomplete.length) effects.out(progress(4, 4, 'Client setup complete', 'All selected integrations are configured.'));
    return incomplete.length ? EXIT_REFUSED : EXIT_OK;
  } catch (error) {
    effects.out(warn(`Client setup incomplete: ${phase} failed — ${clientDiagnostic(error)}. Fix this error before retrying.`));
    clientRetry(effects, imported, integrations);
    return EXIT_REFUSED;
  }
}
