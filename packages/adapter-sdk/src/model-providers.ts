import {
  type CostSessionRecord,
  type ModelCallLedgerRecord,
  type ModelPricingRate,
  type ModelProviderName,
  type ModelUsageMetrics,
  type RenderedPrompt,
  type StructuredJsonSchema,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import type { TaskContractSpec } from "@software-factory/task-contract";
import {
  CostBudgetExceededError,
  type CostGuardRecorder,
  computeCostMicroUsd,
  estimateTokenCount,
  extractNormalizedTokenUsage,
  resolveModelPricingRate,
} from "./cost-guard.ts";
import type { PromptRegistry } from "./prompt-registry.ts";
import {
  StructuredOutputValidationError,
  extractJsonFromModelText,
  parseAndValidateStructuredOutput,
} from "./structured-output.ts";

export type { ModelProviderName };

export class ModelProviderConfigurationError extends Error {
  public readonly code = "ERR_MODEL_PROVIDER_NOT_CONFIGURED" as const;
  public readonly provider: ModelProviderName;

  constructor(provider: ModelProviderName, message: string) {
    super(message);
    this.name = "ModelProviderConfigurationError";
    this.provider = provider;
  }
}

export class ModelProviderHttpError extends Error {
  public readonly statusCode: number;
  public readonly provider: ModelProviderName;

  constructor(provider: ModelProviderName, statusCode: number, message: string) {
    super(message);
    this.name = "ModelProviderHttpError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}

export interface ModelProviderConfig {
  readonly provider: ModelProviderName;
  readonly model: string;
  readonly apiKey?: string;
  readonly apiKeyEnvVar?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Explicitly opt in to plain http:// or private network hosts (unsafe outside controlled tests). Default: false. */
  readonly allowInsecureHttpBaseUrl?: boolean;
  /** Optional hostname allowlist for provider endpoints (applies even when baseUrl uses default endpoint). */
  readonly allowedHosts?: readonly string[];
}

export interface ModelCompletionRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface ModelCompletionResponse {
  readonly provider: ModelProviderName;
  readonly model: string;
  readonly endpoint: string;
  readonly contentText: string;
  readonly requestSha256: string;
  readonly rawUsage?: Readonly<Record<string, unknown>>;
  readonly usage: ModelUsageMetrics;
}

const MAX_TOKENS_PER_CALL_HARD_CAP = 200_000;
const MAX_HTTP_ERROR_BODY_CHARS = 500;

function defaultEnvVarForProvider(provider: ModelProviderName): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
  }
}

function defaultModelForProvider(provider: ModelProviderName): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-20250514";
    case "openai":
      return "gpt-4.1";
    case "google":
      return "gemini-2.5-pro";
  }
}

function defaultBaseUrlForProvider(provider: ModelProviderName): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com";
    case "openai":
      return "https://api.openai.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
  }
}

