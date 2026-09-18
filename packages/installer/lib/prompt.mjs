// Interactive prompts drawn on the controlling terminal (/dev/tty), so they work under
// `curl | bash` (where stdin/stdout are the pipe). Synchronous, dependency-free: line prompts via
// fs.readSync, and a raw-mode checkbox multi-select. When there is no tty or OURS_ASSUME_YES is
// set, every prompt returns its default without reading — the headless/CI path never blocks.
import { readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { c } from './ui.mjs';

const ASSUME_YES = () => !!process.env.OURS_ASSUME_YES;

// A Ctrl+C at any prompt must abort cleanly — never the old "^C^C^C… and keeps going" bug. Two
// things conspire: (1) the process must have a SIGINT handler (installed by the orchestrator) so
// Node doesn't just hard-kill, and (2) that handler can't run while a synchronous fs.readSync
// blocks the event loop. So readByte turns an interrupted read (EINTR) — and a literal Ctrl+C byte
// 0x03, in case the tty's signal generation is off — into this sentinel error, which unwinds the
// blocked read; the orchestrator catches it (or its own SIGINT handler fires) and exits(130).
export class InstallCancelled extends Error {
  constructor() { super('SIGINT'); this.code = 'OURS_SIGINT'; }
}
export const isCancel = (e) => !!e && e.code === 'OURS_SIGINT';

// Read raw bytes one at a time from the tty fd. Returns the byte (0-255) or null at EOF/error.
function readByte(fd) {
  const buf = Buffer.alloc(1);
  try {
    const n = readSync(fd, buf, 0, 1, null);
    return n === 1 ? buf[0] : null;
  } catch {
    return null;
  }
}

// askLine: print `prompt` and read a line. We read in RAW mode with signal generation OFF (stty
// -icanon -echo -isig) so Ctrl+C arrives as the byte 0x03 that we turn into a clean InstallCancelled
// — rather than a SIGINT that a blocked synchronous readSync would defer forever (the old
// "^C^C^C… and keeps going" bug). We echo/backspace ourselves since -echo is off. If stty isn't
// available (not a real tty), fall back to a plain cooked read. Throws InstallCancelled on Ctrl+C.
export function askLine(write, fd, prompt, def = '') {
  if (fd == null || ASSUME_YES()) return def;
  write(prompt);

  const saved = spawnSync('stty', ['-g'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
  const rawOk = saved.status === 0
    && spawnSync('stty', ['-icanon', '-echo', '-isig', 'min', '1', 'time', '0'], { stdio: [fd, 'ignore', 'ignore'] }).status === 0;
  const restore = () => { if (rawOk) spawnSync('stty', (saved.stdout || '').trim() ? [(saved.stdout || '').trim()] : ['sane'], { stdio: [fd, 'ignore', 'ignore'] }); };

  let s = '';
  try {
    for (;;) {
      const b = readByte(fd);
      if (b === null || b === 0x04) break;               // EOF / Ctrl+D → take the default
      if (b === 0x03) { restore(); write('^C'); throw new InstallCancelled(); } // Ctrl+C
      if (b === 0x0a || b === 0x0d) { if (rawOk) write('\n'); break; }          // Enter
      if (b === 0x7f || b === 0x08) { if (s.length) { s = s.slice(0, -1); if (rawOk) write('\b \b'); } continue; } // backspace
      if (b < 0x20) continue;                            // ignore other control bytes
      s += String.fromCharCode(b);
      if (rawOk) write(String.fromCharCode(b));           // manual echo
    }
  } finally {
    restore();
  }
  const ans = s.trim();
  return ans === '' ? def : ans;
}

// Secret variant of askLine: identical cancellation/backspace/default semantics, but typed
// characters are never echoed (not even as placeholder stars). This keeps provider keys out of
// terminal scrollback, curl|bash output, and captured CI logs.
export function askSecret(write, fd, prompt, def = '') {
  if (fd == null || ASSUME_YES()) return def;

  const saved = spawnSync('stty', ['-g'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
  const rawOk = saved.status === 0
    && spawnSync('stty', ['-icanon', '-echo', '-isig', 'min', '1', 'time', '0'], { stdio: [fd, 'ignore', 'ignore'] }).status === 0;
  const restore = () => {
    if (rawOk) spawnSync('stty', (saved.stdout || '').trim() ? [(saved.stdout || '').trim()] : ['sane'], { stdio: [fd, 'ignore', 'ignore'] });
  };
  if (!rawOk) {
    // Fail closed: a cooked fallback would echo the secret. Returning null lets the caller
    // explain that secure input is unavailable without ever reading a credential.
    write(`${prompt}\n`);
    return null;
  }
  // Disable echo BEFORE displaying the prompt. Otherwise an automated or very fast typist can
  // submit bytes in the small prompt→stty window and have the terminal driver echo the secret.
  write(prompt);

  let s = '';
  try {
    for (;;) {
      const b = readByte(fd);
      if (b === null || b === 0x04) break;
      if (b === 0x03) { restore(); write('^C'); throw new InstallCancelled(); }
      if (b === 0x0a || b === 0x0d) { write('\n'); break; }
      if (b === 0x7f || b === 0x08) { if (s.length) s = s.slice(0, -1); continue; }
      if (b < 0x20) continue;
      s += String.fromCharCode(b);
    }
  } finally {
    restore();
  }
  const ans = s.trim();
  return ans === '' ? def : ans;
}

// askYesNo: y/n with a default shown in caps. Returns boolean.
export function askYesNo(write, fd, prompt, def = false) {
  if (fd == null || ASSUME_YES()) return def;
  const hint = def ? '[Y/n]' : '[y/N]';
  const ans = askLine(write, fd, `${prompt} ${hint} `, def ? 'y' : 'n');
  return /^y/i.test(ans);
}

// checkboxSelect: raw-mode multi-select drawn on the tty. ↑/↓ (or k/j) move, Space toggles, Enter
// confirms, a/n = all/none, q cancels (selects nothing). Returns the selected names in order.
// `specs` are { name, label } (optionally { checked }). No-tty → returns pre-checked defaults.
export function checkboxSelect(write, fd, specs, { title } = {}) {
  const names = specs.map((s) => s.name);
  const labels = specs.map((s) => s.label);
  const sel = specs.map((s) => (s.checked ? 1 : 0));
  const n = specs.length;
  const chosen = () => names.filter((_, i) => sel[i] === 1);

  if (fd == null) return chosen();

  // Enter raw mode via `stty` on the tty fd (NOT tty.ReadStream.setRawMode, which would flip the
  // fd to non-blocking and break our fs.readSync). Save the current settings and restore them
  // after. If stty is unavailable / this isn't a real tty, fall back to the pre-checked defaults.
  const saved = spawnSync('stty', ['-g'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
  if (saved.status !== 0) return chosen();
  const savedMode = (saved.stdout || '').trim();
  const setRaw = spawnSync('stty', ['-echo', '-icanon', 'min', '1', 'time', '0'], { stdio: [fd, 'ignore', 'ignore'] });
  if (setRaw.status !== 0) return chosen();
  const restore = () => spawnSync('stty', savedMode ? [savedMode] : ['sane'], { stdio: [fd, 'ignore', 'ignore'] });

  let cur = 0;
  let drawn = 0;

  const redraw = () => {
    if (drawn) write(`\x1b[${n}A`); // rewind over the previous frame
    drawn = 1;
    for (let i = 0; i < n; i++) {
      const box = sel[i] ? c.green('[x]') : '[ ]';
      const point = i === cur ? c.cyan('> ') : '  ';
      write(`\r\x1b[K  ${point}${box} ${labels[i]}\n`);
    }
  };

  write(`  ${title || 'Choose — ' + c.bold('↑/↓') + ' move, ' + c.bold('Space') + ' toggle, ' + c.bold('Enter') + ' confirm (a=all, n=none)'}:\n`);
  redraw();

  loop: for (;;) {
    const b = readByte(fd);
    if (b === null) break;
    switch (b) {
      case 0x1b: { // ESC — arrow key sequence \x1b [ A/B
        const b1 = readByte(fd);
        if (b1 === 0x5b || b1 === 0x4f) { // '[' or 'O'
          const b2 = readByte(fd);
          if (b2 === 0x41) cur = (cur - 1 + n) % n; // up
          else if (b2 === 0x42) cur = (cur + 1) % n; // down
        }
        break;
      }
      case 0x6b: case 0x4b: cur = (cur - 1 + n) % n; break; // k/K
      case 0x6a: case 0x4a: cur = (cur + 1) % n; break;     // j/J
      case 0x20: sel[cur] = 1 - sel[cur]; break;            // space
      case 0x61: case 0x41: for (let i = 0; i < n; i++) sel[i] = 1; break; // a/A
      case 0x6e: case 0x4e: for (let i = 0; i < n; i++) sel[i] = 0; break; // n/N
      case 0x71: case 0x51: for (let i = 0; i < n; i++) sel[i] = 0; break loop; // q/Q cancel
      case 0x0d: case 0x0a: break loop; // enter
      default: break;
    }
    redraw();
  }

  restore();
  return chosen();
}
