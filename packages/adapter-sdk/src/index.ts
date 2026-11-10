import { sha256Hex } from "@software-factory/shared-types";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DELETED_LINES,
  DEFAULT_SYSTEM_FORBIDDEN_PATHS,
  type TaskContractSpec,
} from "@software-factory/task-contract";

/**
 * AgentRuntimeAdapter Interface (MVP-SPEC-03 Section 4.4 & Roadmap M2)
 */
export interface AgentTaskContext {
  readonly projectId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly leaseEpoch: number;
  readonly worktreePath: string;
  readonly baseMainCommitHash: string;
  readonly taskTitle: string;
  readonly taskContract: TaskContractSpec;
  readonly ephemeralGitPushToken?: string;
  readonly hostEnvironmentToSanitize?: Readonly<Record<string, string | undefined>>;
}

export interface AgentInvocationPlan {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly sanitizedEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly agentCommitHash: string | null;
  readonly verifiedTreeHash: string | null;
  readonly writerProvider: string;
  readonly writerModel: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly error?: string;
}

export interface AgentRuntimeAdapter {
  readonly runtimeId: "claude-code-cli" | "fake-agent-harness";
  readonly writerProvider: string;
  readonly writerModel: string;

  prepareInvocation(ctx: AgentTaskContext): Promise<AgentInvocationPlan>;
  parseExecutionResult(
    ctx: AgentTaskContext,
    rawExitCode: number,
    stdout: string,
    stderr: string
  ): Promise<AgentExecutionResult>;
}

/**
 * List of forbidden environment variable prefixes/names that MUST NEVER leak from
 * the WNA Supervisor (`sf-wna`) into the `LinuxSandboxBackend` (`sf-task-runner`).
 */
export const FORBIDDEN_SANDBOX_ENV_PATTERNS: readonly RegExp[] = [
  /^SF_WNA_/i,
  /^WORKER_NODE_CREDENTIAL$/i,
  /^DATABASE_URL$/i,
  /^PGPASSWORD$/i,
  /^AWS_/i,
  /^GITHUB_TOKEN$/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^GOOGLE_API_KEY$/i,
];

export interface AssembledTaskExecutionContext {
  readonly promptInstruction: string;
  readonly stagingRef: string;
  readonly canonicalStagingRef: string;
  readonly sanitizedEnv: Readonly<Record<string, string>>;
}

/**
 * TaskContextAssembler (Roadmap M2 Section 1 & FIX-26)
 * Builds a clean `env -i` environment whitelist (stripping all WNA / DB / Cloud credentials)
 * and constructs deterministic task instructions bound to the TaskContract.
 * If `ctx.hostEnvironmentToSanitize` is provided for inspection/testing, its non-whitelisted keys
 * are inspected and confirmed discarded; forbidden keys are strictly prevented from entering `sanitizedEnv`.
 */
export class TaskContextAssembler {
  public static assemble(ctx: AgentTaskContext): AssembledTaskExecutionContext {
    const canonicalStagingRef = `refs/heads/sf/staging/${ctx.taskId}/${ctx.leaseEpoch}`;
    const stagingRef = `refs/factory/Verify/${ctx.taskId}/${ctx.leaseEpoch}`;
    const forbiddenPaths = [
      ...DEFAULT_SYSTEM_FORBIDDEN_PATHS,
      ...(ctx.taskContract.forbidden_paths ?? []),
    ];
    const protectedPaths = ctx.taskContract.protected_paths ?? [];
    const maxChanged = ctx.taskContract.max_changed_files ?? DEFAULT_MAX_CHANGED_FILES;
    const maxDeleted = ctx.taskContract.max_deleted_lines ?? DEFAULT_MAX_DELETED_LINES;

    const promptInstruction = [
      `# Software Factory Task Execution Contract`,
      `Task ID: ${ctx.taskId} (Epoch: ${ctx.leaseEpoch})`,
      `Title: ${ctx.taskTitle}`,
      `Base Commit: ${ctx.baseMainCommitHash}`,
      `Allowed Files: ${ctx.taskContract.allowed_files.join(", ")}`,
      `Protected Paths (Read-Only): ${protectedPaths.join(", ") || "none"}`,
      `Forbidden Paths: ${forbiddenPaths.join(", ")}`,
      `Diff Limits: max_changed_files=${maxChanged}, max_deleted_lines=${maxDeleted}`,
      `Target Staging Ref: ${canonicalStagingRef}`,
    ].join("\n");

    // Strictly build from an empty environment (`env -i` semantics):
    // Never copy host/WNA secrets even if `hostEnvironmentToSanitize` contains them.
    const sanitizedEnv: Record<string, string> = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `/tmp/sf-task-runner-${ctx.taskId}-${ctx.leaseEpoch}`,
      LANG: "C.UTF-8",
      USER: "sf-task-runner",
      LOGNAME: "sf-task-runner",
      GIT_TERMINAL_PROMPT: "0",
      SF_PROJECT_ID: ctx.projectId,
      SF_TASK_ID: ctx.taskId,
      SF_LEASE_ID: ctx.leaseId,
      SF_LEASE_EPOCH: String(ctx.leaseEpoch),
      SF_WORKTREE_PATH: ctx.worktreePath,
      SF_BASE_COMMIT_HASH: ctx.baseMainCommitHash,
      SF_STAGING_REF: canonicalStagingRef,
      SF_VERIFY_REF_ALIAS: stagingRef,
    };

