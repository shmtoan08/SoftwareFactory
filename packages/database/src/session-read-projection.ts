import { readTimestamp, type ProjectReadInput } from "./project-read-projection.ts";

export interface SessionReadInput extends Omit<ProjectReadInput, "after" | "cursorContextMismatch"> {
  cursorContextMismatch?: boolean;
  after: { createdAt: string; pipelineSessionId: string } | null;
}

export interface SessionReadRow {
  pipeline_session_id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface SessionReadRows {
  fetchedAt: string;
  /** At most limit + 1 rows, including the probe row when present. */
  sessions: SessionReadRow[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertSessionReadInput(input: SessionReadInput): void {
  if (!uuid.test(input.projectId) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.after && (!uuid.test(input.after.pipelineSessionId)
      || readTimestamp(input.after.createdAt) !== input.after.createdAt))) {
    throw new Error("Invalid session projection input");
  }
}

export function sessionReadRow(row: Record<keyof SessionReadRow, unknown>, projectId: string): SessionReadRow {
  const { pipeline_session_id, project_id, title, created_at, updated_at } = row;
  if (typeof pipeline_session_id !== "string" || !uuid.test(pipeline_session_id) || project_id !== projectId
    || typeof title !== "string" || typeof created_at !== "string" || typeof updated_at !== "string") {
    throw new Error("Invalid session projection row");
  }
  return { pipeline_session_id, project_id, title, created_at: readTimestamp(created_at),
    updated_at: readTimestamp(updated_at) };
}
