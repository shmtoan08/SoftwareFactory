import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  CORE_API_AUTH_HEADER, CoreApiHttpServer, CoreApiService, CoreApiTokenAuthenticator, encodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import {
  buildPostgresPoolConfigFromEnv, PostgresControlPlaneRepository, PostgresRuntimePool, SoftwareFactoryControlPlaneStore,
  type TimelineItem,
} from "@software-factory/database";
import { TimelineReadCursorCodec } from "../../../core-api/src/timeline-read-projection.ts";
import { WebApprovalConsoleHttpServer } from "../index.ts";
import { timelinePageContentType, timelinePaginationScript } from "./timeline.ts";

const id = (part: number, scope: number) => `${part}0000000-0000-0000-0000-${String(scope).padStart(12, "0")}`;
const project = id(1, 2);
const session = id(2, 2);
const principal = "fixture";
const projectPath = `/projects/${project}`;
const corePath = `/api/v1${projectPath}/pipeline-sessions/${session}/timeline`;
const stamp = "2026-11-26T00:00:00.123456Z";

function timelineSection(html: string) {
  const section = html.match(/<section id="timeline-panel"[\s\S]*?<\/section>/)?.[0];
  assert.ok(section?.includes("Partial activity feed"));
  return section!;
}

async function withStack(core: CoreApiService, run: (webUrl: string, apiUrl: string) => Promise<void>) {
  const api = new CoreApiHttpServer({ coreApi: core });
  const { baseUrl: apiUrl } = await api.start();
  const web = new WebApprovalConsoleHttpServer({ coreApi: core, dashboardCoreApiBaseUrl: apiUrl });
  try {
    const { baseUrl } = await web.start();
    await run(baseUrl, apiUrl);
  } finally {
    await web.stop();
    await api.stop();
  }
}

