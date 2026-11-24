import { DashboardClient } from "../dashboard-data/client.ts";
import { facts } from "./router.ts";
import { refreshablePanel } from "./panel-refresh.ts";

type BudgetResult = Awaited<ReturnType<DashboardClient["getBudgetSnapshot"]>>;
type BudgetSnapshot = Extract<BudgetResult, { data: unknown }>["data"];

const missing = "Không có dữ liệu";
const missingValue = (value: string | null) => value ?? missing;

function budgetState(state: "loading" | "empty" | "error" | "access-denied"): string {
  const messages = {
    loading: "Đang tải…",
    empty: missing + ".",
    error: "Không tải được dữ liệu.",
    "access-denied": "Bạn không có quyền truy cập dữ liệu này.",
  };
  return `<p data-state="${state}">${messages[state]}</p>`;
}

export function budgetPanelPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/dashboard-budget`;
}

export function budgetLoadingPanel(): string {
  return `<section id="budget-loading" aria-labelledby="budget-loading-heading"><h2 id="budget-loading-heading">Budget</h2>
<div role="status">${budgetState("loading")}</div></section>`;
}

export function budgetPanel(projectId: string, body: string): string {
  return refreshablePanel("budget-panel", "Budget", budgetPanelPath(projectId), body);
}

function dimension(heading: string, data: BudgetSnapshot["dimensions"][keyof BudgetSnapshot["dimensions"]]): string {
  return `<div><h3>${heading}</h3>${facts([
    ["Đơn vị", data.unit], ["Loại giới hạn", data.limitKind], ["Giới hạn", missingValue(data.limit)],
    ["Đã dùng", data.consumed], ["Còn lại", missingValue(data.remaining)],
  ])}</div>`;
}

export function renderBudget(result: BudgetResult): string {
  if (result.kind === "empty") return budgetState("empty");
  if (result.kind === "error") {
    if (result.error.kind === "access-denied" || ("status" in result.error && result.error.status === 401)) {
      return budgetState("access-denied");
    }
    return budgetState(result.error.kind === "not-found" ? "empty" : "error");
  }

  const { dimensions, policy, recoveryState, recoveryReason, recoveryScope, usageSemantics,
    estimatedModelUsageIncluded, fetchedAt } = result.data;
  return `<div data-state="ready">
${facts([["Tải lúc", result.receivedAt], ["Snapshot (fetchedAt)", fetchedAt], ["Recovery state", recoveryState]])}
<div class="budget-dimensions">
${dimension("Token", dimensions.tokens)}
${dimension("Chi phí", dimensions.costMicroUsd)}
${dimension("Thời gian thực thi", dimensions.wallTimeMs)}
</div>
<details><summary>Thông tin snapshot</summary>
${facts([
  ["Trạng thái policy", policy?.status ?? missing], ["Policy cập nhật lúc", policy?.updatedAt ?? missing],
  ["Recovery reason", recoveryReason], ["Recovery scope", recoveryScope],
  ["Nguồn usage", usageSemantics], ["Có usage ước tính", estimatedModelUsageIncluded ? "Có" : "Không"],
])}
</details></div>`;
}

export async function loadBudgetBody(
  projectId: string, authToken: string | undefined, baseUrl: string | undefined,
): Promise<string> {
  if (!authToken) return budgetState("access-denied");
  if (!baseUrl) return budgetState("error");
  try {
    const client = new DashboardClient({ baseUrl, projectId, authToken, timeoutMs: 7000 });
    return renderBudget(await client.getBudgetSnapshot());
  } catch {
    return budgetState("error");
  }
}
