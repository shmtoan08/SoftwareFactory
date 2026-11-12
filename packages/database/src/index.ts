import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentOrgRole,
  type AgentOrganizationProfileRecord,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type BaselineSpecFreezeRecord,
  type CandidateBoundLineage,
  type ChangeRequestRecord,
  type CostPreflightCheckInput,
  type CostPreflightCheckResult,
  type CostSessionRecord,
  type DevEpicRecord,
  type DevMilestoneRecord,
  type DevUserStoryRecord,
  type FinalizeModelCallInput,
  type FinalizeModelCallResult,
  type LeaseSyncStatusResponse,
  type MergeCandidateRecord,
  type MergeOperationRecord,
  type ModelCallLedgerRecord,
  type ModelCallStatus,
  type OutboxEventRecord,
  type ProcessedWorkerEventRecord,
  type ProductPipelineBundle,
  type ProductPipelineSessionRecord,
  type ProjectBootstrapRecord,
  type ReleaseAcceptancePackageRecord,
  type ResourceUsageMetricRecord,
  type ReviewArtifactRecord,
  type ReviewArtifactStatus,
  type ReviewSessionRecord,
  type ReviewSessionStatus,
  type ServerEventAckContract,
  type SnapshotRetentionClass,
  type Stage1DiscoveryItemRecord,
  type Stage7DevelopmentPlanBundle,
  type StageApprovalGateRecord,
  type StageArtifactRecord,
  type TaskLeaseRecord,
  type TaskPlanLinkRecord,
  type TaskRecord,
  type TaskStatus,
  type Tier3AssertionEvidence,
  type VerificationExecutionBackend,
  type VerificationOverallStatus,
  type VerificationRunRecord,
  type VerifiedCodeImportRecord,
  type WorkerEventEnvelope,
  WORKER_EVENT_STATE_TRANSITIONS,
  computeCanonicalPayloadSha256,
  computeTaskExecutionIdempotencyKey,
  evaluatePostcallLimits,
  evaluatePreflightLimits,
} from "@software-factory/shared-types";
import {
  type GitTreeChangeEntry,
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  validateGitTreeImport,
} from "@software-factory/task-contract";
import {
  type ApplyChangeRequestStoreInput,
  ApprovalExpiredOrStaleError,
  type CasMergeResult,
  type ControlPlaneStore,
  type CreateChangeRequestStoreInput,
  type CreateCostSessionInput,
  type CreateProductPipelineSessionInput,
  type CreateProjectBootstrapInput,
  type CreateStage1DiscoveryItemsInput,
  type CreateStage7DevelopmentPlanInput,
  type DecideChangeRequestStoreInput,
  type FreezeBaselineSpecInput,
  PostgresRlsError,
  type ProjectMemberRole,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type RecordReleaseAcceptancePackageInput,
  type RecordResourceUsageMetricInput,
  type RecordStageApprovalGateInput,
  type RecordStageArtifactInput,
  type ResolveStage1DiscoveryItemInput,
  type RlsSessionContext,
  SimulatedPostMergeCrashError,
  type UpsertAgentOrganizationProfileInput,
} from "./types.ts";
import {
  buildProductPipelineBundle,
  computeBaselineFreezeBundleSha256,
  normalizeCreateStage1DiscoveryItem,
  validateCreateCostSessionInput,
  validateFreezeBaselineSpecInvariants,
  validateStage2Ac10References,
  validateStageArtifactKindAndHash,
} from "./m6a-validation.ts";
import {
  computeChangeRequestSha256,
  computeProjectBootstrapSha256,
  computeReleasePackageSha256,
  serializeTrustedAcceptanceTestSpecs,
  validateAgentOrganizationProfileInput,
} from "./m6b-validation.ts";
import {
  PostgresControlPlaneRepository,
  type PostgresPoolConfig,
  PostgresRuntimePool,
  buildCandidateBoundLineage,
  buildPostgresPoolConfigFromEnv,
  validateAndNormalizeResourceUsageMetricInput,
} from "./postgres-pool.ts";

export * from "./types.ts";
export * from "./m6a-validation.ts";
export * from "./m6b-validation.ts";
export * from "./postgres-pool.ts";

/**
 * SoftwareFactoryControlPlaneStore implements the PostgreSQL 4-Tier RLS Engine,
 * Canonical Lock Ordering (`task_leases` -> `tasks`), `clock_timestamp()` evaluation,
 * Lease/Event Coordinator, 3D Independent Reviewer Guard, 8-Field Approval Binding & TTL,
 * and Idempotent Atomic CAS Merge + Post-Merge Reconciler (MVP-SPEC-02, MVP-SPEC-03, MVP-SPEC-04).
 */
export class SoftwareFactoryControlPlaneStore implements ControlPlaneStore {
  private clockFn: () => Date;
  private readonly asyncLocalStorage = new AsyncLocalStorage<RlsSessionContext>();
  private defaultSession: RlsSessionContext = {
    currentProjectId: null,
    currentPrincipalId: null,
    currentRole: "anonymous",
  };

  // Per-resource mutex queues to enforce strict row-level FOR UPDATE serialization
  private lockQueues: Map<string, Promise<void>> = new Map();

  // Tables
  private projects: Map<string, ProjectRecord> = new Map();
  private projectMemberships: Map<string, ProjectMembershipRecord> = new Map();
  private tasks: Map<string, TaskRecord> = new Map();
  private taskLeases: Map<string, TaskLeaseRecord> = new Map();
  private processedWorkerEvents: Map<string, ProcessedWorkerEventRecord> = new Map();
  private processedEventsByIdempotencyKey: Map<string, ProcessedWorkerEventRecord> = new Map();
  private processedEventsByLeaseSeq: Map<string, ProcessedWorkerEventRecord> = new Map();
  private verifiedCodeImports: Map<string, VerifiedCodeImportRecord> = new Map();
  private mergeCandidates: Map<string, MergeCandidateRecord> = new Map();
  private verificationRuns: Map<string, VerificationRunRecord> = new Map();
  private reviewSessions: Map<string, ReviewSessionRecord> = new Map();
  private reviewArtifacts: Map<string, ReviewArtifactRecord> = new Map();
  private approvalRequests: Map<string, ApprovalRequestRecord> = new Map();
  private approvalDecisions: Map<string, ApprovalDecisionRecord> = new Map();
  private mergeOperations: Map<string, MergeOperationRecord> = new Map();
  private resourceUsageMetrics: Map<string, ResourceUsageMetricRecord> = new Map();
  private outboxEvents: Map<string, OutboxEventRecord> = new Map();
  private costSessions: Map<string, CostSessionRecord> = new Map();
  private modelCallLedgers: Map<string, ModelCallLedgerRecord> = new Map();
  private pipelineSessions: Map<string, ProductPipelineSessionRecord> = new Map();
  private stage1DiscoveryItems: Map<string, Stage1DiscoveryItemRecord> = new Map();
  private stageArtifacts: Map<string, StageArtifactRecord> = new Map();
  private stageApprovalGates: Map<string, StageApprovalGateRecord> = new Map();
  private baselineSpecFreezes: Map<string, BaselineSpecFreezeRecord> = new Map();
  private projectBootstraps: Map<string, ProjectBootstrapRecord> = new Map();
  private agentOrganizationProfiles: Map<string, AgentOrganizationProfileRecord> = new Map();
  private devMilestones: Map<string, DevMilestoneRecord> = new Map();
  private devEpics: Map<string, DevEpicRecord> = new Map();
  private devUserStories: Map<string, DevUserStoryRecord> = new Map();
  private taskPlanLinks: Map<string, TaskPlanLinkRecord> = new Map();
  private changeRequests: Map<string, ChangeRequestRecord> = new Map();
  private releaseAcceptancePackages: Map<string, ReleaseAcceptancePackageRecord> = new Map();

  // Simulated bare Git repository state per project: ref -> commit_hash, and commit_hash -> metadata
  private gitRefsByProject: Map<string, Map<string, string>> = new Map();
  private gitCommitsByProject: Map<
    string,
    Map<
      string,
      {
        commitHash: string;
        treeHash: string;
        parents: string[];
        taskId?: string;
        mergeCandidateId?: string;
      }
    >
  > = new Map();

  constructor(clockFn: () => Date = () => new Date()) {
    this.clockFn = clockFn;
  }

  public setClock(clockFn: () => Date): void {
    this.clockFn = clockFn;
  }

  public clockTimestampIso(): string {
    return this.clockFn().toISOString();
  }

