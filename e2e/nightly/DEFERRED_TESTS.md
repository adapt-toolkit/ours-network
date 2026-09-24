# Deferred and withdrawn checks — 2026-09-24

Runtime artifacts referenced below are retained separately and are not committed with the suite. Run the documented commands to generate local reports.

The maintainer deferred product fixes on 2026-09-24 and requested failing checks be excluded from the active gate. Corrupt-registry recovery and simultaneous connector support were withdrawn from the requested scope.

Default inventory: **37 active executions in 32 isolated jobs; 6 TODO executions; 2 withdrawn executions**. TODO/withdrawn are exclusions, not passes, skips or fixed defects. Existing passing security/recovery checks remain active. Positive authenticated HTTP endpoint checks remain active on A and B. Product packages and pinned versions are unchanged.

| Status | Tag | Executions | Reason / boundary | Historical evidence |
| --- | --- | ---: | --- | --- |
| TODO | `@limit-json-request-size` | 2 | Size contract deferred; 2 MiB JSON padding is not a verified MUFL payload limit. Must define byte boundary before implementation. | full-final/12–13-regressions-client |
| TODO | `@quote-systemd-state-path` | 1 | Valid normal configuration (spaces in path), deferred by the instruction to remove red tests; not classified as abnormal input. | full-final/20-regressions-telegram |
| TODO | `@avoid-duplicate-telegram-send` | 1 | Lost response after accepted POST. Future contract: one attempt, no automatic resend. | full-final/21-regressions-telegram |
| TODO | `@preserve-file-on-interruption` | 1 | Interrupted stream can truncate export destination. Future hash-addressed caching must publish complete verified data atomically and preserve authorization and existing export files. | full-final/38-regressions-component |
| TODO | `@close-codex-websocket` | 1 | Initialize timeout after connection opens. Frequency unknown; controlled test proves socket remains open beyond 500 ms only. | full-final/39-regressions-component |
| Withdrawn | `@preserve-corrupt-bot-registry` | 1 | Owner does not want this bot-registry recovery check. | full-final/18-regressions-telegram |
| Withdrawn | `@keep-primary-connector-pid` | 1 | Simultaneous connectors are outside Owner-supported scope. | full-final/19-regressions-telegram |

Definitions and step implementations remain in the source as reproducible records. Scenario-level `@todo` / `@withdrawn` tags exclude them from both default runners. `run_all.py` emits `deferred.json` and an HTML notice with separate counts. A direct selection containing only excluded cases fails with “No active scenarios selected”; it cannot silently pass zero tests. Dry-run validation still checks every retained definition, including deferred checks.

To explicitly reproduce a deferred check (expected failure on unchanged packages):

```sh
python3 run.py --only regressions-component --include-deferred --tags @preserve-file-on-interruption --no-build
python3 run.py --only regressions-telegram --include-deferred --tags @quote-systemd-state-path --no-build
python3 run.py --only regressions-client --include-deferred --tags @limit-json-request-size --no-build
```

The initial [45-execution matrix](COVERAGE_MATRIX.md) and 35 passed / 10 failed full run (`reports/full-final/index.html`, separate run artifact) remain historical evidence. The HTTP correction has separate 2/2 evidence. A fresh active-only run is reported separately in RUN_REPORT.md; excluding a failure never rewrites its original outcome.
