// Interactive prompts drawn on the controlling terminal (/dev/tty), so they work under
// `curl | bash` (where stdin/stdout are the pipe). Synchronous, dependency-free: line prompts via
// fs.readSync, and raw-mode single/multiple choices. When there is no tty or OURS_ASSUME_YES is
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

// Decode incrementally: a terminal read may split a UTF-8 code point across bytes.
// Fatal decoding rejects malformed input instead of storing a corrupted name or path.
function textEntry(write, fd, prompt, def, secret, {
  read = readByte, enterRaw = enterSelectionMode,
} = {}) {
  if (fd == null || ASSUME_YES()) return def;
  let restore;
  try { restore = enterRaw(fd); } catch (error) {
    // A secret must never fall back to an echoing cooked terminal.
    if (secret && isCancel(error)) { write(`${prompt}\n`); return null; }
    throw error;
  }
  let decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = false;
  const characters = [];
  try {
    write(prompt);
    for (;;) {
      const byte = read(fd);
      if (byte == null || byte === 0x03 || byte === 0x04) throw new InstallCancelled();
      if (byte === 0x7f || byte === 0x08) {
        if (pending) {
          decoder = new TextDecoder('utf-8', { fatal: true });
          pending = false;
        } else if (characters.length) {
          characters.pop();
          if (!secret) write('\b \b');
        }
        continue;
      }
      if (byte === 0x0a || byte === 0x0d) {
        try { decoder.decode(); } catch { throw new InstallCancelled(); }
        write('\n');
        const answer = characters.join('').trim();
        return answer === '' ? def : answer;
      }
      if (byte < 0x20) {
        if (pending) throw new InstallCancelled();
        continue;
      }
      let decoded;
      try { decoded = decoder.decode(Uint8Array.of(byte), { stream: true }); }
      catch { throw new InstallCancelled(); }
      pending = decoded.length === 0;
      for (const character of decoded) {
        characters.push(character);
        if (!secret) write(character);
      }
    }
  } finally {
    restore();
  }
}

export function askLine(write, fd, prompt, def = '', controls) {
  return textEntry(write, fd, prompt, def, false, controls);
}

export function askSecret(write, fd, prompt, def = '', controls) {
  return textEntry(write, fd, prompt, def, true, controls);
}

// askYesNo: y/n with a default shown in caps. Returns boolean.
export function askYesNo(write, fd, prompt, def = false) {
  if (fd == null || ASSUME_YES()) return def;
  const hint = def ? '[Y/n]' : '[y/N]';
  const ans = askLine(write, fd, `${prompt} ${hint} `, def ? 'y' : 'n');
  return /^y/i.test(ans);
}

// Keep terminal controls injectable so key sequences and cleanup can be checked without a TTY.
function enterSelectionMode(fd) {
  const saved = spawnSync('stty', ['-g'], { stdio: [fd, 'pipe', 'ignore'], encoding: 'utf8' });
  if (saved.status !== 0 || !saved.stdout?.trim()) throw new InstallCancelled();
  const restore = () => spawnSync('stty', [saved.stdout.trim()], { stdio: [fd, 'ignore', 'ignore'] });
  const raw = spawnSync('stty', ['-echo', '-icanon', '-isig', 'min', '1', 'time', '0'], { stdio: [fd, 'ignore', 'ignore'] });
  if (raw.status !== 0) { restore(); throw new InstallCancelled(); }
  return restore;
}

function choose(write, fd, question, choices, defaults, multiple, {
  read = readByte, enterRaw = enterSelectionMode,
} = {}) {
  if (!choices.length) throw new Error('A choice prompt requires at least one choice');
  const selected = choices.map(choice => defaults.includes(choice.value));
  let current = Math.max(0, selected.indexOf(true));
  const result = () => multiple
    ? choices.filter((_, i) => selected[i]).map(choice => choice.value)
    : choices[current].value;
  if (fd == null || ASSUME_YES()) return result();
  const restore = enterRaw(fd);
  let drawn = false;
  const next = () => {
    const byte = read(fd);
    if (byte == null || byte === 0x03 || byte === 0x04) throw new InstallCancelled();
    return byte;
  };
  const redraw = () => {
    if (drawn) write(`\x1b[${choices.length}A`);
    drawn = true;
    choices.forEach((choice, i) => {
      const marker = multiple ? (selected[i] ? c.green('[x]') : '[ ]') : (i === current ? c.green('(●)') : '( )');
      write(`\r\x1b[K  ${i === current ? c.cyan('> ') : '  '}${marker} ${choice.label}\n`);
    });
  };
  try {
    write(`\x1b[?25l  ${question}\n  ${c.bold('↑/↓')} move${multiple ? ', ' + c.bold('Space') + ' toggle' : ''}, ${c.bold('Enter')} confirm\n`);
    redraw();
    for (;;) {
      const byte = next();
      if (byte === 0x0d || byte === 0x0a) return result();
      if (byte === 0x1b) {
        const prefix = next();
        if (prefix === 0x5b || prefix === 0x4f) {
          const direction = next();
          if (direction === 0x41) current = (current - 1 + choices.length) % choices.length;
          if (direction === 0x42) current = (current + 1) % choices.length;
        }
      } else if (multiple && byte === 0x20) selected[current] = !selected[current];
      redraw();
    }
  } finally {
    try { restore(); } finally { write('\x1b[?25h'); }
  }
}

export function select(write, fd, question, choices, defaultValue, controls) {
  return choose(write, fd, question, choices, [defaultValue], false, controls);
}

export function multiselect(write, fd, question, choices, defaults = [], controls) {
  return choose(write, fd, question, choices, defaults, true, controls);
}

// Preserve the existing component selection API using the same keyboard implementation.
export function checkboxSelect(write, fd, specs, { title } = {}) {
  if (!specs.length) return [];
  return multiselect(write, fd, title || 'Choose components',
    specs.map(({ name, label }) => ({ value: name, label })),
    specs.filter(spec => spec.checked).map(spec => spec.name));
}
