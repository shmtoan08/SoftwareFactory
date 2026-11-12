import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAgentRuntimeAdapterFromEnv } from "@software-factory/adapter-sdk";
import type {
  AgentExecutionResult,
  AgentRuntimeAdapter,
  AgentTaskContext,
} from "@software-factory/adapter-sdk";
import type {
  ResourceUsageMetricRecord,
  ServerEventAckContract,
  TaskLeaseRecord,
  TaskRecord,
} from "@software-factory/shared-types";
import type { TaskContractSpec } from "@software-factory/task-contract";
import {
  type AgentGatewayTransportClient,
  LinuxCgroupV2SandboxBackend,
  LocalOutboxBuffer,
  type SandboxCleanupEvidence,
  type SandboxResourceMetricsSnapshot,
  type SandboxSecurityMetadata,
} from "./index.ts";

async function runGitCommandAsync(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000).unref();
    }, options.timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const reason = timedOut
        ? `git ${options.args[0] ?? "command"} timed out after ${options.timeoutMs}ms`
        : `git ${options.args[0] ?? "command"} failed with exit code ${String(code)} (signal=${String(signal)})`;
      rejectPromise(new Error(`${reason}\n${stderr}${stdout}`.trim()));
    });
  });
}

export interface WnaWorkerDaemonOptions {
  readonly gateway: AgentGatewayTransportClient;
  readonly worktreeBaseDir: string;
  readonly outboxDir: string;
  readonly sandboxBackend?: LinuxCgroupV2SandboxBackend;
  readonly runtimeAdapter?: AgentRuntimeAdapter;
  readonly env?: NodeJS.ProcessEnv;
}

export interface WnaLeaseExecutionInput {
  readonly task: TaskRecord;
  readonly lease: TaskLeaseRecord;
  readonly repoBarePath: string;
  readonly gitPushToken: string;
  readonly preReceiveUrl?: string;
  readonly adapter?: AgentRuntimeAdapter;
  readonly modelProviderConfig?: AgentTaskContext["modelProviderConfig"];
  readonly previousFailureFeedbackMd?: string | null;
  readonly stagingRefKind?: "verify" | "staging";
  readonly requireKernelCgroup?: boolean;
  readonly requireSubreaper?: boolean;
  readonly requireNamespaceIsolation?: boolean;
  readonly isolateNamespaces?: boolean;
  readonly dropPrivileges?: boolean;
  readonly hostEnvironmentToSanitize?: Readonly<Record<string, string | undefined>>;
  /** Fault injection: simulate worker crash right after git push succeeds, before sending task.completed */
  readonly simulateCrashAfterPushBeforeCompletedEvent?: boolean;
  /** Fault injection: trigger reconnect/replay sync explicitly after task.completed send attempt */
  readonly forceReconnectSyncReplayCheck?: boolean;
}

export interface WnaLeaseExecutionResult {
  readonly outcome:
    | "COMPLETED"
    | "FAILED"
    | "FENCED_STALE_LEASE"
    | "SIMULATED_CRASH_BEFORE_COMPLETED";
  readonly worktreePath: string;
  readonly stagingRef: string;
  readonly outboxFilePath: string | null;
  readonly agentExecution: AgentExecutionResult | null;
  readonly pushedCommitHash: string | null;
  readonly pushStdout: string;
  readonly securityMetadata: SandboxSecurityMetadata | null;
  readonly cleanupEvidence: SandboxCleanupEvidence | null;
  readonly metricsSnapshot: SandboxResourceMetricsSnapshot | null;
  readonly recordedMetric: ResourceUsageMetricRecord | null;
  readonly outboxAcks: readonly ServerEventAckContract[];
  readonly reconnectSyncInvoked: boolean;
  readonly error?: string;
}

/**
 * Live Worker Node Agent (WNA) Daemon (`MVP-SPEC-03` & `M5`).
 * Manages the full end-to-end execution lifecycle of an assigned `TaskLease`:
 * 1. Creates an isolated detached Git worktree at `B_base` (`<worktreeBaseDir>/<taskId>/epoch-<N>`).
 * 2. Opens persistent `LocalOutboxBuffer` (`0600` `.jsonl` WAL) and emits `task.accepted` / `task.started`.
 * 3. Launches `AgentRuntimeAdapter` inside `LinuxCgroupV2SandboxBackend` with clean `env -i` sanitization.
 * 4. Emits `task.progress`, pushes real Git commit to staging ref through `pre-receive` gatekeeper hook.
 * 5. Kills & verifies sandbox cleanup (`populated.zero`), records honest `DEVELOPER` metrics (`AC-12a`),
 *    and delivers `task.completed` (or `task.failed`) with automatic reconnect sync+replay on transient failures.
 * 6. Removes the ephemeral worktree in `finally`.
 */
