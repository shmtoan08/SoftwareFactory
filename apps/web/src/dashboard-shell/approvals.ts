import type { DashboardClient, DashboardResult } from "../dashboard-data/client.ts";
import { escapeHtml, facts } from "./router.ts";

type Resource = "approval-decisions" | "change-requests";
type State = "loading" | "empty" | "ready" | "error" | "access-denied";
const headings = { "approval-decisions": "Approval decisions", "change-requests": "Change requests" };
const decisionLabels = { APPROVED: "Approved", REJECTED: "Rejected", REQUEST_CHANGES: "Changes requested" };
const requestLabels = { PENDING_APPROVAL: "Pending approval", APPROVED: "Approved", REJECTED: "Rejected", APPLIED: "Applied" };

function panel(resource: Resource, state: State, body: string): string {
  const id = `${resource}-${state === "loading" ? "loading" : "result"}`;
  const limit = resource === "approval-decisions"
    ? "Chỉ hiển thị quyết định đã ghi, gắn với đúng artifact ID và SHA-256. Yêu cầu phê duyệt pipeline, thời hạn và bộ sưu tập phê duyệt deployment/reconciliation: unsupported."
    : "Chỉ hiển thị các bản ghi change request do API trả về.";
  return `<section id="${id}" data-state="${state}" aria-labelledby="${id}-heading">
<h2 id="${id}-heading">${headings[resource]}</h2>
<p>${limit}</p>${body}</section>`;
}

export function approvalsPlaceholder(state: "loading" | "empty"): string {
  const message = state === "loading" ? "Đang tải…" : "Chưa chọn session.";
  const body = `<p role="status">${message}</p>`;
  return panel("approval-decisions", state, body) + panel("change-requests", state, body);
}

function renderResult<T>(
  resource: Resource, result: DashboardResult<T>, empty: string, renderItems: (data: T) => string,
): string {
  if (result.kind === "empty") return panel(resource, "empty", `<p role="status">${empty}</p>`);
  if (result.kind === "ok") return panel(resource, "ready", renderItems(result.data));
  if (result.kind !== "error") return panel(resource, "error", '<p role="status">Không tải được dữ liệu.</p>');

  const error = result.error;
  if (error.kind === "access-denied" || ("status" in error && error.status === 401)) {
    return panel(resource, "access-denied", '<p role="status">Bạn không có quyền truy cập dữ liệu này.</p>');
  }
  const message = error.kind === "data" ? "Dữ liệu API thiếu trường bắt buộc hoặc không hợp lệ."
    : "Không tải được dữ liệu.";
  return panel(resource, "error", `<p role="status">${message}</p>`);
}

export async function loadApprovalDecisions(client: DashboardClient, sessionId: string): Promise<string> {
  return renderResult("approval-decisions", await client.listApprovalDecisions(sessionId),
    "No recorded decision", ({ decisions }) => `<ul class="approval-records">${decisions.map((gate) => {
      const label = gate.decision === null ? "No recorded decision" : decisionLabels[gate.decision];
      return `<li data-decision="${gate.decision ?? "missing"}"><h3>${label}</h3>${facts([
        ["Session nguồn", gate.sessionId], ["Gate ID", gate.gateId], ["Gate", gate.gate],
        ["Artifact ID đã ghi", gate.targetArtifactId], ["Artifact SHA-256 đã ghi", gate.targetArtifactHash],
        ["Binding", gate.bindingMatches ? "Khớp đúng ID và SHA-256 trong bundle" : "Không có artifact khớp đúng ID và SHA-256 trong bundle"],
        ["Lý do", gate.rationale ?? "Không có"], ["Người quyết định", gate.approver], ["Quyết định lúc", gate.decidedAt],
      ])}</li>`;
    }).join("")}</ul>`);
}

export async function loadApprovalChangeRequests(client: DashboardClient, sessionId: string): Promise<string> {
  return renderResult("change-requests", await client.listApprovalChangeRequests(sessionId),
    "Không có change request.", ({ requests }) => `<ul class="approval-records">${requests.map((cr) =>
      `<li data-request-status="${cr.status}"><h3>${escapeHtml(cr.title)}</h3>${facts([
        ["Trạng thái", requestLabels[cr.status]], ["Session nguồn", cr.sessionId], ["Change request ID", cr.id], ["Mã", cr.key],
        ["Baseline ID", cr.baselineId], ["Change request SHA-256", cr.hash],
      ])}</li>`,
    ).join("")}</ul>`);
}
