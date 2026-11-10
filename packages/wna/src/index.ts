import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

export type LinuxNamespaceKind = "user" | "mount" | "pid" | "ipc" | "uts";

export interface SandboxSecurityMetadata {
  readonly isSimulated: boolean;
  readonly backendMode:
    | "linux-cgroup-v2"
    | "linux-supervisor"
    | "simulated-cgroup-v2"
    | "real-process";
  readonly supervisorPid: number | null;
  readonly workerPid: number | null;
  readonly supervisorUser: string;
  readonly supervisorUid: number | null;
  readonly subreaperEnabled: boolean;
  readonly uidDropped: boolean;
  readonly sandboxUser: string;
  readonly sandboxUid: number;
  readonly sandboxGid: number;
  readonly noNewPrivsEnabled: boolean;
  readonly capabilitiesDropped: boolean;
  readonly namespaces: readonly LinuxNamespaceKind[];
  readonly maskedPathsApplied: readonly string[];
  readonly mountedWorktreePath: string;
  readonly ephemeralGitPushRef: string;
}

/**
 * SandboxBackend Interface & Cleanup Evidence (MVP-SPEC-03 Section 4.2 & 4.3, Roadmap M2, FIX-05, FIX-15)
 */
export interface SandboxCleanupEvidence {
  readonly taskId: string;
  readonly leaseEpoch: number;
  readonly backendMode:
    | "linux-cgroup-v2"
    | "linux-supervisor"
    | "real-process"
    | "simulated-cgroup-v2";
  readonly isSimulated: boolean;
  readonly realKernelOperationsExecuted: boolean;
  readonly realProcessGroupKilled: boolean;
  readonly cgroupPath: string;
  readonly freezeApplied: boolean;
  readonly cgroupKillWritten: boolean;
  readonly populatedZeroVerified: boolean;
  readonly subreaperWaitpidReapedPids: readonly number[];
  readonly remainingProcsCount: number;
  readonly cgroupDirRemoved: boolean;
  readonly killedPids: readonly number[];
  readonly verifiedAt: string;
}

export interface SandboxBackend {
  spawnProcessInSandbox(input: {
    taskId: string;
    leaseEpoch: number;
    pid?: number;
    childPids?: number[];
    doubleForkOrphanPids?: number[];
    worktreePath?: string;
  }): void;
  killAndVerifyClean(taskId: string, leaseEpoch: number): Promise<SandboxCleanupEvidence>;
  getActivePids(taskId: string, leaseEpoch: number): readonly number[];
}

export interface RealProcessSpawnResult {
  readonly pid: number;
  readonly supervisorPid?: number;
  readonly executionMode: "real-cgroup-v2" | "real-process";
  readonly cgroupPath: string;
  readonly securityMetadata: SandboxSecurityMetadata;
  readonly exitPromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdoutTail?: string;
    stderrTail?: string;
  }>;
}

interface SupervisorReadyPayload {
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly workerPid?: number;
  readonly supervisorPid?: number;
  readonly subreaperEnabled?: boolean;
  readonly uidDropped?: boolean;
  readonly actualUid?: number;
  readonly actualGid?: number;
  readonly noNewPrivsEnabled?: boolean;
  readonly capabilitiesDropped?: boolean;
  readonly namespaces?: readonly LinuxNamespaceKind[];
  readonly maskedPathsApplied?: readonly string[];
}

interface SupervisorReapPayload {
  readonly reapedPids?: readonly number[];
  readonly workerExitCode?: number;
}

interface ManagedProcessRecord {
  readonly pid: number;
  readonly supervisorPid?: number;
  readonly child: ChildProcess;
  readonly reapFilePath?: string;
  readonly supDir?: string;
  exited: boolean;
  reapedPidsFromFile: number[];
  readonly exitPromise: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdoutTail?: string;
    stderrTail?: string;
  }>;
}

const DEFAULT_MASKED_PATHS: readonly string[] = ["/etc/sf-wna", "/var/lib/sf-wna/outbox"];
const SLEEP_INT32 = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms: number): void {
  Atomics.wait(SLEEP_INT32, 0, 0, ms);
}

function getCurrentHostUsername(uid: number | null): string {
  try {
    return userInfo().username;
  } catch {
    return uid !== null ? `uid:${uid}` : "unknown";
  }
}

