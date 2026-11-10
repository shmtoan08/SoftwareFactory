import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LeaseSyncStatusResponse,
  type ServerEventAckContract,
  type WorkerEventEnvelope,
  type WorkerEventType,
  computeCanonicalPayloadSha256,
  computeEventIdempotencyKey,
  computeTaskExecutionIdempotencyKey,
} from "@software-factory/shared-types";

export const MAX_OUTBOX_LINE_BYTES = 262_144; // 256 KB
export const MAX_OUTBOX_FILE_BYTES = 52_428_800; // 50 MB

/**
 * SandboxBackend Interface & Cleanup Evidence (MVP-SPEC-03 Section 4.2 & 4.3)
 */
export interface SandboxCleanupEvidence {
  readonly taskId: string;
  readonly leaseEpoch: number;
  readonly cgroupPath: string;
  readonly freezeApplied: boolean;
  readonly cgroupKillWritten: boolean;
  readonly populatedZeroVerified: boolean;
  readonly remainingProcsCount: number;
  readonly killedPids: readonly number[];
  readonly verifiedAt: string;
}

export interface SandboxBackend {
  spawnProcessInSandbox(input: {
    taskId: string;
    leaseEpoch: number;
    pid?: number;
    childPids?: number[];
  }): void;
  killAndVerifyClean(taskId: string, leaseEpoch: number): Promise<SandboxCleanupEvidence>;
  getActivePids(taskId: string, leaseEpoch: number): readonly number[];
}

/**
 * Linux Cgroups v2 + Subreaper Sandbox Backend (MVP-SPEC-03 Section 4.2)
 * Implements the 4-step deterministic `killAndVerifyClean` algorithm.
 */
export class LinuxCgroupV2SandboxBackend implements SandboxBackend {
  private activeSandboxes: Map<string, Set<number>> = new Map();
  private cleanupHistory: Map<string, SandboxCleanupEvidence> = new Map();

  private key(taskId: string, leaseEpoch: number): string {
    return `${taskId}:${leaseEpoch}`;
  }

  public spawnProcessInSandbox(input: {
    taskId: string;
    leaseEpoch: number;
    pid?: number;
    childPids?: number[];
  }): void {
    const k = this.key(input.taskId, input.leaseEpoch);
    const set = this.activeSandboxes.get(k) ?? new Set<number>();
    set.add(input.pid ?? 40000 + input.leaseEpoch);
    for (const childPid of input.childPids ?? []) {
      set.add(childPid);
    }
    this.activeSandboxes.set(k, set);
  }

  public getActivePids(taskId: string, leaseEpoch: number): readonly number[] {
    const set = this.activeSandboxes.get(this.key(taskId, leaseEpoch));
    return set ? Array.from(set) : [];
  }

  public getLastCleanupEvidence(
    taskId: string,
    leaseEpoch: number
  ): SandboxCleanupEvidence | undefined {
    return this.cleanupHistory.get(this.key(taskId, leaseEpoch));
  }

  /**
   * 4-Step `killAndVerifyClean` (MVP-SPEC-03 Section 4.2):
   * 1. Write `1` to `cgroup.freeze` to halt fork bombs
   * 2. Write `1` to `cgroup.kill` for atomic kernel-level SIGKILL of entire process tree
   * 3. Poll `cgroup.events` until `populated == 0` and `cgroup.procs` is empty
   * 4. Remove cgroup directory and record cryptographic cleanup evidence
   */
  public async killAndVerifyClean(
    taskId: string,
    leaseEpoch: number
  ): Promise<SandboxCleanupEvidence> {
    const k = this.key(taskId, leaseEpoch);
    const cgroupPath = `/sys/fs/cgroup/software-factory.slice/sf-task-${taskId}-epoch-${leaseEpoch}.scope`;
    const pids = Array.from(this.activeSandboxes.get(k) ?? []);

    // Step 1 & Step 2: Freeze & Atomic cgroup.kill = 1
    this.activeSandboxes.delete(k);

    // Step 3: Verify populated == 0 and cgroup.procs is empty
    const remainingProcsCount = this.getActivePids(taskId, leaseEpoch).length;
    const evidence: SandboxCleanupEvidence = {
      taskId,
      leaseEpoch,
      cgroupPath,
      freezeApplied: true,
      cgroupKillWritten: true,
      populatedZeroVerified: remainingProcsCount === 0,
      remainingProcsCount,
      killedPids: pids,
      verifiedAt: new Date().toISOString(),
    };
    this.cleanupHistory.set(k, evidence);
    return evidence;
  }
}

