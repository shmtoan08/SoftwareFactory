import { DashboardClient, type DashboardResult } from "../dashboard-data/client.ts";
import type { TimelineDto, TimelineItemDto } from "../dashboard-data/mapping.ts";
import { escapeHtml, facts } from "./router.ts";

export const timelinePageContentType = "application/vnd.sf.timeline-page+json";

const partial = "Partial activity feed — ordered by recorded time. Not a complete or causal audit trail.";

function panel(state: "loading" | "empty" | "ready" | "error", content: string): string {
  const id = state === "loading" ? "timeline-loading" : "timeline-panel";
  return `<section id="${id}" data-state="${state}" aria-labelledby="${id}-heading">
<h2 id="${id}-heading">Timeline</h2>
<p>${partial}</p>
${content}</section>`;
}

export function timelinePlaceholder(state: "loading" | "empty" | "error"): string {
  const messages = { loading: "Đang tải…", empty: "Chưa chọn session.", error: "Không tải được Timeline." };
  return panel(state, `<p role="status">${messages[state]}</p>`);
}

export function renderTimelineItem(item: TimelineItemDto): string {
  const { type, recordedAt, resourceId } = item;
  const row = (fields: [string, string][] = [], label: string = type) =>
    `<li data-event-type="${escapeHtml(type)}"><h3>${escapeHtml(label)}</h3>${facts([
      ...(label === type ? [] : [["Type", type] as [string, string]]),
      ["Recorded at", recordedAt], ["Resource ID", resourceId], ...fields,
    ])}</li>`;

  switch (item.type) {
    case "session.created": return row();
    case "artifact.recorded": return row([["Artifact SHA-256", item.details.artifactSha256]]);
    case "gate.decided": return row([
      ["Decision", item.details.decision],
      ["Target artifact ID", item.details.targetArtifactId],
      ["Target artifact SHA-256", item.details.targetArtifactSha256],
    ]);
    case "baseline.frozen": return row();
    case "change-request.submitted": return row();
    case "change-request.decided": return row();
    case "change-request.applied": return row();
    default: return row([], "Unsupported event type");
  }
}

function timelineError(status?: number): string {
  switch (status) {
    case 401:
    case 403: return "Bạn không có quyền truy cập Timeline.";
    case 404: return "Không tìm thấy session trong phạm vi project.";
    case 409: return "Timeline đã thay đổi, tải lại từ đầu";
    default: return "Không tải được Timeline.";
  }
}

export function timelineFailure(status?: number): string {
  return panel("error", `<p role="status">${timelineError(status)}</p>`);
}

function timelineRows(data: TimelineDto): string {
  return data.items.map(renderTimelineItem).join("");
}

export function renderTimeline(result: DashboardResult<TimelineDto>, sessionId: string): string {
  if (result.kind === "error") return timelineFailure("status" in result.error ? result.error.status : undefined);
  if (result.kind === "empty") return panel("empty", '<p role="status">No recorded events</p>');
  const cursor = result.data.page.nextCursor;
  const pagination = cursor === null ? "" : `<button type="button" data-timeline-cursor="${escapeHtml(cursor)}">Load more</button><p data-timeline-status role="status"></p>`;
  return panel("ready", `<div data-timeline-session="${escapeHtml(sessionId)}"><ul class="approval-records">${timelineRows(result.data)}</ul>${pagination}</div>`);
}

export async function loadTimelinePage(
  projectId: string, query: URLSearchParams, authToken: string | undefined, baseUrl: string | undefined,
) {
  const error = (status: number) => ({ status, body: { message: timelineError(status) } });
  if (!authToken) return error(401);
  if (!baseUrl) return error(500);
  const session = query.get("sessionId");
  const cursor = query.get("cursor");
  if (!session || !cursor || [...query.keys()].length !== 2) return error(400);
  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    const result = await client.listTimeline(session, { cursor });
    if (result.kind === "error") {
      return error("status" in result.error ? result.error.status : 500);
    }
    return { status: 200, body: { rows: timelineRows(result.data), nextCursor: result.data.page.nextCursor } };
  } catch {
    return error(400);
  }
}

export const timelinePaginationScript = `(() => {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest?.("button[data-timeline-cursor]");
    if (!button || button.disabled || button.hidden || button.closest("[data-session-changing]")) return;
    const content = button.closest("[data-timeline-session]");
    const status = content.querySelector("[data-timeline-status]");
    button.disabled = true;
    status.textContent = "Đang tải…";
    try {
      const query = new URLSearchParams({ sessionId: content.dataset.timelineSession, cursor: button.dataset.timelineCursor });
      const response = await fetch(location.pathname + "?" + query, {
        headers: { Accept: "${timelinePageContentType}" },
        cache: "no-store",
      });
      if (response.headers.get("Content-Type") !== "${timelinePageContentType}") throw new Error();
      const page = await response.json();
      if (!button.isConnected || button.closest("[data-session-changing]")) return;
      if (!response.ok) {
        status.textContent = typeof page.message === "string" ? page.message : "Không tải được Timeline.";
        if ([401, 403, 404, 409].includes(response.status)) {
          delete button.dataset.timelineCursor;
          button.hidden = true;
        }
        if ([401, 403, 404].includes(response.status)) content.querySelector("ul").replaceChildren();
        return;
      }
      if (typeof page.rows !== "string" || (page.nextCursor !== null &&
          (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === button.dataset.timelineCursor))) throw new Error();
      content.querySelector("ul").insertAdjacentHTML("beforeend", page.rows);
      if (page.nextCursor === null) {
        delete button.dataset.timelineCursor;
        button.hidden = true;
      } else {
        button.dataset.timelineCursor = page.nextCursor;
      }
      status.textContent = "";
    } catch {
      status.textContent = "Không tải được Timeline.";
    } finally {
      button.disabled = false;
    }
  });
})();`;
