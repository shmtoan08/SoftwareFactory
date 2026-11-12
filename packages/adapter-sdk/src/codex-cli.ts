import { execFileSync } from "node:child_process";
import { realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskContextAssembler, type AgentTaskContext, type AgentInvocationPlan, type AgentExecutionResult, type AgentRuntimeAdapter } from "./index.ts";
import { inspectRealGitCommitForImport, validateGitTreeImport, codeImportGitEnvironment } from "@software-factory/task-contract";

export interface CodexCliAdapterOptions {
  readonly writerModel: string;
  readonly binaryPath?: string;
  readonly defaultTimeoutMs?: number;
  /** Invocation-scoped provider credential, never inherited from the WNA host. */
  readonly apiKey?: string;
  readonly resolveApiKey?: (ctx: AgentTaskContext) => string | Promise<string>;
}

/** Headless Codex runtime. JSONL indicates completion; Git is authoritative for code. */
export class CodexCliAdapter implements AgentRuntimeAdapter {
  public readonly runtimeId = "codex-cli" as const;
  public readonly writerProvider = "openai";
  public readonly writerModel: string;
  private readonly options: CodexCliAdapterOptions;
  private readonly invocationSecrets = new WeakMap<AgentTaskContext, string>();
  private readonly invocationHomes = new WeakMap<AgentTaskContext, string>();

  constructor(options: CodexCliAdapterOptions) {
    if (!options.writerModel?.trim()) throw new Error("CodexCliAdapter requires an explicit writerModel");
    if (options.defaultTimeoutMs !== undefined && (!Number.isSafeInteger(options.defaultTimeoutMs) || options.defaultTimeoutMs < 1)) {
      throw new Error("Codex timeout must be a positive safe integer");
    }
    this.writerModel = options.writerModel.trim();
    this.options = options;
  }

