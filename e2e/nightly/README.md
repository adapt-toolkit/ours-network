# Nightly Docker E2E

> Current scope (Owner decision 2026-09-24): **37 active executions, 6 TODO, 2 withdrawn**. Product fixes are deferred. See [DEFERRED_TESTS.md](DEFERRED_TESTS.md) for reasons and explicit reproduction. Earlier failure results below are historical and remain unchanged.

Start with [GETTING_STARTED.md](./GETTING_STARTED.md) for requirements, the first build, focused runs, reports, package version changes, and debugging. `python3 package_suite.py` creates a portable archive in `dist/` from an explicit list of source files.

Latest active run: **37/37 passed**, with 6 TODO and 2 withdrawn exclusions. See [active matrix](ACTIVE_COVERAGE_MATRIX.md) and [run report](RUN_REPORT.md).

## Test language

The executable scenarios are written in English Gherkin (`# language: en`) under `tests/features/`. JavaScript remains only in `tests/steps/`, where each sentence calls the published SDK/CLI and checks the result. For example:

```gherkin
Scenario: A credential for one server cannot access the other
  When I use my credential against the other server
  Then the server rejects the request with status 401
```

`tests/run.mjs` invokes Cucumber.js 13.2.1. It accepts the scenario group (`smoke`, `flows`, `telegram`, `rooms-agents`, `regressions-fleet`, `regressions-client`, `regressions-telegram`, `regressions-component`) and forwards extra Cucumber options such as `--name`, `--tags`, or `--dry-run`. `tests/validate.mjs` performs a dry run of every feature file without starting the stand.

## E2E boundary

An E2E scenario must invoke an installed package through its public CLI, SDK, or service interface and assert a result produced by that package across a process or network boundary. Mocks may stand in for external services or agent providers. Their control endpoints set up conditions, and their request logs can prove what the real package sent; a successful response from a mock alone never passes an E2E scenario. Image composition checks and in-process fault injection run separately from `tests/features/`.

## Composing scenarios

Step definitions use Cucumber parameters for scenario data: `root identity {string} exists on server {word}` works with any identity name and configured server. Repeating that step prepares multiple independent actors; later steps find the corresponding client by identity name in the scenario's isolated World. The message and file flow is one `Scenario Outline` with `Examples` for A→B and B→A. Reuse each daemon's root identity across rows because the daemon state persists for the duration of a run and each daemon supports one root. The bot name, JSON padding size, file content, and timeout values are parameters. Add a new combination by adding an example row or data-table entry when the behavior is the same; add a new step only for a new action or assertion. Protocol outcomes such as HTTP 401 remain explicit assertions because they are the behavior under test.

`Examples` lists the combinations that matter; Cucumber does not automatically run the Cartesian product of independent columns. That is intentional for this stateful E2E stand: each row starts a new scenario World, but the server volumes persist until the run ends. If a much larger matrix becomes necessary, generate example rows from a separate case table and select pairwise combinations, while keeping one report entry per case. Identity names must be unique within one scenario because later steps address actors by name.

## Generated reports

Gherkin describes test behavior; Cucumber.js generates the results. Each non-dry-run scenario group automatically writes three reports using Cucumber's built-in formatters:

Report text also includes assertion errors and timeout labels from `tests/steps/`; these are kept in English alongside the feature files.

| File | Use |
| --- | --- |
| `<group>-<container>.html` | Standalone interactive report for people, including failed steps, stack traces, and failure attachments |
| `<group>-<container>.xml` | JUnit report for CI |
| `<group>-<container>.ndjson` | Cucumber Messages for automated processing |

`run.py` saves them in a new `reports/<UTC timestamp>-<run ID>/` directory and prints its path, even when scenarios fail. The reports remain after disposable containers are removed. Use `--report-dir /absolute/path` to choose another directory. A manually started Compose stand writes to `reports/manual/` by default. Dry-run validation does not create reports. Active groups produce HTML reports. Deferred regressions require explicit `--include-deferred` and are expected to fail on these unchanged packages.

Run `python3 run_all.py` from this directory to execute all 37 active scenario executions. Six TODO and two withdrawn executions, including both component checks, are excluded and recorded separately. It keeps running after regression failures and creates one `index.html` linking each Cucumber report and execution log. Each expanded case receives a fresh project; `--jobs 1` runs serially, default is 2 isolated concurrent jobs. Use `--build` for the first run or when package manifests or Dockerfiles change; it builds the images once before the first group. The default reuses images already built.

