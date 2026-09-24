#!/usr/bin/env python3
"""Build and run isolated nightly E2E scenario groups in Docker."""
import argparse
from datetime import datetime, timezone
import os
import json
import time
from pathlib import Path
import subprocess
import sys
import uuid


HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true", help="Keep only this run's containers and volumes for debugging")
    parser.add_argument("--no-build", action="store_true", help="Reuse previously built images")
    parser.add_argument("--seed-roots", action="store_true", help="Pre-create roots before room-agent scenarios to check reuse of existing daemon state")
    parser.add_argument("--only", choices=["telegram", "flows", "smoke", "rooms-agents", "regressions-fleet", "regressions-client", "regressions-telegram", "regressions-component", "security", "recovery"], help="Run one scenario group and only its dependencies")
    parser.add_argument("--include-deferred", action="store_true", help="Explicitly run selected TODO/withdrawn regressions (expected to fail)")
    parser.add_argument("--tags", help="Pass a Cucumber tag expression to the selected scenario group")
    parser.add_argument("--report-dir", type=Path, help="Directory for generated Cucumber reports")
    parser.add_argument("--case-line", type=int)
    parser.add_argument("--crash", action="store_true")
    args = parser.parse_args()
    if args.include_deferred and not args.only:
        parser.error("--include-deferred requires --only")
    if args.tags and not args.only:
        parser.error("--tags requires --only")
    if args.tags and args.only == "smoke":
        parser.error("--tags is unavailable for the two-container smoke group")
    if args.seed_roots and args.only != "rooms-agents":
        parser.error("--seed-roots requires --only rooms-agents")
    project = "ours-e2e-" + uuid.uuid4().hex[:10]
    run_name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + project.removeprefix("ours-e2e-")
    report_dir = (args.report_dir or HERE / "reports" / run_name).expanduser().resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "COMPOSE_PROJECT_NAME": project, "OURS_E2E_REPORT_DIR": str(report_dir)}
    base = ["docker", "compose", "-f", str(HERE / "docker-compose.yaml")]

    cleanup = {"project": project, "started": datetime.now(timezone.utc).isoformat()}

    def call(*parts, check=True):
        print("+", " ".join([*base, *parts]), flush=True)
        return subprocess.run([*base, *parts], cwd=HERE, env=env, check=check, timeout=1800 if parts[0] == "build" else 300)

    def scenario(service, name):
        extra = ["--tags", args.tags] if args.tags else []
        if args.include_deferred:
            extra.append("--include-deferred")
        call("exec", "-T", "-e", f"OURS_E2E_CASE_LINE={args.case_line or ''}", service, "node", "/opt/ours/tests/run.mjs", name, *extra)

    try:
        services = {
            "security": ["telegram-mock", "broker", "server-a", "server-b", "test-runner"],
            "recovery": ["telegram-mock", "broker", "server-a", "server-b", "test-runner"],
            "telegram": ["telegram-mock", "broker", "server-a", "tg-connector"],
            "flows": ["telegram-mock", "broker", "server-a", "server-b", "test-runner"],
            "smoke": ["telegram-mock", "broker", "server-a", "server-b", "client-a", "client-b"],
            "rooms-agents": ["telegram-mock", "broker", "server-a", "server-b", "cowork-a", "cowork-b", "agent-runner"],
            "regressions-fleet": ["telegram-mock", "broker", "server-a", "server-b", "cowork-a", "cowork-b", "agent-runner"],
            "regressions-client": ["telegram-mock", "broker", "server-a", "server-b", "test-runner"],
            "regressions-component": ["component-runner"],
            "regressions-telegram": ["telegram-mock", "broker", "server-a", "tg-connector"],
        }.get(args.only, [])
        targets = ["client-a", "client-b"] if args.only == "smoke" else services[-1:]
        if not args.no_build:
            call("build", "--pull", *services)
        image_proof = {}
        for role in ('client', 'server', 'broker', 'agent-host'):
            image = f'ours-e2e-0muekpy8-{role}:review'
            installed = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, '/opt/ours/package.json'], check=True, capture_output=True, text=True, timeout=30)
            if json.loads(installed.stdout) != json.loads((HERE/'manifests'/f'{role}.json').read_text()):
                raise RuntimeError(f'Stale image manifest for {role}; rebuild before testing')
            image_proof[role] = subprocess.check_output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], text=True, timeout=30).strip()
        (report_dir/'images.json').write_text(json.dumps(image_proof, indent=2))
        call("up", "-d", "--wait", "--no-build", "--wait-timeout", "240", *targets)
        if args.only == "recovery":
            call("exec", "-T", "test-runner", "node", "/opt/ours/tests/recovery-prepare.mjs")
            if args.crash:
                call("kill", "-s", "SIGKILL", "server-a", "server-b")
                call("up", "-d", "--wait", "--no-build", "--wait-timeout", "120", "server-a", "server-b")
            else:
                call("restart", "server-a", "server-b")
                call("up", "-d", "--wait", "--no-build", "--wait-timeout", "120", "server-a", "server-b")
            if not args.crash:
                for side in ('a', 'b'):
                    call("exec", "-T", "test-runner", "node", "-e", f"const fs=require('fs'),assert=require('assert');const req=JSON.parse(fs.readFileSync('/secrets/{side}/shutdown-request.json'));const end=JSON.parse(fs.readFileSync('/secrets/{side}/shutdown-result.json'));assert.equal(req.signal,'SIGTERM');assert.ok(end.code===0 || end.signal==='SIGTERM');console.log('Confirmed graceful daemon shutdown {side}:',JSON.stringify(end));")
            scenario("test-runner", "recovery")
            return 0
        if args.only == "security":
            scenario("test-runner", "security")
            return 0
        if args.seed_roots:
            for side in ("a", "b"):
                call("exec", "-T", "agent-runner", "node", "/opt/ours/tests/seed-root.mjs", side)
        if args.only == "telegram":
            scenario("tg-connector", "telegram")
            print(f"PASS: Telegram connector scenario ({project})")
            return 0
        if args.only == "flows":
            scenario("test-runner", "flows")
            print(f"PASS: cross-server flows ({project})")
            return 0
        if args.only == "rooms-agents":
            scenario("agent-runner", "rooms-agents")
            print(f"PASS: Cowork rooms and Fleet agents ({project})")
            return 0
        if args.only == "regressions-fleet":
            scenario("agent-runner", "regressions-fleet")
            return 0
        if args.only == "regressions-client":
            scenario("test-runner", "regressions-client")
            return 0
        if args.only == "regressions-component":
            scenario("component-runner", "regressions-component")
            return 0
        if args.only == "regressions-telegram":
            scenario("tg-connector", "regressions-telegram")
            return 0
        scenario("client-a", "smoke")
        scenario("client-b", "smoke")
        call("exec", "-T", "client-a", "node", "/opt/ours/tests/verify-image.mjs")
        if args.only == "smoke":
            print(f"PASS: two-client smoke ({project})")
            return 0
        scenario("tg-connector", "telegram")
        scenario("test-runner", "flows")
        scenario("agent-runner", "rooms-agents")
        print(f"PASS: client smoke, cross-server flows, Telegram and room-agent scenarios ({project})")
        return 0
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        if not (args.only or "").startswith("regressions-"):
            call("ps", check=False)
            # Raw service logs may contain credential material; preserve safe status only.
        return getattr(error, "returncode", 124) or 1
    finally:
        if args.keep:
            print(f"Kept test project: {project}")
        else:
            try:
                result = call("down", "--volumes", "--remove-orphans", check=False)
                cleanup["exit_code"] = result.returncode
                cleanup["residuals"] = {}
                for resource in ('container', 'network', 'volume'):
                    probe = subprocess.run(['docker', resource, 'ls', '-q', '--filter', f'label=com.docker.compose.project={project}'], capture_output=True, text=True, timeout=30)
                    cleanup['residuals'][resource] = probe.stdout.splitlines()
                    if probe.returncode or probe.stdout.strip():
                        cleanup['exit_code'] = 1
                if cleanup['exit_code']:
                    raise RuntimeError("Project cleanup failed")
            finally:
                cleanup["finished"] = datetime.now(timezone.utc).isoformat()
                (report_dir / "cleanup.json").write_text(json.dumps(cleanup, indent=2))
        reports = sorted(report_dir.glob("*.html"))
        print(f"Cucumber reports: {report_dir}")
        for report in reports:
            print(f"  {report.name}")


if __name__ == "__main__":
    sys.exit(main())
