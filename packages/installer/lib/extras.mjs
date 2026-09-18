// ours-install v3 — the four retained extras, re-pointed at the v3 arrangement.
//
// The v3 installer keeps harness plugins, ours-fleet, voice setup and the
// copy-paste hand-off prompt.
//
// The shared daemon belongs to the operator CLI. Client profiles select that
// daemon for MCP-backed harnesses and Fleet; these phases preserve the selection.
//
// Pure, like target.mjs / plan.mjs / components.mjs: no I/O, no subprocess, no
// terminal. Every function takes what was observed and returns a plan; the
// orchestrator performs it.

import { dirname, join, resolve } from 'node:path';
import { pkgSpec } from './logic.mjs';

const cfgPath = (stateDir) => join(resolve(stateDir), 'config.json');
export const shellQuote = (value) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
  ? value
  : `'${value.replaceAll("'", `'"'"'`)}'`;

// -----------------------------------------------------------------------------
// Harness plugins
// -----------------------------------------------------------------------------

export const CLAUDE_MARKET = 'adapt-toolkit/ours-claude-marketplace';
export const CODEX_MARKET = 'adapt-toolkit/ours-codex-marketplace';

export const HARNESSES = [
  { name: 'claude-code', label: 'Claude Code' },
  { name: 'codex', label: 'Codex' },
  { name: 'hermes', label: 'Hermes' },
];

/**
 * TWO OF THE THREE REGISTRATIONS CANNOT PERSIST AN ENVIRONMENT VALUE.
 *
 * For a non-default state directory, planMcpAttachment exposes the required
 * OURS_CONFIG value. Claude Code and Codex cannot persist that value in their
 * plugin registrations, so the installer prints an explicit shell export and
 * never claims it was applied automatically:
 *
 *   Claude Code  the marketplace plugin's mcpServers.ours is command+args, with
 *                no env key, and `claude plugin install` injects nothing per
 *                install.
 *   Codex        .mcp.json's env_vars is an allowlist of NAMES, not a value map
 *                (pinned by packages/codex/test/plugin-package.test.mjs). The
 *                value must already be in the ambient environment.
 *   Hermes       renderConfigBlock is OUR writer, and now emits an `env:` block
 *                carrying OURS_CONFIG — so for Hermes the pair is real.
 *
 * The supported behavior is:
 *
 *   default state directory   today's behaviour, byte for byte.
 *   Hermes, non-default       real: the pair is handed to ours-hermes-install's
 *                             invocation and written into ~/.hermes/config.yaml
 *                             as the ours server's own env block.
 *   Claude / Codex, non-def   install the plugin (it is still the right plugin)
 *                             and PRINT the exact line the operator must add.
 *                             Never claim automatic configuration in the screen text.
 *
 * Deliberately NOT done: registering a second, user-scoped `ours` MCP server via
 * `claude mcp add --env`. Two `ours` servers in front of one harness, and which
 * wins is not something anyone here has verified.
 */
export const HARNESS_ENV_SUPPORT = {
  // 'applied' — the pair is genuinely carried into the registration.
  // 'printed' — the operator is told the exact line and nothing is claimed.
  'claude-code': 'printed',
  codex: 'printed',
  hermes: 'applied',
};

const manualSteps = {
  'claude-code': (channel) => [
    `/plugin marketplace add ${CLAUDE_MARKET}`,
    '/plugin install ours',
  ],
  codex: (channel) => [
    `codex plugin marketplace add ${CODEX_MARKET}`,
    'codex plugin add ours@ours-codex-marketplace',
    `npm i -g ${pkgSpec('codex', channel)}`,
  ],
  hermes: (channel) => [
    `npm i -g ${pkgSpec('hermes', channel)}`,
    'ours-hermes-install',
  ],
};

const driveSteps = {
  'claude-code': (channel) => [
    ['claude', 'plugin', 'marketplace', 'add', CLAUDE_MARKET],
    ['claude', 'plugin', 'install', 'ours@ours.network'],
  ],
  codex: (channel) => [
    ['codex', 'plugin', 'marketplace', 'add', CODEX_MARKET],
    ['codex', 'plugin', 'add', 'ours@ours-codex-marketplace'],
    // Product requirement in v2 and kept: choosing the Codex plugin also installs the
    // ours-codex live launcher, in the same step.
    ['npm', 'i', '-g', pkgSpec('codex', channel)],
  ],
  // Hermes has no driven CLI: nothing here ever calls a `hermes` binary. Its
  // plugin install is npm + ours-hermes-install, which writes ~/.hermes.
  // --skip-daemon because in v3 the daemon is emphatically not ours-mcp's.
  hermes: (channel) => [
    ['npm', 'i', '-g', pkgSpec('hermes', channel)],
    ['ours-hermes-install', '--skip-daemon'],
  ],
};

