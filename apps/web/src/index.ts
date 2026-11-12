import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CostBudgetExceededError,
  type ModelProviderConfig,
  ModelProviderConfigurationError,
  ModelProviderHttpError,
  PromptNotFoundError,
  PromptRenderError,
  PromptVersionConflictError,
  StructuredOutputValidationError,
} from "@software-factory/adapter-sdk";
import {
  type ApprovalCenterBundle,
  CORE_API_AUTH_HEADER,
  type CoreApiAuthContext,
  type CoreApiService,
  decodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import { Ac10ViolationError, PostgresRlsError } from "@software-factory/database";
import type {
  AgentOrgRole,
  AgentOrganizationProfileRecord,
  ApprovalDecisionRecord,
  BaselineSpecFreezeRecord,
  BidirectionalTraceabilityMatrix,
  CandidateBoundLineage,
  ChangeRequestProposedTaskSpec,
  ChangeRequestRecord,
  ExecutionTargetType,
  M6BStages5To9Bundle,
  MergeCandidateRecord,
  PipelineStageName,
  ProductPipelineBundle,
  ProductPipelineSessionRecord,
  ReleaseAcceptancePackageRecord,
  ReviewArtifactRecord,
  Stage1DiscoveryItemRecord,
  Stage4ConsistencyReport,
  StageApprovalGateRecord,
  StageApprovalGateStage,
  StageArtifactRecord,
  TargetTrustTier,
  VerificationRunRecord,
} from "@software-factory/shared-types";

class WebBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebBadRequestError";
  }
}

function sanitizeWebModelConfig(raw: unknown): ModelProviderConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WebBadRequestError("model_config must be an object");
  }
  const candidate = raw as Record<string, unknown>;
  const provider = candidate.provider;
  const model = candidate.model;
  if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
    throw new WebBadRequestError(
      "model_config.provider must be one of anthropic, openai, google"
    );
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new WebBadRequestError("model_config.model must be a non-empty string");
  }
  return {
    provider,
    model: model.trim(),
    ...(typeof candidate.apiKey === "string" ? { apiKey: candidate.apiKey } : {}),
    ...(typeof candidate.apiKeyEnvVar === "string" ? { apiKeyEnvVar: candidate.apiKeyEnvVar } : {}),
    ...(typeof candidate.baseUrl === "string" ? { baseUrl: candidate.baseUrl } : {}),
    ...(typeof candidate.timeoutMs === "number" ? { timeoutMs: candidate.timeoutMs } : {}),
    allowInsecureHttpBaseUrl: false,
  };
}

const PIPELINE_GATE_STAGE_TO_ARTIFACT_STAGE: Readonly<
  Record<StageApprovalGateStage, PipelineStageName>
> = {
  STAGE_1_DISCOVERY: "STAGE_1_IDEA_DISCOVERY",
  STAGE_2_REQUIREMENTS: "STAGE_2_REQUIREMENTS",
  STAGE_3_ARCHITECTURE: "STAGE_3_ARCHITECTURE",
  STAGE_4_SPEC_FREEZE: "STAGE_4_SPEC_FREEZE",
};

