import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CORE_API_AUTH_HEADER, CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import {
  buildPostgresPoolConfigFromEnv, PostgresControlPlaneRepository, PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore, type ControlPlaneStore,
} from "@software-factory/database";
import type { CostSessionRecord, ProductPipelineSessionRecord } from "@software-factory/shared-types";
import { catalog, contents } from "./dashboard-read-test-support.ts";

const roles = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"] as const;
const numericFields = ["session_cost_budget_micro_usd", "cost_used_micro_usd", "tokens_used_total", "session_token_budget"] as const;
const stamp = "2026-11-24T00:00:00.123000Z";
const notFound = { status: 404, body: { error_code: "ERR_READ_RESOURCE_NOT_FOUND" } };
const forbidden = { status: 403, body: { error_code: "ERR_FORBIDDEN_RLS" } };
const invalid = { status: 400, body: { error_code: "ERR_READ_QUERY_INVALID" } };
const failed = { status: 500, body: { error_code: "ERR_READ_PROJECTION_FAILED" } };
const config = buildPostgresPoolConfigFromEnv();

async function prepare(store: ControlPlaneStore) {
  const a = randomUUID(), b = randomUUID(), linked = randomUUID(), shared = randomUUID(),
    noLink = randomUUID(), unattributed = randomUUID(), foreign = randomUUID();
  const scope = { currentProjectId: a, currentPrincipalId: "AUDITOR", currentRole: "core_api_service" as const };
  for (const projectId of [a, b]) {
    await store.withRlsTransaction({ currentProjectId: projectId, currentRole: "system_admin_role" }, async () => {
      await store.createProject({ project_id: projectId, slug: `cost-read-${projectId}`, name: "Fixture",
        repo_bare_path: "/private/cost.git", initial_main_commit_hash: "a".repeat(40) });
      for (const role of roles) {
        await store.addProjectMembership({ project_id: projectId, principal_id: role, member_role: role });
      }
    });
  }
  const createCost = (projectId: string, pipelineId: string | null) => store.createCostSession({
    project_id: projectId, pipeline_session_id: pipelineId,
    max_tokens_per_request: 1, max_cost_micro_usd_per_request: 0,
    session_token_budget: Number.MAX_SAFE_INTEGER, session_cost_budget_micro_usd: Number.MAX_SAFE_INTEGER,
  });
  const createSession = (projectId: string, sessionId: string, costId: string | null) => store.createProductPipelineSession({
    project_id: projectId, pipeline_session_id: sessionId, cost_session_id: costId,
    title: "Fixture", raw_idea_text: "Private idea", created_by_principal_id: "AUDITOR",
  });
  const [cost, nullCost] = await store.withRlsTransaction(scope, async () => {
    const cost = await createCost(a, linked);
    const nullCost = await createCost(a, null);
    await createSession(a, linked, cost.cost_session_id);
    await createSession(a, shared, cost.cost_session_id);
    await createSession(a, noLink, null);
    await createSession(a, unattributed, nullCost.cost_session_id);
    return [cost.cost_session_id, nullCost.cost_session_id];
  });
  const foreignCost = await store.withRlsTransaction({ ...scope, currentProjectId: b }, async () => {
    const cost = await createCost(b, foreign);
    await createSession(b, foreign, cost.cost_session_id);
    return cost.cost_session_id;
  });

  let now = Date.now();
  const core = new CoreApiService(store, { authenticator: new CoreApiTokenAuthenticator({ clockFn: () => new Date(now) }) });
  const auth = (projectId = a, role: typeof roles[number] = "AUDITOR", principalId: string = role, ttlMs?: number) =>
    encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId, roles: [role], ttlMs }));
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  const request = async (path: string, token: string | null = auth()) => {
    const headers: Record<string, string> = token === null ? {} : { [CORE_API_AUTH_HEADER]: token };
    const response = await fetch(baseUrl + "/api/v1/projects" + path, { headers });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), bytes: Buffer.byteLength(text) };
  };
  const sessionPath = (projectId: string, sessionId: string) => `/${projectId}/pipeline-sessions/${sessionId}`;
  const get = (projectId: string = a, sessionId: string = linked, token: string | null = auth(), query = "") =>
    request(sessionPath(projectId, sessionId) + "/cost-session-snapshot" + query, token);
  const expected = {
    cost_session_id: cost, pipeline_session_id: linked,
    session_cost_budget_micro_usd: Number.MAX_SAFE_INTEGER, cost_used_micro_usd: 0,
    tokens_used_total: 0, session_token_budget: Number.MAX_SAFE_INTEGER, status: "ACTIVE",
  };
  return { a, b, linked, shared, noLink, unattributed, foreign, cost, nullCost, foreignCost, auth, scope,
    get, request, sessionPath, expected, advance: () => { now += 2; }, stop: () => server.stop() };
}

