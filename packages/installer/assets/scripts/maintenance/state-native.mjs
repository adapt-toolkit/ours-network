/** Private bindings for the existing stopped-state primitives, not a general FFI API. */
import koffi from 'koffi';
import { constants } from 'node:os';
import { getSystemErrorName } from 'node:util';

if (!['linux', 'darwin'].includes(process.platform)) {
  throw new Error('State maintenance requires supported Linux or macOS native primitives');
}
const libc = koffi.load(null);
const flock = libc.func('int flock(int fd, int operation)');
const rename = process.platform === 'darwin'
  ? libc.func('int renamex_np(const char *from, const char *to, unsigned int flags)')
  : libc.func('int renameat2(int fromfd, const char *from, int tofd, const char *to, unsigned int flags)');
const timespec = koffi.struct({ tv_sec: 'long', tv_nsec: 'long' });
const utimensat = libc.func('utimensat', 'int', ['int', 'str', koffi.pointer(timespec), 'int']);

function failure(operation, number) {
  const code = getSystemErrorName(-number);
  return Object.assign(new Error(`${operation}: ${code}`), { code, errno: number });
}

function move(from, to, flags, operation) {
  const result = process.platform === 'darwin'
    ? rename(from, to, flags)
    : rename(-100, from, -100, to, flags);
  if (result !== 0) throw failure(operation, koffi.errno());
}

export function exchange(from, to) {
  move(from, to, 2, 'atomic directory exchange');
}

export function publishNoReplace(from, to) {
  move(from, to, process.platform === 'darwin' ? 4 : 1, 'atomic no-replace publication');
}

// The caller owns the descriptor and its lifetime. Closing its final reference
// releases the lock; never unlink the lock inode or use a stale-timeout takeover.
export function tryLock(fd) {
  if (flock(fd, 2 | 4) === 0) return true;
  const number = koffi.errno();
  if ([constants.errno.EAGAIN, constants.errno.EWOULDBLOCK].includes(number)) return false;
  throw failure('state lock', number);
}

// Node's Date-based APIs lose the nanoseconds retained by the archive format.
export function setMtimeNs(path, nanoseconds) {
  let seconds = nanoseconds / 1000000000n;
  let remainder = nanoseconds % 1000000000n;
  if (remainder < 0n) { seconds -= 1n; remainder += 1000000000n; }
  const value = { tv_sec: seconds, tv_nsec: remainder };
  const darwin = process.platform === 'darwin';
  if (utimensat(darwin ? -2 : -100, path, [value, value], darwin ? 0x20 : 0x100) !== 0) {
    throw failure('restore state timestamps', koffi.errno());
  }
}
