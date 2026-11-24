import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import { requireId } from "../dashboard-data/mapping.ts";
import { escapeHtml, facts } from "./router.ts";

type RecordedAssignment = {
  assigneeId: string | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
};

const absent = "không có";

export function taskDetail(endpoint: string, assignment: RecordedAssignment): string {
  return `<details data-task-detail="${escapeHtml(endpoint)}">
<summary>Chi tiết task</summary>
${facts([
  ["Profile được giao (kế hoạch)", assignment.assigneeId ?? absent],
  ["Lease owner (đã ghi)", assignment.leaseOwnerId ?? absent],
  ["Lease hết hạn lúc", assignment.leaseExpiresAt ?? absent],
])}
<div data-task-detail-body role="status"></div></details>`;
}

export const taskDetailScript = `
document.addEventListener("toggle", async (event) => {
  const detail = event.target;
  if (!detail.matches?.("[data-task-detail]") || !detail.open || detail.dataset.detailPending) return;
  const body = detail.querySelector("[data-task-detail-body]");
  detail.dataset.detailPending = "true";
  body.textContent = "Đang tải…";
  try {
    const response = await fetch(detail.dataset.taskDetail, {
      method: "GET", mode: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || response.headers.get("X-Dashboard-Panel") !== "1") throw new Error();
    const content = await response.text();
    if (detail.isConnected && detail.open) body.innerHTML = content;
  } catch {
    if (detail.isConnected && detail.open) body.textContent = "Không tải được chi tiết task.";
  } finally {
    delete detail.dataset.detailPending;
  }
}, true);
`;

function detailState<T>(result: DashboardResult<T>, missingIsEmpty = false): string {
  if (result.kind !== "error") return result.kind === "empty" ? '<p data-state="empty">không có</p>' : "";
  const error = result.error;
  if (error.kind === "access-denied" || ("status" in error && error.status === 401)) {
    return '<p data-state="access-denied">Bạn không có quyền truy cập dữ liệu này.</p>';
  }
  if (missingIsEmpty && error.kind === "not-found") return '<p data-state="empty">không có</p>';
  return '<p data-state="error">Không tải được dữ liệu.</p>';
}

export async function loadTaskDetails(
  projectId: string, sessionId: string, taskId: string, authToken: string | undefined, baseUrl: string | undefined,
): Promise<string> {
  if (!authToken) return '<p data-state="access-denied">Bạn không có quyền truy cập dữ liệu này.</p>';
  try {
    requireId(sessionId, "sessionId");
    requireId(taskId, "taskId");
    if (!baseUrl) throw new Error("Core API is unavailable");
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    const [assignment, dispatches] = await Promise.all([client.getTaskAssignment(taskId), client.listTaskDispatches(taskId)]);
    const assignmentBody = assignment.kind === "ok" ? facts([
      ["Assignment ID", assignment.data.assignmentId], ["Profile đã duyệt", assignment.data.profileId],
      ["Worker trong phân công", assignment.data.workerId], ["Tạo lúc", assignment.data.createdAt],
    ]) : detailState(assignment, true);
    const dispatchBody = dispatches.kind === "ok" ? `<ul>${dispatches.data.dispatches.map((dispatch) =>
      `<li>${facts([
        ["Request ID", dispatch.requestId], ["Trạng thái dispatch", dispatch.status],
        ["Ghi nhận lúc", dispatch.claimedAt ?? absent], ["Hoàn tất lúc", dispatch.completedAt ?? absent],
      ])}</li>`,
    ).join("")}</ul>` : detailState(dispatches);
    return `<h4>Phân công thực thi đã duyệt</h4>${assignmentBody}<h4>Bản ghi dispatch</h4>${dispatchBody}`;
  } catch {
    return '<p data-state="error">Không tải được chi tiết task.</p>';
  }
}
