// ours-install v3 — component selection and attachment.
//
// Component selection and attachment planning. Repoint decisions stay beside
// attachment decisions so an existing connector can never move silently.
// Pure, like target.mjs and plan.mjs: the caller injects the current file
// contents and the installed versions, and every function returns a plan.
//
// The three components are the MCP server, the Telegram connector and cowork.
// None of them IS the daemon; all three attach to one. A normal install carries
// the complete stack, while the messenger remains deliberately out of scope.

import { join, resolve } from 'node:path';
import { pkgSpec, resolveChannel } from './logic.mjs';

// `pkg` is the package's IDENTITY — bare, no dist-tag — because that is what
// `npm ls -g --json <pkg>` needs to read an installed version back, and what a
// component is keyed by in every summary. `specKey` is the same package's name
// in lib/logic.mjs's channel map, and `componentSpec` below is the only thing
// that turns the two into an `npm i -g` argument.
//
// THE TWO MUST STAY SEPARATE. Putting the tag in `pkg` would make
// effects.installedVersion('@ours.network/mcp@nightly') return null forever,
// which fails the cowork version floor CLOSED and blanks the version column —
// a silent regression that looks like "cowork is too old".
// `required` is not a stronger default — it is the absence of a choice. The
// daemon is the ours-sdk CLI and this package is the MCP server every harness
// speaks to it through, so an operator who declined it would have a daemon no
// harness can reach — which is not a decision anyone means to make. Declining
// has to be impossible rather than discouraged.
export const COMPONENTS = [
  { key: 'mcp', label: 'MCP server for your harness', pkg: '@ours.network/mcp', specKey: 'mcp', default: true, required: true },
  { key: 'tg', label: 'Telegram connector', pkg: '@ours.network/tg-connector', specKey: 'tg-connector', default: true },
  { key: 'cowork', label: 'cowork', pkg: '@ours.network/cowork', specKey: 'cowork', default: true },
];

/**
 * The `npm i -g` argument for one component on one channel.
 *
 * WHY THIS EXISTS AT ALL. `args.channel` was resolved in the orchestrator and
 * then reached only lib/extras.mjs's two planners, while these three packages
 * were installed by their bare names. So `CHANNEL=nightly` installed the NIGHTLY
 * Codex/Hermes plugins and NIGHTLY ours-fleet beside a STABLE MCP server — the
 * split-brain deployment the channel exists to prevent, and the same class of
 * bug the extras.mjs channel-map correction fixed for ours-fleet one package
 * over. Every install path for these three now goes through here.
 *
 * All three publish a real `nightly` dist-tag (verified against the registry,
 * so none of these pins can 404. `pkgSpec` falls back to `latest`
 * for anything unmapped rather than inventing a tag, so an unknown component
 * degrades to today's behaviour instead of failing.
 *
 * ON THE STABLE CHANNEL THIS RETURNS THE BARE NAME, byte for byte what shipped
 * before. `npm i -g pkg` and `npm i -g pkg@latest` are the same install, so
 * appending the tag would have bought nothing and changed every stable screen
 * line and assertion. The nightly channel is the case that was broken; it is the
 * only case that changes.
 */
export const componentByKey = (key) => COMPONENTS.find((c) => c.key === key);

export function componentSpec(component, channel = 'latest') {
  const key = typeof component === 'string' ? component : component?.specKey ?? component?.key;
  const name = typeof component === 'string' ? null : component?.pkg ?? null;
  if (resolveChannel(channel) === 'latest') return name ?? `@ours.network/${String(key).replace(/^@ours\.network\//, '')}`;
  return pkgSpec(key, channel);
}

// cowork must be at least this build to understand an external-daemon block.
export const COWORK_DAEMON_FLOOR = '0.4.1-nightly.20260816.4aaf940';

// -----------------------------------------------------------------------------
// THE REGISTRY THAT IS NOT OURS TO TOUCH
// -----------------------------------------------------------------------------

