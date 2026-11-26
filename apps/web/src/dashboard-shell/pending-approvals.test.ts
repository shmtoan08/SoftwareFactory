import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CORE_API_AUTH_HEADER, CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator,
  encodeCoreApiAuthHeader } from "@software-factory/core-api";
import { buildPostgresPoolConfigFromEnv, PostgresControlPlaneRepository, PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import { DashboardClient } from "../dashboard-data/client.ts";
import { pendingApprovalKey } from "../dashboard-data/mapping.ts";
import { WebApprovalConsoleHttpServer } from "../index.ts";
import { pendingApprovalsPageContentType, pendingApprovalsPaginationScript } from "./pending-approvals.ts";

const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const path = `/projects/${projectId}`;
const fragment = `${path}/dashboard-pending-approvals`;
const upstream = `/api/v1${path}/pending-approvals`;
const stamp = "2026-11-26T10:00:00.123456Z";

function panel(html: string) {
  const section = html.match(/<section id="pending-approvals-panel"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section);
  return section;
}

function rows(html: string) {
  return [...html.matchAll(/<li data-pending-key="([^"]+)"/g)].map(([, pendingKey]) => ({ tagName: "LI", dataset: { pendingKey } }));
}

function mount(html: string, transport: (url: string, init: RequestInit) => Promise<Response>) {
  const markup = panel(html);
  assert.ok(html.includes(pendingApprovalsPaginationScript));
  const cursor = markup.match(/data-pending-cursor="([^"]+)"/)?.[1];
  assert.ok(cursor);
  const list = {
    children: rows(markup),
    append(content: { children: ReturnType<typeof rows> }) { this.children.push(...content.children); },
  };
  const status = { textContent: "" };
  const snapshot = { querySelector: (selector: string) => selector === "ul" ? list : status };
  const section = { dataset: { panelUrl: fragment, panelBusy: "" } };
  const button = {
    dataset: { pendingCursor: cursor as string | undefined }, hidden: false, disabled: false, isConnected: true,
    textContent: "Load more", closest: (selector: string) => selector === "#pending-approvals-panel" ? section : snapshot,
  };
  let click!: (event: unknown) => Promise<void>;
  runInNewContext(pendingApprovalsPaginationScript, {
    document: {
      addEventListener: (_name: string, handler: typeof click) => { click = handler; },
      createElement: () => ({
        content: { children: [] as ReturnType<typeof rows> },
        set innerHTML(html: string) { this.content.children = rows(html); },
      }),
    },
    URLSearchParams, AbortSignal, fetch: transport,
  });
  return { button, status, keys: () => list.children.map((row) => row.dataset.pendingKey),
    click: () => click({ target: { closest: () => button } }) };
}

const dto = (number: number) => number % 2 === 0 ? {
  kind: "CHANGE_REQUEST", cr_id: id(number), pipeline_session_id: id(70), baseline_id: id(71),
  cr_key: `CR-${number}`, title: `Request ${number}`, hash: "a".repeat(64), status: "PENDING_APPROVAL", created_at: stamp,
} : {
  kind: "MERGE_APPROVAL", approval_request_id: id(number), task_id: id(72), merge_candidate_id: id(73),
  status: "PENDING", created_at: stamp, expires_at: "2026-11-26T11:00:00.123456Z",
};
const fixturePage = (start: number, count: number, nextCursor: string | null) => ({
  schemaVersion: "pending-approvals-v1", fetchedAt: stamp, scope: { kind: "project-token", projectId },
  items: Array.from({ length: count }, (_, i) => dto(start + i)),
  page: { limit: 20, hasMore: nextCursor !== null, nextCursor },
});
const casePage = (body: object, status = 200) => ({ status, body });

