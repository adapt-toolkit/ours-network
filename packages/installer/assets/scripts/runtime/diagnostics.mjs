/** Retain actionable failure details without emitting credential output. */
export function redactDiagnostic(value, env = process.env) {
  let text = String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:token|password|secret|api.?key|private.?key|invitation|enrollment|authorization|credential|access.?token|refresh.?token)/i.test(key) && typeof secret === 'string' && secret)
      text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/((?:["']?(?:api[-_]?token|token|password|secret|api[-_]?key|private[-_]?key|invitation|enrollment|authorization|credential|access.?token|refresh.?token)["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/(--(?:setup-workspace|password|token|secret|api-key|private-key|invitation|enrollment)(?:=|\s+))\S+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted credential]')
    .replace(/[A-Za-z0-9_+/=-]{43,}/g, '[redacted opaque value]');
}

const bounded = text => text.length <= 65536 ? text : text.slice(0, 65536) + '\n[Diagnostic output exceeds 64 KiB; remainder omitted.]';
function credentialFailure(stderr) {
  // Credential stdout can be a successful issuance followed by failure: never
  // include it. Only a structured error envelope or shipped helper refusal is
  // accepted from stderr; arbitrary lines/warnings remain private.
  const lines = String(stderr ?? '').split('\n').reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (typeof value?.oursInstallerError?.message === 'string') {
        const detail = value.oursInstallerError;
        const stage = /^[a-z][a-z-]{0,40}$/.test(detail.stage ?? '') ? detail.stage : 'credential-operation';
        return `Stage: ${stage}\nReason: ${detail.message}`;
      }
      if (typeof value?.error?.message === 'string') return `Reason: ${value.error.message}`;
    } catch {}
  }
  const prefix = 'OURS client setup refused: ';
  const legacy = lines.find(line => line.startsWith(prefix));
  if (legacy) return `Reason: ${legacy.slice(prefix.length)}`;
  return 'The credential operation provided no structured reason. Its raw output was withheld because it can contain credentials.';
}

export function commandFailure(command, args, result, { sensitive = false, cwd, env = process.env } = {}) {
  const visibleArgs = [...args];
  if (sensitive) {
    for (let i = 0; i < visibleArgs.length - 1; i++) if (['-e', '--eval'].includes(visibleArgs[i])) visibleArgs[i + 1] = '[captured installer helper]';
  }
  const details = [`Command: ${command} ${visibleArgs.join(' ')}${result.status != null ? ` exited ${result.status}` : ''}`];
  if (cwd) details.push(`Working directory: ${cwd}`);
  if (result.status !== null && result.status !== undefined) details.push(`Exit code: ${result.status}`);
  if (result.signal) details.push(`Signal: ${result.signal}`);
  if (result.error?.code) details.push(`System error: ${result.error.code}`);
  if (result.error?.code === 'ETIMEDOUT') details.push('Reason: command timed out.');
  if (sensitive) details.push(credentialFailure(result.stderr));
  else {
    const stderr = String(result.stderr ?? '').trim(), stdout = String(result.stdout ?? '').trim();
    if (stderr) details.push(`Standard error:\n${stderr}`);
    if (stdout) details.push(`Standard output:\n${stdout}`);
    if (!stderr && !stdout) details.push('No captured command output. Streaming commands print their output above.');
  }
  details.push('Keep installation data intact. Include this error and the preceding installation stage when requesting help.');
  return new Error(bounded(redactDiagnostic(details.join('\n'), env)), result.error ? { cause: result.error } : undefined);
}

export function installerFailure(error, env = process.env) {
  const details = []; const seen = new Set();
  for (let cause = error; cause && !seen.has(cause) && seen.size < 8; cause = cause.cause) {
    seen.add(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!details.includes(message)) details.push(message);
    if (typeof cause.code === 'string' && /^[A-Z_0-9]+$/.test(cause.code)) details.push(`System error: ${cause.code}`);
  }
  return bounded(redactDiagnostic(details.join('\nCaused by: '), env));
}