function findLatestStageArtifact(
  artifacts: readonly StageArtifactRecord[],
  stage: PipelineStageName
): StageArtifactRecord | null {
  let latest: StageArtifactRecord | null = null;
  for (const artifact of artifacts) {
    if (artifact.stage !== stage) continue;
    if (!latest || artifact.version >= latest.version) {
      latest = artifact;
    }
  }
  return latest;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * WebApprovalConsoleController (MVP-SPEC-01 & MVP-SPEC-04 Section 4 & M5)
 * Ensures the Human Approver UI binds all 8 mandatory cryptographic fields
 * from the active MergeCandidate, VerificationRun, and ReviewArtifact before submitting decisions,
 * and exposes full Candidate-Bound Lineage (`AC-11a`) & Resource Metrics (`AC-12a`) views.
 */
export class WebApprovalConsoleController {
  public readonly coreApi: CoreApiService;

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

  public async loadCandidateLineage(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    taskId: string;
    repoPath?: string;
    gitDir?: string;
  }): Promise<CandidateBoundLineage> {
    return this.coreApi.getCandidateBoundLineage(input.projectId, input.auth, {
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

  public renderApprovalCenterHtml(bundle: ApprovalCenterBundle): string {
    const mc = bundle.activeCandidate;
    const vr = bundle.latestVerificationRun;
    const rev = bundle.latestReviewArtifact;
    const req = bundle.activeApprovalRequest;
    const lock = bundle.eightFieldLockPayload;
    const filesHtml = bundle.diffSummary.changedFiles
      .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>Approval Center - ${escapeHtml(bundle.task.task_id)}</title>`,
      "</head>",
      "<body>",
      `<main data-task-id="${escapeHtml(bundle.task.task_id)}">`,
      `<h1>Approval Center: ${escapeHtml(bundle.task.title)}</h1>`,
      `<p>Project: <strong>${escapeHtml(bundle.project.slug)}</strong> | Status: <code>${escapeHtml(bundle.task.status)}</code></p>`,
      `<p>Live main HEAD: <code>${escapeHtml(bundle.liveMainCommitHash ?? "unknown")}</code> | Stale Base: <strong>${String(bundle.staleBaseDetected)}</strong> | Request Status: <code>${escapeHtml(req?.status ?? "none")}</code> | Expired: <strong>${String(bundle.isExpiredAtNow)}</strong></p>`,
      "<section>",
      "<h2>8-Field Cryptographic Lock Payload</h2>",
      lock
        ? `<ul>
            <li>candidate_id: <code>${escapeHtml(lock.merge_candidate_id)}</code></li>
            <li>approval_request_id: <code>${escapeHtml(lock.approval_request_id ?? "none")}</code></li>
            <li>agent_commit_hash: <code>${escapeHtml(lock.agent_commit_hash)}</code></li>
            <li>base_main_commit_hash: <code>${escapeHtml(lock.base_main_commit_hash)}</code></li>
            <li>verified_tree_hash: <code>${escapeHtml(lock.verified_tree_hash)}</code></li>
            <li>merge_candidate_hash: <code>${escapeHtml(lock.merge_candidate_hash)}</code></li>
            <li>verification_run_id: <code>${escapeHtml(lock.verification_run_id)}</code></li>
            <li>review_artifact_id: <code>${escapeHtml(lock.review_artifact_id)}</code></li>
          </ul>`
        : "<p>Incomplete 8-field lock metadata</p>",
      "</section>",
      "<section>",
      `<h2>Verifier (${escapeHtml(vr?.overall_status ?? "none")}) &amp; 3D Reviewer (${escapeHtml(rev?.verdict ?? "none")})</h2>`,
      `<p>Candidate Hash: <code>${escapeHtml(mc?.merge_candidate_hash ?? "none")}</code></p>`,
      `<p>Reviewer: <code>${escapeHtml(rev?.reviewer_principal_id ?? "none")}</code> (${escapeHtml(rev?.reviewer_provider ?? "-")}/${escapeHtml(rev?.reviewer_model ?? "-")})</p>`,
      "</section>",
      "<section>",
      `<h2>Changed Files (${bundle.diffSummary.changedFiles.length})</h2>`,
      `<ul>${filesHtml}</ul>`,
      `<pre>${escapeHtml(bundle.diffSummary.diffText)}</pre>`,
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ].join("\n");
  }

  public renderCandidateLineageMarkdown(lineage: CandidateBoundLineage): string {
    const metricsRows = lineage.resourceUsageMetrics
      .map(
        (m) =>
          `| ${m.phase} | ${m.lease_epoch} | ${m.wall_time_ms}ms | ${m.cpu_usage_usec}us | ${m.peak_memory_bytes}B | ${m.sandbox_backend_mode} | ${m.metrics_source} |`
      )
      .join("\n");

    return [
      `# Candidate-Bound Lineage — Task \`${lineage.taskId}\``,
      `- **Status:** \`${lineage.task.status}\` | **Complete:** \`${String(lineage.lineageComplete)}\` | **HashBindingVerified:** \`${String(lineage.hashBindingVerified)}\``,
      `- **Main HEAD Matches Candidate:** \`${String(lineage.gitLogHeadMatchesCandidate)}\` (\`${lineage.mainHeadCommitHash ?? "null"}\`)`,
      `- **Task Leases:** ${lineage.taskLeases.length} | **Processed Worker Events:** ${lineage.processedEventsCount}`,
      `- **Verified Import:** \`${lineage.verifiedImport?.import_id ?? "none"}\` (recovered=\`${String(
        lineage.verifiedImport?.recovered_by_reconciler ?? false
      )}\`)`,
      `- **Merge Candidate:** \`${lineage.mergeCandidate?.merge_candidate_id ?? "none"}\` (\`${
        lineage.mergeCandidate?.merge_candidate_hash ?? "none"
      }\`)`,
      `- **Verification Run:** \`${lineage.verificationRun?.verification_run_id ?? "none"}\` (${
        lineage.verificationRun?.overall_status ?? "none"
      })`,
      `- **Review Session / Artifact:** \`${lineage.reviewSession?.review_session_id ?? "none"}\` / \`${
        lineage.reviewArtifact?.review_artifact_id ?? "none"
      }\``,
      `- **Approval Request / Decision:** \`${lineage.approvalRequest?.approval_request_id ?? "none"}\` / \`${
        lineage.activeOrConsumedApproval?.approval_id ?? "none"
      }\``,
      `- **Merge Operations:** ${lineage.mergeOperations.map((m) => `${m.merge_op_id}(${m.status})`).join(", ") || "none"}`,
      lineage.missingLinks.length > 0 ? `- **Missing Links:** ${lineage.missingLinks.join(", ")}` : "",
      "",
      "## Resource Usage Telemetry (AC-12a)",
      "| Phase | Epoch | Wall Time | CPU | Peak Memory | Backend | Source |",
      "|---|---:|---:|---:|---:|---|---|",
      metricsRows,
    ]
      .filter(Boolean)
      .join("\n");
  }

  public renderCandidateLineageHtml(lineage: CandidateBoundLineage): string {
    const metricsRows = lineage.resourceUsageMetrics
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.phase)}</td><td>${m.lease_epoch}</td><td>${m.wall_time_ms}</td><td>${m.cpu_usage_usec}</td><td>${m.peak_memory_bytes}</td><td><code>${escapeHtml(
            m.sandbox_backend_mode
          )}</code></td><td><code>${escapeHtml(m.metrics_source)}</code></td></tr>`
      )
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>Candidate Lineage - ${escapeHtml(lineage.taskId)}</title>`,
      "</head>",
      "<body>",
      `<main data-task-id="${escapeHtml(lineage.taskId)}">`,
      `<h1>Candidate-Bound Lineage: ${escapeHtml(lineage.task.title)}</h1>`,
      `<p>Status: <code>${escapeHtml(lineage.task.status)}</code> | Complete: <strong>${String(
        lineage.lineageComplete
      )}</strong> | Hash Binding Verified: <strong>${String(
        lineage.hashBindingVerified
      )}</strong> | Git HEAD Matches Candidate: <strong>${String(
        lineage.gitLogHeadMatchesCandidate
      )}</strong></p>`,
      "<ol>",
      `<li>Task: <code>${escapeHtml(lineage.taskId)}</code> (base=<code>${escapeHtml(lineage.task.base_main_commit_hash)}</code>)</li>`,
      `<li>Leases (${lineage.taskLeases.length}): ${lineage.taskLeases
        .map((l) => `<code>${escapeHtml(l.lease_id)}</code>[${escapeHtml(l.status)}]`)
        .join(", ")}</li>`,
      `<li>Processed Worker Events: <strong>${lineage.processedEventsCount}</strong></li>`,
      `<li>VerifiedCodeImport: <code>${escapeHtml(lineage.verifiedImport?.import_id ?? "none")}</code> (recovered=${String(
        lineage.verifiedImport?.recovered_by_reconciler ?? false
      )})</li>`,
      `<li>MergeCandidate: <code>${escapeHtml(lineage.mergeCandidate?.merge_candidate_id ?? "none")}</code> (hash=<code>${escapeHtml(
        lineage.mergeCandidate?.merge_candidate_hash ?? "none"
      )}</code>)</li>`,
      `<li>VerificationRun: <code>${escapeHtml(lineage.verificationRun?.verification_run_id ?? "none")}</code> (${escapeHtml(
        lineage.verificationRun?.overall_status ?? "none"
      )})</li>`,
      `<li>ReviewSession / ReviewArtifact: <code>${escapeHtml(
        lineage.reviewSession?.review_session_id ?? "none"
      )}</code> / <code>${escapeHtml(lineage.reviewArtifact?.review_artifact_id ?? "none")}</code></li>`,
      `<li>ApprovalRequest / ApprovalDecision: <code>${escapeHtml(
        lineage.approvalRequest?.approval_request_id ?? "none"
      )}</code> / <code>${escapeHtml(lineage.activeOrConsumedApproval?.approval_id ?? "none")}</code></li>`,
      `<li>MergeOperations (${lineage.mergeOperations.length}): ${lineage.mergeOperations
        .map((m) => `<code>${escapeHtml(m.merge_op_id)}</code>[${escapeHtml(m.status)}]`)
        .join(", ")}</li>`,
      `<li>refs/heads/main HEAD: <code>${escapeHtml(lineage.mainHeadCommitHash ?? "null")}</code></li>`,
      "</ol>",
      "<h2>Resource Usage Telemetry (AC-12a)</h2>",
      "<table>",
      "<thead><tr><th>Phase</th><th>Epoch</th><th>Wall ms</th><th>CPU usec</th><th>Peak Bytes</th><th>Backend</th><th>Source</th></tr></thead>",
      `<tbody>${metricsRows}</tbody>`,
      "</table>",
      "</main>",
      "</body>",
      "</html>",
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

  // ===========================================================================
  // Milestone M6A: Stages 1–4 Product Pipeline Console & Baseline Freeze Gate
  // ===========================================================================

  public async listPipelineSessions(input: {
    auth: CoreApiAuthContext;
    projectId: string;
  }): Promise<ProductPipelineSessionRecord[]> {
    return this.coreApi.listPipelineSessions(input.projectId, input.auth);
  }

  public async createPipelineSession(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId?: string;
    costSessionId?: string | null;
    costBudget?: {
      readonly cost_session_id?: string;
      readonly max_tokens_per_request: number;
      readonly max_cost_micro_usd_per_request: number;
      readonly session_token_budget: number;
      readonly session_cost_budget_micro_usd: number;
    };
    title: string;
    rawIdeaText: string;
  }): Promise<Awaited<ReturnType<CoreApiService["createPipelineSession"]>>> {
    return this.coreApi.createPipelineSession(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cost_session_id: input.costSessionId,
      cost_budget: input.costBudget,
      title: input.title,
      raw_idea_text: input.rawIdeaText,
    });
  }

  public async loadPipelineBundle(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
  }): Promise<ProductPipelineBundle | null> {
    return this.coreApi.getPipelineBundle(input.projectId, input.auth, input.pipelineSessionId);
  }

  public async runPipelineStage1Extract(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    costSessionId?: string;
    promptVersion?: string;
    maxTokens?: number;
    temperature?: number;
    modelConfig?: ModelProviderConfig;
  }): Promise<Awaited<ReturnType<CoreApiService["runPipelineStage1Extract"]>>> {
    return this.coreApi.runPipelineStage1Extract(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cost_session_id: input.costSessionId,
      prompt_version: input.promptVersion,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      model_config: input.modelConfig,
    });
  }

  public async resolvePipelineStage1Item(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    itemId: string;
    decision: "CONFIRM" | "REJECT";
    resolutionNote?: string | null;
  }): Promise<Stage1DiscoveryItemRecord> {
    return this.coreApi.resolvePipelineStage1Item(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      item_id: input.itemId,
      decision: input.decision,
      resolution_note: input.resolutionNote,
    });
  }

  public async runPipelineStage2Requirements(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    costSessionId?: string;
    promptVersion?: string;
    maxTokens?: number;
    temperature?: number;
    modelConfig?: ModelProviderConfig;
  }): Promise<Awaited<ReturnType<CoreApiService["runPipelineStage2Requirements"]>>> {
    return this.coreApi.runPipelineStage2Requirements(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cost_session_id: input.costSessionId,
      prompt_version: input.promptVersion,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      model_config: input.modelConfig,
    });
  }

  public async runPipelineStage3Architecture(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    costSessionId?: string;
    stage2ArtifactId?: string;
    promptVersion?: string;
    maxTokens?: number;
    temperature?: number;
    modelConfig?: ModelProviderConfig;
  }): Promise<Awaited<ReturnType<CoreApiService["runPipelineStage3Architecture"]>>> {
    return this.coreApi.runPipelineStage3Architecture(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cost_session_id: input.costSessionId,
      stage2_artifact_id: input.stage2ArtifactId,
      prompt_version: input.promptVersion,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      model_config: input.modelConfig,
    });
  }

  public async runPipelineStage4ConsistencyCheck(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    stage1ArtifactId?: string;
    stage2ArtifactId?: string;
    stage3ArtifactId?: string;
    checkedAt?: string;
  }): Promise<Awaited<ReturnType<CoreApiService["runPipelineStage4ConsistencyCheck"]>>> {
    return this.coreApi.runPipelineStage4ConsistencyCheck(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      stage1_artifact_id: input.stage1ArtifactId,
      stage2_artifact_id: input.stage2ArtifactId,
      stage3_artifact_id: input.stage3ArtifactId,
      checked_at: input.checkedAt,
    });
  }

  public renderPipelineProjectListHtml(input: {
    projectId: string;
    sessions: readonly ProductPipelineSessionRecord[];
    errorMessage?: string;
  }): string {
    const projectEnc = encodeURIComponent(input.projectId);
    const errorBannerHtml = input.errorMessage
      ? `<div role="alert" data-error-banner="true" class="error-banner">${escapeHtml(
          input.errorMessage
        )}</div>`
      : "";
    const sessionRows = input.sessions
      .map((s) => {
        const sEnc = encodeURIComponent(s.pipeline_session_id);
        return `<tr><td><a href="/projects/${projectEnc}/pipeline-sessions/${sEnc}">${escapeHtml(
          s.title
        )}</a></td><td><code>${escapeHtml(s.current_stage)}</code></td><td><code>${escapeHtml(
          s.status
        )}</code></td><td><code>${escapeHtml(s.created_by_principal_id)}</code></td></tr>`;
      })
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>Product Pipelines - ${escapeHtml(input.projectId)}</title>`,
      "</head>",
      "<body>",
      `<main data-project-id="${escapeHtml(input.projectId)}">`,
      `<h1>Product Pipeline Sessions (${escapeHtml(input.projectId)})</h1>`,
      errorBannerHtml,
      `<p><a href="/projects/${projectEnc}/agent-profiles">Agent Org Profiles (Stage 6)</a></p>`,
      "<section>",
      `<h2>Existing Sessions (${input.sessions.length})</h2>`,
      input.sessions.length > 0
        ? `<table><thead><tr><th>Title</th><th>Stage</th><th>Status</th><th>Creator</th></tr></thead><tbody>${sessionRows}</tbody></table>`
        : "<p>No product pipeline sessions yet.</p>",
      "</section>",
      "<section>",
      "<h2>Create Pipeline Session</h2>",
      `<form method="POST" action="/projects/${projectEnc}/pipeline-sessions">`,
      '<label>Title <input type="text" name="title" required></label>',
      '<label>Raw Idea Text <textarea name="raw_idea_text" required></textarea></label>',
      '<label>Existing Cost Session ID <input type="text" name="cost_session_id" placeholder="optional UUID"></label>',
      '<label>Max Tokens / Request <input type="number" name="max_tokens_per_request" placeholder="8000"></label>',
      '<label>Max Cost micro-USD / Request <input type="number" name="max_cost_micro_usd_per_request" placeholder="500000"></label>',
      '<label>Session Token Budget <input type="number" name="session_token_budget" placeholder="50000"></label>',
      '<label>Session Cost Budget micro-USD <input type="number" name="session_cost_budget_micro_usd" placeholder="2000000"></label>',
      '<button type="submit">Create Pipeline Session</button>',
      "</form>",
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public renderPipelineBundleMarkdown(bundle: ProductPipelineBundle): string {
    const cost = bundle.costSession;
    const ledgersRows = bundle.modelCallLedgers
      .map(
        (l) =>
          `| ${l.stage} | ${l.provider}/${l.model} | ${l.prompt_id}@${l.prompt_version} | ${l.status} | ${
            l.actual_total_tokens
          }${l.usage_estimated ? " (est)" : ""} | ${l.actual_cost_micro_usd} |`
      )
      .join("\n");
    const discoveryRows = bundle.discoveryItems
      .map(
        (d) =>
          `| ${d.kind} | ${d.title} | ${d.confirmation_status} | ${d.confirmed_by_principal_id ?? "-"} |`
      )
      .join("\n");
    const artifactRows = bundle.artifacts
      .map(
        (a) =>
          `| ${a.stage} | v${a.version} | ${a.artifact_kind} | ${a.provider}/${a.model} | \`${a.artifact_sha256}\` |`
      )
      .join("\n");
    const stage4Artifact = findLatestStageArtifact(bundle.artifacts, "STAGE_4_SPEC_FREEZE");
    const report = stage4Artifact
      ? (stage4Artifact.content_json as unknown as Stage4ConsistencyReport)
      : null;
    const gateRows = bundle.approvalGates
      .map(
        (g) =>
          `| ${g.gate_stage} | ${g.decision} | ${g.approver_principal_id} | \`${g.target_artifact_sha256}\` |`
      )
      .join("\n");

    return [
      `# Product Pipeline — ${bundle.session.title} (\`${bundle.session.pipeline_session_id}\`)`,
      `- **Project:** \`${bundle.session.project_id}\` | **Stage:** \`${bundle.session.current_stage}\` | **Status:** \`${bundle.session.status}\``,
      `- **Cost Session (AC-12b):** \`${cost?.cost_session_id ?? "none"}\` status=\`${
        cost?.status ?? "none"
      }\` tokens=\`${cost?.tokens_used_total ?? 0}/${
        cost?.session_token_budget ?? 0
      }\` cost_micro_usd=\`${cost?.cost_used_micro_usd ?? 0}/${
        cost?.session_cost_budget_micro_usd ?? 0
      }\``,
      "",
      "## Stage 1 Discovery Items (AC-10)",
      "| Kind | Title | Confirmation | Confirmed By |",
      "|---|---|---|---|",
      discoveryRows,
      "",
      "## Stage Artifacts",
      "| Stage | Version | Kind | Provider/Model | Artifact SHA-256 |",
      "|---|---:|---|---|---|",
      artifactRows,
      "",
      "## Model Call Ledgers",
      "| Stage | Provider/Model | Prompt | Status | Actual Tokens | Cost (micro-USD) |",
      "|---|---|---|---|---:|---:|",
      ledgersRows,
      "",
      report
        ? [
            `## Stage 4 Consistency Check (\`passed=${String(report.passed)}\`)`,
            ...report.checks.map(
              (c) => `- **${c.check_id} (${c.name}):** \`${c.passed ? "PASS" : c.severity}\` — ${c.details}`
            ),
          ].join("\n")
        : "## Stage 4 Consistency Check\n- Not executed yet",
      "",
      "## Approval Gates",
      "| Gate Stage | Decision | Approver | Target SHA-256 |",
      "|---|---|---|---|",
      gateRows,
      "",
      bundle.baselineFreeze
        ? `## Baseline Spec Freeze\n- **Baseline ID:** \`${bundle.baselineFreeze.baseline_id}\` | **Status:** \`${bundle.baselineFreeze.status}\` | **Bundle SHA-256:** \`${bundle.baselineFreeze.freeze_bundle_sha256}\``
        : "## Baseline Spec Freeze\n- Not frozen",
    ].join("\n");
  }

  public renderPipelineBundleHtml(
    bundle: ProductPipelineBundle,
    options?: { readonly errorMessage?: string }
  ): string {
    const projectEnc = encodeURIComponent(bundle.session.project_id);
    const sessionEnc = encodeURIComponent(bundle.session.pipeline_session_id);
    const baseActionUrl = `/projects/${projectEnc}/pipeline-sessions/${sessionEnc}`;
    const isFrozen = bundle.session.status === "FROZEN";
    const disabledAttr = isFrozen ? " disabled" : "";
    const errorBannerHtml = options?.errorMessage
      ? `<div role="alert" data-error-banner="true" class="error-banner">${escapeHtml(
          options.errorMessage
        )}</div>`
      : "";

    const cost = bundle.costSession;
    const discoveryRows = bundle.discoveryItems
      .map((d) => {
        const itemEnc = encodeURIComponent(d.item_id);
        const actionCell =
          !isFrozen && d.confirmation_status === "UNCONFIRMED"
            ? `<form method="POST" action="${baseActionUrl}/stage1/items/${itemEnc}/resolve" style="display:inline"><input type="hidden" name="decision" value="CONFIRM"><button type="submit">Confirm</button></form> <form method="POST" action="${baseActionUrl}/stage1/items/${itemEnc}/resolve" style="display:inline"><input type="hidden" name="decision" value="REJECT"><input type="text" name="resolution_note" placeholder="Rejection rationale"><button type="submit">Reject</button></form>`
            : "<code>-</code>";
        return `<tr><td><code>${escapeHtml(d.kind)}</code></td><td>${escapeHtml(
          d.title
        )}</td><td><code>${escapeHtml(d.confirmation_status)}</code></td><td><code>${escapeHtml(
          d.confirmed_by_principal_id ?? "-"
        )}</code></td><td>${actionCell}</td></tr>`;
      })
      .join("");
    const artifactRows = bundle.artifacts
      .map(
        (a) =>
          `<tr><td><code>${escapeHtml(a.stage)}</code></td><td>v${a.version}</td><td><code>${escapeHtml(
            a.artifact_kind
          )}</code></td><td>${escapeHtml(a.provider)}/${escapeHtml(
            a.model
          )}</td><td><code>${escapeHtml(a.artifact_sha256)}</code></td></tr>`
      )
      .join("");
    const ledgerRows = bundle.modelCallLedgers
      .map(
        (l) =>
          `<tr><td><code>${escapeHtml(l.stage)}</code></td><td>${escapeHtml(
            l.provider
          )}/${escapeHtml(l.model)}</td><td><code>${escapeHtml(l.status)}</code></td><td>${
            l.actual_total_tokens
          }${l.usage_estimated ? " (est)" : ""}</td><td>${l.actual_cost_micro_usd}</td></tr>`
      )
      .join("");
    const gateRows = bundle.approvalGates
      .map(
        (g) =>
          `<tr><td><code>${escapeHtml(g.gate_stage)}</code></td><td><code>${escapeHtml(
            g.decision
          )}</code></td><td><code>${escapeHtml(g.approver_principal_id)}</code></td><td><code>${escapeHtml(
            g.target_artifact_sha256
          )}</code></td></tr>`
      )
      .join("");
    const stage4Artifact = findLatestStageArtifact(bundle.artifacts, "STAGE_4_SPEC_FREEZE");
    const report = stage4Artifact
      ? (stage4Artifact.content_json as unknown as Stage4ConsistencyReport)
      : null;

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>Product Pipeline - ${escapeHtml(bundle.session.title)}</title>`,
      "</head>",
      "<body>",
      `<main data-pipeline-session-id="${escapeHtml(bundle.session.pipeline_session_id)}">`,
      `<h1>Product Pipeline: ${escapeHtml(bundle.session.title)}</h1>`,
      `<p>Stage: <code>${escapeHtml(bundle.session.current_stage)}</code> | Status: <code>${escapeHtml(
        bundle.session.status
      )}</code> | Frozen Baseline: <code>${escapeHtml(
        bundle.session.frozen_baseline_id ?? "none"
      )}</code></p>`,
      errorBannerHtml,
      `<p><a href="/projects/${projectEnc}/pipeline-sessions">All Pipeline Sessions</a> | <a href="${baseActionUrl}/m6b">Stage 5–9 &amp; Traceability Workbench</a> | <a href="/projects/${projectEnc}/agent-profiles">Agent Org Profiles</a></p>`,
      "<section>",
      "<h2>Cost Session (AC-12b)</h2>",
      cost
        ? `<p>Cost Session: <code>${escapeHtml(cost.cost_session_id)}</code> | Status: <code>${escapeHtml(
            cost.status
          )}</code> | Tokens: <strong>${cost.tokens_used_total}</strong>/${
            cost.session_token_budget
          } | Cost (micro-USD): <strong>${cost.cost_used_micro_usd}</strong>/${
            cost.session_cost_budget_micro_usd
          }</p>`
        : "<p>No cost session linked</p>",
      "<table><thead><tr><th>Stage</th><th>Provider/Model</th><th>Status</th><th>Tokens</th><th>Micro-USD</th></tr></thead>",
      `<tbody>${ledgerRows}</tbody></table>`,
      "</section>",
      '<section data-workbench="stages-1-4">',
      "<h2>Pipeline Workbench (Stages 1-4)</h2>",
      `<form method="POST" action="${baseActionUrl}/stage1/extract">`,
      '<label>Prompt Version <input type="text" name="prompt_version" placeholder="1.0.0"></label>',
      '<label>Max Tokens <input type="number" name="max_tokens" placeholder="4096"></label>',
      '<label>Temperature <input type="number" step="0.1" name="temperature" placeholder="0"></label>',
      `<button type="submit"${disabledAttr}>Run Stage 1 Discovery</button>`,
      "</form>",
      `<form method="POST" action="${baseActionUrl}/stage2/requirements">`,
      '<label>Prompt Version <input type="text" name="prompt_version" placeholder="1.0.0"></label>',
      '<label>Max Tokens <input type="number" name="max_tokens" placeholder="8192"></label>',
      `<button type="submit"${disabledAttr}>Run Stage 2 Requirements</button>`,
      "</form>",
      `<form method="POST" action="${baseActionUrl}/stage3/architecture">`,
      '<label>Stage 2 Artifact ID <input type="text" name="stage2_artifact_id" placeholder="latest"></label>',
      '<label>Prompt Version <input type="text" name="prompt_version" placeholder="1.0.0"></label>',
      `<button type="submit"${disabledAttr}>Run Stage 3 Architecture</button>`,
      "</form>",
      `<form method="POST" action="${baseActionUrl}/stage4/consistency-check">`,
      `<button type="submit"${disabledAttr}>Run Stage 4 Consistency Check</button>`,
      "</form>",
      "</section>",
      "<section>",
      `<h2>Stage 1 Discovery Items (${bundle.discoveryItems.length})</h2>`,
      "<table><thead><tr><th>Kind</th><th>Title</th><th>Status</th><th>Confirmed By</th><th>Actions</th></tr></thead>",
      `<tbody>${discoveryRows}</tbody></table>`,
      "</section>",
      "<section>",
      `<h2>Stage Artifacts (${bundle.artifacts.length})</h2>`,
      "<table><thead><tr><th>Stage</th><th>Version</th><th>Kind</th><th>Provider/Model</th><th>SHA-256</th></tr></thead>",
      `<tbody>${artifactRows}</tbody></table>`,
      "</section>",
      "<section>",
      `<h2>Stage 4 Consistency Check (${report ? (report.passed ? "PASS" : "FAIL") : "PENDING"})</h2>`,
      report
        ? `<ul>${report.checks
            .map(
              (c) =>
                `<li><strong>${escapeHtml(c.check_id)}</strong> (${escapeHtml(
                  c.name
                )}): <code>${c.passed ? "PASS" : escapeHtml(c.severity)}</code> — ${escapeHtml(
                  c.details
                )}</li>`
            )
            .join("")}</ul>`
        : "<p>Stage 4 report not generated</p>",
      "</section>",
      "<section>",
      `<h2>Approval Gates (${bundle.approvalGates.length})</h2>`,
      "<table><thead><tr><th>Gate</th><th>Decision</th><th>Approver</th><th>Target SHA-256</th></tr></thead>",
      `<tbody>${gateRows}</tbody></table>`,
      `<form method="POST" action="${baseActionUrl}/approval-gates">`,
      '<label>Gate Stage <select name="gate_stage"><option value="STAGE_1_DISCOVERY">STAGE_1_DISCOVERY</option><option value="STAGE_2_REQUIREMENTS">STAGE_2_REQUIREMENTS</option><option value="STAGE_3_ARCHITECTURE">STAGE_3_ARCHITECTURE</option><option value="STAGE_4_SPEC_FREEZE" selected>STAGE_4_SPEC_FREEZE</option></select></label>',
      '<label>Decision <select name="decision"><option value="APPROVED" selected>APPROVED</option><option value="REQUEST_CHANGES">REQUEST_CHANGES</option><option value="REJECTED">REJECTED</option></select></label>',
      '<label>Rationale <input type="text" name="rationale" placeholder="Gate decision rationale"></label>',
      `<button type="submit"${disabledAttr}>Submit Approval Gate</button>`,
      "</form>",
      "</section>",
      "<section>",
      "<h2>Baseline Spec Freeze</h2>",
      bundle.baselineFreeze
        ? `<p>Baseline ID: <code>${escapeHtml(
            bundle.baselineFreeze.baseline_id
          )}</code> | Status: <code>${escapeHtml(
            bundle.baselineFreeze.status
          )}</code> | Bundle SHA-256: <code>${escapeHtml(
            bundle.baselineFreeze.freeze_bundle_sha256
          )}</code></p>`
        : "<p>Not frozen</p>",
      `<form method="POST" action="${baseActionUrl}/freeze">`,
      `<button type="submit"${disabledAttr}>Freeze Baseline Spec</button>`,
      "</form>",
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public async submitPipelineApprovalGate(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    gateStage: StageApprovalGateStage;
    targetArtifactId?: string;
    targetArtifactSha256?: string;
    decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    rationale?: string | null;
  }): Promise<StageApprovalGateRecord> {
    return this.coreApi.submitPipelineApprovalGate(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      gate_stage: input.gateStage,
      target_artifact_id: input.targetArtifactId,
      target_artifact_sha256: input.targetArtifactSha256,
      decision: input.decision,
      rationale: input.rationale,
    });
  }

  public async submitPipelineApprovalGateFromBundle(input: {
    auth: CoreApiAuthContext;
    bundle: ProductPipelineBundle;
    gateStage: StageApprovalGateStage;
    decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    rationale?: string | null;
  }): Promise<StageApprovalGateRecord> {
    const expectedStage = PIPELINE_GATE_STAGE_TO_ARTIFACT_STAGE[input.gateStage];
    const targetArtifact = findLatestStageArtifact(input.bundle.artifacts, expectedStage);
    if (!targetArtifact) {
      throw new PostgresRlsError(
        "23503",
        `Target artifact for gate ${input.gateStage} not found in pipeline session ${input.bundle.session.pipeline_session_id}`
      );
    }
    return this.coreApi.submitPipelineApprovalGate(input.bundle.session.project_id, input.auth, {
      pipeline_session_id: input.bundle.session.pipeline_session_id,
      gate_stage: input.gateStage,
      target_artifact_id: targetArtifact.artifact_id,
      target_artifact_sha256: targetArtifact.artifact_sha256,
      decision: input.decision,
      rationale: input.rationale,
    });
  }

  public async freezePipelineBaseline(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    stage1ArtifactId?: string;
    stage1ArtifactSha256?: string;
    stage2ArtifactId?: string;
    stage2ArtifactSha256?: string;
    stage3ArtifactId?: string;
    stage3ArtifactSha256?: string;
    validationReportArtifactId?: string;
    validationReportSha256?: string;
    approvalGateId?: string;
  }): Promise<BaselineSpecFreezeRecord> {
    return this.coreApi.freezePipelineBaseline(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      stage1_artifact_id: input.stage1ArtifactId,
      stage1_artifact_sha256: input.stage1ArtifactSha256,
      stage2_artifact_id: input.stage2ArtifactId,
      stage2_artifact_sha256: input.stage2ArtifactSha256,
      stage3_artifact_id: input.stage3ArtifactId,
      stage3_artifact_sha256: input.stage3ArtifactSha256,
      validation_report_artifact_id: input.validationReportArtifactId,
      validation_report_sha256: input.validationReportSha256,
      approval_gate_id: input.approvalGateId,
    });
  }

  // ===========================================================================
  // Milestone M6B: Stages 5–9 Workbench, Agent Profiles, CRs & AC-11b Views
  // ===========================================================================

  public async bootstrapPipelineProject(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    repoPath?: string;
    trustedAcceptanceDir?: string;
    extraProtectedPaths?: readonly string[];
    scaffoldFiles?: Readonly<Record<string, string>>;
    acceptanceSpecs?: Parameters<CoreApiService["bootstrapPipelineProject"]>[2]["acceptance_specs"];
  }): Promise<Awaited<ReturnType<CoreApiService["bootstrapPipelineProject"]>>> {
    return this.coreApi.bootstrapPipelineProject(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      repo_path: input.repoPath,
      trusted_acceptance_dir: input.trustedAcceptanceDir,
      extra_protected_paths: input.extraProtectedPaths,
      scaffold_files: input.scaffoldFiles,
      acceptance_specs: input.acceptanceSpecs,
    });
  }

  public async listAgentOrganizationProfiles(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    role?: AgentOrgRole;
    activeOnly?: boolean;
  }): Promise<AgentOrganizationProfileRecord[]> {
    return this.coreApi.listAgentOrganizationProfiles(input.projectId, input.auth, {
      role: input.role,
      active_only: input.activeOnly,
    });
  }

  public async upsertAgentOrganizationProfile(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    profileId?: string;
    profileKey: string;
    role: AgentOrgRole;
    principalId: string;
    provider: string;
    model: string;
    executionTargetType: ExecutionTargetType;
    trustTier: TargetTrustTier;
    targetLocator?: string | null;
    capabilitiesJson?: Readonly<Record<string, unknown>>;
    isActive?: boolean;
  }): Promise<AgentOrganizationProfileRecord> {
    return this.coreApi.upsertAgentOrganizationProfile(input.projectId, input.auth, {
      profile_id: input.profileId,
      profile_key: input.profileKey,
      role: input.role,
      principal_id: input.principalId,
      provider: input.provider,
      model: input.model,
      execution_target_type: input.executionTargetType,
      trust_tier: input.trustTier,
      target_locator: input.targetLocator,
      capabilities_json: input.capabilitiesJson,
      is_active: input.isActive,
    });
  }

  public async validateStage6ReviewerPair(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    developerProfileId: string;
    reviewerProfileId: string;
  }): Promise<Awaited<ReturnType<CoreApiService["validateStage6ReviewerPair"]>>> {
    return this.coreApi.validateStage6ReviewerPair(input.projectId, input.auth, {
      developer_profile_id: input.developerProfileId,
      reviewer_profile_id: input.reviewerProfileId,
    });
  }

  public async runPipelineStage7Plan(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    costSessionId?: string;
    promptVersion?: string;
    maxTokens?: number;
    temperature?: number;
    maxReworkCycles?: number;
    modelConfig?: ModelProviderConfig;
  }): Promise<Awaited<ReturnType<CoreApiService["runPipelineStage7Plan"]>>> {
    return this.coreApi.runPipelineStage7Plan(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cost_session_id: input.costSessionId,
      prompt_version: input.promptVersion,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      max_rework_cycles: input.maxReworkCycles,
      model_config: input.modelConfig,
    });
  }

  public async loadM6BBundle(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
  }): Promise<M6BStages5To9Bundle> {
    return this.coreApi.getPipelineM6BBundle(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
    });
  }

  public async submitChangeRequest(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    crId?: string;
    crKey: string;
    title: string;
    rationale: string;
    impactedRequirementIds: readonly string[];
    impactedComponentIds?: readonly string[];
    proposedTasks: readonly ChangeRequestProposedTaskSpec[];
  }): Promise<ChangeRequestRecord> {
    return this.coreApi.submitPipelineChangeRequest(input.projectId, input.auth, {
      cr_id: input.crId,
      pipeline_session_id: input.pipelineSessionId,
      cr_key: input.crKey,
      title: input.title,
      rationale: input.rationale,
      impacted_requirement_ids: input.impactedRequirementIds,
      impacted_component_ids: input.impactedComponentIds,
      proposed_tasks: input.proposedTasks,
    });
  }

  public async decideChangeRequest(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId?: string;
    crId: string;
    decision: "APPROVED" | "REJECTED";
    decisionRationale?: string | null;
  }): Promise<ChangeRequestRecord> {
    return this.coreApi.decidePipelineChangeRequest(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cr_id: input.crId,
      decision: input.decision,
      decision_rationale: input.decisionRationale,
    });
  }

  public async applyChangeRequest(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId?: string;
    crId: string;
  }): Promise<Awaited<ReturnType<CoreApiService["applyPipelineChangeRequest"]>>> {
    return this.coreApi.applyPipelineChangeRequest(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      cr_id: input.crId,
    });
  }

  public async loadTraceabilityMatrix(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
  }): Promise<BidirectionalTraceabilityMatrix> {
    return this.coreApi.getPipelineTraceabilityMatrix(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
    });
  }

  public async issueReleasePackage(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
    notes?: string;
  }): Promise<ReleaseAcceptancePackageRecord> {
    return this.coreApi.issuePipelineReleasePackage(input.projectId, input.auth, {
      pipeline_session_id: input.pipelineSessionId,
      notes: input.notes,
    });
  }

  public renderAgentProfilesMarkdown(
    projectId: string,
    profiles: readonly AgentOrganizationProfileRecord[]
  ): string {
    const rows = profiles
      .map(
        (p) =>
          `| \`${p.profile_key}\` | ${p.role} | \`${p.principal_id}\` | ${p.provider}/${p.model} | \`${p.execution_target_type}\` | \`${p.trust_tier}\` | \`${String(p.is_active)}\` |`
      )
      .join("\n");
    return [
      `# Agent Organization Profiles — Project \`${projectId}\``,
      `| Key | Role | Principal | Provider/Model | Execution Target | Trust Tier | Active |`,
      `|---|---|---|---|---|---|---|`,
      rows,
    ].join("\n");
  }

  public renderAgentProfilesHtml(input: {
    projectId: string;
    profiles: readonly AgentOrganizationProfileRecord[];
    errorMessage?: string;
    pairValidationMessage?: string;
  }): string {
    const projectEnc = encodeURIComponent(input.projectId);
    const errorBannerHtml = input.errorMessage
      ? `<div role="alert" data-error-banner="true" class="error-banner">${escapeHtml(
          input.errorMessage
        )}</div>`
      : "";
    const pairStatusHtml = input.pairValidationMessage
      ? `<div role="status" data-pair-validation="valid">${escapeHtml(
          input.pairValidationMessage
        )}</div>`
      : "";
    const rows = input.profiles
      .map(
        (p) =>
          `<tr><td><code>${escapeHtml(p.profile_id)}</code></td><td><code>${escapeHtml(
            p.profile_key
          )}</code></td><td><code>${escapeHtml(p.role)}</code></td><td><code>${escapeHtml(
            p.principal_id
          )}</code></td><td>${escapeHtml(p.provider)}/${escapeHtml(
            p.model
          )}</td><td><code>${escapeHtml(
            p.execution_target_type
          )}</code></td><td><code>${escapeHtml(p.trust_tier)}</code></td><td><code>${escapeHtml(
            p.target_locator ?? "-"
          )}</code></td><td>${String(p.is_active)}</td></tr>`
      )
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>Agent Organization Profiles - ${escapeHtml(input.projectId)}</title>`,
      "</head>",
      "<body>",
      `<main data-project-id="${escapeHtml(input.projectId)}">`,
      `<h1>Agent Organization Profiles (${escapeHtml(input.projectId)})</h1>`,
      errorBannerHtml,
      pairStatusHtml,
      `<p><a href="/projects/${projectEnc}/pipeline-sessions">All Pipeline Sessions</a></p>`,
      "<section>",
      `<h2>Configured Profiles (${input.profiles.length})</h2>`,
      input.profiles.length > 0
        ? `<table><thead><tr><th>Profile ID</th><th>Key</th><th>Role</th><th>Principal</th><th>Provider/Model</th><th>Execution Target</th><th>Trust Tier</th><th>Target Locator</th><th>Active</th></tr></thead><tbody>${rows}</tbody></table>`
        : "<p>No agent organization profiles configured yet.</p>",
      "</section>",
      "<section>",
      "<h2>Create / Update Agent Profile (Stage 6)</h2>",
      `<form method="POST" action="/projects/${projectEnc}/agent-profiles">`,
      '<label>Profile Key <input type="text" name="profile_key" required></label>',
      '<label>Role <select name="role"><option value="PLANNER">PLANNER</option><option value="DEVELOPER" selected>DEVELOPER</option><option value="REVIEWER_READONLY">REVIEWER_READONLY</option><option value="VERIFIER">VERIFIER</option></select></label>',
      '<label>Principal ID <input type="text" name="principal_id" required></label>',
      '<label>Provider <input type="text" name="provider" required></label>',
      '<label>Model <input type="text" name="model" required></label>',
      '<label>Execution Target <select name="execution_target_type"><option value="factory_managed_worker" selected>factory_managed_worker</option><option value="user_managed_worker">user_managed_worker</option><option value="provider_managed_vm">provider_managed_vm</option><option value="remote_agent_session">remote_agent_session</option></select></label>',
      '<label>Trust Tier <select name="trust_tier"><option value="TIER_1_FACTORY_MANAGED" selected>TIER_1_FACTORY_MANAGED</option><option value="TIER_2_USER_MANAGED">TIER_2_USER_MANAGED</option><option value="TIER_3_PROVIDER_VM">TIER_3_PROVIDER_VM</option><option value="TIER_4_REMOTE_SESSION">TIER_4_REMOTE_SESSION</option></select></label>',
      '<label>Target Locator <input type="text" name="target_locator" placeholder="optional"></label>',
      '<label>Capabilities JSON <input type="text" name="capabilities_json" placeholder="{}"></label>',
      '<label>Active <select name="is_active"><option value="true" selected>true</option><option value="false">false</option></select></label>',
      '<button type="submit">Save Agent Profile</button>',
      "</form>",
      "</section>",
      "<section>",
      "<h2>Validate Stage 6 3D Reviewer Separation Pair</h2>",
      `<form method="POST" action="/projects/${projectEnc}/agent-profiles/validate-pair">`,
      '<label>Developer Profile ID <input type="text" name="developer_profile_id" required></label>',
      '<label>Reviewer Profile ID <input type="text" name="reviewer_profile_id" required></label>',
      '<button type="submit">Validate 3D Separation</button>',
      "</form>",
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public renderTraceabilityMatrixMarkdown(matrix: BidirectionalTraceabilityMatrix): string {
    const reqRows = matrix.requirement_rows
      .map((r) => {
        const taskSummary = r.stage8_lineage
          .map(
            (s) =>
              `${s.task_id}(${s.status}${s.merged_commit_hash ? `,commit=${s.merged_commit_hash.slice(0, 8)},main=${String(s.main_reachable)}` : ""})`
          )
          .join("; ");
        return `| \`${r.req_id}\` | ${r.stage1_item_ids.length} | ${r.ac_ids.join(", ") || "-"} | ${
          r.stage3_component_ids.join(", ") || "-"
        } | ${r.trusted_acceptance_test_files.join(", ") || "-"} | ${
          r.story_ids.length
        } | ${taskSummary || "-"} | ${r.applied_cr_ids.join(", ") || "-"} | \`${String(
          r.complete
        )}\` |`;
      })
      .join("\n");

    const missingRows = matrix.missing_links
      .map((m) => `- **${m.req_id}** [${m.stage}]: ${m.reason}`)
      .join("\n");
    const orphanRows = matrix.orphan_links
      .map((o) => `- **${o.entity_type}** (\`${o.entity_id}\`): ${o.reason}`)
      .join("\n");

    return [
      `## Bidirectional Traceability Matrix (AC-11b)`,
      `- **Baseline ID:** \`${matrix.baseline_id}\` | **Coverage:** **${matrix.coverage_percent}%** (${matrix.covered_requirements}/${matrix.total_requirements}) | **Complete:** \`${String(
        matrix.complete
      )}\` | **Digest:** \`${matrix.traceability_sha256}\``,
      "",
      "| Requirement | Stage 1 | ACs | Components | Trusted Tests | Stories | Stage 8 Tasks & Commits | Applied CRs | Complete |",
      "|---|---:|---|---|---|---:|---|---|---|",
      reqRows,
      missingRows ? `\n### Missing Links (${matrix.missing_links.length})\n${missingRows}` : "",
      orphanRows ? `\n### Orphan Links (${matrix.orphan_links.length})\n${orphanRows}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public renderTraceabilityMatrixHtml(matrix: BidirectionalTraceabilityMatrix): string {
    const projectEnc = encodeURIComponent(matrix.project_id);
    const sessionEnc = encodeURIComponent(matrix.pipeline_session_id);
    const rows = matrix.requirement_rows
      .map((r) => {
        const lineageLinks = r.stage8_lineage
          .map((s) => {
            const taskEnc = encodeURIComponent(s.task_id);
            return `<div><code>${escapeHtml(s.task_id)}</code> [<code>${escapeHtml(
              s.status
            )}</code>] mainReachable=${String(s.main_reachable)} <a href="/projects/${projectEnc}/tasks/${taskEnc}/approval-center">Approval Center</a> <a href="/projects/${projectEnc}/tasks/${taskEnc}/lineage">Lineage</a></div>`;
          })
          .join("");
        return `<tr><td><code>${escapeHtml(r.req_id)}</code><br>${escapeHtml(
          r.title
        )}</td><td>${escapeHtml(r.stage1_item_ids.join(", ") || "-")}</td><td>${escapeHtml(
          r.ac_ids.join(", ") || "-"
        )}</td><td>${escapeHtml(r.stage3_component_ids.join(", ") || "-")}</td><td>${escapeHtml(
          r.trusted_acceptance_test_files.join(", ") || "-"
        )}</td><td>${escapeHtml(r.story_ids.join(", ") || "-")}</td><td>${
          lineageLinks || "-"
        }</td><td>${escapeHtml(r.applied_cr_ids.join(", ") || "-")}</td><td><code>${String(
          r.complete
        )}</code></td><td>${escapeHtml(r.missing_links.join("; ") || "-")}</td></tr>`;
      })
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>AC-11b Traceability Matrix - ${escapeHtml(matrix.pipeline_session_id)}</title>`,
      "</head>",
      "<body>",
      `<main data-pipeline-session-id="${escapeHtml(matrix.pipeline_session_id)}">`,
      `<h1>AC-11b Bidirectional Traceability Matrix</h1>`,
      `<p>Baseline: <code>${escapeHtml(
        matrix.baseline_id
      )}</code> | Coverage: <strong>${matrix.coverage_percent}%</strong> (${
        matrix.covered_requirements
      }/${matrix.total_requirements}) | Complete: <strong>${String(
        matrix.complete
      )}</strong> | SHA-256: <code>${escapeHtml(matrix.traceability_sha256)}</code></p>`,
      `<p><a href="/projects/${projectEnc}/pipeline-sessions/${sessionEnc}/m6b">Back to Stage 5–9 Workbench</a></p>`,
      "<table><thead><tr><th>Requirement</th><th>Stage 1</th><th>ACs</th><th>Components</th><th>Trusted Tests</th><th>Stories</th><th>Stage 8 Lineages</th><th>Applied CRs</th><th>Complete</th><th>Missing</th></tr></thead>",
      `<tbody>${rows}</tbody></table>`,
      "</main>",
      "</body>",
      "</html>",
    ].join("\n");
  }

  public renderM6BBundleMarkdown(bundle: M6BStages5To9Bundle): string {
    const profileRows = bundle.agent_profiles
      .map(
        (p) =>
          `| \`${p.profile_key}\` | ${p.role} | \`${p.principal_id}\` | ${p.provider}/${p.model} | \`${p.execution_target_type}\` | \`${p.trust_tier}\` |`
      )
      .join("\n");
    const taskLinkById = new Map(bundle.stage7_plan.taskLinks.map((l) => [l.task_id, l] as const));
    const taskRows = bundle.stage7_plan.tasks
      .map((t) => {
        const link = taskLinkById.get(t.task_id);
        return `| \`${t.task_id}\` | ${t.title} | \`${t.status}\` | \`${
          link?.cr_id ?? "stage7"
        }\` | ${link?.requirement_ids.join(", ") ?? "-"} | \`${
          link?.assigned_profile_id ?? "-"
        }\` |`;
      })
      .join("\n");
    const crRows = bundle.change_requests
      .map(
        (cr) =>
          `| \`${cr.cr_key}\` | ${cr.title} | \`${cr.status}\` | ${cr.impacted_requirement_ids.join(
            ", "
          )} | \`${cr.cr_sha256}\` |`
      )
      .join("\n");
    const relRows = bundle.release_packages
      .map(
        (rp) =>
          `| \`${rp.release_id}\` | ${rp.coverage_percent}% | \`${rp.main_head_commit_hash}\` | \`${rp.package_sha256}\` | \`${rp.accepted_by_principal_id}\` |`
      )
      .join("\n");

    return [
      `# M6B Stages 5–9 Workbench — Session \`${bundle.pipeline_session_id}\``,
      `- **Project:** \`${bundle.project_id}\` | **Baseline ID:** \`${bundle.baseline.baseline_id}\` | **Freeze SHA-256:** \`${bundle.baseline.freeze_bundle_sha256}\``,
      "",
      "## Stage 5 Project Bootstrap",
      bundle.bootstrap
        ? [
            `- **Bootstrap ID:** \`${bundle.bootstrap.bootstrap_id}\``,
            `- **Repo Path:** \`${bundle.bootstrap.repo_path}\``,
            `- **Trusted Acceptance Dir:** \`${bundle.bootstrap.trusted_acceptance_dir}\``,
            `- **Base Main Commit:** \`${bundle.bootstrap.base_main_commit_hash}\``,
            `- **Trusted Policy SHA-256:** \`${bundle.bootstrap.trusted_policy_sha256}\``,
            `- **Acceptance Tests:** ${bundle.bootstrap.acceptance_tests.length}`,
          ].join("\n")
        : "- Not bootstrapped yet",
      "",
      "## Stage 6 Agent Organization Profiles",
      "| Key | Role | Principal | Provider/Model | Target Type | Trust Tier |",
      "|---|---|---|---|---|---|",
      profileRows,
      "",
      `## Stage 7 Development Plan (Milestones=${bundle.stage7_plan.milestones.length}, Epics=${bundle.stage7_plan.epics.length}, Stories=${bundle.stage7_plan.stories.length}, Tasks=${bundle.stage7_plan.tasks.length})`,
      "| Task ID | Title | Status | Source | Requirements | Profile |",
      "|---|---|---|---|---|---|",
      taskRows,
      "",
      `## Stage 9 Change Requests (${bundle.change_requests.length})`,
      "| CR Key | Title | Status | Impacted Reqs | CR SHA-256 |",
      "|---|---|---|---|---|",
      crRows,
      "",
      this.renderTraceabilityMatrixMarkdown(bundle.traceability),
      "",
      `## Stage 9 Release Acceptance Packages (${bundle.release_packages.length})`,
      "| Release ID | Coverage | Main HEAD | Package SHA-256 | Accepted By |",
      "|---|---:|---|---|---|",
      relRows,
    ].join("\n");
  }

  public renderM6BBundleHtml(
    bundle: M6BStages5To9Bundle,
    options?: { readonly errorMessage?: string }
  ): string {
    const projectEnc = encodeURIComponent(bundle.project_id);
    const sessionEnc = encodeURIComponent(bundle.pipeline_session_id);
    const baseActionUrl = `/projects/${projectEnc}/pipeline-sessions/${sessionEnc}`;
    const errorBannerHtml = options?.errorMessage
      ? `<div role="alert" data-error-banner="true" class="error-banner">${escapeHtml(
          options.errorMessage
        )}</div>`
      : "";

    const boot = bundle.bootstrap;
    const acceptanceRows = (boot?.acceptance_tests ?? [])
      .map(
        (t) =>
          `<tr><td><code>${escapeHtml(t.ac_id)}</code></td><td><code>${escapeHtml(
            t.req_id
          )}</code></td><td><code>${escapeHtml(
            t.test_file_path
          )}</code></td><td>${escapeHtml(t.component_ids.join(", ") || "-")}</td><td>${escapeHtml(
            t.expected_deliverables.join(", ") || "-"
          )}</td></tr>`
      )
      .join("");

    const profileRows = bundle.agent_profiles
      .map(
        (p) =>
          `<tr><td><code>${escapeHtml(p.profile_key)}</code></td><td><code>${escapeHtml(
            p.role
          )}</code></td><td><code>${escapeHtml(p.principal_id)}</code></td><td>${escapeHtml(
            p.provider
          )}/${escapeHtml(p.model)}</td><td><code>${escapeHtml(
            p.execution_target_type
          )}</code></td><td><code>${escapeHtml(p.trust_tier)}</code></td><td>${String(
            p.is_active
          )}</td></tr>`
      )
      .join("");

    const taskLinkById = new Map(bundle.stage7_plan.taskLinks.map((l) => [l.task_id, l] as const));
    const storyById = new Map(bundle.stage7_plan.stories.map((s) => [s.story_id, s] as const));
    const epicById = new Map(bundle.stage7_plan.epics.map((e) => [e.epic_id, e] as const));

    const storyRows = bundle.stage7_plan.stories
      .map((s) => {
        const epic = epicById.get(s.epic_id);
        return `<li><strong>${escapeHtml(s.story_key)}</strong> (${escapeHtml(
          epic?.epic_key ?? "-"
        )}): ${escapeHtml(s.title)} — reqs=[${escapeHtml(
          s.requirement_ids.join(", ")
        )}] acs=[${escapeHtml(s.ac_ids.join(", "))}]</li>`;
      })
      .join("");

    const taskRows = bundle.stage7_plan.tasks
      .map((t) => {
        const link = taskLinkById.get(t.task_id);
        const story = link?.story_id ? storyById.get(link.story_id) : undefined;
        const taskEnc = encodeURIComponent(t.task_id);
        return `<tr><td><code>${escapeHtml(t.task_id)}</code></td><td>${escapeHtml(
          t.title
        )}</td><td><code>${escapeHtml(t.status)}</code></td><td><code>${escapeHtml(
          story?.story_key ?? "-"
        )}</code></td><td><code>${escapeHtml(
          link?.cr_id ?? "-"
        )}</code></td><td>${escapeHtml(
          link?.requirement_ids.join(", ") ?? "-"
        )}</td><td><a href="/projects/${projectEnc}/tasks/${taskEnc}/approval-center">Approval Center</a> | <a href="/projects/${projectEnc}/tasks/${taskEnc}/lineage">Lineage</a></td></tr>`;
      })
      .join("");

    const crRows = bundle.change_requests
      .map((cr) => {
        const crEnc = encodeURIComponent(cr.cr_id);
        let actionHtml = "<code>-</code>";
        if (cr.status === "PENDING_APPROVAL") {
          actionHtml = `<form method="POST" action="${baseActionUrl}/change-requests/${crEnc}/decide" style="display:inline"><input type="hidden" name="decision" value="APPROVED"><input type="text" name="decision_rationale" placeholder="Rationale"><button type="submit">Approve CR</button></form> <form method="POST" action="${baseActionUrl}/change-requests/${crEnc}/decide" style="display:inline"><input type="hidden" name="decision" value="REJECTED"><input type="text" name="decision_rationale" placeholder="Rejection reason"><button type="submit">Reject CR</button></form>`;
        } else if (cr.status === "APPROVED") {
          actionHtml = `<form method="POST" action="${baseActionUrl}/change-requests/${crEnc}/apply" style="display:inline"><button type="submit">Apply CR</button></form>`;
        }
        return `<tr><td><code>${escapeHtml(cr.cr_key)}</code><br><small><code>${escapeHtml(
          cr.cr_id
        )}</code></small></td><td>${escapeHtml(cr.title)}</td><td><code>${escapeHtml(
          cr.status
        )}</code></td><td>${escapeHtml(
          cr.impacted_requirement_ids.join(", ")
        )}</td><td><code>${escapeHtml(cr.cr_sha256)}</code></td><td>${actionHtml}</td></tr>`;
      })
      .join("");

    const trace = bundle.traceability;
    const traceRows = trace.requirement_rows
      .map((r) => {
        const stage8Html = r.stage8_lineage
          .map((s) => {
            const taskEnc = encodeURIComponent(s.task_id);
            return `<div><code>${escapeHtml(s.task_id)}</code> [<code>${escapeHtml(
              s.status
            )}</code>] commit=<code>${escapeHtml(
              s.merged_commit_hash ?? "none"
            )}</code> mainReachable=<strong>${String(
              s.main_reachable
            )}</strong> <a href="/projects/${projectEnc}/tasks/${taskEnc}/approval-center">Approval Center</a> <a href="/projects/${projectEnc}/tasks/${taskEnc}/lineage">Lineage</a></div>`;
          })
          .join("");
        return `<tr><td><code>${escapeHtml(r.req_id)}</code><br>${escapeHtml(
          r.title
        )}</td><td>${escapeHtml(r.stage1_item_ids.join(", ") || "-")}</td><td>${escapeHtml(
          r.ac_ids.join(", ") || "-"
        )}</td><td>${escapeHtml(r.stage3_component_ids.join(", ") || "-")}</td><td>${escapeHtml(
          r.trusted_acceptance_test_files.join(", ") || "-"
        )}</td><td>${escapeHtml(r.story_ids.join(", ") || "-")}</td><td>${
          stage8Html || "-"
        }</td><td>${escapeHtml(r.applied_cr_ids.join(", ") || "-")}</td><td><code>${String(
          r.complete
        )}</code></td><td>${escapeHtml(r.missing_links.join("; ") || "-")}</td></tr>`;
      })
      .join("");

    const releaseRows = bundle.release_packages
      .map(
        (rp) =>
          `<tr><td><code>${escapeHtml(rp.release_id)}</code></td><td><strong>${
            rp.coverage_percent
          }%</strong> (${String(rp.complete)})</td><td><code>${escapeHtml(
            rp.main_head_commit_hash
          )}</code></td><td><code>${escapeHtml(
            rp.package_sha256
          )}</code></td><td><code>${escapeHtml(
            rp.accepted_by_principal_id
          )}</code></td><td><code>${escapeHtml(rp.accepted_at)}</code></td></tr>`
      )
      .join("");

    return [
      "<!DOCTYPE html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>M6B Workbench - ${escapeHtml(bundle.pipeline_session_id)}</title>`,
      "</head>",
      "<body>",
      `<main data-m6b-session-id="${escapeHtml(bundle.pipeline_session_id)}">`,
      `<h1>M6B Stages 5–9 &amp; AC-11b Traceability Workbench</h1>`,
      `<p>Project: <code>${escapeHtml(bundle.project_id)}</code> | Session: <code>${escapeHtml(
        bundle.pipeline_session_id
      )}</code> | Frozen Baseline: <code>${escapeHtml(
        bundle.baseline.baseline_id
      )}</code> | Freeze SHA-256: <code>${escapeHtml(
        bundle.baseline.freeze_bundle_sha256
      )}</code></p>`,
      errorBannerHtml,
      `<nav><a href="/projects/${projectEnc}/pipeline-sessions">All Pipeline Sessions</a> | <a href="${baseActionUrl}">Stages 1–4 Console</a> | <a href="/projects/${projectEnc}/agent-profiles">Agent Org Profiles</a> | <a href="${baseActionUrl}/traceability">Standalone Traceability Matrix</a></nav>`,
      '<section data-workbench="stage5-bootstrap">',
      "<h2>Stage 5: Project Bootstrap &amp; Trusted Acceptance Tests</h2>",
      boot
        ? `<div><p>Bootstrap ID: <code>${escapeHtml(
            boot.bootstrap_id
          )}</code> | Repo Path: <code>${escapeHtml(
            boot.repo_path
          )}</code> | Trusted Acceptance Dir: <code>${escapeHtml(
            boot.trusted_acceptance_dir
          )}</code> | Base Main Commit: <code>${escapeHtml(
            boot.base_main_commit_hash
          )}</code></p><p>Trusted Policy SHA-256: <code>${escapeHtml(
            boot.trusted_policy_sha256
          )}</code> | Bootstrap SHA-256: <code>${escapeHtml(
            boot.bootstrap_sha256
          )}</code></p><p>Protected Paths: ${boot.protected_paths
            .map((p) => `<code>${escapeHtml(p)}</code>`)
            .join(", ")}</p><table><thead><tr><th>AC ID</th><th>Req ID</th><th>Test File</th><th>Components</th><th>Expected Deliverables</th></tr></thead><tbody>${acceptanceRows}</tbody></table></div>`
        : "<p>Project has not been bootstrapped yet.</p>",
      `<form method="POST" action="${baseActionUrl}/bootstrap">`,
      '<label>Repo Path <input type="text" name="repo_path" placeholder="optional"></label>',
      '<label>Trusted Acceptance Dir <input type="text" name="trusted_acceptance_dir" placeholder="optional"></label>',
      '<label>Extra Protected Paths (comma-separated) <input type="text" name="extra_protected_paths" placeholder="optional"></label>',
      '<button type="submit">Run Stage 5 Bootstrap</button>',
      "</form>",
      "</section>",
      '<section data-workbench="stage6-profiles">',
      `<h2>Stage 6: Agent Organization Profiles (${bundle.agent_profiles.length})</h2>`,
      `<p><a href="/projects/${projectEnc}/agent-profiles">Manage Agent Org Profiles &amp; 3D Separation</a></p>`,
      bundle.agent_profiles.length > 0
        ? `<table><thead><tr><th>Key</th><th>Role</th><th>Principal</th><th>Provider/Model</th><th>Execution Target</th><th>Trust Tier</th><th>Active</th></tr></thead><tbody>${profileRows}</tbody></table>`
        : "<p>No agent organization profiles configured.</p>",
      "</section>",
      '<section data-workbench="stage7-plan">',
      `<h2>Stage 7: Development Plan &amp; Materialized Stage 8 Tasks</h2>`,
      `<p>Milestones: <strong>${bundle.stage7_plan.milestones.length}</strong> | Epics: <strong>${bundle.stage7_plan.epics.length}</strong> | Stories: <strong>${bundle.stage7_plan.stories.length}</strong> | Tasks: <strong>${bundle.stage7_plan.tasks.length}</strong></p>`,
      `<form method="POST" action="${baseActionUrl}/stage7/plan">`,
      '<label>Prompt Version <input type="text" name="prompt_version" placeholder="1.0.0"></label>',
      '<label>Max Tokens <input type="number" name="max_tokens" placeholder="8192"></label>',
      '<label>Temperature <input type="number" step="0.1" name="temperature" placeholder="0"></label>',
      '<label>Max Rework Cycles <input type="number" name="max_rework_cycles" placeholder="3"></label>',
      '<button type="submit">Run Stage 7 Planning</button>',
      "</form>",
      storyRows ? `<ul>${storyRows}</ul>` : "",
      bundle.stage7_plan.tasks.length > 0
        ? `<table><thead><tr><th>Task ID</th><th>Title</th><th>Status</th><th>Story</th><th>CR ID</th><th>Requirements</th><th>Links</th></tr></thead><tbody>${taskRows}</tbody></table>`
        : "<p>No Stage 8 tasks materialized yet.</p>",
      "</section>",
      '<section data-workbench="stage9-change-requests">',
      `<h2>Stage 9: Post-Freeze Change Requests (${bundle.change_requests.length})</h2>`,
      bundle.change_requests.length > 0
        ? `<table><thead><tr><th>CR Key</th><th>Title</th><th>Status</th><th>Impacted Reqs</th><th>CR SHA-256</th><th>Actions</th></tr></thead><tbody>${crRows}</tbody></table>`
        : "<p>No change requests submitted.</p>",
      `<form method="POST" action="${baseActionUrl}/change-requests">`,
      '<label>CR Key <input type="text" name="cr_key" required placeholder="CR-001"></label>',
      '<label>Title <input type="text" name="title" required></label>',
      '<label>Rationale <input type="text" name="rationale" required></label>',
      '<label>Impacted Requirement IDs (comma-separated or JSON) <input type="text" name="impacted_requirement_ids" required></label>',
      '<label>Impacted Component IDs (optional) <input type="text" name="impacted_component_ids"></label>',
      '<label>Proposed Tasks JSON <textarea name="proposed_tasks" required placeholder=\'[{"task_key":"TASK-CR-1","title":"...","description":"...","requirement_ids":["REQ-FUNC-001"],"ac_ids":["AC-FUNC-1"],"allowed_files":["src/index.js"]}]\'></textarea></label>',
      '<button type="submit">Submit Change Request</button>',
      "</form>",
      "</section>",
      '<section data-workbench="ac11b-traceability">',
      "<h2>AC-11b: Bidirectional Traceability Matrix</h2>",
      `<p>Coverage: <strong>${trace.coverage_percent}%</strong> (${trace.covered_requirements}/${trace.total_requirements}) | Complete: <strong>${String(
        trace.complete
      )}</strong> | Digest: <code>${escapeHtml(trace.traceability_sha256)}</code></p>`,
      `<table><thead><tr><th>Requirement</th><th>Stage 1</th><th>ACs</th><th>Components</th><th>Trusted Tests</th><th>Stories</th><th>Stage 8 Tasks &amp; Commits</th><th>Applied CRs</th><th>Complete</th><th>Missing</th></tr></thead><tbody>${traceRows}</tbody></table>`,
      trace.missing_links.length > 0
        ? `<h3>Missing Links (${trace.missing_links.length})</h3><ul>${trace.missing_links
            .map(
              (m) =>
                `<li><code>${escapeHtml(m.req_id)}</code> [<code>${escapeHtml(
                  m.stage
                )}</code>]: ${escapeHtml(m.reason)}</li>`
            )
            .join("")}</ul>`
        : "",
      trace.orphan_links.length > 0
        ? `<h3>Orphan Links (${trace.orphan_links.length})</h3><ul>${trace.orphan_links
            .map(
              (o) =>
                `<li><code>${escapeHtml(o.entity_type)}</code> (<code>${escapeHtml(
                  o.entity_id
                )}</code>): ${escapeHtml(o.reason)}</li>`
            )
            .join("")}</ul>`
        : "",
      "</section>",
      '<section data-workbench="release-acceptance">',
      `<h2>Stage 9: Release Acceptance Packages (${bundle.release_packages.length})</h2>`,
      bundle.release_packages.length > 0
        ? `<table><thead><tr><th>Release ID</th><th>Coverage</th><th>Main HEAD</th><th>Package SHA-256</th><th>Accepted By</th><th>Accepted At</th></tr></thead><tbody>${releaseRows}</tbody></table>`
        : "<p>No release acceptance package issued yet.</p>",
      `<form method="POST" action="${baseActionUrl}/release-package">`,
      '<label>Release Notes <input type="text" name="notes" placeholder="Sign-off notes"></label>',
      '<button type="submit">Issue Release Acceptance Package</button>',
      "</form>",
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

export interface WebApprovalConsoleHttpServerOptions {
  readonly controller?: WebApprovalConsoleController;
  readonly coreApi?: CoreApiService;
  readonly host?: string;
  readonly port?: number;
}

function mapErrorToHttpPayload(err: unknown): {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
} {
  if (err instanceof WebBadRequestError || err instanceof SyntaxError) {
    return {
      statusCode: 400,
      body: {
        error_code: "ERR_BAD_REQUEST",
        reason: err.message,
      },
    };
  }
  if (err instanceof CostBudgetExceededError) {
    return {
      statusCode: 402,
      body: {
        error_code: err.code,
        limit_scope: err.limitScope,
        cost_session_id: err.costSessionId,
        ledger_id: err.ledgerId,
        details: err.details,
        reason: err.message,
      },
    };
  }
  if (err instanceof StructuredOutputValidationError) {
    return {
      statusCode: 422,
      body: {
        error_code: err.code,
        validation_errors: err.validationErrors,
        reason: err.message,
      },
    };
  }
  if (err instanceof PromptVersionConflictError) {
    return {
      statusCode: 409,
      body: {
        error_code: err.code,
        prompt_id: err.promptId,
        version: err.version,
        reason: err.message,
      },
    };
  }
  if (err instanceof PromptNotFoundError) {
    return {
      statusCode: 404,
      body: {
        error_code: err.code,
        prompt_id: err.promptId,
        version: err.version,
        reason: err.message,
      },
    };
  }
  if (err instanceof PromptRenderError) {
    return {
      statusCode: 400,
      body: {
        error_code: err.code,
        reason: err.message,
      },
    };
  }
  if (err instanceof ModelProviderConfigurationError) {
    return {
      statusCode: 503,
      body: {
        error_code: err.code,
        provider: err.provider,
        reason: err.message,
      },
    };
  }
  if (err instanceof ModelProviderHttpError) {
    return {
      statusCode: 502,
      body: {
        error_code: "ERR_MODEL_PROVIDER_UPSTREAM",
        provider: err.provider,
        upstream_status: err.statusCode,
        reason: err.message,
      },
    };
  }
  if (err instanceof Ac10ViolationError) {
    return {
      statusCode: 422,
      body: {
        error_code: err.code,
        sqlState: err.sqlState,
        offending_item_ids: err.offendingItemIds,
        reason: err.message,
      },
    };
  }

  const shaped = err as {
    code?: string;
    sqlState?: string;
    message?: string;
    offendingItemIds?: readonly string[];
  };
  if (shaped.code === "ERR_AC10_UNCONFIRMED_ASSUMPTION") {
    return {
      statusCode: 422,
      body: {
        error_code: "ERR_AC10_UNCONFIRMED_ASSUMPTION",
        sqlState: shaped.sqlState ?? "23514",
        offending_item_ids: shaped.offendingItemIds ?? [],
        reason: shaped.message ?? "AC-10 unconfirmed assumption violation",
      },
    };
  }
  if (shaped.code === "ERR_APPROVAL_EXPIRED_OR_STALE") {
    return {
      statusCode: 409,
      body: {
        error_code: "ERR_APPROVAL_EXPIRED_OR_STALE",
        reason: shaped.message ?? "Approval request expired or stale",
      },
    };
  }
  if (shaped.sqlState === "42501") {
    return {
      statusCode: 403,
      body: {
        error_code: "ERR_FORBIDDEN_RLS",
        sqlState: "42501",
        reason: shaped.message ?? "Forbidden",
      },
    };
  }
  if (shaped.sqlState === "23503") {
    return {
      statusCode: 404,
      body: {
        error_code: "ERR_NOT_FOUND_FK",
        sqlState: "23503",
        reason: shaped.message ?? "Not found",
      },
    };
  }
  if (shaped.sqlState === "23505") {
    return {
      statusCode: 409,
      body: {
        error_code: "ERR_CONFLICT_UNIQUE",
        sqlState: "23505",
        reason: shaped.message ?? "Unique constraint conflict",
      },
    };
  }
  if (shaped.sqlState === "23514") {
    return {
      statusCode: 422,
      body: {
        error_code: "ERR_CHECK_VIOLATION",
        sqlState: "23514",
        reason: shaped.message ?? "Validation constraint violated",
      },
    };
  }
  return {
    statusCode: 500,
    body: {
      error_code: "ERR_INTERNAL",
      reason: err instanceof Error ? err.message : String(err),
    },
  };
}

function optionalStringField(val: unknown, fieldName: string): string | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (typeof val !== "string") {
    throw new WebBadRequestError(`${fieldName} must be a string`);
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalFiniteNumberField(
  val: unknown,
  isFormUrlEncoded: boolean,
  fieldName: string
): number | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new WebBadRequestError(`${fieldName} must be a finite number`);
    }
    return val;
  }
  if (isFormUrlEncoded && typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new WebBadRequestError(`${fieldName} must be a finite number`);
    }
    return parsed;
  }
  throw new WebBadRequestError(`${fieldName} must be a number`);
}

