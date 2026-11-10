import type {
  ApprovalDecisionRecord,
  MergeCandidateRecord,
  ReviewArtifactRecord,
  VerificationRunRecord,
} from "@software-factory/shared-types";
import type {
  ApprovalCenterBundle,
  CoreApiAuthContext,
  CoreApiService,
} from "@software-factory/core-api";

/**
 * WebApprovalConsoleController (MVP-SPEC-01 & MVP-SPEC-04 Section 4)
 * Ensures the Human Approver UI binds all 8 mandatory cryptographic fields
 * from the active MergeCandidate, VerificationRun, and ReviewArtifact before submitting decisions.
 */
export class WebApprovalConsoleController {
  private readonly coreApi: CoreApiService;

  constructor(coreApi: CoreApiService) {
    this.coreApi = coreApi;
  }

  public async loadApprovalCenterBundle(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    taskId: string;
    repoPath?: string;
    gitDir?: string;
  }): Promise<ApprovalCenterBundle> {
    return this.coreApi.getApprovalCenterBundle(input.projectId, input.auth, {
      task_id: input.taskId,
      repo_path: input.repoPath,
      git_dir: input.gitDir,
    });
  }

  public renderApprovalCenterSummaryMarkdown(bundle: ApprovalCenterBundle): string {
    const mc = bundle.activeCandidate;
    const req = bundle.activeApprovalRequest;
    const rev = bundle.latestReviewArtifact;
    return [
      `# Approval Center — Task \`${bundle.task.task_id}\` (${bundle.task.status})`,
      `- **Project:** \`${bundle.project.slug}\` (TTL=${bundle.project.approval_ttl_seconds}s)`,
      `- **Candidate:** \`${mc?.merge_candidate_hash ?? "none"}\` (base=\`${
        mc?.base_main_commit_hash ?? "none"
      }\`, liveMain=\`${bundle.liveMainCommitHash ?? "unknown"}\`, staleBase=\`${String(
        bundle.staleBaseDetected
      )}\`)`,
      `- **Approval Request:** \`${req?.approval_request_id ?? "none"}\` status=\`${
        req?.status ?? "none"
      }\` expired=\`${String(bundle.isExpiredAtNow)}\` remainingMs=\`${String(
        bundle.remainingTtlMs ?? "n/a"
      )}\``,
      `- **3D Review:** verdict=\`${rev?.verdict ?? "none"}\` status=\`${
        rev?.status ?? "none"
      }\` reviewer=\`${rev?.reviewer_principal_id ?? "none"}\` (${
        rev?.reviewer_provider ?? "-"
      }/${rev?.reviewer_model ?? "-"})`,
      `- **Changed Files (${bundle.diffSummary.changedFiles.length}):** ${
        bundle.diffSummary.changedFiles.join(", ") || "none"
      }`,
    ].join("\n");
  }

  public async submitDecisionFromApprovalCenterView(input: {
    auth: CoreApiAuthContext;
    bundle: ApprovalCenterBundle;
    decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    feedback?: string;
    ttlMs?: number;
    repoPath?: string;
    gitDir?: string;
  }): Promise<ApprovalDecisionRecord> {
    const payload = input.bundle.eightFieldLockPayload;
    if (!payload) {
      throw new Error(
        `Approval Center bundle for task ${input.bundle.task.task_id} is missing complete 8-field lock metadata`
      );
    }
    return this.coreApi.submitHumanApproval(payload.project_id, input.auth, {
      task_id: payload.task_id,
      merge_candidate_id: payload.merge_candidate_id,
      approval_request_id: payload.approval_request_id ?? undefined,
      agent_commit_hash: payload.agent_commit_hash,
      base_main_commit_hash: payload.base_main_commit_hash,
      verified_tree_hash: payload.verified_tree_hash,
      merge_candidate_hash: payload.merge_candidate_hash,
      verification_run_id: payload.verification_run_id,
      review_artifact_id: payload.review_artifact_id,
      decision: input.decision,
      feedback: input.feedback,
      ttl_ms: input.ttlMs,
      repo_path: input.repoPath,
      git_dir: input.gitDir,
    });
  }

  public async approveCandidateWith8FieldBinding(input: {
    auth: CoreApiAuthContext;
    candidate: MergeCandidateRecord;
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
    approvalRequestId?: string;
    ttlMs?: number;
    repoPath?: string;
    gitDir?: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
      approval_request_id: input.approvalRequestId,
      agent_commit_hash: input.candidate.agent_commit_hash,
      base_main_commit_hash: input.candidate.base_main_commit_hash,
      verified_tree_hash: input.candidate.verified_tree_hash,
      merge_candidate_hash: input.candidate.merge_candidate_hash,
      verification_run_id: input.verificationRun.verification_run_id,
      review_artifact_id: input.reviewArtifact.review_artifact_id,
      decision: "APPROVED",
      ttl_ms: input.ttlMs,
      repo_path: input.repoPath,
      git_dir: input.gitDir,
    });
  }

  public async requestChangesWith8FieldBinding(input: {
    auth: CoreApiAuthContext;
    candidate: MergeCandidateRecord;
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
    approvalRequestId?: string;
    feedback: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
      approval_request_id: input.approvalRequestId,
      agent_commit_hash: input.candidate.agent_commit_hash,
      base_main_commit_hash: input.candidate.base_main_commit_hash,
      verified_tree_hash: input.candidate.verified_tree_hash,
      merge_candidate_hash: input.candidate.merge_candidate_hash,
      verification_run_id: input.verificationRun.verification_run_id,
      review_artifact_id: input.reviewArtifact.review_artifact_id,
      decision: "REQUEST_CHANGES",
      feedback: input.feedback,
    });
  }

  public async rejectCandidateWith8FieldBinding(input: {
    auth: CoreApiAuthContext;
    candidate: MergeCandidateRecord;
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
    approvalRequestId?: string;
    reason?: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
      approval_request_id: input.approvalRequestId,
      agent_commit_hash: input.candidate.agent_commit_hash,
      base_main_commit_hash: input.candidate.base_main_commit_hash,
      verified_tree_hash: input.candidate.verified_tree_hash,
      merge_candidate_hash: input.candidate.merge_candidate_hash,
      verification_run_id: input.verificationRun.verification_run_id,
      review_artifact_id: input.reviewArtifact.review_artifact_id,
      decision: "REJECTED",
      feedback: input.reason,
    });
  }
}
