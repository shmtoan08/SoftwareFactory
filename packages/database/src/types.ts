import type {
  AgentOrgRole,
  AgentOrganizationProfileRecord,
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  BaselineSpecFreezeRecord,
  CandidateBoundLineage,
  ChangeRequestProposedTaskSpec,
  ChangeRequestRecord,
  CostPreflightCheckInput,
  CostPreflightCheckResult,
  CostSessionRecord,
  DevEpicRecord,
  DevMilestoneRecord,
  DevUserStoryRecord,
  ExecutionTargetType,
  FinalizeModelCallInput,
  FinalizeModelCallResult,
  LeaseSyncStatusResponse,
  MergeCandidateRecord,
  MergeOperationRecord,
  ModelCallLedgerRecord,
  ModelProviderName,
  OutboxEventRecord,
  PipelineStageName,
  ProcessedWorkerEventRecord,
  ProductPipelineBundle,
  ProductPipelineSessionRecord,
  ProjectBootstrapRecord,
  ReleaseAcceptancePackageRecord,
  ResourceUsageMetricRecord,
  ResourceUsageMetricsSource,
  ResourceUsagePhase,
  ReviewArtifactRecord,
  ReviewSessionRecord,
  ReviewSessionStatus,
  ServerEventAckContract,
  SnapshotRetentionClass,
  Stage1ConfirmationStatus,
  Stage1DiscoveryItemRecord,
  Stage1ItemKind,
  Stage7DevelopmentPlanBundle,
  StageApprovalGateRecord,
  StageApprovalGateStage,
  StageArtifactKind,
  StageArtifactRecord,
  TargetTrustTier,
  TaskLeaseRecord,
  TaskPlanLinkRecord,
  TaskRecord,
  TaskStatus,
  Tier3AssertionEvidence,
  TrustedAcceptanceTestSpec,
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

export class Ac10ViolationError extends PostgresRlsError {
  public readonly code = "ERR_AC10_UNCONFIRMED_ASSUMPTION" as const;
  public readonly offendingItemIds: readonly string[];

  constructor(message: string, offendingItemIds: readonly string[] = []) {
    super("23514", message);
    this.name = "Ac10ViolationError";
    this.offendingItemIds = offendingItemIds;
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

export interface CreateCostSessionInput {
  readonly cost_session_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id?: string | null;
  readonly task_id?: string | null;
  readonly max_tokens_per_request: number;
  readonly max_cost_micro_usd_per_request: number;
  readonly session_token_budget: number;
  readonly session_cost_budget_micro_usd: number;
}

export interface CreateProductPipelineSessionInput {
  readonly pipeline_session_id?: string;
  readonly project_id: string;
  readonly cost_session_id?: string | null;
  readonly title: string;
  readonly raw_idea_text: string;
  readonly created_by_principal_id: string;
}

export interface CreateStage1DiscoveryItemInput {
  readonly item_id?: string;
  readonly kind: Stage1ItemKind;
  readonly title: string;
  readonly statement: string;
  readonly rationale: string;
  readonly clarification_question?: string | null;
  readonly confirmation_status?: Stage1ConfirmationStatus;
}

export interface CreateStage1DiscoveryItemsInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly items: readonly CreateStage1DiscoveryItemInput[];
}

export interface ResolveStage1DiscoveryItemInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly item_id: string;
  readonly decision: "CONFIRM" | "REJECT";
  readonly actor_principal_id: string;
  readonly resolution_note?: string | null;
}

export interface RecordStageArtifactInput {
  readonly artifact_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly stage: PipelineStageName;
  readonly artifact_kind: StageArtifactKind;
  readonly provider: ModelProviderName | "system";
  readonly model: string;
  readonly prompt_id: string;
  readonly prompt_version: string;
  readonly prompt_sha256: string;
  readonly content_json: Readonly<Record<string, unknown>>;
  readonly artifact_sha256?: string;
  readonly created_by_principal_id: string;
  readonly advance_session_stage?: PipelineStageName;
}

export interface RecordStageApprovalGateInput {
  readonly gate_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly gate_stage: StageApprovalGateStage;
  readonly target_artifact_id: string;
  readonly target_artifact_sha256: string;
  readonly approver_principal_id: string;
  readonly decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
  readonly rationale?: string | null;
}

export interface FreezeBaselineSpecInput {
  readonly baseline_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly stage1_artifact_id: string;
  readonly stage1_artifact_sha256: string;
  readonly stage2_artifact_id: string;
  readonly stage2_artifact_sha256: string;
  readonly stage3_artifact_id: string;
  readonly stage3_artifact_sha256: string;
  readonly validation_report_artifact_id: string;
  readonly validation_report_sha256: string;
  readonly approval_gate_id: string;
  readonly frozen_by_principal_id: string;
}

export interface CreateProjectBootstrapInput {
  readonly bootstrap_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly repo_path: string;
  readonly trusted_acceptance_dir: string;
  readonly base_main_commit_hash: string;
  readonly protected_paths: readonly string[];
  readonly trusted_policy_sha256: string;
  readonly generated_files: readonly string[];
  readonly acceptance_tests: readonly TrustedAcceptanceTestSpec[];
  readonly created_by_principal_id: string;
}

export interface UpsertAgentOrganizationProfileInput {
  readonly profile_id?: string;
  readonly project_id: string;
  readonly profile_key: string;
  readonly role: AgentOrgRole;
  readonly principal_id: string;
  readonly provider: string;
  readonly model: string;
  readonly execution_target_type: ExecutionTargetType;
  readonly trust_tier: TargetTrustTier;
  readonly target_locator?: string | null;
  readonly capabilities_json?: Readonly<Record<string, unknown>>;
  readonly is_active?: boolean;
  readonly created_by_principal_id: string;
}

export interface CreateStage7DevelopmentPlanInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly bootstrap_id: string;
  readonly base_main_commit_hash: string;
  readonly milestones: ReadonlyArray<{
    readonly milestone_id?: string;
    readonly milestone_key: string;
    readonly title: string;
    readonly description: string;
    readonly sequence_order: number;
  }>;
  readonly epics: ReadonlyArray<{
    readonly epic_id?: string;
    readonly milestone_key: string;
    readonly epic_key: string;
    readonly title: string;
    readonly description: string;
    readonly sequence_order: number;
  }>;
  readonly stories: ReadonlyArray<{
    readonly story_id?: string;
    readonly epic_key: string;
    readonly story_key: string;
    readonly title: string;
    readonly description: string;
    readonly requirement_ids: readonly string[];
    readonly ac_ids: readonly string[];
    readonly sequence_order: number;
  }>;
  readonly tasks: ReadonlyArray<{
    readonly task_id?: string;
    readonly story_key: string;
    readonly title: string;
    readonly task_contract: TaskContractSpec;
    readonly requirement_ids: readonly string[];
    readonly ac_ids: readonly string[];
    readonly assigned_profile_id?: string | null;
    readonly max_rework_cycles?: number;
  }>;
}

