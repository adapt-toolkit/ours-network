# Agent quickstart: existing installer, sensible defaults

Coordinated release target, not a claim that published installer2.1.8/integrations2.0.4 already supply automatic session identities. Use the exact approved artifact only after its daemon/integration capabilities are available. No new installer mode or mandatory Docker choice is introduced.

For an authorized first local connection, perform read-only prerequisite checks and supply ordinary options instead of opening the questionnaire. Preserve existing installation/profile/engine/source/auth/policy choices. A different existing endpoint/full workspace is a conflict to explain, not permission to overwrite it.

- Probe installed Claude/Codex with bounded --version and plugin --help. Honor nonempty CLAUDE_CODE_EXECUTABLE and CODEX_PATH as exact custom executable paths. Do not install/upgrade upstream clients. Neither supported client present: stop before installation, give the relevant official installation/login step and never claim ready. One supported client is sufficient for two sessions.
- Check Docker OR Podman readiness and use a supported available engine. Docker needs reachable Engine+Compose>=2.35; Podman must satisfy existing installer qualification/recovery checks. If both are suitable, retain prior preference, otherwise Docker is a reasonable default. Neither ready: explain the missing prerequisite; do not sudo, change groups or install/restart an engine.
- Default directory ~/.ours-install; retain an explicit existing directory. Preserve the configured Human/root. For a new installation choose a generic public pseudonym such as Local-<opaque random suffix>; do not use raw OS username/hostname as a public root/session name. The installer derives an opaque local hash label and prints it locally; no raw OS username, hostname or project basename is projected. The deterministic hash is not a security boundary.

The complete ordinary command is:

```sh
ours-install --plugin-only --state-dir ~/.ours-install --identity-name Local-OPAQUE --integrations claude-code --container-engine docker
```

Replace the illustrative name with a generated public pseudonym or the existing explicit name. Choose installed integrations: claude-code, codex or claude-code,codex. Choose supported docker or podman. All flags above already exist; advanced installer choices remain available. With all ordinary values supplied, installation is noninteractive without bypassing client/OS permissions. No Fleet/gateway/Cowork/Messenger/Telegram is included.

The exact acquired integration and selected daemon must advertise automatic identity/persistence capabilities before lifecycle policy or tool grants are written. Existing settings, deny/ask rules, complex/unknown policies and authentication remain intact. Only current_identity/list_identities/list_local_contact_book/list_local_sessions metadata tools are eligible for exact grants. Reading and sending messages retain prompts. Claude grants stay off until real native plugin-qualified tool names are qualified; no shell wildcard, file transfer, arbitrary send_command, destructive identity operations or automatic keep_identity grant. Unknown Codex releases retain prompts. Explain actual files/tool changes; do not claim every upstream client/version was tested.

Report only actually configured clients and verified versions. Choose the next action from the acquired capabilities, never the package version alone:

- Automatic identity capabilities available: open TWO new sessions. Each receives a temporary identity. Ask to list local sessions, choose the exact CID/handle and request a message. Show the actual local label. Rename changes only its label; explicit keep preserves CID/history/contacts and native resume rebinds it.
- Automatic identity capabilities unavailable or disabled (including published baseline2.1.8): explain manual setup. Open two sessions; say "use Ours as builder" in one and "use Ours as reviewer" in the other, then ask builder to message reviewer. Do not claim automatic identities or configured approval grants.

Only if grants were actually written, report their actual count and client: "Ours added approval for <n> read-only Ours tools in <client>. Other Ours tools still ask first." Today the qualified automatic grant path is Codex0.162.1 only; print no Claude grant claim. Existing restrictive policy can result in zero grants.

Keep the explicitly armed Monitor workflow. Session cleanup removes the temporary identity and local history only when a delivered end/authoritative release completes; peer copies/backups remain. If cleanup cannot finish, identity/history stay until cleanup is completed. Nothing retries automatically. On explicit request `ours-mcp retry-session-ends` retries at most20 recorded pending ends without touching active owners. This owning session may explicitly close its exact temporary identity with close_temporary_identity, retaining upstream approval. A never-recorded earlier end requires resuming that original session; otherwise report blocked without guessing or forcing.


Reruns reconcile missing Ours settings without duplicate plugins/containers/roots or changed auth. Do not claim a clean-OS/timed/end-to-end installation or live model delivery unless actually performed. Another host/person still uses invitations and trust policy.
