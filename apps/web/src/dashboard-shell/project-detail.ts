import { evidencePlaceholder, renderEvidence } from "./evidence.ts";
import type { ServerResponse } from "node:http";
import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import type { SessionDto, SessionListDto } from "../dashboard-data/mapping.ts";
import { agentProfilesLoading, agentProfilesPanel, loadAgentProfilesBody } from "./agent-profiles.ts";
import { approvalsPlaceholder, renderApprovalChangeRequests, renderApprovalDecisions } from "./approvals.ts";
import { budgetLoadingPanel, budgetPanel, loadBudgetBody, renderBudget } from "./budget.ts";
import { costUsagePlaceholder, loadCostUsage } from "./cost-session-usage.ts";
import { panelRefreshScript } from "./panel-refresh.ts";
import { renderTimeline, timelineFailure, timelinePaginationScript, timelinePlaceholder } from "./timeline.ts";
import { taskDetailScript } from "./task-detail.ts";
import { readTaskPage, renderTasks, retireTasksOnSessionChange, tasksPanel, tasksPlaceholder } from "./tasks.ts";
import { workItemsPanel, workItemsPlaceholder } from "./work-items.ts";
import { documentEnd, documentStart, escapeHtml, facts } from "./router.ts";

type ProjectDetail = Extract<Awaited<ReturnType<DashboardClient["getProject"]>>, { data: unknown }>["data"];
type Panel = "project" | "sessions";
type PanelState = "loading" | "empty" | "error" | "access-denied" | "ready";

const headings = { project: "Thông tin project", sessions: "Session context" };

function panel(id: Panel, state: PanelState, content: string): string {
  const key = `${id}-${state === "loading" ? "loading" : "result"}`;
  return `<section id="${key}" data-state="${state}" aria-labelledby="${key}-heading">
<h2 id="${key}-heading">${headings[id]}</h2>
${content}
</section>`;
}

function unavailable(id: Panel, state: "loading" | "empty" | "error" | "access-denied"): string {
  const messages = {
    loading: "Đang tải…",
    empty: id === "project" ? "Không tìm thấy project." : "Chưa chọn session. Project chưa có session.",
    error: "Không tải được dữ liệu.",
    "access-denied": "Bạn không có quyền truy cập dữ liệu này.",
  };
  return panel(id, state, `<p role="status">${messages[state]}</p>`);
}

function failureState<T>(panel: Panel, result: DashboardResult<T>): "error" | "access-denied" | "empty" | null {
  if (result.kind === "empty") return "empty";
  if (result.kind !== "error") return null;
  const error = result.error;
  if (error.kind === "access-denied" || ("status" in error && error.status === 401)) return "access-denied";
  if (panel === "project" && error.kind === "not-found") return "empty";
  return "error";
}

function renderProject(result: DashboardResult<ProjectDetail>): string {
  if (result.kind !== "ok") return unavailable("project", failureState("project", result) ?? "error");
  const { project, fetchedAt } = result.data;
  return panel("project", "ready", facts([
    ["Tên", project.name], ["Project ID", project.projectId], ["Slug", project.slug],
    ["Nhánh mặc định", project.defaultBranch], ["Tạo lúc", project.createdAt], ["Cập nhật lúc", project.updatedAt],
    ["fetchedAt", fetchedAt], ["receivedAt", result.receivedAt],
  ]));
}

function renderSessions(result: DashboardResult<SessionListDto>, projectId: string, selected: SessionDto | undefined, cursor: string | null): string {
  if (result.kind !== "ok") return unavailable("sessions", failureState("sessions", result) ?? "error");
  const { items, page } = result.data;
  const path = `/projects/${encodeURIComponent(projectId)}`;
  const options = items.map((item) =>
    `<option value="${escapeHtml(item.pipelineSessionId)}"${item === selected ? " selected" : ""}>${escapeHtml(item.title)}</option>`,
  ).join("");
  const selection = `<form method="get" action="${path}" data-session-context="${selected?.pipelineSessionId ?? ""}">
<label for="session-choice">Session</label>
<select id="session-choice" name="sessionId"><option value=""${selected ? "" : " selected"}>Chưa chọn session</option>${options}</select>
${cursor === null ? "" : `<input type="hidden" name="cursor" value="${escapeHtml(cursor)}">`}
<button type="submit">Chọn session</button>
</form>`;
  const pagination = [
    cursor === null ? "" : `<a href="${path}">Trang đầu</a>`,
    page.nextCursor === null ? "" : `<a href="${path}?${escapeHtml(new URLSearchParams({ cursor: page.nextCursor }).toString())}">Trang tiếp</a>`,
  ].filter(Boolean).join(" · ");
  const details = selected ? facts([
    ["Session ID", selected.pipelineSessionId], ["Tên", selected.title],
    ["Tạo lúc", selected.createdAt], ["Cập nhật lúc", selected.updatedAt],
  ]) + "<p>Đây là session mà các panel phụ thuộc session sẽ dùng trong Slice 1c.</p>"
    : '<p role="status">Chưa chọn session.</p>';
  return panel("sessions", selected ? "ready" : "empty", details + selection + (pagination ? `<p>${pagination}</p>` : ""));
}

