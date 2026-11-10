import type {
  AgentExecutionResult,
  AgentInvocationPlan,
  AgentRuntimeAdapter,
  AgentTaskContext,
} from "@software-factory/adapter-sdk";
import { sha256Hex } from "@software-factory/shared-types";

/**
 * Deterministic FakeAgentHarnessAdapter (MVP-SPEC-03 Section 4.4 & Roadmap M1.4)
 * Implements AgentRuntimeAdapter for adversarial & recovery testing without requiring external LLM API calls.
 */
export class FakeAgentHarnessAdapter implements AgentRuntimeAdapter {
  public readonly runtimeId = "fake-agent-harness" as const;
  public readonly writerProvider = "anthropic";
  public readonly writerModel = "claude-3-7-sonnet-fake-harness";

  public async prepareInvocation(ctx: AgentTaskContext): Promise<AgentInvocationPlan> {
    return {
      binaryPath: "/usr/bin/env",
      args: ["node", "--eval", `console.log("FakeAgent executing task ${ctx.taskId}")`],
      sanitizedEnv: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp/sf-sandbox-home",
        SF_TASK_ID: ctx.taskId,
        SF_LEASE_EPOCH: String(ctx.leaseEpoch),
      },
      timeoutMs: 30_000,
    };
  }

  public async parseExecutionResult(
    ctx: AgentTaskContext,
    rawExitCode: number,
    stdout: string,
    stderr: string
  ): Promise<AgentExecutionResult> {
    const agentCommitHash = sha256Hex(
      `commit:${ctx.projectId}:${ctx.taskId}:${ctx.leaseId}:${ctx.leaseEpoch}`
    ).slice(0, 40);
    const verifiedTreeHash = sha256Hex(
      `tree:${ctx.projectId}:${ctx.taskId}:${ctx.leaseEpoch}`
    ).slice(0, 40);

    return {
      exitCode: rawExitCode,
      agentCommitHash,
      verifiedTreeHash,
      writerProvider: this.writerProvider,
      writerModel: this.writerModel,
      stdoutTail: stdout.slice(-1024),
      stderrTail: stderr.slice(-1024),
    };
  }
}
