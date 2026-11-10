import type {
  ApprovalDecisionRecord,
  MergeCandidateRecord,
  ReviewArtifactRecord,
  VerificationRunRecord,
} from "@software-factory/shared-types";
import type { CoreApiAuthContext, CoreApiService } from "@software-factory/core-api";

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

  public async approveCandidateWith8FieldBinding(input: {
    auth: CoreApiAuthContext;
    candidate: MergeCandidateRecord;
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
    ttlMs?: number;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
      agent_commit_hash: input.candidate.agent_commit_hash,
      base_main_commit_hash: input.candidate.base_main_commit_hash,
      verified_tree_hash: input.candidate.verified_tree_hash,
      merge_candidate_hash: input.candidate.merge_candidate_hash,
      verification_run_id: input.verificationRun.verification_run_id,
      review_artifact_id: input.reviewArtifact.review_artifact_id,
      decision: "APPROVED",
      ttl_ms: input.ttlMs,
    });
  }

  public async requestChangesWith8FieldBinding(input: {
    auth: CoreApiAuthContext;
    candidate: MergeCandidateRecord;
    verificationRun: VerificationRunRecord;
    reviewArtifact: ReviewArtifactRecord;
    feedback: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
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
    reason?: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.coreApi.submitHumanApproval(input.candidate.project_id, input.auth, {
      task_id: input.candidate.task_id,
      merge_candidate_id: input.candidate.merge_candidate_id,
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
