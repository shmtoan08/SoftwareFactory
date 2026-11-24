import type { DashboardClient, DashboardResult } from "../dashboard-data/client.ts";
import { recordedTimestamp } from "../dashboard-data/mapping.ts";
import { facts } from "./router.ts";
import type { TasksResult } from "./tasks.ts";

type Budget = Awaited<ReturnType<DashboardClient["getBudgetSnapshot"]>>;
type Bundle = Awaited<ReturnType<DashboardClient["getApprovalEvidence"]>>;
type Changes = Awaited<ReturnType<DashboardClient["listApprovalChangeRequests"]>>;
type Fact = readonly [label: string, resourceId: string, at: string | null];
type Snapshot = { budget: Budget; session?: { id: string; bundle: Bundle; tasks: TasksResult; changes: Changes } };

const banner = "Not a complete audit trail; assembled from separate snapshots, no global ordering.";

function status(message: string): string {
  return `<p role="status">${message}</p>`;
}

function panel(state: "loading" | "ready" | "empty" | "error" | "access-denied", body: string): string {
  const id = state === "loading" ? "timeline-loading" : "timeline-result";
  return `<section id="${id}" data-state="${state}" aria-labelledby="${id}-heading">
<h2 id="${id}-heading">Recorded resource activity</h2>
<p>${banner}</p>${body}</section>`;
}

export function timelinePlaceholder(state: "loading" | "error" | "access-denied"): string {
  const message = state === "loading" ? "Đang tải…" : state === "access-denied"
    ? "Bạn không có quyền truy cập dữ liệu này." : "Không tải được dữ liệu.";
  return panel(state, status(message));
}

function reader<T>(
  name: string, result: DashboardResult<T>, select: (data: T) => {
    rows: Fact[]; partial?: boolean;
  },
): string {
  const heading = `<h4>${name}</h4>`;
  if (result.kind === "error") {
    const { error } = result;
    const denied = "status" in error && (error.status === 401 || error.status === 403);
    return heading + status(denied ? "Bạn không có quyền truy cập nguồn này."
      : error.kind === "data" ? "Unsupported — dữ liệu nguồn thiếu hoặc không hợp lệ." : "Không tải được nguồn này.");
  }
  const { rows, partial } = select(result.data);
  const items = new Map<string, { row: readonly [string, string, string]; conflict: boolean }>();
  let incomplete = partial ?? false;
  for (const row of rows) {
    const [label, id, at] = row;
    if (at === null) {
      incomplete = true;
      continue;
    }
    const key = JSON.stringify([label, id]);
    const previous = items.get(key);
    items.set(key, { row: [label, id, at], conflict: !!previous && (previous.conflict || previous.row[2] !== at) });
  }
  const ordered = [...items.entries()].sort(([keyA, { row: [, , a] }], [keyB, { row: [, , b] }]) =>
    a.replace(/Z$/, "").padEnd(26, "0").localeCompare(b.replace(/Z$/, "").padEnd(26, "0"))
      || keyA.localeCompare(keyB),
  );
  const rendered = ordered.map(([, { row: [label, id, at], conflict }]) => {
    if (conflict) {
      incomplete = true;
      return "";
    }
    return `<li>${facts([["Fact", label], ["Bản ghi", id], ["Mốc đã ghi", at],
      ["Nguồn", name], ["Tải lúc", result.receivedAt]])}</li>`;
  }).join("");
  return heading + (rendered ? `<ul class="approval-records">${rendered}</ul>` : status("Không có activity fact."))
    + (incomplete ? status("Unsupported — một phần dữ liệu bị giới hạn, thiếu hoặc mâu thuẫn.") : "");
}

export function renderTimeline(projectId: string, { budget, session }: Snapshot): string {
  const gateFacts = (data: Extract<Bundle, { data: unknown }>["data"]): Fact[] =>
    (data.approvals?.decisions ?? []).filter((gate) => gate.sessionId === session?.id && gate.decision !== null)
      .map((gate) => ["Gate decision recorded", gate.gateId, recordedTimestamp(gate.decidedAt)]);
  const selected = session ? reader("R0 bundle", session.bundle, (data) => {
    const { id } = session;
    if (data.session?.id !== id) return { rows: [], partial: true };
    const rows: Fact[] = [["Session created", data.session.id, data.session.createdAt], ...gateFacts(data)];
    for (const artifact of data.evidence?.items ?? []) {
      if (artifact !== null) rows.push(["Artifact recorded", artifact.id, artifact.createdAt]);
    }
    if (data.cost?.sessionId === id) rows.push(["Cost session record updated", data.cost.id, data.cost.updatedAt]);
    return { rows, partial: !data.approvals || !data.evidence || data.evidence.limited
      || data.evidence.items.includes(null) || data.cost === undefined };
  }) + reader("P3 task page", session.tasks, (data) => ({
    rows: data.items.filter((task) => task.projectId === projectId && task.sessionId === session.id)
      .flatMap((task): Fact[] => [
        ["Task created", task.taskId, task.createdAt], ["Task record updated", task.taskId, task.updatedAt],
      ]),
    partial: data.page.hasMore,
  })) + reader("R0 change requests", session.changes, (data) => ({
    rows: data.requests.filter((cr) => cr.sessionId === session.id)
      .map((cr) => ["Change request created", cr.id, cr.createdAt]),
  })) : status("Chưa chọn session.");

  const project = reader("P2 budget snapshot", budget, (data) => ({
    rows: data.projectId === projectId ? [["Project budget snapshot", projectId, data.fetchedAt]] : [],
  })) + (session && session.bundle.kind !== "error" && session.bundle.data.cost?.sessionId === null
    ? reader("R0 bundle", session.bundle, ({ cost }) => ({
      rows: cost?.sessionId === null ? [["Cost session record updated", cost.id, cost.updatedAt]] : [],
    })) : "");

  return panel(session || budget.kind === "ok" ? "ready" : budget.kind === "error" ? "error" : "empty",
    `<p>Within each reader: sorted by recorded timestamp, sources independent.</p>
<section aria-label="Session scope"><h3>Session scope</h3>${selected}</section>
<section aria-label="Project scope"><h3>Project scope</h3>${project}</section>`);
}
