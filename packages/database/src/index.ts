import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ApprovalDecisionRecord,
  type LeaseStatus,
  type LeaseSyncStatusResponse,
  type MergeCandidateRecord,
  type OutboxEventRecord,
  type ProcessedWorkerEventRecord,
  type ReviewArtifactRecord,
  type ServerEventAckContract,
  type TaskLeaseRecord,
  type TaskRecord,
  type TaskStatus,
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

export interface ProjectMembershipRecord {
  membership_id: string;
  project_id: string;
  principal_id: string;
  member_role: "PROJECT_ADMIN" | "APPROVER" | "DEVELOPER" | "VIEWER";
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

export interface ProjectRecord {
  project_id: string;
  slug: string;
  name: string;
  repo_bare_path: string;
  default_branch: string;
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
}

/**
 * SoftwareFactoryControlPlaneStore implements the PostgreSQL 4-Tier RLS Engine,
 * Canonical Lock Ordering (`task_leases` -> `tasks`), `clock_timestamp()` evaluation,
 * Lease/Event Coordinator, 3D Independent Reviewer Guard, 8-Field Approval Binding,
 * and Atomic CAS Merge + Post-Merge Reconciler (MVP-SPEC-02, MVP-SPEC-03, MVP-SPEC-04).
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
  private reviewArtifacts: Map<string, ReviewArtifactRecord> = new Map();
  private approvalDecisions: Map<string, ApprovalDecisionRecord> = new Map();
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
  }): ProjectRecord {
    if (this.getCurrentRlsSession().currentRole !== "system_admin_role") {
      throw new PostgresRlsError("42501", "Only system_admin_role can insert into projects");
    }
    const now = this.clockTimestampIso();
    const project_id = input.project_id ?? randomUUID();
    const record: ProjectRecord = {
      project_id,
      slug: input.slug,
      name: input.name,
      repo_bare_path: input.repo_bare_path,
      default_branch: "main",
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
    member_role: "PROJECT_ADMIN" | "APPROVER" | "DEVELOPER" | "VIEWER";
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

  public createTask(input: {
    task_id?: string;
    project_id: string;
    title: string;
    task_contract: TaskContractSpec;
    base_main_commit_hash?: string;
  }): TaskRecord {
    this.assertWritePermissionForProject(input.project_id);
    const project = this.projects.get(input.project_id);
    if (!project) {
      throw new PostgresRlsError("23503", `Project ${input.project_id} does not exist`);
    }
    const now = this.clockTimestampIso();
    const task_id = input.task_id ?? randomUUID();
    const record: TaskRecord = {
      task_id,
      project_id: input.project_id,
      title: input.title,
      task_contract_json: input.task_contract as unknown as Record<string, unknown>,
      status: "QUEUED",
      base_main_commit_hash: input.base_main_commit_hash ?? project.main_ref_commit_hash,
      current_attempt_no: 0,
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
  // Lease Grant, Canonical Lock Event Submission & Revocation (MVP-SPEC-03)
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
      if (task.status !== "QUEUED") {
        throw new Error(`Cannot grant lease when task is in status ${task.status}`);
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
      task.status = "LEASED";
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
   * Atomic Worker Event Processing Transaction (MVP-SPEC-03 Section 2.3)
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
          task_status: task?.status ?? "FAILED",
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
          if (task.status === "LEASED" || task.status === "ACCEPTED" || task.status === "IN_PROGRESS") {
            task.status = "QUEUED";
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
   * Atomic Lease Revocation Transaction (MVP-SPEC-03 Section 2.4)
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
        if (task.status === "LEASED" || task.status === "ACCEPTED" || task.status === "IN_PROGRESS") {
          task.status = input.requeueTask ? "QUEUED" : "FAILED";
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
   * (MVP-SPEC-03 Section 5.1-5.2 & Roadmap M2 Section 1)
   */
  public pushStagingGitRefWithGatekeeper(input: {
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
    simulatedGatekeeperLatencyMs?: number;
  }): {
    allowed: boolean;
    error_code?: string;
    reason?: string;
    import_id?: string;
  } {
    const startMs = Date.now();

    // Step 1a: Fail-Closed on Control Plane / DB outage or > 2000ms timeout (FIX-16)
    const simulatedLatency = input.simulatedGatekeeperLatencyMs ?? 0;
    if (input.simulateControlPlaneOutage === true || simulatedLatency > 2000) {
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason:
          "Pre-receive Fail-Closed: Control Plane unreachable or exceeded 2000ms hard timeout",
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

    // Step 2-6: Execute 6-Step TrustedImportValidator right at pre-receive hook
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

    const totalElapsedMs = (Date.now() - startMs) + simulatedLatency;
    if (totalElapsedMs > 2000) {
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason: `Pre-receive hard timeout exceeded: execution took ${totalElapsedMs}ms (> 2000ms)`,
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

    // Record immediately in `verified_code_imports` when changes were validated at pre-receive (M2 P0-4)
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

  private findLatestVerifiedImportByLease(
    leaseId: string,
    stagingRef?: string
  ): VerifiedCodeImportRecord | undefined {
    let latest: VerifiedCodeImportRecord | undefined;
    for (const rec of this.verifiedCodeImports.values()) {
      if (rec.lease_id === leaseId && (!stagingRef || rec.staging_ref === stagingRef)) {
        if (!latest || new Date(rec.created_at).getTime() >= new Date(latest.created_at).getTime()) {
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
   * LeaseExpiryReconciler & Orphaned Git Push Reconciler (MVP-SPEC-03 Section 3.2 & Roadmap M2 P0-4)
   * If a Worker pushed a valid staging commit before its connection died (losing `task.completed`),
   * the reconciler detects the recorded `verified_code_imports` entry (or validates the staging ref)
   * and advances the task to `AGENT_COMPLETED` without re-running the Agent!
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

            // Path A (M2): Check if pre-receive hook already recorded a VerifiedCodeImportRecord for this lease!
            const expectedStagingRef = `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`;
            const preRecordedImport =
              this.findLatestVerifiedImportByLease(lease.lease_id, expectedStagingRef) ??
              this.findLatestVerifiedImportByLease(lease.lease_id);
            if (preRecordedImport) {
              lease.status = "COMPLETED";
              lease.completed_at = nowIso;
              task.status = "AGENT_COMPLETED";
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
            const refs = this.gitRefsByProject.get(scope.project_id);
            const commits = this.gitCommitsByProject.get(scope.project_id);
            const stagingCommitHash = refs?.get(stagingRef);
            const commitMeta = stagingCommitHash ? commits?.get(stagingCommitHash) : undefined;

            if (stagingCommitHash && commitMeta && orphanedDiffProvider) {
              const candidateInput = orphanedDiffProvider({
                project_id: scope.project_id,
                task_id: task.task_id,
                lease_id: lease.lease_id,
                lease_epoch: lease.lease_epoch,
                staging_ref: stagingRef,
                agent_commit_hash: stagingCommitHash,
                verified_tree_hash: commitMeta.treeHash,
                parent_commit_hashes: commitMeta.parents,
              });
              if (candidateInput) {
                const validation = validateGitTreeImport(candidateInput);
                if (validation.valid) {
                  // Recover orphaned push into verified_code_imports and advance task to AGENT_COMPLETED!
                  const importRecord: VerifiedCodeImportRecord = {
                    import_id: randomUUID(),
                    project_id: scope.project_id,
                    task_id: task.task_id,
                    lease_id: lease.lease_id,
                    lease_epoch: lease.lease_epoch,
                    agent_commit_hash: validation.agent_commit_hash,
                    verified_tree_hash: validation.verified_tree_hash,
                    staging_ref: stagingRef,
                    changed_files_count: validation.changed_files_count,
                    deleted_lines_count: validation.deleted_lines_count,
                    created_at: nowIso,
                  };
                  this.verifiedCodeImports.set(importRecord.import_id, importRecord);
                  lease.status = "COMPLETED";
                  lease.completed_at = nowIso;
                  task.status = "AGENT_COMPLETED";
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

            // Otherwise mark lease EXPIRED and requeue task
            lease.status = "EXPIRED";
            if (task.active_lease_id === lease.lease_id) {
              task.active_lease_id = null;
              task.status = "QUEUED";
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
    const validation = validateGitTreeImport(input.candidate_input);
    if (!validation.valid) {
      throw new Error(`TrustedImportValidator rejected import: [${validation.error_code}] ${validation.message}`);
    }
    const existing = this.findVerifiedImportByLeaseAndCommit(
      input.lease_id,
      validation.agent_commit_hash
    );
    if (existing) {
      return { ...existing };
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
   * Automatically supersedes any older candidate on the same task and invalidates stale reviews/approvals!
   * (MVP-SPEC-04 Section 2.3 & Section 3.1)
   */
  public createMergeCandidate(input: {
    project_id: string;
    task_id: string;
    import_id: string;
    base_main_commit_hash: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
  }): MergeCandidateRecord {
    this.assertWritePermissionForProject(input.project_id);
    const task = this.tasks.get(input.task_id);
    const imp = this.verifiedCodeImports.get(input.import_id);
    if (!task || !imp || task.project_id !== input.project_id || imp.project_id !== input.project_id) {
      throw new PostgresRlsError("23503", "Task or VerifiedCodeImport not found for project");
    }

    // Verify import belongs to this task (FIX-12)
    if (imp.task_id !== input.task_id) {
      throw new PostgresRlsError("23503", "Import does not belong to the specified task");
    }

    // Verify candidate base matches current main ref (FIX-12)
    const refs = this.gitRefsByProject.get(input.project_id);
    const currentMainSha = refs?.get("refs/heads/main");
    if (currentMainSha && input.base_main_commit_hash !== currentMainSha) {
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
          "SUPERSEDED_BY_NEW_MERGE_CANDIDATE"
        );
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
      verified_tree_hash: imp.verified_tree_hash,
      is_superseded: false,
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

    task.status = "CANDIDATE_BUILT";
    task.base_main_commit_hash = input.base_main_commit_hash;
    task.active_merge_candidate_id = candidate.merge_candidate_id;
    task.updated_at = nowIso;

    return { ...candidate };
  }

  private invalidateArtifactsAndApprovalsForCandidate(
    mergeCandidateId: string,
    reason: string
  ): void {
    for (const ra of this.reviewArtifacts.values()) {
      if (ra.merge_candidate_id === mergeCandidateId && !ra.is_invalidated) {
        ra.is_invalidated = true;
        ra.invalidated_reason = reason;
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
      exit_code: input.exit_code,
      duration_ms: input.duration_ms,
      report_sha256: input.report_sha256,
      created_at: nowIso,
    };
    this.verificationRuns.set(record.verification_run_id, record);
    task.status = input.verdict === "PASS" ? "VERIFIED_PASS" : "VERIFIED_FAIL";
    task.updated_at = nowIso;
    return { ...record };
  }

  /**
   * 3D Independent Reviewer Artifact Recording (MVP-SPEC-04 Section 2)
   * Enforces `chk_independent_reviewer_model`: `(writer_provider, writer_model) IS DISTINCT FROM (reviewer_provider, reviewer_model)`.
   * Enforces `chk_independent_reviewer_principal`: developer and reviewer must be distinct principals (FIX-03).
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
    developer_principal_id?: string;
    reviewer_principal_id?: string;
    developer_session_id?: string;
    reviewer_session_id?: string;
    verdict: "PASS" | "FAIL";
    findings_json?: ReadonlyArray<Record<string, unknown>>;
  }): ReviewArtifactRecord {
    this.assertWritePermissionForProject(input.project_id);

    // Dimension 1: Model Identity Independence Check
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
    const devPrincipal = input.developer_principal_id ?? "agent-writer-principal";
    const revPrincipal = input.reviewer_principal_id ?? "reviewer-principal";
    if (devPrincipal.trim().toLowerCase() === revPrincipal.trim().toLowerCase()) {
      throw new PostgresRlsError(
        "23514",
        `new row violates check constraint "chk_independent_reviewer_principal": developer (${devPrincipal}) must be distinct from reviewer (${revPrincipal})`
      );
    }

    // Dimension 3: Session Independence Check (FIX-03)
    if (
      input.developer_session_id &&
      input.reviewer_session_id &&
      input.developer_session_id === input.reviewer_session_id
    ) {
      throw new PostgresRlsError(
        "23514",
        `new row violates check constraint "chk_independent_reviewer_session": developer session (${input.developer_session_id}) must be distinct from reviewer session`
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

    const nowIso = this.clockTimestampIso();
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
      developer_session_id: input.developer_session_id ?? null,
      reviewer_session_id: input.reviewer_session_id ?? null,
      verdict: input.verdict,
      is_invalidated: false,
      invalidated_reason: null,
      findings_json: input.findings_json ?? [],
      created_at: nowIso,
    };
    this.reviewArtifacts.set(record.review_artifact_id, record);
    task.status = input.verdict === "PASS" ? "REVIEWED_PASS" : "REVIEWED_FAIL";
    task.updated_at = nowIso;
    return { ...record };
  }

  /**
   * 8-Field Cryptographically Bound Human Approval (MVP-SPEC-02 Section 6 & MVP-SPEC-04 Section 3.1)
   * Enforces RLS-T8 (Composite FK cross-tenant & 8-field exact binding) + Approval TTL window.
   */
  public submitHumanApproval(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    verified_tree_hash: string;
    merge_candidate_hash: string;
    verification_run_id: string;
    review_artifact_id: string;
    approver_principal_id: string;
    decision: "APPROVED" | "REJECTED";
    ttl_ms?: number;
  }): ApprovalDecisionRecord {
    this.assertWritePermissionForProject(input.project_id);

    // Verify approver membership authorization if project has configured members (FIX-11)
    const membership = this.getProjectMembership(input.project_id, input.approver_principal_id);
    if (membership && membership.member_role !== "APPROVER" && membership.member_role !== "PROJECT_ADMIN") {
      throw new PostgresRlsError(
        "42501",
        `Principal ${input.approver_principal_id} with role ${membership.member_role} is not authorized to approve in project ${input.project_id}`
      );
    }

    const mc = this.mergeCandidates.get(input.merge_candidate_id);
    const ra = this.reviewArtifacts.get(input.review_artifact_id);
    const vr = this.verificationRuns.get(input.verification_run_id);
    const task = this.tasks.get(input.task_id);

    // Enforce maximum 1 ACTIVE approval per candidate (FIX-11 / uq_one_active_approval_per_candidate)
    for (const ad of this.approvalDecisions.values()) {
      if (ad.merge_candidate_id === input.merge_candidate_id && ad.status === "ACTIVE") {
        throw new PostgresRlsError(
          "23505",
          `An ACTIVE approval already exists for merge candidate ${input.merge_candidate_id}`
        );
      }
    }

    // Enforce task status is REVIEWED_PASS before receiving human approval (FIX-11)
    if (task && task.status !== "REVIEWED_PASS") {
      throw new PostgresRlsError(
        "23514",
        `Task must be in REVIEWED_PASS status to receive human approval, got ${task.status}`
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
      ra.verdict !== "PASS" ||
      vr.verdict !== "PASS"
    ) {
      throw new PostgresRlsError(
        "23503",
        "insert or update on table \"approval_decisions\" violates composite 8-field foreign key constraint"
      );
    }

    const nowDate = this.clockFn();
    const nowIso = nowDate.toISOString();
    const ttlMs = input.ttl_ms ?? 24 * 60 * 60 * 1000; // Default 24h TTL
    if (ttlMs <= 0) {
      throw new PostgresRlsError("23514", "chk_approval_ttl_window: expires_at must be > approved_at");
    }

    const record: ApprovalDecisionRecord = {
      approval_id: randomUUID(),
      project_id: input.project_id,
      task_id: input.task_id,
      merge_candidate_id: input.merge_candidate_id,
      agent_commit_hash: input.agent_commit_hash,
      base_main_commit_hash: input.base_main_commit_hash,
      verified_tree_hash: input.verified_tree_hash,
      merge_candidate_hash: input.merge_candidate_hash,
      verification_run_id: input.verification_run_id,
      review_artifact_id: input.review_artifact_id,
      approver_principal_id: input.approver_principal_id,
      decision: input.decision,
      status: "ACTIVE",
      invalidated_reason: null,
      approved_at: nowIso,
      expires_at: new Date(nowDate.getTime() + ttlMs).toISOString(),
      consumed_at: null,
    };

    this.approvalDecisions.set(record.approval_id, record);
    task.status = input.decision === "APPROVED" ? "APPROVED" : "REJECTED";
    task.updated_at = nowIso;
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

  /**
   * 6-Step Post-Merge Reconciler & Atomic CAS Merge (`MVP-SPEC-04` Section 3.2 & Section 3.3)
   * Handles:
   * - Already `MERGED` idempotent return
   * - Crash after `git update-ref` succeeded (`currentMainSha === merge_candidate_hash` or ancestor with matching trailers) -> reconciles DB to `MERGED` without re-running CAS!
   * - Approval TTL expiry (`expires_at <= clock_timestamp()`) -> marks approval `EXPIRED` and transitions task to `REVIEWED_PASS`
   * - CAS conflict (`currentMainSha !== base_main_commit_hash`) -> marks candidate superseded, invalidates review & approval, and transitions task to `NEEDS_REBASE`
   * - Clean CAS (`currentMainSha === base_main_commit_hash`) -> atomically updates `refs/heads/main` to `merge_candidate_hash`, marks approval `CONSUMED`, and transitions task to `MERGED`.
   */
  public async executeAtomicCasMergeOrReconcile(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_id: string;
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
      if (approval.task_id !== input.task_id || approval.merge_candidate_id !== input.merge_candidate_id) {
        throw new Error("Approval decision does not bind to the specified task and merge candidate");
      }
      if (task.status !== "APPROVED" && task.status !== "MERGED") {
        throw new Error(`Task must be in APPROVED status for CAS merge, current status is ${task.status}`);
      }

      const currentMainSha = refs.get("refs/heads/main")!;

      // Step 1: If DB already recorded MERGED, return idempotently
      if (task.status === "MERGED" && task.merged_commit_hash) {
        return {
          status: "RECONCILED_ALREADY_MERGED",
          task_status: "MERGED",
          merged_commit_hash: task.merged_commit_hash,
          main_ref_commit_hash: currentMainSha,
        };
      }

      // Step 2: Check if Git `refs/heads/main` ALREADY contains `merge_candidate_hash`
      // (Recovering from crash after Git CAS succeeded but before DB commit completed!)
      if (currentMainSha === mc.merge_candidate_hash) {
        if (approval.status === "ACTIVE") {
          approval.status = "CONSUMED";
          approval.consumed_at = nowIso;
        }
        task.status = "MERGED";
        task.merged_commit_hash = mc.merge_candidate_hash;
        task.merged_at = nowIso;
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
          }
        );

        return {
          status: "RECONCILED_ALREADY_MERGED",
          task_status: "MERGED",
          merged_commit_hash: mc.merge_candidate_hash,
          main_ref_commit_hash: currentMainSha,
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
        task.status = "REVIEWED_PASS";
        task.updated_at = nowIso;

        return {
          status: "APPROVAL_EXPIRED",
          task_status: task.status,
          merged_commit_hash: null,
          main_ref_commit_hash: currentMainSha,
          invalidated_approval_id: approval.approval_id,
        };
      }

      // Step 4: Check if `refs/heads/main` moved away from `base_main_commit_hash` (CAS Conflict)
      if (currentMainSha !== mc.base_main_commit_hash) {
        mc.is_superseded = true;
        this.invalidateArtifactsAndApprovalsForCandidate(
          mc.merge_candidate_id,
          `CAS_MAIN_MOVED_FROM_${mc.base_main_commit_hash}_TO_${currentMainSha}`
        );
        task.status = "NEEDS_REBASE";
        task.active_merge_candidate_id = null;
        task.updated_at = nowIso;

        return {
          status: "CAS_CONFLICT_NEEDS_REBASE",
          task_status: "NEEDS_REBASE",
          merged_commit_hash: null,
          main_ref_commit_hash: currentMainSha,
          invalidated_approval_id: approval.approval_id,
        };
      }

      // Step 5 & 6: Execute Atomic Git CAS (`git update-ref refs/heads/main <merge_candidate_hash> <base_main_commit_hash>`)
      refs.set("refs/heads/main", mc.merge_candidate_hash);
      project.main_ref_commit_hash = mc.merge_candidate_hash;
      project.updated_at = nowIso;

      approval.status = "CONSUMED";
      approval.consumed_at = nowIso;
      task.status = "MERGED";
      task.merged_commit_hash = mc.merge_candidate_hash;
      task.merged_at = nowIso;
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
        }
      );

      return {
        status: "MERGED_BY_CAS",
        task_status: "MERGED",
        merged_commit_hash: mc.merge_candidate_hash,
        main_ref_commit_hash: mc.merge_candidate_hash,
      };
    });
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
