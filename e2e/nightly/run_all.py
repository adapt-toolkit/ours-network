#!/usr/bin/env python3
"""Run every expanded scenario in a fresh project; fail closed on missing evidence."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent

def cases(disposition="active"):
    for path in sorted((HERE / 'tests/features').glob('*.feature')) + [HERE / 'tests/component/regressions.feature']:
        group = 'regressions-component' if path.parent.name == 'component' else path.stem
        status = "active"
        pending_tags = []
        outline = False
        table = False
        header = False
        for number, line in enumerate(path.read_text().splitlines(), 1):
            text = line.strip()
            if text.startswith('@'):
                pending_tags.extend(text.split())
            if text.startswith(('Scenario:', 'Scenario Outline:')):
                status = 'withdrawn' if '@withdrawn' in pending_tags else 'todo' if '@todo' in pending_tags else 'active'
                pending_tags = []
            if text.startswith(('Feature:', 'Examples:')):
                pending_tags = []
            if text.startswith('Scenario:'):
                outline = False
                table = False
                header = False
                if status == disposition:
                    yield group, number, text.split(':', 1)[1].strip(), False
            elif text.startswith('Scenario Outline:'):
                outline = True
                table = False
                name = text.split(':', 1)[1].strip()
            elif outline and text.startswith('Examples:'):
                table = True
                header = True
            elif table and text.startswith('|'):
                if header:
                    header = False
                elif status == disposition:
                    yield group, number, name + ' ' + text, False
    if disposition == 'active':
        yield 'recovery', None, 'Crash recovery preserves durable state', True

def summarize(directory):
    files = list(directory.glob('*.xml'))
    if not files:
        return {'tests': 0, 'failed': 0, 'skipped': 0, 'evidence_error': 'Missing JUnit report'}
    counts = dict(tests=0, failed=0, skipped=0)
    for path in files:
        try:
            cases = list(ET.parse(path).getroot().iter('testcase'))
            for case in cases:
                counts['tests'] += 1
                counts['failed'] += int(case.find('failure') is not None or case.find('error') is not None)
                counts['skipped'] += int(case.find('skipped') is not None)
        except ET.ParseError:
            counts['evidence_error'] = 'Invalid JUnit report'
    if not counts['tests']:
        counts['evidence_error'] = 'Zero executed scenarios'
    return counts

def write_index(directory, results):
    (directory / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    deferred = json.loads((directory / 'deferred.json').read_text())
    deferred_notice = f"<p>Owner-deferred: {len(deferred['todo'])} TODO executions; {len(deferred['withdrawn'])} withdrawn executions. Excluded from the gate, not passed or fixed. See <a href='deferred.json'>deferred inventory</a>.</p>"
    rows = ''.join(f'<tr><td>{escape(r["name"])}</td><td>{r["code"]}</td><td>{r["counts"]}</td><td><a href="{r["id"]}/execution.log">log</a> ' + ' '.join(f'<a href="{r["id"]}/{p.name}">{p.name}</a>' for p in (directory/r['id']).glob('*.html')) + '</td></tr>' for r in results)
    (directory / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>Nightly results</title><h1>Nightly results</h1>' + deferred_notice + '<p>Every active case uses a fresh Docker project. Any failed, skipped, absent report or cleanup failure makes the full gate fail.</p><table><tr><th>Case</th><th>Exit</th><th>Counts</th><th>Evidence</th></tr>' + rows + '</table>')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--jobs', type=int, choices=range(1,5), default=2)
    parser.add_argument('--report-dir', type=Path)
    args = parser.parse_args()
    directory = (args.report_dir or HERE/'reports'/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-full-'+uuid.uuid4().hex[:8])).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    deferred = {status: [dict(group=c[0], line=c[1], name=c[2]) for c in cases(status)] for status in ('todo', 'withdrawn')}
    (directory / 'deferred.json').write_text(json.dumps(deferred, indent=2) + '\n')
    if args.build:
        with (directory/'build.log').open('w') as log:
            subprocess.run(['docker','compose','-p','ours-e2e-0muekpy8-build','build','--pull'],cwd=HERE,stdout=log,stderr=subprocess.STDOUT,timeout=1800,check=True)
    results = []
    def run_case(item):
        index, (group, line, name, crash) = item
        case_id = f'{index:02d}-{group}'
        target = directory/case_id
        target.mkdir()
        command = [sys.executable,str(HERE/'run.py'),'--only',group,'--no-build','--report-dir',str(target)]
        if line: command += ['--case-line',str(line)]
        if crash: command += ['--crash']
        started = datetime.now(timezone.utc)
        print(f'{case_id}: {name}',flush=True)
        with (target/'execution.log').open('w') as log:
            # run.py bounds each subprocess and always tears its project down.
            process = subprocess.run(command,cwd=HERE,stdout=log,stderr=subprocess.STDOUT)
        counts = summarize(target)
        expected = 2 if group == "smoke" else 1
        if counts["tests"] != expected:
            counts["evidence_error"] = f"Expected {expected} scenarios, found {counts['tests']}"
        cleanup = target/'cleanup.json'
        cleanup_ok = cleanup.exists() and json.loads(cleanup.read_text()).get('exit_code') == 0
        code = process.returncode or int(bool(counts.get('evidence_error') or counts['failed'] or counts['skipped'] or not cleanup_ok))
        print(f'{case_id}: exit={code}, {counts}, cleanup={cleanup_ok}',flush=True)
        return dict(id=case_id,name=name,group=group,line=line,code=code,command=command,started=started.isoformat(),seconds=(datetime.now(timezone.utc)-started).total_seconds(),counts=counts,cleanup_ok=cleanup_ok,retries=0)
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for result in pool.map(run_case, enumerate(cases(), 1)):
            results.append(result)
            write_index(directory,results)
    print(f'Report index: {directory / "index.html"}',flush=True)
    return int(any(r['code'] for r in results))

if __name__ == '__main__':
    sys.exit(main())
