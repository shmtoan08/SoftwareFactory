import { createHash } from "node:crypto";

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