function optionalModelConfigField(
  val: unknown,
  isFormUrlEncoded: boolean
): ModelProviderConfig | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (isFormUrlEncoded && typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return sanitizeWebModelConfig(JSON.parse(trimmed));
    } catch (err) {
      if (err instanceof WebBadRequestError) {
        throw err;
      }
      throw new WebBadRequestError("model_config form field must contain valid JSON");
    }
  }
  return sanitizeWebModelConfig(val);
}

function optionalBooleanField(
  val: unknown,
  isFormUrlEncoded: boolean,
  fieldName: string
): boolean | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (typeof val === "boolean") {
    return val;
  }
  if (isFormUrlEncoded && typeof val === "string") {
    const lower = val.trim().toLowerCase();
    if (lower === "true" || lower === "1" || lower === "on") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "off") {
      return false;
    }
  }
  throw new WebBadRequestError(`${fieldName} must be a boolean`);
}

function optionalStringArrayField(
  val: unknown,
  isFormUrlEncoded: boolean,
  fieldName: string
): string[] | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (Array.isArray(val)) {
    const out: string[] = [];
    for (const entry of val) {
      if (typeof entry !== "string" || !entry.trim()) {
        throw new WebBadRequestError(`${fieldName} entries must be non-empty strings`);
      }
      out.push(entry.trim());
    }
    return out;
  }
  if (isFormUrlEncoded && typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new WebBadRequestError(`${fieldName} JSON array is malformed`);
      }
      return optionalStringArrayField(parsed, false, fieldName);
    }
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  throw new WebBadRequestError(`${fieldName} must be an array of strings`);
}

