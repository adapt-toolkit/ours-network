# Unified installer implementation plan

> **For agentic workers:** Use subagent-driven development for the independent input and onboarding modules; root owns integration and CI review.

**Goal:** One interactive/CLI installer for server, Human identity, clients and updates, with identical visible progress.

**Architecture:** Input collection produces a validated options object. A single public setup executor uses existing server and client lifecycle helpers and new scoped onboarding effects. Maintenance commands keep existing isolated behavior.

**Tech stack:** Node.js >=22, existing dependency-free console UI, node:test, GitHub Actions.

**Spec:** ../specs/2026-09-18-unified-installer-design.md

## Global constraints

- No local test execution; all verification runs in GitHub CI at Owner request.
- No host service or identity changes during development.
- Preserve pinned packages, authority ownership, locks and retained data.
- Explicit CLI missing inputs fail before mutation and never open prompts.

## Tasks

- [ ] Input module and tests: `lib/setup-options.mjs`, `test/setup-options.test.mjs`. Export `parseSetupArgs(argv,{home})`, `collectSetupOptions(effects)`, `validateSetupOptions(options,{interactive})`, `recommendedMode({platform,arch,release})`. Options are scope, operation, mode, stateDir, identityName, integrations, fleetSettingsPath, config, sources, compatible, ports, dryRun/migrate. Required sets depend on scope; interactive and CLI normalize to the same object.
- [ ] Onboarding effects and tests: `lib/server-onboarding.mjs` exports `createServerOnboarding(effects,{compose,localEnv,bin})` with `serverEnsureIdentity(record,name)` and `prepareLocalClient(record,integrations,fleetSettingsPath)`. Use verified owner CLI commands, retain root identity, issue a separate private token via existing `serverAccess`, and publish profile after successful issue. Tests assert no secret/master transfer and same selected runtime.
- [ ] Shared executor: create `lib/setup.mjs` and route `install.mjs` to it. Validate files and planned choices first; invoke existing `runServerCommand`/exported `runClientCommand` with explicit answers. Add pre-consumer identity stage and local-client handoff. Dry-run and invalid presets must not acquire locks or run subprocesses.
- [ ] Client update integration: allow explicit integrations/Fleet settings/source policy and strict noninteractive mode in `runClientCommand`. Refresh managed settings only for explicit setup; use a selection-keyed immutable client runtime for updates. Retain existing profile mismatch refusal and release graph checks.
- [ ] Update progress: instrument existing build transitions without reordering mutation, restore, compatibility or readiness steps. Show identity retention/state restoration and accurate failure phase.
- [ ] Documentation/entry tests: replace outdated user-facing CLI help and installation examples. Add tests for the public entry's route, parity, no hidden prompt, full-stack ordering, update and failure boundaries.
- [ ] Commit/push PR changes, run GitHub CI, fix failures, obtain independent review, record exact head/run and send Owner a concrete ready PR. Underlying reported Docker crash remains pending external logs.
