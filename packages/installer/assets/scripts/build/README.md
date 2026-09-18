# Build

Inputs: [sources.json](../../sources.json), access to selected Git/npm sources and,
when needed, the BuildKit secret `github_token`. Docker builds run these scripts
inside the image build; package installations run them in installer-selected
staging on the host. Outputs: npm archives and one package.json under
`OURS_BUILD_ROOT` (default `/opt/ours`) for the final installation.

| File | Responsibility |
|---|---|
| `build.mjs` | Fetch sources, run required recipes in order and generate the final manifest |
| `build-sdk.mjs` | Build SDK and CLI from one repository, including MUFL |
| `build-mcp.mjs` | Build selected packages from the MCP monorepo |
| `build-telegram.mjs`, `build-cowork.mjs`, `build-messenger.mjs`, `build-fleet.mjs` | Build the corresponding repository with the selected SDK/CLI |
| `record-build.mjs` | Finalize a fresh npm installation: record the resolved tree, protect owned inputs and verify/publish vendor context |
| `build-common.mjs` | Shared archive naming and dispatch to consumer-owned build recipes |

The Dockerfile invokes `node /build-scripts/build.mjs`; no manual script calls are
needed. Each Git repository is built once. Selected published npm packages are
retrieved without rebuilding them. Archives are created inside the image; prebuilt
dependencies are not included in the delivery directory.

Telegram, Cowork, Messenger and Fleet own `scripts/build-selected.mjs`. The
assembler passes the actual selected SDK and CLI archives with `--sdk PATH --cli
PATH --out-dir PATH`, reads the JSON `filename`, verifies the packed package name,
and collects it using the existing archive naming convention. The owning recipe
handles disposable dependency preparation, build and portable packing. Consumer
source manifests and locks are not rewritten by the assembler. Missing owner
recipes or selected SDK/CLI archives fail explicitly; there is no fallback build.
SDK and MCP retain their existing repository build owners.

After the final npm install, the owning installer/Dockerfile runs `record-build.mjs`.
It requires a fresh output with no retained dependency tree/context, verifies actual
archive bytes and lock/tree bindings, and writes context privately. An existing
context is never regenerated as historical evidence. Image export makes non-secret
provenance root-owned and readable for configured runtime UIDs; host/state copies
remain private. Docker images carrying context are labelled
`network.ours.build-context=1`; a missing/copy-failed context on such an image aborts
preparation instead of treating it as legacy.