export interface CreateChangeRequestStoreInput {
  readonly cr_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly cr_key: string;
  readonly title: string;
  readonly rationale: string;
  readonly impacted_requirement_ids: readonly string[];
  readonly impacted_component_ids?: readonly string[];
  readonly proposed_tasks: readonly ChangeRequestProposedTaskSpec[];
  readonly requested_by_principal_id: string;
}

export interface DecideChangeRequestStoreInput {
  readonly project_id: string;
  readonly cr_id: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly decided_by_principal_id: string;
  readonly decision_rationale?: string | null;
}

export interface ApplyChangeRequestStoreInput {
  readonly project_id: string;
  readonly cr_id: string;
  readonly bootstrap_id?: string | null;
  readonly applied_by_principal_id: string;
  readonly base_main_commit_hash: string;
  readonly protected_paths: readonly string[];
  readonly trusted_policy_sha256: string;
}

export interface RecordReleaseAcceptancePackageInput {
  readonly release_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly traceability_sha256: string;
  readonly coverage_percent: number;
  readonly complete: boolean;
  readonly total_requirements: number;
  readonly merged_task_ids: readonly string[];
  readonly applied_cr_ids: readonly string[];
  readonly main_head_commit_hash: string;
  readonly summary_markdown: string;
  readonly package_json: Readonly<Record<string, unknown>>;
  readonly accepted_by_principal_id: string;
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

  // Milestone M6A: Model Cost Guard (AC-12b) & Stages 1–4 Product Pipeline
  createCostSession(input: CreateCostSessionInput): CostSessionRecord | Promise<CostSessionRecord>;
  getCostSession(
    costSessionId: string
  ): CostSessionRecord | null | Promise<CostSessionRecord | null>;
  listModelCallLedgers(filter?: {
    readonly cost_session_id?: string;
    readonly pipeline_session_id?: string;
  }): ModelCallLedgerRecord[] | Promise<ModelCallLedgerRecord[]>;
  preflightCheckCostSession(
    input: CostPreflightCheckInput
  ): CostPreflightCheckResult | Promise<CostPreflightCheckResult>;
  finalizeModelCallLedger(
    input: FinalizeModelCallInput
  ): FinalizeModelCallResult | Promise<FinalizeModelCallResult>;