type Fixture = Awaited<ReturnType<typeof prepare>>;

function checkError(response: Awaited<ReturnType<Fixture["get"]>>, expected: { status: number; body: object }) {
  assert.equal(response.status, expected.status);
  assert.deepEqual(response.body, expected.body);
}

async function contract(f: Fixture) {
  for (const role of roles) {
    const result = await f.get(f.a, f.linked, f.auth(f.a, role));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      schemaVersion: "dashboard-read-v1", fetchedAt: result.body.fetchedAt, projectId: f.a,
      pipelineSessionId: f.linked, costSession: f.expected,
    });
    assert.match(result.body.fetchedAt, /\.\d{6}Z$/);
    assert.deepEqual(Object.keys(result.body.costSession), Object.keys(f.expected));
    checkError(await f.get(f.b, f.foreign, f.auth(f.a, role)), forbidden);
    checkError(await f.get(randomUUID(), f.foreign, f.auth(f.a, role)), forbidden);
  }
  assert.equal((await f.get(f.a, f.noLink)).body.costSession, null);
  const shared = await f.get(f.a, f.shared);
  assert.equal(shared.status, 200);
  assert.equal(shared.body.pipelineSessionId, f.shared);
  assert.deepEqual(shared.body.costSession, f.expected);
  const unattributed = await f.get(f.a, f.unattributed);
  assert.equal(unattributed.status, 200);
  assert.equal(unattributed.body.costSession.cost_session_id, f.nullCost);
  assert.equal(unattributed.body.costSession.pipeline_session_id, null);
  checkError(await f.get(f.a, f.foreign), notFound);
  checkError(await f.get(f.a, randomUUID()), notFound);
  checkError(await f.get(f.a, f.linked, f.auth(f.a, "AUDITOR", "absent")), forbidden);
  checkError(await f.get(f.a, f.linked, f.auth(f.a, "DEVELOPER", "AUDITOR")), forbidden);
  checkError(await f.get(f.a, f.linked, null), { status: 401, body: { error_code: "ERR_UNAUTHORIZED" } });
  checkError(await f.get(f.a, f.linked, "invalid-transport-auth"), { status: 401, body: { error_code: "ERR_UNAUTHORIZED" } });
  const forged = JSON.parse(Buffer.from(f.auth(), "base64url").toString("utf8"));
  forged.signatureHex = "0".repeat(64);
  checkError(await f.get(f.a, f.linked, Buffer.from(JSON.stringify(forged)).toString("base64url")), forbidden);
  const expired = f.auth(f.a, "AUDITOR", "AUDITOR", 1);
  f.advance();
  checkError(await f.get(f.a, f.linked, expired), forbidden);
  checkError(await f.get(f.a, "%ZZ"), invalid);
  checkError(await f.get("invalid-project", f.linked), invalid);
  checkError(await f.get(f.a, f.linked, f.auth(), "?limit=1"), invalid);
}

