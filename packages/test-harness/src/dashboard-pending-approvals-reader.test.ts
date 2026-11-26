import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { CoreApiService } from "@software-factory/core-api";
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
