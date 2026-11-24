import type { ServerResponse } from "node:http";
import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import type { SessionListDto } from "../dashboard-data/mapping.ts";
import { documentEnd, documentStart } from "./router.ts";

type ProjectDetail = Extract<Awaited<ReturnType<DashboardClient["getProject"]>>, { data: unknown }>["data"];
type Panel = "project" | "sessions";
type PanelState = "loading" | "empty" | "error" | "access-denied" | "ready";

const headings = { project: "Thông tin project", sessions: "Session context" };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

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

function facts(entries: [string, string][]): string {
  return `<dl>${entries.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
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

function renderSessions(result: DashboardResult<SessionListDto>, projectId: string, selectedId: string | null, cursor: string | null): string {
  if (result.kind !== "ok") return unavailable("sessions", failureState("sessions", result) ?? "error");
  const { items, page } = result.data;
  const selected = items.find((item) => item.pipelineSessionId === selectedId);
  const path = `/projects/${encodeURIComponent(projectId)}`;
  const options = items.map((item) =>
    `<option value="${escapeHtml(item.pipelineSessionId)}"${item === selected ? " selected" : ""}>${escapeHtml(item.title)}</option>`,
  ).join("");
  const selection = `<form method="get" action="${path}">
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
  const end = progress + "</div>" + documentEnd;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });

  if (!authToken || !baseUrl) {
    const state = authToken ? "error" : "access-denied";
    res.end(start + unavailable("project", state) + unavailable("sessions", state) + end);
    return;
  }

  let client: DashboardClient;
  try {
    client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
  } catch {
    res.end(start + unavailable("project", "error") + unavailable("sessions", "error") + end);
    return;
  }

  const cursor = query.get("cursor");
  res.write(start + unavailable("project", "loading") + unavailable("sessions", "loading") + progress);
  const write = (html: string) => { if (!res.destroyed) res.write(html); };
  await Promise.all([
    client.getProject().then(renderProject).catch(() => unavailable("project", "error")).then(write),
    client.listSessions(projectId, cursor === null ? {} : { cursor })
      .then((result) => renderSessions(result, projectId, query.get("sessionId"), cursor))
      .catch(() => unavailable("sessions", "error")).then(write),
  ]);
  if (!res.destroyed) res.end("</div>" + documentEnd);
}
