# Exact Ours tool approvals

Only current_identity, list_identities, list_local_contact_book and list_local_sessions metadata operations are eligible. The installer leaves reading/sending message approval settings unchanged. File transfer, send_command, identity deletion/rebinding and keep_identity are not granted automatically. User/managed restrictions remain authoritative.

Claude automatic grants are disabled pending real native qualification of plugin-qualified tool names; existing settings and prompts remain unchanged. The test-only qualified merger preserves server-wide and wildcard ask/deny rules. No permissionMode, shell allowance or authentication changes. The development host reports Claude2.1.330; compiled hook payloads were tested in an isolated fixture, not an installed live Claude model turn.

Codex qualification is exact0.162.1, not a universal floor. The generated [plugins."ours@ours-codex-marketplace".mcp_servers.ours.tools.<tool>] approval_mode="approve" entries were accepted and retained by installed0.162.1 app-server initialize/config-read in private CODEX_HOME. No thread/inference was started. Runtime semantics were inspected at immutable upstream tag rust-v0.162.1, commit7a078f6bb4ce0dc2a81408b334ce52979d92c603:

- codex-rs/config/src/mcp_types.rs: enum and conservative restrict_to composition.
- codex-rs/core/src/mcp_tool_call.rs: custom_mcp_tool_approval_mode reads selected tool/server/plugin configuration; requires_mcp_tool_approval_for_mode maps Approve to false. Strict Auto-review retains its gate.

Source: https://github.com/openai/codex/blob/7a078f6bb4ce0dc2a81408b334ce52979d92c603/codex-rs/core/src/mcp_tool_call.rs . Rolling docs: https://learn.chatgpt.com/docs/config-file/config-reference . This is source+parser verification, not a live model approval interaction or proof for every release. Unknown versions retain prompts. Explicit/complex existing TOML approval policies retain their bytes and prompts.

Installer settings require both acquired integration capabilities and selected daemon instance/capabilities. Older bundles remain unchanged with an update explanation. Explicitly disabled Ours plugins are retained before marketplace/settings mutation. Existing private lifecycle policy is preserved. Atomic writes roll back attempted changes on failure; symlink/non-regular settings files are refused. No host configuration changed during development; tests used private fixture homes.