function optionalJsonValueField<T>(
  val: unknown,
  isFormUrlEncoded: boolean,
  fieldName: string
): T | undefined {
  if (val === undefined || val === null || val === "") {
    return undefined;
  }
  if (isFormUrlEncoded && typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new WebBadRequestError(`${fieldName} form field must contain valid JSON`);
    }
  }
  return val as T;
}

/**
 * Live HTTP Web Approval Console & Lineage Viewer Server (`M5` + `M6A` + `M6B`).
 * Renders Approval Center, Candidate-Bound Lineage, Stages 1-4 Pipeline Workbench,
 * Stage 6 Agent Org Profiles, and Stages 5-9 & AC-11b Traceability Workbench
 * (`HTML`/`Markdown`/`JSON`) and enforces RBAC / fail-closed constraints over HTTP.
 */
export class WebApprovalConsoleHttpServer {
  private readonly controller: WebApprovalConsoleController;
  private readonly host: string;
  private readonly port: number;
  private server: Server | null = null;

  constructor(options: WebApprovalConsoleHttpServerOptions) {
    if (options.controller) {
      this.controller = options.controller;
    } else if (options.coreApi) {
      this.controller = new WebApprovalConsoleController(options.coreApi);
    } else {
      throw new Error("WebApprovalConsoleHttpServer requires controller or coreApi");
    }
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
  }

