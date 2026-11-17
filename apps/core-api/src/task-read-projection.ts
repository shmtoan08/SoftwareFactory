import { timingSafeEqual } from "node:crypto";
import { PostgresRlsError, ProjectReadCursorContextError, TASK_READ_STATUSES, TASK_READ_UUID, taskReadDto, readTimestamp, type ControlPlaneStore, type TaskReadDto } from "@software-factory/database";
import type { TaskStatus } from "@software-factory/shared-types";
import { ReadProjectionError } from "./project-read-projection.ts";
import type { CoreApiAuthContext } from "./index.ts";
const invalid = () => new ReadProjectionError(400, "ERR_READ_QUERY_INVALID");
interface Context { projectId: string; principalId: string; sessionId: string; sourceStatuses: readonly TaskStatus[]; limit: number; }
interface Cursor extends Context { v: 1; kind: "tasks"; anchor: { updatedAt: string; id: string }; expires: number; }
export class TaskReadCursorCodec {
  private readonly mac: (data: string) => string;
  private readonly now: () => number;
  constructor(mac: (data: string) => string, now = Date.now) { this.mac = mac; this.now = now; }
  encode(context: Context, row: TaskReadDto): string {
    const c: Cursor = { v: 1, kind: "tasks", ...context, anchor: { updatedAt: row.updatedAt, id: row.taskId }, expires: this.now() + 900000 };
    const data = Buffer.from(JSON.stringify(c)).toString("base64url"), token = `${data}.${this.mac(data)}`;
    if (Buffer.byteLength(token) > 2048) throw invalid();
    return token;
  }
  decode(token: string): Cursor {
    try {
      if (Buffer.byteLength(token) > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token)) throw invalid();
      const [data, sig] = token.split(".");
      if (!timingSafeEqual(Buffer.from(this.mac(data!), "hex"), Buffer.from(sig!, "hex"))) throw invalid();
      const bytes = Buffer.from(data!, "base64url");
      if (bytes.toString("base64url") !== data) throw invalid();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes), c: Cursor = JSON.parse(raw);
      if (!c || typeof c !== "object" || JSON.stringify(c) !== raw || Object.keys(c).sort().join() !== "anchor,expires,kind,limit,principalId,projectId,sessionId,sourceStatuses,v" || c.v !== 1 || c.kind !== "tasks" || !TASK_READ_UUID.test(c.projectId) || !TASK_READ_UUID.test(c.sessionId) || typeof c.principalId !== "string" || !c.principalId || !Number.isSafeInteger(c.limit) || c.limit < 1 || c.limit > 100 || !Number.isSafeInteger(c.expires) || !Array.isArray(c.sourceStatuses) || c.sourceStatuses.some(s => !TASK_READ_STATUSES.includes(s)) || JSON.stringify([...new Set(c.sourceStatuses)].sort()) !== JSON.stringify(c.sourceStatuses) || !c.anchor || Object.keys(c.anchor).sort().join() !== "id,updatedAt" || !TASK_READ_UUID.test(c.anchor.id) || readTimestamp(c.anchor.updatedAt) !== c.anchor.updatedAt) throw invalid();
      return c;
    } catch { throw invalid(); }
  }
  mismatch(c: Cursor, ctx: Context): boolean {
    return c.expires <= this.now() || c.projectId !== ctx.projectId || c.principalId !== ctx.principalId || c.sessionId !== ctx.sessionId || c.limit !== ctx.limit || JSON.stringify(c.sourceStatuses) !== JSON.stringify(ctx.sourceStatuses);
  }
}
export class TaskReadProjectionService {
  private readonly store: ControlPlaneStore;
  private readonly verify: (auth: unknown, project: string) => CoreApiAuthContext;
  private readonly cursor: TaskReadCursorCodec;
  constructor(store: ControlPlaneStore, verify: (auth: unknown, project: string) => CoreApiAuthContext, mac: (data: string) => string) { this.store = store; this.verify = verify; this.cursor = new TaskReadCursorCodec(mac); }
  async read(auth: CoreApiAuthContext, projectId: string, sessionId: string, query: URLSearchParams) {
    const deadlineAt = Date.now() + 5000;
    let verified: CoreApiAuthContext;
    try { verified = this.verify(auth, projectId); } catch { throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS"); }
    if (!TASK_READ_UUID.test(verified.projectId) || !TASK_READ_UUID.test(sessionId)) throw invalid();
    for (const key of query.keys()) if (!["limit", "cursor", "status"].includes(key) || (key !== "status" && query.getAll(key).length !== 1)) throw invalid();
    const rawLimit = query.get("limit");
    if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100)) throw invalid();
    const statuses = query.getAll("status");
    if (statuses.length > 11 || new Set(statuses).size !== statuses.length || statuses.some(s => !TASK_READ_STATUSES.includes(s as TaskStatus))) throw invalid();
    const ctx: Context = { projectId: verified.projectId, principalId: verified.principalId, sessionId, sourceStatuses: (statuses as TaskStatus[]).sort(), limit: rawLimit === null ? 25 : Number(rawLimit) };
    const token = query.get("cursor"), cursor = token === null ? null : this.cursor.decode(token);
    try {
      const rows = await this.store.readTaskProjection({ ...ctx, signedRoles: verified.roles, after: cursor?.anchor ?? null, cursorContextMismatch: cursor ? this.cursor.mismatch(cursor, ctx) : false, deadlineAt });
      if (rows.tasks.length > ctx.limit + 1) throw new Error("Invalid task row bound");
      const all = rows.tasks.map(row => taskReadDto(row, ctx));
      for (let i = 0; i < all.length; i++) {
        const row = all[i]!, prev = i ? all[i - 1]! : cursor?.anchor ? { updatedAt: cursor.anchor.updatedAt, taskId: cursor.anchor.id } : null;
        if ((ctx.sourceStatuses.length && !ctx.sourceStatuses.includes(row.sourceStatus)) || (prev && !(row.updatedAt < prev.updatedAt || (row.updatedAt === prev.updatedAt && row.taskId < prev.taskId)))) throw new Error("Invalid task ordering/filter");
      }
      const items = all.slice(0, ctx.limit), hasMore = all.length > ctx.limit;
      const result = { schemaVersion: "dashboard-read-v1" as const, fetchedAt: readTimestamp(rows.fetchedAt), projectId: ctx.projectId, sessionId, filters: { sourceStatuses: [...ctx.sourceStatuses], stage: null }, items, page: { limit: ctx.limit, hasMore, nextCursor: hasMore ? this.cursor.encode(ctx, items[items.length - 1]!) : null } };
      if (Date.now() >= deadlineAt || Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error("Read response bound exceeded");
      return result;
    } catch (err) {
      if (err instanceof ProjectReadCursorContextError) throw new ReadProjectionError(409, "ERR_READ_CURSOR_CONTEXT");
      if (err instanceof PostgresRlsError && err.sqlState === "42501") throw new ReadProjectionError(403, "ERR_FORBIDDEN_RLS");
      if (err instanceof PostgresRlsError && err.sqlState === "23503") throw new ReadProjectionError(404, "ERR_READ_RESOURCE_NOT_FOUND");
      throw new ReadProjectionError(500, "ERR_READ_PROJECTION_FAILED");
    }
  }
}
