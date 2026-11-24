import assert from "node:assert/strict";
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