  public async start(): Promise<{ port: number; baseUrl: string }> {
    if (this.server) {
      throw new Error("WebApprovalConsoleHttpServer already started");
    }
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const addr = this.server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Unexpected WebApprovalConsoleHttpServer address");
    }
    return {
      port: addr.port,
      baseUrl: `http://${this.host}:${addr.port}`,
    };
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const srv = this.server;
    this.server = null;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private sendBody(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
    res.writeHead(statusCode, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    });
    res.end(body);
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    this.sendBody(res, statusCode, "application/json", JSON.stringify(body));
  }

  private sendRedirect(res: ServerResponse, location: string): void {
    res.writeHead(303, {
      Location: location,
      "Content-Length": 0,
      Connection: "close",
    });
    res.end();
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const payload = await this.readRequestPayload<Record<string, unknown>>(req);
    return payload.data as T;
  }

  private async readRequestPayload<T extends Record<string, unknown>>(
    req: IncomingMessage
  ): Promise<{ readonly data: T; readonly isFormUrlEncoded: boolean }> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 1_048_576) {
        throw new WebBadRequestError("Request body too large");
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(raw);
      const parsed: Record<string, string> = {};
      for (const [k, v] of params.entries()) {
        parsed[k] = v;
      }
      return { data: parsed as T, isFormUrlEncoded: true };
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return { data: {} as T, isFormUrlEncoded: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new SyntaxError("Malformed JSON request body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WebBadRequestError("JSON request body must be an object");
    }
    return { data: parsed as T, isFormUrlEncoded: false };
  }

  private prefersHtmlResponse(
    req: IncomingMessage,
    url: URL,
    isFormUrlEncoded: boolean
  ): boolean {
    if (!isFormUrlEncoded) {
      return false;
    }
    if (url.searchParams.get("format") === "json") {
      return false;
    }
    const accept = String(req.headers.accept ?? "").toLowerCase();
    return !accept.includes("application/json");
  }

  private async sendPipelineErrorResponse(input: {
    res: ServerResponse;
    err: unknown;
    preferHtml: boolean;
    auth?: CoreApiAuthContext;
    projectId?: string;
    pipelineSessionId?: string;
    errorView?: "pipeline" | "m6b" | "agent-profiles";
  }): Promise<void> {
    const mapped = mapErrorToHttpPayload(input.err);
    if (!input.preferHtml) {
      this.sendJson(input.res, mapped.statusCode, mapped.body);
      return;
    }

    const reasonText = `${String(mapped.body.error_code ?? "ERROR")}: ${String(
      mapped.body.reason ?? "Request failed"
    )}`;
    if (input.errorView === "agent-profiles" && input.auth && input.projectId) {
      try {
        const profiles = await this.controller.listAgentOrganizationProfiles({
          auth: input.auth,
          projectId: input.projectId,
        });
        this.sendBody(
          input.res,
          mapped.statusCode,
          "text/html; charset=utf-8",
          this.controller.renderAgentProfilesHtml({
            projectId: input.projectId,
            profiles,
            errorMessage: reasonText,
          })
        );
        return;
      } catch {
        // Fall through to generic HTML error banner
      }
    }
    if (
      input.errorView === "m6b" &&
      input.auth &&
      input.projectId &&
      input.pipelineSessionId
    ) {
      try {
        const m6bBundle = await this.controller.loadM6BBundle({
          auth: input.auth,
          projectId: input.projectId,
          pipelineSessionId: input.pipelineSessionId,
        });
        this.sendBody(
          input.res,
          mapped.statusCode,
          "text/html; charset=utf-8",
          this.controller.renderM6BBundleHtml(m6bBundle, { errorMessage: reasonText })
        );
        return;
      } catch {
        // Baseline may not be frozen yet; try loading Stages 1-4 pipeline bundle below
      }
    }
    if (input.auth && input.projectId && input.pipelineSessionId) {
      try {
        const bundle = await this.controller.loadPipelineBundle({
          auth: input.auth,
          projectId: input.projectId,
          pipelineSessionId: input.pipelineSessionId,
        });
        if (bundle) {
          this.sendBody(
            input.res,
            mapped.statusCode,
            "text/html; charset=utf-8",
            this.controller.renderPipelineBundleHtml(bundle, { errorMessage: reasonText })
          );
          return;
        }
      } catch {
        // Ignore reload error and fall through to generic HTML error banner
      }
    }
    if (input.auth && input.projectId && !input.pipelineSessionId) {
      try {
        const sessions = await this.controller.listPipelineSessions({
          auth: input.auth,
          projectId: input.projectId,
        });
        this.sendBody(
          input.res,
          mapped.statusCode,
          "text/html; charset=utf-8",
          this.controller.renderPipelineProjectListHtml({
            projectId: input.projectId,
            sessions,
            errorMessage: reasonText,
          })
        );
        return;
      } catch {
        // Ignore reload error and fall through to generic HTML error banner
      }
    }

    const fallbackHtml = [
      "<!DOCTYPE html>",
      '<html lang="en">',
      '<head><meta charset="utf-8"><title>Pipeline Error</title></head>',
      "<body>",
      "<main>",
      "<h1>Product Pipeline Error</h1>",
      `<div role="alert" data-error-banner="true" class="error-banner">${escapeHtml(reasonText)}</div>`,
      "</main>",
      "</body>",
      "</html>",
    ].join("\n");
    this.sendBody(input.res, mapped.statusCode, "text/html; charset=utf-8", fallbackHtml);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let errorHtmlContext: {
      preferHtml: boolean;
      auth?: CoreApiAuthContext;
      projectId?: string;
      pipelineSessionId?: string;
      errorView?: "pipeline" | "m6b" | "agent-profiles";
    } = { preferHtml: false };

    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", `http://${this.host}`);
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/health") {
        this.sendJson(res, 200, { ok: true, service: "web-approval-console" });
        return;
      }

      const auth = decodeCoreApiAuthHeader(req.headers[CORE_API_AUTH_HEADER]);
      if (!auth) {
        this.sendJson(res, 401, {
          error_code: "ERR_UNAUTHORIZED",
          reason: `Missing or invalid ${CORE_API_AUTH_HEADER} header`,
        });
        return;
      }

      const centerMatch = pathname.match(
        /^\/projects\/([^/]+)\/tasks\/([^/]+)\/approval-center$/
      );
      if (method === "GET" && centerMatch?.[1] && centerMatch?.[2]) {
        const projectId = decodeURIComponent(centerMatch[1]);
        const taskId = decodeURIComponent(centerMatch[2]);
        const repoPath = url.searchParams.get("repo_path") ?? undefined;
        const gitDir = url.searchParams.get("git_dir") ?? undefined;
        const bundle = await this.controller.loadApprovalCenterBundle({
          auth,
          projectId,
          taskId,
          repoPath,
          gitDir,
        });
        const format = url.searchParams.get("format") ?? "html";
        if (format === "json") {
          this.sendJson(res, 200, bundle);
          return;
        }
        if (format === "md") {
          this.sendBody(
            res,
            200,
            "text/markdown; charset=utf-8",
            this.controller.renderApprovalCenterSummaryMarkdown(bundle)
          );
          return;
        }
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderApprovalCenterHtml(bundle)
        );
        return;
      }

      const lineageMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/lineage$/);
      if (method === "GET" && lineageMatch?.[1] && lineageMatch?.[2]) {
        const projectId = decodeURIComponent(lineageMatch[1]);
        const taskId = decodeURIComponent(lineageMatch[2]);
        const repoPath = url.searchParams.get("repo_path") ?? undefined;
        const gitDir = url.searchParams.get("git_dir") ?? undefined;
        const lineage = await this.controller.loadCandidateLineage({
          auth,
          projectId,
          taskId,
          repoPath,
          gitDir,
        });
        const format = url.searchParams.get("format") ?? "html";
        if (format === "json") {
          this.sendJson(res, 200, lineage);
          return;
        }
        if (format === "md") {
          this.sendBody(
            res,
            200,
            "text/markdown; charset=utf-8",
            this.controller.renderCandidateLineageMarkdown(lineage)
          );
          return;
        }
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderCandidateLineageHtml(lineage)
        );
        return;
      }

      const approvalsMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/approvals$/);
      if (method === "POST" && approvalsMatch?.[1] && approvalsMatch?.[2]) {
        const projectId = decodeURIComponent(approvalsMatch[1]);
        const taskId = decodeURIComponent(approvalsMatch[2]);
        const body = await this.readJsonBody<{
          decision?: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
          feedback?: string;
          ttl_ms?: number;
          repo_path?: string;
          git_dir?: string;
          merge_candidate_id?: string;
          approval_request_id?: string;
          agent_commit_hash?: string;
          base_main_commit_hash?: string;
          verified_tree_hash?: string;
          merge_candidate_hash?: string;
          verification_run_id?: string;
          review_artifact_id?: string;
        }>(req);

        if (!body.decision) {
          this.sendJson(res, 400, {
            error_code: "ERR_BAD_REQUEST",
            reason: "decision is required",
          });
          return;
        }

        const hasExplicit8Fields = Boolean(
          body.merge_candidate_id &&
            body.agent_commit_hash &&
            body.base_main_commit_hash &&
            body.verified_tree_hash &&
            body.merge_candidate_hash &&
            body.verification_run_id &&
            body.review_artifact_id
        );

        let record: ApprovalDecisionRecord;
        if (hasExplicit8Fields) {
          record = await this.controller.coreApi.submitHumanApproval(projectId, auth, {
            task_id: taskId,
            merge_candidate_id: body.merge_candidate_id!,
            approval_request_id: body.approval_request_id,
            agent_commit_hash: body.agent_commit_hash!,
            base_main_commit_hash: body.base_main_commit_hash!,
            verified_tree_hash: body.verified_tree_hash!,
            merge_candidate_hash: body.merge_candidate_hash!,
            verification_run_id: body.verification_run_id!,
            review_artifact_id: body.review_artifact_id!,
            decision: body.decision,
            feedback: body.feedback,
            ttl_ms: body.ttl_ms,
            repo_path: body.repo_path,
            git_dir: body.git_dir,
          });
        } else {
          const bundle = await this.controller.loadApprovalCenterBundle({
            auth,
            projectId,
            taskId,
            repoPath: body.repo_path,
            gitDir: body.git_dir,
          });
          record = await this.controller.submitDecisionFromApprovalCenterView({
            auth,
            bundle,
            decision: body.decision,
            feedback: body.feedback,
            ttlMs: body.ttl_ms,
            repoPath: body.repo_path,
            gitDir: body.git_dir,
          });
        }

        this.sendJson(res, 201, record);
        return;
      }

      const pipelineListCreateMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions$/
      );
      if (pipelineListCreateMatch?.[1]) {
        const projectId = decodeURIComponent(pipelineListCreateMatch[1]);
        if (method === "GET") {
          const sessions = await this.controller.listPipelineSessions({ auth, projectId });
          const format = url.searchParams.get("format") ?? "html";
          if (format === "json") {
            this.sendJson(res, 200, { sessions });
            return;
          }
          const errorMessage = url.searchParams.get("error") ?? undefined;
          this.sendBody(
            res,
            200,
            "text/html; charset=utf-8",
            this.controller.renderPipelineProjectListHtml({
              projectId,
              sessions,
              errorMessage,
            })
          );
          return;
        }
        if (method === "POST") {
          const { data, isFormUrlEncoded } = await this.readRequestPayload<{
            pipeline_session_id?: string;
            cost_session_id?: string | null;
            cost_budget?: unknown;
            max_tokens_per_request?: unknown;
            max_cost_micro_usd_per_request?: unknown;
            session_token_budget?: unknown;
            session_cost_budget_micro_usd?: unknown;
            title?: unknown;
            raw_idea_text?: unknown;
          }>(req);
          const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
          errorHtmlContext = { preferHtml, auth, projectId };

          const title = optionalStringField(data.title, "title");
          const rawIdeaText = optionalStringField(data.raw_idea_text, "raw_idea_text");
          if (!title || !rawIdeaText) {
            throw new WebBadRequestError("title and raw_idea_text are required non-empty strings");
          }

          let costBudget:
            | {
                readonly cost_session_id?: string;
                readonly max_tokens_per_request: number;
                readonly max_cost_micro_usd_per_request: number;
                readonly session_token_budget: number;
                readonly session_cost_budget_micro_usd: number;
              }
            | undefined;

          if (data.cost_budget !== undefined && data.cost_budget !== null && data.cost_budget !== "") {
            let parsedBudget = data.cost_budget;
            if (isFormUrlEncoded && typeof parsedBudget === "string") {
              try {
                parsedBudget = JSON.parse(parsedBudget);
              } catch {
                throw new WebBadRequestError("cost_budget form field must be valid JSON");
              }
            }
            if (!parsedBudget || typeof parsedBudget !== "object" || Array.isArray(parsedBudget)) {
              throw new WebBadRequestError(
                "cost_budget must include numeric per-request and session token/cost budgets"
              );
            }
            const b = parsedBudget as Record<string, unknown>;
            const maxTok = optionalFiniteNumberField(
              b.max_tokens_per_request,
              false,
              "cost_budget.max_tokens_per_request"
            );
            const maxCost = optionalFiniteNumberField(
              b.max_cost_micro_usd_per_request,
              false,
              "cost_budget.max_cost_micro_usd_per_request"
            );
            const sessTok = optionalFiniteNumberField(
              b.session_token_budget,
              false,
              "cost_budget.session_token_budget"
            );
            const sessCost = optionalFiniteNumberField(
              b.session_cost_budget_micro_usd,
              false,
              "cost_budget.session_cost_budget_micro_usd"
            );
            if (
              maxTok === undefined ||
              maxCost === undefined ||
              sessTok === undefined ||
              sessCost === undefined
            ) {
              throw new WebBadRequestError(
                "cost_budget must include numeric per-request and session token/cost budgets"
              );
            }
            costBudget = {
              cost_session_id: optionalStringField(
                b.cost_session_id,
                "cost_budget.cost_session_id"
              ),
              max_tokens_per_request: maxTok,
              max_cost_micro_usd_per_request: maxCost,
              session_token_budget: sessTok,
              session_cost_budget_micro_usd: sessCost,
            };
          } else {
            const maxTok = optionalFiniteNumberField(
              data.max_tokens_per_request,
              isFormUrlEncoded,
              "max_tokens_per_request"
            );
            const maxCost = optionalFiniteNumberField(
              data.max_cost_micro_usd_per_request,
              isFormUrlEncoded,
              "max_cost_micro_usd_per_request"
            );
            const sessTok = optionalFiniteNumberField(
              data.session_token_budget,
              isFormUrlEncoded,
              "session_token_budget"
            );
            const sessCost = optionalFiniteNumberField(
              data.session_cost_budget_micro_usd,
              isFormUrlEncoded,
              "session_cost_budget_micro_usd"
            );
            if (
              maxTok !== undefined ||
              maxCost !== undefined ||
              sessTok !== undefined ||
              sessCost !== undefined
            ) {
              if (
                maxTok === undefined ||
                maxCost === undefined ||
                sessTok === undefined ||
                sessCost === undefined
              ) {
                throw new WebBadRequestError(
                  "All four budget fields (max_tokens_per_request, max_cost_micro_usd_per_request, session_token_budget, session_cost_budget_micro_usd) must be provided together"
                );
              }
              costBudget = {
                max_tokens_per_request: maxTok,
                max_cost_micro_usd_per_request: maxCost,
                session_token_budget: sessTok,
                session_cost_budget_micro_usd: sessCost,
              };
            }
          }

          const created = await this.controller.createPipelineSession({
            auth,
            projectId,
            pipelineSessionId: optionalStringField(
              data.pipeline_session_id,
              "pipeline_session_id"
            ),
            costSessionId: optionalStringField(data.cost_session_id, "cost_session_id") ?? null,
            costBudget,
            title,
            rawIdeaText,
          });
          if (preferHtml) {
            this.sendRedirect(
              res,
              `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
                created.session.pipeline_session_id
              )}`
            );
            return;
          }
          this.sendJson(res, 201, created);
          return;
        }
      }

      const pipelineSessionMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)$/
      );
      if (method === "GET" && pipelineSessionMatch?.[1] && pipelineSessionMatch?.[2]) {
        const projectId = decodeURIComponent(pipelineSessionMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineSessionMatch[2]);
        const bundle = await this.controller.loadPipelineBundle({
          auth,
          projectId,
          pipelineSessionId,
        });
        if (!bundle) {
          this.sendJson(res, 404, {
            error_code: "ERR_PIPELINE_SESSION_NOT_FOUND",
            reason: `Product pipeline session ${pipelineSessionId} not found in project ${projectId}`,
          });
          return;
        }
        const format = url.searchParams.get("format") ?? "html";
        if (format === "json") {
          this.sendJson(res, 200, bundle);
          return;
        }
        if (format === "md") {
          this.sendBody(
            res,
            200,
            "text/markdown; charset=utf-8",
            this.controller.renderPipelineBundleMarkdown(bundle)
          );
          return;
        }
        const errorMessage = url.searchParams.get("error") ?? undefined;
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderPipelineBundleHtml(bundle, { errorMessage })
        );
        return;
      }

      const pipelineStage1ExtractMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage1\/extract$/
      );
      if (
        method === "POST" &&
        pipelineStage1ExtractMatch?.[1] &&
        pipelineStage1ExtractMatch?.[2]
      ) {
        const projectId = decodeURIComponent(pipelineStage1ExtractMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineStage1ExtractMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          cost_session_id?: unknown;
          prompt_version?: unknown;
          max_tokens?: unknown;
          temperature?: unknown;
          model_config?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        const outcome = await this.controller.runPipelineStage1Extract({
          auth,
          projectId,
          pipelineSessionId,
          costSessionId: optionalStringField(data.cost_session_id, "cost_session_id"),
          promptVersion: optionalStringField(data.prompt_version, "prompt_version"),
          maxTokens: optionalFiniteNumberField(data.max_tokens, isFormUrlEncoded, "max_tokens"),
          temperature: optionalFiniteNumberField(
            data.temperature,
            isFormUrlEncoded,
            "temperature"
          ),
          modelConfig: optionalModelConfigField(data.model_config, isFormUrlEncoded),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 200, outcome);
        return;
      }

      const pipelineStage1ResolveMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage1\/items\/([^/]+)\/resolve$/
      );
      if (
        method === "POST" &&
        pipelineStage1ResolveMatch?.[1] &&
        pipelineStage1ResolveMatch?.[2] &&
        pipelineStage1ResolveMatch?.[3]
      ) {
        const projectId = decodeURIComponent(pipelineStage1ResolveMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineStage1ResolveMatch[2]);
        const itemId = decodeURIComponent(pipelineStage1ResolveMatch[3]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          decision?: unknown;
          resolution_note?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        if (data.decision !== "CONFIRM" && data.decision !== "REJECT") {
          throw new WebBadRequestError("decision must be CONFIRM or REJECT");
        }
        const resolved = await this.controller.resolvePipelineStage1Item({
          auth,
          projectId,
          pipelineSessionId,
          itemId,
          decision: data.decision,
          resolutionNote:
            optionalStringField(data.resolution_note, "resolution_note") ?? null,
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 200, resolved);
        return;
      }

      const pipelineStage2Match = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage2\/requirements$/
      );
      if (method === "POST" && pipelineStage2Match?.[1] && pipelineStage2Match?.[2]) {
        const projectId = decodeURIComponent(pipelineStage2Match[1]);
        const pipelineSessionId = decodeURIComponent(pipelineStage2Match[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          cost_session_id?: unknown;
          prompt_version?: unknown;
          max_tokens?: unknown;
          temperature?: unknown;
          model_config?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        const outcome = await this.controller.runPipelineStage2Requirements({
          auth,
          projectId,
          pipelineSessionId,
          costSessionId: optionalStringField(data.cost_session_id, "cost_session_id"),
          promptVersion: optionalStringField(data.prompt_version, "prompt_version"),
          maxTokens: optionalFiniteNumberField(data.max_tokens, isFormUrlEncoded, "max_tokens"),
          temperature: optionalFiniteNumberField(
            data.temperature,
            isFormUrlEncoded,
            "temperature"
          ),
          modelConfig: optionalModelConfigField(data.model_config, isFormUrlEncoded),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 200, outcome);
        return;
      }

      const pipelineStage3Match = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage3\/architecture$/
      );
      if (method === "POST" && pipelineStage3Match?.[1] && pipelineStage3Match?.[2]) {
        const projectId = decodeURIComponent(pipelineStage3Match[1]);
        const pipelineSessionId = decodeURIComponent(pipelineStage3Match[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          cost_session_id?: unknown;
          stage2_artifact_id?: unknown;
          prompt_version?: unknown;
          max_tokens?: unknown;
          temperature?: unknown;
          model_config?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        const outcome = await this.controller.runPipelineStage3Architecture({
          auth,
          projectId,
          pipelineSessionId,
          costSessionId: optionalStringField(data.cost_session_id, "cost_session_id"),
          stage2ArtifactId: optionalStringField(data.stage2_artifact_id, "stage2_artifact_id"),
          promptVersion: optionalStringField(data.prompt_version, "prompt_version"),
          maxTokens: optionalFiniteNumberField(data.max_tokens, isFormUrlEncoded, "max_tokens"),
          temperature: optionalFiniteNumberField(
            data.temperature,
            isFormUrlEncoded,
            "temperature"
          ),
          modelConfig: optionalModelConfigField(data.model_config, isFormUrlEncoded),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 200, outcome);
        return;
      }

      const pipelineStage4Match = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage4\/consistency-check$/
      );
      if (method === "POST" && pipelineStage4Match?.[1] && pipelineStage4Match?.[2]) {
        const projectId = decodeURIComponent(pipelineStage4Match[1]);
        const pipelineSessionId = decodeURIComponent(pipelineStage4Match[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          stage1_artifact_id?: unknown;
          stage2_artifact_id?: unknown;
          stage3_artifact_id?: unknown;
          checked_at?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        const outcome = await this.controller.runPipelineStage4ConsistencyCheck({
          auth,
          projectId,
          pipelineSessionId,
          stage1ArtifactId: optionalStringField(data.stage1_artifact_id, "stage1_artifact_id"),
          stage2ArtifactId: optionalStringField(data.stage2_artifact_id, "stage2_artifact_id"),
          stage3ArtifactId: optionalStringField(data.stage3_artifact_id, "stage3_artifact_id"),
          checkedAt: optionalStringField(data.checked_at, "checked_at"),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 200, outcome);
        return;
      }

      const pipelineGateMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/approval-gates$/
      );
      if (method === "POST" && pipelineGateMatch?.[1] && pipelineGateMatch?.[2]) {
        const projectId = decodeURIComponent(pipelineGateMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineGateMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          gate_stage?: StageApprovalGateStage;
          target_artifact_id?: unknown;
          target_artifact_sha256?: unknown;
          decision?: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
          rationale?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        if (
          data.gate_stage !== "STAGE_1_DISCOVERY" &&
          data.gate_stage !== "STAGE_2_REQUIREMENTS" &&
          data.gate_stage !== "STAGE_3_ARCHITECTURE" &&
          data.gate_stage !== "STAGE_4_SPEC_FREEZE"
        ) {
          throw new WebBadRequestError(
            "gate_stage must be STAGE_1_DISCOVERY, STAGE_2_REQUIREMENTS, STAGE_3_ARCHITECTURE, or STAGE_4_SPEC_FREEZE"
          );
        }
        if (
          data.decision !== "APPROVED" &&
          data.decision !== "REJECTED" &&
          data.decision !== "REQUEST_CHANGES"
        ) {
          throw new WebBadRequestError(
            "decision must be APPROVED, REJECTED, or REQUEST_CHANGES"
          );
        }

        const targetArtifactId = optionalStringField(data.target_artifact_id, "target_artifact_id");
        const targetArtifactSha256 = optionalStringField(
          data.target_artifact_sha256,
          "target_artifact_sha256"
        );
        const rationale = optionalStringField(data.rationale, "rationale") ?? null;

        let gate: StageApprovalGateRecord;
        if (targetArtifactId && targetArtifactSha256) {
          gate = await this.controller.submitPipelineApprovalGate({
            auth,
            projectId,
            pipelineSessionId,
            gateStage: data.gate_stage,
            targetArtifactId,
            targetArtifactSha256,
            decision: data.decision,
            rationale,
          });
        } else {
          const bundle = await this.controller.loadPipelineBundle({
            auth,
            projectId,
            pipelineSessionId,
          });
          if (!bundle) {
            if (!preferHtml) {
              this.sendJson(res, 404, {
                error_code: "ERR_PIPELINE_SESSION_NOT_FOUND",
                reason: `Product pipeline session ${pipelineSessionId} not found in project ${projectId}`,
              });
              return;
            }
            throw new PostgresRlsError(
              "23503",
              `Product pipeline session ${pipelineSessionId} not found in project ${projectId}`
            );
          }
          gate = await this.controller.submitPipelineApprovalGateFromBundle({
            auth,
            bundle,
            gateStage: data.gate_stage,
            decision: data.decision,
            rationale,
          });
        }

        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 201, gate);
        return;
      }

      const pipelineFreezeMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/freeze$/
      );
      if (method === "POST" && pipelineFreezeMatch?.[1] && pipelineFreezeMatch?.[2]) {
        const projectId = decodeURIComponent(pipelineFreezeMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineFreezeMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          stage1_artifact_id?: unknown;
          stage1_artifact_sha256?: unknown;
          stage2_artifact_id?: unknown;
          stage2_artifact_sha256?: unknown;
          stage3_artifact_id?: unknown;
          stage3_artifact_sha256?: unknown;
          validation_report_artifact_id?: unknown;
          validation_report_sha256?: unknown;
          approval_gate_id?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = { preferHtml, auth, projectId, pipelineSessionId };

        const freeze = await this.controller.freezePipelineBaseline({
          auth,
          projectId,
          pipelineSessionId,
          stage1ArtifactId: optionalStringField(data.stage1_artifact_id, "stage1_artifact_id"),
          stage1ArtifactSha256: optionalStringField(
            data.stage1_artifact_sha256,
            "stage1_artifact_sha256"
          ),
          stage2ArtifactId: optionalStringField(data.stage2_artifact_id, "stage2_artifact_id"),
          stage2ArtifactSha256: optionalStringField(
            data.stage2_artifact_sha256,
            "stage2_artifact_sha256"
          ),
          stage3ArtifactId: optionalStringField(data.stage3_artifact_id, "stage3_artifact_id"),
          stage3ArtifactSha256: optionalStringField(
            data.stage3_artifact_sha256,
            "stage3_artifact_sha256"
          ),
          validationReportArtifactId: optionalStringField(
            data.validation_report_artifact_id,
            "validation_report_artifact_id"
          ),
          validationReportSha256: optionalStringField(
            data.validation_report_sha256,
            "validation_report_sha256"
          ),
          approvalGateId: optionalStringField(data.approval_gate_id, "approval_gate_id"),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}`
          );
          return;
        }
        this.sendJson(res, 201, freeze);
        return;
      }

      // Milestone M6B: Stage 6 Agent Organization Profiles & 3D Separation
      const webAgentProfilesMatch = pathname.match(/^\/projects\/([^/]+)\/agent-profiles$/);
      if (webAgentProfilesMatch?.[1]) {
        const projectId = decodeURIComponent(webAgentProfilesMatch[1]);
        if (method === "GET") {
          const roleParam = url.searchParams.get("role") as AgentOrgRole | null;
          const activeOnly = url.searchParams.get("active_only") === "true";
          const profiles = await this.controller.listAgentOrganizationProfiles({
            auth,
            projectId,
            role: roleParam ?? undefined,
            activeOnly,
          });
          const format = url.searchParams.get("format") ?? "html";
          if (format === "json") {
            this.sendJson(res, 200, { profiles });
            return;
          }
          if (format === "md") {
            this.sendBody(
              res,
              200,
              "text/markdown; charset=utf-8",
              this.controller.renderAgentProfilesMarkdown(projectId, profiles)
            );
            return;
          }
          const errorMessage = url.searchParams.get("error") ?? undefined;
          this.sendBody(
            res,
            200,
            "text/html; charset=utf-8",
            this.controller.renderAgentProfilesHtml({ projectId, profiles, errorMessage })
          );
          return;
        }
        if (method === "POST") {
          const { data, isFormUrlEncoded } = await this.readRequestPayload<{
            profile_id?: unknown;
            profile_key?: unknown;
            role?: unknown;
            principal_id?: unknown;
            provider?: unknown;
            model?: unknown;
            execution_target_type?: unknown;
            trust_tier?: unknown;
            target_locator?: unknown;
            capabilities_json?: unknown;
            is_active?: unknown;
          }>(req);
          const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
          errorHtmlContext = {
            preferHtml,
            auth,
            projectId,
            errorView: "agent-profiles",
          };

          const profileKey = optionalStringField(data.profile_key, "profile_key");
          const principalId = optionalStringField(data.principal_id, "principal_id");
          const provider = optionalStringField(data.provider, "provider");
          const model = optionalStringField(data.model, "model");
          if (!profileKey || !principalId || !provider || !model) {
            throw new WebBadRequestError(
              "profile_key, principal_id, provider, and model are required non-empty strings"
            );
          }
          if (
            data.role !== "PLANNER" &&
            data.role !== "DEVELOPER" &&
            data.role !== "REVIEWER_READONLY" &&
            data.role !== "VERIFIER"
          ) {
            throw new WebBadRequestError(
              "role must be PLANNER, DEVELOPER, REVIEWER_READONLY, or VERIFIER"
            );
          }
          if (
            data.execution_target_type !== "factory_managed_worker" &&
            data.execution_target_type !== "user_managed_worker" &&
            data.execution_target_type !== "provider_managed_vm" &&
            data.execution_target_type !== "remote_agent_session"
          ) {
            throw new WebBadRequestError(
              "execution_target_type must be factory_managed_worker, user_managed_worker, provider_managed_vm, or remote_agent_session"
            );
          }
          if (
            data.trust_tier !== "TIER_1_FACTORY_MANAGED" &&
            data.trust_tier !== "TIER_2_USER_MANAGED" &&
            data.trust_tier !== "TIER_3_PROVIDER_VM" &&
            data.trust_tier !== "TIER_4_REMOTE_SESSION"
          ) {
            throw new WebBadRequestError(
              "trust_tier must be TIER_1_FACTORY_MANAGED, TIER_2_USER_MANAGED, TIER_3_PROVIDER_VM, or TIER_4_REMOTE_SESSION"
            );
          }
          const capabilitiesJson = optionalJsonValueField<Record<string, unknown>>(
            data.capabilities_json,
            isFormUrlEncoded,
            "capabilities_json"
          );
          if (
            capabilitiesJson !== undefined &&
            (!capabilitiesJson || typeof capabilitiesJson !== "object" || Array.isArray(capabilitiesJson))
          ) {
            throw new WebBadRequestError("capabilities_json must be a JSON object");
          }

          const saved = await this.controller.upsertAgentOrganizationProfile({
            auth,
            projectId,
            profileId: optionalStringField(data.profile_id, "profile_id"),
            profileKey,
            role: data.role,
            principalId,
            provider,
            model,
            executionTargetType: data.execution_target_type,
            trustTier: data.trust_tier,
            targetLocator: optionalStringField(data.target_locator, "target_locator") ?? null,
            capabilitiesJson,
            isActive: optionalBooleanField(data.is_active, isFormUrlEncoded, "is_active"),
          });
          if (preferHtml) {
            this.sendRedirect(res, `/projects/${encodeURIComponent(projectId)}/agent-profiles`);
            return;
          }
          this.sendJson(res, 200, saved);
          return;
        }
      }

      const webValidatePairMatch = pathname.match(
        /^\/projects\/([^/]+)\/agent-profiles\/validate-pair$/
      );
      if (method === "POST" && webValidatePairMatch?.[1]) {
        const projectId = decodeURIComponent(webValidatePairMatch[1]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          developer_profile_id?: unknown;
          reviewer_profile_id?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          errorView: "agent-profiles",
        };

        const developerProfileId = optionalStringField(
          data.developer_profile_id,
          "developer_profile_id"
        );
        const reviewerProfileId = optionalStringField(
          data.reviewer_profile_id,
          "reviewer_profile_id"
        );
        if (!developerProfileId || !reviewerProfileId) {
          throw new WebBadRequestError(
            "developer_profile_id and reviewer_profile_id are required"
          );
        }
        const pair = await this.controller.validateStage6ReviewerPair({
          auth,
          projectId,
          developerProfileId,
          reviewerProfileId,
        });
        if (preferHtml) {
          const profiles = await this.controller.listAgentOrganizationProfiles({ auth, projectId });
          this.sendBody(
            res,
            200,
            "text/html; charset=utf-8",
            this.controller.renderAgentProfilesHtml({
              projectId,
              profiles,
              pairValidationMessage: `3D separation VALID: ${pair.developerProfile.profile_key} (${pair.developerProfile.provider}/${pair.developerProfile.model}) != ${pair.reviewerProfile.profile_key} (${pair.reviewerProfile.provider}/${pair.reviewerProfile.model})`,
            })
          );
          return;
        }
        this.sendJson(res, 200, pair);
        return;
      }

      // Milestone M6B: Stages 5–9 & AC-11b Traceability Workbench Views
      const webM6BMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/m6b$/
      );
      if (method === "GET" && webM6BMatch?.[1] && webM6BMatch?.[2]) {
        const projectId = decodeURIComponent(webM6BMatch[1]);
        const pipelineSessionId = decodeURIComponent(webM6BMatch[2]);
        const bundle = await this.controller.loadM6BBundle({
          auth,
          projectId,
          pipelineSessionId,
        });
        const format = url.searchParams.get("format") ?? "html";
        if (format === "json") {
          this.sendJson(res, 200, bundle);
          return;
        }
        if (format === "md") {
          this.sendBody(
            res,
            200,
            "text/markdown; charset=utf-8",
            this.controller.renderM6BBundleMarkdown(bundle)
          );
          return;
        }
        const errorMessage = url.searchParams.get("error") ?? undefined;
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderM6BBundleHtml(bundle, { errorMessage })
        );
        return;
      }

      const webTraceabilityMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/traceability$/
      );
      if (method === "GET" && webTraceabilityMatch?.[1] && webTraceabilityMatch?.[2]) {
        const projectId = decodeURIComponent(webTraceabilityMatch[1]);
        const pipelineSessionId = decodeURIComponent(webTraceabilityMatch[2]);
        const matrix = await this.controller.loadTraceabilityMatrix({
          auth,
          projectId,
          pipelineSessionId,
        });
        const format = url.searchParams.get("format") ?? "html";
        if (format === "json") {
          this.sendJson(res, 200, matrix);
          return;
        }
        if (format === "md") {
          this.sendBody(
            res,
            200,
            "text/markdown; charset=utf-8",
            this.controller.renderTraceabilityMatrixMarkdown(matrix)
          );
          return;
        }
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderTraceabilityMatrixHtml(matrix)
        );
        return;
      }

      const webBootstrapMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/bootstrap$/
      );
      if (method === "POST" && webBootstrapMatch?.[1] && webBootstrapMatch?.[2]) {
        const projectId = decodeURIComponent(webBootstrapMatch[1]);
        const pipelineSessionId = decodeURIComponent(webBootstrapMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          repo_path?: unknown;
          trusted_acceptance_dir?: unknown;
          extra_protected_paths?: unknown;
          scaffold_files?: unknown;
          acceptance_specs?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        const outcome = await this.controller.bootstrapPipelineProject({
          auth,
          projectId,
          pipelineSessionId,
          repoPath: optionalStringField(data.repo_path, "repo_path"),
          trustedAcceptanceDir: optionalStringField(
            data.trusted_acceptance_dir,
            "trusted_acceptance_dir"
          ),
          extraProtectedPaths: optionalStringArrayField(
            data.extra_protected_paths,
            isFormUrlEncoded,
            "extra_protected_paths"
          ),
          scaffoldFiles: optionalJsonValueField<Readonly<Record<string, string>>>(
            data.scaffold_files,
            isFormUrlEncoded,
            "scaffold_files"
          ),
          acceptanceSpecs: optionalJsonValueField<
            Parameters<CoreApiService["bootstrapPipelineProject"]>[2]["acceptance_specs"]
          >(data.acceptance_specs, isFormUrlEncoded, "acceptance_specs"),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 201, outcome);
        return;
      }

      const webStage7PlanMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage7\/plan$/
      );
      if (method === "POST" && webStage7PlanMatch?.[1] && webStage7PlanMatch?.[2]) {
        const projectId = decodeURIComponent(webStage7PlanMatch[1]);
        const pipelineSessionId = decodeURIComponent(webStage7PlanMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          cost_session_id?: unknown;
          prompt_version?: unknown;
          max_tokens?: unknown;
          temperature?: unknown;
          max_rework_cycles?: unknown;
          model_config?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        const outcome = await this.controller.runPipelineStage7Plan({
          auth,
          projectId,
          pipelineSessionId,
          costSessionId: optionalStringField(data.cost_session_id, "cost_session_id"),
          promptVersion: optionalStringField(data.prompt_version, "prompt_version"),
          maxTokens: optionalFiniteNumberField(data.max_tokens, isFormUrlEncoded, "max_tokens"),
          temperature: optionalFiniteNumberField(
            data.temperature,
            isFormUrlEncoded,
            "temperature"
          ),
          maxReworkCycles: optionalFiniteNumberField(
            data.max_rework_cycles,
            isFormUrlEncoded,
            "max_rework_cycles"
          ),
          modelConfig: optionalModelConfigField(data.model_config, isFormUrlEncoded),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 201, outcome);
        return;
      }

      const webChangeRequestsMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests$/
      );
      if (
        method === "POST" &&
        webChangeRequestsMatch?.[1] &&
        webChangeRequestsMatch?.[2]
      ) {
        const projectId = decodeURIComponent(webChangeRequestsMatch[1]);
        const pipelineSessionId = decodeURIComponent(webChangeRequestsMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          cr_id?: unknown;
          cr_key?: unknown;
          title?: unknown;
          rationale?: unknown;
          impacted_requirement_ids?: unknown;
          impacted_component_ids?: unknown;
          proposed_tasks?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        const crKey = optionalStringField(data.cr_key, "cr_key");
        const title = optionalStringField(data.title, "title");
        const rationale = optionalStringField(data.rationale, "rationale");
        const impactedReqIds = optionalStringArrayField(
          data.impacted_requirement_ids,
          isFormUrlEncoded,
          "impacted_requirement_ids"
        );
        const proposedTasks = optionalJsonValueField<ChangeRequestProposedTaskSpec[]>(
          data.proposed_tasks,
          isFormUrlEncoded,
          "proposed_tasks"
        );
        if (
          !crKey ||
          !title ||
          !rationale ||
          !impactedReqIds ||
          !Array.isArray(proposedTasks)
        ) {
          throw new WebBadRequestError(
            "cr_key, title, rationale, impacted_requirement_ids, and proposed_tasks array are required"
          );
        }

        const created = await this.controller.submitChangeRequest({
          auth,
          projectId,
          pipelineSessionId,
          crId: optionalStringField(data.cr_id, "cr_id"),
          crKey,
          title,
          rationale,
          impactedRequirementIds: impactedReqIds,
          impactedComponentIds: optionalStringArrayField(
            data.impacted_component_ids,
            isFormUrlEncoded,
            "impacted_component_ids"
          ),
          proposedTasks,
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 201, created);
        return;
      }

      const webCrDecideMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests\/([^/]+)\/decide$/
      );
      if (
        method === "POST" &&
        webCrDecideMatch?.[1] &&
        webCrDecideMatch?.[2] &&
        webCrDecideMatch?.[3]
      ) {
        const projectId = decodeURIComponent(webCrDecideMatch[1]);
        const pipelineSessionId = decodeURIComponent(webCrDecideMatch[2]);
        const crId = decodeURIComponent(webCrDecideMatch[3]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          decision?: unknown;
          decision_rationale?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        if (data.decision !== "APPROVED" && data.decision !== "REJECTED") {
          throw new WebBadRequestError("decision must be APPROVED or REJECTED");
        }
        const decided = await this.controller.decideChangeRequest({
          auth,
          projectId,
          pipelineSessionId,
          crId,
          decision: data.decision,
          decisionRationale:
            optionalStringField(data.decision_rationale, "decision_rationale") ?? null,
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 200, decided);
        return;
      }

      const webCrApplyMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests\/([^/]+)\/apply$/
      );
      if (
        method === "POST" &&
        webCrApplyMatch?.[1] &&
        webCrApplyMatch?.[2] &&
        webCrApplyMatch?.[3]
      ) {
        const projectId = decodeURIComponent(webCrApplyMatch[1]);
        const pipelineSessionId = decodeURIComponent(webCrApplyMatch[2]);
        const crId = decodeURIComponent(webCrApplyMatch[3]);
        const { isFormUrlEncoded } = await this.readRequestPayload<Record<string, unknown>>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        const applied = await this.controller.applyChangeRequest({
          auth,
          projectId,
          pipelineSessionId,
          crId,
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 200, applied);
        return;
      }

      const webReleasePackageMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/release-package$/
      );
      if (
        method === "POST" &&
        webReleasePackageMatch?.[1] &&
        webReleasePackageMatch?.[2]
      ) {
        const projectId = decodeURIComponent(webReleasePackageMatch[1]);
        const pipelineSessionId = decodeURIComponent(webReleasePackageMatch[2]);
        const { data, isFormUrlEncoded } = await this.readRequestPayload<{
          notes?: unknown;
        }>(req);
        const preferHtml = this.prefersHtmlResponse(req, url, isFormUrlEncoded);
        errorHtmlContext = {
          preferHtml,
          auth,
          projectId,
          pipelineSessionId,
          errorView: "m6b",
        };

        const pkg = await this.controller.issueReleasePackage({
          auth,
          projectId,
          pipelineSessionId,
          notes: optionalStringField(data.notes, "notes"),
        });
        if (preferHtml) {
          this.sendRedirect(
            res,
            `/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
              pipelineSessionId
            )}/m6b`
          );
          return;
        }
        this.sendJson(res, 201, pkg);
        return;
      }

      this.sendJson(res, 404, {
        error_code: "ERR_NOT_FOUND",
        reason: `Unknown Web Approval Console route ${method} ${pathname}`,
      });
    } catch (err: unknown) {
      await this.sendPipelineErrorResponse({
        res,
        err,
        preferHtml: errorHtmlContext.preferHtml,
        auth: errorHtmlContext.auth,
        projectId: errorHtmlContext.projectId,
        pipelineSessionId: errorHtmlContext.pipelineSessionId,
        errorView: errorHtmlContext.errorView,
      });
    }
  }
}

export * from "./runtime.ts";

