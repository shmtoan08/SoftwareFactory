import { DashboardClient } from "../dashboard-data/client.ts";
import { refreshablePanel } from "./panel-refresh.ts";
import { escapeHtml, facts } from "./router.ts";

type TasksResult = Awaited<ReturnType<DashboardClient["listSessionTasks"]>>;
type TaskRow = Extract<TasksResult, { data: unknown }>["data"]["items"][number];

function taskState(state: "loading" | "empty" | "error" | "access-denied", message: string): string {
  return `<p data-state="${state}">${message}</p>`;
}

export function tasksPlaceholder(state: "empty" | "loading"): string {
  const body = state === "empty"
    ? taskState("empty", 'Chưa chọn session. Hãy chọn một session ở <a href="#sessions-result">Session context</a>.')
    : taskState("loading", "Đang tải…");
  return `<section id="tasks-${state}" aria-labelledby="tasks-${state}-heading">
<h2 id="tasks-${state}-heading">Tasks</h2>
<div role="status">${body}</div>
</section>`;
}

export function tasksPanel(projectId: string, sessionId: string, body: string): string {
  const path = `/projects/${encodeURIComponent(projectId)}/dashboard-tasks/${encodeURIComponent(sessionId)}`;
  return refreshablePanel("tasks-panel", "Tasks", path, body);
}

// Session selection is a full document GET. On submission, retire the old panel
// immediately, while the next document is still on its way.
export const retireTasksOnSessionChange = `
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("[data-session-context]")) return;
  if (form.elements.sessionId.value === form.dataset.sessionContext) return;
  const panels = form.closest(".project-panels");
  panels.dataset.sessionChanging = "";
  panels.querySelector("#tasks-panel")?.remove();
});
`;

function renderTask(task: TaskRow): string {
  const missing = "Không có dữ liệu";
  return `<li><h3>${escapeHtml(task.title)}</h3>${facts([
    ["Task ID", task.taskId], ["Project ID", task.projectId], ["Session ID", task.sessionId],
    ["sourceStatus", task.sourceStatus], ["Lượt thực hiện", String(task.currentAttemptNo)],
    ["Số lần làm lại", String(task.reworkCount)], ["Giới hạn làm lại", String(task.maxReworkCycles)],
    ["Lease epoch", task.activeLeaseEpoch], ["Profile được giao", task.assigneeId ?? missing],
    ["Lease owner", task.leaseOwnerId ?? missing], ["Lease hết hạn lúc", task.leaseExpiresAt ?? missing],
    ["Tạo lúc", task.createdAt], ["Cập nhật lúc", task.updatedAt],
  ])}</li>`;
}

function renderTasks(result: TasksResult): string {
  if (result.kind === "empty") return taskState("empty", "Session này chưa có task.");
  if (result.kind === "error") {
    const error = result.error;
    if (error.kind === "access-denied" || ("status" in error && error.status === 401)) {
      return taskState("access-denied", "Bạn không có quyền truy cập dữ liệu này.");
    }
    return taskState("error", "Không tải được dữ liệu.");
  }
  const { data, receivedAt } = result;
  return `<div data-state="ready">
${facts([["Tải lúc", receivedAt], ["Snapshot (fetchedAt)", data.fetchedAt]])}
${data.page.hasMore ? "<p>Đang hiển thị trang đầu của danh sách task.</p>" : ""}
<ul class="dashboard-task-list">${data.items.map(renderTask).join("")}</ul></div>`;
}

export async function loadTasksBody(projectId: string, sessionId: string, authToken: string | undefined, baseUrl: string | undefined): Promise<string> {
  if (!authToken) return taskState("access-denied", "Bạn không có quyền truy cập dữ liệu này.");
  if (!baseUrl) return taskState("error", "Không tải được dữ liệu.");
  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    return renderTasks(await client.listSessionTasks(sessionId));
  } catch {
    return taskState("error", "Không tải được dữ liệu.");
  }
}