/**
 * The Telegram connector keeps its OWN registry of routes, and the installer must
 * never write into it.
 *
 *   ~/.ours-telegram/bots.json        the bot registry
 *   ~/.ours-telegram/<route>/         one directory per route, each holding
 *                                     identity.key, state_data.bin, connection.json
 *
 * (tg-connector `src/connector.ts:35-42,170-173`, `src/config.ts:39`.)
 *
 * WHY THIS IS STATED AS A CONSTANT AND ASSERTED BY A TEST. The connector
 * distinguishes its identities by walking its own state directory, NOT by asking
 * the daemon: a daemon's identity list is FLAT and carries no attribution to the
 * app that created it. So there is no way to reconstruct this registry from the
 * daemon side, and anything the installer clears here is gone. The installer's
 * entire business with the connector is three keys in one config file.
 *
 * It also keeps a future route migration possible — moving each route's packet
 * into the shared daemon has to read this registry to know which daemon identity
 * corresponds to which route, and an installer that trampled it would have
 * destroyed the mapping.
 */
export const TG_STATE_DIR_NAME = '.ours-telegram';
export const TG_REGISTRY_FILES = ['bots.json'];
export const TG_ROUTE_FILES = ['identity.key', 'state_data.bin', 'connection.json'];

export const tgConfigPath = (home, env = {}) => env.OURS_TG_CONFIG ?? join(home, TG_STATE_DIR_NAME, 'config.json');
export const coworkConfigPath = (home, env = {}) => env.OURS_COWORK_CONFIG ?? join(home, '.ours-cowork', 'config.json');

// -----------------------------------------------------------------------------
// Component selection
// -----------------------------------------------------------------------------

/**
 * Which components this run installs. The default is the complete stack: MCP,
 * Telegram and cowork all attach to the same daemon. Explicit programmatic
 * answers are retained for compatibility, but the public installer no longer
 * asks the user to assemble the product one package at a time.
 *
 * `installed` marks a component already present so the question reads "keep it?"
 * — and DECLINING AN ALREADY-INSTALLED COMPONENT NEVER UNINSTALLS IT. Removal is
 * `ours-uninstall`. A "no" here means "do not add", never "take it away".
 */
export function planComponentSelection({ answers = {}, installed = {}, assumeYes = false } = {}) {
  return COMPONENTS.map((component) => {
    const already = installed[component.key] === true;
    const answer = assumeYes ? component.default : answers[component.key];
    // A required component ignores the answer entirely, including an explicit no.
    // The daemon phase has already installed and started it by the time this runs;
    // "skip" here would only produce a screen that contradicts the machine.
    const wanted = component.required
      ? true
      : (answer === undefined ? (already || component.default) : answer === true);
    return {
      ...component,
      already,
      action: already ? (wanted ? 'keep' : 'leave-alone') : (wanted ? 'install' : 'skip'),
    };
  });
}

// -----------------------------------------------------------------------------
// MCP server attachment
// -----------------------------------------------------------------------------

/**
 * The MCP server runs per session, not as a daemon: the harness spawns
 * `ours-mcp proxy` over stdio. No systemd unit is installed for it, and the only
 * thing written to disk is the harness's MCP registration.
 *
 * For a non-default state directory the registration carries
 * `OURS_CONFIG=<state-dir>/config.json`, so the endpoint and the state directory
 * travel together — which is what keeps "endpoint given, state directory
 * defaulted" unreachable. Several harnesses can each point at a different daemon
 * precisely because the pair lives in each registration.
 */
export function planMcpAttachment({ stateDir, isDefaultStateDir, channel = 'latest' }) {
  const dir = resolve(stateDir);
  return {
    key: 'mcp',
    install: ['npm', 'i', '-g', componentSpec(componentByKey('mcp'), channel)],
    service: null, // deliberate: per-session stdio proxy, never a unit
    harnessEnv: isDefaultStateDir ? {} : { OURS_CONFIG: join(dir, 'config.json') },
    writes: ['the harness MCP registration'],
  };
}

// -----------------------------------------------------------------------------
// Telegram connector attachment and repointing
// -----------------------------------------------------------------------------

/**
 * Attach the connector to this daemon by setting exactly three keys in its config
 * file, preserving every other key in it — the file also holds the operator's bot
 * token and STT settings. If all three already match, the file is not touched.
 *
 * Both daemon keys are ALWAYS written together. A half-formed pair is what makes
 * "endpoint selected, state directory defaulted" reachable downstream, and the
 * SDK refuses that before it opens a socket.
 *
 * Returns `action: 'confirm-repoint'` when the connector is currently attached to
 * a DIFFERENT daemon. There is exactly one `daemonUrl`/`daemonStateDir` pair and
 * one unit, so pointing it elsewhere MOVES the connector; it does not add a
 * second one. That is not something to do silently, and unlike the legacy-unit
 * case it is not recoverable by re-running: the operator's routes would be
 * talking to a daemon they did not choose.
 */