  public async prepareInvocation(ctx: AgentTaskContext): Promise<AgentInvocationPlan> {
    const apiKey = (await this.options.resolveApiKey?.(ctx)) ?? this.options.apiKey ??
      (ctx.modelProviderConfig?.provider === "openai" ? ctx.modelProviderConfig.apiKey : undefined);
    if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n\0]/.test(apiKey)) {
      throw new Error("ERR_CODEX_CREDENTIAL_REQUIRED: explicitly provision a scoped Codex API key");
    }
    const assembled = TaskContextAssembler.assemble(ctx);
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: ctx.worktreePath, env: codeImportGitEnvironment(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const gitDir = realpathSync(git(["rev-parse", "--absolute-git-dir"]));
    const commonDir = realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    let detached = false;
    try { git(["symbolic-ref", "-q", "HEAD"]); } catch { detached = true; }
    if (!detached || gitDir === commonDir || realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(ctx.worktreePath) ||
      git(["rev-parse", "HEAD"]) !== ctx.baseMainCommitHash) {
      throw new Error("ERR_CODEX_WORKTREE_REQUIRED: use a detached linked WNA worktree at the task base");
    }
    // Native workspace mode protects Git metadata. Grant only this detached
    // worktree's metadata and shared objects; common refs/config remain read-only.
    // Use one inline TOML table: dotted -c keys cannot preserve dots in paths.
    const filesystem = [gitDir, join(commonDir, "objects")].map((path) => `${JSON.stringify(path)}="write"`).join(",");
    const permissions = `permissions={sf-worker={extends=":workspace",filesystem={${filesystem}}}}`;
    this.cleanupInvocation(ctx);
    const runtimeHome = mkdtempSync(join(tmpdir(), "sf-codex-home-"));
    this.invocationHomes.set(ctx, runtimeHome);
    mkdirSync(join(runtimeHome, "codex"), { mode: 0o700 });
    this.invocationSecrets.set(ctx, apiKey);
    const runtimeEnv = { ...assembled.sanitizedEnv };
    delete runtimeEnv.SF_GIT_LEASE_TOKEN;
    return {
      binaryPath: this.options.binaryPath ?? "codex",
      args: ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--cd", ctx.worktreePath, "--model", this.writerModel,
        "-c", 'default_permissions="sf-worker"', "-c", permissions,
        "-c", 'approval_policy="never"',
        "-c", 'shell_environment_policy.inherit="none"',
        "-c", `shell_environment_policy.set.PATH=${JSON.stringify(assembled.sanitizedEnv.PATH)}`,
        [assembled.promptInstruction, "",
          "Implement the task and meaningful tests within the allowed paths. Run relevant tests.",
          "Create exactly one Git commit whose parent is the specified base commit; leave a clean worktree.",
          'Use git -c user.name="Software Factory Codex" -c user.email="codex@software-factory.local" commit when needed.',
          "Do not push or update remote refs: WNA submits the resulting commit through the controlled gate.",
        ].join("\n")],
      sanitizedEnv: Object.freeze({ ...runtimeEnv, CODEX_API_KEY: apiKey, HOME: runtimeHome,
        CODEX_HOME: join(runtimeHome, "codex") }),
      timeoutMs: this.options.defaultTimeoutMs ?? 300_000,
    };
  }

  public cleanupInvocation(ctx: AgentTaskContext): void {
    const home = this.invocationHomes.get(ctx);
    this.invocationSecrets.delete(ctx);
    this.invocationHomes.delete(ctx);
    if (home) rmSync(home, { recursive: true, force: true });
  }

  public async parseExecutionResult(ctx: AgentTaskContext, rawExitCode: number, stdout: string, stderr: string): Promise<AgentExecutionResult> {
    const secret = this.invocationSecrets.get(ctx) ?? this.options.apiKey ?? ctx.modelProviderConfig?.apiKey;
    this.invocationSecrets.delete(ctx);
    const redact = (text: string): string => (secret ? text.split(secret).join("[REDACTED]") : text).slice(-2048);
    const result = { writerProvider: this.writerProvider, writerModel: this.writerModel,
      stdoutTail: redact(stdout), stderrTail: redact(stderr) };
    try {
      if (rawExitCode !== 0) throw new Error(`Codex exited with code ${rawExitCode}`);
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      const events: { type?: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        try { events.push(JSON.parse(lines[i]!) as { type?: string }); }
        catch {
          // WNA retains a bounded tail; its first JSONL record may be clipped.
          if (i !== 0 || lines.length === 1) throw new Error("Malformed Codex JSONL record");
        }
      }
      if (!events.some((event) => event?.type === "turn.completed") ||
        events.some((event) => event?.type === "turn.failed" || event?.type === "error")) {
        throw new Error("Codex JSONL is missing a successful terminal turn");
      }
      const git = (args: string[]) => execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
        cwd: ctx.worktreePath, encoding: "utf8", timeout: 10_000,
        env: codeImportGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"], maxBuffer: 2 * 1024 * 1024,
      }).trim();
      if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(ctx.worktreePath)) throw new Error("Codex worktree Git root changed");
      if (git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=all"])) throw new Error("Codex left uncommitted changes");
      const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
      const candidate = inspectRealGitCommitForImport({ repoPath: ctx.worktreePath,
        agentCommitHash: commit, expectedBaseMainCommitHash: ctx.baseMainCommitHash, contract: ctx.taskContract, gitEnvironment: codeImportGitEnvironment() });
      const validation = validateGitTreeImport(candidate);
      if (!validation.valid) throw new Error(`Codex Git result rejected: ${validation.error_code}`);
      return { ...result, exitCode: 0, agentCommitHash: commit, verifiedTreeHash: candidate.verified_tree_hash };
    } catch (error) {
      return { ...result, exitCode: rawExitCode || 1, agentCommitHash: null, verifiedTreeHash: null,
        error: redact(error instanceof Error ? error.message : String(error)) };
    } finally { this.cleanupInvocation(ctx); }
  }
}