test("bounded cost-session snapshot in memory", async () => {
  const store = new SoftwareFactoryControlPlaneStore(() => new Date(stamp));
  const f = await prepare(store);
  try {
    const maps = store as unknown as {
      costSessions: Map<string, CostSessionRecord>;
      pipelineSessions: Map<string, ProductPipelineSessionRecord>;
    };
    const cost = maps.costSessions.get(f.cost)!;
    const session = maps.pipelineSessions.get(f.linked)!;
    const trap = () => { throw new Error("Legacy reader used"); };
    store.getCostSession = trap;
    store.getProductPipelineBundle = trap;
    store.listModelCallLedgers = trap;
    await contract(f);
    const original = structuredClone(cost);
    assert.deepEqual(maps.costSessions.get(f.cost), original);
    for (const link of [f.foreignCost, randomUUID()]) {
      maps.pipelineSessions.set(f.linked, { ...session, cost_session_id: link });
      checkError(await f.get(), notFound);
    }
    maps.pipelineSessions.set(f.linked, session);
    for (const field of numericFields) {
      maps.costSessions.set(f.cost, { ...cost, [field]: Number.MAX_SAFE_INTEGER + 1 });
      checkError(await f.get(), failed);
    }
    for (const invalidCost of [
      { ...cost, cost_used_micro_usd: null }, { ...cost, status: "INVALID" },
      { ...cost, session_token_budget: 0 }, { ...cost, tokens_used_total: "1.5" },
    ]) {
      maps.costSessions.set(f.cost, invalidCost as CostSessionRecord);
      checkError(await f.get(), failed);
    }
    maps.costSessions.set(f.cost, cost);
    assert.equal((await f.get()).body.fetchedAt, stamp);

    const read = store.readCostSessionProjection.bind(store);
    store.readCostSessionProjection = async (input) => {
      const result = await read(input);
      assert.ok(result.costSession);
      const costSession = { ...result.costSession, payload: "x".repeat(1048576) };
      return { ...result, costSession };
    };
    checkError(await f.get(), failed);
  } finally {
    await f.stop();
  }
});

async function insertLedgers(pool: PostgresRuntimePool, f: Fixture, costId: string, sessionId: string, count: number) {
  await pool.withRlsTransaction(f.scope, () => pool.queryInActiveTx(
    `INSERT INTO model_call_ledgers
       (project_id,cost_session_id,pipeline_session_id,stage,provider,model,prompt_id,prompt_version,
        prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,estimated_cost_micro_usd,status)
     SELECT $1::uuid,$2::uuid,$3::uuid,'fixture','openai','fixture','fixture','1',
            repeat('a',64),repeat('b',64),0,0,0,'ALLOWED'
     FROM generate_series(1,$4::int);`, [f.a, costId, sessionId, count],
  ));
}