test("Pending approvals page fragment and browser handler enforce error, retry, and atomic append rules", async (t) => {
  const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
  const token = encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId: "fixture", roles: ["AUDITOR"] }));
  const auth = { [CORE_API_AUTH_HEADER]: token };
  const calls: string[] = [];
  let response = casePage(fixturePage(20, 20, "first"));
  const upstreamServer = createServer((req, res) => {
    if (!req.url?.startsWith(upstream)) { res.writeHead(404).end(); return; }
    assert.equal(req.method, "GET");
    assert.equal(req.headers[CORE_API_AUTH_HEADER], token);
    calls.push(req.url);
    res.writeHead(response.status).end(JSON.stringify(response.body));
  });
  upstreamServer.listen(0, "127.0.0.1");
  await once(upstreamServer, "listening");
  const address = upstreamServer.address();
  assert.ok(address && typeof address !== "string");
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: `http://127.0.0.1:${address.port}` });
  const { baseUrl } = await web.start();
  t.after(async () => { await web.stop(); await new Promise<void>((resolve) => upstreamServer.close(() => resolve())); });
  const initial = await fetch(baseUrl + path, { headers: auth }).then((res) => res.text());
  const fetchPage = (url: string, init: RequestInit) => {
    assert.equal(init.method, "GET");
    assert.deepEqual([...new URL(url, baseUrl).searchParams.keys()], ["cursor"]);
    assert.equal(new Headers(init.headers).get("Accept"), pendingApprovalsPageContentType);
    return fetch(baseUrl + url, { ...init, headers: { ...init.headers, ...auth } });
  };

  for (const query of ["", "?cursor=", "?cursor=a&cursor=b", "?cursor=a&limit=20", "?cursor=a&unknown=1"]) {
    const invalid = await fetch(baseUrl + fragment + "/page" + query, { headers: auth });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { problem: "request" });
  }
  assert.deepEqual(calls, [upstream + "?limit=20"]);

  const initialKeys = rows(panel(initial)).map((row) => row.dataset.pendingKey);
  for (const [code, message] of [
    [401, "Bạn không có quyền truy cập dữ liệu này."],
    [403, "Bạn không có quyền truy cập dữ liệu này."],
    [400, "Yêu cầu không hợp lệ."],
    [409, "Pending approvals đã thay đổi, tải lại từ đầu"],
  ] as const) {
    response = casePage({ reason: "private" }, code);
    const ui = mount(initial, fetchPage);
    const callsBefore = calls.length;
    await ui.click();
    assert.equal(ui.status.textContent, message);
    assert.equal(ui.button.dataset.pendingCursor, undefined);
    assert.equal(ui.button.hidden, true);
    assert.deepEqual(ui.keys(), initialKeys);
    await ui.click();
    assert.deepEqual(calls.slice(callsBefore), [upstream + "?limit=20&cursor=first"]);
  }

  for (const [name, body] of [
    ["duplicate", fixturePage(39, 2, null)],
    ["invalid DTO", { ...fixturePage(40, 1, null), items: [{ ...dto(40), rationale: "never render" }] }],
    ["cursor loop", fixturePage(40, 20, "first")],
  ] as const) {
    response = casePage(body);
    const ui = mount(initial, fetchPage);
    await ui.click();
    assert.equal(ui.status.textContent, "Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ.", name);
    assert.equal(ui.button.hidden, true);
    assert.deepEqual(ui.keys(), initialKeys);
  }

  const wrongType = mount(initial, async () => Response.json({ rows: "", nextCursor: null }));
  await wrongType.click();
  assert.equal(wrongType.status.textContent, "Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ.");
  assert.deepEqual(wrongType.keys(), initialKeys);

  let resolvePage!: (response: Response) => void;
  const afterRefresh = mount(initial, () => new Promise((resolve) => { resolvePage = resolve; }));
  const inFlight = afterRefresh.click();
  afterRefresh.button.isConnected = false;
  resolvePage(new Response(JSON.stringify({ rows: '<li data-pending-key="new-row"></li>', nextCursor: null }), {
    headers: { "Content-Type": pendingApprovalsPageContentType },
  }));
  await inFlight;
  assert.deepEqual(afterRefresh.keys(), initialKeys);

  response = casePage({ reason: "private", rows: "<li>partial</li>" }, 500);
  let failNetwork = true;
  const ui = mount(initial, (url, init) => {
    if (failNetwork) return Promise.reject(new TypeError("offline"));
    return fetchPage(url, init);
  });
  for (const failure of ["network", "HTTP 500"]) {
    await ui.click();
    assert.equal(ui.status.textContent, "Không tải được dữ liệu.", failure);
    assert.equal(ui.button.textContent, "Retry");
    assert.equal(ui.button.dataset.pendingCursor, "first");
    assert.deepEqual(ui.keys(), initialKeys);
    failNetwork = false;
  }
  response = casePage(fixturePage(40, 2, null));
  const start = calls.length;
  const click = ui.click();
  assert.equal(ui.button.disabled, true);
  await ui.click();
  await click;
  assert.deepEqual(calls.slice(start), [upstream + "?limit=20&cursor=first"]);
  assert.deepEqual(ui.keys(), [...initialKeys, `CHANGE_REQUEST:${id(40)}`, `MERGE_APPROVAL:${id(41)}`]);
  assert.equal(ui.button.hidden, true);
});

