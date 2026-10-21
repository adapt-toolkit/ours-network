# Local YAML Room Layout E2E

Local extension of the adopted nightly suite. Select explicit Fleet and Cowork
builds. Use the `room-layouts` group in `tests/run.mjs` or run the fixture below.

```sh
npm ci --prefix tests/layouts
node tests/layouts/run.mjs --fleet /path/to/fleet --cowork /path/to/cowork \
  --codex /path/to/codex --report-dir /path/to/reports
```

`features/room-layouts.feature` exercises shared and fresh participants through
public Fleet commands, native supervisors, Codex ACP sessions, and a private
Cowork/daemon/broker stack. A scripted text-only provider records delivered input.
It tests session reuse/isolation, YAML snapshot preservation, concurrent opens,
stale binding rejection, three distinct 3-Amigos roles, overlapping room closure,
archive retention, survival of borrowed instances, external room closure detection
and cleanup with an already stopped participant. Unit tests additionally
cover arbitrary room opening order, controller authority, native membership drift,
partial cleanup, preserved uncertainty and protection of replacement instances.

Closing a room keeps its participants alive; closing the layout retires its owned
workers. Two layout instances can open the same room key. Removing the source
Agent Template and breaking the source layout YAML preserve existing instances.

These tests verify mechanics and context availability, not model comprehension,
MCP tool selection, autonomy or conversational quality. Real-model assessment is
a separate disposable experiment, not a permanent E2E requirement. HTML, JUnit and Cucumber Messages reports are written to the selected
report directory. Never rebuild the selected Fleet while scenarios are running.

An empty scenario selection fails, including `--dry-run`.

Use `--scratch-dir /path/to/task-owned-directory` to keep all runtime state
inside a selected workspace; also select --report-dir inside that workspace
for reports and logs. The directory must already exist. The fixture
creates a private per-scenario child and keeps reports/state for inspection;
cleanup stops its processes without deleting evidence. Without this option,
Linux uses TMPDIR and macOS uses /private/tmp.

Unix socket limits apply to physical UTF-8 path bytes, not the visible symlink
alias. Scratch parents up to 61 bytes fit the current portable 103-byte budget;
longer parents fail before starting services with the calculated Cowork/Fleet
path and a shorter-directory instruction. Fleet uses its supported private
socket-root override inside that same scenario directory. A 61-byte task root
is covered by real socket-bind tests:

```sh
OURS_LAYOUT_SCRATCH_DIR=/path/to/task-owned-root node --test tests/layouts/runtime.test.mjs tests/layouts/socket-paths.test.mjs
```

Scenario directories use two random base64url characters, allocated with
exclusive mkdir (0700) and bounded collision retries. Cowork state and Fleet
sockets remain inside that directory; no sibling or global state is allocated.
Socket tests honor OURS_LAYOUT_SCRATCH_DIR (or TMPDIR), including their negative
case, and remove only directories they successfully allocated.
