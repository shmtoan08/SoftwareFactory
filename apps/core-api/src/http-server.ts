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
import type {
  AgentGatewayService,
  IssuedReviewerSessionCredential,
} from "@software-factory/agent-gateway";
import {
  Ac10ViolationError,
  ApprovalExpiredOrStaleError,
  type CasMergeResult,
  type ControlPlaneStore,
  PostgresRlsError,
  type RecordResourceUsageMetricInput,
  SimulatedPostMergeCrashError,
} from "@software-factory/database";
import type {
  Stage1ExtractOutcome,
  Stage5AcceptanceSpecOverride,
  Stage5BootstrapOutcome,
  Stage6ReviewerPairOutcome,
  Stage7PlanExecutionOutcome,
  StageExecutionOutcome,
} from "@software-factory/product-pipeline";
import type { IndependentReviewExecutionResult } from "@software-factory/reviewer";
import type {
  AgentOrgRole,
  AgentOrganizationProfileRecord,
  ApprovalDecisionRecord,
  ApprovalRequestRecord,
  BaselineSpecFreezeRecord,
  BidirectionalTraceabilityMatrix,
  CandidateBoundLineage,
  ChangeRequestProposedTaskSpec,
  ChangeRequestRecord,
  CostSessionRecord,
  ExecutionTargetType,
  M6BStages5To9Bundle,
  MergeCandidateRecord,
  ModelCallLedgerRecord,
  ProductPipelineBundle,
  ProductPipelineSessionRecord,
  ReleaseAcceptancePackageRecord,
  ResourceUsageMetricRecord,
  ReviewArtifactRecord,
  ReviewSessionRecord,
  Stage1DiscoveryItemRecord,
  Stage4ConsistencyReport,
  StageApprovalGateRecord,
  StageApprovalGateStage,
  StageArtifactRecord,
  TargetTrustTier,
  TaskLeaseRecord,
  TaskPlanLinkRecord,
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

function sanitizeHttpModelConfig(raw: unknown): ModelProviderConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BadRequestHttpError("model_config must be an object");
  }
  const candidate = raw as Record<string, unknown>;
  const provider = candidate.provider;
  const model = candidate.model;
  if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
    throw new BadRequestHttpError(
      "model_config.provider must be one of anthropic, openai, google"
    );
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new BadRequestHttpError("model_config.model must be a non-empty string");
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

      const costSessionsMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/cost-sessions$/
      );
      if (method === "POST" && costSessionsMatch?.[1]) {
        const projectId = decodeURIComponent(costSessionsMatch[1]);
        const body = await this.readJsonBody<{
          cost_session_id?: string;
          pipeline_session_id?: string | null;
          task_id?: string | null;
          max_tokens_per_request: number;
          max_cost_micro_usd_per_request: number;
          session_token_budget: number;
          session_cost_budget_micro_usd: number;
        }>(req);
        if (
          typeof body.max_tokens_per_request !== "number" ||
          typeof body.max_cost_micro_usd_per_request !== "number" ||
          typeof body.session_token_budget !== "number" ||
          typeof body.session_cost_budget_micro_usd !== "number"
        ) {
          throw new BadRequestHttpError(
            "max_tokens_per_request, max_cost_micro_usd_per_request, session_token_budget, and session_cost_budget_micro_usd are required numeric budgets"
          );
        }
        const created = await this.coreApi.createCostSession(projectId, auth, body);
        this.sendJson(res, 201, created);
        return;
      }

      const singleCostSessionMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/cost-sessions\/([^/]+)$/
      );
      if (method === "GET" && singleCostSessionMatch?.[1] && singleCostSessionMatch?.[2]) {
        const projectId = decodeURIComponent(singleCostSessionMatch[1]);
        const costSessionId = decodeURIComponent(singleCostSessionMatch[2]);
        const costView = await this.coreApi.getCostSessionWithLedgers(
          projectId,
          auth,
          costSessionId
        );
        if (!costView) {
          this.sendJson(res, 404, {
            error_code: "ERR_COST_SESSION_NOT_FOUND",
            reason: `Cost session ${costSessionId} not found in project ${projectId}`,
          });
          return;
        }
        this.sendJson(res, 200, costView);
        return;
      }

      const pipelineSessionsMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions$/
      );
      if (pipelineSessionsMatch?.[1]) {
        const projectId = decodeURIComponent(pipelineSessionsMatch[1]);
        if (method === "POST") {
          const body = await this.readJsonBody<{
            pipeline_session_id?: string;
            cost_session_id?: string | null;
            cost_budget?: {
              cost_session_id?: string;
              max_tokens_per_request: number;
              max_cost_micro_usd_per_request: number;
              session_token_budget: number;
              session_cost_budget_micro_usd: number;
            };
            title: string;
            raw_idea_text: string;
          }>(req);
          if (
            typeof body.title !== "string" ||
            !body.title.trim() ||
            typeof body.raw_idea_text !== "string" ||
            !body.raw_idea_text.trim()
          ) {
            throw new BadRequestHttpError("title and raw_idea_text are required non-empty strings");
          }
          if (
            body.cost_budget !== undefined &&
            (typeof body.cost_budget !== "object" ||
              body.cost_budget === null ||
              typeof body.cost_budget.max_tokens_per_request !== "number" ||
              typeof body.cost_budget.max_cost_micro_usd_per_request !== "number" ||
              typeof body.cost_budget.session_token_budget !== "number" ||
              typeof body.cost_budget.session_cost_budget_micro_usd !== "number")
          ) {
            throw new BadRequestHttpError(
              "cost_budget must include numeric per-request and session token/cost budgets"
            );
          }
          const created = await this.coreApi.createPipelineSession(projectId, auth, body);
          this.sendJson(res, 201, created);
          return;
        }
        if (method === "GET") {
          const sessions = await this.coreApi.listPipelineSessions(projectId, auth);
          this.sendJson(res, 200, { sessions });
          return;
        }
      }

      const singlePipelineMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)$/
      );
      if (method === "GET" && singlePipelineMatch?.[1] && singlePipelineMatch?.[2]) {
        const projectId = decodeURIComponent(singlePipelineMatch[1]);
        const pipelineSessionId = decodeURIComponent(singlePipelineMatch[2]);
        const bundle = await this.coreApi.getPipelineBundle(projectId, auth, pipelineSessionId);
        if (!bundle) {
          this.sendJson(res, 404, {
            error_code: "ERR_PIPELINE_SESSION_NOT_FOUND",
            reason: `Product pipeline session ${pipelineSessionId} not found in project ${projectId}`,
          });
          return;
        }
        this.sendJson(res, 200, bundle);
        return;
      }

      const stage1ExtractMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage1\/extract$/
      );
      if (method === "POST" && stage1ExtractMatch?.[1] && stage1ExtractMatch?.[2]) {
        const projectId = decodeURIComponent(stage1ExtractMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage1ExtractMatch[2]);
        const body = await this.readJsonBody<{
          cost_session_id?: string;
          prompt_version?: string;
          max_tokens?: number;
          temperature?: number;
          model_config?: unknown;
        }>(req);
        const outcome = await this.coreApi.runPipelineStage1Extract(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cost_session_id: body.cost_session_id,
          prompt_version: body.prompt_version,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          model_config: sanitizeHttpModelConfig(body.model_config),
        });
        this.sendJson(res, 200, outcome);
        return;
      }

      const stage1ResolveMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage1\/items\/([^/]+)\/resolve$/
      );
      if (
        method === "POST" &&
        stage1ResolveMatch?.[1] &&
        stage1ResolveMatch?.[2] &&
        stage1ResolveMatch?.[3]
      ) {
        const projectId = decodeURIComponent(stage1ResolveMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage1ResolveMatch[2]);
        const itemId = decodeURIComponent(stage1ResolveMatch[3]);
        const body = await this.readJsonBody<{
          decision?: "CONFIRM" | "REJECT";
          resolution_note?: string | null;
        }>(req);
        if (body.decision !== "CONFIRM" && body.decision !== "REJECT") {
          throw new BadRequestHttpError("decision must be CONFIRM or REJECT");
        }
        const resolved = await this.coreApi.resolvePipelineStage1Item(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          item_id: itemId,
          decision: body.decision,
          resolution_note: body.resolution_note,
        });
        this.sendJson(res, 200, resolved);
        return;
      }

      const stage2RequirementsMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage2\/requirements$/
      );
      if (method === "POST" && stage2RequirementsMatch?.[1] && stage2RequirementsMatch?.[2]) {
        const projectId = decodeURIComponent(stage2RequirementsMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage2RequirementsMatch[2]);
        const body = await this.readJsonBody<{
          cost_session_id?: string;
          prompt_version?: string;
          max_tokens?: number;
          temperature?: number;
          model_config?: unknown;
        }>(req);
        const outcome = await this.coreApi.runPipelineStage2Requirements(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cost_session_id: body.cost_session_id,
          prompt_version: body.prompt_version,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          model_config: sanitizeHttpModelConfig(body.model_config),
        });
        this.sendJson(res, 200, outcome);
        return;
      }

      const stage3ArchitectureMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage3\/architecture$/
      );
      if (method === "POST" && stage3ArchitectureMatch?.[1] && stage3ArchitectureMatch?.[2]) {
        const projectId = decodeURIComponent(stage3ArchitectureMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage3ArchitectureMatch[2]);
        const body = await this.readJsonBody<{
          cost_session_id?: string;
          stage2_artifact_id?: string;
          prompt_version?: string;
          max_tokens?: number;
          temperature?: number;
          model_config?: unknown;
        }>(req);
        const outcome = await this.coreApi.runPipelineStage3Architecture(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cost_session_id: body.cost_session_id,
          stage2_artifact_id: body.stage2_artifact_id,
          prompt_version: body.prompt_version,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          model_config: sanitizeHttpModelConfig(body.model_config),
        });
        this.sendJson(res, 200, outcome);
        return;
      }

      const stage4CheckMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage4\/consistency-check$/
      );
      if (method === "POST" && stage4CheckMatch?.[1] && stage4CheckMatch?.[2]) {
        const projectId = decodeURIComponent(stage4CheckMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage4CheckMatch[2]);
        const body = await this.readJsonBody<{
          stage1_artifact_id?: string;
          stage2_artifact_id?: string;
          stage3_artifact_id?: string;
          checked_at?: string;
        }>(req);
        const outcome = await this.coreApi.runPipelineStage4ConsistencyCheck(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          stage1_artifact_id: body.stage1_artifact_id,
          stage2_artifact_id: body.stage2_artifact_id,
          stage3_artifact_id: body.stage3_artifact_id,
          checked_at: body.checked_at,
        });
        this.sendJson(res, 200, outcome);
        return;
      }

      const pipelineGateMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/approval-gates$/
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
          throw new BadRequestHttpError(
            "gate_stage must be STAGE_1_DISCOVERY, STAGE_2_REQUIREMENTS, STAGE_3_ARCHITECTURE, or STAGE_4_SPEC_FREEZE"
          );
        }
        if (
          body.decision !== "APPROVED" &&
          body.decision !== "REJECTED" &&
          body.decision !== "REQUEST_CHANGES"
        ) {
          throw new BadRequestHttpError(
            "decision must be APPROVED, REJECTED, or REQUEST_CHANGES"
          );
        }
        const gate = await this.coreApi.submitPipelineApprovalGate(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          gate_stage: body.gate_stage,
          target_artifact_id: body.target_artifact_id,
          target_artifact_sha256: body.target_artifact_sha256,
          decision: body.decision,
          rationale: body.rationale,
        });
        this.sendJson(res, 201, gate);
        return;
      }

      const pipelineFreezeMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/freeze$/
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
        const freeze = await this.coreApi.freezePipelineBaseline(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          ...body,
        });
        this.sendJson(res, 201, freeze);
        return;
      }

      // Milestone M6B: Agent Profiles (Stage 6) & Stages 5–9 Lifecycle
      const agentProfilesMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/agent-profiles$/
      );
      if (agentProfilesMatch?.[1]) {
        const projectId = decodeURIComponent(agentProfilesMatch[1]);
        if (method === "GET") {
          const roleParam = url.searchParams.get("role") as AgentOrgRole | null;
          const activeOnly = url.searchParams.get("active_only") === "true";
          const profiles = await this.coreApi.listAgentOrganizationProfiles(projectId, auth, {
            role: roleParam ?? undefined,
            active_only: activeOnly,
          });
          this.sendJson(res, 200, { profiles });
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody<{
            profile_id?: string;
            profile_key?: string;
            role?: AgentOrgRole;
            principal_id?: string;
            provider?: string;
            model?: string;
            execution_target_type?: ExecutionTargetType;
            trust_tier?: TargetTrustTier;
            target_locator?: string | null;
            capabilities_json?: Readonly<Record<string, unknown>>;
            is_active?: boolean;
          }>(req);
          if (
            !body.profile_key ||
            !body.role ||
            !body.principal_id ||
            !body.provider ||
            !body.model ||
            !body.execution_target_type ||
            !body.trust_tier
          ) {
            throw new BadRequestHttpError(
              "profile_key, role, principal_id, provider, model, execution_target_type, and trust_tier are required"
            );
          }
          const profile = await this.coreApi.upsertAgentOrganizationProfile(projectId, auth, {
            profile_id: body.profile_id,
            profile_key: body.profile_key,
            role: body.role,
            principal_id: body.principal_id,
            provider: body.provider,
            model: body.model,
            execution_target_type: body.execution_target_type,
            trust_tier: body.trust_tier,
            target_locator: body.target_locator ?? null,
            capabilities_json: body.capabilities_json ?? {},
            is_active: body.is_active ?? true,
          });
          this.sendJson(res, 200, profile);
          return;
        }
      }

      const validatePairMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/agent-profiles\/validate-pair$/
      );
      if (method === "POST" && validatePairMatch?.[1]) {
        const projectId = decodeURIComponent(validatePairMatch[1]);
        const body = await this.readJsonBody<{
          developer_profile_id?: string;
          reviewer_profile_id?: string;
        }>(req);
        if (!body.developer_profile_id || !body.reviewer_profile_id) {
          throw new BadRequestHttpError(
            "developer_profile_id and reviewer_profile_id are required"
          );
        }
        const pair = await this.coreApi.validateStage6ReviewerPair(projectId, auth, {
          developer_profile_id: body.developer_profile_id,
          reviewer_profile_id: body.reviewer_profile_id,
        });
        this.sendJson(res, 200, pair);
        return;
      }

      const pipelineBootstrapMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/bootstrap$/
      );
      if (method === "POST" && pipelineBootstrapMatch?.[1] && pipelineBootstrapMatch?.[2]) {
        const projectId = decodeURIComponent(pipelineBootstrapMatch[1]);
        const pipelineSessionId = decodeURIComponent(pipelineBootstrapMatch[2]);
        const body = await this.readJsonBody<{
          repo_path?: string;
          trusted_acceptance_dir?: string;
          extra_protected_paths?: readonly string[];
          scaffold_files?: Readonly<Record<string, string>>;
          acceptance_specs?: Readonly<Record<string, Stage5AcceptanceSpecOverride>>;
        }>(req);
        const outcome = await this.coreApi.bootstrapPipelineProject(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          ...body,
        });
        this.sendJson(res, 201, outcome);
        return;
      }

      const stage7PlanMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/stage7\/plan$/
      );
      if (method === "POST" && stage7PlanMatch?.[1] && stage7PlanMatch?.[2]) {
        const projectId = decodeURIComponent(stage7PlanMatch[1]);
        const pipelineSessionId = decodeURIComponent(stage7PlanMatch[2]);
        const body = await this.readJsonBody<{
          cost_session_id?: string;
          prompt_version?: string;
          max_tokens?: number;
          temperature?: number;
          max_rework_cycles?: number;
          model_config?: unknown;
        }>(req);
        const outcome = await this.coreApi.runPipelineStage7Plan(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cost_session_id: body.cost_session_id,
          prompt_version: body.prompt_version,
          max_tokens: body.max_tokens,
          temperature: body.temperature,
          max_rework_cycles: body.max_rework_cycles,
          model_config: sanitizeHttpModelConfig(body.model_config),
        });
        this.sendJson(res, 201, outcome);
        return;
      }

      const m6bBundleMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/m6b-bundle$/
      );
      if (method === "GET" && m6bBundleMatch?.[1] && m6bBundleMatch?.[2]) {
        const projectId = decodeURIComponent(m6bBundleMatch[1]);
        const pipelineSessionId = decodeURIComponent(m6bBundleMatch[2]);
        const bundle = await this.coreApi.getPipelineM6BBundle(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
        });
        this.sendJson(res, 200, bundle);
        return;
      }

      const changeRequestsMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests$/
      );
      if (changeRequestsMatch?.[1] && changeRequestsMatch?.[2]) {
        const projectId = decodeURIComponent(changeRequestsMatch[1]);
        const pipelineSessionId = decodeURIComponent(changeRequestsMatch[2]);
        if (method === "GET") {
          const changeRequests = await this.coreApi.listPipelineChangeRequests(
            projectId,
            auth,
            pipelineSessionId
          );
          this.sendJson(res, 200, { change_requests: changeRequests });
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody<{
            cr_id?: string;
            cr_key?: string;
            title?: string;
            rationale?: string;
            impacted_requirement_ids?: readonly string[];
            impacted_component_ids?: readonly string[];
            proposed_tasks?: readonly ChangeRequestProposedTaskSpec[];
          }>(req);
          if (
            !body.cr_key ||
            !body.title ||
            !body.rationale ||
            !Array.isArray(body.impacted_requirement_ids) ||
            !Array.isArray(body.proposed_tasks)
          ) {
            throw new BadRequestHttpError(
              "cr_key, title, rationale, impacted_requirement_ids, and proposed_tasks are required"
            );
          }
          const created = await this.coreApi.submitPipelineChangeRequest(projectId, auth, {
            cr_id: body.cr_id,
            pipeline_session_id: pipelineSessionId,
            cr_key: body.cr_key,
            title: body.title,
            rationale: body.rationale,
            impacted_requirement_ids: body.impacted_requirement_ids,
            impacted_component_ids: body.impacted_component_ids,
            proposed_tasks: body.proposed_tasks,
          });
          this.sendJson(res, 201, created);
          return;
        }
      }

      const crDecideMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests\/([^/]+)\/decide$/
      );
      if (method === "POST" && crDecideMatch?.[1] && crDecideMatch?.[2] && crDecideMatch?.[3]) {
        const projectId = decodeURIComponent(crDecideMatch[1]);
        const pipelineSessionId = decodeURIComponent(crDecideMatch[2]);
        const crId = decodeURIComponent(crDecideMatch[3]);
        const body = await this.readJsonBody<{
          decision?: "APPROVED" | "REJECTED";
          decision_rationale?: string | null;
        }>(req);
        if (body.decision !== "APPROVED" && body.decision !== "REJECTED") {
          throw new BadRequestHttpError("decision must be APPROVED or REJECTED");
        }
        const decided = await this.coreApi.decidePipelineChangeRequest(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cr_id: crId,
          decision: body.decision,
          decision_rationale: body.decision_rationale ?? null,
        });
        this.sendJson(res, 200, decided);
        return;
      }

      const crApplyMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/change-requests\/([^/]+)\/apply$/
      );
      if (method === "POST" && crApplyMatch?.[1] && crApplyMatch?.[2] && crApplyMatch?.[3]) {
        const projectId = decodeURIComponent(crApplyMatch[1]);
        const pipelineSessionId = decodeURIComponent(crApplyMatch[2]);
        const crId = decodeURIComponent(crApplyMatch[3]);
        const applied = await this.coreApi.applyPipelineChangeRequest(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
          cr_id: crId,
        });
        this.sendJson(res, 200, applied);
        return;
      }

      const traceabilityMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/traceability$/
      );
      if (method === "GET" && traceabilityMatch?.[1] && traceabilityMatch?.[2]) {
        const projectId = decodeURIComponent(traceabilityMatch[1]);
        const pipelineSessionId = decodeURIComponent(traceabilityMatch[2]);
        const matrix = await this.coreApi.getPipelineTraceabilityMatrix(projectId, auth, {
          pipeline_session_id: pipelineSessionId,
        });
        this.sendJson(res, 200, matrix);
        return;
      }

      const releasePackageMatch = pathname.match(
        /^\/api\/v1\/projects\/([^/]+)\/pipeline-sessions\/([^/]+)\/release-package$/
      );
      if (releasePackageMatch?.[1] && releasePackageMatch?.[2]) {
        const projectId = decodeURIComponent(releasePackageMatch[1]);
        const pipelineSessionId = decodeURIComponent(releasePackageMatch[2]);
        if (method === "GET") {
          const releasePackages = await this.coreApi.listPipelineReleasePackages(
            projectId,
            auth,
            pipelineSessionId
          );
          this.sendJson(res, 200, { release_packages: releasePackages });
          return;
        }
        if (method === "POST") {
          const body = await this.readJsonBody<{
            notes?: string;
          }>(req);
          const pkg = await this.coreApi.issuePipelineReleasePackage(projectId, auth, {
            pipeline_session_id: pipelineSessionId,
            notes: body.notes,
          });
          this.sendJson(res, 201, pkg);
          return;
        }
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

  // Milestone M6A: Cost Sessions & Product Pipeline Stages 1–4
  public async createCostSession(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly cost_session_id?: string;
      readonly pipeline_session_id?: string | null;
      readonly task_id?: string | null;
      readonly max_tokens_per_request: number;
      readonly max_cost_micro_usd_per_request: number;
      readonly session_token_budget: number;
      readonly session_cost_budget_micro_usd: number;
    }
  ): Promise<CostSessionRecord> {
    const res = await this.requestJson<CostSessionRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/cost-sessions`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async getCostSession(
    projectId: string,
    auth: CoreApiAuthContext,
    costSessionId: string
  ): Promise<{
    readonly session: CostSessionRecord;
    readonly ledgers: readonly ModelCallLedgerRecord[];
  }> {
    const res = await this.requestJson<{
      readonly session: CostSessionRecord;
      readonly ledgers: readonly ModelCallLedgerRecord[];
    }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/cost-sessions/${encodeURIComponent(
        costSessionId
      )}`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async createPipelineSession(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly pipeline_session_id?: string;
      readonly cost_session_id?: string | null;
      readonly cost_budget?: {
        readonly cost_session_id?: string;
        readonly max_tokens_per_request: number;
        readonly max_cost_micro_usd_per_request: number;
        readonly session_token_budget: number;
        readonly session_cost_budget_micro_usd: number;
      };
      readonly title: string;
      readonly raw_idea_text: string;
    }
  ): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly costSession: CostSessionRecord | null;
  }> {
    const res = await this.requestJson<{
      readonly session: ProductPipelineSessionRecord;
      readonly costSession: CostSessionRecord | null;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async listPipelineSessions(
    projectId: string,
    auth: CoreApiAuthContext
  ): Promise<ProductPipelineSessionRecord[]> {
    const res = await this.requestJson<{ sessions: ProductPipelineSessionRecord[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions`,
      auth,
      undefined,
      [200]
    );
    return res.data.sessions;
  }

  public async getPipelineBundle(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<ProductPipelineBundle> {
    const res = await this.requestJson<ProductPipelineBundle>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async runPipelineStage1Extract(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly cost_session_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
    } = {}
  ): Promise<Stage1ExtractOutcome> {
    const res = await this.requestJson<Stage1ExtractOutcome>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage1/extract`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async resolvePipelineStage1Item(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    itemId: string,
    input: {
      readonly decision: "CONFIRM" | "REJECT";
      readonly resolution_note?: string | null;
    }
  ): Promise<Stage1DiscoveryItemRecord> {
    const res = await this.requestJson<Stage1DiscoveryItemRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage1/items/${encodeURIComponent(itemId)}/resolve`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async runPipelineStage2Requirements(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly cost_session_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
    } = {}
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const res = await this.requestJson<StageExecutionOutcome<Record<string, unknown>>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage2/requirements`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async runPipelineStage3Architecture(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly cost_session_id?: string;
      readonly stage2_artifact_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly model_config?: ModelProviderConfig;
    } = {}
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const res = await this.requestJson<StageExecutionOutcome<Record<string, unknown>>>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage3/architecture`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async runPipelineStage4ConsistencyCheck(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly stage1_artifact_id?: string;
      readonly stage2_artifact_id?: string;
      readonly stage3_artifact_id?: string;
      readonly checked_at?: string;
    } = {}
  ): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly report: Stage4ConsistencyReport;
    readonly artifact: StageArtifactRecord;
  }> {
    const res = await this.requestJson<{
      readonly session: ProductPipelineSessionRecord;
      readonly report: Stage4ConsistencyReport;
      readonly artifact: StageArtifactRecord;
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage4/consistency-check`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async submitPipelineApprovalGate(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly gate_stage: StageApprovalGateStage;
      readonly target_artifact_id?: string;
      readonly target_artifact_sha256?: string;
      readonly decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
      readonly rationale?: string | null;
    }
  ): Promise<StageApprovalGateRecord> {
    const res = await this.requestJson<StageApprovalGateRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/approval-gates`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async freezePipelineBaseline(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly stage1_artifact_id?: string;
      readonly stage1_artifact_sha256?: string;
      readonly stage2_artifact_id?: string;
      readonly stage2_artifact_sha256?: string;
      readonly stage3_artifact_id?: string;
      readonly stage3_artifact_sha256?: string;
      readonly validation_report_artifact_id?: string;
      readonly validation_report_sha256?: string;
      readonly approval_gate_id?: string;
    } = {}
  ): Promise<BaselineSpecFreezeRecord> {
    const res = await this.requestJson<BaselineSpecFreezeRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/freeze`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  // Milestone M6B: Agent Profiles (Stage 6) & Stages 5–9 Lifecycle
  public async upsertAgentOrganizationProfile(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly profile_id?: string;
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
    }
  ): Promise<AgentOrganizationProfileRecord> {
    const res = await this.requestJson<AgentOrganizationProfileRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/agent-profiles`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async listAgentOrganizationProfiles(
    projectId: string,
    auth: CoreApiAuthContext,
    filter?: {
      readonly role?: AgentOrgRole;
      readonly active_only?: boolean;
    }
  ): Promise<AgentOrganizationProfileRecord[]> {
    const qs = new URLSearchParams();
    if (filter?.role) qs.set("role", filter.role);
    if (filter?.active_only) qs.set("active_only", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await this.requestJson<{ profiles: AgentOrganizationProfileRecord[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/agent-profiles${suffix}`,
      auth,
      undefined,
      [200]
    );
    return res.data.profiles;
  }

  public async validateStage6ReviewerPair(
    projectId: string,
    auth: CoreApiAuthContext,
    input: {
      readonly developer_profile_id: string;
      readonly reviewer_profile_id: string;
    }
  ): Promise<Stage6ReviewerPairOutcome> {
    const res = await this.requestJson<Stage6ReviewerPairOutcome>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/agent-profiles/validate-pair`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async bootstrapPipelineProject(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly repo_path?: string;
      readonly trusted_acceptance_dir?: string;
      readonly extra_protected_paths?: readonly string[];
      readonly scaffold_files?: Readonly<Record<string, string>>;
      readonly acceptance_specs?: Readonly<Record<string, Stage5AcceptanceSpecOverride>>;
    } = {}
  ): Promise<Stage5BootstrapOutcome> {
    const res = await this.requestJson<Stage5BootstrapOutcome>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/bootstrap`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async runPipelineStage7Plan(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly cost_session_id?: string;
      readonly prompt_version?: string;
      readonly max_tokens?: number;
      readonly temperature?: number;
      readonly max_rework_cycles?: number;
      readonly model_config?: ModelProviderConfig;
    } = {}
  ): Promise<Stage7PlanExecutionOutcome> {
    const res = await this.requestJson<Stage7PlanExecutionOutcome>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/stage7/plan`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async getPipelineM6BBundle(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<M6BStages5To9Bundle> {
    const res = await this.requestJson<M6BStages5To9Bundle>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/m6b-bundle`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async submitPipelineChangeRequest(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly cr_id?: string;
      readonly cr_key: string;
      readonly title: string;
      readonly rationale: string;
      readonly impacted_requirement_ids: readonly string[];
      readonly impacted_component_ids?: readonly string[];
      readonly proposed_tasks: readonly ChangeRequestProposedTaskSpec[];
    }
  ): Promise<ChangeRequestRecord> {
    const res = await this.requestJson<ChangeRequestRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/change-requests`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async listPipelineChangeRequests(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<ChangeRequestRecord[]> {
    const res = await this.requestJson<{ change_requests: ChangeRequestRecord[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/change-requests`,
      auth,
      undefined,
      [200]
    );
    return res.data.change_requests;
  }

  public async decidePipelineChangeRequest(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    crId: string,
    input: {
      readonly decision: "APPROVED" | "REJECTED";
      readonly decision_rationale?: string | null;
    }
  ): Promise<ChangeRequestRecord> {
    const res = await this.requestJson<ChangeRequestRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/change-requests/${encodeURIComponent(crId)}/decide`,
      auth,
      input,
      [200]
    );
    return res.data;
  }

  public async applyPipelineChangeRequest(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    crId: string
  ): Promise<{
    readonly changeRequest: ChangeRequestRecord;
    readonly tasks: readonly TaskRecord[];
    readonly taskLinks: readonly TaskPlanLinkRecord[];
  }> {
    const res = await this.requestJson<{
      readonly changeRequest: ChangeRequestRecord;
      readonly tasks: readonly TaskRecord[];
      readonly taskLinks: readonly TaskPlanLinkRecord[];
    }>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/change-requests/${encodeURIComponent(crId)}/apply`,
      auth,
      {},
      [200]
    );
    return res.data;
  }

  public async getPipelineTraceabilityMatrix(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<BidirectionalTraceabilityMatrix> {
    const res = await this.requestJson<BidirectionalTraceabilityMatrix>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/traceability`,
      auth,
      undefined,
      [200]
    );
    return res.data;
  }

  public async issuePipelineReleasePackage(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string,
    input: {
      readonly notes?: string;
    } = {}
  ): Promise<ReleaseAcceptancePackageRecord> {
    const res = await this.requestJson<ReleaseAcceptancePackageRecord>(
      "POST",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/release-package`,
      auth,
      input,
      [201]
    );
    return res.data;
  }

  public async listPipelineReleasePackages(
    projectId: string,
    auth: CoreApiAuthContext,
    pipelineSessionId: string
  ): Promise<ReleaseAcceptancePackageRecord[]> {
    const res = await this.requestJson<{ release_packages: ReleaseAcceptancePackageRecord[] }>(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-sessions/${encodeURIComponent(
        pipelineSessionId
      )}/release-package`,
      auth,
      undefined,
      [200]
    );
    return res.data.release_packages;
  }
}