    if (ctx.ephemeralGitPushToken) {
      sanitizedEnv.SF_GIT_LEASE_TOKEN = ctx.ephemeralGitPushToken;
    }

    // Defensive check: verify zero forbidden keys exist in sanitizedEnv
    for (const key of Object.keys(sanitizedEnv)) {
      for (const pattern of FORBIDDEN_SANDBOX_ENV_PATTERNS) {
        if (pattern.test(key)) {
          delete sanitizedEnv[key];
        }
      }
    }

    return {
      promptInstruction,
      stagingRef,
      canonicalStagingRef,
      sanitizedEnv: Object.freeze(sanitizedEnv),
    };
  }
}

/**
 * First Production Coding Agent Runtime Adapter: ClaudeCodeCliAdapter (`P-010`)
 * (MVP-SPEC-03 Section 4.4, Roadmap M2 Section 1, FIX-06)
 */
export class ClaudeCodeCliAdapter implements AgentRuntimeAdapter {
  public readonly runtimeId = "claude-code-cli" as const;
  public readonly writerProvider = "anthropic";
  public readonly writerModel: string;
  private readonly binaryPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(options?: {
    writerModel?: string;
    binaryPath?: string;
    defaultTimeoutMs?: number;
  }) {
    this.writerModel = options?.writerModel ?? "claude-3-7-sonnet-20250219";
    this.binaryPath = options?.binaryPath ?? "/usr/local/bin/claude";
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 300_000;
  }

  public async prepareInvocation(ctx: AgentTaskContext): Promise<AgentInvocationPlan> {
    const assembled = TaskContextAssembler.assemble(ctx);
    return {
      binaryPath: this.binaryPath,
      args: [
        "--print",
        "--output-format",
        "json",
        "--cwd",
        ctx.worktreePath,
        "--prompt",
        assembled.promptInstruction,
      ],
      sanitizedEnv: assembled.sanitizedEnv,
      timeoutMs: this.defaultTimeoutMs,
    };
  }

  public async parseExecutionResult(
    _ctx: AgentTaskContext,
    rawExitCode: number,
    stdout: string,
    stderr: string
  ): Promise<AgentExecutionResult> {
    let parsedCommit: string | null = null;
    let parsedTree: string | null = null;
    let parseError: string | undefined;

    const trimmed = stdout.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const json = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof json.agent_commit_hash === "string" && /^[0-9a-f]{40}$/i.test(json.agent_commit_hash)) {
          parsedCommit = json.agent_commit_hash.toLowerCase();
        }
        if (typeof json.verified_tree_hash === "string" && /^[0-9a-f]{40}$/i.test(json.verified_tree_hash)) {
          parsedTree = json.verified_tree_hash.toLowerCase();
        }
      } catch (err: unknown) {
        parseError = `Failed to parse JSON output: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // FIX-06: NEVER fabricate a fake commit hash with sha256Hex when output lacks a valid commit!
    if (!parsedCommit || !parsedTree) {
      return {
        exitCode: rawExitCode !== 0 ? rawExitCode : 1,
        agentCommitHash: null,
        verifiedTreeHash: null,
        writerProvider: this.writerProvider,
        writerModel: this.writerModel,
        stdoutTail: stdout.slice(-2048),
        stderrTail: stderr.slice(-2048),
        error: parseError ?? "Failed to parse valid 40-char commit hash and tree hash in CLI output",
      };
    }

    return {
      exitCode: rawExitCode,
      agentCommitHash: parsedCommit,
      verifiedTreeHash: parsedTree,
      writerProvider: this.writerProvider,
      writerModel: this.writerModel,
      stdoutTail: stdout.slice(-2048),
      stderrTail: stderr.slice(-2048),
    };
  }
}