test("bounded cost-session snapshot on real PostgreSQL keeps SQL, bytes and legacy reads independent of ledger growth",
  { skip: !config && "Real PostgreSQL required" }, async () => {
    const pool = new PostgresRuntimePool(config!);
    let f: Fixture | undefined;
    try {
      const repo = new PostgresControlPlaneRepository(pool);
      f = await prepare(repo);
      await contract(f);
      const read = await f.get();
      const direct = `/${f.a}/cost-sessions/${f.cost}`;
      const bundle = f.sessionPath(f.a, f.linked);
      assert.deepEqual((await f.request(direct)).body.ledgers, []);
      assert.deepEqual((await f.request(bundle)).body.modelCallLedgers, []);

      await insertLedgers(pool, f, f.cost, f.linked, 2048);
      await insertLedgers(pool, f, f.cost, f.shared, 1);
      await insertLedgers(pool, f, f.nullCost, f.linked, 2);
      const before = await contents(pool, f), schema = await catalog(pool);
      const query = pool.queryInActiveTx.bind(pool);
      const observed: string[] = [];
      pool.queryInActiveTx = (async (sql: string, params: readonly unknown[] = []) => {
        assert.match(sql, /^SELECT\b/);
        assert.doesNotMatch(sql, /model_call_ledgers|SELECT\s+\*|\b(UPDATE|INSERT|DELETE|CALL)\b/i);
        const flags = await query(`SELECT current_user AS role, current_setting('transaction_read_only') AS ro,
          current_setting('transaction_isolation') AS isolation, current_setting('row_security') AS rls;`);
        assert.deepEqual(flags.rows[0], { role: "app_runtime", ro: "on", isolation: "repeatable read", rls: "on" });
        observed.push(sql);
        return query(sql, params);
      }) as typeof pool.queryInActiveTx;
      const getCostSession = repo.getCostSession, getBundle = repo.getProductPipelineBundle, listLedgers = repo.listModelCallLedgers;
      const trap = () => { throw new Error("Legacy reader used"); };
      repo.getCostSession = trap;
      repo.getProductPipelineBundle = trap;
      repo.listModelCallLedgers = trap;
      try {
        const after = await f.get();
        assert.equal(after.status, 200);
        assert.equal(after.bytes, read.bytes);
        assert.deepEqual(after.body, { ...read.body, fetchedAt: after.body.fetchedAt });
        assert.equal(observed.length, 3);
        assert.match(observed[2]!, /LEFT JOIN model_cost_sessions c ON c.project_id=s.project_id AND c.cost_session_id=s.cost_session_id/);
        assert.match(observed[2]!, /WHERE s.project_id=\$1::uuid AND s.pipeline_session_id=\$2::uuid/);
      } finally {
        pool.queryInActiveTx = query;
        repo.getCostSession = getCostSession;
        repo.getProductPipelineBundle = getBundle;
        repo.listModelCallLedgers = listLedgers;
      }

      const oldDirect = await f.request(direct), oldBundle = await f.request(bundle);
      assert.equal(oldDirect.status, 200);
      assert.deepEqual(Object.keys(oldDirect.body), ["session", "ledgers"]);
      assert.equal(oldDirect.body.ledgers.length, 2049);
      assert.ok(oldDirect.body.ledgers.every((row: { cost_session_id: string }) => row.cost_session_id === f!.cost));
      assert.equal(oldBundle.status, 200);
      assert.equal(oldBundle.body.costSession.cost_session_id, f.cost);
      assert.equal(oldBundle.body.modelCallLedgers.length, 2050);
      assert.ok(oldBundle.body.modelCallLedgers.every((row: { pipeline_session_id: string }) => row.pipeline_session_id === f!.linked));
      assert.equal(await contents(pool, f), before);
      assert.deepEqual(await catalog(pool), schema);
      assert.equal(pool.getStats().activeConnections, 0);
    } finally {
      await f?.stop();
      await pool.close();
    }
  });

