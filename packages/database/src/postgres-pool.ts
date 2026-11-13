import { validateProductionApproval, validateDeploymentCompletion } from "./deployment-validation.ts";
import { validateVerificationIsolation } from "./m6c3-validation.ts";
import { validateCodeImportReceipt } from "./m6c-validation.ts";
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import {
  type AgentOrgRole,
  type AgentOrganizationProfileRecord,
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type BaselineSpecFreezeRecord,
  type BudgetPauseEventRecord,
  type BudgetPauseEventType,
  type BudgetPauseScope,
  type BudgetPauseStatus,
  type BudgetUsageSummary,
  type CandidateBoundLineage,
  type ChangeRequestProposedTaskSpec,
  type ChangeRequestRecord,
  type CodeImportSubmissionRecord,
  type CostPreflightCheckInput,
  type CostPreflightCheckResult,
  type CostSessionRecord,
  type DevEpicRecord,
  type DevMilestoneRecord,
  type DevUserStoryRecord,
  type ExecutionTargetType,
  type FinalizeModelCallInput,
  type FinalizeModelCallResult,
  type LeaseSyncStatusResponse,
  type MergeCandidateRecord,
  type MergeOperationRecord,
  type MergeQueueEntryRecord,
  type MergeQueueEntryStatus,
  type ModelCallLedgerRecord,
  type ModelCallStatus,
  type ModelProviderName,
  type OutboxEventRecord,
  type PipelineSessionStatus,
  type PipelineStageName,
  type ProcessedWorkerEventRecord,
  type ProductionDeploymentApprovalRecord,
  type ProductionDeploymentRecord,
  type ProductPipelineBundle,
  type ProductPipelineSessionRecord,
  type ProjectBootstrapRecord,
  type ProjectBudgetPolicyRecord,
  type ProjectBudgetSnapshot,
  type ReleaseAcceptancePackageRecord,
  type ResourceUsageMetricRecord,
  type ReviewArtifactRecord,
  type ReviewSessionRecord,
  type ReviewSessionStatus,
  type ServerEventAckContract,
  type SnapshotRetentionClass,
  type Stage1ConfirmationStatus,
  type Stage1DiscoveryItemRecord,
  type Stage1ItemKind,
  type Stage7DevelopmentPlanBundle,
  type StageApprovalGateRecord,
  type StageApprovalGateStage,
  type StageArtifactKind,
  type StageArtifactRecord,
  type TargetTrustTier,
  type TaskBudgetPolicyRecord,
  type TaskDependencyKind,
  type TaskDependencyRecord,
  type TaskLeaseRecord,
  type TaskPlanLinkRecord,
  type TaskRecord,
  type TaskStatus,
  type Tier3AssertionEvidence,
  type TrustedAcceptanceTestSpec,
  type VerificationExecutionBackend,
  type VerificationOverallStatus,
  type VerificationRunRecord,
  type VerifiedCodeImportRecord,
  type WorkerEventEnvelope,
  WORKER_EVENT_STATE_TRANSITIONS,
  computeCanonicalPayloadSha256,
  computeTaskExecutionIdempotencyKey,
  evaluatePostcallLimits,
  evaluatePreflightLimits,
} from "@software-factory/shared-types";
import {
  type GitTreeChangeEntry,
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  doTaskAllowedFilesIntersect,
  validateGitTreeImport,
} from "@software-factory/task-contract";
import {
  Ac10ViolationError,
  type AddTaskDependencyInput,
  type ApplyChangeRequestStoreInput,
  ApprovalExpiredOrStaleError,
  BudgetAutoPausedError,
  type CasMergeResult,
  type CompleteMergeQueueEntryInput,
  type ControlPlaneStore,
  type CreateChangeRequestStoreInput,
  type CreateCostSessionInput,
  type CreateProductPipelineSessionInput,
  type CreateProjectBootstrapInput,
  type CreateStage1DiscoveryItemsInput,
  type CreateStage7DevelopmentPlanInput,
  type DecideChangeRequestStoreInput,
  type EnqueueMergeCandidateInput,
  type FreezeBaselineSpecInput,
  PostgresRlsError,
  type ProjectMemberRole,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type RecordReleaseAcceptancePackageInput,
  type RecordResourceUsageMetricInput,
  type RecordStageApprovalGateInput,
  type RecordStageArtifactInput,
  type ResolveStage1DiscoveryItemInput,
  type ResumeProjectBudgetInput,
  type ResumeTaskBudgetInput,
  type RlsSessionContext,
  SimulatedPostMergeCrashError,
  TaskDependencyBlockedError,
  type UpsertAgentOrganizationProfileInput,
  type UpsertProjectBudgetPolicyInput,
  type UpsertTaskBudgetPolicyInput,
} from "./types.ts";
import {
  buildProductPipelineBundle,
  computeBaselineFreezeBundleSha256,
  normalizeCreateStage1DiscoveryItem,
  validateCreateCostSessionInput,
  validateFreezeBaselineSpecInvariants,
  validateStage2Ac10References,
  validateStageArtifactKindAndHash,
} from "./m6a-validation.ts";
import {
  computeChangeRequestSha256,
  computeProjectBootstrapSha256,
  computeReleasePackageSha256,
  serializeTrustedAcceptanceTestSpecs,
  validateAgentOrganizationProfileInput,
  validateProjectBootstrapInput,
} from "./m6b-validation.ts";

export type PostgresSslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface PostgresPoolConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly maxConnections?: number;
  readonly connectTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  readonly maxRecvBufferBytes?: number;
  readonly maxScramIterations?: number;
  readonly applicationName?: string;
  readonly sslMode?: PostgresSslMode;
  readonly sslRootCertPath?: string;
  readonly sslCaPem?: string;
  readonly sslServername?: string;
  readonly allowInsecureRemoteDisableSsl?: boolean;
  readonly allowInsecureCleartextAuth?: boolean;
  readonly allowLegacyMd5Auth?: boolean;
}

export interface PostgresPoolStats {
  readonly maxConnections: number;
  readonly totalConnections: number;
  readonly idleConnections: number;
  readonly activeConnections: number;
  readonly waitingCount: number;
  readonly transactionsExecuted: number;
  readonly discardAllExecuted: number;
}

export interface PostgresColumnMeta {
  readonly name: string;
  readonly typeOid: number;
}

export interface PostgresQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount: number;
  readonly commandTag: string;
}

export class PostgresQueryError extends Error {
  public readonly sqlState: string;
  public readonly constraint?: string;
  public readonly detail?: string;

  constructor(sqlState: string, message: string, constraint?: string, detail?: string) {
    super(message);
    this.name = "PostgresQueryError";
    this.sqlState = sqlState;
    this.constraint = constraint;
    this.detail = detail;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function parseSslMode(raw: string | undefined): PostgresSslMode | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "disable" ||
    normalized === "prefer" ||
    normalized === "require" ||
    normalized === "verify-ca" ||
    normalized === "verify-full"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported PostgreSQL sslmode: ${raw}`);
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer config value, got: ${raw}`);
  }
  return parsed;
}

export function buildPostgresPoolConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PostgresPoolConfig | null {
  const parseSharedOptions = (urlParams?: URLSearchParams) => {
    const sslMode = parseSslMode(urlParams?.get("sslmode") ?? env.PGSSLMODE);
    const sslRootCertPath =
      urlParams?.get("sslrootcert")?.trim() || env.PGSSLROOTCERT?.trim() || undefined;
    const connectSeconds = parseOptionalPositiveInt(
      urlParams?.get("connect_timeout") ?? undefined
    );
    const connectTimeoutMs =
      parseOptionalPositiveInt(env.PGCONNECT_TIMEOUT_MS) ??
      (connectSeconds !== undefined ? connectSeconds * 1000 : undefined);
    const queryTimeoutMs =
      parseOptionalPositiveInt(urlParams?.get("query_timeout") ?? undefined) ??
      parseOptionalPositiveInt(env.PGQUERY_TIMEOUT_MS);
    const acquireTimeoutMs =
      parseOptionalPositiveInt(urlParams?.get("acquire_timeout") ?? undefined) ??
      parseOptionalPositiveInt(env.PGACQUIRE_TIMEOUT_MS);
    const socketTimeoutMs = parseOptionalPositiveInt(env.PGSOCKET_TIMEOUT_MS);
    const maxRecvBufferBytes = parseOptionalPositiveInt(env.PGMAX_RECV_BUFFER_BYTES);
    const maxScramIterations = parseOptionalPositiveInt(env.PGMAX_SCRAM_ITERATIONS);
    return {
      ...(sslMode ? { sslMode } : {}),
      ...(sslRootCertPath ? { sslRootCertPath } : {}),
      ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
      ...(queryTimeoutMs !== undefined ? { queryTimeoutMs } : {}),
      ...(acquireTimeoutMs !== undefined ? { acquireTimeoutMs } : {}),
      ...(socketTimeoutMs !== undefined ? { socketTimeoutMs } : {}),
      ...(maxRecvBufferBytes !== undefined ? { maxRecvBufferBytes } : {}),
      ...(maxScramIterations !== undefined ? { maxScramIterations } : {}),
      ...(env.PG_ALLOW_INSECURE_CLEARTEXT_AUTH === "1"
        ? { allowInsecureCleartextAuth: true }
        : {}),
      ...(env.PG_ALLOW_LEGACY_MD5_AUTH === "1" ? { allowLegacyMd5Auth: true } : {}),
      ...(env.PG_ALLOW_INSECURE_REMOTE_DISABLE_SSL === "1"
        ? { allowInsecureRemoteDisableSsl: true }
        : {}),
    };
  };

  if (env.DATABASE_URL && env.DATABASE_URL.trim().length > 0) {
    const parsed = new URL(env.DATABASE_URL);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(parsed.username || "postgres"),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      maxConnections: env.PGPOOL_MAX ? Number.parseInt(env.PGPOOL_MAX, 10) : 10,
      applicationName: parsed.searchParams.get("application_name") || "software-factory-runtime",
      ...parseSharedOptions(parsed.searchParams),
    };
  }
  if (!env.PGHOST || env.PGHOST.trim().length === 0) {
    return null;
  }
  return {
    host: env.PGHOST,
    port: env.PGPORT ? Number.parseInt(env.PGPORT, 10) : 5432,
    database: env.PGDATABASE || "postgres",
    user: env.PGUSER || "postgres",
    password: env.PGPASSWORD,
    maxConnections: env.PGPOOL_MAX ? Number.parseInt(env.PGPOOL_MAX, 10) : 10,
    applicationName: "software-factory-runtime",
    ...parseSharedOptions(),
  };
}

interface WireFrame {
  readonly type: string;
  readonly payload: Buffer;
}

function readCString(buf: Buffer, offset: number): { value: string; nextOffset: number } {
  const nullIdx = buf.indexOf(0, offset);
  if (nullIdx === -1) {
    return { value: buf.toString("utf8", offset), nextOffset: buf.length };
  }
  return {
    value: buf.toString("utf8", offset, nullIdx),
    nextOffset: nullIdx + 1,
  };
}

function buildStartupPacket(config: PostgresPoolConfig): Buffer {
  const parts: Buffer[] = [];
  const pushPair = (k: string, v: string): void => {
    parts.push(Buffer.from(k, "utf8"), Buffer.from([0]), Buffer.from(v, "utf8"), Buffer.from([0]));
  };
  pushPair("user", config.user);
  pushPair("database", config.database);
  pushPair("client_encoding", "UTF8");
  pushPair("DateStyle", "ISO, MDY");
  if (config.applicationName) {
    pushPair("application_name", config.applicationName);
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const header = Buffer.allocUnsafe(8);
  header.writeInt32BE(8 + body.length, 0);
  header.writeInt32BE(196608, 4); // Protocol v3.0
  return Buffer.concat([header, body]);
}

function buildTypedMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(type.charCodeAt(0), 0);
  header.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([header, body]);
}

function encodeParamValue(value: unknown): Buffer | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return Buffer.from(value ? "t" : "f", "utf8");
  }
  if (value instanceof Date) {
    return Buffer.from(value.toISOString(), "utf8");
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(`\\x${value.toString("hex")}`, "utf8");
  }
  if (typeof value === "object") {
    return Buffer.from(JSON.stringify(value), "utf8");
  }
  return Buffer.from(String(value), "utf8");
}

function normalizePgTimestampToIso(raw: string): string {
  const trimmed = raw.trim();
  // PG outputs e.g. "2026-11-11 01:23:45.678901+00" or "2026-11-11 01:23:45.678901"
  let isoCandidate = trimmed.replace(" ", "T");
  if (/[+-]\d{2}$/.test(isoCandidate)) {
    isoCandidate += ":00";
  } else if (!/[Z+-]/.test(isoCandidate.slice(10))) {
    isoCandidate += "Z";
  }
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  return parsed.toISOString();
}

function decodePgCell(raw: string, typeOid: number): unknown {
  switch (typeOid) {
    case 16: // bool
      return raw === "t" || raw === "true" || raw === "1";
    case 21: // int2
    case 23: // int4
    case 26: // oid
    case 20: { // int8
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : raw;
    }
    case 700: // float4
    case 701: // float8
    case 1700: // numeric
      return Number.parseFloat(raw);
    case 114: // json
    case 3802: // jsonb
      return JSON.parse(raw);
    case 1114: // timestamp
    case 1184: // timestamptz
      return normalizePgTimestampToIso(raw);
    case 1042: // bpchar (CHAR(n))
      return raw.trimEnd();
    default:
      return raw;
  }
}

function parseRowCountFromCommandTag(tag: string): number {
  const parts = tag.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  if (!last) {
    return 0;
  }
  const n = Number.parseInt(last, 10);
  return Number.isFinite(n) ? n : 0;
}

function parsePgErrorFields(payload: Buffer): {
  sqlState: string;
  message: string;
  constraint?: string;
  detail?: string;
} {
  let offset = 0;
  let sqlState = "XX000";
  let message = "PostgreSQL error";
  let constraint: string | undefined;
  let detail: string | undefined;
  while (offset < payload.length) {
    const fieldType = payload.readUInt8(offset);
    offset += 1;
    if (fieldType === 0) {
      break;
    }
    const { value, nextOffset } = readCString(payload, offset);
    offset = nextOffset;
    const ch = String.fromCharCode(fieldType);
    if (ch === "C") {
      sqlState = value;
    } else if (ch === "M") {
      message = value;
    } else if (ch === "n") {
      constraint = value;
    } else if (ch === "D") {
      detail = value;
    }
  }
  return { sqlState, message, constraint, detail };
}

interface WireWaiter {
  resolve: (frame: WireFrame) => void;
  reject: (err: Error) => void;
  cleanup?: () => void;
}

class PooledPgConnection {
  public readonly id: string = randomUUID();
  private readonly socket: net.Socket | tls.TLSSocket;
  private readonly config: PostgresPoolConfig;
  private readonly maxRecvBufferBytes: number;
  private readonly queryTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly socketTimeoutMs: number;
  private readonly maxScramIterations: number;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private waiters: WireWaiter[] = [];
  private wireQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private closeError: Error | null = null;
  public lastTxStatus: "I" | "T" | "E" = "I";

  private constructor(socket: net.Socket | tls.TLSSocket, config: PostgresPoolConfig) {
    this.socket = socket;
    this.config = config;
    this.maxRecvBufferBytes = Math.max(4096, config.maxRecvBufferBytes ?? 16 * 1024 * 1024);
    this.queryTimeoutMs = Math.max(1, config.queryTimeoutMs ?? 15_000);
    this.connectTimeoutMs = Math.max(1, config.connectTimeoutMs ?? 5_000);
    this.socketTimeoutMs = config.socketTimeoutMs ?? 60_000;
    this.maxScramIterations = Math.max(4096, config.maxScramIterations ?? 200_000);

    if (this.socketTimeoutMs > 0 && Number.isFinite(this.socketTimeoutMs)) {
      this.socket.setTimeout(this.socketTimeoutMs);
    }

    this.socket.on("timeout", () => {
      const err = new Error(`PostgreSQL socket timeout after ${this.socketTimeoutMs}ms`);
      this.failConnection(err);
    });

    this.socket.on("data", (chunk: Buffer) => {
      if (this.closed) {
        return;
      }
      if (this.recvBuffer.length + chunk.length > this.maxRecvBufferBytes) {
        this.failConnection(
          new Error(
            `PostgreSQL wire recvBuffer exceeded maxRecvBufferBytes (${this.maxRecvBufferBytes})`
          )
        );
        return;
      }
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      this.drainWaiters();
    });
    this.socket.on("error", (err) => {
      this.closed = true;
      this.closeError ??= err;
      this.rejectAllWaiters(err);
    });
    this.socket.on("close", () => {
      this.closed = true;
      const err = this.closeError ?? new Error("PostgreSQL connection closed unexpectedly");
      this.closeError ??= err;
      this.rejectAllWaiters(err);
    });
  }

  public isAlive(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  private failConnection(err: Error): void {
    if (!this.closeError) {
      this.closeError = err;
    }
    this.closed = true;
    this.recvBuffer = Buffer.alloc(0);
    this.rejectAllWaiters(err);
    if (!this.socket.destroyed) {
      this.socket.destroy(err);
    }
  }

  private enqueueWireOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.wireQueue.then(fn, fn);
    this.wireQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private rejectAllWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.cleanup?.();
        waiter.reject(err);
      }
    }
  }

  private tryPopFrame(): WireFrame | null {
    if (this.recvBuffer.length < 5) {
      return null;
    }
    const type = String.fromCharCode(this.recvBuffer.readUInt8(0));
    const totalLen = this.recvBuffer.readInt32BE(1);
    if (totalLen < 4 || 1 + totalLen > this.maxRecvBufferBytes) {
      this.failConnection(
        new Error(
          `PostgreSQL wire frame length ${totalLen} outside allowed range (4..${this.maxRecvBufferBytes})`
        )
      );
      return null;
    }
    const frameEnd = 1 + totalLen;
    if (this.recvBuffer.length < frameEnd) {
      return null;
    }
    const payload = this.recvBuffer.subarray(5, frameEnd);
    this.recvBuffer = this.recvBuffer.subarray(frameEnd);
    return { type, payload };
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      const frame = this.tryPopFrame();
      if (!frame) {
        break;
      }
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.cleanup?.();
        waiter.resolve(frame);
      }
    }
  }

  private nextFrame(deadlineAtMs?: number): Promise<WireFrame> {
    const queued = this.tryPopFrame();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("PostgreSQL connection is already closed")
      );
    }
    const remainingMs =
      deadlineAtMs !== undefined ? deadlineAtMs - Date.now() : this.queryTimeoutMs;
    if (remainingMs <= 0) {
      const err = new Error(
        `PostgreSQL wire read timed out after ${this.queryTimeoutMs}ms`
      );
      this.failConnection(err);
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter: WireWaiter = {
        resolve: (frame) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
        cleanup: () => {
          clearTimeout(timer);
        },
      };
      const timer = setTimeout(() => {
        if (settled) return;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        const err = new Error(
          `PostgreSQL wire read timed out after ${Math.max(1, remainingMs)}ms`
        );
        this.failConnection(err);
        waiter.reject(err);
      }, remainingMs);
      this.waiters.push(waiter);
    });
  }

  private static resolveEffectiveSslMode(config: PostgresPoolConfig): PostgresSslMode {
    if (config.sslMode) {
      return config.sslMode;
    }
    return isLoopbackHost(config.host) ? "prefer" : "require";
  }

  private static resolveTlsCa(config: PostgresPoolConfig): string | undefined {
    if (config.sslCaPem && config.sslCaPem.trim().length > 0) {
      return config.sslCaPem;
    }
    if (config.sslRootCertPath && config.sslRootCertPath.trim().length > 0) {
      return readFileSync(config.sslRootCertPath, "utf8");
    }
    return undefined;
  }

  public static async connect(config: PostgresPoolConfig): Promise<PooledPgConnection> {
    const sslMode = PooledPgConnection.resolveEffectiveSslMode(config);
    if (
      sslMode === "disable" &&
      !isLoopbackHost(config.host) &&
      config.allowInsecureRemoteDisableSsl !== true
    ) {
      throw new Error(
        `Refusing insecure sslmode=disable for non-loopback PostgreSQL host "${config.host}" without allowInsecureRemoteDisableSsl`
      );
    }

    const timeoutMs = Math.max(1, config.connectTimeoutMs ?? 5000);
    const deadlineAtMs = Date.now() + timeoutMs;

    const tcpSocket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection({
        host: config.host,
        port: config.port,
      });
      const timer = setTimeout(() => {
        sock.destroy(new Error(`PostgreSQL connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.setNoDelay(true);
        resolve(sock);
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    let activeSocket: net.Socket | tls.TLSSocket = tcpSocket;

    if (sslMode !== "disable") {
      try {
        const sslResponseByte = await new Promise<number>((resolve, reject) => {
          const remainingMs = Math.max(1, deadlineAtMs - Date.now());
          let settled = false;
          const cleanup = (): void => {
            clearTimeout(timer);
            tcpSocket.removeListener("data", onData);
            tcpSocket.removeListener("error", onError);
            tcpSocket.removeListener("close", onClose);
          };
          const onData = (chunk: Buffer): void => {
            if (settled || chunk.length === 0) return;
            settled = true;
            cleanup();
            resolve(chunk.readUInt8(0));
          };
          const onError = (err: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
          };
          const onClose = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error("PostgreSQL closed socket during SSL negotiation"));
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            const err = new Error(`PostgreSQL SSL negotiation timeout after ${timeoutMs}ms`);
            tcpSocket.destroy(err);
            reject(err);
          }, remainingMs);

          tcpSocket.on("data", onData);
          tcpSocket.once("error", onError);
          tcpSocket.once("close", onClose);

          // PG wire SSLRequest: length=8, request code=80877103
          const sslReq = Buffer.allocUnsafe(8);
          sslReq.writeInt32BE(8, 0);
          sslReq.writeInt32BE(80877103, 4);
          tcpSocket.write(sslReq);
        });

        if (sslResponseByte === 0x53 /* 'S' */) {
          const caPem = PooledPgConnection.resolveTlsCa(config);
          const verifyHost = (config.sslServername ?? config.host).trim().replace(/^\[|\]$/g, "");
          const tlsOptions: tls.ConnectionOptions = {
            socket: tcpSocket,
            ...(caPem ? { ca: caPem } : {}),
            ...(verifyHost && net.isIP(verifyHost) === 0 ? { servername: verifyHost } : {}),
          };

          if (sslMode === "verify-full") {
            tlsOptions.rejectUnauthorized = true;
            tlsOptions.host = verifyHost;
          } else if (sslMode === "verify-ca") {
            tlsOptions.rejectUnauthorized = true;
            tlsOptions.checkServerIdentity = () => undefined;
          } else if (caPem) {
            tlsOptions.rejectUnauthorized = true;
            tlsOptions.checkServerIdentity = () => undefined;
          } else {
            tlsOptions.rejectUnauthorized = false;
          }

          activeSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const remainingMs = Math.max(1, deadlineAtMs - Date.now());
            let settled = false;
            const tlsSock = tls.connect(tlsOptions);
            const cleanup = (): void => {
              clearTimeout(timer);
              tlsSock.removeListener("secureConnect", onSecure);
              tlsSock.removeListener("error", onError);
              tlsSock.removeListener("close", onClose);
            };
            const onSecure = (): void => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(tlsSock);
            };
            const onError = (err: Error): void => {
              if (settled) return;
              settled = true;
              cleanup();
              tlsSock.destroy();
              reject(err);
            };
            const onClose = (): void => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error("PostgreSQL TLS handshake closed before completion"));
            };
            const timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              const err = new Error(`PostgreSQL TLS handshake timeout after ${timeoutMs}ms`);
              tlsSock.destroy(err);
              reject(err);
            }, remainingMs);

            tlsSock.once("secureConnect", onSecure);
            tlsSock.once("error", onError);
            tlsSock.once("close", onClose);
          });
        } else if (sslResponseByte === 0x4e /* 'N' */) {
          if (sslMode !== "prefer") {
            throw new Error(
              `PostgreSQL server refused TLS (responded 'N' to SSLRequest) under sslmode=${sslMode}`
            );
          }
        } else {
          throw new Error(
            `Unexpected PostgreSQL SSLRequest response byte: 0x${sslResponseByte.toString(16)}`
          );
        }
      } catch (err) {
        if (!tcpSocket.destroyed) {
          tcpSocket.destroy();
        }
        throw err;
      }
    }

    const conn = new PooledPgConnection(activeSocket, config);
    try {
      await conn.authenticateStartup();
      return conn;
    } catch (err) {
      await conn.close();
      throw err;
    }
  }

  private async authenticateStartup(): Promise<void> {
    const deadlineAtMs = Date.now() + this.connectTimeoutMs;
    this.socket.write(buildStartupPacket(this.config));

    let scramState:
      | {
          clientNonce: string;
          clientFirstBare: string;
          expectedServerSignature: Buffer;
        }
      | undefined;

    while (true) {
      const frame = await this.nextFrame(deadlineAtMs);
      if (frame.type === "E") {
        const parsed = parsePgErrorFields(frame.payload);
        throw new PostgresQueryError(parsed.sqlState, parsed.message, parsed.constraint, parsed.detail);
      }
      if (frame.type === "R") {
        const authCode = frame.payload.readInt32BE(0);
        if (authCode === 0) {
          continue;
        }
        const password = this.config.password ?? "";
        if (authCode === 3) {
          if (this.config.allowInsecureCleartextAuth !== true) {
            throw new Error(
              "PostgreSQL cleartext password authentication (authCode=3) rejected by default; use SCRAM-SHA-256 or set allowInsecureCleartextAuth: true"
            );
          }
          // Cleartext password (explicitly opted-in only)
          const body = Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]);
          this.socket.write(buildTypedMessage("p", body));
        } else if (authCode === 5) {
          if (this.config.allowLegacyMd5Auth !== true) {
            throw new Error(
              "PostgreSQL legacy MD5 authentication (authCode=5) rejected by default; use SCRAM-SHA-256 or set allowLegacyMd5Auth: true"
            );
          }
          // MD5 password with 4-byte salt (explicitly opted-in only)
          const salt = frame.payload.subarray(4, 8);
          const inner = createHash("md5")
            .update(password + this.config.user, "utf8")
            .digest("hex");
          const outer = createHash("md5")
            .update(Buffer.concat([Buffer.from(inner, "utf8"), salt]))
            .digest("hex");
          const body = Buffer.concat([Buffer.from(`md5${outer}`, "utf8"), Buffer.from([0])]);
          this.socket.write(buildTypedMessage("p", body));
        } else if (authCode === 10) {
          // SASL mechanisms list
          const mechanisms: string[] = [];
          let off = 4;
          while (off < frame.payload.length) {
            const { value, nextOffset } = readCString(frame.payload, off);
            off = nextOffset;
            if (value.length === 0) {
              break;
            }
            mechanisms.push(value);
          }
          if (!mechanisms.includes("SCRAM-SHA-256")) {
            throw new Error(`Unsupported SASL mechanisms from PostgreSQL: ${mechanisms.join(", ")}`);
          }
          const clientNonce = randomBytes(18).toString("base64");
          const clientFirstBare = `n=,r=${clientNonce}`;
          const clientFirstMessage = `n,,${clientFirstBare}`;
          const clientFirstBuf = Buffer.from(clientFirstMessage, "utf8");
          const mechBuf = Buffer.from("SCRAM-SHA-256", "utf8");
          const body = Buffer.allocUnsafe(mechBuf.length + 1 + 4 + clientFirstBuf.length);
          mechBuf.copy(body, 0);
          body.writeUInt8(0, mechBuf.length);
          body.writeInt32BE(clientFirstBuf.length, mechBuf.length + 1);
          clientFirstBuf.copy(body, mechBuf.length + 5);
          scramState = {
            clientNonce,
            clientFirstBare,
            expectedServerSignature: Buffer.alloc(0),
          };
          this.socket.write(buildTypedMessage("p", body));
        } else if (authCode === 11) {
          // SASLContinue
          if (!scramState) {
            throw new Error("Unexpected SCRAM-SHA-256 AuthenticationSASLContinue");
          }
          const serverFirstMessage = frame.payload.toString("utf8", 4);
          const kv = new Map<string, string>();
          for (const part of serverFirstMessage.split(",")) {
            const eq = part.indexOf("=");
            if (eq > 0) {
              kv.set(part.slice(0, eq), part.slice(eq + 1));
            }
          }
          const combinedNonce = kv.get("r") ?? "";
          const saltB64 = kv.get("s") ?? "";
          const iterStr = kv.get("i") ?? "4096";
          if (!combinedNonce.startsWith(scramState.clientNonce)) {
            throw new Error("SCRAM-SHA-256 server nonce mismatch");
          }
          if (!/^\d+$/.test(iterStr)) {
            throw new Error(`Invalid SCRAM-SHA-256 iteration count: ${iterStr}`);
          }
          const iterations = Number.parseInt(iterStr, 10);
          if (
            !Number.isFinite(iterations) ||
            iterations < 4096 ||
            iterations > this.maxScramIterations
          ) {
            throw new Error(
              `SCRAM-SHA-256 iteration count ${iterations} outside allowed bounds (4096..${this.maxScramIterations})`
            );
          }
          const salt = Buffer.from(saltB64, "base64");
          const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, "sha256");
          const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
          const storedKey = createHash("sha256").update(clientKey).digest();
          const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
          const authMessage = `${scramState.clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
          const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
          const clientProof = Buffer.allocUnsafe(clientKey.length);
          for (let i = 0; i < clientKey.length; i += 1) {
            clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
          }
          const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
          scramState.expectedServerSignature = createHmac("sha256", serverKey)
            .update(authMessage)
            .digest();
          const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
          this.socket.write(buildTypedMessage("p", Buffer.from(clientFinal, "utf8")));
        } else if (authCode === 12) {
          // SASLFinal
          if (!scramState) {
            throw new Error("Unexpected SCRAM-SHA-256 AuthenticationSASLFinal");
          }
          const serverFinal = frame.payload.toString("utf8", 4);
          const vPrefix = serverFinal.startsWith("v=") ? serverFinal.slice(2) : "";
          const serverSig = Buffer.from(vPrefix, "base64");
          if (
            serverSig.length !== scramState.expectedServerSignature.length ||
            !timingSafeEqual(serverSig, scramState.expectedServerSignature)
          ) {
            throw new Error("SCRAM-SHA-256 server signature verification failed");
          }
        } else {
          throw new Error(`Unsupported PostgreSQL authentication method code: ${authCode}`);
        }
      } else if (frame.type === "Z") {
        this.lastTxStatus = String.fromCharCode(frame.payload.readUInt8(0)) as "I" | "T" | "E";
        return;
      }
      // Ignore 'K', 'S', 'N' during startup
    }
  }

  public simpleQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string
  ): Promise<PostgresQueryResult<TRow>> {
    return this.enqueueWireOp(() => {
      if (this.closed || this.socket.destroyed) {
        return Promise.reject(
          this.closeError ?? new Error("PostgreSQL connection is closed")
        );
      }
      const body = Buffer.concat([Buffer.from(sql, "utf8"), Buffer.from([0])]);
      this.socket.write(buildTypedMessage("Q", body));
      return this.collectQueryResult<TRow>();
    });
  }

  public query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<TRow>> {
    if (params.length === 0) {
      return this.simpleQuery<TRow>(sql);
    }

    return this.enqueueWireOp(() => {
      if (this.closed || this.socket.destroyed) {
        return Promise.reject(
          this.closeError ?? new Error("PostgreSQL connection is closed")
        );
      }
      // Parse ('P'): unnamed statement "", SQL, 0 pre-specified param OIDs
      const sqlBuf = Buffer.from(sql, "utf8");
      const parseBody = Buffer.allocUnsafe(1 + sqlBuf.length + 1 + 2);
      parseBody.writeUInt8(0, 0);
      sqlBuf.copy(parseBody, 1);
      parseBody.writeUInt8(0, 1 + sqlBuf.length);
      parseBody.writeInt16BE(0, 1 + sqlBuf.length + 1);

      // Bind ('B'): portal "", statement "", 0 param format codes (all text), paramCount, values, 0 result format codes
      const encodedParams = params.map(encodeParamValue);
      const bindHeader = Buffer.allocUnsafe(6);
      bindHeader.writeUInt8(0, 0); // portal=""
      bindHeader.writeUInt8(0, 1); // statement=""
      bindHeader.writeInt16BE(0, 2); // 0 param format codes
      bindHeader.writeInt16BE(encodedParams.length, 4);
      const bindChunks: Buffer[] = [bindHeader];

      for (const p of encodedParams) {
        const lenBuf = Buffer.allocUnsafe(4);
        if (p === null) {
          lenBuf.writeInt32BE(-1, 0);
          bindChunks.push(lenBuf);
        } else {
          lenBuf.writeInt32BE(p.length, 0);
          bindChunks.push(lenBuf, p);
        }
      }
      const resultFmtBuf = Buffer.allocUnsafe(2);
      resultFmtBuf.writeInt16BE(0, 0);
      bindChunks.push(resultFmtBuf);

      // Describe ('D') portal ""
      const describeBody = Buffer.from([0x50, 0x00]); // 'P', ""
      // Execute ('E') portal "", maxRows=0
      const executeBody = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]);
      // Sync ('S')
      const syncMsg = buildTypedMessage("S", Buffer.alloc(0));

      const wirePacket = Buffer.concat([
        buildTypedMessage("P", parseBody),
        buildTypedMessage("B", Buffer.concat(bindChunks)),
        buildTypedMessage("D", describeBody),
        buildTypedMessage("E", executeBody),
        syncMsg,
      ]);
      this.socket.write(wirePacket);
      return this.collectQueryResult<TRow>();
    });
  }

  private async collectQueryResult<TRow extends Record<string, unknown>>(): Promise<
    PostgresQueryResult<TRow>
  > {
    const deadlineAtMs = Date.now() + this.queryTimeoutMs;
    let columns: PostgresColumnMeta[] = [];
    const rows: TRow[] = [];
    let rowCount = 0;
    let commandTag = "";
    let queryError: PostgresQueryError | null = null;

    while (true) {
      const frame = await this.nextFrame(deadlineAtMs);
      switch (frame.type) {
        case "1":
        case "2":
        case "3":
        case "n":
        case "N":
        case "S":
        case "K":
        case "I":
          break;
        case "T": {
          const fieldCount = frame.payload.readInt16BE(0);
          columns = [];
          let off = 2;
          for (let i = 0; i < fieldCount; i += 1) {
            const { value: name, nextOffset } = readCString(frame.payload, off);
            off = nextOffset;
            // tableOid (4) + colAttr (2) + typeOid (4) + typeSize (2) + typeMod (4) + format (2) = 18 bytes
            const typeOid = frame.payload.readInt32BE(off + 6);
            off += 18;
            columns.push({ name, typeOid });
          }
          break;
        }
        case "D": {
          const colCount = frame.payload.readInt16BE(0);
          let off = 2;
          const record: Record<string, unknown> = {};
          for (let i = 0; i < colCount; i += 1) {
            const valLen = frame.payload.readInt32BE(off);
            off += 4;
            const colMeta = columns[i];
            if (!colMeta) {
              if (valLen > 0) {
                off += valLen;
              }
              continue;
            }
            if (valLen === -1) {
              record[colMeta.name] = null;
            } else {
              const raw = frame.payload.toString("utf8", off, off + valLen);
              off += valLen;
              record[colMeta.name] = decodePgCell(raw, colMeta.typeOid);
            }
          }
          rows.push(record as TRow);
          rowCount = rows.length;
          break;
        }
        case "C": {
          const { value: tag } = readCString(frame.payload, 0);
          commandTag = tag;
          const parsedCount = parseRowCountFromCommandTag(tag);
          if (rows.length === 0) {
            rowCount = parsedCount;
          }
          break;
        }
        case "E": {
          const parsed = parsePgErrorFields(frame.payload);
          queryError = new PostgresQueryError(
            parsed.sqlState,
            parsed.message,
            parsed.constraint,
            parsed.detail
          );
          break;
        }
        case "Z": {
          this.lastTxStatus = String.fromCharCode(frame.payload.readUInt8(0)) as "I" | "T" | "E";
          if (queryError) {
            throw queryError;
          }
          return { rows, rowCount, commandTag };
        }
        default:
          break;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError ??= new Error("PostgreSQL connection closed");
    try {
      await Promise.race([
        this.enqueueWireOp(async () => {
          if (!this.socket.destroyed && this.socket.writable) {
            this.socket.write(buildTypedMessage("X", Buffer.alloc(0)));
          }
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 50).unref();
        }),
      ]);
    } catch {
      // ignore write errors during close
    }
    this.rejectAllWaiters(this.closeError);
    this.socket.end();
    this.socket.destroy();
  }
}

interface ActiveTxState {
  readonly conn: PooledPgConnection;
  readonly session: RlsSessionContext;
  readonly afterEnd: (() => Promise<void>)[];
}

interface PoolAcquireWaiter {
  settled: boolean;
  resolve: (conn: PooledPgConnection) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

/**
 * Bounded PostgreSQL Runtime Pool executing `SET LOCAL ROLE app_runtime`, scoped `app.*`
 * session settings inside `BEGIN`/`COMMIT`, and unconditional `DISCARD ALL` on release
 * before returning a connection to the pool (`RLS-T6`).
 */
export class PostgresRuntimePool {
  private readonly config: PostgresPoolConfig;
  private readonly maxConnections: number;
  private readonly acquireTimeoutMs: number;
  private readonly allConnections: Set<PooledPgConnection> = new Set();
  private readonly idleConnections: PooledPgConnection[] = [];
  private readonly activeConnections: Set<PooledPgConnection> = new Set();
  private readonly waiters: PoolAcquireWaiter[] = [];
  private readonly txAsyncStorage = new AsyncLocalStorage<ActiveTxState>();
  private transactionsExecuted = 0;
  private discardAllExecuted = 0;
  private closed = false;