function normalizeHostname(rawHostname: string): string {
  return rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

function parseIpv4Octets(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function extractEmbeddedIpv4FromIpv6(host: string): readonly [number, number, number, number] | null {
  if (!host.includes(":")) {
    return null;
  }
  const dottedMatch = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch?.[1]) {
    return parseIpv4Octets(dottedMatch[1]);
  }
  const hexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMatch?.[1] && hexMatch?.[2]) {
    const hi = Number.parseInt(hexMatch[1], 16);
    const lo = Number.parseInt(hexMatch[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}

function classifyHost(rawHostname: string): "loopback" | "metadata_or_unspecified" | "private" | "public" {
  const host = normalizeHostname(rawHostname);
  if (host === "localhost" || host === "::1") {
    return "loopback";
  }
  if (host === "::" || host === "metadata.google.internal" || host === "metadata") {
    return "metadata_or_unspecified";
  }
  const directIpv4 = parseIpv4Octets(host);
  const embeddedIpv4 = directIpv4 ? null : extractEmbeddedIpv4FromIpv6(host);
  const ipv4 = directIpv4 ?? embeddedIpv4;
  if (ipv4) {
    const [a, b, c, d] = ipv4;
    if (a === 127) {
      if (directIpv4 && b === 0 && c === 0 && d === 1) {
        return "loopback";
      }
      return "private";
    }
    if (a === 0 || (a === 169 && b === 254)) {
      return "metadata_or_unspecified";
    }
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return "private";
    }
  }
  if (/^fe[89ab][0-9a-f]:/.test(host)) {
    return "metadata_or_unspecified";
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host)) {
    return "private";
  }
  return "public";
}

function validateModelBaseUrl(config: ModelProviderConfig): void {
  const effectiveUrl = config.baseUrl ?? defaultBaseUrlForProvider(config.provider);
  let parsed: URL;
  try {
    parsed = new URL(effectiveUrl);
  } catch {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Invalid model provider baseUrl '${effectiveUrl}' for '${config.provider}'`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Unsupported URL scheme '${parsed.protocol}' in baseUrl '${effectiveUrl}'; expected https://`
    );
  }
  if (parsed.username || parsed.password) {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Embedded URL credentials are forbidden in model provider baseUrl`
    );
  }

  const hostClass = classifyHost(parsed.hostname);
  if (hostClass === "metadata_or_unspecified") {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Forbidden metadata/unspecified host '${parsed.hostname}' in model provider baseUrl`
    );
  }
  if (hostClass === "private" && config.allowInsecureHttpBaseUrl !== true) {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Private/internal network host '${parsed.hostname}' is blocked in model provider baseUrl`
    );
  }
  if (
    parsed.protocol === "http:" &&
    hostClass !== "loopback" &&
    config.allowInsecureHttpBaseUrl !== true
  ) {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Insecure http:// baseUrl '${effectiveUrl}' is forbidden for non-loopback host '${parsed.hostname}'; use https:// or set allowInsecureHttpBaseUrl: true`
    );
  }
  if (config.allowedHosts && config.allowedHosts.length > 0) {
    const normalizedHost = normalizeHostname(parsed.hostname);
    const allowed = config.allowedHosts.some((h) => normalizeHostname(h) === normalizedHost);
    if (!allowed) {
      throw new ModelProviderConfigurationError(
        config.provider,
        `Model provider host '${parsed.hostname}' is not in allowedHosts [${config.allowedHosts.join(", ")}]`
      );
    }
  }
}

function validateGenerationParams(
  provider: ModelProviderName,
  maxTokens: number,
  temperature: number
): void {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_TOKENS_PER_CALL_HARD_CAP) {
    throw new ModelProviderConfigurationError(
      provider,
      `Invalid maxTokens (${String(maxTokens)}): must be an integer between 1 and ${MAX_TOKENS_PER_CALL_HARD_CAP}`
    );
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ModelProviderConfigurationError(
      provider,
      `Invalid temperature (${String(temperature)}): must be a finite number between 0 and 2`
    );
  }
}

function isOpenAiReasoningModel(model: string): boolean {
  return /^(?:o1|o3|o4)(?:$|[-_])/i.test(model.trim());
}

async function readTruncatedResponseText(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > MAX_HTTP_ERROR_BODY_CHARS
      ? `${text.slice(0, MAX_HTTP_ERROR_BODY_CHARS)}...[truncated]`
      : text;
  } catch {
    return "<unreadable response body>";
  }
}

