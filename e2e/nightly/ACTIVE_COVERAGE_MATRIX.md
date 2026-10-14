# Active run matrix — 2026-09-24

Runtime artifacts referenced below are retained separately and are not committed with the suite. Run the documented commands to generate local reports.

37 passed, 0 failed, 0 skipped; 6 TODO and 2 withdrawn excluded. [Exclusion reasons](DEFERRED_TESTS.md).

| Job | Scenario | Result | Evidence |
| --- | --- | --- | --- |
| 01-flows | An invitation, messages, and a file travel from <sender> to <receiver> - Sender on server A - #1.1: An invitation, messages, and a file travel from Alice to Bob | Passed; cleanup verified | HTML (`reports/active-20260924/01-flows/flows-both.html`, separate run artifact) |
| 02-flows | An invitation, messages, and a file travel from <sender> to <receiver> - Sender on server B - #2.1: An invitation, messages, and a file travel from Bob to Alice | Passed; cleanup verified | HTML (`reports/active-20260924/02-flows/flows-both.html`, separate run artifact) |
| 03-flows | A public invitation can be revoked - Owner on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/03-flows/flows-both.html`, separate run artifact) |
| 04-flows | A public invitation can be revoked - Owner on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/04-flows/flows-both.html`, separate run artifact) |
| 05-flows | A second client cannot take a busy identity without explicit force - Owner on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/05-flows/flows-both.html`, separate run artifact) |
| 06-flows | A second client cannot take a busy identity without explicit force - Owner on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/06-flows/flows-both.html`, separate run artifact) |
| 07-flows | Server state is isolated - First identity on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/07-flows/flows-both.html`, separate run artifact) |
| 08-flows | Server state is isolated - First identity on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/08-flows/flows-both.html`, separate run artifact) |
| 09-recovery | Restarted daemons preserve identities credentials contacts and unread data | Passed; cleanup verified | HTML (`reports/active-20260924/09-recovery/recovery-both.html`, separate run artifact) |
| 10-regressions-client | A remote client uses its explicitly configured HTTP endpoint and credential - Server A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/10-regressions-client/regressions-client-both.html`, separate run artifact) |
| 11-regressions-client | A remote client uses its explicitly configured HTTP endpoint and credential - Server B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/11-regressions-client/regressions-client-both.html`, separate run artifact) |
| 12-regressions-fleet | Fleet launches two task agents into one Cowork room - Fleet hosted on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/12-regressions-fleet/regressions-fleet-agent-host.html`, separate run artifact) |
| 13-regressions-fleet | Fleet launches two task agents into one Cowork room - Fleet hosted on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/13-regressions-fleet/regressions-fleet-agent-host.html`, separate run artifact) |
| 14-regressions-fleet | Fleet launches a three-member team - Team hosts - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/14-regressions-fleet/regressions-fleet-agent-host.html`, separate run artifact) |
| 15-regressions-fleet | Fleet launches a three-member team - Team hosts - #1.2 | Passed; cleanup verified | HTML (`reports/active-20260924/15-regressions-fleet/regressions-fleet-agent-host.html`, separate run artifact) |
| 16-rooms-agents | A remote client joins a Cowork room and exchanges messages - Cowork hosted on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/16-rooms-agents/rooms-agents-agent-host.html`, separate run artifact) |
| 17-rooms-agents | A remote client joins a Cowork room and exchanges messages - Cowork hosted on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/17-rooms-agents/rooms-agents-agent-host.html`, separate run artifact) |
| 18-rooms-agents | Fleet launches a task agent into a Cowork room - Fleet hosted on A - #1.1 | Passed; cleanup verified | HTML (`reports/active-20260924/18-rooms-agents/rooms-agents-agent-host.html`, separate run artifact) |
| 19-rooms-agents | Fleet launches a task agent into a Cowork room - Fleet hosted on B - #2.1 | Passed; cleanup verified | HTML (`reports/active-20260924/19-rooms-agents/rooms-agents-agent-host.html`, separate run artifact) |
| 20-rooms-agents | Completing a Fleet task deletes its room and retires its members | Passed; cleanup verified | HTML (`reports/active-20260924/20-rooms-agents/rooms-agents-agent-host.html`, separate run artifact) |
| 21-security | Temporary ownership cannot be stolen and explicit retirement removes state | Passed; cleanup verified | HTML (`reports/active-20260924/21-security/security-both.html`, separate run artifact) |
| 22-security | Another identity cannot read a private message or file | Passed; cleanup verified | HTML (`reports/active-20260924/22-security/security-both.html`, separate run artifact) |
| 23-security | Invalid file selections do not consume valid unread files | Passed; cleanup verified | HTML (`reports/active-20260924/23-security/security-both.html`, separate run artifact) |
| 24-security | Unread batches and history cursors neither lose nor duplicate messages | Passed; cleanup verified | HTML (`reports/active-20260924/24-security/security-both.html`, separate run artifact) |
| 25-security | MCP stdio discovery and identity tools use the configured daemon | Passed; cleanup verified | HTML (`reports/active-20260924/25-security/security-both.html`, separate run artifact) |
| 26-smoke | Servers have distinct instance IDs | Passed; cleanup verified | HTML (`reports/active-20260924/26-smoke/smoke-a.html`, separate run artifact) |
| 26-smoke | Servers have distinct instance IDs | Passed; cleanup verified | HTML (`reports/active-20260924/26-smoke/smoke-b.html`, separate run artifact) |
| 27-smoke | Private metadata requires a valid credential | Passed; cleanup verified | HTML (`reports/active-20260924/27-smoke/smoke-a.html`, separate run artifact) |
| 27-smoke | Private metadata requires a valid credential | Passed; cleanup verified | HTML (`reports/active-20260924/27-smoke/smoke-b.html`, separate run artifact) |
| 28-smoke | A client attaches to its assigned server | Passed; cleanup verified | HTML (`reports/active-20260924/28-smoke/smoke-a.html`, separate run artifact) |
| 28-smoke | A client attaches to its assigned server | Passed; cleanup verified | HTML (`reports/active-20260924/28-smoke/smoke-b.html`, separate run artifact) |
| 29-smoke | A mismatched server instance ID is rejected | Passed; cleanup verified | HTML (`reports/active-20260924/29-smoke/smoke-a.html`, separate run artifact) |
| 29-smoke | A mismatched server instance ID is rejected | Passed; cleanup verified | HTML (`reports/active-20260924/29-smoke/smoke-b.html`, separate run artifact) |
| 30-smoke | A credential for one server cannot access the other | Passed; cleanup verified | HTML (`reports/active-20260924/30-smoke/smoke-a.html`, separate run artifact) |
| 30-smoke | A credential for one server cannot access the other | Passed; cleanup verified | HTML (`reports/active-20260924/30-smoke/smoke-b.html`, separate run artifact) |
| 31-telegram | The connector registers a bot, polls, and answers a chat command | Passed; cleanup verified | HTML (`reports/active-20260924/31-telegram/telegram-connector.html`, separate run artifact) |
| 32-recovery | Restarted daemons preserve identities credentials contacts and unread data | Passed; cleanup verified | HTML (`reports/active-20260924/32-recovery/recovery-both.html`, separate run artifact) |
