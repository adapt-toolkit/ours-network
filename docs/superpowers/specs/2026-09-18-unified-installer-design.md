# Unified installer

Owner request 558: no-argument `ours-install` opens an interactive console form for the complete server and client installation. CLI arguments preset the same questions; incomplete presets fail before changes. Both modes execute the same installation/update sequence and progress reporting.

## Input and execution

The console form collects scope (all by default, server or client optional), runtime mode, installation root, install/update intent, Human display name, selected client integrations, and Fleet settings. CLI presets provide the same values. A pure parser rejects unknown/duplicate/conflicting flags and lists missing values. `native` aliases the existing internal `packages` mode. Linux x64 recommends native; macOS and Windows/WSL recommend Docker with an architecture caveat, not a speed guarantee. Advanced port overrides use documented defaults. Fleet CLI setup requires a settings file; interactive setup may run Fleet's own wizard.

One setup executor validates the entire plan and input files before mutation, displays the selected plan, then runs existing lifecycle primitives. The public executable uses this executor for both input modes. Existing maintenance verbs retain their scoped semantics. Help/version are read-only; dry-run reports the complete plan without acquiring locks or changing services.

## Server, identity and clients

Fresh server setup prepares the selected runtime and authority through the existing owning CLI. Startup becomes daemon readiness, Human identity lookup/create, then consumers. Existing root identities are retained without renaming/deletion; progress reports restoration/retention. Messenger selects the retained/created Human identity before it starts. Full-stack setup issues a separate local client credential through the owning API, never copies the API master, and uses a private profile to configure chosen integrations and Fleet.

Client package selection uses the server's retained immutable release binding (including all component pins), or an explicitly supplied full development policy. It must not silently combine an old server with unrelated installer pins. Explicit client updates can acquire a new immutable runtime and refresh the managed profile settings; ordinary legacy retry behavior remains available in internal lifecycle helpers.

## Updates and observability

Existing installation records use the existing prepared-build transition, storage compatibility gate, and retained authority/identity data. Progress covers preparation, compatibility validation, writer shutdown, identity/state update, runtime activation, restoration and readiness. Completion is reported only after requested server and client work succeeds. Docker startup failures show bounded container logs and a scoped diagnostic command. Long builds/acquisition stream output; credential operations remain captured.

Legacy installation-record conversions remain supported by existing conversion helpers. A pre-record global installation must never be silently overwritten or treated as an empty new root; owner clarification is pending for the desired legacy adapter scope.

## Validation and constraints

No local test execution per persistent Owner instruction. Tests are authored for GitHub CI: input parity, missing presets and invalid files before effects, interactive/no-TTY/cancel, both runtime modes, identity retention/create ordering, local profile issuance, source selection alignment, client refresh, update progress and actual packaged entry routing. Existing locks, channel pin verification, storage and credential protections stay in force. No daemon/service operations are performed in the developer environment. Owner merges/publishes.
