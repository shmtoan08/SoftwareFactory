import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  LeaseSyncStatusResponse,
  ServerEventAckContract,
  WorkerEventEnvelope,
} from "@software-factory/shared-types";
import {
  type GitTreeChangeEntry,
  type TaskContractSpec,
  inspectRealGitCommitForImport,
} from "@software-factory/task-contract";
import type { SoftwareFactoryControlPlaneStore } from "@software-factory/database";
import type { AgentGatewayTransportClient } from "@software-factory/wna";

export interface LeasePushTokenClaims {
  readonly projectId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly workerId: string;
  readonly exp: number;
}

const STAGING_REF_PATTERN =
  /^(refs\/heads\/sf\/staging|refs\/factory\/Verify)\/([0-9a-fA-F-]+)\/(0|[1-9][0-9]*)$/;

/**
 * Per-lease short-lived HMAC-SHA256 Git push token issuer & verifier (`MVP-SPEC-03` Section 5.1, `FIX-14`).
 * Strictly binds each push token to `(projectId, taskId, leaseId, leaseEpoch, workerId, exp)` so static
 * shared env tokens or tokens from another task/epoch are rejected fail-closed.
 */
export class EphemeralGitPushTokenService {
  private readonly signingSecret: string;
  private readonly clockFn: () => Date;

  constructor(options?: { signingSecret?: string; clockFn?: () => Date }) {
    if (options?.signingSecret !== undefined) {
      if (options.signingSecret.trim().length === 0) {
        throw new Error("EphemeralGitPushTokenService signingSecret must not be empty");
      }
      this.signingSecret = options.signingSecret;
    } else {
      this.signingSecret = randomBytes(32).toString("hex");
    }
    this.clockFn = options?.clockFn ?? (() => new Date());
  }

  public issueLeasePushToken(input: {
    projectId: string;
    taskId: string;
    leaseId: string;
    leaseEpoch: number;
    workerId: string;
    ttlMs?: number;
  }): string {
    const ttlMs = input.ttlMs ?? 300_000;
    if (ttlMs <= 0) {
      throw new Error("Lease push token ttlMs must be positive");
    }
    const claims: LeasePushTokenClaims = {
      projectId: input.projectId,
      taskId: input.taskId,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      workerId: input.workerId,
      exp: this.clockFn().getTime() + ttlMs,
    };
    const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const sigB64 = createHmac("sha256", this.signingSecret)
      .update(payloadB64, "utf8")
      .digest("base64url");
    return `${payloadB64}.${sigB64}`;
  }

  public verifyLeasePushToken(
    token: string,
    expectedRefName: string
  ): { readonly valid: true; readonly claims: LeasePushTokenClaims } | { readonly valid: false; readonly reason: string } {
    if (!token || typeof token !== "string") {
      return { valid: false, reason: "Missing lease push token" };
    }
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { valid: false, reason: "Malformed lease push token; static/unsigned tokens are forbidden" };
    }
    const [payloadB64, sigB64] = parts;
    const expectedSigB64 = createHmac("sha256", this.signingSecret)
      .update(payloadB64, "utf8")
      .digest("base64url");

    const actualBuf = Buffer.from(sigB64, "utf8");
    const expectedBuf = Buffer.from(expectedSigB64, "utf8");
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      return { valid: false, reason: "Invalid lease push token signature" };
    }

    let claims: LeasePushTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as LeasePushTokenClaims;
    } catch {
      return { valid: false, reason: "Corrupted lease push token payload" };
    }

    if (
      typeof claims.projectId !== "string" ||
      typeof claims.taskId !== "string" ||
      typeof claims.leaseId !== "string" ||
      typeof claims.leaseEpoch !== "number" ||
      typeof claims.workerId !== "string" ||
      typeof claims.exp !== "number"
    ) {
      return { valid: false, reason: "Incomplete claims inside lease push token" };
    }

    if (claims.exp <= this.clockFn().getTime()) {
      return { valid: false, reason: "Lease push token has expired" };
    }

    const refMatch = expectedRefName.match(STAGING_REF_PATTERN);
    if (!refMatch) {
      return { valid: false, reason: `Ref '${expectedRefName}' is not a valid staging ref` };
    }
    const refTaskId = refMatch[2]!;
    const refEpoch = Number.parseInt(refMatch[3]!, 10);
    if (claims.taskId !== refTaskId || claims.leaseEpoch !== refEpoch) {
      return {
        valid: false,
        reason: `Token binding (${claims.taskId}/epoch ${claims.leaseEpoch}) does not match ref '${expectedRefName}'`,
      };
    }

    return { valid: true, claims };
  }
}

