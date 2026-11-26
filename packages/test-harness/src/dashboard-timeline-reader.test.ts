import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreApiService, CoreApiTokenAuthenticator } from "@software-factory/core-api";
import {
  buildPostgresPoolConfigFromEnv, PostgresControlPlaneRepository, PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore, timelineAnchor, type TimelineItem,
} from "@software-factory/database";
import { TimelineReadCursorCodec } from "../../../apps/core-api/src/timeline-read-projection.ts";

const scopeId = (part: number, scope: number) => `${part}0000000-0000-0000-0000-${String(scope).padStart(12, "0")}`;
const projectId = scopeId(1, 1);
const pipelineSessionId = scopeId(2, 1);
const principalId = "fixture";

test("timeline service enforces authentication, query and cursor context before serving pages", async () => {
  const store = new SoftwareFactoryControlPlaneStore();
  const authenticator = new CoreApiTokenAuthenticator();
  const core = new CoreApiService(store, { authenticator });
  const otherSession = scopeId(2, 2);
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentProjectId: projectId }, async () => {
    await store.createProject({ project_id: projectId, slug: "timeline-fixture", name: "Fixture",
      repo_bare_path: "/fixture", initial_main_commit_hash: "a".repeat(40) });
    for (const principal of [principalId, "other"]) {
      await store.addProjectMembership({ project_id: projectId, principal_id: principal, member_role: "AUDITOR" });
    }
  });
  await store.withRlsTransaction({ currentRole: "core_api_service", currentProjectId: projectId }, async () => {
    for (const id of [pipelineSessionId, otherSession]) {
      await store.createProductPipelineSession({ pipeline_session_id: id, project_id: projectId, title: "Fixture",
        raw_idea_text: "excluded", created_by_principal_id: principalId });
    }
  });
  const auth = core.issueAuthContext({ projectId, principalId, roles: ["AUDITOR"] });
  const other = core.issueAuthContext({ projectId, principalId: "other", roles: ["AUDITOR"] });
  const read = (query = "", token: typeof auth | null = auth, session = pipelineSessionId, project = projectId) =>
    core.readTimelineProjection(token, project, session, new URLSearchParams(query));
  await assert.rejects(read("", null), { httpStatus: 401, code: "ERR_UNAUTHORIZED" });
  await assert.rejects(read("", { ...auth, signatureHex: "0".repeat(64) }), { httpStatus: 403 });
  await assert.rejects(read("", auth, pipelineSessionId, scopeId(1, 2)), { httpStatus: 403 });
  await assert.rejects(read("", auth, scopeId(2, 99)), { httpStatus: 404 });
  for (const query of ["limit=0", "limit=101", "limit=01", "limit=2&limit=2", "stage=READY",
    "other=1", "cursor=garbage", `cursor=${"a".repeat(2049)}`]) {
    await assert.rejects(read(query), { httpStatus: 400, code: "ERR_READ_QUERY_INVALID" });
  }
  const first = await read();
  assert.equal(first.schemaVersion, "timeline-v1");
  assert.equal(first.page.limit, 20);
  assert.equal(first.items[0]?.type, "session.created");
  assert.deepEqual(first.items[0]?.details, {});
  const context = { projectId, pipelineSessionId, principalId, limit: 20 };
  const anchor = timelineAnchor(first.items[0]!);
  const mac = (data: string) => authenticator.signTimelineReadCursor(data);
  const codec = new TimelineReadCursorCodec(mac);
  const encoded = codec.encode(context, anchor);
  assert.deepEqual((await read(`cursor=${encoded}`)).items, []);
  const expired = new TimelineReadCursorCodec(mac, () => Date.now() - 900_001).encode(context, anchor);
  for (const promise of [read(`cursor=${expired}`), read(`cursor=${encoded}`, other),
    read(`cursor=${encoded}`, auth, otherSession), read(`cursor=${encoded}&limit=100`)]) {
    await assert.rejects(promise, { httpStatus: 409, code: "ERR_READ_CURSOR_CONTEXT" });
  }
  await assert.rejects(read(`cursor=${encoded.slice(0, -1)}${encoded.endsWith("0") ? "1" : "0"}`), { httpStatus: 400 });
  const wrongPurpose = new TimelineReadCursorCodec((data) => authenticator.signSessionReadCursor(data)).encode(context, anchor);
  await assert.rejects(read(`cursor=${wrongPurpose}`), { httpStatus: 400 });
});

