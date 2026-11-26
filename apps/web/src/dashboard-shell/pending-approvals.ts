import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import { assertUniquePendingApprovalPage, DashboardDataError, pendingApprovalKey, type PendingApprovalItemDto, type PendingApprovalsDto } from "../dashboard-data/mapping.ts";
import { refreshablePanel } from "./panel-refresh.ts";
import { escapeHtml } from "./router.ts";

type State = "loading" | "empty" | "error" | "access-denied";
export const pendingApprovalsPageContentType = "application/vnd.sf.pending-approvals-page+json";

const dataError = "Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ.";
const notes = "<small>Stage gates are not listed here.</small>";
const messages = {
  loading: "Đang tải…",
  error: "Không tải được dữ liệu.",
  "access-denied": "Bạn không có quyền truy cập dữ liệu này.",
};
const time = (stamp: string) => `<time datetime="${escapeHtml(stamp)}">${escapeHtml(stamp)}</time>`;
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const fact = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;

const retry = '<button type="button" data-panel-refresh>Retry</button>';

export function pendingApprovalsPlaceholder(state: Exclude<State, "empty">): string {
  return `<p data-state="${state}">${messages[state]}</p>${state === "error" ? retry : ""}${notes}`;
}

function renderItem(item: PendingApprovalItemDto): string {
  const row = `<li data-pending-key="${escapeHtml(pendingApprovalKey(item))}">`;
  if (item.kind === "CHANGE_REQUEST") {
    return `${row}<p>Change request</p><h3>${escapeHtml(item.title)}</h3><dl>${
      fact("Key", code(item.cr_key)) + fact("Status", escapeHtml(item.status))
      + fact("Session", code(item.pipeline_session_id)) + fact("Baseline", code(item.baseline_id))
      + fact("Hash", `<code title="${escapeHtml(item.hash)}">${escapeHtml(item.hash.slice(0, 12))}</code>`)
      + fact("Created", time(item.created_at))
    }</dl></li>`;
  }
  return `${row}<h3>Merge approval</h3><dl>${
    fact("Status", escapeHtml(item.status)) + fact("Task", code(item.task_id))
    + fact("Merge candidate", code(item.merge_candidate_id)) + fact("Request", code(item.approval_request_id))
    + fact("Created", time(item.created_at)) + fact("Expires at", time(item.expires_at))
  }</dl></li>`;
}

export function renderPendingApprovals(result: DashboardResult<PendingApprovalsDto>): string {
  if (result.kind === "error") {
    if (result.error.kind === "data") {
      return `<p data-state="error">${dataError}</p>${notes}`;
    }
    if (result.error.kind === "bad-request") return `<p data-state="error">Yêu cầu không hợp lệ.</p>${notes}`;
    return pendingApprovalsPlaceholder(result.error.kind === "unauthorized" || result.error.kind === "access-denied" ? "access-denied" : "error");
  }
  const { items, fetchedAt, page } = result.data;
  if (result.kind === "empty") {
    return `<p data-state="empty">No pending change requests or merge approvals as of ${escapeHtml(fetchedAt)}.</p>${notes}`;
  }
  return `<div data-state="ready"><p>As of ${time(fetchedAt)}</p>
<ul class="approval-records">${items.map(renderItem).join("")}</ul>
${page.nextCursor === null ? "" : `<button type="button" data-pending-cursor="${escapeHtml(page.nextCursor)}">Load more</button><p data-pending-status role="status"></p>`}${notes}</div>`;
}

export function pendingApprovalsPanel(projectId: string, body: string): string {
  return refreshablePanel("pending-approvals-panel", "Pending approvals",
    `/projects/${encodeURIComponent(projectId)}/dashboard-pending-approvals`, body, "", "Refresh");
}

export async function loadPendingApprovalsBody(projectId: string, authToken: string | undefined, baseUrl: string | undefined) {
  if (!authToken) return pendingApprovalsPlaceholder("access-denied");
  if (!baseUrl) return pendingApprovalsPlaceholder("error");
  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    return renderPendingApprovals(await client.listPendingApprovals());
  } catch {
    return pendingApprovalsPlaceholder("error");
  }
}

