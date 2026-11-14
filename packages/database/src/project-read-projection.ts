import { PostgresRlsError, type ProjectMemberRole } from "./types.ts";
export interface ProjectReadDto {
  projectId: string; slug: string; name: string; defaultBranch: string;
  createdAt: string; updatedAt: string;
}
export interface ProjectReadInput {
  projectId: string; principalId: string; signedRoles: readonly ProjectMemberRole[];
  cursorContextMismatch: boolean; deadlineAt: number;
  limit: number; after: { updatedAt: string; id: string } | null;
}
export interface ProjectReadRows { fetchedAt: string; projects: ProjectReadDto[]; }
export const PROJECT_READ_ROLES: readonly ProjectMemberRole[] = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"];
export function assertProjectReadRole(role: unknown, roles: readonly ProjectMemberRole[]): void {
  if (!PROJECT_READ_ROLES.includes(role as ProjectMemberRole) || !roles.includes(role as ProjectMemberRole)) throw new PostgresRlsError("42501", "Project read denied");
}
export function readTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(value) || (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace(/(\.\d{3})\d{3}Z$/, "$1Z"))) throw new Error("Invalid projection timestamp");
  return value.replace(/\.(\d{3})Z$/, (_match, ms: string) => `.${ms}000Z`);
}

export class ProjectReadCursorContextError extends Error {}
