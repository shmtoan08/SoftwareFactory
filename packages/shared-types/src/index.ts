import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Canonical Task Statuses (MVP-SPEC-01 Section 4 & MVP-SPEC-02 Section 2)
 */
export type TaskStatus =
  | "Ready"
  | "Leased"
  | "ExecutingInTarget"
  | "BuildingMergeCandidate"
  | "VerifyingInDocker"
  | "UnderIndependentReview"
  | "AwaitingHumanApproval"
  | "AtomicCasMerge"
  | "MergedAndCompleted"
  | "ReworkRequired"
  | "ManualIntervention";

/**
 * Canonical Lease Statuses (MVP-SPEC-02 Section 2)
 */
export type LeaseStatus = "ACTIVE" | "COMPLETED" | "EXPIRED" | "REVOKED";

/**
 * Canonical Worker Event Types (MVP-SPEC-03 Section 1.1)
 */
export type WorkerEventType =
  | "task.accepted"
  | "task.started"
  | "task.progress"
  | "task.heartbeat"
  | "task.completed"
  | "task.failed";

/**
 * Terminal Worker Event Types that close the active lease upon acceptance
 */
export const TERMINAL_WORKER_EVENT_TYPES: ReadonlySet<WorkerEventType> = new Set([
  "task.completed",
  "task.failed",
]);

/**
 * Deterministic Task State Transition Matrix (MVP-SPEC-01 Section 4)
 */
export const STATE_TRANSITION_MATRIX: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  Ready: ["Leased", "ManualIntervention"],
  Leased: ["Leased", "ExecutingInTarget", "Ready", "ReworkRequired", "ManualIntervention"],
  ExecutingInTarget: [
    "ExecutingInTarget",
    "BuildingMergeCandidate",
    "Ready",
    "ReworkRequired",
    "ManualIntervention",
  ],
  BuildingMergeCandidate: ["VerifyingInDocker", "ReworkRequired", "ManualIntervention"],
  VerifyingInDocker: ["UnderIndependentReview", "ReworkRequired", "ManualIntervention"],
  UnderIndependentReview: ["AwaitingHumanApproval", "ReworkRequired", "ManualIntervention"],
  AwaitingHumanApproval: [
    "AtomicCasMerge",
    "ReworkRequired",
    "ManualIntervention",
    "BuildingMergeCandidate",
  ],
  AtomicCasMerge: [
    "MergedAndCompleted",
    "BuildingMergeCandidate",
    "AwaitingHumanApproval",
    "ManualIntervention",
  ],
  MergedAndCompleted: [],
  ReworkRequired: ["Leased", "Ready", "ManualIntervention"],
  ManualIntervention: ["Ready", "ReworkRequired"],
};

/**
 * Maps each WorkerEventType to its allowed source task statuses and resulting target task status
 * (MVP-SPEC-01 Section 4 & MVP-SPEC-03 Section 1.1)
 */
export const WORKER_EVENT_STATE_TRANSITIONS: Readonly<
  Record<
    WorkerEventType,
    {
      readonly allowedFrom: readonly TaskStatus[];
      readonly targetStatus: TaskStatus | "UNCHANGED";
      readonly closesLeaseAs?: "COMPLETED" | "REVOKED";
    }
  >
> = {
  "task.accepted": {
    allowedFrom: ["Leased"],
    targetStatus: "Leased",
  },
  "task.started": {
    allowedFrom: ["Leased", "ExecutingInTarget"],
    targetStatus: "ExecutingInTarget",
  },
  "task.progress": {
    allowedFrom: ["ExecutingInTarget"],
    targetStatus: "ExecutingInTarget",
  },
  "task.heartbeat": {
    allowedFrom: ["Leased", "ExecutingInTarget"],
    targetStatus: "UNCHANGED",
  },
  "task.completed": {
    allowedFrom: ["ExecutingInTarget"],
    targetStatus: "BuildingMergeCandidate",
    closesLeaseAs: "COMPLETED",
  },
  "task.failed": {
    allowedFrom: ["Leased", "ExecutingInTarget"],
    targetStatus: "ReworkRequired",
    closesLeaseAs: "REVOKED",
  },
};

export function isValidTaskStateTransition(from: TaskStatus, to: TaskStatus): boolean {
  return STATE_TRANSITION_MATRIX[from].includes(to);
}

/**
 * Worker Event Envelope (MVP-SPEC-03 Section 1.1)
 */
export interface WorkerEventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  readonly schema_version: "1.5";
  readonly project_id: string;
  readonly task_id: string;
  readonly attempt_no: number;
  readonly lease_id: string;
  readonly lease_epoch: number;
  readonly worker_id: string;
  readonly sequence_no: number;
  readonly event_type: WorkerEventType;
  readonly task_execution_idempotency_key: string;
  readonly event_idempotency_key: string;
  readonly payload_sha256: string;
  readonly emitted_at: string;
  readonly payload: TPayload;
}

/**
 * Server Event ACK / Reject Contract (MVP-SPEC-03 Section 1.2)
 */
export type ServerEventAckStatus =
  | "ACCEPTED"
  | "DUPLICATE_RETRY_NOP"
  | "REJECTED_STALE_LEASE"
  | "REJECTED_OUT_OF_ORDER"
  | "REJECTED_CONFLICT_PAYLOAD"
  | "REJECTED_INVALID_TRANSITION";

export type ServerEventErrorCode =
  | "ERR_STALE_LEASE"
  | "ERR_SEQ_GAP"
  | "ERR_SEQ_ALREADY_ADVANCED"
  | "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "ERR_INVALID_STATE_TRANSITION";

export interface ServerEventAckContract {
  readonly http_status: 200 | 409 | 422;
  readonly ack_status: ServerEventAckStatus;
  readonly lease_id: string;
  readonly lease_epoch: number;
  readonly lease_status: LeaseStatus;
  readonly acked_sequence_no: number;
  readonly expected_next_seq: number;
  readonly task_status: TaskStatus;
  readonly lease_expires_at: string | null;
  readonly server_clock_timestamp: string;
  readonly error_code?: ServerEventErrorCode;
}

/**
 * Reconnect Sync Response Contract (MVP-SPEC-03 Section 2.2)
 */
