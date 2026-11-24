import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader, type CoreApiAuthContext } from "@software-factory/core-api";
import { ProjectReadCursorCodec } from "../../../apps/core-api/src/project-read-projection.ts";
import { SessionReadCursorCodec } from "../../../apps/core-api/src/session-read-projection.ts";
import { TaskReadCursorCodec } from "../../../apps/core-api/src/task-read-projection.ts";
import {
  buildPostgresPoolConfigFromEnv,
  PostgresControlPlaneRepository,
  PostgresRuntimePool,
  PostgresRlsError,
  SoftwareFactoryControlPlaneStore,
  type ControlPlaneStore,
  type SessionReadInput,
} from "@software-factory/database";
import { catalog, contents } from "./dashboard-read-test-support.ts";

const timestamp = "2026-11-24T00:00:00.123000Z";
const principalId = "session-source-auditor";
const roles = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"] as const;
const principal = (role: typeof roles[number]) => role === "AUDITOR" ? principalId : `session-source-${role}`;

async function seed(store: ControlPlaneStore, pool?: PostgresRuntimePool) {
  const a = randomUUID();
  const b = randomUUID();
  const empty = randomUUID();
  const ids = Array.from({ length: 6 }, () => randomUUID()).sort().reverse();
  for (const projectId of [a, b, empty]) {
    await store.withRlsTransaction({ currentProjectId: projectId, currentRole: "system_admin_role" }, async () => {
      await store.createProject({ project_id: projectId, slug: `session-source-${projectId}`, name: "Fixture",
        repo_bare_path: "/private/fixture.git", initial_main_commit_hash: "a".repeat(40) });
      for (const role of roles) {
        await store.addProjectMembership({ project_id: projectId, principal_id: principal(role), member_role: role });
      }
    });
  }
  const foreign = randomUUID();
  for (const projectId of [a, b]) {
    await store.withRlsTransaction({ currentProjectId: projectId, currentPrincipalId: principalId, currentRole: "core_api_service" }, async () => {
      const sessionIds = projectId === a ? [...ids].reverse() : [foreign];
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
  return { a, b, empty, foreign, ids: pool ? [ids.at(-1)!, ...ids.slice(0, -1)] : ids,
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

async function verifyHttp(store: ControlPlaneStore, fixture: Awaited<ReturnType<typeof seed>>, pool?: PostgresRuntimePool) {
  const { a, b, empty, foreign, ids, scope } = fixture;
  let authClock = Date.now();
  const authenticator = new CoreApiTokenAuthenticator({ clockFn: () => new Date(authClock) });
  const core = new CoreApiService(store, { authenticator });
  const auth = (role: typeof roles[number] = "AUDITOR", projectId = a, principalId = principal(role)) =>
    core.issueAuthContext({ projectId, principalId, roles: [role] });
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  const request = async (path: string, token: CoreApiAuthContext | string | null = auth()) => {
    const headers: Record<string, string> = token === null ? {} : {
      [CORE_API_AUTH_HEADER]: typeof token === "string" ? token : encodeCoreApiAuthHeader(token),
    };
    const response = await fetch(baseUrl + "/api/v1/projects" + path, { headers });
    return { status: response.status, body: await response.json() as Awaited<ReturnType<CoreApiService["readSessionProjection"]>> };
  };
  const get = (query = "", token: CoreApiAuthContext | string | null = auth(), project: string = a) =>
    request(`/${project}/sessions${query}`, token);
  const error = (status: number, error_code: string) => ({ status, body: { error_code } });
  const denied = error(403, "ERR_FORBIDDEN_RLS");
  const invalid = error(400, "ERR_READ_QUERY_INVALID");
  const conflict = error(409, "ERR_READ_CURSOR_CONTEXT");
  const queryCursor = (cursor: string, limit = 2) => `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`;
  try {
    for (const role of roles) {
      const result = await get("", auth(role));
      assert.equal(result.status, 200);
      assert.deepEqual(Object.keys(result.body), ["schemaVersion", "fetchedAt", "projectId", "items", "page"]);
      assert.equal(result.body.schemaVersion, "dashboard-read-v1");
      assert.equal(result.body.projectId, a);
      assert.match(result.body.fetchedAt, /\.\d{6}Z$/);
      assert.deepEqual(result.body.page, { limit: 20, hasMore: false, nextCursor: null });
      assert.deepEqual(result.body.items.map((row: { pipelineSessionId: string }) => row.pipelineSessionId), ids);
      for (const row of result.body.items) {
        assert.deepEqual(Object.keys(row), ["pipelineSessionId", "projectId", "title", "createdAt", "updatedAt"]);
        assert.equal(row.projectId, a);
        assert.equal(row.title, "Session");
        assert.match(row.createdAt, /\.12300[01]Z$/);
        assert.equal(row.updatedAt, row.createdAt);
      }
      assert.deepEqual(await get("", auth(role), b), denied);
      assert.deepEqual(await get("", auth(role), randomUUID()), denied);
    }
    assert.deepEqual(await get("", null), error(401, "ERR_UNAUTHORIZED"));
    assert.deepEqual(await get("", "not-json"), error(401, "ERR_UNAUTHORIZED"));
    assert.deepEqual(await get("", { ...auth(), signatureHex: "0".repeat(64) }), denied);
    assert.deepEqual(await get("", auth("AUDITOR", a, "non-member")), denied);
    assert.deepEqual(await get("", auth("DEVELOPER", a, principalId)), denied);
    const staleAuth = core.issueAuthContext({ projectId: a, principalId, roles: ["AUDITOR"], ttlMs: 1 });
    authClock += 2;
    assert.deepEqual(await get("", staleAuth), denied);
    assert.deepEqual(await get("", auth(), "not-a-uuid"), invalid);

    for (const query of ["limit=0", "limit=-1", "limit=01", "limit=1.5", "limit=", "limit=101", "limit=1&limit=2",
      "stage=Ready", "status=ACTIVE", "cursor=", "cursor=x", "cursor=x&cursor=y", "cursor=" + "a".repeat(2049)]) {
      assert.deepEqual(await get(`?${query}`), invalid, query);
    }
    assert.deepEqual((await get("?limit=100")).body.page, { limit: 100, hasMore: false, nextCursor: null });
    const emptyPage = await get("", auth("AUDITOR", empty), empty);
    assert.equal(emptyPage.status, 200);
    assert.deepEqual(emptyPage.body.items, []);
    assert.deepEqual(emptyPage.body.page, { limit: 20, hasMore: false, nextCursor: null });

    const first = await get("?limit=2");
    assert.equal(first.status, 200);
    assert.equal(first.body.page.hasMore, true);
    const cursor = first.body.page.nextCursor;
    assert.ok(cursor);
    const seen: string[] = [];
    let page = first;
    for (const hasMore of [true, true, false]) {
      assert.equal(page.status, 200);
      assert.equal(page.body.items.length, 2);
      assert.equal(page.body.page.hasMore, hasMore);
      seen.push(...page.body.items.map((row: { pipelineSessionId: string }) => row.pipelineSessionId));
      if (hasMore) {
        assert.ok(page.body.page.nextCursor);
        page = await get(queryCursor(page.body.page.nextCursor));
      }
    }
    assert.deepEqual(seen, ids);
    assert.equal(page.body.page.nextCursor, null);
    assert.deepEqual(await get(queryCursor(cursor, 1)), conflict);
    assert.deepEqual(await get(queryCursor(cursor), auth("DEVELOPER")), conflict);
    assert.deepEqual(await get(queryCursor(cursor), auth("AUDITOR", b), b), conflict);
    assert.deepEqual(await get(queryCursor(cursor), auth("AUDITOR", a, "non-member")), denied);
    assert.deepEqual(await get(queryCursor(cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a"))), invalid);

    const mac = (data: string) => authenticator.signSessionReadCursor(data);
    const codec = new SessionReadCursorCodec(mac);
    const context = { projectId: a, principalId, limit: 2 };
    const decoded = codec.decode(cursor);
    assert.equal(decoded.anchor.pipelineSessionId, ids[1]);
    const clock = 1000000;
    const expiring = new SessionReadCursorCodec(mac, () => clock).encode(context, decoded.anchor);
    const atExpiry = new SessionReadCursorCodec(mac, () => clock + 15 * 60 * 1000);
    assert.equal(atExpiry.decode(expiring).expires, clock + 15 * 60 * 1000);
    assert.equal(atExpiry.mismatch(atExpiry.decode(expiring), context), true);
    assert.deepEqual(await get(queryCursor(expiring)), conflict);
    const anchor = { createdAt: "2026-11-24T01:00:00.000000Z", pipelineSessionId: foreign };
    const foreignAnchor = await get(queryCursor(codec.encode(context, anchor)));
    const absentAnchor = await get(queryCursor(codec.encode(context, { ...anchor, pipelineSessionId: randomUUID() })));
    assert.equal(foreignAnchor.status, 200);
    assert.deepEqual(foreignAnchor.body.items, absentAnchor.body.items);

    const oldMac = (data: string) => authenticator.signProjectReadCursor(data);
    const p1 = new ProjectReadCursorCodec(oldMac).encode(context, {
      projectId: a, slug: "fixture", name: "Fixture", defaultBranch: "main", createdAt: timestamp, updatedAt: timestamp,
    });
    const p3 = new TaskReadCursorCodec(oldMac).encode({ ...context, sessionId: ids[0]!, sourceStatuses: [] }, {
      taskId: randomUUID(), projectId: a, sessionId: ids[0]!, title: "Fixture", sourceStatus: "Ready",
      currentAttemptNo: 0, reworkCount: 0, maxReworkCycles: 1, activeLeaseEpoch: "0",
      assigneeId: null, leaseOwnerId: null, leaseExpiresAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    assert.deepEqual(await get(queryCursor(p1)), invalid);
    assert.deepEqual(await get(queryCursor(p3)), invalid);
    assert.deepEqual(await request(queryCursor(cursor)), invalid);
    assert.deepEqual(await request(`/${a}/sessions/${ids[0]}/tasks${queryCursor(cursor)}`), invalid);

    // A valid membership references a project through a FK in PostgreSQL. Inject only the
    // missing lookup result to exercise the defensive branch without invalid fixture data.
    if (pool) {
      const query = pool.queryInActiveTx.bind(pool);
      pool.queryInActiveTx = async <Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        sql.startsWith("SELECT project_id FROM projects") ? { rows: [], rowCount: 0, commandTag: "SELECT 0" } : query<Row>(sql, params);
      try {
        assert.deepEqual(await get(), error(404, "ERR_READ_RESOURCE_NOT_FOUND"));
      } finally {
        pool.queryInActiveTx = query;
      }
      await assert.rejects(pool.withReadOnlyRlsTransaction(scope, () => pool.queryInActiveTx(
        "UPDATE product_pipeline_sessions SET updated_at=updated_at WHERE project_id=$1::uuid;", [a],
      )), { sqlState: "25006" });
      assert.equal(pool.getStats().activeConnections, 0);
      assert.equal((await get()).status, 200);
    } else {
      const read = store.readSessionProjection;
      store.readSessionProjection = async () => { throw new PostgresRlsError("23503", "Private project detail"); };
      try {
        assert.deepEqual(await get(), error(404, "ERR_READ_RESOURCE_NOT_FOUND"));
      } finally {
        store.readSessionProjection = read;
      }
    }
    const read = store.readSessionProjection;
    store.readSessionProjection = async () => { throw new Error("private query failure"); };
    try {
      assert.deepEqual(await get(), error(500, "ERR_READ_PROJECTION_FAILED"));
    } finally {
      store.readSessionProjection = read;
    }
  } finally {
    await server.stop();
  }
}

test("session list HTTP contract in memory", async () => {
  const store = new SoftwareFactoryControlPlaneStore(() => new Date(timestamp));
  await verifyHttp(store, await seed(store));
});

test("session list HTTP contract on real PostgreSQL", { skip: !config && "Real PostgreSQL required" }, async () => {
  const pool = new PostgresRuntimePool(config!);
  try {
    const store = new PostgresControlPlaneRepository(pool);
    const fixture = await seed(store, pool);
    const before = await contents(pool, fixture);
    const schema = await catalog(pool);
    await verifyHttp(store, fixture, pool);
    assert.equal(await contents(pool, fixture), before);
    assert.equal(await catalog(pool), schema);
    assert.equal(pool.getStats().activeConnections, 0);
  } finally {
    await pool.close();
  }
});
