import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { CORE_API_AUTH_HEADER, CoreApiService, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { createControlPlaneStackRuntime, WebApprovalConsoleController, WebApprovalConsoleHttpServer } from "../index.ts";
import { withDashboardRouteBoundary } from "./router.ts";

const projectId = "console-project";
const taskId = "console-task";
const sessionId = "console-session";
const project = `/projects/${projectId}`;
const tasks = `${project}/tasks/${taskId}`;
const sessions = `${project}/pipeline-sessions`;
const session = `${sessions}/${sessionId}`;
const workbench = `${session}/m6b`;

interface Response {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

async function withConsole(run: (context: {
  endpoint: string;
  controller: WebApprovalConsoleController;
  authHeader: string;
}) => Promise<void>, dashboardCoreApiBaseUrl?: string) {
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const controller = new WebApprovalConsoleController(core);
  const authHeader = encodeCoreApiAuthHeader(core.issueAuthContext({
    projectId, principalId: "console-admin", roles: ["ORG_ADMIN"],
  }));
  const server = new WebApprovalConsoleHttpServer({ controller, dashboardCoreApiBaseUrl });
  const { baseUrl } = await server.start();
  try {
    await run({ endpoint: baseUrl, controller, authHeader });
  } finally {
    await server.stop();
  }
}

function open(endpoint: string, path: string, options: {
  auth?: string;
  form?: Record<string, string>;
  accept?: string;
  onBody?: (body: string) => void;
} = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const payload = options.form ? new URLSearchParams(options.form).toString() : undefined;
    const headers: Record<string, string | number> = { Accept: options.accept ?? "text/html" };
    if (options.auth) headers[CORE_API_AUTH_HEADER] = options.auth;
    if (payload !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = httpRequest(new URL(path, endpoint), {
      method: payload === undefined ? "GET" : "POST", headers,
    }, (res) => {
      res.setEncoding("utf8");
      let body = "";
      res.on("data", (chunk: string) => {
        body += chunk;
        options.onBody?.(body);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("Console request timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

function assertHtml(response: Response, status: number, heading: RegExp) {
  assert.equal(response.status, status, response.body);
  assert.match(response.headers["content-type"] ?? "", /^text\/html/);
  assert.match(response.body, heading);
}

test("Dashboard renders the empty Projects list and protects project data without auth", async () => {
  await withConsole(async ({ endpoint, controller }) => {
    const calls: string[] = [];
    controller.listPipelineSessions = async () => { calls.push("listPipelineSessions"); return []; };
    controller.loadPipelineBundle = async () => { calls.push("loadPipelineBundle"); return null; };

    const list = await open(endpoint, "/projects");
    assertHtml(list, 200, /<h1>Projects<\/h1>/);
    assert.match(list.body, /Project listings are unavailable here for now/);
    assert.match(list.body, /<a href="\/projects" aria-current="page">Projects<\/a>/);

    const detail = await open(endpoint, project);
    assertHtml(detail, 200, /<h1>Project<\/h1>/);
    assert.match(detail.body, /id="project-result" data-state="access-denied"/);
    assert.match(detail.body, /id="sessions-result" data-state="access-denied"/);
    assert.doesNotMatch(detail.body, /\brealtime\b|\blive\b/i);
    const projectsLink = detail.body.match(/<a href="([^"]+)">Projects<\/a>/)?.[1];
    assert.ok(projectsLink);
    assert.equal((await open(endpoint, projectsLink)).body, list.body);
    assert.deepEqual(calls, []);
  });
});

test("Dashboard not-found and invalid route pages preserve navigation and the server keeps serving", async () => {
  await withConsole(async ({ endpoint, authHeader }) => {
    for (const path of ["/unknown", `${project}/unknown`]) {
      const response = await open(endpoint, path);
      assertHtml(response, 404, /<h1>Page not found<\/h1>/);
      assert.match(response.body, /href="\/projects"/);
    }
    const invalid = await open(endpoint, "/projects/%ZZ");
    assertHtml(invalid, 400, /<h1>Invalid project address<\/h1>/);
    assert.doesNotMatch(invalid.body, /%ZZ|URIError/);
    const invalidJson = await open(endpoint, "/projects/%ZZ", { accept: "application/json" });
    assert.equal(invalidJson.status, 400);
    assert.match(invalidJson.headers["content-type"] ?? "", /^application\/json/);
    assert.deepEqual(JSON.parse(invalidJson.body), { error_code: "ERR_NOT_FOUND" });
    const json = await open(endpoint, "/unknown", { auth: authHeader, accept: "application/json" });
    assert.equal(json.status, 404);
    assert.equal(JSON.parse(json.body).error_code, "ERR_NOT_FOUND");
    assertHtml(await open(endpoint, "/projects"), 200, /<h1>Projects<\/h1>/);
  });
});

test("Dashboard route boundary replaces a rendering exception with a safe 500 page", () => {
  const response = withDashboardRouteBoundary(() => { throw new Error("private rendering detail"); });
  assert.equal(response.status, 500);
  assert.match(response.body, /<h1>Unable to open this page<\/h1>/);
  assert.match(response.body, /href="\/projects"/);
  assert.doesNotMatch(response.body, /private rendering detail/);
});

test("legacy console routes still render and navigate over HTTP", async (t) => {
  await withConsole(async ({ endpoint, authHeader, controller }) => {
    // Stub controller I/O so these regressions exercise the router and real HTML
    // renderers without running legacy write, model or Git operations.
    function stub(method: Exclude<keyof WebApprovalConsoleController, "coreApi">, result: unknown) {
      return t.mock.method(controller, method, async () => result);
    }

    const sessionRecord = { project_id: projectId, pipeline_session_id: sessionId,
      title: "Console session", current_stage: "STAGE_1_IDEA_DISCOVERY", status: "ACTIVE",
      created_by_principal_id: "console-admin", frozen_baseline_id: null };
    const traceability = { project_id: projectId, pipeline_session_id: sessionId, baseline_id: "baseline",
      requirement_rows: [], missing_links: [], orphan_links: [], coverage_percent: 0,
      covered_requirements: 0, total_requirements: 0, complete: false, traceability_sha256: "digest" };
    const task = { task_id: taskId, title: "Console task", status: "Ready", base_main_commit_hash: "base" };
    stub("loadApprovalCenterBundle", { project: { slug: projectId }, task, diffSummary: { changedFiles: [], diffText: "" } });
    stub("loadCandidateLineage", { task, taskId, resourceUsageMetrics: [], taskLeases: [], mergeOperations: [] });
    stub("listPipelineSessions", [sessionRecord]);
    stub("loadPipelineBundle", {
      session: sessionRecord, costSession: null, discoveryItems: [], artifacts: [], modelCallLedgers: [], approvalGates: [],
    });
    stub("listAgentOrganizationProfiles", []);
    stub("loadM6BBundle", {
      project_id: projectId, pipeline_session_id: sessionId, baseline: { baseline_id: "baseline", freeze_bundle_sha256: "digest" },
      agent_profiles: [], stage7_plan: { taskLinks: [], stories: [], epics: [], tasks: [], milestones: [] },
      change_requests: [], release_packages: [], traceability,
    });
    stub("loadTraceabilityMatrix", traceability);

    const health = await open(endpoint, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, service: "web-approval-console" });

    const pages = [
      [`${tasks}/approval-center`, /<h1>Approval Center: Console task<\/h1>/, undefined],
      [`${tasks}/lineage`, /<h1>Candidate-Bound Lineage: Console task<\/h1>/, undefined],
      [sessions, /<h1>Product Pipeline Sessions/, session],
      [session, /<h1>Product Pipeline: Console session<\/h1>/, workbench],
      [`${project}/agent-profiles`, /<h1>Agent Organization Profiles/, undefined],
      [workbench, /<h1>M6B Stages/, `${session}/traceability`],
      [`${session}/traceability`, /<h1>AC-11b Bidirectional Traceability Matrix<\/h1>/, workbench],
    ] as const;
    for (const [path, heading, link] of pages) {
      await t.test(`GET ${path}`, async () => {
        assert.equal((await open(endpoint, path)).status, 401);
        const response = await open(endpoint, path, { auth: authHeader });
        assertHtml(response, 200, heading);
        if (link) {
          assert.ok(response.body.includes(`href="${link}"`));
          assert.equal((await open(endpoint, link, { auth: authHeader })).status, 200);
        }
      });
    }

    const profile = { profile_key: "fixture", provider: "fixture", model: "fixture" };
    const actions = [
      [`${tasks}/approvals`, "submitDecisionFromApprovalCenterView", { decision: "REJECTED" }, { decision: "REJECTED" }, 201],
      [sessions, "createPipelineSession", { title: "Session", raw_idea_text: "Fixture" }, { session: sessionRecord }, session],
      [`${session}/stage1/extract`, "runPipelineStage1Extract", {}, {}, session],
      [`${session}/stage1/items/item/resolve`, "resolvePipelineStage1Item", { decision: "CONFIRM" }, {}, session],
      [`${session}/stage2/requirements`, "runPipelineStage2Requirements", {}, {}, session],
      [`${session}/stage3/architecture`, "runPipelineStage3Architecture", {}, {}, session],
      [`${session}/stage4/consistency-check`, "runPipelineStage4ConsistencyCheck", {}, {}, session],
      [`${session}/approval-gates`, "submitPipelineApprovalGate", {
        gate_stage: "STAGE_1_DISCOVERY", decision: "APPROVED",
        target_artifact_id: "artifact", target_artifact_sha256: "a".repeat(64),
      }, {}, session],
      [`${session}/freeze`, "freezePipelineBaseline", {}, {}, session],
      [`${project}/agent-profiles`, "upsertAgentOrganizationProfile", {
        profile_key: "fixture", principal_id: "developer", provider: "fixture", model: "fixture",
        role: "DEVELOPER", execution_target_type: "factory_managed_worker", trust_tier: "TIER_1_FACTORY_MANAGED",
      }, {}, `${project}/agent-profiles`],
      [`${project}/agent-profiles/validate-pair`, "validateStage6ReviewerPair", {
        developer_profile_id: "developer", reviewer_profile_id: "reviewer",
      }, { developerProfile: profile, reviewerProfile: profile }, 200],
      [`${session}/bootstrap`, "bootstrapPipelineProject", {}, {}, workbench],
      [`${session}/stage7/plan`, "runPipelineStage7Plan", {}, {}, workbench],
      [`${session}/change-requests`, "submitChangeRequest", {
        cr_key: "CR-1", title: "Change", rationale: "Fixture", impacted_requirement_ids: "req-1", proposed_tasks: "[]",
      }, {}, workbench],
      [`${session}/change-requests/cr/decide`, "decideChangeRequest", { decision: "APPROVED" }, {}, workbench],
      [`${session}/change-requests/cr/apply`, "applyChangeRequest", {}, {}, workbench],
      [`${session}/release-package`, "issueReleasePackage", {}, {}, workbench],
    ] as const;
    for (const [path, action, payload, result, destination] of actions) {
      await t.test(`POST ${path}`, async () => {
        const handler = stub(action, result);
        const form: Record<string, string> = Object.fromEntries(Object.entries(payload));
        assert.equal((await open(endpoint, path, { form })).status, 401);
        assert.equal(handler.mock.callCount(), 0);
        const response = await open(endpoint, path, { form, auth: authHeader });
        assert.equal(handler.mock.callCount(), 1, response.body);
        if (typeof destination === "string") {
          assert.equal(response.status, 303, response.body);
          assert.equal(response.headers.location, destination);
          assert.equal((await open(endpoint, destination, { auth: authHeader })).status, 200);
        } else if (action === "validateStage6ReviewerPair") {
          assertHtml(response, destination, /3D separation VALID/);
        } else {
          assert.equal(response.status, destination, response.body);
          assert.deepEqual(JSON.parse(response.body), result);
        }
      });
    }
  });
});

test("project detail streams panel states independently and uses only the approved GET endpoints", async () => {
  const id = "10000000-0000-0000-0000-000000000001";
  const otherId = "20000000-0000-0000-0000-000000000001";
  const chosenId = "20000000-0000-0000-0000-000000000002";
  const stamp = "2026-11-24T10:00:00.123456Z";
  const source = { schemaVersion: "dashboard-read-v1", fetchedAt: stamp };
  const items = [
    { pipelineSessionId: otherId, projectId: id, title: "Other", createdAt: stamp, updatedAt: stamp },
    { pipelineSessionId: chosenId, projectId: id, title: "<Chosen>", createdAt: stamp, updatedAt: stamp },
  ];
  const projectPath = `/projects/${id}`;
  let projectStatus = 200;
  let sessionsStatus = 200;
  let sessionItems = items;
  let receivedAuth: string | undefined;
  const calls: Array<{ method: string | undefined; url: string | undefined }> = [];
  const cursor = "opaque+%&";
  let nextCursor: string | null = null;
  let releaseProject: (() => void) | undefined;
  let projectGate: Promise<void> | undefined;
  const core = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (!receivedAuth || req.headers[CORE_API_AUTH_HEADER] !== receivedAuth) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url!, "http://127.0.0.1");
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === `/api/v1${projectPath}`) {
      await projectGate;
      res.writeHead(projectStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...source, project: { projectId: id, name: "Example project", slug: "example", defaultBranch: "main",
          createdAt: stamp, updatedAt: stamp },
      }));
    } else if (url.pathname === `/api/v1${projectPath}/sessions`) {
      res.writeHead(sessionsStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...source, projectId: id, items: sessionItems,
        page: { limit: 20, hasMore: nextCursor !== null, nextCursor } }));
    } else {
      res.writeHead(404).end();
    }
  });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  const address = core.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withConsole(async ({ endpoint, authHeader }) => {
      receivedAuth = authHeader;
      projectGate = new Promise<void>((resolve) => { releaseProject = resolve; });
      let sawIndependentSession = false;
      const initial = await open(endpoint, projectPath, {
        auth: authHeader,
        onBody(body) {
          if (body.includes('id="sessions-result"') && !body.includes('id="project-result"')) {
            sawIndependentSession = true;
            releaseProject?.();
          }
        },
      });
      projectGate = undefined;
      assert.equal(sawIndependentSession, true);
      assertHtml(initial, 200, /id="project-loading" data-state="loading"/);
      assert.match(initial.body, /id="sessions-loading" data-state="loading"/);
      assert.match(initial.body, /id="project-result" data-state="ready"/);
      assert.match(initial.body, /Example project/);
      assert.ok(initial.body.includes(`<dt>fetchedAt</dt><dd>${stamp}</dd>`));
      assert.match(initial.body, /<dt>receivedAt<\/dt><dd>[^<]+/);
      assert.match(initial.body, /id="sessions-result" data-state="empty"/);
      assert.match(initial.body, /<option value="" selected>Chưa chọn session<\/option>/);
      assert.doesNotMatch(initial.body, /<option value="[^"]+" selected/);
      assert.doesNotMatch(initial.body, /name="sessionId"[^>]*value=|<dt>Session ID<\/dt>/);
      assert.doesNotMatch(initial.body, new RegExp(authHeader));

      nextCursor = cursor;
      const selected = await open(endpoint, `${projectPath}?sessionId=${chosenId}`, { auth: authHeader });
      assert.match(selected.body, /id="sessions-result" data-state="ready"/);
      assert.ok(selected.body.includes(`<dt>Session ID</dt><dd>${chosenId}</dd>`));
      assert.ok(selected.body.includes(`<option value="${chosenId}" selected>&lt;Chosen&gt;</option>`));
      assert.doesNotMatch(selected.body, /<Chosen>/);
      assert.match(selected.body, /<dt>Tạo lúc<\/dt>/);
      assert.match(selected.body, /<dt>Cập nhật lúc<\/dt>/);
      assert.match(selected.body, /các panel phụ thuộc session sẽ dùng trong Slice 1c/);
      const next = selected.body.match(/href="([^"]+)">Trang tiếp/);
      assert.ok(next?.[1]);
      nextCursor = null;
      const nextPage = await open(endpoint, next[1], { auth: authHeader });
      assert.match(nextPage.body, /<option value="" selected>Chưa chọn session<\/option>/);
      assert.ok(calls.some(({ url }) => url === `/api/v1${projectPath}/sessions?${new URLSearchParams({ cursor })}`));

      for (const [project, sessions, itemsForPage, expectedProject, expectedSession] of [
        [500, 200, items, "error", "ready"],
        [403, 200, items, "access-denied", "ready"],
        [404, 200, items, "empty", "ready"],
        [200, 500, items, "ready", "error"],
        [200, 403, items, "ready", "access-denied"],
        [200, 200, [], "ready", "empty"],
      ] as const) {
        projectStatus = project;
        sessionsStatus = sessions;
        sessionItems = [...itemsForPage];
        const response = await open(endpoint, `${projectPath}?sessionId=${chosenId}`, { auth: authHeader });
        assert.ok(response.body.includes(`id="project-result" data-state="${expectedProject}"`));
        assert.ok(response.body.includes(`id="sessions-result" data-state="${expectedSession}"`));
        const progress = response.body.match(/<section id="pipeline-progress".*?<\/section>/s)?.[0];
        assert.ok(progress);
        assert.match(progress, /data-state="unsupported"/);
        assert.ok(progress.includes("Chưa có nguồn tiến độ được duyệt (session DTO không chứa stage/status/tiến độ)"));
        assert.doesNotMatch(progress, /<progress|role="progressbar"|%|\d+\s+task|Stage [0-9]/i);
        if (itemsForPage.length === 0) assert.match(response.body, /Chưa chọn session\. Project chưa có session\./);
      }
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.equal(call.method, "GET");
        const url = new URL(call.url!, endpoint);
        assert.ok([`/api/v1${projectPath}`, `/api/v1${projectPath}/sessions`, `/api/v1${projectPath}/budget-snapshot`, `/api/v1${projectPath}/agent-profiles`,
          `/api/v1${projectPath}/sessions/${chosenId}/tasks`,
          `/api/v1${projectPath}/pipeline-sessions/${chosenId}/cost-session-snapshot`,
          `/api/v1${projectPath}/pipeline-sessions/${chosenId}`, `/api/v1${projectPath}/pipeline-sessions/${chosenId}/change-requests`].includes(url.pathname));
        assert.ok([...url.searchParams.keys()].every((key) => key === "cursor"));
      }
    }, `http://127.0.0.1:${address.port}`);
  } finally {
    releaseProject?.();
    await new Promise<void>((resolve, reject) => core.close((err) => err ? reject(err) : resolve()));
  }
});

