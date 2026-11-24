import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CORE_API_AUTH_HEADER, CoreApiService, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { WebApprovalConsoleHttpServer } from "../index.ts";
import { panelRefreshScript } from "./panel-refresh.ts";
import { taskDetailScript } from "./task-detail.ts";
import { retireTasksOnSessionChange } from "./tasks.ts";

const projectId = "10000000-0000-0000-0000-000000000007";
const sessionA = "20000000-0000-0000-0000-000000000007";
const sessionB = "20000000-0000-0000-0000-000000000008";
const taskId = "30000000-0000-0000-0000-000000000007";
const stamp = "2026-11-24T10:00:00.123456Z";
const detailPath = `/projects/${projectId}`;
const corePath = `/api/v1${detailPath}`;
const taskPath = (sessionId: string) => `${corePath}/sessions/${sessionId}/tasks`;
const envelope = { schemaVersion: "dashboard-read-v1", fetchedAt: stamp, projectId };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function getTasksPanel(html: string) {
  const panel = html.match(/<section id="tasks-panel" data-panel-url="([^"]+)"[\s\S]*?<div data-panel-body role="status">([\s\S]*?)<\/section>/);
  assert.ok(panel?.[1] && panel[2]);
  return { endpoint: panel[1], body: panel[2] };
}

