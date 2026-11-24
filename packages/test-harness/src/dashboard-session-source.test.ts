import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  buildPostgresPoolConfigFromEnv,
  PostgresControlPlaneRepository,
  PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore,
  type ControlPlaneStore,
  type SessionReadInput,
} from "@software-factory/database";
import { contents } from "./dashboard-read-test-support.ts";

const timestamp = "2026-11-24T00:00:00.123000Z";
const principalId = "session-source-auditor";

async function seed(store: ControlPlaneStore, pool?: PostgresRuntimePool) {
  const a = randomUUID();
  const b = randomUUID();
  const empty = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID()).sort().reverse();
  for (const projectId of [a, b, empty]) {
    await store.withRlsTransaction({ currentProjectId: projectId, currentRole: "system_admin_role" }, async () => {
      await store.createProject({ project_id: projectId, slug: `session-source-${projectId}`, name: "Fixture",
        repo_bare_path: "/private/fixture.git", initial_main_commit_hash: "a".repeat(40) });
      await store.addProjectMembership({ project_id: projectId, principal_id: principalId, member_role: "AUDITOR" });
    });
  }
  for (const projectId of [a, b]) {
    await store.withRlsTransaction({ currentProjectId: projectId, currentPrincipalId: principalId, currentRole: "core_api_service" }, async () => {
      const sessionIds = projectId === a ? [...ids].reverse() : [randomUUID()];
      for (const id of sessionIds) {
        if (pool) {
          const createdAt = id === ids.at(-1) ? timestamp.replace("123000", "123001") : timestamp;
          await pool.queryInActiveTx(
            `INSERT INTO product_pipeline_sessions
              (pipeline_session_id, project_id, title, raw_idea_text, created_by_principal_id, created_at, updated_at)
             VALUES ($1,$2,'Session','Private content',$3,$4::timestamptz,$4::timestamptz);`,
            [id, projectId, principalId, createdAt],
          );
        } else {
          await store.createProductPipelineSession({ pipeline_session_id: id, project_id: projectId,
            title: "Session", raw_idea_text: "Private content", created_by_principal_id: principalId });
        }
      }
    });
  }
  return { a, b, empty, ids: pool ? [ids.at(-1)!, ...ids.slice(0, -1)] : ids,
    scope: { currentProjectId: a, currentPrincipalId: principalId, currentRole: "core_api_service" as const } };
}

async function verify(store: ControlPlaneStore, fixture: Awaited<ReturnType<typeof seed>>) {
  const { a, empty, ids } = fixture;
  const base = { projectId: a, principalId, signedRoles: ["AUDITOR"] as const, limit: 2 };
  const read = (after: SessionReadInput["after"] = null) =>
    store.readSessionProjection({ ...base, deadlineAt: Date.now() + 5000, after });
  const seen: string[] = [];
  let after: SessionReadInput["after"] = null;
  for (const pageSize of [3, 3, 2]) {
    const result = await read(after);
    assert.match(result.fetchedAt, /\.\d{6}Z$/);
    assert.equal(result.sessions.length, pageSize);
    for (const row of result.sessions) {
      assert.deepEqual(Object.keys(row).sort(), ["created_at", "pipeline_session_id", "project_id", "title", "updated_at"]);
      assert.equal(row.project_id, a);
      assert.equal(row.title, "Session");
      assert.match(row.created_at, /\.12300[01]Z$/);
      assert.equal(row.updated_at, row.created_at);
    }
    const page = result.sessions.slice(0, base.limit);
    seen.push(...page.map((row) => row.pipeline_session_id));
    const last = page.at(-1)!;
    after = { createdAt: last.created_at, pipelineSessionId: last.pipeline_session_id };
  }
  assert.deepEqual(seen, ids);
  assert.deepEqual((await read(after)).sessions, []);
  const input = { ...base, after: null, deadlineAt: Date.now() + 5000 };
  assert.deepEqual((await store.readSessionProjection({ ...input, projectId: empty })).sessions, []);
  await assert.rejects(store.readSessionProjection({ ...input, limit: 101 }), /Invalid session projection input/);
  await assert.rejects(store.readSessionProjection({ ...input, signedRoles: ["DEVELOPER"] }), { sqlState: "42501" });
  const first = await read();
  first.sessions[0]!.title = "Changed outside the store";
  assert.equal((await read()).sessions[0]!.title, "Session");
}

test("bounded session source projection in memory", async () => {
  const store = new SoftwareFactoryControlPlaneStore(() => new Date(timestamp));
  await verify(store, await seed(store));
});

const config = buildPostgresPoolConfigFromEnv();
test("bounded session source projection on real PostgreSQL", { skip: !config && "Real PostgreSQL required" }, async () => {
  const pool = new PostgresRuntimePool(config!);
  try {
    const store = new PostgresControlPlaneRepository(pool);
    const fixture = await seed(store, pool);
    const before = await contents(pool, fixture);
    const query = pool.queryInActiveTx.bind(pool);
    let pages = 0;
    pool.queryInActiveTx = (async (sql: string, params: readonly unknown[] = []) => {
      assert.match(sql, /^SELECT\b/);
      assert.doesNotMatch(sql, /SELECT\s+\*|\b(UPDATE|INSERT|DELETE|CALL)\b/i);
      const flags = await query(`SELECT current_user AS role, current_setting('transaction_read_only') AS ro,
        current_setting('transaction_isolation') AS isolation, current_setting('row_security') AS rls;`);
      assert.deepEqual(flags.rows[0], { role: "app_runtime", ro: "on", isolation: "repeatable read", rls: "on" });
      if (sql.includes("FROM product_pipeline_sessions")) {
        assert.match(sql, /WHERE project_id=\$1::uuid/);
        assert.match(sql, /LIMIT \$4::int/);
        assert.equal(params[3], 3);
        pages++;
      }
      return query(sql, params);
    }) as typeof pool.queryInActiveTx;
    await verify(store, fixture);
    assert.equal(pages, 7);
    pool.queryInActiveTx = query;
    assert.equal(await contents(pool, fixture), before);
    assert.equal(pool.getStats().activeConnections, 0);
  } finally {
    await pool.close();
  }
});
