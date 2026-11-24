import { timingSafeEqual } from "node:crypto";
import {
  PostgresRlsError, ProjectReadCursorContextError, readTimestamp,
  type ControlPlaneStore, type SessionReadInput,
} from "@software-factory/database";
import type { CoreApiAuthContext } from "./index.ts";
import { ReadProjectionError } from "./project-read-projection.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
const forbidden = () => new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
const cursorMaxBytes = 2048;
const cursorTtlMs = 15 * 60 * 1000;

type Context = Pick<SessionReadInput, "projectId" | "principalId" | "limit">;
type Anchor = NonNullable<SessionReadInput["after"]>;
interface Cursor extends Context {
  v: 1;
  kind: "sessions";
  anchor: Anchor;
  expires: number;
}

export class SessionReadCursorCodec {
  private readonly mac: (data: string) => string;
  private readonly now: () => number;

  constructor(mac: (data: string) => string, now = Date.now) {
    this.mac = mac;
    this.now = now;
  }

  encode(context: Context, anchor: Anchor): string {
    const { projectId, principalId, limit } = context;
    const cursor: Cursor = {
      v: 1, kind: "sessions", projectId, principalId, limit,
      anchor: { createdAt: anchor.createdAt, pipelineSessionId: anchor.pipelineSessionId },
      expires: this.now() + cursorTtlMs,
    };
    const data = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const token = `${data}.${this.mac(data)}`;
    if (Buffer.byteLength(token) > cursorMaxBytes) throw new Error("Session cursor exceeds size limit");
    return token;
  }

  decode(token: string): Cursor {
    try {
      if (Buffer.byteLength(token) > cursorMaxBytes || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw invalid();
      const [data, signature] = token.split(".") as [string, string];
      if (!timingSafeEqual(Buffer.from(this.mac(data), "hex"), Buffer.from(signature, "hex"))) throw invalid();
      const bytes = Buffer.from(data, "base64url");
      if (bytes.toString("base64url") !== data) throw invalid();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const cursor: Cursor = JSON.parse(raw);
      if (!cursor || JSON.stringify(cursor) !== raw || Object.keys(cursor).sort().join() !== "anchor,expires,kind,limit,principalId,projectId,v"
        || cursor.v !== 1 || cursor.kind !== "sessions" || !uuid.test(cursor.projectId)
        || typeof cursor.principalId !== "string" || !cursor.principalId.trim()
        || !Number.isSafeInteger(cursor.limit) || cursor.limit < 1 || cursor.limit > 100
        || !Number.isSafeInteger(cursor.expires) || !cursor.anchor
        || Object.keys(cursor.anchor).sort().join() !== "createdAt,pipelineSessionId"
        || !uuid.test(cursor.anchor.pipelineSessionId)
        || readTimestamp(cursor.anchor.createdAt) !== cursor.anchor.createdAt) throw invalid();
      return cursor;
    } catch {
      throw invalid();
    }
  }

  mismatch(cursor: Cursor, context: Context): boolean {
    return cursor.expires <= this.now() || cursor.projectId !== context.projectId
      || cursor.principalId !== context.principalId || cursor.limit !== context.limit;
  }
}

function precedes(row: Anchor, previous: Anchor): boolean {
  return row.createdAt > previous.createdAt
    || (row.createdAt === previous.createdAt && row.pipelineSessionId > previous.pipelineSessionId);
}

export class SessionReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: CoreApiAuthContext) => CoreApiAuthContext;
  private readonly cursor: SessionReadCursorCodec;

  constructor(store: ControlPlaneStore, verify: (auth: CoreApiAuthContext) => CoreApiAuthContext, mac: (data: string) => string) {
    this.store = store;
    this.verify = verify;
    this.cursor = new SessionReadCursorCodec(mac);
  }

  async read(auth: CoreApiAuthContext, projectId: string, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    let verified: CoreApiAuthContext;
    try {
      verified = this.verify(auth);
    } catch {
      throw forbidden();
    }
    if (!uuid.test(projectId)) throw invalid();
    if (verified.projectId !== projectId) throw forbidden();
    for (const key of query.keys()) {
      if ((key !== "limit" && key !== "cursor") || query.getAll(key).length !== 1) throw invalid();
    }
    const rawLimit = query.get("limit");
    if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) throw invalid();
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    const context = { projectId, principalId: verified.principalId, limit };
    const token = query.get("cursor");
    const cursor = token === null ? null : this.cursor.decode(token);

    try {
      const rows = await this.store.readSessionProjection({
        ...context, signedRoles: verified.roles, deadlineAt,
        after: cursor?.anchor ?? null,
        cursorContextMismatch: cursor !== null && this.cursor.mismatch(cursor, context),
      });
      if (rows.sessions.length > limit + 1) throw new Error("Invalid session row bound");
      let previous = cursor?.anchor ?? null;
      const all = rows.sessions.map((row) => {
        const item = {
          pipelineSessionId: row.pipeline_session_id,
          projectId: row.project_id,
          title: row.title,
          createdAt: readTimestamp(row.created_at),
          updatedAt: readTimestamp(row.updated_at),
        };
        if (item.projectId !== projectId || !uuid.test(item.pipelineSessionId) || typeof item.title !== "string"
          || (previous && !precedes(previous, item))) throw new Error("Invalid session projection row");
        previous = item;
        return item;
      });
      const items = all.slice(0, limit);
      const hasMore = all.length > limit;
      const result = {
        schemaVersion: "dashboard-read-v1" as const,
        fetchedAt: readTimestamp(rows.fetchedAt),
        projectId,
        items,
        page: { limit, hasMore, nextCursor: hasMore ? this.cursor.encode(context, items[items.length - 1]!) : null },
      };
      if (Date.now() >= deadlineAt || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error("Read response bound exceeded");
      return result;
    } catch (error) {
      if (error instanceof ProjectReadCursorContextError) throw new ReadProjectionError(409, "ERR_READ_CURSOR_CONTEXT");
      if (error instanceof PostgresRlsError && error.sqlState === "42501") throw forbidden();
      if (error instanceof PostgresRlsError && error.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
