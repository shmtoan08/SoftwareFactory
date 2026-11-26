import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORE_API_AUTH_HEADER, CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator,
  encodeCoreApiAuthHeader, type CoreApiAuthContext,
} from "@software-factory/core-api";
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

type TimelinePage = Awaited<ReturnType<CoreApiService["readTimelineProjection"]>>;

function timelinePath(project: string, session: string): string {
  return `/api/v1/projects/${project}/pipeline-sessions/${session}/timeline`;
}

function request(baseUrl: string, project: string, session: string, auth?: CoreApiAuthContext | string, query = "") {
  const headers: Record<string, string> = auth === undefined ? {} : {
    [CORE_API_AUTH_HEADER]: typeof auth === "string" ? auth : encodeCoreApiAuthHeader(auth),
  };
  return fetch(baseUrl + timelinePath(project, session) + query, { headers });
}

async function assertHttpError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error_code: code });
}

test("timeline HTTP response cap accepts exactly 1 MiB and rejects one extra UTF-8 byte", async (t) => {
  const store = new SoftwareFactoryControlPlaneStore();
  const core = new CoreApiService(store);
  const auth = core.issueAuthContext({ projectId, principalId, roles: ["AUDITOR"] });
  const stamp = "2026-11-26T00:00:00.123456Z";
  const details = { artifactSha256: "é" };
  const item: TimelineItem = { type: "artifact.recorded", recordedAt: stamp, resourceId: scopeId(3, 1), details };
  // Production details are fixed-size. Inject a larger DAO row to exercise the transport safety cap.
  const expected = {
    schemaVersion: "timeline-v1", fetchedAt: stamp,
    scope: { kind: "project-token", projectId, pipelineSessionId },
    items: [item], page: { limit: 20, hasMore: false, nextCursor: null },
  };
  const cap = 1024 * 1024;
  details.artifactSha256 += "x".repeat(cap - Buffer.byteLength(JSON.stringify(expected)));
  t.mock.method(store, "readTimelineProjection", async () => ({ fetchedAt: stamp, items: [item] }));
  const server = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl } = await server.start();
  try {
    const exact = await request(baseUrl, projectId, pipelineSessionId, auth);
    assert.equal(exact.status, 200);
    assert.equal(exact.headers.get("content-length"), String(cap));
    assert.equal(await exact.text(), JSON.stringify(expected));
    details.artifactSha256 += "x";
    assert.equal(Buffer.byteLength(JSON.stringify(expected)), cap + 1);
    await assertHttpError(await request(baseUrl, projectId, pipelineSessionId, auth), 500, "ERR_READ_PROJECTION_FAILED");
  } finally {
    await server.stop();
  }
});

const fixture = process.env.TIMELINE_DAO_FIXTURES === "1" ? buildPostgresPoolConfigFromEnv() : null;

