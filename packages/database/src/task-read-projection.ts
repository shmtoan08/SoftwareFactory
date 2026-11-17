import { STATE_TRANSITION_MATRIX, type TaskStatus } from "@software-factory/shared-types";
import { readTimestamp, type ProjectReadInput } from "./project-read-projection.ts";
export const TASK_READ_STATUSES = Object.keys(STATE_TRANSITION_MATRIX) as TaskStatus[];
export interface TaskReadInput extends ProjectReadInput { sessionId: string; sourceStatuses: readonly TaskStatus[]; }
export interface TaskReadDto {
  taskId: string; projectId: string; sessionId: string; title: string; sourceStatus: TaskStatus;
  currentAttemptNo: number; reworkCount: number; maxReworkCycles: number; activeLeaseEpoch: string;
  assigneeId: string | null; leaseOwnerId: string | null; leaseExpiresAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface TaskReadRows { fetchedAt: string; tasks: TaskReadDto[]; }
export const TASK_READ_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Fail closed on source corruption; construct a new allowlisted object, never return a TaskRecord. */
export function taskReadDto(row: TaskReadDto, input: Pick<TaskReadInput, "projectId" | "sessionId">): TaskReadDto {
  if (row.projectId !== input.projectId || row.sessionId !== input.sessionId || !TASK_READ_UUID.test(row.taskId) || !TASK_READ_STATUSES.includes(row.sourceStatus) || typeof row.title !== "string" || Buffer.byteLength(row.title) > 1048576) throw new Error("Invalid task projection source");
  for (const value of [row.currentAttemptNo, row.reworkCount, row.maxReworkCycles]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid task counter");
  if (row.maxReworkCycles < 1 || typeof row.activeLeaseEpoch !== "string" || !/^(0|[1-9][0-9]*)$/.test(row.activeLeaseEpoch)) throw new Error("Invalid task epoch");
  if (row.assigneeId !== null && (typeof row.assigneeId !== "string" || !TASK_READ_UUID.test(row.assigneeId))) throw new Error("Invalid task assignee");
  if ((row.leaseOwnerId === null) !== (row.leaseExpiresAt === null) || (row.leaseOwnerId !== null && (typeof row.leaseOwnerId !== "string" || !row.leaseOwnerId))) throw new Error("Invalid task lease");
  return { taskId: row.taskId, projectId: row.projectId, sessionId: row.sessionId, title: row.title, sourceStatus: row.sourceStatus,
    currentAttemptNo: row.currentAttemptNo, reworkCount: row.reworkCount, maxReworkCycles: row.maxReworkCycles, activeLeaseEpoch: row.activeLeaseEpoch,
    assigneeId: row.assigneeId, leaseOwnerId: row.leaseOwnerId, leaseExpiresAt: row.leaseExpiresAt === null ? null : readTimestamp(row.leaseExpiresAt), createdAt: readTimestamp(row.createdAt), updatedAt: readTimestamp(row.updatedAt) };
}
