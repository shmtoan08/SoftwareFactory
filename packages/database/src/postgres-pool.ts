import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import net from "node:net";
import {
  type ApprovalDecisionRecord,
  type ApprovalRequestRecord,
  type CandidateBoundLineage,
  type LeaseSyncStatusResponse,
  type MergeCandidateRecord,
  type MergeOperationRecord,
  type OutboxEventRecord,
  type ProcessedWorkerEventRecord,
  type ResourceUsageMetricRecord,
  type ReviewArtifactRecord,
  type ReviewSessionRecord,
  type ReviewSessionStatus,
  type ServerEventAckContract,
  type SnapshotRetentionClass,
  type TaskLeaseRecord,
  type TaskRecord,
  type TaskStatus,
  type Tier3AssertionEvidence,
  type VerificationExecutionBackend,
  type VerificationOverallStatus,
  type VerificationRunRecord,
  type VerifiedCodeImportRecord,
  type WorkerEventEnvelope,
  WORKER_EVENT_STATE_TRANSITIONS,
  computeCanonicalPayloadSha256,
  computeTaskExecutionIdempotencyKey,
} from "@software-factory/shared-types";
import {
  type GitTreeChangeEntry,
  type GitTreeImportCandidateInput,
  type TaskContractSpec,
  validateGitTreeImport,
} from "@software-factory/task-contract";
import {
  ApprovalExpiredOrStaleError,
  type CasMergeResult,
  type ControlPlaneStore,
  PostgresRlsError,
  type ProjectMemberRole,
  type ProjectMembershipRecord,
  type ProjectRecord,
  type RecordResourceUsageMetricInput,
  type RlsSessionContext,
  SimulatedPostMergeCrashError,
} from "./types.ts";

export interface PostgresPoolConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly maxConnections?: number;
  readonly connectTimeoutMs?: number;
  readonly applicationName?: string;
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

export function buildPostgresPoolConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PostgresPoolConfig | null {
  if (env.DATABASE_URL && env.DATABASE_URL.trim().length > 0) {
    const parsed = new URL(env.DATABASE_URL);
    return {
      host: parsed.hostname || "127.0.0.1",
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(parsed.username || "postgres"),
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      maxConnections: env.PGPOOL_MAX ? Number.parseInt(env.PGPOOL_MAX, 10) : 10,
      applicationName: "software-factory-runtime",
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

class PooledPgConnection {
  public readonly id: string = randomUUID();
  private readonly socket: net.Socket;
  private readonly config: PostgresPoolConfig;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private waiters: Array<(frame: WireFrame) => void> = [];
  private wireQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private closeError: Error | null = null;
  public lastTxStatus: "I" | "T" | "E" = "I";

  private constructor(socket: net.Socket, config: PostgresPoolConfig) {
    this.socket = socket;
    this.config = config;
    this.socket.on("data", (chunk: Buffer) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
      this.drainWaiters();
    });
    this.socket.on("error", (err) => {
      this.closed = true;
      this.closeError = err;
      this.rejectAllWaiters(err);
    });
    this.socket.on("close", () => {
      this.closed = true;
      const err = this.closeError ?? new Error("PostgreSQL connection closed unexpectedly");
      this.rejectAllWaiters(err);
    });
  }

  public isAlive(): boolean {
    return !this.closed && !this.socket.destroyed;
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
        waiter({ type: "__ERROR__", payload: Buffer.from(err.message, "utf8") });
      }
    }
  }

  private tryPopFrame(): WireFrame | null {
    if (this.recvBuffer.length < 5) {
      return null;
    }
    const type = String.fromCharCode(this.recvBuffer.readUInt8(0));
    const totalLen = this.recvBuffer.readInt32BE(1);
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
        waiter(frame);
      }
    }
  }

  private nextFrame(): Promise<WireFrame> {
    const queued = this.tryPopFrame();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("PostgreSQL connection is already closed")
      );
    }
    return new Promise((resolve, reject) => {
      this.waiters.push((frame) => {
        if (frame.type === "__ERROR__") {
          reject(new Error(frame.payload.toString("utf8")));
          return;
        }
        resolve(frame);
      });
    });
  }

  public static async connect(config: PostgresPoolConfig): Promise<PooledPgConnection> {
    const timeoutMs = config.connectTimeoutMs ?? 5000;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
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

    const conn = new PooledPgConnection(socket, config);
    await conn.authenticateStartup();
    return conn;
  }

  private async authenticateStartup(): Promise<void> {
    this.socket.write(buildStartupPacket(this.config));

    let scramState:
      | {
          clientNonce: string;
          clientFirstBare: string;
          expectedServerSignature: Buffer;
        }
      | undefined;

    while (true) {
      const frame = await this.nextFrame();
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
          // Cleartext password
          const body = Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]);
          this.socket.write(buildTypedMessage("p", body));
        } else if (authCode === 5) {
          // MD5 password with 4-byte salt
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
          const salt = Buffer.from(saltB64, "base64");
          const iterations = Number.parseInt(iterStr, 10);
          const { pbkdf2Sync } = await import("node:crypto");
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
    let columns: PostgresColumnMeta[] = [];
    const rows: TRow[] = [];
    let rowCount = 0;
    let commandTag = "";
    let queryError: PostgresQueryError | null = null;

    while (true) {
      const frame = await this.nextFrame();
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
    if (!this.closed) {
      try {
        this.socket.write(buildTypedMessage("X", Buffer.alloc(0)));
      } catch {
        // ignore write errors during close
      }
      this.closed = true;
      this.socket.end();
      this.socket.destroy();
    }
  }
}

