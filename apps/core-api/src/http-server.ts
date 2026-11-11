import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AgentGatewayService,
  IssuedReviewerSessionCredential,
} from "@software-factory/agent-gateway";
import {
  ApprovalExpiredOrStaleError,
  type CasMergeResult,
  type ControlPlaneStore,
  PostgresRlsError,
  type RecordResourceUsageMetricInput,
  SimulatedPostMergeCrashError,
} from "@software-factory/database";
import type { IndependentReviewExecutionResult } from "@software-factory/reviewer";
import type {
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  CandidateBoundLineage,
  MergeCandidateRecord,
  ResourceUsageMetricRecord,
  ReviewArtifactRecord,
  ReviewSessionRecord,
  TaskLeaseRecord,
  TaskRecord,
  TaskStatus,
  VerificationRunRecord,
  VerifiedCodeImportRecord,
} from "@software-factory/shared-types";
import type { GitTreeImportCandidateInput, TaskContractSpec } from "@software-factory/task-contract";
import type {
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  RetryableVerificationResult,
  TierCommandSpec,
} from "@software-factory/verifier";
import type { ApprovalCenterBundle, CoreApiAuthContext, CoreApiService } from "./index.ts";

export const CORE_API_AUTH_HEADER = "x-sf-auth-token";

export function encodeCoreApiAuthHeader(auth: CoreApiAuthContext): string {
  return Buffer.from(JSON.stringify(auth), "utf8").toString("base64url");
}

export function decodeCoreApiAuthHeader(
  headerValue: string | string[] | undefined
): CoreApiAuthContext | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw || !raw.trim()) {
    return null;
  }
  const trimmed = raw.trim();
  const jsonText = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64url").toString("utf8");
  try {
    const parsed = JSON.parse(jsonText) as CoreApiAuthContext;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export interface CoreApiVerifyHttpPolicy {
  /** Allow verified ORG_ADMIN callers to override isolation or command/image allowlists on POST /verify. Default: false. */
  readonly allowAdminVerifyOverrides?: boolean;
  /** Allowed binary executables for tier1/tier2/tier3 commands. Default: ["node", process.execPath]. */
  readonly allowedCommandBinaries?: readonly string[];
  /** Allowed Docker image tags/digests. Default: ["node:22-alpine"]. */
  readonly allowedDockerImages?: readonly string[];
  /** Allowed extra_env keys. Default: []. */
  readonly allowedEnvKeys?: readonly string[];
}

export interface CoreApiHttpServerOptions {
  readonly coreApi: CoreApiService;
  readonly host?: string;
  readonly port?: number;
  readonly snapshotStore?: ImmutableSourceSnapshotStore;
  readonly defaultVerifier?: Docker3TierVerifier;
  readonly defaultAgentGateway?: AgentGatewayService;
  readonly defaultOrphanedDiffProvider?: Parameters<
    ControlPlaneStore["runLeaseExpiryAndOrphanedPushReconciler"]
  >[0];
  readonly verifyPolicy?: CoreApiVerifyHttpPolicy;
  readonly enableTestFaultInjection?: boolean;
}

class BadRequestHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestHttpError";
  }
}

/**
 * Live HTTP Control Plane API Server wrapping `CoreApiService` (`M5`).
 * Exposes task dispatch, candidate building, verification/review triggers,
 * Approval Center, 8-field approval submission, atomic CAS merge, lineage inspection,
 * resource usage metrics, and orphaned-push reconciliation over HTTP JSON.
 */
export class CoreApiHttpServer {
  private readonly coreApi: CoreApiService;
  private readonly host: string;
  private readonly port: number;
  private readonly snapshotStore?: ImmutableSourceSnapshotStore;
  private readonly defaultVerifier?: Docker3TierVerifier;
  private readonly defaultAgentGateway?: AgentGatewayService;
  private readonly defaultOrphanedDiffProvider?: CoreApiHttpServerOptions["defaultOrphanedDiffProvider"];
  private readonly verifyPolicy: {
    readonly allowAdminVerifyOverrides: boolean;
    readonly allowedCommandBinaries: readonly string[];
    readonly allowedDockerImages: readonly string[];
    readonly allowedEnvKeys: readonly string[];
  };
  private readonly enableTestFaultInjection: boolean;
  private server: Server | null = null;

