import type { DashboardClient } from "../dashboard-data/client.ts";
import { costAmountsUnsupportedMessage } from "../dashboard-data/mapping.ts";
import { facts } from "./router.ts";

type Result = Awaited<ReturnType<DashboardClient["getCostSessionSnapshot"]>>;
type State = "loading" | "empty" | "error" | "unsupported" | "access-denied" | "ready";

function panel(state: State, body: string): string {
  const id = state === "loading" ? "cost-session-loading" : "cost-session-result";
  return `<section id="${id}" data-state="${state}" aria-labelledby="${id}-heading">
<h2 id="${id}-heading">Cost session usage</h2>${body}</section>`;
}

export function costUsagePlaceholder(state: "loading" | "empty"): string {
  const message = state === "loading" ? "Đang tải…" :
    'Chưa chọn session. Hãy chọn một session ở <a href="#sessions-result">Session context</a>.';
  return panel(state, `<p role="status">${message}</p>`);
}

export function renderCostUsage(result: Result): string {
  if (result.kind === "error") {
    const error = result.error;
    if (error.kind === "data" && error.message === costAmountsUnsupportedMessage) {
      return panel("unsupported", '<p role="status">unsupported — thiếu số liệu chi phí hoặc giá trị vượt giới hạn số nguyên an toàn.</p>');
    }
    if (error.kind === "http" && error.status === 401) {
      return panel("access-denied", '<p role="status">Cần xác thực để xem cost session.</p>');
    }
    if (error.kind === "access-denied") {
      return panel("access-denied", '<p role="status">Bạn không có quyền truy cập cost session này.</p>');
    }
    if (error.kind === "bad-request") return panel("error", '<p role="status">Yêu cầu snapshot không hợp lệ.</p>');
    if (error.kind === "not-found") return panel("error", '<p role="status">Không tìm thấy snapshot cost session.</p>');
    return panel("error", '<p role="status">Không tải được snapshot cost session.</p>');
  }

  const { costSession, pipelineSessionId, fetchedAt } = result.data;
  if (costSession === null) return panel("empty", '<p role="status">Session chưa có cost session.</p>');

  const { cost_session_id, pipeline_session_id, session_cost_budget_micro_usd, cost_used_micro_usd } = costSession;
  const remaining = session_cost_budget_micro_usd - cost_used_micro_usd;
  const scope: [string, string][] = pipeline_session_id === pipelineSessionId
    ? [["Phạm vi", "Session đã chọn"], ["Session ID", pipelineSessionId]]
    : [["Phạm vi", "Cost session"]];
  return panel("ready", facts([
    ["Cost session ID", cost_session_id], ...scope,
    ["Đã dùng (micro-USD)", String(cost_used_micro_usd)],
    ["Ngân sách (micro-USD)", String(session_cost_budget_micro_usd)],
    ["Còn lại (micro-USD)", remaining < 0 ? `${remaining} (overrun)` : String(remaining)],
    ["Snapshot (fetchedAt)", fetchedAt],
  ]) + "<p>unsupported — API không cung cấp usage_estimated hoặc nguồn provider/model.</p>");
}

export async function loadCostUsage(client: DashboardClient, pipelineSessionId: string): Promise<string> {
  try {
    return renderCostUsage(await client.getCostSessionSnapshot(pipelineSessionId));
  } catch {
    return panel("error", '<p role="status">Không tải được snapshot cost session.</p>');
  }
}
