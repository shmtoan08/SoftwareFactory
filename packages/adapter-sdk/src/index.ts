import type { TaskContractSpec } from "@software-factory/task-contract";

/**
 * AgentRuntimeAdapter Interface (MVP-SPEC-03 Section 4.4)
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
}

export interface AgentInvocationPlan {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly sanitizedEnv: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface AgentExecutionResult {
  readonly exitCode: number;
  readonly agentCommitHash: string;
  readonly verifiedTreeHash: string;
  readonly writerProvider: string;
  readonly writerModel: string;
  readonly stdoutTail: string;
  readonly stderrTail: string;
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