test("PostgreSQL timeline HTTP route walks seven milestones and enforces the full error table", { skip: !fixture }, async (t) => {
  const pool = new PostgresRuntimePool(fixture!);
  const repo = new PostgresControlPlaneRepository(pool);
  const authenticator = new CoreApiTokenAuthenticator();
  const core = new CoreApiService(repo, { authenticator });
  const server = new CoreApiHttpServer({ coreApi: core });
  try {
    const { baseUrl } = await server.start();
    const project = scopeId(1, 2), session = scopeId(2, 2);
    const read = (query = "", token: CoreApiAuthContext | string = auth, projectPath = project, sessionPath = session) =>
      request(baseUrl, projectPath, sessionPath, token, query);
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
           UNION ALL SELECT 7,'change-request.applied',applied_at,cr_id FROM change_requests
             WHERE project_id=$1 AND pipeline_session_id=$2 AND applied_at IS NOT NULL
         ) AS expected ORDER BY ts DESC, rank DESC, id DESC`, [project, session])).rows,
    );
    assert.equal(reference.length, 9009);
    let cursor: string | null = null;
    let pages = 0;
    const seen = [];
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await read(`?${query}`);
      assert.equal(response.status, 200);
      const result = await response.json() as TimelinePage;
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
      assert.ok(++pages <= 91);
    } while (cursor);
    assert.deepEqual(seen, reference);
    assert.equal(pages, 91);
    assert.equal(new Set(seen.map((row) => row.type)).size, 7);
    assert.equal(seen.filter((row) => row.type === "change-request.applied").length, 3000);

    await assertHttpError(await request(baseUrl, project, session), 401, "ERR_UNAUTHORIZED");
    await assertHttpError(await read("", "malformed-transport"), 401, "ERR_UNAUTHORIZED");
    const forged = { ...auth, signatureHex: "0".repeat(64) };
    await assertHttpError(await read("", forged), 403, "ERR_FORBIDDEN_RLS");
    const unlisted = core.issueAuthContext({ projectId: project, principalId: "unlisted", roles: ["AUDITOR"] });
    await assertHttpError(await read("", unlisted), 403, "ERR_FORBIDDEN_RLS");
    await assertHttpError(await read("", auth, projectId, pipelineSessionId), 403, "ERR_FORBIDDEN_RLS");
    for (const id of [pipelineSessionId, scopeId(2, 99)]) {
      await assertHttpError(await read("", auth, project, id), 404, "ERR_READ_RESOURCE_NOT_FOUND");
    }
    for (const query of ["?limit=0", "?limit=101", "?stage=READY", "?unsupported=1", "?limit=1&limit=2",
      "?cursor=malformed", "?cursor=a&cursor=b", `?cursor=${"a".repeat(2049)}`]) {
      await assertHttpError(await read(query), 400, "ERR_READ_QUERY_INVALID");
    }
    await assertHttpError(await read("", auth, project, "%ZZ"), 400, "ERR_READ_QUERY_INVALID");
    const first = await read("?limit=1");
    assert.equal(first.status, 200);
    const page = await first.json() as TimelinePage;
    assert.equal(page.items.length, 1);
    assert.ok(page.page.nextCursor);
    const issued = page.page.nextCursor;
    await assertHttpError(await read(`?limit=2&cursor=${issued}`), 409, "ERR_READ_CURSOR_CONTEXT");
    await assertHttpError(await read(`?limit=1&cursor=${issued.slice(0, -1)}${issued.endsWith("0") ? "1" : "0"}`),
      400, "ERR_READ_QUERY_INVALID");
    const mac = (data: string) => authenticator.signTimelineReadCursor(data);
    const context = { projectId: project, pipelineSessionId: session, principalId, limit: 1 };
    const anchor = timelineAnchor(page.items[0]!);
    const expired = new TimelineReadCursorCodec(mac, () => Date.now() - 900_001).encode(context, anchor);
    const otherSession = new TimelineReadCursorCodec(mac).encode({ ...context, pipelineSessionId }, anchor);
    for (const token of [expired, otherSession]) {
      await assertHttpError(await read(`?limit=1&cursor=${token}`), 409, "ERR_READ_CURSOR_CONTEXT");
    }
    const defaultPage = await read();
    assert.equal(defaultPage.status, 200);
    assert.equal((await defaultPage.json() as TimelinePage).page.limit, 20);

    const boundary = reference.at(-1)!;
    const end = new TimelineReadCursorCodec(mac).encode(context, timelineAnchor({
      type: boundary.type, recordedAt: boundary.recorded_at, resourceId: boundary.resource_id, details: {},
    }));
    const exhausted = await read(`?limit=1&cursor=${end}`);
    assert.equal(exhausted.status, 200);
    const exhaustedBody = await exhausted.json() as TimelinePage;
    assert.deepEqual(exhaustedBody.items, []);
    assert.deepEqual(exhaustedBody.page, { limit: 1, hasMore: false, nextCursor: null });

    t.mock.method(repo, "readTimelineProjection", async () => { throw new Error("private database failure"); });
    await assertHttpError(await read(), 500, "ERR_READ_PROJECTION_FAILED");
  } finally {
    await server.stop();
    await pool.close();
  }
});
