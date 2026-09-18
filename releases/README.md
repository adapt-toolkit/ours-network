# Versioned product composition

Each installer version has one exact, channel-matching nine-component npm set.
`stable.json` and `nightly.json` are release inputs, not mutable endpoints fetched
by an installed product. Packing embeds the selected manifest and exact source
policy inside the installer archive. Changes to a component set require a new
installer version; they do not bump MCP.

`nightly.json` selects the published nightly component set for the installer
version in `packages/installer/package.json`. `stable.json` remains unbound until
a stable release is prepared. Each package entry contains an exact `version` and
registry `integrity` (SHA-512); dist-tags and ranges are not release inputs.

To prepare a new component set, select published same-channel versions and
integrities in the manifest. PR CI downloads and verifies all nine archives,
checks actual installed ours dependency graphs, and inspects the packed installer.
The version bump preserves these component selections.

Publication follows the same split as the component repositories:

- `prerelease`: after gates, compute an ephemeral patch-line `X.Y.Z-nightly.N`
  above the local core version and published `latest`, with N above the published
  nightly counters. Update the installer package, workspace lock and nightly
  manifest together in the runner. Do not commit this bump; publish with `nightly`.
- `main`: derive major/minor/patch from Conventional Commits. `ci`, `test`, `docs`,
  `chore` and skip-CI commits do not publish. Commit the installer package,
  workspace lock and stable manifest together using the version-bump GitHub App,
  then publish that exact commit with `latest`.

Both paths require a complete channel-matching component manifest before
changing files or publishing. Stable therefore remains blocked until its stable
component set is selected; nightly pins are never silently converted to stable.
Registry lookup or publish failures fail the job. There is no post-publication
registry polling. Rerunning a nightly selects a fresh version once the previous
publication is visible in registry metadata.

Configure repository or available organization secrets `NPM_TOKEN`,
`VERSION_BUMP_APP_ID` and `VERSION_BUMP_APP_PRIVATE_KEY`. The GitHub App needs
repository contents-write access and permission to push the stable bump commit.
NPM_TOKEN must allow publication of `@ours.network/install`.

The packaged source policy carries the immutable release binding. Server and
client acquisition validate their actual ours dependency versions and integrity
against it before activation. An explicit development `--sources` policy without
a release binding remains a development override. This does not freeze every
third-party dependency across all platforms; npm still resolves those locally.

MCP no longer publishes the installer. Only this repository publishes the
installer; changing its component selection does not bump MCP.
