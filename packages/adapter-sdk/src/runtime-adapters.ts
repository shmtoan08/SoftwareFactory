import { ClaudeCodeCliAdapter, type AgentRuntimeAdapter } from "./index.ts";
import { CodexCliAdapter } from "./codex-cli.ts";

/** Operator configuration only. No arbitrary runtime names or fallback on missing Codex auth/model. */
export function loadAgentRuntimeAdapterFromEnv(env: NodeJS.ProcessEnv = process.env,
  testOptions: { testOnlyEmulator?: boolean } = {}): AgentRuntimeAdapter {
  const runtime = env.SF_AGENT_RUNTIME?.trim() || "claude-code-cli";
  const writerModel = env.SF_AGENT_MODEL?.trim();
  const timeoutMs = env.SF_AGENT_TIMEOUT_MS === undefined ? undefined : Number(env.SF_AGENT_TIMEOUT_MS);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("Invalid SF_AGENT_TIMEOUT_MS");
  if (runtime === "codex-cli") {
    if (!testOptions.testOnlyEmulator) throw new Error("ERR_UNMETERED_CODEX_DISABLED: production Codex requires trusted Cost Guard metering");
    if (!writerModel) throw new Error("Codex runtime requires SF_AGENT_MODEL");
    return new CodexCliAdapter({ writerModel, binaryPath: env.SF_AGENT_BINARY?.trim() || undefined,
      defaultTimeoutMs: timeoutMs, apiKey: env.SF_CODEX_API_KEY, testOnlyEmulator: true });
  }
  if (runtime === "claude-code-cli") return new ClaudeCodeCliAdapter({ writerModel,
    binaryPath: env.SF_AGENT_BINARY?.trim() || undefined, defaultTimeoutMs: timeoutMs });
  throw new Error(`Unsupported SF_AGENT_RUNTIME '${runtime}'`);
}