  createProductPipelineSession(
    input: CreateProductPipelineSessionInput
  ): ProductPipelineSessionRecord | Promise<ProductPipelineSessionRecord>;
  getProductPipelineSession(
    pipelineSessionId: string
  ): ProductPipelineSessionRecord | null | Promise<ProductPipelineSessionRecord | null>;
  listProductPipelineSessions():
    | ProductPipelineSessionRecord[]
    | Promise<ProductPipelineSessionRecord[]>;
  updateProductPipelineSessionCostSession(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly cost_session_id: string;
  }): ProductPipelineSessionRecord | Promise<ProductPipelineSessionRecord>;

  createStage1DiscoveryItems(
    input: CreateStage1DiscoveryItemsInput
  ): Stage1DiscoveryItemRecord[] | Promise<Stage1DiscoveryItemRecord[]>;
  resolveStage1DiscoveryItem(
    input: ResolveStage1DiscoveryItemInput
  ): Stage1DiscoveryItemRecord | Promise<Stage1DiscoveryItemRecord>;
  listStage1DiscoveryItems(
    pipelineSessionId: string
  ): Stage1DiscoveryItemRecord[] | Promise<Stage1DiscoveryItemRecord[]>;

  recordStageArtifact(
    input: RecordStageArtifactInput
  ): StageArtifactRecord | Promise<StageArtifactRecord>;
  listStageArtifacts(
    pipelineSessionId: string
  ): StageArtifactRecord[] | Promise<StageArtifactRecord[]>;
  getStageArtifactById(
    artifactId: string
  ): StageArtifactRecord | null | Promise<StageArtifactRecord | null>;

  recordStageApprovalGate(
    input: RecordStageApprovalGateInput
  ): StageApprovalGateRecord | Promise<StageApprovalGateRecord>;
  listStageApprovalGates(
    pipelineSessionId: string
  ): StageApprovalGateRecord[] | Promise<StageApprovalGateRecord[]>;

  freezeBaselineSpec(
    input: FreezeBaselineSpecInput
  ): BaselineSpecFreezeRecord | Promise<BaselineSpecFreezeRecord>;
  getBaselineSpecFreeze(
    pipelineSessionId: string
  ): BaselineSpecFreezeRecord | null | Promise<BaselineSpecFreezeRecord | null>;
  getProductPipelineBundle(
    pipelineSessionId: string
  ): ProductPipelineBundle | null | Promise<ProductPipelineBundle | null>;

  // Milestone M6B: Stages 5-9 Lifecycle, Multi-Target Profiles, CR & Release Acceptance
  updateProjectMainRefCommitHash(input: {
    readonly project_id: string;
    readonly main_ref_commit_hash: string;
  }): ProjectRecord | Promise<ProjectRecord>;

  createProjectBootstrap(
    input: CreateProjectBootstrapInput
  ): ProjectBootstrapRecord | Promise<ProjectBootstrapRecord>;
  getProjectBootstrapBySession(
    pipelineSessionId: string
  ): ProjectBootstrapRecord | null | Promise<ProjectBootstrapRecord | null>;
  getProjectBootstrapById(
    bootstrapId: string
  ): ProjectBootstrapRecord | null | Promise<ProjectBootstrapRecord | null>;

  upsertAgentOrganizationProfile(
    input: UpsertAgentOrganizationProfileInput
  ): AgentOrganizationProfileRecord | Promise<AgentOrganizationProfileRecord>;
  listAgentOrganizationProfiles(
    projectId: string,
    filter?: { readonly role?: AgentOrgRole; readonly active_only?: boolean }
  ): AgentOrganizationProfileRecord[] | Promise<AgentOrganizationProfileRecord[]>;
  getAgentOrganizationProfileById(
    profileId: string
  ): AgentOrganizationProfileRecord | null | Promise<AgentOrganizationProfileRecord | null>;

  createStage7DevelopmentPlan(
    input: CreateStage7DevelopmentPlanInput
  ): Stage7DevelopmentPlanBundle | Promise<Stage7DevelopmentPlanBundle>;
  listDevMilestones(
    pipelineSessionId: string
  ): DevMilestoneRecord[] | Promise<DevMilestoneRecord[]>;
  listDevEpics(
    pipelineSessionId: string
  ): DevEpicRecord[] | Promise<DevEpicRecord[]>;
  listDevUserStories(
    pipelineSessionId: string
  ): DevUserStoryRecord[] | Promise<DevUserStoryRecord[]>;
  listTaskPlanLinks(
    pipelineSessionId: string
  ): TaskPlanLinkRecord[] | Promise<TaskPlanLinkRecord[]>;

  createChangeRequest(
    input: CreateChangeRequestStoreInput
  ): ChangeRequestRecord | Promise<ChangeRequestRecord>;
  getChangeRequestById(
    crId: string
  ): ChangeRequestRecord | null | Promise<ChangeRequestRecord | null>;
  listChangeRequests(
    pipelineSessionId: string
  ): ChangeRequestRecord[] | Promise<ChangeRequestRecord[]>;
  decideChangeRequest(
    input: DecideChangeRequestStoreInput
  ): ChangeRequestRecord | Promise<ChangeRequestRecord>;
  applyChangeRequestAndMaterializeTasks(input: ApplyChangeRequestStoreInput):
    | {
        readonly changeRequest: ChangeRequestRecord;
        readonly tasks: readonly TaskRecord[];
        readonly taskLinks: readonly TaskPlanLinkRecord[];
      }
    | Promise<{
        readonly changeRequest: ChangeRequestRecord;
        readonly tasks: readonly TaskRecord[];
        readonly taskLinks: readonly TaskPlanLinkRecord[];
      }>;

  recordReleaseAcceptancePackage(
    input: RecordReleaseAcceptancePackageInput
  ): ReleaseAcceptancePackageRecord | Promise<ReleaseAcceptancePackageRecord>;
  listReleaseAcceptancePackages(
    pipelineSessionId: string
  ): ReleaseAcceptancePackageRecord[] | Promise<ReleaseAcceptancePackageRecord[]>;
}
