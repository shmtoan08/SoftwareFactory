import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  ApprovalDecisionRecord,
  CandidateBoundLineage,
  MergeCandidateRecord,
  ReviewArtifactRecord,
  VerificationRunRecord,
} from "@software-factory/shared-types";
import {
  type ApprovalCenterBundle,
  CORE_API_AUTH_HEADER,
  type CoreApiAuthContext,
  type CoreApiService,
  decodeCoreApiAuthHeader,
} from "@software-factory/core-api";

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
    return (raw ? JSON.parse(raw) : {}) as T;
  }

  private sendMappedError(res: ServerResponse, err: unknown): void {
    const shaped = err as { code?: string; sqlState?: string; message?: string };
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

      this.sendJson(res, 404, {
        error_code: "ERR_NOT_FOUND",
        reason: `Unknown Web Approval Console route ${method} ${pathname}`,
      });
    } catch (err: unknown) {
      this.sendMappedError(res, err);
    }
  }
}