  constructor(config: PostgresPoolConfig) {
    this.config = config;
    this.maxConnections = Math.max(1, config.maxConnections ?? 10);
    this.acquireTimeoutMs = Math.max(1, config.acquireTimeoutMs ?? 10_000);
  }

  public getStats(): PostgresPoolStats {
    return {
      maxConnections: this.maxConnections,
      totalConnections: this.allConnections.size,
      idleConnections: this.idleConnections.length,
      activeConnections: this.activeConnections.size,
      waitingCount: this.waiters.length,
      transactionsExecuted: this.transactionsExecuted,
      discardAllExecuted: this.discardAllExecuted,
    };
  }

  public getActiveTxSession(): RlsSessionContext | null {
    return this.txAsyncStorage.getStore()?.session ?? null;
  }

  /** Awaited after COMMIT/ROLLBACK and connection release, outside the ended TX. */
  public afterTransactionEnd(fn: () => Promise<void>): void {
    const active = this.txAsyncStorage.getStore();
    if (!active) throw new Error("afterTransactionEnd requires an active transaction");
    active.afterEnd.push(fn);
  }

  private async finishTransaction(state: ActiveTxState, originalError: unknown): Promise<void> {
    const errors: unknown[] = [];
    await this.txAsyncStorage.exit(async () => {
      for (const callback of state.afterEnd.splice(0)) {
        try { await callback(); } catch (error) { errors.push(error); }
      }
    });
    if (errors.length) throw new AggregateError(
      originalError === undefined ? errors : [originalError, ...errors],
      "Transaction ended but durable completion work failed"
    );
  }

  private popActiveWaiter(): PoolAcquireWaiter | undefined {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      if (next && !next.settled) {
        return next;
      }
    }
    return undefined;
  }

