# Versioned product composition

Each installer version has one exact, channel-matching nine-component npm set.
`stable.json` and `nightly.json` are release inputs, not mutable endpoints fetched
by an installed product. Packing embeds the selected manifest and exact source
policy inside the installer archive. Changes to a component set require a new
installer version; they do not bump MCP.

The initial migration intentionally leaves both sets unbound (`installerVersion:
null`, empty packages). Existing npm packages lack the reviewed external-session
contract. Packing/publication therefore fails until actual new releases have been
selected and qualified. Do not insert fake future versions or mark old artifacts
as qualified. Each package entry needs `version` and registry `integrity` (SHA512).

Before release, set the installer package version and matching manifest version,
select published same-channel versions, verify their nine archives and nested
ours dependency graph, and complete native/Docker install/update qualification.
CI verifies archive bytes and records the resolved dependency lock. That recorded
lock is evidence; this migration does not yet replay it in every platform-specific
installer build. Direct exact pins alone do not freeze all third-party dependencies.
The complete product runtime qualification remains a separate release prerequisite.
