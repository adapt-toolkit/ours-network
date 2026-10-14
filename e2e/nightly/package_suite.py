#!/usr/bin/env python3
"""Create a portable source archive from an explicit suite file list."""

import argparse
from hashlib import sha256
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


HERE = Path(__file__).resolve().parent
ARCHIVE_ROOT = "ours-nightly-e2e"
FILES = (
    ".dockerignore",
    ".gitignore",
    "Dockerfile",
    "Dockerfile.mock",
    "docker-compose.yaml",
    "README.md",
    "GETTING_STARTED.md",
    "TEST_MATRIX.md",
    "FINDING_COVERAGE.md",
    "SCENARIO_REVIEW.md",
    "COVERAGE_MATRIX.md",
    "RUN_REPORT.md",
    "DEFECTS.md",
    "DEFERRED_TESTS.md",
    "ACTIVE_COVERAGE_MATRIX.md",
    "run.py",
    "run_all.py",
    "package_suite.py",
    "manifests/agent-host.json",
    "manifests/broker.json",
    "manifests/agent-host.lock.json",
    "manifests/broker.lock.json",
    "manifests/client.lock.json",
    "manifests/server.lock.json",
    "manifests/client.json",
    "manifests/server.json",
    "scripts/cowork.mjs",
    "scripts/dev-broker.mjs",
    "scripts/server.mjs",
    "scripts/telegram-mock.mjs",
    "tests/test_runner.py",
    "tests/recovery-prepare.mjs",
    "tests/features/recovery.feature",
    "tests/features/security.feature",
    "tests/steps/recovery.mjs",
    "tests/steps/security.mjs",
    "tests/mock-acp.mjs",
    "tests/run.mjs",
    "tests/seed-root.mjs",
    "tests/topology.mjs",
    "tests/validate.mjs",
    "tests/verify-image.mjs",
    "tests/component/regressions.feature",
    "tests/component/regressions.mjs",
    "tests/features/flows.feature",
    "tests/features/regressions-client.feature",
    "tests/features/regressions-fleet.feature",
    "tests/features/regressions-telegram.feature",
    "tests/features/rooms-agents.feature",
    "tests/features/smoke.feature",
    "tests/features/telegram.feature",
    "tests/steps/common.mjs",
    "tests/steps/flows.mjs",
    "tests/steps/regressions-client.mjs",
    "tests/steps/regressions-telegram.mjs",
    "tests/steps/rooms-agents.mjs",
    "tests/steps/smoke.mjs",
    "tests/steps/telegram.mjs",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=HERE / "dist" / "ours-nightly-e2e-suite.zip")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if len(FILES) != len(set(FILES)):
        raise ValueError("The package file list contains duplicate paths")
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in sorted(FILES):
            source = HERE / relative
            if not source.is_file() or source.is_symlink():
                raise FileNotFoundError(f"Missing or unsupported suite file: {relative}")
            entry = ZipInfo(f"{ARCHIVE_ROOT}/{relative}", date_time=(2026, 9, 23, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = (0o100644 << 16)
            archive.writestr(entry, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    digest = sha256(output.read_bytes()).hexdigest()
    checksum = output.with_name(output.name + ".sha256")
    checksum.write_text(f"{digest}  {output.name}\n", encoding="ascii")
    print(f"Archive: {output}")
    print(f"SHA-256: {digest}")
    print(f"Files: {len(FILES)}")


if __name__ == "__main__":
    main()
