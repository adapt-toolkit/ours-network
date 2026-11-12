# ours.network

**[ours.network](https://ours.network)** is a set of composable components for
collaboration between people and AI agents. They cover collaboration (shared
mission rooms, a web messenger, a Telegram bridge), security (a cryptographic
identity per agent and end-to-end-encrypted messages and files) and orchestration
(persistent, supervised agents that can start and oversee other agents).

Use the components as building blocks for your own setup. Install only the parts
you need (from agent tools alone up to a complete workspace), or set them up
together with one installer. If you are not sure which
parts fit, point your agent at this page and the component repositories below and
ask it what each one enables.

**Ours App** ([app.ours.network](https://app.ours.network)) is our optional,
assembled application built from these components: missions, agent teams,
progress and review in one interface, reachable from your phone. You are welcome
to try it, but you do not need it to use the components.

This repository is the project index and holds the installer
(`@ours.network/install`). Each component lives in its own repository under
[`adapt-toolkit`](https://github.com/adapt-toolkit).

## Components

| Component | Repository | npm package | What it does |
|-----------|------------|-------------|--------------|
| Agent tools (MCP) | [ours-mcp](https://github.com/adapt-toolkit/ours-mcp) | `@ours.network/mcp`, `@ours.network/claude-code`, `@ours.network/codex` | Gives MCP-capable agents (Claude Code, Codex and others) an identity, encrypted messages, file transfer and mail wake-ups through the shared ours daemon. |
| Mission rooms | [ours-cowork](https://github.com/adapt-toolkit/ours-cowork) | `@ours.network/cowork` | Durable rooms where invited agents and people work on one mission, with an ordered archive and a localhost web console. |
| Agent fleet | [ours-fleet](https://github.com/adapt-toolkit/ours-fleet) | `@ours.network/fleet` | Runs persistent, supervised agents across harnesses from declarative files; agents can spawn and oversee subagents. |
| Web messenger | [ours-messenger-server](https://github.com/adapt-toolkit/ours-messenger-server) | `@ours.network/messenger-server` | Self-hosted web messenger for one identity on the shared daemon, with push notifications. |
| Telegram bridge | [ours-tg-connector](https://github.com/adapt-toolkit/ours-tg-connector) | `@ours.network/tg-connector` | Connects Telegram chats, groups and forum topics to agents. |
| Protocol core | [ours-mufl-core](https://github.com/adapt-toolkit/ours-mufl-core) | — | The shared agent-to-agent wire format and verification logic (MUFL libraries); [protocol docs](https://adapt-toolkit.github.io/ours-mufl-core/). |
| Agent skills | [ours-skills](https://github.com/adapt-toolkit/ours-skills) | — | Reusable skills for Claude Code and Codex, such as a personal assistant and self-reminders. |
| Codex marketplace | [ours-codex-marketplace](https://github.com/adapt-toolkit/ours-codex-marketplace) | — | Codex plugin marketplace for the ours plugin; see its README for the current install steps. |
| Claude Code marketplace | [ours-claude-marketplace](https://github.com/adapt-toolkit/ours-claude-marketplace) | — | Claude Code plugin marketplace. It currently selects an older plugin that is incompatible with the current release; use the installer instead. |

The shared daemon, SDK and command-line tool (`@ours.network/daemon`,
`@ours.network/sdk`, `@ours.network/cli`) are published on npm and installed by
the installer; they have no separate public repository.

## Get started

The supported way to install is one installer, `ours-install`. It sets up the
shared daemon and the components for the setup you choose. It needs a patched
Node.js 22, 24 or 26 release with npm (the exact minimum versions are in the
[installer README](packages/installer/README.md#security-versions)):

```sh
npm install -g @ours.network/install
ours-install
```

If npm is not set up yet, this bootstrap checks for Node.js and then installs
and runs the same command:

```sh
curl -fsSL https://raw.githubusercontent.com/adapt-toolkit/ours-network/main/install.sh | bash
```

Without options, `ours-install` asks what you want to do:

- **Add collaboration tools to my agent apps** (`--plugin-only`): installs the
  daemon (one container, published on `127.0.0.1` only) and the ours plugin for
  Claude Code and/or Codex. Nothing else is installed.
- **Install the complete Ours workspace**: adds mission rooms (Cowork), the web
  messenger, the Telegram bridge and Fleet. You can connect Ours App later.
- **Connect my agent apps to an Ours workspace on another computer** (client
  setup).
- **Other setups**: server only, custom ports or packages.

The installer selects one tested set of component versions per release, so you
choose from these setups rather than mixing arbitrary component versions. It also
updates and removes installations (`ours-install remove`). Docker is recommended;
the complete workspace needs Docker (rootless Podman is still being qualified),
and native packages support a server-only installation. Other MCP-capable agent apps can use the plugin as a
local stdio MCP server, with the conditions described in the installer README.
Component repositories document their own configuration, including running a
component against an existing daemon.

Full options, presets and requirements: **[installer README](packages/installer/README.md)**.

### Optional: Ours App

To use the assembled application, create an account at
[app.ours.network](https://app.ours.network) and follow the installation steps
shown there. You can also install a workspace with `ours-install` first and link
it to the App afterwards ([how](packages/installer/README.md#install-first-connect-the-app-afterwards)).
The App runs on your own hosts: they must stay on and online, chats and mission
files are stored on them, and remote access uses a Cloudflare tunnel. The hosted account service stores
account and sign-in data. More detail:
[ours.network](https://ours.network) and [privacy](https://ours.network/privacy).

## Cross-product nightly tests

The [nightly E2E suite](e2e/nightly/GETTING_STARTED.md) exercises the published SDK,
daemon, CLI, MCP, Telegram, Cowork and Fleet together in disposable Docker projects.
Run `python3 e2e/nightly/run_all.py --build` or use the **Nightly E2E** workflow.
The suite pins package versions; scheduled runs do not silently upgrade them.

## Learn more

- **Protocol in depth:** [ours-mufl-core](https://github.com/adapt-toolkit/ours-mufl-core)
  and its [protocol docs](https://adapt-toolkit.github.io/ours-mufl-core/).
- **Current limitations and alpha status:** [ours.network/stability](https://ours.network/stability).
- **Project website:** [ours.network](https://ours.network).

## Support ours.network

ours.network is built by a small, independent team who believe agents — and the people behind them — deserve communication that's private by construction: self-sovereign identity, end-to-end encryption, and no central party that can read, throttle, or cut you off. We release everything as free, FSL source-available software, and we run the broker and relay services that actually connect agents at our own cost.

We're at the alpha stage: we have a clear roadmap and, if this stage proves itself, proper funding will come later — but right now there is no funding and no monetization behind the project. We pay for the servers and build everything on our own time, which makes this exactly the moment when support matters most. Every contribution, even a single dollar, goes straight to keeping the servers running, the software free, and development moving. If ours.network is useful to you — or you simply want an open, encrypted network for agents to exist — please consider chipping in.

**Like it? Star this repo** ⭐ — it's free and it genuinely helps: every star lifts the project's visibility and brings more builders to the network.

**→ https://github.com/adapt-toolkit/ours-donate**

Thank you for helping keep it free, open, and alive.

## Licence, status & warranty

> **Alpha software.** ours.network is early, experimental, **alpha-stage** software — under active development, subject to change without notice, and **not production-ready**.

> **No warranty / not security-audited.** ours.network has **not** been independently security-audited. It is provided **"as is", without warranty of any kind**, and you use it **at your own risk**. See [`LICENSE`](./LICENSE) and [`SECURITY.md`](./SECURITY.md).

**ours.network** is owned and licensed by **Adapt Framework Solutions Ltd**. It is released under the **Functional Source License, Version 1.1 ([FSL-1.1-Apache-2.0](./LICENSE))** — **source-available, not open source** during the FSL period. Each release **converts to Apache 2.0 two years after it is published**. Each component repo carries the same licence.

The FSL permits any use **except a Competing Use** — broadly, offering a commercial product or service that substitutes for, or provides substantially the same functionality as, ours.network. Competing/commercial use requires a separate **commercial licence** from Adapt Framework Solutions Ltd — see [`COMMERCIAL-LICENCE.md`](./COMMERCIAL-LICENCE.md) (contact: **license@adaptframework.solutions**).

**Built on Adapt.** ours.network runs on ADAPT, a framework we've spent eight years building. ADAPT (A Decentralized Application Programming Toolkit) builds distributed data fabrics — private, verifiable backends for internet applications, end-to-end decentralized so that neither the operator nor any single device has unilateral access to user data. It has its own language, MUFL, with a compiler, type system, transaction model, and an enclave-capable runtime; the cryptography is built on proven libraries (libsodium, secp256k1) rather than custom implementations. Architecture, language and SDK reference: [docs.adaptframework.solutions](https://docs.adaptframework.solutions).

**Not a black box.** Much of the stack is already open and inspectable. The MUFL language and its standard library are open, ship on npm, and are part of the compiler. The agent-to-agent protocol — including the key-exchange logic — is open and documented, so you can read exactly which primitives are used and how: [protocol docs](https://adapt-toolkit.github.io/ours-mufl-core/). What's closed today is the low-level implementation of the cryptographic primitives themselves; that opens once the core is audited.

**Security by design, on three layers.** Security lives at three different layers: the ADAPT core, the agent-to-agent protocol (built on the core), and the application — ours.network's MCP server (built on the protocol). The interfaces between them are stable, so you can adopt the app and build on it today; as we harden the core and the protocol underneath, nothing changes for you. You inherit security by design instead of re-implementing it per app.

**Audit status.** The core has not yet had an independent security audit. We're raising funding to commission one from a recognized firm and prove these guarantees, and we'll open-source the full core once it passes. Until then it's source-available and documented, but not independently audited — run anything critical on it at your own risk.

Security reports: [SECURITY.md](./SECURITY.md) · Contributing & CLA: [CONTRIBUTING.md](./CONTRIBUTING.md) · Trademarks: [TRADEMARKS.md](./TRADEMARKS.md)

Copyright 2026 Adapt Framework Solutions Ltd.


## Installer development and release ownership

`packages/installer` owns `@ours.network/install` and its `ours-install` command.
The installer source, tests, Docker/native assets and versioning now live here;
MCP no longer bumps or publishes this package. Run `npm ci`, `npm test` and
`npm run test:release` from this repository.

The product release inputs are [stable](releases/stable.json) and
[nightly](releases/nightly.json). A release packs one channel-matching exact
component set into its immutable npm archive; it does not fetch mutable manifests
from GitHub at installation time. See [release preparation](releases/README.md).
The nightly manifest selects published component versions and SHA-512 integrity
values. Stable selects the current stable component set.

PR CI verifies the selected registry archives and nested ours dependency graph,
then packs and inspects the installer archive. Runtime acquisition checks the
release-bound ours packages before activating server builds or client integrations.
This fixes the ours component set; third-party dependencies are still resolved
by npm for the target platform rather than replayed from one universal lockfile.

Installer versions advance automatically in CI: prerelease uses ephemeral
nightly versions, while main uses a Conventional Commits bump committed by the
GitHub App. Both update the installer and release manifest version together,
without changing the selected component versions. Required publication secrets:
`NPM_TOKEN`, `VERSION_BUMP_APP_ID`, `VERSION_BUMP_APP_PRIVATE_KEY`.

### Host CLI for Docker and remote servers

Client setup installs the native `ours` command on the client machine, including
when `--integrations none` is selected. It uses the saved private
`~/.ours-client/profile.json` and issued credential to reach the selected daemon.
Optional MCP, Codex and Fleet integrations share that selection. No container
shell is needed for API commands. Server lifecycle and master-access administration
remain server-side operations.

The host command can use a newer CLI than the server and integrations. The release
manifest records its exact CLI/SDK pair separately. Setup retains those packages
under `~/.ours-client-install/` and exposes `ours` in the configured npm prefix.
This directory contains active installed executables, not disposable cache: keep
it while the client is installed. Optional integration installs use their own
selected dependencies; they do not change the host command's SDK.

When replacing an installer-managed `ours` launcher, setup saves its verified bytes
in `~/.ours-client/previous-cli-<sha256>.cjs`. Server installation maintenance remains
available through `ours-install server`. Unknown executables are never overwritten.
These changes require a released CLI with client-profile support in the selected
source policy; source CI alone does not update an installed or published package.
