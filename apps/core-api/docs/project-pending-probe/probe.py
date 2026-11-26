#!/usr/bin/env python3
"""Run the project pending EXPLAIN evidence probe on a disposable Docker database."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / 'packages/database/tests/timeline-index'))
import probe as timeline
from work_bound import inspect, nodes

VERSIONS = {'16': '16.16', '17': '17.12'}
REFERENCE_ROWS = 102
INVENTORY = {
    'change_requests': {
        'change_requests_pkey': 'UNIQUE (cr_id)',
        'uq_cr_id_project': 'UNIQUE (cr_id, project_id)',
        'uq_cr_project_baseline_key': 'UNIQUE (project_id, baseline_id, cr_key)',
        'idx_cr_project_session': '(project_id, pipeline_session_id, created_at DESC)',
        'idx_change_requests_decided_timeline':
            '(project_id, pipeline_session_id, decided_at DESC, cr_id DESC) WHERE (decided_at IS NOT NULL)',
        'idx_change_requests_submitted_timeline': '(project_id, pipeline_session_id, created_at DESC, cr_id DESC)',
        'idx_change_requests_applied_timeline':
            '(project_id, pipeline_session_id, applied_at DESC, cr_id DESC) WHERE (applied_at IS NOT NULL)',
    },
    'approval_requests': {
        'approval_requests_pkey': 'UNIQUE (approval_request_id)',
        'uq_ar_id_project': 'UNIQUE (approval_request_id, project_id)',
        'uq_ar_composite_binding': 'UNIQUE (approval_request_id, project_id, task_id, merge_candidate_id, '
            'agent_commit_hash, base_main_commit_hash, merge_candidate_hash, verified_tree_hash, '
            'verification_run_id, review_artifact_id)',
        'uq_one_pending_approval_request_per_candidate': "UNIQUE (merge_candidate_id) WHERE (status = 'PENDING'::text)",
    },
    'tasks': {'tasks_pkey': 'UNIQUE (task_id)', 'uq_tasks_id_project': 'UNIQUE (task_id, project_id)'},
}
CR = """SELECT cr_id, project_id, pipeline_session_id, baseline_id, cr_key, title, status, created_at
FROM change_requests WHERE project_id=$1 AND status='PENDING_APPROVAL'
ORDER BY created_at DESC, cr_id DESC LIMIT 101"""
APPROVAL = """SELECT approval_request_id, project_id, task_id, merge_candidate_id, status, expires_at, created_at
FROM approval_requests WHERE project_id=$1 AND status='PENDING'{expiry}
ORDER BY created_at DESC, approval_request_id DESC LIMIT 101"""
TASKS = """SELECT task_id FROM tasks WHERE project_id=$1 AND status='AwaitingHumanApproval'
ORDER BY created_at DESC, task_id DESC LIMIT 101"""
CASES = [
    ('Q1', 1, CR), ('Q1-tied', 2, CR),
    ('Q2a', 1, APPROVAL.format(expiry='')),
    ('Q2b', 1, APPROVAL.format(expiry=' AND expires_at > now()')),
    ('Q3', 1, TASKS),
]
TRIAL_INDEXES = [
    """CREATE INDEX probe_pending_cr ON change_requests (project_id, created_at DESC, cr_id DESC)
       WHERE status = 'PENDING_APPROVAL'""",
    """CREATE INDEX probe_pending_approval ON approval_requests (project_id, created_at DESC, approval_request_id DESC)
       WHERE status = 'PENDING'""",
    """CREATE INDEX probe_waiting_tasks ON tasks (project_id, created_at DESC, task_id DESC)
       WHERE status = 'AwaitingHumanApproval'""",
]


def verify_inventory(db):
    actual = json.loads(db.query("""SELECT json_object_agg(tablename, indexes) FROM (
        SELECT tablename, json_object_agg(indexname,
            CASE WHEN indexdef LIKE 'CREATE UNIQUE %' THEN 'UNIQUE ' ELSE '' END
            || split_part(indexdef,' USING btree ',2)) AS indexes
        FROM pg_indexes WHERE schemaname='public'
          AND tablename IN ('change_requests','approval_requests','tasks')
        GROUP BY tablename) AS catalog"""))
    assert actual == INVENTORY, f'Schema differs from brief: {json.dumps(actual, sort_keys=True)}'
    return actual


def seed_change_requests(db, project_number, tied):
    fixture = (timeline.HERE / 'fixture.sql').read_text()
    session_sql = fixture[fixture.index('INSERT INTO product_pipeline_sessions'):fixture.index('INSERT INTO change_requests')]
    for offset in range(10):
        project = timeline.scope(project_number)[0]
        _, session, baseline = timeline.scope(project_number * 100 + offset)
        values = dict(p=timeline.quoting(project), s=timeline.quoting(session), b=timeline.quoting(baseline), artifacts='1', ties='0')
        db.query(re.sub(r'(?<!:):(p|s|b|artifacts|ties)\b', lambda m: values[m[1]], session_sql))
        stamp = "'2025-01-01T00:00:00Z'::timestamptz"
        created = f"({stamp} + ({offset} * 10000 + g) * interval '1 second')"
        if tied:
            created = f"CASE WHEN g<=300 THEN {stamp} ELSE {created} END"
        db.query(f"""INSERT INTO change_requests
          (cr_id,project_id,pipeline_session_id,baseline_id,cr_key,title,rationale,impacted_requirement_ids_json,
           proposed_tasks_json,status,requested_by_principal_id,decided_by_principal_id,decided_at,cr_sha256,created_at)
          SELECT md5({values['s']} || g)::uuid,{values['p']},{values['s']},{values['b']},'fixture-'||g,
            'fixture','fixture','["req"]','[{{}}]',CASE WHEN g<=300 THEN 'PENDING_APPROVAL' ELSE 'APPROVED' END,
            'fixture',CASE WHEN g>300 THEN 'fixture' END,CASE WHEN g>300 THEN {created} END,repeat('c',64),{created}
          FROM generate_series(1,10000) g""")


def seed(db):
    for number in (1, 2):
        project = timeline.quoting(timeline.scope(number)[0])
        db.query(f"""INSERT INTO projects(project_id,slug,name,repo_bare_path) VALUES ({project},{project},'fixture','/fixture');
        INSERT INTO project_memberships(project_id,principal_id,member_role) VALUES ({project},'fixture','AUDITOR')""")
        seed_change_requests(db, number, tied=(number == 2))
    db.query((HERE / 'approval-fixture.sql').read_text().replace(':p', timeline.quoting(timeline.scope(1)[0])))
    db.query('ANALYZE')
    for number, expected_timestamps in ((1, 3000), (2, 1)):
        timeline.read_scope(db, number)
        assert db.query("""SELECT count(*),count(DISTINCT pipeline_session_id),
            count(*) FILTER (WHERE status='PENDING_APPROVAL'),
            count(DISTINCT created_at) FILTER (WHERE status='PENDING_APPROVAL') FROM change_requests""") == f'100000|10|3000|{expected_timestamps}'
        if number == 1:
            assert db.query("""SELECT count(*),count(*) FILTER (WHERE status='PENDING'),
              count(*) FILTER (WHERE status='PENDING' AND expires_at>now()) FROM approval_requests""") == '10000|1000|800'
            assert db.query("""SELECT count(*),count(*) FILTER (WHERE status='AwaitingHumanApproval') FROM tasks""") == '10000|500'
        db.query('ROLLBACK')


def measure(db, phase):
    measurements = []
    for name, scope, query in CASES:
        timeline.read_scope(db, scope)
        project = timeline.quoting(timeline.scope(scope)[0])
        db.query(f'PREPARE pending_page(uuid) AS {query}')
        # Capture the requested statement before the result-oracle execution warms it.
        explain = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE pending_page({project})'))
        result = db.query(f'EXECUTE pending_page({project})')
        db.query('DEALLOCATE pending_page')
        db.query('ROLLBACK')
        document = explain[0]
        root = document['Plan']
        read, sorts = inspect(explain)
        scans = [node['Node Type'] + (': ' + node['Index Name'] if 'Index Name' in node else '')
                 for node in nodes(root) if 'Scan' in node['Node Type'].split()]
        assert root['Actual Rows'] == len(result.splitlines()) == 101
        assert read >= root['Actual Rows'], f'{name}: scan accounting undercounts output'
        metrics = dict(query=name, rows_read=read, scans=scans, sort_inputs=sorts,
                       shared_hit=root['Shared Hit Blocks'], shared_read=root['Shared Read Blocks'],
                       execution_ms=document['Execution Time'])
        print(phase, json.dumps(metrics), flush=True)
        measurements.append((dict(**metrics, sql=query, explain=explain), result))
    return measurements


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', choices=VERSIONS)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    container = timeline.command('docker', 'run', '--rm', '-d', '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                                 f'postgres:{args.version}-alpine').strip()
    db = None
    try:
        for _ in range(60):
            if subprocess.run(('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q')).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = timeline.Session(container)
        version = db.query('SHOW server_version')
        assert version == VERSIONS[args.version], version
        for migration in sorted(timeline.MIGRATION.parent.glob('*.sql')):
            if not migration.name.startswith('0002'):  # Assertion-only RLS test, per timeline runner.
                db.query(migration.read_text())
        inventory = verify_inventory(db)
        seed(db)
        before = measure(db, 'baseline')
        db.query(';\n'.join(TRIAL_INDEXES))
        db.query('ANALYZE')
        after = measure(db, 'disposable indexes')
        for (first, original), (second, updated) in zip(before, after, strict=True):
            assert original == updated, f"{first['query']}: ordered result changed"
        report = dict(postgres=version, reference_rows=REFERENCE_ROWS, inventory=inventory,
                      disposable_index_definitions=TRIAL_INDEXES,
                      baseline=[plan for plan, _ in before], trial=[plan for plan, _ in after])
        args.output.write_text(json.dumps(report, indent=2) + '\n')
    finally:
        if db is not None:
            db.close()
        timeline.command('docker', 'stop', container)


if __name__ == '__main__':
    main()
