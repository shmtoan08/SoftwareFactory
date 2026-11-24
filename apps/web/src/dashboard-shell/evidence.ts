import type { DashboardClient } from "../dashboard-data/client.ts";
import { ARTIFACT_ROW_LIMIT } from "../dashboard-data/mapping.ts";
import { escapeHtml, facts } from "./router.ts";

type State = "loading" | "empty" | "ready" | "error" | "access-denied" | "unavailable";
const unavailable = "Inaccessible/unavailable artifact";

function panel(state: State, body: string): string {
  const id = state === "loading" ? "evidence-loading" : "evidence-result";
  return `<section id="${id}" data-state="${state}" aria-labelledby="${id}-heading">
<h2 id="${id}-heading">Evidence</h2>${body}</section>`;
}

function status(state: State, message: string): string {
  return panel(state, `<p role="status">${message}</p>`);
}

export function evidencePlaceholder(state: "loading" | "empty"): string {
  return status(state, state === "loading" ? "Đang tải…" : "Chưa chọn session.");
}

export function renderEvidence(result: Awaited<ReturnType<DashboardClient["getApprovalEvidence"]>>): string {
  if (result.kind === "error") {
    const { error } = result;
    if ("status" in error && (error.status === 401 || error.status === 403)) {
      return status("access-denied", `${unavailable} — Bạn không có quyền truy cập.`);
    }
    if (error.kind === "not-found" || error.kind === "data") return status("unavailable", unavailable);
    return status("error", "Không tải được Evidence.");
  }

  const { evidence } = result.data;
  if (evidence === null) return status("unavailable", unavailable);
  if (evidence.items.length === 0) return status("empty", "Không có artifact.");

  const rows = evidence.items.map((artifact) => {
    if (artifact === null) return `<li data-state="unavailable">${unavailable}</li>`;
    const gates = artifact.gates;
    return `<li><h3>${escapeHtml(artifact.id)}</h3>${facts([
      ["Artifact SHA-256", artifact.hash], ["Loại", artifact.kind], ["Stage", artifact.stage],
      ["Approval gates", gates === null ? "Unsupported — thiếu dữ liệu gate hợp lệ"
        : gates.join(", ") || "Không có gate khớp ID và SHA-256"],
    ])}
<pre class="evidence-preview">${escapeHtml(artifact.preview)}</pre>
${artifact.truncated ? "<p>Bản xem trước đã bị cắt do vượt giới hạn kích thước.</p>" : ""}</li>`;
  });
  return panel(evidence.items.every((item) => item === null) ? "unavailable" : "ready", `<ul class="approval-records">${rows.join("")}</ul>`
    + (evidence.limited ? `<p>Chỉ hiển thị ${ARTIFACT_ROW_LIMIT} artifact đầu tiên trong bundle.</p>` : ""));
}
