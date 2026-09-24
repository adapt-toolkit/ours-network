# E2E coverage matrix

> Current scope (Owner decision 2026-09-24): **37 active executions, 6 TODO, 2 withdrawn**. Product fixes are deferred. See [DEFERRED_TESTS.md](DEFERRED_TESTS.md) for reasons and explicit reproduction. Earlier failure results below are historical and remain unchanged.

Current per-execution results and new cases: [COVERAGE_MATRIX.md](./COVERAGE_MATRIX.md). Historical finding claims below do not substitute for the current run.

`Implemented` means the case makes requests to published nightly packages in separate Docker containers and asserts an externally visible result. `Planned` is a test case definition, not a claim of coverage. Keep test cases in focused scripts; run the new or changed script with only its required services while developing it.

| Area | Case | Status |
| --- | --- | --- |
| Topology | Two daemon instances advertise distinct pinned IDs | Implemented |
| Topology | Two client instances each receive only their assigned server credential | Implemented |
| Topology | Servers have separate state and root identity hierarchies | Implemented |
| Packaging | Client image contains pinned SDK, CLI, Fleet, MCP, Codex, Claude Code, Hermes and optional Fleet adapters | Separate image validation |
| Packaging | Client image has no direct daemon dependency | Separate image validation |
| Packaging | Installer produces the same role-specific installation plan and package lock | Planned |
| Auth | HMAC authority and credential issued independently on both servers | Implemented |
| Auth | Anonymous/invalid credentials cannot read private metadata | Implemented |
| Auth | A's credential cannot authenticate to B and vice versa | Implemented |
| Auth | Wrong instance pin fails before credential is sent | Implemented |
| Auth | New credential issued after installation works without reinstall | Planned |
| Auth | Credential replacement invalidates old clients and accepts reconfigured clients | Planned |
| Auth | Malformed, empty, unreadable and symlink credential files fail closed | Planned |
| Auth | Gateway denies unauthenticated Telegram control operations | Planned |
| Identity | Create roots independently and attach external sessions | Implemented |
| Identity | Duplicate root name rejected | Implemented |
| Identity | Competing external lease requires explicit forced transfer | Implemented |
| Identity | Temporary identity owner, cleanup and stale-owner recovery | Added ownership/force/delete denial and explicit retirement; stale-owner crash reconciliation deferred |
| Identity | Role delegation and root restart persistence | Planned |
| Contacts | One-time invite, redeem, bidirectional contact view | Implemented |
| Contacts | Public invite list, revoke, repeated revoke | Implemented |
| Contacts | Named public invite and malformed invite rejected | Implemented |
| Contacts | Rename/remove contact and remote deletion notice | Planned |
| Messaging | A-to-B and B-to-A delivery through the local broker | Implemented |
| Messaging | Inbox metadata, consume-on-read, durable history lookup | Implemented |
| Messaging | Reply reference and read receipt reach sender | Planned |
| Messaging | Offline broker queue, reconnection and duplicate suppression | Planned |
| Messaging | Concurrent send ordering and large message boundary | Planned |
| Commands | Advertised catalog, schema validation, remote command/result | Planned |
| Files | Send base64 payload, receive, fetch exact bytes | Implemented |
| Files | Already consumed selected file cannot be consumed twice | Implemented |
| Files | Upload session, streamed download, MIME and size limits | Planned |
| Files | Wrong identity or invalid wire ID cannot fetch bytes | Added cross-identity fetch/history denial and malformed/duplicate/mixed selected-file atomicity |
| Lifecycle | Daemon restart retains identity, contacts, messages and HMAC authority | Added SIGTERM and SIGKILL committed-state recovery, credential continuity and continued messaging |
| Lifecycle | Failure during state write cannot silently lose ratchet state | Planned |
| Lifecycle | Backups and restore into a fresh instance | Planned |
| Telegram | Published connector validates bot against local HTTPS mock | Implemented |
| Telegram | Published connector begins polling local HTTPS mock | Implemented |
| Telegram | Published connector answers an external chat's `/id` command through the mocked Telegram API | Implemented |
| Telegram | Inbound chat text reaches selected ours identity | Planned |
| Telegram | Outbound ours message calls mocked sendMessage with correct chat/topic | Planned |
| Telegram | Media getFile/download, voice STT, retry/429, malformed update | Planned |
| Telegram | Two bots, multiple routes and route removal | Planned |
| Messenger | Browser session bootstrap, authentication, send/receive | Planned |
| Messenger | Multiple sessions, push notifications, persistence | Planned |
| Cowork | Room creation, cross-server membership, participant message and room reply with either daemon as host | Implemented |
| Cowork | Room task lifecycle, permissions, removal and recovery | Planned |
| Cowork | Two-server room synchronization and conflicting edits | Planned |
| Fleet | Single task agent launches through published CLI, joins Cowork and has a live launch with either daemon as host | Implemented |
| Fleet | Pair task agents both join the same Cowork room with either daemon as host | Retested on current nightly; targeted pair/team passed after harness correction, see final matrix |
| Fleet | Registration, remote task dispatch, cancellation and recovery | Planned |
| Fleet adapters | Codex and Claude Code adapters against local protocol mocks | Planned |
| MCP | Tool discovery, invocation, errors and session termination | Added real stdio MCP discovery, create/close temporary identity and invalid invitation; native session-end hook remains untested |
| Agent integrations | Codex, Claude Code and Hermes installation and invocation | Planned |
| Security | Internal network cannot reach real Telegram or public broker | Planned |
| Security | HTTPS reverse proxy, trusted CA and rejected self-signed certificate | Planned |

The current suite deliberately avoids tests that duplicate upstream unit tests without crossing a process or network boundary. Every planned case needs a deterministic mock or fault trigger and an assertion against the remote process's state or response before it is marked implemented.