test("the stack runtime wires project detail to the paired Core API", async () => {
  const store = new SoftwareFactoryControlPlaneStore();
  const id = "10000000-0000-0000-0000-000000000003";
  const session = "20000000-0000-0000-0000-000000000003";
  const principalId = "dashboard-reader";
  await store.withRlsTransaction({ currentProjectId: id, currentRole: "system_admin_role" }, async () => {
    await store.createProject({ project_id: id, slug: "runtime-project", name: "Runtime project",
      repo_bare_path: "/private/runtime-project.git", initial_main_commit_hash: "a".repeat(40) });
    await store.addProjectMembership({ project_id: id, principal_id: principalId, member_role: "AUDITOR" });
  });
  await store.withRlsTransaction({ currentProjectId: id, currentPrincipalId: principalId, currentRole: "core_api_service" }, () =>
    store.createProductPipelineSession({ pipeline_session_id: session, project_id: id, title: "Runtime session",
      raw_idea_text: "Private session source", created_by_principal_id: principalId }));
  const runtime = await createControlPlaneStackRuntime({ env: {}, store, withGatewayHttp: false });
  try {
    assert.ok(runtime.webEndpoint && runtime.coreApiRuntime?.coreApiEndpoint);
    const auth = encodeCoreApiAuthHeader(runtime.coreApi.issueAuthContext({ projectId: id, principalId, roles: ["AUDITOR"] }));
    const response = await open(runtime.webEndpoint.baseUrl, `/projects/${id}?sessionId=${session}`, { auth });
    assertHtml(response, 200, /<dt>Tên<\/dt><dd>Runtime project<\/dd>/);
    assert.ok(response.body.includes(`<dt>Session ID</dt><dd>${session}</dd>`));
    assert.match(response.body, /<dt>Tên<\/dt><dd>Runtime session<\/dd>/);
    assert.match(response.body, /id="tasks-panel"[\s\S]*?data-state="empty">Session này chưa có task/);
    assert.match(response.body, /id="cost-session-result" data-state="empty"[\s\S]*?Session chưa có cost session/);
    assert.doesNotMatch(response.body, /Private session source|private\/runtime-project/);
  } finally {
    await runtime.close();
  }
});