export function planTgAttachment({ existing, endpoint, stateDir, brokerUrl, assumeYes = false, channel = 'latest' }) {
  const dir = resolve(stateDir);
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const desired = { daemonUrl: endpoint, daemonStateDir: dir, brokerUrl };

  const current = typeof base.daemonUrl === 'string' || typeof base.daemonStateDir === 'string'
    ? { daemonUrl: base.daemonUrl ?? null, daemonStateDir: base.daemonStateDir ?? null }
    : null;
  const pointsElsewhere = current !== null
    && (current.daemonStateDir === null || resolve(current.daemonStateDir) !== dir);

  const merged = { ...base };
  const changes = [];
  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined || value === null) continue;
    if (merged[key] === value) continue;
    changes.push(key);
    merged[key] = value;
  }
  const plan = {
    key: 'tg',
    install: ['npm', 'i', '-g', componentSpec(componentByKey('tg'), channel)],
    changed: changes.length > 0,
    changes,
    config: merged,
    // The connector is a durable shim over the shared daemon. Its service command
    // owns the platform-specific unit and `enable --now`; the installer invokes
    // it after committing the coherent daemon selection below.
    service: ['ours-tg-connector', 'install-service'],
    untouched: [...TG_REGISTRY_FILES, ...TG_ROUTE_FILES],
  };
  if (!pointsElsewhere) return { ...plan, action: plan.changed ? 'attach' : 'unchanged' };
  const repoint = {
    ...plan,
    action: 'confirm-repoint',
    from: current,
    to: { daemonUrl: endpoint, daemonStateDir: dir },
    prompt: `The Telegram connector currently uses ${current.daemonUrl ?? 'an unrecorded daemon'} (${current.daemonStateDir ?? 'unrecorded state directory'}).\nPoint it at ${endpoint} (${dir}) instead? This MOVES the connector; it does not add a second one.`,
  };
  // Never repoint an existing connector without a human, in any mode.
  return assumeYes ? { ...repoint, action: 'skip-repoint', reason: 'never repointed non-interactively' } : repoint;
}

// -----------------------------------------------------------------------------
// cowork attachment
// -----------------------------------------------------------------------------

/**
 * Compare an installed version against a floor. Prerelease-aware and CONSERVATIVE
 * by design: anything unparseable is "too old", because the failure it guards is
 * handing a daemon block to a build whose config is strict and whose boot is
 * fail-closed. Being wrong in the cautious direction leaves cowork embedded;
 * being wrong the other way stops it starting.
 */
export function atLeastVersion(actual, floor) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v ?? '').trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const a = parse(actual);
  const b = parse(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  if (a.pre === b.pre) return true;
  if (a.pre === null) return true; // a release outranks any prerelease of the same version
  if (b.pre === null) return false;
  return a.pre >= b.pre;
}

/**
 * cowork's external-daemon block. Both halves are required: a half-formed block
 * is REFUSED rather than written, because cowork's boot is fail-closed.
 *
 * The top-level `stateDir` in that file is cowork's OWN private state and is left
 * alone; only `daemon.stateDir` is the ours daemon's. Confusing the two fails
 * closed at boot, which is why they are never touched in the same write.
 */
/**
 * cowork's own defaults, seeded ONLY into a config that does not have them.
 *
 * WHY THIS IS NOT "CONFIGURING SOMEBODY ELSE'S TOOL". On a first install cowork's
 * config file does not exist, so v3 wrote it with a `daemon` block and nothing
 * else — no version, no broker, no REST port. The nightly installer seeds all
 * three (`planCoworkConfig`, lib/logic.mjs), and the broker in particular is a
 * value the INSTALLER knows and cowork cannot guess: it is the one the operator
 * chose in this run, and a cowork pointed at a different broker cannot reach the
 * agents it was installed to talk to.
 *
 * SEEDED ONLY INTO A FILE THAT DOES NOT EXIST YET. An existing cowork config is
 * copied through untouched — every key, including ones we would have defaulted.
 * That line is deliberate and narrower than "write any key that is absent": a
 * config the operator already has is theirs, and adding keys to it on a re-run
 * would rewrite a file for no reason the operator asked for. A file this run is
 * CREATING is a different thing, and it is the only case seeded here.
 *
 * NOT VERIFIED, and stated rather than assumed: whether cowork boots happily on a
 * daemon block alone. Its own defaults may well cover all three. Seeding what the
 * installer already knows is the safe direction either way, and it is what the
 * flow being replaced does.
 */