test("PostgreSQL cost snapshot fails closed for every unsafe BIGINT, unresolved link and timed-out query",
  { skip: !config && "Real PostgreSQL required" }, async () => {
    const pool = new PostgresRuntimePool(config!);
    const writer = new PostgresRuntimePool(config!);
    let f: Fixture | undefined;
    try {
      const repo = new PostgresControlPlaneRepository(pool);
      const fixture = await prepare(repo);
      f = fixture;
      const { a, linked, cost, scope } = fixture;
      const safe = String(Number.MAX_SAFE_INTEGER);
      const tooLarge = (BigInt(safe) + 1n).toString();
      await pool.withRlsTransaction(scope, () => pool.queryInActiveTx(
        "UPDATE model_cost_sessions SET cost_used_micro_usd=$2::bigint,tokens_used_total=$2::bigint WHERE cost_session_id=$1::uuid;",
        [cost, safe],
      ));
      const max = await fixture.get();
      assert.equal(max.status, 200);
      for (const field of numericFields) assert.equal(max.body.costSession[field], Number.MAX_SAFE_INTEGER);

      for (const field of numericFields) {
        const costId = randomUUID(), sessionId = randomUUID();
        const totals = numericFields.map((key) => key === field ? tooLarge : safe);
        await pool.withRlsTransaction(scope, async () => {
          await pool.queryInActiveTx(
            `INSERT INTO model_cost_sessions (
               cost_session_id,project_id,max_tokens_per_request,max_cost_micro_usd_per_request,
               session_cost_budget_micro_usd,cost_used_micro_usd,tokens_used_total,session_token_budget
             ) VALUES ($1::uuid,$2::uuid,1,0,$3::bigint,$4::bigint,$5::bigint,$6::bigint);`,
            [costId, a, ...totals],
          );
          await repo.createProductPipelineSession({ project_id: a, pipeline_session_id: sessionId, cost_session_id: costId,
            title: "Overflow fixture", raw_idea_text: "Fixture", created_by_principal_id: "AUDITOR" });
        });
        checkError(await fixture.get(a, sessionId), failed);
        assert.equal(pool.getStats().activeConnections, 0);
      }

      const query = pool.queryInActiveTx.bind(pool);
      const readCosts = (sql: string) => sql.includes("LEFT JOIN model_cost_sessions");
      pool.queryInActiveTx = async <Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        sql.startsWith("SELECT project_id FROM projects") ? { rows: [], rowCount: 0, commandTag: "SELECT 0" } : query<Row>(sql, params);
      checkError(await fixture.get(), notFound);
      for (const unresolved of [fixture.foreignCost, randomUUID()]) {
        pool.queryInActiveTx = (async (sql: string, params: readonly unknown[] = []) => {
          const result = await query(sql, params);
          if (!readCosts(sql)) return result;
          return { ...result, rows: [{ linked_cost_session_id: unresolved, cost_session_id: null }] };
        }) as typeof pool.queryInActiveTx;
        checkError(await fixture.get(), notFound);
        assert.equal(pool.getStats().activeConnections, 0);
      }
      pool.queryInActiveTx = (async (sql: string, params: readonly unknown[] = []) =>
        readCosts(sql) ? query("SELECT pg_sleep(3);") : query(sql, params)) as typeof pool.queryInActiveTx;
      checkError(await fixture.get(), failed);
      assert.equal(pool.getStats().activeConnections, 0);
      pool.queryInActiveTx = query;
      assert.equal((await fixture.get()).status, 200);

      await assert.rejects(pool.withReadOnlyRlsTransaction(scope, () => pool.queryInActiveTx(
        "UPDATE model_cost_sessions SET cost_used_micro_usd=0 WHERE cost_session_id=$1;",
        [cost],
      )), { sqlState: "25006" });
      assert.equal(pool.getStats().activeConnections, 0);

      let updated = false;
      pool.queryInActiveTx = (async (sql: string, params: readonly unknown[] = []) => {
        const result = await query(sql, params);
        if (!updated && sql.startsWith("SELECT member_role")) {
          updated = true;
          await writer.withRlsTransaction(scope, () => writer.queryInActiveTx(
            "UPDATE model_cost_sessions SET cost_used_micro_usd=5 WHERE cost_session_id=$1;",
            [cost],
          ));
          await writer.withRlsTransaction({ ...scope, currentRole: "system_admin_role" }, () => writer.queryInActiveTx(
            "UPDATE project_memberships SET member_role='DEVELOPER' WHERE project_id=$1 AND principal_id='AUDITOR';",
            [a],
          ));
        }
        return result;
      }) as typeof pool.queryInActiveTx;
      const consistent = await fixture.get(a, linked);
      assert.equal(consistent.status, 200);
      assert.equal(consistent.body.costSession.cost_used_micro_usd, Number.MAX_SAFE_INTEGER);
      pool.queryInActiveTx = query;
      checkError(await fixture.get(), forbidden);
      const next = await fixture.get(a, linked, fixture.auth(a, "DEVELOPER", "AUDITOR"));
      assert.equal(next.status, 200);
      assert.equal(next.body.costSession.cost_used_micro_usd, 5);
    } finally {
      await f?.stop();
      await Promise.all([pool.close(), writer.close()]);
    }
  });