test("Agent Profiles render only configured profile fields and handle each panel state", async (t) => {
  const id = "10000000-0000-0000-0000-000000000031";
  const profilePath = `/projects/${id}/dashboard-agent-profiles`;
  const corePath = `/api/v1/projects/${id}/agent-profiles`;
  const profile = (index: number) => ({
    project_id: id, principal_id: `profile-${index}`, provider: "<provider&>", model: "approved-model",
    role: "DEVELOPER", is_active: index % 2 === 0,
    target_locator: "Private target", public_context: "Private context", profile_snapshot: "Private snapshot",
    updated_at: "2020-01-01T00:00:00.000000Z",
  });

  async function scenario(
    status: number, payload: unknown,
    verify: (input: { endpoint: string; authHeader: string; calls: string[]; release(): void }) => Promise<void>,
    hold = false,
  ) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    if (!hold) release();
    const calls: string[] = [];
    let expectedAuth = "";
    const api = createServer(async (req, res) => {
      const path = req.url!;
      if (req.method !== "GET" || req.headers[CORE_API_AUTH_HEADER] !== expectedAuth) {
        res.writeHead(403).end();
        return;
      }
      calls.push(path);
      if (new URL(path, "http://127.0.0.1").pathname !== corePath) {
        res.writeHead(404).end();
        return;
      }
      await gate;
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const address = api.address();
    assert.ok(address && typeof address !== "string");
    try {
      await withConsole(async ({ endpoint, authHeader }) => {
        expectedAuth = authHeader;
        await verify({ endpoint, authHeader, calls, release });
      }, `http://127.0.0.1:${address.port}`);
    } finally {
      release();
      await new Promise<void>((resolve, reject) => api.close((err) => err ? reject(err) : resolve()));
    }
  }

  await t.test("loading is visible while other panels finish", async () => {
    await scenario(200, { profiles: [] }, async ({ endpoint, authHeader, release }) => {
      let sawLoading = false;
      const page = await open(endpoint, `/projects/${id}`, {
        auth: authHeader,
        onBody(body) {
          if (body.includes('id="agent-profiles-loading"') && body.includes('id="project-result"')
            && !body.includes('id="agent-profiles-panel"')) {
            sawLoading = true;
            release();
          }
        },
      });
      assert.equal(sawLoading, true);
      assert.match(page.body, /id="agent-profiles-loading"[\s\S]*?data-state="loading"/);
      assert.match(page.body, /id="agent-profiles-panel"[\s\S]*?data-state="empty"/);
    }, true);
  });

  for (const [status, expected, payload] of [
    [200, "empty", { profiles: [] }],
    [500, "error", { reason: "private backend response" }],
    [403, "access-denied", { reason: "private backend response" }],
  ] as const) {
    await t.test(expected, async () => {
      await scenario(status, payload, async ({ endpoint, authHeader, calls }) => {
        const response = await open(endpoint, profilePath, { auth: authHeader });
        assert.equal(response.status, 200);
        assert.equal(response.headers["x-dashboard-panel"], "1");
        assert.match(response.body, new RegExp(`data-state="${expected}"`));
        assert.doesNotMatch(response.body, /private backend response/);
        assert.deepEqual(calls, [corePath]);
        if (expected === "empty") assert.match(response.body, /Không có cấu hình profile/);
      });
    });
  }

  await t.test("read-only filters, exact fields and a bounded configuration table", async () => {
    await scenario(200, { profiles: Array.from({ length: 101 }, (_, index) => profile(index)) },
      async ({ endpoint, authHeader, calls }) => {
        const response = await open(endpoint, profilePath, { auth: authHeader });
        assert.equal(response.status, 200);
        assert.deepEqual(calls, [corePath]);
        assert.match(response.body, /Cấu hình profile/);
        assert.match(response.body, /Cấu hình bật\/tắt/);
        assert.match(response.body, /<td>Bật<\/td>/);
        assert.match(response.body, /<td>Tắt<\/td>/);
        assert.match(response.body, /&lt;provider&amp;&gt;/);
        assert.match(response.body, /<dt>Tải lúc \(receivedAt\)<\/dt><dd>[^<]+/);
        assert.match(response.body, /<dt>fetchedAt<\/dt><dd>API không cung cấp<\/dd>/);
        assert.match(response.body, /Chỉ hiển thị 100 cấu hình đầu/);
        assert.equal([...response.body.matchAll(/<th scope="row">profile-/g)].length, 100);
        assert.doesNotMatch(response.body, /online|running|active worker|Private (?:target|context|snapshot)|2020-01-01/i);
        const invalid = await open(endpoint, profilePath + "?role=UNKNOWN", { auth: authHeader });
        assert.match(invalid.body, /data-state="error"/);
        assert.equal(calls.length, 1);
      });
    await scenario(200, { profiles: [profile(0)] }, async ({ endpoint, authHeader, calls }) => {
      const response = await open(endpoint, profilePath + "?role=DEVELOPER&active_only=true", { auth: authHeader });
      assert.match(response.body, /<td>Bật<\/td>/);
      assert.doesNotMatch(response.body, /<td>Tắt<\/td>/);
      assert.deepEqual(calls, [corePath + "?role=DEVELOPER&active_only=true"]);
    });
  });
});

test("Cost session usage follows the Issue #25 envelope, attribution, integer math and error matrix", async (t) => {
  const id = "10000000-0000-0000-0000-000000000026";
  const selectedId = "20000000-0000-0000-0000-000000000026";
  const otherId = "20000000-0000-0000-0000-000000000027";
  const costId = "30000000-0000-0000-0000-000000000026";
  const stamp = "2026-11-24T00:00:00.123456Z";
  const corePath = `/api/v1/projects/${id}`;
  const readPath = `${corePath}/pipeline-sessions/${selectedId}/cost-session-snapshot`;
  const projectPath = `/projects/${id}`;
  const meta = { schemaVersion: "dashboard-read-v1", fetchedAt: stamp, projectId: id };
  const cost = {
    cost_session_id: costId, pipeline_session_id: selectedId, session_cost_budget_micro_usd: 20, cost_used_micro_usd: 8,
    tokens_used_total: 4, session_token_budget: 100, status: "ACTIVE",
  };
  let expectedAuth = "";
  let status = 200;
  const snapshot = { ...meta, pipelineSessionId: selectedId };
  let payload: unknown = { ...snapshot, costSession: cost };
  const calls: Array<{ method: string | undefined; path: string }> = [];
  const api = createServer((req, res) => {
    const path = req.url!;
    if (req.method !== "GET" || req.headers[CORE_API_AUTH_HEADER] !== expectedAuth) {
      res.writeHead(403).end();
      return;
    }
    if (path === readPath) {
      calls.push({ method: req.method, path });
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      return;
    }
    if (path === `${corePath}/sessions`) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        ...meta, items: [{ pipelineSessionId: selectedId, projectId: id, title: "Test pipeline session",
          createdAt: stamp, updatedAt: stamp }], page: { limit: 20, hasMore: false, nextCursor: null },
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withConsole(async ({ endpoint, authHeader }) => {
      expectedAuth = authHeader;
      const costPanel = async (sessionId?: string) => {
        const url = projectPath + (sessionId === undefined ? "" : `?sessionId=${sessionId}`);
        const page = await open(endpoint, url, { auth: authHeader });
        assert.equal(page.status, 200);
        const panel = page.body.match(/<section id="cost-session-result"[\s\S]*?<\/section>/)?.[0];
        assert.ok(panel);
        assert.match(panel, /<h2 id="cost-session-result-heading">Cost session usage<\/h2>/);
        assert.doesNotMatch(panel, /%|<select|<form|ledger|billing/i);
        return panel;
      };
      await t.test("no confirmed session means no snapshot request", async () => {
        assert.match(await costPanel(), /data-state="empty"[\s\S]*?Chưa chọn session/);
        assert.match(await costPanel(otherId), /Chưa chọn session/);
        assert.equal(calls.length, 0);
      });

      await t.test("matches attribution and displays a positive remaining balance", async () => {
        const panel = await costPanel(selectedId);
        assert.ok(panel.includes(`<dt>Cost session ID</dt><dd>${costId}</dd>`));
        assert.ok(panel.includes(`<dt>Session ID</dt><dd>${selectedId}</dd>`));
        assert.match(panel, /<dt>Phạm vi<\/dt><dd>Session đã chọn<\/dd>/);
        assert.match(panel, /<dt>Đã dùng \(micro-USD\)<\/dt><dd>8<\/dd>/);
        assert.match(panel, /<dt>Còn lại \(micro-USD\)<\/dt><dd>12<\/dd>/);
        assert.match(panel, /unsupported — API không cung cấp usage_estimated hoặc nguồn provider\/model/);
        assert.deepEqual(calls, [{ method: "GET", path: readPath }]);
      });

      await t.test("preserves cost-session scope on mismatched and null attribution", async () => {
        for (const attribution of [otherId, null]) {
          payload = { ...snapshot, costSession: { ...cost, pipeline_session_id: attribution, cost_used_micro_usd: 20 } };
          const panel = await costPanel(selectedId);
          assert.match(panel, /<dt>Phạm vi<\/dt><dd>Cost session<\/dd>/);
          assert.doesNotMatch(panel, /Session đã chọn|<dt>Session ID<\/dt>/);
          assert.match(panel, /<dt>Đã dùng \(micro-USD\)<\/dt><dd>20<\/dd>/);
          assert.match(panel, /<dt>Còn lại \(micro-USD\)<\/dt><dd>0<\/dd>/);
        }
      });

      await t.test("keeps negative remaining amounts and shows an explicit empty link", async () => {
        payload = { ...snapshot, costSession: { ...cost, session_cost_budget_micro_usd: 0,
          cost_used_micro_usd: Number.MAX_SAFE_INTEGER } };
        assert.match(await costPanel(selectedId), /<dt>Còn lại \(micro-USD\)<\/dt><dd>-9007199254740991 \(overrun\)<\/dd>/);
        payload = { ...snapshot, costSession: null };
        const empty = await costPanel(selectedId);
        assert.match(empty, /data-state="empty"/);
        assert.match(empty, /Session chưa có cost session/);
        assert.doesNotMatch(empty, /<dd>0<\/dd>|<dt>Đã dùng/);
      });

      await t.test("missing, unsafe or string amounts become unsupported before calculation", async () => {
        const { cost_used_micro_usd: _missing, ...missing } = cost;
        for (const value of [missing, { ...cost, cost_used_micro_usd: Number.MAX_SAFE_INTEGER + 1 },
          { ...cost, session_cost_budget_micro_usd: "20" }, { ...cost, cost_used_micro_usd: null }]) {
          payload = { ...snapshot, costSession: value };
          const unsupported = await costPanel(selectedId);
          assert.match(unsupported, /data-state="unsupported"/);
          assert.doesNotMatch(unsupported, /<dt>Còn lại|<dd>0<\/dd>|overrun/);
        }
      });

      await t.test("matches each S0 error and hides backend error details", async () => {
        for (const [code, error, state, message] of [
          [400, "ERR_READ_QUERY_INVALID", "error", "Yêu cầu snapshot không hợp lệ"],
          [401, "ERR_UNAUTHORIZED", "access-denied", "Cần xác thực"],
          [403, "ERR_FORBIDDEN_RLS", "access-denied", "không có quyền"],
          [404, "ERR_READ_RESOURCE_NOT_FOUND", "error", "Không tìm thấy snapshot"],
          [500, "ERR_READ_PROJECTION_FAILED", "error", "Không tải được snapshot"],
        ] as const) {
          status = code;
          payload = { error_code: error, reason: "Private backend detail" };
          const panel = await costPanel(selectedId);
          assert.ok(panel.includes(`data-state="${state}"`) && panel.includes(message));
          assert.doesNotMatch(panel, /<dd>0<\/dd>|Private backend detail|Session chưa có cost session/);
        }
        assert.ok(calls.every((call) => call.path === readPath && call.method === "GET"));
      });
    }, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("Issues #29 and #30 share selected-session R0 readers and preserve exact artifact bindings", async (t) => {
  const id = "10000000-0000-0000-0000-000000000029";
  const selectedId = "20000000-0000-0000-0000-000000000029";
  const foreignSession = "20000000-0000-0000-0000-000000000030";
  const oldHash = "a".repeat(64), latestHash = "b".repeat(64), exactHash = "c".repeat(64);
  const stamp = "2026-11-24T00:00:00.123456Z";
  const corePath = `/api/v1/projects/${id}`;
  const bundlePath = `${corePath}/pipeline-sessions/${selectedId}`;
  const crPath = `${bundlePath}/change-requests`;
  const projectPath = `/projects/${id}`;
  const identity = { project_id: id, pipeline_session_id: selectedId };
  const oldId = "30000000-0000-0000-0000-000000000029";
  const exactId = "30000000-0000-0000-0000-000000000030";
  const artifactMetadata = {
    ...identity, stage: "STAGE_2_REQUIREMENTS", artifact_kind: "STAGE_2_PRD_SRS",
  };
  const gate = {
    ...identity, gate_id: "gate-test", gate_stage: "STAGE_2_REQUIREMENTS",
    target_artifact_id: oldId, target_artifact_sha256: oldHash,
    decision: "APPROVED", rationale: "A note <script>", approver_principal_id: "principal-one", decided_at: stamp,
  };
  const bundle = {
    session: identity,
    artifacts: [
      { ...artifactMetadata, artifact_id: oldId, artifact_sha256: latestHash, content_json: { hidden: "Private artifact content" } },
      { ...artifactMetadata, artifact_id: exactId, artifact_sha256: exactHash, content_json: {} },
    ],
    approvalGates: [
      gate,
      { ...gate, gate_id: "gate-rejected", decision: "REJECTED", target_artifact_id: exactId, target_artifact_sha256: exactHash },
      { ...gate, gate_id: "gate-request-changes", decision: "REQUEST_CHANGES" },
      { ...gate, gate_id: "gate-missing", decision: undefined },
    ],
    modelCallLedgers: [{ detail: "Private ledger" }],
  };
  const requests = { change_requests: ["PENDING_APPROVAL", "APPROVED", "REJECTED", "APPLIED"].map((status, index) => ({
    ...identity, cr_id: `change-${index}`, baseline_id: "baseline-one", cr_key: `CR-${index}`,
    title: `Change ${index}`, status, cr_sha256: String(index).repeat(64), proposed_tasks: ["Private proposed tasks"],
  })) };

  let auth = "";
  let bundleStatus = 200, crStatus = 200;
  let bundleBody: unknown = bundle, crBody: unknown = requests;
  let holdBundle: Promise<void> | undefined;
  const calls: Array<{ method: string | undefined; path: string }> = [];
  const api = createServer(async (req, res) => {
    const path = req.url!;
    calls.push({ method: req.method, path });
    if (req.method !== "GET" || req.headers[CORE_API_AUTH_HEADER] !== auth) {
      res.writeHead(403).end();
      return;
    }
    if (path === bundlePath) {
      await holdBundle;
      res.writeHead(bundleStatus, { "Content-Type": "application/json" }).end(JSON.stringify(bundleBody));
      return;
    }
    if (path === crPath) {
      res.writeHead(crStatus, { "Content-Type": "application/json" }).end(JSON.stringify(crBody));
      return;
    }
    if (path === `${corePath}/sessions`) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        schemaVersion: "dashboard-read-v1", fetchedAt: stamp, projectId: id,
        items: [{ pipelineSessionId: selectedId, projectId: id, title: "Approval fixture", createdAt: stamp, updatedAt: stamp }],
        page: { limit: 20, hasMore: false, nextCursor: null },
      }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  try {
    await withConsole(async ({ endpoint, authHeader }) => {
      auth = authHeader;
      const read = (session = selectedId, onBody?: (body: string) => void) =>
        open(endpoint, projectPath + (session ? `?sessionId=${session}` : ""), { auth, onBody });
      const sections = (html: string) => {
        const decisions = html.match(/<section id="approval-decisions-result"[\s\S]*?<\/section>/)?.[0];
        const changes = html.match(/<section id="change-requests-result"[\s\S]*?<\/section>/)?.[0];
        assert.ok(decisions && changes);
        assert.doesNotMatch(decisions + changes, /<form|<button|Private |<script>|Workload|Project Health/);
        assert.doesNotMatch(decisions, /Pending approval/);
        return { decisions, changes };
      };
      await t.test("no approved reader runs without a selected session", async () => {
        for (const session of ["", foreignSession]) {
          const result = sections((await read(session)).body);
          assert.match(result.decisions, /data-state="empty"[\s\S]*?Chưa chọn session/);
          assert.match(result.changes, /data-state="empty"[\s\S]*?Chưa chọn session/);
        }
        assert.equal(calls.filter(({ path }) => path === bundlePath || path === crPath).length, 0);
      });

      await t.test("loading is independent and only exact artifact ID and hash can match", async () => {
        const from = calls.length;
        let resolve!: () => void;
        holdBundle = new Promise<void>((done) => { resolve = done; });
        let independent = false;
        const response = await read(selectedId, (html) => {
          if (html.includes('id="change-requests-result"') && !html.includes('id="approval-decisions-result"')) {
            independent = true;
            resolve();
          }
        });
        holdBundle = undefined;
        assert.equal(independent, true);
        assert.match(response.body, /id="evidence-loading" data-state="loading"/);
        assert.match(response.body, /id="approval-decisions-loading" data-state="loading"/);
        assert.match(response.body, /id="change-requests-loading" data-state="loading"/);
        const { decisions, changes } = sections(response.body);
        const approved = decisions.match(/<li data-decision="APPROVED">[\s\S]*?<\/li>/)?.[0];
        assert.ok(approved);
        assert.ok(approved.includes(oldHash));
        assert.ok(approved.includes(selectedId));
        assert.doesNotMatch(approved, new RegExp(latestHash));
        assert.match(approved, /Không có artifact khớp đúng ID và SHA-256/);
        assert.match(decisions, /data-decision="REJECTED"><h3>Rejected<\/h3>[\s\S]*?Khớp đúng ID và SHA-256 trong bundle/);
        assert.match(decisions, /data-decision="REQUEST_CHANGES"><h3>Changes requested/);
        assert.match(decisions, /data-decision="missing"><h3>No recorded decision/);
        assert.match(decisions, /A note &lt;script&gt;/);
        assert.match(decisions, /unsupported/);
        for (const [status, label] of [
          ["PENDING_APPROVAL", "Pending approval"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["APPLIED", "Applied"],
        ]) {
          assert.match(changes, new RegExp(`data-request-status="${status}"[\\s\\S]*?<dt>Trạng thái</dt><dd>${label}</dd>`));
        }
        assert.equal([...changes.matchAll(/Pending approval/g)].length, 1);
        assert.ok(changes.includes(selectedId) && changes.includes("baseline-one") && changes.includes("2".repeat(64)));
        assert.deepEqual(calls.slice(from).filter(({ path }) => path === bundlePath || path === crPath)
          .map(({ path }) => path).sort(), [bundlePath, crPath].sort());
      });

      await t.test("empty responses create no pending record", async () => {
        bundleBody = { ...bundle, approvalGates: [] };
        crBody = { change_requests: [] };
        const { decisions, changes } = sections((await read()).body);
        assert.match(decisions, /data-state="empty"[\s\S]*?No recorded decision/);
        assert.match(changes, /data-state="empty"[\s\S]*?Không có change request/);
        assert.doesNotMatch(changes, /Pending approval|data-request-status/);
      });

      await t.test("4xx, 5xx and malformed data are explicit and do not affect the other section", async () => {
        bundleStatus = 403;
        bundleBody = { reason: "Private gate exception" };
        crBody = requests;
        let result = sections((await read()).body);
        assert.match(result.decisions, /data-state="access-denied"/);
        assert.match(result.changes, /data-state="ready"/);
        bundleStatus = 200;
        bundleBody = bundle;
        crStatus = 500;
        crBody = { reason: "Private CR exception" };
        result = sections((await read()).body);
        assert.match(result.decisions, /data-state="ready"/);
        assert.match(result.changes, /data-state="error"/);
        bundleBody = { ...bundle, approvalGates: [{ ...gate, target_artifact_sha256: undefined }] };
        crStatus = 200;
        crBody = { change_requests: [{ ...requests.change_requests[0], pipeline_session_id: foreignSession }] };
        result = sections((await read()).body);
        assert.match(result.decisions, /data-state="error"[\s\S]*?Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ/);
        assert.match(result.changes, /data-state="error"[\s\S]*?Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ/);
        assert.doesNotMatch(result.changes, /Pending approval/);
      });

      const evidenceSection = (html: string) => {
        const section = html.match(/<section id="evidence-result"[\s\S]*?<\/section>/)?.[0];
        assert.ok(section);
        assert.doesNotMatch(section, /<(?:a|button|form|script)\b|\b(?:href|src|download)="/i);
        return section;
      };

      await t.test("Issue #30 escapes and caps previews and shows only exact non-navigable gate matches", async () => {
        const from = calls.length;
        const content = { text: "<script>alert(1)</script>", large: "x".repeat(5000) + "END-OF-PREVIEW" };
        bundleBody = { ...bundle, approvalGates: [
          ...bundle.approvalGates, { ...gate, gate_id: "gate-other-id", target_artifact_sha256: exactHash },
        ], artifacts: [
          { ...bundle.artifacts[0], content_json: content },
          bundle.artifacts[1],
          ...Array.from({ length: 49 }, () => ({ ...bundle.artifacts[1] })),
        ] };
        const evidence = evidenceSection((await read()).body);
        const [old, exact] = evidence.match(/<li>[\s\S]*?<\/li>/g) ?? [];
        assert.ok(old && exact);
        assert.match(old, /STAGE_2_PRD_SRS[\s\S]*STAGE_2_REQUIREMENTS/);
        assert.ok(old.includes(oldId) && old.includes(latestHash));
        assert.match(old, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
        assert.match(old, /Bản xem trước đã bị cắt/);
        assert.doesNotMatch(old, /END-OF-PREVIEW|gate-test|gate-rejected/);
        assert.ok(exact.includes(exactId) && exact.includes(exactHash));
        assert.match(exact, /gate-rejected/);
        assert.doesNotMatch(exact, /gate-test|gate-other-id/);
        assert.match(evidence, /Chỉ hiển thị 50 artifact/);
        assert.equal(evidence.match(/class="evidence-preview"/g)?.length, 50);
        assert.deepEqual(calls.slice(from).filter(({ path }) => path === bundlePath), [{ method: "GET", path: bundlePath }]);
      });

      await t.test("Issue #30 shows empty, inaccessible, malformed and upstream error states", async () => {
        for (const [status, artifacts, expected] of [
          [200, [], /data-state="empty".*?Không có artifact/s],
          [200, undefined, /data-state="unavailable".*?Inaccessible\/unavailable artifact/s],
          [200, [{ ...bundle.artifacts[0], content_json: undefined }, bundle.artifacts[1]], /data-state="unavailable">Inaccessible\/unavailable artifact/],
          [200, [{ ...bundle.artifacts[0], project_id: foreignSession }], /data-state="unavailable".*?Inaccessible\/unavailable artifact/s],
          [403, [], /data-state="access-denied".*?Inaccessible\/unavailable artifact/s],
          [404, [], /data-state="unavailable".*?Inaccessible\/unavailable artifact/s],
          [500, [], /data-state="error".*?Không tải được Evidence/s],
        ] as const) {
          bundleStatus = status;
          bundleBody = { ...bundle, artifacts };
          const evidence = evidenceSection((await read()).body);
          assert.match(evidence, expected);
          if (status === 200 && Array.isArray(artifacts) && artifacts.length === 2) assert.match(evidence, /gate-rejected/);
          assert.doesNotMatch(evidence, /Private artifact content/);
        }
      });

      assert.ok(calls.every(({ method, path }) => method === "GET" && !/approval-center|lineage|production-deployments/.test(path)));
      const allowed = new Set([corePath, `${corePath}/sessions`, `${corePath}/budget-snapshot`, `${corePath}/agent-profiles`,
        `${corePath}/sessions/${selectedId}/tasks`, `${bundlePath}/cost-session-snapshot`, bundlePath, crPath]);
      assert.deepEqual(calls.filter(({ path }) => !allowed.has(path)), []);
    }, `http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});
