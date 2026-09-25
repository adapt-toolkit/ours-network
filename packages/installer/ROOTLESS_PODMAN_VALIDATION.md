# Rootless Podman integration validation

Status: implementation under review; **not a qualified server-support release**.
Validation date: 2026-09-25. No production deployment, migration, restart or merge.

## Scope and source baseline

The supplied `rootless-podman-support.zip` was inspected as design/evidence,
not executable authority. SHA-256:
`0eafc865566be71bcb87d432a98384da47e6d153e4395d9cfe721b4def168e96`.
It contains six substantive Markdown documents and no implementation patches.
Its historical ARM VM observations do not establish current Linux amd64 support.

All referenced repositories were fetched into isolated checkouts at these
`prerelease` commits. SDK, CLI and daemon share the SDK repository; the MCP
repository also supplies Codex and Claude Code integrations.

| Repository | Commit |
| --- | --- |
| ours-network | a9ae420d2878a304911e94d53d0cdd2cff06f299 |
| ours-sdk | 737e1028cabadcbb8837548923c7a92b49e9e575 |
| ours-cowork | 2d2ff8979756678068b8f6b85c619f6d811010ff |
| ours-messenger-server | 5e2ca2be5789a5300fcbed08a0dd26b9b59780ef |
| ours-tg-connector | 21f4bf92b52e1d61261987f298bcc76248cddb78 |
| ours-fleet | 717f6d8a09e6173b9b8a017fc5efb08d71927524 |
| ours-mcp | ce6e3e0298b83aec0257c4ae3773d785d8b38889 |

Runtime launch/build/maintenance and gateway packaging belong to ours-network;
no source changes were required in the other repositories. Host Fleet and harness
integrations continue using their existing client paths. Their unrelated feature
suites are not implied by the installer results below.

## Corrections established by testing

- This prerelease already checks authenticated gateway readiness during install.
  The added lifecycle check covers full starts and preserves intentionally stopped
  applications during partial runtime restoration.
- Podman 5.4.2 with Compose 5.5.1 exposes the whole named volume instead of the
  requested subpath. Its vendor restart unit also lacks `should-start-on-boot`.
  The new preflight rejects this combination rather than weakening isolation.
- Local and API Podman must select the same rootless store. Compose is passed an
  explicit Unix socket; native builds use the retained root/runroot/driver.
  Both report the same retained UID/GID mapping fingerprint.
- Podman image IDs need Docker-compatible `sha256:` normalization at the adapter
  boundary. Missing-object detection must not reinterpret inspect error 125 as
  permission to create or replace an object.
- Compose excludes maintenance profiles from ordinary configuration output and
  implicitly builds absent administration images. Native build resolution enables
  all profiles and builds the selected missing administration image first.
- Fresh schema-2 installations omit embedded `networkMcp`; the shared rebuild
  validator previously required it. Validation now accepts absence and still
  rejects malformed or conflicting embedded configuration, while retaining
  standalone-profile, credential, provenance and strict legacy conversion checks.
- Gateway COPY destinations must remain accessible to UID 101 on both engines.
  Runtime DNS comes from validated container nameservers, retaining nginx variables.

## Observed environment and results

Native Debian 13 Linux amd64, unprivileged UID 1000, subordinate UID/GID ranges,
SELinux disabled, standalone Docker Compose 5.5.1. Podman 6.1.2 was built from
upstream tag commit `04f3aa430e6df81bea059978bc5bafbc846ba3e7` with systemd and
seccomp support, using netavark/aardvark-dns 2.1.0. A separate task store and API
socket isolated all Podman tests from the installed 5.4.2 default backend.

- Behavioral preflight: PASS on 6.1.2, including UID-1000 private storage,
  volume subpath isolation, DNS, Compose reset/wait/JSON status.
- Native synthetic secret/cache build: PASS; secret absent from command arguments,
  build output, image inspect/history and final filesystem.
- Production runtime: native build of the shipped exact package/integrity policy,
  runtime metadata and gateway artifact capability qualification PASS.
- Development runtime: native build from all exact prerelease commits above,
  including private SDK/submodule acquisition through an environment build secret,
  native compilation and gateway capability qualification PASS. The source-built
  five-service lifecycle and authenticated gateway also PASS.
- Real runtime: prepare, access-init/access-issue, test Human identity, all five
  services, authenticated gateway readiness, stop/status/start PASS.
- Maintenance: server backup/restore and Cowork backup/reset/restore PASS; all
  services subsequently restarted with authenticated gateway readiness.
- Rebuild: the initial fresh-layout validator defect was reproduced and fixed;
  retained transition recovery PASS after rebuilding the maintenance helper. A
  second complete rebuild using final code and the real installation lock PASS,
  including offline state validation and authenticated gateway readiness.
- Gateway runtime: Docker 2/2 and Podman 2/2 PASS for root/nested paths,
  authentication, WebSockets and changed backend IPs. Combined Podman native
  capability/build-secret and gateway tests: 4/4 PASS.
- Installer suite: 756 passed, 0 failed, 11 opt-in tests skipped; subsequent
  adapter-only addition separately passed (13 adapter tests).
- Independent Critic reruns confirmed the behavioral/native-secret tests and
  adapter regressions. Final review is recorded separately from these observations.

The runtime harness called actual installer effects against owned resources.
It deliberately did not claim a complete public install: the isolated custom
store/socket cannot satisfy standard vendor boot-unit selection, and the public
preflight rejects that configuration. A harness backup label collision was
correctly rejected; separate per-domain labels were used afterward.

## Reproduction and remaining release gates

From `packages/installer`, with installed package dependencies:

```sh
umask 022
node --test
OURS_TEST_DOCKER=1 node --test test/gateway-docker.test.mjs
PODMAN_COMPOSE_PROVIDER=/absolute/path/to/docker-compose \
  OURS_TEST_PODMAN=1 node --test test/podman-integration.test.mjs test/gateway-docker.test.mjs
```

The gateway fixture covers root and nested base paths, discovery, service routing,
forged-host denial, Telegram authentication, WebSocket upgrade and backend IP
replacement without restarting nginx. Test projects and their resources are
uniquely named and cleaned up. The Podman tests require a functional matching API
socket; `OURS_PODMAN_SOCKET` can select an isolated harness socket.

Before advertising a supported engine/provider pair, run the full public installer
and update/rebuild/legacy-conversion matrix on a disposable native Linux amd64
host with SELinux Enforcing, standard vendor user units, logout/linger, reboot,
unexpected exit and explicit-stop behavior. Include Docker parity for the full
maintenance matrix. This shared host is not a safe reboot/SELinux test target.
No fallback to privileged containers, whole-volume service mounts, host chown,
keep-id, or globally disabled SELinux is permitted.
