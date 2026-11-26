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
MIGRATION = probe.MIGRATION.with_name('0033_change_request_applied_timeline_index.sql')
INDEX = 'idx_change_requests_applied_timeline'
TIES = 3000
TIE_TIME = '2026-02-01T00:00:00Z'


def assert_index(db):
    definition = db.query(f"""SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='change_requests' AND indexname='{INDEX}'""")
    assert definition == (f'CREATE INDEX {INDEX} ON public.change_requests USING btree '
                          '(project_id, pipeline_session_id, applied_at DESC, cr_id DESC) '
                          'WHERE (applied_at IS NOT NULL)')
    return definition


def measure_applied(db, report, label, scope, requests, pending=0):
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
    count = int(db.query(f'SELECT count(*) FROM change_requests WHERE project_id={project} AND pipeline_session_id={session}'))
    assert (total, tied, count) == (requests, TIES, requests + pending)
    report['fixtures'][label] = {'applied': total, 'tied': tied, 'null': count - total}
    start = len(report['plans'])
    work.explain_cases(db, report, label, scope, (APPLIED,), work.cursor_cases(db, source))
    plans = report['plans'][start:]
    for plan in plans:
        plan['passed'] = plan['passed'] and plan['indexes'] == [INDEX] and not plan['sort_inputs']
        plan['passed'] = plan['passed'] and not any(
            node['Node Type'] == 'Seq Scan' and node.get('Relation Name') == 'change_requests'
            for node in work.nodes(plan['explain'][0]['Plan'])
        )
    if label == 'all-tied' and all(plan['passed'] for plan in plans):
        report['walked'] = work.verify_walk(db, scope, requests, APPLIED)
        assert report['walked'] == requests
    db.query('ROLLBACK')


def measure_regression(db, report):
    probe.read_scope(db, 1)
    branches = (work.SUBMITTED, work.BRANCHES[-1])
    sources = ' UNION ALL '.join(probe.base(branch, 1) for branch in work.BRANCHES)
    work.explain_cases(db, report, 'regression/global', 1, branches, work.cursor_cases(db, sources))
    for branch in branches:
        work.explain_cases(db, report, 'regression/branch', 1, (branch,),
                           work.cursor_cases(db, probe.base(branch, 1)))
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
            if not migration.name.startswith('0002') and migration < MIGRATION:
                db.query(migration.read_text())
        ddl = MIGRATION.read_text()
        db.query(ddl)
        report['clean_index'] = assert_index(db)
        db.query(f'BEGIN; DROP INDEX public.{INDEX}; COMMIT')
        assert db.query(f"SELECT to_regclass('public.{INDEX}')") == ''

        probe.seed(db, 1, 30000, 100000, TIES, submitted_ties=TIES)
        db.query(ddl)
        report['upgrade_index'] = assert_index(db)
        db.query(ddl)
        assert_index(db)
        measure_regression(db, report)
        measure_applied(db, report, 'mixed', 1, 100000)
        probe.seed(db, 2, 1, TIES, TIES, submitted_ties=TIES)
        measure_applied(db, report, 'all-tied', 2, TIES)
        probe.seed(db, 3, 1, TIES, TIES, pending=6000, submitted_ties=TIES)
        measure_applied(db, report, 'null-majority', 3, TIES, pending=6000)
        assert len([p for p in report['plans'] if p['fixture'] in ('mixed', 'all-tied')]) == 10
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
