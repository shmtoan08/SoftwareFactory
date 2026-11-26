import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CORE_API_AUTH_HEADER, CoreApiService, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { WebApprovalConsoleHttpServer } from "../index.ts";
import { DashboardClient } from "../dashboard-data/client.ts";
import { mapSessionTasks } from "../dashboard-data/mapping.ts";
import { workItemsPanel } from "./work-items.ts";

const projectId = "10000000-0000-0000-0000-000000000021";
const sessionA = "20000000-0000-0000-0000-000000000021";
const sessionB = "20000000-0000-0000-0000-000000000022";
const taskId = "30000000-0000-0000-0000-000000000021";
const fetchedAt = "2026-11-24T11:00:00.123456Z";
const receivedAt = "2026-11-24T11:00:01.000Z";
const metadata = { schemaVersion: "dashboard-read-v1" as const, fetchedAt };
const nextCursor = "opaque+%&";
const projectPath = `/projects/${projectId}`;

function response(sessionId: string, statuses: string[], filter: string[] = [], cursor: string | null = null) {
  const items = statuses.map((sourceStatus, index) => ({
    taskId: index === 0 ? taskId : `30000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    projectId, sessionId, title: sessionId === sessionA ? "Task only in A" : "Task only in B", sourceStatus,
    currentAttemptNo: 1, reworkCount: 0, maxReworkCycles: 2, activeLeaseEpoch: "0",
    assigneeId: null, leaseOwnerId: null, leaseExpiresAt: null, createdAt: fetchedAt, updatedAt: fetchedAt,
  }));
  const data = mapSessionTasks({
    ...metadata, projectId, sessionId, items, filters: { sourceStatuses: filter, stage: null },
    page: { limit: 25, hasMore: cursor !== null, nextCursor: cursor },
  }, projectId, sessionId);
  return { kind: items.length ? "ok" as const : "empty" as const, data, receivedAt,
    source: { projectId, sessionId, endpoint: `/api/v1${projectPath}/sessions/${sessionId}/tasks` } };
}

test("Work items table displays every specified status pair and preserves unknown source status", () => {
  const pairs = [
    ["Ready", "Ready"], ["Leased", "Leased"], ["ExecutingInTarget", "Executing in target"],
    ["BuildingMergeCandidate", "Building merge candidate"], ["VerifyingInDocker", "Verifying in Docker"],
    ["UnderIndependentReview", "Under independent review"], ["AwaitingHumanApproval", "Awaiting human approval"],
    ["AtomicCasMerge", "Atomic CAS merge"], ["MergedAndCompleted", "Merged and completed"],
    ["ReworkRequired", "Rework required"], ["ManualIntervention", "Manual intervention"],
    ["future <state>  ", "Unknown"], ["constructor", "Unknown"],
  ];
  const html = workItemsPanel(projectId, sessionA, response(sessionA, pairs.map(([status]) => status!)));
  assert.match(html, /<th scope="col">sourceStatus<\/th><th scope="col">displayStatus<\/th>/);
  for (const [source, label] of pairs) {
    assert.ok(html.includes(`<td class="work-item-status">${source!.replace("<", "&lt;").replace(">", "&gt;")}</td><td>${label}</td>`), source);
  }
  assert.doesNotMatch(html, /\bstage\b|<state>|realtime|<progress/i);
});

test("Work items use scoped server filtering and paging, with isolated refresh and session navigation", async (t) => {
  const calls: Array<{ sessionId: string; options: Parameters<DashboardClient["listSessionTasks"]>[1] }> = [];
  let taskState: "ok" | "empty" | "error" | "access-denied" = "ok";
  let gate: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const base = { projectId, endpoint: "fixture" };
  const projectReader = t.mock.method(DashboardClient.prototype, "getProject", async () => ({
    kind: "ok", receivedAt, source: base, data: { ...metadata, project: {
      projectId, name: "Project stays ready", slug: "project", defaultBranch: "main", createdAt: fetchedAt, updatedAt: fetchedAt,
    } },
  }));
  const sessionsReader = t.mock.method(DashboardClient.prototype, "listSessions", async () => ({
    kind: "ok", receivedAt, source: base, data: { ...metadata, projectId, items: [sessionA, sessionB].map((id) => ({
      pipelineSessionId: id, projectId, title: id, createdAt: fetchedAt, updatedAt: fetchedAt,
    })), page: { limit: 20, hasMore: false, nextCursor: null } },
  }));
  const budgetReader = t.mock.method(DashboardClient.prototype, "getBudgetSnapshot", async () => ({
    kind: "error", receivedAt, source: base, error: { kind: "not-found", status: 404 },
  }));
  t.mock.method(DashboardClient.prototype, "listAgentProfiles", async () => ({
    kind: "empty", receivedAt, source: base, data: { profiles: [] },
  }));
  t.mock.method(DashboardClient.prototype, "getCostSessionSnapshot", async (pipelineSessionId: string) => ({
    kind: "empty", receivedAt, source: base, data: { ...metadata, projectId, pipelineSessionId, costSession: null },
  }));
  t.mock.method(DashboardClient.prototype, "getApprovalEvidence", async () => ({
    kind: "empty", receivedAt, source: base, data: { approvals: { decisions: [] }, evidence: { items: [], limited: false } },
  }));
  t.mock.method(DashboardClient.prototype, "listApprovalChangeRequests", async () => ({
    kind: "empty", receivedAt, source: base, data: { requests: [] },
  }));
  t.mock.method(DashboardClient.prototype, "listTimeline", async () => ({
    kind: "error", receivedAt, source: base, error: { kind: "not-found", status: 404 },
  }));
  t.mock.method(DashboardClient.prototype, "listSessionTasks", async (
    sessionId: string, options?: Parameters<DashboardClient["listSessionTasks"]>[1],
  ) => {
    calls.push({ sessionId, options });
    requested?.();
    await gate;
    if (taskState === "empty") return response(sessionId, [], [...(options?.sourceStatuses ?? [])]);
    if (taskState === "error" || taskState === "access-denied") {
      return { kind: "error", receivedAt, source: base, error: { kind: taskState === "error" ? "server-error" : "access-denied",
        status: taskState === "error" ? 500 : 403, message: "private response" } };
    }
    const filter = [...(options?.sourceStatuses ?? [])];
    return response(sessionId, filter.length ? filter : ["Ready"], filter, options?.cursor ? null : nextCursor);
  });
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const auth = encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId: "work-items-reader", roles: ["AUDITOR"] }));
  const headers = { [CORE_API_AUTH_HEADER]: auth };
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: "http://fixture.test" });
  const { baseUrl } = await web.start();
  const open = (path: string) => fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(10000) });
  try {
    const noSelection = await (await open(projectPath)).text();
    assert.match(noSelection, /id="work-items-empty"[\s\S]*?data-state="empty">Chưa chọn session/);
    assert.equal(calls.length, 0);
    const htmlA = await (await open(`${projectPath}?sessionId=${sessionA}`)).text();
    assert.deepEqual(calls, [{ sessionId: sessionA, options: undefined }]);
    assert.match(htmlA, /id="work-items-loading"[\s\S]*?data-state="loading"/);
    assert.match(htmlA, /id="tasks-panel"/);
    const tableA = htmlA.match(/<section id="work-items-panel" data-panel-url="([^"]+)"[\s\S]*?<div data-panel-body role="status">([\s\S]*?)<\/section>/);
    assert.ok(tableA?.[1] && tableA[2]);
    assert.ok(tableA[2].includes(fetchedAt));
    assert.match(tableA[2], /Task only in A/);
    const scripts = htmlA.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(scripts?.[1]);
    const handlers = new Map<string, (event: { target: unknown }) => Promise<void>>();
    const body = { innerHTML: tableA[2], setAttribute() {} };
    const select = { name: "status", value: "ReworkRequired" };
    const panel = { dataset: { panelUrl: tableA[1] }, isConnected: true,
      querySelector: () => body, querySelectorAll: () => [select] };
    runInNewContext(scripts[1], {
      document: { addEventListener: (name: string, fn: (event: { target: unknown }) => Promise<void>) => handlers.set(name, fn) },
      fetch: async (path: string, options: RequestInit) => {
        assert.equal(options.method, "GET");
        return open(path);
      },
      AbortSignal, URLSearchParams,
    });
    const click = (dataset: Record<string, string> = {}) =>
      handlers.get("click")!({ target: { closest: () => ({ dataset, disabled: false, closest: () => panel }) } });
    await click({ panelFilter: "" });
    assert.deepEqual(calls.at(-1), { sessionId: sessionA, options: { cursor: undefined, sourceStatuses: ["ReworkRequired"] } });
    assert.match(body.innerHTML, /<td class="work-item-status">ReworkRequired<\/td><td>Rework required<\/td>/);
    const next = body.innerHTML.match(/data-panel-request="([^"]+)">Trang tiếp/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(next);
    await click({ panelRequest: next });
    assert.deepEqual(calls.at(-1), { sessionId: sessionA, options: { cursor: nextCursor, sourceStatuses: ["ReworkRequired"] } });
    assert.doesNotMatch(body.innerHTML, /Trang tiếp/);
    await click();
    assert.deepEqual(calls.at(-1), { sessionId: sessionA, options: { cursor: undefined, sourceStatuses: ["ReworkRequired"] } });
    assert.deepEqual([projectReader, sessionsReader, budgetReader].map((mock) => mock.mock.callCount()), [2, 2, 2]);

    const beforeRefresh = calls.length;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { requested = resolve; });
    const pending = click();
    await started;
    assert.match(body.innerHTML, /data-state="loading"/);
    assert.doesNotMatch(body.innerHTML, /Task only in A/);
    await click({ panelFilter: "" });
    assert.equal(calls.length, beforeRefresh + 1);
    assert.deepEqual([projectReader, sessionsReader, budgetReader].map((mock) => mock.mock.callCount()), [2, 2, 2]);
    release?.();
    await pending;
    requested = undefined;
    gate = undefined;
    assert.match(body.innerHTML, /data-state="ready"/);

    for (const state of ["empty", "error", "access-denied"] as const) {
      taskState = state;
      await click();
      assert.ok(body.innerHTML.includes(`data-state="${state}"`));
      assert.doesNotMatch(body.innerHTML, /Task only in A|private response/);
    }
    assert.deepEqual([projectReader, sessionsReader, budgetReader].map((mock) => mock.mock.callCount()), [2, 2, 2]);
    const beforeInvalid = calls.length;
    assert.match(await (await open(panel.dataset.panelUrl + "&status=Ready")).text(), /Bộ lọc hoặc trang không hợp lệ/);
    assert.equal(calls.length, beforeInvalid);
    taskState = "ok";
    const htmlB = await (await open(`${projectPath}?sessionId=${sessionB}`)).text();
    assert.match(htmlB, /Task only in B/);
    assert.doesNotMatch(htmlB, /Task only in A/);
    assert.deepEqual(calls.at(-1), { sessionId: sessionB, options: undefined });
  } finally {
    release?.();
    await web.stop();
  }
});

test("Work items drill-down uses recorded P3 fields and reads only the opened task's approved detail resources", async () => {
  const otherTask = "30000000-0000-0000-0000-000000000022";
  const recordedProfile = "40000000-0000-0000-0000-000000000021";
  const corePath = `/api/v1${projectPath}`;
  const p3Path = `${corePath}/sessions/${sessionA}/tasks`;
  const calls: Array<{ method: string | undefined; path: string }> = [];
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const auth = encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId: "task-detail-reader", roles: ["AUDITOR"] }));
  const headers = { [CORE_API_AUTH_HEADER]: auth };
  const detailPaths = (task: string) => [
    `${corePath}/tasks/${task}/execution-target`,
    `${corePath}/tasks/${task}/target-dispatches`,
  ];
  const privateFields = { target_locator: "Private locator", public_context: "Private context",
    profile_snapshot: { example: "Private snapshot" } };
  const api = createServer((req, res) => {
    const path = req.url!;
    calls.push({ method: req.method, path });
    if (req.method !== "GET" || req.headers[CORE_API_AUTH_HEADER] !== auth) {
      res.writeHead(403).end();
      return;
    }
    let payload: unknown;
    let status = 200;
    if (path === `${corePath}/sessions`) {
      payload = { ...metadata, projectId, items: [{ pipelineSessionId: sessionA, projectId, title: "Selected session",
        createdAt: fetchedAt, updatedAt: fetchedAt }], page: { limit: 20, hasMore: false, nextCursor: null } };
    } else if (path === p3Path) {
      const data = response(sessionA, ["Ready"]).data;
      const row = data.items[0]!;
      payload = { ...data, items: [
        { ...row, title: "Task with recorded lease", assigneeId: recordedProfile, leaseOwnerId: "recorded-owner", leaseExpiresAt: fetchedAt },
        { ...row, taskId: otherTask, title: "Task without assignment or lease" },
      ] };
    } else if (path === detailPaths(taskId)[0]) {
      payload = { project_id: projectId, task_id: taskId, assignment_id: "assignment-one", profile_id: "approved-profile",
        worker_id: "assigned-worker", created_at: fetchedAt, ...privateFields };
    } else if (path === detailPaths(taskId)[1]) {
      payload = { dispatches: [{ project_id: projectId, task_id: taskId, execution_request_id: "request-one",
        status: "UNKNOWN", claimed_at: fetchedAt, completed_at: null, ...privateFields }] };
    } else if (detailPaths(otherTask).includes(path)) {
      status = 500;
      payload = { reason: "Private backend failure", ...privateFields };
    } else if (path === `${corePath}/agent-profiles`) {
      payload = { profiles: [] };
    } else {
      status = 404;
      payload = { error_code: "ERR_NOT_FOUND" };
    }
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: `http://127.0.0.1:${address.port}` });
  const { baseUrl } = await web.start();
  try {
    const html = await (await fetch(`${baseUrl}${projectPath}?sessionId=${sessionA}`, { headers })).text();
    assert.equal(calls.filter(({ path }) => path === p3Path).length, 1);
    const isDetail = ({ path }: { path: string }) => /\/(execution-target|target-dispatches)$/.test(path);
    assert.equal(calls.filter(isDetail).length, 0);
    const rows = [...html.matchAll(/<details data-task-detail="([^"]+)">([\s\S]*?)<\/details>/g)];
    assert.equal(rows.length, 2);
    const first = rows.find((row) => row[1]?.includes(taskId));
    const second = rows.find((row) => row[1]?.includes(otherTask));
    assert.ok(first?.[1] && first[2] && second?.[1] && second[2]);
    assert.match(first[2], /<dt>Lease owner \(đã ghi\)<\/dt><dd>recorded-owner<\/dd>/);
    assert.ok(first[2].includes(`<dt>Lease hết hạn lúc</dt><dd>${fetchedAt}</dd>`));
    assert.ok(first[2].includes(recordedProfile));
    assert.equal([...second[2].matchAll(/<dd>không có<\/dd>/g)].length, 3);

    type Toggle = (event: { target: unknown }) => Promise<void>;
    let toggle!: Toggle;
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    const loader = scripts.find((match) => match[1]?.includes('addEventListener("toggle"'));
    assert.ok(loader?.[1]);
    runInNewContext(loader[1], {
      document: { addEventListener(event: string, handler: Toggle) {
        assert.equal(event, "toggle");
        toggle = handler;
      } },
      fetch: (path: string, options: RequestInit) => fetch(baseUrl + path, { ...options, headers }),
      AbortSignal,
    });
    const openTask = async (endpoint: string, open: boolean) => {
      const body = { textContent: "", innerHTML: "" };
      await toggle({ target: { open, matches: () => true, isConnected: true, dataset: { taskDetail: endpoint },
        querySelector: () => body } });
      return body.innerHTML;
    };
    const beforeOpen = calls.length;
    await openTask(first[1], false);
    assert.equal(calls.length, beforeOpen);
    const fetched = await openTask(first[1], true);
    assert.deepEqual(calls.slice(beforeOpen).map(({ path }) => path).sort(), detailPaths(taskId).sort());
    assert.match(fetched, /<dt>Trạng thái dispatch<\/dt><dd>UNKNOWN<\/dd>/);
    assert.match(fetched, /assignment-one/);
    assert.doesNotMatch(fetched, /recorded-owner|Private (?:locator|context|snapshot)|target_locator|public_context|profile_snapshot/i);

    const beforeError = calls.length;
    const error = await openTask(second[1], true);
    assert.deepEqual(calls.slice(beforeError).map(({ path }) => path).sort(), detailPaths(otherTask).sort());
    assert.equal([...error.matchAll(/data-state="error"/g)].length, 2);
    assert.doesNotMatch(error, /không có|Private|UNKNOWN/);
    assert.doesNotMatch(first[2] + second[2] + fetched + error, /\b(?:online|running|active worker|active)\b/i);
    assert.ok(calls.every(({ method }) => method === "GET"));
  } finally {
    await web.stop();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});
