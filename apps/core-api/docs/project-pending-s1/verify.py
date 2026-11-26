#!/usr/bin/env python3
"""Verify Issue #38 migration, reader plans and PostgreSQL integration tests."""
import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
evidence = runpy.run_path(str(HERE.parent / 'project-pending-probe/probe.py'))
db_tools = evidence['timeline']
EXPECTED = {
    'change_requests': 'idx_change_requests_project_pending',
    'approval_requests': 'idx_approval_requests_project_pending',
}
DATABASE_ENV = {
    'PGHOST': '127.0.0.1', 'PGUSER': 'postgres', 'PGDATABASE': 'postgres',
    'PGPASSWORD': 'pending_reader_fixture',
}


def apply_schema(db, migrations):
    for migration in migrations:
        db.query(migration.read_text())


def catalog(db):
    return json.loads(db.query("""SELECT coalesce(json_object_agg(indexname,indexdef),'{}')
        FROM pg_indexes WHERE schemaname='public'
          AND indexname IN ('idx_change_requests_project_pending','idx_approval_requests_project_pending')"""))


def verify_catalog(db):
    entries = catalog(db)
    for statement in evidence['TRIAL_INDEXES'][:2]:
        ddl = ' '.join(statement.split())
        for table, name in EXPECTED.items():
            if f' ON {table} ' in ddl:
                expected = ddl[ddl.index(' ON '):].replace(f' ON {table} (', f' ON public.{table} USING btree (')
                expected = expected.replace(" WHERE status = ", " WHERE (status = ") + '::text)'
                assert entries.pop(name) == f'CREATE INDEX {name}{expected}'
    assert not entries


def measure_plans(db):
    script = """
import { readPendingApprovalCandidates } from './packages/database/src/pending-approvals-read-projection.ts';
const inputs = JSON.parse(process.argv[1]);
const queries = [];
for (const { name, projectId } of inputs) {
  await readPendingApprovalCandidates({
    projectId, limit: 100, after: null, deadlineAt: Date.now() + 5000,
    principalId: 'fixture', signedRoles: ['AUDITOR'],
  }, '2026-01-01T00:00:00.000000Z', async (sql, params) => {
    queries.push({ name, sql, params });
    return [];
  });
}
console.log(JSON.stringify(queries));
"""
    inputs = [dict(name=name, projectId=db_tools.scope(scope)[0]) for name, scope in [('mixed', 1), ('tied', 2)]]
    queries = json.loads(db_tools.command('node', '--input-type=module', '-e', script, json.dumps(inputs)))
    report = []
    for query in queries:
        scope = 1 if query['name'] == 'mixed' else 2
        table = next(table for table in EXPECTED if f'FROM {table} ' in query['sql'])
        db_tools.read_scope(db, scope)
        db.query('PREPARE pending_s1(uuid,int) AS ' + query['sql'])
        arguments = ','.join(db_tools.quoting(v) if isinstance(v, str) else str(v) for v in query['params'])
        explain = json.loads(db.query(f'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE pending_s1({arguments})'))
        db.query('DEALLOCATE pending_s1')
        db.query('ROLLBACK')
        rows, sorts = evidence['inspect'](explain)
        scans = [p for p in evidence['nodes'](explain[0]['Plan']) if 'Scan' in p['Node Type'].split()]
        plan = dict(**query, table=table, rows_read=rows, sort_inputs=sorts, explain=explain)
        report.append(plan)
        passed = (rows == 101 and not sorts and len(scans) == 1
                  and scans[0]['Node Type'] in ('Index Scan', 'Index Only Scan')
                  and scans[0].get('Index Name') == EXPECTED[table])
        print(query['name'], table, rows, [(p['Node Type'], p.get('Index Name')) for p in scans], sorts, flush=True)
        if not passed:
            print(json.dumps(explain, indent=2), flush=True)
            raise AssertionError('S1 EXPLAIN differs from the agreed probe plan')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', choices=evidence['VERSIONS'])
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    container = db_tools.command('docker', 'run', '--rm', '-d', '-p', '127.0.0.1::5432',
                                 '-e', 'POSTGRES_PASSWORD=' + DATABASE_ENV['PGPASSWORD'],
                                 f'postgres:{args.version}-alpine').strip()
    db = None
    try:
        for _ in range(60):
            if subprocess.run(('docker', 'exec', container, 'pg_isready', '-h', '127.0.0.1', '-q')).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('PostgreSQL did not start')
        db = db_tools.Session(container)
        version = db.query('SHOW server_version')
        assert version == evidence['VERSIONS'][args.version]
        baseline = [p for p in sorted(db_tools.MIGRATION.parent.glob('*.sql')) if 0 < int(p.name[:4]) <= 33
                    and not p.name.startswith('0002')]
        migration, = db_tools.MIGRATION.parent.glob('0034_project_pending_approvals_indexes.sql')
        apply_schema(db, baseline)
        evidence['verify_inventory'](db)
        assert not catalog(db)
        assert migration.read_text().endswith('COMMIT;\n')
        db.query(migration.read_text().removesuffix('COMMIT;\n') + 'ROLLBACK;')
        assert not catalog(db)
        apply_schema(db, [migration, migration])
        verify_catalog(db)

        db.query('CREATE DATABASE pending_s1_fresh')
        db.query('\\connect pending_s1_fresh\nSELECT current_database()')
        apply_schema(db, [*baseline, migration])
        verify_catalog(db)
        db.query('\\connect postgres\nSELECT current_database()')

        evidence['seed'](db)
        other_project = db_tools.scope(2)[0]
        fixture_sql = (HERE.parent / 'project-pending-probe/approval-fixture.sql').read_text()
        db.query(fixture_sql.replace(':p', db_tools.quoting(other_project))
                 .replace('md5(', f'md5({db_tools.quoting(other_project)} || '))
        # Force one live merge approval to share the first CR timestamp in both projects.
        db.query("""WITH target AS (
          SELECT DISTINCT ON (project_id) approval_request_id FROM approval_requests
          WHERE status='PENDING' AND expires_at>now() ORDER BY project_id, created_at
        ) UPDATE approval_requests SET created_at='2025-01-01T00:00:01Z'
          WHERE approval_request_id IN (SELECT approval_request_id FROM target)""")
        db.query('ANALYZE')
        plans = measure_plans(db)
        args.output.write_text(json.dumps(dict(postgres=version, plans=plans), indent=2) + '\n')

        port = db_tools.command('docker', 'port', container, '5432/tcp').strip().rsplit(':', 1)[1]
        subprocess.run(['node', '--test', 'packages/test-harness/src/dashboard-pending-approvals-reader.test.ts'],
                       cwd=ROOT, check=True, env={**os.environ, **DATABASE_ENV, 'PGPORT': port,
                                                  'PENDING_APPROVALS_FIXTURE_CONTAINER': container})
    finally:
        if db:
            db.close()
        db_tools.command('docker', 'stop', container)


if __name__ == '__main__':
    main()