  constructor(options: CoreApiHttpServerOptions) {
    this.coreApi = options.coreApi;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.snapshotStore = options.snapshotStore ?? options.coreApi.snapshotStore ?? undefined;
    this.defaultVerifier = options.defaultVerifier;
    this.defaultAgentGateway = options.defaultAgentGateway;
    this.defaultOrphanedDiffProvider = options.defaultOrphanedDiffProvider;
    this.verifyPolicy = {
      allowAdminVerifyOverrides: options.verifyPolicy?.allowAdminVerifyOverrides ?? false,
      allowedCommandBinaries: options.verifyPolicy?.allowedCommandBinaries ?? [
        "node",
        process.execPath,
      ],
      allowedDockerImages: options.verifyPolicy?.allowedDockerImages ?? ["node:22-alpine"],
      allowedEnvKeys: options.verifyPolicy?.allowedEnvKeys ?? [],
    };
    this.enableTestFaultInjection = options.enableTestFaultInjection ?? false;
  }

  public async start(): Promise<{ port: number; baseUrl: string }> {
    if (this.server) {
      throw new Error("CoreApiHttpServer already started");
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
      throw new Error("Unexpected CoreApiHttpServer address");
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

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      Connection: "close",
    });
    res.end(payload);
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 4 * 1024 * 1024) {
        throw new BadRequestHttpError("Request body exceeds 4 MiB limit");
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
      throw new BadRequestHttpError("Malformed JSON request body");
    }
  }

  private requireAuth(req: IncomingMessage): CoreApiAuthContext | null {
    return decodeCoreApiAuthHeader(req.headers[CORE_API_AUTH_HEADER]);
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (err instanceof BadRequestHttpError) {
      this.sendJson(res, 400, {
        error_code: "ERR_BAD_REQUEST",
        reason: err.message,
      });
      return;
    }
    if (err instanceof ApprovalExpiredOrStaleError) {
      this.sendJson(res, 409, {
        error_code: err.code,
        sqlState: err.sqlState,
        approval_request_status: err.approvalRequestStatus,
        reason: err.message,
      });
      return;
    }
    if (err instanceof SimulatedPostMergeCrashError) {
      this.sendJson(res, 500, {
        error_code: err.code,
        merge_op_id: err.mergeOpId,
        reason: err.message,
      });
      return;
    }
    if (err instanceof PostgresRlsError) {
      const status =
        err.sqlState === "42501"
          ? 403
          : err.sqlState === "23503"
          ? 404
          : err.sqlState === "23505"
          ? 409
          : 422;
      const errorCode =
        err.sqlState === "42501"
          ? "ERR_FORBIDDEN_RLS"
          : err.sqlState === "23503"
          ? "ERR_NOT_FOUND_FK"
          : err.sqlState === "23505"
          ? "ERR_CONFLICT_UNIQUE"
          : "ERR_CHECK_VIOLATION";
      this.sendJson(res, status, {
        error_code: errorCode,
        sqlState: err.sqlState,
        reason: err.message,
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
        this.sendJson(res, 200, { ok: true, service: "core-api" });
        return;
      }

      const auth = this.requireAuth(req);
      if (!auth) {
        this.sendJson(res, 401, {
          error_code: "ERR_UNAUTHORIZED",
          reason: `Missing or invalid ${CORE_API_AUTH_HEADER} header`,
        });
        return;
      }

      const tasksCollection = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/tasks$/);
      if (tasksCollection?.[1]) {
        const projectId = decodeURIComponent(tasksCollection[1]);
        if (method === "POST") {
          const body = await this.readJsonBody<{
            title: string;
            task_contract: TaskContractSpec;
            base_main_commit_hash?: string;
            max_rework_cycles?: number;
          }>(req);
          if (!body.title || !body.task_contract) {
            throw new BadRequestHttpError("title and task_contract are required");
          }
          const created = await this.coreApi.createTask(projectId, auth, body);
          this.sendJson(res, 201, created);
          return;
        }
        if (method === "GET") {
          const list = await this.coreApi.listTasks(projectId, auth);
          this.sendJson(res, 200, { tasks: list });
          return;
        }
      }

      const reconcilerMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/reconciler\/orphaned-pushes$/
      );
      if (method === "POST" && reconcilerMatch?.[1]) {
        const projectId = decodeURIComponent(reconcilerMatch[1]);
        const results = await this.coreApi.runOrphanedPushReconciler(
          projectId,
          auth,
          this.defaultOrphanedDiffProvider
        );
        this.sendJson(res, 200, { recovered: results });
        return;
      }

      const singleTaskMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)$/
      );
      if (method === "GET" && singleTaskMatch?.[1] && singleTaskMatch?.[2]) {
        const projectId = decodeURIComponent(singleTaskMatch[1]);
        const taskId = decodeURIComponent(singleTaskMatch[2]);
        const task = await this.coreApi.getTask(projectId, auth, taskId);
        if (!task) {
          this.sendJson(res, 404, {
            error_code: "ERR_TASK_NOT_FOUND",
            reason: `Task ${taskId} not found in project ${projectId}`,
          });
          return;
        }
        this.sendJson(res, 200, task);
        return;
      }

      const taskActionMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/([a-z-]+)$/
      );
      if (!taskActionMatch?.[1] || !taskActionMatch?.[2] || !taskActionMatch?.[3]) {
        this.sendJson(res, 404, {
          error_code: "ERR_NOT_FOUND",
          reason: `Unknown route ${method} ${pathname}`,
        });
        return;
      }

      const projectId = decodeURIComponent(taskActionMatch[1]);
      const taskId = decodeURIComponent(taskActionMatch[2]);
      const action = taskActionMatch[3];

      if (method === "POST" && action === "dispatch") {
        const body = await this.readJsonBody<{
          worker_id: string;
          heartbeat_interval_ms?: number;
          lease_ttl_ms?: number;
        }>(req);
        if (!body.worker_id) {
          throw new BadRequestHttpError("worker_id is required");
        }
        const lease = await this.coreApi.dispatchTaskLease(projectId, auth, {
          ...body,
          task_id: taskId,
        });
        this.sendJson(res, 201, lease);
        return;
      }

      if (method === "POST" && action === "revoke-lease") {
        const body = await this.readJsonBody<{
          lease_id: string;
          reason: string;
          requeueTask?: boolean;
        }>(req);
        if (!body.lease_id || !body.reason) {
          throw new BadRequestHttpError("lease_id and reason are required");
        }
        const lease = await this.coreApi.revokeTaskLease(projectId, auth, {
          ...body,
          task_id: taskId,
        });
        this.sendJson(res, 200, lease);
        return;
      }

      if (method === "POST" && action === "build-candidate") {
        const body = await this.readJsonBody<{
          lease_id: string;
          lease_epoch: number;
          staging_ref: string;
          agent_commit_hash: string;
          repo_path: string;
          git_dir?: string;
          candidate_input?: GitTreeImportCandidateInput;
        }>(req);
        if (
          !body.lease_id ||
          typeof body.lease_epoch !== "number" ||
          !body.staging_ref ||
          !body.agent_commit_hash ||
          !body.repo_path
        ) {
          throw new BadRequestHttpError(
            "lease_id, lease_epoch, staging_ref, agent_commit_hash, and repo_path are required"
          );
        }
        const built = await this.coreApi.buildMergeCandidateFromGit(projectId, auth, {
          ...body,
          task_id: taskId,
          snapshot_store: this.snapshotStore,
        });
        this.sendJson(res, built.ok ? 200 : 409, built);
        return;
      }

      if (method === "POST" && action === "rebuild-candidate") {
        const body = await this.readJsonBody<{
          repo_path?: string;
          git_dir?: string;
          import_id?: string;
        }>(req);
        const rebuilt = await this.coreApi.rebuildMergeCandidateAfterCasConflict(projectId, auth, {
          ...body,
          task_id: taskId,
          snapshot_store: this.snapshotStore,
        });
        this.sendJson(res, rebuilt.ok ? 200 : 409, rebuilt);
        return;
      }

      if (method === "POST" && action === "verify") {
        if (!this.defaultVerifier) {
          throw new BadRequestHttpError(
            "CoreApiHttpServer was not initialized with defaultVerifier for HTTP /verify route"
          );
        }
        const body = await this.readJsonBody<{
          merge_candidate_id: string;
          trusted_acceptance_dir: string;
          expected_trusted_policy_sha256?: string;
          repo_path?: string;
          base_baseline_dir?: string;
          deps_cache_dir?: string;
          docker_image?: string;
          execution_mode?: "auto" | "docker" | "sandbox" | "subprocess";
          require_docker?: boolean;
          network_disabled?: boolean;
          step_timeout_ms?: number;
          max_infra_retries?: number;
          tier1_command: TierCommandSpec;
          tier2_command?: TierCommandSpec;
          tier3_command?: TierCommandSpec;
          tier3_test_files?: readonly string[];
          extra_env?: Readonly<Record<string, string>>;
        }>(req);
        if (!body.merge_candidate_id || !body.trusted_acceptance_dir || !body.tier1_command) {
          throw new BadRequestHttpError(
            "merge_candidate_id, trusted_acceptance_dir, and tier1_command are required"
          );
        }

        // Authenticate caller first so forged tokens never probe HTTP /verify policy rules
        await this.coreApi.authorizeAction(auth, projectId, ["DEVELOPER", "ORG_ADMIN"]);

        const policyViolations: string[] = [];
        if (body.execution_mode === "subprocess" || body.execution_mode === "sandbox") {
          policyViolations.push(
            `execution_mode '${body.execution_mode}' is restricted; HTTP /verify requires 'auto' or 'docker'`
          );
        }
        if (body.require_docker === false) {
          policyViolations.push("require_docker=false is forbidden on HTTP /verify");
        }
        if (body.network_disabled === false) {
          policyViolations.push("network_disabled=false is forbidden on HTTP /verify");
        }
        if (
          body.docker_image !== undefined &&
          !this.verifyPolicy.allowedDockerImages.includes(body.docker_image)
        ) {
          policyViolations.push(
            `docker_image '${body.docker_image}' is not in HTTP /verify allowlist`
          );
        }
        if (body.extra_env !== undefined) {
          if (!body.extra_env || typeof body.extra_env !== "object" || Array.isArray(body.extra_env)) {
            policyViolations.push("extra_env must be a plain key/value object");
          } else {
            for (const envKey of Object.keys(body.extra_env)) {
              if (!this.verifyPolicy.allowedEnvKeys.includes(envKey)) {
                policyViolations.push(
                  `extra_env key '${envKey}' is not in HTTP /verify allowlist`
                );
              }
            }
          }
        }
        const commandsToValidate: Array<[string, TierCommandSpec | undefined]> = [
          ["tier1_command", body.tier1_command],
          ["tier2_command", body.tier2_command],
          ["tier3_command", body.tier3_command],
        ];
        for (const [label, cmdSpec] of commandsToValidate) {
          if (!cmdSpec) {
            continue;
          }
          const cmdBin = typeof cmdSpec.command === "string" ? cmdSpec.command.trim() : "";
          if (!cmdBin || !this.verifyPolicy.allowedCommandBinaries.includes(cmdBin)) {
            policyViolations.push(
              `${label}.command '${cmdBin}' is not in HTTP /verify command allowlist`
            );
          }
        }

        if (policyViolations.length > 0) {
          let adminOverrideAuthorized = false;
          if (this.verifyPolicy.allowAdminVerifyOverrides) {
            try {
              await this.coreApi.authorizeAction(auth, projectId, ["ORG_ADMIN"]);
              adminOverrideAuthorized = true;
            } catch {
              adminOverrideAuthorized = false;
            }
          }
          if (!adminOverrideAuthorized) {
            throw new PostgresRlsError(
              "42501",
              `HTTP /verify policy violation: ${policyViolations.join("; ")}`
            );
          }
        }

        const verified = await this.coreApi.verifyMergeCandidate(projectId, auth, {
          ...body,
          task_id: taskId,
          verifier: this.defaultVerifier,
        });
        this.sendJson(res, 200, verified);
        return;
      }

      if (method === "POST" && action === "review") {
        if (!this.defaultAgentGateway) {
          throw new BadRequestHttpError(
            "CoreApiHttpServer was not initialized with defaultAgentGateway for HTTP /review route"
          );
        }
        const body = await this.readJsonBody<{
          merge_candidate_id: string;
          verification_run_id: string;
          reviewer_principal_id: string;
          reviewer_session_id?: string;
          reviewer_credential_id?: string;
          reviewer_agent_profile_id: string;
          reviewer_provider: string;
          reviewer_model: string;
          developer_principal_id: string;
          developer_session_id: string;
          developer_credential_id: string;
          developer_agent_profile_id: string;
          writer_provider: string;
          writer_model: string;
          repo_path?: string;
          git_dir?: string;
          tier3_test_files?: readonly string[];
          probe_read_only_enforcement?: boolean;
          approval_request_ttl_ms?: number;
        }>(req);
        const reviewed = await this.coreApi.runIndependentReview(projectId, auth, {
          ...body,
          task_id: taskId,
          agent_gateway: this.defaultAgentGateway,
          snapshot_store: this.snapshotStore,
        });
        this.sendJson(res, 200, reviewed);
        return;
      }

      if (method === "GET" && action === "approval-center") {
        const repoPath = url.searchParams.get("repo_path") ?? undefined;
        const gitDir = url.searchParams.get("git_dir") ?? undefined;
        const bundle = await this.coreApi.getApprovalCenterBundle(projectId, auth, {
          task_id: taskId,
          repo_path: repoPath,
          git_dir: gitDir,
        });
        this.sendJson(res, 200, bundle);
        return;
      }

      if (method === "POST" && action === "approvals") {
        const body = await this.readJsonBody<{
          merge_candidate_id: string;
          approval_request_id?: string;
          agent_commit_hash: string;
          base_main_commit_hash: string;
          verified_tree_hash: string;
          merge_candidate_hash: string;
          verification_run_id: string;
          review_artifact_id: string;
          decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
          feedback?: string;
          ttl_ms?: number;
          repo_path?: string;
          git_dir?: string;
          current_main_commit_hash?: string;
        }>(req);
        const decision = await this.coreApi.submitHumanApproval(projectId, auth, {
          ...body,
          task_id: taskId,
        });
        this.sendJson(res, 201, decision);
        return;
      }

      if (method === "POST" && action === "cas-merge") {
        const body = await this.readJsonBody<{
          merge_candidate_id: string;
          approval_id: string;
          repo_path?: string;
          git_dir?: string;
          require_real_git?: boolean;
          simulateCrashAfterGitUpdateRef?: boolean;
        }>(req);
        if (!body.merge_candidate_id || !body.approval_id) {
          throw new BadRequestHttpError("merge_candidate_id and approval_id are required");
        }
        if (body.simulateCrashAfterGitUpdateRef !== undefined && !this.enableTestFaultInjection) {
          throw new PostgresRlsError(
            "42501",
            "simulateCrashAfterGitUpdateRef is disabled unless CoreApiHttpServer enableTestFaultInjection is enabled"
          );
        }
        const mergeResult = await this.coreApi.executeCasMerge(projectId, auth, {
          ...body,
          task_id: taskId,
          snapshot_store: this.snapshotStore ?? undefined,
        });
        const statusCode =
          mergeResult.status === "MERGED_BY_CAS" ||
          mergeResult.status === "RECONCILED_ALREADY_MERGED"
            ? 200
            : 409;
        this.sendJson(res, statusCode, mergeResult);
        return;
      }

      if (method === "GET" && action === "lineage") {
        const repoPath = url.searchParams.get("repo_path") ?? undefined;
        const gitDir = url.searchParams.get("git_dir") ?? undefined;
        const lineage = await this.coreApi.getCandidateBoundLineage(projectId, auth, {
          task_id: taskId,
          repo_path: repoPath,
          git_dir: gitDir,
        });
        this.sendJson(res, 200, lineage);
        return;
      }

      if (method === "GET" && action === "metrics") {
        const metrics = await this.coreApi.listResourceUsageMetrics(projectId, auth, taskId);
        this.sendJson(res, 200, { metrics });
        return;
      }

      if (method === "POST" && action === "metrics") {
        const body = await this.readJsonBody<Omit<RecordResourceUsageMetricInput, "project_id">>(
          req
        );
        const metric = await this.coreApi.recordResourceUsageMetric(projectId, auth, {
          ...body,
          task_id: taskId,
        });
        this.sendJson(res, 201, metric);
        return;
      }

      this.sendJson(res, 404, {
        error_code: "ERR_NOT_FOUND",
        reason: `Unknown route ${method} ${pathname}`,
      });
    } catch (err: unknown) {
      this.sendError(res, err);
    }
  }
}

