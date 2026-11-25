#!/usr/bin/env python3
"""Run Issue #34 against disposable PostgreSQL Docker instances."""
import argparse
import json
import re
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
MIGRATION = ROOT / 'packages/database/migrations/0031_timeline_read_indexes.sql'
CONTRACT = ROOT / 'apps/core-api/docs/dashboard-timeline-event-reader-s0.md'
BRANCHES = (
    (2, 'stage_artifacts', 'created_at', 'artifact_id', 'idx_stage_artifacts_timeline', ', artifact_sha256'),
    (3, 'stage_approval_gates', 'decided_at', 'gate_id', 'idx_stage_approval_gates_timeline',
     ', decision, target_artifact_id, target_artifact_sha256'),
    (6, 'change_requests', 'decided_at', 'cr_id', 'idx_change_requests_decided_timeline', ''),
)
PAGE = 101
STAMP = '2026-01-01 00:00:00+00'


def quoting(value):
    return "'" + str(value).replace("'", "''") + "'"


def command(*args, data=None):
    return subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE, check=True).stdout


class Session:
    def __init__(self, container):
        self.proc = subprocess.Popen(
            ('docker', 'exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'),
            text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )

    def query(self, sql):
        marker = 'probe_' + uuid.uuid4().hex
        self.proc.stdin.write(f'{sql.rstrip().rstrip(";")};\n\\echo {marker}\n')
        self.proc.stdin.flush()
        lines = []
        for line in self.proc.stdout:
            if line.rstrip() == marker:
                return ''.join(lines).strip()
            lines.append(line)
        raise RuntimeError(f'psql ended while running {sql[:180]}')

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


def scope(number):
    return tuple(f'{part}0000000-0000-0000-0000-{number:012d}' for part in (1, 2, 3))


def seed(db, number, artifacts, requests, ties, pending=0, cr_ties=None, submitted_ties=0):
    project, session, baseline = map(quoting, scope(number))
    fixture = (HERE / 'fixture.sql').read_text()
    values = dict(p=project, s=session, b=baseline, artifacts=artifacts, requests=requests,
                  ties=ties, pending=pending, cr_ties=cr_ties or ties, submitted_ties=submitted_ties)
    db.query(re.sub(r'(?<!:):(p|s|b|artifacts|requests|ties|pending|cr_ties|submitted_ties)\b', lambda match: str(values[match[1]]), fixture))