export class WnaWorkerDaemon {
  private readonly gateway: AgentGatewayTransportClient;
  private readonly worktreeBaseDir: string;
  private readonly outboxDir: string;
  private readonly runtimeAdapter?: AgentRuntimeAdapter;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  public readonly sandboxBackend: LinuxCgroupV2SandboxBackend;

  constructor(options: WnaWorkerDaemonOptions) {
    this.gateway = options.gateway;
    this.runtimeAdapter = options.runtimeAdapter;
    this.runtimeEnv = options.env ?? process.env;
    this.worktreeBaseDir = resolve(options.worktreeBaseDir);
    this.outboxDir = resolve(options.outboxDir);
    this.sandboxBackend = options.sandboxBackend ?? new LinuxCgroupV2SandboxBackend();
  }

  private async flushOutboxWithReconnect(
    outbox: LocalOutboxBuffer,
    allAcks: ServerEventAckContract[],
    forceSyncReplay = false
  ): Promise<{ reconnectSyncInvoked: boolean }> {
    let reconnectSyncInvoked = false;
    try {
      const acks = await outbox.sendOrReplay(this.gateway);
      allAcks.push(...acks);
      if (forceSyncReplay && !outbox.isFenced()) {
        reconnectSyncInvoked = true;
        const syncRes = await outbox.syncAndReplayAfterReconnect(this.gateway);
        allAcks.push(...syncRes.acks);
      }
    } catch {
      reconnectSyncInvoked = true;
      const maxReconnectAttempts = 3;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxReconnectAttempts; attempt += 1) {
        try {
          const syncRes = await outbox.syncAndReplayAfterReconnect(this.gateway);
          allAcks.push(...syncRes.acks);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < maxReconnectAttempts) {
            await new Promise((r) => setTimeout(r, 20 * attempt));
          }
        }
      }
      if (lastErr !== undefined) {
        throw lastErr;
      }
    }
    return { reconnectSyncInvoked };
  }

  public async executeLease(input: WnaLeaseExecutionInput): Promise<WnaLeaseExecutionResult> {
    const { task, lease } = input;
    const stagingRef =
      input.stagingRefKind === "staging"
        ? `refs/heads/sf/staging/${task.task_id}/${lease.lease_epoch}`
        : `refs/factory/Verify/${task.task_id}/${lease.lease_epoch}`;

    const taskWorktreeRoot = join(this.worktreeBaseDir, task.task_id);
    const worktreePath = join(taskWorktreeRoot, `epoch-${lease.lease_epoch}`);
    mkdirSync(taskWorktreeRoot, { recursive: true, mode: 0o755 });
    mkdirSync(this.outboxDir, { recursive: true, mode: 0o700 });

    const outbox = new LocalOutboxBuffer({
      projectId: task.project_id,
      taskId: task.task_id,
      attemptNo: lease.attempt_no,
      leaseId: lease.lease_id,
      leaseEpoch: lease.lease_epoch,
      workerId: lease.worker_id,
      sandboxBackend: this.sandboxBackend,
      outboxDir: this.outboxDir,
    });

    const outboxAcks: ServerEventAckContract[] = [];
    let reconnectSyncInvoked = false;
    let securityMetadata: SandboxSecurityMetadata | null = null;
    let cleanupEvidence: SandboxCleanupEvidence | null = null;
    let metricsSnapshot: SandboxResourceMetricsSnapshot | null = null;
    let recordedMetric: ResourceUsageMetricRecord | null = null;
    let agentExecution: AgentExecutionResult | null = null;
    let pushedCommitHash: string | null = null;
    let pushStdout = "";
    let currentPhase = "worktree_prepare";
    let terminalEventEnqueued = false;
    let invocationContext: AgentTaskContext | undefined;
    let invocationAdapter: AgentRuntimeAdapter | undefined;

    const reportDeveloperMetric = async (
      snap: SandboxResourceMetricsSnapshot | null,
      fallbackBackendMode: string
    ): Promise<ResourceUsageMetricRecord | null> => {
      if (!this.gateway.reportResourceUsageMetric || !snap) {
        return null;
      }
      try {
        return await this.gateway.reportResourceUsageMetric({
          project_id: task.project_id,
          task_id: task.task_id,
          lease_id: lease.lease_id,
          lease_epoch: lease.lease_epoch,
          attempt_no: lease.attempt_no,
          rework_cycle: task.rework_count,
          phase: "DEVELOPER",
          wall_time_ms: snap.wallTimeMs,
          cpu_usage_usec: snap.cpuUsageUsec,
          peak_memory_bytes: snap.peakMemoryBytes,
          sandbox_backend_mode: snap.backendMode ?? fallbackBackendMode,
          metrics_source: snap.metricsSource,
        });
      } catch {
        return null;
      }
    };

    try {
      if (existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          execFileSync("git", ["worktree", "prune"], {
            cwd: input.repoBarePath,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          });
        } catch {
          // best-effort prune
        }
      }

      execFileSync(
        "git",
        ["worktree", "add", "--detach", worktreePath, task.base_main_commit_hash],
        {
          cwd: input.repoBarePath,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        }
      );

      currentPhase = "task_accepted";
      outbox.enqueueEvent("task.accepted", {
        worker_id: lease.worker_id,
        worktree_path: worktreePath,
      });
      const r1 = await this.flushOutboxWithReconnect(outbox, outboxAcks);
      reconnectSyncInvoked = reconnectSyncInvoked || r1.reconnectSyncInvoked;
      if (outbox.isFenced()) {
        terminalEventEnqueued = true;
        return {
          outcome: "FENCED_STALE_LEASE",
          worktreePath,
          stagingRef,
          outboxFilePath: outbox.outboxFilePath,
          agentExecution: null,
          pushedCommitHash: null,
          pushStdout: "",
          securityMetadata: null,
          cleanupEvidence: this.sandboxBackend.getLastCleanupEvidence(task.task_id, lease.lease_epoch) ?? null,
          metricsSnapshot: this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch),
          recordedMetric: null,
          outboxAcks,
          reconnectSyncInvoked,
        };
      }

      currentPhase = "task_started";
      outbox.enqueueEvent("task.started", {
        worktree_path: worktreePath,
        base_main_commit_hash: task.base_main_commit_hash,
      });
      const r2 = await this.flushOutboxWithReconnect(outbox, outboxAcks);
      reconnectSyncInvoked = reconnectSyncInvoked || r2.reconnectSyncInvoked;
      if (outbox.isFenced()) {
        terminalEventEnqueued = true;
        return {
          outcome: "FENCED_STALE_LEASE",
          worktreePath,
          stagingRef,
          outboxFilePath: outbox.outboxFilePath,
          agentExecution: null,
          pushedCommitHash: null,
          pushStdout: "",
          securityMetadata: null,
          cleanupEvidence: this.sandboxBackend.getLastCleanupEvidence(task.task_id, lease.lease_epoch) ?? null,
          metricsSnapshot: this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch),
          recordedMetric: null,
          outboxAcks,
          reconnectSyncInvoked,
        };
      }

      const agentCtx: AgentTaskContext = {
        projectId: task.project_id,
        taskId: task.task_id,
        leaseId: lease.lease_id,
        leaseEpoch: lease.lease_epoch,
        worktreePath,
        baseMainCommitHash: task.base_main_commit_hash,
        taskTitle: task.title,
        taskContract: task.task_contract_json as unknown as TaskContractSpec,
        reworkCycle: task.rework_count,
        previousFailureFeedbackMd: input.previousFailureFeedbackMd,
        modelProviderConfig: input.modelProviderConfig,
        ephemeralGitPushToken: input.gitPushToken,
        hostEnvironmentToSanitize: input.hostEnvironmentToSanitize,
      };

      currentPhase = "agent_prepare";
      const adapter = input.adapter ?? this.runtimeAdapter ??
        (this.runtimeEnv.SF_AGENT_RUNTIME ? loadAgentRuntimeAdapterFromEnv(this.runtimeEnv) : undefined);
      if (!adapter) throw new Error("ERR_AGENT_RUNTIME_NOT_CONFIGURED: provide an adapter or SF_AGENT_RUNTIME");
      invocationContext = agentCtx;
      invocationAdapter = adapter;
      const plan = await adapter.prepareInvocation(agentCtx);
      currentPhase = "sandbox_spawn";
      const spawnRes = this.sandboxBackend.spawnRealProcessInSandbox({
        taskId: task.task_id,
        leaseEpoch: lease.lease_epoch,
        command: plan.binaryPath,
        args: plan.args,
        sanitizedEnv: plan.sanitizedEnv,
        cwd: worktreePath,
        worktreePath,
        requireKernelCgroup: input.requireKernelCgroup,
        requireSubreaper: input.requireSubreaper,
        requireNamespaceIsolation: input.requireNamespaceIsolation,
        isolateNamespaces: input.isolateNamespaces,
        dropPrivileges: input.dropPrivileges,
      });
      securityMetadata = spawnRes.securityMetadata;

      currentPhase = "agent_execute";
      let timedOut = false;
      let agentTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const exitRes = await Promise.race([
        spawnRes.exitPromise,
        new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdoutTail?: string; stderrTail?: string }>(
          (resolveTimeout) => {
            agentTimeoutId = setTimeout(() => {
              timedOut = true;
              resolveTimeout({ code: 124, signal: "SIGKILL", stdoutTail: "", stderrTail: "Agent execution timeout" });
            }, plan.timeoutMs);
          }
        ),
      ]).finally(() => {
        if (agentTimeoutId !== undefined) {
          clearTimeout(agentTimeoutId);
        }
      });

      if (timedOut) {
        cleanupEvidence = await this.sandboxBackend.killAndVerifyClean(task.task_id, lease.lease_epoch);
      }

      agentExecution = await adapter.parseExecutionResult(
        agentCtx,
        exitRes.code ?? 1,
        exitRes.stdoutTail ?? "",
        exitRes.stderrTail ?? ""
      );

      if (agentExecution.exitCode !== 0 || !agentExecution.agentCommitHash) {
        if (!cleanupEvidence) {
          cleanupEvidence = await this.sandboxBackend.killAndVerifyClean(task.task_id, lease.lease_epoch);
        }
        metricsSnapshot = this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch);
        recordedMetric = await reportDeveloperMetric(
          metricsSnapshot,
          securityMetadata.backendMode
        );
        const failureReason =
          agentExecution.error ?? `Agent exited with code ${agentExecution.exitCode}`;
        terminalEventEnqueued = true;
        outbox.enqueueEvent("task.failed", {
          error: failureReason,
          exit_code: agentExecution.exitCode,
          phase: currentPhase,
        });
        const rf = await this.flushOutboxWithReconnect(outbox, outboxAcks);
        reconnectSyncInvoked = reconnectSyncInvoked || rf.reconnectSyncInvoked;
        return {
          outcome: outbox.isFenced() ? "FENCED_STALE_LEASE" : "FAILED",
          worktreePath,
          stagingRef,
          outboxFilePath: outbox.outboxFilePath,
          agentExecution,
          pushedCommitHash: null,
          pushStdout: "",
          securityMetadata,
          cleanupEvidence,
          metricsSnapshot,
          recordedMetric,
          outboxAcks,
          reconnectSyncInvoked,
          error: failureReason,
        };
      }

      currentPhase = "task_progress";
      outbox.enqueueEvent("task.progress", {
        phase: "staging_push_ready",
        agent_commit_hash: agentExecution.agentCommitHash,
        verified_tree_hash: agentExecution.verifiedTreeHash,
      });
      const r3 = await this.flushOutboxWithReconnect(outbox, outboxAcks);
      reconnectSyncInvoked = reconnectSyncInvoked || r3.reconnectSyncInvoked;
      if (outbox.isFenced()) {
        terminalEventEnqueued = true;
        cleanupEvidence =
          this.sandboxBackend.getLastCleanupEvidence(task.task_id, lease.lease_epoch) ??
          (await this.sandboxBackend.killAndVerifyClean(task.task_id, lease.lease_epoch));
        metricsSnapshot = this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch);
        return {
          outcome: "FENCED_STALE_LEASE",
          worktreePath,
          stagingRef,
          outboxFilePath: outbox.outboxFilePath,
          agentExecution,
          pushedCommitHash: null,
          pushStdout: "",
          securityMetadata,
          cleanupEvidence,
          metricsSnapshot,
          recordedMetric: null,
          outboxAcks,
          reconnectSyncInvoked,
        };
      }

      currentPhase = "staging_push";
      const pushResult = await runGitCommandAsync({
        args: ["push", input.repoBarePath, `${agentExecution.agentCommitHash}:${stagingRef}`],
        cwd: worktreePath,
        env: {
          PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          GIT_TERMINAL_PROMPT: "0",
          SF_GIT_LEASE_TOKEN: input.gitPushToken,
          ...(input.preReceiveUrl ? { SF_GATEWAY_PRE_RECEIVE_URL: input.preReceiveUrl } : {}),
        },
        timeoutMs: 60_000,
      });
      pushStdout = `${pushResult.stdout ?? ""}${pushResult.stderr ?? ""}`;
      pushedCommitHash = agentExecution.agentCommitHash;

      if (!cleanupEvidence) {
        cleanupEvidence = await this.sandboxBackend.killAndVerifyClean(task.task_id, lease.lease_epoch);
      }
      metricsSnapshot = this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch);

      if (input.simulateCrashAfterPushBeforeCompletedEvent) {
        terminalEventEnqueued = true;
        return {
          outcome: "SIMULATED_CRASH_BEFORE_COMPLETED",
          worktreePath,
          stagingRef,
          outboxFilePath: outbox.outboxFilePath,
          agentExecution,
          pushedCommitHash,
          pushStdout,
          securityMetadata,
          cleanupEvidence,
          metricsSnapshot,
          recordedMetric: null,
          outboxAcks,
          reconnectSyncInvoked,
        };
      }

      recordedMetric = await reportDeveloperMetric(
        metricsSnapshot,
        securityMetadata.backendMode
      );

      currentPhase = "task_completed";
      terminalEventEnqueued = true;
      outbox.enqueueEvent("task.completed", {
        agent_commit_hash: agentExecution.agentCommitHash,
        verified_tree_hash: agentExecution.verifiedTreeHash,
        staging_ref: stagingRef,
        writer_provider: agentExecution.writerProvider,
        writer_model: agentExecution.writerModel,
      });
      const r4 = await this.flushOutboxWithReconnect(
        outbox,
        outboxAcks,
        input.forceReconnectSyncReplayCheck
      );
      reconnectSyncInvoked = reconnectSyncInvoked || r4.reconnectSyncInvoked;

      return {
        outcome: outbox.isFenced() ? "FENCED_STALE_LEASE" : "COMPLETED",
        worktreePath,
        stagingRef,
        outboxFilePath: outbox.outboxFilePath,
        agentExecution,
        pushedCommitHash,
        pushStdout,
        securityMetadata,
        cleanupEvidence,
        metricsSnapshot,
        recordedMetric,
        outboxAcks,
        reconnectSyncInvoked,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!cleanupEvidence) {
        try {
          cleanupEvidence = await this.sandboxBackend.killAndVerifyClean(
            task.task_id,
            lease.lease_epoch
          );
        } catch {
          // best-effort cleanup on failure
        }
      }
      if (!metricsSnapshot) {
        try {
          metricsSnapshot = this.sandboxBackend.readMetrics(task.task_id, lease.lease_epoch);
        } catch {
          // ignore metrics read failure
        }
      }
      if (!recordedMetric && metricsSnapshot) {
        recordedMetric = await reportDeveloperMetric(
          metricsSnapshot,
          securityMetadata?.backendMode ??
            (process.platform === "linux" ? "linux-supervisor" : "real-process")
        );
      }
      if (!terminalEventEnqueued && !outbox.isFenced()) {
        terminalEventEnqueued = true;
        outbox.enqueueEvent("task.failed", {
          error: errorMsg,
          phase: currentPhase,
        });
        try {
          const rf = await this.flushOutboxWithReconnect(outbox, outboxAcks);
          reconnectSyncInvoked = reconnectSyncInvoked || rf.reconnectSyncInvoked;
          return {
            outcome: outbox.isFenced() ? "FENCED_STALE_LEASE" : "FAILED",
            worktreePath,
            stagingRef,
            outboxFilePath: outbox.outboxFilePath,
            agentExecution,
            pushedCommitHash,
            pushStdout,
            securityMetadata,
            cleanupEvidence,
            metricsSnapshot,
            recordedMetric,
            outboxAcks,
            reconnectSyncInvoked,
            error: errorMsg,
          };
        } catch {
          // If gateway itself is unreachable while flushing task.failed, keep event in WAL and rethrow original error
          throw err;
        }
      }
      throw err;
    } finally {
      try {
        if (!cleanupEvidence) {
          await this.sandboxBackend.killAndVerifyClean(task.task_id, lease.lease_epoch);
        }
      } catch {
        // best-effort cleanup
      }
      try {
        if (invocationContext) await invocationAdapter?.cleanupInvocation?.(invocationContext);
      } catch { /* worktree cleanup must still run if runtime state cleanup fails */ }
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
          cwd: input.repoBarePath,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
        try {
          execFileSync("git", ["worktree", "prune"], {
            cwd: input.repoBarePath,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          });
        } catch {
          // ignore
        }
      }
    }
  }
}
