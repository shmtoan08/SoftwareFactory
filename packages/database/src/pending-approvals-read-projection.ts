import { readTimestamp, type ProjectReadInput } from "./project-read-projection.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PendingApprovalBoundary {
  createdAt: string;
  rank: 0 | 1;
  id: string;
}

export interface PendingApprovalsReadInput extends Omit<ProjectReadInput, "after" | "cursorContextMismatch"> {
  after: PendingApprovalBoundary | null;
}

export type PendingApprovalItem =
  | { kind: "CHANGE_REQUEST"; cr_id: string; pipeline_session_id: string; baseline_id: string;
      cr_key: string; hash: string; title: string; status: "PENDING_APPROVAL"; created_at: string }
  | { kind: "MERGE_APPROVAL"; approval_request_id: string; task_id: string; merge_candidate_id: string;
      status: "PENDING"; created_at: string; expires_at: string };

export interface PendingApprovalsReadRows {
  fetchedAt: string;
  items: PendingApprovalItem[];
}

export function assertPendingApprovalsInput(input: PendingApprovalsReadInput): void {
  const { after, limit, projectId } = input;
  if (!uuid.test(projectId) || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isFinite(input.deadlineAt)) throw new Error("Invalid pending approvals input");
  if (after && ((after.rank !== 0 && after.rank !== 1) || !uuid.test(after.id)
    || readTimestamp(after.createdAt) !== after.createdAt)) throw new Error("Invalid pending approvals boundary");
}

export function pendingApprovalBoundary(item: PendingApprovalItem): PendingApprovalBoundary {
  return item.kind === "CHANGE_REQUEST"
    ? { createdAt: item.created_at, rank: 0, id: item.cr_id }
    : { createdAt: item.created_at, rank: 1, id: item.approval_request_id };
}

function descending(left: string, right: string): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

export function comparePendingApprovals(left: PendingApprovalBoundary, right: PendingApprovalBoundary): number {
  return descending(left.createdAt, right.createdAt) || left.rank - right.rank || descending(left.id, right.id);
}

export function pendingApprovalItem(rank: 0 | 1, row: Record<string, unknown>): PendingApprovalItem {
  const field = (key: string): string => {
    const value = row[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid pending approval field: ${key}`);
    return value;
  };
  const id = (key: string): string => {
    const value = field(key);
    if (!uuid.test(value)) throw new Error(`Invalid pending approval UUID: ${key}`);
    return value;
  };
  const created_at = readTimestamp(field("created_at"));
  if (rank === 0) {
    const hash = field("cr_sha256");
    if (row.status !== "PENDING_APPROVAL" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid pending change request");
    return {
      kind: "CHANGE_REQUEST", cr_id: id("cr_id"), pipeline_session_id: id("pipeline_session_id"),
      baseline_id: id("baseline_id"), cr_key: field("cr_key"), hash, title: field("title"),
      status: "PENDING_APPROVAL", created_at,
    };
  }
  const expires_at = readTimestamp(field("expires_at"));
  if (row.status !== "PENDING" || expires_at <= created_at) throw new Error("Invalid pending merge approval");
  return {
    kind: "MERGE_APPROVAL", approval_request_id: id("approval_request_id"),
    task_id: id("task_id"), merge_candidate_id: id("merge_candidate_id"),
    status: "PENDING", created_at, expires_at,
  };
}

const sources = [
  {
    table: "change_requests", id: "cr_id", status: "PENDING_APPROVAL",
    fields: "cr_id, pipeline_session_id, baseline_id, cr_key, cr_sha256, title, status",
  },
  {
    table: "approval_requests", id: "approval_request_id", status: "PENDING",
    fields: `approval_request_id, task_id, merge_candidate_id, status,
      to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at`,
  },
] as const;

type Execute = (sql: string, params: readonly (number | string)[]) => Promise<readonly Record<string, unknown>[]>;

export async function readPendingApprovalCandidates(
  input: PendingApprovalsReadInput, snapshotAt: string, execute: Execute,
): Promise<PendingApprovalsReadRows> {
  const fetchedAt = readTimestamp(snapshotAt);
  const size = input.limit + 1;

  const readSource = async (rank: 0 | 1) => {
    const { table, id, status, fields } = sources[rank];
    const items: PendingApprovalItem[] = [];
    let boundary = input.after;
    while (items.length < size) {
      const select = async (predicate: string, keys: string[]) => {
        if (Date.now() >= input.deadlineAt) throw new Error("Pending approvals read deadline exceeded");
        const rows = await execute(
          `SELECT ${fields}, to_char(${table}.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
           FROM ${table} WHERE project_id=$1::uuid AND status='${status}'
           ${predicate} ORDER BY ${table}.created_at DESC, ${id} DESC LIMIT $2::int;`,
          [input.projectId, size, ...keys],
        );
        if (rows.length > size) throw new Error("Invalid pending approval row bound");
        for (const row of rows) {
          const item = pendingApprovalItem(rank, row);
          const next = pendingApprovalBoundary(item);
          if (boundary && comparePendingApprovals(boundary, next) >= 0) throw new Error("Invalid pending approval ordering");
          boundary = next;
          if (item.kind === "CHANGE_REQUEST" || item.expires_at > fetchedAt) {
            items.push(item);
            if (items.length === size) break;
          }
        }
        return rows.length;
      };

      const start = boundary;
      if (!start) {
        if (await select("", []) < size) break;
      } else if (rank === start.rank) {
        const same = await select(`AND ${table}.created_at=$3::timestamptz AND ${id}<$4::uuid`, [start.createdAt, start.id]);
        if (items.length === size) break;
        if (same < size && await select(`AND ${table}.created_at<$3::timestamptz`, [start.createdAt]) < size) break;
      } else {
        const operator = rank > start.rank ? "<=" : "<";
        if (await select(`AND ${table}.created_at${operator}$3::timestamptz`, [start.createdAt]) < size) break;
      }
    }
    return items;
  };

  const changes = await readSource(0);
  const approvals = await readSource(1);
  const items = changes.concat(approvals)
    .sort((left, right) => comparePendingApprovals(pendingApprovalBoundary(left), pendingApprovalBoundary(right)))
    .slice(0, size);
  return { fetchedAt, items };
}
