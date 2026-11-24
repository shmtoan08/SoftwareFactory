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
        assert.ok([`/api/v1${projectPath}`, `/api/v1${projectPath}/sessions`, `/api/v1${projectPath}/budget-snapshot`,
          `/api/v1${projectPath}/sessions/${chosenId}/tasks`].includes(url.pathname));
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
    assert.doesNotMatch(response.body, /Private session source|private\/runtime-project/);
  } finally {
    await runtime.close();
  }
});