export async function loadPendingApprovalsPage(
  projectId: string, query: URLSearchParams, authToken: string | undefined, baseUrl: string | undefined,
) {
  const failure = (status: number, problem: "data" | "request" | "unavailable" = "unavailable") =>
    ({ status, body: { problem } });
  const cursor = query.get("cursor");
  if (!cursor || query.size !== 1) return failure(400, "request");
  if (!authToken) return failure(401);
  if (!baseUrl) return failure(500);
  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    const result = await client.listPendingApprovals({ cursor });
    if (result.kind === "error") {
      if (result.error.kind === "data") return failure(502, "data");
      if ("status" in result.error) return failure(result.error.status);
      return failure(500);
    }
    return { status: 200, body: { rows: result.data.items.map(renderItem).join(""), nextCursor: result.data.page.nextCursor } };
  } catch {
    return failure(500);
  }
}

// Node strips the TypeScript annotations before serializing these shared validators.
// Keep page identities and continuation state scoped to the current list element.
export const pendingApprovalsPaginationScript = `(() => {
  const DashboardDataError = ${DashboardDataError.toString()};
  const pendingApprovalKey = ${pendingApprovalKey.toString()};
  const assertUniquePendingApprovalPage = ${assertUniquePendingApprovalPage.toString()};
  const consumed = new WeakMap();
  const rowsKeys = (rows) => Array.from(rows.children, (row) => {
    if (row.tagName !== "LI" || !row.dataset.pendingKey) throw new DashboardDataError("pending approval row");
    return row.dataset.pendingKey;
  });

  document.addEventListener("click", async (event) => {
    const button = event.target?.closest?.("button[data-pending-cursor]");
    if (!button || button.hidden || button.disabled) return;
    const panel = button.closest("#pending-approvals-panel");
    if (panel.dataset.panelBusy) return;
    const snapshot = button.closest('[data-state="ready"]');
    const status = snapshot.querySelector("[data-pending-status]");
    const list = snapshot.querySelector("ul");
    const cursor = button.dataset.pendingCursor;
    const seen = consumed.get(list) ?? new Set();
    consumed.set(list, seen);
    const stop = () => { button.hidden = true; delete button.dataset.pendingCursor; };
    const retry = () => { status.textContent = "${messages.error}"; button.textContent = "Retry"; };
    const invalid = () => { status.textContent = "${dataError}"; stop(); };
    button.disabled = true;
    status.textContent = "${messages.loading}";
    try {
      const query = new URLSearchParams({ cursor });
      const response = await fetch(panel.dataset.panelUrl + "/page?" + query, {
        method: "GET", headers: { Accept: "${pendingApprovalsPageContentType}" },
        cache: "no-store", mode: "same-origin", redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!button.isConnected) return;
      if (response.headers.get("Content-Type") !== "${pendingApprovalsPageContentType}") throw new DashboardDataError("page content type");
      const page = await response.json();
      if (!button.isConnected) return;
      if (!response.ok) {
        if (page.problem === "data") invalid();
        else if ([401, 403].includes(response.status)) { status.textContent = "${messages["access-denied"]}"; stop(); }
        else if (response.status === 400) { status.textContent = "Yêu cầu không hợp lệ."; stop(); }
        else if (response.status === 409) { status.textContent = "Pending approvals đã thay đổi, tải lại từ đầu"; stop(); }
        else retry();
        return;
      }
      if (typeof page.rows !== "string" || (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor || seen.has(page.nextCursor)))) {
        throw new DashboardDataError("page continuation");
      }
      const fragment = document.createElement("template");
      fragment.innerHTML = page.rows;
      assertUniquePendingApprovalPage(rowsKeys(fragment.content), rowsKeys(list));
      list.append(fragment.content);
      seen.add(cursor);
      status.textContent = "";
      if (page.nextCursor === null) stop();
      else {
        button.dataset.pendingCursor = page.nextCursor;
        button.textContent = "Load more";
      }
    } catch (error) {
      if (!button.isConnected) return;
      if (error instanceof DashboardDataError || error instanceof SyntaxError) invalid();
      else retry();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
})();`;