async function parseProviderJsonResponse<T>(
  provider: ModelProviderName,
  resp: Response
): Promise<T> {
  try {
    return (await resp.json()) as T;
  } catch (err: unknown) {
    throw new ModelProviderHttpError(
      provider,
      resp.status,
      `${provider} API returned invalid JSON response: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function extractTextContent(rawContent: unknown): string {
  if (typeof rawContent === "string") {
    return rawContent;
  }
  if (Array.isArray(rawContent)) {
    return rawContent
      .filter(
        (part): part is { type?: unknown; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string" &&
          ((part as { type?: unknown }).type === undefined ||
            (part as { type?: unknown }).type === "text" ||
            (part as { type?: unknown }).type === "output_text")
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/**
 * Live Model Provider HTTP Adapter (`anthropic`, `openai`, `google`).
 * Fail-closed: throws `ModelProviderConfigurationError` if no API key is configured,
 * if a forbidden private/metadata host is used, or if a non-loopback `http://` baseUrl
 * is configured without explicit opt-in.
 */
export class LiveModelProviderClient {
  public readonly config: ModelProviderConfig;
  private readonly resolvedApiKey: string;

  constructor(config: ModelProviderConfig, env: NodeJS.ProcessEnv = process.env) {
    this.config = config;
    validateModelBaseUrl(config);
    const envVar = config.apiKeyEnvVar ?? defaultEnvVarForProvider(config.provider);
    const key = (config.apiKey ?? env[envVar] ?? "").trim();
    if (!key) {
      throw new ModelProviderConfigurationError(
        config.provider,
        `Live model provider '${config.provider}' (${config.model}) is unconfigured: missing apiKey and env var ${envVar}`
      );
    }
    this.resolvedApiKey = key;
  }

  public async complete(req: ModelCompletionRequest): Promise<ModelCompletionResponse> {
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const maxTokens = req.maxTokens ?? 1024;
    const temperature = req.temperature ?? 0;
    validateGenerationParams(this.config.provider, maxTokens, temperature);
    const requestSha256 = sha256Hex(
      canonicalizeJson({
        provider: this.config.provider,
        model: this.config.model,
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
      })
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (this.config.provider === "anthropic") {
        const base = (this.config.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
        const endpoint = `${base}/v1/messages`;
        const resp = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": this.resolvedApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: maxTokens,
            temperature,
            system: req.systemPrompt,
            messages: [{ role: "user", content: req.userPrompt }],
          }),
        });
        if (!resp.ok) {
          throw new ModelProviderHttpError(
            "anthropic",
            resp.status,
            `Anthropic API error HTTP ${resp.status}: ${await readTruncatedResponseText(resp)}`
          );
        }
        const json = await parseProviderJsonResponse<{
          content?: Array<{ type?: string; text?: string }>;
          usage?: Record<string, unknown>;
        }>("anthropic", resp);
        const text =
          Array.isArray(json.content)
            ? json.content
                .filter((c) => Boolean(c) && c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n")
            : "";
        return {
          provider: "anthropic",
          model: this.config.model,
          endpoint,
          contentText: text,
          requestSha256,
          rawUsage: json.usage,
          usage: extractNormalizedTokenUsage(
            "anthropic",
            json.usage,
            `${req.systemPrompt}\n${req.userPrompt}`,
            text
          ),
        };
      }

      if (this.config.provider === "openai") {
        const base = (this.config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
        const endpoint = `${base}/v1/chat/completions`;
        const reasoning = isOpenAiReasoningModel(this.config.model);
        const bodyPayload: Record<string, unknown> = reasoning
          ? {
              model: this.config.model,
              max_completion_tokens: maxTokens,
              ...(req.temperature === 1 ? { temperature: 1 } : {}),
              messages: [
                { role: "system", content: req.systemPrompt },
                { role: "user", content: req.userPrompt },
              ],
            }
          : {
              model: this.config.model,
              max_tokens: maxTokens,
              temperature,
              messages: [
                { role: "system", content: req.systemPrompt },
                { role: "user", content: req.userPrompt },
              ],
            };
        const resp = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.resolvedApiKey}`,
          },
          body: JSON.stringify(bodyPayload),
        });
        if (!resp.ok) {
          throw new ModelProviderHttpError(
            "openai",
            resp.status,
            `OpenAI API error HTTP ${resp.status}: ${await readTruncatedResponseText(resp)}`
          );
        }
        const json = await parseProviderJsonResponse<{
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: Record<string, unknown>;
        }>("openai", resp);
        const text = extractTextContent(json.choices?.[0]?.message?.content);
        return {
          provider: "openai",
          model: this.config.model,
          endpoint,
          contentText: text,
          requestSha256,
          rawUsage: json.usage,
          usage: extractNormalizedTokenUsage(
            "openai",
            json.usage,
            `${req.systemPrompt}\n${req.userPrompt}`,
            text
          ),
        };
      }

      // Google Gemini generateContent
      const base = (
        this.config.baseUrl ?? "https://generativelanguage.googleapis.com"
      ).replace(/\/+$/, "");
      const endpoint = `${base}/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`;
      const resp = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.resolvedApiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature,
          },
        }),
      });
      if (!resp.ok) {
        throw new ModelProviderHttpError(
          "google",
          resp.status,
          `Google Gemini API error HTTP ${resp.status}: ${await readTruncatedResponseText(resp)}`
        );
      }
      const json = await parseProviderJsonResponse<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: Record<string, unknown>;
      }>("google", resp);
      const parts = json.candidates?.[0]?.content?.parts;
      const text = Array.isArray(parts)
        ? parts
            .filter((p): p is { text: string } => Boolean(p) && typeof p.text === "string")
            .map((p) => p.text)
            .filter(Boolean)
            .join("\n")
        : "";
      return {
        provider: "google",
        model: this.config.model,
        endpoint,
        contentText: text,
        requestSha256,
        rawUsage: json.usageMetadata,
        usage: extractNormalizedTokenUsage(
          "google",
          json.usageMetadata,
          `${req.systemPrompt}\n${req.userPrompt}`,
          text
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface LiveReviewEvaluationInput {
  readonly taskContract: TaskContractSpec;
  readonly diffText: string;
  readonly changedFiles: readonly string[];
  readonly verificationRunSummary: {
    readonly verification_run_id: string;
    readonly verdict: "PASS" | "FAIL";
    readonly overall_status: string;
    readonly tier1_trusted_acceptance_passed: boolean | null;
    readonly tier2_protected_baseline_passed: boolean | null;
    readonly tier3_agent_tests_passed: boolean | null;
  };
}

export interface LiveReviewEvaluationOutput {
  readonly verdict: "PASS" | "FAIL";
  readonly findings: ReadonlyArray<{
    readonly code: "CUSTOM_REVIEW_REJECTION";
    readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
    readonly filePath?: string;
    readonly detail: string;
  }>;
  readonly summaryMarkdown: string;
}

/**
 * Queries a configured `LiveModelProviderClient` to independently review a clean diff & verification summary.
 * Fails closed (`FAIL`) if the model rejects the change or returns an unparseable response.
 */
export async function evaluateIndependentReviewWithLiveModel(
  client: LiveModelProviderClient,
  input: LiveReviewEvaluationInput
): Promise<LiveReviewEvaluationOutput> {
  const systemPrompt = [
    "You are an independent read-only software reviewer in Software Factory v1.5.",
    "Respond ONLY with valid JSON: {\"verdict\":\"PASS\"|\"FAIL\",\"summaryMarkdown\":\"...\",\"findings\":[{\"severity\":\"HIGH\"|\"MEDIUM\"|\"INFO\",\"detail\":\"...\"}]}",
  ].join("\n");

  const userPrompt = [
    `Allowed Files: ${input.taskContract.allowed_files.join(", ")}`,
    `Changed Files: ${input.changedFiles.join(", ")}`,
    `Verification Summary: ${JSON.stringify(input.verificationRunSummary)}`,
    "Diff:",
    input.diffText.slice(0, 12000),
  ].join("\n\n");

  const completion = await client.complete({
    systemPrompt,
    userPrompt,
    maxTokens: 512,
    temperature: 0,
  });

  const rawText = typeof completion?.contentText === "string" ? completion.contentText.trim() : "";
  try {
    const parsedRaw = extractJsonFromModelText(rawText);
    if (!parsedRaw || typeof parsedRaw !== "object" || Array.isArray(parsedRaw)) {
      throw new Error("Expected JSON object");
    }
    const parsed = parsedRaw as {
      verdict?: unknown;
      summaryMarkdown?: unknown;
      findings?: Array<{ severity?: unknown; filePath?: unknown; detail?: unknown }>;
    };
    const verdict = parsed.verdict === "PASS" ? "PASS" : "FAIL";
    const findings: LiveReviewEvaluationOutput["findings"] = Array.isArray(parsed.findings)
      ? parsed.findings.map((f) => {
          const sev: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO" =
            f.severity === "CRITICAL" ||
            f.severity === "HIGH" ||
            f.severity === "MEDIUM" ||
            f.severity === "INFO"
              ? f.severity
              : "INFO";
          return {
            code: "CUSTOM_REVIEW_REJECTION" as const,
            severity: sev,
            ...(typeof f.filePath === "string" ? { filePath: f.filePath } : {}),
            detail: typeof f.detail === "string" ? f.detail : "Reviewer finding",
          };
        })
      : [];
    const summaryMarkdown =
      typeof parsed.summaryMarkdown === "string" && parsed.summaryMarkdown.trim()
        ? parsed.summaryMarkdown
        : `### Live Review Result (${client.config.provider}/${client.config.model})\n\nVerdict: ${verdict}`;
    return { verdict, findings, summaryMarkdown };
  } catch (err: unknown) {
    return {
      verdict: "FAIL",
      findings: [
        {
          code: "CUSTOM_REVIEW_REJECTION",
          severity: "HIGH",
          detail: `Live model ${client.config.provider}/${client.config.model} returned non-JSON review response: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      summaryMarkdown: `### Live Review Result (${client.config.provider}/${client.config.model})\n\nVerdict: FAIL (malformed JSON response)`,
    };
  }
}

export interface ModelProviderProfileConfig extends ModelProviderConfig {
  readonly defaultMaxTokens?: number;
  readonly defaultTemperature?: number;
}

/**
 * Loads `ModelProviderProfileConfig` purely from environment variables (`AC-01` config-driven swapping).
 * Supports `SF_MODEL_PROVIDER` (`anthropic` | `openai` | `google`), `SF_MODEL_NAME`,
 * `SF_MODEL_BASE_URL`, `SF_MODEL_API_KEY`, `SF_MODEL_TIMEOUT_MS`, `SF_MODEL_ALLOWED_HOSTS`,
 * and `SF_MODEL_ALLOW_INSECURE_HTTP`.
 */
export function loadModelProviderConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<ModelProviderProfileConfig>
): ModelProviderProfileConfig {
  const rawProvider = (overrides?.provider ?? env.SF_MODEL_PROVIDER ?? "anthropic").trim().toLowerCase();
  if (rawProvider !== "anthropic" && rawProvider !== "openai" && rawProvider !== "google") {
    throw new ModelProviderConfigurationError(
      "anthropic",
      `Unsupported SF_MODEL_PROVIDER '${rawProvider}'; expected anthropic, openai, or google`
    );
  }
  const provider: ModelProviderName = rawProvider;
  const model =
    (overrides?.model ?? env.SF_MODEL_NAME ?? "").trim() || defaultModelForProvider(provider);
  const baseUrl = (overrides?.baseUrl ?? env.SF_MODEL_BASE_URL)?.trim() || undefined;
  const apiKey = (overrides?.apiKey ?? env.SF_MODEL_API_KEY)?.trim() || undefined;

  let timeoutMs = overrides?.timeoutMs;
  if (timeoutMs === undefined && env.SF_MODEL_TIMEOUT_MS?.trim()) {
    const parsed = Number.parseInt(env.SF_MODEL_TIMEOUT_MS.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ModelProviderConfigurationError(
        provider,
        `Invalid SF_MODEL_TIMEOUT_MS '${env.SF_MODEL_TIMEOUT_MS}'`
      );
    }
    timeoutMs = parsed;
  }

  let allowedHosts = overrides?.allowedHosts;
  if (!allowedHosts && env.SF_MODEL_ALLOWED_HOSTS?.trim()) {
    allowedHosts = env.SF_MODEL_ALLOWED_HOSTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const allowInsecureHttpBaseUrl =
    overrides?.allowInsecureHttpBaseUrl ?? env.SF_MODEL_ALLOW_INSECURE_HTTP === "1";

  return {
    provider,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(overrides?.apiKeyEnvVar ? { apiKeyEnvVar: overrides.apiKeyEnvVar } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(allowInsecureHttpBaseUrl ? { allowInsecureHttpBaseUrl } : {}),
    ...(overrides?.defaultMaxTokens !== undefined
      ? { defaultMaxTokens: overrides.defaultMaxTokens }
      : {}),
    ...(overrides?.defaultTemperature !== undefined
      ? { defaultTemperature: overrides.defaultTemperature }
      : {}),
  };
}

export function createModelProviderClient(
  config: ModelProviderConfig,
  env: NodeJS.ProcessEnv = process.env
): LiveModelProviderClient {
  return new LiveModelProviderClient(config, env);
}

export interface ManagedModelProviderExecutorOptions {
  readonly client: LiveModelProviderClient;
  readonly promptRegistry: PromptRegistry;
  readonly costGuard: CostGuardRecorder;
  readonly pricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
  readonly defaultMaxTokens?: number;
  readonly defaultTemperature?: number;
}

export interface ManagedPromptExecutionInput {
  readonly projectId: string;
  readonly costSessionId: string;
  readonly pipelineSessionId?: string | null;
  readonly taskId?: string | null;
  readonly stage: string;
  readonly promptId: string;
  readonly promptVersion?: string;
  readonly variables?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly outputSchemaOverride?: StructuredJsonSchema;
}

export interface ManagedStructuredExecutionResult<T> {
  readonly parsed: T;
  readonly rawCompletion: ModelCompletionResponse;
  readonly renderedPrompt: RenderedPrompt;
  readonly usage: ModelUsageMetrics;
  readonly actualCostMicroUsd: number;
  readonly ledger: ModelCallLedgerRecord;
  readonly costSession: CostSessionRecord;
}

/**
 * Config-driven Model Executor (`M6A`):
 * Orchestrates immutable `PromptRegistry` versioning, `AC-12b` Pre-Flight Cost Guard,
 * `LiveModelProviderClient` completion, Fail-Closed `StructuredOutputValidation`,
 * and atomic `CostGuardRecorder` Post-Call Ledger accounting.
 */
export class ManagedModelProviderExecutor {
  public readonly client: LiveModelProviderClient;
  public readonly promptRegistry: PromptRegistry;
  public readonly costGuard: CostGuardRecorder;
  public readonly pricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
  public readonly defaultMaxTokens: number;
  public readonly defaultTemperature: number;

  constructor(options: ManagedModelProviderExecutorOptions) {
    this.client = options.client;
    this.promptRegistry = options.promptRegistry;
    this.costGuard = options.costGuard;
    this.pricingOverrides = options.pricingOverrides;
    this.defaultMaxTokens = options.defaultMaxTokens ?? 1024;
    this.defaultTemperature = options.defaultTemperature ?? 0;
  }

  /**
   * Returns a cloned executor bound to a different provider configuration without altering
   * prompts, schemas, or budget tracking state (`AC-01`).
   */
  public withProviderConfig(
    config: ModelProviderConfig,
    env: NodeJS.ProcessEnv = process.env
  ): ManagedModelProviderExecutor {
    return new ManagedModelProviderExecutor({
      client: createModelProviderClient(config, env),
      promptRegistry: this.promptRegistry,
      costGuard: this.costGuard,
      pricingOverrides: this.pricingOverrides,
      defaultMaxTokens: this.defaultMaxTokens,
      defaultTemperature: this.defaultTemperature,
    });
  }

  public async executeStructuredPrompt<T>(
    input: ManagedPromptExecutionInput
  ): Promise<ManagedStructuredExecutionResult<T>> {
    const provider = this.client.config.provider;
    const model = this.client.config.model;
    const maxTokens = input.maxTokens ?? this.defaultMaxTokens;
    const temperature = input.temperature ?? this.defaultTemperature;
    validateGenerationParams(provider, maxTokens, temperature);

    const renderedPrompt = this.promptRegistry.render(
      input.promptId,
      input.promptVersion,
      input.variables ?? {}
    );

    const estimatedInputTokens = estimateTokenCount(
      `${renderedPrompt.systemPrompt}\n${renderedPrompt.userPrompt}`
    );
    const rate = resolveModelPricingRate(provider, model, this.pricingOverrides);
    const estimatedCostMicroUsd = computeCostMicroUsd(estimatedInputTokens, maxTokens, rate);
    const requestSha256 = sha256Hex(
      canonicalizeJson({
        provider,
        model,
        promptId: renderedPrompt.promptId,
        promptVersion: renderedPrompt.version,
        promptSha256: renderedPrompt.promptSha256,
        systemPrompt: renderedPrompt.systemPrompt,
        userPrompt: renderedPrompt.userPrompt,
        maxTokens,
      })
    );

    const preflight = await this.costGuard.preflightCheckCostSession({
      project_id: input.projectId,
      cost_session_id: input.costSessionId,
      pipeline_session_id: input.pipelineSessionId ?? null,
      task_id: input.taskId ?? null,
      stage: input.stage,
      provider,
      model,
      prompt_id: renderedPrompt.promptId,
      prompt_version: renderedPrompt.version,
      prompt_sha256: renderedPrompt.promptSha256,
      request_sha256: requestSha256,
      estimated_input_tokens: estimatedInputTokens,
      reserved_output_tokens: maxTokens,
      estimated_cost_micro_usd: estimatedCostMicroUsd,
    });

    if (!preflight.allowed) {
      throw new CostBudgetExceededError({
        limitScope: preflight.limitScope,
        costSessionId: input.costSessionId,
        ledgerId: preflight.blockedLedger.call_id,
        message: preflight.reason,
        details: {
          stage: input.stage,
          provider,
          model,
          estimatedInputTokens,
          reservedOutputTokens: maxTokens,
          estimatedCostMicroUsd,
          ledgerStatus: preflight.blockedLedger.status,
        },
      });
    }

    const startMs = Date.now();
    let completion: ModelCompletionResponse;
    try {
      completion = await this.client.complete({
        systemPrompt: renderedPrompt.systemPrompt,
        userPrompt: renderedPrompt.userPrompt,
        maxTokens,
        temperature,
      });
    } catch (providerErr: unknown) {
      const latencyMs = Math.max(0, Date.now() - startMs);
      await this.costGuard.finalizeModelCallLedger({
        project_id: input.projectId,
        cost_session_id: input.costSessionId,
        pipeline_session_id: input.pipelineSessionId ?? null,
        task_id: input.taskId ?? null,
        stage: input.stage,
        provider,
        model,
        prompt_id: renderedPrompt.promptId,
        prompt_version: renderedPrompt.version,
        prompt_sha256: renderedPrompt.promptSha256,
        request_sha256: requestSha256,
        estimated_input_tokens: estimatedInputTokens,
        reserved_output_tokens: maxTokens,
        actual_input_tokens: 0,
        actual_output_tokens: 0,
        estimated_cost_micro_usd: estimatedCostMicroUsd,
        actual_cost_micro_usd: 0,
        usage_estimated: false,
        outcome: "FAILED_PROVIDER",
        error_message:
          providerErr instanceof Error ? providerErr.message : String(providerErr),
        latency_ms: latencyMs,
      });
      throw providerErr;
    }

    const latencyMs = Math.max(0, Date.now() - startMs);
    const usage = completion.usage;
    const actualCostMicroUsd = computeCostMicroUsd(usage.inputTokens, usage.outputTokens, rate);
    const schema = input.outputSchemaOverride ?? renderedPrompt.outputSchema;

    let parsed: T;
    if (schema) {
      try {
        parsed = parseAndValidateStructuredOutput<T>(completion.contentText, schema);
      } catch (validationErr: unknown) {
        const validationMsg =
          validationErr instanceof Error ? validationErr.message : String(validationErr);
        const finalizeFailed = await this.costGuard.finalizeModelCallLedger({
          project_id: input.projectId,
          cost_session_id: input.costSessionId,
          pipeline_session_id: input.pipelineSessionId ?? null,
          task_id: input.taskId ?? null,
          stage: input.stage,
          provider,
          model,
          prompt_id: renderedPrompt.promptId,
          prompt_version: renderedPrompt.version,
          prompt_sha256: renderedPrompt.promptSha256,
          request_sha256: requestSha256,
          estimated_input_tokens: estimatedInputTokens,
          reserved_output_tokens: maxTokens,
          actual_input_tokens: usage.inputTokens,
          actual_output_tokens: usage.outputTokens,
          estimated_cost_micro_usd: estimatedCostMicroUsd,
          actual_cost_micro_usd: actualCostMicroUsd,
          usage_estimated: Boolean(usage.usageEstimated),
          outcome: "FAILED_VALIDATION",
          error_message: validationMsg,
          latency_ms: latencyMs,
        });
        if (!finalizeFailed.allowed) {
          throw new CostBudgetExceededError({
            limitScope: finalizeFailed.limitScope ?? "SESSION_COST_BUDGET",
            costSessionId: input.costSessionId,
            ledgerId: finalizeFailed.ledger.call_id,
            message: `${finalizeFailed.reason ?? "Post-call cost budget exceeded"} (after structured output validation failure: ${validationMsg})`,
            cause: validationErr,
            details: {
              stage: input.stage,
              provider,
              model,
              actualInputTokens: usage.inputTokens,
              actualOutputTokens: usage.outputTokens,
              actualCostMicroUsd,
              ledgerStatus: finalizeFailed.ledger.status,
              validationFailed: true,
              validationErrors:
                validationErr instanceof StructuredOutputValidationError
                  ? validationErr.validationErrors
                  : [validationMsg],
            },
          });
        }
        throw validationErr;
      }
    } else {
      parsed = completion.contentText as unknown as T;
    }

    const finalized = await this.costGuard.finalizeModelCallLedger({
      project_id: input.projectId,
      cost_session_id: input.costSessionId,
      pipeline_session_id: input.pipelineSessionId ?? null,
      task_id: input.taskId ?? null,
      stage: input.stage,
      provider,
      model,
      prompt_id: renderedPrompt.promptId,
      prompt_version: renderedPrompt.version,
      prompt_sha256: renderedPrompt.promptSha256,
      request_sha256: requestSha256,
      estimated_input_tokens: estimatedInputTokens,
      reserved_output_tokens: maxTokens,
      actual_input_tokens: usage.inputTokens,
      actual_output_tokens: usage.outputTokens,
      estimated_cost_micro_usd: estimatedCostMicroUsd,
      actual_cost_micro_usd: actualCostMicroUsd,
      usage_estimated: Boolean(usage.usageEstimated),
      outcome: "ALLOWED",
      latency_ms: latencyMs,
    });

    if (!finalized.allowed) {
      throw new CostBudgetExceededError({
        limitScope: finalized.limitScope ?? "SESSION_COST_BUDGET",
        costSessionId: input.costSessionId,
        ledgerId: finalized.ledger.call_id,
        message: finalized.reason ?? "Post-call cost budget exceeded",
        details: {
          stage: input.stage,
          provider,
          model,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          actualCostMicroUsd,
          ledgerStatus: finalized.ledger.status,
        },
      });
    }

    return {
      parsed,
      rawCompletion: completion,
      renderedPrompt,
      usage,
      actualCostMicroUsd,
      ledger: finalized.ledger,
      costSession: finalized.session,
    };
  }
}

