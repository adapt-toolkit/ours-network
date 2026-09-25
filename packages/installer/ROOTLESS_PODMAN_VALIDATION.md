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

### Disposable VM handoff

Provision a dedicated x86_64 VM (at least 4 vCPU, 8 GiB RAM, 40 GiB free disk)
whose distribution supplies Podman 6.1.2, compatible netavark/aardvark, subordinate
UID/GID support and vendor `podman-restart.service` with
`--filter should-start-on-boot=true`. Use an unprivileged test account, cgroup v2,
standard HOME/XDG paths, SELinux **Enforcing**, Node.js 22+, npm and standalone
Docker Compose 5.5.1. The Podman pass must have no Docker CLI/daemon dependency.
The VM owner must explicitly authorize reboots and terminate all sessions for the
logout test. These commands are for that disposable VM, not the shared host.

After checking out this PR and preparing installer assets/dependencies, run as the
test user (administrator provisions subordinate ranges and linger beforehand):

```sh
uname -m                              # x86_64
getenforce                           # Enforcing
podman version                       # native client 6.1.2
export PODMAN_COMPOSE_PROVIDER=/absolute/path/to/docker-compose
unset OURS_PODMAN_SOCKET DOCKER_HOST DOCKER_CONTEXT CONTAINER_HOST CONTAINER_CONNECTION
unset CONTAINERS_CONF CONTAINERS_STORAGE_CONF PODMAN_USERNS
systemctl --user enable --now podman.socket
systemctl --user enable podman-restart.service
systemctl --user show podman-restart.service --property=ExecStart
loginctl show-user "$(id -u)" --property=Linger  # yes
export PODMAN_TEST_ROOT="$HOME/ours-podman-qualification"
node install.mjs server install --mode docker --container-engine podman \
  --state-dir "$PODMAN_TEST_ROOT" --identity-name RootlessQualification
node install.mjs server status --state-dir "$PODMAN_TEST_ROOT"
node install.mjs server backup server before-rebuild --state-dir "$PODMAN_TEST_ROOT"
node install.mjs server rebuild --state-dir "$PODMAN_TEST_ROOT"
node install.mjs server restore server before-rebuild --state-dir "$PODMAN_TEST_ROOT"
```

Record all five healthy services and authenticated gateway requests. From an
external controller, end **all** test-user sessions, wait, reconnect, and repeat
status/authenticated checks. Then reboot the VM and repeat the same checks before
running any explicit start command. Capture relevant user-unit journal and
SELinux AVC evidence; no denial should be bypassed by changing enforcement.

Next explicitly stop the installation, verify empty running status, reboot, and
verify it remains stopped. Only then start explicitly and verify all services.
For unexpected-exit recovery, select the exact project from its retained record
and terminate only its verified container-init host process through a PID handle,
then verify automatic recovery and retained identity/credentials. Do not use
`podman kill` for this case: an explicit engine stop suppresses restart policy.
The following refuses a PID whose cgroup does not identify the selected container:

```sh
node install.mjs server stop --state-dir "$PODMAN_TEST_ROOT"
node install.mjs server status --state-dir "$PODMAN_TEST_ROOT"  # no running services
# Disposable-VM controller reboots here; reconnect and repeat status before start.
node install.mjs server start --state-dir "$PODMAN_TEST_ROOT"
PODMAN_TEST_PROJECT=$(node -e 'console.log(require(process.argv[1]).project)' "$PODMAN_TEST_ROOT/installation.json")
podman inspect --format '{{.State.StartedAt}} {{.RestartCount}}' "${PODMAN_TEST_PROJECT}-daemon-1"
python3 - "$PODMAN_TEST_PROJECT" <<'PYTHON'
import json, subprocess, sys
project = sys.argv[1]
container = json.loads(subprocess.check_output(['podman', 'inspect', project+'-daemon-1']))[0]
assert container['Config']['Labels']['com.docker.compose.project'] == project
assert container['State']['Running'] and container['State']['Pid'] > 1
script = """
import os, signal, sys
pid, cid = int(sys.argv[1]), sys.argv[2]
fd = os.pidfd_open(pid)
try:
    assert cid in open('/proc/'+str(pid)+'/cgroup').read(), 'Container identity mismatch'
    assert os.stat('/proc/'+str(pid)).st_uid == 1000, 'Unexpected runtime owner'
    signal.pidfd_send_signal(fd, signal.SIGKILL)
finally:
    os.close(fd)
"""
subprocess.run(['podman','unshare','python3','-c',script,str(container['State']['Pid']),container['Id']],check=True)
PYTHON
# Wait for recovery; assert changed StartedAt, increased RestartCount and health.
podman inspect --format '{{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}' "${PODMAN_TEST_PROJECT}-daemon-1"
# Verify retained identities and authenticated gateway as well.
node install.mjs server status --state-dir "$PODMAN_TEST_ROOT"
```

Still required: repeat component backup/reset/restore for daemon, Telegram,
Cowork and messenger; source update and interrupted retry; fresh schema-1 legacy
conversion fixtures; foreign/malformed volume refusal; and the equivalent full
Docker maintenance matrix. These require owned fixture data and before/after
identity, credential, provenance and mount-boundary assertions; a command exit
code alone is insufficient. The existing unit conversion tests are not a claim
that this real-engine legacy fixture matrix has run.
