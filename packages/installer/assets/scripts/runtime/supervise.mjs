import { spawn } from 'node:child_process';

/**
 * Run the given commands as one unit: signals reach every child, and when any
 * child exits (or cannot start) the others are stopped and the container exits
 * with its status, so a failure is visible and recovers through the container's
 * own restart. A child ignoring SIGTERM is killed after a bounded grace period,
 * within Compose's stop grace period.
 */
const commands = JSON.parse(process.argv[2] ?? '[]');
if (!Array.isArray(commands) || !commands.length || !commands.every(c => Array.isArray(c) && c.length && c.every(a => typeof a === 'string'))) {
  console.error('usage: supervise.mjs JSON-ARRAY-OF-COMMANDS'); process.exit(2);
}
const killAfter = Number(process.env.OURS_SUPERVISE_KILL_AFTER_MS ?? 20_000);
let stopping = false, status = 0, remaining = commands.length;
const children = [];
const running = child => child.exitCode === null && child.signalCode === null && !child.failed;
const stop = signal => {
  for (const child of children) if (running(child)) child.kill(signal);
  if (signal !== 'SIGKILL') setTimeout(() => stop('SIGKILL'), killAfter);
};
const finished = (child, code, reason) => {
  if (child.done) return;
  child.done = true;
  if (!stopping) { stopping = true; status = code; console.error(`Supervised process ${child.spawnfile} ${reason}; stopping the others`); stop('SIGTERM'); }
  if (--remaining === 0) process.exit(status);
};
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (!stopping) { stopping = true; stop(signal); } });
// Inherited descriptors 3 and 4 are the state-directory locks; every child holds them too.
for (const [file, ...args] of commands) {
  const child = spawn(file, args, { stdio: ['inherit', 'inherit', 'inherit', 'inherit', 'inherit'] });
  children.push(child);
  child.on('error', error => { child.failed = true; finished(child, 1, `could not start (${error.code ?? 'error'})`); });
  child.on('exit', (code, signal) => finished(child, code ?? 1, `exited (${signal ?? code})`));
}
