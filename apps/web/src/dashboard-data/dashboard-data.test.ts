import "../dashboard-shell/router.test.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DashboardClient } from "./client.ts";
import { mapBudgetSnapshot, mapProjectDetail, mapSessions, mapSessionTasks } from "./mapping.ts";

const projectId = "10000000-0000-0000-0000-000000000001";
const sessionId = "20000000-0000-0000-0000-000000000001";
const fetchedAt = "2026-11-24T00:00:00.123456Z";
const receivedAt = "2026-11-24T00:00:01.000Z";
const metadata = { schemaVersion: "dashboard-read-v1", fetchedAt };
const project = { projectId, slug: "example", name: "Example", defaultBranch: "main",
  createdAt: fetchedAt, updatedAt: fetchedAt };
const detail = { ...metadata, project };
const projects = { ...metadata, scope: { kind: "project-token", projectId }, items: [project],
  page: { limit: 20, hasMore: false, nextCursor: null } };
const task = {
  taskId: "30000000-0000-0000-0000-000000000001",
  projectId, sessionId, title: "Retry verification", sourceStatus: "Ready",
  currentAttemptNo: 3, reworkCount: 2, maxReworkCycles: 4, activeLeaseEpoch: "9007199254740993",
  assigneeId: "40000000-0000-0000-0000-000000000001",
  leaseOwnerId: "worker-1", leaseExpiresAt: fetchedAt, createdAt: fetchedAt, updatedAt: fetchedAt,
};
const tasks = { ...metadata, projectId, sessionId, filters: { sourceStatuses: [], stage: null }, items: [task],
  page: { limit: 25, hasMore: false, nextCursor: null } };
const budget = {
  ...metadata, projectId, policy: { status: "AUTO_PAUSED", updatedAt: fetchedAt },
  dimensions: {
    tokens: { unit: "tokens", limitKind: "configured", limit: "1", consumed: "9007199254740993",
      remaining: "-9007199254740992" },
    costMicroUsd: { unit: "micro_usd", limitKind: "unbounded", limit: null, consumed: "50", remaining: null },
    wallTimeMs: { unit: "milliseconds", limitKind: "unbounded", limit: null, consumed: "10", remaining: null },
  },
  estimatedModelUsageIncluded: false,
  recoveryState: "pending", recoveryReason: "visible-pending-intent",
  recoveryScope: "visible-project-budget-denial-intents-at-snapshot",
  usageSemantics: "recorded-project-ledgers-and-resource-metrics",
};

function client(fetch: typeof globalThis.fetch, timeoutMs = 1000) {
  return new DashboardClient({
    baseUrl: "http://core.test", projectId, authToken: "test-token", timeoutMs, fetch,
    now: () => new Date(receivedAt),
  });
}

test("maps all four readers with exact DTOs, GET auth and separate receipt and snapshot times", async () => {
  const dtoByPath = new Map<string, unknown>([
    ["/api/v1/projects", projects],
    [`/api/v1/projects/${projectId}`, detail],
    [`/api/v1/projects/${projectId}/budget-snapshot`, budget],
    [`/api/v1/projects/${projectId}/sessions/${sessionId}/tasks`, tasks],
  ]);
  const api = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init.headers).get("x-sf-auth-token"), "test-token");
    assert.equal(url.search, "");
    assert.ok(dtoByPath.has(url.pathname));
    return Response.json(dtoByPath.get(url.pathname));
  });
  for (const [result, expected] of [
    [await api.listProjects(), projects],
    [await api.getProject(), detail],
    [await api.getBudgetSnapshot(), budget],
    [await api.listSessionTasks(sessionId), tasks],
  ] as const) {
    assert.equal(result.kind, "ok");
    assert.equal(result.receivedAt, receivedAt);
    assert.deepEqual(result.data, expected);
    assert.equal(result.data.fetchedAt, fetchedAt);
    assert.equal(result.source.projectId, projectId);
    assert.equal(result.source.sessionId, expected === tasks ? sessionId : undefined);
  }
});

