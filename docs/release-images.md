# Release images

The installer workflow (`.github/workflows/installer.yml`) publishes the server images that
installers download, so users never build them locally.

| Repository (Docker Hub, public) | Dockerfile target | Variants (tag suffix) |
|---|---|---|
| `adaptframework/ours-runtime` | `runtime` | `-server` (full workspace), `-daemon` (plugin-only) |
| `adaptframework/ours-maintenance` | `maintenance` (on-demand `state-operation`: update, backup, restore, reset) | same |

Only linux/amd64 is published: the daemon's native ADAPT addon ships for linux-x64 only.
The gateway uses the digest-pinned upstream nginx image; it has no Ours image.

## When images are published

| Push | Tags (immutable) | Installer published |
|---|---|---|
| `main` with a version bump | `<X.Y.Z>-server`, `<X.Y.Z>-daemon` | `@ours.network/install@latest` |
| `main` without a version bump | `snapshot-stable-<commit12>-server`, `…-daemon` | no |
| `prerelease` | `<X.Y.Z-nightly.N>-server`, `…-daemon` | `@ours.network/install@nightly` |

Order per run: plan (version computed once) → build both roles from materialized contexts
and push by digest → describe (`images.json`: index, linux/amd64 manifest and config
digests) → qualify anonymously (fresh Docker config: pull by digest, runtime/maintenance
pair check, the installer's own runtime qualification) → write immutable tags → pack the
installer with that exact `images.json` and verify it → npm publish. A missing credential,
image or qualification failure stops the run before any installer is published. Tags are
never moved; a retried run reuses a complete published pair and refuses a partial one.
Installers always pull `repository@sha256:<index>`, never a tag. Pull requests build and
qualify the images locally without pushing.

## One-time setup (repository/organization admins)

1. **Docker Hub repositories** — create both as **Public** before the first publication
   (a first push creates a repository with the namespace's *default* privacy):
   Docker Hub → My Hub → Repositories → Create repository → Namespace `adaptframework`,
   names `ours-runtime` and `ours-maintenance`, Visibility **Public**. For an existing
   private repository: its Settings → Visibility settings → Make public.
   Optional defence in depth: enable immutable tags with the patterns
   `^\d+\.\d+\.\d+(-nightly\.\d+)?-(server|daemon)$` and `^snapshot-stable-[0-9a-f]{12}-(server|daemon)$`.
2. **Access token** — a Docker Hub access token for the `adaptframework` account (or an
   organization access token) with **Read & Write** on those two repositories.
3. **GitHub secret** — in `adapt-toolkit/ours-network` → Settings → Secrets and variables →
   Actions → New repository secret: name **`DOCKERHUB_ADAPTFRAMEWORK`**, value = the token.
   (Same name as the existing secret in `adapt-toolkit/adapt`; GitHub secrets are per
   repository unless shared as an organization secret with access for `ours-network`.)
4. **Username (optional)** — repository variable **`DOCKERHUB_USERNAME`**; when unset the
   workflow logs in as `adaptframework`.

After the first publication, `docker pull adaptframework/ours-runtime:<version>-server`
must work without `docker login`.
