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

export function mapTaskAssignment(value: unknown, projectId: string, taskId: string) {
  const dto = record(value, "task assignment");
  scope(dto.project_id, projectId, "assignment.project_id");
  scope(dto.task_id, taskId, "assignment.task_id");
  return {
    assignmentId: string(dto.assignment_id, "assignment.assignment_id"),
    profileId: string(dto.profile_id, "assignment.profile_id"),
    workerId: string(dto.worker_id, "assignment.worker_id"),
    createdAt: string(dto.created_at, "assignment.created_at"),
  };
}

export function mapTaskDispatches(value: unknown, projectId: string, taskId: string) {
  const dto = record(value, "task dispatches");
  return { dispatches: list(dto.dispatches, "dispatches").map((value) => {
    const dispatch = record(value, "dispatch");
    scope(dispatch.project_id, projectId, "dispatch.project_id");
    scope(dispatch.task_id, taskId, "dispatch.task_id");
    return {
      requestId: string(dispatch.execution_request_id, "dispatch.execution_request_id"),
      status: literal(dispatch.status, "dispatch.status", "PENDING", "SENDING", "IMPORTED", "UNKNOWN", "REJECTED"),
      claimedAt: dispatch.claimed_at === null ? null : string(dispatch.claimed_at, "dispatch.claimed_at"),
      completedAt: dispatch.completed_at === null ? null : string(dispatch.completed_at, "dispatch.completed_at"),
    };
  }) };
}

const costAmountField = "costSession amounts";
export const costAmountsUnsupportedMessage = new DashboardDataError(costAmountField).message;

function costInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new DashboardDataError(costAmountField);
  }
  return value;
}

// Issue #25 S0 specifies the exact snapshot envelope and cost record.
export function mapCostSessionSnapshot(value: unknown, projectId: string, pipelineSessionId: string) {
  const dto = record(value, "cost snapshot");
  exactKeys(dto, "cost snapshot", ["schemaVersion", "fetchedAt", "projectId", "pipelineSessionId", "costSession"]);
  const envelope = {
    ...metadata(dto),
    projectId: scope(dto.projectId, projectId, "projectId"),
    pipelineSessionId: scope(dto.pipelineSessionId, pipelineSessionId, "pipelineSessionId"),
  };
  if (dto.costSession === null) return { ...envelope, costSession: null };

  const cost = record(dto.costSession, "costSession");
  const costSession = {
    cost_session_id: requireId(cost.cost_session_id, "cost_session_id"),
    pipeline_session_id: cost.pipeline_session_id === null ? null : requireId(cost.pipeline_session_id, "pipeline_session_id"),
    session_cost_budget_micro_usd: costInteger(cost.session_cost_budget_micro_usd),
    cost_used_micro_usd: costInteger(cost.cost_used_micro_usd),
    tokens_used_total: costInteger(cost.tokens_used_total),
    session_token_budget: costInteger(cost.session_token_budget, 1),
    status: literal(cost.status, "costSession.status", "ACTIVE", "EXHAUSTED", "CLOSED"),
  };
  exactKeys(cost, "costSession", Object.keys(costSession));
  return { ...envelope, costSession };
}

function artifactHash(value: unknown, field: string): string {
  const hash = string(value, field);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new DashboardDataError(field);
  return hash;
}

export function mapApprovalDecisions(value: unknown, projectId: string, sessionId: string) {
  const dto = record(value, "pipeline bundle");
  const session = record(dto.session, "session");
  scope(session.project_id, projectId, "session.project_id");
  scope(session.pipeline_session_id, sessionId, "session.pipeline_session_id");

  // Only artifact identity is needed to verify a gate's exact binding.
  const bindings = new Set(list(dto.artifacts, "artifacts").map((value) => {
    const artifact = record(value, "artifact binding");
    scope(artifact.project_id, projectId, "artifact.project_id");
    scope(artifact.pipeline_session_id, sessionId, "artifact.pipeline_session_id");
    return JSON.stringify([
      string(artifact.artifact_id, "artifact_id"),
      artifactHash(artifact.artifact_sha256, "artifact_sha256"),
    ]);
  }));

  return { decisions: list(dto.approvalGates, "approvalGates").map((value) => {
    const gate = record(value, "approval gate");
    scope(gate.project_id, projectId, "gate.project_id");
    const targetArtifactId = string(gate.target_artifact_id, "target_artifact_id");
    const targetArtifactHash = artifactHash(gate.target_artifact_sha256, "target_artifact_sha256");
    return {
      sessionId: scope(gate.pipeline_session_id, sessionId, "gate.pipeline_session_id"),
      gateId: string(gate.gate_id, "gate_id"),
      gate: literal(gate.gate_stage, "gate_stage", "STAGE_1_DISCOVERY", "STAGE_2_REQUIREMENTS", "STAGE_3_ARCHITECTURE", "STAGE_4_SPEC_FREEZE"),
      targetArtifactId, targetArtifactHash,
      bindingMatches: bindings.has(JSON.stringify([targetArtifactId, targetArtifactHash])),
      decision: gate.decision === null || gate.decision === undefined ? null :
        literal(gate.decision, "decision", "APPROVED", "REJECTED", "REQUEST_CHANGES"),
      rationale: gate.rationale === null ? null : string(gate.rationale, "rationale"),
      approver: string(gate.approver_principal_id, "approver_principal_id"),
      decidedAt: string(gate.decided_at, "decided_at"),
    };
  }) };
}