test("records receipt before consuming the response body", async () => {
  let clock = receivedAt;
  const api = new DashboardClient({
    baseUrl: "http://core.test", projectId, authToken: "test-token", timeoutMs: 1000,
    now: () => new Date(clock),
    fetch: async () => new Response(new ReadableStream({
      pull(controller) {
        clock = "2026-11-24T00:00:02.000Z";
        controller.enqueue(new TextEncoder().encode(JSON.stringify(detail)));
        controller.close();
      },
    }, { highWaterMark: 0 })),
  });
  const result = await api.getProject();
  assert.equal(result.kind, "ok");
  assert.equal(result.receivedAt, receivedAt);
  assert.equal(result.data.fetchedAt, fetchedAt);
});

test("preserves an unfamiliar sourceStatus verbatim", () => {
  const futureTask = { ...task, sourceStatus: " Future status / v2 " };
  const dto = { ...tasks, items: [futureTask] };
  assert.deepEqual(mapSessionTasks(dto, projectId, sessionId), dto);
});

test("empty collections retain their API metadata", async () => {
  const empty = { ...projects, items: [] };
  const result = await client(async () => Response.json(empty)).listProjects();
  assert.equal(result.kind, "empty");
  assert.equal(result.receivedAt, receivedAt);
  assert.deepEqual(result.data, empty);
});

test("passes the server cursor back unchanged for projects and tasks and preserves filters", async () => {
  const cursor = "opaque_base64url.cursor-1";
  for (const collection of [projects, tasks]) {
    const isTasks = collection === tasks;
    const filters = { sourceStatuses: ["Ready"], stage: null };
    const first = { ...collection, ...(isTasks ? { filters } : {}),
      page: { limit: 100, hasMore: true, nextCursor: cursor } };
    const second = { ...first, items: [], page: { limit: 100, hasMore: false, nextCursor: null } };
    const queries: string[] = [];
    const api = client(async (input) => {
      const url = new URL(String(input));
      queries.push(url.search);
      return Response.json(url.searchParams.has("cursor") ? second : first);
    });
    const read = (next?: string) => isTasks
      ? api.listSessionTasks(sessionId, { limit: 100, cursor: next, sourceStatuses: ["Ready"] })
      : api.listProjects({ limit: 100, cursor: next });
    const initial = await read();
    assert.equal(initial.kind, "ok");
    const next = initial.data.page.nextCursor;
    assert.equal(next, cursor);
    assert.equal((await read(next)).kind, "empty");
    const status = isTasks ? "&status=Ready" : "";
    assert.deepEqual(queries, [`?limit=100${status}`, `?limit=100&cursor=${cursor}${status}`]);
  }
});

test("preserves typed HTTP errors with receipt times, including limits above 100", async () => {
  for (const [status, kind] of [[400, "bad-request"], [403, "access-denied"],
    [404, "not-found"], [500, "server-error"], [409, "http"]] as const) {
    const queries: string[] = [];
    const api = client(async (input) => {
      queries.push(new URL(String(input)).search);
      return Response.json({ error_code: "ERR_TEST" }, { status });
    });
    for (const result of [await api.listProjects({ limit: 101 }), await api.listSessionTasks(sessionId, { limit: 101 })]) {
      assert.equal(result.kind, "error");
      assert.deepEqual(result.error, { kind, status });
      assert.equal(result.receivedAt, receivedAt);
    }
    assert.deepEqual(queries, ["?limit=101", "?limit=101"]);
  }
});

test("does not send a stage query, even if extra options are supplied", async () => {
  const options = { limit: 25, stage: "STAGE_1_IDEA_DISCOVERY" };
  const result = await client(async (input) => {
    assert.equal(new URL(String(input)).search, "?limit=25");
    return Response.json(tasks);
  }).listSessionTasks(sessionId, options);
  assert.equal(result.kind, "ok");
});

test("invalid session IDs cannot resolve to another HTTP route", async () => {
  const api = client(async () => assert.fail("unexpected request"));
  const result = await api.listSessionTasks("..");
  assert.equal(result.kind, "error");
  assert.equal(result.error.kind, "data");
  assert.equal(result.receivedAt, null);
});

