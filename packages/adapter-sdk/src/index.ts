import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DELETED_LINES,
  DEFAULT_SYSTEM_FORBIDDEN_PATHS,
  type TaskContractSpec,
  evaluatePathPolicyPrecedence,
  isSafeRelativePosixPath,
  matchesAnyGlob,
} from "@software-factory/task-contract";
import { LiveModelProviderClient, type ModelProviderConfig } from "./model-providers.ts";

export * from "./model-providers.ts";

/**
 * AgentRuntimeAdapter Interface (MVP-SPEC-03 Section 4.4 & Roadmap M2/M5)
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
  readonly reworkCycle?: number;
  readonly previousFailureFeedbackMd?: string | null;
  readonly modelProviderConfig?: ModelProviderConfig;
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
  readonly runtimeId: "claude-code-cli" | "fake-agent-harness" | "workspace-coding-agent";
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

    const lines = [
      `# Software Factory Task Execution Contract`,
      `Task ID: ${ctx.taskId} (Epoch: ${ctx.leaseEpoch})`,
      `Rework Cycle: ${ctx.reworkCycle ?? 0}`,
      `Title: ${ctx.taskTitle}`,
      `Base Commit: ${ctx.baseMainCommitHash}`,
      `Allowed Files: ${ctx.taskContract.allowed_files.join(", ")}`,
      `Protected Paths (Read-Only): ${protectedPaths.join(", ") || "none"}`,
      `Forbidden Paths: ${forbiddenPaths.join(", ")}`,
      `Diff Limits: max_changed_files=${maxChanged}, max_deleted_lines=${maxDeleted}`,
      `Target Staging Ref: ${canonicalStagingRef}`,
    ];
    if (ctx.previousFailureFeedbackMd && ctx.previousFailureFeedbackMd.trim().length > 0) {
      lines.push(`# Previous Failure / Rework Feedback\n${ctx.previousFailureFeedbackMd.trim()}`);
    }
    const promptInstruction = lines.join("\n");

    // Strictly build from an empty environment (`env -i` semantics):
    // Never copy host/WNA secrets even if `hostEnvironmentToSanitize` contains them.
    const sanitizedEnv: Record<string, string> = {
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
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

export interface WorkspaceFileEdit {
  readonly path: string;
  readonly content: string;
}

function validateWorkspaceFileEdits(
  rawFiles: unknown,
  taskContract?: TaskContractSpec
): readonly WorkspaceFileEdit[] {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error(
      "Workspace edits must be a non-empty array of { path, content }; empty edits are rejected fail-closed"
    );
  }
  const maxChangedFiles = taskContract?.max_changed_files ?? DEFAULT_MAX_CHANGED_FILES;
  if (rawFiles.length > maxChangedFiles) {
    throw new Error(
      `Workspace edit count (${rawFiles.length}) exceeds max_changed_files (${maxChangedFiles})`
    );
  }

  const seenLowerPaths = new Set<string>();
  const validated: WorkspaceFileEdit[] = [];

  for (const item of rawFiles) {
    if (!item || typeof item !== "object") {
      throw new Error("Workspace edit entry must be an object with string 'path' and 'content'");
    }
    const candidate = item as { path?: unknown; content?: unknown };
    if (typeof candidate.path !== "string" || typeof candidate.content !== "string") {
      throw new Error("Workspace edit entry must contain string 'path' and 'content'");
    }
    if (!isSafeRelativePosixPath(candidate.path)) {
      throw new Error(`Unsafe workspace edit path rejected: '${candidate.path}'`);
    }
    const lowerPath = candidate.path.toLowerCase();
    if (seenLowerPaths.has(lowerPath)) {
      throw new Error(`Duplicate or case-colliding workspace edit path: '${candidate.path}'`);
    }
    seenLowerPaths.add(lowerPath);

    if (taskContract) {
      const verdict = evaluatePathPolicyPrecedence(candidate.path, taskContract);
      if (!verdict.allowed) {
        throw new Error(
          `Workspace edit path '${candidate.path}' rejected by TaskContract (${verdict.reason}${
            verdict.matchedRule ? `: ${verdict.matchedRule}` : ""
          })`
        );
      }
    } else {
      const matchedForbidden = matchesAnyGlob(candidate.path, DEFAULT_SYSTEM_FORBIDDEN_PATHS, true);
      if (matchedForbidden !== null) {
        throw new Error(
          `Workspace edit path '${candidate.path}' rejected by default forbidden rule '${matchedForbidden}'`
        );
      }
    }

    validated.push({
      path: candidate.path,
      content: candidate.content,
    });
  }

  return validated;
}

function assertWorktreeTargetNoSymlinkEscape(rootDir: string, relativePosixPath: string): string {
  const realRoot = realpathSync(rootDir);
  const absTarget = resolve(realRoot, relativePosixPath);
  if (absTarget === realRoot || !absTarget.startsWith(`${realRoot}/`) && !absTarget.startsWith(`${realRoot}\\`)) {
    throw new Error(`Path traversal blocked: ${relativePosixPath}`);
  }
  const segments = relativePosixPath.split("/");
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = join(cursor, segments[i]!);
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink target blocked in workspace edit: ${relativePosixPath}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        break;
      }
      throw err;
    }
  }
  return absTarget;
}

const WORKSPACE_AGENT_INLINE_RUNNER = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { execFileSync } = require("node:child_process");',
  'const payload = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));',
  'if (!Array.isArray(payload.files) || payload.files.length === 0) {',
  '  throw new Error("WorkspaceCodingAgentAdapter requires at least one file edit; empty commits are forbidden");',
  "}",
  "const root = fs.realpathSync(path.resolve(payload.worktreePath));",
  "const addedPaths = [];",
  "for (const file of payload.files) {",
  '  if (!file || typeof file.path !== "string" || typeof file.content !== "string") {',
  '    throw new Error("Invalid workspace file edit payload");',
  "  }",
  "  const abs = path.resolve(root, file.path);",
  '  if (abs === root || (!abs.startsWith(root + path.sep))) {',
  '    throw new Error("Path traversal blocked: " + file.path);',
  "  }",
  '  let cursor = root;',
  '  for (const seg of file.path.split("/")) {',
  "    cursor = path.join(cursor, seg);",
  "    try {",
  "      if (fs.lstatSync(cursor).isSymbolicLink()) {",
  '        throw new Error("Symlink blocked: " + file.path);',
  "      }",
  "    } catch (e) {",
  '      if (e && e.code === "ENOENT") break;',
  "      throw e;",
  "    }",
  "  }",
  "  fs.mkdirSync(path.dirname(abs), { recursive: true });",
  '  fs.writeFileSync(abs, file.content, "utf8");',
  "  addedPaths.push(file.path);",
  "}",
  'execFileSync("git", ["add", "--", ...addedPaths], { cwd: root, stdio: "pipe" });',
  'execFileSync("git", ["-c", "user.name=" + payload.authorName, "-c", "user.email=" + payload.authorEmail, "commit", "-m", payload.commitMessage], { cwd: root, stdio: "pipe" });',
  'const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();',
  'const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();',
  'process.stdout.write(JSON.stringify({ agent_commit_hash: head, verified_tree_hash: tree }) + "\\n");',
].join(" ");

/**
 * Live Workspace Coding Agent Runtime Adapter (`M5`).
 * Executes inside `LinuxCgroupV2SandboxBackend` using clean `env -i` environment variables,
 * optionally consults a configured `LiveModelProviderClient` in the supervisor layer (never passing API keys
 * into the sandbox), writes target source/test edits to the isolated worktree, creates a real signed/attributed
 * `git commit`, and returns exact SHA-1 commit & tree hashes.
 */
