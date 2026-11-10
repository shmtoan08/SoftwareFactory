import { createHash } from "node:crypto";

/**
 * Canonical Task Statuses (MVP-SPEC-01 Section 4.1 & MVP-SPEC-02 Section 4)
 */
export type TaskStatus =
  | "QUEUED"
  | "LEASED"
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "AGENT_COMPLETED"
  | "CANDIDATE_BUILT"
  | "VERIFIED_PASS"
  | "VERIFIED_FAIL"
  | "REVIEWED_PASS"
  | "REVIEWED_FAIL"
  | "APPROVED"
  | "REJECTED"
  | "MERGED"
  | "NEEDS_REBASE"
  | "FAILED";

/**
 * Canonical Lease Statuses (MVP-SPEC-02 Section 5)
 */
export type LeaseStatus = "ACTIVE" | "COMPLETED" | "EXPIRED" | "REVOKED";

/**
 * Canonical Worker Event Types (MVP-SPEC-03 Section 2.1)
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
 * Deterministic Task State Transition Matrix (MVP-SPEC-01 Section 4.1 & MVP-SPEC-03 Section 2.1)
 */
export const STATE_TRANSITION_MATRIX: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ["LEASED", "FAILED"],
  LEASED: ["ACCEPTED", "QUEUED", "FAILED"],
  ACCEPTED: ["IN_PROGRESS", "QUEUED", "FAILED"],
  IN_PROGRESS: ["IN_PROGRESS", "AGENT_COMPLETED", "QUEUED", "FAILED"],
  AGENT_COMPLETED: ["CANDIDATE_BUILT", "FAILED"],
  CANDIDATE_BUILT: ["VERIFIED_PASS", "VERIFIED_FAIL", "NEEDS_REBASE", "FAILED"],
  VERIFIED_PASS: ["REVIEWED_PASS", "REVIEWED_FAIL", "NEEDS_REBASE"],
  VERIFIED_FAIL: ["QUEUED", "FAILED"],
  REVIEWED_PASS: ["APPROVED", "REJECTED", "NEEDS_REBASE"],
  REVIEWED_FAIL: ["QUEUED", "FAILED"],
  APPROVED: ["MERGED", "NEEDS_REBASE", "REVIEWED_PASS"],
  REJECTED: ["QUEUED", "FAILED"],
  NEEDS_REBASE: ["CANDIDATE_BUILT", "QUEUED", "FAILED"],
  MERGED: [],
  FAILED: ["QUEUED"],
};

/**
 * Maps each WorkerEventType to its allowed source task statuses and resulting target task status
 * (MVP-SPEC-03 Section 2.1)
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
    allowedFrom: ["LEASED"],
    targetStatus: "ACCEPTED",
  },
  "task.started": {
    allowedFrom: ["ACCEPTED"],
    targetStatus: "IN_PROGRESS",
  },
  "task.progress": {
    allowedFrom: ["IN_PROGRESS"],
    targetStatus: "IN_PROGRESS",
  },
  "task.heartbeat": {
    allowedFrom: ["LEASED", "ACCEPTED", "IN_PROGRESS"],
    targetStatus: "UNCHANGED",
  },
  "task.completed": {
    allowedFrom: ["IN_PROGRESS"],
    targetStatus: "AGENT_COMPLETED",
    closesLeaseAs: "COMPLETED",
  },
  "task.failed": {
    allowedFrom: ["LEASED", "ACCEPTED", "IN_PROGRESS"],
    targetStatus: "FAILED",
    closesLeaseAs: "REVOKED",
  },
};

export function isValidTaskStateTransition(from: TaskStatus, to: TaskStatus): boolean {
  return STATE_TRANSITION_MATRIX[from].includes(to);
}

/**
 * Worker Event Envelope (MVP-SPEC-03 Section 2.1)
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
 * Server Event ACK / Reject Contract (MVP-SPEC-03 Section 2.2)
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
 * Reconnect Sync Response Contract (MVP-SPEC-03 Section 3.1)
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
 * Database Entity Interfaces (MVP-SPEC-02 Sections 4-6)
 */
export interface TaskRecord {
  task_id: string;
  project_id: string;
  title: string;
  task_contract_json: Record<string, unknown>;
  status: TaskStatus;
  base_main_commit_hash: string;
  current_attempt_no: number;
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
  exit_code: number;
  duration_ms: number;
  report_sha256: string;
  created_at: string;
}

export interface ReviewArtifactRecord {
  review_artifact_id: string;
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
  verdict: "PASS" | "FAIL";
  is_invalidated: boolean;
  invalidated_reason: string | null;
  findings_json: ReadonlyArray<Record<string, unknown>>;
  created_at: string;
}

/**
 * 8-Field Cryptographically Bound Human Approval Record (MVP-SPEC-02 Section 6 & MVP-SPEC-04 Section 3.1)
 */
export interface ApprovalDecisionRecord {
  approval_id: string;
  project_id: string;
  task_id: string;
  merge_candidate_id: string;
  agent_commit_hash: string;
  base_main_commit_hash: string;
  verified_tree_hash: string;
  merge_candidate_hash: string;
  verification_run_id: string;
  review_artifact_id: string;
  approver_Principal_id: string;
  decision: "APPROVED" | "REJECTED";
  status: "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED";
  invalidated_reason: string | null;
  approved_at: string;
  expires_at: string;
  consumed_at: string | null;
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
 * Deterministic Canonical JSON serialization (sorts object keys recursively)
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
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