export const ARTIFACT_ROW_LIMIT = 50;
const ARTIFACT_PREVIEW_LIMIT = 4096;

export function mapApprovalEvidence(value: unknown, projectId: string, sessionId: string) {
  const bundle = record(value, "pipeline bundle");
  const session = record(bundle.session, "session");
  scope(session.project_id, projectId, "session.project_id");
  scope(session.pipeline_session_id, sessionId, "session.pipeline_session_id");

  let approvals: ReturnType<typeof mapApprovalDecisions> | null;
  try {
    approvals = mapApprovalDecisions(bundle, projectId, sessionId);
  } catch (error) {
    if (!(error instanceof DashboardDataError)) throw error;
    approvals = null;
  }

  const artifacts = Array.isArray(bundle.artifacts) ? bundle.artifacts : null;
  const evidence = artifacts === null ? null : {
    limited: artifacts.length > ARTIFACT_ROW_LIMIT,
    items: artifacts.slice(0, ARTIFACT_ROW_LIMIT).map((value: unknown) => {
      try {
        const artifact = record(value, "artifact");
        scope(artifact.project_id, projectId, "artifact.project_id");
        scope(artifact.pipeline_session_id, sessionId, "artifact.pipeline_session_id");
        const id = requireId(artifact.artifact_id, "artifact_id");
        const hash = artifactHash(artifact.artifact_sha256, "artifact_sha256");
        const kind = literal(artifact.artifact_kind, "artifact_kind",
          "STAGE_1_DISCOVERY_BUNDLE", "STAGE_2_PRD_SRS", "STAGE_3_ARCHITECTURE_DESIGN", "STAGE_4_VALIDATION_REPORT");
        const stage = literal(artifact.stage, "stage",
          "STAGE_1_IDEA_DISCOVERY", "STAGE_2_REQUIREMENTS", "STAGE_3_ARCHITECTURE", "STAGE_4_SPEC_FREEZE");
        const content = JSON.stringify(record(artifact.content_json, "content_json"));
        return {
          id, hash, kind, stage,
          preview: content.slice(0, ARTIFACT_PREVIEW_LIMIT),
          truncated: content.length > ARTIFACT_PREVIEW_LIMIT,
          gates: approvals?.decisions.filter((gate) => gate.targetArtifactId === id && gate.targetArtifactHash === hash)
            .map(({ gateId }) => gateId) ?? null,
        };
      } catch (error) {
        if (!(error instanceof DashboardDataError || error instanceof RangeError)) throw error;
        return null;
      }
    }),
  };
  return { approvals, evidence };
}

export function mapApprovalChangeRequests(value: unknown, projectId: string, sessionId: string) {
  const dto = record(value, "change requests");
  return { requests: list(dto.change_requests, "change_requests").map((value) => {
    const cr = record(value, "change request");
    scope(cr.project_id, projectId, "change_request.project_id");
    return {
      sessionId: scope(cr.pipeline_session_id, sessionId, "change_request.pipeline_session_id"),
      id: string(cr.cr_id, "cr_id"),
      baselineId: string(cr.baseline_id, "baseline_id"),
      key: string(cr.cr_key, "cr_key"),
      hash: artifactHash(cr.cr_sha256, "cr_sha256"),
      title: string(cr.title, "title"),
      status: literal(cr.status, "status", "PENDING_APPROVAL", "APPROVED", "REJECTED", "APPLIED"),
    };
  }) };
}
