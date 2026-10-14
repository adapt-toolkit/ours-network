# Nightly suite validation — 2026-09-24

The active gate passed **37 executions, 0 failed, 0 skipped** across 32 isolated Docker projects. Six TODO executions and two withdrawn executions are explicitly excluded; they are not fixed or counted as passes. No product packages were changed.

Command: `python3 run_all.py --jobs 3 --report-dir reports/active-20260924`.
Runtime: 521.90 seconds. No retries. All 32 project cleanups completed with no labeled containers, networks or volumes remaining. Independent review reconciled every JUnit result, the exclusion inventory, unchanged package image IDs and cleanup evidence.

See [active scenario matrix](ACTIVE_COVERAGE_MATRIX.md), [deferred checks](DEFERRED_TESTS.md), and [coverage gaps](SCENARIO_REVIEW.md). Generated HTML/JUnit/NDJSON reports and runtime archives are intentionally not committed. Relative report links in the matrices refer to the separately retained run artifacts, or reports regenerated with the commands below.

## Reproduce

```sh
python3 -m unittest discover -s tests -p test_runner.py
python3 run_all.py --build --jobs 3 --report-dir reports/reproduction
```

The report directory must be new. Build downloads the pinned npm packages; each scenario runs in a fresh project. See GETTING_STARTED.md for dependencies, single-group runs and explicit `--include-deferred` reproduction of excluded checks.

## Versions and environment

Host: x86_64, Python 3.12.3, Docker Engine 29.7.2, Compose 5.4.0. Images: Node 24.21.0. Dependencies are frozen by `manifests/*.json` and `manifests/*.lock.json`, installed with `npm ci`.

SDK 3.8.1-nightly.11; daemon 3.8.1-nightly.3; CLI 2.8.1-nightly.9; Fleet and adapters 1.2.0-nightly.8; MCP/Codex/Claude/Hermes 1.2.0-nightly.7; Cowork 1.3.3-nightly.20260923.2d2ff89; Telegram 1.0.1-nightly.6; Messenger 1.0.31-nightly.6; ADAPT broker/SDK 0.10.13-nightly.1; Cucumber 13.2.1.

The internal Compose network publishes no host ports and mounts no Docker socket. All identities, credentials and service state are disposable. A local HTTPS Telegram mock and deterministic ACP agent stand in for external providers. Installer/systemd boot, browser behavior and production TLS are not established by these checks.

## Additional validation

- Three runner fault checks pass: inventory, missing/malformed/failed/skipped evidence, and aggregate failure/cleanup handling while continuing later cases.
- All retained Gherkin definitions pass dry-run validation, including TODO and withdrawn definitions.
- Default client regression group executes only the two active authenticated HTTP endpoint scenarios; both pass.
- Selecting `--tags @todo` without `--include-deferred` executes zero scenarios and exits 1 with an explicit error, preventing false success.
- Wrong credentials, wrong instance pins, cross-identity access and recovery checks remain active.

## Historical results

The original full-scope run executed 45 cases: 35 passed, 10 failed, no skips. Two failures were incorrect remote-HTTP rejection expectations, replaced after the maintainer clarified that TLS is deployment responsibility and explicit endpoint plus credential is supported. The positive replacement checks passed on both servers. The other eight failures are now six TODO and two withdrawn executions, as documented separately. The original failures and their evidence were retained; the active gate does not establish original-full-scope success.

An earlier development run had 28 passes and 17 failures, including seven Fleet failures caused by an overly long Unix socket path in the harness. Shortening isolated task paths fixed that harness problem; targeted Fleet checks and the later full run passed. No blind retries were used.

Independent review accepted the final source archive (58 files, SHA-256 `b6723e98139a1e02fd8bba830ff8273567ffe6d9445527708d76d9906d4c4e30`) and separate evidence archive (791 files, SHA-256 `44149a873d345fbeb67fc140b5f77c4f225ec0967b3278d4347e34a9f9ef6573`). This PR uses the reviewed executable files unchanged; these documentation edits omit private room references and clarify artifact availability. Archives themselves are not part of the PR.
