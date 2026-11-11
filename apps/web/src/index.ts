import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CostBudgetExceededError,
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
  ApprovalDecisionRecord,
  BaselineSpecFreezeRecord,
  CandidateBoundLineage,
  MergeCandidateRecord,
  PipelineStageName,
  ProductPipelineBundle,
  ReviewArtifactRecord,
  Stage4ConsistencyReport,
  StageApprovalGateRecord,
  StageApprovalGateStage,
  StageArtifactRecord,
  VerificationRunRecord,
} from "@software-factory/shared-types";

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

  public async loadPipelineBundle(input: {
    auth: CoreApiAuthContext;
    projectId: string;
    pipelineSessionId: string;
  }): Promise<ProductPipelineBundle | null> {
    return this.coreApi.getPipelineBundle(input.projectId, input.auth, input.pipelineSessionId);
  }

  public renderPipelineBundleMarkdown(bundle: ProductPipelineBundle): string {
    const cost = bundle.costSession;
    const ledgersRows = bundle.modelCallLedgers
      .map(
        (l) =>
          `| ${l.stage} | ${l.provider}/${l.model} | ${l.prompt_id}@${l.prompt_version} | ${l.status} | ${l.actual_total_tokens} | ${l.actual_cost_micro_usd} |`
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

  public renderPipelineBundleHtml(bundle: ProductPipelineBundle): string {
    const cost = bundle.costSession;
    const discoveryRows = bundle.discoveryItems
      .map(
        (d) =>
          `<tr><td><code>${escapeHtml(d.kind)}</code></td><td>${escapeHtml(
            d.title
          )}</td><td><code>${escapeHtml(d.confirmation_status)}</code></td><td><code>${escapeHtml(
            d.confirmed_by_principal_id ?? "-"
          )}</code></td></tr>`
      )
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
          }</td><td>${l.actual_cost_micro_usd}</td></tr>`
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
      "<section>",
      `<h2>Stage 1 Discovery Items (${bundle.discoveryItems.length})</h2>`,
      "<table><thead><tr><th>Kind</th><th>Title</th><th>Status</th><th>Confirmed By</th></tr></thead>",
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
      "</section>",
      "</main>",
      "</body>",
      "</html>",
    ].join("\n");
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
}

export interface WebApprovalConsoleHttpServerOptions {
  readonly controller?: WebApprovalConsoleController;
  readonly coreApi?: CoreApiService;
  readonly host?: string;
  readonly port?: number;
}

/**
 * Live HTTP Web Approval Console & Lineage Viewer Server (`M5`).
 * Renders Approval Center + Candidate-Bound Lineage (`HTML`/`Markdown`/`JSON`)
 * and enforces 8-field lock submission for Human Approvers over HTTP.
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

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 1_048_576) {
        throw new Error("Request body too large");
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {} as T;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new SyntaxError("Malformed JSON request body");
    }
  }

  private sendMappedError(res: ServerResponse, err: unknown): void {
    if (err instanceof SyntaxError) {
      this.sendJson(res, 400, {
        error_code: "ERR_BAD_REQUEST",
        reason: err.message,
      });
      return;
    }
    if (err instanceof CostBudgetExceededError) {
      this.sendJson(res, 402, {
        error_code: err.code,
        limit_scope: err.limitScope,
        cost_session_id: err.costSessionId,
        ledger_id: err.ledgerId,
        details: err.details,
        reason: err.message,
      });
      return;
    }
    if (err instanceof StructuredOutputValidationError) {
      this.sendJson(res, 422, {
        error_code: err.code,
        validation_errors: err.validationErrors,
        reason: err.message,
      });
      return;
    }
    if (err instanceof PromptVersionConflictError) {
      this.sendJson(res, 409, {
        error_code: err.code,
        prompt_id: err.promptId,
        version: err.version,
        reason: err.message,
      });
      return;
    }
    if (err instanceof PromptNotFoundError) {
      this.sendJson(res, 404, {
        error_code: err.code,
        prompt_id: err.promptId,
        version: err.version,
        reason: err.message,
      });
      return;
    }
    if (err instanceof PromptRenderError) {
      this.sendJson(res, 400, {
        error_code: err.code,
        reason: err.message,
      });
      return;
    }
    if (err instanceof ModelProviderConfigurationError) {
      this.sendJson(res, 503, {
        error_code: err.code,
        provider: err.provider,
        reason: err.message,
      });
      return;
    }
    if (err instanceof ModelProviderHttpError) {
      this.sendJson(res, 502, {
        error_code: "ERR_MODEL_PROVIDER_UPSTREAM",
        provider: err.provider,
        upstream_status: err.statusCode,
        reason: err.message,
      });
      return;
    }
    if (err instanceof Ac10ViolationError) {
      this.sendJson(res, 422, {
        error_code: err.code,
        sqlState: err.sqlState,
        offending_item_ids: err.offendingItemIds,
        reason: err.message,
      });
      return;
    }

    const shaped = err as {
      code?: string;
      sqlState?: string;
      message?: string;
      offendingItemIds?: readonly string[];
    };
    if (shaped.code === "ERR_AC10_UNCONFIRMED_ASSUMPTION") {
      this.sendJson(res, 422, {
        error_code: "ERR_AC10_UNCONFIRMED_ASSUMPTION",
        sqlState: shaped.sqlState ?? "23514",
        offending_item_ids: shaped.offendingItemIds ?? [],
        reason: shaped.message ?? "AC-10 unconfirmed assumption violation",
      });
      return;
    }
    if (shaped.code === "ERR_APPROVAL_EXPIRED_OR_STALE") {
      this.sendJson(res, 409, {
        error_code: "ERR_APPROVAL_EXPIRED_OR_STALE",
        reason: shaped.message ?? "Approval request expired or stale",
      });
      return;
    }
    if (shaped.sqlState === "42501") {
      this.sendJson(res, 403, {
        error_code: "ERR_FORBIDDEN_RLS",
        sqlState: "42501",
        reason: shaped.message ?? "Forbidden",
      });
      return;
    }
    if (shaped.sqlState === "23503") {
      this.sendJson(res, 404, {
        error_code: "ERR_NOT_FOUND_FK",
        sqlState: "23503",
        reason: shaped.message ?? "Not found",
      });
      return;
    }
    if (shaped.sqlState === "23505") {
      this.sendJson(res, 409, {
        error_code: "ERR_CONFLICT_UNIQUE",
        sqlState: "23505",
        reason: shaped.message ?? "Unique constraint conflict",
      });
      return;
    }
    if (shaped.sqlState === "23514") {
      this.sendJson(res, 422, {
        error_code: "ERR_CHECK_VIOLATION",
        sqlState: "23514",
        reason: shaped.message ?? "Validation constraint violated",
      });
      return;
    }
    this.sendJson(res, 500, {
      error_code: "ERR_INTERNAL",
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        this.sendBody(
          res,
          200,
          "text/html; charset=utf-8",
          this.controller.renderPipelineBundleHtml(bundle)
        );
        return;
      }

      const pipelineGateMatch = pathname.match(
        /^\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/approval-gates$/
      );
      if (method === "POST" && pipelineGateMatch?.[1] && pipelineGateMatch?.[2]) {
        const projectId = decodeURIComponent(pipelineGateMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineGateMatch[2]);
        const body = await this.readJsonBody<{
          gate_stage?: StageApprovalGateStage;
          target_artifact_id?: string;
          target_artifact_sha256?: string;
          decision?: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
          rationale?: string | null;
        }>(req);

        if (
          body.gate_stage !== "STAGE_1_DISCOVERY" &&
          body.gate_stage !== "STAGE_2_REQUIREMENTS" &&
          body.gate_stage !== "STAGE_3_ARCHITECTURE" &&
          body.gate_stage !== "STAGE_4_SPEC_FREEZE"
        ) {
          this.sendJson(res, 400, {
            error_code: "ERR_BAD_REQUEST",
            reason:
              "gate_stage must be STAGE_1_DISCOVERY, STAGE_2_REQUIREMENTS, STAGE_3_ARCHITECTURE, or STAGE_4_SPEC_FREEZE",
          });
          return;
        }
        if (
          body.decision !== "APPROVED" &&
          body.decision !== "REJECTED" &&
          body.decision !== "REQUEST_CHANGES"
        ) {
          this.sendJson(res, 400, {
            error_code: "ERR_BAD_REQUEST",
            reason: "decision must be APPROVED, REJECTED, or REQUEST_CHANGES",
          });
          return;
        }

        let gate: StageApprovalGateRecord;
        if (body.target_artifact_id && body.target_artifact_sha256) {
          gate = await this.controller.submitPipelineApprovalGate({
            auth,
            projectId,
            pipelineSessionId,
            gateStage: body.gate_stage,
            targetArtifactId: body.target_artifact_id,
            targetArtifactSha256: body.target_artifact_sha256,
            decision: body.decision,
            rationale: body.rationale,
          });
        } else {
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
          gate = await this.controller.submitPipelineApprovalGateFromBundle({
            auth,
            bundle,
            gateStage: body.gate_stage,
            decision: body.decision,
            rationale: body.rationale,
          });
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
        const body = await this.readJsonBody<{
          stage1_artifact_id?: string;
          stage1_artifact_sha256?: string;
          stage2_artifact_id?: string;
          stage2_artifact_sha256?: string;
          stage3_artifact_id?: string;
          stage3_artifact_sha256?: string;
          validation_report_artifact_id?: string;
          validation_report_sha256?: string;
          approval_gate_id?: string;
        }>(req);

        const freeze = await this.controller.freezePipelineBaseline({
          auth,
          projectId,
          pipelineSessionId,
          stage1ArtifactId: body.stage1_artifact_id,
          stage1ArtifactSha256: body.stage1_artifact_sha256,
          stage2ArtifactId: body.stage2_artifact_id,
          stage2ArtifactSha256: body.stage2_artifact_sha256,
          stage3ArtifactId: body.stage3_artifact_id,
          stage3ArtifactSha256: body.stage3_artifact_sha256,
          validationReportArtifactId: body.validation_report_artifact_id,
          validationReportSha256: body.validation_report_sha256,
          approvalGateId: body.approval_gate_id,
        });
        this.sendJson(res, 201, freeze);
        return;
      }

      this.sendJson(res, 404, {
        error_code: "ERR_NOT_FOUND",
        reason: `Unknown Web Approval Console route ${method} ${pathname}`,
      });
    } catch (err: unknown) {
      this.sendMappedError(res, err);
    }
  }
}

export * from "./runtime.ts";