function loadMore(html: string, request: (path: string, init: RequestInit) => Promise<Response>) {
  const panel = timelineSection(html);
  assert.ok(html.includes(timelinePaginationScript));
  const cursor = panel.match(/data-timeline-cursor="([^"]+)"/)?.[1];
  const selected = panel.match(/data-timeline-session="([^"]+)"/)?.[1];
  assert.ok(cursor && selected);
  const status = { textContent: "" };
  let rows = panel.match(/<ul[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
  const list = { insertAdjacentHTML: (_position: string, page: string) => { rows += page; }, replaceChildren: () => { rows = ""; } };
  const content = { dataset: { timelineSession: selected }, querySelector: (selector: string) => selector === "ul" ? list : status };
  const button = {
    dataset: { timelineCursor: cursor as string | undefined }, disabled: false, hidden: false, isConnected: true,
    closest: (selector: string) => selector === "[data-timeline-session]" ? content : null,
  };
  let click!: (event: unknown) => Promise<void>;
  runInNewContext(timelinePaginationScript, {
    document: { addEventListener: (name: string, callback: typeof click) => { assert.equal(name, "click"); click = callback; } },
    location: { pathname: projectPath }, URLSearchParams, fetch: request,
  });
  return { button, status, rows: () => rows, click: () => click({ target: { closest: () => button } }) };
}

test("Timeline UI maps the actual Core API error table and rejects a cap failure without appending data", async (t) => {
  const store = new SoftwareFactoryControlPlaneStore();
  const authenticator = new CoreApiTokenAuthenticator();
  const core = new CoreApiService(store, { authenticator });
  await store.withRlsTransaction({ currentRole: "system_admin_role", currentProjectId: project }, async () => {
    await store.createProject({ project_id: project, slug: "timeline-ui", name: "Fixture",
      repo_bare_path: "/fixture", initial_main_commit_hash: "a".repeat(40) });
    await store.addProjectMembership({ project_id: project, principal_id: principal, member_role: "AUDITOR" });
  });
  await store.withRlsTransaction({ currentRole: "core_api_service", currentProjectId: project }, async () => {
    await store.createProductPipelineSession({ pipeline_session_id: session, project_id: project, title: "Fixture",
      raw_idea_text: "excluded", created_by_principal_id: principal });
  });
  const auth = core.issueAuthContext({ projectId: project, principalId: principal, roles: ["AUDITOR"] });
  const headers = { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(auth) };
  const mac = (data: string) => authenticator.signTimelineReadCursor(data);
  const context = { projectId: project, pipelineSessionId: session, principalId: principal, limit: 20 };
  const expired = new TimelineReadCursorCodec(mac, () => Date.now() - 900_001).encode(context, {
    recordedAt: stamp, rank: 1, resourceId: session,
  });
  const readProjection = store.readTimelineProjection.bind(store);
  const missing = id(2, 99);
  const missingCursor = new TimelineReadCursorCodec(mac).encode({ ...context, pipelineSessionId: missing }, {
    recordedAt: stamp, rank: 1, resourceId: missing,
  });
  await withStack(core, async (webUrl) => {
    const detail = () => fetch(webUrl + projectPath + `?sessionId=${session}`, { headers }).then((res) => res.text());
    const read = (cursor: string, sessionId = session, token: string | null = headers[CORE_API_AUTH_HEADER]) =>
      fetch(webUrl + projectPath + "?" + new URLSearchParams({ sessionId, cursor }), {
        headers: { Accept: timelinePageContentType, ...(token ? { [CORE_API_AUTH_HEADER]: token } : {}) },
      });
    const forbidden = encodeCoreApiAuthHeader({ ...auth, signatureHex: "0".repeat(64) });
    const cases = [
      [401, () => read("bad", session, null), "Bạn không có quyền truy cập Timeline."],
      [403, () => read("bad", session, forbidden), "Bạn không có quyền truy cập Timeline."],
      [400, () => read("bad"), "Không tải được Timeline."],
      [404, () => read(missingCursor, missing), "Không tìm thấy session trong phạm vi project."],
      [409, () => read(expired), "Timeline đã thay đổi, tải lại từ đầu"],
    ] as const;
    const items: TimelineItem[] = Array.from({ length: 21 }, (_, i) => ({
      type: "change-request.submitted", recordedAt: stamp, resourceId: id(9, 21 - i), details: {},
    }));
    const projection = t.mock.method(store, "readTimelineProjection", async (...args: Parameters<typeof readProjection>) =>
      args[0].pipelineSessionId === missing || args[0].cursorContextMismatch ? readProjection(...args) : { fetchedAt: stamp, items });
    const html = await detail();
    for (const [status, request, message] of cases) {
      let requests = 0;
      const response = await request();
      assert.equal(response.status, status);
      assert.deepEqual(await response.clone().json(), { message });
      const ui = loadMore(html, async () => { requests++; return response; });
      const original = ui.rows();
      await ui.click();
      assert.equal(ui.status.textContent, message);
      assert.equal(requests, 1);
      if (status === 409) {
        assert.equal(ui.button.dataset.timelineCursor, undefined);
        assert.equal(ui.button.hidden, true);
        assert.equal(ui.rows(), original);
        await ui.click();
        assert.equal(requests, 1);
      }
    }
    projection.mock.mockImplementation(async () => ({
      fetchedAt: stamp, items: [{
        type: "artifact.recorded", recordedAt: stamp, resourceId: id(9, 1),
        details: { artifactSha256: "never-render-this".repeat(100_000) },
      }],
    }));
    let capResponse: Response | undefined;
    const ui = loadMore(html, async (path, init) => {
      const response = await fetch(webUrl + path, { ...init, headers: { ...init.headers, ...headers } });
      capResponse = response.clone();
      return response;
    });
    const original = ui.rows();
    await ui.click();
    assert.equal(capResponse?.status, 500);
    assert.deepEqual(await capResponse.json(), { message: "Không tải được Timeline." });
    assert.equal(ui.status.textContent, "Không tải được Timeline.");
    assert.equal(ui.rows(), original);
    assert.doesNotMatch(timelineSection(await detail()), /never-render-this|data-event-type/);
    projection.mock.mockImplementation(async () => ({ fetchedAt: stamp, items: [] }));
    assert.match(timelineSection(await detail()), /No recorded events/);
  });
});

const fixture = process.env.TIMELINE_DAO_FIXTURES === "1" ? buildPostgresPoolConfigFromEnv() : null;

test("Timeline UI keeps server ordering across real PostgreSQL pages and denies another project", { skip: !fixture }, async () => {
  const pool = new PostgresRuntimePool(fixture!);
  const core = new CoreApiService(new PostgresControlPlaneRepository(pool));
  const headersFor = (projectId: string) => ({
    [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(core.issueAuthContext({ projectId, principalId: principal, roles: ["AUDITOR"] })),
  });
  const headers = headersFor(project);
  try {
    await withStack(core, async (webUrl, apiUrl) => {
      const html = await fetch(webUrl + projectPath + `?sessionId=${session}`, { headers }).then((res) => res.text());
      const reference: TimelineItem[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor !== null) query.set("cursor", cursor);
        const response = await fetch(apiUrl + corePath + "?" + query, { headers });
        assert.equal(response.status, 200);
        const page = await response.json() as { items: TimelineItem[]; page: { nextCursor: string | null } };
        reference.push(...page.items);
        cursor = page.page.nextCursor;
      } while (cursor !== null);
      assert.equal(reference.length, 9009);

      const used = new Set<string>();
      const ui = loadMore(html, async (path, init) => {
        const query = new URL(path, webUrl).searchParams;
        assert.deepEqual([...query.keys()], ["sessionId", "cursor"]);
        const sent = query.get("cursor");
        assert.equal(sent, ui.button.dataset.timelineCursor);
        assert.ok(sent && !used.has(sent));
        used.add(sent);
        const response = await fetch(webUrl + path, { ...init, headers: { ...init.headers, ...headers } });
        assert.equal(response.status, 200);
        return response;
      });

      // Both clicks execute before the response to the first can arrive.
      await Promise.all([ui.click(), ui.click()]);
      assert.equal(used.size, 1);
      while (!ui.button.hidden) {
        assert.ok(used.size < 451);
        await ui.click();
      }
      assert.equal(used.size, 450);
      assert.equal(ui.button.dataset.timelineCursor, undefined);
      const actual = [...ui.rows().matchAll(/data-event-type="([^"]+)"[\s\S]*?<dt>Recorded at<\/dt><dd>([^<]+)<\/dd>[\s\S]*?<dt>Resource ID<\/dt><dd>([^<]+)<\/dd>/g)]
        .map(([, type, recordedAt, resourceId]) => ({ type, recordedAt, resourceId }));
      assert.deepEqual(actual, reference.map(({ type, recordedAt, resourceId }) => ({ type, recordedAt, resourceId })));

      const otherHeaders = headersFor(id(1, 1));
      const denied = await fetch(webUrl + projectPath + `?sessionId=${session}`, { headers: otherHeaders }).then((res) => res.text());
      assert.match(timelineSection(denied), /Bạn không có quyền truy cập Timeline/);
      assert.doesNotMatch(timelineSection(denied), /data-event-type/);
      const foreign = await fetch(webUrl + projectPath + `?sessionId=${session}&cursor=unused`, {
        headers: { ...otherHeaders, Accept: timelinePageContentType },
      });
      assert.equal(foreign.status, 403);
      assert.deepEqual(await foreign.json(), { message: "Bạn không có quyền truy cập Timeline." });
    });
  } finally {
    await pool.close();
  }
});
