import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import type { PendingApprovalItemDto, PendingApprovalsDto } from "../dashboard-data/mapping.ts";
import { refreshablePanel } from "./panel-refresh.ts";
import { escapeHtml } from "./router.ts";

type State = "loading" | "empty" | "error" | "access-denied";
const notes = "<small>Stage gates are not listed here.</small>";
const messages = {
  loading: "Đang tải…",
  error: "Không tải được dữ liệu.",
  "access-denied": "Bạn không có quyền truy cập dữ liệu này.",
};
const time = (stamp: string) => `<time datetime="${escapeHtml(stamp)}">${escapeHtml(stamp)}</time>`;
const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const fact = (label: string, value: string) => `<dt>${label}</dt><dd>${value}</dd>`;

export function pendingApprovalsPlaceholder(state: Exclude<State, "empty">): string {
  return `<p data-state="${state}">${messages[state]}</p>${notes}`;
}

function renderItem(item: PendingApprovalItemDto): string {
  if (item.kind === "CHANGE_REQUEST") {
    return `<li><p>Change request</p><h3>${escapeHtml(item.title)}</h3><dl>${
      fact("Key", code(item.cr_key)) + fact("Status", escapeHtml(item.status))
      + fact("Session", code(item.pipeline_session_id)) + fact("Baseline", code(item.baseline_id))
      + fact("Hash", `<code title="${escapeHtml(item.hash)}">${escapeHtml(item.hash.slice(0, 12))}</code>`)
      + fact("Created", time(item.created_at))
    }</dl></li>`;
  }
  return `<li><h3>Merge approval</h3><dl>${
    fact("Status", escapeHtml(item.status)) + fact("Task", code(item.task_id))
    + fact("Merge candidate", code(item.merge_candidate_id)) + fact("Request", code(item.approval_request_id))
    + fact("Created", time(item.created_at)) + fact("Expires at", time(item.expires_at))
  }</dl></li>`;
}

export function renderPendingApprovals(result: DashboardResult<PendingApprovalsDto>): string {
  if (result.kind === "error") {
    if (result.error.kind === "data") {
      return `<p data-state="error">Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ.</p>${notes}`;
    }
    return pendingApprovalsPlaceholder(result.error.kind === "unauthorized" || result.error.kind === "access-denied" ? "access-denied" : "error");
  }
  const { items, fetchedAt, page } = result.data;
  if (result.kind === "empty") {
    return `<p data-state="empty">No pending change requests or merge approvals as of ${escapeHtml(fetchedAt)}.</p>${notes}`;
  }
  return `<div data-state="ready"><p>As of ${time(fetchedAt)}</p>
<ul class="approval-records">${items.map(renderItem).join("")}</ul>
${page.hasMore ? "<p>More items available</p>" : ""}${notes}</div>`;
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