function dashboardScripts(html: string): string[] {
  const allowed = new Set([panelRefreshScript, retireTasksOnSessionChange, taskDetailScript]);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  for (const [, attributes, script] of scripts) {
    assert.equal(attributes?.trim(), "", "Dashboard scripts must be inline");
    assert.ok(script && allowed.delete(script), "Unexpected Dashboard script");
    assert.doesNotMatch(script, /["'](?:POST|PUT|PATCH|DELETE)["']/i, "Dashboard scripts must be read-only");
  }
  assert.equal(allowed.size, 0, "Expected refresh and selection handlers");
  for (const [form] of html.matchAll(/<form\b[^>]*>/gi)) {
    assert.match(form, /\bmethod="get"/i, "Dashboard forms must be read-only");
  }
  return scripts.map((match) => match[2]!);
}

test("Tasks requires explicit selection, keeps loading and failures local, and ignores a late refresh after a session change", async () => {
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const auth = encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId: "task-auditor", roles: ["AUDITOR"] }));
  const headers = { [CORE_API_AUTH_HEADER]: auth };
  const calls: string[] = [];
  let heldA: ReturnType<typeof deferred> | undefined;
  let startedA: ReturnType<typeof deferred> | undefined;
  let taskStatus = 200;
  let empty = false;
  let revision = 1;
  const fixtureApi = createServer(async (req, res) => {
    calls.push(req.url!);
    if (req.method !== "GET" || req.headers[CORE_API_AUTH_HEADER] !== auth) {
      res.writeHead(403).end();
      return;
    }
    let data: unknown;
    switch (req.url) {
      case corePath:
        data = { ...envelope, project: { projectId, slug: "project", name: "Existing project",
          defaultBranch: "main", createdAt: stamp, updatedAt: stamp } };
        break;
      case `${corePath}/sessions`:
        data = { ...envelope, items: [sessionB, sessionA].map((id) => ({
          pipelineSessionId: id, projectId, title: `Session ${id === sessionA ? "A" : "B"}`, createdAt: stamp, updatedAt: stamp,
        })), page: { limit: 20, hasMore: false, nextCursor: null } };
        break;
      case `${corePath}/budget-snapshot`:
        res.writeHead(404).end();
        return;
      case taskPath(sessionA):
      case taskPath(sessionB): {
        const id = req.url === taskPath(sessionA) ? sessionA : sessionB;
        if (id === sessionA) {
          startedA?.resolve();
          await heldA?.promise;
        }
        const state = { unit: "session", status: "private task failure" };
        if (taskStatus !== 200) {
          res.writeHead(taskStatus, { "Content-Type": "application/json" }).end(JSON.stringify(state));
          return;
        }
        data = { ...envelope, sessionId: id, filters: { sourceStatuses: [], stage: null },
          items: empty ? [] : [{ taskId, projectId, sessionId: id, title: `Task ${id === sessionA ? "A" : "B"} <r${revision}>`,
            sourceStatus: "source-unknown", currentAttemptNo: 3, reworkCount: 2, maxReworkCycles: 4,
            activeLeaseEpoch: "9007199254740995", assigneeId: null, leaseOwnerId: "fixture-worker",
            leaseExpiresAt: stamp, createdAt: stamp, updatedAt: stamp }],
          page: { limit: 25, hasMore: false, nextCursor: null } };
        break;
      }
      default:
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  });
  fixtureApi.listen(0, "127.0.0.1");
  await once(fixtureApi, "listening");
  const apiAddress = fixtureApi.address();
  assert.ok(apiAddress && typeof apiAddress !== "string");
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: `http://127.0.0.1:${apiAddress.port}` });
  const { baseUrl } = await web.start();
  const navigate = (query = "") => fetch(baseUrl + detailPath + query, { headers, signal: AbortSignal.timeout(10000) });
  const taskCalls = () => calls.filter((url) => url.endsWith("/tasks"));
  try {
    for (const query of ["", "?sessionId=", "?sessionId=20000000-0000-0000-0000-000000000009"]) {
      const html = await (await navigate(query)).text();
      assert.match(html, /id="tasks-empty"[\s\S]*?data-state="empty">Chưa chọn session/);
      assert.match(html, /Hãy chọn một session ở <a href="#sessions-result">Session context/);
      assert.doesNotMatch(html, /data-panel-url="[^"]+dashboard-tasks/);
    }
    assert.deepEqual(taskCalls(), []);

    heldA = deferred();
    const pageA = await navigate(`?sessionId=${sessionA}`);
    const decoder = new TextDecoder();
    let htmlA = "";
    let sawIndependentLoading = false;
    for await (const chunk of pageA.body!) {
      htmlA += decoder.decode(chunk, { stream: true });
      if (!sawIndependentLoading && htmlA.includes('id="tasks-loading"')
        && htmlA.includes('id="project-result" data-state="ready"')
        && htmlA.includes('id="sessions-result" data-state="ready"')
        && htmlA.includes('id="budget-panel"') && !htmlA.includes('id="tasks-panel"')) {
        sawIndependentLoading = true;
        heldA.resolve();
      }
    }
    assert.equal(sawIndependentLoading, true);
    assert.match(htmlA, /id="tasks-loading"[\s\S]*?data-state="loading"/);
    const initial = getTasksPanel(htmlA);
    assert.match(initial.body, /data-state="ready"/);
    assert.match(initial.body, /Task A &lt;r1&gt;/);
    assert.doesNotMatch(initial.body, /Task B|<r1>|\bstage\b/i);
    for (const value of [taskId, projectId, sessionA, "source-unknown", "9007199254740995", "fixture-worker", stamp, "Không có dữ liệu"]) {
      assert.ok(initial.body.includes(value), value);
    }
    for (const [label, value] of [["Lượt thực hiện", 3], ["Số lần làm lại", 2], ["Giới hạn làm lại", 4]]) {
      assert.ok(initial.body.includes(`<dt>${label}</dt><dd>${value}</dd>`));
    }
    assert.deepEqual(taskCalls(), [taskPath(sessionA)]);

    type Handler = (event: { target: unknown }) => Promise<void> | void;
    const handlers = new Map<string, Handler>();
    const content = { innerHTML: initial.body, setAttribute() {} };
    const panel = { dataset: { panelUrl: initial.endpoint }, isConnected: true,
      querySelector: () => content, remove() { this.isConnected = false; } };
    const button = { disabled: false, closest: () => panel };
    const formParent = { dataset: {} as Record<string, string>, querySelector: () => panel };
    const form = {
      matches: (selector: string) => selector === "[data-session-context]",
      elements: { sessionId: { value: sessionB } },
      dataset: { sessionContext: sessionA },
      closest: () => formParent,
    };
    assert.throws(() => dashboardScripts(htmlA + "<script>unexpected()</script>"), /Unexpected Dashboard script/);
    assert.throws(() => dashboardScripts(htmlA + '<form method="post"></form>'), /forms must be read-only/);
    const scripts = dashboardScripts(htmlA);
    runInNewContext(scripts.join("\n"), {
      document: { addEventListener: (name: string, handler: Handler) => handlers.set(name, handler) },
      fetch: (path: string, options: RequestInit) => fetch(baseUrl + path, { ...options, headers }),
      AbortSignal,
    });
    const click = async () => handlers.get("click")!({ target: { closest: () => button } });

    taskStatus = 500;
    const beforeError = calls.length;
    await click();
    assert.match(content.innerHTML, /data-state="error"/);
    assert.doesNotMatch(content.innerHTML, /private task failure|Task A/);
    assert.deepEqual(calls.slice(beforeError), [taskPath(sessionA)]);

    taskStatus = 403;
    const beforeDenied = calls.length;
    await click();
    assert.match(content.innerHTML, /data-state="access-denied"/);
    assert.doesNotMatch(content.innerHTML, /private task failure|data-state="error"/);
    assert.deepEqual(calls.slice(beforeDenied), [taskPath(sessionA)]);

    taskStatus = 200;
    empty = true;
    await click();
    assert.match(content.innerHTML, /data-state="empty">Session này chưa có task/);
    empty = false;

    revision = 2;
    await click();
    assert.match(content.innerHTML, /Task A &lt;r2&gt;/);

    heldA = deferred();
    startedA = deferred();
    const beforeRefresh = calls.length;
    const oldRefresh = click();
    await startedA.promise;
    assert.match(content.innerHTML, /data-state="loading"/);
    assert.deepEqual(calls.slice(beforeRefresh), [taskPath(sessionA)]);
    await click();
    assert.deepEqual(calls.slice(beforeRefresh), [taskPath(sessionA)]);

    await handlers.get("submit")!({ target: form });
    assert.equal(panel.isConnected, false);
    assert.equal(formParent.dataset.sessionChanging, "");
    const htmlB = await (await navigate(`?sessionId=${sessionB}`)).text();
    const newPanel = getTasksPanel(htmlB);
    assert.match(newPanel.body, /Task B &lt;r2&gt;/);
    assert.doesNotMatch(newPanel.body, /Task A/);
    assert.match(htmlB, /id="project-result" data-state="ready"/);
    assert.match(htmlB, /id="pipeline-progress" data-state="unsupported"/);
    assert.match(htmlB, /id="budget-panel"/);
    heldA.resolve();
    await oldRefresh;
    assert.doesNotMatch(content.innerHTML, /Task A/);
    assert.deepEqual(calls.slice(beforeRefresh).sort(), [
      taskPath(sessionA), corePath, `${corePath}/sessions`, `${corePath}/budget-snapshot`,
      `${corePath}/agent-profiles`, taskPath(sessionB), `${corePath}/pipeline-sessions/${sessionB}/cost-session-snapshot`,
      `${corePath}/pipeline-sessions/${sessionB}`, `${corePath}/pipeline-sessions/${sessionB}/change-requests`,
    ].sort());
  } finally {
    heldA?.resolve();
    await web.stop();
    await new Promise<void>((resolve, reject) => fixtureApi.close((error) => error ? reject(error) : resolve()));
  }
});
