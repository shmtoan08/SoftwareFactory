import { refreshablePanel } from "./panel-refresh.ts";
import { escapeHtml, facts } from "./router.ts";
import { readTaskPage, type TasksResult } from "./tasks.ts";

// Data Mapping Spec v2, TaskStatus presentation table.
const statusLabels = new Map([
  ["Ready", "Ready"],
  ["Leased", "Leased"],
  ["ExecutingInTarget", "Executing in target"],
  ["BuildingMergeCandidate", "Building merge candidate"],
  ["VerifyingInDocker", "Verifying in Docker"],
  ["UnderIndependentReview", "Under independent review"],
  ["AwaitingHumanApproval", "Awaiting human approval"],
  ["AtomicCasMerge", "Atomic CAS merge"],
  ["MergedAndCompleted", "Merged and completed"],
  ["ReworkRequired", "Rework required"],
  ["ManualIntervention", "Manual intervention"],
]);

export function workItemsPlaceholder(state: "loading" | "empty"): string {
  const message = state === "loading" ? "Đang tải…"
    : 'Chưa chọn session. Hãy chọn một session ở <a href="#sessions-result">Session context</a>.';
  return `<section id="work-items-${state}" aria-labelledby="work-items-${state}-heading">
<h2 id="work-items-${state}-heading">Work items</h2><p role="status" data-state="${state}">${message}</p></section>`;
}

function tablePath(projectId: string, sessionId: string, status?: string, cursor?: string): string {
  const path = `/projects/${encodeURIComponent(projectId)}/dashboard-work-items/${encodeURIComponent(sessionId)}`;
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (cursor !== undefined) query.set("cursor", cursor);
  return query.size ? path + "?" + query.toString() : path;
}

export function workItemsPanel(projectId: string, sessionId: string, result: TasksResult): string {
  const controls = `<div class="work-items-filter">
<label for="work-items-status">Lọc trạng thái trên máy chủ</label>
<select id="work-items-status" name="status" data-panel-filter-field><option value="">Tất cả trạng thái</option>
${[...statusLabels].map(([source, label]) => `<option value="${source}">${label}</option>`).join("")}
</select><button type="button" data-panel-filter>Áp dụng</button></div>`;
  return refreshablePanel("work-items-panel", "Work items", tablePath(projectId, sessionId),
    renderWorkItems(result, projectId, sessionId), controls);
}

function renderWorkItems(result: TasksResult, projectId: string, sessionId: string, status?: string, cursor?: string): string {
  if (result.kind === "error") {
    const error = result.error;
    if (error.kind === "access-denied" || ("status" in error && error.status === 401)) {
      return '<p data-state="access-denied">Bạn không có quyền truy cập dữ liệu này.</p>';
    }
    return '<p data-state="error">Không tải được dữ liệu.</p>';
  }

  const { data } = result;
  const rows = data.items.map((item) =>
    `<tr><th scope="row">${escapeHtml(item.title)}</th><td>${escapeHtml(item.taskId)}</td><td class="work-item-status">${escapeHtml(item.sourceStatus)}</td><td>${statusLabels.get(item.sourceStatus) ?? "Unknown"}</td></tr>`,
  ).join("");
  const table = result.kind === "empty" ? "<p>Không có work item trong trang này.</p>" : `<div class="work-items-scroll" tabindex="0">
<table><caption>Work items của session đã chọn</caption><thead><tr><th scope="col">Work item</th><th scope="col">Task ID</th>
<th scope="col">sourceStatus</th><th scope="col">displayStatus</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const paging = [
    cursor === undefined ? "" : `<button type="button" data-panel-request="${escapeHtml(tablePath(projectId, sessionId, status))}">Trang đầu</button>`,
    data.page.nextCursor === null ? "" :
      `<button type="button" data-panel-request="${escapeHtml(tablePath(projectId, sessionId, status, data.page.nextCursor))}">Trang tiếp</button>`,
  ].filter(Boolean).join(" ");
  return `<div data-state="${result.kind === "empty" ? "empty" : "ready"}">
${facts([["Snapshot (fetchedAt)", data.fetchedAt], ["Tải lúc", result.receivedAt]])}
${table}${paging ? `<p>${paging}</p>` : ""}</div>`;
}

export async function loadWorkItemsBody(
  projectId: string, sessionId: string, query: URLSearchParams, authToken: string | undefined, baseUrl: string | undefined,
): Promise<string> {
  const status = query.get("status") ?? undefined;
  const cursor = query.get("cursor") ?? undefined;
  if ([...query.keys()].some((key) => (key !== "status" && key !== "cursor") || query.getAll(key).length > 1)
    || (status !== undefined && !statusLabels.has(status))) {
    return '<p data-state="error">Bộ lọc hoặc trang không hợp lệ.</p>';
  }
  const result = await readTaskPage(projectId, sessionId, authToken, baseUrl,
    { cursor, sourceStatuses: status === undefined ? [] : [status] });
  return renderWorkItems(result, projectId, sessionId, status, cursor);
}
