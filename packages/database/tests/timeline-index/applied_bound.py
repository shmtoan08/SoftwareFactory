#!/usr/bin/env python3
"""Check the Issue #32 applied branch before enabling it in the reader."""
import argparse
import json
from pathlib import Path
import subprocess
import time

import probe
import work_bound as work

APPLIED = (7, 'change_requests', 'applied_at', 'cr_id', '', '')
TIES = 3000
TIE_TIME = '2026-02-01T00:00:00Z'


def measure(db, report, label, scope, artifacts, requests):
    probe.seed(db, scope, artifacts, requests, TIES, submitted_ties=TIES)
    project, session, _ = map(probe.quoting, probe.scope(scope))
    db.query(f"""UPDATE change_requests
        SET status='APPLIED', applied_by_principal_id='fixture',
            applied_at=CASE WHEN cr_key IN (SELECT 'fixture-'||g FROM generate_series(1,{TIES}) g)
                THEN '{TIE_TIME}'::timestamptz ELSE decided_at + interval '1 second' END
        WHERE project_id={project} AND pipeline_session_id={session} AND status='APPROVED';
        ANALYZE change_requests""")
    probe.read_scope(db, scope)
    source = probe.base(APPLIED, scope)
    total, tied = map(int, db.query(f"""SELECT count(*),
        count(*) FILTER (WHERE ts='{TIE_TIME}'::timestamptz) FROM ({source}) AS fixture""").split('|'))
    assert total == requests and tied == TIES, 'fixture did not contain the required applied rows'
    report['fixtures'][label] = {'applied': total, 'tied': tied}
    work.explain_cases(db, report, label, scope, (APPLIED,), work.cursor_cases(db, source))
    db.query('ROLLBACK')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('major', choices=['16', '17'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    container = probe.command(
        'docker', 'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=timeline_probe_fixture',
        f'postgres:{args.major}-alpine',
    ).strip()
    report = dict(bound=work.BOUND, fixtures={}, plans=[])
    db = None
    try:
        for _ in range(60):
            if subprocess.run(('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q')).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = probe.Session(container)
        report['version'] = db.query('SHOW server_version')
        assert report['version'] == {'16': '16.16', '17': '17.12'}[args.major]
        for migration in sorted(probe.MIGRATION.parent.glob('*.sql')):
            if not migration.name.startswith('0002'):
                db.query(migration.read_text())
        measure(db, report, 'mixed', 1, 30000, 100000)
        measure(db, report, 'all-tied', 2, 1, TIES)
        assert len(report['plans']) == 10
        for row in report['plans']:
            print(f"{row['fixture']} {row['page']} stage {row['stage']}: "
                  f"rows read={row['rows_read']}, sort inputs={row['sort_inputs']}, pass={row['passed']}")
        return int(any(not row['passed'] for row in report['plans']))
    finally:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        if db:
            db.close()
        probe.command('docker', 'stop', container)


if __name__ == '__main__':
    raise SystemExit(main())
