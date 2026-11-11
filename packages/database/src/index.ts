import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type LeaseSyncStatusResponse,
  type MergeCandidateRecord,
  type MergeOperationRecord,
  type OutboxEventRecord,
  type ProcessedWorkerEventRecord,
  type ReviewArtifactRecord,
  type ReviewArtifactStatus,
  type ReviewSessionRecord,
  type ReviewSessionStatus,
  type ServerEventAckContract,
  type SnapshotRetentionClass,
  type TaskLeaseRecord,
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
} from "@software-factory/shared-types";
import {
  type GitTreeChangeEntry,
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  validateGitTreeImport,
} from "@software-factory/task-contract";

export type AppSessionRole =
  | "anonymous"
  | "core_api_service"
  | "gateway_service"
  | "outbox_relay_service"
  | "system_admin_role";

export interface RlsSessionContext {
  currentProjectId: string | null;
  currentPrincipalId: string | null;
  currentRole: AppSessionRole;
}

export type ProjectMemberRole =
  | "ORG_ADMIN"
  | "PROJECT_APPROVER"
  | "DEVELOPER"
  | "AUDITOR";

export interface ProjectMembershipRecord {
  membership_id: string;
  project_id: string;
  principal_id: string;
  member_role: ProjectMemberRole;
  created_at: string;
}

export class PostgresRlsError extends Error {
  public readonly sqlState: string;
  constructor(sqlState: "42501" | "23503" | "23505" | "23514", message: string) {
    super(message);
    this.name = "PostgresRlsError";
    this.sqlState = sqlState;
  }
}

export class ApprovalExpiredOrStaleError extends Error {
  public readonly code = "ERR_APPROVAL_EXPIRED_OR_STALE" as const;
  public readonly httpStatus = 409 as const;
  public readonly sqlState = "23514" as const;
  public readonly approvalRequestStatus?: string;

  constructor(message: string, approvalRequestStatus?: string) {
    super(message);
    this.name = "ApprovalExpiredOrStaleError";
    this.approvalRequestStatus = approvalRequestStatus;
  }
}

export class SimulatedPostMergeCrashError extends Error {
  public readonly code = "ERR_SIMULATED_POST_MERGE_CRASH" as const;
  public readonly mergeOpId?: string;

  constructor(message: string, mergeOpId?: string) {
    super(message);
    this.name = "SimulatedPostMergeCrashError";
    this.mergeOpId = mergeOpId;
  }
}

export interface ProjectRecord {
  project_id: string;
  slug: string;
  name: string;
  repo_bare_path: string;
  default_branch: string;
  approval_ttl_seconds: number;
  main_ref_commit_hash: string;
  created_at: string;
  updated_at: string;
}

export interface CasMergeResult {
  readonly status:
    | "MERGED_BY_CAS"
    | "RECONCILED_ALREADY_MERGED"
    | "CAS_CONFLICT_NEEDS_REBASE"
    | "APPROVAL_EXPIRED";
  readonly task_status: TaskStatus;
  readonly merged_commit_hash: string | null;
  readonly main_ref_commit_hash: string;
  readonly invalidated_approval_id?: string;
  readonly merge_op_id?: string;
  readonly reconciled_after_lost_response?: boolean;
}

/**
 * SoftwareFactoryControlPlaneStore implements the PostgreSQL 4-Tier RLS Engine,
 * Canonical Lock Ordering (`task_leases` -> `tasks`), `clock_timestamp()` evaluation,
 * Lease/Event Coordinator, 3D Independent Reviewer Guard, 8-Field Approval Binding & TTL,
 * and Idempotent Atomic CAS Merge + Post-Merge Reconciler (MVP-SPEC-02, MVP-SPEC-03, MVP-SPEC-04).
 */
export class SoftwareFactoryControlPlaneStore {
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
  private outboxEvents: Map<string, OutboxEventRecord> = new Map();

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

  public getMainRefCommitHash(): string | null {
    const currentProjectId = this.requireCurrentProjectId();
    if (!currentProjectId) {
      return null;
    }
    return this.gitRefsByProject.get(currentProjectId)?.get("refs/heads/main") ?? null;
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
