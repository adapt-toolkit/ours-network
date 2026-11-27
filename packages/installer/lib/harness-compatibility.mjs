/** Feature checks avoid inventing a universal upstream version floor for plugins. */
export function pluginCliCompatibility(name, result) {
  const command = name === 'claude-code' ? 'claude' : 'codex';
  const text = String(result?.stdout ?? '');
  const supported = result?.ok && /marketplace/.test(text) && (name === 'claude-code' ? /install/.test(text) : /add/.test(text));
  return supported ? { ok: true } : { ok: false, detail: `${command} does not expose the required plugin marketplace commands (or the read-only capability check failed). Install a current supported ${name === 'claude-code' ? 'Claude Code from https://code.claude.com/docs/en/setup' : 'Codex from https://developers.openai.com/codex/cli'}, verify ${command} plugin --help, then resume ours-install client --config ~/.ours-client/profile.json --integrations ${name}. Your executable and settings were not replaced.` };
}