const pg = process.env.PENDING_APPROVALS_FIXTURE_CONTAINER ? buildPostgresPoolConfigFromEnv() : null;

test("Real PostgreSQL pending feed walks signed cursors, reloads, and keeps project denials indistinguishable", { skip: !pg }, async (t) => {
  const pool = new PostgresRuntimePool(pg!);
  const authenticator = new CoreApiTokenAuthenticator();
  const store = new PostgresControlPlaneRepository(pool);
  const core = new CoreApiService(store, { authenticator });
  const api = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl: coreUrl } = await api.start();
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: coreUrl });
  const { baseUrl } = await web.start();
  t.after(async () => { await web.stop(); await api.stop(); await pool.close(); });
  const token = (project: string, principalId: string) =>
    encodeCoreApiAuthHeader(core.issueAuthContext({ projectId: project, principalId, roles: ["AUDITOR"] }));
  const auth = token(projectId, "fixture");
  const read = (url: string, init: RequestInit = {}, authToken = auth) => fetch(baseUrl + url, {
    ...init, headers: { ...init.headers, [CORE_API_AUTH_HEADER]: authToken },
  });
  const initial = await read(path).then((res) => res.text());
  const expected = new DashboardClient({ baseUrl: coreUrl, projectId, timeoutMs: 7000, authToken: auth });
  const reference: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await expected.listPendingApprovals({ cursor });
    assert.equal(result.kind, "ok");
    reference.push(...result.data.items.map(pendingApprovalKey));
    cursor = result.data.page.nextCursor ?? undefined;
  } while (cursor && reference.length < 3800);
  assert.equal(cursor, undefined);
  assert.equal(reference.length, 3800);
  assert.equal(new Set(reference).size, 3800);

  const sent = new Set<string>();
  const ui = mount(initial, (url, init) => {
    const query = new URL(url, baseUrl).searchParams;
    assert.deepEqual([...query.keys()], ["cursor"]);
    const opaque = query.get("cursor")!;
    assert.equal(opaque, ui.button.dataset.pendingCursor);
    assert.ok(!sent.has(opaque));
    sent.add(opaque);
    return read(url, init);
  });
  await Promise.all([ui.click(), ui.click()]);
  assert.equal(sent.size, 1);
  for (let i = 1; i < 190 && !ui.button.hidden; i++) await ui.click();
  assert.equal(sent.size, 189);
  assert.equal(ui.button.hidden, true);
  assert.deepEqual(ui.keys(), reference);
  const refreshed = await read(fragment).then((res) => res.text());
  assert.equal(rows(refreshed).length, 20);
  assert.match(refreshed, /data-pending-cursor=/);

  const otherScope = mount(initial, (url, init) =>
    read(url.replace(path, `/projects/${id(2)}`), init, token(id(2), "fixture")));
  await otherScope.click();
  assert.match(otherScope.status.textContent, /Pending approvals đã thay đổi, tải lại từ đầu/);
  assert.equal(otherScope.button.hidden, true);
  assert.deepEqual(otherScope.keys(), reference.slice(0, 20));

  const denial = async (project: string, auth: string) => {
    const html = await read(`/projects/${project}`, {}, auth).then((res) => res.text());
    return panel(html).match(/<div data-panel-body role="status">([\s\S]*?)<\/div>/)?.[1];
  };
  const noMembership = await denial(projectId, token(projectId, "unlisted"));
  assert.equal(noMembership, await denial(id(99), token(id(99), "fixture")));
  assert.match(noMembership!, /Bạn không có quyền truy cập dữ liệu này\./);

  // Exercise the real HTTP envelope and web mapper with an empty projection and a corrupt projection.
  const projection = t.mock.method(store, "readPendingApprovalsProjection", async () => ({ fetchedAt: stamp, items: [] }));
  assert.match(await read(fragment).then((res) => res.text()), /No pending change requests or merge approvals as of/);
  const invalidItem = { kind: "MERGE_APPROVAL" as const, approval_request_id: id(4), task_id: id(5),
    merge_candidate_id: id(6), status: "PENDING" as const, created_at: "2024-01-01T00:00:00.123456Z",
    expires_at: "2026-11-27T11:00:00.123456Z", rationale: "private detail" };
  projection.mock.mockImplementation(async () => ({ fetchedAt: stamp, items: [invalidItem] }));
  const corrupt = mount(initial, read);
  await corrupt.click();
  assert.equal(corrupt.status.textContent, "Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ.");
  assert.deepEqual(corrupt.keys(), reference.slice(0, 20));
});