interface ActiveTxState {
  readonly conn: PooledPgConnection;
  readonly session: RlsSessionContext;
}

/**
 * Bounded PostgreSQL Runtime Pool executing `SET LOCAL ROLE app_runtime`, scoped `app.*`
 * session settings inside `BEGIN`/`COMMIT`, and unconditional `DISCARD ALL` on release
 * before returning a connection to the pool (`RLS-T6`).
 */
export class PostgresRuntimePool {
  private readonly config: PostgresPoolConfig;
  private readonly maxConnections: number;
  private readonly allConnections: Set<PooledPgConnection> = new Set();
  private readonly idleConnections: PooledPgConnection[] = [];
  private readonly activeConnections: Set<PooledPgConnection> = new Set();
  private readonly waiters: Array<{
    resolve: (conn: PooledPgConnection) => void;
    reject: (err: Error) => void;
  }> = [];
  private readonly txAsyncStorage = new AsyncLocalStorage<ActiveTxState>();
  private transactionsExecuted = 0;
  private discardAllExecuted = 0;
  private closed = false;

  constructor(config: PostgresPoolConfig) {
    this.config = config;
    this.maxConnections = Math.max(1, config.maxConnections ?? 10);
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
      this.allConnections.add(conn);
      this.activeConnections.add(conn);
      return conn;
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private async release(conn: PooledPgConnection): Promise<void> {
    this.activeConnections.delete(conn);

    const finalizeBroken = async (): Promise<void> => {
      this.allConnections.delete(conn);
      await conn.close();
      const next = this.waiters.shift();
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
      const next = this.waiters.shift();
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
    try {
      await conn.simpleQuery("BEGIN; SET LOCAL ROLE app_runtime;");
      await conn.query(
        "SELECT set_config('app.current_project_id', $1::text, true), set_config('app.current_principal_id', $2::text, true), set_config('app.current_role', $3::text, true);",
        [session.currentProjectId ?? "", session.currentPrincipalId ?? "", session.currentRole]
      );
      const result = await this.txAsyncStorage.run({ conn, session }, () =>
        fn(conn, session)
      );
      await conn.simpleQuery("COMMIT;");
      committed = true;
      return result;
    } catch (error) {
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
  if (error instanceof PostgresRlsError || error instanceof ApprovalExpiredOrStaleError || error instanceof SimulatedPostMergeCrashError) {
    throw error;
  }
  if (error instanceof PostgresQueryError) {
    const sqlState = error.sqlState;
    if (
      sqlState === "42501" ||
      sqlState === "23503" ||
      sqlState === "23505" ||
      sqlState === "23514"
    ) {
      throw new PostgresRlsError(
        sqlState,
        error.detail ? `${error.message} (${error.detail})` : error.message
      );
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
  }): Promise<TaskLeaseRecord> {
    try {
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
      if (task.status !== "Ready" && task.status !== "ReworkRequired") {
        throw new Error(`Cannot grant lease when task is in status ${task.status}`);
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

  public async revokeTaskLease(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    reason: string;
    requeueTask?: boolean;
  }): Promise<TaskLeaseRecord> {
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort(new Error("ERR_GATEKEEPER_TIMEOUT"));
        reject(new Error("ERR_GATEKEEPER_TIMEOUT"));
      }, deadlineMs);
    });

    const runVerification = async (): Promise<{
      allowed: boolean;
      error_code?: string;
      reason?: string;
      import_id?: string;
    }> => {
      if (input.authorizeCheckHook) {
        await input.authorizeCheckHook(abortController.signal);
      }
      if (abortController.signal.aborted || Date.now() - startMs > deadlineMs) {
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
      const row = rowRes.rows[0];
      if (
        !row ||
        Number(row.lease_epoch) !== input.lease_epoch ||
        String(row.lease_status) !== "ACTIVE" ||
        row.revoked_at !== null ||
        Boolean(row.is_expired)
      ) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_STALE_OR_EXPIRED_LEASE",
          reason: "Pre-receive denied: lease is not ACTIVE or has expired/revoked",
        };
      }

      if (!input.changes) {
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
        return {
          allowed: false,
          error_code: validation.error_code,
          reason: `TrustedImportValidator rejected push at pre-receive: [${validation.error_code}] ${validation.message}`,
        };
      }

      const elapsedMs = Date.now() - startMs;
      if (abortController.signal.aborted || elapsedMs > deadlineMs) {
        return {
          allowed: false,
          error_code: "ERR_GATEKEEPER_FAIL_CLOSED_UNAVAILABLE",
          reason: `Pre-receive hard timeout exceeded: execution took ${elapsedMs}ms (> ${deadlineMs}ms)`,
        };
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

      const existingRes = await this.pool.queryInActiveTx(
        `SELECT import_id FROM verified_code_imports
         WHERE lease_id = $1::uuid AND agent_commit_hash = $2::text LIMIT 1;`,
        [input.lease_id, input.agent_commit_hash]
      );
      if (existingRes.rows[0]) {
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
      return {
        allowed: true,
        import_id: String(insRes.rows[0]!.import_id),
      };
    };

    const verificationPromise = runVerification();
    verificationPromise.catch(() => {});
    try {
      return await Promise.race([verificationPromise, timeoutPromise]);
    } catch {
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

  public async recordVerifiedCodeImport(input: {
    project_id: string;
    task_id: string;
    lease_id: string;
    lease_epoch: number;
    staging_ref: string;
    candidate_input: GitTreeImportCandidateInput;
  }): Promise<VerifiedCodeImportRecord> {
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
    trusted_policy_sha256?: string | null;
    keep_verifying_on_infra_retry?: boolean;
    exit_code: number;
    duration_ms: number;
    report_sha256: string;
  }): Promise<VerificationRunRecord> {
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
          exit_code, duration_ms, report_sha256
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text,
          $6::text, $7::text, $8::text,
          $9::boolean, $10::boolean,
          $11::boolean, $12::jsonb,
          $13::boolean, $14::jsonb,
          $15::integer, $16::text, $17::boolean,
          $18::boolean, $19::boolean, $20::text,
          $21::integer, $22::integer, $23::text
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
          resulting_task_status: nextTaskStatus,
        }
      );

      return record;
    } catch (error) {
      mapPgError(error);
    }
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
                mc.is_superseded, mc.agent_commit_hash AS mc_agent, mc.base_main_commit_hash AS mc_base,
                mc.merge_candidate_hash AS mc_cand, mc.verified_tree_hash AS mc_tree,
                ra.is_invalidated AS ra_invalidated, ra.status AS ra_status, ra.verdict AS ra_verdict,
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

  public async getMainRefCommitHash(): Promise<string | null> {
    const res = await this.pool.queryInActiveTx(
      "SELECT main_ref_commit_hash FROM projects LIMIT 1;"
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
    try {
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
          input.lease_epoch,
          input.attempt_no ?? 1,
          input.rework_cycle ?? 0,
          input.phase,
          Math.max(0, Math.round(input.wall_time_ms)),
          Math.max(0, Math.round(input.cpu_usage_usec)),
          Math.max(0, Math.round(input.peak_memory_bytes)),
          input.sandbox_backend_mode,
          input.metrics_source,
        ]
      );
      return mapResourceMetricRow(res.rows[0]!);
    } catch (error) {
      mapPgError(error);
    }
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
    const [
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
    ] = await Promise.all([
      liveMainHeadHash !== undefined
        ? Promise.resolve(liveMainHeadHash)
        : this.getMainRefCommitHash(),
      this.listTaskLeasesForTask(taskId),
      this.listProcessedWorkerEventsForTask(taskId),
      this.listResourceUsageMetricsForTask(taskId),
      this.getVerifiedImportsForTask(taskId),
      this.listMergeCandidatesForTask(taskId),
      this.listVerificationRunsForTask(taskId),
      this.listReviewSessionsForTask(taskId),
      this.listReviewArtifactsForTask(taskId),
      this.listApprovalRequestsForTask(taskId),
      this.listApprovalDecisionsForTask(taskId),
      this.listMergeOperationsForTask(taskId),
    ]);

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
  const activeMc =
    (task.active_merge_candidate_id
      ? input.allMergeCandidates.find(
          (c) => c.merge_candidate_id === task.active_merge_candidate_id
        )
      : undefined) ??
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

  const approvalRequest = activeMc
    ? [...input.approvalRequests]
        .reverse()
        .find((r) => r.merge_candidate_id === activeMc.merge_candidate_id) ?? null
    : null;

  const approvalForCandidate = activeMc
    ? [...input.approvalDecisions]
        .reverse()
        .find((a) => a.merge_candidate_id === activeMc.merge_candidate_id) ?? null
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
  if (input.mergeOperations.length === 0) missingLinks.push("merge_operations");

  const hashBindingVerified = Boolean(
    activeMc &&
      verifiedImport &&
      verificationRun &&
      reviewArtifact &&
      approvalForCandidate &&
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
      approvalForCandidate.review_artifact_id === reviewArtifact.review_artifact_id
  );

  const gitLogHeadMatchesCandidate = Boolean(
    activeMc &&
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