export class WorkspaceCodingAgentAdapter implements AgentRuntimeAdapter {
  public readonly runtimeId = "workspace-coding-agent" as const;
  public readonly writerProvider: string;
  public readonly writerModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly editsResolver?: (
    ctx: AgentTaskContext
  ) => Promise<readonly WorkspaceFileEdit[]> | readonly WorkspaceFileEdit[];
  private readonly modelClient?: LiveModelProviderClient;

  constructor(options?: {
    writerProvider?: string;
    writerModel?: string;
    timeoutMs?: number;
    modelClient?: LiveModelProviderClient;
    editsResolver?: (
      ctx: AgentTaskContext
    ) => Promise<readonly WorkspaceFileEdit[]> | readonly WorkspaceFileEdit[];
  }) {
    this.writerProvider = options?.writerProvider ?? options?.modelClient?.config.provider ?? "anthropic";
    this.writerModel = options?.writerModel ?? options?.modelClient?.config.model ?? "claude-3-7-sonnet-20250219";
    this.defaultTimeoutMs = options?.timeoutMs ?? 60_000;
    this.modelClient = options?.modelClient;
    this.editsResolver = options?.editsResolver;
  }

  public async prepareInvocation(ctx: AgentTaskContext): Promise<AgentInvocationPlan> {
    const assembled = TaskContextAssembler.assemble(ctx);
    let rawFiles: unknown;
    if (this.editsResolver) {
      rawFiles = await this.editsResolver(ctx);
    } else if (this.modelClient) {
      const resp = await this.modelClient.complete({
        systemPrompt:
          'You are an autonomous coding agent. Output JSON array of file edits: [{"path":"...","content":"..."}]',
        userPrompt: assembled.promptInstruction,
      });
      const raw = typeof resp?.contentText === "string" ? resp.contentText.trim() : "";
      const s = raw.indexOf("[");
      const e = raw.lastIndexOf("]");
      if (s === -1 || e <= s) {
        throw new Error(
          `WorkspaceCodingAgentAdapter (${this.writerProvider}/${this.writerModel}) returned non-JSON response without an edit array`
        );
      }
      try {
        rawFiles = JSON.parse(raw.slice(s, e + 1));
      } catch (err: unknown) {
        throw new Error(
          `WorkspaceCodingAgentAdapter (${this.writerProvider}/${this.writerModel}) returned malformed JSON edits: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    } else {
      throw new Error(
        "WorkspaceCodingAgentAdapter requires editsResolver or modelClient; empty commits are forbidden"
      );
    }

    const files = validateWorkspaceFileEdits(rawFiles, ctx.taskContract);

    const payload = {
      worktreePath: ctx.worktreePath,
      commitMessage: `sf(${ctx.taskId.slice(0, 8)}): epoch ${ctx.leaseEpoch} rework ${ctx.reworkCycle ?? 0} - ${ctx.taskTitle}`,
      authorName: `sf-agent-${this.writerProvider}`,
      authorEmail: `agent+${ctx.leaseEpoch}@software-factory.local`,
      files,
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return {
      binaryPath: process.execPath,
      args: ["-e", WORKSPACE_AGENT_INLINE_RUNNER, payloadB64],
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
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.startsWith("{") && line.endsWith("}")) {
        try {
          const json = JSON.parse(line) as Record<string, unknown>;
          if (
            typeof json.agent_commit_hash === "string" &&
            /^[0-9a-f]{40}$/i.test(json.agent_commit_hash) &&
            typeof json.verified_tree_hash === "string" &&
            /^[0-9a-f]{40}$/i.test(json.verified_tree_hash)
          ) {
            return {
              exitCode: rawExitCode,
              agentCommitHash: json.agent_commit_hash.toLowerCase(),
              verifiedTreeHash: json.verified_tree_hash.toLowerCase(),
              writerProvider: this.writerProvider,
              writerModel: this.writerModel,
              stdoutTail: stdout.slice(-2048),
              stderrTail: stderr.slice(-2048),
            };
          }
        } catch {
          // continue searching lines
        }
      }
    }

    return {
      exitCode: rawExitCode !== 0 ? rawExitCode : 1,
      agentCommitHash: null,
      verifiedTreeHash: null,
      writerProvider: this.writerProvider,
      writerModel: this.writerModel,
      stdoutTail: stdout.slice(-2048),
      stderrTail: stderr.slice(-2048),
      error: "WorkspaceCodingAgentAdapter failed to parse valid 40-char commit/tree SHA from child stdout",
    };
  }
}

export function applyWorkspaceEditsSync(
  worktreePath: string,
  files: readonly WorkspaceFileEdit[],
  commitMessage: string,
  taskContract?: TaskContractSpec
): { readonly commitHash: string; readonly treeHash: string } {
  const validated = validateWorkspaceFileEdits(files, taskContract);
  const root = realpathSync(resolve(worktreePath));
  for (const file of validated) {
    const abs = assertWorktreeTargetNoSymlinkEscape(root, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
  }
  execFileSync("git", ["add", "--", ...validated.map((f) => f.path)], { cwd: root, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=sf-agent",
      "-c",
      "user.email=agent@software-factory.local",
      "commit",
      "-m",
      commitMessage,
    ],
    { cwd: root, stdio: "pipe" }
  );
  const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const treeHash = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { commitHash, treeHash };
}
