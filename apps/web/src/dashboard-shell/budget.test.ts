import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CORE_API_AUTH_HEADER, CoreApiService, encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { WebApprovalConsoleHttpServer } from "../index.ts";

const projectId = "10000000-0000-0000-0000-000000000006";
const detailPath = `/projects/${projectId}`;
const budgetPath = `/api/v1${detailPath}/budget-snapshot`;
const firstStamp = "2026-11-24T10:00:00.123456Z";
const secondStamp = "2026-11-24T11:00:00.123456Z";
const recovery = {
  recoveryState: "pending",
  recoveryReason: "visible-pending-intent",
  recoveryScope: "visible-project-budget-denial-intents-at-snapshot",
  usageSemantics: "recorded-project-ledgers-and-resource-metrics",
};

function snapshot(fetchedAt: string, remaining: string) {
  return {
    schemaVersion: "dashboard-read-v1", projectId, fetchedAt, policy: { status: "ACTIVE", updatedAt: firstStamp },
    dimensions: {
      // Keep a deliberately distinct remaining value so a client recomputation fails the test.
      tokens: { unit: "tokens", limitKind: "configured", limit: "100", consumed: "1", remaining },
      costMicroUsd: { unit: "micro_usd", limitKind: "unbounded", limit: null, consumed: "35", remaining: null },
      wallTimeMs: { unit: "milliseconds", limitKind: "unbounded", limit: null, consumed: "74", remaining: null },
    },
    estimatedModelUsageIncluded: false, ...recovery,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function refreshControl(script: string, endpoint: string, initial: string, request: typeof fetch) {
  const attributes = new Map<string, string>();
  const body = { innerHTML: initial, setAttribute: (name: string, value: string) => attributes.set(name, value) };
  const panel = { dataset: { panelUrl: endpoint }, isConnected: true, querySelector: () => body };
  const button = { disabled: false, closest: () => panel };
  let handler!: (event: { target: { closest(): typeof button } }) => Promise<void>;
  runInNewContext(script, {
    document: { addEventListener(name: string, callback: typeof handler) {
      assert.equal(name, "click");
      handler = callback;
    } },
    fetch: request,
    AbortSignal,
  });
  return { body, panel, button, attributes, click: () => handler({ target: { closest: () => button } }) };
}

test("Budget renders P2 values and refreshes only its body through one GET per click", async () => {
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const auth = encodeCoreApiAuthHeader(core.issueAuthContext({
    projectId, principalId: "budget-auditor", roles: ["AUDITOR"],
  }));
  const calls: string[] = [];
  let status = 200;
  let data = snapshot(firstStamp, "-77");
  const initialBudget = deferred();
  let budgetGate: Promise<void> | undefined = initialBudget.promise;
  const api = createServer(async (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers[CORE_API_AUTH_HEADER], auth);
    const path = req.url!;
    calls.push(path);
    if (path === budgetPath) {
      await budgetGate;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? data : { reason: "Private backend error detail" }));
      return;
    }
    const envelope = { schemaVersion: "dashboard-read-v1", fetchedAt: firstStamp };
    res.writeHead(200, { "Content-Type": "application/json" });
    if (path === `/api/v1${detailPath}`) {
      res.end(JSON.stringify({ ...envelope, project: { projectId, slug: "project", name: "Existing project",
        defaultBranch: "main", createdAt: firstStamp, updatedAt: firstStamp } }));
    } else if (path === `/api/v1${detailPath}/sessions`) {
      res.end(JSON.stringify({ ...envelope, projectId, items: [], page: { limit: 20, hasMore: false, nextCursor: null } }));
    } else {
      assert.fail(`Unexpected Core endpoint: ${path}`);
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: `http://127.0.0.1:${address.port}` });
  const { baseUrl } = await web.start();
  const page = await fetch(baseUrl + detailPath, { headers: { [CORE_API_AUTH_HEADER]: auth } });
  let html = "";
  let sawIndependentLoading = false;
  try {
    for await (const chunk of page.body!) {
      html += Buffer.from(chunk).toString("utf8");
      if (!sawIndependentLoading && html.includes('id="project-result" data-state="ready"')
        && html.includes('id="sessions-result" data-state="empty"') && !html.includes('id="budget-panel"')) {
        sawIndependentLoading = true;
        initialBudget.resolve();
      }
    }
    assert.equal(sawIndependentLoading, true);
    budgetGate = undefined;
    assert.match(html, /id="budget-loading"[\s\S]*?data-state="loading"/);
    const fragment = html.match(/<section id="budget-panel" data-panel-url="([^"]+)"[\s\S]*?<div data-panel-body role="status">([\s\S]*?)<\/section>/);
    assert.ok(fragment?.[1] && fragment[2]);
    const [endpoint, initial] = [fragment[1], fragment[2]];
    assert.match(fragment[0], /<button type="button" data-panel-refresh>Làm mới<\/button>/);
    assert.match(initial, /data-state="ready"/);
    assert.match(initial, /<dt>Tải lúc<\/dt><dd>[^<]+/);
    assert.ok(initial.includes(firstStamp));
    assert.match(initial, /<dt>Còn lại<\/dt><dd>-77<\/dd>/);
    assert.match(initial, /<dt>Giới hạn<\/dt><dd>Không có dữ liệu<\/dd>/);
    assert.doesNotMatch(initial, /%|dự báo|<progress|<dd>99<\/dd>|<dd>0<\/dd>/i);
    assert.doesNotMatch(html, new RegExp(auth));
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.deepEqual(calls.slice().sort(), [`/api/v1${detailPath}`, `/api/v1${detailPath}/sessions`, budgetPath].sort());
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const sent: string[] = [];
    const control = refreshControl(script, endpoint, initial, async (input, options) => {
      sent.push(String(input));
      assert.equal(options?.method, "GET");
      const response = await fetch(baseUrl + String(input), { ...options, headers: { [CORE_API_AUTH_HEADER]: auth } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response;
    });
    const gate = deferred();
    budgetGate = gate.promise;
    data = snapshot(secondStamp, "-88");
    const outcome = control.click();
    assert.equal(control.button.disabled, true);
    assert.equal(control.attributes.get("aria-busy"), "true");
    assert.match(control.body.innerHTML, /data-state="loading"/);
    assert.doesNotMatch(control.body.innerHTML, /Tải lúc|-77/);
    await control.click();
    gate.resolve();
    await outcome;
    budgetGate = undefined;
    assert.equal(control.button.disabled, false);
    assert.match(control.body.innerHTML, /data-state="ready"/);
    assert.match(control.body.innerHTML, /<dt>Tải lúc<\/dt><dd>[^<]+/);
    assert.ok(control.body.innerHTML.includes(secondStamp));
    assert.match(control.body.innerHTML, /<dt>Còn lại<\/dt><dd>-88<\/dd>/);
    assert.doesNotMatch(control.body.innerHTML, /-77/);
    assert.deepEqual(sent, [endpoint]);
    assert.deepEqual(calls.slice(3), [budgetPath]);

    for (const [httpStatus, state] of [[500, "error"], [403, "access-denied"], [404, "empty"]] as const) {
      status = httpStatus;
      await control.click();
      assert.ok(control.body.innerHTML.includes(`data-state="${state}"`));
      assert.doesNotMatch(control.body.innerHTML, /Tải lúc|-88|Private backend error detail/);
      if (state === "empty") assert.match(control.body.innerHTML, /Không có dữ liệu/);
    }
    assert.deepEqual(calls.slice(3), Array.from({ length: 4 }, () => budgetPath));
    assert.deepEqual(sent, Array.from({ length: 4 }, () => endpoint));
    const unauthorized = await fetch(baseUrl + endpoint);
    assert.match(await unauthorized.text(), /data-state="access-denied"/);
    assert.equal(calls.length, 7);
  } finally {
    initialBudget.resolve();
    await web.stop();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
});

test("panel refresh drops a response after the resource changes and handles transport failures", async () => {
  const { panelRefreshScript } = await import("./panel-refresh.ts");
  let release!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => { release = resolve; });
  const control = refreshControl(panelRefreshScript, "/panel/a", "Old data", () => waiting);
  const done = control.click();
  control.panel.dataset.panelUrl = "/panel/b";
  control.body.innerHTML = "New context";
  release(new Response("Response for A", { headers: { "X-Dashboard-Panel": "1" } }));
  await done;
  assert.equal(control.body.innerHTML, "New context");

  const failed = refreshControl(panelRefreshScript, "/panel/a", "Old data", async () => { throw new Error("Private reason"); });
  await failed.click();
  assert.match(failed.body.innerHTML, /data-state="error"/);
  assert.doesNotMatch(failed.body.innerHTML, /Old data|Private reason/);
  assert.equal(failed.button.disabled, false);
});