/**
 * AgentGatewayService (MVP-SPEC-01 Section 3.1 & MVP-SPEC-03 Section 1-2 & Section 5)
 * Mediates all Worker (WNA) traffic using scoped `gateway_service` RLS transactions.
 * Workers never receive direct PostgreSQL credentials.
 */
export class AgentGatewayService implements AgentGatewayTransportClient {
  private readonly store: SoftwareFactoryControlPlaneStore;
  private readonly projectId: string;
  private readonly workerPrincipalId: string;

  constructor(options: {
    store: SoftwareFactoryControlPlaneStore;
    projectId: string;
    workerPrincipalId?: string;
  }) {
    this.store = options.store;
    this.projectId = options.projectId;
    this.workerPrincipalId = options.workerPrincipalId ?? "wna-worker-node-01";
  }

  public async submitEvent(
    envelope: WorkerEventEnvelope,
    inTransactionDelayMs = 0
  ): Promise<ServerEventAckContract> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () => this.store.submitWorkerEvent(envelope, inTransactionDelayMs)
    );
  }

  public async getLeaseSyncStatus(leaseId: string): Promise<LeaseSyncStatusResponse> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () => {
        const sync = this.store.getLeaseSyncStatus(leaseId);
        if (!sync) {
          throw new Error(`Lease ${leaseId} not found in project ${this.projectId}`);
        }
        return sync;
      }
    );
  }

  public async authorizeAndPushStagingRef(input: {
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    agent_commit_hash: string;
    verified_tree_hash: string;
    parent_commit_hashes: readonly string[];
    changes?: readonly GitTreeChangeEntry[];
    simulateControlPlaneOutage?: boolean;
    deadlineMs?: number;
    authorizeCheckHook?: (signal: AbortSignal) => Promise<void>;
  }): Promise<{
    allowed: boolean;
    error_code?: string;
    reason?: string;
    import_id?: string;
  }> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: this.projectId,
        currentPrincipalId: this.workerPrincipalId,
        currentRole: "gateway_service",
      },
      () =>
        this.store.pushStagingGitRefWithGatekeeper({
          project_id: this.projectId,
          ...input,
        })
    );
  }
}

export interface PreReceiveHttpRequestBody {
  readonly old_sha: string;
  readonly new_sha: string;
  readonly ref_name: string;
  readonly repo_path?: string;
  readonly git_object_directory?: string;
  readonly git_alternate_object_directories?: string;
  readonly verified_tree_hash?: string;
  readonly parent_commit_hashes?: readonly string[];
  readonly changes?: readonly GitTreeChangeEntry[];
}

/**
 * Real HTTP endpoint (`POST /internal/v1/git/pre-receive-verify`) backing `scripts/git-hooks/pre-receive`
 * (`MVP-SPEC-03` Section 5.1, `FIX-14`, `FIX-16`).
 * Validates per-lease HMAC Bearer tokens, inspects incoming Git commits (including quarantine `GIT_OBJECT_DIRECTORY`),
 * runs `pushStagingGitRefWithGatekeeper` under a real async deadline race, and fails closed on errors/timeouts.
 */
export class AgentGatewayHttpServer {
  private readonly store: SoftwareFactoryControlPlaneStore;
  private readonly tokenService: EphemeralGitPushTokenService;
  private readonly host: string;
  private readonly requestedPort: number;
  private server: Server | null = null;
  public deadlineMs: number;
  public simulateControlPlaneOutage: boolean;
  public authorizeCheckHook?: (signal: AbortSignal) => Promise<void>;

  constructor(options: {
    store: SoftwareFactoryControlPlaneStore;
    tokenService: EphemeralGitPushTokenService;
    host?: string;
    port?: number;
    deadlineMs?: number;
    simulateControlPlaneOutage?: boolean;
    authorizeCheckHook?: (signal: AbortSignal) => Promise<void>;
  }) {
    this.store = options.store;
    this.tokenService = options.tokenService;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.deadlineMs = options.deadlineMs ?? 2000;
    this.simulateControlPlaneOutage = options.simulateControlPlaneOutage ?? false;
    this.authorizeCheckHook = options.authorizeCheckHook;
  }