export const COWORK_DEFAULT_REST_PORT = 3052;

export function seedCoworkDefaults(base, { brokerUrl, home }) {
  const seeded = { ...base };
  const added = [];
  if (seeded.version === undefined) { seeded.version = 1; added.push('version'); }
  if (typeof seeded.brokerUrl !== 'string' && brokerUrl) { seeded.brokerUrl = brokerUrl; added.push('brokerUrl'); }
  // cowork's OWN state directory, never the daemon's. Confusing the two fails
  // closed at boot, which is why they are never written in the same expression.
  if (typeof seeded.stateDir !== 'string' && home) { seeded.stateDir = join(home, '.ours-cowork'); added.push('stateDir'); }
  const rest = seeded.rest && typeof seeded.rest === 'object' && !Array.isArray(seeded.rest) ? seeded.rest : null;
  if (!rest || !Number.isInteger(rest.port)) {
    seeded.rest = { enabled: rest?.enabled ?? true, ...(rest ?? {}), port: rest?.port ?? COWORK_DEFAULT_REST_PORT };
    added.push('rest.port');
  }
  return { config: seeded, added };
}

export function planCoworkAttachment({ existing, endpoint, stateDir, installedVersion, channel = 'latest', brokerUrl, home }) {
  const dir = resolve(stateDir);
  if (!endpoint || !stateDir) {
    return { key: 'cowork', action: 'refuse', reason: 'half-formed-block', message: 'a cowork daemon block needs both an endpoint and a state directory; refusing to write half of one' };
  }
  if (!atLeastVersion(installedVersion, COWORK_DAEMON_FLOOR)) {
    return {
      key: 'cowork',
      action: 'leave-embedded',
      reason: 'version-floor',
      installedVersion: installedVersion ?? null,
      message: `the installed cowork (${installedVersion ?? 'version unreadable'}) predates ${COWORK_DAEMON_FLOOR}, which is the first build that understands an external-daemon block; leaving cowork embedded`,
    };
  }
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const daemon = { mode: 'external', endpoint, stateDir: dir };
  const daemonUnchanged = base.daemon
    && base.daemon.mode === 'external'
    && base.daemon.endpoint === endpoint
    && typeof base.daemon.stateDir === 'string'
    && resolve(base.daemon.stateDir) === dir;
  // Seeded only where the key is ABSENT, so an existing config is still copied
  // through untouched — which was already the right behaviour and is not changed.
  const creating = existing === null || existing === undefined;
  const { config: seeded, added } = creating
    ? seedCoworkDefaults(base, { brokerUrl, home })
    : { config: base, added: [] };
  const unchanged = daemonUnchanged && added.length === 0;
  return {
    key: 'cowork',
    action: unchanged ? 'unchanged' : 'attach',
    install: ['npm', 'i', '-g', componentSpec(componentByKey('cowork'), channel)],
    changed: !unchanged,
    seeded: added,
    // The top-level stateDir is cowork's own; an existing one is copied through
    // untouched and only an ABSENT one is seeded. Confusing it with the daemon's
    // fails closed at boot, which is why they are never written together.
    config: { ...seeded, daemon },
    service: ['ours-cowork', 'install-service'],
  };
}

// -----------------------------------------------------------------------------
// Component failures are isolated so the remaining components can continue.
// -----------------------------------------------------------------------------

/**
 * A component that fails is reported with its reason and the exact manual
 * command, and the run continues to the next. The daemon and the
 * already-installed components stay as they are — a failed component is never a
 * reason to undo a successful one.
 */
export function summarizeComponentRun(results) {
  return {
    installed: results.filter((r) => r.state === 'installed').map((r) => r.key),
    failed: results.filter((r) => r.state === 'failed').map((r) => ({ key: r.key, reason: r.reason, retry: r.retry ?? null })),
    skipped: results.filter((r) => r.state === 'skipped').map((r) => r.key),
    continued: true,
  };
}
