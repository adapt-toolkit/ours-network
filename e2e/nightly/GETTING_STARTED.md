# Getting started with the nightly test suite

This guide works from the extracted archive or from the `e2e/nightly/` directory in the source tree. Run every command below from that directory. The archive is self-contained as a test harness: it downloads the pinned published npm packages during image builds and does not require the upstream source repositories.

## Requirements

- Docker Engine or Docker Desktop with the Docker Compose v2 plugin, running and available to your user.
- Python 3.9 or newer on the host. Node.js and npm run inside the images; they are not required on the host.
- Network access to the container registry and npm registry for the first build or whenever package versions change.
- Enough free disk space for several Node.js images and disposable Docker volumes.

Check the tools before starting:

```sh
docker compose version
docker info
python3 --version
```

The Compose network is isolated. The two servers, two clients, ADAPT broker, Telegram connector, Cowork, and Fleet use the published packages installed in Docker images. The Telegram API and the external ACP agent process are controlled local substitutes. The suite does not need production credentials, a real Telegram bot, or host ports.

## First run

Extract the archive, enter its top-level directory, then build and run every group:

```sh
unzip ours-nightly-e2e-suite.zip
cd ours-nightly-e2e
python3 run_all.py --build
```

The first build can take time because Docker downloads base images and npm packages. `--build` builds the images once before the functional group; the remaining groups reuse them. Each group gets its own disposable Compose project and volumes. The runner removes those resources after the group completes.

If you already have images built from the current `manifests/*.json` and Dockerfiles, use:

```sh
python3 run_all.py
```

`run_all.py` prints the path to `reports/<timestamp>-full-<id>/index.html`. Open that file for the overall result and links to the individual scenario reports and execution logs. The active gate excludes 6 TODO and 2 withdrawn executions by Owner decision; these are listed separately in `deferred.json` and the HTML index. See [DEFERRED_TESTS.md](DEFERRED_TESTS.md). Exclusions are not passes or fixes. The process exits nonzero for any failed/skipped case, missing report, unexpected case count or cleanup failure.

## Run one group or scenario

Use a focused run while editing tests or investigating a failure. After the initial image build, add `--no-build` so a test-only change does not reinstall packages:

```sh
python3 run.py --only smoke --no-build
python3 run.py --only flows --no-build
python3 run.py --only telegram --no-build
python3 run.py --only rooms-agents --no-build
python3 run.py --only regressions-fleet --no-build
python3 run.py --only regressions-client --no-build
python3 run.py --only regressions-telegram --include-deferred --no-build
python3 run.py --only regressions-component --include-deferred --no-build
```

`smoke`, `flows`, `telegram`, and `rooms-agents` are functional E2E groups. The `regressions-*` groups check documented defects and may fail until those defects are fixed. `regressions-component` uses in-process fault injection and is explicitly outside the E2E coverage count. See [TEST_MATRIX.md](./TEST_MATRIX.md) for coverage and [FINDING_COVERAGE.md](./FINDING_COVERAGE.md) for the known findings.

Select a tagged scenario within a group:

```sh
python3 run.py --only rooms-agents --tags '@cowork-room and @host-b' --no-build
python3 run.py --only regressions-telegram --include-deferred --tags @avoid-duplicate-telegram-send --no-build
```

`--include-deferred` explicitly opts into retained TODO/withdrawn checks, which are expected to fail on these unchanged packages. Without it, selecting only deferred checks fails instead of silently passing zero tests. `--tags` requires `--only` and is unavailable for `smoke`, which runs in two separate client containers. To verify room and agent behavior when server roots already exist, add `--seed-roots` to a `rooms-agents` run.

## Reports and exit codes

Every non-dry run writes reports to a new directory under `reports/`. Each scenario group produces standalone HTML, JUnit XML, and Cucumber Messages NDJSON files. Failed scenarios include assertion context and relevant attachments in the HTML report. A full run also creates `index.html` and one execution log per group. Use `--report-dir /absolute/path` with either runner to choose another destination.

A single `run.py` invocation exits nonzero if its selected group fails. The full `run_all.py` continues through every expanded case in a fresh project, and exits nonzero for any failure, skipped scenario, missing/invalid report, unexpected case count, or cleanup failure. Review `index.html` and `results.json` for all outcomes.

Runtime reports, Python caches, Docker volumes, and container logs are not part of the distribution archive. Reports stay on your host after the disposable containers are removed.

## Change package versions

Edit the exact npm versions in `manifests/client.json`, `manifests/server.json`, `manifests/broker.json`, and `manifests/agent-host.json`. These files are the source of truth for image contents; the upstream checkout is not read by the suite. Rebuild once after a version or Dockerfile change:

```sh
python3 run_all.py --build
```

When only a feature file, step definition, or mounted script changes, use `run.py --only <group> --no-build` for the affected group. The Compose bind mounts expose those changes without an image rebuild. Run the full suite when you need a complete compatibility result for a new set of package versions.

## Add a scenario

Write English Gherkin in `tests/features/*.feature`, then implement reusable parameterized steps in `tests/steps/*.mjs`. Follow the existing examples for server selection, identities, tables, and `Scenario Outline` rows. A passing E2E assertion must observe the behavior of a published package through its CLI, SDK, or service boundary; a response from the Telegram or ACP substitute alone is insufficient.

The package images include Cucumber.js. Validate feature syntax in a running test container with `node /opt/ours/tests/validate.mjs`; see [README.md](./README.md) for the manual Compose workflow and test boundary. The tests directory is mounted read-only into the containers, so feature and step changes do not need an image rebuild.

## Debug a stand

Use `--keep` with a focused run to retain its containers and volumes. The runner prints the unique Compose project name:

```sh
python3 run.py --only flows --no-build --keep
docker compose -f docker-compose.yaml -p <printed-project-name> ps
docker compose -f docker-compose.yaml -p <printed-project-name> logs --tail 100
docker compose -f docker-compose.yaml -p <printed-project-name> down --volumes --remove-orphans
```

If `docker info` fails, start Docker and retry. If a `--no-build` run reports a missing local image, build once with `python3 run_all.py --build` or run the selected group without `--no-build`. If the failure happens inside a scenario, open its HTML report first; the group's `.log` file contains container startup and runner output.

## Package the suite again

From this directory, run `python3 package_suite.py`. It writes `dist/ours-nightly-e2e-suite.zip` and a SHA-256 checksum file. The packager uses an explicit file allowlist, so generated reports, caches, logs, Docker state, and any previous archives cannot enter the new archive. The extracted archive has the same layout used by this guide.

## GitHub Actions

The repository's `Nightly E2E` workflow runs this gate for suite/workflow changes on pull requests to `main` or `prerelease`, relevant pushes to `prerelease`, manual dispatch, and daily at 03:30 UTC. Scheduled runs explicitly check out `prerelease`; GitHub enables schedules only after the workflow exists on the default branch. PR runs use the PR merge ref.

Each run installs Python 3.12, checks runner invariants, builds the pinned Docker images, and executes every active case with two workers. The job has a 60-minute limit and read-only repository permissions. It needs no repository secrets. Reports and the source ZIP are uploaded with a 14-day retention period even when the gate fails. TODO/withdrawn cases remain excluded and listed separately. Package versions are intentionally pinned, so this is repeatable testing of the selected nightly snapshot, not automatic discovery of new nightly releases.