export class HttpCoreApiError extends Error {
  public readonly statusCode: number;
  public readonly body: Record<string, unknown>;

  constructor(statusCode: number, body: Record<string, unknown>, message: string) {
    super(message);
    this.name = "HttpCoreApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

/**
 * Lightweight typed HTTP client for `CoreApiHttpServer` (`M5`).
 */
export class HttpCoreApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async requestJson<T>(
    method: string,
    path: string,
    auth: CoreApiAuthContext,
    body?: unknown,
    acceptedStatuses: readonly number[] = [200, 201]
  ): Promise<{ status: number; data: T }> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(auth),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!acceptedStatuses.includes(resp.status)) {
      throw new HttpCoreApiError(
        resp.status,
        parsed,
        `CoreApi HTTP ${resp.status} on ${method} ${path}: ${String(
          parsed.reason ?? JSON.stringify(parsed)
        )}`
      );
    }
    return { status: resp.status, data: parsed as T };
  }

  public async createTask(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      title: string;
      task_contract: TaskContractSpec;
      base_main_commit_hash?: string;
      max_rework_cycles?: number;
    }
  ): Promise<TaskRecord> {
    const res = await this.requestJson<TaskRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async getTask(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string
  ): Promise<TaskRecord> {
    const res = await this.requestJson<TaskRecord>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async dispatchTaskLease(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: { worker_id: string; heartbeat_interval_ms?: number; lease_ttl_ms?: number }
  ): Promise<TaskLeaseRecord> {
    const res = await this.requestJson<TaskLeaseRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/dispatch`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async buildCandidate(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      agent_commit_hash: string;
      repo_path: string;
      git_dir?: string;
    }
  ): Promise<
    | {
        ok: true;
        verifiedImport: VerifiedCodeImportRecord;
        mergeCandidate: MergeCandidateRecord;
      }
    | {
        ok: false;
        reason: "MERGE_CONFLICT";
        conflictedFiles: readonly string[];
        conflictSummary: string;
      }
  > {
    const res = await this.requestJson<{
      ok: boolean;
      verifiedImport?: VerifiedCodeImportRecord;
      mergeCandidate?: MergeCandidateRecord;
      reason?: "MERGE_CONFLICT";
      conflictedFiles?: readonly string[];
      conflictSummary?: string;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/build-candidate`,
      auth,
      input,
      [200, 409]
    );
    return res.data as
      | {
          ok: true;
          verifiedImport: VerifiedCodeImportRecord;
          mergeCandidate: MergeCandidateRecord;
        }
        | {
          ok: false;
          reason: "MERGE_CONFLICT";
          conflictedFiles: readonly string[];
          conflictSummary: string;
        };
  }

  public async rebuildCandidate(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      repo_path?: string;
      git_dir?: string;
      import_id?: string;
    } = {}
  ): Promise<
    | {
        ok: true;
        verifiedImport: VerifiedCodeImportRecord;
        mergeCandidate: MergeCandidateRecord;
      }
    | {
        ok: false;
        reason: "MERGE_CONFLICT";
        verifiedImport: VerifiedCodeImportRecord;
        taskStatus: TaskStatus;
        conflictedFiles: readonly string[];
        conflictSummary: string;
      }
  > {
    const res = await this.requestJson<Record<string, unknown>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/rebuild-candidate`,
      auth,
      input,
      [200, 409]
    );
    return res.data as
      | {
          ok: true;
          verifiedImport: VerifiedCodeImportRecord;
          mergeCandidate: MergeCandidateRecord;
        }
      | {
          ok: false;
          reason: "MERGE_CONFLICT";
          verifiedImport: VerifiedCodeImportRecord;
          taskStatus: TaskStatus;
          conflictedFiles: readonly string[];
          conflictSummary: string;
        };
  }

  public async verifyCandidate(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      merge_candidate_id: string;
      trusted_acceptance_dir: string;
      expected_trusted_policy_sha256?: string;
      repo_path?: string;
      base_baseline_dir?: string;
      deps_cache_dir?: string;
      docker_image?: string;
      execution_mode?: "auto" | "docker" | "sandbox" | "subprocess";
      require_docker?: boolean;
      network_disabled?: boolean;
      step_timeout_ms?: number;
      max_infra_retries?: number;
      tier1_command: TierCommandSpec;
      tier2_command?: TierCommandSpec;
      tier3_command?: TierCommandSpec;
      tier3_test_files?: readonly string[];
      extra_env?: Readonly<Record<string, string>>;
    }
  ): Promise<{
    finalRun: VerificationRunRecord;
    allRuns: readonly VerificationRunRecord[];
    retryResult: RetryableVerificationResult;
    taskStatus: TaskStatus;
  }> {
    const res = await this.requestJson<{
      finalRun: VerificationRunRecord;
      allRuns: readonly VerificationRunRecord[];
      retryResult: RetryableVerificationResult;
      taskStatus: TaskStatus;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/verify`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async runIndependentReview(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      merge_candidate_id: string;
      verification_run_id: string;
      reviewer_principal_id: string;
      reviewer_session_id?: string;
      reviewer_credential_id?: string;
      reviewer_agent_profile_id: string;
      reviewer_provider: string;
      reviewer_model: string;
      developer_principal_id: string;
      developer_session_id: string;
      developer_credential_id: string;
      developer_agent_profile_id: string;
      writer_provider: string;
      writer_model: string;
      repo_path?: string;
      git_dir?: string;
      tier3_test_files?: readonly string[];
      probe_read_only_enforcement?: boolean;
      approval_request_ttl_ms?: number;
    }
  ): Promise<{
    reviewSession: ReviewSessionRecord;
    reviewArtifact: ReviewArtifactRecord;
    approvalRequest: ApprovalRequestRecord | null;
    executionResult: IndependentReviewExecutionResult;
    taskStatus: TaskStatus;
    issuedCredential: IssuedReviewerSessionCredential;
  }> {
    const res = await this.requestJson<{
      reviewSession: ReviewSessionRecord;
      reviewArtifact: ReviewArtifactRecord;
      approvalRequest: ApprovalRequestRecord | null;
      executionResult: IndependentReviewExecutionResult;
      taskStatus: TaskStatus;
      issuedCredential: IssuedReviewerSessionCredential;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/review`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async getApprovalCenterBundle(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    query?: { repo_path?: string; git_dir?: string }
  ): Promise<ApprovalCenterBundle> {
    const qs = new URLSearchParams();
    if (query?.repo_path) qs.set("repo_path", query.repo_path);
    if (query?.git_dir) qs.set("git_dir", query.git_dir);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.requestJson<ApprovalCenterBundle>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approval-center${suffix}`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async submitApproval(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      merge_candidate_id: string;
      approval_request_id?: string;
      agent_commit_hash: string;
      base_main_commit_hash: string;
      verified_tree_hash: string;
      merge_candidate_hash: string;
      verification_run_id: string;
      review_artifact_id: string;
      decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
      feedback?: string;
      ttl_ms?: number;
      repo_path?: string;
      git_dir?: string;
      current_main_commit_hash?: string;
    }
  ): Promise<ApprovalDecisionRecord> {
    const res = await this.requestJson<ApprovalDecisionRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/approvals`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async executeCasMerge(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    input: {
      merge_candidate_id: string;
      approval_id: string;
      repo_path?: string;
      git_dir?: string;
      require_real_git?: boolean;
      simulateCrashAfterGitUpdateRef?: boolean;
    }
  ): Promise<CasMergeResult> {
    const res = await this.requestJson<CasMergeResult>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/cas-merge`,
      auth,
      input,
      [200, 409]
    );
    return res.data;
  }

  public async getCandidateLineage(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string,
    query?: { repo_path?: string; git_dir?: string }
  ): Promise<CandidateBoundLineage> {
    const qs = new URLSearchParams();
    if (query?.repo_path) qs.set("repo_path", query.repo_path);
    if (query?.git_dir) qs.set("git_dir", query.git_dir);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.requestJson<CandidateBoundLineage>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/lineage${suffix}`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async listMetrics(
    projectId: string,
    auth: CoreApiAuthContext,
    taskId: string
  ): Promise<ResourceUsageMetricRecord[]> {
    const res = await this.requestJson<{ metrics: ResourceUsageMetricRecord[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/metrics`,
      auth,
      undefined,
      [200]
    );
    return res.data.metrics;
  }

  public async runOrphanedPushReconciler(
    projectId: string,
    auth: CoreApiAuthContext
  ): Promise<
    Array<{
      lease_id: string;
      task_id: string;
      outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
      import_id?: string;
    }>
  > {
    const res = await this.requestJson<{
      recovered: Array<{
        lease_id: string;
        task_id: string;
        outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
        import_id?: string;
      }>;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/reconciler/orphaned-pushes`,
      auth,
      {},
      [200]
    );
    return res.data.recovered;
  }
}
