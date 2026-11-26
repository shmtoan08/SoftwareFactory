#!/usr/bin/env python3
"""Probe Issue #32 work bounds on all six timeline branches."""
import argparse
import json
from pathlib import Path
import subprocess
import time

import probe

LIMIT = 100
LOOKAHEAD = 1
SCAN_OVERHEAD = 1  # Allow the next-group row consumed by incremental sort.
BOUND = LIMIT + LOOKAHEAD + SCAN_OVERHEAD
MIGRATION = probe.MIGRATION.with_name('0032_change_request_submitted_timeline_index.sql')
SUBMITTED_INDEX = 'idx_change_requests_submitted_timeline'
DECIDED_INDEX = 'idx_change_requests_decided_timeline'
SUBMITTED = (5, 'change_requests', 'created_at', 'cr_id', '', '')
BRANCHES = sorted((
    (1, 'product_pipeline_sessions', 'created_at', 'pipeline_session_id', '', ''),
    *probe.BRANCHES,
    (4, 'baseline_spec_freezes', 'frozen_at', 'baseline_id', '', ''),
    SUBMITTED,
))


def nodes(node):
    yield node
    for child in node.get('Plans', []):
        yield from nodes(child)


def actual_rows(node):
    return node['Actual Rows'] * node['Actual Loops']


def scan_rows(node):
    rejected = node.get('Rows Removed by Filter', 0) + node.get('Rows Removed by Index Recheck', 0)
    return actual_rows(node) + rejected * node['Actual Loops']


def inspect(plan):
    root = plan[0]['Plan']
    scans = [node for node in nodes(root) if 'Scan' in node['Node Type'].split()]
    sorts = [node for node in nodes(root) if node['Node Type'] in ('Sort', 'Incremental Sort')]
    return (sum(map(scan_rows, scans)),
            [sum(map(actual_rows, node['Plans'])) for node in sorts])


def assert_cardinality(db):
    checks = (
        ('product_pipeline_sessions', 'p', 'pipeline_session_id'),
        ('baseline_spec_freezes', 'u', 'pipeline_session_id'),
    )
    definitions = []
    for table, kind, column in checks:
        definition = db.query(f"""SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND c.conkey=ARRAY[a.attnum]
          WHERE c.conrelid='public.{table}'::regclass AND c.contype='{kind}'
            AND c.convalidated AND a.attname='{column}'
            AND (c.contype='p' OR c.conname='uq_one_frozen_baseline_per_session')""")
        assert definition, f'expected single-column cardinality constraint on {table}.{column}'
        definitions.append(dict(table=table, constraint=definition))
    return definitions


def cursor_cases(db, source):
    # The unrestricted query is a test oracle for actual page boundary keys.
    # The page probes run after restoring the P0 timeout.
    db.query("SET LOCAL statement_timeout = '30s'")
    count = int(db.query(f'SELECT count(*) FROM ({source}) AS oracle'))
    assert count > 2 * LIMIT
    last_page_offset = ((count - 1) // LIMIT) * LIMIT
    boundaries = []
    for offset in (LIMIT - 1, last_page_offset - 1):
        ts, rank, key = db.query(
            f'SELECT ts, rank, id FROM ({source}) AS oracle '
            f'ORDER BY ts DESC, rank DESC, id DESC OFFSET {offset} LIMIT 1'
        ).split('|')
        boundaries.append((ts, int(rank), key))
    db.query("SET LOCAL statement_timeout = '2s'")
    return list(zip(('first', 'second', 'last'), (None, *boundaries)))


def explain_cases(db, report, fixture, scope, branches, cases):
    for label, boundary in cases:
        for branch in branches:
            for stage, sql in enumerate(probe.bounded(branch, scope, boundary, details=True), 1):
                explain = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}'))
                rows_read, sort_inputs = inspect(explain)
                required_index = {5: SUBMITTED_INDEX, 6: DECIDED_INDEX}.get(branch[0])
                index_scans = [node for node in nodes(explain[0]['Plan'])
                               if node['Node Type'] in ('Index Scan', 'Index Only Scan')]
                indexes = [node['Index Name'] for node in index_scans]
                correct_index = required_index is None or indexes == [required_index]
                sort_allowed = branch[0] != SUBMITTED[0] or not sort_inputs
                report['plans'].append(dict(fixture=fixture, page=label, rank=branch[0], stage=stage,
                                            boundary=boundary, rows_read=rows_read, sort_inputs=sort_inputs,
                                            indexes=indexes, passed=rows_read <= BOUND and correct_index
                                            and sort_allowed and all(n <= BOUND for n in sort_inputs),
                                            explain=explain))


