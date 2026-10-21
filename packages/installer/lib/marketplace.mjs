import { join } from 'node:path';

const NUM = '(?:0|[1-9]\\d*)';
const STABLE_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`);
const NIGHTLY_VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}-nightly\\.${NUM}$`);

// npm view --json normally returns a JSON string, while older/custom npm wrappers may
// return the plain version. Accept exactly one scalar either way; arrays/objects are not
// a deliberate dist-tag resolution and therefore fail closed.
export function parseNpmVersion(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return /^\S+$/.test(raw) ? raw : '';
  }
}

export function validateChannelVersion(version, channel) {
  const value = String(version ?? '').trim();
  const selected = channel === 'nightly' ? 'nightly' : 'latest';
  const valid = selected === 'nightly'
    ? NIGHTLY_VERSION.test(value)
    : STABLE_VERSION.test(value);
  return valid
    ? { ok: true, version: value, channel: selected }
    : {
        ok: false,
        version: value,
        channel: selected,
        reason: selected === 'nightly'
          ? `expected an exact X.Y.Z-nightly.N version, got ${value || '<empty>'}`
          : `expected an exact stable X.Y.Z version, got ${value || '<empty>'}`,
      };
}

function exactVersion(version, channel) {
  const checked = validateChannelVersion(version, channel);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.version;
}

export function buildClaudeMarketplace(version, channel) {
  const pinned = exactVersion(version, channel);
  return {
    $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
    name: 'ours.network',
    owner: {
      name: 'Adapt Toolkit',
      url: 'https://github.com/adapt-toolkit/ours-claude-marketplace',
    },
    plugins: [{
      name: 'ours',
      displayName: 'ours',
      description: 'Secure agent-to-agent communication channel over ADAPT: self-sovereign pubkey identity, end-to-end encryption.',
      author: { name: 'Adapt Toolkit' },
      homepage: 'https://github.com/adapt-toolkit/ours-claude-marketplace',
      repository: 'https://github.com/adapt-toolkit/ours-claude-marketplace',
      keywords: ['mcp', 'a2a', 'adapt', 'e2e', 'messaging'],
      source: {
        source: 'npm',
        package: '@ours.network/claude-code',
        version: pinned,
      },
    }],
  };
}

export function buildCodexMarketplace(version, channel) {
  const pinned = exactVersion(version, channel);
  return {
    name: 'ours-codex-marketplace',
    interface: { displayName: 'ours.network for Codex' },
    plugins: [{
      name: 'ours',
      source: {
        source: 'npm',
        package: '@ours.network/codex',
        version: pinned,
        registry: 'https://registry.npmjs.org',
      },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }],
  };
}

export function marketplacePaths(home) {
  const root = join(home, '.ours', 'install', 'marketplaces');
  const claudeRoot = join(root, 'claude-code');
  const codexRoot = join(root, 'codex');
  return {
    claudeRoot,
    claudeManifest: join(claudeRoot, '.claude-plugin', 'marketplace.json'),
    codexRoot,
    codexManifest: join(codexRoot, '.agents', 'plugins', 'marketplace.json'),
  };
}

export function marketplaceJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}