On failure, the HTML report embeds `failure-context.json` with the scenario, server selection probes, and scenario-specific expected and actual values. Regressions also capture relevant process output, HTTP results, WebSocket state, MCP tool results, or Telegram mock requests. The systemd regression adds the generated unit as a separate text attachment. Sensitive keys and Telegram bot tokens are redacted; attachments are limited in size. Cucumber's HTML formatter renders these attachments directly in the failed scenario, so a separate log file is not needed for the captured context.

## Layout and quick start

This directory is the standalone test suite:

| Path | Purpose |
| --- | --- |
| `docker-compose.yaml` | Test stand with two servers, two clients, broker, Telegram connector and mock, Cowork and Fleet agent host, plus an isolated component runner |
| `tests/features/` | Human-readable English behavioral E2E scenarios |
| `tests/steps/` | JavaScript implementation of the E2E steps |
| `tests/component/` | Separate in-process regressions; these are not E2E coverage |
| `tests/verify-image.mjs` | Separate client-image package validation |
| `tests/run.mjs` | Small wrapper around Cucumber.js for one scenario group |
| `FINDING_COVERAGE.md` | Mapping from every report finding to an executable regression or remaining gap |
| `scripts/` | Broker, daemon and mock launchers, mounted read-only into service containers |
| `manifests/` | Exact nightly package versions installed in the images |
| `run.py` | Disposable runner with a unique Compose project and automatic cleanup |
| `run_all.py` | Run every active expanded case and generate a combined HTML index |
| `reports/` | Automatically generated reports, kept on the host and ignored by Git |

To bring up a stand for manual inspection from this directory:

```sh
docker compose -f docker-compose.yaml -p ours-nightly-test up -d --build --wait
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T client-a node /opt/ours/tests/run.mjs smoke
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T client-b node /opt/ours/tests/run.mjs smoke
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T client-a node /opt/ours/tests/verify-image.mjs
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T tg-connector node /opt/ours/tests/run.mjs telegram
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T test-runner node /opt/ours/tests/run.mjs flows
docker compose -f docker-compose.yaml -p ours-nightly-test exec -T agent-runner node /opt/ours/tests/run.mjs rooms-agents
docker compose -f docker-compose.yaml -p ours-nightly-test down --volumes
```

The tests are visible immediately through read-only bind mounts, so editing a test does not rebuild an image. Compose uses stable local image names across disposable project names. After the first build, pass `--no-build` to `run.py` when iterating on tests; rebuild when package manifests or Dockerfiles change. For the automated disposable run use `python3 run.py`.

`python3 run.py` from this directory builds a disposable, isolated Compose project with two real daemons, two real SDK/CLI client containers, a test coordinator, a real Telegram connector, the local ADAPT broker, and an HTTPS Telegram API mock. Client A receives only server A's credential; client B receives only server B's. The coordinator has both credentials to drive cross-server flows. Exact published package versions are pinned in the four `manifests/*.json` files included with the suite; the upstream source checkout is not needed. The runner creates a unique project name and deletes only its own containers, network, and volumes. `--keep` preserves them for debugging.

After editing a scenario, use `python3 run.py --only telegram`, `--only flows`, `--only smoke`, or `--only rooms-agents`. Each mode starts only the required services and runs only the selected scenario group. Add a Cucumber tag expression such as `--tags '@cowork-room and @host-b'` to run one direction. The `@host-a` and `@host-b` examples use the same Cowork and Fleet step definitions with different server and credential bindings.

Default `--only regressions-client` runs the two active authenticated HTTP endpoint checks. To reproduce deferred failures, use `--include-deferred` with the desired group and tag, for example `python3 run.py --only regressions-component --include-deferred --tags @preserve-file-on-interruption --no-build`. Selecting only excluded checks without that flag fails with a no-active-scenarios error. Deferred checks are expected to fail on the pinned packages. See [FINDING_COVERAGE.md](./FINDING_COVERAGE.md) for the exact per-problem status.

`--only rooms-agents` checks Cowork rooms and single Fleet task agents with either A or B as host against a suite-owned deterministic ACP peer. The server, guest identity, room name, Fleet template and its members come from Gherkin parameters and example tables. The tests use published CLI commands and SDK entry points; they assert authenticated room seats, message delivery, and Fleet launch state. `--only regressions-fleet` runs pair and team templates on both hosts; all four executions passed on the pinned Fleet nightly. The earlier archive claim of `ROOM_SECRET_COLLISION` is historical and was not reproduced in the final verified run. The ACP peer stands in for the external agent process; Fleet, Cowork, both daemons, and the broker remain real. These scenarios verify Fleet/Cowork provisioning and launch through the ACP boundary. They do not validate the published Codex or Claude Code ACP adapters or model-generated work; those require separate behavioral scenarios against a simulated AI service.

