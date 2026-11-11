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
2. **Access token**: either of these works. The login username must match the token type:
   - **Organization access token**: requires `adaptframework` to be a Docker Hub organization
     on a plan that offers organization access tokens. Restrict its resources to the two
     repositories with permission **Image Push** (`scope-image-push`, which includes pull).
     Log in with username = the organization name `adaptframework`.
   - **Personal access token**: owned by a Docker ID that has push access to both
     repositories. Access permissions **Read & Write**; a personal token is account-wide,
     not repository-scoped. Log in with username = **that Docker ID**. This is not the
     namespace unless the account itself is named `adaptframework`. (The existing
     `adapt-toolkit/adapt` workflow logs in as `adaptframework`.)

   References: https://docs.docker.com/security/access-tokens/personal-access-tokens/,
   https://docs.docker.com/security/access-tokens/organization-access-tokens/

   No delete or admin scope is needed. Repository visibility is set once by an admin
   (step 1), not by CI.
3. **GitHub secret**: in `adapt-toolkit/ours-network`, go to Settings → Secrets and variables →
   Actions → New repository secret. Name **`DOCKERHUB_ADAPTFRAMEWORK`**, value = the token.
   GitHub secrets are per repository unless shared as an organization secret with access for
   `ours-network`. This secret has the same name as the one in `adapt-toolkit/adapt`.
4. **Username**: repository variable **`DOCKERHUB_USERNAME`** = the login username from
   step 2. When unset, the workflow logs in as `adaptframework`, which is correct only for an
   organization token or the `adaptframework` account's own token.

Publication is verified without credentials: the workflow pulls every image by digest
with an empty Docker config before tagging, and again implicitly when users install.

After the first publication, `docker pull adaptframework/ours-runtime:<version>-server`
must work without `docker login`.