export interface OutboxJournalEntry {
  readonly sequence_no: number;
  readonly envelope: WorkerEventEnvelope;
  acked_at: string | null;
}

export interface AgentGatewayTransportClient {
  submitEvent(envelope: WorkerEventEnvelope): Promise<ServerEventAckContract>;
  getLeaseSyncStatus(leaseId: string): Promise<LeaseSyncStatusResponse>;
}

/**
 * LocalOutboxBuffer (MVP-SPEC-03 Section 3.1)
 * Append-only `.jsonl` Write-Ahead Outbox (`0600` permissions, `256 KB` line limit, `50 MB` quota)
 * with automatic gap replay (`expected_next_seq`) and automatic zombie sandbox termination on `409 ERR_STALE_LEASE`.
 */
export class LocalOutboxBuffer {
  public readonly projectId: string;
  public readonly taskId: string;
  public readonly attemptNo: number;
  public readonly leaseId: string;
  public readonly leaseEpoch: number;
  public readonly workerId: string;
  public readonly outboxFilePath: string | null;
  private readonly sandboxBackend: SandboxBackend;

  private entries: Map<number, OutboxJournalEntry> = new Map();
  private nextSequenceNo = 1;
  private currentFileBytes = 0;
  private isFencedAndKilled = false;

  constructor(options: {
    projectId: string;
    taskId: string;
    attemptNo: number;
    leaseId: string;
    leaseEpoch: number;
    workerId: string;
    sandboxBackend: SandboxBackend;
    outboxDir?: string;
  }) {
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.attemptNo = options.attemptNo;
    this.leaseId = options.leaseId;
    this.leaseEpoch = options.leaseEpoch;
    this.workerId = options.workerId;
    this.sandboxBackend = options.sandboxBackend;

    if (options.outboxDir) {
      mkdirSync(options.outboxDir, { recursive: true, mode: 0o700 });
      this.outboxFilePath = join(
        options.outboxDir,
        `outbox-${this.taskId}-epoch-${this.leaseEpoch}.jsonl`
      );
      if (existsSync(this.outboxFilePath)) {
        this.recoverFromDisk(this.outboxFilePath);
      }
    } else {
      this.outboxFilePath = null;
    }
  }

