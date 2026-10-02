import { spawn } from 'node:child_process';

/**
 * Run the given commands as one unit: signals reach every child, and when any
 * child exits the others are stopped and the container exits with its status,
 * so a failure is visible and recovers through the container's own restart.
 */
const commands = JSON.parse(process.argv[2] ?? '[]');
if (!Array.isArray(commands) || !commands.length || !commands.every(c => Array.isArray(c) && c.length && c.every(a => typeof a === 'string'))) {
  console.error('usage: supervise.mjs JSON-ARRAY-OF-COMMANDS'); process.exit(2);
}
// Inherited descriptors 3 and 4 are the state-directory locks; every child holds them too.
const children = commands.map(([file, ...args]) => spawn(file, args, { stdio: ['inherit', 'inherit', 'inherit', 'inherit', 'inherit'] }));
let stopping = false, status = 0;
const stop = (signal) => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; stop(signal); });
let remaining = children.length;
for (const child of children) child.on('exit', (code, signal) => {
  if (!stopping) { stopping = true; status = code ?? 1; console.error(`Supervised process ${child.spawnfile} exited (${signal ?? code}); stopping the others`); stop('SIGTERM'); }
  if (--remaining === 0) process.exit(status);
});