  private async acquire(): Promise<PooledPgConnection> {
    if (this.closed) {
      throw new Error("PostgresRuntimePool is closed");
    }
    while (this.idleConnections.length > 0) {
      const idle = this.idleConnections.pop()!;
      if (idle.isAlive()) {
        this.activeConnections.add(idle);
        return idle;
      }
      this.allConnections.delete(idle);
    }

    if (this.allConnections.size < this.maxConnections) {
      const conn = await PooledPgConnection.connect(this.config);
      if (this.closed) {
        await conn.close();
        throw new Error("PostgresRuntimePool is closed");
      }
      this.allConnections.add(conn);
      this.activeConnections.add(conn);
      return conn;
    }

    return new Promise((resolve, reject) => {
      const waiter: PoolAcquireWaiter = {
        settled: false,
        resolve: (conn) => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.cleanup();
          resolve(conn);
        },
        reject: (err) => {
          if (waiter.settled) return;
          waiter.settled = true;
          waiter.cleanup();
          reject(err);
        },
        cleanup: () => {
          clearTimeout(timer);
        },
      };
      const timer = setTimeout(() => {
        if (waiter.settled) return;
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        waiter.reject(
          new Error(`PostgreSQL pool acquire timeout after ${this.acquireTimeoutMs}ms`)
        );
      }, this.acquireTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  private async release(conn: PooledPgConnection): Promise<void> {
    this.activeConnections.delete(conn);

    const finalizeBroken = async (): Promise<void> => {
      this.allConnections.delete(conn);
      await conn.close();
      const next = this.popActiveWaiter();
      if (next) {
        this.acquire().then(next.resolve, next.reject);
      }
    };

    if (this.closed || !conn.isAlive()) {
      await finalizeBroken();
      return;
    }

    try {
      if (conn.lastTxStatus !== "I") {
        await conn.simpleQuery("ROLLBACK;");
      }
      await conn.simpleQuery("DISCARD ALL;");
      this.discardAllExecuted += 1;
      if (conn.lastTxStatus !== "I") {
        await finalizeBroken();
        return;
      }
      const next = this.popActiveWaiter();
      if (next) {
        this.activeConnections.add(conn);
        next.resolve(conn);
      } else {
        this.idleConnections.push(conn);
      }
    } catch {
      await finalizeBroken();
    }
  }

  public async withRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: (conn: PooledPgConnection, effectiveSession: RlsSessionContext) => Promise<T> | T
  ): Promise<T> {
    const active = this.txAsyncStorage.getStore();
    if (active) {
      const desiredProjectId =
        ctx.currentProjectId !== undefined ? ctx.currentProjectId : active.session.currentProjectId;
      const desiredPrincipalId =
        ctx.currentPrincipalId !== undefined
          ? ctx.currentPrincipalId
          : active.session.currentPrincipalId;
      const desiredRole = ctx.currentRole !== undefined ? ctx.currentRole : active.session.currentRole;

      // Reuse same transaction & connection when security scope is identical (prevents self-deadlock on FOR UPDATE).
      if (
        desiredProjectId === active.session.currentProjectId &&
        desiredPrincipalId === active.session.currentPrincipalId &&
        desiredRole === active.session.currentRole
      ) {
        return fn(active.conn, active.session);
      }
    }

    const session: RlsSessionContext = {
      currentProjectId: ctx.currentProjectId ?? null,
      currentPrincipalId: ctx.currentPrincipalId ?? null,
      currentRole: ctx.currentRole ?? "anonymous",
    };

    const conn = await this.acquire();
    this.transactionsExecuted += 1;
    let committed = false;
    let transactionError: unknown;
    const state: ActiveTxState = { conn, session, afterEnd: [] };
    try {
      await conn.simpleQuery("BEGIN; SET LOCAL ROLE app_runtime;");
      await conn.query(
        "SELECT set_config('app.current_project_id', $1::text, true), set_config('app.current_principal_id', $2::text, true), set_config('app.current_role', $3::text, true);",
        [session.currentProjectId ?? "", session.currentPrincipalId ?? "", session.currentRole]
      );
      const result = await this.txAsyncStorage.run(state, () =>
        fn(conn, session)
      );
      await conn.simpleQuery("COMMIT;");
      committed = true;
      return result;
    } catch (error) {
      transactionError = error;
      if (!committed && conn.isAlive()) {
        try {
          await conn.simpleQuery("ROLLBACK;");
        } catch {
          // ignore rollback error on broken connection
        }
      }
      throw error;
    } finally {
      await this.release(conn);
      await this.finishTransaction(state, transactionError);
    }
  }

  public async queryInActiveTx<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<PostgresQueryResult<TRow>> {
    const active = this.txAsyncStorage.getStore();
    if (active) {
      return active.conn.query<TRow>(sql, params);
    }
    // Fail-closed anonymous read/query session when called outside explicit RLS transaction
    return this.withRlsTransaction({ currentRole: "anonymous" }, (conn) =>
      conn.query<TRow>(sql, params)
    );
  }

  /**
   * Executes an independent transient PostgreSQL RLS transaction outside any active outer
   * transaction so durable audit ledgers (`BLOCKED_*` / `FAILED_*`) survive outer rollback
   * without self-deadlocking even when `maxConnections === 1`.
   */
  public async runAutonomousRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: (conn: PooledPgConnection, effectiveSession: RlsSessionContext) => Promise<T> | T
  ): Promise<T> {
    if (!this.txAsyncStorage.getStore()) {
      return this.withRlsTransaction(ctx, fn);
    }
    if (this.closed) {
      throw new Error("PostgresRuntimePool is closed");
    }
    const session: RlsSessionContext = {
      currentProjectId: ctx.currentProjectId ?? null,
      currentPrincipalId: ctx.currentPrincipalId ?? null,
      currentRole: ctx.currentRole ?? "anonymous",
    };
    const conn = await PooledPgConnection.connect(this.config);
    this.transactionsExecuted += 1;
    let committed = false;
    let transactionError: unknown;
    const state: ActiveTxState = { conn, session, afterEnd: [] };
    try {
      await conn.simpleQuery("BEGIN; SET LOCAL ROLE app_runtime;");
      await conn.query(
        "SELECT set_config('app.current_project_id', $1::text, true), set_config('app.current_principal_id', $2::text, true), set_config('app.current_role', $3::text, true);",
        [session.currentProjectId ?? "", session.currentPrincipalId ?? "", session.currentRole]
      );
      const result = await this.txAsyncStorage.run(state, () =>
        fn(conn, session)
      );
      await conn.simpleQuery("COMMIT;");
      committed = true;
      return result;
    } catch (error) {
      transactionError = error;
      if (!committed && conn.isAlive()) {
        try {
          await conn.simpleQuery("ROLLBACK;");
        } catch {
          // ignore rollback error on broken connection
        }
      }
      throw error;
    } finally {
      await conn.close();
      await this.finishTransaction(state, transactionError);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(new Error("PostgresRuntimePool closed"));
    }
    const closes = [...this.allConnections].map((c) => c.close());
    await Promise.allSettled(closes);
    this.idleConnections.length = 0;
    this.activeConnections.clear();
    this.allConnections.clear();
  }
}

function mapPgError(error: unknown): never {
  if (
    error instanceof PostgresRlsError ||
    error instanceof ApprovalExpiredOrStaleError ||
    error instanceof SimulatedPostMergeCrashError ||
    error instanceof BudgetAutoPausedError ||
    error instanceof TaskDependencyBlockedError
  ) {
    throw error;
  }
  if (error instanceof PostgresQueryError) {
    const sqlState = error.sqlState;
    const msgWithDetail = error.detail ? `${error.message} (${error.detail})` : error.message;
    if (
      sqlState === "23514" &&
      (/AC-10 violation/i.test(error.message) ||
        /chk_s1_(?:assumption|recommendation)_not_auto_verified/i.test(
          error.constraint ?? error.message
        ))
    ) {
      throw new Ac10ViolationError(msgWithDetail);
    }
    if (
      sqlState === "42501" ||
      sqlState === "23503" ||
      sqlState === "23505" ||
      sqlState === "23514"
    ) {
      throw new PostgresRlsError(sqlState, msgWithDetail);
    }
  }
  throw error;
}

function mapProjectRow(row: Record<string, unknown>): ProjectRecord {
  return {
    project_id: String(row.project_id),
    slug: String(row.slug),
    name: String(row.name),
    repo_bare_path: String(row.repo_bare_path),
    default_branch: String(row.default_branch ?? "main"),
    approval_ttl_seconds: Number(row.approval_ttl_seconds),
    main_ref_commit_hash: row.main_ref_commit_hash ? String(row.main_ref_commit_hash) : "",
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapTaskRow(row: Record<string, unknown>): TaskRecord {
  return {
    task_id: String(row.task_id),
    project_id: String(row.project_id),
    title: String(row.title),
    task_contract_json: (row.task_contract_json as Record<string, unknown>) ?? {},
    status: String(row.status) as TaskStatus,
    base_main_commit_hash: String(row.base_main_commit_hash),
    current_attempt_no: Number(row.current_attempt_no),
    rework_count: Number(row.rework_count),
    max_rework_cycles: Number(row.max_rework_cycles),
    active_lease_id: row.active_lease_id ? String(row.active_lease_id) : null,
    active_lease_epoch: Number(row.active_lease_epoch),
    active_merge_candidate_id: row.active_merge_candidate_id
      ? String(row.active_merge_candidate_id)
      : null,
    merged_commit_hash: row.merged_commit_hash ? String(row.merged_commit_hash) : null,
    merged_at: row.merged_at ? String(row.merged_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapLeaseRow(row: Record<string, unknown>): TaskLeaseRecord {
  return {
    lease_id: String(row.lease_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    attempt_no: Number(row.attempt_no),
    lease_epoch: Number(row.lease_epoch),
    worker_id: String(row.worker_id),
    status: String(row.status) as TaskLeaseRecord["status"],
    task_execution_idempotency_key: String(row.task_execution_idempotency_key),
    last_processed_seq: Number(row.last_processed_seq),
    heartbeat_interval_ms: Number(row.heartbeat_interval_ms),
    lease_ttl_ms: Number(row.lease_ttl_ms),
    leased_at: String(row.leased_at),
    last_heartbeat_at: String(row.last_heartbeat_at),
    expires_at: String(row.expires_at),
    revoked_at: row.revoked_at ? String(row.revoked_at) : null,
    revoke_reason: row.revoke_reason ? String(row.revoke_reason) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapProcessedEventRow(row: Record<string, unknown>): ProcessedWorkerEventRecord {
  return {
    event_id: String(row.event_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    lease_id: String(row.lease_id),
    lease_epoch: Number(row.lease_epoch),
    sequence_no: Number(row.sequence_no),
    event_type: String(row.event_type) as ProcessedWorkerEventRecord["event_type"],
    event_idempotency_key: String(row.event_idempotency_key),
    payload_sha256: String(row.payload_sha256),
    payload_json: (row.payload_json as Record<string, unknown>) ?? {},
    processed_at: String(row.processed_at),
  };
}

function mapVerifiedImportRow(row: Record<string, unknown>): VerifiedCodeImportRecord {
  return {
    import_id: String(row.import_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    lease_id: String(row.lease_id),
    lease_epoch: Number(row.lease_epoch),
    agent_commit_hash: String(row.agent_commit_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    staging_ref: String(row.staging_ref),
    changed_files_count: Number(row.changed_files_count),
    deleted_lines_count: Number(row.deleted_lines_count),
    recovered_by_reconciler: Boolean(row.recovered_by_reconciler ?? false),
    created_at: String(row.created_at),
  };
}

function mapMergeCandidateRow(row: Record<string, unknown>): MergeCandidateRecord {
  return {
    merge_candidate_id: String(row.merge_candidate_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    import_id: String(row.import_id),
    agent_commit_hash: String(row.agent_commit_hash),
    base_main_commit_hash: String(row.base_main_commit_hash),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    is_superseded: Boolean(row.is_superseded),
    snapshot_path: row.snapshot_path ? String(row.snapshot_path) : null,
    snapshot_sha256: row.snapshot_sha256 ? String(row.snapshot_sha256) : null,
    snapshot_size_bytes:
      row.snapshot_size_bytes !== null && row.snapshot_size_bytes !== undefined
        ? Number(row.snapshot_size_bytes)
        : null,
    snapshot_retention_class: row.snapshot_retention_class
      ? (String(row.snapshot_retention_class) as SnapshotRetentionClass)
      : "EPHEMERAL_14D",
    created_at: String(row.created_at),
  };
}

function mapVerificationRunRow(row: Record<string, unknown>): VerificationRunRecord {
  return {
    verification_run_id: String(row.verification_run_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    verifier_image_digest: String(row.verifier_image_digest),
    verdict: String(row.verdict) as "PASS" | "FAIL",
    overall_status: String(row.overall_status) as VerificationOverallStatus,
    tier1_trusted_acceptance_passed:
      row.tier1_trusted_acceptance_passed === null
        ? null
        : Boolean(row.tier1_trusted_acceptance_passed),
    tier2_protected_baseline_passed:
      row.tier2_protected_baseline_passed === null
        ? null
        : Boolean(row.tier2_protected_baseline_passed),
    tier2_baseline_tamper_detected: Boolean(row.tier2_baseline_tamper_detected),
    tampered_baseline_paths: Array.isArray(row.tampered_baseline_paths)
      ? (row.tampered_baseline_paths as string[])
      : [],
    tier3_agent_tests_passed:
      row.tier3_agent_tests_passed === null ? null : Boolean(row.tier3_agent_tests_passed),
    tier3_assertions: Array.isArray(row.tier3_assertions_json)
      ? (row.tier3_assertions_json as Tier3AssertionEvidence[])
      : [],
    infra_retry_count: Number(row.infra_retry_count ?? 0),
    execution_backend: String(row.execution_backend ?? "docker") as VerificationExecutionBackend,
    hermetic_network_disabled: Boolean(row.hermetic_network_disabled ?? true),
    hardlink_cache_forbidden: Boolean(row.hardlink_cache_forbidden ?? true),
    is_docker_isolated: Boolean(row.is_docker_isolated ?? false),
    isolation_runtime: row.isolation_runtime === "runsc" ? "runsc" : null,
    trusted_policy_sha256: row.trusted_policy_sha256 ? String(row.trusted_policy_sha256) : null,
    exit_code: Number(row.exit_code),
    duration_ms: Number(row.duration_ms),
    report_sha256: String(row.report_sha256),
    created_at: String(row.created_at),
  };
}

function mapReviewSessionRow(row: Record<string, unknown>): ReviewSessionRecord {
  return {
    review_session_id: String(row.review_session_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    verification_run_id: String(row.verification_run_id),
    reviewer_principal_id: String(row.reviewer_principal_id),
    reviewer_credential_id: String(row.reviewer_credential_id),
    reviewer_agent_profile_id: String(row.reviewer_agent_profile_id),
    reviewer_provider: String(row.reviewer_provider),
    reviewer_model: String(row.reviewer_model),
    role: "ROLE_REVIEWER_READONLY",
    sandbox_backend_mode: String(row.sandbox_backend_mode),
    sandbox_pid:
      row.sandbox_pid !== null && row.sandbox_pid !== undefined ? Number(row.sandbox_pid) : null,
    sandbox_cgroup_path: row.sandbox_cgroup_path ? String(row.sandbox_cgroup_path) : null,
    cleanup_populated_zero_verified: Boolean(row.cleanup_populated_zero_verified),
    status: String(row.status) as ReviewSessionStatus,
    started_at: String(row.started_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapReviewArtifactRow(row: Record<string, unknown>): ReviewArtifactRecord {
  return {
    review_artifact_id: String(row.review_artifact_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    verification_run_id: String(row.verification_run_id),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    writer_provider: String(row.writer_provider),
    writer_model: String(row.writer_model),
    reviewer_provider: String(row.reviewer_provider),
    reviewer_model: String(row.reviewer_model),
    developer_principal_id: String(row.developer_principal_id),
    reviewer_principal_id: String(row.reviewer_principal_id),
    developer_session_id: String(row.developer_session_id),
    reviewer_session_id: String(row.reviewer_session_id),
    developer_credential_id: row.developer_credential_id
      ? String(row.developer_credential_id)
      : null,
    reviewer_credential_id: row.reviewer_credential_id
      ? String(row.reviewer_credential_id)
      : null,
    developer_agent_profile_id: row.developer_agent_profile_id
      ? String(row.developer_agent_profile_id)
      : null,
    reviewer_agent_profile_id: row.reviewer_agent_profile_id
      ? String(row.reviewer_agent_profile_id)
      : null,
    review_session_id: row.review_session_id ? String(row.review_session_id) : null,
    verdict: String(row.verdict) as "PASS" | "FAIL",
    status: row.status ? (String(row.status) as ReviewArtifactRecord["status"]) : "VALID",
    is_invalidated: Boolean(row.is_invalidated),
    invalidated_reason: row.invalidated_reason ? String(row.invalidated_reason) : null,
    summary_markdown: row.summary_markdown ? String(row.summary_markdown) : null,
    report_sha256: row.report_sha256 ? String(row.report_sha256) : null,
    findings_json: Array.isArray(row.findings_json)
      ? (row.findings_json as ReadonlyArray<Record<string, unknown>>)
      : [],
    created_at: String(row.created_at),
  };
}

function mapApprovalRequestRow(row: Record<string, unknown>): ApprovalRequestRecord {
  return {
    approval_request_id: String(row.approval_request_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    agent_commit_hash: String(row.agent_commit_hash),
    base_main_commit_hash: String(row.base_main_commit_hash),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    verification_run_id: String(row.verification_run_id),
    review_artifact_id: String(row.review_artifact_id),
    status: String(row.status) as ApprovalRequestRecord["status"],
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapApprovalDecisionRow(row: Record<string, unknown>): ApprovalDecisionRecord {
  return {
    approval_id: String(row.approval_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    approval_request_id: row.approval_request_id ? String(row.approval_request_id) : null,
    agent_commit_hash: String(row.agent_commit_hash),
    base_main_commit_hash: String(row.base_main_commit_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verification_run_id: String(row.verification_run_id),
    review_artifact_id: String(row.review_artifact_id),
    approver_principal_id: String(row.approver_principal_id),
    decision: String(row.decision) as ApprovalDecisionRecord["decision"],
    status: String(row.status) as ApprovalDecisionRecord["status"],
    invalidated_reason: row.invalidated_reason ? String(row.invalidated_reason) : null,
    approved_at: String(row.approved_at),
    expires_at: String(row.expires_at),
    consumed_at: row.consumed_at ? String(row.consumed_at) : null,
  };
}

function mapMergeOperationRow(row: Record<string, unknown>): MergeOperationRecord {
  return {
    merge_op_id: String(row.merge_op_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    approval_id: String(row.approval_id),
    merge_idempotency_key: String(row.merge_idempotency_key),
    base_main_commit_hash: String(row.base_main_commit_hash),
    merge_candidate_hash: String(row.merge_candidate_hash),
    verified_tree_hash: String(row.verified_tree_hash),
    status: String(row.status) as MergeOperationRecord["status"],
    reconciled_after_lost_response: Boolean(row.reconciled_after_lost_response),
    retry_count: Number(row.retry_count),
    last_error: row.last_error ? String(row.last_error) : null,
    created_at: String(row.created_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapResourceMetricRow(row: Record<string, unknown>): ResourceUsageMetricRecord {
  return {
    metric_id: String(row.metric_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    lease_id: row.lease_id ? String(row.lease_id) : null,
    lease_epoch: Number(row.lease_epoch),
    attempt_no: Number(row.attempt_no),
    rework_cycle: Number(row.rework_cycle),
    phase: String(row.phase) as ResourceUsageMetricRecord["phase"],
    wall_time_ms: Number(row.wall_time_ms),
    cpu_usage_usec: Number(row.cpu_usage_usec),
    peak_memory_bytes: Number(row.peak_memory_bytes),
    sandbox_backend_mode: String(row.sandbox_backend_mode),
    metrics_source: String(row.metrics_source) as ResourceUsageMetricRecord["metrics_source"],
    recorded_at: String(row.recorded_at),
  };
}

function mapOutboxRow(row: Record<string, unknown>): OutboxEventRecord {
  return {
    outbox_id: String(row.outbox_id),
    project_id: String(row.project_id),
    aggregate_type: String(row.aggregate_type),
    aggregate_id: String(row.aggregate_id),
    event_type: String(row.event_type),
    payload_json: (row.payload_json as Record<string, unknown>) ?? {},
    published_at: row.published_at ? String(row.published_at) : null,
    created_at: String(row.created_at),
  };
}

function toSafeInt(value: unknown, fieldName: string): number {
  if (typeof value === "bigint") {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${fieldName} (${value.toString()}) exceeds JavaScript safe integer range`);
    }
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new RangeError(`${fieldName} (${value}) is not a safe integer`);
    }
    const parsed = BigInt(trimmed);
    if (parsed < BigInt(Number.MIN_SAFE_INTEGER) || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError(`${fieldName} (${value}) exceeds JavaScript safe integer range`);
    }
    return Number(parsed);
  }
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(num)) {
    throw new RangeError(`${fieldName} (${String(value)}) is not a safe integer`);
  }
  return num;
}

function mapCostSessionRow(row: Record<string, unknown>): CostSessionRecord {
  return {
    cost_session_id: String(row.cost_session_id),
    project_id: String(row.project_id),
    pipeline_session_id: row.pipeline_session_id ? String(row.pipeline_session_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    max_tokens_per_request: toSafeInt(row.max_tokens_per_request, "max_tokens_per_request"),
    max_cost_micro_usd_per_request: toSafeInt(
      row.max_cost_micro_usd_per_request,
      "max_cost_micro_usd_per_request"
    ),
    session_token_budget: toSafeInt(row.session_token_budget, "session_token_budget"),
    session_cost_budget_micro_usd: toSafeInt(
      row.session_cost_budget_micro_usd,
      "session_cost_budget_micro_usd"
    ),
    tokens_used_total: toSafeInt(row.tokens_used_total, "tokens_used_total"),
    cost_used_micro_usd: toSafeInt(row.cost_used_micro_usd, "cost_used_micro_usd"),
    status: String(row.status) as CostSessionRecord["status"],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapModelCallLedgerRow(row: Record<string, unknown>): ModelCallLedgerRecord {
  return {
    call_id: String(row.call_id),
    project_id: String(row.project_id),
    cost_session_id: String(row.cost_session_id),
    pipeline_session_id: row.pipeline_session_id ? String(row.pipeline_session_id) : null,
    task_id: row.task_id ? String(row.task_id) : null,
    stage: String(row.stage),
    provider: String(row.provider) as ModelProviderName,
    model: String(row.model),
    prompt_id: String(row.prompt_id),
    prompt_version: String(row.prompt_version),
    prompt_sha256: String(row.prompt_sha256).trimEnd(),
    request_sha256: String(row.request_sha256).trimEnd(),
    estimated_input_tokens: toSafeInt(row.estimated_input_tokens, "estimated_input_tokens"),
    reserved_output_tokens: toSafeInt(row.reserved_output_tokens, "reserved_output_tokens"),
    actual_input_tokens: toSafeInt(row.actual_input_tokens, "actual_input_tokens"),
    actual_output_tokens: toSafeInt(row.actual_output_tokens, "actual_output_tokens"),
    actual_total_tokens: toSafeInt(row.actual_total_tokens, "actual_total_tokens"),
    estimated_cost_micro_usd: toSafeInt(
      row.estimated_cost_micro_usd,
      "estimated_cost_micro_usd"
    ),
    actual_cost_micro_usd: toSafeInt(row.actual_cost_micro_usd, "actual_cost_micro_usd"),
    status: String(row.status) as ModelCallStatus,
    usage_estimated: Boolean(row.usage_estimated),
    block_reason: row.block_reason ? String(row.block_reason) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    latency_ms: toSafeInt(row.latency_ms, "latency_ms"),
    created_at: String(row.created_at),
  };
}

function mapProductPipelineSessionRow(row: Record<string, unknown>): ProductPipelineSessionRecord {
  return {
    pipeline_session_id: String(row.pipeline_session_id),
    project_id: String(row.project_id),
    cost_session_id: row.cost_session_id ? String(row.cost_session_id) : null,
    title: String(row.title),
    raw_idea_text: String(row.raw_idea_text),
    current_stage: String(row.current_stage) as PipelineStageName,
    status: String(row.status) as PipelineSessionStatus,
    frozen_baseline_id: row.frozen_baseline_id ? String(row.frozen_baseline_id) : null,
    created_by_principal_id: String(row.created_by_principal_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapStage1DiscoveryItemRow(row: Record<string, unknown>): Stage1DiscoveryItemRecord {
  return {
    item_id: String(row.item_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    kind: String(row.kind) as Stage1ItemKind,
    title: String(row.title),
    statement: String(row.statement),
    rationale: String(row.rationale),
    clarification_question: row.clarification_question ? String(row.clarification_question) : null,
    confirmation_status: String(row.confirmation_status) as Stage1ConfirmationStatus,
    confirmed_by_principal_id: row.confirmed_by_principal_id
      ? String(row.confirmed_by_principal_id)
      : null,
    confirmed_at: row.confirmed_at ? String(row.confirmed_at) : null,
    resolution_note: row.resolution_note ? String(row.resolution_note) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapStageArtifactRow(row: Record<string, unknown>): StageArtifactRecord {
  const contentJson = (row.content_json as Record<string, unknown>) ?? {};
  const artifactSha256 = String(row.artifact_sha256).trimEnd();
  const record: StageArtifactRecord = {
    artifact_id: String(row.artifact_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    stage: String(row.stage) as PipelineStageName,
    artifact_kind: String(row.artifact_kind) as StageArtifactKind,
    version: Number(row.version),
    provider: String(row.provider) as ModelProviderName | "system",
    model: String(row.model),
    prompt_id: String(row.prompt_id),
    prompt_version: String(row.prompt_version),
    prompt_sha256: String(row.prompt_sha256).trimEnd(),
    content_json: contentJson,
    artifact_sha256: artifactSha256,
    created_by_principal_id: String(row.created_by_principal_id),
    created_at: String(row.created_at),
  };
  const computed = computeCanonicalPayloadSha256(contentJson);
  if (computed !== artifactSha256.toLowerCase()) {
    throw new PostgresRlsError(
      "23514",
      `Integrity check failed for StageArtifact ${record.artifact_id}: content_json canonical sha256 (${computed}) !== artifact_sha256 (${artifactSha256})`
    );
  }
  return record;
}

function mapStageApprovalGateRow(row: Record<string, unknown>): StageApprovalGateRecord {
  return {
    gate_id: String(row.gate_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    gate_stage: String(row.gate_stage) as StageApprovalGateStage,
    target_artifact_id: String(row.target_artifact_id),
    target_artifact_sha256: String(row.target_artifact_sha256).trimEnd(),
    approver_principal_id: String(row.approver_principal_id),
    decision: String(row.decision) as StageApprovalGateRecord["decision"],
    rationale: row.rationale ? String(row.rationale) : null,
    decided_at: String(row.decided_at),
  };
}

function mapBaselineSpecFreezeRow(row: Record<string, unknown>): BaselineSpecFreezeRecord {
  const record: BaselineSpecFreezeRecord = {
    baseline_id: String(row.baseline_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    stage1_artifact_id: String(row.stage1_artifact_id),
    stage1_artifact_sha256: String(row.stage1_artifact_sha256).trimEnd(),
    stage2_artifact_id: String(row.stage2_artifact_id),
    stage2_artifact_sha256: String(row.stage2_artifact_sha256).trimEnd(),
    stage3_artifact_id: String(row.stage3_artifact_id),
    stage3_artifact_sha256: String(row.stage3_artifact_sha256).trimEnd(),
    validation_report_artifact_id: String(row.validation_report_artifact_id),
    validation_report_sha256: String(row.validation_report_sha256).trimEnd(),
    approval_gate_id: String(row.approval_gate_id),
    frozen_by_principal_id: String(row.frozen_by_principal_id),
    freeze_bundle_sha256: String(row.freeze_bundle_sha256).trimEnd(),
    status: "FROZEN",
    frozen_at: String(row.frozen_at),
  };
  const computed = computeBaselineFreezeBundleSha256(record);
  if (computed !== record.freeze_bundle_sha256.toLowerCase()) {
    throw new PostgresRlsError(
      "23514",
      `Integrity check failed for BaselineSpecFreeze ${record.baseline_id}: computed sha256 (${computed}) !== stored (${record.freeze_bundle_sha256})`
    );
  }
  return record;
}

function asStringArrayCell(val: unknown): string[] {
  return Array.isArray(val) ? val.map((item) => String(item)) : [];
}

function mapProjectBootstrapRow(row: Record<string, unknown>): ProjectBootstrapRecord {
  const record: ProjectBootstrapRecord = {
    bootstrap_id: String(row.bootstrap_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    baseline_id: String(row.baseline_id),
    repo_path: String(row.repo_path),
    trusted_acceptance_dir: String(row.trusted_acceptance_dir),
    base_main_commit_hash: String(row.base_main_commit_hash).trimEnd(),
    protected_paths: asStringArrayCell(row.protected_paths_json),
    trusted_policy_sha256: String(row.trusted_policy_sha256).trimEnd(),
    generated_files: asStringArrayCell(row.generated_files_json),
    acceptance_tests: Array.isArray(row.acceptance_tests_json)
      ? (row.acceptance_tests_json as TrustedAcceptanceTestSpec[])
      : [],
    bootstrap_sha256: String(row.bootstrap_sha256).trimEnd(),
    created_by_principal_id: String(row.created_by_principal_id),
    created_at: String(row.created_at),
  };
  const computed = computeProjectBootstrapSha256(record);
  if (computed !== record.bootstrap_sha256.toLowerCase()) {
    throw new PostgresRlsError(
      "23514",
      `Integrity check failed for ProjectBootstrap ${record.bootstrap_id}: computed sha256 (${computed}) !== stored (${record.bootstrap_sha256})`
    );
  }
  return record;
}

function mapAgentOrganizationProfileRow(
  row: Record<string, unknown>
): AgentOrganizationProfileRecord {
  return {
    profile_id: String(row.profile_id),
    project_id: String(row.project_id),
    profile_key: String(row.profile_key),
    role: String(row.role) as AgentOrgRole,
    principal_id: String(row.principal_id),
    provider: String(row.provider),
    model: String(row.model),
    execution_target_type: String(row.execution_target_type) as ExecutionTargetType,
    trust_tier: String(row.trust_tier) as TargetTrustTier,
    target_locator: row.target_locator ? String(row.target_locator) : null,
    capabilities_json: (row.capabilities_json as Record<string, unknown>) ?? {},
    is_active: Boolean(row.is_active),
    created_by_principal_id: String(row.created_by_principal_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapDevMilestoneRow(row: Record<string, unknown>): DevMilestoneRecord {
  return {
    milestone_id: String(row.milestone_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    baseline_id: String(row.baseline_id),
    milestone_key: String(row.milestone_key),
    title: String(row.title),
    description: String(row.description),
    sequence_order: Number(row.sequence_order),
    created_at: String(row.created_at),
  };
}

function mapDevEpicRow(row: Record<string, unknown>): DevEpicRecord {
  return {
    epic_id: String(row.epic_id),
    project_id: String(row.project_id),
    milestone_id: String(row.milestone_id),
    epic_key: String(row.epic_key),
    title: String(row.title),
    description: String(row.description),
    sequence_order: Number(row.sequence_order),
    created_at: String(row.created_at),
  };
}

function mapDevUserStoryRow(row: Record<string, unknown>): DevUserStoryRecord {
  return {
    story_id: String(row.story_id),
    project_id: String(row.project_id),
    epic_id: String(row.epic_id),
    story_key: String(row.story_key),
    title: String(row.title),
    description: String(row.description),
    requirement_ids: asStringArrayCell(row.requirement_ids_json),
    ac_ids: asStringArrayCell(row.ac_ids_json),
    sequence_order: Number(row.sequence_order),
    created_at: String(row.created_at),
  };
}

function mapTaskPlanLinkRow(row: Record<string, unknown>): TaskPlanLinkRecord {
  return {
    link_id: String(row.link_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    baseline_id: String(row.baseline_id),
    bootstrap_id: row.bootstrap_id ? String(row.bootstrap_id) : null,
    story_id: row.story_id ? String(row.story_id) : null,
    task_id: String(row.task_id),
    cr_id: row.cr_id ? String(row.cr_id) : null,
    requirement_ids: asStringArrayCell(row.requirement_ids_json),
    ac_ids: asStringArrayCell(row.ac_ids_json),
    assigned_profile_id: row.assigned_profile_id ? String(row.assigned_profile_id) : null,
    created_at: String(row.created_at),
  };
}

function mapChangeRequestRow(row: Record<string, unknown>): ChangeRequestRecord {
  const record: ChangeRequestRecord = {
    cr_id: String(row.cr_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    baseline_id: String(row.baseline_id),
    cr_key: String(row.cr_key),
    title: String(row.title),
    rationale: String(row.rationale),
    impacted_requirement_ids: asStringArrayCell(row.impacted_requirement_ids_json),
    impacted_component_ids: asStringArrayCell(row.impacted_component_ids_json),
    proposed_tasks: Array.isArray(row.proposed_tasks_json)
      ? (row.proposed_tasks_json as ChangeRequestProposedTaskSpec[])
      : [],
    status: String(row.status) as ChangeRequestRecord["status"],
    requested_by_principal_id: String(row.requested_by_principal_id),
    decided_by_principal_id: row.decided_by_principal_id
      ? String(row.decided_by_principal_id)
      : null,
    decision_rationale: row.decision_rationale ? String(row.decision_rationale) : null,
    decided_at: row.decided_at ? String(row.decided_at) : null,
    applied_by_principal_id: row.applied_by_principal_id
      ? String(row.applied_by_principal_id)
      : null,
    applied_at: row.applied_at ? String(row.applied_at) : null,
    cr_sha256: String(row.cr_sha256).trimEnd(),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
  const computed = computeChangeRequestSha256(record);
  if (computed !== record.cr_sha256.toLowerCase()) {
    throw new PostgresRlsError(
      "23514",
      `Integrity check failed for ChangeRequest ${record.cr_id}: computed sha256 (${computed}) !== stored (${record.cr_sha256})`
    );
  }
  return record;
}

function mapProductionApproval(row: Record<string, unknown>): ProductionDeploymentApprovalRecord {
  return { approval_id: String(row.approval_id), project_id: String(row.project_id), pipeline_session_id: String(row.pipeline_session_id),
    release_id: String(row.release_id), release_package_sha256: String(row.release_package_sha256), commit_hash: String(row.commit_hash), artifact_sha256: String(row.artifact_sha256),
    target_key: String(row.target_key), approver_principal_id: String(row.approver_principal_id), issued_at: new Date(String(row.issued_at)).toISOString(),
    expires_at: new Date(String(row.expires_at)).toISOString(), token_sha256: String(row.token_sha256), status: row.status as ProductionDeploymentApprovalRecord["status"] };
}
function mapProductionDeployment(row: Record<string, unknown>): ProductionDeploymentRecord {
  return { deployment_id: String(row.deployment_id), project_id: String(row.project_id), approval_id: String(row.approval_id), target_key: String(row.target_key),
    requested_by_principal_id: String(row.requested_by_principal_id), status: row.status as ProductionDeploymentRecord["status"], started_at: new Date(String(row.started_at)).toISOString(),
    completed_at: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null, receipt_sha256: row.receipt_sha256 ? String(row.receipt_sha256) : null };
}

function mapReleaseAcceptancePackageRow(
  row: Record<string, unknown>
): ReleaseAcceptancePackageRecord {
  const record: ReleaseAcceptancePackageRecord = {
    release_id: String(row.release_id),
    project_id: String(row.project_id),
    pipeline_session_id: String(row.pipeline_session_id),
    baseline_id: String(row.baseline_id),
    traceability_sha256: String(row.traceability_sha256).trimEnd(),
    coverage_percent: Number(row.coverage_percent),
    complete: Boolean(row.is_complete),
    total_requirements: Number(row.total_requirements),
    merged_task_ids: asStringArrayCell(row.merged_task_ids_json),
    applied_cr_ids: asStringArrayCell(row.applied_cr_ids_json),
    main_head_commit_hash: String(row.main_head_commit_hash).trimEnd(),
    summary_markdown: String(row.summary_markdown),
    package_json: (row.package_json as Record<string, unknown>) ?? {},
    package_sha256: String(row.package_sha256).trimEnd(),
    accepted_by_principal_id: String(row.accepted_by_principal_id),
    accepted_at: String(row.accepted_at),
  };
  const computed = computeReleasePackageSha256(record);
  if (computed !== record.package_sha256.toLowerCase()) {
    throw new PostgresRlsError(
      "23514",
      `Integrity check failed for ReleaseAcceptancePackage ${record.release_id}: computed sha256 (${computed}) !== stored (${record.package_sha256})`
    );
  }
  return record;
}

function toNullableSafeInt(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toSafeInt(value, fieldName);
}

function mapCodeImportSubmissionRow(row: Record<string, unknown>): CodeImportSubmissionRecord {
  return { submission_id: String(row.submission_id), project_id: String(row.project_id), task_id: String(row.task_id),
    lease_id: String(row.lease_id), lease_epoch: toSafeInt(row.lease_epoch, "lease_epoch"), import_id: String(row.import_id),
    source_type: String(row.source_type) as CodeImportSubmissionRecord["source_type"], payload_sha256: String(row.payload_sha256).trim(),
    agent_commit_hash: String(row.agent_commit_hash).trim(), verified_tree_hash: String(row.verified_tree_hash).trim(),
    staging_ref: String(row.staging_ref), submitted_by_principal_id: String(row.submitted_by_principal_id), created_at: String(row.created_at) };
}

function mapTaskDependencyRow(row: Record<string, unknown>): TaskDependencyRecord {
  return {
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    depends_on_task_id: String(row.depends_on_task_id),
    dependency_kind: String(row.dependency_kind) as TaskDependencyKind,
    created_at: String(row.created_at),
  };
}

function mapMergeQueueEntryRow(row: Record<string, unknown>): MergeQueueEntryRecord {
  return {
    queue_entry_id: String(row.queue_entry_id),
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    merge_candidate_id: String(row.merge_candidate_id),
    approval_id: String(row.approval_id),
    queue_position: toSafeInt(row.queue_position, "queue_position"),
    status: String(row.status) as MergeQueueEntryStatus,
    attempt_count: toSafeInt(row.attempt_count, "attempt_count"),
    rebased_from_candidate_id: row.rebased_from_candidate_id
      ? String(row.rebased_from_candidate_id)
      : null,
    rebased_to_candidate_id: row.rebased_to_candidate_id
      ? String(row.rebased_to_candidate_id)
      : null,
    merged_commit_hash: row.merged_commit_hash
      ? String(row.merged_commit_hash).trimEnd()
      : null,
    last_error: row.last_error ? String(row.last_error) : null,
    enqueued_at: String(row.enqueued_at),
    started_at: row.started_at ? String(row.started_at) : null,
    completed_at: row.completed_at ? String(row.completed_at) : null,
    updated_at: String(row.updated_at),
  };
}

function mapProjectBudgetPolicyRow(row: Record<string, unknown>): ProjectBudgetPolicyRecord {
  return {
    project_id: String(row.project_id),
    max_project_tokens: toNullableSafeInt(row.max_project_tokens, "max_project_tokens"),
    max_project_cost_micro_usd: toNullableSafeInt(
      row.max_project_cost_micro_usd,
      "max_project_cost_micro_usd"
    ),
    max_project_wall_time_ms: toNullableSafeInt(
      row.max_project_wall_time_ms,
      "max_project_wall_time_ms"
    ),
    default_task_max_tokens: toNullableSafeInt(
      row.default_task_max_tokens,
      "default_task_max_tokens"
    ),
    default_task_max_cost_micro_usd: toNullableSafeInt(
      row.default_task_max_cost_micro_usd,
      "default_task_max_cost_micro_usd"
    ),
    default_task_max_wall_time_ms: toNullableSafeInt(
      row.default_task_max_wall_time_ms,
      "default_task_max_wall_time_ms"
    ),
    max_concurrent_tasks: toSafeInt(row.max_concurrent_tasks, "max_concurrent_tasks"),
    status: String(row.status) as BudgetPauseStatus,
    pause_scope: row.pause_scope ? (String(row.pause_scope) as BudgetPauseScope) : null,
    paused_task_id: row.paused_task_id ? String(row.paused_task_id) : null,
    pause_reason: row.pause_reason ? String(row.pause_reason) : null,
    paused_at: row.paused_at ? String(row.paused_at) : null,
    resumed_by_principal_id: row.resumed_by_principal_id
      ? String(row.resumed_by_principal_id)
      : null,
    resumed_at: row.resumed_at ? String(row.resumed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapTaskBudgetPolicyRow(row: Record<string, unknown>): TaskBudgetPolicyRecord {
  return {
    project_id: String(row.project_id),
    task_id: String(row.task_id),
    max_task_tokens: toNullableSafeInt(row.max_task_tokens, "max_task_tokens"),
    max_task_cost_micro_usd: toNullableSafeInt(
      row.max_task_cost_micro_usd,
      "max_task_cost_micro_usd"
    ),
    max_task_wall_time_ms: toNullableSafeInt(row.max_task_wall_time_ms, "max_task_wall_time_ms"),
    status: String(row.status) as BudgetPauseStatus,
    pause_scope: row.pause_scope ? (String(row.pause_scope) as BudgetPauseScope) : null,
    pause_reason: row.pause_reason ? String(row.pause_reason) : null,
    paused_at: row.paused_at ? String(row.paused_at) : null,
    resumed_by_principal_id: row.resumed_by_principal_id
      ? String(row.resumed_by_principal_id)
      : null,
    resumed_at: row.resumed_at ? String(row.resumed_at) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapBudgetPauseEventRow(row: Record<string, unknown>): BudgetPauseEventRecord {
  return {
    event_id: String(row.event_id),
    project_id: String(row.project_id),
    task_id: row.task_id ? String(row.task_id) : null,
    event_type: String(row.event_type) as BudgetPauseEventType,
    pause_scope: row.pause_scope ? (String(row.pause_scope) as BudgetPauseScope) : null,
    reason: String(row.reason),
    observed_tokens: toSafeInt(row.observed_tokens, "observed_tokens"),
    observed_cost_micro_usd: toSafeInt(row.observed_cost_micro_usd, "observed_cost_micro_usd"),
    observed_wall_time_ms: toSafeInt(row.observed_wall_time_ms, "observed_wall_time_ms"),
    limit_value: toNullableSafeInt(row.limit_value, "limit_value"),
    actor_principal_id: row.actor_principal_id ? String(row.actor_principal_id) : null,
    created_at: String(row.created_at),
  };
}

/**
 * Live PostgreSQL Control Plane Repository backed by `PostgresRuntimePool`.
 * Executes parameterized SQL statements inside `BEGIN; SET LOCAL ROLE app_runtime; ... COMMIT; DISCARD ALL;`
 * enforcing real PostgreSQL 4-Tier RLS, canonical lock ordering, composite FKs, and append-only auditability.
 */
export class PostgresControlPlaneRepository implements ControlPlaneStore {
  public readonly pool: PostgresRuntimePool;
  // Local fallback staging refs cache for synthetic (non-filesystem Git) reconciler tests
  private readonly fallbackGitRefsByProject: Map<string, Map<string, string>> = new Map();
  private readonly fallbackGitCommitsByProject: Map<
    string,
    Map<string, { commitHash: string; treeHash: string; parents: string[]; taskId?: string }>
  > = new Map();

  constructor(pool: PostgresRuntimePool) {
    this.pool = pool;
  }

  public async clockTimestampIso(): Promise<string> {
    const res = await this.pool.queryInActiveTx<{ now_ts: string }>(
      "SELECT clock_timestamp() AS now_ts;"
    );
    return String(res.rows[0]?.now_ts ?? new Date().toISOString());
  }

  public withRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: () => Promise<T> | T
  ): Promise<T> {
    return this.pool.withRlsTransaction(ctx, () => fn());
  }

  private withExistingOrRlsTransaction<T>(
    ctx: Partial<RlsSessionContext>,
    fn: () => Promise<T> | T
  ): Promise<T> {
    if (this.pool.getActiveTxSession()) {
      return Promise.resolve(fn());
    }
    return this.withRlsTransaction(ctx, fn);
  }

  private async insertOutboxEventSql(
    projectId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.queryInActiveTx(
      `INSERT INTO outbox_events (project_id, aggregate_type, aggregate_id, event_type, payload_json)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::text, $5::jsonb);`,
      [projectId, aggregateType, aggregateId, eventType, payload]
    );
  }

  public async createProject(input: {
    project_id?: string;
    slug: string;
    name: string;
    repo_bare_path: string;
    initial_main_commit_hash: string;
    initial_main_tree_hash?: string;
    approval_ttl_seconds?: number;
  }): Promise<ProjectRecord> {
    const approvalTtlSeconds = input.approval_ttl_seconds ?? 86_400;
    const projectId = input.project_id ?? randomUUID();
    try {
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO projects (
          project_id, slug, name, repo_bare_path, default_branch,
          approval_ttl_seconds, main_ref_commit_hash
        ) VALUES ($1::uuid, $2::text, $3::text, $4::text, 'main', $5::integer, $6::text)
        RETURNING *;`,
        [
          projectId,
          input.slug,
          input.name,
          input.repo_bare_path,
          approvalTtlSeconds,
          input.initial_main_commit_hash,
        ]
      );
      const record = mapProjectRow(res.rows[0]!);
      this.fallbackGitRefsByProject.set(
        projectId,
        new Map([["refs/heads/main", input.initial_main_commit_hash]])
      );
      this.fallbackGitCommitsByProject.set(
        projectId,
        new Map([
          [
            input.initial_main_commit_hash,
            {
              commitHash: input.initial_main_commit_hash,
              treeHash: input.initial_main_tree_hash ?? input.initial_main_commit_hash,
              parents: [],
            },
          ],
        ])
      );
      return record;
    } catch (error) {
      mapPgError(error);
    }
  }

  public async addProjectMembership(input: {
    project_id: string;
    principal_id: string;
    member_role: ProjectMemberRole;
  }): Promise<ProjectMembershipRecord> {
    try {
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO project_memberships (project_id, principal_id, member_role)
         VALUES ($1::uuid, $2::text, $3::text)
         ON CONFLICT (project_id, principal_id)
         DO UPDATE SET member_role = EXCLUDED.member_role
         RETURNING *;`,
        [input.project_id, input.principal_id, input.member_role]
      );
      const row = res.rows[0]!;
      return {
        membership_id: String(row.membership_id),
        project_id: String(row.project_id),
        principal_id: String(row.principal_id),
        member_role: String(row.member_role) as ProjectMemberRole,
        created_at: String(row.created_at),
      };
    } catch (error) {
      mapPgError(error);
    }
  }

  public async getProjectMembership(
    projectId: string,
    principalId: string
  ): Promise<ProjectMembershipRecord | null> {
    const active = this.pool.getActiveTxSession();
    const run = async (): Promise<ProjectMembershipRecord | null> => {
      const res = await this.pool.queryInActiveTx(
        `SELECT * FROM project_memberships WHERE project_id = $1::uuid AND principal_id = $2::text LIMIT 1;`,
        [projectId, principalId]
      );
      const row = res.rows[0];
      if (!row) {
        return null;
      }
      return {
        membership_id: String(row.membership_id),
        project_id: String(row.project_id),
        principal_id: String(row.principal_id),
        member_role: String(row.member_role) as ProjectMemberRole,
        created_at: String(row.created_at),
      };
    };

    if (
      active &&
      (active.currentProjectId === projectId || active.currentRole === "system_admin_role")
    ) {
      return run();
    }
    return this.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: principalId,
        currentRole: "core_api_service",
      },
      run
    );
  }

  public async getProjectById(projectId: string): Promise<ProjectRecord | null> {
    const active = this.pool.getActiveTxSession();
    const run = async (): Promise<ProjectRecord | null> => {
      const res = await this.pool.queryInActiveTx(
        `SELECT * FROM projects WHERE project_id = $1::uuid LIMIT 1;`,
        [projectId]
      );
      return res.rows[0] ? mapProjectRow(res.rows[0]) : null;
    };
    if (
      active &&
      (active.currentProjectId === projectId || active.currentRole === "system_admin_role")
    ) {
      return run();
    }
    return this.withRlsTransaction(
      {
        currentProjectId: projectId,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      run
    );
  }

  public async createTask(input: {
    task_id?: string;
    project_id: string;
    title: string;
    task_contract: TaskContractSpec;
    base_main_commit_hash?: string;
    max_rework_cycles?: number;
    depends_on_task_ids?: readonly string[];
  }): Promise<TaskRecord> {
    const taskId = input.task_id ?? randomUUID();
    const maxReworkCycles = input.max_rework_cycles ?? 3;
    try {
      const project = await this.getProjectById(input.project_id);
      if (!project) {
        throw new PostgresRlsError("23503", `Project ${input.project_id} does not exist`);
      }
      const baseMain = input.base_main_commit_hash ?? project.main_ref_commit_hash;
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO tasks (
          task_id, project_id, title, task_contract_json, status,
          base_main_commit_hash, current_attempt_no, rework_count, max_rework_cycles
        ) VALUES ($1::uuid, $2::uuid, $3::text, $4::jsonb, 'Ready', $5::text, 0, 0, $6::integer)
        RETURNING *;`,
        [taskId, input.project_id, input.title, input.task_contract, baseMain, maxReworkCycles]
      );
      if (input.depends_on_task_ids && input.depends_on_task_ids.length > 0) {
        const seenDeps = new Set<string>();
        for (const rawDepId of input.depends_on_task_ids) {
          const depId = rawDepId.trim();
          if (!depId || seenDeps.has(depId)) continue;
          seenDeps.add(depId);
          await this.insertTaskDependencySql({
            project_id: input.project_id,
            task_id: taskId,
            depends_on_task_id: depId,
            dependency_kind: "MANUAL",
          });
        }
      }
      return mapTaskRow(res.rows[0]!);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async selectVisibleTasks(): Promise<TaskRecord[]> {
    const res = await this.pool.queryInActiveTx("SELECT * FROM tasks ORDER BY created_at ASC;");
    return res.rows.map(mapTaskRow);
  }

  public async getTaskById(taskId: string): Promise<TaskRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM tasks WHERE task_id = $1::uuid LIMIT 1;",
      [taskId]
    );
    return res.rows[0] ? mapTaskRow(res.rows[0]) : null;
  }

  public async updateTaskTitleRls(taskId: string, newTitle: string): Promise<number> {
    try {
      const res = await this.pool.queryInActiveTx(
        `UPDATE tasks SET title = $1::text, updated_at = clock_timestamp()
         WHERE task_id = $2::uuid;`,
        [newTitle, taskId]
      );
      return res.rowCount;
    } catch (error) {
      mapPgError(error);
    }
  }

  public async deleteProcessedWorkerEventRls(eventId: string): Promise<never> {
    try {
      await this.pool.queryInActiveTx(
        "DELETE FROM processed_worker_events WHERE event_id = $1::uuid;",
        [eventId]
      );
      throw new PostgresRlsError(
        "42501",
        "Expected DELETE on processed_worker_events to be rejected by permissions/RLS"
      );
    } catch (error) {
      mapPgError(error);
    }
  }

  public async deleteTaskRls(taskId: string): Promise<number> {
    try {
      const res = await this.pool.queryInActiveTx(
        "DELETE FROM tasks WHERE task_id = $1::uuid;",
        [taskId]
      );
      return res.rowCount;
    } catch (error) {
      mapPgError(error);
    }
  }

  public async grantTaskLease(input: {
    project_id: string;
    task_id: string;
    worker_id: string;
    heartbeat_interval_ms?: number;
    lease_ttl_ms?: number;
    reject_overlapping_active_files?: boolean;
  }): Promise<TaskLeaseRecord> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      async () => {
        try {
          {
            await this.pool.queryInActiveTx(
              "SELECT pg_advisory_xact_lock(hashtext('lease-dispatch:' || $1::text));",
              [input.project_id]
            );
          }

          const taskExistsRes = await this.pool.queryInActiveTx(
            "SELECT 1 FROM tasks WHERE task_id = $1::uuid AND project_id = $2::uuid LIMIT 1;",
            [input.task_id, input.project_id]
          );
          if (taskExistsRes.rowCount === 0) {
            throw new PostgresRlsError(
              "23503",
              `Task ${input.task_id} not found in project ${input.project_id}`
            );
          }

          // Canonical lock order: project_budget_policies -> task_budget_policies -> tasks
          await this.assertBudgetAllowsExecutionSql({
            project_id: input.project_id,
            task_id: input.task_id,
            projected_tokens: 0,
            projected_cost_micro_usd: 0,
          });

          const taskRes = await this.pool.queryInActiveTx(
            "SELECT * FROM tasks WHERE task_id = $1::uuid AND project_id = $2::uuid FOR UPDATE;",
            [input.task_id, input.project_id]
          );
          const taskRow = taskRes.rows[0];
          if (!taskRow) {
            throw new PostgresRlsError(
              "23503",
              `Task ${input.task_id} not found in project ${input.project_id}`
            );
          }
          const task = mapTaskRow(taskRow);

          const blockingDepsRes = await this.pool.queryInActiveTx<{ depends_on_task_id: string }>(
            `SELECT td.depends_on_task_id
             FROM task_dependencies td
             LEFT JOIN tasks up ON up.task_id = td.depends_on_task_id AND up.project_id = td.project_id
             WHERE td.project_id = $1::uuid
               AND td.task_id = $2::uuid
               AND up.status IS DISTINCT FROM 'MergedAndCompleted'
             ORDER BY td.depends_on_task_id ASC;`,
            [input.project_id, task.task_id]
          );
          if (blockingDepsRes.rows.length > 0) {
            const blockingIds = blockingDepsRes.rows.map((r) => String(r.depends_on_task_id));
            throw new TaskDependencyBlockedError({
              message: `Cannot grant lease for task ${task.task_id}: upstream dependencies are not MergedAndCompleted (${blockingIds.join(", ")})`,
              projectId: input.project_id,
              taskId: task.task_id,
              blockingTaskIds: blockingIds,
            });
          }

          if (input.reject_overlapping_active_files) {
            const activeTasksRes = await this.pool.queryInActiveTx<{
              task_id: string;
              task_contract_json: Record<string, unknown>;
            }>(
              `SELECT task_id, task_contract_json
               FROM tasks
               WHERE project_id = $1::uuid
                 AND task_id <> $2::uuid
                 AND status IN (
                   'Leased', 'ExecutingInTarget', 'BuildingMergeCandidate',
                   'VerifyingInDocker', 'UnderIndependentReview',
                   'AwaitingHumanApproval', 'AtomicCasMerge'
                 )
               ORDER BY created_at ASC;`,
              [input.project_id, task.task_id]
            );
            const capRes = await this.pool.queryInActiveTx("SELECT max_concurrent_tasks FROM project_budget_policies WHERE project_id = $1::uuid;", [input.project_id]);
            const cap = Number(capRes.rows[0]?.max_concurrent_tasks ?? 4);
            if (activeTasksRes.rows.length >= cap) throw new PostgresRlsError("23514", "Project concurrency limit reached");
            for (const otherRow of activeTasksRes.rows) {
              const overlap = doTaskAllowedFilesIntersect(
                task.task_contract_json as unknown as TaskContractSpec,
                otherRow.task_contract_json as unknown as TaskContractSpec
              );
              if (overlap.intersects) {
                throw new PostgresRlsError(
                  "23514",
                  `Cannot grant lease for task ${task.task_id}: allowed_files overlaps with active task ${String(otherRow.task_id)} (witness: ${overlap.details[0]?.witnessPath ?? "unknown"})`
                );
              }
            }
          }

          if (task.status !== "Ready" && task.status !== "ReworkRequired") {
            throw new PostgresRlsError("23514", `Cannot grant lease when task is in status ${task.status}`);
          }

          let nextReworkCount = task.rework_count;
          if (task.status === "ReworkRequired") {
            if (task.rework_count >= task.max_rework_cycles) {
              await this.pool.queryInActiveTx(
                "UPDATE tasks SET status = 'ManualIntervention', updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
                [task.task_id]
              );
              throw new PostgresRlsError(
                "23514",
                `Max rework cycles (${task.max_rework_cycles}) exceeded for task ${task.task_id}; moved to ManualIntervention`
              );
            }
            nextReworkCount += 1;
          }

          const hbMs = input.heartbeat_interval_ms ?? 10_000;
          const ttlMs = input.lease_ttl_ms ?? 35_000;
          if (ttlMs < hbMs * 3) {
            throw new PostgresRlsError("23514", "lease_ttl_ms must be >= heartbeat_interval_ms * 3");
          }
          const nextAttemptNo = task.current_attempt_no + 1;
          const nextEpoch = task.active_lease_epoch + 1;
          const leaseId = randomUUID();
          const idempotencyKey = computeTaskExecutionIdempotencyKey(
            input.project_id,
            input.task_id,
            nextAttemptNo
          );

          const leaseRes = await this.pool.queryInActiveTx(
            `INSERT INTO task_leases (
              lease_id, project_id, task_id, attempt_no, lease_epoch, worker_id, status,
              task_execution_idempotency_key, last_processed_seq, heartbeat_interval_ms,
              lease_ttl_ms, leased_at, last_heartbeat_at, expires_at
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::bigint, $6::text, 'ACTIVE',
              $7::text, 0, $8::integer, $9::integer, clock_timestamp(), clock_timestamp(),
              clock_timestamp() + ($9::bigint * interval '1 millisecond')
            ) RETURNING *;`,
            [leaseId, input.project_id, input.task_id, nextAttemptNo, nextEpoch, input.worker_id, idempotencyKey, hbMs, ttlMs]
          );
          const lease = mapLeaseRow(leaseRes.rows[0]!);

          await this.pool.queryInActiveTx(
            `UPDATE tasks SET
              status = 'Leased',
              current_attempt_no = $1::integer,
              rework_count = $2::integer,
              active_lease_id = $3::uuid,
              active_lease_epoch = $4::bigint,
              updated_at = clock_timestamp()
            WHERE task_id = $5::uuid;`,
            [nextAttemptNo, nextReworkCount, leaseId, nextEpoch, task.task_id]
          );

          await this.insertOutboxEventSql(input.project_id, "task_lease", leaseId, "lease.granted", {
            task_id: task.task_id,
            lease_id: leaseId,
            lease_epoch: nextEpoch,
            worker_id: input.worker_id,
          });

          return lease;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async getLeaseById(leaseId: string): Promise<TaskLeaseRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM task_leases WHERE lease_id = $1::uuid LIMIT 1;",
      [leaseId]
    );
    return res.rows[0] ? mapLeaseRow(res.rows[0]) : null;
  }

  public async listTaskLeasesForTask(taskId: string): Promise<TaskLeaseRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM task_leases WHERE task_id = $1::uuid ORDER BY lease_epoch ASC;",
      [taskId]
    );
    return res.rows.map(mapLeaseRow);
  }

  public async listProcessedWorkerEventsForTask(
    taskId: string
  ): Promise<ProcessedWorkerEventRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM processed_worker_events WHERE task_id = $1::uuid ORDER BY lease_epoch ASC, sequence_no ASC;",
      [taskId]
    );
    return res.rows.map(mapProcessedEventRow);
  }

  public async getLeaseSyncStatus(leaseId: string): Promise<LeaseSyncStatusResponse | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT *, clock_timestamp() AS server_now FROM task_leases WHERE lease_id = $1::uuid LIMIT 1;",
      [leaseId]
    );
    const row = res.rows[0];
    if (!row) {
      return null;
    }
    const lease = mapLeaseRow(row);
    return {
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      lease_status: lease.status,
      last_processed_seq: lease.last_processed_seq,
      expected_next_seq: lease.last_processed_seq + 1,
      lease_expires_at: lease.status === "ACTIVE" ? lease.expires_at : null,
      server_clock_timestamp: String(row.server_now),
    };
  }

  public async submitWorkerEvent(
    envelope: WorkerEventEnvelope,
    inTransactionDelayMs = 0
  ): Promise<ServerEventAckContract> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: envelope.project_id,
        currentPrincipalId: envelope.worker_id,
        currentRole: "gateway_service",
      },
      async () => {
        try {
          const lockRes = await this.pool.queryInActiveTx(
            `SELECT l.lease_id, l.project_id, l.task_id, l.attempt_no, l.lease_epoch,
                    l.worker_id, l.status AS lease_status, l.last_processed_seq,
                    l.lease_ttl_ms, l.expires_at, l.revoked_at,
                    t.status AS task_status, t.active_lease_id, t.active_lease_epoch,
                    clock_timestamp() AS server_now,
                    (l.expires_at <= clock_timestamp()) AS is_expired_now
             FROM task_leases l
             INNER JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
             WHERE l.lease_id = $1::uuid AND l.task_id = $2::uuid AND l.project_id = $3::uuid
             FOR UPDATE OF l, t;`,
            [envelope.lease_id, envelope.task_id, envelope.project_id]
          );

          if (inTransactionDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, inTransactionDelayMs));
          }

          const nowIso = await this.clockTimestampIso();
          const row = lockRes.rows[0];
          if (!row) {
            const tRes = await this.pool.queryInActiveTx(
              "SELECT status FROM tasks WHERE task_id = $1::uuid LIMIT 1;",
              [envelope.task_id]
            );
            return {
              http_status: 409,
              ack_status: "REJECTED_STALE_LEASE",
              lease_id: envelope.lease_id,
              lease_epoch: envelope.lease_epoch,
              lease_status: "REVOKED",
              acked_sequence_no: 0,
              expected_next_seq: 0,
              task_status: (tRes.rows[0]?.status as TaskStatus) ?? "ManualIntervention",
              lease_expires_at: null,
              server_clock_timestamp: nowIso,
              error_code: "ERR_STALE_LEASE",
            };
          }

          const expiresCheck = await this.pool.queryInActiveTx<{
            is_expired_now: boolean;
            server_now: string;
          }>(
            "SELECT ($1::timestamptz <= clock_timestamp()) AS is_expired_now, clock_timestamp() AS server_now;",
            [row.expires_at]
          );
          const isExpiredNow = Boolean(expiresCheck.rows[0]?.is_expired_now);
          const evalNowIso = String(expiresCheck.rows[0]?.server_now ?? nowIso);
          let leaseStatus = String(row.lease_status) as TaskLeaseRecord["status"];
          let taskStatus = String(row.task_status) as TaskStatus;
          const leaseEpoch = Number(row.lease_epoch);
          const lastProcessedSeq = Number(row.last_processed_seq);

          if (isExpiredNow && leaseStatus === "ACTIVE") {
            leaseStatus = "EXPIRED";
            await this.pool.queryInActiveTx(
              "UPDATE task_leases SET status = 'EXPIRED' WHERE lease_id = $1::uuid;",
              [envelope.lease_id]
            );
            if (String(row.active_lease_id ?? "") === envelope.lease_id) {
              if (taskStatus === "Leased" || taskStatus === "ExecutingInTarget") {
                taskStatus = "Ready";
              }
              await this.pool.queryInActiveTx(
                `UPDATE tasks SET active_lease_id = NULL, status = $1::text, updated_at = clock_timestamp()
                 WHERE task_id = $2::uuid;`,
                [taskStatus, envelope.task_id]
              );
            }
          }

          if (
            String(row.worker_id) !== envelope.worker_id ||
            leaseStatus !== "ACTIVE" ||
            row.revoked_at !== null ||
            isExpiredNow ||
            leaseEpoch !== envelope.lease_epoch ||
            String(row.active_lease_id ?? "") !== envelope.lease_id ||
            Number(row.active_lease_epoch) !== envelope.lease_epoch
          ) {
            return {
              http_status: 409,
              ack_status: "REJECTED_STALE_LEASE",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: leaseStatus,
              acked_sequence_no: lastProcessedSeq,
              expected_next_seq: 0,
              task_status: taskStatus,
              lease_expires_at: null,
              server_clock_timestamp: evalNowIso,
              error_code: "ERR_STALE_LEASE",
            };
          }

          const existingRes = await this.pool.queryInActiveTx(
            `SELECT * FROM processed_worker_events
             WHERE (project_id = $1::uuid AND event_idempotency_key = $2::text)
                OR (lease_id = $3::uuid AND sequence_no = $4::bigint)
             LIMIT 1;`,
            [envelope.project_id, envelope.event_idempotency_key, envelope.lease_id, envelope.sequence_no]
          );
          const existingRow = existingRes.rows[0];
          if (existingRow) {
            const existing = mapProcessedEventRow(existingRow);
            const computedSha = computeCanonicalPayloadSha256(envelope.payload);
            if (
              existing.event_idempotency_key === envelope.event_idempotency_key &&
              existing.payload_sha256 === envelope.payload_sha256 &&
              existing.payload_sha256 === computedSha &&
              existing.sequence_no === envelope.sequence_no &&
              existing.event_type === envelope.event_type
            ) {
              return {
                http_status: 200,
                ack_status: "DUPLICATE_RETRY_NOP",
                lease_id: envelope.lease_id,
                lease_epoch: leaseEpoch,
                lease_status: leaseStatus,
                acked_sequence_no: existing.sequence_no,
                expected_next_seq: lastProcessedSeq + 1,
                task_status: taskStatus,
                lease_expires_at: String(row.expires_at),
                server_clock_timestamp: evalNowIso,
              };
            }

            return {
              http_status: 409,
              ack_status: "REJECTED_CONFLICT_PAYLOAD",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: leaseStatus,
              acked_sequence_no: lastProcessedSeq,
              expected_next_seq: lastProcessedSeq + 1,
              task_status: taskStatus,
              lease_expires_at: String(row.expires_at),
              server_clock_timestamp: evalNowIso,
              error_code: "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH",
            };
          }

          const expectedNextSeq = lastProcessedSeq + 1;
          if (envelope.sequence_no !== expectedNextSeq) {
            return {
              http_status: 409,
              ack_status: "REJECTED_OUT_OF_ORDER",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: leaseStatus,
              acked_sequence_no: lastProcessedSeq,
              expected_next_seq: expectedNextSeq,
              task_status: taskStatus,
              lease_expires_at: String(row.expires_at),
              server_clock_timestamp: evalNowIso,
              error_code:
                envelope.sequence_no < expectedNextSeq ? "ERR_SEQ_ALREADY_ADVANCED" : "ERR_SEQ_GAP",
            };
          }

          const actualPayloadSha = computeCanonicalPayloadSha256(envelope.payload);
          if (actualPayloadSha !== envelope.payload_sha256) {
            return {
              http_status: 409,
              ack_status: "REJECTED_CONFLICT_PAYLOAD",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: leaseStatus,
              acked_sequence_no: lastProcessedSeq,
              expected_next_seq: expectedNextSeq,
              task_status: taskStatus,
              lease_expires_at: String(row.expires_at),
              server_clock_timestamp: evalNowIso,
              error_code: "ERR_IDEMPOTENCY_PAYLOAD_MISMATCH",
            };
          }

          const transitionRule = WORKER_EVENT_STATE_TRANSITIONS[envelope.event_type];
          if (!transitionRule.allowedFrom.includes(taskStatus)) {
            return {
              http_status: 422,
              ack_status: "REJECTED_INVALID_TRANSITION",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: leaseStatus,
              acked_sequence_no: lastProcessedSeq,
              expected_next_seq: expectedNextSeq,
              task_status: taskStatus,
              lease_expires_at: String(row.expires_at),
              server_clock_timestamp: evalNowIso,
              error_code: "ERR_INVALID_STATE_TRANSITION",
            };
          }

          await this.pool.queryInActiveTx(
            `INSERT INTO processed_worker_events (
              project_id, task_id, lease_id, lease_epoch, sequence_no,
              event_type, event_idempotency_key, payload_sha256, payload_json
            ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint, $6::text, $7::text, $8::text, $9::jsonb);`,
            [
              envelope.project_id,
              envelope.task_id,
              envelope.lease_id,
              envelope.lease_epoch,
              envelope.sequence_no,
              envelope.event_type,
              envelope.event_idempotency_key,
              envelope.payload_sha256,
              envelope.payload,
            ]
          );

          let nextLeaseStatus: TaskLeaseRecord["status"] = "ACTIVE";
          let nextTaskStatus: TaskStatus =
            transitionRule.targetStatus === "UNCHANGED" ? taskStatus : transitionRule.targetStatus;
          const leaseTtlMs = Number(row.lease_ttl_ms);

          if (transitionRule.closesLeaseAs === "COMPLETED") {
            nextLeaseStatus = "COMPLETED";
            const updL = await this.pool.queryInActiveTx(
              `UPDATE task_leases SET
                last_processed_seq = $1::bigint,
                last_heartbeat_at = clock_timestamp(),
                expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
                status = 'COMPLETED',
                completed_at = clock_timestamp()
              WHERE lease_id = $3::uuid
              RETURNING expires_at, clock_timestamp() AS server_now;`,
              [envelope.sequence_no, leaseTtlMs, envelope.lease_id]
            );
            await this.pool.queryInActiveTx(
              `UPDATE tasks SET status = $1::text, active_lease_id = NULL, updated_at = clock_timestamp()
               WHERE task_id = $2::uuid;`,
              [nextTaskStatus, envelope.task_id]
            );
            await this.insertOutboxEventSql(
              envelope.project_id,
              "task",
              envelope.task_id,
              envelope.event_type,
              {
                task_id: envelope.task_id,
                lease_id: envelope.lease_id,
                lease_epoch: leaseEpoch,
                sequence_no: envelope.sequence_no,
                new_task_status: nextTaskStatus,
                payload: envelope.payload,
              }
            );
            return {
              http_status: 200,
              ack_status: "ACCEPTED",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: nextLeaseStatus,
              acked_sequence_no: envelope.sequence_no,
              expected_next_seq: envelope.sequence_no + 1,
              task_status: nextTaskStatus,
              lease_expires_at: null,
              server_clock_timestamp: String(updL.rows[0]?.server_now ?? evalNowIso),
            };
          }

          if (transitionRule.closesLeaseAs === "REVOKED") {
            nextLeaseStatus = "REVOKED";
            const updL = await this.pool.queryInActiveTx(
              `UPDATE task_leases SET
                last_processed_seq = $1::bigint,
                last_heartbeat_at = clock_timestamp(),
                status = 'REVOKED',
                revoked_at = clock_timestamp(),
                revoke_reason = 'WORKER_REPORTED_FAILURE'
              WHERE lease_id = $2::uuid
              RETURNING clock_timestamp() AS server_now;`,
              [envelope.sequence_no, envelope.lease_id]
            );
            await this.pool.queryInActiveTx(
              `UPDATE tasks SET status = $1::text, active_lease_id = NULL, updated_at = clock_timestamp()
               WHERE task_id = $2::uuid;`,
              [nextTaskStatus, envelope.task_id]
            );
            await this.insertOutboxEventSql(
              envelope.project_id,
              "task",
              envelope.task_id,
              envelope.event_type,
              {
                task_id: envelope.task_id,
                lease_id: envelope.lease_id,
                lease_epoch: leaseEpoch,
                sequence_no: envelope.sequence_no,
                new_task_status: nextTaskStatus,
                payload: envelope.payload,
              }
            );
            return {
              http_status: 200,
              ack_status: "ACCEPTED",
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              lease_status: nextLeaseStatus,
              acked_sequence_no: envelope.sequence_no,
              expected_next_seq: envelope.sequence_no + 1,
              task_status: nextTaskStatus,
              lease_expires_at: null,
              server_clock_timestamp: String(updL.rows[0]?.server_now ?? evalNowIso),
            };
          }

          const updL = await this.pool.queryInActiveTx(
            `UPDATE task_leases SET
              last_processed_seq = $1::bigint,
              last_heartbeat_at = clock_timestamp(),
              expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond')
            WHERE lease_id = $3::uuid
            RETURNING expires_at, clock_timestamp() AS server_now;`,
            [envelope.sequence_no, leaseTtlMs, envelope.lease_id]
          );
          if (transitionRule.targetStatus !== "UNCHANGED") {
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET status = $1::text, updated_at = clock_timestamp() WHERE task_id = $2::uuid;",
              [nextTaskStatus, envelope.task_id]
            );
          }
          await this.insertOutboxEventSql(
            envelope.project_id,
            "task",
            envelope.task_id,
            envelope.event_type,
            {
              task_id: envelope.task_id,
              lease_id: envelope.lease_id,
              lease_epoch: leaseEpoch,
              sequence_no: envelope.sequence_no,
              new_task_status: nextTaskStatus,
              payload: envelope.payload,
            }
          );

          return {
            http_status: 200,
            ack_status: "ACCEPTED",
            lease_id: envelope.lease_id,
            lease_epoch: leaseEpoch,
            lease_status: "ACTIVE",
            acked_sequence_no: envelope.sequence_no,
            expected_next_seq: envelope.sequence_no + 1,
            task_status: nextTaskStatus,
            lease_expires_at: String(updL.rows[0]?.expires_at ?? row.expires_at),
            server_clock_timestamp: String(updL.rows[0]?.server_now ?? evalNowIso),
          };
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async revokeTaskLease(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    reason: string;
    requeueTask?: boolean;
  }): Promise<TaskLeaseRecord> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const lockRes = await this.pool.queryInActiveTx(
            `SELECT l.*, t.active_lease_id, t.status AS task_status
             FROM task_leases l
             INNER JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
             WHERE l.lease_id = $1::uuid AND l.task_id = $2::uuid AND l.project_id = $3::uuid
             FOR UPDATE OF l, t;`,
            [input.lease_id, input.task_id, input.project_id]
          );
          const row = lockRes.rows[0];
          if (!row) {
            throw new Error(`Lease ${input.lease_id} not found`);
          }

          let updatedLease = mapLeaseRow(row);
          if (updatedLease.status === "ACTIVE") {
            const res = await this.pool.queryInActiveTx(
              `UPDATE task_leases SET status = 'REVOKED', revoked_at = clock_timestamp(), revoke_reason = $1::text
               WHERE lease_id = $2::uuid RETURNING *;`,
              [input.reason, input.lease_id]
            );
            updatedLease = mapLeaseRow(res.rows[0]!);
          }

          if (String(row.active_lease_id ?? "") === input.lease_id) {
            const curTaskStatus = String(row.task_status) as TaskStatus;
            const nextTaskStatus: TaskStatus =
              curTaskStatus === "Leased" || curTaskStatus === "ExecutingInTarget"
                ? input.requeueTask
                  ? "Ready"
                  : "ManualIntervention"
                : curTaskStatus;
            await this.pool.queryInActiveTx(
              `UPDATE tasks SET active_lease_id = NULL, status = $1::text, updated_at = clock_timestamp()
               WHERE task_id = $2::uuid;`,
              [nextTaskStatus, input.task_id]
            );
          }

          await this.insertOutboxEventSql(input.project_id, "task_lease", input.lease_id, "lease.revoked", {
            task_id: input.task_id,
            lease_id: input.lease_id,
            lease_epoch: updatedLease.lease_epoch,
            reason: input.reason,
          });

          return updatedLease;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async pushStagingGitRefWithGatekeeper(input: {
    project_id: string;
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
    const deadlineMs = input.deadlineMs ?? 2000;
    if (input.simulateControlPlaneOutage === true || deadlineMs <= 0) {
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason:
          "Pre-receive Fail-Closed: Control Plane unreachable or exceeded 2000ms hard timeout",
      };
    }

    const startMs = Date.now();
    const abortController = new AbortController();
    let cancelledByTimeout = false;
    let enteredDbWork = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        cancelledByTimeout = true;
        abortController.abort(new Error("ERR_GATEKEEPER_TIMEOUT"));
        reject(new Error("ERR_GATEKEEPER_TIMEOUT"));
      }, deadlineMs);
    });

    const isAborted = (): boolean =>
      cancelledByTimeout || abortController.signal.aborted || Date.now() - startMs > deadlineMs;

    const runVerification = async (): Promise<{
      allowed: boolean;
      error_code?: string;
      reason?: string;
      import_id?: string;
    }> => {
      if (input.authorizeCheckHook) {
        await input.authorizeCheckHook(abortController.signal);
      }
      if (isAborted()) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
          reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
        };
      }

      const expectedStagingRef = `refs/heads/sf/staging/${input.task_id}/${input.lease_epoch}`;
      const expectedVerifyAlias = `refs/factory/Verify/${input.task_id}/${input.lease_epoch}`;
      if (input.staging_ref !== expectedStagingRef && input.staging_ref !== expectedVerifyAlias) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FORBIDDEN_REF",
          reason: `Pre-receive denied: staging_ref ${input.staging_ref} does not match ${expectedStagingRef} or ${expectedVerifyAlias}`,
        };
      }

      enteredDbWork = true;
      const inActiveTx = this.pool.getActiveTxSession() !== null;
      let savepointCreated = false;
      const rollbackSavepointIfNeeded = async (): Promise<void> => {
        if (!savepointCreated) {
          return;
        }
        savepointCreated = false;
        try {
          await this.pool.queryInActiveTx(
            "ROLLBACK TO SAVEPOINT sf_gatekeeper_pre_receive; RELEASE SAVEPOINT sf_gatekeeper_pre_receive; SET LOCAL statement_timeout = 0;"
          );
        } catch {
          // best-effort cleanup on aborted/closed connection
        }
      };

      if (inActiveTx) {
        const remainingMs = Math.max(1, Math.min(600_000, Math.trunc(deadlineMs - (Date.now() - startMs))));
        await this.pool.queryInActiveTx(
          `SAVEPOINT sf_gatekeeper_pre_receive; SET LOCAL statement_timeout = ${remainingMs};`
        );
        savepointCreated = true;
      }

      try {
        const rowRes = await this.pool.queryInActiveTx(
          `SELECT l.lease_id, l.status AS lease_status, l.revoked_at, l.lease_epoch,
                  (l.expires_at <= clock_timestamp()) AS is_expired,
                  t.task_contract_json, t.base_main_commit_hash
           FROM task_leases l
           INNER JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
           WHERE l.lease_id = $1::uuid AND l.task_id = $2::uuid AND l.project_id = $3::uuid
           LIMIT 1;`,
          [input.lease_id, input.task_id, input.project_id]
        );
        if (isAborted()) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
            reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
          };
        }

        const row = rowRes.rows[0];
        if (
          !row ||
          Number(row.lease_epoch) !== input.lease_epoch ||
          String(row.lease_status) !== "ACTIVE" ||
          row.revoked_at !== null ||
          Boolean(row.is_expired)
        ) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_STALE_OR_EXPIRED_LEASE",
            reason: "Pre-receive denied: lease is not ACTIVE or has expired/revoked",
          };
        }

        if (!input.changes) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_MISSING_CHANGES",
            reason:
              "Pre-receive denied: Git changes manifest is required for TrustedImportValidator verification",
          };
        }

        const contract = row.task_contract_json as unknown as TaskContractSpec;
        const validation = validateGitTreeImport({
          agent_commit_hash: input.agent_commit_hash,
          verified_tree_hash: input.verified_tree_hash,
          parent_commit_hashes: input.parent_commit_hashes,
          expected_base_main_commit_hash: String(row.base_main_commit_hash),
          changes: input.changes,
          contract,
        });

        if (!validation.valid) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: validation.error_code,
            reason: `TrustedImportValidator rejected push at pre-receive: [${validation.error_code}] ${validation.message}`,
          };
        }

        if (isAborted()) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
            reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
          };
        }

        const existingRes = await this.pool.queryInActiveTx(
          `SELECT import_id FROM verified_code_imports
           WHERE lease_id = $1::uuid AND agent_commit_hash = $2::text LIMIT 1;`,
          [input.lease_id, input.agent_commit_hash]
        );
        if (isAborted()) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
            reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
          };
        }
        if (existingRes.rows[0]) {
          if (savepointCreated) {
            savepointCreated = false;
            await this.pool.queryInActiveTx(
              "RELEASE SAVEPOINT sf_gatekeeper_pre_receive; SET LOCAL statement_timeout = 0;"
            );
          }
          return {
            allowed: true,
            import_id: String(existingRes.rows[0].import_id),
          };
        }

        const insRes = await this.pool.queryInActiveTx(
          `INSERT INTO verified_code_imports (
            project_id, task_id, lease_id, lease_epoch, agent_commit_hash,
            verified_tree_hash, staging_ref, changed_files_count, deleted_lines_count, recovered_by_reconciler
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::integer, $9::integer, FALSE)
          RETURNING import_id;`,
          [
            input.project_id,
            input.task_id,
            input.lease_id,
            input.lease_epoch,
            validation.agent_commit_hash,
            validation.verified_tree_hash,
            input.staging_ref,
            validation.changed_files_count,
            validation.deleted_lines_count,
          ]
        );
        if (isAborted()) {
          await rollbackSavepointIfNeeded();
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
            reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
          };
        }

        if (savepointCreated) {
          savepointCreated = false;
          await this.pool.queryInActiveTx(
            "RELEASE SAVEPOINT sf_gatekeeper_pre_receive; SET LOCAL statement_timeout = 0;"
          );
        }

        let refs = this.fallbackGitRefsByProject.get(input.project_id);
        if (!refs) {
          refs = new Map();
          this.fallbackGitRefsByProject.set(input.project_id, refs);
        }
        let commits = this.fallbackGitCommitsByProject.get(input.project_id);
        if (!commits) {
          commits = new Map();
          this.fallbackGitCommitsByProject.set(input.project_id, commits);
        }
        commits.set(input.agent_commit_hash, {
          commitHash: input.agent_commit_hash,
          treeHash: input.verified_tree_hash,
          parents: [...input.parent_commit_hashes],
          taskId: input.task_id,
        });
        refs.set(expectedStagingRef, input.agent_commit_hash);
        refs.set(input.staging_ref, input.agent_commit_hash);

        return {
          allowed: true,
          import_id: String(insRes.rows[0]!.import_id),
        };
      } catch (err) {
        await rollbackSavepointIfNeeded();
        if (isAborted()) {
          return {
            allowed: false,
            error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
            reason: `Pre-receive hard timeout exceeded: gatekeeper exceeded ${deadlineMs}ms deadline`,
          };
        }
        throw err;
      }
    };

    const verificationPromise = runVerification();
    verificationPromise.catch(() => {});
    try {
      return await Promise.race([verificationPromise, timeoutPromise]);
    } catch {
      cancelledByTimeout = true;
      abortController.abort(new Error("ERR_GATEKEEPER_TIMEOUT"));
      if (enteredDbWork) {
        await verificationPromise.catch(() => {});
      }
      return {
        allowed: false,
        error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
        reason: `Pre-receive Fail-Closed: Control Plane unreachable or exceeded ${deadlineMs}ms hard timeout`,
      };
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  public async listExpiredActiveLeaseScopes(
    batchLimit = 50
  ): Promise<Array<{ project_id: string; lease_id: string; task_id: string }>> {
    const res = await this.pool.queryInActiveTx(
      "SELECT project_id, lease_id, task_id FROM list_expired_active_lease_scopes($1::integer);",
      [batchLimit]
    );
    return res.rows.map((r) => ({
      project_id: String(r.project_id),
      lease_id: String(r.lease_id),
      task_id: String(r.task_id),
    }));
  }

  public async runLeaseExpiryAndOrphanedPushReconciler(
    orphanedDiffProvider?: (stagingInfo: {
      project_id: string;
      task_id: string;
      lease_id: string;
      lease_epoch: number;
      staging_ref: string;
      agent_commit_hash: string;
      verified_tree_hash: string;
      parent_commit_hashes: readonly string[];
    }) => GitTreeImportCandidateInput | null
  ): Promise<
    Array<{
      lease_id: string;
      task_id: string;
      outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
      import_id?: string;
    }>
  > {
    const scopes = await this.listExpiredActiveLeaseScopes(50);
    const results: Array<{
      lease_id: string;
      task_id: string;
      outcome: "RECOVERED_ORPHANED_PUSH" | "EXPIRED_AND_REQUEUED";
      import_id?: string;
    }> = [];

    for (const scope of scopes) {
      await this.withRlsTransaction(
        {
          currentProjectId: scope.project_id,
          currentPrincipalId: "lease_expiry_reconciler",
          currentRole: "core_api_service",
        },
        async () => {
          const lockRes = await this.pool.queryInActiveTx(
            `SELECT l.*, t.status AS task_status, t.active_lease_id,
                    (l.expires_at <= clock_timestamp()) AS is_expired_now
             FROM task_leases l
             INNER JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
             WHERE l.lease_id = $1::uuid AND l.task_id = $2::uuid AND l.project_id = $3::uuid
             FOR UPDATE OF l, t;`,
            [scope.lease_id, scope.task_id, scope.project_id]
          );
          const row = lockRes.rows[0];
          if (!row || String(row.status) !== "ACTIVE" || !Boolean(row.is_expired_now)) {
            return;
          }
          const leaseEpoch = Number(row.lease_epoch);
          const expectedStagingRef = `refs/heads/sf/staging/${scope.task_id}/${leaseEpoch}`;
          const expectedVerifyRef = `refs/factory/Verify/${scope.task_id}/${leaseEpoch}`;

          // Path A: Check pre-recorded verified_code_imports for this lease & epoch
          const impRes = await this.pool.queryInActiveTx(
            `SELECT * FROM verified_code_imports
             WHERE project_id = $1::uuid AND task_id = $2::uuid AND lease_id = $3::uuid AND lease_epoch = $4::bigint
               AND (staging_ref = $5::text OR staging_ref = $6::text)
             ORDER BY created_at DESC LIMIT 1;`,
            [scope.project_id, scope.task_id, scope.lease_id, leaseEpoch, expectedStagingRef, expectedVerifyRef]
          );
          const preRecorded = impRes.rows[0] ? mapVerifiedImportRow(impRes.rows[0]) : null;
          if (preRecorded) {
            await this.pool.queryInActiveTx(
              "UPDATE verified_code_imports SET recovered_by_reconciler = TRUE WHERE import_id = $1::uuid;",
              [preRecorded.import_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE task_leases SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE lease_id = $1::uuid;",
              [scope.lease_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET status = 'BuildingMergeCandidate', active_lease_id = NULL, updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
              [scope.task_id]
            );
            await this.insertOutboxEventSql(
              scope.project_id,
              "task",
              scope.task_id,
              "task.orphaned_push_recovered",
              {
                task_id: scope.task_id,
                lease_id: scope.lease_id,
                import_id: preRecorded.import_id,
                agent_commit_hash: preRecorded.agent_commit_hash,
              }
            );
            results.push({
              lease_id: scope.lease_id,
              task_id: scope.task_id,
              outcome: "RECOVERED_ORPHANED_PUSH",
              import_id: preRecorded.import_id,
            });
            return;
          }

          // Path B: Probe orphanedDiffProvider if fallback or external staging ref exists
          const refs = this.fallbackGitRefsByProject.get(scope.project_id);
          const commits = this.fallbackGitCommitsByProject.get(scope.project_id);
          const matchedRef = refs?.get(expectedStagingRef)
            ? expectedStagingRef
            : expectedVerifyRef;
          const stagingCommitHash = refs?.get(matchedRef) ?? "";
          const commitMeta = stagingCommitHash ? commits?.get(stagingCommitHash) : undefined;

          if (orphanedDiffProvider) {
            const candidateInput = orphanedDiffProvider({
              project_id: scope.project_id,
              task_id: scope.task_id,
              lease_id: scope.lease_id,
              lease_epoch: leaseEpoch,
              staging_ref: matchedRef,
              agent_commit_hash: stagingCommitHash,
              verified_tree_hash: commitMeta?.treeHash ?? "",
              parent_commit_hashes: commitMeta?.parents ?? [],
            });
            if (candidateInput) {
              const validation = validateGitTreeImport(candidateInput);
              if (validation.valid) {
                const insImp = await this.pool.queryInActiveTx(
                  `INSERT INTO verified_code_imports (
                    project_id, task_id, lease_id, lease_epoch, agent_commit_hash,
                    verified_tree_hash, staging_ref, changed_files_count, deleted_lines_count,
                    recovered_by_reconciler
                  ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::integer, $9::integer, TRUE)
                  RETURNING import_id;`,
                  [
                    scope.project_id,
                    scope.task_id,
                    scope.lease_id,
                    leaseEpoch,
                    validation.agent_commit_hash,
                    validation.verified_tree_hash,
                    matchedRef,
                    validation.changed_files_count,
                    validation.deleted_lines_count,
                  ]
                );
                const importId = String(insImp.rows[0]!.import_id);
                await this.pool.queryInActiveTx(
                  "UPDATE task_leases SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE lease_id = $1::uuid;",
                  [scope.lease_id]
                );
                await this.pool.queryInActiveTx(
                  "UPDATE tasks SET status = 'BuildingMergeCandidate', active_lease_id = NULL, updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
                  [scope.task_id]
                );
                await this.insertOutboxEventSql(
                  scope.project_id,
                  "task",
                  scope.task_id,
                  "task.orphaned_push_recovered",
                  {
                    task_id: scope.task_id,
                    lease_id: scope.lease_id,
                    import_id: importId,
                    agent_commit_hash: validation.agent_commit_hash,
                  }
                );
                results.push({
                  lease_id: scope.lease_id,
                  task_id: scope.task_id,
                  outcome: "RECOVERED_ORPHANED_PUSH",
                  import_id: importId,
                });
                return;
              }
            }
          }

          await this.pool.queryInActiveTx(
            "UPDATE task_leases SET status = 'EXPIRED' WHERE lease_id = $1::uuid;",
            [scope.lease_id]
          );
          if (String(row.active_lease_id ?? "") === scope.lease_id) {
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET active_lease_id = NULL, status = 'Ready', updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
              [scope.task_id]
            );
          }
          await this.insertOutboxEventSql(
            scope.project_id,
            "task_lease",
            scope.lease_id,
            "lease.expired",
            {
              task_id: scope.task_id,
              lease_id: scope.lease_id,
              lease_epoch: leaseEpoch,
            }
          );
          results.push({
            lease_id: scope.lease_id,
            task_id: scope.task_id,
            outcome: "EXPIRED_AND_REQUEUED",
          });
        }
      );
    }
    return results;
  }

  public async getVerifiedImportsForTask(taskId: string): Promise<VerifiedCodeImportRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM verified_code_imports WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapVerifiedImportRow);
  }

  public async withTaskLeaseLock<T>(projectId: string, taskId: string, leaseId: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.pool.queryInActiveTx(
      `SELECT l.lease_id FROM task_leases l JOIN tasks t ON t.project_id = l.project_id AND t.task_id = l.task_id
       WHERE l.project_id = $1::uuid AND l.task_id = $2::uuid AND l.lease_id = $3::uuid FOR UPDATE OF l, t;`,
      [projectId, taskId, leaseId]);
    if (!result.rowCount) throw new PostgresRlsError("23503", "Lease not found in current project");
    return fn();
  }

  public async getCodeImportSubmission(leaseId: string): Promise<CodeImportSubmissionRecord | null> {
    const result = await this.pool.queryInActiveTx("SELECT * FROM code_import_submissions WHERE lease_id = $1::uuid;", [leaseId]);
    return result.rows[0] ? mapCodeImportSubmissionRow(result.rows[0]) : null;
  }

  public async recordCodeImportSubmission(input: Omit<CodeImportSubmissionRecord, "submission_id" | "created_at">): Promise<CodeImportSubmissionRecord> {
    validateCodeImportReceipt(input);
    try {
      const result = await this.pool.queryInActiveTx(
        `INSERT INTO code_import_submissions (project_id, task_id, lease_id, lease_epoch, import_id, source_type,
          payload_sha256, agent_commit_hash, verified_tree_hash, staging_ref, submitted_by_principal_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::uuid, $6::text, $7::text, $8::text, $9::text, $10::text, $11::text) RETURNING *;`,
        [input.project_id, input.task_id, input.lease_id, input.lease_epoch, input.import_id, input.source_type,
          input.payload_sha256, input.agent_commit_hash, input.verified_tree_hash, input.staging_ref, input.submitted_by_principal_id]);
      const record = mapCodeImportSubmissionRow(result.rows[0]!);
      await this.insertOutboxEventSql(input.project_id, "code_import_submission", record.submission_id, "code_import.accepted",
        { task_id: input.task_id, lease_id: input.lease_id, source_type: input.source_type, import_id: input.import_id });
      return record;
    } catch (error) { mapPgError(error); }
  }

  public async recordVerifiedCodeImport(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    candidate_input: GitTreeImportCandidateInput;
  }): Promise<VerifiedCodeImportRecord> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const rowRes = await this.pool.queryInActiveTx(
            `SELECT l.*, t.status AS task_status, t.base_main_commit_hash,
                    (l.expires_at <= clock_timestamp()) AS is_expired_now
             FROM task_leases l
             INNER JOIN tasks t ON t.task_id = l.task_id AND t.project_id = l.project_id
             WHERE l.lease_id = $1::uuid AND l.task_id = $2::uuid AND l.project_id = $3::uuid
             FOR UPDATE OF l, t;`,
            [input.lease_id, input.task_id, input.project_id]
          );
          const row = rowRes.rows[0];
          if (!row) {
            throw new PostgresRlsError(
              "23503",
              `Task ${input.task_id} or Lease ${input.lease_id} not found for project ${input.project_id}`
            );
          }
          if (Number(row.lease_epoch) !== input.lease_epoch) {
            throw new PostgresRlsError(
              "23514",
              `Lease epoch mismatch: expected ${String(row.lease_epoch)}, got ${input.lease_epoch}`
            );
          }
          const expectedStagingRef = `refs/heads/sf/staging/${input.task_id}/${input.lease_epoch}`;
          const expectedVerifyAlias = `refs/factory/Verify/${input.task_id}/${input.lease_epoch}`;
          if (input.staging_ref !== expectedStagingRef && input.staging_ref !== expectedVerifyAlias) {
            throw new PostgresRlsError(
              "23514",
              `Invalid staging_ref ${input.staging_ref}`
            );
          }
          const leaseStatus = String(row.status);
          if (
            leaseStatus === "REVOKED" ||
            leaseStatus === "EXPIRED" ||
            row.revoked_at !== null ||
            (leaseStatus === "ACTIVE" && Boolean(row.is_expired_now))
          ) {
            throw new PostgresRlsError(
              "23514",
              `Lease ${input.lease_id} (status=${leaseStatus}) is revoked or expired`
            );
          }
          if (input.candidate_input.expected_base_main_commit_hash !== String(row.base_main_commit_hash)) {
            throw new PostgresRlsError(
              "23514",
              `Candidate expected_base_main_commit_hash does not match task base_main_commit_hash`
            );
          }

          const validation = validateGitTreeImport(input.candidate_input);
          if (!validation.valid) {
            throw new PostgresRlsError(
              "23514",
              `TrustedImportValidator rejected import: [${validation.error_code}] ${validation.message}`
            );
          }

          const existingRes = await this.pool.queryInActiveTx(
            `SELECT * FROM verified_code_imports
             WHERE lease_id = $1::uuid AND agent_commit_hash = $2::text LIMIT 1;`,
            [input.lease_id, validation.agent_commit_hash]
          );
          if (existingRes.rows[0]) {
            const existing = mapVerifiedImportRow(existingRes.rows[0]);
            if (
              existing.project_id !== input.project_id ||
              existing.task_id !== input.task_id ||
              existing.lease_epoch !== input.lease_epoch ||
              existing.staging_ref !== input.staging_ref ||
              existing.verified_tree_hash !== validation.verified_tree_hash
            ) {
              throw new PostgresRlsError(
                "23514",
                `Conflicting VerifiedCodeImport already exists for lease ${input.lease_id}`
              );
            }
            return existing;
          }

          if (leaseStatus !== "ACTIVE") {
            throw new PostgresRlsError(
              "23514",
              `Cannot record new VerifiedCodeImport on non-ACTIVE lease (status=${leaseStatus})`
            );
          }

          const ins = await this.pool.queryInActiveTx(
            `INSERT INTO verified_code_imports (
              project_id, task_id, lease_id, lease_epoch, agent_commit_hash,
              verified_tree_hash, staging_ref, changed_files_count, deleted_lines_count
            ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::text, $6::text, $7::text, $8::integer, $9::integer)
            RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.lease_id,
              input.lease_epoch,
              validation.agent_commit_hash,
              validation.verified_tree_hash,
              input.staging_ref,
              validation.changed_files_count,
              validation.deleted_lines_count,
            ]
          );
          return mapVerifiedImportRow(ins.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async createMergeCandidate(input: {
    project_id: string;
    task_id: string;
    import_id: string;
    base_main_commit_hash: string;
    merge_candidate_hash: string;
    verified_tree_hash: string;
    allow_rebased_tree_hash?: boolean;
    snapshot_path?: string | null;
    snapshot_sha256?: string | null;
    snapshot_size_bytes?: number | null;
    snapshot_retention_class?: SnapshotRetentionClass;
  }): Promise<MergeCandidateRecord> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const impRes = await this.pool.queryInActiveTx(
            `SELECT i.*, p.main_ref_commit_hash
             FROM verified_code_imports i
             INNER JOIN projects p ON p.project_id = i.project_id
             WHERE i.import_id = $1::uuid AND i.task_id = $2::uuid AND i.project_id = $3::uuid
             LIMIT 1;`,
            [input.import_id, input.task_id, input.project_id]
          );
          const impRow = impRes.rows[0];
          if (!impRow) {
            throw new PostgresRlsError("23503", "Task or VerifiedCodeImport not found for project");
          }
          if (!input.allow_rebased_tree_hash && input.verified_tree_hash !== String(impRow.verified_tree_hash)) {
            throw new PostgresRlsError(
              "23514",
              `Candidate verified_tree_hash ${input.verified_tree_hash} does not match import ${String(impRow.verified_tree_hash)}`
            );
          }
          const currentMainSha = impRow.main_ref_commit_hash
            ? String(impRow.main_ref_commit_hash)
            : "";
          if (currentMainSha && input.base_main_commit_hash !== currentMainSha) {
            throw new PostgresRlsError(
              "23514",
              `Candidate base_main_commit_hash ${input.base_main_commit_hash} does not match current main ${currentMainSha}`
            );
          }

          // Supersede older candidates and invalidate stale reviews/requests/approvals on this task
          await this.pool.queryInActiveTx(
            `UPDATE merge_candidates SET is_superseded = TRUE
             WHERE project_id = $1::uuid AND task_id = $2::uuid AND is_superseded = FALSE;`,
            [input.project_id, input.task_id]
          );
          await this.pool.queryInActiveTx(
            `UPDATE review_artifacts
             SET status = 'INVALIDATED_STALE_CANDIDATE', is_invalidated = TRUE,
                 invalidated_reason = COALESCE(invalidated_reason, 'SUPERSEDED_BY_NEW_MERGE_CANDIDATE')
             WHERE project_id = $1::uuid AND task_id = $2::uuid
               AND merge_candidate_hash <> $3::text AND (status = 'VALID' OR is_invalidated = FALSE);`,
            [input.project_id, input.task_id, input.merge_candidate_hash]
          );
          await this.pool.queryInActiveTx(
            `UPDATE approval_requests SET status = 'INVALIDATED_STALE_CANDIDATE', updated_at = clock_timestamp()
             WHERE project_id = $1::uuid AND task_id = $2::uuid AND status = 'PENDING';`,
            [input.project_id, input.task_id]
          );
          await this.pool.queryInActiveTx(
            `UPDATE approval_decisions SET status = 'INVALIDATED',
                 invalidated_reason = COALESCE(invalidated_reason, 'SUPERSEDED_BY_NEW_MERGE_CANDIDATE')
             WHERE project_id = $1::uuid AND task_id = $2::uuid AND status = 'ACTIVE';`,
            [input.project_id, input.task_id]
          );

          const ins = await this.pool.queryInActiveTx(
            `INSERT INTO merge_candidates (
              project_id, task_id, import_id, agent_commit_hash, base_main_commit_hash,
              merge_candidate_hash, verified_tree_hash, is_superseded,
              snapshot_path, snapshot_sha256, snapshot_size_bytes, snapshot_retention_class
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
              $6::text, $7::text, FALSE, $8::text, $9::text, $10::bigint, $11::text
            ) RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.import_id,
              String(impRow.agent_commit_hash),
              input.base_main_commit_hash,
              input.merge_candidate_hash,
              input.verified_tree_hash,
              input.snapshot_path ?? null,
              input.snapshot_sha256 ?? null,
              input.snapshot_size_bytes ?? null,
              input.snapshot_retention_class ?? "EPHEMERAL_14D",
            ]
          );
          const mc = mapMergeCandidateRow(ins.rows[0]!);

          await this.pool.queryInActiveTx(
            `UPDATE tasks SET status = 'VerifyingInDocker', active_merge_candidate_id = $1::uuid,
                 updated_at = clock_timestamp()
             WHERE task_id = $2::uuid;`,
            [mc.merge_candidate_id, input.task_id]
          );

          return mc;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  private async closeActiveLeasesForTaskSql(
    taskId: string,
    targetStatus: "COMPLETED" | "REVOKED",
    reason?: string
  ): Promise<void> {
    if (targetStatus === "COMPLETED") {
      await this.pool.queryInActiveTx(
        `UPDATE task_leases SET status = 'COMPLETED', completed_at = COALESCE(completed_at, clock_timestamp())
         WHERE task_id = $1::uuid AND status = 'ACTIVE';`,
        [taskId]
      );
    } else {
      await this.pool.queryInActiveTx(
        `UPDATE task_leases SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, clock_timestamp()),
             revoke_reason = COALESCE(revoke_reason, $1::text)
         WHERE task_id = $2::uuid AND status = 'ACTIVE';`,
        [reason ?? "TASK_SUPERSEDED", taskId]
      );
    }
    await this.pool.queryInActiveTx(
      "UPDATE tasks SET active_lease_id = NULL WHERE task_id = $1::uuid;",
      [taskId]
    );
  }

  public async markMergeConflictReworkRequired(input: {
    project_id: string;
    task_id: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    conflicted_files: readonly string[];
    import_id?: string;
    conflict_summary?: string;
  }): Promise<{ readonly task_status: TaskStatus; readonly conflicted_files: readonly string[] }> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const taskRes = await this.pool.queryInActiveTx(
            "SELECT * FROM tasks WHERE task_id = $1::uuid AND project_id = $2::uuid FOR UPDATE;",
            [input.task_id, input.project_id]
          );
          if (!taskRes.rows[0]) {
            throw new PostgresRlsError("23503", `Task ${input.task_id} not found for project`);
          }
          const task = mapTaskRow(taskRes.rows[0]);
          const nextStatus: TaskStatus =
            task.rework_count < task.max_rework_cycles ? "ReworkRequired" : "ManualIntervention";
          await this.closeActiveLeasesForTaskSql(task.task_id, "COMPLETED");
          await this.pool.queryInActiveTx(
            "UPDATE tasks SET status = $1::text, active_lease_id = NULL, updated_at = clock_timestamp() WHERE task_id = $2::uuid;",
            [nextStatus, task.task_id]
          );
          await this.insertOutboxEventSql(
            input.project_id,
            "task",
            task.task_id,
            "merge_candidate.conflict",
            {
              task_id: task.task_id,
              import_id: input.import_id ?? null,
              agent_commit_hash: input.agent_commit_hash,
              base_main_commit_hash: input.base_main_commit_hash,
              conflicted_files: [...input.conflicted_files],
              conflict_summary: input.conflict_summary ?? null,
              resulting_task_status: nextStatus,
            }
          );
          return {
            task_status: nextStatus,
            conflicted_files: [...input.conflicted_files],
          };
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async recordVerificationRun(input: {
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
    isolation_runtime?: "runsc" | null;
    trusted_policy_sha256?: string | null;
    keep_verifying_on_infra_retry?: boolean;
    exit_code: number;
    duration_ms: number;
    report_sha256: string;
  }): Promise<VerificationRunRecord> {
    validateVerificationIsolation(input);
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const checkRes = await this.pool.queryInActiveTx(
            `SELECT mc.*, t.rework_count, t.max_rework_cycles
             FROM merge_candidates mc
             INNER JOIN tasks t ON t.task_id = mc.task_id AND t.project_id = mc.project_id
             WHERE mc.merge_candidate_id = $1::uuid AND mc.project_id = $2::uuid AND mc.task_id = $3::uuid
             FOR UPDATE OF mc, t;`,
            [input.merge_candidate_id, input.project_id, input.task_id]
          );
          const mcRow = checkRes.rows[0];
          if (
            !mcRow ||
            Boolean(mcRow.is_superseded) ||
            String(mcRow.merge_candidate_hash) !== input.merge_candidate_hash ||
            String(mcRow.verified_tree_hash) !== input.verified_tree_hash
          ) {
            throw new PostgresRlsError(
              "23503",
              "VerificationRun composite foreign key binding mismatch against active MergeCandidate"
            );
          }

          const overallStatus: VerificationOverallStatus =
            input.overall_status ?? (input.verdict === "PASS" ? "PASSED" : "FAILED_ACCEPTANCE");
          const tamperDetected = input.tier2_baseline_tamper_detected ?? false;
          const infraRetryCount = input.infra_retry_count ?? 0;
          const t1 =
            input.tier1_trusted_acceptance_passed !== undefined
              ? input.tier1_trusted_acceptance_passed
              : input.verdict === "PASS"
              ? true
              : null;
          const t2 =
            input.tier2_protected_baseline_passed !== undefined
              ? input.tier2_protected_baseline_passed
              : input.verdict === "PASS"
              ? true
              : null;
          const t3 =
            input.tier3_agent_tests_passed !== undefined
              ? input.tier3_agent_tests_passed
              : input.verdict === "PASS"
              ? true
              : null;

          await this.pool.queryInActiveTx(
            `UPDATE review_artifacts SET status = 'INVALIDATED_STALE_CANDIDATE', is_invalidated = TRUE,
                 invalidated_reason = 'VERIFICATION_RUN_RERUN'
             WHERE merge_candidate_id = $1::uuid AND (status = 'VALID' OR is_invalidated = FALSE);`,
            [input.merge_candidate_id]
          );
          await this.pool.queryInActiveTx(
            `UPDATE approval_requests SET status = 'INVALIDATED_STALE_CANDIDATE', updated_at = clock_timestamp()
             WHERE merge_candidate_id = $1::uuid AND status = 'PENDING';`,
            [input.merge_candidate_id]
          );
          await this.pool.queryInActiveTx(
            `UPDATE approval_decisions SET status = 'INVALIDATED', invalidated_reason = 'VERIFICATION_RUN_RERUN'
             WHERE merge_candidate_id = $1::uuid AND status = 'ACTIVE';`,
            [input.merge_candidate_id]
          );

          const ins = await this.pool.queryInActiveTx(
            `INSERT INTO verification_runs (
              project_id, task_id, merge_candidate_id, merge_candidate_hash, verified_tree_hash,
              verifier_image_digest, verdict, overall_status,
              tier1_trusted_acceptance_passed, tier2_protected_baseline_passed,
              tier2_baseline_tamper_detected, tampered_baseline_paths,
              tier3_agent_tests_passed, tier3_assertions_json,
              infra_retry_count, execution_backend, hermetic_network_disabled,
              hardlink_cache_forbidden, is_docker_isolated, trusted_policy_sha256,
              exit_code, duration_ms, report_sha256, isolation_runtime
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
              $6::text, $7::text, $8::text,
              $9::boolean, $10::boolean,
              $11::boolean, $12::jsonb,
              $13::boolean, $14::jsonb,
              $15::integer, $16::text, $17::boolean,
              $18::boolean, $19::boolean, $20::text,
              $21::integer, $22::integer, $23::text, $24::text
            ) RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.merge_candidate_id,
              input.merge_candidate_hash,
              input.verified_tree_hash,
              input.verifier_image_digest,
              input.verdict,
              overallStatus,
              t1,
              t2,
              tamperDetected,
              input.tampered_baseline_paths ?? [],
              t3,
              input.tier3_assertions ?? [],
              infraRetryCount,
              input.execution_backend ?? "docker",
              input.hermetic_network_disabled ?? true,
              input.hardlink_cache_forbidden ?? true,
              input.is_docker_isolated ?? false,
              input.trusted_policy_sha256 ?? null,
              input.exit_code,
              input.duration_ms,
              input.report_sha256,
              input.isolation_runtime ?? null,
            ]
          );
          const record = mapVerificationRunRow(ins.rows[0]!);

          let nextTaskStatus: TaskStatus;
          if (input.verdict === "PASS") {
            nextTaskStatus = "UnderIndependentReview";
          } else if (overallStatus === "INFRA_ERROR") {
            nextTaskStatus = input.keep_verifying_on_infra_retry
              ? "VerifyingInDocker"
              : "ManualIntervention";
            if (nextTaskStatus === "ManualIntervention") {
              await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
            }
          } else {
            const reworkCount = Number(mcRow.rework_count);
            const maxRework = Number(mcRow.max_rework_cycles);
            nextTaskStatus = reworkCount < maxRework ? "ReworkRequired" : "ManualIntervention";
            await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
          }

          await this.pool.queryInActiveTx(
            "UPDATE tasks SET status = $1::text, updated_at = clock_timestamp() WHERE task_id = $2::uuid;",
            [nextTaskStatus, input.task_id]
          );

          await this.insertOutboxEventSql(
            input.project_id,
            "verification_run",
            record.verification_run_id,
            "verification.completed",
            {
              task_id: input.task_id,
              merge_candidate_id: input.merge_candidate_id,
              merge_candidate_hash: input.merge_candidate_hash,
              verdict: record.verdict,
              overall_status: record.overall_status,
              tier2_baseline_tamper_detected: record.tier2_baseline_tamper_detected,
              infra_retry_count: record.infra_retry_count,
              execution_backend: record.execution_backend,
              is_docker_isolated: record.is_docker_isolated,
              isolation_runtime: record.isolation_runtime,
              resulting_task_status: nextTaskStatus,
            }
          );

          return record;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async recordReviewSession(input: {
    review_session_id?: string;
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
    sandbox_pid?: number | null;
    sandbox_cgroup_path?: string | null;
    cleanup_populated_zero_verified?: boolean;
    status?: ReviewSessionStatus;
    started_at?: string;
    completed_at?: string | null;
  }): Promise<ReviewSessionRecord> {
    try {
      const sessionId = input.review_session_id ?? randomUUID();
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO review_sessions (
          review_session_id, project_id, task_id, merge_candidate_id, verification_run_id,
          reviewer_principal_id, reviewer_credential_id, reviewer_agent_profile_id,
          reviewer_provider, reviewer_model, role, sandbox_backend_mode, sandbox_pid,
          sandbox_cgroup_path, cleanup_populated_zero_verified, status, started_at, completed_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::text, $7::text, $8::text,
          $9::text, $10::text, $11::text, $12::text, $13::integer,
          $14::text, $15::boolean, $16::text, COALESCE($17::timestamptz, clock_timestamp()), $18::timestamptz
        ) RETURNING *;`,
        [
          sessionId,
          input.project_id,
          input.task_id,
          input.merge_candidate_id,
          input.verification_run_id,
          input.reviewer_principal_id.trim(),
          input.reviewer_credential_id.trim(),
          input.reviewer_agent_profile_id.trim(),
          input.reviewer_provider.trim(),
          input.reviewer_model.trim(),
          input.role,
          input.sandbox_backend_mode,
          input.sandbox_pid ?? null,
          input.sandbox_cgroup_path ?? null,
          input.cleanup_populated_zero_verified ?? false,
          input.status ?? "ACTIVE",
          input.started_at ?? null,
          input.completed_at ?? null,
        ]
      );
      return mapReviewSessionRow(res.rows[0]!);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async completeReviewSession(input: {
    project_id: string;
    review_session_id: string;
    status: "COMPLETED" | "FAILED" | "REVOKED";
    cleanup_populated_zero_verified: boolean;
    sandbox_backend_mode?: string;
    sandbox_pid?: number | null;
    sandbox_cgroup_path?: string | null;
  }): Promise<ReviewSessionRecord> {
    try {
      const res = await this.pool.queryInActiveTx(
        `UPDATE review_sessions SET
          status = $1::text,
          cleanup_populated_zero_verified = $2::boolean,
          sandbox_backend_mode = COALESCE($3::text, sandbox_backend_mode),
          sandbox_pid = COALESCE($4::integer, sandbox_pid),
          sandbox_cgroup_path = COALESCE($5::text, sandbox_cgroup_path),
          completed_at = clock_timestamp()
        WHERE review_session_id = $6::uuid AND project_id = $7::uuid
        RETURNING *;`,
        [
          input.status,
          input.cleanup_populated_zero_verified,
          input.sandbox_backend_mode ?? null,
          input.sandbox_pid ?? null,
          input.sandbox_cgroup_path ?? null,
          input.review_session_id,
          input.project_id,
        ]
      );
      if (!res.rows[0]) {
        throw new PostgresRlsError("23503", `ReviewSession ${input.review_session_id} not found`);
      }
      return mapReviewSessionRow(res.rows[0]);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async recordReviewArtifact(input: {
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
    developer_principal_id: string;
    reviewer_principal_id: string;
    developer_session_id: string;
    reviewer_session_id: string;
    developer_credential_id?: string | null;
    reviewer_credential_id?: string | null;
    developer_agent_profile_id?: string | null;
    reviewer_agent_profile_id?: string | null;
    review_session_id?: string | null;
    summary_markdown?: string | null;
    report_sha256?: string | null;
    approval_request_ttl_ms?: number;
    verdict: "PASS" | "FAIL";
    findings_json?: ReadonlyArray<Record<string, unknown>>;
  }): Promise<ReviewArtifactRecord> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const preRes = await this.pool.queryInActiveTx(
            `SELECT vr.verification_run_id, vr.verdict AS vr_verdict,
                    mc.agent_commit_hash, mc.base_main_commit_hash, mc.is_superseded,
                    t.rework_count, t.max_rework_cycles, p.approval_ttl_seconds,
                    (SELECT v2.verification_run_id FROM verification_runs v2
                     WHERE v2.project_id = $1::uuid AND v2.merge_candidate_id = $3::uuid
                     ORDER BY v2.created_at DESC LIMIT 1) AS latest_vr_id
             FROM verification_runs vr
             INNER JOIN merge_candidates mc ON mc.merge_candidate_id = vr.merge_candidate_id AND mc.project_id = vr.project_id
             INNER JOIN tasks t ON t.task_id = mc.task_id AND t.project_id = mc.project_id
             INNER JOIN projects p ON p.project_id = t.project_id
             WHERE vr.verification_run_id = $2::uuid AND vr.project_id = $1::uuid
               AND vr.merge_candidate_id = $3::uuid AND vr.task_id = $4::uuid
             LIMIT 1;`,
            [input.project_id, input.verification_run_id, input.merge_candidate_id, input.task_id]
          );
          const row = preRes.rows[0];
          if (!row || String(row.vr_verdict) !== "PASS" || Boolean(row.is_superseded)) {
            throw new PostgresRlsError(
              "23503",
              "ReviewArtifact composite foreign key binding mismatch against PASS VerificationRun"
            );
          }
          if (row.latest_vr_id && String(row.latest_vr_id) !== input.verification_run_id) {
            throw new PostgresRlsError(
              "23503",
              `VerificationRun ${input.verification_run_id} was superseded by newer run ${String(row.latest_vr_id)}`
            );
          }

          const ins = await this.pool.queryInActiveTx(
            `INSERT INTO review_artifacts (
              project_id, task_id, merge_candidate_id, verification_run_id,
              merge_candidate_hash, verified_tree_hash,
              writer_provider, writer_model, reviewer_provider, reviewer_model,
              developer_principal_id, reviewer_principal_id,
              developer_session_id, reviewer_session_id,
              developer_credential_id, reviewer_credential_id,
              developer_agent_profile_id, reviewer_agent_profile_id,
              review_session_id, verdict, status, is_invalidated,
              summary_markdown, report_sha256, findings_json
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              $5::text, $6::text,
              $7::text, $8::text, $9::text, $10::text,
              $11::text, $12::text,
              $13::text, $14::text,
              $15::text, $16::text,
              $17::text, $18::text,
              $19::uuid, $20::text, 'VALID', FALSE,
              $21::text, $22::text, $23::jsonb
            ) RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.merge_candidate_id,
              input.verification_run_id,
              input.merge_candidate_hash,
              input.verified_tree_hash,
              input.writer_provider.trim(),
              input.writer_model.trim(),
              input.reviewer_provider.trim(),
              input.reviewer_model.trim(),
              input.developer_principal_id.trim(),
              input.reviewer_principal_id.trim(),
              input.developer_session_id.trim(),
              input.reviewer_session_id.trim(),
              input.developer_credential_id ?? null,
              input.reviewer_credential_id ?? null,
              input.developer_agent_profile_id ?? null,
              input.reviewer_agent_profile_id ?? null,
              input.review_session_id ?? null,
              input.verdict,
              input.summary_markdown ?? null,
              input.report_sha256 ?? null,
              input.findings_json ?? [],
            ]
          );
          const artifact = mapReviewArtifactRow(ins.rows[0]!);

          if (input.verdict === "PASS") {
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET status = 'AwaitingHumanApproval', updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
              [input.task_id]
            );
            await this.pool.queryInActiveTx(
              `UPDATE approval_requests SET status = 'INVALIDATED_STALE_CANDIDATE', updated_at = clock_timestamp()
               WHERE merge_candidate_id = $1::uuid AND status = 'PENDING';`,
              [input.merge_candidate_id]
            );
            const reqTtlMs =
              input.approval_request_ttl_ms ?? Number(row.approval_ttl_seconds) * 1000;
            if (reqTtlMs <= 0) {
              throw new PostgresRlsError("23514", "chk_ar_ttl_window: expires_at must be > created_at");
            }
            await this.pool.queryInActiveTx(
              `INSERT INTO approval_requests (
                project_id, task_id, merge_candidate_id,
                agent_commit_hash, base_main_commit_hash, merge_candidate_hash, verified_tree_hash,
                verification_run_id, review_artifact_id, status, expires_at
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid,
                $4::text, $5::text, $6::text, $7::text,
                $8::uuid, $9::uuid, 'PENDING',
                clock_timestamp() + ($10::bigint * interval '1 millisecond')
              );`,
              [
                input.project_id,
                input.task_id,
                input.merge_candidate_id,
                String(row.agent_commit_hash),
                String(row.base_main_commit_hash),
                input.merge_candidate_hash,
                input.verified_tree_hash,
                input.verification_run_id,
                artifact.review_artifact_id,
                reqTtlMs,
              ]
            );
          } else {
            const nextStatus: TaskStatus =
              Number(row.rework_count) < Number(row.max_rework_cycles)
                ? "ReworkRequired"
                : "ManualIntervention";
            await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET status = $1::text, updated_at = clock_timestamp() WHERE task_id = $2::uuid;",
              [nextStatus, input.task_id]
            );
          }
          return artifact;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async submitHumanApproval(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_request_id?: string;
    agent_commit_hash: string;
    base_main_commit_hash: string;
    verified_tree_hash: string;
    merge_candidate_hash: string;
    verification_run_id: string;
    review_artifact_id: string;
    approver_principal_id: string;
    decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
    feedback?: string;
    ttl_ms?: number;
    current_main_commit_hash?: string;
  }): Promise<ApprovalDecisionRecord> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.approver_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const membership = await this.getProjectMembership(input.project_id, input.approver_principal_id);
          if (
            !membership ||
            (membership.member_role !== "PROJECT_APPROVER" && membership.member_role !== "ORG_ADMIN")
          ) {
            throw new PostgresRlsError(
              "42501",
              `Principal ${input.approver_principal_id} (${
                membership ? `role=${membership.member_role}` : "no project membership"
              }) is not authorized to approve in project ${input.project_id}`
            );
          }

          const stateRes = await this.pool.queryInActiveTx(
            `SELECT p.approval_ttl_seconds, p.main_ref_commit_hash,
                    t.status AS task_status, t.rework_count, t.max_rework_cycles,
                    mc.task_id AS mc_task_id, mc.is_superseded,
                    mc.agent_commit_hash AS mc_agent, mc.base_main_commit_hash AS mc_base,
                    mc.merge_candidate_hash AS mc_cand, mc.verified_tree_hash AS mc_tree,
                    ra.task_id AS ra_task_id, ra.merge_candidate_id AS ra_mc_id,
                    ra.verification_run_id AS ra_vr_id, ra.merge_candidate_hash AS ra_cand,
                    ra.verified_tree_hash AS ra_tree,
                    ra.is_invalidated AS ra_invalidated, ra.status AS ra_status, ra.verdict AS ra_verdict,
                    vr.task_id AS vr_task_id, vr.merge_candidate_id AS vr_mc_id,
                    vr.verdict AS vr_verdict
             FROM projects p
             INNER JOIN tasks t ON t.project_id = p.project_id AND t.task_id = $2::uuid
             INNER JOIN merge_candidates mc ON mc.project_id = p.project_id AND mc.merge_candidate_id = $3::uuid
             INNER JOIN review_artifacts ra ON ra.project_id = p.project_id AND ra.review_artifact_id = $4::uuid
             INNER JOIN verification_runs vr ON vr.project_id = p.project_id AND vr.verification_run_id = $5::uuid
             WHERE p.project_id = $1::uuid
             FOR UPDATE OF t, mc;`,
            [
              input.project_id,
              input.task_id,
              input.merge_candidate_id,
              input.review_artifact_id,
              input.verification_run_id,
            ]
          );
          const row = stateRes.rows[0];
          if (!row) {
            throw new PostgresRlsError(
              "23503",
              'insert or update on table "approval_decisions" violates composite 8-field foreign key constraint'
            );
          }
          if (String(row.task_status) !== "AwaitingHumanApproval") {
            throw new PostgresRlsError(
              "23514",
              `Task must be in AwaitingHumanApproval status to receive human approval, got ${String(row.task_status)}`
            );
          }
          if (
            String(row.mc_task_id) !== input.task_id ||
            String(row.mc_agent) !== input.agent_commit_hash ||
            String(row.mc_base) !== input.base_main_commit_hash ||
            String(row.mc_cand) !== input.merge_candidate_hash ||
            String(row.mc_tree) !== input.verified_tree_hash ||
            String(row.ra_task_id) !== input.task_id ||
            String(row.ra_mc_id) !== input.merge_candidate_id ||
            String(row.ra_vr_id) !== input.verification_run_id ||
            String(row.ra_cand) !== input.merge_candidate_hash ||
            String(row.ra_tree) !== input.verified_tree_hash ||
            String(row.vr_task_id) !== input.task_id ||
            String(row.vr_mc_id) !== input.merge_candidate_id ||
            Boolean(row.is_superseded) ||
            Boolean(row.ra_invalidated) ||
            String(row.ra_status) !== "VALID" ||
            String(row.ra_verdict) !== "PASS" ||
            String(row.vr_verdict) !== "PASS"
          ) {
            throw new PostgresRlsError(
              "23503",
              'insert or update on table "approval_decisions" violates composite 8-field foreign key constraint'
            );
          }

          const arRes = input.approval_request_id
            ? await this.pool.queryInActiveTx(
                `SELECT *, (expires_at <= clock_timestamp()) AS is_expired_now
                 FROM approval_requests WHERE approval_request_id = $1::uuid LIMIT 1;`,
                [input.approval_request_id]
              )
            : await this.pool.queryInActiveTx(
                `SELECT *, (expires_at <= clock_timestamp()) AS is_expired_now
                 FROM approval_requests
                 WHERE merge_candidate_id = $1::uuid AND review_artifact_id = $2::uuid
                 ORDER BY (status = 'PENDING') DESC, created_at DESC LIMIT 1;`,
                [input.merge_candidate_id, input.review_artifact_id]
              );
          const arRow = arRes.rows[0];
          if (
            input.approval_request_id &&
            (!arRow ||
              String(arRow.project_id) !== input.project_id ||
              String(arRow.task_id) !== input.task_id ||
              String(arRow.merge_candidate_id) !== input.merge_candidate_id ||
              String(arRow.review_artifact_id) !== input.review_artifact_id ||
              String(arRow.verification_run_id) !== input.verification_run_id ||
              String(arRow.agent_commit_hash) !== String(row.mc_agent) ||
              String(arRow.base_main_commit_hash) !== String(row.mc_base) ||
              String(arRow.merge_candidate_hash) !== String(row.mc_cand) ||
              String(arRow.verified_tree_hash) !== String(row.mc_tree))
          ) {
            throw new PostgresRlsError(
              "23503",
              `ApprovalRequest ${input.approval_request_id} violates composite binding to candidate ${input.merge_candidate_id} / review ${input.review_artifact_id}`
            );
          }
          const approvalRequestId = arRow ? String(arRow.approval_request_id) : null;

          if (input.decision === "APPROVED") {
            const liveMainSha =
              input.current_main_commit_hash ??
              (row.main_ref_commit_hash ? String(row.main_ref_commit_hash) : "");
            if (!liveMainSha || liveMainSha !== String(row.mc_base)) {
              await this.pool.queryInActiveTx(
                "UPDATE merge_candidates SET is_superseded = TRUE WHERE merge_candidate_id = $1::uuid;",
                [input.merge_candidate_id]
              );
              await this.pool.queryInActiveTx(
                `UPDATE review_artifacts SET status = 'INVALIDATED_STALE_BASE', is_invalidated = TRUE,
                     invalidated_reason = $1::text
                 WHERE merge_candidate_id = $2::uuid;`,
                [
                  `APPROVAL_REJECTED_STALE_BASE_${String(row.mc_base)}_VS_${liveMainSha}`,
                  input.merge_candidate_id,
                ]
              );
              if (approvalRequestId) {
                await this.pool.queryInActiveTx(
                  "UPDATE approval_requests SET status = 'INVALIDATED_STALE_BASE', updated_at = clock_timestamp() WHERE approval_request_id = $1::uuid;",
                  [approvalRequestId]
                );
              }
              await this.pool.queryInActiveTx(
                `UPDATE tasks SET status = 'BuildingMergeCandidate',
                     base_main_commit_hash = COALESCE(NULLIF($1::text, ''), base_main_commit_hash),
                     active_merge_candidate_id = NULL, updated_at = clock_timestamp()
                 WHERE task_id = $2::uuid;`,
                [liveMainSha, input.task_id]
              );
              throw new ApprovalExpiredOrStaleError(
                `ERR_APPROVAL_EXPIRED_OR_STALE: candidate base_main_commit_hash ${String(row.mc_base)} is stale against live main ${liveMainSha}`,
                "INVALIDATED_STALE_BASE"
              );
            }

            if (
              !arRow ||
              String(arRow.status) !== "PENDING" ||
              Boolean(arRow.is_expired_now)
            ) {
              if (approvalRequestId) {
                await this.pool.queryInActiveTx(
                  "UPDATE approval_requests SET status = 'INVALIDATED_EXPIRED', updated_at = clock_timestamp() WHERE approval_request_id = $1::uuid;",
                  [approvalRequestId]
                );
              }
              await this.pool.queryInActiveTx(
                "UPDATE merge_candidates SET is_superseded = TRUE WHERE merge_candidate_id = $1::uuid;",
                [input.merge_candidate_id]
              );
              await this.pool.queryInActiveTx(
                `UPDATE tasks SET status = 'BuildingMergeCandidate', active_merge_candidate_id = NULL,
                     updated_at = clock_timestamp()
                 WHERE task_id = $1::uuid;`,
                [input.task_id]
              );
              throw new ApprovalExpiredOrStaleError(
                "ERR_APPROVAL_EXPIRED_OR_STALE: ApprovalRequest expired or missing",
                "INVALIDATED_EXPIRED"
              );
            }
          }

          const ttlMs = input.ttl_ms ?? Number(row.approval_ttl_seconds) * 1000;
          if (ttlMs <= 0) {
            throw new PostgresRlsError("23514", "chk_approval_ttl_window: expires_at must be > approved_at");
          }

          const initialStatus = input.decision === "APPROVED" ? "ACTIVE" : "CONSUMED";
          const ins = await this.pool.queryInActiveTx(
            `INSERT INTO approval_decisions (
              project_id, task_id, merge_candidate_id, approval_request_id,
              agent_commit_hash, base_main_commit_hash, verified_tree_hash, merge_candidate_hash,
              verification_run_id, review_artifact_id, approver_principal_id,
              decision, status, approved_at, expires_at, consumed_at
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              $5::text, $6::text, $7::text, $8::text,
              $9::uuid, $10::uuid, $11::text,
              $12::text, $13::text, clock_timestamp(),
              clock_timestamp() + ($14::bigint * interval '1 millisecond'),
              CASE WHEN $13::text = 'CONSUMED' THEN clock_timestamp() ELSE NULL END
            ) RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.merge_candidate_id,
              approvalRequestId,
              input.agent_commit_hash,
              input.base_main_commit_hash,
              input.verified_tree_hash,
              input.merge_candidate_hash,
              input.verification_run_id,
              input.review_artifact_id,
              input.approver_principal_id,
              input.decision,
              initialStatus,
              ttlMs,
            ]
          );
          const record = mapApprovalDecisionRow(ins.rows[0]!);

          if (approvalRequestId) {
            await this.pool.queryInActiveTx(
              "UPDATE approval_requests SET status = $1::text, updated_at = clock_timestamp() WHERE approval_request_id = $2::uuid;",
              [input.decision === "APPROVED" ? "APPROVED" : "REJECTED", approvalRequestId]
            );
          }

          let nextTaskStatus: TaskStatus;
          if (input.decision === "APPROVED") {
            nextTaskStatus = "AtomicCasMerge";
          } else if (input.decision === "REQUEST_CHANGES") {
            nextTaskStatus =
              Number(row.rework_count) < Number(row.max_rework_cycles)
                ? "ReworkRequired"
                : "ManualIntervention";
            await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
          } else {
            nextTaskStatus = "ManualIntervention";
            await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
          }

          await this.pool.queryInActiveTx(
            "UPDATE tasks SET status = $1::text, updated_at = clock_timestamp() WHERE task_id = $2::uuid;",
            [nextTaskStatus, input.task_id]
          );

          await this.insertOutboxEventSql(
            input.project_id,
            "approval_decision",
            record.approval_id,
            "human.approval_decided",
            {
              task_id: input.task_id,
              merge_candidate_id: input.merge_candidate_id,
              approval_request_id: approvalRequestId,
              decision: input.decision,
              approver_principal_id: input.approver_principal_id,
              resulting_task_status: nextTaskStatus,
              ...(input.feedback ? { feedback: input.feedback } : {}),
            }
          );

          return record;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async executeAtomicCasMergeOrReconcile(input: {
    project_id: string;
    task_id: string;
    merge_candidate_id: string;
    approval_id: string;
    gitBridge?: {
      readonly getCurrentMainHead: () => string;
      readonly atomicCompareAndSwapMainRef: (
        expectedOldSha: string,
        newCandidateSha: string
      ) => boolean;
    };
    simulateCrashAfterGitUpdateRef?: boolean;
  }): Promise<CasMergeResult> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" },
      async () => {
        try {
          const res = await this.pool.queryInActiveTx(
            `SELECT p.main_ref_commit_hash,
                    t.status AS task_status, t.merged_commit_hash,
                    mc.base_main_commit_hash, mc.merge_candidate_hash, mc.verified_tree_hash,
                    ad.decision, ad.status AS approval_status, ad.approval_request_id,
                    (ad.expires_at <= clock_timestamp()) AS approval_expired_now
             FROM projects p
             INNER JOIN tasks t ON t.project_id = p.project_id AND t.task_id = $2::uuid
             INNER JOIN merge_candidates mc ON mc.project_id = p.project_id AND mc.merge_candidate_id = $3::uuid
             INNER JOIN approval_decisions ad ON ad.project_id = p.project_id AND ad.approval_id = $4::uuid
             WHERE p.project_id = $1::uuid
             FOR UPDATE OF t, mc, ad;`,
            [input.project_id, input.task_id, input.merge_candidate_id, input.approval_id]
          );
          const row = res.rows[0];
          if (!row) {
            throw new Error("Missing project, task, merge_candidate, or approval_decision for CAS merge");
          }
          if (String(row.decision) !== "APPROVED") {
            throw new Error(`Cannot merge candidate with decision ${String(row.decision)}`);
          }
          const taskStatus = String(row.task_status) as TaskStatus;
          if (taskStatus !== "AtomicCasMerge" && taskStatus !== "MergedAndCompleted") {
            throw new Error(
              `Task must be in AtomicCasMerge status for CAS merge, current status is ${taskStatus}`
            );
          }

          const currentMainSha = input.gitBridge
            ? input.gitBridge.getCurrentMainHead()
            : String(row.main_ref_commit_hash ?? "");
          if (!currentMainSha) {
            throw new PostgresRlsError(
              "23503",
              `Project ${input.project_id} is missing required refs/heads/main pointer`
            );
          }

          if (taskStatus === "MergedAndCompleted" && row.merged_commit_hash) {
            const opRes = await this.pool.queryInActiveTx(
              `SELECT * FROM merge_operations
               WHERE project_id = $1::uuid AND task_id = $2::uuid AND approval_id = $3::uuid
               LIMIT 1;`,
              [input.project_id, input.task_id, input.approval_id]
            );
            const op = opRes.rows[0] ? mapMergeOperationRow(opRes.rows[0]) : undefined;
            return {
              status: "RECONCILED_ALREADY_MERGED",
              task_status: "MergedAndCompleted",
              merged_commit_hash: String(row.merged_commit_hash),
              main_ref_commit_hash: currentMainSha,
              ...(op ? { merge_op_id: op.merge_op_id } : {}),
              reconciled_after_lost_response: op?.reconciled_after_lost_response ?? false,
            };
          }

          const mergeIdempKey = `merge:${input.project_id}:${input.task_id}:${String(row.merge_candidate_hash)}:${input.approval_id}`;
          let opRes = await this.pool.queryInActiveTx(
            "SELECT * FROM merge_operations WHERE project_id = $1::uuid AND merge_idempotency_key = $2::text LIMIT 1;",
            [input.project_id, mergeIdempKey]
          );
          let mergeOp: MergeOperationRecord;
          if (opRes.rows[0]) {
            mergeOp = mapMergeOperationRow(opRes.rows[0]);
            if (mergeOp.status === "IN_PROGRESS") {
              const upd = await this.pool.queryInActiveTx(
                "UPDATE merge_operations SET retry_count = retry_count + 1 WHERE merge_op_id = $1::uuid RETURNING *;",
                [mergeOp.merge_op_id]
              );
              mergeOp = mapMergeOperationRow(upd.rows[0]!);
            }
          } else {
            const insOp = await this.pool.queryInActiveTx(
              `INSERT INTO merge_operations (
                project_id, task_id, merge_candidate_id, approval_id, merge_idempotency_key,
                base_main_commit_hash, merge_candidate_hash, verified_tree_hash, status
              ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text, $8::text, 'IN_PROGRESS')
              RETURNING *;`,
              [
                input.project_id,
                input.task_id,
                input.merge_candidate_id,
                input.approval_id,
                mergeIdempKey,
                String(row.base_main_commit_hash),
                String(row.merge_candidate_hash),
                String(row.verified_tree_hash),
              ]
            );
            mergeOp = mapMergeOperationRow(insOp.rows[0]!);
          }

          const mcHash = String(row.merge_candidate_hash);
          const baseHash = String(row.base_main_commit_hash);
          const approvalReqId = row.approval_request_id ? String(row.approval_request_id) : null;

          const commitReconciledMerge = async (reconciled: boolean, eventName: string): Promise<CasMergeResult> => {
            await this.pool.queryInActiveTx(
              "UPDATE projects SET main_ref_commit_hash = $1::text, updated_at = clock_timestamp() WHERE project_id = $2::uuid;",
              [mcHash, input.project_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE approval_decisions SET status = 'CONSUMED', consumed_at = COALESCE(consumed_at, clock_timestamp()) WHERE approval_id = $1::uuid;",
              [input.approval_id]
            );
            if (approvalReqId) {
              await this.pool.queryInActiveTx(
                "UPDATE approval_requests SET status = 'APPROVED', updated_at = clock_timestamp() WHERE approval_request_id = $1::uuid;",
                [approvalReqId]
              );
            }
            await this.pool.queryInActiveTx(
              "UPDATE merge_candidates SET snapshot_retention_class = 'MERGED_PERMANENT' WHERE merge_candidate_id = $1::uuid;",
              [input.merge_candidate_id]
            );
            await this.pool.queryInActiveTx(
              `UPDATE merge_operations SET status = 'MERGED', reconciled_after_lost_response = $1::boolean,
                   last_error = NULL, completed_at = clock_timestamp()
               WHERE merge_op_id = $2::uuid;`,
              [reconciled, mergeOp.merge_op_id]
            );
            await this.closeActiveLeasesForTaskSql(input.task_id, "COMPLETED");
            await this.pool.queryInActiveTx(
              `UPDATE tasks SET status = 'MergedAndCompleted', merged_commit_hash = $1::text,
                   merged_at = clock_timestamp(), updated_at = clock_timestamp()
               WHERE task_id = $2::uuid;`,
              [mcHash, input.task_id]
            );
            await this.insertOutboxEventSql(input.project_id, "task", input.task_id, eventName, {
              task_id: input.task_id,
              merge_candidate_id: input.merge_candidate_id,
              merged_commit_hash: mcHash,
              approval_id: input.approval_id,
              merge_op_id: mergeOp.merge_op_id,
            });
            return {
              status: reconciled ? "RECONCILED_ALREADY_MERGED" : "MERGED_BY_CAS",
              task_status: "MergedAndCompleted",
              merged_commit_hash: mcHash,
              main_ref_commit_hash: mcHash,
              merge_op_id: mergeOp.merge_op_id,
              reconciled_after_lost_response: reconciled,
            };
          };

          if (currentMainSha === mcHash) {
            return await commitReconciledMerge(true, "task.merged_reconciled");
          }

          if (String(row.approval_status) !== "ACTIVE" || Boolean(row.approval_expired_now)) {
            if (String(row.approval_status) === "ACTIVE") {
              await this.pool.queryInActiveTx(
                "UPDATE approval_decisions SET status = 'EXPIRED', invalidated_reason = 'APPROVAL_TTL_EXPIRED' WHERE approval_id = $1::uuid;",
                [input.approval_id]
              );
            }
            await this.pool.queryInActiveTx(
              "UPDATE merge_operations SET last_error = 'APPROVAL_TTL_EXPIRED' WHERE merge_op_id = $1::uuid;",
              [mergeOp.merge_op_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE tasks SET status = 'AwaitingHumanApproval', updated_at = clock_timestamp() WHERE task_id = $1::uuid;",
              [input.task_id]
            );
            return {
              status: "APPROVAL_EXPIRED",
              task_status: "AwaitingHumanApproval",
              merged_commit_hash: null,
              main_ref_commit_hash: currentMainSha,
              invalidated_approval_id: input.approval_id,
              merge_op_id: mergeOp.merge_op_id,
            };
          }

          const abortForConflict = async (observedSha: string): Promise<CasMergeResult> => {
            const errMsg = `CAS_MAIN_MOVED_FROM_${baseHash}_TO_${observedSha}`;
            await this.pool.queryInActiveTx(
              "UPDATE projects SET main_ref_commit_hash = $1::text, updated_at = clock_timestamp() WHERE project_id = $2::uuid;",
              [observedSha, input.project_id]
            );
            await this.pool.queryInActiveTx(
              `UPDATE merge_operations SET status = 'CAS_CONFLICT_ABORTED', last_error = $1::text, completed_at = clock_timestamp()
               WHERE merge_op_id = $2::uuid;`,
              [errMsg, mergeOp.merge_op_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE merge_candidates SET is_superseded = TRUE WHERE merge_candidate_id = $1::uuid;",
              [input.merge_candidate_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE review_artifacts SET status = 'INVALIDATED_STALE_BASE', is_invalidated = TRUE, invalidated_reason = $1::text WHERE merge_candidate_id = $2::uuid;",
              [errMsg, input.merge_candidate_id]
            );
            await this.pool.queryInActiveTx(
              "UPDATE approval_decisions SET status = 'INVALIDATED', invalidated_reason = $1::text WHERE approval_id = $2::uuid;",
              [errMsg, input.approval_id]
            );
            if (approvalReqId) {
              await this.pool.queryInActiveTx(
                "UPDATE approval_requests SET status = 'INVALIDATED_STALE_BASE', updated_at = clock_timestamp() WHERE approval_request_id = $1::uuid;",
                [approvalReqId]
              );
            }
            await this.pool.queryInActiveTx(
              `UPDATE tasks SET status = 'BuildingMergeCandidate', base_main_commit_hash = $1::text,
                   active_merge_candidate_id = NULL, updated_at = clock_timestamp()
               WHERE task_id = $2::uuid;`,
              [observedSha, input.task_id]
            );
            await this.insertOutboxEventSql(
              input.project_id,
              "merge_operation",
              mergeOp.merge_op_id,
              "merge.cas_conflict_detected",
              {
                task_id: input.task_id,
                merge_candidate_id: input.merge_candidate_id,
                stale_base_main_commit_hash: baseHash,
                observed_main_commit_hash: observedSha,
              }
            );
            return {
              status: "CAS_CONFLICT_NEEDS_REBASE",
              task_status: "BuildingMergeCandidate",
              merged_commit_hash: null,
              main_ref_commit_hash: observedSha,
              invalidated_approval_id: input.approval_id,
              merge_op_id: mergeOp.merge_op_id,
            };
          };

          if (currentMainSha !== baseHash) {
            return await abortForConflict(currentMainSha);
          }

          if (input.gitBridge) {
            const casOk = input.gitBridge.atomicCompareAndSwapMainRef(baseHash, mcHash);
            if (!casOk) {
              const racedSha = input.gitBridge.getCurrentMainHead();
              if (racedSha === mcHash) {
                return await commitReconciledMerge(true, "task.merged_reconciled");
              }
              return await abortForConflict(racedSha);
            }
          }

          if (input.simulateCrashAfterGitUpdateRef) {
            throw new SimulatedPostMergeCrashError(
              `Simulated crash right after git update-ref moved refs/heads/main to ${mcHash}`,
              mergeOp.merge_op_id
            );
          }

          return await commitReconciledMerge(false, "task.merged");
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async getMainRefCommitHash(projectId?: string): Promise<string | null> {
    const activeSession = this.pool.getActiveTxSession();
    const targetProjectId = projectId ?? activeSession?.currentProjectId ?? null;
    if (!targetProjectId) {
      return null;
    }
    if (
      activeSession &&
      activeSession.currentRole !== "system_admin_role" &&
      activeSession.currentProjectId !== targetProjectId
    ) {
      return null;
    }
    const res = await this.pool.queryInActiveTx(
      "SELECT main_ref_commit_hash FROM projects WHERE project_id = $1::uuid LIMIT 1;",
      [targetProjectId]
    );
    const val = res.rows[0]?.main_ref_commit_hash;
    return val ? String(val) : null;
  }

  public async getMergeCandidateById(mergeCandidateId: string): Promise<MergeCandidateRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM merge_candidates WHERE merge_candidate_id = $1::uuid LIMIT 1;",
      [mergeCandidateId]
    );
    return res.rows[0] ? mapMergeCandidateRow(res.rows[0]) : null;
  }

  public async listMergeCandidatesForTask(taskId: string): Promise<MergeCandidateRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM merge_candidates WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapMergeCandidateRow);
  }

  public async listVerificationRunsForTask(taskId: string): Promise<VerificationRunRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM verification_runs WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapVerificationRunRow);
  }

  public async listReviewSessionsForTask(taskId: string): Promise<ReviewSessionRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM review_sessions WHERE task_id = $1::uuid ORDER BY started_at ASC;",
      [taskId]
    );
    return res.rows.map(mapReviewSessionRow);
  }

  public async listReviewArtifactsForTask(taskId: string): Promise<ReviewArtifactRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM review_artifacts WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapReviewArtifactRow);
  }

  public async listApprovalRequestsForTask(taskId: string): Promise<ApprovalRequestRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM approval_requests WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapApprovalRequestRow);
  }

  public async getLatestApprovalRequestForCandidate(
    mergeCandidateId: string
  ): Promise<ApprovalRequestRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM approval_requests WHERE merge_candidate_id = $1::uuid ORDER BY created_at DESC LIMIT 1;",
      [mergeCandidateId]
    );
    return res.rows[0] ? mapApprovalRequestRow(res.rows[0]) : null;
  }

  public async listApprovalDecisionsForTask(taskId: string): Promise<ApprovalDecisionRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM approval_decisions WHERE task_id = $1::uuid ORDER BY approved_at ASC;",
      [taskId]
    );
    return res.rows.map(mapApprovalDecisionRow);
  }

  public async listMergeOperationsForTask(taskId: string): Promise<MergeOperationRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM merge_operations WHERE task_id = $1::uuid ORDER BY created_at ASC;",
      [taskId]
    );
    return res.rows.map(mapMergeOperationRow);
  }

  public async recordResourceUsageMetric(
    input: RecordResourceUsageMetricInput
  ): Promise<ResourceUsageMetricRecord> {
    return this.withExistingOrRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "gateway_service" },
      async () => {
        try {
          validateAndNormalizeResourceUsageMetricInput(input);
          let taskDefaults: { current_attempt_no: number; rework_count: number } | undefined;
          if (input.attempt_no === undefined || input.rework_cycle === undefined) {
            const taskRes = await this.pool.queryInActiveTx(
              "SELECT current_attempt_no, rework_count FROM tasks WHERE project_id = $1::uuid AND task_id = $2::uuid LIMIT 1;",
              [input.project_id, input.task_id]
            );
            const taskRow = taskRes.rows[0];
            if (taskRow) {
              taskDefaults = {
                current_attempt_no: Number(taskRow.current_attempt_no ?? 1),
                rework_count: Number(taskRow.rework_count ?? 0),
              };
            }
          }
          // Serialize spend ingestion before aggregation so concurrent task metrics
          // cannot each miss the other's uncommitted wall-time.
          await this.pool.queryInActiveTx("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid FOR UPDATE;", [input.project_id]);
          await this.pool.queryInActiveTx("SELECT 1 FROM task_budget_policies WHERE project_id = $1::uuid AND task_id = $2::uuid FOR UPDATE;", [input.project_id, input.task_id]);
          const normalized = validateAndNormalizeResourceUsageMetricInput(input, taskDefaults);

          const res = await this.pool.queryInActiveTx(
            `INSERT INTO resource_usage_metrics (
              project_id, task_id, lease_id, lease_epoch, attempt_no, rework_cycle,
              phase, wall_time_ms, cpu_usage_usec, peak_memory_bytes,
              sandbox_backend_mode, metrics_source
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::integer, $6::integer,
              $7::text, $8::integer, $9::bigint, $10::bigint, $11::text, $12::text
            ) RETURNING *;`,
            [
              input.project_id,
              input.task_id,
              input.lease_id ?? null,
              normalized.lease_epoch,
              normalized.attempt_no,
              normalized.rework_cycle,
              input.phase,
              normalized.wall_time_ms,
              normalized.cpu_usage_usec,
              normalized.peak_memory_bytes,
              normalized.sandbox_backend_mode,
              input.metrics_source,
            ]
          );
          const metric = mapResourceMetricRow(res.rows[0]!);
          await this.evaluatePostSpendBudgetPauseSql({
            project_id: input.project_id,
            task_id: input.task_id,
          });
          return metric;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listResourceUsageMetricsForTask(
    taskId: string
  ): Promise<ResourceUsageMetricRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM resource_usage_metrics WHERE task_id = $1::uuid ORDER BY recorded_at ASC;",
      [taskId]
    );
    return res.rows.map(mapResourceMetricRow);
  }

  public async listOutboxEventsForProject(): Promise<OutboxEventRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM outbox_events ORDER BY created_at ASC;"
    );
    return res.rows.map(mapOutboxRow);
  }

  public async getCandidateBoundLineage(
    taskId: string,
    liveMainHeadHash?: string | null
  ): Promise<CandidateBoundLineage | null> {
    const task = await this.getTaskById(taskId);
    if (!task) {
      return null;
    }
    const mainHeadCommitHash =
      liveMainHeadHash !== undefined
        ? liveMainHeadHash
        : await this.getMainRefCommitHash(task.project_id);
    const taskLeases = await this.listTaskLeasesForTask(taskId);
    const processedEvents = await this.listProcessedWorkerEventsForTask(taskId);
    const resourceUsageMetrics = await this.listResourceUsageMetricsForTask(taskId);
    const imports = await this.getVerifiedImportsForTask(taskId);
    const allMergeCandidates = await this.listMergeCandidatesForTask(taskId);
    const verificationRuns = await this.listVerificationRunsForTask(taskId);
    const reviewSessions = await this.listReviewSessionsForTask(taskId);
    const reviewArtifacts = await this.listReviewArtifactsForTask(taskId);
    const approvalRequests = await this.listApprovalRequestsForTask(taskId);
    const approvalDecisions = await this.listApprovalDecisionsForTask(taskId);
    const mergeOperations = await this.listMergeOperationsForTask(taskId);

    return buildCandidateBoundLineage({
      task,
      mainHeadCommitHash,
      taskLeases,
      processedEvents,
      resourceUsageMetrics,
      imports,
      allMergeCandidates,
      verificationRuns,
      reviewSessions,
      reviewArtifacts,
      approvalRequests,
      approvalDecisions,
      mergeOperations,
    });
  }

  // ===========================================================================
  // Milestone M6A: Model Cost Guard (AC-12b) & Stages 1–4 Product Pipeline
  // ===========================================================================

  public async createCostSession(input: CreateCostSessionInput): Promise<CostSessionRecord> {
    try {
      validateCreateCostSessionInput(input);
      const costSessionId = input.cost_session_id ?? randomUUID();
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO model_cost_sessions (
          cost_session_id, project_id, pipeline_session_id, task_id,
          max_tokens_per_request, max_cost_micro_usd_per_request,
          session_token_budget, session_cost_budget_micro_usd,
          tokens_used_total, cost_used_micro_usd, status
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          $5::bigint, $6::bigint, $7::bigint, $8::bigint,
          0, 0, 'ACTIVE'
        ) RETURNING *;`,
        [
          costSessionId,
          input.project_id,
          input.pipeline_session_id ?? null,
          input.task_id ?? null,
          input.max_tokens_per_request,
          input.max_cost_micro_usd_per_request,
          input.session_token_budget,
          input.session_cost_budget_micro_usd,
        ]
      );
      return mapCostSessionRow(res.rows[0]!);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async getCostSession(costSessionId: string): Promise<CostSessionRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM model_cost_sessions WHERE cost_session_id = $1::uuid LIMIT 1;",
      [costSessionId]
    );
    return res.rows[0] ? mapCostSessionRow(res.rows[0]) : null;
  }

  public async listModelCallLedgers(filter?: {
    readonly cost_session_id?: string;
    readonly pipeline_session_id?: string;
  }): Promise<ModelCallLedgerRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.cost_session_id) {
      params.push(filter.cost_session_id);
      conditions.push(`cost_session_id = $${params.length}::uuid`);
    }
    if (filter?.pipeline_session_id) {
      params.push(filter.pipeline_session_id);
      conditions.push(`pipeline_session_id = $${params.length}::uuid`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")} ` : "";
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM model_call_ledgers ${whereClause}ORDER BY created_at ASC;`,
      params
    );
    return res.rows.map(mapModelCallLedgerRow);
  }

  public async preflightCheckCostSession(
    input: CostPreflightCheckInput
  ): Promise<CostPreflightCheckResult> {
    const projectedTokens = input.estimated_input_tokens + input.reserved_output_tokens;
    const insertBlockedPreflightRow = async (params: {
      readonly session: CostSessionRecord;
      readonly blockReason: string;
      readonly errorMessage: string;
    }): Promise<ModelCallLedgerRecord> => {
      const callId = randomUUID();
      const ledgerRes = await this.pool.queryInActiveTx(
        `INSERT INTO model_call_ledgers (
          call_id, project_id, cost_session_id, pipeline_session_id, task_id,
          stage, provider, model, prompt_id, prompt_version, prompt_sha256, request_sha256,
          estimated_input_tokens, reserved_output_tokens,
          actual_input_tokens, actual_output_tokens, actual_total_tokens,
          estimated_cost_micro_usd, actual_cost_micro_usd,
          status, usage_estimated, block_reason, error_message, latency_ms
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::text, $7::text, $8::text, $9::text, $10::text, $11::char(64), $12::char(64),
          $13::integer, $14::integer,
          0, 0, 0,
          $15::bigint, 0,
          'BLOCKED_PREFLIGHT', FALSE, $16::text, $17::text, 0
        ) RETURNING *;`,
        [
          callId,
          input.project_id,
          input.cost_session_id,
          input.pipeline_session_id ?? params.session.pipeline_session_id,
          input.task_id ?? params.session.task_id,
          input.stage,
          input.provider,
          input.model,
          input.prompt_id,
          input.prompt_version,
          input.prompt_sha256,
          input.request_sha256,
          input.estimated_input_tokens,
          input.reserved_output_tokens,
          input.estimated_cost_micro_usd,
          params.blockReason,
          params.errorMessage,
        ]
      );
      return mapModelCallLedgerRow(ledgerRes.rows[0]!);
    };

    const insertBlockedPreflight = async (
      session: CostSessionRecord,
      violation: NonNullable<ReturnType<typeof evaluatePreflightLimits>>
    ): Promise<CostPreflightCheckResult> => {
      const blockedLedger = await insertBlockedPreflightRow({
        session,
        blockReason: `${violation.limitScope}: ${violation.reason}`,
        errorMessage: violation.reason,
      });
      return {
        allowed: false,
        limitScope: violation.limitScope,
        reason: violation.reason,
        session,
        blockedLedger,
      };
    };

    const checkBudgetForSession = async (session: CostSessionRecord): Promise<void> => {
      const targetPipelineId = input.pipeline_session_id ?? session.pipeline_session_id;
      const targetTaskId = input.task_id ?? session.task_id;
      await this.assertBudgetAllowsExecutionSql({
        project_id: input.project_id,
        task_id: targetTaskId,
        projected_tokens: projectedTokens,
        projected_cost_micro_usd: input.estimated_cost_micro_usd,
        blockedPreflight: { ...input, task_id: targetTaskId, pipeline_session_id: targetPipelineId },
        verifyParentsCommittedSql: async () => {
          const csCheck = await this.pool.queryInActiveTx(
            `SELECT 1 FROM model_cost_sessions
             WHERE cost_session_id = $1::uuid AND project_id = $2::uuid
             LIMIT 1 FOR KEY SHARE NOWAIT;`,
            [input.cost_session_id, input.project_id]
          );
          if (csCheck.rowCount === 0) {
            return false;
          }
          if (targetPipelineId) {
            const psCheck = await this.pool.queryInActiveTx(
              `SELECT 1 FROM product_pipeline_sessions
               WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
               LIMIT 1;`,
              [targetPipelineId, input.project_id]
            );
            if (psCheck.rowCount === 0) {
              return false;
            }
          }
          return true;
        },
        onBlockedSql: async (pauseScope, reason) => {
          await insertBlockedPreflightRow({
            session,
            blockReason: `${pauseScope}: ${reason}`,
            errorMessage: reason,
          });
        },
      });
    };

    const runLockedInCurrentTx = async (
      alreadyCheckedBudget = false
    ): Promise<CostPreflightCheckResult> => {
      try {
        if (!alreadyCheckedBudget) {
          const probeRes = await this.pool.queryInActiveTx(
            `SELECT * FROM model_cost_sessions
             WHERE cost_session_id = $1::uuid AND project_id = $2::uuid;`,
            [input.cost_session_id, input.project_id]
          );
          const probeRow = probeRes.rows[0];
          if (!probeRow) {
            throw new PostgresRlsError(
              "23503",
              `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
            );
          }
          await checkBudgetForSession(mapCostSessionRow(probeRow));
        }
        const sessRes = await this.pool.queryInActiveTx(
          `SELECT * FROM model_cost_sessions
           WHERE cost_session_id = $1::uuid AND project_id = $2::uuid
           FOR UPDATE;`,
          [input.cost_session_id, input.project_id]
        );
        const sessRow = sessRes.rows[0];
        if (!sessRow) {
          throw new PostgresRlsError(
            "23503",
            `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
          );
        }
        const session = mapCostSessionRow(sessRow);
        const violation = evaluatePreflightLimits(session, input);
        if (!violation) {
          return { allowed: true, session };
        }
        return await insertBlockedPreflight(session, violation);
      } catch (error) {
        mapPgError(error);
      }
    };

    const active = this.pool.getActiveTxSession();
    if (!active) {
      return this.withRlsTransaction(
        {
          currentProjectId: input.project_id,
          currentPrincipalId: "core_api_service",
          currentRole: "core_api_service",
        },
        () => runLockedInCurrentTx(false)
      );
    }

    // M6A-FU-03: Probe without FOR UPDATE first when called inside an outer transaction.
    // On preflight denials, persist BLOCKED_PREFLIGHT in an autonomous transaction unless
    // FOR UPDATE NOWAIT hits outer lock contention (55P03) or parent FKs are uncommitted.
    const fallbackSentinel = new Error("AUTONOMOUS_TX_FALLBACK");
    try {
      const probeRes = await this.pool.queryInActiveTx(
        `SELECT * FROM model_cost_sessions
         WHERE cost_session_id = $1::uuid AND project_id = $2::uuid;`,
        [input.cost_session_id, input.project_id]
      );
      const probeRow = probeRes.rows[0];
      if (!probeRow) {
        throw new PostgresRlsError(
          "23503",
          `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
        );
      }
      const probeSession = mapCostSessionRow(probeRow);
      await checkBudgetForSession(probeSession);
      const probeViolation = evaluatePreflightLimits(probeSession, input);
      if (!probeViolation) {
        return { allowed: true, session: probeSession };
      }

      try {
        return await this.pool.runAutonomousRlsTransaction(active, async () => {
          let sessRes2;
          try {
            sessRes2 = await this.pool.queryInActiveTx(
              `SELECT * FROM model_cost_sessions
               WHERE cost_session_id = $1::uuid AND project_id = $2::uuid
               FOR UPDATE NOWAIT;`,
              [input.cost_session_id, input.project_id]
            );
          } catch (lockErr) {
            if (lockErr instanceof PostgresQueryError && lockErr.sqlState === "55P03") {
              throw fallbackSentinel;
            }
            throw lockErr;
          }
          const sessRow2 = sessRes2.rows[0];
          if (!sessRow2) {
            throw fallbackSentinel;
          }
          const session2 = mapCostSessionRow(sessRow2);
          const targetPipelineId = input.pipeline_session_id ?? session2.pipeline_session_id;
          if (targetPipelineId) {
            const psCheck = await this.pool.queryInActiveTx(
              `SELECT 1 FROM product_pipeline_sessions
               WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
               LIMIT 1;`,
              [targetPipelineId, input.project_id]
            );
            if (psCheck.rowCount === 0) {
              throw fallbackSentinel;
            }
          }
          const targetTaskId = input.task_id ?? session2.task_id;
          if (targetTaskId) {
            const taskCheck = await this.pool.queryInActiveTx(
              `SELECT 1 FROM tasks
               WHERE task_id = $1::uuid AND project_id = $2::uuid
               LIMIT 1;`,
              [targetTaskId, input.project_id]
            );
            if (taskCheck.rowCount === 0) {
              throw fallbackSentinel;
            }
          }
          const violation2 = evaluatePreflightLimits(session2, input);
          if (!violation2) {
            return { allowed: true, session: session2 };
          }
          return await insertBlockedPreflight(session2, violation2);
        });
      } catch (autoErr) {
        if (autoErr === fallbackSentinel) {
          return await runLockedInCurrentTx(true);
        }
        throw autoErr;
      }
    } catch (error) {
      mapPgError(error);
    }
  }

  public async finalizeModelCallLedger(
    input: FinalizeModelCallInput
  ): Promise<FinalizeModelCallResult> {
    if (
      !Number.isSafeInteger(input.estimated_input_tokens) ||
      input.estimated_input_tokens < 0 ||
      !Number.isSafeInteger(input.reserved_output_tokens) ||
      input.reserved_output_tokens < 0 ||
      !Number.isSafeInteger(input.actual_input_tokens) ||
      input.actual_input_tokens < 0 ||
      !Number.isSafeInteger(input.actual_output_tokens) ||
      input.actual_output_tokens < 0 ||
      !Number.isSafeInteger(input.estimated_cost_micro_usd) ||
      input.estimated_cost_micro_usd < 0 ||
      !Number.isSafeInteger(input.actual_cost_micro_usd) ||
      input.actual_cost_micro_usd < 0
    ) {
      throw new PostgresRlsError(
        "23514",
        "Model call token and cost quantities must be non-negative safe integers"
      );
    }
    const actualTotalTokens = input.actual_input_tokens + input.actual_output_tokens;
    if (!Number.isSafeInteger(actualTotalTokens)) {
      throw new RangeError("actual_total_tokens exceeds JavaScript safe integer range");
    }

    const executeLockedFinalize = async (useNoWait: boolean): Promise<FinalizeModelCallResult> => {
      const lockClause = useNoWait ? "FOR UPDATE NOWAIT" : "FOR UPDATE";
      const scopeProbe = await this.pool.queryInActiveTx("SELECT task_id FROM model_cost_sessions WHERE cost_session_id = $1::uuid AND project_id = $2::uuid;", [input.cost_session_id, input.project_id]);
      const budgetTaskId = input.task_id ?? (scopeProbe.rows[0]?.task_id ? String(scopeProbe.rows[0].task_id) : null);
      // Canonical lock order: project_budget_policies -> task_budget_policies -> model_cost_sessions
      await this.pool.queryInActiveTx(
        `SELECT 1 FROM project_budget_policies
         WHERE project_id = $1::uuid
         ${lockClause};`,
        [input.project_id]
      );
      if (budgetTaskId) {
        await this.pool.queryInActiveTx(
          `SELECT 1 FROM task_budget_policies
           WHERE project_id = $1::uuid AND task_id = $2::uuid
           ${lockClause};`,
          [input.project_id, budgetTaskId]
        );
      }
      const sessRes = await this.pool.queryInActiveTx(
        `SELECT * FROM model_cost_sessions
         WHERE cost_session_id = $1::uuid AND project_id = $2::uuid
         ${lockClause};`,
        [input.cost_session_id, input.project_id]
      );
      const sessRow = sessRes.rows[0];
      if (!sessRow) {
        throw new PostgresRlsError(
          "23503",
          `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
        );
      }
      const session = mapCostSessionRow(sessRow);
      const resolvedTaskId = input.task_id ?? session.task_id;
      if (resolvedTaskId && !input.task_id) {
        await this.pool.queryInActiveTx(
          `SELECT 1 FROM task_budget_policies
           WHERE project_id = $1::uuid AND task_id = $2::uuid
           ${lockClause};`,
          [input.project_id, resolvedTaskId]
        );
      }
      const evalRes = evaluatePostcallLimits(
        session,
        actualTotalTokens,
        input.actual_cost_micro_usd
      );

      let updatedSession = session;
      if (session.status === "ACTIVE") {
        const updRes = await this.pool.queryInActiveTx(
          `UPDATE model_cost_sessions
           SET tokens_used_total = $1::bigint,
               cost_used_micro_usd = $2::bigint,
               status = $3::text,
               updated_at = clock_timestamp()
           WHERE cost_session_id = $4::uuid AND project_id = $5::uuid
           RETURNING *;`,
          [
            evalRes.nextTokensUsedTotal,
            evalRes.nextCostUsedMicroUsd,
            evalRes.nextStatus,
            input.cost_session_id,
            input.project_id,
          ]
        );
        updatedSession = mapCostSessionRow(updRes.rows[0]!);
      }

      const status: ModelCallStatus = evalRes.exceeded ? "BLOCKED_POSTCALL" : input.outcome;
      const blockReason = evalRes.exceeded
        ? `${evalRes.exceeded.limitScope}: ${evalRes.exceeded.reason}`
        : null;
      const errorMessage = evalRes.exceeded
        ? input.error_message && input.outcome !== "ALLOWED"
          ? `${evalRes.exceeded.reason}; upstream error: ${input.error_message}`
          : evalRes.exceeded.reason
        : input.error_message ?? null;
      const callId = randomUUID();

      const ledgerRes = await this.pool.queryInActiveTx(
        `INSERT INTO model_call_ledgers (
          call_id, project_id, cost_session_id, pipeline_session_id, task_id,
          stage, provider, model, prompt_id, prompt_version, prompt_sha256, request_sha256,
          estimated_input_tokens, reserved_output_tokens,
          actual_input_tokens, actual_output_tokens, actual_total_tokens,
          estimated_cost_micro_usd, actual_cost_micro_usd,
          status, usage_estimated, block_reason, error_message, latency_ms
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
          $6::text, $7::text, $8::text, $9::text, $10::text, $11::char(64), $12::char(64),
          $13::integer, $14::integer,
          $15::integer, $16::integer, $17::integer,
          $18::bigint, $19::bigint,
          $20::text, $21::boolean, $22::text, $23::text, $24::integer
        ) RETURNING *;`,
        [
          callId,
          input.project_id,
          input.cost_session_id,
          input.pipeline_session_id ?? session.pipeline_session_id,
          resolvedTaskId,
          input.stage,
          input.provider,
          input.model,
          input.prompt_id,
          input.prompt_version,
          input.prompt_sha256,
          input.request_sha256,
          input.estimated_input_tokens,
          input.reserved_output_tokens,
          input.actual_input_tokens,
          input.actual_output_tokens,
          actualTotalTokens,
          input.estimated_cost_micro_usd,
          input.actual_cost_micro_usd,
          status,
          Boolean(input.usage_estimated),
          blockReason,
          errorMessage,
          Math.max(0, Math.trunc(input.latency_ms)),
        ]
      );
      const ledger = mapModelCallLedgerRow(ledgerRes.rows[0]!);
      await this.evaluatePostSpendBudgetPauseSql({
        project_id: input.project_id,
        task_id: resolvedTaskId,
      });
      return {
        allowed: !evalRes.exceeded,
        ...(evalRes.exceeded
          ? { limitScope: evalRes.exceeded.limitScope, reason: evalRes.exceeded.reason }
          : {}),
        session: updatedSession,
        ledger,
      };
    };

    const runInCurrentTx = async (): Promise<FinalizeModelCallResult> => {
      try {
        return await executeLockedFinalize(false);
      } catch (error) {
        mapPgError(error);
      }
    };

    const active = this.pool.getActiveTxSession();
    if (!active) {
      return this.withRlsTransaction(
        {
          currentProjectId: input.project_id,
          currentPrincipalId: "core_api_service",
          currentRole: "core_api_service",
        },
        runInCurrentTx
      );
    }

    // M6A-FU-03: Probe without FOR UPDATE first inside outer TX. ALLOWED calls run in TX_outer
    // so they commit/rollback atomically with domain state (M6A-FU-02), whereas BLOCKED_POSTCALL /
    // FAILED_* / EXHAUSTED writes use an autonomous TX with FOR UPDATE NOWAIT and parent FK checks.
    const fallbackSentinel = new Error("AUTONOMOUS_TX_FALLBACK");
    try {
      const probeRes = await this.pool.queryInActiveTx(
        `SELECT * FROM model_cost_sessions
         WHERE cost_session_id = $1::uuid AND project_id = $2::uuid;`,
        [input.cost_session_id, input.project_id]
      );
      const probeRow = probeRes.rows[0];
      if (!probeRow) {
        throw new PostgresRlsError(
          "23503",
          `Cost session ${input.cost_session_id} not found for project ${input.project_id}`
        );
      }
      const probeSession = mapCostSessionRow(probeRow);
      const probeEval = evaluatePostcallLimits(
        probeSession,
        actualTotalTokens,
        input.actual_cost_micro_usd
      );
      if (!probeEval.exceeded && input.outcome === "ALLOWED") {
        return await runInCurrentTx();
      }

      try {
        return await this.pool.runAutonomousRlsTransaction(active, async () => {
          const sessCheck = await this.pool.queryInActiveTx(
            `SELECT * FROM model_cost_sessions
             WHERE cost_session_id = $1::uuid AND project_id = $2::uuid
             LIMIT 1;`,
            [input.cost_session_id, input.project_id]
          );
          const sessRow2 = sessCheck.rows[0];
          if (!sessRow2) {
            throw fallbackSentinel;
          }
          const session2 = mapCostSessionRow(sessRow2);
          const targetPipelineId = input.pipeline_session_id ?? session2.pipeline_session_id;
          if (targetPipelineId) {
            const psCheck = await this.pool.queryInActiveTx(
              `SELECT 1 FROM product_pipeline_sessions
               WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
               LIMIT 1;`,
              [targetPipelineId, input.project_id]
            );
            if (psCheck.rowCount === 0) {
              throw fallbackSentinel;
            }
          }
          const targetTaskId = input.task_id ?? session2.task_id;
          if (targetTaskId) {
            const taskCheck = await this.pool.queryInActiveTx(
              `SELECT 1 FROM tasks
               WHERE task_id = $1::uuid AND project_id = $2::uuid
               LIMIT 1;`,
              [targetTaskId, input.project_id]
            );
            if (taskCheck.rowCount === 0) {
              throw fallbackSentinel;
            }
          }
          try {
            return await executeLockedFinalize(true);
          } catch (lockErr) {
            if (lockErr instanceof PostgresQueryError && lockErr.sqlState === "55P03") {
              throw fallbackSentinel;
            }
            throw lockErr;
          }
        });
      } catch (autoErr) {
        if (autoErr === fallbackSentinel) {
          return await runInCurrentTx();
        }
        throw autoErr;
      }
    } catch (error) {
      mapPgError(error);
    }
  }

  public async createProductPipelineSession(
    input: CreateProductPipelineSessionInput
  ): Promise<ProductPipelineSessionRecord> {
    try {
      const pipelineSessionId = input.pipeline_session_id ?? randomUUID();
      const res = await this.pool.queryInActiveTx(
        `INSERT INTO product_pipeline_sessions (
          pipeline_session_id, project_id, cost_session_id,
          title, raw_idea_text, current_stage, status, created_by_principal_id
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid,
          $4::text, $5::text, 'STAGE_1_IDEA_DISCOVERY', 'ACTIVE', $6::text
        ) RETURNING *;`,
        [
          pipelineSessionId,
          input.project_id,
          input.cost_session_id ?? null,
          input.title,
          input.raw_idea_text,
          input.created_by_principal_id,
        ]
      );
      return mapProductPipelineSessionRow(res.rows[0]!);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async getProductPipelineSession(
    pipelineSessionId: string
  ): Promise<ProductPipelineSessionRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM product_pipeline_sessions WHERE pipeline_session_id = $1::uuid LIMIT 1;",
      [pipelineSessionId]
    );
    return res.rows[0] ? mapProductPipelineSessionRow(res.rows[0]) : null;
  }

  public async listProductPipelineSessions(): Promise<ProductPipelineSessionRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM product_pipeline_sessions ORDER BY created_at ASC;"
    );
    return res.rows.map(mapProductPipelineSessionRow);
  }

  public async updateProductPipelineSessionCostSession(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly cost_session_id: string;
  }): Promise<ProductPipelineSessionRecord> {
    try {
      const res = await this.pool.queryInActiveTx(
        `UPDATE product_pipeline_sessions
         SET cost_session_id = $1::uuid,
             updated_at = clock_timestamp()
         WHERE pipeline_session_id = $2::uuid AND project_id = $3::uuid
         RETURNING *;`,
        [input.cost_session_id, input.pipeline_session_id, input.project_id]
      );
      if (!res.rows[0]) {
        throw new PostgresRlsError(
          "23503",
          `Pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      return mapProductPipelineSessionRow(res.rows[0]);
    } catch (error) {
      mapPgError(error);
    }
  }

  public async createStage1DiscoveryItems(
    input: CreateStage1DiscoveryItemsInput
  ): Promise<Stage1DiscoveryItemRecord[]> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const sessRes = await this.pool.queryInActiveTx(
            `SELECT status FROM product_pipeline_sessions
             WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.pipeline_session_id, input.project_id]
          );
          const sessRow = sessRes.rows[0];
          if (!sessRow) {
            throw new PostgresRlsError(
              "23503",
              `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
            );
          }
          if (String(sessRow.status) !== "ACTIVE") {
            throw new PostgresRlsError(
              "23514",
              `Session ${input.pipeline_session_id} is ${String(sessRow.status)}; stage1_discovery_items cannot be added or modified after baseline freeze`
            );
          }

          const normalizedItems = input.items.map((raw) => ({
            raw,
            normalized: normalizeCreateStage1DiscoveryItem(raw),
          }));

          const inserted: Stage1DiscoveryItemRecord[] = [];
          for (const { raw, normalized } of normalizedItems) {
            const itemId = raw.item_id ?? randomUUID();
            const res = await this.pool.queryInActiveTx(
              `INSERT INTO stage1_discovery_items (
                item_id, project_id, pipeline_session_id, kind,
                title, statement, rationale, clarification_question, confirmation_status
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::text,
                $5::text, $6::text, $7::text, $8::text, $9::text
              ) RETURNING *;`,
              [
                itemId,
                input.project_id,
                input.pipeline_session_id,
                raw.kind,
                normalized.title,
                normalized.statement,
                raw.rationale,
                normalized.clarification_question,
                normalized.confirmation_status,
              ]
            );
            inserted.push(mapStage1DiscoveryItemRow(res.rows[0]!));
          }
          return inserted;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async resolveStage1DiscoveryItem(
    input: ResolveStage1DiscoveryItemInput
  ): Promise<Stage1DiscoveryItemRecord> {
    if (!input.actor_principal_id.trim()) {
      throw new PostgresRlsError("23514", "actor_principal_id is required to resolve Stage 1 item");
    }
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const existingRes = await this.pool.queryInActiveTx(
            `SELECT s.confirmation_status, p.status AS session_status
             FROM stage1_discovery_items s
             JOIN product_pipeline_sessions p
               ON p.pipeline_session_id = s.pipeline_session_id
              AND p.project_id = s.project_id
             WHERE s.item_id = $1::uuid
               AND s.pipeline_session_id = $2::uuid
               AND s.project_id = $3::uuid
             FOR UPDATE OF s;`,
            [input.item_id, input.pipeline_session_id, input.project_id]
          );
          const existingRow = existingRes.rows[0];
          if (!existingRow) {
            throw new PostgresRlsError(
              "23503",
              `Stage 1 discovery item ${input.item_id} not found in pipeline session ${input.pipeline_session_id}`
            );
          }
          const sessionStatus = String(existingRow.session_status);
          if (sessionStatus !== "ACTIVE") {
            throw new PostgresRlsError(
              "23514",
              `Session ${input.pipeline_session_id} is ${sessionStatus}; stage1_discovery_items cannot be modified after baseline freeze`
            );
          }
          const existingStatus = String(existingRow.confirmation_status);
          if (existingStatus !== "UNCONFIRMED") {
            throw new PostgresRlsError(
              "23514",
              `Stage 1 discovery item ${input.item_id} is already ${existingStatus} and cannot be re-resolved`
            );
          }

          const nextStatus = input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
          const res = await this.pool.queryInActiveTx(
            `UPDATE stage1_discovery_items
             SET confirmation_status = $1::text,
                 confirmed_by_principal_id = $2::text,
                 confirmed_at = clock_timestamp(),
                 resolution_note = COALESCE($3::text, resolution_note),
                 updated_at = clock_timestamp()
             WHERE item_id = $4::uuid
               AND pipeline_session_id = $5::uuid
               AND project_id = $6::uuid
               AND confirmation_status = 'UNCONFIRMED'
             RETURNING *;`,
            [
              nextStatus,
              input.actor_principal_id,
              input.resolution_note ?? null,
              input.item_id,
              input.pipeline_session_id,
              input.project_id,
            ]
          );
          if (!res.rows[0]) {
            throw new PostgresRlsError(
              "23514",
              `Stage 1 discovery item ${input.item_id} is no longer UNCONFIRMED and cannot be re-resolved`
            );
          }
          return mapStage1DiscoveryItemRow(res.rows[0]);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listStage1DiscoveryItems(
    pipelineSessionId: string
  ): Promise<Stage1DiscoveryItemRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM stage1_discovery_items WHERE pipeline_session_id = $1::uuid ORDER BY created_at ASC;",
      [pipelineSessionId]
    );
    return res.rows.map(mapStage1DiscoveryItemRow);
  }

  public async recordStageArtifact(
    input: RecordStageArtifactInput
  ): Promise<StageArtifactRecord> {
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.created_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const sessRes = await this.pool.queryInActiveTx(
            `SELECT status FROM product_pipeline_sessions
             WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.pipeline_session_id, input.project_id]
          );
          const sessRow = sessRes.rows[0];
          if (!sessRow) {
            throw new PostgresRlsError(
              "23503",
              `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
            );
          }
          if (String(sessRow.status) !== "ACTIVE") {
            throw new PostgresRlsError(
              "23514",
              `Session ${input.pipeline_session_id} is ${String(sessRow.status)}; new stage artifacts are forbidden after baseline freeze`
            );
          }

          const artifactSha = validateStageArtifactKindAndHash({
            stage: input.stage,
            artifact_kind: input.artifact_kind,
            content_json: input.content_json,
            artifact_sha256: input.artifact_sha256,
          });

          if (input.stage === "STAGE_2_REQUIREMENTS") {
            const items = await this.listStage1DiscoveryItems(input.pipeline_session_id);
            validateStage2Ac10References(input.content_json, items, input.pipeline_session_id);
          }

          const verRes = await this.pool.queryInActiveTx<{ next_version: number }>(
            `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
             FROM stage_artifacts
             WHERE pipeline_session_id = $1::uuid AND stage = $2::text;`,
            [input.pipeline_session_id, input.stage]
          );
          const nextVersion = Number(verRes.rows[0]?.next_version ?? 1);
          const artifactId = input.artifact_id ?? randomUUID();

          const insRes = await this.pool.queryInActiveTx(
            `INSERT INTO stage_artifacts (
              artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version,
              provider, model, prompt_id, prompt_version, prompt_sha256,
              content_json, artifact_sha256, created_by_principal_id
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer,
              $7::text, $8::text, $9::text, $10::text, $11::char(64),
              $12::jsonb, $13::char(64), $14::text
            ) RETURNING *;`,
            [
              artifactId,
              input.project_id,
              input.pipeline_session_id,
              input.stage,
              input.artifact_kind,
              nextVersion,
              input.provider,
              input.model,
              input.prompt_id,
              input.prompt_version,
              input.prompt_sha256,
              input.content_json,
              artifactSha,
              input.created_by_principal_id,
            ]
          );

          if (input.advance_session_stage) {
            await this.pool.queryInActiveTx(
              `UPDATE product_pipeline_sessions
               SET current_stage = $1::text, updated_at = clock_timestamp()
               WHERE pipeline_session_id = $2::uuid AND project_id = $3::uuid;`,
              [input.advance_session_stage, input.pipeline_session_id, input.project_id]
            );
          }

          return mapStageArtifactRow(insRes.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listStageArtifacts(pipelineSessionId: string): Promise<StageArtifactRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM stage_artifacts WHERE pipeline_session_id = $1::uuid ORDER BY created_at ASC, version ASC;",
      [pipelineSessionId]
    );
    return res.rows.map(mapStageArtifactRow);
  }

  public async getStageArtifactById(artifactId: string): Promise<StageArtifactRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM stage_artifacts WHERE artifact_id = $1::uuid LIMIT 1;",
      [artifactId]
    );
    return res.rows[0] ? mapStageArtifactRow(res.rows[0]) : null;
  }

  public async recordStageApprovalGate(
    input: RecordStageApprovalGateInput
  ): Promise<StageApprovalGateRecord> {
    if (!input.approver_principal_id.trim()) {
      throw new PostgresRlsError("23514", "approver_principal_id must be non-empty");
    }
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.approver_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const sessRes = await this.pool.queryInActiveTx(
            `SELECT status FROM product_pipeline_sessions
             WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.pipeline_session_id, input.project_id]
          );
          const sessRow = sessRes.rows[0];
          if (!sessRow) {
            throw new PostgresRlsError(
              "23503",
              `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
            );
          }
          if (String(sessRow.status) !== "ACTIVE") {
            throw new PostgresRlsError(
              "23514",
              `Session ${input.pipeline_session_id} is ${String(sessRow.status)}; new stage approval gates are forbidden after baseline freeze`
            );
          }
          const gateId = input.gate_id ?? randomUUID();
          const res = await this.pool.queryInActiveTx(
            `INSERT INTO stage_approval_gates (
              gate_id, project_id, pipeline_session_id, gate_stage,
              target_artifact_id, target_artifact_sha256,
              approver_principal_id, decision, rationale
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::text,
              $5::uuid, $6::char(64),
              $7::text, $8::text, $9::text
            ) RETURNING *;`,
            [
              gateId,
              input.project_id,
              input.pipeline_session_id,
              input.gate_stage,
              input.target_artifact_id,
              input.target_artifact_sha256,
              input.approver_principal_id,
              input.decision,
              input.rationale ?? null,
            ]
          );
          return mapStageApprovalGateRow(res.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listStageApprovalGates(
    pipelineSessionId: string
  ): Promise<StageApprovalGateRecord[]> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM stage_approval_gates WHERE pipeline_session_id = $1::uuid ORDER BY decided_at ASC;",
      [pipelineSessionId]
    );
    return res.rows.map(mapStageApprovalGateRow);
  }

  public async freezeBaselineSpec(
    input: FreezeBaselineSpecInput
  ): Promise<BaselineSpecFreezeRecord> {
    if (!input.frozen_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "frozen_by_principal_id must be non-empty");
    }
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.frozen_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const sessRes = await this.pool.queryInActiveTx(
            `SELECT * FROM product_pipeline_sessions
             WHERE pipeline_session_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.pipeline_session_id, input.project_id]
          );
          const session = sessRes.rows[0] ? mapProductPipelineSessionRow(sessRes.rows[0]) : null;

          const s1Res = await this.pool.queryInActiveTx(
            "SELECT * FROM stage_artifacts WHERE artifact_id = $1::uuid LIMIT 1;",
            [input.stage1_artifact_id]
          );
          const s2Res = await this.pool.queryInActiveTx(
            "SELECT * FROM stage_artifacts WHERE artifact_id = $1::uuid LIMIT 1;",
            [input.stage2_artifact_id]
          );
          const s3Res = await this.pool.queryInActiveTx(
            "SELECT * FROM stage_artifacts WHERE artifact_id = $1::uuid LIMIT 1;",
            [input.stage3_artifact_id]
          );
          const s4Res = await this.pool.queryInActiveTx(
            "SELECT * FROM stage_artifacts WHERE artifact_id = $1::uuid LIMIT 1;",
            [input.validation_report_artifact_id]
          );
          const latestS4Res = await this.pool.queryInActiveTx(
            `SELECT * FROM stage_artifacts
             WHERE project_id = $1::uuid
               AND pipeline_session_id = $2::uuid
               AND stage = 'STAGE_4_SPEC_FREEZE'
             ORDER BY version DESC
             LIMIT 1;`,
            [input.project_id, input.pipeline_session_id]
          );
          const stage1Items = await this.listStage1DiscoveryItems(input.pipeline_session_id);
          const gateRes = await this.pool.queryInActiveTx(
            "SELECT * FROM stage_approval_gates WHERE gate_id = $1::uuid LIMIT 1;",
            [input.approval_gate_id]
          );
          const existingRes = await this.pool.queryInActiveTx(
            "SELECT * FROM baseline_spec_freezes WHERE pipeline_session_id = $1::uuid LIMIT 1;",
            [input.pipeline_session_id]
          );

          validateFreezeBaselineSpecInvariants({
            request: input,
            session,
            stage1Artifact: s1Res.rows[0] ? mapStageArtifactRow(s1Res.rows[0]) : null,
            stage2Artifact: s2Res.rows[0] ? mapStageArtifactRow(s2Res.rows[0]) : null,
            stage3Artifact: s3Res.rows[0] ? mapStageArtifactRow(s3Res.rows[0]) : null,
            validationReportArtifact: s4Res.rows[0] ? mapStageArtifactRow(s4Res.rows[0]) : null,
            latestStage4Artifact: latestS4Res.rows[0]
              ? mapStageArtifactRow(latestS4Res.rows[0])
              : null,
            stage1Items,
            approvalGate: gateRes.rows[0] ? mapStageApprovalGateRow(gateRes.rows[0]) : null,
            existingFreeze: existingRes.rows[0] ? mapBaselineSpecFreezeRow(existingRes.rows[0]) : null,
          });

          const baselineId = input.baseline_id ?? randomUUID();
          const freezeBundleSha = computeBaselineFreezeBundleSha256(input);

          const insRes = await this.pool.queryInActiveTx(
            `INSERT INTO baseline_spec_freezes (
              baseline_id, project_id, pipeline_session_id,
              stage1_artifact_id, stage1_artifact_sha256,
              stage2_artifact_id, stage2_artifact_sha256,
              stage3_artifact_id, stage3_artifact_sha256,
              validation_report_artifact_id, validation_report_sha256,
              approval_gate_id, frozen_by_principal_id, freeze_bundle_sha256, status
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid,
              $4::uuid, $5::char(64),
              $6::uuid, $7::char(64),
              $8::uuid, $9::char(64),
              $10::uuid, $11::char(64),
              $12::uuid, $13::text, $14::char(64), 'FROZEN'
            ) RETURNING *;`,
            [
              baselineId,
              input.project_id,
              input.pipeline_session_id,
              input.stage1_artifact_id,
              input.stage1_artifact_sha256,
              input.stage2_artifact_id,
              input.stage2_artifact_sha256,
              input.stage3_artifact_id,
              input.stage3_artifact_sha256,
              input.validation_report_artifact_id,
              input.validation_report_sha256,
              input.approval_gate_id,
              input.frozen_by_principal_id,
              freezeBundleSha,
            ]
          );

          await this.pool.queryInActiveTx(
            `UPDATE product_pipeline_sessions
             SET status = 'FROZEN',
                 frozen_baseline_id = $1::uuid,
                 current_stage = 'STAGE_4_SPEC_FREEZE',
                 updated_at = clock_timestamp()
             WHERE pipeline_session_id = $2::uuid AND project_id = $3::uuid;`,
            [baselineId, input.pipeline_session_id, input.project_id]
          );

          await this.insertOutboxEventSql(
            input.project_id,
            "product_pipeline",
            input.pipeline_session_id,
            "pipeline.baseline_frozen",
            {
              pipeline_session_id: input.pipeline_session_id,
              baseline_id: baselineId,
              freeze_bundle_sha256: freezeBundleSha,
              frozen_by_principal_id: input.frozen_by_principal_id,
            }
          );

          return mapBaselineSpecFreezeRow(insRes.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async getBaselineSpecFreeze(
    pipelineSessionId: string
  ): Promise<BaselineSpecFreezeRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM baseline_spec_freezes WHERE pipeline_session_id = $1::uuid LIMIT 1;",
      [pipelineSessionId]
    );
    return res.rows[0] ? mapBaselineSpecFreezeRow(res.rows[0]) : null;
  }

  public async getProductPipelineBundle(
    pipelineSessionId: string
  ): Promise<ProductPipelineBundle | null> {
    const session = await this.getProductPipelineSession(pipelineSessionId);
    if (!session) {
      return null;
    }
    const costSession = session.cost_session_id
      ? await this.getCostSession(session.cost_session_id)
      : null;
    const modelCallLedgers = await this.listModelCallLedgers({
      pipeline_session_id: pipelineSessionId,
    });
    const discoveryItems = await this.listStage1DiscoveryItems(pipelineSessionId);
    const artifacts = await this.listStageArtifacts(pipelineSessionId);
    const approvalGates = await this.listStageApprovalGates(pipelineSessionId);
    const baselineFreeze = await this.getBaselineSpecFreeze(pipelineSessionId);

    return buildProductPipelineBundle({
      session,
      costSession,
      modelCallLedgers,
      discoveryItems,
      artifacts,
      approvalGates,
      baselineFreeze,
    });
  }

  // ===========================================================================
  // Milestone M6B: Stages 5-9 Lifecycle, Multi-Target Profiles, CR & Release
  // ===========================================================================

  public async updateProjectMainRefCommitHash(input: {
    readonly project_id: string;
    readonly main_ref_commit_hash: string;
  }): Promise<ProjectRecord> {
    if (!/^[0-9a-f]{40}$/i.test(input.main_ref_commit_hash.trim())) {
      throw new PostgresRlsError(
        "23514",
        `main_ref_commit_hash '${input.main_ref_commit_hash}' must be a 40-hex commit hash`
      );
    }
    const normalizedHash = input.main_ref_commit_hash.trim().toLowerCase();
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const res = await this.pool.queryInActiveTx(
            `UPDATE projects
             SET main_ref_commit_hash = $1::char(40),
                 updated_at = clock_timestamp()
             WHERE project_id = $2::uuid
             RETURNING *;`,
            [normalizedHash, input.project_id]
          );
          if (res.rowCount === 0 || !res.rows[0]) {
            throw new PostgresRlsError(
              "23503",
              `Project ${input.project_id} not found or inaccessible under current RLS context`
            );
          }
          let refs = this.fallbackGitRefsByProject.get(input.project_id);
          if (!refs) {
            refs = new Map();
            this.fallbackGitRefsByProject.set(input.project_id, refs);
          }
          refs.set("refs/heads/main", normalizedHash);
          let commits = this.fallbackGitCommitsByProject.get(input.project_id);
          if (!commits) {
            commits = new Map();
            this.fallbackGitCommitsByProject.set(input.project_id, commits);
          }
          if (!commits.has(normalizedHash)) {
            commits.set(normalizedHash, {
              commitHash: normalizedHash,
              treeHash: normalizedHash,
              parents: [],
            });
          }
          return mapProjectRow(res.rows[0]);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async createProjectBootstrap(
    input: CreateProjectBootstrapInput
  ): Promise<ProjectBootstrapRecord> {
    validateProjectBootstrapInput(input);
    const bootstrapId = input.bootstrap_id ?? randomUUID();
    const normalizedHash = input.base_main_commit_hash.toLowerCase();
    const normalizedPolicySha = input.trusted_policy_sha256.toLowerCase();
    const normalizedSpecs = serializeTrustedAcceptanceTestSpecs(input.acceptance_tests);
    const bootstrapSha = computeProjectBootstrapSha256({
      ...input,
      base_main_commit_hash: normalizedHash,
      trusted_policy_sha256: normalizedPolicySha,
      acceptance_tests: normalizedSpecs,
    });
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.created_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const dupBaseline = await this.pool.queryInActiveTx(
            `SELECT 1 FROM project_bootstraps
             WHERE project_id = $1::uuid AND baseline_id = $2::uuid
             LIMIT 1;`,
            [input.project_id, input.baseline_id]
          );
          if (dupBaseline.rowCount > 0) {
            throw new PostgresRlsError(
              "23505",
              `Project bootstrap already exists for project ${input.project_id} and baseline ${input.baseline_id}`
            );
          }
          const insRes = await this.pool.queryInActiveTx(
            `INSERT INTO project_bootstraps (
              bootstrap_id, project_id, pipeline_session_id, baseline_id,
              repo_path, trusted_acceptance_dir, base_main_commit_hash,
              protected_paths_json, trusted_policy_sha256,
              generated_files_json, acceptance_tests_json,
              bootstrap_sha256, created_by_principal_id
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              $5::text, $6::text, $7::char(40),
              $8::jsonb, $9::char(64),
              $10::jsonb, $11::jsonb,
              $12::char(64), $13::text
            ) RETURNING *;`,
            [
              bootstrapId,
              input.project_id,
              input.pipeline_session_id,
              input.baseline_id,
              input.repo_path,
              input.trusted_acceptance_dir,
              normalizedHash,
              [...input.protected_paths],
              normalizedPolicySha,
              [...input.generated_files],
              normalizedSpecs,
              bootstrapSha,
              input.created_by_principal_id,
            ]
          );
          await this.insertOutboxEventSql(
            input.project_id,
            "project_bootstrap",
            bootstrapId,
            "pipeline.project_bootstrapped",
            {
              pipeline_session_id: input.pipeline_session_id,
              baseline_id: input.baseline_id,
              bootstrap_id: bootstrapId,
              base_main_commit_hash: normalizedHash,
              trusted_policy_sha256: normalizedPolicySha,
            }
          );
          return mapProjectBootstrapRow(insRes.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async getProjectBootstrapBySession(
    pipelineSessionId: string
  ): Promise<ProjectBootstrapRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM project_bootstraps WHERE pipeline_session_id = $1::uuid ORDER BY created_at DESC LIMIT 1;",
      [pipelineSessionId]
    );
    return res.rows[0] ? mapProjectBootstrapRow(res.rows[0]) : null;
  }

  public async getProjectBootstrapById(
    bootstrapId: string
  ): Promise<ProjectBootstrapRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM project_bootstraps WHERE bootstrap_id = $1::uuid LIMIT 1;",
      [bootstrapId]
    );
    return res.rows[0] ? mapProjectBootstrapRow(res.rows[0]) : null;
  }

  public async upsertAgentOrganizationProfile(
    input: UpsertAgentOrganizationProfileInput
  ): Promise<AgentOrganizationProfileRecord> {
    validateAgentOrganizationProfileInput(input);
    const profileId = input.profile_id ?? randomUUID();
    const keyTrimmed = input.profile_key.trim();
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.created_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const res = await this.pool.queryInActiveTx(
            `INSERT INTO agent_organization_profiles (
              profile_id, project_id, profile_key, role, principal_id,
              provider, model, execution_target_type, trust_tier,
              target_locator, capabilities_json, is_active, created_by_principal_id
            ) VALUES (
              $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
              $6::text, $7::text, $8::text, $9::text,
              $10::text, $11::jsonb, $12::boolean, $13::text
            )
            ON CONFLICT (project_id, profile_key) DO UPDATE SET
              role = EXCLUDED.role,
              principal_id = EXCLUDED.principal_id,
              provider = EXCLUDED.provider,
              model = EXCLUDED.model,
              execution_target_type = EXCLUDED.execution_target_type,
              trust_tier = EXCLUDED.trust_tier,
              target_locator = EXCLUDED.target_locator,
              capabilities_json = EXCLUDED.capabilities_json,
              is_active = EXCLUDED.is_active,
              updated_at = clock_timestamp()
            RETURNING *;`,
            [
              profileId,
              input.project_id,
              keyTrimmed,
              input.role,
              input.principal_id.trim(),
              input.provider.trim(),
              input.model.trim(),
              input.execution_target_type,
              input.trust_tier,
              input.target_locator ?? null,
              input.capabilities_json ?? {},
              input.is_active ?? true,
              input.created_by_principal_id.trim(),
            ]
          );
          return mapAgentOrganizationProfileRow(res.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listAgentOrganizationProfiles(
    projectId: string,
    filter?: { readonly role?: AgentOrgRole; readonly active_only?: boolean }
  ): Promise<AgentOrganizationProfileRecord[]> {
    const clauses = ["project_id = $1::uuid"];
    const params: unknown[] = [projectId];
    if (filter?.role) {
      params.push(filter.role);
      clauses.push(`role = $${params.length}::text`);
    }
    if (filter?.active_only) {
      clauses.push("is_active = TRUE");
    }
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM agent_organization_profiles
       WHERE ${clauses.join(" AND ")}
       ORDER BY profile_key ASC;`,
      params
    );
    return res.rows.map(mapAgentOrganizationProfileRow);
  }

  public async getAgentOrganizationProfileById(
    profileId: string
  ): Promise<AgentOrganizationProfileRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM agent_organization_profiles WHERE profile_id = $1::uuid LIMIT 1;",
      [profileId]
    );
    return res.rows[0] ? mapAgentOrganizationProfileRow(res.rows[0]) : null;
  }

  public async createStage7DevelopmentPlan(
    input: CreateStage7DevelopmentPlanInput
  ): Promise<Stage7DevelopmentPlanBundle> {
    if (!/^[0-9a-f]{40}$/i.test(input.base_main_commit_hash)) {
      throw new PostgresRlsError(
        "23514",
        `base_main_commit_hash '${input.base_main_commit_hash}' must be a 40-hex commit hash`
      );
    }
    if (
      input.milestones.length === 0 ||
      input.epics.length === 0 ||
      input.stories.length === 0 ||
      input.tasks.length === 0
    ) {
      throw new PostgresRlsError(
        "23514",
        "Stage 7 development plan requires >= 1 milestone, epic, story, and task"
      );
    }
    const normalizedBaseMain = input.base_main_commit_hash.toLowerCase();
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: "core_api_service",
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const existingPlan = await this.pool.queryInActiveTx(
            "SELECT 1 FROM dev_milestones WHERE project_id = $1::uuid AND baseline_id = $2::uuid LIMIT 1;",
            [input.project_id, input.baseline_id]
          );
          if (existingPlan.rowCount > 0) {
            throw new PostgresRlsError(
              "23514",
              `Stage 7 development plan already exists for frozen baseline ${input.baseline_id}; submit a Stage 9 Change Request to add or modify tasks`
            );
          }

          const bootRes = await this.pool.queryInActiveTx(
            `SELECT bootstrap_id, baseline_id FROM project_bootstraps
             WHERE bootstrap_id = $1::uuid AND project_id = $2::uuid LIMIT 1;`,
            [input.bootstrap_id, input.project_id]
          );
          if (
            !bootRes.rows[0] ||
            String(bootRes.rows[0].baseline_id) !== input.baseline_id
          ) {
            throw new PostgresRlsError(
              "23514",
              `Bootstrap ${input.bootstrap_id} does not match baseline ${input.baseline_id}`
            );
          }

          const milestones: DevMilestoneRecord[] = [];
          const milestoneIdByKey = new Map<string, string>();
          for (const m of input.milestones) {
            const milestoneId = m.milestone_id ?? randomUUID();
            const res = await this.pool.queryInActiveTx(
              `INSERT INTO dev_milestones (
                milestone_id, project_id, pipeline_session_id, baseline_id,
                milestone_key, title, description, sequence_order
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                $5::text, $6::text, $7::text, $8::integer
              ) RETURNING *;`,
              [
                milestoneId,
                input.project_id,
                input.pipeline_session_id,
                input.baseline_id,
                m.milestone_key,
                m.title,
                m.description,
                m.sequence_order,
              ]
            );
            const mapped = mapDevMilestoneRow(res.rows[0]!);
            milestoneIdByKey.set(m.milestone_key, mapped.milestone_id);
            milestones.push(mapped);
          }

          const epics: DevEpicRecord[] = [];
          const epicIdByKey = new Map<string, string>();
          for (const e of input.epics) {
            const milestoneId = milestoneIdByKey.get(e.milestone_key);
            if (!milestoneId) {
              throw new PostgresRlsError("23503", `Milestone key '${e.milestone_key}' not found`);
            }
            const epicId = e.epic_id ?? randomUUID();
            const res = await this.pool.queryInActiveTx(
              `INSERT INTO dev_epics (
                epic_id, project_id, milestone_id,
                epic_key, title, description, sequence_order
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid,
                $4::text, $5::text, $6::text, $7::integer
              ) RETURNING *;`,
              [
                epicId,
                input.project_id,
                milestoneId,
                e.epic_key,
                e.title,
                e.description,
                e.sequence_order,
              ]
            );
            const mapped = mapDevEpicRow(res.rows[0]!);
            epicIdByKey.set(e.epic_key, mapped.epic_id);
            epics.push(mapped);
          }

          const stories: DevUserStoryRecord[] = [];
          const storyIdByKey = new Map<string, string>();
          for (const s of input.stories) {
            const epicId = epicIdByKey.get(s.epic_key);
            if (!epicId) {
              throw new PostgresRlsError("23503", `Epic key '${s.epic_key}' not found`);
            }
            const storyId = s.story_id ?? randomUUID();
            const res = await this.pool.queryInActiveTx(
              `INSERT INTO dev_user_stories (
                story_id, project_id, epic_id, story_key, title, description,
                requirement_ids_json, ac_ids_json, sequence_order
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
                $7::jsonb, $8::jsonb, $9::integer
              ) RETURNING *;`,
              [
                storyId,
                input.project_id,
                epicId,
                s.story_key,
                s.title,
                s.description,
                [...s.requirement_ids],
                [...s.ac_ids],
                s.sequence_order,
              ]
            );
            const mapped = mapDevUserStoryRow(res.rows[0]!);
            storyIdByKey.set(s.story_key, mapped.story_id);
            stories.push(mapped);
          }

          const tasks: TaskRecord[] = [];
          const taskLinks: TaskPlanLinkRecord[] = [];
          for (const t of input.tasks) {
            const storyId = storyIdByKey.get(t.story_key);
            if (!storyId) {
              throw new PostgresRlsError("23503", `Story key '${t.story_key}' not found`);
            }
            const taskRec = await this.createTask({
              task_id: t.task_id,
              project_id: input.project_id,
              title: t.title,
              task_contract: t.task_contract,
              base_main_commit_hash: normalizedBaseMain,
              max_rework_cycles: t.max_rework_cycles,
            });
            tasks.push(taskRec);
            const linkId = randomUUID();
            const linkRes = await this.pool.queryInActiveTx(
              `INSERT INTO task_plan_links (
                link_id, project_id, pipeline_session_id, baseline_id,
                bootstrap_id, story_id, task_id, cr_id,
                requirement_ids_json, ac_ids_json, assigned_profile_id
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                $5::uuid, $6::uuid, $7::uuid, NULL,
                $8::jsonb, $9::jsonb, $10::uuid
              ) RETURNING *;`,
              [
                linkId,
                input.project_id,
                input.pipeline_session_id,
                input.baseline_id,
                input.bootstrap_id,
                storyId,
                taskRec.task_id,
                [...t.requirement_ids],
                [...t.ac_ids],
                t.assigned_profile_id ?? null,
              ]
            );
            taskLinks.push(mapTaskPlanLinkRow(linkRes.rows[0]!));
          }

          await this.persistMaterializedDependenciesSql(input.project_id, input.tasks, tasks);

          await this.insertOutboxEventSql(
            input.project_id,
            "product_pipeline",
            input.pipeline_session_id,
            "pipeline.stage7_plan_materialized",
            {
              pipeline_session_id: input.pipeline_session_id,
              baseline_id: input.baseline_id,
              task_ids: tasks.map((t) => t.task_id),
            }
          );

          return { milestones, epics, stories, taskLinks, tasks };
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listDevMilestones(pipelineSessionId: string): Promise<DevMilestoneRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM dev_milestones
       WHERE pipeline_session_id = $1::uuid
       ORDER BY sequence_order ASC, created_at ASC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapDevMilestoneRow);
  }

  public async listDevEpics(pipelineSessionId: string): Promise<DevEpicRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT e.* FROM dev_epics e
       JOIN dev_milestones m ON m.milestone_id = e.milestone_id AND m.project_id = e.project_id
       WHERE m.pipeline_session_id = $1::uuid
       ORDER BY e.sequence_order ASC, e.created_at ASC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapDevEpicRow);
  }

  public async listDevUserStories(pipelineSessionId: string): Promise<DevUserStoryRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT s.* FROM dev_user_stories s
       JOIN dev_epics e ON e.epic_id = s.epic_id AND e.project_id = s.project_id
       JOIN dev_milestones m ON m.milestone_id = e.milestone_id AND m.project_id = e.project_id
       WHERE m.pipeline_session_id = $1::uuid
       ORDER BY s.sequence_order ASC, s.created_at ASC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapDevUserStoryRow);
  }

  public async listTaskPlanLinks(pipelineSessionId: string): Promise<TaskPlanLinkRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM task_plan_links
       WHERE pipeline_session_id = $1::uuid
       ORDER BY created_at ASC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapTaskPlanLinkRow);
  }

  public async listProjectTaskPlanLinks(): Promise<TaskPlanLinkRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM task_plan_links
       ORDER BY created_at ASC;`
    );
    return res.rows.map(mapTaskPlanLinkRow);
  }

  public async createChangeRequest(
    input: CreateChangeRequestStoreInput
  ): Promise<ChangeRequestRecord> {
    if (!input.cr_key.trim() || !input.title.trim() || !input.rationale.trim()) {
      throw new PostgresRlsError("23514", "cr_key, title, and rationale must be non-empty");
    }
    const crId = input.cr_id ?? randomUUID();
    const crSha = computeChangeRequestSha256(input);
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.requested_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const res = await this.pool.queryInActiveTx(
            `INSERT INTO change_requests (
              cr_id, project_id, pipeline_session_id, baseline_id,
              cr_key, title, rationale,
              impacted_requirement_ids_json, impacted_component_ids_json, proposed_tasks_json,
              status, requested_by_principal_id, cr_sha256
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              $5::text, $6::text, $7::text,
              $8::jsonb, $9::jsonb, $10::jsonb,
              'PENDING_APPROVAL', $11::text, $12::char(64)
            ) RETURNING *;`,
            [
              crId,
              input.project_id,
              input.pipeline_session_id,
              input.baseline_id,
              input.cr_key.trim(),
              input.title.trim(),
              input.rationale.trim(),
              [...input.impacted_requirement_ids],
              [...(input.impacted_component_ids ?? [])],
              [...input.proposed_tasks],
              input.requested_by_principal_id,
              crSha,
            ]
          );
          await this.insertOutboxEventSql(
            input.project_id,
            "change_request",
            crId,
            "change_request.submitted",
            {
              cr_id: crId,
              cr_key: input.cr_key.trim(),
              pipeline_session_id: input.pipeline_session_id,
              baseline_id: input.baseline_id,
              cr_sha256: crSha,
            }
          );
          return mapChangeRequestRow(res.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async getChangeRequestById(crId: string): Promise<ChangeRequestRecord | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT * FROM change_requests WHERE cr_id = $1::uuid LIMIT 1;",
      [crId]
    );
    return res.rows[0] ? mapChangeRequestRow(res.rows[0]) : null;
  }

  public async listChangeRequests(pipelineSessionId: string): Promise<ChangeRequestRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM change_requests
       WHERE pipeline_session_id = $1::uuid
       ORDER BY created_at DESC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapChangeRequestRow);
  }

  public async decideChangeRequest(
    input: DecideChangeRequestStoreInput
  ): Promise<ChangeRequestRecord> {
    if ((input.decision as string) !== "APPROVED" && (input.decision as string) !== "REJECTED") {
      throw new PostgresRlsError(
        "23514",
        `Change Request decision must be APPROVED or REJECTED, got '${String(input.decision)}'`
      );
    }
    if (!input.decided_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "decided_by_principal_id is required");
    }
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.decided_by_principal_id.trim(),
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const existingRes = await this.pool.queryInActiveTx(
            `SELECT * FROM change_requests
             WHERE cr_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.cr_id, input.project_id]
          );
          const row = existingRes.rows[0];
          if (!row) {
            throw new PostgresRlsError(
              "23503",
              `Change Request ${input.cr_id} not found for project ${input.project_id}`
            );
          }
          const existing = mapChangeRequestRow(row);
          if (existing.status !== "PENDING_APPROVAL") {
            throw new PostgresRlsError(
              "23514",
              `Change Request ${input.cr_id} is in status ${existing.status}; only PENDING_APPROVAL can be decided`
            );
          }
          const updRes = await this.pool.queryInActiveTx(
            `UPDATE change_requests
             SET status = $1::text,
                 decided_by_principal_id = $2::text,
                 decision_rationale = $3::text,
                 decided_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE cr_id = $4::uuid AND project_id = $5::uuid
             RETURNING *;`,
            [
              input.decision,
              input.decided_by_principal_id.trim(),
              input.decision_rationale ?? null,
              input.cr_id,
              input.project_id,
            ]
          );
          const mapped = mapChangeRequestRow(updRes.rows[0]!);
          await this.insertOutboxEventSql(
            input.project_id,
            "change_request",
            mapped.cr_id,
            `change_request.${input.decision.toLowerCase()}`,
            {
              cr_id: mapped.cr_id,
              cr_key: mapped.cr_key,
              decision: input.decision,
              decided_by_principal_id: mapped.decided_by_principal_id,
            }
          );
          return mapped;
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async applyChangeRequestAndMaterializeTasks(
    input: ApplyChangeRequestStoreInput
  ): Promise<{
    readonly changeRequest: ChangeRequestRecord;
    readonly tasks: readonly TaskRecord[];
    readonly taskLinks: readonly TaskPlanLinkRecord[];
  }> {
    if (!input.applied_by_principal_id.trim()) {
      throw new PostgresRlsError("23514", "applied_by_principal_id is required");
    }
    if (!/^[0-9a-f]{40}$/i.test(input.base_main_commit_hash)) {
      throw new PostgresRlsError(
        "23514",
        `base_main_commit_hash '${input.base_main_commit_hash}' must be a 40-hex commit hash`
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(input.trusted_policy_sha256)) {
      throw new PostgresRlsError(
        "23514",
        `trusted_policy_sha256 '${input.trusted_policy_sha256}' must be a 64-hex SHA-256`
      );
    }
    const normalizedBaseMain = input.base_main_commit_hash.toLowerCase();
    const normalizedPolicySha = input.trusted_policy_sha256.toLowerCase();
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.applied_by_principal_id.trim(),
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const crRes = await this.pool.queryInActiveTx(
            `SELECT * FROM change_requests
             WHERE cr_id = $1::uuid AND project_id = $2::uuid
             FOR UPDATE;`,
            [input.cr_id, input.project_id]
          );
          const row = crRes.rows[0];
          if (!row) {
            throw new PostgresRlsError(
              "23503",
              `Change Request ${input.cr_id} not found for project ${input.project_id}`
            );
          }
          const existing = mapChangeRequestRow(row);
          if (existing.status !== "APPROVED") {
            throw new PostgresRlsError(
              "23514",
              `Change Request ${input.cr_id} has status ${existing.status}; only APPROVED Change Requests can be applied`
            );
          }
          if (existing.proposed_tasks.length === 0) {
            throw new PostgresRlsError(
              "23514",
              `Change Request ${input.cr_id} has no proposed_tasks to materialize`
            );
          }

          const tasks: TaskRecord[] = [];
          const taskLinks: TaskPlanLinkRecord[] = [];
          for (const pt of existing.proposed_tasks) {
            const contract: TaskContractSpec = {
              allowed_files: [...pt.allowed_files],
              protected_paths: [...input.protected_paths],
              trusted_policy_sha256: normalizedPolicySha,
            };
            const taskRec = await this.createTask({
              project_id: input.project_id,
              title: pt.title,
              task_contract: contract,
              base_main_commit_hash: normalizedBaseMain,
            });
            tasks.push(taskRec);
            const linkRes = await this.pool.queryInActiveTx(
              `INSERT INTO task_plan_links (
                link_id, project_id, pipeline_session_id, baseline_id,
                bootstrap_id, story_id, task_id, cr_id,
                requirement_ids_json, ac_ids_json, assigned_profile_id
              ) VALUES (
                $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                $5::uuid, $6::uuid, $7::uuid, $8::uuid,
                $9::jsonb, $10::jsonb, $11::uuid
              ) RETURNING *;`,
              [
                randomUUID(),
                input.project_id,
                existing.pipeline_session_id,
                existing.baseline_id,
                input.bootstrap_id ?? null,
                pt.story_id ?? null,
                taskRec.task_id,
                existing.cr_id,
                [...pt.requirement_ids],
                [...pt.ac_ids],
                pt.developer_profile_id ?? null,
              ]
            );
            taskLinks.push(mapTaskPlanLinkRow(linkRes.rows[0]!));
          }

          await this.persistMaterializedDependenciesSql(input.project_id, existing.proposed_tasks, tasks);

          const updRes = await this.pool.queryInActiveTx(
            `UPDATE change_requests
             SET status = 'APPLIED',
                 applied_by_principal_id = $1::text,
                 applied_at = clock_timestamp(),
                 updated_at = clock_timestamp()
             WHERE cr_id = $2::uuid AND project_id = $3::uuid
             RETURNING *;`,
            [input.applied_by_principal_id.trim(), existing.cr_id, input.project_id]
          );
          const updated = mapChangeRequestRow(updRes.rows[0]!);
          await this.insertOutboxEventSql(
            input.project_id,
            "change_request",
            updated.cr_id,
            "change_request.applied",
            {
              cr_id: updated.cr_id,
              cr_key: updated.cr_key,
              materialized_task_ids: tasks.map((t) => t.task_id),
            }
          );

          return { changeRequest: updated, tasks, taskLinks };
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public assertOutsideTransaction(): void {
    if (this.pool.getActiveTxSession()) throw new PostgresRlsError("23514", "Production execution requires its own committed transaction");
  }

  public async createProductionDeploymentApproval(input: ProductionDeploymentApprovalRecord): Promise<ProductionDeploymentApprovalRecord> {
    const member = await this.getProjectMembership(input.project_id,input.approver_principal_id);
    if (input.approver_principal_id !== this.pool.getActiveTxSession()?.currentPrincipalId || !member || !["PROJECT_APPROVER","ORG_ADMIN"].includes(member.member_role)) throw new PostgresRlsError("42501", "Production approval requires the authenticated project approver");
    const release = (await this.listReleaseAcceptancePackages(input.pipeline_session_id)).find((r) => r.release_id === input.release_id) ?? null;
    validateProductionApproval(input,release,await this.clockTimestampIso());
    const columns = ["approval_id","project_id","pipeline_session_id","release_id","release_package_sha256","commit_hash","artifact_sha256","target_key","approver_principal_id","issued_at","expires_at","token_sha256","status"] as const;
    const result = await this.pool.queryInActiveTx(`INSERT INTO production_deployment_approvals(${columns.join(",")}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(",")}) RETURNING *;`,columns.map((c)=>input[c]));
    await this.insertOutboxEventSql(input.project_id,"production_deployment",input.approval_id,"deployment.approved",{approval_id:input.approval_id,release_id:input.release_id,target_key:input.target_key});
    return mapProductionApproval(result.rows[0]!);
  }
  public async getProductionDeploymentApproval(approvalId: string): Promise<ProductionDeploymentApprovalRecord | null> {
    const result = await this.pool.queryInActiveTx("SELECT * FROM production_deployment_approvals WHERE approval_id=$1::uuid;",[approvalId]);
    return result.rows[0] ? mapProductionApproval(result.rows[0]) : null;
  }
  public async getProductionDeploymentByApproval(approvalId: string): Promise<ProductionDeploymentRecord | null> {
    const result = await this.pool.queryInActiveTx("SELECT * FROM production_deployments WHERE approval_id=$1::uuid;",[approvalId]);
    return result.rows[0] ? mapProductionDeployment(result.rows[0]) : null;
  }
  public async revokeProductionDeploymentApproval(projectId: string,approvalId: string): Promise<void> {
    const result=await this.pool.queryInActiveTx("UPDATE production_deployment_approvals SET status='REVOKED' WHERE project_id=$1::uuid AND approval_id=$2::uuid AND status='ACTIVE' RETURNING approval_id;",[projectId,approvalId]);
    if (!result.rowCount) throw new PostgresRlsError("23514","Only active deployment approval can be revoked");
    await this.insertOutboxEventSql(projectId,"production_deployment",approvalId,"deployment.revoked",{approval_id:approvalId});
  }
  public async beginProductionDeployment(input: {project_id:string;approval_id:string;token_sha256:string;requested_by_principal_id:string}): Promise<{record:ProductionDeploymentRecord;created:boolean}> {
    const result=await this.pool.queryInActiveTx("SELECT * FROM production_deployment_approvals WHERE project_id=$1::uuid AND approval_id=$2::uuid FOR UPDATE;",[input.project_id,input.approval_id]);
    if (!result.rows[0]) throw new PostgresRlsError("42501","Invalid deployment approval token");
    const approval=mapProductionApproval(result.rows[0]);
    if (approval.token_sha256!==input.token_sha256 || input.requested_by_principal_id!==this.pool.getActiveTxSession()?.currentPrincipalId || !input.requested_by_principal_id.trim()) throw new PostgresRlsError("42501","Invalid deployment approval token");
    const existing=await this.pool.queryInActiveTx("SELECT * FROM production_deployments WHERE approval_id=$1::uuid;",[input.approval_id]);
    if(existing.rows[0])return{record:mapProductionDeployment(existing.rows[0]),created:false};
    if(approval.status!=="ACTIVE" || Date.parse(approval.expires_at)<=Date.parse(await this.clockTimestampIso()))throw new PostgresRlsError("42501","Deployment approval expired, revoked or consumed");
    const inserted=await this.pool.queryInActiveTx("INSERT INTO production_deployments(project_id,approval_id,target_key,requested_by_principal_id) VALUES($1::uuid,$2::uuid,$3,$4) RETURNING *;",[input.project_id,input.approval_id,approval.target_key,input.requested_by_principal_id]);
    const record=mapProductionDeployment(inserted.rows[0]!);
    await this.insertOutboxEventSql(input.project_id,"production_deployment",record.deployment_id,"deployment.started",{deployment_id:record.deployment_id,approval_id:input.approval_id,target_key:approval.target_key});
    return{record,created:true};
  }
  public async completeProductionDeployment(input: {project_id:string;deployment_id:string;status:"SUCCEEDED"|"UNKNOWN";receipt_sha256:string|null}):Promise<ProductionDeploymentRecord>{
    validateDeploymentCompletion(input.status,input.receipt_sha256);
    const result=await this.pool.queryInActiveTx("UPDATE production_deployments SET status=$3,receipt_sha256=$4,completed_at=clock_timestamp() WHERE project_id=$1::uuid AND deployment_id=$2::uuid AND status='RUNNING' RETURNING *;",[input.project_id,input.deployment_id,input.status,input.receipt_sha256]);
    if(!result.rows[0])throw new PostgresRlsError("23514","Only running deployment can complete");
    await this.insertOutboxEventSql(input.project_id,"production_deployment",input.deployment_id,"deployment.completed",{deployment_id:input.deployment_id,status:input.status,receipt_sha256:input.receipt_sha256});
    return mapProductionDeployment(result.rows[0]);
  }

  public async recordReleaseAcceptancePackage(
    input: RecordReleaseAcceptancePackageInput
  ): Promise<ReleaseAcceptancePackageRecord> {
    if (!input.complete || input.coverage_percent !== 100) {
      throw new PostgresRlsError(
        "23514",
        `Release acceptance requires 100% bidirectional traceability (got complete=${String(
          input.complete
        )}, coverage_percent=${input.coverage_percent})`
      );
    }
    if (
      !/^[0-9a-f]{40}$/i.test(input.main_head_commit_hash) ||
      !/^[0-9a-f]{64}$/i.test(input.traceability_sha256) ||
      input.merged_task_ids.length === 0
    ) {
      throw new PostgresRlsError(
        "23514",
        "Release acceptance package requires valid main_head_commit_hash, traceability_sha256, and >= 1 merged task"
      );
    }
    const releaseId = input.release_id ?? randomUUID();
    const packageSha = computeReleasePackageSha256(input);
    return this.withExistingOrRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.accepted_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        try {
          const insRes = await this.pool.queryInActiveTx(
            `INSERT INTO release_acceptance_packages (
              release_id, project_id, pipeline_session_id, baseline_id,
              traceability_sha256, coverage_percent, is_complete, total_requirements,
              merged_task_ids_json, applied_cr_ids_json,
              main_head_commit_hash, summary_markdown, package_json,
              package_sha256, accepted_by_principal_id
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4::uuid,
              $5::char(64), $6::numeric(5,2), $7::boolean, $8::integer,
              $9::jsonb, $10::jsonb,
              $11::char(40), $12::text, $13::jsonb,
              $14::char(64), $15::text
            ) RETURNING *;`,
            [
              releaseId,
              input.project_id,
              input.pipeline_session_id,
              input.baseline_id,
              input.traceability_sha256.toLowerCase(),
              input.coverage_percent,
              input.complete,
              input.total_requirements,
              [...input.merged_task_ids],
              [...input.applied_cr_ids],
              input.main_head_commit_hash.toLowerCase(),
              input.summary_markdown,
              input.package_json,
              packageSha,
              input.accepted_by_principal_id,
            ]
          );
          await this.insertOutboxEventSql(
            input.project_id,
            "release_acceptance",
            releaseId,
            "pipeline.release_accepted",
            {
              release_id: releaseId,
              pipeline_session_id: input.pipeline_session_id,
              baseline_id: input.baseline_id,
              package_sha256: packageSha,
            }
          );
          return mapReleaseAcceptancePackageRow(insRes.rows[0]!);
        } catch (error) {
          mapPgError(error);
        }
      }
    );
  }

  public async listReleaseAcceptancePackages(
    pipelineSessionId: string
  ): Promise<ReleaseAcceptancePackageRecord[]> {
    const res = await this.pool.queryInActiveTx(
      `SELECT * FROM release_acceptance_packages
       WHERE pipeline_session_id = $1::uuid
       ORDER BY accepted_at DESC;`,
      [pipelineSessionId]
    );
    return res.rows.map(mapReleaseAcceptancePackageRow);
  }
  // M6C-1 operations share the caller's tenant transaction. All SQL identifiers below
  // are selected from fixed internal lists, never supplied by HTTP clients.
  private async lockM6CProject(projectId: string): Promise<void> {
    const result = await this.pool.queryInActiveTx(
      "SELECT project_id FROM projects WHERE project_id = $1::uuid FOR UPDATE;", [projectId]
    );
    if (!result.rowCount) throw new PostgresRlsError("23503", "Project not found in current scope");
  }

  public async withProjectMergeQueueLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.pool.getActiveTxSession()) {
      throw new PostgresRlsError("23514", "Merge queue lock requires an explicit tenant transaction covering its callback");
    }
    await this.lockM6CProject(projectId);
    return fn();
  }

  public async listProjectTaskDependencies(): Promise<TaskDependencyRecord[]> {
    const result = await this.pool.queryInActiveTx(
      "SELECT * FROM task_dependencies ORDER BY created_at, task_id, depends_on_task_id;"
    );
    return result.rows.map(mapTaskDependencyRow);
  }

  public async addTaskDependency(input: AddTaskDependencyInput): Promise<TaskDependencyRecord> {
    return this.insertTaskDependencySql(input);
  }

  private async persistMaterializedDependenciesSql(projectId: string,
    specs: readonly { task_key?: string; depends_on_task_keys?: readonly string[]; depends_on_task_ids?: readonly string[] }[],
    tasks: readonly TaskRecord[]): Promise<void> {
    const byKey = new Map<string, string>();
    for (let i = 0; i < specs.length; i++) {
      const key = specs[i]!.task_key?.trim();
      if (key) {
        if (byKey.has(key)) throw new PostgresRlsError("23514", "Duplicate task_key");
        byKey.set(key, tasks[i]!.task_id);
      }
    }
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const ids = new Set(spec.depends_on_task_ids ?? []);
      for (const key of spec.depends_on_task_keys ?? []) {
        const id = byKey.get(key.trim());
        if (!id) throw new PostgresRlsError("23514", `Unknown dependency task_key '${key}'`);
        ids.add(id);
      }
      for (const id of ids) await this.insertTaskDependencySql({ project_id: projectId,
        task_id: tasks[i]!.task_id, depends_on_task_id: id, dependency_kind: "PLAN_DAG" });
    }
  }

  private async insertTaskDependencySql(input: AddTaskDependencyInput): Promise<TaskDependencyRecord> {
    await this.pool.queryInActiveTx("SELECT pg_advisory_xact_lock(hashtext('lease-dispatch:' || $1::text));", [input.project_id]);
    try {
      const result = await this.pool.queryInActiveTx(
        `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, dependency_kind)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text) RETURNING *;`,
        [input.project_id, input.task_id, input.depends_on_task_id, input.dependency_kind ?? "MANUAL"]
      );
      return mapTaskDependencyRow(result.rows[0]!);
    } catch (error) { mapPgError(error); }
  }

  public async enqueueMergeCandidate(input: EnqueueMergeCandidateInput): Promise<MergeQueueEntryRecord> {
    await this.lockM6CProject(input.project_id);
    try {
      const result = await this.pool.queryInActiveTx(
        `INSERT INTO merge_queue_entries
          (project_id, task_id, merge_candidate_id, approval_id, rebased_from_candidate_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid) RETURNING *;`,
        [input.project_id, input.task_id, input.merge_candidate_id, input.approval_id,
          input.rebased_from_candidate_id ?? null]
      );
      const entry = mapMergeQueueEntryRow(result.rows[0]!);
      await this.insertOutboxEventSql(input.project_id, "merge_queue_entry", entry.queue_entry_id,
        "merge_queue.enqueued", { queue_entry_id: entry.queue_entry_id, task_id: input.task_id });
      return entry;
    } catch (error) { mapPgError(error); }
  }

  public async claimNextMergeQueueEntry(projectId: string): Promise<MergeQueueEntryRecord | null> {
    await this.lockM6CProject(projectId);
    const result = await this.pool.queryInActiveTx(
      `UPDATE merge_queue_entries SET status = 'PROCESSING', attempt_count = attempt_count + 1,
         started_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE queue_entry_id = (
         SELECT queue_entry_id FROM merge_queue_entries
         WHERE project_id = $1::uuid AND status = 'QUEUED'
           AND NOT EXISTS (SELECT 1 FROM merge_queue_entries WHERE project_id = $1::uuid AND status = 'PROCESSING')
         ORDER BY queue_position LIMIT 1
       ) RETURNING *;`, [projectId]
    );
    return result.rows[0] ? mapMergeQueueEntryRow(result.rows[0]) : null;
  }

  public async completeMergeQueueEntry(input: CompleteMergeQueueEntryInput): Promise<MergeQueueEntryRecord> {
    if (!["MERGED", "REBASED_NEEDS_REVERIFY", "FAILED", "CANCELLED"].includes(input.status)) {
      throw new PostgresRlsError("23514", "Invalid terminal merge queue status");
    }
    if (input.merged_commit_hash != null && !/^[0-9a-f]{40}$/i.test(input.merged_commit_hash)) {
      throw new PostgresRlsError("23514", "merged_commit_hash must be a 40-hex commit hash");
    }
    await this.lockM6CProject(input.project_id);
    const result = await this.pool.queryInActiveTx(
      `UPDATE merge_queue_entries SET status = $3::text,
         rebased_to_candidate_id = CASE WHEN $7::boolean THEN $4::uuid ELSE rebased_to_candidate_id END,
         merged_commit_hash = CASE WHEN $8::boolean THEN $5::text ELSE merged_commit_hash END,
         last_error = CASE WHEN $9::boolean THEN $6::text ELSE last_error END,
         completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE project_id = $1::uuid AND queue_entry_id = $2::uuid AND status = 'PROCESSING' RETURNING *;`,
      [input.project_id, input.queue_entry_id, input.status, input.rebased_to_candidate_id ?? null,
        input.merged_commit_hash?.toLowerCase() ?? null, input.last_error ?? null,
        input.rebased_to_candidate_id !== undefined, input.merged_commit_hash !== undefined, input.last_error !== undefined]
    );
    if (!result.rows[0]) throw new PostgresRlsError("23514", "Merge queue entry is not processing");
    const entry = mapMergeQueueEntryRow(result.rows[0]);
    await this.insertOutboxEventSql(input.project_id, "merge_queue_entry", entry.queue_entry_id,
      "merge_queue.completed", { queue_entry_id: entry.queue_entry_id, status: entry.status });
    return entry;
  }

  public async listMergeQueueEntries(): Promise<MergeQueueEntryRecord[]> {
    const result = await this.pool.queryInActiveTx("SELECT * FROM merge_queue_entries ORDER BY queue_position;");
    return result.rows.map(mapMergeQueueEntryRow);
  }

  private async budgetUsageSql(projectId: string, taskId?: string | null): Promise<BudgetUsageSummary> {
    const result = await this.pool.queryInActiveTx(
      `SELECT
       (SELECT COALESCE(sum(actual_total_tokens), 0) FROM model_call_ledgers
        WHERE project_id = $1::uuid AND ($2::uuid IS NULL OR task_id = $2::uuid)) AS tokens_used,
       (SELECT COALESCE(sum(actual_cost_micro_usd), 0) FROM model_call_ledgers
        WHERE project_id = $1::uuid AND ($2::uuid IS NULL OR task_id = $2::uuid)) AS cost_micro_usd,
       (SELECT COALESCE(sum(wall_time_ms), 0) FROM resource_usage_metrics
        WHERE project_id = $1::uuid AND ($2::uuid IS NULL OR task_id = $2::uuid)) AS wall_time_ms;`,
      [projectId, taskId ?? null]
    );
    const row = result.rows[0]!;
    return { tokens_used: toSafeInt(row.tokens_used, "tokens_used"),
      cost_micro_usd: toSafeInt(row.cost_micro_usd, "cost_micro_usd"),
      wall_time_ms: toSafeInt(row.wall_time_ms, "wall_time_ms") };
  }

  public async getProjectBudgetSnapshot(projectId: string): Promise<ProjectBudgetSnapshot> {
    await this.recoverBudgetDenials(projectId);
    const policy = await this.pool.queryInActiveTx("SELECT * FROM project_budget_policies WHERE project_id = $1::uuid;", [projectId]);
    const tasks = await this.pool.queryInActiveTx("SELECT task_id FROM tasks WHERE project_id = $1::uuid;", [projectId]);
    const policies = await this.pool.queryInActiveTx("SELECT * FROM task_budget_policies WHERE project_id = $1::uuid ORDER BY task_id;", [projectId]);
    const taskUsage: Record<string, BudgetUsageSummary> = {};
    for (const row of tasks.rows) taskUsage[String(row.task_id)] = await this.budgetUsageSql(projectId, String(row.task_id));
    return { project_id: projectId, policy: policy.rows[0] ? mapProjectBudgetPolicyRow(policy.rows[0]) : null,
      usage: await this.budgetUsageSql(projectId), task_policies: policies.rows.map(mapTaskBudgetPolicyRow),
      task_usage: taskUsage, events: await this.listBudgetPauseEvents(projectId) };
  }

  public async listBudgetPauseEvents(projectId?: string): Promise<BudgetPauseEventRecord[]> {
    const result = await this.pool.queryInActiveTx(
      "SELECT * FROM budget_pause_events WHERE ($1::uuid IS NULL OR project_id = $1::uuid) ORDER BY created_at DESC, event_id DESC;",
      [projectId ?? null]
    );
    return result.rows.map(mapBudgetPauseEventRow);
  }

  private async budgetEventSql(projectId: string, taskId: string | null, eventType: BudgetPauseEventType,
    reason: string, scope: BudgetPauseScope | null = null, limit: number | null = null,
    actor: string | null = null, usage?: BudgetUsageSummary): Promise<void> {
    const observed = usage ?? await this.budgetUsageSql(projectId, taskId);
    await this.pool.queryInActiveTx(
      `INSERT INTO budget_pause_events (project_id, task_id, event_type, pause_scope, reason,
        observed_tokens, observed_cost_micro_usd, observed_wall_time_ms, limit_value, actor_principal_id)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10::text);`,
      [projectId, taskId, eventType, scope, reason, observed.tokens_used, observed.cost_micro_usd,
        observed.wall_time_ms, limit, actor]
    );
    if (eventType !== "BUDGET_UPDATED") await this.insertOutboxEventSql(projectId,
      taskId ? "task_budget_policy" : "project_budget_policy", taskId ?? projectId,
      eventType === "RESUMED" ? "budget.resumed" : "budget.auto_paused",
      { project_id: projectId, task_id: taskId, pause_scope: scope, reason });
  }

  private async writeBudgetPolicySql(
    input: UpsertProjectBudgetPolicyInput | UpsertTaskBudgetPolicyInput,
    resume?: { actor_principal_id: string; reason: string }
  ): Promise<ProjectBudgetPolicyRecord | TaskBudgetPolicyRecord> {
    const taskId = "task_id" in input ? input.task_id : null;
    const table = taskId ? "task_budget_policies" : "project_budget_policies";
    const fields = taskId
      ? ["max_task_tokens", "max_task_cost_micro_usd", "max_task_wall_time_ms"]
      : ["max_project_tokens", "max_project_cost_micro_usd", "max_project_wall_time_ms",
        "default_task_max_tokens", "default_task_max_cost_micro_usd", "default_task_max_wall_time_ms", "max_concurrent_tasks"];
    const values = input as unknown as Record<string, unknown>;
    for (const field of fields) {
      const value = values[field];
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || Number(value) <= 0 ||
        (field === "max_concurrent_tasks" && Number(value) > 128))) {
        throw new PostgresRlsError("23514", `${field} must be a positive safe integer`);
      }
      if (field === "max_concurrent_tasks" && value === null) throw new PostgresRlsError("23514", "max_concurrent_tasks cannot be null");
    }
    await this.lockM6CProject(input.project_id);
    const keyParams = taskId ? [input.project_id, taskId] : [input.project_id];
    const predicate = taskId ? "project_id = $1::uuid AND task_id = $2::uuid" : "project_id = $1::uuid";
    const existing = (await this.pool.queryInActiveTx(`SELECT * FROM ${table} WHERE ${predicate} FOR UPDATE;`, keyParams)).rows[0];
    if (resume) {
      if (!resume.actor_principal_id.trim() || !resume.reason.trim()) throw new PostgresRlsError("23514", "Actor and reason required");
      if (!existing) throw new PostgresRlsError("23503", "Budget policy not found");
      if (existing.status !== "AUTO_PAUSED") throw new PostgresRlsError("23514", "Budget is not paused");
      const scopeField: Record<string, string> = { PROJECT_TOKENS: "max_project_tokens", PROJECT_COST: "max_project_cost_micro_usd", PROJECT_WALL_TIME: "max_project_wall_time_ms", TASK_TOKENS: "max_task_tokens", TASK_COST: "max_task_cost_micro_usd", TASK_WALL_TIME: "max_task_wall_time_ms" };
      const breachedField = scopeField[String(existing.pause_scope)];
      if (!breachedField || typeof values[breachedField] !== "number") throw new PostgresRlsError("23514", "Resume requires an explicit raised ceiling for the paused budget");
      const usage = await this.budgetUsageSql(input.project_id, taskId);
      const projectPolicy = taskId ? (await this.pool.queryInActiveTx("SELECT * FROM project_budget_policies WHERE project_id = $1::uuid;", [input.project_id])).rows[0] : null;
      const defaultFields = ["default_task_max_tokens", "default_task_max_cost_micro_usd", "default_task_max_wall_time_ms"];
      const usageFields = ["tokens_used", "cost_micro_usd", "wall_time_ms"] as const;
      for (let i = 0; i < 3; i++) {
        const field = fields[i]!;
        const configuredLimit = values[field] !== undefined ? values[field] : existing[field];
        const limit = configuredLimit ?? projectPolicy?.[defaultFields[i]!] ?? null;
        // A paused ceiling must be raised, not removed through resume.
        if ((existing.pause_scope && values[field] === null && existing[field] !== null) ||
          (limit !== null && usage[usageFields[i]!] >= Number(limit))) {
          throw new PostgresRlsError("23514", "New budget ceiling must be strictly above observed spend");
        }
      }
    }
    const supplied = fields.filter((field) => values[field] !== undefined);
    let row: Record<string, unknown>;
    if (!existing) {
      const columns = [...(taskId ? ["project_id", "task_id"] : ["project_id"]), ...supplied];
      const params = [...keyParams, ...supplied.map((field) => values[field])];
      row = (await this.pool.queryInActiveTx(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *;`, params
      )).rows[0]!;
    } else {
      const params: unknown[] = [...keyParams];
      const assignments = supplied.map((field) => { params.push(values[field]); return `${field} = $${params.length}`; });
      if (resume) {
        params.push(resume.actor_principal_id);
        assignments.push(`status = 'ACTIVE', pause_scope = NULL, pause_reason = NULL, resumed_at = clock_timestamp(), resumed_by_principal_id = $${params.length}`);
        if (!taskId) assignments.push("paused_task_id = NULL");
      }
      row = (await this.pool.queryInActiveTx(
        `UPDATE ${table} SET ${[...assignments, "updated_at = clock_timestamp()"].join(", ")} WHERE ${predicate} RETURNING *;`, params
      )).rows[0]!;
    }
    await this.budgetEventSql(input.project_id, taskId, resume ? "RESUMED" : "BUDGET_UPDATED",
      resume?.reason ?? "Budget policy updated", null, null, resume?.actor_principal_id ?? input.actor_principal_id ?? null);
    return taskId ? mapTaskBudgetPolicyRow(row) : mapProjectBudgetPolicyRow(row);
  }

  public async upsertProjectBudgetPolicy(input: UpsertProjectBudgetPolicyInput): Promise<ProjectBudgetPolicyRecord> {
    return await this.writeBudgetPolicySql(input) as ProjectBudgetPolicyRecord;
  }
  public async upsertTaskBudgetPolicy(input: UpsertTaskBudgetPolicyInput): Promise<TaskBudgetPolicyRecord> {
    return await this.writeBudgetPolicySql(input) as TaskBudgetPolicyRecord;
  }
  public async resumeProjectBudget(input: ResumeProjectBudgetInput): Promise<ProjectBudgetPolicyRecord> {
    return await this.writeBudgetPolicySql(input, input) as ProjectBudgetPolicyRecord;
  }
  public async resumeTaskBudget(input: ResumeTaskBudgetInput): Promise<TaskBudgetPolicyRecord> {
    return await this.writeBudgetPolicySql(input, input) as TaskBudgetPolicyRecord;
  }

  private async detectBudgetViolationSql(input: {
    project_id: string; task_id?: string | null; projected_tokens?: number; projected_cost_micro_usd?: number;
  }, skipPaused = false): Promise<{ scope: BudgetPauseScope; limit: number | null; taskId: string | null; reason: string; usage: BudgetUsageSummary; paused: boolean } | null> {
    const pRow = (await this.pool.queryInActiveTx("SELECT * FROM project_budget_policies WHERE project_id = $1::uuid;", [input.project_id])).rows[0];
    const tRow = input.task_id ? (await this.pool.queryInActiveTx("SELECT * FROM task_budget_policies WHERE project_id = $1::uuid AND task_id = $2::uuid;", [input.project_id, input.task_id])).rows[0] : undefined;
    const p = pRow ? mapProjectBudgetPolicyRow(pRow) : null;
    const t = tRow ? mapTaskBudgetPolicyRow(tRow) : null;
    for (const taskScope of [false, true]) {
      if (taskScope && !input.task_id) continue;
      const policy = taskScope ? t : p;
      const usage = await this.budgetUsageSql(input.project_id, taskScope ? input.task_id : null);
      if (policy?.status === "AUTO_PAUSED" && skipPaused) continue;
      if (policy?.status === "AUTO_PAUSED") return {
        scope: policy.pause_scope ?? (taskScope ? "TASK_COST" : "PROJECT_COST"), limit: null,
        taskId: taskScope ? input.task_id! : null, reason: policy.pause_reason ?? "Budget is AUTO_PAUSED", usage, paused: true
      };
      const limits = taskScope
        ? [t?.max_task_tokens ?? p?.default_task_max_tokens, t?.max_task_cost_micro_usd ?? p?.default_task_max_cost_micro_usd, t?.max_task_wall_time_ms ?? p?.default_task_max_wall_time_ms]
        : [p?.max_project_tokens, p?.max_project_cost_micro_usd, p?.max_project_wall_time_ms];
      const observed = [usage.tokens_used, usage.cost_micro_usd, usage.wall_time_ms];
      const projected = [input.projected_tokens ?? 0, input.projected_cost_micro_usd ?? 0, 0];
      const scopes: BudgetPauseScope[] = taskScope ? ["TASK_TOKENS", "TASK_COST", "TASK_WALL_TIME"] : ["PROJECT_TOKENS", "PROJECT_COST", "PROJECT_WALL_TIME"];
      for (let i = 0; i < 3; i++) {
        const limit = limits[i];
        if (limit != null && (observed[i]! >= limit || observed[i]! + projected[i]! > limit)) {
          return { scope: scopes[i]!, limit, taskId: taskScope ? input.task_id! : null,
            reason: `${scopes[i]} budget ceiling reached or projected spend exceeds limit (${limit})`, usage, paused: false };
        }
      }
    }
    return null;
  }

  private async persistBudgetViolationSql(projectId: string,
    violation: NonNullable<Awaited<ReturnType<PostgresControlPlaneRepository["detectBudgetViolationSql"]>>>): Promise<void> {
    if (violation.paused) return;
    const taskId = violation.taskId;
    if (taskId) await this.pool.queryInActiveTx(
      "INSERT INTO task_budget_policies (project_id, task_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING;", [projectId, taskId]);
    const result = await this.pool.queryInActiveTx(taskId
      ? `UPDATE task_budget_policies SET status = 'AUTO_PAUSED', pause_scope = $3::text, pause_reason = $4::text,
          paused_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE project_id = $1::uuid AND task_id = $2::uuid AND status = 'ACTIVE' RETURNING project_id;`
      : `UPDATE project_budget_policies SET status = 'AUTO_PAUSED', pause_scope = $3::text, pause_reason = $4::text,
          paused_task_id = $2::uuid, paused_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE project_id = $1::uuid AND status = 'ACTIVE' RETURNING project_id;`,
      [projectId, taskId, violation.scope, violation.reason]);
    if (result.rowCount) await this.budgetEventSql(projectId, taskId, "AUTO_PAUSED", violation.reason,
      violation.scope, violation.limit, null, violation.usage);
  }

  private async assertBudgetAllowsExecutionSql(input: {
    project_id: string; task_id?: string | null; projected_tokens: number; projected_cost_micro_usd: number;
    verifyParentsCommittedSql?: () => Promise<boolean>;
    onBlockedSql?: (scope: BudgetPauseScope, reason: string) => Promise<void>;
    blockedPreflight?: CostPreflightCheckInput;
  }): Promise<void> {
    if (!this.pool.getActiveTxSession()) return this.pool.withRlsTransaction(
      { currentProjectId: input.project_id, currentRole: "core_api_service" }, () => this.assertBudgetAllowsExecutionSql(input));
    const recoverySession = this.pool.getActiveTxSession()!;
    await this.recoverBudgetDenials(input.project_id);
    const pending = await this.pool.queryInActiveTx("SELECT payload_json FROM budget_denial_intents WHERE project_id=$1::uuid AND status='PENDING' ORDER BY created_at,intent_id LIMIT 1;", [input.project_id]);
    if (pending.rowCount) {
      this.pool.afterTransactionEnd(() => this.recoverBudgetDenials(input.project_id, recoverySession));
      const saved = pending.rows[0]!.payload_json as { violation: { scope: BudgetPauseScope; reason: string } };
      throw new BudgetAutoPausedError({ message: saved.violation.reason, projectId: input.project_id, taskId: input.task_id, pauseScope: saved.violation.scope });
    }
    const violation = await this.detectBudgetViolationSql(input);
    if (!violation) return;
    const active = this.pool.getActiveTxSession();
    const outerProjectPolicy = (await this.pool.queryInActiveTx("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid;", [input.project_id])).rowCount > 0;
    const outerTaskPolicy = input.task_id ? (await this.pool.queryInActiveTx("SELECT 1 FROM task_budget_policies WHERE project_id = $1::uuid AND task_id = $2::uuid;", [input.project_id, input.task_id])).rowCount > 0 : false;
    const fallback = new Error("BUDGET_PARENT_UNCOMMITTED_OR_LOCKED");
    let shouldBlock = true;
    let blocked = violation;
    try {
      await this.pool.runAutonomousRlsTransaction(active ?? { currentProjectId: input.project_id, currentRole: "core_api_service" }, async () => {
        if (input.verifyParentsCommittedSql && !await input.verifyParentsCommittedSql()) throw fallback;
        const project = await this.pool.queryInActiveTx("SELECT 1 FROM projects WHERE project_id = $1::uuid;", [input.project_id]);
        const task = input.task_id ? await this.pool.queryInActiveTx("SELECT 1 FROM tasks WHERE project_id = $1::uuid AND task_id = $2::uuid;", [input.project_id, input.task_id]) : null;
        if (!project.rowCount || (task && !task.rowCount)) throw fallback;
        // NOWAIT prevents self-deadlock when a caller modified its policy in the outer transaction.
        const committedProjectPolicy = await this.pool.queryInActiveTx("SELECT 1 FROM project_budget_policies WHERE project_id = $1::uuid FOR UPDATE NOWAIT;", [input.project_id]);
        const committedTaskPolicy = input.task_id ? await this.pool.queryInActiveTx("SELECT 1 FROM task_budget_policies WHERE project_id = $1::uuid AND task_id = $2::uuid FOR UPDATE NOWAIT;", [input.project_id, input.task_id]) : null;
        if ((outerProjectPolicy && !committedProjectPolicy.rowCount) || (outerTaskPolicy && !committedTaskPolicy?.rowCount)) throw fallback;
        const currentViolation = await this.detectBudgetViolationSql(input);
        if (!currentViolation) { shouldBlock = false; return; }
        blocked = currentViolation;
        await this.persistBudgetViolationSql(input.project_id, currentViolation);
        await input.onBlockedSql?.(currentViolation.scope, currentViolation.reason);
      });
    } catch (error) {
      if (error !== fallback && !(error instanceof PostgresQueryError && error.sqlState === "55P03")) throw error;
      // The outer TX owns a parent/policy lock (or a newly inserted parent).
      // Wait for its real end before retrying: writing inside it would lose the
      // pause, event and blocked ledger on rollback. Completion work is awaited,
      // uses a fresh tenant TX, and runs after releasing the outer connection.
      const intentId = randomUUID();
      const owner = await this.pool.queryInActiveTx("SELECT pg_current_xact_id()::text AS xid;");
      await this.pool.runAutonomousRlsTransaction(active!, () => this.pool.queryInActiveTx(
        "INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES($1::uuid,$2::uuid,$3::xid8,$4::jsonb);",
        [intentId, input.project_id, owner.rows[0]!.xid, JSON.stringify({ violation, preflight: input.blockedPreflight ?? null })]));
      this.pool.afterTransactionEnd(() => this.recoverBudgetDenials(input.project_id, active!));
    }
    if (!shouldBlock) return;
    throw new BudgetAutoPausedError({ message: blocked.reason, projectId: input.project_id,
      taskId: input.task_id, pauseScope: blocked.scope });
  }

  public async recoverBudgetDenials(projectId: string, completedSession?: RlsSessionContext): Promise<void> {
    const ctx = this.pool.getActiveTxSession() ?? completedSession;
    if (!ctx || ctx.currentProjectId !== projectId || !["core_api_service", "gateway_service"].includes(ctx.currentRole)) return;
    try {
      await this.pool.runAutonomousRlsTransaction(ctx, async () => {
        await this.pool.queryInActiveTx("SET LOCAL lock_timeout = '250ms';");
        const rows = await this.pool.queryInActiveTx(
          `SELECT * FROM budget_denial_intents WHERE project_id=$1::uuid AND status='PENDING'
           AND pg_xact_status(outer_xid) IS DISTINCT FROM 'in progress'
           ORDER BY created_at,intent_id FOR UPDATE SKIP LOCKED;`, [projectId]);
        for (const row of rows.rows) {
          const payload = row.payload_json as { violation: NonNullable<Awaited<ReturnType<PostgresControlPlaneRepository["detectBudgetViolationSql"]>>>; preflight: CostPreflightCheckInput | null };
          await this.applyBudgetDenialSql(projectId, payload.violation, payload.preflight, String(row.intent_id));
          await this.pool.queryInActiveTx("UPDATE budget_denial_intents SET status='COMPLETED',completed_at=clock_timestamp() WHERE intent_id=$1::uuid;", [row.intent_id]);
        }
      });
    } catch (error) {
      // Another active transaction still owns required rows. The durable intent
      // stays PENDING and all new executions fail closed until replay succeeds.
      if (!(error instanceof PostgresQueryError && error.sqlState === "55P03")) throw error;
    }
  }

  private async applyBudgetDenialSql(projectId: string,
    captured: NonNullable<Awaited<ReturnType<PostgresControlPlaneRepository["detectBudgetViolationSql"]>>>,
    preflight: CostPreflightCheckInput | null, intentId: string): Promise<void> {
    const project = await this.pool.queryInActiveTx("SELECT 1 FROM projects WHERE project_id = $1::uuid;", [projectId]);
    // A rolled-back project has no durable domain identity to pause.
    if (!project.rowCount) return;
    const task = captured.taskId ? await this.pool.queryInActiveTx(
      "SELECT 1 FROM tasks WHERE project_id = $1::uuid AND task_id = $2::uuid;", [projectId, captured.taskId]) : null;
    if (task && !task.rowCount) {
      // The transient task is gone; retain its denial audit on the project
      // without inventing a task or violating the audit's composite FK.
      await this.budgetEventSql(projectId, null, "AUTO_PAUSED",
        `${captured.reason}; rolled-back task ${captured.taskId}`, captured.scope, captured.limit, null, captured.usage);
      return;
    }
    // A policy created in the aborted TX is gone. Preserve the observed
    // denial ceiling so AUTO_PAUSED remains resumable by an approver.
    const columns: Record<BudgetPauseScope, string> = {
      PROJECT_TOKENS: "max_project_tokens", PROJECT_COST: "max_project_cost_micro_usd", PROJECT_WALL_TIME: "max_project_wall_time_ms",
      TASK_TOKENS: "max_task_tokens", TASK_COST: "max_task_cost_micro_usd", TASK_WALL_TIME: "max_task_wall_time_ms",
    };
    const table = captured.taskId ? "task_budget_policies" : "project_budget_policies";
    const field = columns[captured.scope];
    if (captured.taskId) await this.pool.queryInActiveTx(
      `INSERT INTO ${table} (project_id, task_id, ${field}) VALUES ($1::uuid, $2::uuid, $3::bigint) ON CONFLICT DO NOTHING;`,
      [projectId, captured.taskId, captured.limit]);
    else await this.pool.queryInActiveTx(
      `INSERT INTO ${table} (project_id, ${field}) VALUES ($1::uuid, $2::bigint) ON CONFLICT DO NOTHING;`,
      [projectId, captured.limit]);
    await this.persistBudgetViolationSql(projectId, { ...captured, paused: false });

    if (!preflight) return;
    const session = await this.getCostSession(preflight.cost_session_id);
    if (!session) return;
    const taskId = preflight.task_id ?? session.task_id;
    const pipelineId = preflight.pipeline_session_id ?? session.pipeline_session_id;
    if (taskId && !(await this.pool.queryInActiveTx("SELECT 1 FROM tasks WHERE project_id=$1::uuid AND task_id=$2::uuid;", [projectId,taskId])).rowCount) return;
    if (pipelineId && !(await this.pool.queryInActiveTx("SELECT 1 FROM product_pipeline_sessions WHERE project_id=$1::uuid AND pipeline_session_id=$2::uuid;", [projectId,pipelineId])).rowCount) return;
    await this.pool.queryInActiveTx(
      `INSERT INTO model_call_ledgers(call_id,project_id,cost_session_id,pipeline_session_id,task_id,stage,provider,model,
        prompt_id,prompt_version,prompt_sha256,request_sha256,estimated_input_tokens,reserved_output_tokens,
        actual_input_tokens,actual_output_tokens,actual_total_tokens,estimated_cost_micro_usd,actual_cost_micro_usd,status,usage_estimated,block_reason,error_message,latency_ms)
       VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,0,0,$15,0,'BLOCKED_PREFLIGHT',false,$16,$16,0)
       ON CONFLICT (call_id) DO NOTHING;`,
      [intentId,projectId,preflight.cost_session_id,pipelineId,taskId,preflight.stage,preflight.provider,preflight.model,
        preflight.prompt_id,preflight.prompt_version,preflight.prompt_sha256,preflight.request_sha256,preflight.estimated_input_tokens,
        preflight.reserved_output_tokens,preflight.estimated_cost_micro_usd,captured.reason]);
  }

  private async evaluatePostSpendBudgetPauseSql(input: { project_id: string; task_id?: string | null }): Promise<void> {
    // At most two policies (project + task) can transition; a third read
    // verifies convergence. A future persistence/state mismatch must fail closed.
    for (let transitions = 0; transitions <= 2; transitions++) {
      const violation = await this.detectBudgetViolationSql(input, true);
      if (!violation) return;
      if (transitions === 2) {
        throw new PostgresRlsError("23514", "Budget auto-pause failed to converge after two policy transitions");
      }
      await this.persistBudgetViolationSql(input.project_id, violation);
    }
  }

}

export function validateAndNormalizeResourceUsageMetricInput(
  input: RecordResourceUsageMetricInput,
  taskDefaults?: { readonly current_attempt_no: number; readonly rework_count: number }
): {
  readonly lease_epoch: number;
  readonly attempt_no: number;
  readonly rework_cycle: number;
  readonly wall_time_ms: number;
  readonly cpu_usage_usec: number;
  readonly peak_memory_bytes: number;
  readonly sandbox_backend_mode: string;
} {
  if (!Number.isFinite(input.lease_epoch) || input.lease_epoch < 0) {
    throw new PostgresRlsError("23514", "lease_epoch must be a non-negative finite number");
  }
  if (
    input.attempt_no !== undefined &&
    (!Number.isFinite(input.attempt_no) || input.attempt_no < 1)
  ) {
    throw new PostgresRlsError("23514", "attempt_no must be >= 1");
  }
  if (
    input.rework_cycle !== undefined &&
    (!Number.isFinite(input.rework_cycle) || input.rework_cycle < 0)
  ) {
    throw new PostgresRlsError("23514", "rework_cycle must be >= 0");
  }
  if (!Number.isFinite(input.wall_time_ms) || input.wall_time_ms < 0) {
    throw new PostgresRlsError("23514", "wall_time_ms must be >= 0");
  }
  if (!Number.isFinite(input.cpu_usage_usec) || input.cpu_usage_usec < 0) {
    throw new PostgresRlsError("23514", "cpu_usage_usec must be >= 0");
  }
  if (!Number.isFinite(input.peak_memory_bytes) || input.peak_memory_bytes < 0) {
    throw new PostgresRlsError("23514", "peak_memory_bytes must be >= 0");
  }
  const trimmedMode = input.sandbox_backend_mode.trim();
  if (!trimmedMode) {
    throw new PostgresRlsError("23514", "sandbox_backend_mode must be non-empty");
  }

  const defaultAttemptNo = Math.max(1, Math.round(taskDefaults?.current_attempt_no ?? 1));
  const defaultReworkCycle = Math.max(0, Math.round(taskDefaults?.rework_count ?? 0));

  return {
    lease_epoch: Math.round(input.lease_epoch),
    attempt_no: Math.max(1, Math.round(input.attempt_no ?? defaultAttemptNo)),
    rework_cycle: Math.max(0, Math.round(input.rework_cycle ?? defaultReworkCycle)),
    wall_time_ms: Math.round(input.wall_time_ms),
    cpu_usage_usec: Math.round(input.cpu_usage_usec),
    peak_memory_bytes: Math.round(input.peak_memory_bytes),
    sandbox_backend_mode: trimmedMode,
  };
}

export function buildCandidateBoundLineage(input: {
  readonly task: TaskRecord;
  readonly mainHeadCommitHash: string | null;
  readonly taskLeases: readonly TaskLeaseRecord[];
  readonly processedEvents: readonly ProcessedWorkerEventRecord[];
  readonly resourceUsageMetrics: readonly ResourceUsageMetricRecord[];
  readonly imports: readonly VerifiedCodeImportRecord[];
  readonly allMergeCandidates: readonly MergeCandidateRecord[];
  readonly verificationRuns: readonly VerificationRunRecord[];
  readonly reviewSessions: readonly ReviewSessionRecord[];
  readonly reviewArtifacts: readonly ReviewArtifactRecord[];
  readonly approvalRequests: readonly ApprovalRequestRecord[];
  readonly approvalDecisions: readonly ApprovalDecisionRecord[];
  readonly mergeOperations: readonly MergeOperationRecord[];
}): CandidateBoundLineage {
  const { task } = input;
  const designatedMc = task.active_merge_candidate_id
    ? input.allMergeCandidates.find(
        (c) => c.merge_candidate_id === task.active_merge_candidate_id
      )
    : undefined;
  const activeMc =
    (designatedMc && !designatedMc.is_superseded ? designatedMc : undefined) ??
    [...input.allMergeCandidates].reverse().find((c) => !c.is_superseded) ??
    input.allMergeCandidates[input.allMergeCandidates.length - 1] ??
    null;

  const verifiedImport = activeMc
    ? input.imports.find((i) => i.import_id === activeMc.import_id) ?? null
    : input.imports[input.imports.length - 1] ?? null;

  const verificationRun = activeMc
    ? [...input.verificationRuns]
        .reverse()
        .find((v) => v.merge_candidate_id === activeMc.merge_candidate_id) ?? null
    : null;

  const reviewArtifact = activeMc
    ? [...input.reviewArtifacts]
        .reverse()
        .find(
          (r) =>
            r.merge_candidate_id === activeMc.merge_candidate_id &&
            (!verificationRun || r.verification_run_id === verificationRun.verification_run_id)
        ) ?? null
    : null;

  const reviewSession = reviewArtifact?.review_session_id
    ? input.reviewSessions.find((s) => s.review_session_id === reviewArtifact.review_session_id) ??
      null
    : activeMc
    ? [...input.reviewSessions]
        .reverse()
        .find((s) => s.merge_candidate_id === activeMc.merge_candidate_id) ?? null
    : null;

  const approvalForCandidate = activeMc
    ? [...input.approvalDecisions]
        .reverse()
        .find((a) => a.merge_candidate_id === activeMc.merge_candidate_id) ?? null
    : null;

  const approvalRequest = approvalForCandidate?.approval_request_id
    ? input.approvalRequests.find(
        (r) => r.approval_request_id === approvalForCandidate.approval_request_id
      ) ?? null
    : activeMc
    ? [...input.approvalRequests]
        .reverse()
        .find((r) => r.merge_candidate_id === activeMc.merge_candidate_id) ?? null
    : null;

  const mergeOpForCandidate = activeMc
    ? [...input.mergeOperations]
        .reverse()
        .find(
          (m) => m.merge_candidate_id === activeMc.merge_candidate_id && m.status === "MERGED"
        ) ??
      [...input.mergeOperations]
        .reverse()
        .find((m) => m.merge_candidate_id === activeMc.merge_candidate_id) ??
      null
    : null;

  const missingLinks: string[] = [];
  if (input.taskLeases.length === 0) missingLinks.push("task_leases");
  if (input.processedEvents.length === 0) missingLinks.push("processed_worker_events");
  if (!verifiedImport) missingLinks.push("verified_code_imports");
  if (!activeMc) missingLinks.push("merge_candidates");
  if (!verificationRun) missingLinks.push("verification_runs");
  if (!reviewSession) missingLinks.push("review_sessions");
  if (!reviewArtifact) missingLinks.push("review_artifacts");
  if (!approvalRequest) missingLinks.push("approval_requests");
  if (!approvalForCandidate) missingLinks.push("approval_decisions");
  if (!mergeOpForCandidate || mergeOpForCandidate.status !== "MERGED") {
    missingLinks.push("merge_operations");
  }

  const hashBindingVerified = Boolean(
    activeMc &&
      !activeMc.is_superseded &&
      verifiedImport &&
      verificationRun &&
      reviewArtifact &&
      approvalForCandidate &&
      verificationRun.verdict === "PASS" &&
      verificationRun.overall_status === "PASSED" &&
      reviewArtifact.verdict === "PASS" &&
      !reviewArtifact.is_invalidated &&
      reviewArtifact.status === "VALID" &&
      approvalForCandidate.decision === "APPROVED" &&
      (approvalForCandidate.status === "ACTIVE" || approvalForCandidate.status === "CONSUMED") &&
      (!approvalForCandidate.approval_request_id ||
        (approvalRequest !== null &&
          approvalRequest.approval_request_id === approvalForCandidate.approval_request_id)) &&
      (!approvalRequest ||
        (approvalRequest.merge_candidate_id === activeMc.merge_candidate_id &&
          approvalRequest.review_artifact_id === reviewArtifact.review_artifact_id &&
          approvalRequest.verification_run_id === verificationRun.verification_run_id &&
          approvalRequest.agent_commit_hash === activeMc.agent_commit_hash &&
          approvalRequest.base_main_commit_hash === activeMc.base_main_commit_hash &&
          approvalRequest.merge_candidate_hash === activeMc.merge_candidate_hash &&
          approvalRequest.verified_tree_hash === activeMc.verified_tree_hash &&
          approvalRequest.status === "APPROVED")) &&
      activeMc.agent_commit_hash === verifiedImport.agent_commit_hash &&
      verificationRun.merge_candidate_hash === activeMc.merge_candidate_hash &&
      verificationRun.verified_tree_hash === activeMc.verified_tree_hash &&
      reviewArtifact.merge_candidate_hash === activeMc.merge_candidate_hash &&
      reviewArtifact.verified_tree_hash === activeMc.verified_tree_hash &&
      approvalForCandidate.agent_commit_hash === activeMc.agent_commit_hash &&
      approvalForCandidate.base_main_commit_hash === activeMc.base_main_commit_hash &&
      approvalForCandidate.merge_candidate_hash === activeMc.merge_candidate_hash &&
      approvalForCandidate.verified_tree_hash === activeMc.verified_tree_hash &&
      approvalForCandidate.verification_run_id === verificationRun.verification_run_id &&
      approvalForCandidate.review_artifact_id === reviewArtifact.review_artifact_id &&
      (!mergeOpForCandidate ||
        (mergeOpForCandidate.approval_id === approvalForCandidate.approval_id &&
          mergeOpForCandidate.base_main_commit_hash === activeMc.base_main_commit_hash &&
          mergeOpForCandidate.merge_candidate_hash === activeMc.merge_candidate_hash &&
          mergeOpForCandidate.verified_tree_hash === activeMc.verified_tree_hash))
  );

  const gitLogHeadMatchesCandidate = Boolean(
    activeMc &&
      !activeMc.is_superseded &&
      input.mainHeadCommitHash &&
      task.merged_commit_hash &&
      input.mainHeadCommitHash === activeMc.merge_candidate_hash &&
      task.merged_commit_hash === activeMc.merge_candidate_hash
  );

  return {
    projectId: task.project_id,
    taskId: task.task_id,
    mainHeadCommitHash: input.mainHeadCommitHash,
    gitLogHeadMatchesCandidate,
    task: { ...task },
    taskContract: task.task_contract_json,
    taskLeases: [...input.taskLeases],
    processedEvents: [...input.processedEvents],
    processedEventsCount: input.processedEvents.length,
    resourceUsageMetrics: [...input.resourceUsageMetrics],
    verifiedImport: verifiedImport ? { ...verifiedImport } : null,
    allMergeCandidates: [...input.allMergeCandidates],
    mergeCandidate: activeMc ? { ...activeMc } : null,
    verificationRun: verificationRun ? { ...verificationRun } : null,
    reviewSession: reviewSession ? { ...reviewSession } : null,
    reviewArtifact: reviewArtifact ? { ...reviewArtifact } : null,
    approvalRequest: approvalRequest ? { ...approvalRequest } : null,
    approvalDecisions: [...input.approvalDecisions],
    activeOrConsumedApproval: approvalForCandidate ? { ...approvalForCandidate } : null,
    mergeOperations: [...input.mergeOperations],
    hashBindingVerified,
    lineageComplete: missingLinks.length === 0 && hashBindingVerified,
    missingLinks,
  };
}
