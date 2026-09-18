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

To prepare a new release, select published same-channel versions, set a new
installer version and the matching `installerVersion`, and update the workspace
lock metadata. PR CI downloads and verifies all nine archives, resolves and checks
the nested ours dependency graph, and inspects the packed installer manifest,
source policy and release lock. A failed gate prevents publication.

The packaged source policy carries the immutable release binding. Server and
client acquisition validate their actual ours dependency versions and integrity
against it before activation. An explicit development `--sources` policy without
a release binding remains a development override. This does not freeze every
third-party dependency across all platforms; npm still resolves those locally.

MCP no longer publishes the installer. Merging a release-ready change to
`prerelease` publishes this installer version with the `nightly` tag after checks;
`main` requires a stable version and uses `latest`. A changed component selection
requires a new installer version, without bumping MCP.