def verify_walk(db, scope, expected_count, branch=SUBMITTED):
    source = probe.base(branch, scope)
    db.query("SET LOCAL statement_timeout = '30s'")
    expected = db.query(f'SELECT * FROM ({source}) AS reference ORDER BY ts DESC, id DESC').splitlines()
    db.query("SET LOCAL statement_timeout = '2s'")
    assert len(expected) == expected_count
    offset = 0
    boundary = None
    while True:
        page = []
        for sql in probe.bounded(branch, scope, boundary):
            page.extend(db.query(sql).splitlines())
            if len(page) >= LIMIT:
                break
        page = page[:LIMIT]
        assert page == expected[offset:offset + LIMIT], f'keyset page mismatch at offset {offset}'
        offset += len(page)
        if len(page) < LIMIT:
            return offset
        ts, rank, key = page[-1].split('|')
        boundary = ts, int(rank), key


def assert_index(db):
    definition = db.query(f"""SELECT indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='change_requests' AND indexname='{SUBMITTED_INDEX}'""")
    assert definition == (f'CREATE INDEX {SUBMITTED_INDEX} ON public.change_requests USING btree '
                          '(project_id, pipeline_session_id, created_at DESC, cr_id DESC)')
    return definition


def measure_inserts(db):
    project, session, baseline = map(probe.quoting, probe.scope(1))
    db.query('BEGIN')
    try:
        sql = f"""INSERT INTO change_requests(project_id,pipeline_session_id,baseline_id,cr_key,title,rationale,
            impacted_requirement_ids_json,proposed_tasks_json,requested_by_principal_id,cr_sha256)
            SELECT {project},{session},{baseline},'write-probe-'||g,'fixture','fixture',
                   '["req"]','[{{}}]','fixture',repeat('c',64) FROM generate_series(1,1000) g"""
        plan = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}'))
        assert plan[0]['Plan']['Plans'][0]['Actual Rows'] == 1000
        return plan
    finally:
        db.query('ROLLBACK')



def run(db, major, report):
    report['version'] = db.query('SHOW server_version')
    assert report['version'] == {'16': '16.16', '17': '17.12'}[major]
    assert probe.PAGE == LIMIT + LOOKAHEAD
    for migration in sorted(probe.MIGRATION.parent.glob('*.sql')):
        if not migration.name.startswith('0002') and migration < MIGRATION:
            db.query(migration.read_text())
    ddl = MIGRATION.read_text()
    db.query(ddl)
    report['clean_index'] = assert_index(db)
    db.query(f'BEGIN; DROP INDEX public.{SUBMITTED_INDEX}; COMMIT')
    assert db.query(f"SELECT to_regclass('public.{SUBMITTED_INDEX}')") == ''
    report['drop_verified'] = True
    report['cardinality'] = assert_cardinality(db)
    for label, scope, artifacts, requests, ties in (
        ('mixed', 1, 30000, 100000, 3000),
        ('all-tied', 2, 1, 3000, 3000),
    ):
        probe.seed(db, scope, artifacts, requests, 3000, submitted_ties=ties)
        if label == 'mixed':
            report['write_before'] = measure_inserts(db)
            db.query(ddl)
            report['upgrade_index'] = assert_index(db)
            report['index_bytes'] = int(db.query(f"SELECT pg_relation_size('public.{SUBMITTED_INDEX}')"))
            db.query(ddl)
            assert_index(db)
            report['write_after'] = measure_inserts(db)
            db.query('ANALYZE change_requests')
        probe.read_scope(db, scope)
        submitted = probe.base(SUBMITTED, scope)
        observed = int(db.query(f"SELECT count(*) FROM ({submitted}) AS cr WHERE ts = '{probe.STAMP}'"))
        assert observed == ties
        report['fixtures'][label] = dict(artifacts=artifacts + 4, gates=artifacts + 1,
                                         change_requests=requests, tied_submissions=observed)
        if label == 'mixed':
            source = ' UNION ALL '.join(probe.base(branch, scope) for branch in BRANCHES)
            explain_cases(db, report, 'mixed/global', scope, BRANCHES, cursor_cases(db, source))
        explain_cases(db, report, label + '/submitted', scope, (SUBMITTED,), cursor_cases(db, submitted))
        if all(p['passed'] for p in report['plans']):
            report.setdefault('walks', {})[label] = verify_walk(db, scope, requests)
        db.query('ROLLBACK')

    assert len(report['plans']) == 30
    assert {p['rank'] for p in report['plans']} == set(range(1, 7))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('major', choices=['16', '17'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    container = probe.command('docker', 'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=timeline_probe_fixture',
                              f'postgres:{args.major}-alpine').strip()
    report = dict(bound=BOUND, plans=[], fixtures={})
    db = None
    try:
        for _ in range(60):
            if subprocess.run(('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q')).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = probe.Session(container)
        run(db, args.major, report)
        failures = [p for p in report['plans'] if not p['passed']]
        for failure in failures:
            print(f"{failure['fixture']} {failure['page']} rank={failure['rank']} stage={failure['stage']}: "
                  f"read {failure['rows_read']}, sort inputs {failure['sort_inputs']}, bound {BOUND}")
        return int(bool(failures))
    finally:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        if db:
            db.close()
        probe.command('docker', 'stop', container)


if __name__ == '__main__':
    raise SystemExit(main())
