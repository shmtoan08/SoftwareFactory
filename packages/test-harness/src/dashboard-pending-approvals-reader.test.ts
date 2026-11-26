import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import {
  CORE_API_AUTH_HEADER, CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator,
  encodeCoreApiAuthHeader, type CoreApiAuthContext,
} from "@software-factory/core-api";
import { PendingApprovalsCursorCodec } from "../../../apps/core-api/src/pending-approvals-read-projection.ts";
import { TimelineReadCursorCodec } from "../../../apps/core-api/src/timeline-read-projection.ts";
import {
  buildPostgresPoolConfigFromEnv, pendingApprovalBoundary, PostgresControlPlaneRepository, PostgresRuntimePool,
  readPendingApprovalCandidates, SoftwareFactoryControlPlaneStore, type PendingApprovalBoundary,
  type PendingApprovalItem, type PendingApprovalsReadInput,
} from "@software-factory/database";

const project = (i: number) => `10000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const principalId = "fixture";
const fixture = process.env.PENDING_APPROVALS_FIXTURE_CONTAINER;
const pg = fixture ? buildPostgresPoolConfigFromEnv() : null;
const stamp = "2025-01-01T00:00:01.000000Z";
const cutoff = "2026-11-26T00:00:00.000001Z";

function sql(statement: string): string {
  return execFileSync("docker", ["exec", fixture!, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-c", statement],
    { encoding: "utf8" }).trim();
}

function params(statement: string, values: readonly (number | string)[]): string {
  return statement.replace(/\$(\d+)/g, (_, n: string) => {
    const value = values[Number(n) - 1]!;
    return typeof value === "number" ? String(value) : "'" + value.replaceAll("'", "''") + "'";
  }).trim().replace(/;$/, "");
}

function key(item: PendingApprovalItem) {
  const { rank, id } = pendingApprovalBoundary(item);
  return { rank, id };
}

test("internal pending approvals reader scopes signed tokens and returns an empty visible project", async () => {
  const store = new SoftwareFactoryControlPlaneStore(() => new Date("2026-11-26T00:00:00.001Z"));
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentProjectId: project(1) }, async () => {
    await store.createProject({ project_id: project(1), slug: "pending-reader", name: "Fixture", repo_bare_path: "/fixture", initial_main_commit_hash: "a".repeat(40) });
    await store.addProjectMembership({ project_id: project(1), principal_id: principalId, member_role: "AUDITOR" });
  });
  const service = new CoreApiService(store);
  const auth = service.issueAuthContext({ projectId: project(1), principalId, roles: ["AUDITOR"] });
  assert.deepEqual(await service.readPendingApprovalsProjection(auth, project(1)),
    { fetchedAt: "2026-11-26T00:00:00.001000Z", items: [] });
  assert.throws(() => service.readPendingApprovalsProjection(auth, project(2)));
  const unlisted = service.issueAuthContext({ projectId: project(1), principalId: "unlisted", roles: ["AUDITOR"] });
  await assert.rejects(service.readPendingApprovalsProjection(unlisted, project(1)), /Project read denied/);
});

test("TTL filtering skips fully expired chunks and compares DB microseconds including equality", async () => {
  const input: PendingApprovalsReadInput = {
    projectId: project(1), principalId, signedRoles: ["AUDITOR"], limit: 1, after: null, deadlineAt: Date.now() + 5000,
  };
  const approvals = ["2026-11-26T00:00:00.000000Z", cutoff, "2026-11-26T00:00:00.000002Z"].map((expires_at, index) => ({
    approval_request_id: project(3 - index), task_id: project(4), merge_candidate_id: project(5),
    status: "PENDING", created_at: stamp, expires_at,
  }));
  let calls = 0;
  const page = await readPendingApprovalCandidates(input, cutoff, async (query, args) => {
    assert.match(query, /WHERE project_id=\$1::uuid AND status='(?:PENDING_APPROVAL|PENDING)'/);
    assert.doesNotMatch(query, /\b(?:tasks|stage_approval_gates|JOIN)\b/i);
    assert.equal(args[0], project(1));
    assert.equal(args[1], 2);
    if (query.includes("FROM change_requests")) return [];
    calls++;
    if (calls === 1) return approvals.slice(0, 2);
    if (calls === 2) {
      assert.equal(args[3], approvals[1]!.approval_request_id);
      return approvals.slice(2);
    }
    return [];
  });
  assert.equal(calls, 3);
  assert.deepEqual(page, { fetchedAt: cutoff, items: [{ kind: "MERGE_APPROVAL", ...approvals[2] }] });
});

test("PostgreSQL pending reader traverses 3,000 tied CRs and merges both sources under RLS", { skip: !pg }, async () => {
  const pool = new PostgresRuntimePool(pg!);
  const service = new CoreApiService(new PostgresControlPlaneRepository(pool));
  try {
    const auth = (i: number) => service.issueAuthContext({ projectId: project(i), principalId, roles: ["AUDITOR"] });
    for (const i of [1, 2]) {
      const oracle = JSON.parse(sql(`SELECT json_agg(json_build_object('rank', rank, 'id', id)
        ORDER BY created_at DESC, rank ASC, id DESC) FROM (
        SELECT created_at, 0 AS rank, cr_id AS id FROM change_requests
        WHERE project_id='${project(i)}' AND status='PENDING_APPROVAL'
        UNION ALL
        SELECT created_at, 1, approval_request_id FROM approval_requests
        WHERE project_id='${project(i)}' AND status='PENDING' AND expires_at>now()
        ) AS eligible`));
      assert.equal(oracle.length, 3800);
      let after: PendingApprovalBoundary | undefined;
      const seen: ReturnType<typeof key>[] = [];
      const token = auth(i);
      for (let n = 0; n < 38; n++) {
        const page = await service.readPendingApprovalsProjection(token, project(i), { limit: 100, ...(after ? { after } : {}) });
        assert.equal(page.items.length, n === 37 ? 100 : 101);
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item), item.kind === "CHANGE_REQUEST"
            ? ["kind", "cr_id", "pipeline_session_id", "baseline_id", "cr_key", "hash", "title", "status", "created_at"]
            : ["kind", "approval_request_id", "task_id", "merge_candidate_id", "status", "created_at", "expires_at"]);
          if (item.kind === "MERGE_APPROVAL") assert.ok(item.expires_at > page.fetchedAt);
        }
        seen.push(...page.items.slice(0, 100).map(key));
        after = pendingApprovalBoundary(page.items[99]!);
      }
      assert.deepEqual(seen, oracle);
      assert.equal(new Set(seen.map((item) => `${item.rank}:${item.id}`)).size, seen.length);
    }
    assert.equal(sql("SELECT count(*) FROM approval_requests WHERE status='PENDING' AND expires_at<=now()"), "400");
    const denied = service.issueAuthContext({ projectId: project(1), principalId: "unlisted", roles: ["AUDITOR"] });
    await assert.rejects(service.readPendingApprovalsProjection(denied, project(1)), /Project read denied/);
  } finally {
    await pool.close();
  }
});

test("PostgreSQL source predicates isolate projects even when executed as the RLS-bypassing fixture owner", { skip: !pg }, async () => {
  assert.equal(sql("SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname=current_user"), "t");
  const fetchedAt = sql(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
  const foreign = JSON.parse(sql(`SELECT json_agg(id) FROM (
    SELECT cr_id AS id FROM change_requests WHERE project_id='${project(2)}' AND status='PENDING_APPROVAL'
    UNION ALL SELECT approval_request_id FROM approval_requests WHERE project_id='${project(2)}' AND status='PENDING'
    ) AS foreign_rows`)) as string[];
  const reached = new Set<string>();
  const page = await readPendingApprovalCandidates({
    projectId: project(1), principalId, signedRoles: ["AUDITOR"], limit: 100,
    after: { createdAt: "2025-01-01T02:43:20.000000Z", rank: 0, id: project(1) }, deadlineAt: Date.now() + 5000,
  }, fetchedAt, async (query, args) => {
    assert.doesNotMatch(query, /\b(?:tasks|stage_approval_gates|JOIN)\b/i);
    const rows = JSON.parse(sql(`SELECT coalesce(json_agg(r),'[]') FROM (${params(query, args)}) r`)) as Record<string, unknown>[];
    for (const row of rows) reached.add(String(row.cr_id ?? row.approval_request_id));
    return rows;
  });
  assert.ok(page.items.length);
  assert.ok(reached.size > 100);
  assert.ok(foreign.every((id) => !reached.has(id)));
});

type Page = {
  schemaVersion: string;
  fetchedAt: string;
  scope: { kind: string; projectId: string };
  items: PendingApprovalItem[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
};

function pendingRequest(base: string, i: number, auth?: CoreApiAuthContext | string, query = "") {
  return fetch(`${base}/api/v1/projects/${project(i)}/pending-approvals${query}`, {
    headers: auth === undefined ? {} : {
      [CORE_API_AUTH_HEADER]: typeof auth === "string" ? auth : encodeCoreApiAuthHeader(auth),
    },
  });
}

async function assertPendingError(response: Response, status: number, code: string) {
  const body = await response.text();
  assert.equal(response.status, status, body.slice(0, 300));
  assert.equal(body, JSON.stringify({ error_code: code }));
  return body;
}

function signed(core: CoreApiService, i: number, principal = principalId) {
  return core.issueAuthContext({ projectId: project(i), principalId: principal, roles: ["AUDITOR"] });
}

async function assertDeniedProjects(base: string, core: CoreApiService) {
  const token = signed(core, 1);
  const denied = (response: Response) => assertPendingError(response, 403, "ERR_FORBIDDEN_RLS");
  const nonmember = await denied(await pendingRequest(base, 1, signed(core, 1, "unlisted")));
  const absent = await denied(await pendingRequest(base, 99, signed(core, 99)));
  assert.equal(nonmember, absent);
  assert.equal(await denied(await pendingRequest(base, 2, token)), absent);
}

test("pending approvals HTTP membership-first and authorization error matrix on memory", async (t) => {
  const store = new SoftwareFactoryControlPlaneStore();
  let now = Date.now();
  const authenticator = new CoreApiTokenAuthenticator({ clockFn: () => new Date(now) });
  const core = new CoreApiService(store, { authenticator });
  const roles = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"] as const;
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentProjectId: project(1) }, async () => {
    await store.createProject({ project_id: project(1), slug: "pending-http", name: "Fixture", repo_bare_path: "/fixture",
      initial_main_commit_hash: "a".repeat(40) });
    for (const role of roles) await store.addProjectMembership({ project_id: project(1), principal_id: role, member_role: role });
    await store.addProjectMembership({ project_id: project(1), principal_id: principalId, member_role: "AUDITOR" });
  });
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  t.after(() => server.stop());
  await assertDeniedProjects(baseUrl, core);
  for (const bad of [undefined, "malformed"]) {
    await assertPendingError(await pendingRequest(baseUrl, 1, bad), 401, "ERR_UNAUTHORIZED");
  }
  const token = signed(core, 1);
  const wrongRole = core.issueAuthContext({ projectId: project(1), principalId, roles: ["DEVELOPER"] });
  const roleOutside = core.issueAuthContext({
    projectId: project(1), principalId, roles: ["OUTSIDE_READ_ROLES"] as unknown as readonly ["AUDITOR"],
  });
  const short = core.issueAuthContext({ projectId: project(1), principalId, roles: ["AUDITOR"], ttlMs: 1 });
  now += 2;
  for (const bad of [wrongRole, roleOutside, short, { ...token, signatureHex: "0".repeat(64) }]) {
    await assertPendingError(await pendingRequest(baseUrl, 1, bad), 403, "ERR_FORBIDDEN_RLS");
  }
  for (const role of roles) {
    const auth = core.issueAuthContext({ projectId: project(1), principalId: role, roles: [role] });
    const response = await pendingRequest(baseUrl, 1, auth);
    assert.equal(response.status, 200);
    const body = await response.json() as Page;
    assert.match(body.fetchedAt, /\.\d{6}Z$/);
    assert.deepEqual(body, {
      schemaVersion: "pending-approvals-v1", fetchedAt: body.fetchedAt, scope: { kind: "project-token", projectId: project(1) },
      items: [], page: { limit: 20, hasMore: false, nextCursor: null },
    });
  }
});

test("pending approvals HTTP distinguishes invalid cursors from authorized stale context without reading a page", async (t) => {
  const store = new SoftwareFactoryControlPlaneStore();
  const authenticator = new CoreApiTokenAuthenticator();
  const core = new CoreApiService(store, { authenticator });
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentProjectId: project(1) }, async () => {
    await store.createProject({ project_id: project(1), slug: "cursor-http", name: "Fixture", repo_bare_path: "/fixture",
      initial_main_commit_hash: "a".repeat(40) });
    await store.addProjectMembership({ project_id: project(1), principal_id: principalId, member_role: "AUDITOR" });
  });
  const pages = t.mock.method(store, "readPendingApprovalsProjection");
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  t.after(() => server.stop());
  const token = signed(core, 1);
  const context = { projectId: project(1), principalId, limit: 20 };
  const anchor = { createdAt: stamp, rank: 0, id: project(8) } as const;
  const mac = (data: string) => authenticator.signPendingApprovalsCursor(data);
  const codec = new PendingApprovalsCursorCodec(mac);
  const encoded = codec.encode(context, anchor);
  const timeline = new TimelineReadCursorCodec((data) => authenticator.signTimelineReadCursor(data))
    .encode({ ...context, pipelineSessionId: project(9) }, { recordedAt: stamp, rank: 1, resourceId: project(8) });
  for (const query of ["stage=READY", "kind=CHANGE_REQUEST", "extra=1", "limit=1&limit=1", "cursor=a&cursor=b",
    "limit=0", "limit=101", "limit=01", "limit=%201", "cursor=", "cursor=malformed",
    `cursor=${"é".repeat(1025)}`, `cursor=${timeline}`,
    `cursor=${encoded.slice(0, -1)}${encoded.endsWith("a") ? "b" : "a"}`]) {
    await assertPendingError(await pendingRequest(baseUrl, 1, token, `?${query}`), 400, "ERR_READ_QUERY_INVALID");
  }
  const expired = new PendingApprovalsCursorCodec(mac, () => Date.now() - 900_000).encode(context, anchor);
  const invalidContext = [expired, codec.encode({ ...context, projectId: project(2) }, anchor),
    codec.encode({ ...context, principalId: "other" }, anchor), codec.encode({ ...context, limit: 1 }, anchor)];
  for (const opaque of invalidContext) {
    await assertPendingError(await pendingRequest(baseUrl, 1, token, `?cursor=${opaque}`), 409, "ERR_READ_CURSOR_CONTEXT");
  }
  await assertPendingError(await pendingRequest(baseUrl, 1, signed(core, 1, "unlisted"), `?cursor=${expired}`),
    403, "ERR_FORBIDDEN_RLS");
  assert.equal(pages.mock.callCount(), 0);
});

test("pending approvals HTTP caps the complete UTF-8 body at 1 MiB even at limit 100", async (t) => {
  const store = new SoftwareFactoryControlPlaneStore();
  const core = new CoreApiService(store);
  const items: Extract<PendingApprovalItem, { kind: "CHANGE_REQUEST" }>[] = Array.from({ length: 100 }, (_, i) => ({
    kind: "CHANGE_REQUEST", cr_id: project(200 - i), pipeline_session_id: project(8), baseline_id: project(9),
    cr_key: "fixture", hash: "a".repeat(64), title: "é", status: "PENDING_APPROVAL", created_at: stamp,
  }));
  const expected = {
    schemaVersion: "pending-approvals-v1", fetchedAt: stamp, scope: { kind: "project-token", projectId: project(1) },
    items, page: { limit: 100, hasMore: false, nextCursor: null },
  };
  const cap = 1_048_576;
  items[0]!.title += "x".repeat(cap - Buffer.byteLength(JSON.stringify(expected)));
  t.mock.method(store, "readPendingApprovalsProjection", async () => ({ fetchedAt: stamp, items }));
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  t.after(() => server.stop());
  const token = signed(core, 1);
  const exact = await pendingRequest(baseUrl, 1, token, "?limit=100");
  assert.equal(exact.status, 200);
  assert.equal(exact.headers.get("content-length"), String(cap));
  assert.equal(await exact.text(), JSON.stringify(expected));
  items[0]!.title += "x";
  assert.equal(Buffer.byteLength(JSON.stringify(expected)), cap + 1);
  await assertPendingError(await pendingRequest(baseUrl, 1, token, "?limit=100"), 500, "ERR_READ_PROJECTION_FAILED");
});

test("PostgreSQL pending approvals HTTP walks the merged feed and rechecks membership on each page", { skip: !pg }, async (t) => {
  const pool = new PostgresRuntimePool(pg!);
  const authenticator = new CoreApiTokenAuthenticator();
  const core = new CoreApiService(new PostgresControlPlaneRepository(pool), { authenticator });
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  t.after(async () => { await server.stop(); await pool.close(); });
  await assertDeniedProjects(baseUrl, core);

  const token = signed(core, 1);
  const oracle = JSON.parse(sql(`SELECT json_agg(json_build_object('rank',rank,'id',id) ORDER BY created_at DESC, rank ASC, id DESC)
      FROM (SELECT created_at,0 AS rank,cr_id AS id FROM change_requests WHERE project_id='${project(1)}' AND status='PENDING_APPROVAL'
        UNION ALL SELECT created_at,1,approval_request_id FROM approval_requests
        WHERE project_id='${project(1)}' AND status='PENDING' AND expires_at>now()) AS items`)) as ReturnType<typeof key>[];
  assert.equal(oracle.length, 3800);
  const seen: PendingApprovalItem[] = [];
  const cursors = new Set<string>();
  let next: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "73" });
    if (next) query.set("cursor", next);
    const response = await pendingRequest(baseUrl, 1, token, `?${query}`);
    assert.equal(response.status, 200);
    const body = await response.json() as Page;
    assert.deepEqual(Object.keys(body), ["schemaVersion", "fetchedAt", "scope", "items", "page"]);
    assert.equal(body.schemaVersion, "pending-approvals-v1");
    assert.deepEqual(body.scope, { kind: "project-token", projectId: project(1) });
    assert.equal(body.page.limit, 73);
    assert.equal(body.page.hasMore, body.page.nextCursor !== null);
    assert.equal(body.items.length, Math.min(73, oracle.length - seen.length));
    for (const item of body.items) {
      if (item.kind === "MERGE_APPROVAL") {
        assert.deepEqual(Object.keys(item), ["kind", "approval_request_id", "task_id", "merge_candidate_id", "status", "created_at", "expires_at"]);
        assert.ok(item.expires_at > body.fetchedAt);
      } else {
        assert.deepEqual(Object.keys(item), ["kind", "cr_id", "pipeline_session_id", "baseline_id", "cr_key", "hash", "title", "status", "created_at"]);
      }
    }
    seen.push(...body.items);
    next = body.page.nextCursor;
    if (next) {
      assert.ok(!cursors.has(next));
      cursors.add(next);
    }
  } while (next);
  assert.deepEqual(seen.map(key), oracle);
  assert.ok(seen.some((item, index) => item.kind === "CHANGE_REQUEST"
    && seen[index + 1]?.kind === "MERGE_APPROVAL" && item.created_at === seen[index + 1]?.created_at));

  const firstCursor = [...cursors][0]!;
  await assertPendingError(await pendingRequest(baseUrl, 1, token, `?limit=72&cursor=${firstCursor}`), 409, "ERR_READ_CURSOR_CONTEXT");
  await assertPendingError(await pendingRequest(baseUrl, 2, signed(core, 2), `?limit=73&cursor=${firstCursor}`),
    409, "ERR_READ_CURSOR_CONTEXT");
  sql(`DELETE FROM project_memberships WHERE project_id='${project(1)}' AND principal_id='${principalId}'`);
  try {
    await assertPendingError(await pendingRequest(baseUrl, 1, token, `?limit=73&cursor=${firstCursor}`),
      403, "ERR_FORBIDDEN_RLS");
    await assertPendingError(await pendingRequest(baseUrl, 1, token, `?limit=72&cursor=${firstCursor}`),
      403, "ERR_FORBIDDEN_RLS");
  } finally {
    sql(`INSERT INTO project_memberships(project_id,principal_id,member_role) VALUES ('${project(1)}','${principalId}','AUDITOR')`);
  }
});
