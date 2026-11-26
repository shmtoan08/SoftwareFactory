import { readTimestamp, type ProjectReadInput } from "./project-read-projection.ts";

export const TIMELINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TIMELINE_TYPES = [
  "session.created", "artifact.recorded", "gate.decided", "baseline.frozen",
  "change-request.submitted", "change-request.decided", "change-request.applied",
] as const;

type TimelineType = typeof TIMELINE_TYPES[number];

export interface TimelineAnchor {
  recordedAt: string;
  rank: number;
  resourceId: string;
}

export interface TimelineReadInput extends Omit<ProjectReadInput, "after"> {
  pipelineSessionId: string;
  after: TimelineAnchor | null;
}

export interface TimelineItem {
  type: TimelineType;
  recordedAt: string;
  resourceId: string;
  details: {
    artifactSha256?: string;
    decision?: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    targetArtifactId?: string;
    targetArtifactSha256?: string;
  };
}

export interface TimelineReadRows {
  fetchedAt: string;
  items: TimelineItem[];
}

export function assertTimelineAnchor(anchor: TimelineAnchor): void {
  if (!Number.isInteger(anchor.rank) || anchor.rank < 1 || anchor.rank > TIMELINE_TYPES.length
    || typeof anchor.resourceId !== "string" || !TIMELINE_UUID.test(anchor.resourceId)
    || readTimestamp(anchor.recordedAt) !== anchor.recordedAt) throw new Error("Invalid timeline boundary");
}

export function timelineAnchor(item: TimelineItem): TimelineAnchor {
  return { recordedAt: item.recordedAt, rank: TIMELINE_TYPES.indexOf(item.type) + 1, resourceId: item.resourceId };
}

export function compareTimeline(left: TimelineAnchor, right: TimelineAnchor): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt > right.recordedAt ? -1 : 1;
  if (left.rank !== right.rank) return right.rank - left.rank;
  return left.resourceId === right.resourceId ? 0 : left.resourceId > right.resourceId ? -1 : 1;
}

export function assertTimelineReadInput(input: TimelineReadInput): void {
  if (!TIMELINE_UUID.test(input.projectId) || !TIMELINE_UUID.test(input.pipelineSessionId)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("Invalid timeline read input");
  if (input.after) assertTimelineAnchor(input.after);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid timeline hash");
  return value;
}

export function timelineItem(type: TimelineType, time: unknown, id: unknown, row: {
  artifact_sha256?: unknown;
  decision?: unknown;
  target_artifact_id?: unknown;
  target_artifact_sha256?: unknown;
} = {}): TimelineItem {
  if (typeof time !== "string" || typeof id !== "string" || !TIMELINE_UUID.test(id)) throw new Error("Invalid timeline row");
  let details: TimelineItem["details"] = {};
  if (type === "artifact.recorded") details = { artifactSha256: hash(row.artifact_sha256) };
  if (type === "gate.decided") {
    const { decision, target_artifact_id } = row;
    if ((decision !== "APPROVED" && decision !== "REJECTED" && decision !== "REQUEST_CHANGES")
      || typeof target_artifact_id !== "string" || !TIMELINE_UUID.test(target_artifact_id)) throw new Error("Invalid timeline gate");
    details = { decision, targetArtifactId: target_artifact_id, targetArtifactSha256: hash(row.target_artifact_sha256) };
  }
  return { type, recordedAt: readTimestamp(time), resourceId: id, details };
}

const sources = [
  ["product_pipeline_sessions", "created_at", "pipeline_session_id", ""],
  ["stage_artifacts", "created_at", "artifact_id", ", artifact_sha256"],
  ["stage_approval_gates", "decided_at", "gate_id", ", decision, target_artifact_id, target_artifact_sha256"],
  ["baseline_spec_freezes", "frozen_at", "baseline_id", ""],
  ["change_requests", "created_at", "cr_id", ""],
  ["change_requests", "decided_at", "cr_id", ""],
  ["change_requests", "applied_at", "cr_id", ""],
] as const;

type TimelineQuery = { type: TimelineType; stage: string; sql: string; params: readonly (string | number)[] };

export function timelineQueries(input: TimelineReadInput): TimelineQuery[] {
  const { after, projectId, pipelineSessionId } = input;
  return sources.flatMap(([table, stamp, id, details], index) => {
    const query = (stage: string, boundary: string, params: readonly string[]): TimelineQuery => ({
      type: TIMELINE_TYPES[index]!,
      stage,
      sql: `SELECT to_char(${stamp} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
                 ${id} AS resource_id${details}
             FROM ${table} WHERE project_id=$1::uuid AND pipeline_session_id=$2::uuid AND ${stamp} IS NOT NULL
             ${boundary} ORDER BY ${stamp} DESC, ${id} DESC LIMIT $3::int;`,
      params: [projectId, pipelineSessionId, input.limit + 1, ...params],
    });
    if (!after) return [query("first", "", [])];
    const older = query(index + 1 < after.rank ? "at-or-older" : "older",
      `AND ${stamp} ${index + 1 < after.rank ? "<=" : "<"} $4::timestamptz`, [after.recordedAt]);
    if (index + 1 !== after.rank) return [older];
    return [
      query("equal", `AND ${stamp}=$4::timestamptz AND ${id}<$5::uuid`, [after.recordedAt, after.resourceId]),
      older,
    ];
  });
}
