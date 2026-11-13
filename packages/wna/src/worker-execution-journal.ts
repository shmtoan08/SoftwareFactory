import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalizeJson, sha256Hex } from "@software-factory/shared-types";
import type { ExternalTargetAction } from "@software-factory/adapter-sdk";
import { validateCodeImportSubmission, type CodeImportSubmission } from "@software-factory/task-contract";
import type { SandboxCleanupEvidence } from "./index.ts";

export interface WorkerJournalRecord {
  readonly executionId: string;
  readonly actionSha256: string;
  readonly status: "CLAIMED" | "COMPLETED";
  readonly submission?: CodeImportSubmission;
  readonly cleanupEvidence?: SandboxCleanupEvidence;
}
export class WorkerJournalConflict extends Error {
  public readonly kind: "CONFLICT" | "HOLD";
  constructor(kind: "CONFLICT" | "HOLD") { super(`ERR_WORKER_${kind}`); this.kind = kind; }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Service-owned local filesystem only. Never use a task-writable or network filesystem. */
export class WorkerExecutionJournal {
  private readonly root: string;
  constructor(stateDir: string, tenantNamespace: string) {
    if (!isAbsolute(stateDir) || !/^[A-Za-z0-9._:-]{1,128}$/.test(tenantNamespace)) throw new Error("Invalid worker journal configuration");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Worker state directory must be private and service-owned");
    this.root = join(stateDir, sha256Hex(tenantNamespace));
    mkdirSync(this.root, { mode: 0o700, recursive: true });
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error("Invalid namespace directory");
    syncDirectory(stateDir);
  }
  private dir(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid worker execution ID");
    return join(this.root, id);
  }
  public read(action: ExternalTargetAction): WorkerJournalRecord | null {
    const path = this.dir(action.execution_id);
    try { if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new WorkerJournalConflict("HOLD"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const fd = openSync(join(path, "record.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string; try { if (lstatSync(join(path, "record.json")).size > 4 * 1024 * 1024) throw new Error("Journal limit"); raw = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
      const record = JSON.parse(raw) as WorkerJournalRecord;
      if (record.executionId !== action.execution_id || !["CLAIMED", "COMPLETED"].includes(record.status)) throw new WorkerJournalConflict("HOLD");
      if (record.actionSha256 !== sha256Hex(canonicalizeJson(action))) throw new WorkerJournalConflict("CONFLICT");
      if (record.status === "COMPLETED") validateCodeImportSubmission(record.submission);
      return record;
    } catch (error) { if (error instanceof WorkerJournalConflict) throw error; throw new WorkerJournalConflict("HOLD"); }
  }
  public claim(action: ExternalTargetAction): { created: boolean; record: WorkerJournalRecord } {
    const path = this.dir(action.execution_id);
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = this.read(action); if (!record) throw new WorkerJournalConflict("HOLD");
      return { created: false, record };
    }
    // A crash even before record persistence leaves an occupied directory: HOLD, never respawn.
    syncDirectory(this.root);
    const record: WorkerJournalRecord = { executionId: action.execution_id, actionSha256: sha256Hex(canonicalizeJson(action)), status: "CLAIMED" };
    this.persist(path, record);
    return { created: true, record };
  }
  public complete(action: ExternalTargetAction, submission: CodeImportSubmission, evidence: SandboxCleanupEvidence): void {
    const existing = this.read(action);
    if (!existing || existing.status !== "CLAIMED") throw new WorkerJournalConflict("HOLD");
    this.persist(this.dir(action.execution_id), { ...existing, status: "COMPLETED", submission: validateCodeImportSubmission(submission), cleanupEvidence: evidence });
  }
  private persist(dir: string, record: WorkerJournalRecord): void {
    const file = join(dir, `record-${randomUUID()}.tmp`);
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(file, join(dir, "record.json")); syncDirectory(dir); }
    catch (error) { try { unlinkSync(file); } catch { /* preserve original failure */ } throw error; }
  }
}