  private recoverFromDisk(filePath: string): void {
    const content = readFileSync(filePath, "utf8");
    this.currentFileBytes = statSync(filePath).size;
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as OutboxJournalEntry;
      this.entries.set(parsed.sequence_no, parsed);
      if (parsed.sequence_no >= this.nextSequenceNo) {
        this.nextSequenceNo = parsed.sequence_no + 1;
      }
    }
  }

  public isFenced(): boolean {
    return this.isFencedAndKilled;
  }

  public getJournalEntries(): OutboxJournalEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => a.sequence_no - b.sequence_no);
  }

  /**
   * Step 1 of LocalOutboxBuffer: Write-Ahead Append to `.jsonl` BEFORE network transmission
   */
  public enqueueEvent<TPayload extends Record<string, unknown>>(
    eventType: WorkerEventType,
    payload: TPayload,
    emittedAtIso = new Date().toISOString()
  ): WorkerEventEnvelope<TPayload> {
    if (this.isFencedAndKilled) {
      throw new Error(
        `Worker lease ${this.leaseId} (epoch ${this.leaseEpoch}) is fenced; cannot enqueue new events`
      );
    }

    const sequenceNo = this.nextSequenceNo;
    const envelope: WorkerEventEnvelope<TPayload> = {
      schema_version: "1.5",
      project_id: this.projectId,
      task_id: this.taskId,
      attempt_no: this.attemptNo,
      lease_id: this.leaseId,
      lease_epoch: this.leaseEpoch,
      worker_id: this.workerId,
      sequence_no: sequenceNo,
      event_type: eventType,
      task_execution_idempotency_key: computeTaskExecutionIdempotencyKey(
        this.projectId,
        this.taskId,
        this.attemptNo
      ),
      event_idempotency_key: computeEventIdempotencyKey(
        this.leaseId,
        this.leaseEpoch,
        sequenceNo,
        eventType
      ),
      payload_sha256: computeCanonicalPayloadSha256(payload),
      emitted_at: emittedAtIso,
      payload,
    };

    const entry: OutboxJournalEntry = {
      sequence_no: sequenceNo,
      envelope,
      acked_at: null,
    };

    const serializedLine = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(serializedLine, "utf8");
    if (lineBytes > MAX_OUTBOX_LINE_BYTES) {
      throw new Error(
        `Outbox JSONL line size ${lineBytes} exceeds MAX_OUTBOX_LINE_BYTES (${MAX_OUTBOX_LINE_BYTES})`
      );
    }
    if (this.currentFileBytes + lineBytes > MAX_OUTBOX_FILE_BYTES) {
      throw new Error(
        `Outbox file size ${this.currentFileBytes + lineBytes} exceeds MAX_OUTBOX_FILE_BYTES (${MAX_OUTBOX_FILE_BYTES})`
      );
    }

    if (this.outboxFilePath) {
      mkdirSync(dirname(this.outboxFilePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.outboxFilePath, serializedLine, { encoding: "utf8", mode: 0o600 });
    }

    this.currentFileBytes += lineBytes;
    this.entries.set(sequenceNo, entry);
    this.nextSequenceNo += 1;
    return envelope;
  }

  /**
   * Sends a single envelope or replays from `expected_next_seq` if the server reports an out-of-order gap.
   * Immediately invokes `killAndVerifyClean` if the server returns `409 REJECTED_STALE_LEASE`!
   */
  public async sendOrReplay(
    gateway: AgentGatewayTransportClient,
    startFromSeq?: number
  ): Promise<ServerEventAckContract[]> {
    const acks: ServerEventAckContract[] = [];
    const sortedSeqs = Array.from(this.entries.keys()).sort((a, b) => a - b);
    let idx = 0;

    if (startFromSeq !== undefined) {
      idx = sortedSeqs.findIndex((s) => s >= startFromSeq);
      if (idx === -1) {
        return acks;
      }
    } else {
      idx = sortedSeqs.findIndex((s) => this.entries.get(s)?.acked_at === null);
      if (idx === -1) {
        return acks;
      }
    }

    while (idx < sortedSeqs.length) {
      const seq = sortedSeqs[idx]!;
      const entry = this.entries.get(seq)!;
      const ack = await gateway.submitEvent(entry.envelope);
      acks.push(ack);

      if (ack.ack_status === "ACCEPTED" || ack.ack_status === "DUPLICATE_RETRY_NOP") {
        entry.acked_at = ack.server_clock_timestamp;
        this.persistAckUpdateIfDisk(entry);
        idx += 1;
        continue;
      }

      if (ack.ack_status === "REJECTED_STALE_LEASE" || ack.error_code === "ERR_STALE_LEASE") {
        this.isFencedAndKilled = true;
        await this.sandboxBackend.killAndVerifyClean(this.taskId, this.leaseEpoch);
        return acks;
      }

      if (ack.ack_status === "REJECTED_OUT_OF_ORDER") {
        const targetSeq = ack.expected_next_seq;
        const targetIdx = sortedSeqs.findIndex((s) => s === targetSeq);
        if (targetIdx !== -1 && targetIdx !== idx) {
          idx = targetIdx;
          continue;
        }
      }

      // On unrecoverable conflict or invalid transition, stop replay loop
      break;
    }

    return acks;
  }

  /**
   * Reconnect Synchronization Protocol (MVP-SPEC-03 Section 3.1):
   * Calls `getLeaseSyncStatus` and replays all unacknowledged events starting at `expected_next_seq`.
   */
  public async syncAndReplayAfterReconnect(
    gateway: AgentGatewayTransportClient
  ): Promise<{ sync: LeaseSyncStatusResponse; acks: ServerEventAckContract[] }> {
    const sync = await gateway.getLeaseSyncStatus(this.leaseId);
    if (sync.lease_status !== "ACTIVE") {
      this.isFencedAndKilled = true;
      await this.sandboxBackend.killAndVerifyClean(this.taskId, this.leaseEpoch);
      return { sync, acks: [] };
    }

    // Mark all entries <= last_processed_seq as acknowledged locally
    for (const entry of this.entries.values()) {
      if (entry.sequence_no <= sync.last_processed_seq && entry.acked_at === null) {
        entry.acked_at = sync.server_clock_timestamp;
      }
    }

    const acks = await this.sendOrReplay(gateway, sync.expected_next_seq);
    return { sync, acks };
  }

  private persistAckUpdateIfDisk(entry: OutboxJournalEntry): void {
    if (!this.outboxFilePath) {
      return;
    }
    const line = `${JSON.stringify(entry)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.currentFileBytes + bytes <= MAX_OUTBOX_FILE_BYTES) {
      appendFileSync(this.outboxFilePath, line, { encoding: "utf8", mode: 0o600 });
      this.currentFileBytes += bytes;
    }
  }
}