The executable E2E gate covers two daemon identities, HMAC credential issuance, authentication failure, credential isolation, SDK remote attachment from both clients, daemon metadata, actual Telegram connector `getMe`, `getUpdates`, and `/id` reply handling, and cross-server invitation, contact, message, file, inbox and read lifecycle through a real local broker. A separate `verify-image.mjs` check validates the client image's installed package versions and direct dependencies. It sends no traffic to Telegram or the public broker. The mock's HTTPS endpoint is selected by Docker DNS alias, and the test CA is trusted only inside this Compose project.

The main `smoke`, `flows`, and `telegram` scenarios exercise installed package entry points: the published SDK imports and npm CLI commands. They assert externally visible behavior, so replacing compatible package versions should not require rewriting the Gherkin. Only external boundaries are simulated: the Telegram API and the ACP agent provider. The relay is the real ADAPT broker package, and the daemon, SDK, connector, Cowork, and Fleet are published ours packages. Tests assert those packages' behavior; a direct request to a mock by the test runner is never itself a passing E2E result. The `regressions-client` and `regressions-telegram` groups check externally visible security, API, connector, and service behavior. Corrupt registry recovery checks the connector's persisted state, concurrent startup checks the public `status` command, and the spaced-path scenario inspects the systemd unit generated by the public CLI. The separate `regressions-component` group holds Codex WebSocket cleanup and interrupted file replacement checks, which use in-process fault injection and run without the servers or broker. The WebSocket check imports a Codex implementation file because that package does not export the low-level WebSocket client as a public API. These two checks retain coverage of known bugs but do not count as end-to-end tests.

The daemon supports one root identity per server. The Gherkin examples reuse the same root on each server while varying sender, receiver, host, and remote roles. `Given` rows describe room members and Fleet templates; the later assertions read those configured members, so a new role needs one table entry rather than a new step implementation.

Further decoupling work: test Codex WebSocket cleanup through the published `ours-codex` command against a fake Codex App Server; test interrupted file replacement through a published `ours-mcp` stdio session against the test daemon. The remote HTTP credential scenario should capture the request to prove whether the credential was sent. These changes keep behavioral scenarios independent of internal file names and module layout.

This is an initial functional gate, not yet a full suite. Coverage includes committed-state restart/crash recovery, Cowork rooms, Fleet lifecycle and MCP tools. Remaining layers include upgrade/rollback, interrupted writes, token replacement, Messenger workflows, Telegram media/error paths and real provider adapters. Each must assert externally visible results across container boundaries; upstream unit tests alone cannot establish those paths. The Telegram mock currently implements `getMe`, `getUpdates`, and `sendMessage`; every other method fails closed with HTTP 404 so missing mock behavior is visible. See [TEST_MATRIX.md](./TEST_MATRIX.md) for the exact coverage and remaining cases.

The test uses root-owned Docker volumes for credential delivery. That represents preprovisioned credentials; it does not test production secret distribution or Unix user separation. TLS to the daemon is also not configured: current daemon V1 serves HTTP, so remote production access requires an external TLS terminator.

## September 23 task revision

See `COVERAGE_MATRIX.md` for the historical 45-case run and `ACTIVE_COVERAGE_MATRIX.md` for the current 37 active executions, `SCENARIO_REVIEW.md` for risk-based decisions and remaining prerequisites, and `RUN_REPORT.md` for measured outcomes. Package versions and full dependency closure are pinned in `manifests/*.json` and `manifests/*.lock.json`; images use an isolated suite namespace. Each run records immutable image IDs in its report directory.

New groups: `python3 run.py --only security --no-build`, `python3 run.py --only recovery --no-build`, and `python3 run.py --only recovery --crash --no-build`. Recovery prepares durable state, restarts only the two project daemons and checks the same identities, credentials, contacts, history, unread file/message and continued message delivery. Graceful recovery additionally requires recorded child exit after SIGTERM. Crash recovery means committed-state recovery after SIGKILL, not interrupted-write atomicity.

`run_all.py` runs every active expanded scenario from a fresh project (including both recovery modes), so earlier failures cannot poison later cases. `run.py` without `--only` remains a quick functional batch and may stop at its first failed group; use `run_all.py` for the complete gate. Raw service logs are not copied into reports because they can contain secret material; reports retain safe status, lifecycle metadata, assertion context and explicit cleanup records. Tests use only disposable credentials generated inside the project.

### Owner HTTP contract clarification, 2026-09-24

TLS is deployment responsibility. The SDK accepts an explicit endpoint and credential; the current `@remote-http-endpoint` examples verify protected metadata access over configured HTTP on both daemons. Reproduce with `python3 run.py --only regressions-client --tags @remote-http-endpoint --no-build`. The earlier full35/10 remains historical evidence, not the current result of those two corrected tests.
