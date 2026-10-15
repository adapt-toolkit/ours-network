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
