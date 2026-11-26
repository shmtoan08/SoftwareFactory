#!/usr/bin/env python3
"""Explain the exact DAO statements and test the signed cursor against PostgreSQL."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

import probe
import work_bound as work

DAO_QUERIES = """import fs from 'node:fs';
import { timelineQueries } from './packages/database/src/timeline-read-projection.ts';
const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(inputs.map(timelineQueries)));
"""


def explain_fixture(db, report, label, scope, artifacts, requests):
    probe.seed(db, scope, artifacts, requests, 3000, submitted_ties=3000)
    probe.read_scope(db, scope)
    sources = ' UNION ALL '.join(probe.base(branch, scope) for branch in work.BRANCHES)
    cases = work.cursor_cases(db, sources)
    cases.extend(
        (f'submitted-{name}', boundary)
        for name, boundary in work.cursor_cases(db, probe.base(work.SUBMITTED, scope))
        if boundary
    )
    project, session, _ = probe.scope(scope)
    inputs = [{
        'projectId': project, 'pipelineSessionId': session, 'limit': 100,
        'after': dict(zip(('recordedAt', 'rank', 'resourceId'), boundary)) if boundary else None,
    } for _, boundary in cases]
    raw = probe.command('node', '--input-type=module', '-e', DAO_QUERIES, data=json.dumps(inputs))
    for (page, _), queries in zip(cases, json.loads(raw), strict=True):
        for query in queries:
            db.query('PREPARE actual_dao AS ' + query['sql'])
            args = ','.join(
                probe.quoting(value) if isinstance(value, str) else str(value) for value in query['params']
            )
            explain = json.loads(db.query(
                f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE actual_dao({args})'
            ))
            db.query('DEALLOCATE actual_dao')
            rows, sorts = work.inspect(explain)
            report['plans'].append(dict(fixture=label, page=page, rows_read=rows, sort_inputs=sorts,
                                        **query, explain=explain))
    db.query('ROLLBACK')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', choices=['16', '17'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    container = probe.command(
        'docker', 'run', '--rm', '-d', '-p', '127.0.0.1::5432',
        '-e', 'POSTGRES_PASSWORD=timeline_probe_fixture', f'postgres:{args.version}-alpine',
    ).strip()
    db = None
    report = {'plans': []}
    try:
        for _ in range(60):
            command = ('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q')
            if subprocess.run(command).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = probe.Session(container)
        report['version'] = db.query('SHOW server_version')
        assert report['version'] == {'16': '16.16', '17': '17.12'}[args.version]
        for migration in sorted(probe.MIGRATION.parent.glob('*.sql')):
            if not migration.name.startswith('0002'):
                db.query(migration.read_text())
        explain_fixture(db, report, 'mixed', 1, 30000, 100000)
        explain_fixture(db, report, 'all-tied', 2, 1, 3000)
        assert all(p['rows_read'] <= work.BOUND and all(n <= work.BOUND for n in p['sort_inputs'])
                   for p in report['plans']), 'DAO plan exceeded bound'
        port = probe.command('docker', 'port', container, '5432/tcp').strip().rsplit(':', 1)[1]
        subprocess.run(
            ['node', '--test', 'packages/test-harness/src/dashboard-timeline-reader.test.ts'],
            check=True, env={**os.environ, 'TIMELINE_DAO_FIXTURES': '1', 'PGHOST': '127.0.0.1',
                             'PGPORT': port, 'PGUSER': 'postgres', 'PGDATABASE': 'postgres',
                             'PGPASSWORD': 'timeline_probe_fixture'},
        )
    finally:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        if db:
            db.close()
        probe.command('docker', 'stop', container)


if __name__ == '__main__':
    main()
