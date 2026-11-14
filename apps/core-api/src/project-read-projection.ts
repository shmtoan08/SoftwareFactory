import { timingSafeEqual } from "node:crypto";
import { PostgresRlsError, ProjectReadCursorContextError, PROJECT_READ_ROLES, readTimestamp, type ControlPlaneStore, type ProjectReadDto } from "@software-factory/database";
import type { CoreApiAuthContext } from "./index.ts";
export class ReadProjectionError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(httpStatus: number, code: string) { super(code); this.httpStatus = httpStatus; this.code = code; }
}
const invalid = () => new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Cursor {
  v: 1; kind: "projects"; projectId: string; principalId: string; filters: readonly [];
  limit: number; anchor: { updatedAt: string; id: string }; expires: number;
}
export class ProjectReadCursorCodec {
  private readonly mac: (payload: string) => string;
  private readonly now: () => number;
  constructor(mac: (payload: string) => string, now: () => number = Date.now) { this.mac = mac; this.now = now; }
  encode(context: { projectId: string; principalId: string; limit: number }, row: ProjectReadDto): string {
    const body: Cursor = { v: 1, kind: "projects", ...context, filters: [], anchor: { updatedAt: row.updatedAt, id: row.projectId }, expires: this.now() + 900000 };
    const data = Buffer.from(JSON.stringify(body)).toString("base64url");
    const token = `${data}.${this.mac(data)}`;
    if (Buffer.byteLength(token) > 2048) throw invalid();
    return token;
  }
  decode(token: string): Cursor {
    try {
      if (Buffer.byteLength(token) > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw invalid();
      const [data, signature] = token.split(".");
      const expected = this.mac(data!);
      if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature!, "hex"))) throw invalid();
      const bytes = Buffer.from(data!, "base64url");
      if (bytes.toString("base64url") !== data) throw invalid();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
      const c = value as Cursor;
      if (JSON.stringify(c) !== raw || Object.keys(c).sort().join() !== "anchor,expires,filters,kind,limit,principalId,projectId,v" || c.v !== 1 || c.kind !== "projects" || !uuid.test(c.projectId) || typeof c.principalId !== "string" || c.principalId.length < 1 || !Array.isArray(c.filters) || c.filters.length !== 0 || !Number.isSafeInteger(c.limit) || c.limit < 1 || c.limit > 100 || !Number.isSafeInteger(c.expires) || !c.anchor || typeof c.anchor !== "object" || Object.keys(c.anchor).sort().join() !== "id,updatedAt" || !uuid.test(c.anchor.id) || readTimestamp(c.anchor.updatedAt) !== c.anchor.updatedAt) throw invalid();
      return c;
    } catch { throw invalid(); }
  }
  isMismatch(cursor: Cursor, context: { projectId: string; principalId: string; limit: number }): boolean {
    return cursor.projectId !== context.projectId || cursor.principalId !== context.principalId || cursor.limit !== context.limit || cursor.expires <= this.now();
  }
}
export class ProjectReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: unknown, project: string) => CoreApiAuthContext;
  private readonly cursor: ProjectReadCursorCodec;
  constructor(store: ControlPlaneStore, verify: (auth: unknown, project: string) => CoreApiAuthContext, mac: (payload: string) => string) {
    this.store = store; this.verify = verify; this.cursor = new ProjectReadCursorCodec(mac);
  }
  async read(auth: CoreApiAuthContext, projectId: string | undefined, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    const target = projectId ?? (typeof auth?.projectId === "string" ? auth.projectId : "");
    let verified: CoreApiAuthContext;
    try { verified = this.verify(auth, target); }
    catch { throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS"); }
    if (!uuid.test(verified.projectId)) throw invalid();
    const detail = projectId !== undefined;
    for (const key of query.keys()) if ((detail || !["limit", "cursor"].includes(key)) || query.getAll(key).length !== 1) throw invalid();
    const limitValue = query.get("limit");
    if (limitValue !== null && (!/^[1-9][0-9]{0,2}$/.test(limitValue) || Number(limitValue) > 100)) throw invalid();
    const limit = detail ? 1 : limitValue === null ? 20 : Number(limitValue);
    const cursorValue = query.get("cursor");
    const cursor = cursorValue === null ? null : this.cursor.decode(cursorValue);
    const context = { projectId: verified.projectId, principalId: verified.principalId, limit };
    try {
      const rows = await this.store.readProjectProjection({ ...context, signedRoles: verified.roles, after: cursor?.anchor ?? null, cursorContextMismatch: cursor ? this.cursor.isMismatch(cursor, context) : false, deadlineAt });
      for (const row of rows.projects) {
        if (row.projectId !== verified.projectId || !uuid.test(row.projectId) || Object.keys(row).sort().join() !== "createdAt,defaultBranch,name,projectId,slug,updatedAt") throw new Error("Invalid projection DTO");
        for (const value of Object.values(row)) if (typeof value !== "string" || Buffer.byteLength(value) > 1048576) throw new Error("Invalid projection DTO");
        if (readTimestamp(row.createdAt) !== row.createdAt || readTimestamp(row.updatedAt) !== row.updatedAt) throw new Error("Invalid projection DTO");
      }
      if (readTimestamp(rows.fetchedAt) !== rows.fetchedAt || rows.projects.length > limit + 1) throw new Error("Invalid read result");
      const base = { schemaVersion: "dashboard-read-v1" as const, fetchedAt: rows.fetchedAt };
      const items = rows.projects.slice(0, limit);
      const hasMore = rows.projects.length > limit;
      const result = detail ? { ...base, project: items[0]! } : { ...base, scope: { kind: "project-token" as const, projectId: verified.projectId }, items, page: { limit, hasMore, nextCursor: hasMore ? this.cursor.encode(context, items[items.length - 1]!) : null } };
      if (detail && !items[0]) throw new PostgresRlsError("23503", "Project not found");
      if (Buffer.byteLength(JSON.stringify(result)) > 1048576 || Date.now() >= deadlineAt) throw new Error("Read response bound exceeded");
      return result;
    } catch (err) {
      if (err instanceof ProjectReadCursorContextError) throw new ReadProjectionError(409, "ERR_READ_CURSOR_CONTEXT");
      if (err instanceof PostgresRlsError && err.sqlState === "42501") throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
      if (err instanceof PostgresRlsError && err.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
export { PROJECT_READ_ROLES };