/**
 * One plan per harness the caller observed.
 *
 * `harnesses` is [{ name, status }] where status is classifyHarnessProbe's
 * verdict ('ok' | 'alias' | 'unsafe' | 'absent'). Hermes is detected by its
 * config directory rather than a CLI, which is the caller's business; this only
 * consumes the verdict.
 *
 * The v2 golden rule is kept intact: 'alias' / 'unsafe' NEVER dead-end. A
 * harness we cannot safely drive still gets its manual steps printed, so the
 * plugin is still installable.
 *
 * `env` is what an invocation must carry, and it is EMPTY unless the harness can
 * genuinely apply it. `envLine` is what the operator is told. `claimsPair` is
 * false whenever the pair is only printed — the screen text renderer reads it so
 * the screen cannot claim that the pair was persisted where it was only printed.
 */
export function planHarnessPlugins({
  harnesses = [],
  stateDir,
  isDefaultStateDir,
  configPath = null,
  channel = 'latest',
  assumeYes = false,
  answers = {},
} = {}) {
  const explicitProfile = typeof configPath === 'string' && configPath !== '';
  const config = explicitProfile ? resolve(configPath) : stateDir ? cfgPath(stateDir) : null;
  return harnesses.map((h) => {
    const name = String(h?.name ?? '');
    const known = HARNESSES.find((k) => k.name === name);
    const label = known?.label ?? name;
    const status = String(h?.status ?? 'absent');
    const support = HARNESS_ENV_SUPPORT[name] ?? 'printed';
    const applies = explicitProfile || (!isDefaultStateDir && support === 'applied');

    const base = {
      name,
      label,
      status,
      // Default state directory → today's behaviour, byte for byte: no env
      // anywhere, nothing extra printed, nothing claimed.
      envSupport: explicitProfile ? support : isDefaultStateDir ? 'none' : support,
      env: applies ? { OURS_CONFIG: config } : {},
      envLine: explicitProfile && support === 'printed' ? `export OURS_CONFIG=${shellQuote(config)}` : isDefaultStateDir || applies ? null : `export OURS_CONFIG=${shellQuote(config)}`,
      claimsPair: explicitProfile ? support === 'applied' : isDefaultStateDir ? true : applies,
      manual: manualSteps[name] ? manualSteps[name](channel) : [],
    };

    if (!known) return { ...base, action: 'skip', reason: 'unknown harness' };
    if (explicitProfile && name === 'hermes') {
      return { ...base, env: {}, envLine: null, claimsPair: false, action: 'skip', reason: 'not selected for host-profile setup' };
    }
    if (status === 'absent') return { ...base, action: 'skip', reason: 'not installed' };

    const wanted = assumeYes ? true : answers[name] !== false;
    if (!wanted) return { ...base, action: 'skip', reason: 'declined', offerOnRerun: true };

    if (status === 'ok') return { ...base, action: 'drive', steps: driveSteps[name](channel) };
    return {
      ...base,
      action: 'manual',
      reason: status === 'alias' ? 'installed as an alias, not the real command' : 'found, but did not answer --version',
    };
  });
}

// -----------------------------------------------------------------------------
// Preconditions the operator must satisfy before installation
// -----------------------------------------------------------------------------

/**
 * The restart each harness needs before its new plugin is live.
 *
 * A CORRECTNESS PROBLEM WEARING A COSMETIC COSTUME. The ours MCP server is spawned
 * BY the harness, once per session (`ours-mcp proxy` over stdio), so a harness that
 * was already running when its plugin was installed has no ours tools and will not
 * get them until it restarts. v3 said nothing at all about this: the screen read
 * "Everything installed cleanly", the user went back to a running Claude Code,
 * found no ours tools, and concluded the install had failed. The nightly installer
 * prints these hints and v3 dropped them.
 *
 * Derived from what THIS RUN installed rather than from a registry — v3 already
 * knows, and its own summary is a better source than a persisted file that can go
 * stale against reality.
 *
 * The connectors are deliberately absent. The installer runs their
 * `install-service` itself, so their new configuration is already applied; telling
 * someone to restart something that was just restarted for them is noise, and noise
 * in this list is what stops the real lines being read.
 */