def read_scope(db, number):
    db.query(f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE app_runtime;
SET LOCAL statement_timeout = '2s';
SET LOCAL lock_timeout = '250ms';
SELECT set_config('app.current_project_id', {quoting(scope(number)[0])}, true),
       set_config('app.current_principal_id', 'fixture', true),
       set_config('app.current_role', 'core_api_service', true)""")
    assert db.query("""SELECT current_user, current_setting('transaction_read_only'),
        current_setting('transaction_isolation'), current_setting('row_security')""") == 'app_runtime|on|repeatable read|on'


def base(branch, number, details=False):
    rank, table, stamp, key, _, extra = branch
    project, session, _ = map(quoting, scope(number))
    return (f"SELECT {stamp} AS ts, {rank} AS rank, {key} AS id{extra if details else ''} FROM {table}"
            f" WHERE project_id={project}::uuid AND pipeline_session_id={session}::uuid AND {stamp} IS NOT NULL")


def bounded(branch, number, boundary=None, details=False):
    rank, _, stamp, key, _, _ = branch
    query = base(branch, number, details)
    clauses = ['']
    if boundary:
        ts, boundary_rank, uuid_value = boundary
        ts = quoting(ts) + '::timestamptz'
        if rank == boundary_rank:
            clauses = [f' AND {stamp} = {ts} AND {key} < {quoting(uuid_value)}::uuid', f' AND {stamp} < {ts}']
        else:
            operator = '<=' if rank < boundary_rank else '<'
            clauses = [f' AND {stamp} {operator} {ts}']
    return [query + clause + f' ORDER BY {stamp} DESC, {key} DESC LIMIT {PAGE}' for clause in clauses]


def assert_plan(plan, index):
    def walk(node):
        yield node
        for child in node.get('Plans', []):
            yield from walk(child)

    nodes = list(walk(plan[0]['Plan']))
    scans = [node for node in nodes if node['Node Type'] in ('Index Scan', 'Index Only Scan')]
    assert len(scans) == 1 and scans[0]['Index Name'] == index, 'expected ordered scan on ' + index
    scan = scans[0]
    assert scan.get('Rows Removed by Filter', 0) == 0, 'index scan dropped rows'
    assert 'Filter' not in scan, 'residual index scan filter'
    assert scan['Actual Rows'] <= PAGE and scan['Actual Loops'] <= 1, 'index scan exceeded page bound'
    assert all(node['Node Type'] in ('Limit', 'Result', 'Index Scan', 'Index Only Scan') for node in nodes), 'unexpected plan node'


def plan_matrix(db, number, label, report):
    for branch in BRANCHES:
        rank, _, _, _, index, _ = branch
        tied = db.query(f"SELECT id FROM ({base(branch, number)}) AS src WHERE ts = '{STAMP}' ORDER BY id DESC").splitlines()
        assert len(tied) >= (100000 if label == 'second-scale' and rank == 6 else 3000)
        neighbor_ts, neighbor_id = db.query(f"SELECT ts, id FROM ({base(branch, number)}) AS src "
            f"WHERE ts > '{STAMP}' ORDER BY ts, id LIMIT 1").split('|')
        cases = [('first-page', None)]
        for place, anchor_ts, anchor_id in (
            ('group-start', STAMP, tied[0]), ('group-middle', STAMP, tied[len(tied)//2]),
            ('group-end', STAMP, tied[-1]), ('between-groups', neighbor_ts, neighbor_id),
        ):
            cases.extend((f'{place}/{relation}', (anchor_ts, test_rank, anchor_id))
                         for relation, test_rank in [('below', rank+1), ('equal', rank), ('above', rank-1)])
        for case, boundary in cases:
            for stage, sql in enumerate(bounded(branch, number, boundary, details=True), 1):
                plan = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}'))
                entry = dict(fixture=label, branch=rank, case=case, boundary=boundary, stage=stage, explain=plan)
                report['plans'].append(entry)
                try:
                    assert_plan(plan, index)
                except AssertionError as error:
                    entry['failure'] = str(error)


def verify_walk(db, number, report, label):
    sources = ' UNION ALL '.join(base(branch, number) for branch in BRANCHES)
    # Only the test oracle performs a full sort. Restore P0 before fetching any page.
    db.query("SET LOCAL statement_timeout = '30s'")
    expected = db.query(f'SELECT * FROM ({sources}) AS reference ORDER BY ts DESC, rank DESC, id DESC').splitlines()
    db.query("SET LOCAL statement_timeout = '2s'")
    offset = 0
    boundary = None
    while True:
        sources = ' UNION ALL '.join(f'({sql})' for branch in BRANCHES for sql in bounded(branch, number, boundary))
        page = db.query(f'SELECT * FROM ({sources}) AS page ORDER BY ts DESC, rank DESC, id DESC LIMIT 100').splitlines()
        assert page == expected[offset:offset+100], f'page mismatch at offset {offset}'
        offset += len(page)
        if len(page) < 100:
            break
        ts, rank, key = page[-1].split('|')
        boundary = ts, int(rank), key
    assert offset == len(expected)
    report.setdefault('walks', {})[label] = offset


def measure_writes(db, report):
    project, frozen, _ = map(quoting, scope(2))
    active = "'20000000-0000-0000-0000-000000000003'"
    statements = {
        'insert-artifacts': f"""INSERT INTO stage_artifacts(project_id,pipeline_session_id,stage,artifact_kind,version,
            provider,model,prompt_id,prompt_version,prompt_sha256,content_json,artifact_sha256,created_by_principal_id)
            SELECT {project},{active},'STAGE_1_IDEA_DISCOVERY','STAGE_1_DISCOVERY_BUNDLE',g,'system','fixture','fixture','1',
                   repeat('a',64),'{{}}',encode(digest('{{}}','sha256'),'hex'),'fixture'
            FROM generate_series(1,100) g""",
        'insert-gates': f"""INSERT INTO stage_approval_gates(project_id,pipeline_session_id,gate_stage,target_artifact_id,
            target_artifact_sha256,approver_principal_id,decision)
            SELECT project_id,pipeline_session_id,'STAGE_1_DISCOVERY',artifact_id,artifact_sha256,'fixture','APPROVED'
            FROM stage_artifacts WHERE project_id={project} AND pipeline_session_id={active}""",
        'decide-change-requests': f"""UPDATE change_requests SET status='APPROVED',
            decided_by_principal_id='fixture', decided_at=clock_timestamp()
            WHERE project_id={project} AND pipeline_session_id={frozen}
              AND cr_key IN (SELECT 'pending-'||g FROM generate_series(1,100) g)""",
    }
    report['writes'] = {}
    for case in ('without-indexes', 'with-indexes'):
        db.query('BEGIN')
        if case == 'without-indexes':
            db.query('DROP INDEX ' + ','.join(branch[4] for branch in BRANCHES))
        db.query(f"""INSERT INTO product_pipeline_sessions
            (project_id,pipeline_session_id,title,raw_idea_text,created_by_principal_id)
            VALUES ({project},{active},'write probe','fixture','fixture')""")
        results = {}
        for name, sql in statements.items():
            plan = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}'))
            assert plan[0]['Plan']['Plans'][0]['Actual Rows'] == 100, f'{name}: expected 100 changed rows'
            results[name] = plan
        report['writes'][case] = results
        db.query('ROLLBACK')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('major', choices=['16', '17'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--writes', action='store_true', help='also measure 100 writes per operation with and without indexes')
    args = parser.parse_args()
    container = command('docker', 'run', '--rm', '-d', '-e', 'POSTGRES_PASSWORD=timeline_probe_fixture',
                        f'postgres:{args.major}-alpine').strip()
    report = {'plans': []}
    db = None
    try:
        for _ in range(60):
            ready = subprocess.run(('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q'))
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = Session(container)
        report['version'] = db.query('SHOW server_version')
        assert report['version'] == {'16': '16.16', '17': '17.12'}[args.major]
        for migration in sorted(MIGRATION.parent.glob('*.sql')):
            if migration.name[:4] not in ('0002', '0031'):
                db.query(migration.read_text())
        ddl = MIGRATION.read_text() if MIGRATION.exists() else CONTRACT.read_text().split(
            '### Candidate DDL retained from the original probe')[1].split('```sql')[1].split('```')[0].strip()
        for _ in range(2):
            db.query(ddl)
        indexes = db.query("SELECT indexdef FROM pg_indexes WHERE indexname IN (" +
                           ','.join(quoting(branch[4]) for branch in BRANCHES) + ') ORDER BY indexname')
        assert len(indexes.splitlines()) == 3
        report['index_definitions'] = indexes.splitlines()
        print(f'{args.major}: checking original-size fixture', flush=True)
        seed(db, 1, 30000, 100000, 3000)
        read_scope(db, 1)
        plan_matrix(db, 1, 'original-size', report)
        db.query('ROLLBACK')
        if not any('failure' in plan for plan in report['plans']):
            print(f'{args.major}: checking second-scale fixture and full walk', flush=True)
            seed(db, 2, 60000, 200000, 3000, pending=210000, cr_ties=100000)
            read_scope(db, 2)
            assert db.query(base(BRANCHES[2], 1)) == '', 'RLS exposed the other project'
            plan_matrix(db, 2, 'second-scale', report)
            if not any('failure' in plan for plan in report['plans']):
                verify_walk(db, 2, report, 'second-scale')
            db.query('ROLLBACK')
        assert not any('failure' in plan for plan in report['plans']), 'one or more plan checks failed'
        if args.writes:
            measure_writes(db, report)
    finally:
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        if db:
            db.close()
        command('docker', 'stop', container)


if __name__ == '__main__':
    main()
