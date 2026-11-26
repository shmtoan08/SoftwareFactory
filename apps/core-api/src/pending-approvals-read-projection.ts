import { timingSafeEqual } from "node:crypto";
import {
  comparePendingApprovals, pendingApprovalBoundary, PostgresRlsError, ProjectReadCursorContextError, readTimestamp,
  type PendingApprovalBoundary, type PendingApprovalsReadRows,
} from "@software-factory/database";
import type { CoreApiAuthContext } from "./index.ts";
import { ReadProjectionError } from "./project-read-projection.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cursorMaxBytes = 2048;
const cursorTtlMs = 15 * 60 * 1000;
const invalid = () => new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
const forbidden = () => new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");

type Context = { projectId: string; principalId: string; limit: number };
type Cursor = Context & { v: 1; kind: "pending-approvals"; anchor: PendingApprovalBoundary; expires: number };

function assertBoundary(anchor: PendingApprovalBoundary): void {
  if (!anchor || Object.keys(anchor).sort().join() !== "createdAt,id,rank"
    || typeof anchor.id !== "string" || !uuid.test(anchor.id)
    || (anchor.rank !== 0 && anchor.rank !== 1)
    || typeof anchor.createdAt !== "string" || readTimestamp(anchor.createdAt) !== anchor.createdAt) throw invalid();
}

export class PendingApprovalsCursorCodec {
  private readonly mac: (data: string) => string;
  private readonly now: () => number;

  constructor(mac: (data: string) => string, now = Date.now) {
    this.mac = mac;
    this.now = now;
  }

  encode(context: Context, anchor: PendingApprovalBoundary): string {
    assertBoundary(anchor);
    const cursor: Cursor = { v: 1, kind: "pending-approvals", ...context, anchor, expires: this.now() + cursorTtlMs };
    const data = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const token = `${data}.${this.mac(data)}`;
    if (Buffer.byteLength(token) > cursorMaxBytes) throw new Error("Pending approvals cursor exceeds size limit");
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
        || cursor.v !== 1 || cursor.kind !== "pending-approvals"
        || typeof cursor.projectId !== "string" || !uuid.test(cursor.projectId)
        || typeof cursor.principalId !== "string" || !cursor.principalId.trim()
        || !Number.isSafeInteger(cursor.limit) || cursor.limit < 1 || cursor.limit > 100
        || !Number.isSafeInteger(cursor.expires)) throw invalid();
      assertBoundary(cursor.anchor);
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

export async function encodePendingApprovalsPage(options: {
  auth: CoreApiAuthContext | null;
  projectId: string;
  query: URLSearchParams;
  verify: (auth: CoreApiAuthContext) => CoreApiAuthContext;
  cursor: PendingApprovalsCursorCodec;
  rejectContext: (auth: CoreApiAuthContext, deadlineAt: number) => Promise<void>;
  read: (auth: CoreApiAuthContext, limit: number, after?: PendingApprovalBoundary) => Promise<PendingApprovalsReadRows>;
}): Promise<Buffer> {
  const { auth, projectId, query, cursor } = options;
  const deadlineAt = Date.now() + 5000;
  if (!auth) throw new ReadProjectionError(401, "ERR_UNAUTHORIZED");
  let verified: CoreApiAuthContext;
  try {
    verified = options.verify(auth);
  } catch {
    throw forbidden();
  }
  if (!uuid.test(projectId)) throw invalid();
  if (verified.projectId !== projectId) throw forbidden();
  for (const key of query.keys()) {
    if ((key !== "limit" && key !== "cursor") || query.getAll(key).length !== 1) throw invalid();
  }
  const rawLimit = query.get("limit");
  if (rawLimit !== null && !/^(?:[1-9][0-9]?|100)$/.test(rawLimit)) throw invalid();
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  const context = { projectId, principalId: verified.principalId, limit };
  const token = query.get("cursor");
  const continuation = token === null ? null : cursor.decode(token);

  try {
    if (continuation && cursor.mismatch(continuation, context)) {
      await options.rejectContext(verified, deadlineAt);
      throw new Error("Cursor context guard did not reject");
    }
    const { fetchedAt, items: candidates } = await options.read(verified, limit, continuation?.anchor);
    if (candidates.length > limit + 1) throw new Error("Invalid pending approvals row bound");
    let previous = continuation?.anchor;
    for (const item of candidates) {
      const anchor = pendingApprovalBoundary(item);
      assertBoundary(anchor);
      if (previous && comparePendingApprovals(previous, anchor) >= 0) throw new Error("Invalid pending approvals order");
      previous = anchor;
    }
    const items = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const payload = Buffer.from(JSON.stringify({
      schemaVersion: "pending-approvals-v1",
      fetchedAt: readTimestamp(fetchedAt),
      scope: { kind: "project-token", projectId },
      items,
      page: { limit, hasMore, nextCursor: hasMore ? cursor.encode(context, pendingApprovalBoundary(items[items.length - 1]!)) : null },
    }), "utf8");
    if (Date.now() >= deadlineAt || payload.length > 1048576) throw new Error("Pending approvals response bound exceeded");
    return payload;
  } catch (error) {
    if (error instanceof ProjectReadCursorContextError) throw new ReadProjectionError(409, "ERR_READ_CURSOR_CONTEXT");
    if (error instanceof PostgresRlsError && error.sqlState === "42501") throw forbidden();
    throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
  }
}