export interface LeaseSyncStatusResponse {
  readonly lease_id: string;
  readonly lease_epoch: number;
  readonly lease_status: LeaseStatus;
  readonly last_processed_seq: number;
  readonly expected_next_seq: number;
  readonly lease_expires_at: string | null;
  readonly server_clock_timestamp: string;
}

/**
 * Database Entity Interfaces (MVP-SPEC-02 Section 2)
 */
export interface TaskRecord {
  task_id: string;
  project_id: string;
  title: string;
  task_contract_json: Record<string, unknown>;
  status: TaskStatus;
  base_main_commit_hash: string;
  current_attempt_no: number;
  rework_count: number;
  max_rework_cycles: number;
  active_lease_id: string | null;
  active_lease_epoch: number;
  active_merge_candidate_id: string | null;
  merged_commit_hash: string | null;
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskLeaseRecord {
  lease_id: string;
  project_id: string;
  task_id: string;
  attempt_no: number;
  lease_epoch: number;
  worker_id: string;
  status: LeaseStatus;
  task_execution_idempotency_key: string;
  last_processed_seq: number;
  heartbeat_interval_ms: number;
  lease_ttl_ms: number;
  leased_at: string;
  last_heartbeat_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  completed_at: string | null;
}

export interface ProcessedWorkerEventRecord {
  event_id: string;
  project_id: string;
  task_id: string;
  lease_id: string;
  lease_epoch: number;
  sequence_no: number;
  event_type: WorkerEventType;
  event_idempotency_key: string;
  payload_sha256: string;
  payload_json: Record<string, unknown>;
  processed_at: string;
}

export interface VerifiedCodeImportRecord {
  import_id: string;
  project_id: string;
  task_id: string;
  lease_id: string;
  lease_epoch: number;
  agent_commit_hash: string;
  verified_tree_hash: string;
  staging_ref: string;
  changed_files_count: number;
  deleted_lines_count: number;
  recovered_by_reconciler?: boolean;
  created_at: string;
}

export type SnapshotRetentionClass = "EPHEMERAL_14D" | "MERGED_PERMANENT";

export type VerificationOverallStatus =
  | "PASSED"
  | "FAILED_ACCEPTANCE"
  | "TEST_TAMPERING_DETECTED"
  | "TEST_TIMEOUT"
  | "INFRA_ERROR";

export type VerificationExecutionBackend =
  | "docker"
  | "linux-supervisor"
  | "host-subprocess";

export interface Tier3AssertionEvidence {
  readonly filePath: string;
  readonly skippedPatterns: readonly string[];
  readonly assertionSnippets: readonly string[];
  readonly trivialPatterns: readonly string[];
  readonly hasRealAssertions: boolean;
}

export interface MergeCandidateRecord {
  merge_candidate_id: string;
  project_id: string;
  task_id: string;
  import_id: string;
  agent_commit_hash: string;
  base_main_commit_hash: string;
  merge_candidate_hash: string;
  verified_tree_hash: string;
  is_superseded: boolean;
  snapshot_path?: string | null;
  snapshot_sha256?: string | null;
  snapshot_size_bytes?: number | null;
  snapshot_retention_class?: SnapshotRetentionClass;
  created_at: string;
}

export interface VerificationRunRecord {
  verification_run_id: string;
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
  isolation_runtime?: "runsc" | null;
  trusted_policy_sha256?: string | null;
  exit_code: number;
  duration_ms: number;
  report_sha256: string;
  created_at: string;
}

export type ReviewArtifactStatus =
  | "VALID"
  | "INVALIDATED_STALE_CANDIDATE"
  | "INVALIDATED_STALE_BASE";

export type ReviewSessionStatus = "ACTIVE" | "COMPLETED" | "FAILED" | "REVOKED";

export interface ReviewSessionRecord {
  review_session_id: string;
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
  sandbox_pid: number | null;
  sandbox_cgroup_path: string | null;
  cleanup_populated_zero_verified: boolean;
  status: ReviewSessionStatus;
  started_at: string;
  completed_at: string | null;
}

export interface ReviewArtifactRecord {
  review_artifact_id: string;
  project_id: string;
  task_id: string;
  merge_candidate_id: string;
  verification_run_id: string;
  merge_candidate_hash: string;
  verified_tree_hash: string;
  developer_principal_id: string;
  reviewer_principal_id: string;
  developer_session_id: string;
  reviewer_session_id: string;
  developer_credential_id?: string | null;
  reviewer_credential_id?: string | null;
  developer_agent_profile_id?: string | null;
  reviewer_agent_profile_id?: string | null;
  review_session_id?: string | null;
  writer_provider: string;
  writer_model: string;
  reviewer_provider: string;
  reviewer_model: string;
  verdict: "PASS" | "FAIL";
  status?: ReviewArtifactStatus;
  is_invalidated: boolean;
  invalidated_reason: string | null;
  summary_markdown?: string | null;
  report_sha256?: string | null;
  findings_json: ReadonlyArray<Record<string, unknown>>;
  created_at: string;
}

export type ApprovalRequestStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "INVALIDATED_EXPIRED"
  | "INVALIDATED_STALE_BASE"
  | "INVALIDATED_STALE_CANDIDATE";

export interface ApprovalRequestRecord {
  approval_request_id: string;
  project_id: string;
  task_id: string;
  merge_candidate_id: string;
  agent_commit_hash: string;
  base_main_commit_hash: string;
  merge_candidate_hash: string;
  verified_tree_hash: string;
  verification_run_id: string;
  review_artifact_id: string;
  status: ApprovalRequestStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * 8-Field Cryptographically Bound Human Approval Record (MVP-SPEC-02 Section 2 & MVP-SPEC-04 Section 4)
 */
export interface ApprovalDecisionRecord {
  approval_id: string;
  project_id: string;
  task_id: string;
  merge_candidate_id: string;
  approval_request_id?: string | null;
  agent_commit_hash: string;
  base_main_commit_hash: string;
  verified_tree_hash: string;
  merge_candidate_hash: string;
  verification_run_id: string;
  review_artifact_id: string;
  approver_principal_id: string;
  decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
  status: "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED";
  invalidated_reason: string | null;
  approved_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export type MergeOperationStatus = "IN_PROGRESS" | "MERGED" | "CAS_CONFLICT_ABORTED";

export interface MergeOperationRecord {
  merge_op_id: string;
  project_id: string;
  task_id: string;
  merge_candidate_id: string;
  approval_id: string;
  merge_idempotency_key: string;
  base_main_commit_hash: string;
  merge_candidate_hash: string;
  verified_tree_hash: string;
  status: MergeOperationStatus;
  reconciled_after_lost_response: boolean;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface OutboxEventRecord {
  outbox_id: string;
  project_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: Record<string, unknown>;
  published_at: string | null;
  created_at: string;
}

/**
 * Milestone M5: Baseline Execution Resource Usage Metrics (`AC-12a` & `M5-AC6`)
 */
export type ResourceUsagePhase = "DEVELOPER" | "VERIFIER" | "REVIEWER";

export type ResourceUsageMetricsSource =
  | "cgroup-v2"
  | "process-rusage"
  | "wall-clock-only";

export interface ResourceUsageMetricRecord {
  metric_id: string;
  project_id: string;
  task_id: string;
  lease_id: string | null;
  lease_epoch: number;
  attempt_no: number;
  rework_cycle: number;
  phase: ResourceUsagePhase;
  wall_time_ms: number;
  cpu_usage_usec: number;
  peak_memory_bytes: number;
  sandbox_backend_mode: string;
  metrics_source: ResourceUsageMetricsSource;
  recorded_at: string;
}

/**
 * Milestone M5: Complete End-to-End Task Lineage (`AC-11a` & `M5-AC8`)
 */
export interface CandidateBoundLineage {
  readonly codeImportSubmission?: CodeImportSubmissionRecord | null;
  readonly projectId: string;
  readonly taskId: string;
  readonly mainHeadCommitHash: string | null;
  readonly gitLogHeadMatchesCandidate: boolean;
  readonly task: TaskRecord;
  readonly taskContract: Record<string, unknown>;
  readonly taskLeases: readonly TaskLeaseRecord[];
  readonly processedEvents: readonly ProcessedWorkerEventRecord[];
  readonly processedEventsCount: number;
  readonly resourceUsageMetrics: readonly ResourceUsageMetricRecord[];
  readonly verifiedImport: VerifiedCodeImportRecord | null;
  readonly allMergeCandidates: readonly MergeCandidateRecord[];
  readonly mergeCandidate: MergeCandidateRecord | null;
  readonly verificationRun: VerificationRunRecord | null;
  readonly reviewSession: ReviewSessionRecord | null;
  readonly reviewArtifact: ReviewArtifactRecord | null;
  readonly approvalRequest: ApprovalRequestRecord | null;
  readonly approvalDecisions: readonly ApprovalDecisionRecord[];
  readonly activeOrConsumedApproval: ApprovalDecisionRecord | null;
  readonly mergeOperations: readonly MergeOperationRecord[];
  readonly hashBindingVerified: boolean;
  readonly lineageComplete: boolean;
  readonly missingLinks: readonly string[];
}

export type M5CriterionId =
  | "M5-AC1"
  | "M5-AC2"
  | "M5-AC3"
  | "M5-AC4"
  | "M5-AC5"
  | "M5-AC6"
  | "M5-AC7"
  | "M5-AC8";

export interface M5AcceptanceCriterionReport {
  readonly criterionId: M5CriterionId;
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface M5FaultRecoveryScenarioReport {
  readonly scenarioId: "M5-AC7a" | "M5-AC7b" | "M5-AC7c" | "M5-AC7d";
  readonly title: string;
  readonly passed: boolean;
  readonly details: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface M5EnvironmentCapabilities {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly dockerAvailable: boolean;
  readonly cgroupV2Available: boolean;
  readonly linuxNamespacesAvailable: boolean;
  readonly postgresLiveTested: boolean;
}

export interface M5EvidenceBundle {
  readonly schemaVersion: "1.5";
  readonly milestone: "M5";
  readonly generatedAt: string;
  readonly environmentCapabilities: M5EnvironmentCapabilities;
  readonly verticalSliceSummary: {
    readonly projectId: string;
    readonly taskId: string;
    readonly taskStatus: TaskStatus;
    readonly mainHeadCommitHash: string | null;
    readonly mergeCandidateHash: string | null;
    readonly verifiedTreeHash: string | null;
    readonly agentCommitHash: string | null;
    readonly reworkCount: number;
    readonly leaseEpochsObserved: number;
  };
  readonly criteria: readonly M5AcceptanceCriterionReport[];
  readonly faultRecoveryReports: readonly M5FaultRecoveryScenarioReport[];
  readonly lineage: CandidateBoundLineage;
  readonly resourceUsageMetrics: readonly ResourceUsageMetricRecord[];
  readonly bundleSha256: string;
}

/**
 * Deterministic Canonical Serialization for Cryptographic Hashing (FIX-25).
 * Preserves distinct canonical tokens for `undefined`, `NaN`, `+/-Infinity`, and `bigint`
 * in both standalone values and array slots so `[undefined]` and `[null]` never collide.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return "NaN";
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? "Infinity" : "-Infinity";
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      items.push(canonicalizeJson(value[i]));
    }
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries = sortedKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function computeCanonicalPayloadSha256(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalizeJson(payload));
}

export function computeTaskExecutionIdempotencyKey(
  projectId: string,
  taskId: string,
  attemptNo: number
): string {
  return sha256Hex(`${projectId}:${taskId}:${attemptNo}`);
}

export function computeEventIdempotencyKey(
  leaseId: string,
  leaseEpoch: number,
  sequenceNo: number,
  eventType: WorkerEventType
): string {
  return sha256Hex(`${leaseId}:${leaseEpoch}:${sequenceNo}:${eventType}`);
}

export function isUuidString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Milestone M6A: Model Provider Adapter v2, Prompt Versioning, Cost Guard (`AC-12b`)
 * & Stages 1–4 Product Pipeline Domain Types (`M6A-SPEC-01`)
 */
export type ModelProviderName = "anthropic" | "openai" | "google";

export type StructuredJsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface StructuredJsonSchema {
  readonly type: StructuredJsonSchemaType;
  readonly properties?: Readonly<Record<string, StructuredJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: StructuredJsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly unknown[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export interface PromptTemplateSpec {
  readonly promptId: string;
  readonly version: string;
  readonly description: string;
  readonly systemTemplate: string;
  readonly userTemplate: string;
  readonly outputSchema?: StructuredJsonSchema;
  readonly requiredVariables?: readonly string[];
}

export interface RenderedPrompt {
  readonly promptId: string;
  readonly version: string;
  readonly promptSha256: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly outputSchema?: StructuredJsonSchema;
}

export interface ModelUsageMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly usageEstimated?: boolean;
  readonly rawProviderUsage?: Readonly<Record<string, unknown>>;
}

export interface ModelPricingRate {
  readonly inputMicroUsdPerMillionTokens: number;
  readonly outputMicroUsdPerMillionTokens: number;
}

export type CostSessionStatus = "ACTIVE" | "EXHAUSTED" | "CLOSED";

export interface CostSessionRecord {
  readonly cost_session_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string | null;
  readonly task_id: string | null;
  readonly max_tokens_per_request: number;
  readonly max_cost_micro_usd_per_request: number;
  readonly session_token_budget: number;
  readonly session_cost_budget_micro_usd: number;
  readonly tokens_used_total: number;
  readonly cost_used_micro_usd: number;
  readonly status: CostSessionStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export type ModelCallStatus =
  | "ALLOWED"
  | "BLOCKED_PREFLIGHT"
  | "BLOCKED_POSTCALL"
  | "FAILED_VALIDATION"
  | "FAILED_PROVIDER";

export interface ModelCallLedgerRecord {
  readonly call_id: string;
  readonly project_id: string;
  readonly cost_session_id: string;
  readonly pipeline_session_id: string | null;
  readonly task_id: string | null;
  readonly stage: string;
  readonly provider: ModelProviderName;
  readonly model: string;
  readonly prompt_id: string;
  readonly prompt_version: string;
  readonly prompt_sha256: string;
  readonly request_sha256: string;
  readonly estimated_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly actual_input_tokens: number;
  readonly actual_output_tokens: number;
  readonly actual_total_tokens: number;
  readonly estimated_cost_micro_usd: number;
  readonly actual_cost_micro_usd: number;
  readonly status: ModelCallStatus;
  readonly usage_estimated: boolean;
  readonly block_reason: string | null;
  readonly error_message: string | null;
  readonly latency_ms: number;
  readonly created_at: string;
}

export type CostLimitScope =
  | "PER_REQUEST_TOKENS"
  | "PER_REQUEST_COST"
  | "SESSION_TOKEN_BUDGET"
  | "SESSION_COST_BUDGET"
  | "SESSION_EXHAUSTED";

export interface CostPreflightCheckInput {
  readonly project_id: string;
  readonly cost_session_id: string;
  readonly pipeline_session_id?: string | null;
  readonly task_id?: string | null;
  readonly stage: string;
  readonly provider: ModelProviderName;
  readonly model: string;
  readonly prompt_id: string;
  readonly prompt_version: string;
  readonly prompt_sha256: string;
  readonly request_sha256: string;
  readonly estimated_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly estimated_cost_micro_usd: number;
}

export type CostPreflightCheckResult =
  | {
      readonly allowed: true;
      readonly session: CostSessionRecord;
    }
  | {
      readonly allowed: false;
      readonly limitScope: CostLimitScope;
      readonly reason: string;
      readonly session: CostSessionRecord;
      readonly blockedLedger: ModelCallLedgerRecord;
    };

export interface FinalizeModelCallInput {
  readonly project_id: string;
  readonly cost_session_id: string;
  readonly pipeline_session_id?: string | null;
  readonly task_id?: string | null;
  readonly stage: string;
  readonly provider: ModelProviderName;
  readonly model: string;
  readonly prompt_id: string;
  readonly prompt_version: string;
  readonly prompt_sha256: string;
  readonly request_sha256: string;
  readonly estimated_input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly actual_input_tokens: number;
  readonly actual_output_tokens: number;
  readonly estimated_cost_micro_usd: number;
  readonly actual_cost_micro_usd: number;
  readonly usage_estimated?: boolean;
  readonly outcome: "ALLOWED" | "FAILED_VALIDATION" | "FAILED_PROVIDER";
  readonly error_message?: string | null;
  readonly latency_ms: number;
}

export interface FinalizeModelCallResult {
  readonly allowed: boolean;
  readonly limitScope?: CostLimitScope;
  readonly reason?: string;
  readonly session: CostSessionRecord;
  readonly ledger: ModelCallLedgerRecord;
}

export function evaluatePreflightLimits(
  session: CostSessionRecord,
  input: Pick<
    CostPreflightCheckInput,
    "estimated_input_tokens" | "reserved_output_tokens" | "estimated_cost_micro_usd"
  >
): { readonly limitScope: CostLimitScope; readonly reason: string } | null {
  if (session.status !== "ACTIVE") {
    return {
      limitScope: "SESSION_EXHAUSTED",
      reason: `Cost session ${session.cost_session_id} is ${session.status}`,
    };
  }
  const projectedTokens = input.estimated_input_tokens + input.reserved_output_tokens;
  if (projectedTokens > session.max_tokens_per_request) {
    return {
      limitScope: "PER_REQUEST_TOKENS",
      reason: `Projected request tokens (${projectedTokens}) exceeds max_tokens_per_request (${session.max_tokens_per_request})`,
    };
  }
  if (input.estimated_cost_micro_usd > session.max_cost_micro_usd_per_request) {
    return {
      limitScope: "PER_REQUEST_COST",
      reason: `Projected request cost (${input.estimated_cost_micro_usd} micro-USD) exceeds max_cost_micro_usd_per_request (${session.max_cost_micro_usd_per_request} micro-USD)`,
    };
  }
  if (session.tokens_used_total + projectedTokens > session.session_token_budget) {
    return {
      limitScope: "SESSION_TOKEN_BUDGET",
      reason: `Session tokens used (${session.tokens_used_total}) + projected (${projectedTokens}) exceeds session_token_budget (${session.session_token_budget})`,
    };
  }
  if (
    session.cost_used_micro_usd + input.estimated_cost_micro_usd >
    session.session_cost_budget_micro_usd
  ) {
    return {
      limitScope: "SESSION_COST_BUDGET",
      reason: `Session cost used (${session.cost_used_micro_usd} micro-USD) + projected (${input.estimated_cost_micro_usd} micro-USD) exceeds session_cost_budget_micro_usd (${session.session_cost_budget_micro_usd} micro-USD)`,
    };
  }
  return null;
}

export function evaluatePostcallLimits(
  session: CostSessionRecord,
  actualTotalTokens: number,
  actualCostMicroUsd: number
): {
  readonly nextTokensUsedTotal: number;
  readonly nextCostUsedMicroUsd: number;
  readonly nextStatus: CostSessionStatus;
  readonly exceeded: { readonly limitScope: CostLimitScope; readonly reason: string } | null;
} {
  if (session.status !== "ACTIVE") {
    return {
      nextTokensUsedTotal: session.tokens_used_total,
      nextCostUsedMicroUsd: session.cost_used_micro_usd,
      nextStatus: session.status,
      exceeded: {
        limitScope: "SESSION_EXHAUSTED",
        reason: `Cost session ${session.cost_session_id} is ${session.status} and cannot finalize additional model calls`,
      },
    };
  }

  const nextTokensUsedTotal = session.tokens_used_total + actualTotalTokens;
  const nextCostUsedMicroUsd = session.cost_used_micro_usd + actualCostMicroUsd;

  if (actualTotalTokens > session.max_tokens_per_request) {
    return {
      nextTokensUsedTotal,
      nextCostUsedMicroUsd,
      nextStatus: "EXHAUSTED",
      exceeded: {
        limitScope: "PER_REQUEST_TOKENS",
        reason: `Actual request tokens (${actualTotalTokens}) exceeded max_tokens_per_request (${session.max_tokens_per_request})`,
      },
    };
  }
  if (actualCostMicroUsd > session.max_cost_micro_usd_per_request) {
    return {
      nextTokensUsedTotal,
      nextCostUsedMicroUsd,
      nextStatus: "EXHAUSTED",
      exceeded: {
        limitScope: "PER_REQUEST_COST",
        reason: `Actual request cost (${actualCostMicroUsd} micro-USD) exceeded max_cost_micro_usd_per_request (${session.max_cost_micro_usd_per_request} micro-USD)`,
      },
    };
  }
  if (nextTokensUsedTotal > session.session_token_budget) {
    return {
      nextTokensUsedTotal,
      nextCostUsedMicroUsd,
      nextStatus: "EXHAUSTED",
      exceeded: {
        limitScope: "SESSION_TOKEN_BUDGET",
        reason: `Cumulative session tokens (${nextTokensUsedTotal}) exceeded session_token_budget (${session.session_token_budget})`,
      },
    };
  }
  if (nextCostUsedMicroUsd > session.session_cost_budget_micro_usd) {
    return {
      nextTokensUsedTotal,
      nextCostUsedMicroUsd,
      nextStatus: "EXHAUSTED",
      exceeded: {
        limitScope: "SESSION_COST_BUDGET",
        reason: `Cumulative session cost (${nextCostUsedMicroUsd} micro-USD) exceeded session_cost_budget_micro_usd (${session.session_cost_budget_micro_usd} micro-USD)`,
      },
    };
  }

  return {
    nextTokensUsedTotal,
    nextCostUsedMicroUsd,
    nextStatus: session.status,
    exceeded: null,
  };
}


export type PipelineStageName =
  | "STAGE_1_IDEA_DISCOVERY"
  | "STAGE_2_REQUIREMENTS"
  | "STAGE_3_ARCHITECTURE"
  | "STAGE_4_SPEC_FREEZE";

export type PipelineSessionStatus = "ACTIVE" | "FROZEN" | "CANCELLED";

export interface ProductPipelineSessionRecord {
  readonly pipeline_session_id: string;
  readonly project_id: string;
  readonly cost_session_id: string | null;
  readonly title: string;
  readonly raw_idea_text: string;
  readonly current_stage: PipelineStageName;
  readonly status: PipelineSessionStatus;
  readonly frozen_baseline_id: string | null;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export type Stage1ItemKind = "FACT" | "ASSUMPTION" | "RECOMMENDATION";

export type Stage1ConfirmationStatus =
  | "AUTO_VERIFIED"
  | "UNCONFIRMED"
  | "CONFIRMED"
  | "REJECTED";

export interface Stage1DiscoveryItemRecord {
  readonly item_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly kind: Stage1ItemKind;
  readonly title: string;
  readonly statement: string;
  readonly rationale: string;
  readonly clarification_question: string | null;
  readonly confirmation_status: Stage1ConfirmationStatus;
  readonly confirmed_by_principal_id: string | null;
  readonly confirmed_at: string | null;
  readonly resolution_note: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Stage1DiscoveryBundle {
  readonly summary: string;
  readonly facts: ReadonlyArray<{
    readonly title: string;
    readonly statement: string;
    readonly rationale: string;
  }>;
  readonly assumptions: ReadonlyArray<{
    readonly title: string;
    readonly statement: string;
    readonly rationale: string;
    readonly clarification_question: string;
  }>;
  readonly recommendations: ReadonlyArray<{
    readonly title: string;
    readonly statement: string;
    readonly rationale: string;
    readonly clarification_question: string;
  }>;
}

export interface Stage2AcceptanceCriterion {
  readonly ac_id: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
}

export interface Stage2RequirementItem {
  readonly req_id: string;
  readonly title: string;
  readonly description: string;
  readonly priority: "MUST" | "SHOULD" | "COULD";
  readonly source_discovery_item_ids: readonly string[];
  readonly acceptance_criteria: readonly Stage2AcceptanceCriterion[];
}

export interface Stage2RequirementsSpec {
  readonly prd: {
    readonly product_vision: string;
    readonly target_personas: readonly string[];
    readonly goals: readonly string[];
    readonly non_goals: readonly string[];
  };
  readonly srs: {
    readonly functional_requirements: readonly Stage2RequirementItem[];
    readonly non_functional_requirements: readonly Stage2RequirementItem[];
  };
}

export interface Stage3ArchitectureSpec {
  readonly architecture: {
    readonly overview: string;
    readonly components: ReadonlyArray<{
      readonly component_id: string;
      readonly name: string;
      readonly responsibility: string;
      readonly requirement_ids: readonly string[];
    }>;
  };
  readonly database_erd: {
    readonly entities: ReadonlyArray<{
      readonly entity_name: string;
      readonly primary_key: string;
      readonly columns: readonly string[];
      readonly foreign_keys: readonly string[];
      readonly rls_tier: "TIER_1" | "TIER_2" | "TIER_3" | "TIER_4";
      readonly requirement_ids: readonly string[];
    }>;
  };
  readonly api_spec: {
    readonly endpoints: ReadonlyArray<{
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly summary: string;
      readonly auth_role: string;
      readonly requirement_ids: readonly string[];
    }>;
  };
  readonly security_design: {
    readonly threat_controls: ReadonlyArray<{
      readonly threat_id: string;
      readonly threat: string;
      readonly mitigation: string;
      readonly requirement_ids: readonly string[];
    }>;
  };
  readonly adrs: ReadonlyArray<{
    readonly adr_id: string;
    readonly title: string;
    readonly status: "PROPOSED" | "ACCEPTED";
    readonly context: string;
    readonly decision: string;
    readonly consequences: string;
    readonly requirement_ids: readonly string[];
  }>;
}

export interface Stage4ConsistencyCheckResult {
  readonly check_id: string;
  readonly name: string;
  readonly passed: boolean;
  readonly severity: "ERROR" | "WARNING";
  readonly details: string;
  readonly affected_ids: readonly string[];
}

export interface Stage4ConsistencyReport {
  readonly pipeline_session_id: string;
  readonly passed: boolean;
  readonly checks: readonly Stage4ConsistencyCheckResult[];
  readonly blocking_errors: readonly string[];
  readonly referenced_stage1_artifact_id: string;
  readonly referenced_stage2_artifact_id: string;
  readonly referenced_stage3_artifact_id: string;
  readonly checked_at: string;
}

export type StageArtifactKind =
  | "STAGE_1_DISCOVERY_BUNDLE"
  | "STAGE_2_PRD_SRS"
  | "STAGE_3_ARCHITECTURE_DESIGN"
  | "STAGE_4_VALIDATION_REPORT";

export interface StageArtifactRecord {
  readonly artifact_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly stage: PipelineStageName;
  readonly artifact_kind: StageArtifactKind;
  readonly version: number;
  readonly provider: ModelProviderName | "system";
  readonly model: string;
  readonly prompt_id: string;
  readonly prompt_version: string;
  readonly prompt_sha256: string;
  readonly content_json: Readonly<Record<string, unknown>>;
  readonly artifact_sha256: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

export type StageApprovalGateStage =
  | "STAGE_1_DISCOVERY"
  | "STAGE_2_REQUIREMENTS"
  | "STAGE_3_ARCHITECTURE"
  | "STAGE_4_SPEC_FREEZE";

export interface StageApprovalGateRecord {
  readonly gate_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly gate_stage: StageApprovalGateStage;
  readonly target_artifact_id: string;
  readonly target_artifact_sha256: string;
  readonly approver_principal_id: string;
  readonly decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
  readonly rationale: string | null;
  readonly decided_at: string;
}

export interface BaselineSpecFreezeRecord {
  readonly baseline_id: string;
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
  readonly freeze_bundle_sha256: string;
  readonly status: "FROZEN";
  readonly frozen_at: string;
}

export interface ProductPipelineBundle {
  readonly session: ProductPipelineSessionRecord;
  readonly costSession: CostSessionRecord | null;
  readonly modelCallLedgers: readonly ModelCallLedgerRecord[];
  readonly discoveryItems: readonly Stage1DiscoveryItemRecord[];
  readonly artifacts: readonly StageArtifactRecord[];
  readonly approvalGates: readonly StageApprovalGateRecord[];
  readonly baselineFreeze: BaselineSpecFreezeRecord | null;
}

function collectDirectoryFilesRecursively(rootDir: string, relPrefix = ""): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const out: string[] = [];
  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const absPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        continue;
      }
      out.push(...collectDirectoryFilesRecursively(absPath, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Deterministic SHA-256 across an entire directory tree (sorted relative POSIX paths + bytes).
 * Shared by Stage 5 Project Bootstrapper and Stage 8 Docker3TierVerifier (`M6B-SPEC-01`).
 */
export function computeDirectorySha256(dirPath: string): string {
  const absDir = resolve(dirPath);
  const relFiles = collectDirectoryFilesRecursively(absDir).sort();
  const hash = createHash("sha256");

  for (const relPath of relFiles) {
    const absFile = join(absDir, ...relPath.split("/"));
    const st = lstatSync(absFile);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(absFile);
      hash.update(`L\0${relPath}\0${target}\0`);
    } else if (st.isFile()) {
      const bytes = readFileSync(absFile);
      hash.update(`F\0${relPath}\0${bytes.byteLength}\0`);
      hash.update(bytes);
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}

// =============================================================================
// Milestone M6B: Stages 5-9 Software Development Lifecycle & AC-11b Traceability
// =============================================================================

export type ExecutionTargetType =
  | "factory_managed_worker"
  | "user_managed_worker"
  | "provider_managed_vm"
  | "remote_agent_session";

export type TargetTrustTier =
  | "TIER_1_FACTORY_MANAGED"
  | "TIER_2_USER_MANAGED"
  | "TIER_3_PROVIDER_VM"
  | "TIER_4_REMOTE_SESSION";

export type AgentOrgRole =
  | "PLANNER"
  | "DEVELOPER"
  | "REVIEWER_READONLY"
  | "VERIFIER";

export interface AgentOrganizationProfileRecord {
  readonly profile_id: string;
  readonly project_id: string;
  readonly profile_key: string;
  readonly role: AgentOrgRole;
  readonly principal_id: string;
  readonly provider: string;
  readonly model: string;
  readonly execution_target_type: ExecutionTargetType;
  readonly trust_tier: TargetTrustTier;
  readonly target_locator: string | null;
  readonly capabilities_json: Readonly<Record<string, unknown>>;
  readonly is_active: boolean;
  readonly created_by_principal_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TrustedAcceptanceTestSpec {
  readonly ac_id: string;
  readonly req_id: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly test_file_path: string;
  readonly component_ids: readonly string[];
  readonly expected_deliverables: readonly string[];
}

export interface ProjectBootstrapRecord {
  readonly bootstrap_id: string;
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
  readonly bootstrap_sha256: string;
  readonly created_by_principal_id: string;
  readonly created_at: string;
}

export interface DevMilestoneRecord {
  readonly milestone_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly milestone_key: string;
  readonly title: string;
  readonly description: string;
  readonly sequence_order: number;
  readonly created_at: string;
}

export interface DevEpicRecord {
  readonly epic_id: string;
  readonly project_id: string;
  readonly milestone_id: string;
  readonly epic_key: string;
  readonly title: string;
  readonly description: string;
  readonly sequence_order: number;
  readonly created_at: string;
}

export interface DevUserStoryRecord {
  readonly story_id: string;
  readonly project_id: string;
  readonly epic_id: string;
  readonly story_key: string;
  readonly title: string;
  readonly description: string;
  readonly requirement_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly sequence_order: number;
  readonly created_at: string;
}

export interface PlannedCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface PlannedTaskSpec {
  readonly task_key: string;
  readonly story_key: string;
  readonly title: string;
  readonly description: string;
  readonly requirement_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly depends_on_task_keys: readonly string[];
  readonly developer_profile_key?: string;
  readonly verification_tier1_command?: PlannedCommandSpec;
}

export interface Stage7PlanningOutput {
  readonly milestones: ReadonlyArray<{
    readonly milestone_key: string;
    readonly title: string;
    readonly description: string;
  }>;
  readonly epics: ReadonlyArray<{
    readonly epic_key: string;
    readonly milestone_key: string;
    readonly title: string;
    readonly description: string;
  }>;
  readonly stories: ReadonlyArray<{
    readonly story_key: string;
    readonly epic_key: string;
    readonly title: string;
    readonly description: string;
    readonly requirement_ids: readonly string[];
    readonly ac_ids: readonly string[];
  }>;
  readonly tasks: readonly PlannedTaskSpec[];
  readonly planning_notes: string;
}

export interface TaskPlanLinkRecord {
  readonly link_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly bootstrap_id: string | null;
  readonly story_id: string | null;
  readonly task_id: string;
  readonly cr_id: string | null;
  readonly requirement_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly assigned_profile_id: string | null;
  readonly created_at: string;
}

export interface Stage7DevelopmentPlanBundle {
  readonly milestones: readonly DevMilestoneRecord[];
  readonly epics: readonly DevEpicRecord[];
  readonly stories: readonly DevUserStoryRecord[];
  readonly taskLinks: readonly TaskPlanLinkRecord[];
  readonly tasks: readonly TaskRecord[];
}

export type ChangeRequestStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "APPLIED";

export interface ChangeRequestProposedTaskSpec {
  readonly task_key: string;
  readonly story_id?: string | null;
  readonly title: string;
  readonly description: string;
  readonly requirement_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly depends_on_task_keys?: readonly string[];
  readonly depends_on_task_ids?: readonly string[];
  readonly developer_profile_id?: string | null;
}

export interface ChangeRequestRecord {
  readonly cr_id: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly cr_key: string;
  readonly title: string;
  readonly rationale: string;
  readonly impacted_requirement_ids: readonly string[];
  readonly impacted_component_ids: readonly string[];
  readonly proposed_tasks: readonly ChangeRequestProposedTaskSpec[];
  readonly status: ChangeRequestStatus;
  readonly requested_by_principal_id: string;
  readonly decided_by_principal_id: string | null;
  readonly decision_rationale: string | null;
  readonly decided_at: string | null;
  readonly applied_by_principal_id: string | null;
  readonly applied_at: string | null;
  readonly cr_sha256: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TraceabilityStage8TaskLineage {
  readonly task_id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly cr_id: string | null;
  readonly trusted_policy_sha256: string | null;
  readonly lease_ids: readonly string[];
  readonly import_ids: readonly string[];
  readonly merge_candidate_ids: readonly string[];
  readonly verification_run_ids: readonly string[];
  readonly review_session_ids: readonly string[];
  readonly review_artifact_ids: readonly string[];
  readonly approval_request_ids: readonly string[];
  readonly approval_decision_ids: readonly string[];
  readonly merged_commit_hash: string | null;
  readonly main_reachable: boolean;
}

export interface TraceabilityRequirementRow {
  readonly req_id: string;
  readonly title: string;
  readonly stage1_item_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly stage3_component_ids: readonly string[];
  readonly stage3_erd_tables: readonly string[];
  readonly stage3_api_endpoints: readonly string[];
  readonly stage3_security_controls: readonly string[];
  readonly stage3_adr_ids: readonly string[];
  readonly bootstrap_id: string | null;
  readonly trusted_acceptance_test_files: readonly string[];
  readonly milestone_ids: readonly string[];
  readonly epic_ids: readonly string[];
  readonly story_ids: readonly string[];
  readonly task_ids: readonly string[];
  readonly applied_cr_ids: readonly string[];
  readonly stage8_lineage: readonly TraceabilityStage8TaskLineage[];
  readonly complete: boolean;
  readonly missing_links: readonly string[];
}

export interface TraceabilityMissingLink {
  readonly req_id: string;
  readonly stage: string;
  readonly reason: string;
}

export interface TraceabilityOrphanLink {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly reason: string;
}

export interface BidirectionalTraceabilityMatrix {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline_id: string;
  readonly generated_at: string;
  readonly total_requirements: number;
  readonly covered_requirements: number;
  readonly coverage_percent: number;
  readonly complete: boolean;
  readonly requirement_rows: readonly TraceabilityRequirementRow[];
  readonly forward_index: Readonly<Record<string, TraceabilityRequirementRow>>;
  readonly backward_index: {
    readonly stage1_items: Readonly<Record<string, readonly string[]>>;
    readonly stage2_ac_ids: Readonly<Record<string, readonly string[]>>;
    readonly stage3_components: Readonly<Record<string, readonly string[]>>;
    readonly trusted_acceptance_tests: Readonly<Record<string, readonly string[]>>;
    readonly stories: Readonly<Record<string, readonly string[]>>;
    readonly tasks: Readonly<Record<string, readonly string[]>>;
    readonly change_requests: Readonly<Record<string, readonly string[]>>;
    readonly merged_commits: Readonly<Record<string, readonly string[]>>;
  };
  readonly missing_links: readonly TraceabilityMissingLink[];
  readonly orphan_links: readonly TraceabilityOrphanLink[];
  readonly traceability_sha256: string;
}

export interface ReleaseAcceptancePackageRecord {
  readonly release_id: string;
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
  readonly package_sha256: string;
  readonly accepted_by_principal_id: string;
  readonly accepted_at: string;
}

export interface M6BStages5To9Bundle {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly baseline: BaselineSpecFreezeRecord;
  readonly bootstrap: ProjectBootstrapRecord | null;
  readonly agent_profiles: readonly AgentOrganizationProfileRecord[];
  readonly stage7_plan: Stage7DevelopmentPlanBundle;
  readonly change_requests: readonly ChangeRequestRecord[];
  readonly traceability: BidirectionalTraceabilityMatrix;
  readonly release_packages: readonly ReleaseAcceptancePackageRecord[];
}

// =============================================================================
// Milestone M6C-1: Parallel DAG Scheduler, CAS Merge Queue & Budgets (AC-12c)
// =============================================================================

export type TaskDependencyKind = "PLAN_DAG" | "PATH_OVERLAP_SERIALIZED" | "MANUAL";

export interface TaskDependencyRecord {
  readonly project_id: string;
  readonly task_id: string;
  readonly depends_on_task_id: string;
  readonly dependency_kind: TaskDependencyKind;
  readonly created_at: string;
}

export type MergeQueueEntryStatus =
  | "QUEUED"
  | "PROCESSING"
  | "MERGED"
  | "REBASED_NEEDS_REVERIFY"
  | "FAILED"
  | "CANCELLED";

export interface MergeQueueEntryRecord {
  readonly queue_entry_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly merge_candidate_id: string;
  readonly approval_id: string;
  readonly queue_position: number;
  readonly status: MergeQueueEntryStatus;
  readonly attempt_count: number;
  readonly rebased_from_candidate_id: string | null;
  readonly rebased_to_candidate_id: string | null;
  readonly merged_commit_hash: string | null;
  readonly last_error: string | null;
  readonly enqueued_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

export type BudgetPauseStatus = "ACTIVE" | "AUTO_PAUSED";

export type BudgetPauseScope =
  | "PROJECT_TOKENS"
  | "PROJECT_COST"
  | "PROJECT_WALL_TIME"
  | "TASK_TOKENS"
  | "TASK_COST"
  | "TASK_WALL_TIME";

export type BudgetPauseEventType = "AUTO_PAUSED" | "BUDGET_UPDATED" | "RESUMED";

export interface ProjectBudgetPolicyRecord {
  readonly project_id: string;
  readonly max_project_tokens: number | null;
  readonly max_project_cost_micro_usd: number | null;
  readonly max_project_wall_time_ms: number | null;
  readonly default_task_max_tokens: number | null;
  readonly default_task_max_cost_micro_usd: number | null;
  readonly default_task_max_wall_time_ms: number | null;
  readonly max_concurrent_tasks: number;
  readonly status: BudgetPauseStatus;
  readonly pause_scope: BudgetPauseScope | null;
  readonly paused_task_id: string | null;
  readonly pause_reason: string | null;
  readonly paused_at: string | null;
  readonly resumed_by_principal_id: string | null;
  readonly resumed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskBudgetPolicyRecord {
  readonly project_id: string;
  readonly task_id: string;
  readonly max_task_tokens: number | null;
  readonly max_task_cost_micro_usd: number | null;
  readonly max_task_wall_time_ms: number | null;
  readonly status: BudgetPauseStatus;
  readonly pause_scope: BudgetPauseScope | null;
  readonly pause_reason: string | null;
  readonly paused_at: string | null;
  readonly resumed_by_principal_id: string | null;
  readonly resumed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BudgetPauseEventRecord {
  readonly event_id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly event_type: BudgetPauseEventType;
  readonly pause_scope: BudgetPauseScope | null;
  readonly reason: string;
  readonly observed_tokens: number;
  readonly observed_cost_micro_usd: number;
  readonly observed_wall_time_ms: number;
  readonly limit_value: number | null;
  readonly actor_principal_id: string | null;
  readonly created_at: string;
}

export interface BudgetUsageSummary {
  readonly tokens_used: number;
  readonly cost_micro_usd: number;
  readonly wall_time_ms: number;
}

export interface ProjectBudgetSnapshot {
  readonly project_id: string;
  readonly policy: ProjectBudgetPolicyRecord | null;
  readonly usage: BudgetUsageSummary;
  readonly task_policies: readonly TaskBudgetPolicyRecord[];
  readonly task_usage: Readonly<Record<string, BudgetUsageSummary>>;
  readonly events: readonly BudgetPauseEventRecord[];
}

export type ScheduledTaskRejectionReason =
  | "DEPENDENCY_NOT_MERGED"
  | "FILE_CONFLICT_IN_FLIGHT"
  | "FILE_CONFLICT_BATCH"
  | "BUDGET_AUTO_PAUSED"
  | "MAX_CONCURRENCY_REACHED";

export interface ParallelDispatchOutcome {
  readonly project_id: string;
  readonly dispatched: ReadonlyArray<{
    readonly task: TaskRecord;
    readonly lease: TaskLeaseRecord;
    readonly worktreePath?: string;
  }>;
  readonly blocked: ReadonlyArray<{
    readonly task_id: string;
    readonly reason: ScheduledTaskRejectionReason;
    readonly detail: string;
    readonly blocking_task_ids?: readonly string[];
    readonly conflicting_witness_path?: string;
  }>;
}

export interface MergeQueueDrainItemResult {
  readonly queue_entry_id: string;
  readonly task_id: string;
  readonly merge_candidate_id: string;
  readonly status: MergeQueueEntryStatus;
  readonly cas_status?: string;
  readonly merged_commit_hash?: string | null;
  readonly rebased_merge_candidate_id?: string | null;
  readonly conflicted_files?: readonly string[];
  readonly error?: string | null;
}

export interface MergeQueueDrainOutcome {
  readonly project_id: string;
  readonly processed: readonly MergeQueueDrainItemResult[];
  readonly remaining_queued: number;
  readonly main_ref_commit_hash: string | null;
}

/** Immutable M6C-2 receipt: one accepted payload per lease, retried by canonical SHA-256. */
export interface CodeImportSubmissionRecord {
  readonly submission_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly lease_id: string;
  readonly lease_epoch: number;
  readonly import_id: string;
  readonly source_type: "bundle" | "patch" | "artifact";
  readonly payload_sha256: string;
  readonly agent_commit_hash: string;
  readonly verified_tree_hash: string;
  readonly staging_ref: string;
  readonly submitted_by_principal_id: string;
  readonly created_at: string;
}