export const HARNESS_RESTART = {
  'claude-code': 'restart Claude Code',
  codex: 'start a new Codex session (or `ours-codex`)',
  hermes: 'run /reload-mcp in Hermes',
};

export function restartHints(summary = []) {
  const live = (row) => row && (row.state === 'installed' || row.state === 'current');
  const hints = [];
  for (const [name, action] of Object.entries(HARNESS_RESTART)) {
    const row = summary.find((r) => r.key === name);
    if (live(row)) hints.push({ key: name, action });
  }
  // Nothing to restart if no harness got a plugin this run. The MCP server on its
  // own changes nothing a running harness can see, so an "install the MCP server
  // and restart everything" line would be advice with no reason behind it.
  return hints;
}

// -----------------------------------------------------------------------------
// ours-fleet — configured by its native wizard, never started implicitly
// -----------------------------------------------------------------------------

export const fleetConfigPath = (home) => join(resolve(home), 'fleet.yaml');

export function planFleet({ home, stateDir, isDefaultStateDir, configPath = null, settingsPath = null, wanted = true, channel = 'latest' } = {}) {
  const resolvedHome = home ?? (stateDir ? dirname(resolve(stateDir)) : null);
  const path = resolvedHome ? fleetConfigPath(resolvedHome) : null;
  const plan = {
    key: 'fleet',
    label: 'ours-fleet',
    // FOLLOWS THE CHANNEL, and the correction matters more than it looks.
    //
    // This comment used to say the opposite — that ours-fleet lives in its own
    // repo and publishes no nightly tag, so pkgSpec pinned it to @latest. That
    // was true when v3 was written against `main` and it is FALSE here: fleet
    // does publish a nightly dist-tag, and the nightly stack needs the fleet
    // build carrying the SDK integration. A nightly installer that quietly
    // installs stable fleet is precisely the split-brain deployment the channel
    // exists to prevent — the same architecture boundary that made a mixed
    // tg-connector fatal. lib/logic.mjs is the single source of that mapping and
    // this defers to it rather than restating it.
    install: ['npm', 'i', '-g', pkgSpec('fleet', channel)],
    init: ['ours-fleet', 'init', ...(path ? ['--configuration', path] : []),
      ...(settingsPath ? ['--settings', resolve(settingsPath)] : [])],
    configPath: path,
    instruction: `review ${path}, then run ours-fleet doctor and ours-fleet up when you are ready`,
  };
  return wanted ? { ...plan, action: 'install' } : { ...plan, action: 'skip', offerOnRerun: true };
}

// -----------------------------------------------------------------------------
// the copy-paste hand-off prompt
// -----------------------------------------------------------------------------

/**
 * buildHandoffPrompt is pure, renumbers automatically, and drops steps for
 * components that were not installed. The default path needs no daemon preamble;
 * a non-default path names the exact config so the assistant cannot guess.
 */
export function buildHandoffPromptV3({
  identity = false,
  fleet = false,
  telegram = false,
  stateDir = null,
  isDefaultStateDir = true,
} = {}) {
  const steps = [];
  if (identity) {
    steps.push(
      'Create my Ours human identity — this is me, the human; my agents act on\n'
      + '   my behalf. Ask me what name others should see, then create it.',
    );
  }
  if (fleet) {
    steps.push(
      'Review the Fleet wizard output in ~/fleet.yaml with me. Keep its selected\n'
      + '   models, roles, templates, and permissions unless I ask to change them.\n'
      + '   Ask before starting the fleet.',
    );
  }
  if (telegram) {
    steps.push(
      'Finish my Telegram setup without exposing secrets: ask me for the bot name\n'
      + '   and guide me through entering the @BotFather token locally. Register the\n'
      + '   route in the connector service that ours-install already started.',
    );
  }
  if (steps.length === 0) return { text: '', empty: true };

  const preamble = isDefaultStateDir || !stateDir
    ? ''
    : `My ours daemon uses the state directory ${resolve(stateDir)} (config\n${cfgPath(stateDir)}). When you configure anything for me — fleet roles,\nharness environments — set OURS_CONFIG to that path.\n\n`;

  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const text = preamble
    + 'I just installed the ours.network stack. Please help me finish setup, one\n'
    + 'step at a time, explaining as you go:\n\n'
    + numbered + '\n\n'
    + 'Do these in order, wait for my answers, and tell me if you need anything\n'
    + "from me. Don't assume — ask.";
  return { text, empty: false };
}