  public async start(): Promise<{ port: number; url: string }> {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === "object") {
        return {
          port: addr.port,
          url: `http://${this.host}:${addr.port}/internal/v1/git/pre-receive-verify`,
        };
      }
    }

    this.server = createServer((req, res) => {
      void this.routeRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.requestedPort, this.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });

    const addr = this.server.address();
    if (!addr || typeof addr !== "object") {
      throw new Error("Failed to resolve bound port for AgentGatewayHttpServer");
    }
    return {
      port: addr.port,
      url: `http://${this.host}:${addr.port}/internal/v1/git/pre-receive-verify`,
    };
  }

  public async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    const srv = this.server;
    this.server = null;
    if (typeof srv.closeAllConnections === "function") {
      srv.closeAllConnections();
    }
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
      Connection: "close",
    });
    res.end(payload);
  }

  private async readJsonBody(req: IncomingMessage): Promise<PreReceiveHttpRequestBody> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > 1_048_576) {
        throw new Error("Request body too large");
      }
      chunks.push(buf);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as PreReceiveHttpRequestBody;
  }

  private async routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/internal/v1/git/pre-receive-verify") {
      this.sendJson(res, 404, {
        allowed: false,
        error_code: "ERR_NOT_FOUND",
        reason: "Endpoint not found",
      });
      return;
    }

    if (this.simulateControlPlaneOutage) {
      this.sendJson(res, 503, {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason: "Control Plane unavailable",
      });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      this.sendJson(res, 401, {
        allowed: false,
        error_code: "ERR_UNAUTHORIZED",
        reason: "Missing Bearer lease push token",
      });
      return;
    }
    const token = authHeader.slice("Bearer ".length).trim();

    let body: PreReceiveHttpRequestBody;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, {
        allowed: false,
        error_code: "ERR_BAD_REQUEST",
        reason: "Invalid JSON body in pre-receive request",
      });
      return;
    }

    if (!body.new_sha || !body.ref_name) {
      this.sendJson(res, 400, {
        allowed: false,
        error_code: "ERR_BAD_REQUEST",
        reason: "Missing new_sha or ref_name",
      });
      return;
    }

    const verification = this.tokenService.verifyLeasePushToken(token, body.ref_name);
    if (!verification.valid) {
      this.sendJson(res, 403, {
        allowed: false,
        error_code: "ERR_GATEKEEPER_INVALID_TOKEN",
        reason: verification.reason,
      });
      return;
    }

    const { claims } = verification;

    try {
      const result = await this.store.withRlsTransaction(
        {
          currentProjectId: claims.projectId,
          currentPrincipalId: claims.workerId,
          currentRole: "gateway_service",
        },
        async () => {
          const project = this.store.getProjectById(claims.projectId);
          const task = this.store.getTaskById(claims.taskId);
          if (!project || !task) {
            return {
              allowed: false,
              error_code: "ERR_GATEKEEPER_TASK_OR_PROJECT_NOT_FOUND",
              reason: "Project or task not found in scoped RLS context",
            };
          }

          let changes = body.changes;
          let verifiedTreeHash = body.verified_tree_hash;
          let parentCommitHashes = body.parent_commit_hashes;

          if (!changes) {
            const repoPath = body.repo_path?.trim() || project.repo_bare_path;
            const inspected = inspectRealGitCommitForImport({
              repoPath,
              expectedBaseMainCommitHash: task.base_main_commit_hash,
              agentCommitHash: body.new_sha,
              contract: task.task_contract_json as unknown as TaskContractSpec,
              gitObjectDirectory: body.git_object_directory?.trim() || undefined,
              gitAlternateObjectDirectories:
                body.git_alternate_object_directories?.trim() || undefined,
            });
            changes = inspected.changes;
            verifiedTreeHash = inspected.verified_tree_hash;
            parentCommitHashes = inspected.parent_commit_hashes;
          }

          return this.store.pushStagingGitRefWithGatekeeper({
            project_id: claims.projectId,
            task_id: claims.taskId,
            lease_id: claims.leaseId,
            lease_epoch: claims.leaseEpoch,
            staging_ref: body.ref_name,
            agent_commit_hash: body.new_sha,
            verified_tree_hash: verifiedTreeHash ?? body.new_sha,
            parent_commit_hashes: parentCommitHashes ?? [],
            changes,
            simulateControlPlaneOutage: this.simulateControlPlaneOutage,
            deadlineMs: this.deadlineMs,
            authorizeCheckHook: this.authorizeCheckHook,
          });
        }
      );

      if (result.allowed) {
        this.sendJson(res, 200, result as unknown as Record<string, unknown>);
        return;
      }
      const status =
        result.error_code === "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE" ? 504 : 403;
      this.sendJson(res, status, result as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      this.sendJson(res, 500, {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