  /**
   * Simulates `BEGIN; SET LOCAL app.current_project_id = ...; ... COMMIT; DISCARD ALL;`
   * Guarantees RLS-T6 (Connection Pool Reuse Safety: session context is always reset in `finally` via AsyncLocalStorage).
   */
  public async withRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const parentSession = this.getCurrentRlsSession();
    const session: RlsSessionContext = {
      currentProjectId: ctx.currentProjectId !== undefined ? ctx.currentProjectId : parentSession.currentProjectId,
      currentPrincipalId: ctx.currentPrincipalId !== undefined ? ctx.currentPrincipalId : parentSession.currentPrincipalId,
      currentRole: ctx.currentRole !== undefined ? ctx.currentRole : parentSession.currentRole,
    };
    return this.asyncLocalStorage.run(session, fn);
  }

  public discardAllSessionState(): void {
    this.defaultSession = {
      currentProjectId: null,
      currentPrincipalId: null,
      currentRole: "anonymous",
    };
  }

  public getCurrentRlsSession(): RlsSessionContext {
    return this.asyncLocalStorage.getStore() ?? { ...this.defaultSession };
  }

  private requireCurrentProjectId(): string | null {
    const pid = this.getCurrentRlsSession().currentProjectId;
    if (!pid || pid.trim() === "") {
      return null;
    }
    return pid;
  }

  private assertWritePermissionForProject(targetProjectId: string): void {
    const session = this.getCurrentRlsSession();
    const currentProjectId = session.currentProjectId;
    const role = session.currentRole;
    if (
      !currentProjectId ||
      currentProjectId !== targetProjectId ||
      (role !== "core_api_service" && role !== "gateway_service" && role !== "system_admin_role")
    ) {
      throw new PostgresRlsError(
        "42501",
        `new row violates row-level security policy for project_id=${targetProjectId} (current_project_id=${String(
          currentProjectId
        )}, role=${role})`
      );
    }
  }

  private assertCoreApiWritePermissionForProject(targetProjectId: string): void {
    const session = this.getCurrentRlsSession();
    const currentProjectId = session.currentProjectId;
    const role = session.currentRole;
    if (!currentProjectId || currentProjectId !== targetProjectId || role !== "core_api_service") {
      throw new PostgresRlsError(
        "42501",
        `new row violates row-level security policy for project_id=${targetProjectId} (current_project_id=${String(
          currentProjectId
        )}, role=${role})`
      );
    }
  }

  /**
   * Row-level lock serializer: ensures concurrent operations on the same task/lease
   * execute in strict serialized order (`FOR UPDATE OF l, t`).
   * Cleans up idle entries in `lockQueues` to avoid memory leaks (FIX-19).
   */
  private async withSerializedLock<T>(lockKey: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.lockQueues.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextQueue = prev.then(() => next);
    this.lockQueues.set(lockKey, nextQueue);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.lockQueues.get(lockKey) === nextQueue) {
        this.lockQueues.delete(lockKey);
      }
    }
  }

  // ===========================================================================
  // Tier 1 & Tier 2 CRUD with strict RLS enforcement (RLS-T1 .. RLS-T8)
  // ===========================================================================

  public createProject(input: {
    project_id?: string;
    slug: string;
    name: string;
    repo_bare_path: string;
    initial_main_commit_hash: string;
    initial_main_tree_hash?: string;
    approval_ttl_seconds?: number;
  }): ProjectRecord {
    if (this.getCurrentRlsSession().currentRole !== "system_admin_role") {
      throw new PostgresRlsError("42501", "Only system_admin_role can insert into projects");
    }
    const approvalTtlSeconds = input.approval_ttl_seconds ?? 86_400;
    if (!Number.isInteger(approvalTtlSeconds) || approvalTtlSeconds <= 0) {
      throw new PostgresRlsError("23514", "approval_ttl_seconds must be a positive integer");
    }
    const now = this.clockTimestampIso();
    const project_id = input.project_id ?? randomUUID();
    const record: ProjectRecord = {
      project_id,
      slug: input.slug,
      name: input.name,
      repo_bare_path: input.repo_bare_path,
      default_branch: "main",
      approval_ttl_seconds: approvalTtlSeconds,
      main_ref_commit_hash: input.initial_main_commit_hash,
      created_at: now,
      updated_at: now,
    };
    this.projects.set(project_id, record);

    const refs = new Map<string, string>();
    refs.set("refs/heads/main", input.initial_main_commit_hash);
    this.gitRefsByProject.set(project_id, refs);

    const commits = new Map<
      string,
      { commitHash: string; treeHash: string; parents: string[]; taskId?: string; mergeCandidateId?: string }
    >();
    commits.set(input.initial_main_commit_hash, {
      commitHash: input.initial_main_commit_hash,
      treeHash: input.initial_main_tree_hash ?? input.initial_main_commit_hash,
      parents: [],
    });
    this.gitCommitsByProject.set(project_id, commits);
    return { ...record };
  }

  public addProjectMembership(input: {
    project_id: string;
    principal_id: string;
    member_role: ProjectMemberRole;
  }): ProjectMembershipRecord {
    const role = this.getCurrentRlsSession().currentRole;
    if (role !== "system_admin_role" && role !== "core_api_service") {
      throw new PostgresRlsError("42501", "Insufficient privilege to add project membership");
    }
    const membership: ProjectMembershipRecord = {
      membership_id: randomUUID(),
      project_id: input.project_id,
      principal_id: input.principal_id,
      member_role: input.member_role,
      created_at: this.clockTimestampIso(),
    };
    this.projectMemberships.set(`${input.project_id}:${input.principal_id}`, membership);
    return { ...membership };
  }

  public getProjectMembership(projectId: string, principalId: string): ProjectMembershipRecord | null {
    return this.projectMemberships.get(`${projectId}:${principalId}`) ?? null;
  }

  public getProjectById(projectId: string): ProjectRecord | null {
    const project = this.projects.get(projectId);
    return project ? { ...project } : null;
  }

  public createTask(input: {
    task_id?: string;
    project_id: string;
    title: string;
    task_contract: TaskContractSpec;
    base_main_commit_hash?: string;
    max_rework_cycles?: number;
  }): TaskRecord {
    this.assertWritePermissionForProject(input.project_id);
    const project = this.projects.get(input.project_id);
    if (!project) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} does not exist`);
    }
    const maxReworkCycles = input.max_rework_cycles ?? 3;
    if (!Number.isInteger(maxReworkCycles) || maxReworkCycles < 1) {
      throw new PostgresRlsError("23514", "max_rework_cycles must be >= 1");
    }
    const now = this.clockTimestampIso();
    const task_id = input.task_id ?? randomUUID();
    const record: TaskRecord = {
      task_id,
      project_id: input.project_id,
      title: input.title,
      task_contract_json: input.task_contract as unknown as Record<string, unknown>,
      status: "Ready",
      base_main_commit_hash: input.base_main_commit_hash ?? project.main_ref_commit_hash,
      current_attempt_no: 0,
      rework_count: 0,
      max_rework_cycles: maxReworkCycles,
      active_lease_id: null,
      active_lease_epoch: 0,
      active_merge_candidate_id: null,
      merged_commit_hash: null,
      merged_at: null,
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task_id, record);
    return { ...record };
  }

  /**
   * RLS-filtered SELECT on `tasks` (enforces RLS-T1 Default Deny & RLS-T2 Tenant Isolation)
   */
  public selectVisibleTasks(): TaskRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const results: TaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (t.project_id === currentProjectId) {
        results.push({ ...t });
      }
    }
    return results;
  }

  public getTaskById(taskId: string): TaskRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const t = this.tasks.get(taskId);
    if (!t || t.project_id !== currentProjectId) {
      return null;
    }
    return { ...t };
  }

  /**
   * RLS-filtered UPDATE on `tasks` (enforces RLS-T4: returns 0 updated rows if project_id mismatches)
   */
  public updateTaskTitleRls(taskId: string, newTitle: string): number {
    const currentProjectId = this.requireCurrentProjectId();
    const role = this.getCurrentRlsSession().currentRole;
    if (!currentProjectId || (role !== "core_api_service" && role !== "gateway_service")) {
      return 0;
    }
    const task = this.tasks.get(taskId);
    if (!task || task.project_id !== currentProjectId) {
      return 0;
    }
    task.title = newTitle;
    task.updated_at = this.clockTimestampIso();
    return 1;
  }

  /**
   * RLS-T5 & RLS-T7: Attempting to DELETE from Tier 3 append-only evidence table (`processed_worker_events`)
   * or across tenants is strictly forbidden (`42501 insufficient_privilege`).
   */
  public deleteProcessedWorkerEventRls(_eventId: string): never {
    throw new PostgresRlsError(
      "42501",
      "permission denied for table processed_worker_events: Tier 3 append-only evidence table prohibits DELETE"
    );
  }

  public deleteTaskRls(taskId: string): number {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return 0;
    }
    const task = this.tasks.get(taskId);
    if (!task || task.project_id !== currentProjectId) {
      return 0;
    }
    throw new PostgresRlsError("42501", "DELETE is not granted to app_runtime on tasks");
  }

  // ===========================================================================
  // Lease Grant, Canonical Lock Event Submission & Revocation (MVP-SPEC-02 §4 & MVP-SPEC-03 §1)
  // ===========================================================================

  public async grantTaskLease(input: {
    project_id: string;
    task_id: string;
    worker_id: string;
    heartbeat_interval_ms?: number;
    lease_ttl_ms?: number;
  }): Promise<TaskLeaseRecord> {
    this.assertWritePermissionForProject(input.project_id);
    const task = this.tasks.get(input.task_id);
    if (!task || task.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", `Task ${input.task_id} not found in project ${input.project_id}`);
    }

    return this.withSerializedLock(`task:${task.task_id}`, () => {
      if (task.status !== "Ready" && task.status !== "ReworkRequired") {
        throw new Error(`Cannot grant lease when task is in status ${task.status}`);
      }
      if (task.status === "ReworkRequired") {
        if (task.rework_count >= task.max_rework_cycles) {
          task.status = "ManualIntervention";
          task.updated_at = this.clockTimestampIso();
          throw new PostgresRlsError(
            "23514",
            `Max rework cycles (${task.max_rework_cycles}) exceeded for task ${task.task_id}; moved to ManualIntervention`
          );
        }
        task.rework_count += 1;
      }
      // Enforce uq_one_active_lease_per_task
      for (const l of this.taskLeases.values()) {
        if (l.task_id === task.task_id && l.status === "ACTIVE") {
          throw new PostgresRlsError("23505", `Active lease already exists for task ${task.task_id}`);
        }
      }

      const nowDate = this.clockFn();
      const nowIso = nowDate.toISOString();
      const heartbeatIntervalMs = input.heartbeat_interval_ms ?? 10_000;
      const leaseTtlMs = input.lease_ttl_ms ?? 35_000;
      if (leaseTtlMs < heartbeatIntervalMs * 3) {
        throw new PostgresRlsError("23514", "lease_ttl_ms must be >= heartbeat_interval_ms * 3");
      }

      const nextAttemptNo = task.current_attempt_no + 1;
      const nextEpoch = task.active_lease_epoch + 1;
      const lease_id = randomUUID();
      const expiresAtIso = new Date(nowDate.getTime() + leaseTtlMs).toISOString();

      const lease: TaskLeaseRecord = {
        lease_id,
        project_id: input.project_id,
        task_id: input.task_id,
        attempt_no: nextAttemptNo,
        lease_epoch: nextEpoch,
        worker_id: input.worker_id,
        status: "ACTIVE",
        task_execution_idempotency_key: computeTaskExecutionIdempotencyKey(
          input.project_id,
          input.task_id,
          nextAttemptNo
        ),
        last_processed_seq: 0,
        heartbeat_interval_ms: heartbeatIntervalMs,
        lease_ttl_ms: leaseTtlMs,
        leased_at: nowIso,
        last_heartbeat_at: nowIso,
        expires_at: expiresAtIso,
        revoked_at: null,
        revoke_reason: null,
        completed_at: null,
      };

      this.taskLeases.set(lease_id, lease);
      task.status = "Leased";
      task.current_attempt_no = nextAttemptNo;
      task.active_lease_id = lease_id;
      task.active_lease_epoch = nextEpoch;
      task.updated_at = nowIso;

      this.insertOutboxEventInternal(input.project_id, "task_lease", lease_id, "lease.granted", {
        task_id: task.task_id,
        lease_id,
        lease_epoch: nextEpoch,
        worker_id: input.worker_id,
      });

      return { ...lease };
    });
  }

  public getLeaseById(leaseId: string): TaskLeaseRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const lease = this.taskLeases.get(leaseId);
    if (!lease || lease.project_id !== currentProjectId) {
      return null;
    }
    return { ...lease };
  }

  public getLeaseSyncStatus(leaseId: string): LeaseSyncStatusResponse | null {
    const lease = this.getLeaseById(leaseId);
    if (!lease) {
      return null;
    }
    return {
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      lease_status: lease.status,
      last_processed_seq: lease.last_processed_seq,
      expected_next_seq: lease.last_processed_seq + 1,
      lease_expires_at: lease.status === "ACTIVE" ? lease.expires_at : null,
      server_clock_timestamp: this.clockTimestampIso(),
    };
  }

  /**
   * Atomic Worker Event Processing Transaction (MVP-SPEC-02 Section 4 & MVP-SPEC-03 Section 1.2)
   * Linearization point: Canonical row-level lock acquisition on `task_leases` -> `tasks`
   * evaluated against real-time `clock_timestamp()`.
   */
  public async submitWorkerEvent(
    envelope: WorkerEventEnvelope,
    inTransactionDelayMs = 0
  ): Promise<ServerEventAckContract> {
    this.assertWritePermissionForProject(envelope.project_id);

    return this.withSerializedLock(`task:${envelope.task_id}`, async () => {
      if (inTransactionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, inTransactionDelayMs));
      }

      // Evaluate PostgreSQL clock_timestamp() at the exact moment the lock is held and checked!
      const nowDate = this.clockFn();
      const nowIso = nowDate.toISOString();

      const lease = this.taskLeases.get(envelope.lease_id);
      const task = this.tasks.get(envelope.task_id);

      if (!lease || !task || lease.project_id !== envelope.project_id || task.project_id !== envelope.project_id) {
        return {
          http_status: 409,
          ack_status: "REJECTED_STALE_LEASE",
          lease_id: envelope.lease_id,
          lease_epoch: envelope.lease_epoch,
          lease_status: "REVOKED",
          acked_sequence_no: 0,
          expected_next_seq: 0,
          task_status: task?.status ?? "ManualIntervention",
          lease_expires_at: null,
          server_clock_timestamp: nowIso,
          error_code: "ERR_STALE_LEASE",
        };
      }

      // Step 1: Verify Lease Authority, Worker Fencing & Real-Time Expiry (`clock_timestamp()`) FIRST (FIX-04)
      const expiresAtMs = new Date(lease.expires_at).getTime();
      const isExpiredNow = expiresAtMs <= nowDate.getTime();
      if (isExpiredNow && lease.status === "ACTIVE") {
        lease.status = "EXPIRED";
        if (task.active_lease_id === lease.lease_id) {
          task.active_lease_id = null;
          if (task.status === "Leased" || task.status === "ExecutingInTarget") {
            task.status = "Ready";
          }
          task.updated_at = nowIso;
        }
      }

      if (
        lease.worker_id !== envelope.worker_id ||
        lease.status !== "ACTIVE" ||
        lease.revoked_at !== null ||
        isExpiredNow ||
        lease.lease_epoch !== envelope.lease_epoch ||
        task.active_lease_id !== lease.lease_id ||
        task.active_lease_epoch !== envelope.lease_epoch
      ) {
        return {
          http_status: 409,
          ack_status: "REJECTED_STALE_LEASE",
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          lease_status: lease.status,
          acked_sequence_no: lease.last_processed_seq,
          expected_next_seq: 0,
          task_status: task.status,
          lease_expires_at: null,
          server_clock_timestamp: nowIso,
          error_code: "ERR_STALE_LEASE",
        };
      }

      // Step 2: Check Idempotent Retry via Indexed Lookup (FIX-20)
      const existing =
        this.processedEventsByIdempotencyKey.get(
          `${envelope.project_id}:${envelope.event_idempotency_key}`
        ) ??
        this.processedEventsByLeaseSeq.get(
          `${envelope.lease_id}:${envelope.sequence_no}`
        );

      if (existing) {
        const computedSha = computeCanonicalPayloadSha256(envelope.payload);
        if (
          existing.event_idempotency_key === envelope.event_idempotency_key &&
          existing.payload_sha256 === envelope.payload_sha256 &&
          existing.payload_sha256 === computedSha &&
          existing.sequence_no === envelope.sequence_no &&
          existing.event_type === envelope.event_type
        ) {
          return {
            http_status: 200,
            ack_status: "DUPLICATE_RETRY_NOP",
            lease_id: lease.lease_id,
            lease_epoch: lease.lease_epoch,
            lease_status: lease.status,
            acked_sequence_no: existing.sequence_no,
            expected_next_seq: lease.last_processed_seq + 1,
            task_status: task.status,
            lease_expires_at: lease.status === "ACTIVE" ? lease.expires_at : null,
            server_clock_timestamp: nowIso,
          };
        }

        return {
          http_status: 409,
          ack_status: "REJECTED_CONFLICT_PAYLOAD",
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          lease_status: lease.status,
          acked_sequence_no: lease.last_processed_seq,
          expected_next_seq: lease.last_processed_seq + 1,
          task_status: task.status,
          lease_expires_at: lease.status === "ACTIVE" ? lease.expires_at : null,
          server_clock_timestamp: nowIso,
          error_code: "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH",
        };
      }

      // Step 3: Strict Monotonic Sequence Enforcement (sequence_no === last_processed_seq + 1)
      const expectedNextSeq = lease.last_processed_seq + 1;
      if (envelope.sequence_no !== expectedNextSeq) {
        return {
          http_status: 409,
          ack_status: "REJECTED_OUT_OF_ORDER",
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          lease_status: lease.status,
          acked_sequence_no: lease.last_processed_seq,
          expected_next_seq: expectedNextSeq,
          task_status: task.status,
          lease_expires_at: lease.expires_at,
          server_clock_timestamp: nowIso,
          error_code:
            envelope.sequence_no < expectedNextSeq ? "ERR_SEQ_ALREADY_ADVANCED" : "ERR_SEQ_GAP",
        };
      }

      // Verify payload_sha256 matches canonical JSON payload
      const actualPayloadSha = computeCanonicalPayloadSha256(envelope.payload);
      if (actualPayloadSha !== envelope.payload_sha256) {
        return {
          http_status: 409,
          ack_status: "REJECTED_CONFLICT_PAYLOAD",
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          lease_status: lease.status,
          acked_sequence_no: lease.last_processed_seq,
          expected_next_seq: expectedNextSeq,
          task_status: task.status,
          lease_expires_at: lease.expires_at,
          server_clock_timestamp: nowIso,
          error_code: "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH",
        };
      }

      // Step 4: Validate Task State Transition Matrix
      const transitionRule = WORKER_EVENT_STATE_TRANSITIONS[envelope.event_type];
      if (!transitionRule.allowedFrom.includes(task.status)) {
        return {
          http_status: 422,
          ack_status: "REJECTED_INVALID_TRANSITION",
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          lease_status: lease.status,
          acked_sequence_no: lease.last_processed_seq,
          expected_next_seq: expectedNextSeq,
          task_status: task.status,
          lease_expires_at: lease.expires_at,
          server_clock_timestamp: nowIso,
          error_code: "ERR_INVALID_STATE_TRANSITION",
        };
      }

      // Step 5: Persist Processed Event, Advance Lease Sequence/Heartbeat, Update Task & Outbox Atomically
      const eventRecord: ProcessedWorkerEventRecord = {
        event_id: randomUUID(),
        project_id: envelope.project_id,
        task_id: envelope.task_id,
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        sequence_no: envelope.sequence_no,
        event_type: envelope.event_type,
        event_idempotency_key: envelope.event_idempotency_key,
        payload_sha256: envelope.payload_sha256,
        payload_json: structuredClone(envelope.payload),
        processed_at: nowIso,
      };
      this.processedWorkerEvents.set(eventRecord.event_id, eventRecord);
      this.processedEventsByIdempotencyKey.set(
        `${envelope.project_id}:${envelope.event_idempotency_key}`,
        eventRecord
      );
      this.processedEventsByLeaseSeq.set(
        `${envelope.lease_id}:${envelope.sequence_no}`,
        eventRecord
      );

      lease.last_processed_seq = envelope.sequence_no;
      lease.last_heartbeat_at = nowIso;
      lease.expires_at = new Date(nowDate.getTime() + lease.lease_ttl_ms).toISOString();

      if (transitionRule.targetStatus !== "UNCHANGED") {
        task.status = transitionRule.targetStatus;
        task.updated_at = nowIso;
      }

      if (transitionRule.closesLeaseAs === "COMPLETED") {
        lease.status = "COMPLETED";
        lease.completed_at = nowIso;
        task.active_lease_id = null;
      } else if (transitionRule.closesLeaseAs === "REVOKED") {
        lease.status = "REVOKED";
        lease.revoked_at = nowIso;
        lease.revoke_reason = "WORKER_REPORTED_FAILURE";
        task.active_lease_id = null;
      }

      this.insertOutboxEventInternal(
        envelope.project_id,
        "task",
        task.task_id,
        envelope.event_type,
        {
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          sequence_no: envelope.sequence_no,
          new_task_status: task.status,
          payload: envelope.payload,
        }
      );

      return {
        http_status: 200,
        ack_status: "ACCEPTED",
        lease_id: lease.lease_id,
        lease_epoch: lease.lease_epoch,
        lease_status: lease.status,
        acked_sequence_no: envelope.sequence_no,
        expected_next_seq: lease.last_processed_seq + 1,
        task_status: task.status,
        lease_expires_at: lease.status === "ACTIVE" ? lease.expires_at : null,
        server_clock_timestamp: nowIso,
      };
    });
  }

  /**
   * Atomic Lease Revocation Transaction (MVP-SPEC-02 Section 4 & MVP-SPEC-03 Section 1.2)
   * Acquires the exact same canonical lock (`task_leases` -> `tasks`).
   */
  public async revokeTaskLease(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    reason: string;
    requeueTask?: boolean;
  }): Promise<TaskLeaseRecord> {
    this.assertWritePermissionForProject(input.project_id);

    return this.withSerializedLock(`task:${input.task_id}`, () => {
      const nowIso = this.clockTimestampIso();
      const lease = this.taskLeases.get(input.lease_id);
      const task = this.tasks.get(input.task_id);
      if (!lease || !task || lease.project_id !== input.project_id) {
        throw new Error(`Lease ${input.lease_id} not found`);
      }

      if (lease.status === "ACTIVE") {
        lease.status = "REVOKED";
        lease.revoked_at = nowIso;
        lease.revoke_reason = input.reason;
      }
      if (task.active_lease_id === lease.lease_id) {
        task.active_lease_id = null;
        if (task.status === "Leased" || task.status === "ExecutingInTarget") {
          task.status = input.requeueTask ? "Ready" : "ManualIntervention";
        }
        task.updated_at = nowIso;
      }

      this.insertOutboxEventInternal(
        input.project_id,
        "task_lease",
        lease.lease_id,
        "lease.revoked",
        {
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          reason: input.reason,
        }
      );

      return { ...lease };
    });
  }

  /**
   * Controlled Git Push Gatekeeper (`pre-receive` hook) + 6-Step TrustedImportValidator
   * (MVP-SPEC-03 Section 5.1-5.2)
   */
  public async pushStagingGitRefWithGatekeeper(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    agent_commit_hash: string;
    verified_tree_hash: string;
    parent_commit_hashes: readonly string[];
    changes?: readonly GitTreeChangeEntry[];
    simulateControlPlaneOutage?: boolean;
    deadlineMs?: number;
    authorizeCheckHook?: (signal: AbortSignal) => Promise<void>;
  }): Promise<{
    allowed: boolean;
    error_code?: string;
    reason?: string;
    import_id?: string;
  }> {
    const deadlineMs = input.deadlineMs ?? 2000;
    if (input.simulateControlPlaneOutage === true || deadlineMs <= 0) {
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason:
          "Pre-receive Fail-Closed: Control Plane unreachable or exceeded 2000ms hard timeout",
      };
    }

    const startMs = Date.now();
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error("ERR_GATEKEEPER_TIMEOUT"));
        reject(new Error("ERR_GATEKEEPER_TIMEOUT"));
      }, deadlineMs);
    });

    const runVerification = async (): Promise<{
      allowed: boolean;
      error_code?: string;
      reason?: string;
      import_id?: string;
    }> => {
      if (input.authorizeCheckHook) {
        await input.authorizeCheckHook(abortController.signal);
      }
      if (abortController.signal.aborted || Date.now() - startMs > deadlineMs) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
          reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
        };
      }

      const nowMs = this.clockFn().getTime();
      const expectedStagingRef = `refs/heads/sf/staging/${input.task_id}/${input.lease_epoch}`;
      const expectedVerifyAlias = `refs/factory/Verify/${input.task_id}/${input.lease_epoch}`;
      if (input.staging_ref !== expectedStagingRef && input.staging_ref !== expectedVerifyAlias) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FORBIDDEN_REF",
          reason: `Pre-receive denied: staging_ref ${input.staging_ref} does not match ${expectedStagingRef} or ${expectedVerifyAlias}`,
        };
      }

      // Step 1b: Atomic Lease Active & Real-Time Expiry Check (`expires_at > clock_timestamp()`)
      const lease = this.taskLeases.get(input.lease_id);
      const task = this.tasks.get(input.task_id);
      if (
        !lease ||
        !task ||
        lease.project_id !== input.project_id ||
        lease.task_id !== input.task_id ||
        lease.lease_epoch !== input.lease_epoch ||
        lease.status !== "ACTIVE" ||
        lease.revoked_at !== null ||
        new Date(lease.expires_at).getTime() <= nowMs
      ) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_STALE_OR_EXPIRED_LEASE",
          reason: "Pre-receive denied: lease is not ACTIVE or has expired/revoked",
        };
      }

      const refs = this.gitRefsByProject.get(input.project_id);
      const commits = this.gitCommitsByProject.get(input.project_id);
      if (!refs || !commits) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_REPO_NOT_FOUND",
          reason: "Project bare repository not found",
        };
      }

      // Reject pushes that omit changes metadata (FIX-10)
      if (!input.changes) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_MISSING_CHANGES",
          reason:
            "Pre-receive denied: Git changes manifest is required for TrustedImportValidator verification",
        };
      }

      // Step 2-6: Execute 6-Step TrustedImportValidator right at pre-receive hook (also rejects changes: [])
      const contract = task.task_contract_json as unknown as TaskContractSpec;
      const validation = validateGitTreeImport({
        agent_commit_hash: input.agent_commit_hash,
        verified_tree_hash: input.verified_tree_hash,
        parent_commit_hashes: input.parent_commit_hashes,
        expected_base_main_commit_hash: task.base_main_commit_hash,
        changes: input.changes,
        contract,
      });

      if (!validation.valid) {
        return {
          allowed: false,
          error_code: validation.error_code,
          reason: `TrustedImportValidator rejected push at pre-receive: [${validation.error_code}] ${validation.message}`,
        };
      }

      // Re-check deadline right before persisting git ref / verified_code_imports
      const elapsedMs = Date.now() - startMs;
      if (abortController.signal.aborted || elapsedMs > deadlineMs) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
          reason: `Pre-receive hard timeout exceeded: execution took ${elapsedMs}ms (> ${deadlineMs}ms)`,
        };
      }

      commits.set(input.agent_commit_hash, {
        commitHash: input.agent_commit_hash,
        treeHash: input.verified_tree_hash,
        parents: [...input.parent_commit_hashes],
        taskId: input.task_id,
      });
      refs.set(expectedStagingRef, input.agent_commit_hash);
      refs.set(input.staging_ref, input.agent_commit_hash);

      // Record immediately in `verified_code_imports` when changes were validated at pre-receive
      let recordedImportId: string | undefined;
      const existingImport = this.findVerifiedImportByLeaseAndCommit(
        lease.lease_id,
        input.agent_commit_hash
      );
      if (existingImport) {
        recordedImportId = existingImport.import_id;
      } else {
        const importRecord: VerifiedCodeImportRecord = {
          import_id: randomUUID(),
          project_id: input.project_id,
          task_id: input.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          agent_commit_hash: validation.agent_commit_hash,
          verified_tree_hash: validation.verified_tree_hash,
          staging_ref: input.staging_ref,
          changed_files_count: validation.changed_files_count,
          deleted_lines_count: validation.deleted_lines_count,
          recovered_by_reconciler: false,
          created_at: this.clockTimestampIso(),
        };
        this.verifiedCodeImports.set(importRecord.import_id, importRecord);
        recordedImportId = importRecord.import_id;
      }

      return {
        allowed: true,
        ...(recordedImportId ? { import_id: recordedImportId } : {}),
      };
    };

    const verificationPromise = runVerification();
    verificationPromise.catch(() => {});

    try {
      return await Promise.race([verificationPromise, timeoutPromise]);
    } catch {
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason: `Pre-receive Fail-Closed: Control Plane unreachable or exceeded ${deadlineMs}ms hard timeout`,
      };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private findVerifiedImportByLeaseAndCommit(
    leaseId: string,
    agentCommitHash: string
  ): VerifiedCodeImportRecord | undefined {
    for (const rec of this.verifiedCodeImports.values()) {
      if (rec.lease_id === leaseId && rec.agent_commit_hash === agentCommitHash) {
        return rec;
      }
    }
    return undefined;
  }

  /**
   * Strictly matches a VerifiedCodeImportRecord against project, task, lease, lease_epoch,
   * canonical staging ref format, and live Git ref SHA pointer (FIX-27).
   */
  private findMatchingVerifiedImportForReconciler(input: {
    projectId: string;
    taskId: string;
    leaseId: string;
    leaseEpoch: number;
  }): VerifiedCodeImportRecord | undefined {
    const expectedStagingRef = `refs/heads/sf/staging/${input.taskId}/${input.leaseEpoch}`;
    const expectedVerifyAlias = `refs/factory/Verify/${input.taskId}/${input.leaseEpoch}`;
    const refs = this.gitRefsByProject.get(input.projectId);
    if (!refs) {
      return undefined;
    }

    let latest: VerifiedCodeImportRecord | undefined;
    for (const rec of this.verifiedCodeImports.values()) {
      if (
        rec.project_id === input.projectId &&
        rec.task_id === input.taskId &&
        rec.lease_id === input.leaseId &&
        rec.lease_epoch === input.leaseEpoch &&
        (rec.staging_ref === expectedStagingRef || rec.staging_ref === expectedVerifyAlias) &&
        refs.get(rec.staging_ref) === rec.agent_commit_hash
      ) {
        if (
          !latest ||
          new Date(rec.created_at).getTime() >= new Date(latest.created_at).getTime()
        ) {
          latest = rec;
        }
      }
    }
    return latest;
  }

  public getVerifiedImportsForTask(taskId: string): VerifiedCodeImportRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: VerifiedCodeImportRecord[] = [];
    for (const rec of this.verifiedCodeImports.values()) {
      if (rec.project_id === currentProjectId && rec.task_id === taskId) {
        list.push({ ...rec });
      }
    }
    return list;
  }

  /**
   * Narrow `SECURITY DEFINER` equivalent: `list_expired_active_lease_scopes(batch_limit)`
   * (MVP-SPEC-02 Section 3 & MVP-SPEC-03 Section 3.2)
   */
  public listExpiredActiveLeaseScopes(
    batchLimit = 50
  ): Array<{ project_id: string; lease_id: string; task_id: string }> {
    const nowMs = this.clockFn().getTime();
    const expired: Array<{ project_id: string; lease_id: string; task_id: string; expiresAtMs: number }> = [];
    for (const l of this.taskLeases.values()) {
      const expMs = new Date(l.expires_at).getTime();
      if (l.status === "ACTIVE" && expMs <= nowMs) {
        expired.push({
          project_id: l.project_id,
          lease_id: l.lease_id,
          task_id: l.task_id,
          expiresAtMs: expMs,
        });
      }
    }
    expired.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
    return expired.slice(0, batchLimit).map(({ project_id, lease_id, task_id }) => ({
      project_id,
      lease_id,
      task_id,
    }));
  }

  /**
   * LeaseExpiryReconciler & Orphaned Git Push Reconciler (MVP-SPEC-03 Section 3.2)
   * If a Worker pushed a valid staging commit before its connection died (losing `task.completed`),
   * the reconciler verifies the `verified_code_imports` entry against the live staging ref
   * and advances the task to `BuildingMergeCandidate` without re-running the Agent.
   */
  public async runLeaseExpiryAndOrphanedPushReconciler(
    orphanedDiffProvider?: (stagingInfo: {
      project_id: string;
      task_id: string;
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      agent_commit_hash: string;
      verified_tree_hash: string;
      parent_commit_hashes: readonly string[];
    }) => GitTreeImportCandidateInput | null
  ): Promise<
    Array<{
      lease_id: string;
      task_id: string;
      outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
      import_id?: string;
    }>
  > {
    const scopes = this.listExpiredActiveLeaseScopes(50);
    const results: Array<{
      lease_id: string;
      task_id: string;
      outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
      import_id?: string;
    }> = [];

    for (const scope of scopes) {
      await this.withRlsTransaction(
        {
          currentProjectId: scope.project_id,
          currentPrincipalId: "lease_expiry_reconciler",
          currentRole: "core_api_service",
        },
        async () => {
          await this.withSerializedLock(`task:${scope.task_id}`, () => {
            const nowIso = this.clockTimestampIso();
            const nowMs = this.clockFn().getTime();
            const lease = this.taskLeases.get(scope.lease_id);
            const task = this.tasks.get(scope.task_id);
            if (!lease || !task || lease.status !== "ACTIVE" || new Date(lease.expires_at).getTime() > nowMs) {
              return;
            }

            // Path A: Match pre-recorded VerifiedCodeImport strictly by staging ref & live Git commit hash (FIX-27)
            const preRecordedImport = this.findMatchingVerifiedImportForReconciler({
              projectId: scope.project_id,
              taskId: task.task_id,
              leaseId: lease.lease_id,
              leaseEpoch: lease.lease_epoch,
            });
            if (preRecordedImport) {
              preRecordedImport.recovered_by_reconciler = true;
              lease.status = "COMPLETED";
              lease.completed_at = nowIso;
              task.status = "BuildingMergeCandidate";
              task.active_lease_id = null;
              task.updated_at = nowIso;

              this.insertOutboxEventInternal(
                scope.project_id,
                "task",
                task.task_id,
                "task.orphaned_push_recovered",
                {
                  task_id: task.task_id,
                  lease_id: lease.lease_id,
                  import_id: preRecordedImport.import_id,
                  agent_commit_hash: preRecordedImport.agent_commit_hash,
                }
              );
              results.push({
                lease_id: lease.lease_id,
                task_id: task.task_id,
                outcome: "RECOVERED_ORPHANED_PUSH",
                import_id: preRecordedImport.import_id,
              });
              return;
            }

            // Path B: Inspect staging ref via orphanedDiffProvider if not yet in verified_code_imports
            const stagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
            const verifyRef = `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;
            const refs = this.gitRefsByProject.get(scope.project_id);
            const commits = this.gitCommitsByProject.get(scope.project_id);
            const matchedRef = refs?.get(stagingRef)
              ? stagingRef
              : refs?.get(verifyRef)
              ? verifyRef
              : stagingRef;
            const stagingCommitHash = refs?.get(matchedRef);
            const commitMeta = stagingCommitHash ? commits?.get(stagingCommitHash) : undefined;

            if (stagingCommitHash && commitMeta && orphanedDiffProvider) {
              const candidateInput = orphanedDiffProvider({
                project_id: scope.project_id,
                task_id: task.task_id,
                lease_id: lease.lease_id,
                lease_epoch: lease.lease_epoch,
                staging_ref: matchedRef,
                agent_commit_hash: stagingCommitHash,
                verified_tree_hash: commitMeta.treeHash,
                parent_commit_hashes: commitMeta.parents,
              });
              if (candidateInput) {
                const validation = validateGitTreeImport(candidateInput);
                if (validation.valid) {
                  // Recover orphaned push into verified_code_imports and advance task to BuildingMergeCandidate
                  const importRecord: VerifiedCodeImportRecord = {
                    import_id: randomUUID(),
                    project_id: scope.project_id,
                    task_id: task.task_id,
                    lease_id: lease.lease_id,
                    lease_epoch: lease.lease_epoch,
                    agent_commit_hash: validation.agent_commit_hash,
                    verified_tree_hash: validation.verified_tree_hash,
                    staging_ref: matchedRef,
                    changed_files_count: validation.changed_files_count,
                    deleted_lines_count: validation.deleted_lines_count,
                    recovered_by_reconciler: true,
                    created_at: nowIso,
                  };
                  this.verifiedCodeImports.set(importRecord.import_id, importRecord);
                  lease.status = "COMPLETED";
                  lease.completed_at = nowIso;
                  task.status = "BuildingMergeCandidate";
                  task.active_lease_id = null;
                  task.updated_at = nowIso;

                  this.insertOutboxEventInternal(
                    scope.project_id,
                    "task",
                    task.task_id,
                    "task.orphaned_push_recovered",
                    {
                      task_id: task.task_id,
                      lease_id: lease.lease_id,
                      import_id: importRecord.import_id,
                      agent_commit_hash: validation.agent_commit_hash,
                    }
                  );
                  results.push({
                    lease_id: lease.lease_id,
                    task_id: task.task_id,
                    outcome: "RECOVERED_ORPHANED_PUSH",
                    import_id: importRecord.import_id,
                  });
                  return;
                }
              }
            }

            // Otherwise mark lease EXPIRED and requeue task back to Ready
            lease.status = "EXPIRED";
            if (task.active_lease_id === lease.lease_id) {
              task.active_lease_id = null;
              task.status = "Ready";
              task.updated_at = nowIso;
            }
            this.insertOutboxEventInternal(
              scope.project_id,
              "task_lease",
              lease.lease_id,
              "lease.expired",
              {
                task_id: task.task_id,
                lease_id: lease.lease_id,
                lease_epoch: lease.lease_epoch,
              }
            );
            results.push({
              lease_id: lease.lease_id,
              task_id: task.task_id,
              outcome: "EXPIRED_AND_REQUEUED",
            });
          });
        }
      );
    }

    return results;
  }

  // ===========================================================================
  // Import, Candidate, Verifier, 3D Reviewer, 8-Field Approval & CAS Merge
  // ===========================================================================

  public recordVerifiedCodeImport(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    candidate_input: GitTreeImportCandidateInput;
  }): VerifiedCodeImportRecord {
    this.assertWritePermissionForProject(input.project_id);

    const task = this.tasks.get(input.task_id);
    const lease = this.taskLeases.get(input.lease_id);
    if (!task || task.project_id !== input.project_id) {
      throw new PostgresRlsError(
        "23503",
        `Task ${input.task_id} not found for project ${input.project_id}`
      );
    }
    if (!lease || lease.project_id !== input.project_id || lease.task_id !== input.task_id) {
      throw new PostgresRlsError(
        "23503",
        `Lease ${input.lease_id} not found for task ${input.task_id} in project ${input.project_id}`
      );
    }
    if (lease.lease_epoch !== input.lease_epoch) {
      throw new PostgresRlsError(
        "23514",
        `Lease epoch mismatch: expected ${lease.lease_epoch}, got ${input.lease_epoch}`
      );
    }

    const expectedStagingRef = `refs/heads/sf/staging/${input.task_id}/${input.lease_epoch}`;
    const expectedVerifyAlias = `refs/factory/Verify/${input.task_id}/${input.lease_epoch}`;
    if (input.staging_ref !== expectedStagingRef && input.staging_ref !== expectedVerifyAlias) {
      throw new PostgresRlsError(
        "23514",
        `Invalid staging_ref ${input.staging_ref}; expected ${expectedStagingRef} or ${expectedVerifyAlias}`
      );
    }

    // Lease authority & real-time expiry fencing (FIX-08)
    const nowMs = this.clockFn().getTime();
    const isExpired = new Date(lease.expires_at).getTime() <= nowMs;
    if (
      lease.status === "REVOKED" ||
      lease.status === "EXPIRED" ||
      lease.revoked_at !== null ||
      (lease.status === "ACTIVE" && isExpired)
    ) {
      throw new PostgresRlsError(
        "23514",
        `Lease ${input.lease_id} (status=${lease.status}) is revoked or expired and cannot record verified_code_imports`
      );
    }

    if (input.candidate_input.expected_base_main_commit_hash !== task.base_main_commit_hash) {
      throw new PostgresRlsError(
        "23514",
        `Candidate expected_base_main_commit_hash ${input.candidate_input.expected_base_main_commit_hash} does not match task base_main_commit_hash ${task.base_main_commit_hash}`
      );
    }

    const validation = validateGitTreeImport(input.candidate_input);
    if (!validation.valid) {
      throw new PostgresRlsError(
        "23514",
        `TrustedImportValidator rejected import: [${validation.error_code}] ${validation.message}`
      );
    }

    const existing = this.findVerifiedImportByLeaseAndCommit(
      input.lease_id,
      validation.agent_commit_hash
    );
    if (existing) {
      if (
        existing.project_id !== input.project_id ||
        existing.task_id !== input.task_id ||
        existing.lease_epoch !== input.lease_epoch ||
        existing.staging_ref !== input.staging_ref ||
        existing.verified_tree_hash !== validation.verified_tree_hash
      ) {
        throw new PostgresRlsError(
          "23514",
          `Conflicting VerifiedCodeImport already exists for lease ${input.lease_id}`
        );
      }
      if (lease.status === "ACTIVE" || (lease.status === "COMPLETED" && task.status === "BuildingMergeCandidate")) {
        return { ...existing };
      }
      throw new PostgresRlsError(
        "23514",
        `Cannot reuse VerifiedCodeImport while task is in status ${task.status} and lease is ${lease.status}`
      );
    }

    if (lease.status !== "ACTIVE") {
      throw new PostgresRlsError(
        "23514",
        `Cannot record new VerifiedCodeImport on non-ACTIVE lease (status=${lease.status})`
      );
    }

    const nowIso = this.clockTimestampIso();
    const record: VerifiedCodeImportRecord = {
      import_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      lease_id: input.lease_id,
      lease_epoch: input.lease_epoch,
      agent_commit_hash: validation.agent_commit_hash,
      verified_tree_hash: validation.verified_tree_hash,
      staging_ref: input.staging_ref,
      changed_files_count: validation.changed_files_count,
      deleted_lines_count: validation.deleted_lines_count,
      recovered_by_reconciler: false,
      created_at: nowIso,
    };
    this.verifiedCodeImports.set(record.import_id, record);
    return { ...record };
  }

  /**
   * Candidate-First Creation (`C_candidate`).
   * Automatically supersedes any older candidate on the same task and invalidates stale reviews/approvals.
   * (MVP-SPEC-04 Section 1 & Section 3.1)
   */
  public createMergeCandidate(input: {
    project_id: string;
    task_id: string;
    import_id: string;
    base_main_commit_hash: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
    allow_rebased_tree_hash?: boolean;
    snapshot_path?: string | null;
    snapshot_sha256?: string | null;
    snapshot_size_bytes?: number | null;
    snapshot_retention_class?: SnapshotRetentionClass;
  }): MergeCandidateRecord {
    this.assertWritePermissionForProject(input.project_id);
    const task = this.tasks.get(input.task_id);
    const imp = this.verifiedCodeImports.get(input.import_id);
    if (!task || !imp || task.project_id !== input.project_id || imp.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", "Task or VerifiedCodeImport not found for project");
    }

    if (imp.task_id !== input.task_id) {
      throw new PostgresRlsError("23503", "Import does not belong to the specified task");
    }

    if (!/^[0-9a-f]{40,64}$/i.test(input.verified_tree_hash)) {
      throw new PostgresRlsError(
        "23514",
        `Invalid verified_tree_hash ${input.verified_tree_hash}`
      );
    }

    if (!input.allow_rebased_tree_hash && input.verified_tree_hash !== imp.verified_tree_hash) {
      throw new PostgresRlsError(
        "23514",
        `Candidate verified_tree_hash ${input.verified_tree_hash} does not match import ${imp.verified_tree_hash}`
      );
    }

    if (
      input.snapshot_sha256 !== undefined &&
      input.snapshot_sha256 !== null &&
      !/^[0-9a-f]{64}$/.test(input.snapshot_sha256)
    ) {
      throw new PostgresRlsError(
        "23514",
        `chk_mc_snapshot_sha256_hex: invalid snapshot SHA-256 ${input.snapshot_sha256}`
      );
    }
    if (
      input.snapshot_size_bytes !== undefined &&
      input.snapshot_size_bytes !== null &&
      input.snapshot_size_bytes < 0
    ) {
      throw new PostgresRlsError(
        "23514",
        `chk_mc_snapshot_size_nonneg: snapshot_size_bytes must be >= 0`
      );
    }

    // Fail-closed: require refs/heads/main to exist and match candidate base commit (FIX-12)
    const refs = this.gitRefsByProject.get(input.project_id);
    const currentMainSha = refs?.get("refs/heads/main");
    if (!refs || !currentMainSha) {
      throw new PostgresRlsError(
        "23503",
        `Project ${input.project_id} is missing required refs/heads/main pointer`
      );
    }
    if (input.base_main_commit_hash !== currentMainSha) {
      throw new PostgresRlsError(
        "23514",
        `Candidate base_main_commit_hash ${input.base_main_commit_hash} does not match current main ${currentMainSha}`
      );
    }

    const nowIso = this.clockTimestampIso();

    // Supersede any existing candidates for this task and invalidate their reviews & approvals
    for (const oldMc of this.mergeCandidates.values()) {
      if (oldMc.project_id === input.project_id && oldMc.task_id === input.task_id && !oldMc.is_superseded) {
        oldMc.is_superseded = true;
        this.invalidateArtifactsAndApprovalsForCandidate(
          oldMc.merge_candidate_id,
          "SUPERSEDED_BY_NEW_MERGE_CANDIDATE",
          "INVALIDATED_STALE_CANDIDATE"
        );
      }
    }

    // Also auto-invalidate any remaining VALID review artifacts on this task whose hash != new candidate hash
    for (const ra of this.reviewArtifacts.values()) {
      if (
        ra.project_id === input.project_id &&
        ra.task_id === input.task_id &&
        ra.merge_candidate_hash !== input.merge_candidate_hash &&
        (ra.status ?? "VALID") === "VALID"
      ) {
        ra.status = "INVALIDATED_STALE_CANDIDATE";
        ra.is_invalidated = true;
        ra.invalidated_reason = ra.invalidated_reason ?? "SUPERSEDED_BY_NEW_MERGE_CANDIDATE";
      }
    }

    const candidate: MergeCandidateRecord = {
      merge_candidate_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      import_id: input.import_id,
      agent_commit_hash: imp.agent_commit_hash,
      base_main_commit_hash: input.base_main_commit_hash,
      merge_candidate_hash: input.merge_candidate_hash,
      verified_tree_hash: input.verified_tree_hash,
      is_superseded: false,
      snapshot_path: input.snapshot_path ?? null,
      snapshot_sha256: input.snapshot_sha256 ?? null,
      snapshot_size_bytes: input.snapshot_size_bytes ?? null,
      snapshot_retention_class: input.snapshot_retention_class ?? "EPHEMERAL_14D",
      created_at: nowIso,
    };
    this.mergeCandidates.set(candidate.merge_candidate_id, candidate);

    // Register candidate commit in simulated bare repo
    const commits = this.gitCommitsByProject.get(input.project_id);
    commits?.set(input.merge_candidate_hash, {
      commitHash: input.merge_candidate_hash,
      treeHash: candidate.verified_tree_hash,
      parents: [input.base_main_commit_hash, imp.agent_commit_hash],
      taskId: input.task_id,
      mergeCandidateId: candidate.merge_candidate_id,
    });

    task.status = "VerifyingInDocker";
    task.active_merge_candidate_id = candidate.merge_candidate_id;
    task.updated_at = nowIso;

    return { ...candidate };
  }

  /**
   * Records a Merge Conflict while integrating `C_agent` onto `B_base` (`MVP-SPEC-04` §1.1 step 2).
   * Does NOT create a `merge_candidates` row; immediately transitions Task to `ReworkRequired`
   * (or `ManualIntervention` when `max_rework_cycles` is exhausted) with the conflicted file list.
   */
  public markMergeConflictReworkRequired(input: {
    project_id: string;
    task_id: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    conflicted_files: readonly string[];
    import_id?: string;
    conflict_summary?: string;
  }): { readonly task_status: TaskStatus; readonly conflicted_files: readonly string[] } {
    this.assertWritePermissionForProject(input.project_id);
    const task = this.tasks.get(input.task_id);
    if (!task || task.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", `Task ${input.task_id} not found for project`);
    }

    const nowIso = this.clockTimestampIso();
    task.status =
      task.rework_count < task.max_rework_cycles ? "ReworkRequired" : "ManualIntervention";
    this.closeActiveLeasesForTask(task, "COMPLETED");
    task.updated_at = nowIso;

    this.insertOutboxEventInternal(
      input.project_id,
      "task",
      task.task_id,
      "merge_candidate.conflict",
      {
        task_id: task.task_id,
        import_id: input.import_id ?? null,
        agent_commit_hash: input.agent_commit_hash,
        base_main_commit_hash: input.base_main_commit_hash,
        conflicted_files: [...input.conflicted_files],
        conflict_summary: input.conflict_summary ?? null,
        resulting_task_status: task.status,
      }
    );

    return {
      task_status: task.status,
      conflicted_files: [...input.conflicted_files],
    };
  }

  private closeActiveLeasesForTask(
    task: TaskRecord,
    targetStatus: "COMPLETED" | "REVOKED",
    reason?: string
  ): void {
    const nowIso = this.clockTimestampIso();
    for (const lease of this.taskLeases.values()) {
      if (lease.task_id === task.task_id && lease.status === "ACTIVE") {
        lease.status = targetStatus;
        if (targetStatus === "COMPLETED") {
          lease.completed_at = lease.completed_at ?? nowIso;
        } else {
          lease.revoked_at = lease.revoked_at ?? nowIso;
          lease.revoke_reason = lease.revoke_reason ?? reason ?? "TASK_SUPERSEDED";
        }
      }
    }
    task.active_lease_id = null;
  }

  private invalidateArtifactsAndApprovalsForCandidate(
    mergeCandidateId: string,
    reason: string,
    artifactStatus: ReviewArtifactStatus = "INVALIDATED_STALE_CANDIDATE"
  ): void {
    const nowIso = this.clockTimestampIso();
    for (const ra of this.reviewArtifacts.values()) {
      if (ra.merge_candidate_id === mergeCandidateId && (!ra.is_invalidated || (ra.status ?? "VALID") === "VALID")) {
        ra.is_invalidated = true;
        ra.invalidated_reason = reason;
        ra.status = artifactStatus;
      }
    }
    const targetRequestStatus =
      artifactStatus === "INVALIDATED_STALE_BASE"
        ? "INVALIDATED_STALE_BASE"
        : "INVALIDATED_STALE_CANDIDATE";
    for (const ar of this.approvalRequests.values()) {
      if (ar.merge_candidate_id === mergeCandidateId && ar.status === "PENDING") {
        ar.status = targetRequestStatus;
        ar.updated_at = nowIso;
      }
    }
    for (const ad of this.approvalDecisions.values()) {
      if (ad.merge_candidate_id === mergeCandidateId && ad.status === "ACTIVE") {
        ad.status = "INVALIDATED";
        ad.invalidated_reason = reason;
      }
    }
  }

  public recordVerificationRun(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
    verifier_image_digest: string;
    verdict: "PASS" | "FAIL";
    overall_status?: VerificationOverallStatus;
    tier1_trusted_acceptance_passed?: boolean | null;
    tier2_protected_baseline_passed?: boolean | null;
    tier2_baseline_tamper_detected?: boolean;
    tampered_baseline_paths?: readonly string[];
    tier3_agent_tests_passed?: boolean | null;
    tier3_assertions?: readonly Tier3AssertionEvidence[];
    infra_retry_count?: number;
    execution_backend?: VerificationExecutionBackend;
    hermetic_network_disabled?: boolean;
    hardlink_cache_forbidden?: boolean;
    is_docker_isolated?: boolean;
    trusted_policy_sha256?: string | null;
    keep_verifying_on_infra_retry?: boolean;
    exit_code: number;
    duration_ms: number;
    report_sha256: string;
  }): VerificationRunRecord {
    this.assertWritePermissionForProject(input.project_id);
    const mc = this.mergeCandidates.get(input.merge_candidate_id);
    const task = this.tasks.get(input.task_id);
    if (
      !mc ||
      !task ||
      mc.project_id !== input.project_id ||
      mc.task_id !== input.task_id ||
      mc.merge_candidate_hash !== input.merge_candidate_hash ||
      mc.verified_tree_hash !== input.verified_tree_hash ||
      mc.is_superseded
    ) {
      throw new PostgresRlsError(
        "23503",
        "VerificationRun composite foreign key binding mismatch against active MergeCandidate"
      );
    }

    const overallStatus: VerificationOverallStatus =
      input.overall_status ?? (input.verdict === "PASS" ? "PASSED" : "FAILED_ACCEPTANCE");
    const tamperDetected = input.tier2_baseline_tamper_detected ?? false;
    const infraRetryCount = input.infra_retry_count ?? 0;

    if (!Number.isInteger(infraRetryCount) || infraRetryCount < 0) {
      throw new PostgresRlsError("23514", "chk_vr_infra_retry_nonneg: infra_retry_count must be >= 0");
    }

    if (
      input.trusted_policy_sha256 !== undefined &&
      input.trusted_policy_sha256 !== null &&
      !/^[0-9a-f]{64}$/.test(input.trusted_policy_sha256)
    ) {
      throw new PostgresRlsError(
        "23514",
        `chk_vr_trusted_policy_sha256_hex: invalid trusted_policy_sha256 ${input.trusted_policy_sha256}`
      );
    }

    if (
      input.verdict === "PASS" &&
      (overallStatus !== "PASSED" ||
        tamperDetected ||
        input.tier1_trusted_acceptance_passed === false ||
        input.tier2_protected_baseline_passed === false ||
        input.tier3_agent_tests_passed === false)
    ) {
      throw new PostgresRlsError(
        "23514",
        `chk_vr_pass_consistency: cannot record PASS verdict with overall_status=${overallStatus}, tamperDetected=${String(
          tamperDetected
        )}, tier1=${String(input.tier1_trusted_acceptance_passed)}, tier2=${String(
          input.tier2_protected_baseline_passed
        )}, tier3=${String(input.tier3_agent_tests_passed)}`
      );
    }

    // Re-running Verifier automatically invalidates any previous reviews/approvals tied to an older run (MVP-SPEC-04 §3.1)
    this.invalidateArtifactsAndApprovalsForCandidate(
      mc.merge_candidate_id,
      "VERIFICATION_RUN_RERUN",
      "INVALIDATED_STALE_CANDIDATE"
    );

    const nowIso = this.clockTimestampIso();
    const record: VerificationRunRecord = {
      verification_run_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      merge_candidate_hash: input.merge_candidate_hash,
      verified_tree_hash: input.verified_tree_hash,
      verifier_image_digest: input.verifier_image_digest,
      verdict: input.verdict,
      overall_status: overallStatus,
      tier1_trusted_acceptance_passed:
        input.tier1_trusted_acceptance_passed !== undefined
          ? input.tier1_trusted_acceptance_passed
          : input.verdict === "PASS"
          ? true
          : null,
      tier2_protected_baseline_passed:
        input.tier2_protected_baseline_passed !== undefined
          ? input.tier2_protected_baseline_passed
          : input.verdict === "PASS"
          ? true
          : null,
      tier2_baseline_tamper_detected: tamperDetected,
      tampered_baseline_paths: [...(input.tampered_baseline_paths ?? [])],
      tier3_agent_tests_passed:
        input.tier3_agent_tests_passed !== undefined
          ? input.tier3_agent_tests_passed
          : input.verdict === "PASS"
          ? true
          : null,
      tier3_assertions: structuredClone(input.tier3_assertions ?? []),
      infra_retry_count: infraRetryCount,
      execution_backend: input.execution_backend ?? "docker",
      hermetic_network_disabled: input.hermetic_network_disabled ?? true,
      hardlink_cache_forbidden: input.hardlink_cache_forbidden ?? true,
      is_docker_isolated: input.is_docker_isolated ?? false,
      trusted_policy_sha256: input.trusted_policy_sha256 ?? null,
      exit_code: input.exit_code,
      duration_ms: input.duration_ms,
      report_sha256: input.report_sha256,
      created_at: nowIso,
    };
    this.verificationRuns.set(record.verification_run_id, record);

    if (input.verdict === "PASS") {
      task.status = "UnderIndependentReview";
    } else if (overallStatus === "INFRA_ERROR") {
      // INFRA_ERROR NEVER consumes rework_count; either keeps VerifyingInDocker while retrying
      // or escalates directly to ManualIntervention once retries are exhausted (MVP-SPEC-04 §2.3).
      task.status = input.keep_verifying_on_infra_retry ? "VerifyingInDocker" : "ManualIntervention";
      if (task.status === "ManualIntervention") {
        this.closeActiveLeasesForTask(task, "COMPLETED");
      }
    } else {
      task.status =
        task.rework_count < task.max_rework_cycles ? "ReworkRequired" : "ManualIntervention";
      this.closeActiveLeasesForTask(task, "COMPLETED");
    }
    task.updated_at = nowIso;

    this.insertOutboxEventInternal(
      input.project_id,
      "verification_run",
      record.verification_run_id,
      "verification.completed",
      {
        task_id: task.task_id,
        merge_candidate_id: mc.merge_candidate_id,
        merge_candidate_hash: mc.merge_candidate_hash,
        verdict: record.verdict,
        overall_status: record.overall_status,
        tier2_baseline_tamper_detected: record.tier2_baseline_tamper_detected,
        infra_retry_count: record.infra_retry_count,
        execution_backend: record.execution_backend,
        is_docker_isolated: record.is_docker_isolated,
        resulting_task_status: task.status,
      }
    );

    return { ...record };
  }

  /**
   * Records an ephemeral read-only Independent Reviewer Sandbox session (`review_sessions`).
   */
  public recordReviewSession(input: {
    review_session_id?: string;
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    verification_run_id: string;
    reviewer_principal_id: string;
    reviewer_credential_id: string;
    reviewer_agent_profile_id: string;
    reviewer_provider: string;
    reviewer_model: string;
    role: "ROLE_REVIEWER_READONLY";
    sandbox_backend_mode: string;
    sandbox_pid?: number | null;
    sandbox_cgroup_path?: string | null;
    cleanup_populated_zero_verified?: boolean;
    status?: ReviewSessionStatus;
    started_at?: string;
    completed_at?: string | null;
  }): ReviewSessionRecord {
    this.assertWritePermissionForProject(input.project_id);
    if (input.role !== "ROLE_REVIEWER_READONLY") {
      throw new PostgresRlsError(
        "23514",
        `review_sessions role must be ROLE_REVIEWER_READONLY, got ${String(input.role)}`
      );
    }
    if (
      !input.reviewer_principal_id.trim() ||
      !input.reviewer_credential_id.trim() ||
      !input.reviewer_agent_profile_id.trim() ||
      !input.reviewer_provider.trim() ||
      !input.reviewer_model.trim()
    ) {
      throw new PostgresRlsError(
        "23514",
        "review_sessions requires non-empty principal, credential, agent_profile, provider, and model"
      );
    }
    const task = this.tasks.get(input.task_id);
    const mc = this.mergeCandidates.get(input.merge_candidate_id);
    const vr = this.verificationRuns.get(input.verification_run_id);
    if (
      !task ||
      !mc ||
      !vr ||
      task.project_id !== input.project_id ||
      mc.project_id !== input.project_id ||
      vr.project_id !== input.project_id ||
      mc.task_id !== input.task_id ||
      vr.merge_candidate_id !== input.merge_candidate_id
    ) {
      throw new PostgresRlsError(
        "23503",
        "ReviewSession references non-existent or cross-tenant task, candidate, or verification run"
      );
    }

    const nowIso = this.clockTimestampIso();
    const record: ReviewSessionRecord = {
      review_session_id: input.review_session_id ?? randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      verification_run_id: input.verification_run_id,
      reviewer_principal_id: input.reviewer_principal_id.trim(),
      reviewer_credential_id: input.reviewer_credential_id.trim(),
      reviewer_agent_profile_id: input.reviewer_agent_profile_id.trim(),
      reviewer_provider: input.reviewer_provider.trim(),
      reviewer_model: input.reviewer_model.trim(),
      role: input.role,
      sandbox_backend_mode: input.sandbox_backend_mode,
      sandbox_pid: input.sandbox_pid ?? null,
      sandbox_cgroup_path: input.sandbox_cgroup_path ?? null,
      cleanup_populated_zero_verified: input.cleanup_populated_zero_verified ?? false,
      status: input.status ?? "ACTIVE",
      started_at: input.started_at ?? nowIso,
      completed_at: input.completed_at ?? null,
    };
    this.reviewSessions.set(record.review_session_id, record);
    return { ...record };
  }

  public completeReviewSession(input: {
    project_id: string;
    review_session_id: string;
    status: "COMPLETED" | "FAILED" | "REVOKED";
    cleanup_populated_zero_verified: boolean;
    sandbox_backend_mode?: string;
    sandbox_pid?: number | null;
    sandbox_cgroup_path?: string | null;
  }): ReviewSessionRecord {
    this.assertWritePermissionForProject(input.project_id);
    const session = this.reviewSessions.get(input.review_session_id);
    if (!session || session.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", `ReviewSession ${input.review_session_id} not found`);
    }
    session.status = input.status;
    session.cleanup_populated_zero_verified = input.cleanup_populated_zero_verified;
    if (input.sandbox_backend_mode !== undefined) {
      session.sandbox_backend_mode = input.sandbox_backend_mode;
    }
    if (input.sandbox_pid !== undefined) {
      session.sandbox_pid = input.sandbox_pid;
    }
    if (input.sandbox_cgroup_path !== undefined) {
      session.sandbox_cgroup_path = input.sandbox_cgroup_path;
    }
    session.completed_at = this.clockTimestampIso();
    return { ...session };
  }

  /**
   * 3D Independent Reviewer Artifact Recording (MVP-SPEC-04 Section 3.1)
   * Enforces:
   * 1. Model independence: `(writer_provider, writer_model) IS DISTINCT FROM (reviewer_provider, reviewer_model)`
   * 2. Principal independence: non-empty distinct `developer_principal_id` & `reviewer_principal_id`
   * 3. Session independence: non-empty distinct `developer_session_id` & `reviewer_session_id` (FIX-03)
   * 4. Credential & Agent Profile independence when provided (`chk_ra_independent_credential` / `chk_ra_independent_agent_profile`)
   * 5. Auto-creates TTL-bound `ApprovalRequest` (`PENDING`) when `verdict === "PASS"`.
   */
  public recordReviewArtifact(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    verification_run_id: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
    writer_provider: string;
    writer_model: string;
    reviewer_provider: string;
    reviewer_model: string;
    developer_principal_id: string;
    reviewer_principal_id: string;
    developer_session_id: string;
    reviewer_session_id: string;
    developer_credential_id?: string | null;
    reviewer_credential_id?: string | null;
    developer_agent_profile_id?: string | null;
    reviewer_agent_profile_id?: string | null;
    review_session_id?: string | null;
    summary_markdown?: string | null;
    report_sha256?: string | null;
    approval_request_ttl_ms?: number;
    verdict: "PASS" | "FAIL";
    findings_json?: ReadonlyArray<Record<string, unknown>>;
  }): ReviewArtifactRecord {
    this.assertWritePermissionForProject(input.project_id);

    const project = this.projects.get(input.project_id);
    if (!project) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
    }

    // Dimension 1: Model Identity Independence Check
    if (
      !input.writer_provider?.trim() ||
      !input.writer_model?.trim() ||
      !input.reviewer_provider?.trim() ||
      !input.reviewer_model?.trim()
    ) {
      throw new PostgresRlsError(
        "23514",
        "review_artifacts requires non-empty writer and reviewer provider/model identifiers"
      );
    }
    if (
      input.writer_provider.trim().toLowerCase() === input.reviewer_provider.trim().toLowerCase() &&
      input.writer_model.trim().toLowerCase() === input.reviewer_model.trim().toLowerCase()
    ) {
      throw new PostgresRlsError(
        "23514",
        `new row for relation "review_artifacts" violates check constraint "chk_independent_reviewer_model": writer (${input.writer_provider}/${input.writer_model}) must be distinct from reviewer (${input.reviewer_provider}/${input.reviewer_model})`
      );
    }

    // Dimension 2: Principal Identity Independence Check (FIX-03)
    const devPrincipal = typeof input.developer_principal_id === "string" ? input.developer_principal_id.trim() : "";
    const revPrincipal = typeof input.reviewer_principal_id === "string" ? input.reviewer_principal_id.trim() : "";
    if (!devPrincipal || !revPrincipal) {
      throw new PostgresRlsError(
        "23514",
        'new row for relation "review_artifacts" violates NOT NULL / non-empty constraint on developer_principal_id and reviewer_principal_id'
      );
    }
    if (devPrincipal.toLowerCase() === revPrincipal.toLowerCase()) {
      throw new PostgresRlsError(
        "23514",
        `new row violates check constraint "chk_independent_reviewer_principal": developer (${devPrincipal}) must be distinct from reviewer (${revPrincipal})`
      );
    }

    // Dimension 3: Session Independence Check (FIX-03)
    const devSession = typeof input.developer_session_id === "string" ? input.developer_session_id.trim() : "";
    const revSession = typeof input.reviewer_session_id === "string" ? input.reviewer_session_id.trim() : "";
    if (!devSession || !revSession) {
      throw new PostgresRlsError(
        "23514",
        'new row for relation "review_artifacts" violates NOT NULL / non-empty constraint on developer_session_id and reviewer_session_id'
      );
    }
    if (devSession.toLowerCase() === revSession.toLowerCase()) {
      throw new PostgresRlsError(
        "23514",
        `new row violates check constraint "chk_independent_reviewer_session": developer session (${devSession}) must be distinct from reviewer session`
      );
    }

    // Dimension 4: Credential Independence Check (`chk_ra_independent_credential`)
    const hasDevCred = input.developer_credential_id !== undefined && input.developer_credential_id !== null;
    const hasRevCred = input.reviewer_credential_id !== undefined && input.reviewer_credential_id !== null;
    const devCred = hasDevCred ? input.developer_credential_id!.trim() : null;
    const revCred = hasRevCred ? input.reviewer_credential_id!.trim() : null;
    if (hasDevCred || hasRevCred) {
      if (!devCred || !revCred || devCred.toLowerCase() === revCred.toLowerCase()) {
        throw new PostgresRlsError(
          "23514",
          `new row violates check constraint "chk_ra_independent_credential": developer credential (${String(
            devCred
          )}) must be non-empty and distinct from reviewer credential (${String(revCred)})`
        );
      }
    }

    // Dimension 5: Agent Profile Independence Check (`chk_ra_independent_agent_profile`)
    const hasDevProf =
      input.developer_agent_profile_id !== undefined && input.developer_agent_profile_id !== null;
    const hasRevProf =
      input.reviewer_agent_profile_id !== undefined && input.reviewer_agent_profile_id !== null;
    const devProfile = hasDevProf ? input.developer_agent_profile_id!.trim() : null;
    const revProfile = hasRevProf ? input.reviewer_agent_profile_id!.trim() : null;
    if (hasDevProf || hasRevProf) {
      if (!devProfile || !revProfile || devProfile.toLowerCase() === revProfile.toLowerCase()) {
        throw new PostgresRlsError(
          "23514",
          `new row violates check constraint "chk_ra_independent_agent_profile": developer profile (${String(
            devProfile
          )}) must be non-empty and distinct from reviewer profile (${String(revProfile)})`
        );
      }
    }

    if (
      input.report_sha256 !== undefined &&
      input.report_sha256 !== null &&
      !/^[0-9a-f]{64}$/.test(input.report_sha256)
    ) {
      throw new PostgresRlsError(
        "23514",
        `chk_ra_report_sha256_hex: invalid report SHA-256 ${input.report_sha256}`
      );
    }

    const vr = this.verificationRuns.get(input.verification_run_id);
    const mc = this.mergeCandidates.get(input.merge_candidate_id);
    const task = this.tasks.get(input.task_id);
    if (
      !vr ||
      !mc ||
      !task ||
      vr.project_id !== input.project_id ||
      vr.task_id !== input.task_id ||
      vr.merge_candidate_id !== input.merge_candidate_id ||
      vr.merge_candidate_hash !== input.merge_candidate_hash ||
      vr.verified_tree_hash !== input.verified_tree_hash ||
      vr.verdict !== "PASS" ||
      mc.is_superseded
    ) {
      throw new PostgresRlsError(
        "23503",
        "ReviewArtifact composite foreign key binding mismatch against PASS VerificationRun"
      );
    }

    // Bind strictly to the latest VerificationRun for this candidate
    let latestVr: VerificationRunRecord | undefined;
    for (const candidateVr of this.verificationRuns.values()) {
      if (candidateVr.project_id === input.project_id && candidateVr.merge_candidate_id === mc.merge_candidate_id) {
        latestVr = candidateVr;
      }
    }
    if (latestVr && latestVr.verification_run_id !== vr.verification_run_id) {
      throw new PostgresRlsError(
        "23503",
        `VerificationRun ${vr.verification_run_id} was superseded by newer run ${latestVr.verification_run_id}`
      );
    }

    // Validate ReviewSession FK binding if supplied
    if (input.review_session_id) {
      const rs = this.reviewSessions.get(input.review_session_id);
      if (
        !rs ||
        rs.project_id !== input.project_id ||
        rs.task_id !== input.task_id ||
        rs.merge_candidate_id !== input.merge_candidate_id ||
        rs.verification_run_id !== input.verification_run_id ||
        rs.role !== "ROLE_REVIEWER_READONLY" ||
        rs.reviewer_principal_id.toLowerCase() !== revPrincipal.toLowerCase() ||
        (revCred !== null && rs.reviewer_credential_id.toLowerCase() !== revCred.toLowerCase()) ||
        (revProfile !== null && rs.reviewer_agent_profile_id.toLowerCase() !== revProfile.toLowerCase())
      ) {
        throw new PostgresRlsError(
          "23503",
          `ReviewArtifact review_session_id ${input.review_session_id} binding mismatch`
        );
      }
    }

    const nowDate = this.clockFn();
    const nowIso = nowDate.toISOString();
    const record: ReviewArtifactRecord = {
      review_artifact_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      verification_run_id: input.verification_run_id,
      merge_candidate_hash: input.merge_candidate_hash,
      verified_tree_hash: input.verified_tree_hash,
      writer_provider: input.writer_provider,
      writer_model: input.writer_model,
      reviewer_provider: input.reviewer_provider,
      reviewer_model: input.reviewer_model,
      developer_principal_id: devPrincipal,
      reviewer_principal_id: revPrincipal,
      developer_session_id: devSession,
      reviewer_session_id: revSession,
      developer_credential_id: devCred,
      reviewer_credential_id: revCred,
      developer_agent_profile_id: devProfile,
      reviewer_agent_profile_id: revProfile,
      review_session_id: input.review_session_id ?? null,
      verdict: input.verdict,
      status: "VALID",
      is_invalidated: false,
      invalidated_reason: null,
      summary_markdown: input.summary_markdown ?? null,
      report_sha256: input.report_sha256 ?? null,
      findings_json: input.findings_json ?? [],
      created_at: nowIso,
    };
    this.reviewArtifacts.set(record.review_artifact_id, record);

    if (input.verdict === "PASS") {
      task.status = "AwaitingHumanApproval";

      // Supersede any stale PENDING ApprovalRequest for this candidate and create a fresh PENDING request
      for (const oldAr of this.approvalRequests.values()) {
        if (oldAr.merge_candidate_id === mc.merge_candidate_id && oldAr.status === "PENDING") {
          oldAr.status = "INVALIDATED_STALE_CANDIDATE";
          oldAr.updated_at = nowIso;
        }
      }
      const reqTtlMs = input.approval_request_ttl_ms ?? project.approval_ttl_seconds * 1000;
      if (reqTtlMs <= 0) {
        throw new PostgresRlsError("23514", "chk_ar_ttl_window: expires_at must be > created_at");
      }
      const approvalRequest: ApprovalRequestRecord = {
        approval_request_id: randomUUID(),
        project_id: input.project_id,
        task_id: input.task_id,
        merge_candidate_id: mc.merge_candidate_id,
        agent_commit_hash: mc.agent_commit_hash,
        base_main_commit_hash: mc.base_main_commit_hash,
        merge_candidate_hash: mc.merge_candidate_hash,
        verified_tree_hash: mc.verified_tree_hash,
        verification_run_id: vr.verification_run_id,
        review_artifact_id: record.review_artifact_id,
        status: "PENDING",
        expires_at: new Date(nowDate.getTime() + reqTtlMs).toISOString(),
        created_at: nowIso,
        updated_at: nowIso,
      };
      this.approvalRequests.set(approvalRequest.approval_request_id, approvalRequest);
    } else {
      task.status =
        task.rework_count < task.max_rework_cycles ? "ReworkRequired" : "ManualIntervention";
      this.closeActiveLeasesForTask(task, "COMPLETED");
    }
    task.updated_at = nowIso;
    return { ...record };
  }

  private findApprovalRequestForApproval(input: {
    approval_request_id?: string;
    merge_candidate_id: string;
    review_artifact_id: string;
  }): ApprovalRequestRecord | undefined {
    if (input.approval_request_id) {
      return this.approvalRequests.get(input.approval_request_id);
    }
    let matched: ApprovalRequestRecord | undefined;
    for (const ar of this.approvalRequests.values()) {
      if (
        ar.merge_candidate_id === input.merge_candidate_id &&
        ar.review_artifact_id === input.review_artifact_id
      ) {
        if (ar.status === "PENDING") {
          return ar;
        }
        matched = ar;
      }
    }
    return matched;
  }

  /**
   * 8-Field Cryptographically Bound Human Approval (MVP-SPEC-02 Section 2 & MVP-SPEC-04 Section 4)
   * Enforces fail-closed RBAC membership (`PROJECT_APPROVER` | `ORG_ADMIN`), RLS-T8 8-field FK binding,
   * `ApprovalRequest` TTL enforcement (`expires_at > clock_timestamp()`, throwing `409 ERR_APPROVAL_EXPIRED_OR_STALE`),
   * live `refs/heads/main` stale-base detection, `REQUEST_CHANGES` rework transitions, and project-configured TTL.
   */
  public submitHumanApproval(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_request_id?: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    verified_tree_hash: string;
    merge_candidate_hash: string;
    verification_run_id: string;
    review_artifact_id: string;
    approver_principal_id: string;
    decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    feedback?: string;
    ttl_ms?: number;
    current_main_commit_hash?: string;
  }): ApprovalDecisionRecord {
    this.assertWritePermissionForProject(input.project_id);

    const project = this.projects.get(input.project_id);
    if (!project) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
    }

    // Fail-closed project membership & RBAC verification (FIX-11)
    const membership = this.getProjectMembership(input.project_id, input.approver_principal_id);
    if (
      !membership ||
      (membership.member_role !== "PROJECT_APPROVER" && membership.member_role !== "ORG_ADMIN")
    ) {
      throw new PostgresRlsError(
        "42501",
        `Principal ${input.approver_principal_id} (${
          membership ? `role=${membership.member_role}` : "no project membership"
        }) is not authorized to approve in project ${input.project_id}`
      );
    }

    const mc = this.mergeCandidates.get(input.merge_candidate_id);
    const ra = this.reviewArtifacts.get(input.review_artifact_id);
    const vr = this.verificationRuns.get(input.verification_run_id);
    const task = this.tasks.get(input.task_id);

    // Enforce maximum 1 ACTIVE approval per candidate (uq_one_active_approval_per_candidate)
    for (const ad of this.approvalDecisions.values()) {
      if (ad.merge_candidate_id === input.merge_candidate_id && ad.status === "ACTIVE") {
        throw new PostgresRlsError(
          "23505",
          `An ACTIVE approval already exists for merge candidate ${input.merge_candidate_id}`
        );
      }
    }

    // Enforce task status is AwaitingHumanApproval before receiving human approval
    if (task && task.project_id === input.project_id && task.status !== "AwaitingHumanApproval") {
      throw new PostgresRlsError(
        "23514",
        `Task must be in AwaitingHumanApproval status to receive human approval, got ${task.status}`
      );
    }

    // Enforce Composite Foreign Key fk_ad_candidate_8fields & fk_ad_review_binding (RLS-T8)
    if (
      !mc ||
      !ra ||
      !vr ||
      !task ||
      mc.project_id !== input.project_id ||
      mc.task_id !== input.task_id ||
      mc.agent_commit_hash !== input.agent_commit_hash ||
      mc.base_main_commit_hash !== input.base_main_commit_hash ||
      mc.merge_candidate_hash !== input.merge_candidate_hash ||
      mc.verified_tree_hash !== input.verified_tree_hash ||
      mc.is_superseded ||
      ra.project_id !== input.project_id ||
      ra.task_id !== input.task_id ||
      ra.merge_candidate_id !== input.merge_candidate_id ||
      ra.verification_run_id !== input.verification_run_id ||
      ra.merge_candidate_hash !== input.merge_candidate_hash ||
      ra.verified_tree_hash !== input.verified_tree_hash ||
      ra.is_invalidated ||
      (ra.status ?? "VALID") !== "VALID" ||
      ra.verdict !== "PASS" ||
      vr.verdict !== "PASS"
    ) {
      throw new PostgresRlsError(
        "23503",
        'insert or update on table "approval_decisions" violates composite 8-field foreign key constraint'
      );
    }

    const nowDate = this.clockFn();
    const nowIso = nowDate.toISOString();
    const approvalRequest = this.findApprovalRequestForApproval({
      approval_request_id: input.approval_request_id,
      merge_candidate_id: mc.merge_candidate_id,
      review_artifact_id: ra.review_artifact_id,
    });

    if (
      input.approval_request_id &&
      (!approvalRequest ||
        approvalRequest.project_id !== input.project_id ||
        approvalRequest.task_id !== input.task_id ||
        approvalRequest.merge_candidate_id !== mc.merge_candidate_id ||
        approvalRequest.review_artifact_id !== ra.review_artifact_id ||
        approvalRequest.verification_run_id !== vr.verification_run_id ||
        approvalRequest.agent_commit_hash !== mc.agent_commit_hash ||
        approvalRequest.base_main_commit_hash !== mc.base_main_commit_hash ||
        approvalRequest.merge_candidate_hash !== mc.merge_candidate_hash ||
        approvalRequest.verified_tree_hash !== mc.verified_tree_hash)
    ) {
      throw new PostgresRlsError(
        "23503",
        `ApprovalRequest ${input.approval_request_id} violates composite binding to candidate ${mc.merge_candidate_id} / review ${ra.review_artifact_id}`
      );
    }

    if (input.decision === "APPROVED") {
      // Check live refs/heads/main against candidate.base_main_commit_hash before granting approval (MVP-SPEC-04 §4)
      const refs = this.gitRefsByProject.get(input.project_id);
      const liveMainSha = input.current_main_commit_hash ?? refs?.get("refs/heads/main");
      if (!liveMainSha || liveMainSha !== mc.base_main_commit_hash) {
        if (liveMainSha && refs) {
          refs.set("refs/heads/main", liveMainSha);
          project.main_ref_commit_hash = liveMainSha;
          project.updated_at = nowIso;
        }
        mc.is_superseded = true;
        this.invalidateArtifactsAndApprovalsForCandidate(
          mc.merge_candidate_id,
          `APPROVAL_REJECTED_STALE_BASE_${mc.base_main_commit_hash}_VS_${String(liveMainSha)}`,
          "INVALIDATED_STALE_BASE"
        );
        if (approvalRequest) {
          approvalRequest.status = "INVALIDATED_STALE_BASE";
          approvalRequest.updated_at = nowIso;
        }
        task.status = "BuildingMergeCandidate";
        if (liveMainSha) {
          task.base_main_commit_hash = liveMainSha;
        }
        task.active_merge_candidate_id = null;
        task.updated_at = nowIso;
        throw new ApprovalExpiredOrStaleError(
          `ERR_APPROVAL_EXPIRED_OR_STALE: candidate base_main_commit_hash ${mc.base_main_commit_hash} is stale against live main ${String(
            liveMainSha
          )}`,
          "INVALIDATED_STALE_BASE"
        );
      }

      // Check ApprovalRequest presence, PENDING state, and TTL against clock_timestamp() (MVP-SPEC-04 §4)
      if (
        !approvalRequest ||
        approvalRequest.status !== "PENDING" ||
        new Date(approvalRequest.expires_at).getTime() <= nowDate.getTime()
      ) {
        if (approvalRequest) {
          approvalRequest.status = "INVALIDATED_EXPIRED";
          approvalRequest.updated_at = nowIso;
        }
        mc.is_superseded = true;
        this.invalidateArtifactsAndApprovalsForCandidate(
          mc.merge_candidate_id,
          approvalRequest ? "APPROVAL_REQUEST_TTL_EXPIRED" : "APPROVAL_REQUEST_MISSING",
          "INVALIDATED_STALE_CANDIDATE"
        );
        task.status = "BuildingMergeCandidate";
        task.active_merge_candidate_id = null;
        task.updated_at = nowIso;
        throw new ApprovalExpiredOrStaleError(
          approvalRequest
            ? `ERR_APPROVAL_EXPIRED_OR_STALE: ApprovalRequest ${approvalRequest.approval_request_id} expired or not PENDING (status=${approvalRequest.status}, expires_at=${approvalRequest.expires_at})`
            : `ERR_APPROVAL_EXPIRED_OR_STALE: No PENDING ApprovalRequest exists for candidate ${mc.merge_candidate_id} and review ${ra.review_artifact_id}`,
          "INVALIDATED_EXPIRED"
        );
      }
    }

    const ttlMs = input.ttl_ms ?? project.approval_ttl_seconds * 1000;
    if (ttlMs <= 0) {
      throw new PostgresRlsError("23514", "chk_approval_ttl_window: expires_at must be > approved_at");
    }

    const record: ApprovalDecisionRecord = {
      approval_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      approval_request_id: approvalRequest?.approval_request_id ?? null,
      agent_commit_hash: input.agent_commit_hash,
      base_main_commit_hash: input.base_main_commit_hash,
      verified_tree_hash: input.verified_tree_hash,
      merge_candidate_hash: input.merge_candidate_hash,
      verification_run_id: input.verification_run_id,
      review_artifact_id: input.review_artifact_id,
      approver_principal_id: input.approver_principal_id,
      decision: input.decision,
      status: input.decision === "APPROVED" ? "ACTIVE" : "CONSUMED",
      invalidated_reason: null,
      approved_at: nowIso,
      expires_at: new Date(nowDate.getTime() + ttlMs).toISOString(),
      consumed_at: input.decision === "APPROVED" ? null : nowIso,
    };

    if (approvalRequest) {
      approvalRequest.status = input.decision === "APPROVED" ? "APPROVED" : "REJECTED";
      approvalRequest.updated_at = nowIso;
    }

    this.approvalDecisions.set(record.approval_id, record);
    if (input.decision === "APPROVED") {
      task.status = "AtomicCasMerge";
    } else if (input.decision === "REQUEST_CHANGES") {
      task.status =
        task.rework_count < task.max_rework_cycles ? "ReworkRequired" : "ManualIntervention";
      this.closeActiveLeasesForTask(task, "COMPLETED");
    } else {
      task.status = "ManualIntervention";
      this.closeActiveLeasesForTask(task, "COMPLETED");
    }
    task.updated_at = nowIso;

    this.insertOutboxEventInternal(
      input.project_id,
      "approval_decision",
      record.approval_id,
      "human.approval_decided",
      {
        task_id: task.task_id,
        merge_candidate_id: mc.merge_candidate_id,
        approval_request_id: approvalRequest?.approval_request_id ?? null,
        decision: input.decision,
        approver_principal_id: input.approver_principal_id,
        resulting_task_status: task.status,
        ...(input.feedback ? { feedback: input.feedback } : {}),
      }
    );

    return { ...record };
  }

  /**
   * Simulates an external fast-forward or commit on `refs/heads/main` (e.g. another task merged)
   * or a crashed CAS where `refs/heads/main` was updated right before DB transaction crashed.
   */
  public forceSetMainRefCommitHashForTest(projectId: string, newMainCommitHash: string): void {
    const project = this.projects.get(projectId);
    const refs = this.gitRefsByProject.get(projectId);
    if (project && refs) {
      project.main_ref_commit_hash = newMainCommitHash;
      refs.set("refs/heads/main", newMainCommitHash);
    }
  }

  public deleteGitRefForTest(projectId: string, refName: string): void {
    const refs = this.gitRefsByProject.get(projectId);
    refs?.delete(refName);
  }

  /**
   * @internal Test-only fault-injection helper for verifying fail-closed `409 ERR_APPROVAL_EXPIRED_OR_STALE`
   * when an `ApprovalRequest` record is absent. Requires an active RLS write transaction for the record's project.
   */
  public deleteApprovalRequestForTest(approvalRequestId: string): boolean {
    const existing = this.approvalRequests.get(approvalRequestId);
    if (!existing) {
      return false;
    }
    this.assertWritePermissionForProject(existing.project_id);
    return this.approvalRequests.delete(approvalRequestId);
  }

  private getOrCreateMergeOperation(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_id: string;
    base_main_commit_hash: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
    nowIso: string;
  }): { record: MergeOperationRecord; isRetryOfExisting: boolean } {
    const key = `merge:${input.project_id}:${input.task_id}:${input.merge_candidate_hash}:${input.approval_id}`;
    for (const existing of this.mergeOperations.values()) {
      if (existing.project_id === input.project_id && existing.merge_idempotency_key === key) {
        return { record: existing, isRetryOfExisting: true };
      }
    }
    const record: MergeOperationRecord = {
      merge_op_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      approval_id: input.approval_id,
      merge_idempotency_key: key,
      base_main_commit_hash: input.base_main_commit_hash,
      merge_candidate_hash: input.merge_candidate_hash,
      verified_tree_hash: input.verified_tree_hash,
      status: "IN_PROGRESS",
      reconciled_after_lost_response: false,
      retry_count: 0,
      last_error: null,
      created_at: input.nowIso,
      completed_at: null,
    };
    this.mergeOperations.set(record.merge_op_id, record);
    return { record, isRetryOfExisting: false };
  }

  /**
   * 6-Step Post-Merge Reconciler & Idempotent Atomic CAS Merge (MVP-SPEC-04 Section 5.1 & Section 5.2)
   * Handles:
   * - `merge_operations` idempotency tracking (`merge:<project_id>:<task_id>:<merge_candidate_hash>:<approval_id>`)
   * - Already `MergedAndCompleted` strict idempotent return (no extra outbox events, Git commits, or retry_count increments)
   * - Crash after `git update-ref` succeeded (`currentMainSha === merge_candidate_hash`) -> reconciles DB to `MergedAndCompleted` with `reconciled_after_lost_response = true`
   * - Approval TTL expiry (`expires_at <= clock_timestamp()`) -> marks approval `EXPIRED` and transitions task to `AwaitingHumanApproval` (and updates `ApprovalRequest` appropriately)
   * - True CAS conflict (`currentMainSha !== base_main_commit_hash`) -> marks `merge_operations` `CAS_CONFLICT_ABORTED`, supersedes candidate, marks review/approval `INVALIDATED_STALE_BASE`, updates `base_main_commit_hash`, and transitions task to `BuildingMergeCandidate`
   * - Clean CAS (`currentMainSha === base_main_commit_hash`) -> atomically updates `refs/heads/main` to `merge_candidate_hash`, marks approval `CONSUMED` & `merge_operations` `MERGED`, and transitions task to `MergedAndCompleted`.
   */
  public async executeAtomicCasMergeOrReconcile(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_id: string;
    gitBridge?: {
      readonly getCurrentMainHead: () => string;
      readonly atomicCompareAndSwapMainRef: (
        expectedOldSha: string,
        newCandidateSha: string
      ) => boolean;
    };
    simulateCrashAfterGitUpdateRef?: boolean;
  }): Promise<CasMergeResult> {
    this.assertWritePermissionForProject(input.project_id);

    return this.withSerializedLock(`project-merge:${input.project_id}`, () => {
      const nowDate = this.clockFn();
      const nowIso = nowDate.toISOString();

      const project = this.projects.get(input.project_id);
      const task = this.tasks.get(input.task_id);
      const mc = this.mergeCandidates.get(input.merge_candidate_id);
      const approval = this.approvalDecisions.get(input.approval_id);
      const refs = this.gitRefsByProject.get(input.project_id);

      if (!project || !task || !mc || !approval || !refs) {
        throw new Error("Missing project, task, merge_candidate, or approval_decision for CAS merge");
      }

      // Step 0: Enforce approval decision & binding (FIX-01)
      if (approval.decision !== "APPROVED") {
        throw new Error(`Cannot merge candidate with decision ${approval.decision}`);
      }
      if (
        approval.project_id !== input.project_id ||
        approval.task_id !== input.task_id ||
        approval.merge_candidate_id !== input.merge_candidate_id
      ) {
        throw new Error("Approval decision does not bind to the specified task and merge candidate");
      }
      if (task.status !== "AtomicCasMerge" && task.status !== "MergedAndCompleted") {
        throw new Error(
          `Task must be in AtomicCasMerge status for CAS merge, current status is ${task.status}`
        );
      }

      const currentMainSha = input.gitBridge
        ? input.gitBridge.getCurrentMainHead()
        : refs.get("refs/heads/main");
      if (!currentMainSha) {
        throw new PostgresRlsError(
          "23503",
          `Project ${input.project_id} is missing required refs/heads/main pointer`
        );
      }

      // Step 1: If DB already recorded MergedAndCompleted, return strictly idempotently
      // without creating duplicate merge_operations or inflating retry_count.
      if (task.status === "MergedAndCompleted" && task.merged_commit_hash) {
        let existingOp: MergeOperationRecord | undefined;
        for (const op of this.mergeOperations.values()) {
          if (
            op.project_id === input.project_id &&
            op.task_id === input.task_id &&
            op.approval_id === approval.approval_id
          ) {
            existingOp = op;
            break;
          }
          if (
            !existingOp &&
            op.project_id === input.project_id &&
            op.task_id === input.task_id &&
            op.merge_candidate_id === mc.merge_candidate_id &&
            op.status === "MERGED"
          ) {
            existingOp = op;
          }
        }
        if (existingOp && existingOp.status !== "MERGED") {
          existingOp.status = "MERGED";
          existingOp.completed_at = existingOp.completed_at ?? nowIso;
        }
        return {
          status: "RECONCILED_ALREADY_MERGED",
          task_status: "MergedAndCompleted",
          merged_commit_hash: task.merged_commit_hash,
          main_ref_commit_hash: currentMainSha,
          ...(existingOp ? { merge_op_id: existingOp.merge_op_id } : {}),
          reconciled_after_lost_response: existingOp?.reconciled_after_lost_response ?? false,
        };
      }

      const { record: mergeOp, isRetryOfExisting } = this.getOrCreateMergeOperation({
        project_id: input.project_id,
        task_id: input.task_id,
        merge_candidate_id: mc.merge_candidate_id,
        approval_id: approval.approval_id,
        base_main_commit_hash: mc.base_main_commit_hash,
        merge_candidate_hash: mc.merge_candidate_hash,
        verified_tree_hash: mc.verified_tree_hash,
        nowIso,
      });
      if (isRetryOfExisting && mergeOp.status === "IN_PROGRESS") {
        mergeOp.retry_count += 1;
      }

      const linkedApprovalRequest = approval.approval_request_id
        ? this.approvalRequests.get(approval.approval_request_id)
        : undefined;

      // Step 2: Check if Git `refs/heads/main` ALREADY contains `merge_candidate_hash`
      // (Recovering from crash after Git CAS succeeded but before DB commit completed!)
      if (currentMainSha === mc.merge_candidate_hash) {
        if (approval.status === "ACTIVE") {
          approval.status = "CONSUMED";
          approval.consumed_at = nowIso;
        }
        if (linkedApprovalRequest && linkedApprovalRequest.status !== "APPROVED") {
          linkedApprovalRequest.status = "APPROVED";
          linkedApprovalRequest.updated_at = nowIso;
        }
        refs.set("refs/heads/main", mc.merge_candidate_hash);
        project.main_ref_commit_hash = mc.merge_candidate_hash;
        project.updated_at = nowIso;

        mc.snapshot_retention_class = "MERGED_PERMANENT";
        mergeOp.status = "MERGED";
        mergeOp.reconciled_after_lost_response = true;
        mergeOp.last_error = null;
        mergeOp.completed_at = nowIso;

        task.status = "MergedAndCompleted";
        task.merged_commit_hash = mc.merge_candidate_hash;
        task.merged_at = nowIso;
        this.closeActiveLeasesForTask(task, "COMPLETED");
        task.updated_at = nowIso;

        this.insertOutboxEventInternal(
          input.project_id,
          "task",
          task.task_id,
          "task.merged_reconciled",
          {
            task_id: task.task_id,
            merge_candidate_id: mc.merge_candidate_id,
            merged_commit_hash: mc.merge_candidate_hash,
            merge_op_id: mergeOp.merge_op_id,
          }
        );

        return {
          status: "RECONCILED_ALREADY_MERGED",
          task_status: "MergedAndCompleted",
          merged_commit_hash: mc.merge_candidate_hash,
          main_ref_commit_hash: currentMainSha,
          merge_op_id: mergeOp.merge_op_id,
          reconciled_after_lost_response: true,
        };
      }

      // Step 3: Verify Approval TTL & Active Status against real-time clock_timestamp()
      if (
        approval.status !== "ACTIVE" ||
        new Date(approval.expires_at).getTime() <= nowDate.getTime()
      ) {
        if (approval.status === "ACTIVE") {
          approval.status = "EXPIRED";
          approval.invalidated_reason = "APPROVAL_TTL_EXPIRED";
        }
        mergeOp.last_error = "APPROVAL_TTL_EXPIRED";
        if (linkedApprovalRequest) {
          const reqExpired =
            new Date(linkedApprovalRequest.expires_at).getTime() <= nowDate.getTime();
          linkedApprovalRequest.status = reqExpired ? "INVALIDATED_EXPIRED" : "PENDING";
          linkedApprovalRequest.updated_at = nowIso;
        }
        task.status = "AwaitingHumanApproval";
        task.updated_at = nowIso;

        return {
          status: "APPROVAL_EXPIRED",
          task_status: task.status,
          merged_commit_hash: null,
          main_ref_commit_hash: currentMainSha,
          invalidated_approval_id: approval.approval_id,
          merge_op_id: mergeOp.merge_op_id,
        };
      }

      const abortForTrueCasConflict = (observedMainSha: string): CasMergeResult => {
        refs.set("refs/heads/main", observedMainSha);
        project.main_ref_commit_hash = observedMainSha;
        project.updated_at = nowIso;

        mergeOp.status = "CAS_CONFLICT_ABORTED";
        mergeOp.last_error = `CAS_MAIN_MOVED_FROM_${mc.base_main_commit_hash}_TO_${observedMainSha}`;
        mergeOp.completed_at = nowIso;

        mc.is_superseded = true;
        this.invalidateArtifactsAndApprovalsForCandidate(
          mc.merge_candidate_id,
          mergeOp.last_error,
          "INVALIDATED_STALE_BASE"
        );
        if (linkedApprovalRequest) {
          linkedApprovalRequest.status = "INVALIDATED_STALE_BASE";
          linkedApprovalRequest.updated_at = nowIso;
        }
        task.status = "BuildingMergeCandidate";
        task.base_main_commit_hash = observedMainSha;
        task.active_merge_candidate_id = null;
        task.updated_at = nowIso;

        this.insertOutboxEventInternal(
          input.project_id,
          "merge_operation",
          mergeOp.merge_op_id,
          "merge.cas_conflict_detected",
          {
            task_id: task.task_id,
            merge_candidate_id: mc.merge_candidate_id,
            stale_base_main_commit_hash: mc.base_main_commit_hash,
            observed_main_commit_hash: observedMainSha,
          }
        );

        return {
          status: "CAS_CONFLICT_NEEDS_REBASE",
          task_status: "BuildingMergeCandidate",
          merged_commit_hash: null,
          main_ref_commit_hash: observedMainSha,
          invalidated_approval_id: approval.approval_id,
          merge_op_id: mergeOp.merge_op_id,
        };
      };

      // Step 4: Check if `refs/heads/main` moved away from `base_main_commit_hash` (True CAS Conflict)
      if (currentMainSha !== mc.base_main_commit_hash) {
        return abortForTrueCasConflict(currentMainSha);
      }

      // Step 5: Execute Atomic Git CAS (`git update-ref refs/heads/main <merge_candidate_hash> <base_main_commit_hash>`)
      if (input.gitBridge) {
        const casOk = input.gitBridge.atomicCompareAndSwapMainRef(
          mc.base_main_commit_hash,
          mc.merge_candidate_hash
        );
        if (!casOk) {
          const racedMainSha = input.gitBridge.getCurrentMainHead();
          if (racedMainSha === mc.merge_candidate_hash) {
            // Concurrent process already landed the exact same candidate commit -> reconcile
            approval.status = "CONSUMED";
            approval.consumed_at = nowIso;
            if (linkedApprovalRequest) {
              linkedApprovalRequest.status = "APPROVED";
              linkedApprovalRequest.updated_at = nowIso;
            }
            refs.set("refs/heads/main", mc.merge_candidate_hash);
            project.main_ref_commit_hash = mc.merge_candidate_hash;
            project.updated_at = nowIso;
            mc.snapshot_retention_class = "MERGED_PERMANENT";
            mergeOp.status = "MERGED";
            mergeOp.reconciled_after_lost_response = true;
            mergeOp.completed_at = nowIso;
            task.status = "MergedAndCompleted";
            task.merged_commit_hash = mc.merge_candidate_hash;
            task.merged_at = nowIso;
            this.closeActiveLeasesForTask(task, "COMPLETED");
            task.updated_at = nowIso;
            this.insertOutboxEventInternal(
              input.project_id,
              "task",
              task.task_id,
              "task.merged_reconciled",
              {
                task_id: task.task_id,
                merge_candidate_id: mc.merge_candidate_id,
                merged_commit_hash: mc.merge_candidate_hash,
                merge_op_id: mergeOp.merge_op_id,
              }
            );
            return {
              status: "RECONCILED_ALREADY_MERGED",
              task_status: "MergedAndCompleted",
              merged_commit_hash: mc.merge_candidate_hash,
              main_ref_commit_hash: racedMainSha,
              merge_op_id: mergeOp.merge_op_id,
              reconciled_after_lost_response: true,
            };
          }
          return abortForTrueCasConflict(racedMainSha);
        }
      }

      // Fault-injection point: simulates lost response / DB crash AFTER Git `update-ref` already moved `refs/heads/main`!
      // Git `refs/heads/main` holds <mc.merge_candidate_hash>; DB keeps merge_operations='IN_PROGRESS' & task='AtomicCasMerge'.
      if (input.simulateCrashAfterGitUpdateRef) {
        if (!input.gitBridge) {
          refs.set("refs/heads/main", mc.merge_candidate_hash);
          project.main_ref_commit_hash = mc.merge_candidate_hash;
          project.updated_at = nowIso;
        }
        mergeOp.last_error = "ERR_SIMULATED_POST_MERGE_CRASH";
        throw new SimulatedPostMergeCrashError(
          `Simulated crash right after git update-ref moved refs/heads/main to ${mc.merge_candidate_hash}`,
          mergeOp.merge_op_id
        );
      }

      // Step 6: Commit DB state synchronously with merged Git main head
      refs.set("refs/heads/main", mc.merge_candidate_hash);
      project.main_ref_commit_hash = mc.merge_candidate_hash;
      project.updated_at = nowIso;

      mc.snapshot_retention_class = "MERGED_PERMANENT";
      approval.status = "CONSUMED";
      approval.consumed_at = nowIso;
      if (linkedApprovalRequest) {
        linkedApprovalRequest.status = "APPROVED";
        linkedApprovalRequest.updated_at = nowIso;
      }
      mergeOp.status = "MERGED";
      mergeOp.last_error = null;
      mergeOp.completed_at = nowIso;
      task.status = "MergedAndCompleted";
      task.merged_commit_hash = mc.merge_candidate_hash;
      task.merged_at = nowIso;
      this.closeActiveLeasesForTask(task, "COMPLETED");
      task.updated_at = nowIso;

      this.insertOutboxEventInternal(
        input.project_id,
        "task",
        task.task_id,
        "task.merged",
        {
          task_id: task.task_id,
          merge_candidate_id: mc.merge_candidate_id,
          merged_commit_hash: mc.merge_candidate_hash,
          approval_id: approval.approval_id,
          merge_op_id: mergeOp.merge_op_id,
        }
      );

      return {
        status: "MERGED_BY_CAS",
        task_status: "MergedAndCompleted",
        merged_commit_hash: mc.merge_candidate_hash,
        main_ref_commit_hash: mc.merge_candidate_hash,
        merge_op_id: mergeOp.merge_op_id,
        reconciled_after_lost_response: false,
      };
    });
  }

  public getMainRefCommitHash(projectId?: string): string | null {
    const session = this.getCurrentRlsSession();
    const targetProjectId = projectId ?? (session.currentProjectId?.trim() || null);
    if (!targetProjectId) {
      return null;
    }
    if (
      session.currentRole !== "system_admin_role" &&
      session.currentProjectId !== targetProjectId
    ) {
      return null;
    }
    return this.gitRefsByProject.get(targetProjectId)?.get("refs/heads/main") ?? null;
  }

  public getMergeCandidateById(mergeCandidateId: string): MergeCandidateRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const mc = this.mergeCandidates.get(mergeCandidateId);
    if (!mc || mc.project_id !== currentProjectId) {
      return null;
    }
    return { ...mc };
  }

  public listMergeCandidatesForTask(taskId: string): MergeCandidateRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: MergeCandidateRecord[] = [];
    for (const mc of this.mergeCandidates.values()) {
      if (mc.project_id === currentProjectId && mc.task_id === taskId) {
        list.push({ ...mc });
      }
    }
    return list;
  }

  public listVerificationRunsForTask(taskId: string): VerificationRunRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: VerificationRunRecord[] = [];
    for (const vr of this.verificationRuns.values()) {
      if (vr.project_id === currentProjectId && vr.task_id === taskId) {
        list.push({ ...vr });
      }
    }
    return list;
  }

  public getReviewSessionById(reviewSessionId: string): ReviewSessionRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const rs = this.reviewSessions.get(reviewSessionId);
    if (!rs || rs.project_id !== currentProjectId) {
      return null;
    }
    return { ...rs };
  }

  public listReviewSessionsForTask(taskId: string): ReviewSessionRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ReviewSessionRecord[] = [];
    for (const rs of this.reviewSessions.values()) {
      if (rs.project_id === currentProjectId && rs.task_id === taskId) {
        list.push({ ...rs });
      }
    }
    return list;
  }

  public getApprovalById(approvalId: string): ApprovalDecisionRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const ad = this.approvalDecisions.get(approvalId);
    if (!ad || ad.project_id !== currentProjectId) {
      return null;
    }
    return { ...ad };
  }

  public listApprovalDecisionsForTask(taskId: string): ApprovalDecisionRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ApprovalDecisionRecord[] = [];
    for (const ad of this.approvalDecisions.values()) {
      if (ad.project_id === currentProjectId && ad.task_id === taskId) {
        list.push({ ...ad });
      }
    }
    return list;
  }

  public getApprovalRequestById(approvalRequestId: string): ApprovalRequestRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const ar = this.approvalRequests.get(approvalRequestId);
    if (!ar || ar.project_id !== currentProjectId) {
      return null;
    }
    return { ...ar };
  }

  public getLatestApprovalRequestForCandidate(
    mergeCandidateId: string
  ): ApprovalRequestRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    let latest: ApprovalRequestRecord | null = null;
    for (const ar of this.approvalRequests.values()) {
      if (ar.project_id === currentProjectId && ar.merge_candidate_id === mergeCandidateId) {
        latest = { ...ar };
      }
    }
    return latest;
  }

  public listApprovalRequestsForTask(taskId: string): ApprovalRequestRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ApprovalRequestRecord[] = [];
    for (const ar of this.approvalRequests.values()) {
      if (ar.project_id === currentProjectId && ar.task_id === taskId) {
        list.push({ ...ar });
      }
    }
    return list;
  }

  public getReviewArtifactById(reviewArtifactId: string): ReviewArtifactRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const ra = this.reviewArtifacts.get(reviewArtifactId);
    if (!ra || ra.project_id !== currentProjectId) {
      return null;
    }
    return { ...ra };
  }

  public listReviewArtifactsForTask(taskId: string): ReviewArtifactRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ReviewArtifactRecord[] = [];
    for (const ra of this.reviewArtifacts.values()) {
      if (ra.project_id === currentProjectId && ra.task_id === taskId) {
        list.push({ ...ra });
      }
    }
    return list;
  }

  public getMergeOperationById(mergeOpId: string): MergeOperationRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const mo = this.mergeOperations.get(mergeOpId);
    if (!mo || mo.project_id !== currentProjectId) {
      return null;
    }
    return { ...mo };
  }

  public listMergeOperationsForTask(taskId: string): MergeOperationRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: MergeOperationRecord[] = [];
    for (const mo of this.mergeOperations.values()) {
      if (mo.project_id === currentProjectId && mo.task_id === taskId) {
        list.push({ ...mo });
      }
    }
    return list;
  }

  public listTaskLeasesForTask(taskId: string): TaskLeaseRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: TaskLeaseRecord[] = [];
    for (const l of this.taskLeases.values()) {
      if (l.project_id === currentProjectId && l.task_id === taskId) {
        list.push({ ...l });
      }
    }
    list.sort((a, b) => a.lease_epoch - b.lease_epoch);
    return list;
  }

  public listProcessedWorkerEventsForTask(taskId: string): ProcessedWorkerEventRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ProcessedWorkerEventRecord[] = [];
    for (const ev of this.processedWorkerEvents.values()) {
      if (ev.project_id === currentProjectId && ev.task_id === taskId) {
        list.push({ ...ev });
      }
    }
    list.sort((a, b) => a.lease_epoch - b.lease_epoch || a.sequence_no - b.sequence_no);
    return list;
  }

  public recordResourceUsageMetric(
    input: RecordResourceUsageMetricInput
  ): ResourceUsageMetricRecord {
    this.assertWritePermissionForProject(input.project_id);
    const task = this.tasks.get(input.task_id);
    if (!task || task.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", `Task ${input.task_id} not found for project ${input.project_id}`);
    }
    if (input.lease_id) {
      const lease = this.taskLeases.get(input.lease_id);
      if (!lease || lease.project_id !== input.project_id) {
        throw new PostgresRlsError("23503", `Lease ${input.lease_id} not found for project ${input.project_id}`);
      }
    }
    const normalized = validateAndNormalizeResourceUsageMetricInput(input, {
      current_attempt_no: task.current_attempt_no,
      rework_count: task.rework_count,
    });
    const record: ResourceUsageMetricRecord = {
      metric_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      lease_id: input.lease_id ?? null,
      lease_epoch: normalized.lease_epoch,
      attempt_no: normalized.attempt_no,
      rework_cycle: normalized.rework_cycle,
      phase: input.phase,
      wall_time_ms: normalized.wall_time_ms,
      cpu_usage_usec: normalized.cpu_usage_usec,
      peak_memory_bytes: normalized.peak_memory_bytes,
      sandbox_backend_mode: normalized.sandbox_backend_mode,
      metrics_source: input.metrics_source,
      recorded_at: this.clockTimestampIso(),
    };
    this.resourceUsageMetrics.set(record.metric_id, record);
    return { ...record };
  }

  public listResourceUsageMetricsForTask(taskId: string): ResourceUsageMetricRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ResourceUsageMetricRecord[] = [];
    for (const m of this.resourceUsageMetrics.values()) {
      if (m.project_id === currentProjectId && m.task_id === taskId) {
        list.push({ ...m });
      }
    }
    return list;
  }

  public getCandidateBoundLineage(
    taskId: string,
    liveMainHeadHash?: string | null
  ): CandidateBoundLineage | null {
    const task = this.getTaskById(taskId);
    if (!task) {
      return null;
    }
    return buildCandidateBoundLineage({
      task,
      mainHeadCommitHash:
        liveMainHeadHash !== undefined
          ? liveMainHeadHash
          : this.getMainRefCommitHash(task.project_id),
      taskLeases: this.listTaskLeasesForTask(taskId),
      processedEvents: this.listProcessedWorkerEventsForTask(taskId),
      resourceUsageMetrics: this.listResourceUsageMetricsForTask(taskId),
      imports: this.getVerifiedImportsForTask(taskId),
      allMergeCandidates: this.listMergeCandidatesForTask(taskId),
      verificationRuns: this.listVerificationRunsForTask(taskId),
      reviewSessions: this.listReviewSessionsForTask(taskId),
      reviewArtifacts: this.listReviewArtifactsForTask(taskId),
      approvalRequests: this.listApprovalRequestsForTask(taskId),
      approvalDecisions: this.listApprovalDecisionsForTask(taskId),
      mergeOperations: this.listMergeOperationsForTask(taskId),
    });
  }

  public listOutboxEventsForProject(): OutboxEventRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: OutboxEventRecord[] = [];
    for (const ev of this.outboxEvents.values()) {
      if (ev.project_id === currentProjectId) {
        list.push({ ...ev });
      }
    }
    return list;
  }

  // ===========================================================================
  // Milestone M6A: Model Cost Guard (AC-12b) & Stages 1–4 Product Pipeline
  // ===========================================================================

  public createCostSession(input: CreateCostSessionInput): CostSessionRecord {
    this.assertWritePermissionForProject(input.project_id);
    if (!this.projects.has(input.project_id)) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} does not exist`);
    }
    if (input.task_id) {
      const task = this.tasks.get(input.task_id);
      if (!task || task.project_id !== input.project_id) {
        throw new PostgresRlsError("23503", `Task ${input.task_id} not found for project ${input.project_id}`);
      }
    }
    validateCreateCostSessionInput(input);
    const costSessionId = input.cost_session_id ?? randomUUID();
    if (this.costSessions.has(costSessionId)) {
      throw new PostgresRlsError("23505", `Cost session ${costSessionId} already exists`);
    }
    const nowIso = this.clockTimestampIso();
    const record: CostSessionRecord = {
      cost_session_id: costSessionId,
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id ?? null,
      task_id: input.task_id ?? null,
      max_tokens_per_request: input.max_tokens_per_request,
      max_cost_micro_usd_per_request: input.max_cost_micro_usd_per_request,
      session_token_budget: input.session_token_budget,
      session_cost_budget_micro_usd: input.session_cost_budget_micro_usd,
      tokens_used_total: 0,
      cost_used_micro_usd: 0,
      status: "ACTIVE",
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.costSessions.set(costSessionId, record);
    return { ...record };
  }

  public getCostSession(costSessionId: string): CostSessionRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const found = this.costSessions.get(costSessionId);
    if (!found || found.project_id !== currentProjectId) {
      return null;
    }
    return { ...found };
  }

  public listModelCallLedgers(filter?: {
    readonly cost_session_id?: string;
    readonly pipeline_session_id?: string;
  }): ModelCallLedgerRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ModelCallLedgerRecord[] = [];
    for (const l of this.modelCallLedgers.values()) {
      if (l.project_id !== currentProjectId) {
        continue;
      }
      if (filter?.cost_session_id && l.cost_session_id !== filter.cost_session_id) {
        continue;
      }
      if (filter?.pipeline_session_id && l.pipeline_session_id !== filter.pipeline_session_id) {
        continue;
      }
      list.push({ ...l });
    }
    return list;
  }

  public async preflightCheckCostSession(
    input: CostPreflightCheckInput
  ): Promise<CostPreflightCheckResult> {
    const run = (): Promise<CostPreflightCheckResult> => {
      this.assertWritePermissionForProject(input.project_id);
      return this.withSerializedLock(`cost-session:${input.cost_session_id}`, () => {
        const session = this.costSessions.get(input.cost_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
          );
        }
        const resolvedPipelineId = input.pipeline_session_id ?? session.pipeline_session_id;
        if (resolvedPipelineId) {
          const ps = this.pipelineSessions.get(resolvedPipelineId);
          if (!ps || ps.project_id !== input.project_id) {
            throw new PostgresRlsError(
              "23503",
              `Pipeline session ${resolvedPipelineId} not found for project ${input.project_id}`
            );
          }
        }
        const resolvedTaskId = input.task_id ?? session.task_id;
        if (resolvedTaskId) {
          const task = this.tasks.get(resolvedTaskId);
          if (!task || task.project_id !== input.project_id) {
            throw new PostgresRlsError(
              "23503",
              `Task ${resolvedTaskId} not found for project ${input.project_id}`
            );
          }
        }

        const violation = evaluatePreflightLimits(session, input);
        if (!violation) {
          return { allowed: true, session: { ...session } };
        }

        const nowIso = this.clockTimestampIso();
        const blockedLedger: ModelCallLedgerRecord = {
          call_id: randomUUID(),
          project_id: input.project_id,
          cost_session_id: input.cost_session_id,
          pipeline_session_id: resolvedPipelineId,
          task_id: resolvedTaskId,
          stage: input.stage,
          provider: input.provider,
          model: input.model,
          prompt_id: input.prompt_id,
          prompt_version: input.prompt_version,
          prompt_sha256: input.prompt_sha256,
          request_sha256: input.request_sha256,
          estimated_input_tokens: input.estimated_input_tokens,
          reserved_output_tokens: input.reserved_output_tokens,
          actual_input_tokens: 0,
          actual_output_tokens: 0,
          actual_total_tokens: 0,
          estimated_cost_micro_usd: input.estimated_cost_micro_usd,
          actual_cost_micro_usd: 0,
          status: "BLOCKED_PREFLIGHT",
          usage_estimated: false,
          block_reason: `${violation.limitScope}: ${violation.reason}`,
          error_message: violation.reason,
          latency_ms: 0,
          created_at: nowIso,
        };
        this.modelCallLedgers.set(blockedLedger.call_id, blockedLedger);
        return {
          allowed: false,
          limitScope: violation.limitScope,
          reason: violation.reason,
          session: { ...session },
          blockedLedger: { ...blockedLedger },
        };
      });
    };

    if (this.asyncLocalStorage.getStore() !== undefined) {
      return run();
    }
    return this.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      run
    );
  }

  public async finalizeModelCallLedger(
    input: FinalizeModelCallInput
  ): Promise<FinalizeModelCallResult> {
    if (
      !Number.isSafeInteger(input.estimated_input_tokens) ||
      input.estimated_input_tokens < 0 ||
      !Number.isSafeInteger(input.reserved_output_tokens) ||
      input.reserved_output_tokens < 0 ||
      !Number.isSafeInteger(input.actual_input_tokens) ||
      input.actual_input_tokens < 0 ||
      !Number.isSafeInteger(input.actual_output_tokens) ||
      input.actual_output_tokens < 0 ||
      !Number.isSafeInteger(input.estimated_cost_micro_usd) ||
      input.estimated_cost_micro_usd < 0 ||
      !Number.isSafeInteger(input.actual_cost_micro_usd) ||
      input.actual_cost_micro_usd < 0
    ) {
      throw new PostgresRlsError("23514", "Model call token and cost quantities must be non-negative safe integers");
    }
    const actualTotalTokens = input.actual_input_tokens + input.actual_output_tokens;
    if (!Number.isSafeInteger(actualTotalTokens)) {
      throw new RangeError("actual_total_tokens exceeds JavaScript safe integer range");
    }

    const run = (): Promise<FinalizeModelCallResult> => {
      this.assertWritePermissionForProject(input.project_id);
      return this.withSerializedLock(`cost-session:${input.cost_session_id}`, () => {
        const session = this.costSessions.get(input.cost_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
          );
        }
        const resolvedPipelineId = input.pipeline_session_id ?? session.pipeline_session_id;
        if (resolvedPipelineId) {
          const ps = this.pipelineSessions.get(resolvedPipelineId);
          if (!ps || ps.project_id !== input.project_id) {
            throw new PostgresRlsError(
              "23503",
              `Pipeline session ${resolvedPipelineId} not found for project ${input.project_id}`
            );
          }
        }
        const resolvedTaskId = input.task_id ?? session.task_id;
        if (resolvedTaskId) {
          const task = this.tasks.get(resolvedTaskId);
          if (!task || task.project_id !== input.project_id) {
            throw new PostgresRlsError(
              "23503",
              `Task ${resolvedTaskId} not found for project ${input.project_id}`
            );
          }
        }

        const nowIso = this.clockTimestampIso();
        const evalRes = evaluatePostcallLimits(
          session,
          actualTotalTokens,
          input.actual_cost_micro_usd
        );

        let updatedSession: CostSessionRecord = session;
        if (session.status === "ACTIVE") {
          updatedSession = {
            ...session,
            tokens_used_total: evalRes.nextTokensUsedTotal,
            cost_used_micro_usd: evalRes.nextCostUsedMicroUsd,
            status: evalRes.nextStatus,
            updated_at: nowIso,
          };
          this.costSessions.set(session.cost_session_id, updatedSession);
        }

        const status: ModelCallStatus = evalRes.exceeded ? "BLOCKED_POSTCALL" : input.outcome;
        const errorMessage = evalRes.exceeded
          ? input.error_message && input.outcome !== "ALLOWED"
            ? `${evalRes.exceeded.reason}; upstream error: ${input.error_message}`
            : evalRes.exceeded.reason
          : input.error_message ?? null;
        const ledger: ModelCallLedgerRecord = {
          call_id: randomUUID(),
          project_id: input.project_id,
          cost_session_id: input.cost_session_id,
          pipeline_session_id: resolvedPipelineId,
          task_id: resolvedTaskId,
          stage: input.stage,
          provider: input.provider,
          model: input.model,
          prompt_id: input.prompt_id,
          prompt_version: input.prompt_version,
          prompt_sha256: input.prompt_sha256,
          request_sha256: input.request_sha256,
          estimated_input_tokens: input.estimated_input_tokens,
          reserved_output_tokens: input.reserved_output_tokens,
          actual_input_tokens: input.actual_input_tokens,
          actual_output_tokens: input.actual_output_tokens,
          actual_total_tokens: actualTotalTokens,
          estimated_cost_micro_usd: input.estimated_cost_micro_usd,
          actual_cost_micro_usd: input.actual_cost_micro_usd,
          status,
          usage_estimated: Boolean(input.usage_estimated),
          block_reason: evalRes.exceeded
            ? `${evalRes.exceeded.limitScope}: ${evalRes.exceeded.reason}`
            : null,
          error_message: errorMessage,
          latency_ms: Math.max(0, Math.trunc(input.latency_ms)),
          created_at: nowIso,
        };
        this.modelCallLedgers.set(ledger.call_id, ledger);

        return {
          allowed: !evalRes.exceeded,
          ...(evalRes.exceeded
            ? { limitScope: evalRes.exceeded.limitScope, reason: evalRes.exceeded.reason }
            : {}),
          session: { ...updatedSession },
          ledger: { ...ledger },
        };
      });
    };

    if (this.asyncLocalStorage.getStore() !== undefined) {
      return run();
    }
    return this.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      run
    );
  }

  public createProductPipelineSession(
    input: CreateProductPipelineSessionInput
  ): ProductPipelineSessionRecord {
    this.assertWritePermissionForProject(input.project_id);
    if (!this.projects.has(input.project_id)) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} does not exist`);
    }
    if (
      !input.title.trim() ||
      !input.raw_idea_text.trim() ||
      !input.created_by_principal_id.trim()
    ) {
      throw new PostgresRlsError(
        "23514",
        "title, raw_idea_text, and created_by_principal_id must be non-empty"
      );
    }
    if (input.cost_session_id) {
      const cs = this.costSessions.get(input.cost_session_id);
      if (!cs || cs.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
        );
      }
    }
    const pipelineSessionId = input.pipeline_session_id ?? randomUUID();
    if (this.pipelineSessions.has(pipelineSessionId)) {
      throw new PostgresRlsError("23505", `Pipeline session ${pipelineSessionId} already exists`);
    }
    const nowIso = this.clockTimestampIso();
    const record: ProductPipelineSessionRecord = {
      pipeline_session_id: pipelineSessionId,
      project_id: input.project_id,
      cost_session_id: input.cost_session_id ?? null,
      title: input.title,
      raw_idea_text: input.raw_idea_text,
      current_stage: "STAGE_1_IDEA_DISCOVERY",
      status: "ACTIVE",
      frozen_baseline_id: null,
      created_by_principal_id: input.created_by_principal_id,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.pipelineSessions.set(pipelineSessionId, record);
    return { ...record };
  }

  public getProductPipelineSession(pipelineSessionId: string): ProductPipelineSessionRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const found = this.pipelineSessions.get(pipelineSessionId);
    if (!found || found.project_id !== currentProjectId) {
      return null;
    }
    return { ...found };
  }

  public listProductPipelineSessions(): ProductPipelineSessionRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: ProductPipelineSessionRecord[] = [];
    for (const ps of this.pipelineSessions.values()) {
      if (ps.project_id === currentProjectId) {
        list.push({ ...ps });
      }
    }
    return list;
  }

  public async updateProductPipelineSessionCostSession(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly cost_session_id: string;
  }): Promise<ProductPipelineSessionRecord> {
    this.assertWritePermissionForProject(input.project_id);
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "ACTIVE") {
        throw new PostgresRlsError(
          "23514",
          `Frozen pipeline session ${input.pipeline_session_id} cannot be mutated`
        );
      }
      const cs = this.costSessions.get(input.cost_session_id);
      if (!cs || cs.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
        );
      }
      const updated: ProductPipelineSessionRecord = {
        ...session,
        cost_session_id: input.cost_session_id,
        updated_at: this.clockTimestampIso(),
      };
      this.pipelineSessions.set(updated.pipeline_session_id, updated);
      return { ...updated };
    });
  }

  public async createStage1DiscoveryItems(
    input: CreateStage1DiscoveryItemsInput
  ): Promise<Stage1DiscoveryItemRecord[]> {
    this.assertWritePermissionForProject(input.project_id);
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "ACTIVE") {
        throw new PostgresRlsError(
          "23514",
          `Session ${input.pipeline_session_id} is ${session.status}; stage1_discovery_items cannot be added or modified after baseline freeze`
        );
      }

      const nowIso = this.clockTimestampIso();
      const created: Stage1DiscoveryItemRecord[] = [];
      const seenIds = new Set<string>();
      for (const rawItem of input.items) {
        const normalized = normalizeCreateStage1DiscoveryItem(rawItem);
        const itemId = rawItem.item_id ?? randomUUID();
        if (this.stage1DiscoveryItems.has(itemId) || seenIds.has(itemId)) {
          throw new PostgresRlsError("23505", `Stage 1 discovery item ${itemId} already exists`);
        }
        seenIds.add(itemId);
        created.push({
          item_id: itemId,
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          kind: rawItem.kind,
          title: normalized.title,
          statement: normalized.statement,
          rationale: rawItem.rationale,
          clarification_question: normalized.clarification_question,
          confirmation_status: normalized.confirmation_status,
          confirmed_by_principal_id: null,
          confirmed_at: null,
          resolution_note: null,
          created_at: nowIso,
          updated_at: nowIso,
        });
      }

      for (const rec of created) {
        this.stage1DiscoveryItems.set(rec.item_id, rec);
      }
      return created.map((r) => ({ ...r }));
    });
  }

  public async resolveStage1DiscoveryItem(
    input: ResolveStage1DiscoveryItemInput
  ): Promise<Stage1DiscoveryItemRecord> {
    this.assertWritePermissionForProject(input.project_id);
    if (!input.actor_principal_id.trim()) {
      throw new PostgresRlsError("23514", "actor_principal_id is required to resolve Stage 1 item");
    }
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "ACTIVE") {
        throw new PostgresRlsError(
          "23514",
          `Session ${input.pipeline_session_id} is ${session.status}; stage1_discovery_items cannot be modified after baseline freeze`
        );
      }
      const existing = this.stage1DiscoveryItems.get(input.item_id);
      if (
        !existing ||
        existing.project_id !== input.project_id ||
        existing.pipeline_session_id !== input.pipeline_session_id
      ) {
        throw new PostgresRlsError(
          "23503",
          `Stage 1 discovery item ${input.item_id} not found in pipeline session ${input.pipeline_session_id}`
        );
      }
      if (existing.confirmation_status !== "UNCONFIRMED") {
        throw new PostgresRlsError(
          "23514",
          `Stage 1 discovery item ${input.item_id} is already ${existing.confirmation_status} and cannot be re-resolved`
        );
      }
      const nowIso = this.clockTimestampIso();
      const updated: Stage1DiscoveryItemRecord = {
        ...existing,
        confirmation_status: input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED",
        confirmed_by_principal_id: input.actor_principal_id,
        confirmed_at: nowIso,
        resolution_note: input.resolution_note ?? existing.resolution_note,
        updated_at: nowIso,
      };
      this.stage1DiscoveryItems.set(updated.item_id, updated);
      return { ...updated };
    });
  }

  public listStage1DiscoveryItems(pipelineSessionId: string): Stage1DiscoveryItemRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: Stage1DiscoveryItemRecord[] = [];
    for (const item of this.stage1DiscoveryItems.values()) {
      if (item.project_id === currentProjectId && item.pipeline_session_id === pipelineSessionId) {
        list.push({ ...item });
      }
    }
    return list;
  }

  public async recordStageArtifact(
    input: RecordStageArtifactInput
  ): Promise<StageArtifactRecord> {
    this.assertWritePermissionForProject(input.project_id);
    if (!input.created_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "created_by_principal_id must be non-empty");
    }
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "ACTIVE") {
        throw new PostgresRlsError(
          "23514",
          `Session ${input.pipeline_session_id} is ${session.status}; new stage artifacts are forbidden after baseline freeze`
        );
      }

      const artifactSha = validateStageArtifactKindAndHash({
        stage: input.stage,
        artifact_kind: input.artifact_kind,
        content_json: input.content_json,
        artifact_sha256: input.artifact_sha256,
      });

      if (input.stage === "STAGE_2_REQUIREMENTS") {
        const sessionItems = this.listStage1DiscoveryItems(input.pipeline_session_id);
        validateStage2Ac10References(input.content_json, sessionItems, input.pipeline_session_id);
      }

      let maxVersion = 0;
      for (const existing of this.stageArtifacts.values()) {
        if (
          existing.pipeline_session_id === input.pipeline_session_id &&
          existing.stage === input.stage &&
          existing.version > maxVersion
        ) {
          maxVersion = existing.version;
        }
      }

      const artifactId = input.artifact_id ?? randomUUID();
      if (this.stageArtifacts.has(artifactId)) {
        throw new PostgresRlsError("23505", `Stage artifact ${artifactId} already exists`);
      }

      const nowIso = this.clockTimestampIso();
      const record: StageArtifactRecord = {
        artifact_id: artifactId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        stage: input.stage,
        artifact_kind: input.artifact_kind,
        version: maxVersion + 1,
        provider: input.provider,
        model: input.model,
        prompt_id: input.prompt_id,
        prompt_version: input.prompt_version,
        prompt_sha256: input.prompt_sha256,
        content_json: structuredClone(input.content_json),
        artifact_sha256: artifactSha,
        created_by_principal_id: input.created_by_principal_id,
        created_at: nowIso,
      };
      this.stageArtifacts.set(artifactId, record);

      if (input.advance_session_stage) {
        this.pipelineSessions.set(session.pipeline_session_id, {
          ...session,
          current_stage: input.advance_session_stage,
          updated_at: nowIso,
        });
      }

      return { ...record, content_json: structuredClone(record.content_json) };
    });
  }

  public listStageArtifacts(pipelineSessionId: string): StageArtifactRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: StageArtifactRecord[] = [];
    for (const art of this.stageArtifacts.values()) {
      if (art.project_id === currentProjectId && art.pipeline_session_id === pipelineSessionId) {
        list.push({ ...art, content_json: structuredClone(art.content_json) });
      }
    }
    return list;
  }

  public getStageArtifactById(artifactId: string): StageArtifactRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const found = this.stageArtifacts.get(artifactId);
    if (!found || found.project_id !== currentProjectId) {
      return null;
    }
    return { ...found, content_json: structuredClone(found.content_json) };
  }

  public async recordStageApprovalGate(
    input: RecordStageApprovalGateInput
  ): Promise<StageApprovalGateRecord> {
    this.assertWritePermissionForProject(input.project_id);
    if (!input.approver_principal_id.trim()) {
      throw new PostgresRlsError("23514", "approver_principal_id must be non-empty");
    }
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "ACTIVE") {
        throw new PostgresRlsError(
          "23514",
          `Session ${input.pipeline_session_id} is ${session.status}; new stage approval gates are forbidden after baseline freeze`
        );
      }
      const artifact = this.stageArtifacts.get(input.target_artifact_id);
      if (
        !artifact ||
        artifact.project_id !== input.project_id ||
        artifact.pipeline_session_id !== input.pipeline_session_id ||
        artifact.artifact_sha256 !== input.target_artifact_sha256
      ) {
        throw new PostgresRlsError(
          "23503",
          `Target artifact ${input.target_artifact_id} or sha256 does not match session ${input.pipeline_session_id}`
        );
      }
      const gateId = input.gate_id ?? randomUUID();
      if (this.stageApprovalGates.has(gateId)) {
        throw new PostgresRlsError("23505", `Stage approval gate ${gateId} already exists`);
      }
      const record: StageApprovalGateRecord = {
        gate_id: gateId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        gate_stage: input.gate_stage,
        target_artifact_id: input.target_artifact_id,
        target_artifact_sha256: input.target_artifact_sha256,
        approver_principal_id: input.approver_principal_id,
        decision: input.decision,
        rationale: input.rationale ?? null,
        decided_at: this.clockTimestampIso(),
      };
      this.stageApprovalGates.set(gateId, record);
      return { ...record };
    });
  }

  public listStageApprovalGates(pipelineSessionId: string): StageApprovalGateRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return [];
    }
    const list: StageApprovalGateRecord[] = [];
    for (const gate of this.stageApprovalGates.values()) {
      if (gate.project_id === currentProjectId && gate.pipeline_session_id === pipelineSessionId) {
        list.push({ ...gate });
      }
    }
    return list;
  }

  public async freezeBaselineSpec(
    input: FreezeBaselineSpecInput
  ): Promise<BaselineSpecFreezeRecord> {
    this.assertWritePermissionForProject(input.project_id);
    if (!input.frozen_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "frozen_by_principal_id must be non-empty");
    }
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const session = this.pipelineSessions.get(input.pipeline_session_id) ?? null;
      const existingFreeze = this.getBaselineSpecFreeze(input.pipeline_session_id);
      let latestStage4Artifact: StageArtifactRecord | null = null;
      for (const art of this.stageArtifacts.values()) {
        if (
          art.project_id === input.project_id &&
          art.pipeline_session_id === input.pipeline_session_id &&
          art.stage === "STAGE_4_SPEC_FREEZE" &&
          (!latestStage4Artifact || art.version > latestStage4Artifact.version)
        ) {
          latestStage4Artifact = art;
        }
      }
      const stage1Items: Stage1DiscoveryItemRecord[] = [];
      for (const item of this.stage1DiscoveryItems.values()) {
        if (
          item.project_id === input.project_id &&
          item.pipeline_session_id === input.pipeline_session_id
        ) {
          stage1Items.push({ ...item });
        }
      }
      validateFreezeBaselineSpecInvariants({
        request: input,
        session,
        stage1Artifact: this.stageArtifacts.get(input.stage1_artifact_id) ?? null,
        stage2Artifact: this.stageArtifacts.get(input.stage2_artifact_id) ?? null,
        stage3Artifact: this.stageArtifacts.get(input.stage3_artifact_id) ?? null,
        validationReportArtifact:
          this.stageArtifacts.get(input.validation_report_artifact_id) ?? null,
        latestStage4Artifact,
        stage1Items,
        approvalGate: this.stageApprovalGates.get(input.approval_gate_id) ?? null,
        existingFreeze,
      });

      const baselineId = input.baseline_id ?? randomUUID();
      if (this.baselineSpecFreezes.has(baselineId)) {
        throw new PostgresRlsError("23505", `Baseline freeze ${baselineId} already exists`);
      }

      const nowIso = this.clockTimestampIso();
      const freezeBundleSha = computeBaselineFreezeBundleSha256(input);
      const record: BaselineSpecFreezeRecord = {
        baseline_id: baselineId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        stage1_artifact_id: input.stage1_artifact_id,
        stage1_artifact_sha256: input.stage1_artifact_sha256,
        stage2_artifact_id: input.stage2_artifact_id,
        stage2_artifact_sha256: input.stage2_artifact_sha256,
        stage3_artifact_id: input.stage3_artifact_id,
        stage3_artifact_sha256: input.stage3_artifact_sha256,
        validation_report_artifact_id: input.validation_report_artifact_id,
        validation_report_sha256: input.validation_report_sha256,
        approval_gate_id: input.approval_gate_id,
        frozen_by_principal_id: input.frozen_by_principal_id,
        freeze_bundle_sha256: freezeBundleSha,
        status: "FROZEN",
        frozen_at: nowIso,
      };
      this.baselineSpecFreezes.set(baselineId, record);

      this.pipelineSessions.set(session!.pipeline_session_id, {
        ...session!,
        status: "FROZEN",
        frozen_baseline_id: baselineId,
        current_stage: "STAGE_4_SPEC_FREEZE",
        updated_at: nowIso,
      });

      this.insertOutboxEventInternal(
        input.project_id,
        "product_pipeline",
        input.pipeline_session_id,
        "pipeline.baseline_frozen",
        {
          pipeline_session_id: input.pipeline_session_id,
          baseline_id: baselineId,
          freeze_bundle_sha256: freezeBundleSha,
          frozen_by_principal_id: input.frozen_by_principal_id,
        }
      );

      return { ...record };
    });
  }

  public getBaselineSpecFreeze(pipelineSessionId: string): BaselineSpecFreezeRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    for (const freeze of this.baselineSpecFreezes.values()) {
      if (
        freeze.project_id === currentProjectId &&
        freeze.pipeline_session_id === pipelineSessionId
      ) {
        return { ...freeze };
      }
    }
    return null;
  }

  public getProductPipelineBundle(pipelineSessionId: string): ProductPipelineBundle | null {
    const session = this.getProductPipelineSession(pipelineSessionId);
    if (!session) {
      return null;
    }
    const costSession = session.cost_session_id
      ? this.getCostSession(session.cost_session_id)
      : null;
    return buildProductPipelineBundle({
      session,
      costSession,
      modelCallLedgers: this.listModelCallLedgers({ pipeline_session_id: pipelineSessionId }),
      discoveryItems: this.listStage1DiscoveryItems(pipelineSessionId),
      artifacts: this.listStageArtifacts(pipelineSessionId),
      approvalGates: this.listStageApprovalGates(pipelineSessionId),
      baselineFreeze: this.getBaselineSpecFreeze(pipelineSessionId),
    });
  }

  // ===========================================================================
  // Milestone M6B: Stages 5-9 Lifecycle, Multi-Target Profiles, CR & Release
  // ===========================================================================

  public updateProjectMainRefCommitHash(input: {
    readonly project_id: string;
    readonly main_ref_commit_hash: string;
  }): ProjectRecord {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    if (!/^[0-9a-f]{40}$/i.test(input.main_ref_commit_hash.trim())) {
      throw new PostgresRlsError(
        "23514",
        `main_ref_commit_hash '${input.main_ref_commit_hash}' must be a 40-hex commit hash`
      );
    }
    const normalizedHash = input.main_ref_commit_hash.trim().toLowerCase();
    const project = this.projects.get(input.project_id);
    if (!project) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
    }
    const updated: ProjectRecord = {
      ...project,
      main_ref_commit_hash: normalizedHash,
      updated_at: this.clockTimestampIso(),
    };
    this.projects.set(input.project_id, updated);
    let refs = this.gitRefsByProject.get(input.project_id);
    if (!refs) {
      refs = new Map();
      this.gitRefsByProject.set(input.project_id, refs);
    }
    refs.set("refs/heads/main", normalizedHash);
    let commits = this.gitCommitsByProject.get(input.project_id);
    if (!commits) {
      commits = new Map();
      this.gitCommitsByProject.set(input.project_id, commits);
    }
    if (!commits.has(normalizedHash)) {
      commits.set(normalizedHash, {
        commitHash: normalizedHash,
        treeHash: normalizedHash,
        parents: [],
      });
    }
    return { ...updated };
  }

  public async createProjectBootstrap(
    input: CreateProjectBootstrapInput
  ): Promise<ProjectBootstrapRecord> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const freeze = this.baselineSpecFreezes.get(input.baseline_id);
      if (
        !freeze ||
        freeze.project_id !== input.project_id ||
        freeze.pipeline_session_id !== input.pipeline_session_id
      ) {
        throw new PostgresRlsError(
          "23503",
          `Baseline ${input.baseline_id} not found for project ${input.project_id} and session ${input.pipeline_session_id}`
        );
      }
      if (freeze.status !== "FROZEN") {
        throw new PostgresRlsError("23514", `Baseline ${input.baseline_id} must be FROZEN`);
      }
      for (const existing of this.projectBootstraps.values()) {
        if (existing.project_id === input.project_id && existing.baseline_id === input.baseline_id) {
          throw new PostgresRlsError(
            "23505",
            `Project bootstrap already exists for project ${input.project_id} and baseline ${input.baseline_id}`
          );
        }
      }
      if (
        !/^[0-9a-f]{40}$/i.test(input.base_main_commit_hash) ||
        !/^[0-9a-f]{64}$/i.test(input.trusted_policy_sha256) ||
        input.acceptance_tests.length === 0
      ) {
        throw new PostgresRlsError(
          "23514",
          "Invalid project bootstrap hashes or empty acceptance_tests"
        );
      }
      const bootstrapId = input.bootstrap_id ?? randomUUID();
      if (this.projectBootstraps.has(bootstrapId)) {
        throw new PostgresRlsError("23505", `Bootstrap ${bootstrapId} already exists`);
      }
      const normalizedSpecs = serializeTrustedAcceptanceTestSpecs(input.acceptance_tests);
      const normalizedHash = input.base_main_commit_hash.toLowerCase();
      const normalizedPolicySha = input.trusted_policy_sha256.toLowerCase();
      const bootstrapSha = computeProjectBootstrapSha256({
        ...input,
        base_main_commit_hash: normalizedHash,
        trusted_policy_sha256: normalizedPolicySha,
        acceptance_tests: normalizedSpecs,
      });
      const record: ProjectBootstrapRecord = {
        bootstrap_id: bootstrapId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: input.baseline_id,
        repo_path: input.repo_path,
        trusted_acceptance_dir: input.trusted_acceptance_dir,
        base_main_commit_hash: normalizedHash,
        protected_paths: [...input.protected_paths],
        trusted_policy_sha256: normalizedPolicySha,
        generated_files: [...input.generated_files],
        acceptance_tests: normalizedSpecs,
        bootstrap_sha256: bootstrapSha,
        created_by_principal_id: input.created_by_principal_id,
        created_at: this.clockTimestampIso(),
      };
      this.projectBootstraps.set(record.bootstrap_id, record);
      this.insertOutboxEventInternal(
        input.project_id,
        "project_bootstrap",
        record.bootstrap_id,
        "pipeline.project_bootstrapped",
        {
          pipeline_session_id: input.pipeline_session_id,
          baseline_id: input.baseline_id,
          bootstrap_id: record.bootstrap_id,
          base_main_commit_hash: normalizedHash,
          trusted_policy_sha256: normalizedPolicySha,
        }
      );
      return structuredClone(record);
    });
  }

  public getProjectBootstrapBySession(pipelineSessionId: string): ProjectBootstrapRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    for (const rec of this.projectBootstraps.values()) {
      if (rec.project_id === currentProjectId && rec.pipeline_session_id === pipelineSessionId) {
        return structuredClone(rec);
      }
    }
    return null;
  }

  public getProjectBootstrapById(bootstrapId: string): ProjectBootstrapRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const rec = this.projectBootstraps.get(bootstrapId);
    if (!rec || rec.project_id !== currentProjectId) {
      return null;
    }
    return structuredClone(rec);
  }

  public async upsertAgentOrganizationProfile(
    input: UpsertAgentOrganizationProfileInput
  ): Promise<AgentOrganizationProfileRecord> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    validateAgentOrganizationProfileInput(input);
    return this.withSerializedLock(`agent-profile:${input.project_id}:${input.profile_key}`, () => {
      if (!this.projects.has(input.project_id)) {
        throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
      }
      const keyTrimmed = input.profile_key.trim();
      let existing: AgentOrganizationProfileRecord | undefined;
      for (const p of this.agentOrganizationProfiles.values()) {
        if (p.project_id === input.project_id && p.profile_key === keyTrimmed) {
          existing = p;
          break;
        }
      }
      const nowIso = this.clockTimestampIso();
      if (existing) {
        const updated: AgentOrganizationProfileRecord = {
          ...existing,
          role: input.role,
          principal_id: input.principal_id.trim(),
          provider: input.provider.trim(),
          model: input.model.trim(),
          execution_target_type: input.execution_target_type,
          trust_tier: input.trust_tier,
          target_locator: input.target_locator ?? null,
          capabilities_json: structuredClone(input.capabilities_json ?? {}),
          is_active: input.is_active ?? true,
          updated_at: nowIso,
        };
        this.agentOrganizationProfiles.set(updated.profile_id, updated);
        return structuredClone(updated);
      }

      const profileId = input.profile_id ?? randomUUID();
      if (this.agentOrganizationProfiles.has(profileId)) {
        throw new PostgresRlsError("23505", `Agent profile ${profileId} already exists`);
      }
      const record: AgentOrganizationProfileRecord = {
        profile_id: profileId,
        project_id: input.project_id,
        profile_key: keyTrimmed,
        role: input.role,
        principal_id: input.principal_id.trim(),
        provider: input.provider.trim(),
        model: input.model.trim(),
        execution_target_type: input.execution_target_type,
        trust_tier: input.trust_tier,
        target_locator: input.target_locator ?? null,
        capabilities_json: structuredClone(input.capabilities_json ?? {}),
        is_active: input.is_active ?? true,
        created_by_principal_id: input.created_by_principal_id.trim(),
        created_at: nowIso,
        updated_at: nowIso,
      };
      this.agentOrganizationProfiles.set(record.profile_id, record);
      return structuredClone(record);
    });
  }

  public listAgentOrganizationProfiles(
    projectId: string,
    filter?: { readonly role?: AgentOrgRole; readonly active_only?: boolean }
  ): AgentOrganizationProfileRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId || currentProjectId !== projectId) {
      return [];
    }
    const out: AgentOrganizationProfileRecord[] = [];
    for (const p of this.agentOrganizationProfiles.values()) {
      if (p.project_id !== currentProjectId) continue;
      if (filter?.role && p.role !== filter.role) continue;
      if (filter?.active_only && !p.is_active) continue;
      out.push(structuredClone(p));
    }
    out.sort((a, b) => a.profile_key.localeCompare(b.profile_key));
    return out;
  }

  public getAgentOrganizationProfileById(profileId: string): AgentOrganizationProfileRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    const rec = this.agentOrganizationProfiles.get(profileId);
    if (!rec || rec.project_id !== currentProjectId) {
      return null;
    }
    return structuredClone(rec);
  }

  public async createStage7DevelopmentPlan(
    input: CreateStage7DevelopmentPlanInput
  ): Promise<Stage7DevelopmentPlanBundle> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const freeze = this.baselineSpecFreezes.get(input.baseline_id);
      if (
        !freeze ||
        freeze.project_id !== input.project_id ||
        freeze.pipeline_session_id !== input.pipeline_session_id
      ) {
        throw new PostgresRlsError(
          "23503",
          `Baseline ${input.baseline_id} not found for session ${input.pipeline_session_id}`
        );
      }
      if (freeze.status !== "FROZEN") {
        throw new PostgresRlsError("23514", "Stage 7 requires a FROZEN baseline");
      }
      const bootstrap = this.projectBootstraps.get(input.bootstrap_id);
      if (
        !bootstrap ||
        bootstrap.project_id !== input.project_id ||
        bootstrap.baseline_id !== input.baseline_id
      ) {
        throw new PostgresRlsError(
          "23514",
          `Bootstrap ${input.bootstrap_id} does not match baseline ${input.baseline_id}`
        );
      }
      for (const m of this.devMilestones.values()) {
        if (m.project_id === input.project_id && m.baseline_id === input.baseline_id) {
          throw new PostgresRlsError(
            "23514",
            `Stage 7 development plan already exists for frozen baseline ${input.baseline_id}; submit a Stage 9 Change Request to add or modify tasks`
          );
        }
      }

      const nowIso = this.clockTimestampIso();
      const milestones: DevMilestoneRecord[] = [];
      const milestoneIdByKey = new Map<string, string>();
      for (const m of input.milestones) {
        const milestoneId = m.milestone_id ?? randomUUID();
        const rec: DevMilestoneRecord = {
          milestone_id: milestoneId,
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          baseline_id: input.baseline_id,
          milestone_key: m.milestone_key,
          title: m.title,
          description: m.description,
          sequence_order: m.sequence_order,
          created_at: nowIso,
        };
        this.devMilestones.set(milestoneId, rec);
        milestoneIdByKey.set(m.milestone_key, milestoneId);
        milestones.push({ ...rec });
      }

      const epics: DevEpicRecord[] = [];
      const epicIdByKey = new Map<string, string>();
      for (const e of input.epics) {
        const milestoneId = milestoneIdByKey.get(e.milestone_key);
        if (!milestoneId) {
          throw new PostgresRlsError("23503", `Milestone key '${e.milestone_key}' not found`);
        }
        const epicId = e.epic_id ?? randomUUID();
        const rec: DevEpicRecord = {
          epic_id: epicId,
          project_id: input.project_id,
          milestone_id: milestoneId,
          epic_key: e.epic_key,
          title: e.title,
          description: e.description,
          sequence_order: e.sequence_order,
          created_at: nowIso,
        };
        this.devEpics.set(epicId, rec);
        epicIdByKey.set(e.epic_key, epicId);
        epics.push({ ...rec });
      }

      const stories: DevUserStoryRecord[] = [];
      const storyIdByKey = new Map<string, string>();
      for (const s of input.stories) {
        const epicId = epicIdByKey.get(s.epic_key);
        if (!epicId) {
          throw new PostgresRlsError("23503", `Epic key '${s.epic_key}' not found`);
        }
        const storyId = s.story_id ?? randomUUID();
        const rec: DevUserStoryRecord = {
          story_id: storyId,
          project_id: input.project_id,
          epic_id: epicId,
          story_key: s.story_key,
          title: s.title,
          description: s.description,
          requirement_ids: [...s.requirement_ids],
          ac_ids: [...s.ac_ids],
          sequence_order: s.sequence_order,
          created_at: nowIso,
        };
        this.devUserStories.set(storyId, rec);
        storyIdByKey.set(s.story_key, storyId);
        stories.push({ ...rec });
      }

      const createdTasks: TaskRecord[] = [];
      const taskLinks: TaskPlanLinkRecord[] = [];
      for (const t of input.tasks) {
        const storyId = storyIdByKey.get(t.story_key);
        if (!storyId) {
          throw new PostgresRlsError("23503", `Story key '${t.story_key}' not found`);
        }
        const taskRec = this.createTask({
          task_id: t.task_id,
          project_id: input.project_id,
          title: t.title,
          task_contract: t.task_contract,
          base_main_commit_hash: input.base_main_commit_hash,
          max_rework_cycles: t.max_rework_cycles,
        });
        createdTasks.push(taskRec);
        const link: TaskPlanLinkRecord = {
          link_id: randomUUID(),
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          baseline_id: input.baseline_id,
          bootstrap_id: input.bootstrap_id,
          story_id: storyId,
          task_id: taskRec.task_id,
          cr_id: null,
          requirement_ids: [...t.requirement_ids],
          ac_ids: [...t.ac_ids],
          assigned_profile_id: t.assigned_profile_id ?? null,
          created_at: nowIso,
        };
        this.taskPlanLinks.set(link.link_id, link);
        taskLinks.push({ ...link });
      }

      this.insertOutboxEventInternal(
        input.project_id,
        "product_pipeline",
        input.pipeline_session_id,
        "pipeline.stage7_plan_materialized",
        {
          pipeline_session_id: input.pipeline_session_id,
          baseline_id: input.baseline_id,
          task_ids: createdTasks.map((t) => t.task_id),
        }
      );

      return {
        milestones,
        epics,
        stories,
        taskLinks,
        tasks: createdTasks,
      };
    });
  }

  public listDevMilestones(pipelineSessionId: string): DevMilestoneRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const out: DevMilestoneRecord[] = [];
    for (const m of this.devMilestones.values()) {
      if (m.project_id === currentProjectId && m.pipeline_session_id === pipelineSessionId) {
        out.push({ ...m });
      }
    }
    out.sort((a, b) => a.sequence_order - b.sequence_order || a.created_at.localeCompare(b.created_at));
    return out;
  }

  public listDevEpics(pipelineSessionId: string): DevEpicRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const milestoneIds = new Set(this.listDevMilestones(pipelineSessionId).map((m) => m.milestone_id));
    const out: DevEpicRecord[] = [];
    for (const e of this.devEpics.values()) {
      if (e.project_id === currentProjectId && milestoneIds.has(e.milestone_id)) {
        out.push({ ...e });
      }
    }
    out.sort((a, b) => a.sequence_order - b.sequence_order || a.created_at.localeCompare(b.created_at));
    return out;
  }

  public listDevUserStories(pipelineSessionId: string): DevUserStoryRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const epicIds = new Set(this.listDevEpics(pipelineSessionId).map((e) => e.epic_id));
    const out: DevUserStoryRecord[] = [];
    for (const s of this.devUserStories.values()) {
      if (s.project_id === currentProjectId && epicIds.has(s.epic_id)) {
        out.push({ ...s, requirement_ids: [...s.requirement_ids], ac_ids: [...s.ac_ids] });
      }
    }
    out.sort((a, b) => a.sequence_order - b.sequence_order || a.created_at.localeCompare(b.created_at));
    return out;
  }

  public listTaskPlanLinks(pipelineSessionId: string): TaskPlanLinkRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const out: TaskPlanLinkRecord[] = [];
    for (const l of this.taskPlanLinks.values()) {
      if (l.project_id === currentProjectId && l.pipeline_session_id === pipelineSessionId) {
        out.push({ ...l, requirement_ids: [...l.requirement_ids], ac_ids: [...l.ac_ids] });
      }
    }
    out.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }

  public async createChangeRequest(
    input: CreateChangeRequestStoreInput
  ): Promise<ChangeRequestRecord> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const freeze = this.baselineSpecFreezes.get(input.baseline_id);
      if (
        !freeze ||
        freeze.project_id !== input.project_id ||
        freeze.pipeline_session_id !== input.pipeline_session_id
      ) {
        throw new PostgresRlsError(
          "23503",
          `Baseline ${input.baseline_id} not found for session ${input.pipeline_session_id}`
        );
      }
      if (freeze.status !== "FROZEN") {
        throw new PostgresRlsError("23514", "Change Requests require a FROZEN baseline");
      }
      for (const existing of this.changeRequests.values()) {
        if (
          existing.project_id === input.project_id &&
          existing.baseline_id === input.baseline_id &&
          existing.cr_key === input.cr_key.trim()
        ) {
          throw new PostgresRlsError(
            "23505",
            `Change Request cr_key '${input.cr_key}' already exists on baseline ${input.baseline_id}`
          );
        }
      }
      const crId = input.cr_id ?? randomUUID();
      if (this.changeRequests.has(crId)) {
        throw new PostgresRlsError("23505", `Change Request ${crId} already exists`);
      }
      const nowIso = this.clockTimestampIso();
      const crSha = computeChangeRequestSha256(input);
      const record: ChangeRequestRecord = {
        cr_id: crId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: input.baseline_id,
        cr_key: input.cr_key.trim(),
        title: input.title.trim(),
        rationale: input.rationale.trim(),
        impacted_requirement_ids: [...input.impacted_requirement_ids],
        impacted_component_ids: [...(input.impacted_component_ids ?? [])],
        proposed_tasks: structuredClone([...input.proposed_tasks]),
        status: "PENDING_APPROVAL",
        requested_by_principal_id: input.requested_by_principal_id,
        decided_by_principal_id: null,
        decision_rationale: null,
        decided_at: null,
        applied_by_principal_id: null,
        applied_at: null,
        cr_sha256: crSha,
        created_at: nowIso,
        updated_at: nowIso,
      };
      this.changeRequests.set(record.cr_id, record);
      this.insertOutboxEventInternal(
        input.project_id,
        "change_request",
        record.cr_id,
        "change_request.submitted",
        {
          cr_id: record.cr_id,
          cr_key: record.cr_key,
          pipeline_session_id: record.pipeline_session_id,
          baseline_id: record.baseline_id,
          cr_sha256: record.cr_sha256,
        }
      );
      return structuredClone(record);
    });
  }

  public getChangeRequestById(crId: string): ChangeRequestRecord | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return null;
    const rec = this.changeRequests.get(crId);
    if (!rec || rec.project_id !== currentProjectId) return null;
    return structuredClone(rec);
  }

  public listChangeRequests(pipelineSessionId: string): ChangeRequestRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const out: ChangeRequestRecord[] = [];
    for (const cr of this.changeRequests.values()) {
      if (cr.project_id === currentProjectId && cr.pipeline_session_id === pipelineSessionId) {
        out.push(structuredClone(cr));
      }
    }
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out;
  }

  public async decideChangeRequest(
    input: DecideChangeRequestStoreInput
  ): Promise<ChangeRequestRecord> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    if (!input.decided_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "decided_by_principal_id is required");
    }
    return this.withSerializedLock(`change-request:${input.cr_id}`, () => {
      const existing = this.changeRequests.get(input.cr_id);
      if (!existing || existing.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Change Request ${input.cr_id} not found for project ${input.project_id}`
        );
      }
      if (existing.status !== "PENDING_APPROVAL") {
        throw new PostgresRlsError(
          "23514",
          `Change Request ${input.cr_id} is in status ${existing.status}; only PENDING_APPROVAL can be decided`
        );
      }
      const nowIso = this.clockTimestampIso();
      const updated: ChangeRequestRecord = {
        ...existing,
        status: input.decision,
        decided_by_principal_id: input.decided_by_principal_id.trim(),
        decision_rationale: input.decision_rationale ?? null,
        decided_at: nowIso,
        updated_at: nowIso,
      };
      this.changeRequests.set(updated.cr_id, updated);
      this.insertOutboxEventInternal(
        input.project_id,
        "change_request",
        updated.cr_id,
        `change_request.${input.decision.toLowerCase()}`,
        {
          cr_id: updated.cr_id,
          cr_key: updated.cr_key,
          decision: input.decision,
          decided_by_principal_id: updated.decided_by_principal_id,
        }
      );
      return structuredClone(updated);
    });
  }

  public async applyChangeRequestAndMaterializeTasks(
    input: ApplyChangeRequestStoreInput
  ): Promise<{
    readonly changeRequest: ChangeRequestRecord;
    readonly tasks: readonly TaskRecord[];
    readonly taskLinks: readonly TaskPlanLinkRecord[];
  }> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    if (!input.applied_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "applied_by_principal_id is required");
    }
    return this.withSerializedLock(`change-request:${input.cr_id}`, () => {
      const existing = this.changeRequests.get(input.cr_id);
      if (!existing || existing.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Change Request ${input.cr_id} not found for project ${input.project_id}`
        );
      }
      if (existing.status !== "APPROVED") {
        throw new PostgresRlsError(
          "23514",
          `Change Request ${input.cr_id} has status ${existing.status}; only APPROVED Change Requests can be applied`
        );
      }

      const nowIso = this.clockTimestampIso();
      const tasks: TaskRecord[] = [];
      const taskLinks: TaskPlanLinkRecord[] = [];
      for (const pt of existing.proposed_tasks) {
        const contract: TaskContractSpec = {
          allowed_files: [...pt.allowed_files],
          protected_paths: [...input.protected_paths],
          trusted_policy_sha256: input.trusted_policy_sha256,
        };
        const taskRec = this.createTask({
          project_id: input.project_id,
          title: pt.title,
          task_contract: contract,
          base_main_commit_hash: input.base_main_commit_hash,
        });
        tasks.push(taskRec);
        const link: TaskPlanLinkRecord = {
          link_id: randomUUID(),
          project_id: input.project_id,
          pipeline_session_id: existing.pipeline_session_id,
          baseline_id: existing.baseline_id,
          bootstrap_id: input.bootstrap_id ?? null,
          story_id: pt.story_id ?? null,
          task_id: taskRec.task_id,
          cr_id: existing.cr_id,
          requirement_ids: [...pt.requirement_ids],
          ac_ids: [...pt.ac_ids],
          assigned_profile_id: pt.developer_profile_id ?? null,
          created_at: nowIso,
        };
        this.taskPlanLinks.set(link.link_id, link);
        taskLinks.push({ ...link });
      }

      const updated: ChangeRequestRecord = {
        ...existing,
        status: "APPLIED",
        applied_by_principal_id: input.applied_by_principal_id.trim(),
        applied_at: nowIso,
        updated_at: nowIso,
      };
      this.changeRequests.set(updated.cr_id, updated);
      this.insertOutboxEventInternal(
        input.project_id,
        "change_request",
        updated.cr_id,
        "change_request.applied",
        {
          cr_id: updated.cr_id,
          cr_key: updated.cr_key,
          materialized_task_ids: tasks.map((t) => t.task_id),
        }
      );

      return {
        changeRequest: structuredClone(updated),
        tasks,
        taskLinks,
      };
    });
  }

  public async recordReleaseAcceptancePackage(
    input: RecordReleaseAcceptancePackageInput
  ): Promise<ReleaseAcceptancePackageRecord> {
    this.assertCoreApiWritePermissionForProject(input.project_id);
    if (!input.complete || input.coverage_percent !== 100) {
      throw new PostgresRlsError(
        "23514",
        `Release acceptance requires 100% bidirectional traceability (got complete=${String(
          input.complete
        )}, coverage_percent=${input.coverage_percent})`
      );
    }
    if (
      !/^[0-9a-f]{40}$/i.test(input.main_head_commit_hash) ||
      !/^[0-9a-f]{64}$/i.test(input.traceability_sha256) ||
      input.merged_task_ids.length === 0
    ) {
      throw new PostgresRlsError(
        "23514",
        "Release acceptance package requires valid main_head_commit_hash, traceability_sha256, and >= 1 merged task"
      );
    }
    return this.withSerializedLock(`pipeline-session:${input.pipeline_session_id}`, () => {
      const freeze = this.baselineSpecFreezes.get(input.baseline_id);
      if (
        !freeze ||
        freeze.project_id !== input.project_id ||
        freeze.pipeline_session_id !== input.pipeline_session_id ||
        freeze.status !== "FROZEN"
      ) {
        throw new PostgresRlsError(
          "23514",
          `Release acceptance requires FROZEN baseline ${input.baseline_id}`
        );
      }
      const releaseId = input.release_id ?? randomUUID();
      if (this.releaseAcceptancePackages.has(releaseId)) {
        throw new PostgresRlsError("23505", `Release package ${releaseId} already exists`);
      }
      const packageSha = computeReleasePackageSha256(input);
      const record: ReleaseAcceptancePackageRecord = {
        release_id: releaseId,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: input.baseline_id,
        traceability_sha256: input.traceability_sha256.toLowerCase(),
        coverage_percent: input.coverage_percent,
        complete: true,
        total_requirements: input.total_requirements,
        merged_task_ids: [...input.merged_task_ids],
        applied_cr_ids: [...input.applied_cr_ids],
        main_head_commit_hash: input.main_head_commit_hash.toLowerCase(),
        summary_markdown: input.summary_markdown,
        package_json: structuredClone(input.package_json),
        package_sha256: packageSha,
        accepted_by_principal_id: input.accepted_by_principal_id,
        accepted_at: this.clockTimestampIso(),
      };
      this.releaseAcceptancePackages.set(record.release_id, record);
      this.insertOutboxEventInternal(
        input.project_id,
        "release_acceptance",
        record.release_id,
        "pipeline.release_accepted",
        {
          release_id: record.release_id,
          pipeline_session_id: record.pipeline_session_id,
          baseline_id: record.baseline_id,
          package_sha256: record.package_sha256,
        }
      );
      return structuredClone(record);
    });
  }

  public listReleaseAcceptancePackages(
    pipelineSessionId: string
  ): ReleaseAcceptancePackageRecord[] {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) return [];
    const out: ReleaseAcceptancePackageRecord[] = [];
    for (const pkg of this.releaseAcceptancePackages.values()) {
      if (pkg.project_id === currentProjectId && pkg.pipeline_session_id === pipelineSessionId) {
        out.push(structuredClone(pkg));
      }
    }
    out.sort((a, b) => b.accepted_at.localeCompare(a.accepted_at));
    return out;
  }

  private insertOutboxEventInternal(
    projectId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    const outboxId = randomUUID();
    this.outboxEvents.set(outboxId, {
      outbox_id: outboxId,
      project_id: projectId,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload_json: structuredClone(payload),
      published_at: null,
      created_at: this.clockTimestampIso(),
    });
  }
}

export interface ControlPlaneStoreFromEnvOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly poolConfig?: PostgresPoolConfig;
  readonly requirePostgres?: boolean;
  readonly clockFn?: () => Date;
}

export interface ControlPlaneStoreHandle {
  readonly mode: "postgres" | "memory";
  readonly pool: PostgresRuntimePool | null;
  readonly store: ControlPlaneStore;
  close(): Promise<void>;
}

/**
 * Selects PostgreSQL runtime (`PostgresRuntimePool` + `PostgresControlPlaneRepository`) whenever
 * `DATABASE_URL` or `PGHOST` (or explicit `poolConfig`) is configured, or falls back to
 * `SoftwareFactoryControlPlaneStore` when `requirePostgres` is false (`M5-FIX-11`).
 */
export function createControlPlaneStoreFromEnv(
  options?: ControlPlaneStoreFromEnvOptions
): ControlPlaneStoreHandle {
  const env = options?.env ?? process.env;
  const pgConfig = options?.poolConfig ?? buildPostgresPoolConfigFromEnv(env);
  if (!pgConfig) {
    if (options?.requirePostgres) {
      throw new Error(
        "PostgreSQL runtime is required (set DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD)"
      );
    }
    const store = new SoftwareFactoryControlPlaneStore(options?.clockFn);
    return {
      mode: "memory",
      pool: null,
      store,
      close: async () => {},
    };
  }
  const pool = new PostgresRuntimePool(pgConfig);
  const store = new PostgresControlPlaneRepository(pool);
  return {
    mode: "postgres",
    pool,
    store,
    close: async () => {
      await pool.close();
    },
  };
}