export async function sendProjectDetail(
  res: ServerResponse, projectId: string, query: URLSearchParams, authToken: string | undefined, baseUrl: string | undefined,
): Promise<void> {
  const progress = `<section id="pipeline-progress" data-state="unsupported" aria-labelledby="pipeline-progress-heading">
<h2 id="pipeline-progress-heading">Pipeline Progress</h2>
<p><strong>UNSUPPORTED</strong> — Chưa có nguồn tiến độ được duyệt (session DTO không chứa stage/status/tiến độ)</p>
</section>`;
  const start = documentStart("Project", false, "vi") + '<div class="project-panels">';
  const script = `<script>${panelRefreshScript}</script><script>${retireTasksOnSessionChange}</script><script>${taskDetailScript}</script><script>${timelinePaginationScript}</script>`;
  const end = "</div>" + documentEnd;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });

  if (!authToken || !baseUrl) {
    const state = authToken ? "error" : "access-denied";
    res.end(start + unavailable("project", state) + unavailable("sessions", state)
      + progress + budgetPanel(projectId, await loadBudgetBody(projectId, authToken, baseUrl))
      + tasksPlaceholder("empty") + workItemsPlaceholder("empty") + costUsagePlaceholder("empty") + approvalsPlaceholder("empty") + evidencePlaceholder("empty")
      + agentProfilesPanel(projectId, await loadAgentProfilesBody(projectId, authToken, baseUrl)) + timelineFailure(authToken ? undefined : 401) + script + end);
    return;
  }

  let client: DashboardClient;
  try {
    client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
  } catch {
    res.end(start + unavailable("project", "error") + unavailable("sessions", "error")
      + progress + budgetPanel(projectId, await loadBudgetBody(projectId, authToken, baseUrl))
      + tasksPlaceholder("empty") + workItemsPlaceholder("empty") + costUsagePlaceholder("empty") + approvalsPlaceholder("empty") + evidencePlaceholder("empty")
      + agentProfilesPanel(projectId, await loadAgentProfilesBody(projectId, authToken, baseUrl)) + timelinePlaceholder("error") + script + end);
    return;
  }

  const cursor = query.get("cursor");
  const selectedId = query.get("sessionId");
  const initialState = selectedId ? "loading" : "empty";
  res.write(start + unavailable("project", "loading") + unavailable("sessions", "loading")
    + progress + budgetLoadingPanel() + tasksPlaceholder(initialState) + workItemsPlaceholder(initialState) + agentProfilesLoading() + costUsagePlaceholder(initialState) + approvalsPlaceholder(initialState) + evidencePlaceholder(initialState) + timelinePlaceholder(initialState) + script);
  const write = (html: string) => { if (!res.destroyed) res.write(html); };
  const budget = client.getBudgetSnapshot().then((result) => write(budgetPanel(projectId, renderBudget(result))));
  const session = client.listSessions(projectId, cursor === null ? {} : { cursor })
    .then(async (result) => {
      const selected = result.kind === "ok" ? result.data.items.find((item) => item.pipelineSessionId === selectedId) : undefined;
      write(renderSessions(result, projectId, selected, cursor));
      if (!selected) {
        if (selectedId) {
          const timeline = result.kind !== "error" ? timelinePlaceholder("empty")
            : timelineFailure(failureState("sessions", result) === "access-denied" ? 403 : undefined);
          write(tasksPlaceholder("empty") + workItemsPlaceholder("empty") + costUsagePlaceholder("empty")
            + approvalsPlaceholder("empty") + evidencePlaceholder("empty") + timeline);
        }
        return;
      }
      if (res.destroyed) return;
      const sessionId = selected.pipelineSessionId;
      await Promise.all([
        readTaskPage(projectId, sessionId, authToken, baseUrl).then((result) => {
          write(tasksPanel(projectId, sessionId, renderTasks(result)) + workItemsPanel(projectId, sessionId, result));
        }),
        client.getApprovalEvidence(sessionId).then((result) => {
          write(renderApprovalDecisions(result) + renderEvidence(result));
        }),
        client.listApprovalChangeRequests(sessionId).then((result) => {
          write(renderApprovalChangeRequests(result));
        }),
        loadCostUsage(client, sessionId).then(write),
        client.listTimeline(sessionId).then((result) => write(renderTimeline(result, sessionId))),
      ]);
    }, () => {
      write(unavailable("sessions", "error"));
      if (selectedId) write(tasksPlaceholder("empty") + workItemsPlaceholder("empty") + costUsagePlaceholder("empty") + approvalsPlaceholder("empty") + evidencePlaceholder("empty") + timelinePlaceholder("error"));
    });
  await Promise.all([
    loadAgentProfilesBody(projectId, authToken, baseUrl).then((body) => write(agentProfilesPanel(projectId, body))),
    client.getProject().then(renderProject).catch(() => unavailable("project", "error")).then(write),
    budget,
    session,
  ]);
  if (!res.destroyed) res.end("</div>" + documentEnd);
}
