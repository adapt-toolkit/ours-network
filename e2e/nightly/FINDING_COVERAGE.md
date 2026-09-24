> 2026-09-24 contract correction: Owner confirmed TLS is deployment responsibility. Historical remote-HTTP rejection failures were incorrect test expectations, not SDK defects. Current `@remote-http-endpoint` tests assert successful authenticated access. The table otherwise records historical review findings.

> Current scope (Owner decision 2026-09-24): **37 active executions, 6 TODO, 2 withdrawn**. Product fixes are deferred. See [DEFERRED_TESTS.md](DEFERRED_TESTS.md) for reasons and explicit reproduction. Earlier failure results below are historical and remain unchanged.

# Coverage of the September 22, 2026 review findings

Source: the September 22, 2026 deep review, stored outside this portable suite. The original `smoke`, `flows`, and `telegram` groups covered normal behavior and **caught none of the 12 findings**. The regression scenarios assert the desired behavior, so they are expected to fail against the pinned nightly packages. They run separately from the normal functional groups.

| Problem | Executable scenario | Coverage and observed result |
| --- | --- | --- |
| Inbound Telegram update lost after a handler failure | — | Not covered. A controlled failure while forwarding an update to the daemon and a retry check after recovery are needed. |
| Corrupt bot registry overwritten | `@preserve-corrupt-bot-registry` in `regressions-telegram.feature` | Reproduced: the connector overwrote the file with a new registry. |
| Remote HTTP rejection expectation (withdrawn) | `@remote-http-endpoint` in `regressions-client.feature` | Owner contract permits explicit HTTP endpoint + credential; now tests successful protected metadata access. Historical rejection assertion is superseded. |
| Messenger lacks end-user authentication | — | Not covered. The public proxy needs an explicit authentication contract and a test at that boundary. |
| Duplicate outgoing Telegram message after lost response | `@avoid-duplicate-telegram-send` in `regressions-telegram.feature` | Reproduced: the connector made two POSTs for one `/id` reply. Agent-originated delivery and its delivery policy are not yet covered. |
| Individual HMAC client token cannot be revoked | — | Not covered. There is no per-token revocation contract; after one exists, test that the revoked client is denied while another remains authorized. |
| Concurrent connector startup removes the primary PID | `@keep-primary-connector-pid` in `regressions-telegram.feature` | Reproduced: after the second process exits, the public `status` command no longer reports the primary PID. The PID file is diagnostic evidence. |
| Systemd unit splits a state path with spaces | `@quote-systemd-state-path` in `regressions-telegram.feature` | Reproduced for `Environment`: systemd would split the path. `ExecStart` and validation with the real systemd parser are not yet covered. |
| Codex WebSocket remains open after connection failure | `@close-codex-websocket` in `tests/component/regressions.feature` | Component regression, not E2E. Reproduced for the initialize timeout. Failure before the socket opens is not yet covered. |
| Oversized JSON request is accepted | `@limit-json-request-size` in `regressions-client.feature` | Reproduced: both small and large requests returned 200. The 2 MiB threshold is the regression expectation; a product limit still needs to be specified. |
| Closed Messenger socket remains online after late verification | — | Not covered. Production verification is synchronous; this needs a test with an injected asynchronous verifier. |
| Interrupted MCP `save_file` destroys existing content | `@preserve-file-on-interruption` in `tests/component/regressions.feature` | Component regression, not E2E. Reproduced: the call failed and the previous file became empty. |

**Eight of the 12 findings have executable scenarios that failed on the corresponding defect.** The duplicate Telegram send and spaced systemd path checks have partial coverage. Inbound update recovery, Messenger authentication, individual token revocation, and late socket verification still need regression scenarios. The normal functional groups were not rerun after these additions.

Run the known-bug groups:

```sh
python3 run.py --only regressions-client --no-build
python3 run.py --only regressions-telegram --no-build
python3 run.py --only regressions-component --no-build
```

To run one scenario in an active stand, use `node /opt/ours/tests/run.mjs regressions-component --tags @preserve-file-on-interruption` or `regressions-telegram --tags @preserve-corrupt-bot-registry`. The tests are bind-mounted, so editing a scenario does not require rebuilding an image. The group exits nonzero while at least one known bug remains. For a disposable single-scenario run, use `python3 run.py --only regressions-telegram --tags @avoid-duplicate-telegram-send --no-build`.
