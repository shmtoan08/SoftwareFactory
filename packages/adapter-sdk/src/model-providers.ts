import { canonicalizeJson, sha256Hex } from "@software-factory/shared-types";
import type { TaskContractSpec } from "@software-factory/task-contract";

export type ModelProviderName = "anthropic" | "openai" | "google";

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
  /** Explicitly opt in to plain http:// on non-loopback hosts (unsafe outside tests). Default: false. */
  readonly allowInsecureHttpBaseUrl?: boolean;
  /** Optional hostname allowlist for custom baseUrl endpoints. */
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
}

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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function validateModelBaseUrl(config: ModelProviderConfig): void {
  if (config.baseUrl === undefined) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Invalid model provider baseUrl '${config.baseUrl}' for '${config.provider}'`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Unsupported URL scheme '${parsed.protocol}' in baseUrl '${config.baseUrl}'; expected https://`
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLoopbackHostname(parsed.hostname) &&
    config.allowInsecureHttpBaseUrl !== true
  ) {
    throw new ModelProviderConfigurationError(
      config.provider,
      `Insecure http:// baseUrl '${config.baseUrl}' is forbidden for non-loopback host '${parsed.hostname}'; use https:// or set allowInsecureHttpBaseUrl: true`
    );
  }
  if (config.allowedHosts && config.allowedHosts.length > 0) {
    const normalizedHost = parsed.hostname.toLowerCase();
    const allowed = config.allowedHosts.some((h) => h.trim().toLowerCase() === normalizedHost);
    if (!allowed) {
      throw new ModelProviderConfigurationError(
        config.provider,
        `Model provider baseUrl host '${parsed.hostname}' is not in allowedHosts [${config.allowedHosts.join(", ")}]`
      );
    }
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
 * Fail-closed: throws `ModelProviderConfigurationError` if no API key is configured
 * or if a non-loopback `http://` baseUrl is configured without explicit opt-in.
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
            `Anthropic API error HTTP ${resp.status}: ${await resp.text()}`
          );
        }
        const json = (await resp.json()) as {
          content?: Array<{ type?: string; text?: string }>;
          usage?: Record<string, unknown>;
        };
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
        };
      }

      if (this.config.provider === "openai") {
        const base = (this.config.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
        const endpoint = `${base}/v1/chat/completions`;
        const resp = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.resolvedApiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            max_tokens: maxTokens,
            temperature,
            messages: [
              { role: "system", content: req.systemPrompt },
              { role: "user", content: req.userPrompt },
            ],
          }),
        });
        if (!resp.ok) {
          throw new ModelProviderHttpError(
            "openai",
            resp.status,
            `OpenAI API error HTTP ${resp.status}: ${await resp.text()}`
          );
        }
        const json = (await resp.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: Record<string, unknown>;
        };
        const text = extractTextContent(json.choices?.[0]?.message?.content);
        return {
          provider: "openai",
          model: this.config.model,
          endpoint,
          contentText: text,
          requestSha256,
          rawUsage: json.usage,
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
          `Google Gemini API error HTTP ${resp.status}: ${await resp.text()}`
        );
      }
      const json = (await resp.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: Record<string, unknown>;
      };
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
  const jsonStart = rawText.indexOf("{");
  const jsonEnd = rawText.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return {
      verdict: "FAIL",
      findings: [
        {
          code: "CUSTOM_REVIEW_REJECTION",
          severity: "HIGH",
          detail: `Live model ${client.config.provider}/${client.config.model} returned non-JSON review response`,
        },
      ],
      summaryMarkdown: `### Live Review Result (${client.config.provider}/${client.config.model})\n\nVerdict: FAIL (malformed JSON response)`,
    };
  }

  try {
    const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1)) as {
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
  } catch {
    return {
      verdict: "FAIL",
      findings: [
        {
          code: "CUSTOM_REVIEW_REJECTION",
          severity: "HIGH",
          detail: `Failed to parse live model review JSON from ${client.config.provider}/${client.config.model}`,
        },
      ],
      summaryMarkdown: `### Live Review Result\n\nVerdict: FAIL (JSON parse error)`,
    };
  }
}
