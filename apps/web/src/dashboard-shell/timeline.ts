import type { DashboardResult } from "../dashboard-data/client.ts";
import type { TimelineDto, TimelineItemDto } from "../dashboard-data/mapping.ts";
import { escapeHtml, facts } from "./router.ts";

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

export function renderTimeline(result: DashboardResult<TimelineDto>): string {
  if (result.kind === "error") return timelinePlaceholder("error");
  if (result.kind === "empty") return panel("empty", '<p role="status">Không có mốc đã ghi.</p>');
  return panel("ready", `<ul class="approval-records">${result.data.items.map(renderTimelineItem).join("")}</ul>`);
}
