import { timingSafeEqual } from "node:crypto";
import {
  PostgresRlsError, ProjectReadCursorContextError, readTimestamp, TIMELINE_UUID, timelineAnchor, compareTimeline, assertTimelineAnchor,
  type ControlPlaneStore, type TimelineReadInput,
} from "@software-factory/database";
import type { CoreApiAuthContext } from "./index.ts";
import { ReadProjectionError } from "./project-read-projection.ts";

const invalid = () => new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
const forbidden = () => new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
const cursorMaxBytes = 2048;
const cursorTtlMs = 15 * 60 * 1000;

type Context = Pick<TimelineReadInput, "projectId" | "pipelineSessionId" | "principalId" | "limit">;
type Anchor = NonNullable<TimelineReadInput["after"]>;
interface Cursor extends Context {
  v: 1;
  kind: "timeline";
  anchor: Anchor;
  expires: number;
}

export class TimelineReadCursorCodec {
  private readonly mac: (data: string) => string;
  private readonly now: () => number;

  constructor(mac: (data: string) => string, now = Date.now) {
    this.mac = mac;
    this.now = now;
  }

  encode(context: Context, anchor: Anchor): string {
    const { projectId, pipelineSessionId, principalId, limit } = context;
    const cursor: Cursor = {
      v: 1, kind: "timeline", projectId, pipelineSessionId, principalId, limit,
      anchor,
      expires: this.now() + cursorTtlMs,
    };
    const data = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const token = `${data}.${this.mac(data)}`;
    if (Buffer.byteLength(token) > cursorMaxBytes) throw new Error("Timeline cursor exceeds size limit");
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
      if (!cursor || JSON.stringify(cursor) !== raw || Object.keys(cursor).sort().join() !== "anchor,expires,kind,limit,pipelineSessionId,principalId,projectId,v"
        || cursor.v !== 1 || cursor.kind !== "timeline"
        || typeof cursor.projectId !== "string" || !TIMELINE_UUID.test(cursor.projectId)
        || typeof cursor.pipelineSessionId !== "string" || !TIMELINE_UUID.test(cursor.pipelineSessionId)
        || typeof cursor.principalId !== "string" || !cursor.principalId.trim()
        || !Number.isSafeInteger(cursor.limit) || cursor.limit < 1 || cursor.limit > 100
        || !Number.isSafeInteger(cursor.expires) || !cursor.anchor
        || Object.keys(cursor.anchor).sort().join() !== "rank,recordedAt,resourceId") throw invalid();
      assertTimelineAnchor(cursor.anchor);
      return cursor;
    } catch {
      throw invalid();
    }
  }

  mismatch(cursor: Cursor, context: Context): boolean {
    return cursor.expires <= this.now() || cursor.projectId !== context.projectId
      || cursor.pipelineSessionId !== context.pipelineSessionId || cursor.principalId !== context.principalId || cursor.limit !== context.limit;
  }
}

export class TimelineReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: CoreApiAuthContext) => CoreApiAuthContext;
  private readonly cursor: TimelineReadCursorCodec;

  constructor(store: ControlPlaneStore, verify: (auth: CoreApiAuthContext) => CoreApiAuthContext, mac: (data: string) => string) {
    this.store = store;
    this.verify = verify;
    this.cursor = new TimelineReadCursorCodec(mac);
  }

  async read(auth: CoreApiAuthContext | null, projectId: string, pipelineSessionId: string, query: URLSearchParams) {
    return (await this.readEncoded(auth, projectId, pipelineSessionId, query)).result;
  }

  async readEncoded(auth: CoreApiAuthContext | null, projectId: string, pipelineSessionId: string, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    if (!auth) throw new ReadProjectionError(401, "ERR_UNAUTHORIZED");
    let verified: CoreApiAuthContext;
    try {
      verified = this.verify(auth);
    } catch {
      throw forbidden();
    }
    if (TIMELINE_UUID.test(projectId) && verified.projectId !== projectId) throw forbidden();
    if (!TIMELINE_UUID.test(projectId) || !TIMELINE_UUID.test(pipelineSessionId)) throw invalid();
    for (const key of query.keys()) {
      if ((key !== "limit" && key !== "cursor") || query.getAll(key).length !== 1) throw invalid();
    }
    const rawLimit = query.get("limit");
    if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) throw invalid();
    const limit = rawLimit === null ? 20 : Number(rawLimit);
    const context = { projectId, pipelineSessionId, principalId: verified.principalId, limit };
    const token = query.get("cursor");
    const cursor = token === null ? null : this.cursor.decode(token);

    try {
      const rows = await this.store.readTimelineProjection({
        ...context, signedRoles: verified.roles, deadlineAt,
        after: cursor?.anchor ?? null,
        cursorContextMismatch: cursor !== null && this.cursor.mismatch(cursor, context),
      });
      if (rows.items.length > limit + 1) throw new Error("Invalid timeline row bound");
      let previous = cursor?.anchor ?? null;
      for (const item of rows.items) {
        const anchor = timelineAnchor(item);
        assertTimelineAnchor(anchor);
        if (previous && compareTimeline(previous, anchor) >= 0) throw new Error("Invalid timeline page order");
        previous = anchor;
      }
      const items = rows.items.slice(0, limit);
      const hasMore = rows.items.length > limit;
      const result = {
        schemaVersion: "timeline-v1" as const,
        fetchedAt: readTimestamp(rows.fetchedAt),
        scope: { kind: "project-token" as const, projectId, pipelineSessionId },
        items,
        page: { limit, hasMore, nextCursor: hasMore ? this.cursor.encode(context, timelineAnchor(items[items.length - 1]!)) : null },
      };
      const payload = Buffer.from(JSON.stringify(result), "utf8");
      if (Date.now() >= deadlineAt || payload.length > 1048576) throw new Error("Read response bound exceeded");
      return { result, payload };
    } catch (error) {
      if (error instanceof ProjectReadCursorContextError) throw new ReadProjectionError(409, "ERR_READ_CURSOR_CONTEXT");
      if (error instanceof PostgresRlsError && error.sqlState === "42501") throw forbidden();
      if (error instanceof PostgresRlsError && error.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
