# Delivering the Codex reasoning-effort fix (#235)

This installer release must select a published Fleet containing the fix in
adapt-toolkit/ours-fleet#235. Fleet `1.2.0-nightly.47` (installer
`1.2.1-nightly.36`) has `managed-cli.setup-v1` but still rejects Brain effort;
that token alone cannot qualify the fix. The release archive gate now requires
`managed-cli.codex-reasoning-effort-v1`. An affected archive must fail even if its
version and SHA512 are otherwise correct.

The nightly manifest selects published Fleet `1.2.0-nightly.50`, built from merged
commit `e8706ae9eecd3a26992da89c9c7c38651a8ea5fd` with content build ID
`f9c280d92583`. Its archive retains both managed CLI tokens and the reviewed fix,
and includes the workspace device-auth provenance correction from Fleet PR240;
the selector records its actual registry SHA512 in the manifest and source policy.
Other package selections remain unchanged. Do not substitute an affected archive
that advertises only `managed-cli.setup-v1`.

After the Owner approves the independently reviewed Fleet PR for merge and its
nightly publication completes, perform these steps in the installer checkout:

1. Read the exact published version and inspect its `dist/build-info.json`: the
   source commit must contain the reviewed fix and both managed CLI tokens.
2. Run `node scripts/select-release-package.mjs @ours.network/fleet <exact-version>`.
   It verifies the registry SHA512 against the downloaded archive before changing
   `releases/nightly.json`, embedded `assets/sources.json` and the README selection.
   It refuses archives without the fix capability and does not write on refusal.
3. Run `node scripts/verify-release.mjs --installed --require-all-capabilities`.
   This downloads the pinned archives, checks identity, SHA512 and nested ours
   versions/integrities, generates `assets/release-lock.json`, and exercises fresh
   acquisition and retained dependency recovery. This generated lock is packaged
   by CI; it is not a manually invented binding or an npm lockfile repin.
4. Run `npm run test:release`, `npm test` and the complete hosted installer checks.
   Pack the installer and compare `assets/release.json`, `assets/sources.json` and
   `assets/release-lock.json` to the qualified manifest/lock, as the existing CI
   does. Request independent Critic review of the exact updated PR head and graph.
5. With Owner authorization, merge the installer PR to prerelease and verify the
   new published installer archive embeds that qualified Fleet version and SRI.
   A published Fleet alone does not deliver the fix to installer-pinned clients.

Setup/status validation is static and starts no model or session. Actual managed
invocation requires a newly launched session. Retained updates preserve selected
Brain effort, filesystem/approval settings, identities, sessions and user config;
operators need only restart the intended agent when ready to load changed policy.
Linux scripted-provider native/ACP fixtures qualify their observed invocations;
they do not establish macOS execution or successful production task lifecycle.
