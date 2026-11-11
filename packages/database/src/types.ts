import type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  CandidateBoundLineage,
  LeaseSyncStatusResponse,
  MergeCandidateRecord,
  MergeOperationRecord,
  OutboxEventRecord,
  ProcessedWorkerEventRecord,
  ResourceUsageMetricRecord,
  ResourceUsageMetricsSource,
  ResourceUsagePhase,
  ReviewArtifactRecord,
  ReviewSessionRecord,
  ReviewSessionStatus,
  ServerEventAckContract,
  SnapshotRetentionClass,
  TaskLeaseRecord,
  TaskRecord,
  TaskStatus,
  Tier3AssertionEvidence,
  VerificationExecutionBackend,
  VerificationOverallStatus,
  VerificationRunRecord,
  VerifiedCodeImportRecord,
  WorkerEventEnvelope,
} from "@software-factory/shared-types";
import type {
  GitTreeChangeEntry,
  GitTreeImportCandidateInput,
  TaskContractSpec,
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

export interface RecordResourceUsageMetricInput {
  project_id: string;
  task_id: string;
  lease_id?: string | null;
  lease_epoch: number;
  attempt_no?: number;
  rework_cycle?: number;
  phase: ResourceUsagePhase;
  wall_time_ms: number;
  cpu_usage_usec: number;
  peak_memory_bytes: number;
  sandbox_backend_mode: string;
  metrics_source: ResourceUsageMetricsSource;
}

/**
 * Shared Control Plane Repository Contract implemented by both
 * `SoftwareFactoryControlPlaneStore` (in-memory) and `PostgresControlPlaneRepository`
 * (real PostgreSQL via `PostgresRuntimePool`).
 */
export interface ControlPlaneStore {
  clockTimestampIso(): string | Promise<string>;
  withRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: () => Promise<T> | T
  ): Promise<T>;
  createProject(input: {
    project_id?: string;
    slug: string;
    name: string;
    repo_bare_path: string;
    initial_main_commit_hash: string;
    initial_main_tree_hash?: string;
    approval_ttl_seconds?: number;
  }): ProjectRecord | Promise<ProjectRecord>;
  addProjectMembership(input: {
    project_id: string;
    principal_id: string;
    member_role: ProjectMemberRole;
  }): ProjectMembershipRecord | Promise<ProjectMembershipRecord>;
  getProjectMembership(
    projectId: string,
    principalId: string
  ): ProjectMembershipRecord | null | Promise<ProjectMembershipRecord | null>;
  getProjectById(projectId: string): ProjectRecord | null | Promise<ProjectRecord | null>;
  createTask(input: {
    task_id?: string;
    project_id: string;
    title: string;
    task_contract: TaskContractSpec;
    base_main_commit_hash?: string;
    max_rework_cycles?: number;
  }): TaskRecord | Promise<TaskRecord>;
  selectVisibleTasks(): TaskRecord[] | Promise<TaskRecord[]>;
  getTaskById(taskId: string): TaskRecord | null | Promise<TaskRecord | null>;
  grantTaskLease(input: {
    project_id: string;
    task_id: string;
    worker_id: string;
    heartbeat_interval_ms?: number;
    lease_ttl_ms?: number;
  }): Promise<TaskLeaseRecord>;
  getLeaseById(leaseId: string): TaskLeaseRecord | null | Promise<TaskLeaseRecord | null>;
  listTaskLeasesForTask(taskId: string): TaskLeaseRecord[] | Promise<TaskLeaseRecord[]>;
  listProcessedWorkerEventsForTask(
    taskId: string
  ): ProcessedWorkerEventRecord[] | Promise<ProcessedWorkerEventRecord[]>;
  getLeaseSyncStatus(
    leaseId: string
  ): LeaseSyncStatusResponse | null | Promise<LeaseSyncStatusResponse | null>;
  submitWorkerEvent(
    envelope: WorkerEventEnvelope,
    inTransactionDelayMs?: number
  ): Promise<ServerEventAckContract>;
  revokeTaskLease(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    reason: string;
    requeueTask?: boolean;
  }): Promise<TaskLeaseRecord>;
  listExpiredActiveLeaseScopes(
    batchLimit?: number
  ):
    | Array<{ project_id: string; lease_id: string; task_id: string }>
    | Promise<Array<{ project_id: string; lease_id: string; task_id: string }>>;
  runLeaseExpiryAndOrphanedPushReconciler(
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
  >;
  pushStagingGitRefWithGatekeeper(input: {
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
  }>;
  getVerifiedImportsForTask(
    taskId: string
  ): VerifiedCodeImportRecord[] | Promise<VerifiedCodeImportRecord[]>;
  recordVerifiedCodeImport(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    candidate_input: GitTreeImportCandidateInput;
  }): VerifiedCodeImportRecord | Promise<VerifiedCodeImportRecord>;
  createMergeCandidate(input: {
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
  }): MergeCandidateRecord | Promise<MergeCandidateRecord>;
  markMergeConflictReworkRequired(input: {
    project_id: string;
    task_id: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    conflicted_files: readonly string[];
    import_id?: string;
    conflict_summary?: string;
  }):
    | { readonly task_status: TaskStatus; readonly conflicted_files: readonly string[] }
    | Promise<{ readonly task_status: TaskStatus; readonly conflicted_files: readonly string[] }>;
  recordVerificationRun(input: {
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
  }): VerificationRunRecord | Promise<VerificationRunRecord>;
  recordReviewSession(input: {
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
  }): ReviewSessionRecord | Promise<ReviewSessionRecord>;
  completeReviewSession(input: {
    project_id: string;
    review_session_id: string;
    status: "COMPLETED" | "FAILED" | "REVOKED";
    cleanup_populated_zero_verified: boolean;
    sandbox_backend_mode?: string;
    sandbox_pid?: number | null;
    sandbox_cgroup_path?: string | null;
  }): ReviewSessionRecord | Promise<ReviewSessionRecord>;
  recordReviewArtifact(input: {
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
  }): ReviewArtifactRecord | Promise<ReviewArtifactRecord>;
  submitHumanApproval(input: {
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
  }): ApprovalDecisionRecord | Promise<ApprovalDecisionRecord>;
  executeAtomicCasMergeOrReconcile(input: {
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
  }): Promise<CasMergeResult>;
  getMainRefCommitHash(projectId?: string): string | null | Promise<string | null>;
  getMergeCandidateById(
    mergeCandidateId: string
  ): MergeCandidateRecord | null | Promise<MergeCandidateRecord | null>;
  listMergeCandidatesForTask(
    taskId: string
  ): MergeCandidateRecord[] | Promise<MergeCandidateRecord[]>;
  listVerificationRunsForTask(
    taskId: string
  ): VerificationRunRecord[] | Promise<VerificationRunRecord[]>;
  listReviewSessionsForTask(
    taskId: string
  ): ReviewSessionRecord[] | Promise<ReviewSessionRecord[]>;
  listReviewArtifactsForTask(
    taskId: string
  ): ReviewArtifactRecord[] | Promise<ReviewArtifactRecord[]>;
  listApprovalRequestsForTask(
    taskId: string
  ): ApprovalRequestRecord[] | Promise<ApprovalRequestRecord[]>;
  getLatestApprovalRequestForCandidate(
    mergeCandidateId: string
  ): ApprovalRequestRecord | null | Promise<ApprovalRequestRecord | null>;
  listApprovalDecisionsForTask(
    taskId: string
  ): ApprovalDecisionRecord[] | Promise<ApprovalDecisionRecord[]>;
  listMergeOperationsForTask(
    taskId: string
  ): MergeOperationRecord[] | Promise<MergeOperationRecord[]>;
  recordResourceUsageMetric(
    input: RecordResourceUsageMetricInput
  ): ResourceUsageMetricRecord | Promise<ResourceUsageMetricRecord>;
  listResourceUsageMetricsForTask(
    taskId: string
  ): ResourceUsageMetricRecord[] | Promise<ResourceUsageMetricRecord[]>;
  getCandidateBoundLineage(
    taskId: string,
    liveMainHeadHash?: string | null
  ): CandidateBoundLineage | null | Promise<CandidateBoundLineage | null>;
  listOutboxEventsForProject(): OutboxEventRecord[] | Promise<OutboxEventRecord[]>;
}