test("distinguishes network failure and timeout without inventing receipt timestamps", async () => {
  const network = await client(async () => { throw new TypeError("fetch failed"); }).getProject();
  assert.equal(network.kind, "error");
  assert.equal(network.receivedAt, null);
  assert.deepEqual(network.error, { kind: "network" });
  const timeout = await client(async (_input, init) => {
    await new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("did not abort")), 1000);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(init.signal?.reason);
      }, { once: true });
    });
    throw new Error("unreachable");
  }, 10).getProject();
  assert.equal(timeout.kind, "error");
  assert.equal(timeout.receivedAt, null);
  assert.deepEqual(timeout.error, { kind: "timeout" });
});

test("fails closed on invalid JSON, malformed fields, missing fields and scope mismatches", async () => {
  const { defaultBranch: _removed, ...missingBranch } = project;
  const sources = [
    new Response("{"),
    Response.json({ ...detail, project: missingBranch }),
    Response.json({ ...detail, fetchedAt: "invalid" }),
    Response.json({ ...detail, project: { ...project, projectId: sessionId } }),
  ];
  for (const source of sources) {
    const result = await client(async () => source).getProject();
    assert.equal(result.kind, "error");
    assert.equal(result.error.kind, "data");
    assert.equal(result.receivedAt, receivedAt);
  }
  assert.throws(() => mapSessionTasks(tasks, projectId, projectId), /sessionId/);
  assert.throws(() => mapSessionTasks({ ...tasks, items: [{ ...task, currentAttemptNo: "3" }] },
    projectId, sessionId), /currentAttemptNo/);
});

test("recoveryState passes through and only missing or unrecognized values become unknown", () => {
  for (const [recoveryState, recoveryReason] of [
    ["clear", "no-visible-pending-intent"], ["pending", "visible-pending-intent"],
    ["unknown", "journal-not-modeled"],
  ]) {
    const dto = { ...budget, recoveryState, recoveryReason };
    assert.deepEqual(mapBudgetSnapshot(dto, projectId), dto);
  }
  const { recoveryState: _removed, ...missing } = budget;
  assert.equal(mapBudgetSnapshot(missing, projectId).recoveryState, "unknown");
  assert.equal(mapBudgetSnapshot({ ...budget, recoveryState: "new-state" }, projectId).recoveryState, "unknown");
});

test("discards keys outside the DTO allowlists at each mapped level", () => {
  const extra = { unexpected: true };
  assert.deepEqual(mapProjectDetail({ ...detail, ...extra, project: { ...project, ...extra } }, projectId), detail);
  assert.deepEqual(mapBudgetSnapshot({
    ...budget, ...extra, policy: { ...budget.policy, ...extra },
    dimensions: { ...budget.dimensions, ...extra, tokens: { ...budget.dimensions.tokens, ...extra } },
  }, projectId), budget);
  assert.deepEqual(mapSessionTasks({
    ...tasks, ...extra, filters: { ...tasks.filters, ...extra },
    page: { ...tasks.page, ...extra }, items: [{ ...task, ...extra }],
  }, projectId, sessionId), tasks);
});

const sessionItem = { pipelineSessionId: sessionId, projectId, title: "Session", createdAt: fetchedAt, updatedAt: fetchedAt };
const sessionPage = {
  ...metadata, projectId, items: [sessionItem], page: { limit: 20, hasMore: false, nextCursor: null },
};

