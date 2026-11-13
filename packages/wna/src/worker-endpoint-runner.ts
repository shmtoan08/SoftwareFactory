import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type AgentRuntimeAdapter, type AgentTaskContext, type ExternalTargetAction } from "@software-factory/adapter-sdk";
import { isSafeRelativePosixPath, matchesAnyGlob, validateCodeImportSubmission, type ArtifactFileSubmission } from "@software-factory/task-contract";
import { deriveTaskRunnerUid, LinuxCgroupV2SandboxBackend, probeLinuxCgroupV2Support, probeLinuxNamespaceSupport, probeLinuxSubreaperSupport, type SandboxCleanupEvidence } from "./index.ts";
import { assertWorkerCleanup, type WorkerEndpointRunner } from "./worker-endpoint.ts";

export interface LinuxWorkerEndpointRunnerConfig {
  readonly tenantNamespace: string;
  /** Operator-registered public baseline commit -> local repository. No request URLs. */
  readonly baselineCommitRegistry: Readonly<Record<string, string>>;
  readonly worktreeBaseDir: string;
  readonly stateDir: string;
  readonly cgroupRoot?: string;
  readonly adapter: AgentRuntimeAdapter;
}
type FileEntry = { bytes: Buffer; mode: "100644" | "100755" };
const RESERVED = new Set([".git", ".sf-worker-home"]);
/** Artifacts are collected using filesystem reads, never Git in agent-modifiable metadata. */
function readWorkspace(root: string): Map<string, FileEntry> {
  const files = new Map<string, FileEntry>(); let bytes = 0; let entries = 0;
  const walk = (path: string, prefix: string, depth: number) => {
    if (depth > 32) throw new Error("Worker tree depth limit");
    for (const name of readdirSync(path)) {
      if (++entries > 4096) throw new Error("Worker tree entry limit");
      if (!prefix && RESERVED.has(name)) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!isSafeRelativePosixPath(relative)) throw new Error("Unsafe worker artifact path");
      const absolute = join(path, name); const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile() || stat.nlink > 1 && stat.isFile()) throw new Error("Worker artifacts require regular files without links");
      if (stat.isDirectory()) walk(absolute, relative, depth + 1);
      else {
        if (files.size >= 1024 || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) throw new Error("Worker artifact tree limit");
        files.set(relative, { bytes: readFileSync(absolute), mode: stat.mode & 0o111 ? "100755" : "100644" });
      }
    }
  };
  walk(root, "", 0); return files;
}
export class LinuxWorkerEndpointRunner implements WorkerEndpointRunner {
  private readonly config: LinuxWorkerEndpointRunnerConfig;
  private readonly backend: LinuxCgroupV2SandboxBackend;
  constructor(config: LinuxWorkerEndpointRunnerConfig) {
    if (!isAbsolute(config.worktreeBaseDir) || !isAbsolute(config.stateDir) || config.worktreeBaseDir === config.stateDir || !/^[A-Za-z0-9._:-]{1,128}$/.test(config.tenantNamespace)) throw new Error("Invalid Linux worker directories/namespace");
    if (/codex/i.test(`${config.adapter.runtimeId} ${config.adapter.writerProvider} ${config.adapter.writerModel}`)) throw new Error("ERR_UNMETERED_CODEX_DISABLED");
    for (const [commit, repo] of Object.entries(config.baselineCommitRegistry)) if (!/^[a-f0-9]{40}$/.test(commit) || !isAbsolute(repo)) throw new Error("Invalid operator public baseline registry");
    this.config = { ...config, baselineCommitRegistry: Object.freeze({ ...config.baselineCommitRegistry }) };
    this.backend = new LinuxCgroupV2SandboxBackend({ cgroupRoot: config.cgroupRoot });
    mkdirSync(config.worktreeBaseDir, { recursive: true, mode: 0o755 });
    if (lstatSync(config.worktreeBaseDir).isSymbolicLink()) throw new Error("Invalid worker worktree root");
  }
  private checkKernel(): void {
    if (process.platform !== "linux" || process.getuid?.() !== 0 || !probeLinuxCgroupV2Support(this.config.cgroupRoot).supported || !probeLinuxSubreaperSupport().supported || !probeLinuxNamespaceSupport().supported) throw new Error("ERR_WORKER_STRICT_LINUX_UNAVAILABLE");
  }
  private ownTree(path: string, uid: number): void {
    const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error("Worker baseline contains symlink");
    chownSync(path, uid, uid); chmodSync(path, stat.isDirectory() ? 0o700 : stat.mode & 0o111 ? 0o700 : 0o600);
    if (stat.isDirectory()) for (const name of readdirSync(path)) this.ownTree(join(path, name), uid);
  }
  public async health(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.checkKernel();
    // Exercise the strict native mode, including mount_setattr, rather than advertise from a platform string.
    const executionId = randomUUID(); const workspace = mkdtempSync(join(this.config.worktreeBaseDir, "health-"));
    this.ownTree(workspace, deriveTaskRunnerUid(executionId));
    let spawned = false;
    try {
      const result = this.backend.spawnRealProcessInSandbox({ taskId: executionId, leaseEpoch: 1, command: "/bin/true", args: [], sanitizedEnv: { PATH: "/usr/bin:/bin" }, cwd: workspace, worktreePath: workspace, requireKernelCgroup: true, requireSubreaper: true, requireNamespaceIsolation: true, dropPrivileges: true, maskedPaths: [this.config.stateDir], externalWorkerGuard: { maxRuntimeMs: 3000 } });
      spawned = true;
      const exit = await result.exitPromise; signal.throwIfAborted(); if (exit.code !== 0) throw new Error("Strict worker probe failed");
    } finally {
      if (spawned) {
        const evidence = await this.backend.killAndVerifyClean(executionId, 1);
        assertWorkerCleanup(evidence, { execution_id: executionId, lease_epoch: 1 } as ExternalTargetAction);
      }
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  public async execute(action: Readonly<ExternalTargetAction>, signal: AbortSignal) {
    signal.throwIfAborted(); this.checkKernel();
    const repo = this.config.baselineCommitRegistry[action.base_main_commit_hash];
    if (!repo) throw new Error("Public baseline is not registered");
    const workspace = mkdtempSync(join(this.config.worktreeBaseDir, `execution-${action.execution_id}-`));
    let spawned = false; let cleanupEvidence: SandboxCleanupEvidence | undefined;
    let ctx: AgentTaskContext | undefined; let cleanupVerified = false;
    const git = (args: string[], cwd = workspace) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, timeout: 10000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    try {
      // Validate the full public tree before checkout, including unchanged paths/modes.
      const tree = git(["ls-tree", "-rz", action.base_main_commit_hash], repo).toString("utf8").split("\0").filter(Boolean);
      if (tree.length > 1024 || tree.some((entry) => { const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry); return !match || !isSafeRelativePosixPath(match[2]!) || RESERVED.has(match[2]!.split("/")[0]!); })) throw new Error("Unsafe operator baseline tree");
      git(["init", "--initial-branch=main"]);
      git(["-c", "protocol.file.allow=always", "fetch", "--depth=1", "--no-tags", repo, action.base_main_commit_hash]);
      git(["checkout", "--detach", "FETCH_HEAD"]);
      const baseline = readWorkspace(workspace);
      mkdirSync(join(workspace, ".sf-worker-home"), { mode: 0o700 });
      ctx = { projectId: this.config.tenantNamespace, taskId: action.task_id, leaseId: action.execution_id, leaseEpoch: action.lease_epoch, worktreePath: workspace, baseMainCommitHash: action.base_main_commit_hash, taskTitle: action.public_context, taskContract: { allowed_files: [...action.allowed_files] } };
      const plan = await this.config.adapter.prepareInvocation(ctx); signal.throwIfAborted();
      if (!Number.isFinite(plan.timeoutMs) || plan.timeoutMs < 1 || plan.args.length > 256) throw new Error("Invalid worker invocation bounds");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(plan.sanitizedEnv)) {
        if (!["PATH", "LANG", "HOME", "USER", "LOGNAME", "GIT_TERMINAL_PROMPT"].includes(key) && !/^SF_(?:PROJECT_ID|TASK_ID|LEASE_ID|LEASE_EPOCH|WORKTREE_PATH|BASE_COMMIT_HASH|STAGING_REF|VERIFY_REF_ALIAS)$/.test(key)) throw new Error("Worker adapter environment outside allowlist");
        if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid worker environment"); env[key] = value;
      }
      env.HOME = join(workspace, ".sf-worker-home");
      this.ownTree(workspace, deriveTaskRunnerUid(action.execution_id));
      const remaining = Math.min(plan.timeoutMs, Date.parse(action.deadline) - Date.now(), 120000);
      if (remaining <= 0) throw new Error("Worker deadline exceeded before spawn");
      const result = this.backend.spawnRealProcessInSandbox({ taskId: action.execution_id, leaseEpoch: action.lease_epoch, command: plan.binaryPath, args: plan.args, sanitizedEnv: env, cwd: workspace, worktreePath: workspace, requireKernelCgroup: true, requireSubreaper: true, requireNamespaceIsolation: true, dropPrivileges: true, maskedPaths: [this.config.stateDir, "/var/run/docker.sock"], externalWorkerGuard: { maxRuntimeMs: Math.floor(remaining) } });
      spawned = true;
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => reject(new Error("Worker invocation aborted"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        result.exitPromise.finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
      });
      let exit: Awaited<typeof result.exitPromise>;
      try { exit = await Promise.race([result.exitPromise, aborted]); }
      finally { cleanupEvidence = await this.backend.killAndVerifyClean(action.execution_id, action.lease_epoch); assertWorkerCleanup(cleanupEvidence, action); cleanupVerified = true; }
      signal.throwIfAborted(); if (exit.code !== 0) throw new Error("Worker adapter execution failed");
      // No untrusted process remains when walking files; never run agent-modified Git hooks/config on host.
      const current = readWorkspace(workspace); const files: ArtifactFileSubmission[] = [];
      for (const path of new Set([...baseline.keys(), ...current.keys()])) {
        const before = baseline.get(path), after = current.get(path);
        if (before && after && before.mode === after.mode && before.bytes.equals(after.bytes)) continue;
        if (!matchesAnyGlob(path, action.allowed_files)) throw new Error("Worker output outside approved files");
        files.push(after ? { action: "write", path, content_base64: after.bytes.toString("base64"), mode: after.mode } : { action: "delete", path });
      }
      return { submission: validateCodeImportSubmission({ kind: "artifact", files }), cleanupEvidence };
    } finally {
      if (spawned && !cleanupVerified) { cleanupEvidence = await this.backend.killAndVerifyClean(action.execution_id, action.lease_epoch); assertWorkerCleanup(cleanupEvidence, action); cleanupVerified = true; }
      if (ctx) await this.config.adapter.cleanupInvocation?.(ctx);
      // Keep uncertain workspaces for operator inspection instead of deleting a live tree.
      if (!spawned || cleanupVerified) rmSync(workspace, { recursive: true, force: true });
    }
  }
}
