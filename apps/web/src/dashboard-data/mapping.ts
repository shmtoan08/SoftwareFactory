// Field allowlists and source semantics are defined in docs/data-mapping-spec.md §§1–4.
export class DashboardDataError extends Error {
  constructor(field: string) {
    super(`Invalid dashboard response field: ${field}`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DashboardDataError(field);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new DashboardDataError(field);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DashboardDataError(field);
  return value;
}

function literal<const T extends string>(value: unknown, field: string, ...allowed: T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new DashboardDataError(field);
  return match;
}

function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DashboardDataError(field);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(text)
    || !Number.isFinite(Date.parse(text))
    || new Date(text).toISOString() !== text.replace(/(\.\d{3})\d{3}Z$/, "$1Z")) {
    throw new DashboardDataError(field);
  }
  return text;
}

export function requireId(value: unknown, field: string): string {
  const text = string(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    throw new DashboardDataError(field);
  }
  return text;
}

function scope(value: unknown, expected: string, field: string): string {
  if (requireId(value, field) !== expected) throw new DashboardDataError(field);
  return expected;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new DashboardDataError(field);
  return value;
}

function decimal(value: unknown, field: string, signed = false): string {
  const text = string(value, field);
  const pattern = signed ? /^(0|-?[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/;
  if (!pattern.test(text)) throw new DashboardDataError(field);
  return text;
}

function metadata(dto: Record<string, unknown>) {
  return {
    schemaVersion: literal(dto.schemaVersion, "schemaVersion", "dashboard-read-v1"),
    fetchedAt: timestamp(dto.fetchedAt, "fetchedAt"),
  };
}

function page(value: unknown) {
  const dto = record(value, "page");
  const limit = integer(dto.limit, "page.limit", 1, 100);
  const hasMore = boolean(dto.hasMore, "page.hasMore");
  const nextCursor = dto.nextCursor === null ? null : string(dto.nextCursor, "page.nextCursor");
  if (hasMore !== Boolean(nextCursor) || nextCursor === "") {
    throw new DashboardDataError("page.nextCursor");
  }
  return { limit, hasMore, nextCursor };
}

function project(value: unknown, projectId: string) {
  const dto = record(value, "project");
  return {
    projectId: scope(dto.projectId, projectId, "project.projectId"),
    slug: string(dto.slug, "slug"),
    name: string(dto.name, "name"),
    defaultBranch: string(dto.defaultBranch, "defaultBranch"),
    createdAt: timestamp(dto.createdAt, "createdAt"),
    updatedAt: timestamp(dto.updatedAt, "updatedAt"),
  };
}

export function mapProjectList(value: unknown, projectId: string) {
  const dto = record(value, "project list");
  const source = record(dto.scope, "scope");
  return {
    ...metadata(dto),
    scope: {
      kind: literal(source.kind, "scope.kind", "project-token"),
      projectId: scope(source.projectId, projectId, "scope.projectId"),
    },
    items: list(dto.items, "items").map((item) => project(item, projectId)),
    page: page(dto.page),
  };
}

export function mapProjectDetail(value: unknown, projectId: string) {
  const dto = record(value, "project detail");
  return { ...metadata(dto), project: project(dto.project, projectId) };
}

function policy(value: unknown) {
  if (value === null) return null;
  const dto = record(value, "policy");
  return {
    status: literal(dto.status, "policy.status", "ACTIVE", "AUTO_PAUSED"),
    updatedAt: timestamp(dto.updatedAt, "policy.updatedAt"),
  };
}

function dimension<T extends string>(value: unknown, unit: T, policyPresent: boolean) {
  const dto = record(value, "dimension");
  const limitKind = literal(dto.limitKind, "limitKind", "configured", "unbounded", "policy-absent");
  const limit = dto.limit === null ? null : decimal(dto.limit, "limit");
  const remaining = dto.remaining === null ? null : decimal(dto.remaining, "remaining", true);
  if ((limitKind !== "policy-absent") !== policyPresent
    || (limitKind === "configured" ? limit === null || limit === "0" || remaining === null
      : limit !== null || remaining !== null)) {
    throw new DashboardDataError("limitKind");
  }
  return {
    unit: literal(dto.unit, "unit", unit),
    limitKind,
    limit,
    consumed: decimal(dto.consumed, "consumed"),
    remaining,
  };
}

export function mapBudgetSnapshot(value: unknown, projectId: string) {
  const dto = record(value, "budget snapshot");
  const budgetPolicy = policy(dto.policy);
  const dimensions = record(dto.dimensions, "dimensions");
  const recoveryState = dto.recoveryState === "clear" || dto.recoveryState === "pending"
    ? dto.recoveryState : "unknown" as const;
  return {
    ...metadata(dto),
    projectId: scope(dto.projectId, projectId, "projectId"),
    policy: budgetPolicy,
    dimensions: {
      tokens: dimension(dimensions.tokens, "tokens", budgetPolicy !== null),
      costMicroUsd: dimension(dimensions.costMicroUsd, "micro_usd", budgetPolicy !== null),
      wallTimeMs: dimension(dimensions.wallTimeMs, "milliseconds", budgetPolicy !== null),
    },
    estimatedModelUsageIncluded: boolean(dto.estimatedModelUsageIncluded, "estimatedModelUsageIncluded"),
    recoveryState,
    recoveryReason: literal(dto.recoveryReason, "recoveryReason",
      "no-visible-pending-intent", "visible-pending-intent", "journal-not-modeled"),
    recoveryScope: literal(dto.recoveryScope, "recoveryScope", "visible-project-budget-denial-intents-at-snapshot"),
    usageSemantics: literal(dto.usageSemantics, "usageSemantics", "recorded-project-ledgers-and-resource-metrics"),
  };
}

function task(value: unknown, projectId: string, sessionId: string) {
  const dto = record(value, "task");
  const leaseOwnerId = dto.leaseOwnerId === null ? null : string(dto.leaseOwnerId, "leaseOwnerId");
  const leaseExpiresAt = dto.leaseExpiresAt === null ? null : timestamp(dto.leaseExpiresAt, "leaseExpiresAt");
  if (leaseOwnerId === "" || (leaseOwnerId === null) !== (leaseExpiresAt === null)) {
    throw new DashboardDataError("lease");
  }
  return {
    taskId: requireId(dto.taskId, "taskId"),
    projectId: scope(dto.projectId, projectId, "task.projectId"),
    sessionId: scope(dto.sessionId, sessionId, "task.sessionId"),
    title: string(dto.title, "title"),
    sourceStatus: string(dto.sourceStatus, "sourceStatus"),
    currentAttemptNo: integer(dto.currentAttemptNo, "currentAttemptNo"),
    reworkCount: integer(dto.reworkCount, "reworkCount"),
    maxReworkCycles: integer(dto.maxReworkCycles, "maxReworkCycles", 1),
    activeLeaseEpoch: decimal(dto.activeLeaseEpoch, "activeLeaseEpoch"),
    assigneeId: dto.assigneeId === null ? null : requireId(dto.assigneeId, "assigneeId"),
    leaseOwnerId,
    leaseExpiresAt,
    createdAt: timestamp(dto.createdAt, "createdAt"),
    updatedAt: timestamp(dto.updatedAt, "updatedAt"),
  };
}

export function mapSessionTasks(value: unknown, projectId: string, sessionId: string) {
  const dto = record(value, "session tasks");
  const filters = record(dto.filters, "filters");
  if (filters.stage !== null) throw new DashboardDataError("filters.stage");
  return {
    ...metadata(dto),
    projectId: scope(dto.projectId, projectId, "projectId"),
    sessionId: scope(dto.sessionId, sessionId, "sessionId"),
    filters: {
      sourceStatuses: list(filters.sourceStatuses, "filters.sourceStatuses")
        .map((status) => string(status, "filters.sourceStatuses")),
      stage: filters.stage,
    },
    items: list(dto.items, "items").map((item) => task(item, projectId, sessionId)),
    page: page(dto.page),
  };
}

export interface SessionDto {
  pipelineSessionId: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionListDto {
  schemaVersion: "dashboard-read-v1";
  fetchedAt: string;
  projectId: string;
  items: SessionDto[];
  page: ReturnType<typeof page>;
}

function exactKeys(dto: Record<string, unknown>, field: string, keys: readonly string[]): void {
  if (Object.keys(dto).length !== keys.length || keys.some((key) => !Object.hasOwn(dto, key))) {
    throw new DashboardDataError(field);
  }
}

// Issue #24 S2 defines the session list envelope and its exhaustive field allowlist.
export function mapSessions(value: unknown, projectId: string): SessionListDto {
  const dto = record(value, "session list");
  exactKeys(dto, "session list", ["schemaVersion", "fetchedAt", "projectId", "items", "page"]);
  const pageDto = record(dto.page, "page");
  exactKeys(pageDto, "page", ["limit", "hasMore", "nextCursor"]);
  return {
    ...metadata(dto),
    projectId: scope(dto.projectId, projectId, "projectId"),
    items: list(dto.items, "items").map((value): SessionDto => {
      const item = record(value, "session");
      exactKeys(item, "session", ["pipelineSessionId", "projectId", "title", "createdAt", "updatedAt"]);
      return {
        pipelineSessionId: requireId(item.pipelineSessionId, "pipelineSessionId"),
        projectId: scope(item.projectId, projectId, "session.projectId"),
        title: string(item.title, "title"),
        createdAt: timestamp(item.createdAt, "createdAt"),
        updatedAt: timestamp(item.updatedAt, "updatedAt"),
      };
    }),
    page: page(pageDto),
  };
}

export const agentProfileRoles = ["PLANNER", "DEVELOPER", "REVIEWER_READONLY", "VERIFIER"] as const;
export type AgentProfileRole = typeof agentProfileRoles[number];

export interface AgentProfileConfig {
  principal: string;
  provider: string;
  model: string;
  role: AgentProfileRole;
  is_active: boolean;
}

export function mapAgentProfiles(value: unknown, projectId: string): { profiles: AgentProfileConfig[] } {
  const dto = record(value, "agent profile list");
  return { profiles: list(dto.profiles, "profiles").map((value) => {
    const profile = record(value, "profile");
    scope(profile.project_id, projectId, "profile.project_id");
    return {
      principal: string(profile.principal_id, "profile.principal_id"),
      provider: string(profile.provider, "profile.provider"),
      model: string(profile.model, "profile.model"),
      role: literal(profile.role, "profile.role", ...agentProfileRoles),
      is_active: boolean(profile.is_active, "profile.is_active"),
    };
  }) };
}