test("session reader uses only the scoped GET route and forwards paging options and opaque cursor", async () => {
  const cursor = "opaque+%&=/?.next";
  const first = { ...sessionPage, page: { limit: 1, hasMore: true, nextCursor: cursor } };
  const laterItem = { ...sessionItem, pipelineSessionId: "20000000-0000-0000-0000-000000000002", createdAt: "2026-11-23T23:59:59.999999Z" };
  const next = { ...sessionPage, items: [laterItem], page: { limit: 1, hasMore: false, nextCursor: null } };
  const queries: Record<string, string>[] = [];
  const api = client(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(url.pathname, `/api/v1/projects/${projectId}/sessions`);
    queries.push(Object.fromEntries(url.searchParams));
    return Response.json(queries.length === 1 ? sessionPage : url.searchParams.has("cursor") ? next : first);
  });
  const initial = await api.listSessions(projectId);
  assert.equal(initial.kind, "ok");
  assert.deepEqual(initial.data, sessionPage);
  assert.equal(initial.receivedAt, receivedAt);
  assert.equal(initial.data.fetchedAt, fetchedAt);
  const paged = await api.listSessions(projectId, { limit: 1 });
  assert.equal(paged.kind, "ok");
  assert.ok(paged.data.page.nextCursor);
  const result = await api.listSessions(projectId, { limit: 1, cursor: paged.data.page.nextCursor });
  assert.equal(result.kind, "ok");
  assert.deepEqual(result.data, next);
  assert.equal(result.receivedAt, receivedAt);
  assert.deepEqual(queries, [{}, { limit: "1" }, { limit: "1", cursor }]);

  const emptyPage = { ...sessionPage, items: [] };
  const empty = await client(async () => Response.json(emptyPage)).listSessions(projectId);
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.data, emptyPage);
  assert.equal(empty.receivedAt, receivedAt);
});

test("session reader rejects malformed project path segments before transport", async () => {
  let requests = 0;
  const api = client(async () => { requests++; return Response.json(sessionPage); });
  for (const id of ["..", "x/y", "x?stage=1", "%2f", ""]) {
    const result = await api.listSessions(id);
    assert.equal(result.kind, "error");
    assert.equal(result.error.kind, "data");
    assert.equal(result.receivedAt, null);
  }
  assert.equal(requests, 0);
});

test("session reader preserves typed HTTP errors and delegates the limit bound to the server", async () => {
  for (const [status, kind] of [[400, "bad-request"], [403, "access-denied"], [404, "not-found"], [409, "http"], [500, "server-error"]] as const) {
    const api = client(async (input) => {
      assert.equal(new URL(String(input)).search, "?limit=101");
      return Response.json({ error_code: "ERR_TEST" }, { status });
    });
    const result = await api.listSessions(projectId, { limit: 101 });
    assert.equal(result.kind, "error");
    assert.deepEqual(result.error, { kind, status });
    assert.equal(result.receivedAt, receivedAt);
    assert.equal("data" in result, false);
  }
});

test("session mapper enforces the exact item and envelope allowlists and project scope", () => {
  const result = mapSessions(sessionPage, projectId);
  assert.deepEqual(result, sessionPage);
  assert.deepEqual(Object.keys(result.items[0]!), ["pipelineSessionId", "projectId", "title", "createdAt", "updatedAt"]);
  const { title: _missing, ...missingTitle } = sessionItem;
  for (const malformed of [
    { ...sessionPage, totalCount: 1 },
    { ...sessionPage, items: [{ ...sessionItem, stage: "unexpected" }] },
    { ...sessionPage, items: [{ ...sessionItem, status: "unexpected" }] },
    { ...sessionPage, items: [missingTitle] },
    { ...sessionPage, items: [{ ...sessionItem, projectId: sessionId }] },
    { ...sessionPage, projectId: sessionId },
    { ...sessionPage, page: { ...sessionPage.page, nextCursor: 1 } },
    { ...sessionPage, page: { ...sessionPage.page, hasMore: true } },
  ]) {
    assert.throws(() => mapSessions(malformed, projectId), /Invalid dashboard response field/);
  }
});

test("session reader fails closed when a response is malformed or contains a bad row after a valid row", async () => {
  const invalidResponses = [
    new Response("{"),
    Response.json({ ...sessionPage, items: null }),
    Response.json({ ...sessionPage, items: [sessionItem, { ...sessionItem, updatedAt: null }] }),
  ];
  for (const response of invalidResponses) {
    const result = await client(async () => response).listSessions(projectId);
    assert.equal(result.kind, "error");
    assert.equal(result.error.kind, "data");
    assert.equal(result.receivedAt, receivedAt);
    assert.equal("data" in result, false);
  }
});