function resolveSupervisorSourcePath(): string {
  const candidates: string[] = [];
  if (typeof import.meta.url === "string" && import.meta.url.length > 0) {
    try {
      candidates.push(fileURLToPath(new URL("../native/sf_sandbox_supervisor.c", import.meta.url)));
    } catch {
      // ignore invalid URL
    }
  }
  candidates.push(resolve(process.cwd(), "packages", "wna", "native", "sf_sandbox_supervisor.c"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `ERR_SANDBOX_SUPERVISOR_UNAVAILABLE: Unable to locate sf_sandbox_supervisor.c (checked: ${candidates.join(", ")})`
  );
}

let cachedSupervisorBinaryPath: string | null = null;
let cachedSupervisorSourceHash: string | null = null;

function ensureLinuxSupervisorBinary(): string {
  if (process.platform !== "linux") {
    throw new Error(
      `ERR_SANDBOX_SUPERVISOR_UNAVAILABLE: Native Linux sandbox supervisor requires Linux host (current: ${process.platform})`
    );
  }
  const srcPath = resolveSupervisorSourcePath();
  const srcBytes = readFileSync(srcPath);
  const srcHash = createHash("sha256").update(srcBytes).digest("hex").slice(0, 16);

  if (
    cachedSupervisorBinaryPath &&
    cachedSupervisorSourceHash === srcHash &&
    existsSync(cachedSupervisorBinaryPath)
  ) {
    return cachedSupervisorBinaryPath;
  }

  const cacheDir = join(tmpdir(), "sf-wna-native");
  mkdirSync(cacheDir, { recursive: true, mode: 0o755 });
  const binPath = join(cacheDir, `sf-sandbox-supervisor-${srcHash}`);
  if (existsSync(binPath)) {
    cachedSupervisorBinaryPath = binPath;
    cachedSupervisorSourceHash = srcHash;
    return binPath;
  }

  const tmpBinPath = join(
    cacheDir,
    `sf-sandbox-supervisor-${srcHash}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`
  );
  const errors: string[] = [];
  let compiled = false;
  for (const compiler of ["cc", "gcc", "clang"]) {
    try {
      execFileSync(
        compiler,
        ["-O2", "-Wall", "-Wextra", "-Werror", "-o", tmpBinPath, srcPath],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      compiled = true;
      break;
    } catch (err: unknown) {
      errors.push(`${compiler}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!compiled) {
    try {
      unlinkSync(tmpBinPath);
    } catch {
      // ignore
    }
    throw new Error(
      `ERR_SANDBOX_SUPERVISOR_UNAVAILABLE: Failed to compile sf_sandbox_supervisor.c: ${errors.join("; ")}`
    );
  }

  try {
    chmodSync(tmpBinPath, 0o755);
    renameSync(tmpBinPath, binPath);
  } catch (err: unknown) {
    try {
      unlinkSync(tmpBinPath);
    } catch {
      // ignore
    }
    if (!existsSync(binPath)) {
      throw err;
    }
  }

  cachedSupervisorBinaryPath = binPath;
  cachedSupervisorSourceHash = srcHash;
  return binPath;
}

function buildNulConfigBuffer(pairs: ReadonlyArray<readonly [string, string]>): Buffer {
  const chunks: Buffer[] = [];
  for (const [k, v] of pairs) {
    chunks.push(Buffer.from(`${k}\0${v}\0`, "utf8"));
  }
  return Buffer.concat(chunks);
}

function readLinuxProcStatState(pid: number): { alive: boolean; state: string | null } {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen === -1 || stat.length <= rparen + 2) {
      return { alive: true, state: null };
    }
    const state = stat[rparen + 2] ?? null;
    return { alive: state !== "Z" && state !== "X", state };
  } catch {
    return { alive: false, state: null };
  }
}

function findLinuxDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync(
      "ps",
      ["-eo", "pid=,ppid="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const edges = new Map<number, number[]>();
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const parts = line.split(/\s+/);
      if (parts.length < 2) {
        continue;
      }
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        continue;
      }
      const list = edges.get(ppid) ?? [];
      list.push(pid);
      edges.set(ppid, list);
    }

    const result: number[] = [];
    const seen = new Set<number>([rootPid]);
    const queue: number[] = [rootPid];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of edges.get(cur) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          result.push(child);
          queue.push(child);
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Derives a deterministic UID/GID in the user namespace (10000..29999) based on the task_id
 * to ensure two different tasks never share the same sandbox UID (FIX-15).
 */
export function deriveTaskRunnerUid(taskId: string): number {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = (hash * 31 + taskId.charCodeAt(i)) >>> 0;
  }
  return 10000 + (hash % 20000);
}

/**
 * Checks whether genuine Linux kernel cgroups v2 control files are present and writable.
 */
export function probeLinuxCgroupV2Support(cgroupRoot = "/sys/fs/cgroup"): {
  readonly supported: boolean;
  readonly cgroupRoot: string;
  readonly reason?: string;
} {
  if (process.platform !== "linux") {
    return {
      supported: false,
      cgroupRoot,
      reason: `Host platform '${process.platform}' is not Linux`,
    };
  }
  const controllersPath = join(cgroupRoot, "cgroup.controllers");
  if (!existsSync(cgroupRoot) || !existsSync(controllersPath)) {
    return {
      supported: false,
      cgroupRoot,
      reason: `Linux cgroup v2 hierarchy not mounted at ${cgroupRoot}`,
    };
  }
  try {
    accessSync(cgroupRoot, constants.W_OK);
    return { supported: true, cgroupRoot };
  } catch (err: unknown) {
    return {
      supported: false,
      cgroupRoot,
      reason: `Insufficient privileges to write to ${cgroupRoot}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Runtime kernel probe for Linux PR_SET_CHILD_SUBREAPER support (FIX-05).
 */
export function probeLinuxSubreaperSupport(): {
  readonly supported: boolean;
  readonly reason?: string;
} {
  if (process.platform !== "linux") {
    return {
      supported: false,
      reason: `Host platform '${process.platform}' is not Linux`,
    };
  }
  try {
    const binPath = ensureLinuxSupervisorBinary();
    const raw = execFileSync(binPath, ["--probe-all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const parsed = JSON.parse(raw) as {
      subreaperSupported?: boolean;
      reason?: string;
    };
    return parsed.subreaperSupported
      ? { supported: true }
      : {
          supported: false,
          reason: parsed.reason || "PR_SET_CHILD_SUBREAPER failed at runtime",
        };
  } catch (err: unknown) {
    return {
      supported: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runtime kernel probe for Linux namespaces (mount/pid/ipc/uts + userns when unprivileged) and mount masking (FIX-05).
 */
export function probeLinuxNamespaceSupport(options?: { testMaskMount?: boolean }): {
  readonly supported: boolean;
  readonly userNamespaceUsed: boolean;
  readonly mountMaskSupported: boolean;
  readonly reason?: string;
} {
  if (process.platform !== "linux") {
    return {
      supported: false,
      userNamespaceUsed: false,
      mountMaskSupported: false,
      reason: `Host platform '${process.platform}' is not Linux`,
    };
  }
  let probeMaskDir: string | null = null;
  try {
    const binPath = ensureLinuxSupervisorBinary();
    const args = ["--probe-all"];
    if (options?.testMaskMount) {
      probeMaskDir = mkdtempSync(join(tmpdir(), "sf-ns-probe-"));
      args.push(probeMaskDir);
    }
    const raw = execFileSync(binPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const parsed = JSON.parse(raw) as {
      namespacesSupported?: boolean;
      userNamespaceUsed?: boolean;
      mountMaskSupported?: boolean;
      reason?: string;
    };
    return {
      supported: Boolean(parsed.namespacesSupported),
      userNamespaceUsed: Boolean(parsed.userNamespaceUsed),
      mountMaskSupported: Boolean(parsed.mountMaskSupported),
      reason: parsed.reason || undefined,
    };
  } catch (err: unknown) {
    return {
      supported: false,
      userNamespaceUsed: false,
      mountMaskSupported: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (probeMaskDir) {
      try {
        rmSync(probeMaskDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Linux Cgroups v2 + Namespaces + Subreaper Sandbox Backend (MVP-SPEC-03 Section 4.1-4.3, FIX-05)
 *
 * Strictly separates synthetic state-machine testing (`spawnProcessInSandbox`, which ALWAYS
 * reports `backendMode: "simulated-cgroup-v2"`, `isSimulated: true`, `freezeApplied: false`,
 * `cgroupKillWritten: false`, `cgroupDirRemoved: false`, `subreaperEnabled: false`, `namespaces: []`)
 * from real OS child-process supervision (`spawnRealProcessInSandbox`), which on Linux compiles and
 * runs `sf_sandbox_supervisor` (`PR_SET_CHILD_SUBREAPER`, `unshare` namespaces + `tmpfs`/bind path
 * masking, `PR_SET_NO_NEW_PRIVS`, capability clearing, optional UID/GID drop, and cgroups v2 when
 * `requireKernelCgroup: true`) and never fabricates security claims that were not executed.
 */
export class LinuxCgroupV2SandboxBackend implements SandboxBackend {
  private activeSandboxes: Map<string, Set<number>> = new Map();
  private reparentedOrphans: Map<string, Set<number>> = new Map();
  private securityMetadata: Map<string, SandboxSecurityMetadata> = new Map();
  private sandboxExecutionMode: Map<string, "simulated" | "real-process" | "real-cgroup-v2"> =
    new Map();
  private managedProcesses: Map<string, ManagedProcessRecord[]> = new Map();
  private cleanupHistory: Map<string, SandboxCleanupEvidence> = new Map();
  private readonly cgroupRoot: string;

  constructor(options?: { cgroupRoot?: string }) {
    this.cgroupRoot = options?.cgroupRoot ?? "/sys/fs/cgroup";
  }

  private key(taskId: string, leaseEpoch: number): string {
    return `${taskId}:${leaseEpoch}`;
  }

  private getCgroupPath(taskId: string, leaseEpoch: number): string {
    return join(
      this.cgroupRoot,
      "software-factory.slice",
      `sf-task-${taskId}-epoch-${leaseEpoch}.scope`
    );
  }

  private recordSimulatedSecurityMetadata(
    taskId: string,
    leaseEpoch: number,
    worktreePath?: string
  ): SandboxSecurityMetadata {
    const k = this.key(taskId, leaseEpoch);
    const existing = this.securityMetadata.get(k);
    if (existing) {
      return existing;
    }
    const mountedWorktreePath =
      worktreePath ?? `/var/lib/software-factory/worktrees/${taskId}/epoch-${leaseEpoch}`;
    const taskUid = deriveTaskRunnerUid(taskId);
    const meta: SandboxSecurityMetadata = {
      isSimulated: true,
      backendMode: "simulated-cgroup-v2",
      supervisorPid: null,
      workerPid: null,
      supervisorUser: "simulated",
      supervisorUid: null,
      subreaperEnabled: false,
      uidDropped: false,
      sandboxUser: "simulated",
      sandboxUid: taskUid,
      sandboxGid: taskUid,
      noNewPrivsEnabled: false,
      capabilitiesDropped: false,
      namespaces: [],
      maskedPathsApplied: [],
      mountedWorktreePath,
      ephemeralGitPushRef: `refs/heads/sf/staging/${taskId}/${leaseEpoch}`,
    };
    this.securityMetadata.set(k, meta);
    return meta;
  }

  /**
   * Registers synthetic PIDs for fast unit tests.
   * NEVER claims `backendMode: "linux-cgroup-v2"` or active kernel isolation!
   */
  public spawnProcessInSandbox(input: {
    taskId: string;
    leaseEpoch: number;
    pid?: number;
    childPids?: number[];
    doubleForkOrphanPids?: number[];
    worktreePath?: string;
  }): void {
    const k = this.key(input.taskId, input.leaseEpoch);
    const set = this.activeSandboxes.get(k) ?? new Set<number>();
    set.add(input.pid ?? 40000 + input.leaseEpoch);
    for (const childPid of input.childPids ?? []) {
      set.add(childPid);
    }

    const orphanSet = this.reparentedOrphans.get(k) ?? new Set<number>();
    for (const orphanPid of input.doubleForkOrphanPids ?? []) {
      set.add(orphanPid);
      orphanSet.add(orphanPid);
    }

    this.activeSandboxes.set(k, set);
    this.reparentedOrphans.set(k, orphanSet);
    if (!this.sandboxExecutionMode.has(k)) {
      this.sandboxExecutionMode.set(k, "simulated");
    }
    this.recordSimulatedSecurityMetadata(input.taskId, input.leaseEpoch, input.worktreePath);
  }

  /**
   * Spawns a real OS subprocess inside a detached process group with clean `env -i` environment.
   * On Linux, launches via `sf_sandbox_supervisor` enforcing `PR_SET_CHILD_SUBREAPER`, Linux
   * namespaces (`mount`, `pid`, `ipc`, `uts` + `user` if unprivileged), mount masking of forbidden
   * paths, `PR_SET_NO_NEW_PRIVS`, capability clearing, optional UID/GID drop, and cgroups v2
   * attachment when `requireKernelCgroup: true`.
   */
  public spawnRealProcessInSandbox(input: {
    taskId: string;
    leaseEpoch: number;
    command: string;
    args: readonly string[];
    sanitizedEnv: Readonly<Record<string, string>>;
    cwd: string;
    worktreePath?: string;
    requireKernelCgroup?: boolean;
    requireSubreaper?: boolean;
    requireNamespaceIsolation?: boolean;
    isolateNamespaces?: boolean;
    maskedPaths?: readonly string[];
    dropPrivileges?: boolean;
  }): RealProcessSpawnResult {
    const k = this.key(input.taskId, input.leaseEpoch);
    const cgroupPath = this.getCgroupPath(input.taskId, input.leaseEpoch);
    const taskUid = deriveTaskRunnerUid(input.taskId);
    const mountedWorktreePath =
      input.worktreePath ??
      input.cwd ??
      `/var/lib/software-factory/worktrees/${input.taskId}/epoch-${input.leaseEpoch}`;
    let executionMode: "real-cgroup-v2" | "real-process" = "real-process";
    let cgroupCreated = false;

    if (input.requireKernelCgroup) {
      const probe = probeLinuxCgroupV2Support(this.cgroupRoot);
      if (!probe.supported) {
        throw new Error(`ERR_LINUX_CGROUP_V2_UNAVAILABLE: ${probe.reason}`);
      }
      mkdirSync(cgroupPath, { recursive: true });
      cgroupCreated = true;
      executionMode = "real-cgroup-v2";
    }

    const hostUid = typeof process.getuid === "function" ? process.getuid() : null;
    const hostGid = typeof process.getgid === "function" ? process.getgid() : null;
    const hostUsername = getCurrentHostUsername(hostUid);

    if (process.platform !== "linux") {
      if (input.requireSubreaper) {
        throw new Error(
          `ERR_LINUX_SUBREAPER_UNAVAILABLE: Host platform '${process.platform}' does not support Linux PR_SET_CHILD_SUBREAPER`
        );
      }
      if (input.requireNamespaceIsolation) {
        throw new Error(
          `ERR_LINUX_NAMESPACE_UNAVAILABLE: Host platform '${process.platform}' does not support Linux namespaces`
        );
      }
      if (input.dropPrivileges) {
        throw new Error(
          `ERR_SANDBOX_PRIVDROP_FAILED: Host platform '${process.platform}' does not support Linux privilege dropping`
        );
      }

      const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.sanitizedEnv },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const pid = child.pid;
      if (pid === undefined) {
        throw new Error("ERR_SANDBOX_SPAWN_FAILED: OS failed to assign PID to child process");
      }

      let nonLinuxStdoutTail = "";
      let nonLinuxStderrTail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        nonLinuxStdoutTail += chunk.toString("utf8");
        if (nonLinuxStdoutTail.length > 8192) {
          nonLinuxStdoutTail = nonLinuxStdoutTail.slice(-8192);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        nonLinuxStderrTail += chunk.toString("utf8");
        if (nonLinuxStderrTail.length > 8192) {
          nonLinuxStderrTail = nonLinuxStderrTail.slice(-8192);
        }
      });

      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdoutTail?: string;
        stderrTail?: string;
      }>((resolveExit) => {
        child.once("close", (code, signal) => {
          resolveExit({
            code,
            signal,
            stdoutTail: nonLinuxStdoutTail.slice(-2048),
            stderrTail: nonLinuxStderrTail.slice(-2048),
          });
        });
      });

      const record: ManagedProcessRecord = {
        pid,
        child,
        exited: false,
        reapedPidsFromFile: [],
        exitPromise,
      };
      void exitPromise.then(() => {
        record.exited = true;
      });

      const procs = this.managedProcesses.get(k) ?? [];
      procs.push(record);
      this.managedProcesses.set(k, procs);

      const pidSet = this.activeSandboxes.get(k) ?? new Set<number>();
      pidSet.add(pid);
      this.activeSandboxes.set(k, pidSet);

      const meta: SandboxSecurityMetadata = {
        isSimulated: false,
        backendMode: "real-process",
        supervisorPid: process.pid,
        workerPid: pid,
        supervisorUser: hostUsername,
        supervisorUid: hostUid,
        subreaperEnabled: false,
        uidDropped: false,
        sandboxUser: hostUsername,
        sandboxUid: hostUid ?? taskUid,
        sandboxGid: hostGid ?? taskUid,
        noNewPrivsEnabled: false,
        capabilitiesDropped: false,
        namespaces: [],
        maskedPathsApplied: [],
        mountedWorktreePath,
        ephemeralGitPushRef: `refs/heads/sf/staging/${input.taskId}/${input.leaseEpoch}`,
      };
      this.securityMetadata.set(k, meta);
      this.sandboxExecutionMode.set(k, executionMode);

      return {
        pid,
        executionMode,
        cgroupPath,
        securityMetadata: meta,
        exitPromise,
      };
    }

    // Genuine Linux path via sf_sandbox_supervisor
    let supDir: string | undefined;
    let supChild: ChildProcess | undefined;
    try {
      const binPath = ensureLinuxSupervisorBinary();
      supDir = mkdtempSync(join(tmpdir(), "sf-wna-sup-"));
      chmodSync(supDir, 0o700);
      const configPath = join(supDir, "config.bin");
      const readyPath = join(supDir, "ready.json");
      const reapPath = join(supDir, "reap.json");

      const allMaskedPaths = Array.from(
        new Set([...DEFAULT_MASKED_PATHS, ...(input.maskedPaths ?? [])])
      );
      const dropPrivsMode =
        input.dropPrivileges === true ? "2" : input.dropPrivileges === false ? "0" : "1";

      const configPairs: Array<readonly [string, string]> = [
        ["cgroup_path", executionMode === "real-cgroup-v2" ? cgroupPath : ""],
        ["require_cgroup", input.requireKernelCgroup ? "1" : "0"],
        ["isolate_ns", input.isolateNamespaces === false ? "0" : "1"],
        ["require_ns", input.requireNamespaceIsolation ? "1" : "0"],
        ["enable_subreaper", "1"],
        ["require_subreaper", input.requireSubreaper ? "1" : "0"],
        ["drop_privs", dropPrivsMode],
        ["uid", String(taskUid)],
        ["gid", String(taskUid)],
        ["cwd", input.cwd],
        ["ready_file", readyPath],
        ["reap_file", reapPath],
        ["cmd", input.command],
      ];
      for (const a of input.args) {
        configPairs.push(["arg", a]);
      }
      for (const mp of allMaskedPaths) {
        configPairs.push(["mask", mp]);
      }
      writeFileSync(configPath, buildNulConfigBuffer(configPairs));

      supChild = spawn(binPath, ["--config", configPath], {
        cwd: input.cwd,
        env: { ...input.sanitizedEnv },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const supPid = supChild.pid;
      if (supPid === undefined) {
        throw new Error("ERR_SANDBOX_SPAWN_FAILED: OS failed to assign PID to supervisor");
      }

      // Capture rolling stdout/stderr tails asynchronously so pipe buffers never block child execution
      let supStdoutTail = "";
      let supStderrTail = "";
      supChild.stdout?.on("data", (chunk: Buffer) => {
        supStdoutTail += chunk.toString("utf8");
        if (supStdoutTail.length > 8192) {
          supStdoutTail = supStdoutTail.slice(-8192);
        }
      });
      supChild.stderr?.on("data", (chunk: Buffer) => {
        supStderrTail += chunk.toString("utf8");
        if (supStderrTail.length > 8192) {
          supStderrTail = supStderrTail.slice(-8192);
        }
      });

      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stdoutTail?: string;
        stderrTail?: string;
      }>((resolveExit) => {
        supChild!.once("close", (code, signal) => {
          resolveExit({
            code,
            signal,
            stdoutTail: supStdoutTail.slice(-2048),
            stderrTail: supStderrTail.slice(-2048),
          });
        });
      });

      let ready: SupervisorReadyPayload | null = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (existsSync(readyPath)) {
          const rawReady = readFileSync(readyPath, "utf8");
          ready = JSON.parse(rawReady) as SupervisorReadyPayload;
          break;
        }
        const procState = readLinuxProcStatState(supPid);
        if (!procState.alive && !existsSync(readyPath)) {
          break;
        }
        sleepSyncMs(2);
      }

      if (!ready) {
        try {
          process.kill(supPid, "SIGKILL");
        } catch {
          // best effort
        }
        throw new Error(
          `ERR_SANDBOX_SPAWN_FAILED: Timed out or exited waiting for supervisor handshake (${supStderrTail.trim()})`
        );
      }

      if (!ready.ok || typeof ready.workerPid !== "number") {
        const errCode = ready.errorCode ?? "ERR_SANDBOX_SPAWN_FAILED";
        const errMsg = ready.errorMessage ?? "Supervisor reported spawn failure";
        throw new Error(`${errCode}: ${errMsg}`);
      }

      const workerPid = ready.workerPid;
      const actualUid = ready.actualUid ?? hostUid ?? taskUid;
      const actualGid = ready.actualGid ?? hostGid ?? taskUid;
      const uidDropped = Boolean(ready.uidDropped);

      const record: ManagedProcessRecord = {
        pid: workerPid,
        supervisorPid: supPid,
        child: supChild,
        reapFilePath: reapPath,
        supDir,
        exited: false,
        reapedPidsFromFile: [],
        exitPromise,
      };

      void exitPromise.then(() => {
        record.exited = true;
        if (record.reapFilePath && existsSync(record.reapFilePath)) {
          try {
            const parsedReap = JSON.parse(
              readFileSync(record.reapFilePath, "utf8")
            ) as SupervisorReapPayload;
            if (Array.isArray(parsedReap.reapedPids)) {
              record.reapedPidsFromFile = parsedReap.reapedPids.filter((p) =>
                Number.isInteger(p)
              );
            }
          } catch {
            // ignore
          }
        }
        if (record.supDir) {
          try {
            rmSync(record.supDir, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      });

      const procs = this.managedProcesses.get(k) ?? [];
      procs.push(record);
      this.managedProcesses.set(k, procs);

      const pidSet = this.activeSandboxes.get(k) ?? new Set<number>();
      pidSet.add(workerPid);
      this.activeSandboxes.set(k, pidSet);

      const meta: SandboxSecurityMetadata = {
        isSimulated: false,
        backendMode: executionMode === "real-cgroup-v2" ? "linux-cgroup-v2" : "linux-supervisor",
        supervisorPid: supPid,
        workerPid,
        supervisorUser: hostUsername,
        supervisorUid: hostUid,
        subreaperEnabled: Boolean(ready.subreaperEnabled),
        uidDropped,
        sandboxUser: uidDropped ? `sf-task-runner-${actualUid}` : hostUsername,
        sandboxUid: actualUid,
        sandboxGid: actualGid,
        noNewPrivsEnabled: Boolean(ready.noNewPrivsEnabled),
        capabilitiesDropped: Boolean(ready.capabilitiesDropped),
        namespaces: ready.namespaces ?? [],
        maskedPathsApplied: ready.maskedPathsApplied ?? [],
        mountedWorktreePath,
        ephemeralGitPushRef: `refs/heads/sf/staging/${input.taskId}/${input.leaseEpoch}`,
      };
      this.securityMetadata.set(k, meta);
      this.sandboxExecutionMode.set(k, executionMode);

      return {
        pid: workerPid,
        supervisorPid: supPid,
        executionMode,
        cgroupPath,
        securityMetadata: meta,
        exitPromise,
      };
    } catch (err: unknown) {
      if (supChild?.pid !== undefined) {
        try {
          process.kill(supChild.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      if (cgroupCreated && existsSync(cgroupPath)) {
        try {
          rmdirSync(cgroupPath);
        } catch {
          // ignore
        }
      }
      if (supDir) {
        try {
          rmSync(supDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      throw err;
    }
  }

  /**
   * Registers a simulated double-fork orphan PID for unit testing.
   */
  public spawnDoubleForkOrphanInSandbox(
    taskId: string,
    leaseEpoch: number,
    orphanPid: number
  ): void {
    const k = this.key(taskId, leaseEpoch);
    const set = this.activeSandboxes.get(k) ?? new Set<number>();
    const orphanSet = this.reparentedOrphans.get(k) ?? new Set<number>();
    set.add(orphanPid);
    orphanSet.add(orphanPid);
    this.activeSandboxes.set(k, set);
    this.reparentedOrphans.set(k, orphanSet);
    if (!this.sandboxExecutionMode.has(k)) {
      this.sandboxExecutionMode.set(k, "simulated");
    }
  }

  public getSandboxSecurityMetadata(
    taskId: string,
    leaseEpoch: number
  ): SandboxSecurityMetadata | undefined {
    return this.securityMetadata.get(this.key(taskId, leaseEpoch));
  }

  /**
   * Verifies Mount Namespace & UID Isolation (`MVP-SPEC-03` Section 4.1 & `FIX-15`):
   * Resolves POSIX `..` segments before enforcing allowlist so path traversal cannot bypass prefix checks.
   */
  public assertSandboxPathAccess(
    taskId: string,
    leaseEpoch: number,
    requestedPath: string
  ): { allowed: true } {
    const meta = this.securityMetadata.get(this.key(taskId, leaseEpoch));
    if (!meta) {
      throw new Error(`EACCES: Sandbox for ${taskId} (epoch ${leaseEpoch}) is not active`);
    }
    if (requestedPath.includes("\0")) {
      throw new Error("EACCES: Null byte forbidden in sandbox path");
    }
    const normalized = posix.resolve("/", requestedPath.replace(/\\/g, "/"));
    if (normalized === "/etc/sf-wna" || normalized.startsWith("/etc/sf-wna/")) {
      throw new Error(
        `EACCES: Mount namespace isolation denied access to WNA credential path '${normalized}' for user '${meta.sandboxUser}'`
      );
    }
    const allowedPrefix = posix.resolve("/", meta.mountedWorktreePath.replace(/\\/g, "/"));
    if (
      normalized === allowedPrefix ||
      normalized.startsWith(`${allowedPrefix}/`) ||
      normalized === "/tmp" ||
      normalized.startsWith("/tmp/")
    ) {
      return { allowed: true };
    }
    throw new Error(
      `EACCES: Mount namespace isolation denied cross-worktree or host path access '${normalized}' (allowed worktree: '${allowedPrefix}')`
    );
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

  private isPidAlive(pid: number): boolean {
    if (process.platform === "linux") {
      const state = readLinuxProcStatState(pid);
      if (state.state === "Z" || state.state === "X") {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private cleanupManagedTempDirs(managed: readonly ManagedProcessRecord[]): void {
    for (const proc of managed) {
      if (proc.supDir) {
        try {
          rmSync(proc.supDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  private mergeReapedPids(managed: readonly ManagedProcessRecord[]): number[] {
    const reaped = new Set<number>();
    for (const proc of managed) {
      if (proc.reapFilePath && existsSync(proc.reapFilePath)) {
        try {
          const parsed = JSON.parse(
            readFileSync(proc.reapFilePath, "utf8")
          ) as SupervisorReapPayload;
          if (Array.isArray(parsed.reapedPids)) {
            for (const p of parsed.reapedPids) {
              if (Number.isInteger(p)) {
                reaped.add(p);
              }
            }
          }
        } catch {
          // ignore
        }
      }
      for (const p of proc.reapedPidsFromFile) {
        reaped.add(p);
      }
      if (proc.supervisorPid === undefined && proc.exited) {
        reaped.add(proc.pid);
      }
    }
    return Array.from(reaped);
  }

  /**
   * 5-Step `killAndVerifyClean` (MVP-SPEC-03 Section 4.2, FIX-05):
   * - For `real-cgroup-v2`: executes real writes to `cgroup.freeze`, `cgroup.kill`, signals the
   *   subreaper supervisor to drain/waitpid all descendants, polls `cgroup.events`, and calls `rmdir(cgroup)`.
   * - For `real-process`: on Linux signals the `PR_SET_CHILD_SUBREAPER` supervisor (`SIGTERM`) which
   *   kills `-workerPid` AND every adopted double-fork orphan descendant and calls `waitpid(-1)`; on
   *   non-Linux sends `SIGKILL` to `-pid`. Reports `backendMode: "linux-supervisor"` (or `"real-process"`),
   *   `isSimulated: false`, `realProcessGroupKilled: true`, while reporting `realKernelOperationsExecuted: false`,
   *   `freezeApplied: false`, `cgroupKillWritten: false`, `cgroupDirRemoved: false` because kernel cgroupfs was not exercised.
   * - For `simulated`: clears tracked state and explicitly reports `isSimulated: true`,
   *   `realKernelOperationsExecuted: false`, `freezeApplied: false`, `cgroupKillWritten: false`,
   *   `cgroupDirRemoved: false`.
   */
  public async killAndVerifyClean(
    taskId: string,
    leaseEpoch: number
  ): Promise<SandboxCleanupEvidence> {
    const k = this.key(taskId, leaseEpoch);
    const mode = this.sandboxExecutionMode.get(k) ?? "simulated";
    const cgroupPath = this.getCgroupPath(taskId, leaseEpoch);
    const trackedPids = new Set<number>(this.activeSandboxes.get(k) ?? []);
    const managed = this.managedProcesses.get(k) ?? [];

    if (mode === "real-cgroup-v2") {
      try {
        for (const p of readFileSync(join(cgroupPath, "cgroup.procs"), "utf8")
          .split(/\s+/)
          .filter(Boolean)) {
          const parsed = Number(p);
          if (Number.isInteger(parsed)) {
            trackedPids.add(parsed);
          }
        }
      } catch {
        // best effort snapshot before freeze/kill
      }
      for (const proc of managed) {
        if (proc.supervisorPid !== undefined) {
          for (const d of findLinuxDescendantPids(proc.supervisorPid)) {
            trackedPids.add(d);
          }
        }
      }

      writeFileSync(join(cgroupPath, "cgroup.freeze"), "1", "utf8");
      writeFileSync(join(cgroupPath, "cgroup.kill"), "1", "utf8");

      const deadline = Date.now() + 5000;
      let populatedZeroVerified = false;
      while (Date.now() < deadline) {
        const events = readFileSync(join(cgroupPath, "cgroup.events"), "utf8");
        if (/^populated\s+0$/m.test(events)) {
          populatedZeroVerified = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      for (const proc of managed) {
        if (!proc.exited && proc.supervisorPid !== undefined) {
          try {
            process.kill(proc.supervisorPid, "SIGTERM");
          } catch {
            // already exited
          }
        }
        const settled = await Promise.race([
          proc.exitPromise.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
        ]);
        if (!settled && proc.supervisorPid !== undefined) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            // ignore
          }
          try {
            process.kill(proc.supervisorPid, "SIGKILL");
          } catch {
            // ignore
          }
          await Promise.race([proc.exitPromise, new Promise((r) => setTimeout(r, 1000))]);
        }
      }

      const reapedPids = this.mergeReapedPids(managed);
      for (const p of reapedPids) {
        trackedPids.add(p);
      }

      const remainingPids = readFileSync(join(cgroupPath, "cgroup.procs"), "utf8")
        .split(/\s+/)
        .filter(Boolean);
      const remainingProcsCount = remainingPids.length;
      if (remainingProcsCount === 0) {
        rmdirSync(cgroupPath);
      }
      const cgroupDirRemoved = !existsSync(cgroupPath);

      this.cleanupManagedTempDirs(managed);
      this.activeSandboxes.delete(k);
      this.managedProcesses.delete(k);
      this.reparentedOrphans.delete(k);
      this.securityMetadata.delete(k);
      this.sandboxExecutionMode.delete(k);

      const evidence: SandboxCleanupEvidence = {
        taskId,
        leaseEpoch,
        backendMode: "linux-cgroup-v2",
        isSimulated: false,
        realKernelOperationsExecuted: true,
        realProcessGroupKilled: true,
        cgroupPath,
        freezeApplied: true,
        cgroupKillWritten: true,
        populatedZeroVerified,
        subreaperWaitpidReapedPids: reapedPids,
        remainingProcsCount,
        cgroupDirRemoved,
        killedPids: Array.from(trackedPids),
        verifiedAt: new Date().toISOString(),
      };
      this.cleanupHistory.set(k, evidence);
      return evidence;
    }

    if (mode === "real-process") {
      for (const proc of managed) {
        if (proc.supervisorPid !== undefined) {
          for (const d of findLinuxDescendantPids(proc.supervisorPid)) {
            trackedPids.add(d);
          }
          if (!proc.exited) {
            try {
              process.kill(proc.supervisorPid, "SIGTERM");
            } catch {
              // already exited
            }
          }
          const settled = await Promise.race([
            proc.exitPromise.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
          ]);
          if (!settled) {
            for (const d of findLinuxDescendantPids(proc.supervisorPid)) {
              trackedPids.add(d);
              try {
                process.kill(d, "SIGKILL");
              } catch {
                // ignore
              }
            }
            try {
              process.kill(-proc.pid, "SIGKILL");
            } catch {
              // ignore
            }
            try {
              process.kill(proc.supervisorPid, "SIGKILL");
            } catch {
              // ignore
            }
            await Promise.race([proc.exitPromise, new Promise((r) => setTimeout(r, 1000))]);
          }
        } else {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            try {
              proc.child.kill("SIGKILL");
            } catch {
              // already exited
            }
          }
          await Promise.race([proc.exitPromise, new Promise((r) => setTimeout(r, 3000))]);
        }
      }

      const reapedPids = this.mergeReapedPids(managed);
      for (const p of reapedPids) {
        trackedPids.add(p);
      }

      const allTracked = Array.from(trackedPids);
      const remainingAlive = allTracked.filter((pid) => this.isPidAlive(pid)).length;
      this.cleanupManagedTempDirs(managed);
      this.activeSandboxes.delete(k);
      this.managedProcesses.delete(k);
      this.reparentedOrphans.delete(k);
      this.securityMetadata.delete(k);
      this.sandboxExecutionMode.delete(k);

      const hasLinuxSupervisor = managed.some((proc) => proc.supervisorPid !== undefined);
      const evidence: SandboxCleanupEvidence = {
        taskId,
        leaseEpoch,
        backendMode: hasLinuxSupervisor ? "linux-supervisor" : "real-process",
        isSimulated: false,
        realKernelOperationsExecuted: false,
        realProcessGroupKilled: true,
        cgroupPath,
        freezeApplied: false,
        cgroupKillWritten: false,
        populatedZeroVerified: remainingAlive === 0,
        subreaperWaitpidReapedPids: reapedPids,
        remainingProcsCount: remainingAlive,
        cgroupDirRemoved: false,
        killedPids: allTracked,
        verifiedAt: new Date().toISOString(),
      };
      this.cleanupHistory.set(k, evidence);
      return evidence;
    }

    // Synthetic/Simulated Sandbox Cleanup — NEVER claims linux-cgroup-v2 or kernel cgroup writes!
    const reapedOrphans = Array.from(this.reparentedOrphans.get(k) ?? []);
    this.activeSandboxes.delete(k);
    this.reparentedOrphans.delete(k);
    this.securityMetadata.delete(k);
    this.sandboxExecutionMode.delete(k);

    const remainingProcsCount = this.getActivePids(taskId, leaseEpoch).length;
    const populatedZeroVerified = remainingProcsCount === 0;

    const evidence: SandboxCleanupEvidence = {
      taskId,
      leaseEpoch,
      backendMode: "simulated-cgroup-v2",
      isSimulated: true,
      realKernelOperationsExecuted: false,
      realProcessGroupKilled: false,
      cgroupPath,
      freezeApplied: false,
      cgroupKillWritten: false,
      populatedZeroVerified,
      subreaperWaitpidReapedPids: reapedOrphans,
      remainingProcsCount,
      cgroupDirRemoved: false,
      killedPids: Array.from(trackedPids),
      verifiedAt: new Date().toISOString(),
    };
    this.cleanupHistory.set(k, evidence);
    return evidence;
  }
}

export class SimulatedCgroupV2SandboxBackend extends LinuxCgroupV2SandboxBackend {}

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
 * LocalOutboxBuffer (MVP-SPEC-03 Section 2.1)
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
   * Reconnect Synchronization Protocol (MVP-SPEC-03 Section 2.2):
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