const fixture = process.env.TIMELINE_DAO_FIXTURES === "1" ? buildPostgresPoolConfigFromEnv() : null;

test("PostgreSQL timeline DAO walks the complete 3,000-tie fixture with signed page cursors", { skip: !fixture }, async () => {
  const pool = new PostgresRuntimePool(fixture!);
  try {
    const project = scopeId(1, 2), session = scopeId(2, 2);
    const core = new CoreApiService(new PostgresControlPlaneRepository(pool));
    const auth = core.issueAuthContext({ projectId: project, principalId, roles: ["AUDITOR"] });
    const reference = await pool.withReadOnlyRlsTransaction(
      { currentProjectId: project, currentPrincipalId: principalId, currentRole: "core_api_service" },
      async () => (await pool.queryInActiveTx<{ type: TimelineItem["type"]; resource_id: string; recorded_at: string }>(
        `SELECT type, id AS resource_id, to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
         FROM (
           SELECT 1 AS rank, 'session.created' AS type, created_at AS ts, pipeline_session_id AS id
             FROM product_pipeline_sessions WHERE project_id=$1 AND pipeline_session_id=$2
           UNION ALL SELECT 2,'artifact.recorded',created_at,artifact_id FROM stage_artifacts WHERE project_id=$1 AND pipeline_session_id=$2
           UNION ALL SELECT 3,'gate.decided',decided_at,gate_id FROM stage_approval_gates WHERE project_id=$1 AND pipeline_session_id=$2
           UNION ALL SELECT 4,'baseline.frozen',frozen_at,baseline_id FROM baseline_spec_freezes WHERE project_id=$1 AND pipeline_session_id=$2
           UNION ALL SELECT 5,'change-request.submitted',created_at,cr_id FROM change_requests WHERE project_id=$1 AND pipeline_session_id=$2
           UNION ALL SELECT 6,'change-request.decided',decided_at,cr_id FROM change_requests
             WHERE project_id=$1 AND pipeline_session_id=$2 AND decided_at IS NOT NULL
         ) AS expected ORDER BY ts DESC, rank DESC, id DESC`, [project, session])).rows,
    );
    assert.equal(reference.length, 6009);
    let cursor: string | null = null;
    let pages = 0;
    const seen = [];
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await core.readTimelineProjection(auth, project, session, query);
      assert.deepEqual(result.scope, { kind: "project-token", projectId: project, pipelineSessionId: session });
      for (const item of result.items) {
        assert.deepEqual(Object.keys(item).sort(), ["details", "recordedAt", "resourceId", "type"]);
        const allowlist = item.type === "artifact.recorded" ? ["artifactSha256"]
          : item.type === "gate.decided" ? ["decision", "targetArtifactId", "targetArtifactSha256"] : [];
        assert.deepEqual(Object.keys(item.details).sort(), allowlist);
        seen.push({ type: item.type, resource_id: item.resourceId, recorded_at: item.recordedAt });
      }
      cursor = result.page.nextCursor;
      assert.equal(result.page.hasMore, cursor !== null);
      assert.ok(++pages <= 61);
    } while (cursor);
    assert.deepEqual(seen, reference);
    assert.equal(pages, 61);
    await assert.rejects(core.readTimelineProjection(auth, project, pipelineSessionId), { httpStatus: 404 });
  } finally {
    await pool.close();
  }
});
