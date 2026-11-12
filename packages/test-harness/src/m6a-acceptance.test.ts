import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  CostBudgetExceededError,
  type CostGuardRecorder,
  InMemoryCostGuardLedger,
  LiveModelProviderClient,
  ManagedModelProviderExecutor,
  ModelProviderConfigurationError,
  ModelProviderHttpError,
  PromptNotFoundError,
  PromptRegistry,
  PromptRenderError,
  PromptVersionConflictError,
  StructuredOutputValidationError,
  computeCostMicroUsd,
  evaluateIndependentReviewWithLiveModel,
  loadModelProviderConfigFromEnv,
  parseAndValidateStructuredOutput,
} from "@software-factory/adapter-sdk";
import {
  CORE_API_AUTH_HEADER,
  CoreApiHttpServer,
  CoreApiService,
  HttpCoreApiClient,
  HttpCoreApiError,
  encodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import {
  Ac10ViolationError,
  PostgresRlsError,
  PostgresRuntimePool,
  SoftwareFactoryControlPlaneStore,
  buildPostgresPoolConfigFromEnv,
} from "@software-factory/database";
import {
  STAGE1_DISCOVERY_PROMPT_ID,
  STAGE2_REQUIREMENTS_PROMPT_ID,
  STAGE3_ARCHITECTURE_PROMPT_ID,
  STAGE4_CONSISTENCY_CHECK_PROMPT_ID,
  STAGE4_CONSISTENCY_CHECK_PROMPT_SHA256,
  createDefaultPipelinePromptRegistry,
  runCrossArtifactConsistencyCheck,
} from "@software-factory/product-pipeline";
import {
  type ModelProviderName,
  type PipelineStageName,
  type ProductPipelineBundle,
  type PromptTemplateSpec,
  type Stage1DiscoveryBundle,
  type Stage2RequirementsSpec,
  type Stage3ArchitectureSpec,
  type StructuredJsonSchema,
  computeCanonicalPayloadSha256,
  sha256Hex,
} from "@software-factory/shared-types";
import { createControlPlaneStackRuntime } from "@software-factory/web";

interface RecordedProviderRequest {
  readonly provider: ModelProviderName;
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly rawBody: Record<string, unknown>;
}

interface ProviderResponseOverride {
  readonly statusCode?: number;
  readonly text?: string;
  readonly jsonBody?: unknown;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly omitUsage?: boolean;
}

interface MockModelProviderHarness {
  readonly anthropicBaseUrl: string;
  readonly openaiBaseUrl: string;
  readonly googleBaseUrl: string;
  readonly hits: Record<ModelProviderName, number>;
  readonly requests: RecordedProviderRequest[];
  setStage1Factory(factory: (req: RecordedProviderRequest) => Stage1DiscoveryBundle): void;
  setResponseOverride(
    provider: ModelProviderName | "any",
    override: ProviderResponseOverride | ((req: RecordedProviderRequest) => ProviderResponseOverride) | null
  ): void;
  resetCounts(): void;
  close(): Promise<void>;
}

function readHttpBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJsonResponse(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    Connection: "close",
  });
  res.end(json);
}

function buildDefaultStage1Bundle(): Stage1DiscoveryBundle {
  return {
    summary: "Deterministic intake extraction separating verified facts from unconfirmed items.",
    facts: [
      {
        title: "Multi-tenant Tenant Isolation",
        statement: "All project data must be strictly isolated per project_id.",
        rationale: "Explicitly required by the customer security mandate.",
      },
      {
        title: "Audit Log Retention",
        statement: "All state transitions must emit an immutable audit trail.",
        rationale: "Explicit compliance requirement stated in raw idea text.",
      },
    ],
    assumptions: [
      {
        title: "OAuth2 SSO Requirement",
        statement: "Enterprise operators authenticate exclusively via OIDC SSO.",
        rationale: "Common enterprise deployment pattern not explicitly confirmed.",
        clarification_question: "Is OIDC SSO mandatory for initial release?",
      },
    ],
    recommendations: [
      {
        title: "Export CSV Billing Summary",
        statement: "Provide monthly CSV download alongside ledger JSON export.",
        rationale: "Helpful convenience for finance reviewers.",
        clarification_question: "Should CSV export be included in v1 scope?",
      },
    ],
  };
}

function buildDynamicStage2Payload(userPrompt: string): Stage2RequirementsSpec {
  const marker = "Verified Stage 1 Items (AUTO_VERIFIED / CONFIRMED only):\n";
  const idx = userPrompt.indexOf(marker);
  if (idx === -1) {
    throw new Error("Mock Stage 2 handler expected confirmed_discovery_items_json marker");
  }
  const jsonText = userPrompt.slice(idx + marker.length).trim();
  const items = JSON.parse(jsonText) as Array<{
    item_id: string;
    kind: string;
    title: string;
    statement: string;
  }>;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Mock Stage 2 received zero verified Stage 1 items");
  }

  const funcReqs = items.slice(0, Math.max(1, items.length - 1)).map((item, pos) => ({
    req_id: `REQ-FUNC-${String(pos + 1).padStart(3, "0")}`,
    title: `Implement ${item.title}`,
    description: item.statement,
    priority: "MUST" as const,
    source_discovery_item_ids: [item.item_id],
    acceptance_criteria: [
      {
        ac_id: `AC-FUNC-${pos + 1}`,
        given: `Verified Stage 1 item ${item.item_id} is active`,
        when: "Operator triggers core workflow",
        then: `${item.title} invariant is enforced deterministically`,
      },
    ],
  }));

  const tailItem = items[items.length - 1]!;
  const nonFuncReqs = [
    {
      req_id: "REQ-NFR-001",
      title: `Audit & Reliability for ${tailItem.title}`,
      description: tailItem.statement,
      priority: "MUST" as const,
      source_discovery_item_ids: [tailItem.item_id],
      acceptance_criteria: [
        {
          ac_id: "AC-NFR-1",
          given: "Production PostgreSQL storage is enabled",
          when: "Operation commits",
          then: "Immutable ledger and SHA-256 digest are verified",
        },
      ],
    },
  ];

  return {
    prd: {
      product_vision: "Deterministic multi-tenant software factory pipeline",
      target_personas: ["Platform Architect", "Project Approver", "Developer"],
      goals: ["Zero hallucinated requirements (AC-10)", "Deterministic baseline freeze"],
      non_goals: ["Unverified auto-execution without human approval"],
    },
    srs: {
      functional_requirements: funcReqs,
      non_functional_requirements: nonFuncReqs,
    },
  };
}

function buildDynamicStage3Payload(userPrompt: string): Stage3ArchitectureSpec {
  const marker = "Stage 2 PRD & SRS:\n";
  const idx = userPrompt.indexOf(marker);
  if (idx === -1) {
    throw new Error("Mock Stage 3 handler expected stage2_prd_srs_json marker");
  }
  const spec = JSON.parse(userPrompt.slice(idx + marker.length).trim()) as Stage2RequirementsSpec;
  const reqIds = [
    ...spec.srs.functional_requirements.map((r) => r.req_id),
    ...spec.srs.non_functional_requirements.map((r) => r.req_id),
  ];

  return {
    architecture: {
      overview: "Hexagonal control plane separating RLS persistence, AI gateway, and verification.",
      components: [
        {
          component_id: "COMP-CONTROL-PLANE",
          name: "ControlPlaneCoreApi",
          responsibility: "Enforces RBAC, cost budgets, AC-10 filtering, and freeze invariants.",
          requirement_ids: reqIds,
        },
      ],
    },
    database_erd: {
      entities: [
        {
          entity_name: "pipeline_spec_ledger",
          primary_key: "artifact_id",
          columns: ["artifact_id UUID", "project_id UUID", "artifact_sha256 CHAR(64)"],
          foreign_keys: ["project_id -> projects(project_id)"],
          rls_tier: "TIER_2",
          requirement_ids: reqIds,
        },
      ],
    },
    api_spec: {
      endpoints: [
        {
          method: "POST",
          path: "/api/v1/projects/:projectId/pipeline-sessions/:id/freeze",
          summary: "Commits immutable BaselineSpecFreeze after Stage 4 consistency & approval",
          auth_role: "PROJECT_APPROVER",
          requirement_ids: reqIds,
        },
      ],
    },
    security_design: {
      threat_controls: [
        {
          threat_id: "THREAT-AC10-HALLUCINATION",
          threat: "Unconfirmed Stage 1 assumption promoted silently into SRS",
          mitigation: "3-layer firewall (context filter + domain check + PG trigger)",
          requirement_ids: reqIds,
        },
      ],
    },
    adrs: [
      {
        adr_id: "ADR-001",
        title: "Enforce Append-Only Stage Artifacts with Canonical SHA-256",
        status: "ACCEPTED",
        context: "Compliance requires cryptographic lineage from Stage 1 discovery to freeze.",
        decision: "Compute canonical JSON SHA-256 and REVOKE UPDATE/DELETE on artifact tables.",
        consequences: "Post-freeze edits require a new pipeline session version.",
        requirement_ids: reqIds,
      },
    ],
  };
}

async function startMockModelProviderServers(): Promise<MockModelProviderHarness> {
  const hits: Record<ModelProviderName, number> = {
    anthropic: 0,
    openai: 0,
    google: 0,
  };
  const requests: RecordedProviderRequest[] = [];
  let stage1Factory: (req: RecordedProviderRequest) => Stage1DiscoveryBundle = () =>
    buildDefaultStage1Bundle();
  const overrides = new Map<
    ModelProviderName | "any",
    ProviderResponseOverride | ((req: RecordedProviderRequest) => ProviderResponseOverride)
  >();

  const makeHandler =
    (provider: ModelProviderName) =>
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      try {
        hits[provider] += 1;
        const bodyText = await readHttpBody(req);
        const body = (bodyText ? JSON.parse(bodyText) : {}) as Record<string, unknown>;

        let systemPrompt = "";
        let userPrompt = "";
        if (provider === "anthropic") {
          systemPrompt = typeof body.system === "string" ? body.system : "";
          const msgs = Array.isArray(body.messages) ? body.messages : [];
          const first = msgs[0] as { content?: unknown } | undefined;
          userPrompt = typeof first?.content === "string" ? first.content : "";
        } else if (provider === "openai") {
          const msgs = Array.isArray(body.messages)
            ? (body.messages as Array<{ role?: string; content?: unknown }>)
            : [];
          systemPrompt =
            typeof msgs.find((m) => m.role === "system")?.content === "string"
              ? (msgs.find((m) => m.role === "system")!.content as string)
              : "";
          userPrompt =
            typeof msgs.find((m) => m.role === "user")?.content === "string"
              ? (msgs.find((m) => m.role === "user")!.content as string)
              : "";
        } else {
          const sys = body.systemInstruction as { parts?: Array<{ text?: string }> } | undefined;
          systemPrompt = sys?.parts?.[0]?.text ?? "";
          const contents = Array.isArray(body.contents)
            ? (body.contents as Array<{ parts?: Array<{ text?: string }> }>)
            : [];
          userPrompt = contents[0]?.parts?.[0]?.text ?? "";
        }

        const recorded: RecordedProviderRequest = {
          provider,
          method: req.method ?? "POST",
          url: req.url ?? "/",
          headers: req.headers,
          systemPrompt,
          userPrompt,
          rawBody: body,
        };
        requests.push(recorded);

        const rawOverride = overrides.get(provider) ?? overrides.get("any");
        const resolvedOverride =
          typeof rawOverride === "function" ? rawOverride(recorded) : rawOverride;

        if (resolvedOverride?.statusCode && resolvedOverride.statusCode >= 400) {
          if (resolvedOverride.jsonBody !== undefined) {
            writeJsonResponse(res, resolvedOverride.statusCode, resolvedOverride.jsonBody);
            return;
          }
          res.writeHead(resolvedOverride.statusCode, { "Content-Type": "text/plain", Connection: "close" });
          res.end(resolvedOverride.text ?? `Simulated HTTP ${resolvedOverride.statusCode}`);
          return;
        }

        let responseText: string;
        if (resolvedOverride?.text !== undefined) {
          responseText = resolvedOverride.text;
        } else if (userPrompt.includes("Verified Stage 1 Items")) {
          responseText = JSON.stringify(buildDynamicStage2Payload(userPrompt));
        } else if (userPrompt.includes("Stage 2 PRD & SRS:")) {
          responseText = JSON.stringify(buildDynamicStage3Payload(userPrompt));
        } else if (userPrompt.includes("Raw Product Idea:")) {
          responseText = JSON.stringify(stage1Factory(recorded));
        } else {
          responseText = JSON.stringify({
            ok: true,
            provider,
            model:
              provider === "google"
                ? (req.url ?? "").split("/models/")[1]?.split(":")[0] ?? "gemini-2.5-pro"
                : String(body.model ?? "unknown"),
          });
        }

        const inputTokens = resolvedOverride?.inputTokens ?? 120;
        const outputTokens = resolvedOverride?.outputTokens ?? 80;
        const omitUsage = resolvedOverride?.omitUsage === true;

        if (provider === "anthropic") {
          writeJsonResponse(res, 200, {
            id: `msg_${hits.anthropic}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            ...(omitUsage
              ? {}
              : {
                  usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    ...(resolvedOverride?.cacheCreationInputTokens !== undefined
                      ? { cache_creation_input_tokens: resolvedOverride.cacheCreationInputTokens }
                      : {}),
                    ...(resolvedOverride?.cacheReadInputTokens !== undefined
                      ? { cache_read_input_tokens: resolvedOverride.cacheReadInputTokens }
                      : {}),
                  },
                }),
          });
          return;
        }
        if (provider === "openai") {
          writeJsonResponse(res, 200, {
            id: `chatcmpl_${hits.openai}`,
            choices: [{ index: 0, message: { role: "assistant", content: responseText } }],
            ...(omitUsage
              ? {}
              : {
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  },
                }),
          });
          return;
        }
        writeJsonResponse(res, 200, {
          candidates: [{ content: { role: "model", parts: [{ text: responseText }] } }],
          ...(omitUsage
            ? {}
            : {
                usageMetadata: {
                  promptTokenCount: inputTokens,
                  candidatesTokenCount: outputTokens,
                  totalTokenCount: inputTokens + outputTokens,
                },
              }),
        });
      } catch (err: unknown) {
        writeJsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    };

  const listenServer = async (provider: ModelProviderName) => {
    const srv = createServer((req, res) => {
      void makeHandler(provider)(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", reject);
        resolve();
      });
    });
    const addr = srv.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`Failed to bind mock ${provider} server`);
    }
    return { server: srv, baseUrl: `http://127.0.0.1:${addr.port}` };
  };

  const [anth, oai, goog] = await Promise.all([
    listenServer("anthropic"),
    listenServer("openai"),
    listenServer("google"),
  ]);

  return {
    anthropicBaseUrl: anth.baseUrl,
    openaiBaseUrl: oai.baseUrl,
    googleBaseUrl: goog.baseUrl,
    hits,
    requests,
    setStage1Factory(factory) {
      stage1Factory = factory;
    },
    setResponseOverride(provider, override) {
      if (override === null) {
        overrides.delete(provider);
      } else {
        overrides.set(provider, override);
      }
    },
    resetCounts() {
      hits.anthropic = 0;
      hits.openai = 0;
      hits.google = 0;
      requests.length = 0;
    },
    async close() {
      await Promise.all(
        [anth.server, oai.server, goog.server].map(
          (srv) =>
            new Promise<void>((resolve) => {
              srv.closeAllConnections?.();
              srv.close(() => resolve());
            })
        )
      );
    },
  };
}

function createEchoRegistry(): PromptRegistry {
  const reg = createDefaultPipelinePromptRegistry();
  reg.register({
    promptId: "m6a.provider.echo",
    version: "1.0.0",
    description: "Provider equivalence probe",
    requiredVariables: ["subject"],
    systemTemplate: "Respond ONLY with JSON matching { ok, provider, model }.",
    userTemplate: "Evaluate subject={{subject}}",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "provider", "model"],
      properties: {
        ok: { type: "boolean" },
        provider: { type: "string", enum: ["anthropic", "openai", "google"] },
        model: { type: "string", minLength: 1 },
      },
    },
  });
  return reg;
}

describe("M6A Acceptance Gates (Model Provider v2, AC-12b Cost Guard & Stages 1–4 Pipeline)", () => {
  it("M6A-AC1: Config-driven runtime multi-provider swap (anthropic/openai/google) and fail-closed config/HTTP validation", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    let httpServer: CoreApiHttpServer | null = null;
    try {
      const registry = createEchoRegistry();
      const ledger = new InMemoryCostGuardLedger();
      const projectId = randomUUID();
      const costSession = ledger.createSession({
        project_id: projectId,
        max_tokens_per_request: 4000,
        max_cost_micro_usd_per_request: 500_000,
        session_token_budget: 20_000,
        session_cost_budget_micro_usd: 2_000_000,
      });

      const baseExecutor = new ManagedModelProviderExecutor({
        client: new LiveModelProviderClient({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        }),
        promptRegistry: registry,
        costGuard: ledger,
      });

      // 1. Runtime config swap purely via env / withProviderConfig on identical prompt
      const envProfiles: Array<{
        provider: ModelProviderName;
        env: NodeJS.ProcessEnv;
      }> = [
        {
          provider: "anthropic",
          env: {
            SF_MODEL_PROVIDER: "anthropic",
            SF_MODEL_NAME: "claude-sonnet-4-20250514",
            SF_MODEL_API_KEY: "test-anthropic-key-local",
            SF_MODEL_BASE_URL: mock.anthropicBaseUrl,
          },
        },
        {
          provider: "openai",
          env: {
            SF_MODEL_PROVIDER: "openai",
            SF_MODEL_NAME: "gpt-4.1",
            SF_MODEL_API_KEY: "test-openai-key-local",
            SF_MODEL_BASE_URL: mock.openaiBaseUrl,
          },
        },
        {
          provider: "google",
          env: {
            SF_MODEL_PROVIDER: "google",
            SF_MODEL_NAME: "gemini-2.5-pro",
            SF_MODEL_API_KEY: "test-google-key-local",
            SF_MODEL_BASE_URL: mock.googleBaseUrl,
          },
        },
      ];

      const shaSet = new Set<string>();
      for (const profile of envProfiles) {
        const cfg = loadModelProviderConfigFromEnv(profile.env);
        const swapped = baseExecutor.withProviderConfig(cfg, profile.env);
        const res = await swapped.executeStructuredPrompt<{
          ok: boolean;
          provider: string;
          model: string;
        }>({
          projectId,
          costSessionId: costSession.cost_session_id,
          stage: "STAGE_1_IDEA_DISCOVERY",
          promptId: "m6a.provider.echo",
          variables: { subject: "equivalence" },
        });
        assert.equal(res.parsed.ok, true);
        assert.equal(res.parsed.provider, profile.provider);
        assert.equal(res.usage.inputTokens, 120);
        assert.equal(res.usage.outputTokens, 80);
        assert.equal(res.usage.totalTokens, 200);
        shaSet.add(res.renderedPrompt.promptSha256);
      }
      assert.equal(shaSet.size, 1, "All 3 providers must execute identical rendered promptSha256");
      assert.equal(mock.hits.anthropic, 1);
      assert.equal(mock.hits.openai, 1);
      assert.equal(mock.hits.google, 1);

      // Verify provider-specific HTTP auth headers
      const anthReq = mock.requests.find((r) => r.provider === "anthropic")!;
      assert.equal(anthReq.headers["x-api-key"], "test-anthropic-key-local");
      assert.equal(anthReq.headers["anthropic-version"], "2023-06-01");
      const oaiReq = mock.requests.find((r) => r.provider === "openai")!;
      assert.equal(oaiReq.headers.authorization, "Bearer test-openai-key-local");
      const googReq = mock.requests.find((r) => r.provider === "google")!;
      assert.equal(googReq.headers["x-goog-api-key"], "test-google-key-local");
      assert.ok(googReq.url.includes("/v1beta/models/gemini-2.5-pro:generateContent"));

      // 2. Fail-closed unit config checks
      assert.throws(
        () =>
          new LiveModelProviderClient(
            { provider: "openai", model: "gpt-4.1", baseUrl: mock.openaiBaseUrl },
            {}
          ),
        (err: unknown) =>
          err instanceof ModelProviderConfigurationError &&
          err.code === "ERR_MODEL_PROVIDER_NOT_CONFIGURED"
      );
      assert.throws(
        () =>
          new LiveModelProviderClient({
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            apiKey: "test-anthropic-key-local",
            baseUrl: "http://api.external-untrusted.example",
          }),
        (err: unknown) =>
          err instanceof ModelProviderConfigurationError &&
          err.code === "ERR_MODEL_PROVIDER_NOT_CONFIGURED"
      );

      // 3. CoreApiHttpServer runtime swapping & fail-closed HTTP 503 / 502 mapping
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: "m6a-ac1-http",
            name: "M6A AC1 HTTP",
            repo_bare_path: "/tmp/m6a-ac1.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "dev-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );

      const coreApi = new CoreApiService(store, {
        env: {},
        defaultModelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        },
      });
      httpServer = new CoreApiHttpServer({ coreApi });
      const { baseUrl } = await httpServer.start();
      const client = new HttpCoreApiClient(baseUrl);
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "dev-alice",
        roles: ["DEVELOPER"],
      });

      const created = await client.createPipelineSession(proj.project_id, authDev, {
        title: "AC1 Runtime Swap",
        raw_idea_text: "Build multi-tenant ledger with strict audit logs.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });

      // Missing key on runtime model_config -> 503 ERR_MODEL_PROVIDER_NOT_CONFIGURED
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(proj.project_id, authDev, created.session.pipeline_session_id, {
            model_config: {
              provider: "openai",
              model: "gpt-4.1",
              baseUrl: mock.openaiBaseUrl,
            },
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 503 &&
          err.body.error_code === "ERR_MODEL_PROVIDER_NOT_CONFIGURED"
      );

      // Non-loopback plain http:// rejected even if caller tries allowInsecureHttpBaseUrl: true over HTTP
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(proj.project_id, authDev, created.session.pipeline_session_id, {
            model_config: {
              provider: "openai",
              model: "gpt-4.1",
              apiKey: "test-openai-key-local",
              baseUrl: "http://evil-remote.example.com",
              allowInsecureHttpBaseUrl: true,
            },
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 503 &&
          err.body.error_code === "ERR_MODEL_PROVIDER_NOT_CONFIGURED"
      );

      // Upstream HTTP 502 -> 502 ERR_MODEL_PROVIDER_UPSTREAM + FAILED_PROVIDER ledger persisted
      mock.setResponseOverride("google", { statusCode: 502, text: "Bad Gateway Upstream" });
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(proj.project_id, authDev, created.session.pipeline_session_id, {
            model_config: {
              provider: "google",
              model: "gemini-2.5-pro",
              apiKey: "test-google-key-local",
              baseUrl: mock.googleBaseUrl,
            },
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 502 &&
          err.body.error_code === "ERR_MODEL_PROVIDER_UPSTREAM"
      );
      mock.setResponseOverride("google", null);

      const costAfter502 = await client.getCostSession(
        proj.project_id,
        authDev,
        created.costSession!.cost_session_id
      );
      assert.ok(costAfter502.ledgers.some((l) => l.status === "FAILED_PROVIDER"));
    } finally {
      await Promise.allSettled([httpServer?.stop(), mock.close()]);
    }
  });

  it("M6A-AC2: Immutable PromptRegistry versioning and fail-closed StructuredOutputValidation with FAILED_VALIDATION billing", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    let httpServer: CoreApiHttpServer | null = null;
    try {
      const registry = createDefaultPipelinePromptRegistry();
      const specV1: PromptTemplateSpec = {
        promptId: "m6a.contract.test",
        version: "1.0.0",
        description: "Test contract v1",
        requiredVariables: ["topic"],
        systemTemplate: "Return JSON for {{topic}}",
        userTemplate: "Topic={{topic}}",
        outputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["priority", "label"],
          properties: {
            priority: { type: "string", enum: ["MUST", "SHOULD"] },
            label: { type: "string", minLength: 1 },
          },
        },
      };
      const regV1 = registry.register(specV1);
      // Idempotent re-register of exact same spec is allowed
      const regV1Repeat = registry.register({ ...specV1 });
      assert.equal(regV1.promptSha256, regV1Repeat.promptSha256);

      // Mutating an already registered (promptId, version) throws PromptVersionConflictError (409)
      assert.throws(
        () =>
          registry.register({
            ...specV1,
            systemTemplate: "Mutated silently!",
          }),
        (err: unknown) =>
          err instanceof PromptVersionConflictError &&
          err.httpStatus === 409 &&
          err.code === "ERR_PROMPT_VERSION_CONFLICT"
      );

      // New version 2.0.0 yields distinct promptSha256
      const regV2 = registry.register({
        ...specV1,
        version: "2.0.0",
        systemTemplate: "Return strict v2 JSON for {{topic}}",
      });
      assert.notEqual(regV1.promptSha256, regV2.promptSha256);

      assert.throws(
        () => registry.render("nonexistent.prompt", "1.0.0", {}),
        (err: unknown) => err instanceof PromptNotFoundError && err.httpStatus === 404
      );
      assert.throws(
        () => registry.render("m6a.contract.test", "1.0.0", {}),
        (err: unknown) => err instanceof PromptRenderError && err.httpStatus === 400
      );

      // Direct fail-closed StructuredJsonSchema validation assertions
      const testSchema = regV1.spec.outputSchema!;
      const validFenced = parseAndValidateStructuredOutput<{ priority: string; label: string }>(
        '```json\n{"priority":"MUST","label":"clean-fence"}\n```',
        testSchema
      );
      assert.equal(validFenced.priority, "MUST");
      assert.equal(validFenced.label, "clean-fence");

      for (const badPayload of [
        'Here is the JSON:\n```json\n{"priority":"MUST","label":"prose"}\n```',
        '{"priority":"MUST","label":"extra","unexpected":1}',
        '{"priority":"COULD","label":"bad-enum"}',
      ]) {
        assert.throws(
          () => parseAndValidateStructuredOutput(badPayload, testSchema),
          (err: unknown) =>
            err instanceof StructuredOutputValidationError &&
            err.httpStatus === 422 &&
            err.code === "ERR_STRUCTURED_OUTPUT_INVALID" &&
            err.validationErrors.length > 0
        );
      }

      // Wire CoreApiHttpServer + mock invalid model responses
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: "m6a-ac2-struct",
            name: "M6A AC2 Structured",
            repo_bare_path: "/tmp/m6a-ac2.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "dev-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );

      const coreApi = new CoreApiService(store, {
        promptRegistry: registry,
        defaultModelConfig: {
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "test-openai-key-local",
          baseUrl: mock.openaiBaseUrl,
        },
      });
      httpServer = new CoreApiHttpServer({ coreApi });
      const { baseUrl } = await httpServer.start();
      const client = new HttpCoreApiClient(baseUrl);
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "dev-alice",
        roles: ["DEVELOPER"],
      });

      const created = await client.createPipelineSession(proj.project_id, authDev, {
        title: "AC2 Structured Failure Test",
        raw_idea_text: "Validate fail-closed schema enforcement.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });

      // (a) Leading/trailing prose wrapping fenced JSON -> 422 ERR_STRUCTURED_OUTPUT_INVALID
      mock.setResponseOverride("openai", {
        text: `Here is the discovery JSON:\n\`\`\`json\n${JSON.stringify(buildDefaultStage1Bundle())}\n\`\`\``,
        inputTokens: 100,
        outputTokens: 50,
      });
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(
            proj.project_id,
            authDev,
            created.session.pipeline_session_id
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 422 &&
          err.body.error_code === "ERR_STRUCTURED_OUTPUT_INVALID"
      );

      // (b) Additional unknown property -> 422
      const withExtraProp = {
        ...buildDefaultStage1Bundle(),
        unexpected_hallucinated_key: true,
      };
      mock.setResponseOverride("openai", {
        text: JSON.stringify(withExtraProp),
        inputTokens: 110,
        outputTokens: 60,
      });
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(
            proj.project_id,
            authDev,
            created.session.pipeline_session_id
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 422 &&
          err.body.error_code === "ERR_STRUCTURED_OUTPUT_INVALID"
      );

      // Verify zero artifacts or discovery items were persisted on invalid output,
      // while FAILED_VALIDATION calls WERE billed and logged durably!
      const bundleAfterInvalid = await client.getPipelineBundle(
        proj.project_id,
        authDev,
        created.session.pipeline_session_id
      );
      assert.equal(bundleAfterInvalid.artifacts.length, 0);
      assert.equal(bundleAfterInvalid.discoveryItems.length, 0);
      assert.equal(bundleAfterInvalid.modelCallLedgers.length, 2);
      assert.ok(bundleAfterInvalid.modelCallLedgers.every((l) => l.status === "FAILED_VALIDATION"));
      assert.equal(bundleAfterInvalid.costSession!.tokens_used_total, 150 + 170);
      assert.ok(bundleAfterInvalid.costSession!.cost_used_micro_usd > 0);

      // (c) Clean single ```json fence (without outside prose) IS accepted
      mock.setResponseOverride("openai", {
        text: `\`\`\`json\n${JSON.stringify(buildDefaultStage1Bundle())}\n\`\`\``,
        inputTokens: 100,
        outputTokens: 50,
      });
      const validOutcome = await client.runPipelineStage1Extract(
        proj.project_id,
        authDev,
        created.session.pipeline_session_id
      );
      assert.equal(validOutcome.artifact.stage, "STAGE_1_IDEA_DISCOVERY");
      assert.equal(validOutcome.ledger.status, "ALLOWED");

      // (d) Invalid enum in Stage 2 (priority: "BLOCKER") -> 422 ERR_STRUCTURED_OUTPUT_INVALID
      const factItem = validOutcome.discoveryItems.find((i) => i.kind === "FACT")!;
      mock.setResponseOverride("openai", {
        text: JSON.stringify({
          prd: {
            product_vision: "v",
            target_personas: ["Dev"],
            goals: ["g"],
            non_goals: [],
          },
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-1",
                title: "t",
                description: "d",
                priority: "BLOCKER",
                source_discovery_item_ids: [factItem.item_id],
                acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
              },
            ],
            non_functional_requirements: [],
          },
        }),
      });
      await assert.rejects(
        () =>
          client.runPipelineStage2Requirements(
            proj.project_id,
            authDev,
            created.session.pipeline_session_id
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 422 &&
          err.body.error_code === "ERR_STRUCTURED_OUTPUT_INVALID"
      );
      mock.setResponseOverride("openai", null);
    } finally {
      await Promise.allSettled([httpServer?.stop(), mock.close()]);
    }
  });

  it("M6A-AC3: AC-12b Per-Request & Cumulative Session Token/Cost Guard in exact integer micro-USD", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    let httpServer: CoreApiHttpServer | null = null;
    try {
      // 1. Exact BigInt integer ceiling math verification (no IEEE-754 drift)
      assert.equal(
        computeCostMicroUsd(1, 0, {
          inputMicroUsdPerMillionTokens: 150_000,
          outputMicroUsdPerMillionTokens: 600_000,
        }),
        1,
        "Fractional micro-USD (0.15) must ceiling cleanly to 1 integer micro-USD"
      );
      assert.equal(
        computeCostMicroUsd(1_000_000, 1_000_000, {
          inputMicroUsdPerMillionTokens: 3_000_000,
          outputMicroUsdPerMillionTokens: 15_000_000,
        }),
        18_000_000
      );

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: "m6a-ac3-cost",
            name: "M6A AC3 Cost Guard",
            repo_bare_path: "/tmp/m6a-ac3.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "dev-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );

      // Pricing rate: input = 1_000_000 micro-USD / 1M tokens (1 micro-USD/token),
      // output = 2_000_000 micro-USD / 1M tokens (2 micro-USD/token).
      const coreApi = new CoreApiService(store, {
        modelPricingOverrides: {
          "anthropic:claude-sonnet-4-20250514": {
            inputMicroUsdPerMillionTokens: 1_000_000,
            outputMicroUsdPerMillionTokens: 2_000_000,
          },
        },
        defaultModelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        },
      });
      httpServer = new CoreApiHttpServer({ coreApi });
      const { baseUrl } = await httpServer.start();
      const client = new HttpCoreApiClient(baseUrl);
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "dev-alice",
        roles: ["DEVELOPER"],
      });

      // Case A: Pre-flight PER_REQUEST_TOKENS & PER_REQUEST_COST -> 0 upstream HTTP calls!
      const tinyCostSess = await client.createCostSession(proj.project_id, authDev, {
        max_tokens_per_request: 250,
        max_cost_micro_usd_per_request: 400,
        session_token_budget: 10_000,
        session_cost_budget_micro_usd: 10_000,
      });
      const tinyPipeline = await client.createPipelineSession(proj.project_id, authDev, {
        cost_session_id: tinyCostSess.cost_session_id,
        title: "Preflight Reject Pipeline",
        raw_idea_text: "Validate preflight rejects over-budget requests before HTTP call.",
      });

      mock.resetCounts();
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(proj.project_id, authDev, tinyPipeline.session.pipeline_session_id, {
            max_tokens: 500, // exceeds max_tokens_per_request=250
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_COST_LIMIT_EXCEEDED" &&
          err.body.limit_scope === "PER_REQUEST_TOKENS"
      );
      assert.equal(mock.hits.anthropic, 0, "PER_REQUEST_TOKENS preflight block must fire 0 HTTP calls");

      // Estimated input tokens for Stage 1 prompt is ~200+ tokens; max_tokens=20 gives ~240 <= 250 tokens
      // but cost ~240*1 + 20*2 = ~280... let's pass a tiny per-request cost cap or small tokens
      const perCostSess = await client.createCostSession(proj.project_id, authDev, {
        max_tokens_per_request: 5000,
        max_cost_micro_usd_per_request: 100, // Stage 1 input ~200 tokens >= 200 micro-USD > 100
        session_token_budget: 10_000,
        session_cost_budget_micro_usd: 10_000,
      });
      await assert.rejects(
        () =>
          client.runPipelineStage1Extract(proj.project_id, authDev, tinyPipeline.session.pipeline_session_id, {
            cost_session_id: perCostSess.cost_session_id,
            max_tokens: 10,
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_COST_LIMIT_EXCEEDED" &&
          err.body.limit_scope === "PER_REQUEST_COST"
      );
      assert.equal(mock.hits.anthropic, 0, "PER_REQUEST_COST preflight block must fire 0 HTTP calls");

      const blockedInfo = await client.getCostSession(
        proj.project_id,
        authDev,
        tinyCostSess.cost_session_id
      );
      assert.equal(blockedInfo.ledgers[0]?.status, "BLOCKED_PREFLIGHT");

      // Case B: Call 1 ALLOWED, Call 2 triggers BLOCKED_POSTCALL & EXHAUSTED, Call 3 SESSION_EXHAUSTED (0 HTTP calls)
      // Budget: session_cost_budget_micro_usd = 1000, max_cost_micro_usd_per_request = 2000
      const postCallPipe = await client.createPipelineSession(proj.project_id, authDev, {
        title: "Postcall Cumulative Budget Pipeline",
        raw_idea_text: "Build billing ledger service.",
        cost_budget: {
          max_tokens_per_request: 2000,
          max_cost_micro_usd_per_request: 2000,
          session_token_budget: 1200,
          session_cost_budget_micro_usd: 1000,
        },
      });
      const csId = postCallPipe.costSession!.cost_session_id;

      // Call 1: actual input=100, output=100 -> 200 tokens, 100*1 + 100*2 = 300 micro-USD (<= 1000)
      mock.resetCounts();
      mock.setResponseOverride("anthropic", { inputTokens: 100, outputTokens: 100 });
      const call1 = await client.runPipelineStage1Extract(
        proj.project_id,
        authDev,
        postCallPipe.session.pipeline_session_id,
        { max_tokens: 50 }
      );
      assert.equal(call1.costSession.tokens_used_total, 200);
      assert.equal(call1.costSession.cost_used_micro_usd, 300);
      assert.equal(call1.costSession.status, "ACTIVE");
      assert.equal(mock.hits.anthropic, 1);

      // Call 2 (Stage 2): confirm assumption first, then let preflight pass (max_tokens=16 -> est cost < 400, remaining 700),
      // while actual provider returns input=400, output=300 (cost = 400 + 600 = 1000 -> total 1300 > 1000!)
      const assumItem = call1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      await client.resolvePipelineStage1Item(
        proj.project_id,
        authDev,
        postCallPipe.session.pipeline_session_id,
        assumItem.item_id,
        { decision: "CONFIRM" }
      );

      mock.setResponseOverride("anthropic", { inputTokens: 400, outputTokens: 300 });
      await assert.rejects(
        () =>
          client.runPipelineStage2Requirements(
            proj.project_id,
            authDev,
            postCallPipe.session.pipeline_session_id,
            { max_tokens: 16 }
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_SESSION_BUDGET_EXCEEDED" &&
          err.body.limit_scope === "SESSION_COST_BUDGET"
      );
      assert.equal(mock.hits.anthropic, 2, "Call 2 executed once before postcall detected overage");

      // Session must now be EXHAUSTED, ledger[1] must be BLOCKED_POSTCALL, and Stage 2 artifact must NOT exist!
      const afterOver = await client.getCostSession(proj.project_id, authDev, csId);
      assert.equal(afterOver.session.status, "EXHAUSTED");
      assert.equal(afterOver.session.tokens_used_total, 200 + 700);
      assert.equal(afterOver.session.cost_used_micro_usd, 300 + 1000);
      assert.equal(afterOver.ledgers[1]?.status, "BLOCKED_POSTCALL");

      const bundleOver = await client.getPipelineBundle(
        proj.project_id,
        authDev,
        postCallPipe.session.pipeline_session_id
      );
      assert.equal(
        bundleOver.artifacts.filter((a) => a.stage === "STAGE_2_REQUIREMENTS").length,
        0,
        "Artifact must NOT be persisted when postcall exceeds session budget"
      );

      // Call 3 on EXHAUSTED session -> immediate preflight SESSION_EXHAUSTED with 0 HTTP calls!
      mock.setResponseOverride("anthropic", null);
      await assert.rejects(
        () =>
          client.runPipelineStage2Requirements(
            proj.project_id,
            authDev,
            postCallPipe.session.pipeline_session_id,
            { max_tokens: 16 }
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_SESSION_BUDGET_EXCEEDED" &&
          err.body.limit_scope === "SESSION_EXHAUSTED"
      );
      assert.equal(mock.hits.anthropic, 2, "EXHAUSTED session must block Call 3 with 0 HTTP hits");

      // Direct CostBudgetExceededError unit assertion
      const unitExec = new ManagedModelProviderExecutor({
        client: new LiveModelProviderClient({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        }),
        promptRegistry: createDefaultPipelinePromptRegistry(),
        costGuard: store as CostGuardRecorder,
      });
      await assert.rejects(
        () =>
          unitExec.executeStructuredPrompt({
            projectId: proj.project_id,
            costSessionId: csId,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            variables: {
              project_id: proj.project_id,
              pipeline_session_id: postCallPipe.session.pipeline_session_id,
              title: "Blocked",
              raw_idea_text: "Blocked",
            },
          }),
        (err: unknown) => err instanceof CostBudgetExceededError && err.limitScope === "SESSION_EXHAUSTED"
      );
    } finally {
      await Promise.allSettled([httpServer?.stop(), mock.close()]);
    }
  });

  it("M6A-AC4: AC-10 Anti-Hallucination & Stage 1 Confirmation Firewall (3-Layer Enforcement)", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    let httpServer: CoreApiHttpServer | null = null;
    try {
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: "m6a-ac4-ac10",
            name: "M6A AC4 AC-10",
            repo_bare_path: "/tmp/m6a-ac4.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "dev-alice",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );

      const coreApi = new CoreApiService(store, {
        defaultModelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        },
      });
      httpServer = new CoreApiHttpServer({ coreApi });
      const { baseUrl } = await httpServer.start();
      const client = new HttpCoreApiClient(baseUrl);
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "dev-alice",
        roles: ["DEVELOPER"],
      });

      // 1. Direct ASSUMPTION with AUTO_VERIFIED must fail closed
      const pOnlyAssump = await client.createPipelineSession(proj.project_id, authDev, {
        title: "Unconfirmed-Only Session",
        raw_idea_text: "Only hypotheses so far.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });

      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "dev-alice",
              currentRole: "core_api_service",
            },
            () =>
              store.createStage1DiscoveryItems({
                project_id: proj.project_id,
                pipeline_session_id: pOnlyAssump.session.pipeline_session_id,
                items: [
                  {
                    kind: "ASSUMPTION",
                    title: "Direct Bypass",
                    statement: "Should never auto-verify",
                    rationale: "Negative probe",
                    confirmation_status: "AUTO_VERIFIED",
                  },
                ],
              })
          ),
        (err: unknown) =>
          err instanceof Ac10ViolationError && err.code === "ERR_AC10_UNCONFIRMED_ASSUMPTION"
      );

      // 2. Stage 1 returns ONLY unconfirmed Assumption + Recommendation (0 facts) -> Stage 2 blocked with 0 HTTP calls!
      mock.setStage1Factory(() => ({
        summary: "Hypotheses needing clarification",
        facts: [],
        assumptions: [
          {
            title: "Need Postgres HA?",
            statement: "Assume multi-AZ failover is desired.",
            rationale: "Enterprise SLA assumption",
            clarification_question: "Confirm multi-AZ requirement?",
          },
        ],
        recommendations: [
          {
            title: "Add Webhook Retry",
            statement: "Recommend exponential backoff webhooks.",
            rationale: "Best practice",
            clarification_question: "Include webhook retry in v1?",
          },
        ],
      }));

      const s1OnlyAssump = await client.runPipelineStage1Extract(
        proj.project_id,
        authDev,
        pOnlyAssump.session.pipeline_session_id
      );
      assert.equal(s1OnlyAssump.discoveryItems.length, 2);
      assert.ok(s1OnlyAssump.discoveryItems.every((i) => i.confirmation_status === "UNCONFIRMED"));
      assert.ok(s1OnlyAssump.discoveryItems.every((i) => Boolean(i.clarification_question)));

      const unconfirmedAssump = s1OnlyAssump.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const unconfirmedRec = s1OnlyAssump.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;

      const hitsBeforeStage2Fail = mock.hits.anthropic;
      await assert.rejects(
        () =>
          client.runPipelineStage2Requirements(
            proj.project_id,
            authDev,
            pOnlyAssump.session.pipeline_session_id
          ),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 422 &&
          err.body.error_code === "ERR_AC10_UNCONFIRMED_ASSUMPTION" &&
          Array.isArray(err.body.offending_item_ids) &&
          (err.body.offending_item_ids as string[]).includes(unconfirmedAssump.item_id)
      );
      assert.equal(
        mock.hits.anthropic,
        hitsBeforeStage2Fail,
        "AC-10 precondition must block Stage 2 before calling model provider"
      );

      // 3. Layer 2 Domain Validation blocks Stage 2 artifact directly citing UNCONFIRMED item ID
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "dev-alice",
              currentRole: "core_api_service",
            },
            () =>
              store.recordStageArtifact({
                project_id: proj.project_id,
                pipeline_session_id: pOnlyAssump.session.pipeline_session_id,
                stage: "STAGE_2_REQUIREMENTS",
                artifact_kind: "STAGE_2_PRD_SRS",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE2_REQUIREMENTS_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                created_by_principal_id: "dev-alice",
                content_json: {
                  prd: {
                    product_vision: "test",
                    target_personas: ["Op"],
                    goals: ["g"],
                    non_goals: [],
                  },
                  srs: {
                    functional_requirements: [
                      {
                        req_id: "REQ-HALLUCINATED-1",
                        title: "Tampered",
                        description: "Cites unconfirmed item",
                        priority: "MUST",
                        source_discovery_item_ids: [unconfirmedAssump.item_id],
                        acceptance_criteria: [
                          { ac_id: "AC-1", given: "g", when: "w", then: "t" },
                        ],
                      },
                    ],
                    non_functional_requirements: [],
                  },
                },
              })
          ),
        (err: unknown) =>
          err instanceof Ac10ViolationError &&
          err.offendingItemIds.includes(unconfirmedAssump.item_id)
      );

      // 4. Confirm Assumption, keep Recommendation REJECTED -> Layer 1 filters out REJECTED & UNCONFIRMED,
      // passes ONLY CONFIRMED item to Stage 2, and unblocks Stage 2 cleanly!
      const confirmedAssump = await client.resolvePipelineStage1Item(
        proj.project_id,
        authDev,
        pOnlyAssump.session.pipeline_session_id,
        unconfirmedAssump.item_id,
        { decision: "CONFIRM", resolution_note: "Customer confirmed Multi-AZ is required" }
      );
      assert.equal(confirmedAssump.confirmation_status, "CONFIRMED");

      const rejectedRec = await client.resolvePipelineStage1Item(
        proj.project_id,
        authDev,
        pOnlyAssump.session.pipeline_session_id,
        unconfirmedRec.item_id,
        { decision: "REJECT", resolution_note: "Deferred webhook retry out of v1" }
      );
      assert.equal(rejectedRec.confirmation_status, "REJECTED");

      // Also verify Layer 2 rejects citing REJECTED item ID
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "dev-alice",
              currentRole: "core_api_service",
            },
            () =>
              store.recordStageArtifact({
                project_id: proj.project_id,
                pipeline_session_id: pOnlyAssump.session.pipeline_session_id,
                stage: "STAGE_2_REQUIREMENTS",
                artifact_kind: "STAGE_2_PRD_SRS",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE2_REQUIREMENTS_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                created_by_principal_id: "dev-alice",
                content_json: {
                  prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
                  srs: {
                    functional_requirements: [
                      {
                        req_id: "REQ-REJECTED-REF",
                        title: "Rejected",
                        description: "Cites rejected item",
                        priority: "MUST",
                        source_discovery_item_ids: [rejectedRec.item_id],
                        acceptance_criteria: [
                          { ac_id: "AC-1", given: "g", when: "w", then: "t" },
                        ],
                      },
                    ],
                    non_functional_requirements: [],
                  },
                },
              })
          ),
        (err: unknown) =>
          err instanceof Ac10ViolationError && err.offendingItemIds.includes(rejectedRec.item_id)
      );

      // Execute Stage 2 after human CONFIRM: inspect exact LLM request payload!
      mock.resetCounts();
      const s2Outcome = await client.runPipelineStage2Requirements(
        proj.project_id,
        authDev,
        pOnlyAssump.session.pipeline_session_id
      );
      assert.equal(mock.requests.length, 1);
      const stage2PromptSent = mock.requests[0]!.userPrompt;
      assert.ok(
        stage2PromptSent.includes(confirmedAssump.item_id),
        "CONFIRMED item ID must enter Stage 2 context"
      );
      assert.equal(
        stage2PromptSent.includes(rejectedRec.item_id),
        false,
        "REJECTED item ID must be filtered out of Stage 2 context (Layer 1 firewall)"
      );
      assert.equal(s2Outcome.artifact.stage, "STAGE_2_REQUIREMENTS");
    } finally {
      await Promise.allSettled([httpServer?.stop(), mock.close()]);
    }
  });

  it("M6A-AC5: End-to-End Stages 1 -> Q&A -> 2 -> 3 -> 4 Checker -> Web Approval Gate -> FROZEN BaselineSpecFreeze", async () => {
    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);
      const webBaseUrl = stack.webEndpoint!.baseUrl;

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-ac5-e2e-${randomUUID().slice(0, 8)}`,
            name: "M6A AC5 Full E2E",
            repo_bare_path: "/tmp/m6a-ac5.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      const created = await coreClient.createPipelineSession(proj.project_id, authDev, {
        title: "Factory Billing Control Plane",
        raw_idea_text: "Build multi-tenant ledger with immutable audit logs and freeze approval.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 50_000,
          session_cost_budget_micro_usd: 10_000_000,
        },
      });
      const sessionId = created.session.pipeline_session_id;

      // Stage 1 using default Anthropic provider
      const s1 = await coreClient.runPipelineStage1Extract(proj.project_id, authDev, sessionId);
      assert.equal(s1.session.current_stage, "STAGE_1_IDEA_DISCOVERY");
      assert.equal(s1.ledger.provider, "anthropic");

      const facts = s1.discoveryItems.filter((i) => i.kind === "FACT");
      const assumption = s1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const rec = s1.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;
      assert.ok(facts.length >= 2);
      assert.ok(facts.every((f) => f.confirmation_status === "AUTO_VERIFIED"));
      assert.equal(assumption.confirmation_status, "UNCONFIRMED");
      assert.equal(rec.confirmation_status, "UNCONFIRMED");

      // Confirm Assumption, Reject Recommendation
      await coreClient.resolvePipelineStage1Item(proj.project_id, authDev, sessionId, assumption.item_id, {
        decision: "CONFIRM",
        resolution_note: "Confirmed OIDC SSO for operators",
      });
      await coreClient.resolvePipelineStage1Item(proj.project_id, authDev, sessionId, rec.item_id, {
        decision: "REJECT",
        resolution_note: "CSV export deferred to M7",
      });

      // Stage 2 swapping provider cleanly to OpenAI
      const s2 = await coreClient.runPipelineStage2Requirements(proj.project_id, authDev, sessionId, {
        model_config: {
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "test-openai-key-local",
          baseUrl: mock.openaiBaseUrl,
        },
      });
      assert.equal(s2.session.current_stage, "STAGE_2_REQUIREMENTS");
      assert.equal(s2.artifact.provider, "openai");
      assert.equal(s2.artifact.prompt_id, STAGE2_REQUIREMENTS_PROMPT_ID);

      // Stage 3 swapping provider cleanly to Google Gemini
      const s3 = await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, sessionId, {
        model_config: {
          provider: "google",
          model: "gemini-2.5-pro",
          apiKey: "test-google-key-local",
          baseUrl: mock.googleBaseUrl,
        },
      });
      assert.equal(s3.session.current_stage, "STAGE_3_ARCHITECTURE");
      assert.equal(s3.artifact.provider, "google");
      assert.equal(s3.artifact.prompt_id, STAGE3_ARCHITECTURE_PROMPT_ID);

      // Stage 4 Deterministic CrossArtifactConsistencyChecker
      const s4 = await coreClient.runPipelineStage4ConsistencyCheck(
        proj.project_id,
        authDev,
        sessionId
      );
      assert.equal(s4.session.current_stage, "STAGE_4_SPEC_FREEZE");
      assert.equal(s4.report.passed, true);
      assert.equal(s4.report.checks.length, 5);
      assert.ok(s4.report.checks.every((c) => c.passed));

      // Inspect Web Console HTML, Markdown, and JSON views
      const htmlResp = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessionId)}?format=html`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) } }
      );
      assert.equal(htmlResp.status, 200);
      const htmlText = await htmlResp.text();
      assert.ok(htmlText.includes("Factory Billing Control Plane"));
      assert.ok(htmlText.includes(s3.artifact.artifact_sha256));

      const mdResp = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessionId)}?format=md`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) } }
      );
      assert.equal(mdResp.status, 200);
      const mdText = await mdResp.text();
      assert.ok(mdText.includes("# Product Pipeline — Factory Billing Control Plane"));
      assert.ok(mdText.includes("## Stage 4 Consistency Check"));

      const jsonResp = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessionId)}?format=json`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) } }
      );
      assert.equal(jsonResp.status, 200);
      const preFreezeBundle = (await jsonResp.json()) as ProductPipelineBundle;
      assert.equal(preFreezeBundle.artifacts.length, 4);

      // Web Console: PROJECT_APPROVER submits STAGE_4_SPEC_FREEZE Approval Gate & Freeze
      const webGateResp = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessionId)}/approval-gates`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: JSON.stringify({
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "APPROVED",
            rationale: "All CHK-01..CHK-05 passed and Stage 1..3 hashes verified.",
          }),
        }
      );
      assert.equal(webGateResp.status, 201);
      const gate = (await webGateResp.json()) as {
        gate_id: string;
        target_artifact_id: string;
        target_artifact_sha256: string;
      };
      assert.equal(gate.target_artifact_id, s4.artifact.artifact_id);
      assert.equal(gate.target_artifact_sha256, s4.artifact.artifact_sha256);

      const webFreezeResp = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessionId)}/freeze`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: JSON.stringify({
            approval_gate_id: gate.gate_id,
          }),
        }
      );
      assert.equal(webFreezeResp.status, 201);
      const frozen = (await webFreezeResp.json()) as {
        baseline_id: string;
        status: string;
        freeze_bundle_sha256: string;
      };
      assert.equal(frozen.status, "FROZEN");

      // Verify final bundle, SHA-256 digests, cost accumulation across 3 providers, and outbox event
      const finalBundle = await coreClient.getPipelineBundle(proj.project_id, authDev, sessionId);
      assert.equal(finalBundle.session.status, "FROZEN");
      assert.equal(finalBundle.session.frozen_baseline_id, frozen.baseline_id);
      assert.equal(finalBundle.baselineFreeze?.baseline_id, frozen.baseline_id);
      assert.equal(finalBundle.modelCallLedgers.length, 3);
      assert.deepEqual(
        finalBundle.modelCallLedgers.map((l) => l.provider),
        ["anthropic", "openai", "google"]
      );
      const sumTokens = finalBundle.modelCallLedgers.reduce((acc, l) => acc + l.actual_total_tokens, 0);
      const sumCost = finalBundle.modelCallLedgers.reduce((acc, l) => acc + l.actual_cost_micro_usd, 0);
      assert.equal(finalBundle.costSession?.tokens_used_total, sumTokens);
      assert.equal(finalBundle.costSession?.cost_used_micro_usd, sumCost);
      assert.ok(sumCost > 0);

      for (const art of finalBundle.artifacts) {
        assert.equal(
          computeCanonicalPayloadSha256(art.content_json),
          art.artifact_sha256,
          `Artifact ${art.stage} SHA-256 must match canonical JSON`
        );
      }

      const outboxEvents = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () => store.listOutboxEventsForProject()
      );
      assert.ok(
        outboxEvents.some(
          (ev) =>
            ev.event_type === "pipeline.baseline_frozen" &&
            ev.aggregate_id === sessionId
        )
      );
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });

  it("M6A-AC6: Checker rejection blocks freeze (422), DEVELOPER RBAC 403, Cross-Tenant isolation & FROZEN immutability", async () => {
    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);
      const webBaseUrl = stack.webEndpoint!.baseUrl;

      let projAId = "";
      let projBId = "";
      await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const ac6Suffix = randomUUID().slice(0, 8);
          const pA = await store.createProject({
            slug: `m6a-ac6-a-${ac6Suffix}`,
            name: "M6A AC6 Project A",
            repo_bare_path: "/tmp/m6a-ac6-a.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          const pB = await store.createProject({
            slug: `m6a-ac6-b-${ac6Suffix}`,
            name: "M6A AC6 Project B",
            repo_bare_path: "/tmp/m6a-ac6-b.git",
            initial_main_commit_hash: "3".repeat(40),
            initial_main_tree_hash: "4".repeat(40),
          });
          projAId = pA.project_id;
          projBId = pB.project_id;
          await store.addProjectMembership({
            project_id: projAId,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: projAId,
            principal_id: "auditor-carol",
            member_role: "AUDITOR",
          });
          await store.addProjectMembership({
            project_id: projAId,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          await store.addProjectMembership({
            project_id: projBId,
            principal_id: "eve-b-approver",
            member_role: "PROJECT_APPROVER",
          });
        }
      );

      const authDevA = coreApi.issueAuthContext({
        projectId: projAId,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authAuditorA = coreApi.issueAuthContext({
        projectId: projAId,
        principalId: "auditor-carol",
        roles: ["AUDITOR"],
      });
      const authApproverA = coreApi.issueAuthContext({
        projectId: projAId,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });
      const authApproverB = coreApi.issueAuthContext({
        projectId: projBId,
        principalId: "eve-b-approver",
        roles: ["PROJECT_APPROVER"],
      });

      // 1. Standalone Checker unit negative probes (CHK-02, CHK-03, CHK-04, CHK-05)
      const nowIso = new Date().toISOString();
      const s1Items = [
        {
          item_id: randomUUID(),
          project_id: projAId,
          pipeline_session_id: randomUUID(),
          kind: "FACT" as const,
          title: "Fact 1",
          statement: "S1",
          rationale: "R1",
          clarification_question: null,
          confirmation_status: "AUTO_VERIFIED" as const,
          confirmed_by_principal_id: null,
          confirmed_at: null,
          resolution_note: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
        {
          item_id: randomUUID(),
          project_id: projAId,
          pipeline_session_id: randomUUID(),
          kind: "FACT" as const,
          title: "Uncovered Fact 2",
          statement: "S2",
          rationale: "R2",
          clarification_question: null,
          confirmation_status: "AUTO_VERIFIED" as const,
          confirmed_by_principal_id: null,
          confirmed_at: null,
          resolution_note: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
      ];
      const sessRefId = s1Items[0]!.pipeline_session_id;
      const fixedItems = s1Items.map((x) => ({ ...x, pipeline_session_id: sessRefId }));
      const badS2Json: Stage2RequirementsSpec = {
        prd: { product_vision: "v", target_personas: ["p"], goals: ["g"], non_goals: [] },
        srs: {
          functional_requirements: [
            {
              req_id: "REQ-DUP",
              title: "Req 1",
              description: "d",
              priority: "MUST",
              source_discovery_item_ids: [fixedItems[0]!.item_id],
              acceptance_criteria: [],
            },
            {
              req_id: "REQ-DUP",
              title: "Duplicate Req",
              description: "d2",
              priority: "SHOULD",
              source_discovery_item_ids: [fixedItems[0]!.item_id],
              acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
            },
          ],
          non_functional_requirements: [],
        },
      };
      const badS3Json: Stage3ArchitectureSpec = {
        architecture: {
          overview: "",
          components: [],
        },
        database_erd: { entities: [] },
        api_spec: { endpoints: [] },
        security_design: { threat_controls: [] },
        adrs: [
          {
            adr_id: "ADR-DANGLING",
            title: "Dangling",
            status: "ACCEPTED",
            context: "c",
            decision: "d",
            consequences: "c",
            requirement_ids: ["REQ-NONEXISTENT"],
          },
        ],
      };
      const mkArt = (
        stage: PipelineStageName,
        kind:
          | "STAGE_1_DISCOVERY_BUNDLE"
          | "STAGE_2_PRD_SRS"
          | "STAGE_3_ARCHITECTURE_DESIGN",
        content: Record<string, unknown>,
        tamperedHash?: string
      ) => ({
        artifact_id: randomUUID(),
        project_id: projAId,
        pipeline_session_id: sessRefId,
        stage,
        artifact_kind: kind,
        version: 1,
        provider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
        prompt_id: "p",
        prompt_version: "1.0.0",
        prompt_sha256: "a".repeat(64),
        content_json: content,
        artifact_sha256: tamperedHash ?? computeCanonicalPayloadSha256(content),
        created_by_principal_id: "alice-dev",
        created_at: nowIso,
      });

      const unitCheck = runCrossArtifactConsistencyCheck({
        pipelineSessionId: sessRefId,
        stage1Items: fixedItems,
        stage1Artifact: mkArt("STAGE_1_IDEA_DISCOVERY", "STAGE_1_DISCOVERY_BUNDLE", { ok: true }),
        stage2Artifact: mkArt("STAGE_2_REQUIREMENTS", "STAGE_2_PRD_SRS", badS2Json as unknown as Record<string, unknown>),
        stage3Artifact: mkArt(
          "STAGE_3_ARCHITECTURE",
          "STAGE_3_ARCHITECTURE_DESIGN",
          badS3Json as unknown as Record<string, unknown>,
          "0".repeat(64)
        ),
      });
      assert.equal(unitCheck.passed, false);
      assert.equal(unitCheck.checks.find((c) => c.check_id === "CHK-02")?.passed, false);
      assert.equal(unitCheck.checks.find((c) => c.check_id === "CHK-03")?.passed, false);
      assert.equal(unitCheck.checks.find((c) => c.check_id === "CHK-04")?.passed, false);
      assert.equal(unitCheck.checks.find((c) => c.check_id === "CHK-05")?.passed, false);

      // 2. Live pipeline: Stage 3 returns empty adrs (valid schema, fails CHK-04!) -> Checker blocks freeze!
      const badPipe = await coreClient.createPipelineSession(projAId, authDevA, {
        title: "Checker Rejection Gate Test",
        raw_idea_text: "Needs full 5-part architecture.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });
      const badSessId = badPipe.session.pipeline_session_id;
      const badS1 = await coreClient.runPipelineStage1Extract(projAId, authDevA, badSessId);
      const badAssump = badS1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const badRec = badS1.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;
      await coreClient.resolvePipelineStage1Item(projAId, authDevA, badSessId, badAssump.item_id, {
        decision: "REJECT",
      });
      await coreClient.resolvePipelineStage1Item(projAId, authDevA, badSessId, badRec.item_id, {
        decision: "REJECT",
      });
      await coreClient.runPipelineStage2Requirements(projAId, authDevA, badSessId);

      // Force Stage 3 to return empty `adrs: []` (matches JSON schema, violates CHK-04!)
      mock.setResponseOverride("anthropic", (req) => ({
        text: JSON.stringify({
          ...buildDynamicStage3Payload(req.userPrompt),
          adrs: [],
        }),
      }));
      await coreClient.runPipelineStage3Architecture(projAId, authDevA, badSessId);
      mock.setResponseOverride("anthropic", null);

      const badS4 = await coreClient.runPipelineStage4ConsistencyCheck(projAId, authDevA, badSessId);
      assert.equal(badS4.report.passed, false);
      assert.equal(badS4.report.checks.find((c) => c.check_id === "CHK-04")?.passed, false);

      // Even if approver records a gate decision against the failed report, freeze MUST fail closed with 422!
      const badGate = await coreClient.submitPipelineApprovalGate(projAId, authApproverA, badSessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: badS4.artifact.artifact_id,
        target_artifact_sha256: badS4.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(projAId, authApproverA, badSessId, {
            approval_gate_id: badGate.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // 3. Produce a clean Stage 3 & Stage 4 on the same session to verify RBAC + FROZEN immutability
      const goodS3 = await coreClient.runPipelineStage3Architecture(projAId, authDevA, badSessId);
      const goodS4 = await coreClient.runPipelineStage4ConsistencyCheck(projAId, authDevA, badSessId, {
        stage3_artifact_id: goodS3.artifact.artifact_id,
      });
      assert.equal(goodS4.report.passed, true);

      // AUDITOR cannot execute Stage 1..4 extraction/check (403)
      await assert.rejects(
        () => coreClient.runPipelineStage4ConsistencyCheck(projAId, authAuditorA, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      // DEVELOPER cannot approve gate or freeze on Core API OR Web Console (403)
      await assert.rejects(
        () =>
          coreClient.submitPipelineApprovalGate(projAId, authDevA, badSessId, {
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "APPROVED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      const devWebGate = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(projAId)}/pipeline-sessions/${encodeURIComponent(badSessId)}/approval-gates`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: JSON.stringify({
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "APPROVED",
          }),
        }
      );
      assert.equal(devWebGate.status, 403);

      // Tampered target_artifact_sha256 rejected by composite FK / validation
      await assert.rejects(
        () =>
          coreClient.submitPipelineApprovalGate(projAId, authApproverA, badSessId, {
            gate_stage: "STAGE_4_SPEC_FREEZE",
            target_artifact_id: goodS4.artifact.artifact_id,
            target_artifact_sha256: "f".repeat(64),
            decision: "APPROVED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 404
      );

      // Cross-tenant isolation: Project B Approver cannot view, approve, or freeze Project A session
      await assert.rejects(
        () => coreClient.getPipelineBundle(projAId, authApproverB, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      await assert.rejects(
        () =>
          coreClient.submitPipelineApprovalGate(projBId, authApproverB, badSessId, {
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "APPROVED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 404
      );

      // Approver approves goodS4 and freezes baseline, while DEVELOPER freeze attempt returns 403
      const goodGate = await coreClient.submitPipelineApprovalGate(projAId, authApproverA, badSessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: goodS4.artifact.artifact_id,
        target_artifact_sha256: goodS4.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(projAId, authDevA, badSessId, {
            approval_gate_id: goodGate.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      const frozen = await coreClient.freezePipelineBaseline(projAId, authApproverA, badSessId, {
        approval_gate_id: goodGate.gate_id,
      });
      assert.equal(frozen.status, "FROZEN");

      // 4. FROZEN Immutability: any post-freeze resolve, re-generation, check, or duplicate freeze fails closed with 0 LLM hits!
      mock.resetCounts();
      await assert.rejects(
        () =>
          coreClient.resolvePipelineStage1Item(projAId, authDevA, badSessId, badAssump.item_id, {
            decision: "CONFIRM",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () => coreClient.runPipelineStage1Extract(projAId, authDevA, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () => coreClient.runPipelineStage2Requirements(projAId, authDevA, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () => coreClient.runPipelineStage3Architecture(projAId, authDevA, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () => coreClient.runPipelineStage4ConsistencyCheck(projAId, authDevA, badSessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(projAId, authApproverA, badSessId, {
            approval_gate_id: goodGate.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && (err.statusCode === 422 || err.statusCode === 409)
      );
      assert.equal(mock.hits.anthropic, 0, "FROZEN pipeline must trigger 0 model provider calls");
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });

  it("M6A-AC7: Live PostgreSQL 16/17 (0006): FORCE RLS across 7 tables, Append-Only & Column GRANTs, SQL Triggers, JSONB SHA-256 Round-Trip & Live HTTP E2E", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      poolConfig: pgConfig,
      requirePostgres: true,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      assert.equal(stack.mode, "postgres");
      assert.ok(stack.pool !== null);
      const pool = stack.pool!;
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);
      const webBaseUrl = stack.webEndpoint!.baseUrl;

      const suffix = randomUUID().slice(0, 8);
      let projectAId = "";
      let projectBId = "";
      await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "m6a-pg-bootstrap" },
        async () => {
          const pA = await store.createProject({
            slug: `m6a-pg-a-${suffix}`,
            name: `M6A PG Project A ${suffix}`,
            repo_bare_path: `/tmp/m6a-pg-a-${suffix}.git`,
            initial_main_commit_hash: "a".repeat(40),
            initial_main_tree_hash: "b".repeat(40),
          });
          const pB = await store.createProject({
            slug: `m6a-pg-b-${suffix}`,
            name: `M6A PG Project B ${suffix}`,
            repo_bare_path: `/tmp/m6a-pg-b-${suffix}.git`,
            initial_main_commit_hash: "c".repeat(40),
            initial_main_tree_hash: "d".repeat(40),
          });
          projectAId = pA.project_id;
          projectBId = pB.project_id;
          await store.addProjectMembership({
            project_id: projectAId,
            principal_id: "pg-alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: projectAId,
            principal_id: "pg-bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          await store.addProjectMembership({
            project_id: projectBId,
            principal_id: "pg-carol-dev",
            member_role: "DEVELOPER",
          });
        }
      );

      const authDevA = coreApi.issueAuthContext({
        projectId: projectAId,
        principalId: "pg-alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApproverA = coreApi.issueAuthContext({
        projectId: projectAId,
        principalId: "pg-bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      // 1. Live PG E2E: Stages 1 (Anthropic) -> Resolve -> 2 (OpenAI) -> 3 (Google) -> 4 -> Web Gate & Freeze
      const created = await coreClient.createPipelineSession(projectAId, authDevA, {
        title: `PG Live Pipeline ${suffix}`,
        raw_idea_text: "Build RLS-enforced billing & spec freeze pipeline on PostgreSQL.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 2_000_000,
          session_token_budget: 60_000,
          session_cost_budget_micro_usd: 15_000_000,
        },
      });
      const sessId = created.session.pipeline_session_id;

      const s1 = await coreClient.runPipelineStage1Extract(projectAId, authDevA, sessId);
      const assumpItem = s1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const recItem = s1.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;

      // Direct PG SQL trigger tests BEFORE freeze:
      // (a) Direct SQL ASSUMPTION AUTO_VERIFIED blocked with 23514
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO stage1_discovery_items (
                  item_id, project_id, pipeline_session_id, kind, title, statement, rationale, confirmation_status
                ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ASSUMPTION', 'BadSQL', 'S', 'R', 'AUTO_VERIFIED');`,
                [randomUUID(), projectAId, sessId]
              )
          ),
        (err: unknown) =>
          (err instanceof PostgresRlsError ||
            typeof (err as { sqlState?: string }).sqlState === "string") &&
          (err as { sqlState: string }).sqlState === "23514"
      );

      // (b) Direct SQL Stage 2 INSERT referencing UNCONFIRMED assumption blocked by trg_stage_artifact_invariants (23514 AC-10)
      const directBadS2Content = {
        prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
        srs: {
          functional_requirements: [
            {
              req_id: "REQ-PG-TRIGGER",
              title: "Trigger Probe",
              description: "d",
              priority: "MUST",
              source_discovery_item_ids: [assumpItem.item_id],
              acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
            },
          ],
          non_functional_requirements: [],
        },
      };
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            () =>
              pool.queryInActiveTx(
                `INSERT INTO stage_artifacts (
                  artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version,
                  provider, model, prompt_id, prompt_version, prompt_sha256,
                  content_json, artifact_sha256, created_by_principal_id
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid, 'STAGE_2_REQUIREMENTS', 'STAGE_2_PRD_SRS', 99,
                  'anthropic', 'claude-sonnet-4-20250514', 'p', '1.0.0', $4::char(64),
                  $5::jsonb, $6::char(64), 'pg-alice-dev'
                );`,
                [
                  randomUUID(),
                  projectAId,
                  sessId,
                  "a".repeat(64),
                  directBadS2Content,
                  computeCanonicalPayloadSha256(directBadS2Content),
                ]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // (b2) M6A-FIX-01: Missing source_discovery_item_ids key on requirement rejected at DB trigger (23514)
      const directMissingKeyS2Content = {
        prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
        srs: {
          functional_requirements: [
            {
              req_id: "REQ-PG-MISSING-KEY",
              title: "Missing Key Probe",
              description: "d",
              priority: "MUST",
            },
          ],
          non_functional_requirements: [],
        },
      };
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            () =>
              pool.queryInActiveTx(
                `INSERT INTO stage_artifacts (
                  artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version,
                  provider, model, prompt_id, prompt_version, prompt_sha256,
                  content_json, artifact_sha256, created_by_principal_id
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid, 'STAGE_2_REQUIREMENTS', 'STAGE_2_PRD_SRS', 99,
                  'anthropic', 'claude-sonnet-4-20250514', 'p', '1.0.0', $4::char(64),
                  $5::jsonb, $6::char(64), 'pg-alice-dev'
                );`,
                [
                  randomUUID(),
                  projectAId,
                  sessId,
                  "a".repeat(64),
                  directMissingKeyS2Content,
                  computeCanonicalPayloadSha256(directMissingKeyS2Content),
                ]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // (b3) Minor Note 7: Non-array functional_requirements raises 23514 (not 22023)
      const directNonArrayS2Content = {
        prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
        srs: {
          functional_requirements: "not-an-array",
          non_functional_requirements: [],
        },
      };
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            () =>
              pool.queryInActiveTx(
                `INSERT INTO stage_artifacts (
                  artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version,
                  provider, model, prompt_id, prompt_version, prompt_sha256,
                  content_json, artifact_sha256, created_by_principal_id
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid, 'STAGE_2_REQUIREMENTS', 'STAGE_2_PRD_SRS', 99,
                  'anthropic', 'claude-sonnet-4-20250514', 'p', '1.0.0', $4::char(64),
                  $5::jsonb, $6::char(64), 'pg-alice-dev'
                );`,
                [
                  randomUUID(),
                  projectAId,
                  sessId,
                  "a".repeat(64),
                  directNonArrayS2Content,
                  computeCanonicalPayloadSha256(directNonArrayS2Content),
                ]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // (b4) Minor Note 1: ASSUMPTION with blank clarification_question blocked by CHECK (23514)
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO stage1_discovery_items (
                  item_id, project_id, pipeline_session_id, kind, title, statement, rationale,
                  clarification_question, confirmation_status
                ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ASSUMPTION', 'NoQ', 'S', 'R', '   ', 'UNCONFIRMED');`,
                [randomUUID(), projectAId, sessId]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // Confirm assumption, reject recommendation, verify M6A-FIX-02 one-way transition guard in PG, finish Stages 2..4
      await coreClient.resolvePipelineStage1Item(projectAId, authDevA, sessId, assumpItem.item_id, {
        decision: "CONFIRM",
      });
      await coreClient.resolvePipelineStage1Item(projectAId, authDevA, sessId, recItem.item_id, {
        decision: "REJECT",
      });

      // M6A-FIX-02: Cannot flip CONFIRMED -> REJECTED or REJECTED -> CONFIRMED or FACT -> REJECTED
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE stage1_discovery_items
                 SET confirmation_status = 'REJECTED'
                 WHERE item_id = $1::uuid;`,
                [assumpItem.item_id]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );
      await assert.rejects(
        () =>
          coreClient.resolvePipelineStage1Item(projectAId, authDevA, sessId, assumpItem.item_id, {
            decision: "REJECT",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const s2 = await coreClient.runPipelineStage2Requirements(projectAId, authDevA, sessId, {
        model_config: {
          provider: "openai",
          model: "gpt-4.1",
          apiKey: "test-openai-key-local",
          baseUrl: mock.openaiBaseUrl,
        },
      });
      const s3 = await coreClient.runPipelineStage3Architecture(projectAId, authDevA, sessId, {
        model_config: {
          provider: "google",
          model: "gemini-2.5-pro",
          apiKey: "test-google-key-local",
          baseUrl: mock.googleBaseUrl,
        },
      });
      const s4 = await coreClient.runPipelineStage4ConsistencyCheck(projectAId, authDevA, sessId);
      assert.equal(s4.report.passed, true);

      // Verify JSONB round-trip canonical SHA-256 directly from PG
      const bundleFromPg = await coreClient.getPipelineBundle(projectAId, authDevA, sessId);
      assert.equal(bundleFromPg.artifacts.length, 4);
      for (const art of bundleFromPg.artifacts) {
        assert.equal(
          computeCanonicalPayloadSha256(art.content_json),
          art.artifact_sha256,
          `PG JSONB round-trip SHA-256 mismatch on ${art.stage}`
        );
      }

      // M6A-FIX-03 in PostgreSQL: generate newer Stage 4 v2 and verify older v1 report cannot be frozen via HTTP or direct SQL
      const staleGateV1 = await coreClient.submitPipelineApprovalGate(projectAId, authApproverA, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4.artifact.artifact_id,
        target_artifact_sha256: s4.artifact.artifact_sha256,
        decision: "APPROVED",
        rationale: "Gate bound to older Stage 4 v1",
      });
      const s4Latest = await coreClient.runPipelineStage4ConsistencyCheck(projectAId, authDevA, sessId);
      assert.equal(s4Latest.artifact.version, s4.artifact.version + 1);

      const staleFreezeRes = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(projectAId)}/pipeline-sessions/${encodeURIComponent(sessId)}/freeze`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: JSON.stringify({
            validation_report_artifact_id: s4.artifact.artifact_id,
            validation_report_sha256: s4.artifact.artifact_sha256,
            approval_gate_id: staleGateV1.gate_id,
          }),
        }
      );
      assert.equal(staleFreezeRes.status, 422);

      const s1ArtFromPg = bundleFromPg.artifacts.find((a) => a.stage === "STAGE_1_IDEA_DISCOVERY")!;
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-bob-approver",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO baseline_spec_freezes (
                  baseline_id, project_id, pipeline_session_id,
                  stage1_artifact_id, stage1_artifact_sha256,
                  stage2_artifact_id, stage2_artifact_sha256,
                  stage3_artifact_id, stage3_artifact_sha256,
                  validation_report_artifact_id, validation_report_sha256,
                  approval_gate_id, frozen_by_principal_id, freeze_bundle_sha256
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid,
                  $4::uuid, $5::char(64),
                  $6::uuid, $7::char(64),
                  $8::uuid, $9::char(64),
                  $10::uuid, $11::char(64),
                  $12::uuid, 'pg-bob-approver', $13::char(64)
                );`,
                [
                  randomUUID(),
                  projectAId,
                  sessId,
                  s1ArtFromPg.artifact_id,
                  s1ArtFromPg.artifact_sha256,
                  s2.artifact.artifact_id,
                  s2.artifact.artifact_sha256,
                  s3.artifact.artifact_id,
                  s3.artifact.artifact_sha256,
                  s4.artifact.artifact_id,
                  s4.artifact.artifact_sha256,
                  staleGateV1.gate_id,
                  "f".repeat(64),
                ]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // Direct PG SQL trigger: marking session FROZEN without committed baseline_spec_freezes row fails (23514)
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-bob-approver",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE product_pipeline_sessions
                 SET status = 'FROZEN', frozen_baseline_id = $1::uuid
                 WHERE pipeline_session_id = $2::uuid;`,
                [randomUUID(), sessId]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // Web Console Approve (latest Stage 4) & Freeze against live PostgreSQL
      const webGateRes = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(projectAId)}/pipeline-sessions/${encodeURIComponent(sessId)}/approval-gates`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: JSON.stringify({ gate_stage: "STAGE_4_SPEC_FREEZE", decision: "APPROVED" }),
        }
      );
      assert.equal(webGateRes.status, 201);

      const webFreezeRes = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(projectAId)}/pipeline-sessions/${encodeURIComponent(sessId)}/freeze`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: JSON.stringify({}),
        }
      );
      assert.equal(webFreezeRes.status, 201);

      // 2. Post-freeze direct SQL trigger checks under app_runtime:
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE stage1_discovery_items SET resolution_note = 'Post freeze edit' WHERE item_id = $1::uuid;`,
                [assumpItem.item_id]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE product_pipeline_sessions SET status = 'ACTIVE' WHERE pipeline_session_id = $1::uuid;`,
                [sessId]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // Minor Note 8: Title column UPDATE denied (42501) by column GRANT & granted frozen columns blocked (23514) by trigger
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE product_pipeline_sessions SET title = 'Hijacked Frozen Title' WHERE pipeline_session_id = $1::uuid;`,
                [sessId]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "42501"
      );
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `UPDATE product_pipeline_sessions SET current_stage = 'STAGE_1_IDEA_DISCOVERY' WHERE pipeline_session_id = $1::uuid;`,
                [sessId]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // Minor Note 17: Stage approval gates cannot be inserted after baseline freeze
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-bob-approver",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO stage_approval_gates (
                  gate_id, project_id, pipeline_session_id, gate_stage,
                  target_artifact_id, target_artifact_sha256, approver_principal_id, decision
                ) VALUES (
                  $1::uuid, $2::uuid, $3::uuid, 'STAGE_4_SPEC_FREEZE',
                  $4::uuid, $5::char(64), 'pg-bob-approver', 'APPROVED'
                );`,
                [
                  randomUUID(),
                  projectAId,
                  sessId,
                  s4Latest.artifact.artifact_id,
                  s4Latest.artifact.artifact_sha256,
                ]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      // 3. Append-only 42501 & Column-level UPDATE GRANT 42501 across M6A tables under app_runtime
      const assert42501 = async (fn: () => Promise<unknown>, label: string): Promise<void> => {
        await assert.rejects(
          fn,
          (err: unknown) => (err as { sqlState?: string }).sqlState === "42501",
          `Expected SQLSTATE 42501 for ${label}`
        );
      };

      const txA = {
        currentProjectId: projectAId,
        currentPrincipalId: "pg-alice-dev",
        currentRole: "core_api_service" as const,
      };
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(`UPDATE model_call_ledgers SET actual_cost_micro_usd = 0 WHERE pipeline_session_id = $1::uuid;`, [sessId])
          ),
        "UPDATE model_call_ledgers"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(`UPDATE stage_artifacts SET model = 'tampered' WHERE artifact_id = $1::uuid;`, [s2.artifact.artifact_id])
          ),
        "UPDATE stage_artifacts"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(`UPDATE stage_approval_gates SET decision = 'REJECTED' WHERE pipeline_session_id = $1::uuid;`, [sessId])
          ),
        "UPDATE stage_approval_gates"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(`UPDATE baseline_spec_freezes SET freeze_bundle_sha256 = repeat('0', 64) WHERE pipeline_session_id = $1::uuid;`, [sessId])
          ),
        "UPDATE baseline_spec_freezes"
      );

      for (const tbl of [
        "model_cost_sessions",
        "model_call_ledgers",
        "product_pipeline_sessions",
        "stage1_discovery_items",
        "stage_artifacts",
        "stage_approval_gates",
        "baseline_spec_freezes",
      ]) {
        await assert42501(
          () =>
            pool.withRlsTransaction(txA, (conn) =>
              conn.query(`DELETE FROM ${tbl} WHERE project_id = $1::uuid;`, [projectAId])
            ),
          `DELETE FROM ${tbl}`
        );
      }

      // Column-level GRANT blocks on protected columns
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(
              `UPDATE model_cost_sessions SET session_cost_budget_micro_usd = 999999999 WHERE cost_session_id = $1::uuid;`,
              [created.costSession!.cost_session_id]
            )
          ),
        "UPDATE non-whitelisted model_cost_sessions.session_cost_budget_micro_usd"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(
              `UPDATE product_pipeline_sessions SET raw_idea_text = 'tampered' WHERE pipeline_session_id = $1::uuid;`,
              [sessId]
            )
          ),
        "UPDATE non-whitelisted product_pipeline_sessions.raw_idea_text"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txA, (conn) =>
            conn.query(
              `UPDATE stage1_discovery_items SET statement = 'tampered' WHERE item_id = $1::uuid;`,
              [assumpItem.item_id]
            )
          ),
        "UPDATE non-whitelisted stage1_discovery_items.statement"
      );

      // 4. Cross-Tenant RLS Invisibility & INSERT 42501 across DISCARD ALL
      const m6aTables = [
        "model_cost_sessions",
        "model_call_ledgers",
        "product_pipeline_sessions",
        "stage1_discovery_items",
        "stage_artifacts",
        "stage_approval_gates",
        "baseline_spec_freezes",
      ];
      const txB = {
        currentProjectId: projectBId,
        currentPrincipalId: "pg-carol-dev",
        currentRole: "core_api_service" as const,
      };
      await pool.withRlsTransaction(txB, async (conn) => {
        for (const tbl of m6aTables) {
          const cntRes = await conn.query<{ cnt: string }>(
            `SELECT count(*)::text AS cnt FROM ${tbl} WHERE project_id = $1::uuid;`,
            [projectAId]
          );
          assert.equal(cntRes.rows[0]?.cnt, "0", `Project B must see 0 Project A rows in ${tbl}`);
        }
      });
      await assert42501(
        () =>
          pool.withRlsTransaction(txB, (conn) =>
            conn.query(
              `INSERT INTO model_cost_sessions (
                 cost_session_id, project_id, max_tokens_per_request,
                 max_cost_micro_usd_per_request, session_token_budget,
                 session_cost_budget_micro_usd
               ) VALUES (gen_random_uuid(), $1::uuid, 1000, 100000, 5000, 500000);`,
              [projectAId]
            )
          ),
        "Cross-tenant INSERT INTO model_cost_sessions"
      );
      await assert42501(
        () =>
          pool.withRlsTransaction(txB, (conn) =>
            conn.query(
              `INSERT INTO product_pipeline_sessions (
                 pipeline_session_id, project_id, title, raw_idea_text, created_by_principal_id
               ) VALUES (gen_random_uuid(), $1::uuid, 'Intrusion', 'Cross-tenant', 'pg-carol-dev');`,
              [projectAId]
            )
          ),
        "Cross-tenant INSERT INTO product_pipeline_sessions"
      );

      // Unscoped role sees 0 rows across all 7 M6A tables
      await pool.withRlsTransaction(
        {
          currentProjectId: null,
          currentPrincipalId: null,
          currentRole: "anonymous",
        },
        async (conn) => {
          for (const tbl of m6aTables) {
            const cntRes = await conn.query<{ cnt: string }>(`SELECT count(*)::text AS cnt FROM ${tbl};`);
            assert.equal(cntRes.rows[0]?.cnt, "0", `Unscoped anonymous must see 0 rows in ${tbl}`);
          }
        }
      );

      // 5. Durable AC-12b BLOCKED_POSTCALL + EXHAUSTED + SESSION_EXHAUSTED in PostgreSQL
      const tightPipe = await coreClient.createPipelineSession(projectAId, authDevA, {
        title: `PG Durable Budget ${suffix}`,
        raw_idea_text: "Validate durable EXHAUSTED status in PostgreSQL.",
        cost_budget: {
          max_tokens_per_request: 3000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 250,
          session_cost_budget_micro_usd: 1_000_000,
        },
      });
      mock.setResponseOverride("anthropic", { inputTokens: 200, outputTokens: 150 }); // 350 > 250
      await assert.rejects(
        () => coreClient.runPipelineStage1Extract(projectAId, authDevA, tightPipe.session.pipeline_session_id, { max_tokens: 16 }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_SESSION_BUDGET_EXCEEDED"
      );
      mock.setResponseOverride("anthropic", null);

      const pgTightCost = await coreClient.getCostSession(
        projectAId,
        authDevA,
        tightPipe.costSession!.cost_session_id
      );
      assert.equal(pgTightCost.session.status, "EXHAUSTED");
      assert.equal(pgTightCost.ledgers[0]?.status, "BLOCKED_POSTCALL");

      const hitsBeforePgExhausted = mock.hits.anthropic;
      await assert.rejects(
        () => coreClient.runPipelineStage1Extract(projectAId, authDevA, tightPipe.session.pipeline_session_id, { max_tokens: 16 }),
        (err: unknown) =>
          err instanceof HttpCoreApiError &&
          err.statusCode === 402 &&
          err.body.error_code === "ERR_SESSION_BUDGET_EXCEEDED" &&
          err.body.limit_scope === "SESSION_EXHAUSTED"
      );
      assert.equal(mock.hits.anthropic, hitsBeforePgExhausted);

      // 6. M6A-FIX-04 in PG: direct finalizeModelCallLedger on EXHAUSTED session blocks & preserves EXHAUSTED
      const directExhFin = await store.finalizeModelCallLedger({
        project_id: projectAId,
        cost_session_id: tightPipe.costSession!.cost_session_id,
        pipeline_session_id: tightPipe.session.pipeline_session_id,
        stage: "STAGE_1_IDEA_DISCOVERY",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
        prompt_version: "1.0.0",
        prompt_sha256: "a".repeat(64),
        request_sha256: "b".repeat(64),
        estimated_input_tokens: 10,
        reserved_output_tokens: 10,
        actual_input_tokens: 5,
        actual_output_tokens: 5,
        estimated_cost_micro_usd: 100,
        actual_cost_micro_usd: 50,
        outcome: "ALLOWED",
        latency_ms: 10,
      });
      assert.equal(directExhFin.allowed, false);
      assert.equal(directExhFin.limitScope, "SESSION_EXHAUSTED");
      assert.equal(directExhFin.session.status, "EXHAUSTED");
      assert.equal(directExhFin.ledger.status, "BLOCKED_POSTCALL");

      // 7. M6A-FIX-07 in PG: omitted provider usage persists usage_estimated=true in model_call_ledgers
      const estPipe = await coreClient.createPipelineSession(projectAId, authDevA, {
        title: `PG Estimated Usage ${suffix}`,
        raw_idea_text: "Verify usage_estimated=true round-trips through PostgreSQL.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 2_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 10_000_000,
        },
      });
      mock.setResponseOverride("anthropic", { omitUsage: true });
      const estOutcome = await coreClient.runPipelineStage1Extract(
        projectAId,
        authDevA,
        estPipe.session.pipeline_session_id
      );
      mock.setResponseOverride("anthropic", null);
      assert.equal(estOutcome.ledger.usage_estimated, true);

      // 8. Minor Note 6 in PG: model_cost_sessions.pipeline_session_id composite FK rejects dangling reference on COMMIT (23503)
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projectAId,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO model_cost_sessions (
                   cost_session_id, project_id, pipeline_session_id,
                   max_tokens_per_request, max_cost_micro_usd_per_request,
                   session_token_budget, session_cost_budget_micro_usd
                 ) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1000, 100000, 5000, 500000);`,
                [projectAId, randomUUID()]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23503"
      );

      assert.ok(pool.getStats().discardAllExecuted > 0);
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
      if (stack.pool) {
        assert.equal(stack.pool.getStats().totalConnections, 0);
      }
    }
  });
});

describe("M6A Review Hardening & Regression Suite (M6A-FIX-01..10 + Minor Notes)", () => {
  it("M6A-FIX-05/06 & Minor Notes 9, 17: PromptRegistry deep-freeze/semver, Stage 4 SHA-256 & strict StructuredJsonSchema validation", () => {
    const registry = createDefaultPipelinePromptRegistry();

    // Minor Note 9: Stage 4 Consistency Check template registered with deterministic promptSha256
    const regStage4 = registry.get(STAGE4_CONSISTENCY_CHECK_PROMPT_ID, "1.0.0");
    assert.equal(regStage4.promptSha256, STAGE4_CONSISTENCY_CHECK_PROMPT_SHA256);

    // M6A-FIX-05: Deep clone & deep freeze prevents caller post-register mutation
    const schemaRef: StructuredJsonSchema = {
      type: "object",
      additionalProperties: false,
      required: ["nested"],
      properties: {
        nested: {
          type: "object",
          required: ["flag"],
          properties: {
            flag: { type: "string", enum: ["ON", "OFF"] },
          },
        },
      },
    };
    const regMutable = registry.register({
      promptId: "m6a.fix05.freeze",
      version: "1.0.0",
      description: "Deep freeze test",
      requiredVariables: ["topic"],
      systemTemplate: "Topic {{topic}}",
      userTemplate: "Run {{topic}}",
      outputSchema: schemaRef,
    });
    assert.ok(Object.isFrozen(regMutable.spec.outputSchema));
    assert.ok(Object.isFrozen(regMutable.spec.outputSchema!.properties!.nested));
    (schemaRef.properties!.nested!.required as string[]).push("tampered");
    assert.deepEqual(regMutable.spec.outputSchema!.properties!.nested!.required, ["flag"]);
    assert.throws(() => {
      (regMutable.spec.outputSchema!.properties!.nested!.required as string[]).push("tampered");
    }, TypeError);
    assert.throws(() => {
      const rendered = registry.render("m6a.fix05.freeze", "1.0.0", { topic: "x" });
      (rendered.outputSchema!.properties as Record<string, unknown>).tamper = { type: "string" };
    }, TypeError);

    // Minor Note 17: Unversioned get(promptId) selects highest semver regardless of insertion order
    registry.register({
      promptId: "m6a.semver.test",
      version: "1.10.0",
      description: "Higher minor semver",
      requiredVariables: [],
      systemTemplate: "v1.10.0",
      userTemplate: "go",
    });
    registry.register({
      promptId: "m6a.semver.test",
      version: "1.2.0",
      description: "Lower minor semver inserted second",
      requiredVariables: [],
      systemTemplate: "v1.2.0",
      userTemplate: "go",
    });
    assert.equal(registry.get("m6a.semver.test").spec.version, "1.10.0");

    // M6A-FIX-06: Missing or unknown schema.type must fail closed (never silently pass)
    assert.throws(
      () =>
        parseAndValidateStructuredOutput(
          '{"a":123}',
          { required: ["missing"], properties: { missing: { type: "string" } } } as unknown as StructuredJsonSchema
        ),
      (err: unknown) =>
        err instanceof StructuredOutputValidationError && err.code === "ERR_STRUCTURED_OUTPUT_INVALID"
    );
    assert.throws(
      () =>
        parseAndValidateStructuredOutput(
          '"hello"',
          { type: "bogus_type" } as unknown as StructuredJsonSchema
        ),
      (err: unknown) =>
        err instanceof StructuredOutputValidationError && err.code === "ERR_STRUCTURED_OUTPUT_INVALID"
    );

    // Minor Note 17: Bare fence rejected, malformed regex caught cleanly, null required property rejected, object/array enum supported
    assert.throws(
      () =>
        parseAndValidateStructuredOutput('```\n{"ok":"yes"}\n```', {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "string" } },
        }),
      (err: unknown) => err instanceof StructuredOutputValidationError
    );
    assert.throws(
      () =>
        parseAndValidateStructuredOutput('{"code":"abc"}', {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", pattern: "[unclosed" } },
        }),
      (err: unknown) => err instanceof StructuredOutputValidationError
    );
    assert.throws(
      () =>
        parseAndValidateStructuredOutput('{"name":null}', {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        }),
      (err: unknown) => err instanceof StructuredOutputValidationError
    );
    const enumObj = parseAndValidateStructuredOutput<{ mode: string; tags: string[] }>(
      '{"tags":["a","b"],"mode":"strict"}',
      {
        type: "object",
        enum: [{ mode: "strict", tags: ["a", "b"] }],
        properties: {
          mode: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      }
    );
    assert.equal(enumObj.mode, "strict");
  });

  it("M6A-FIX-07 & Minor Notes 3, 4, 13, 14, 15, 16: Cache billing, estimated usage, SSRF, OpenAI reasoning & review JSON", async () => {
    const mock = await startMockModelProviderServers();
    const ledgerStore = new InMemoryCostGuardLedger();
    try {
      const projId = randomUUID();
      const costSess = ledgerStore.createSession({
        project_id: projId,
        max_tokens_per_request: 100_000,
        max_cost_micro_usd_per_request: 10_000_000,
        session_token_budget: 200_000,
        session_cost_budget_micro_usd: 20_000_000,
      });

      // Minor Notes 3 & 4: SSRF blocks metadata, 127.0.0.2, RFC1918 private IPs, and checks allowedHosts when baseUrl omitted
      for (const badUrl of [
        "https://169.254.169.254/latest/meta-data",
        "http://127.0.0.2:8080/v1",
        "https://10.0.0.1/v1",
        "https://[::ffff:169.254.169.254]/v1",
      ]) {
        assert.throws(
          () =>
            new LiveModelProviderClient({
              provider: "openai",
              model: "gpt-4.1",
              apiKey: "test-key",
              baseUrl: badUrl,
              allowInsecureHttpBaseUrl: false,
            }),
          ModelProviderConfigurationError
        );
      }
      assert.throws(
        () =>
          new LiveModelProviderClient({
            provider: "openai",
            model: "gpt-4.1",
            apiKey: "test-key",
            allowedHosts: ["internal-proxy.example.com"],
          }),
        ModelProviderConfigurationError
      );

      // Minor Note 16: Unsafe integer overflow in computeCostMicroUsd fails closed
      assert.throws(
        () =>
          computeCostMicroUsd(10_000_000_000, 0, {
            inputMicroUsdPerMillionTokens: 2_000_000_000_000,
            outputMicroUsdPerMillionTokens: 1,
          }),
        /MAX_SAFE_INTEGER|exceeds/i
      );

      // Minor Note 17: Invalid generation params (maxTokens <= 0 / negative temperature) fail closed
      const client = new LiveModelProviderClient({
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "test-openai-key",
        baseUrl: mock.openaiBaseUrl,
      });
      await assert.rejects(
        () =>
          client.complete({
            systemPrompt: "sys",
            userPrompt: "usr",
            maxTokens: 0,
            temperature: 0,
          }),
        ModelProviderConfigurationError
      );

      // Minor Note 15: OpenAI reasoning model (o3-mini) uses max_completion_tokens and omits temperature
      const o3Client = new LiveModelProviderClient({
        provider: "openai",
        model: "o3-mini",
        apiKey: "test-openai-key",
        baseUrl: mock.openaiBaseUrl,
      });
      mock.resetCounts();
      await o3Client.complete({
        systemPrompt: "sys",
        userPrompt: "usr",
        maxTokens: 256,
        temperature: 0,
      });
      const o3Body = mock.requests[0]!.rawBody;
      assert.equal(o3Body.max_completion_tokens, 256);
      assert.equal(o3Body.max_tokens, undefined);
      assert.equal(o3Body.temperature, undefined);

      // M6A-FIX-07 (part 1): Anthropic cache_creation_input_tokens + cache_read_input_tokens included in billing
      const anthExec = new ManagedModelProviderExecutor({
        client: new LiveModelProviderClient({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anth-key",
          baseUrl: mock.anthropicBaseUrl,
        }),
        promptRegistry: createDefaultPipelinePromptRegistry(),
        costGuard: ledgerStore,
      });
      mock.setResponseOverride("anthropic", {
        text: JSON.stringify(buildDefaultStage1Bundle()),
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 60,
      });
      const cacheRes = await anthExec.executeStructuredPrompt({
        projectId: projId,
        costSessionId: costSess.cost_session_id,
        stage: "STAGE_1_IDEA_DISCOVERY",
        promptId: STAGE1_DISCOVERY_PROMPT_ID,
        variables: {
          project_id: projId,
          pipeline_session_id: randomUUID(),
          title: "Cache billing",
          raw_idea_text: "Idea",
        },
      });
      assert.equal(cacheRes.usage.inputTokens, 200);
      assert.equal(cacheRes.usage.usageEstimated, false);
      assert.equal(cacheRes.ledger.actual_input_tokens, 200);
      assert.equal(cacheRes.ledger.usage_estimated, false);

      // M6A-FIX-07 (part 2): Omitted usage triggers fallback byte estimation and marks ledger.usage_estimated = true
      mock.setResponseOverride("anthropic", {
        text: JSON.stringify(buildDefaultStage1Bundle()),
        omitUsage: true,
      });
      const estRes = await anthExec.executeStructuredPrompt({
        projectId: projId,
        costSessionId: costSess.cost_session_id,
        stage: "STAGE_1_IDEA_DISCOVERY",
        promptId: STAGE1_DISCOVERY_PROMPT_ID,
        variables: {
          project_id: projId,
          pipeline_session_id: randomUUID(),
          title: "Estimated telemetry",
          raw_idea_text: "Idea",
        },
      });
      mock.setResponseOverride("anthropic", null);
      assert.equal(estRes.usage.usageEstimated, true);
      assert.equal(estRes.ledger.usage_estimated, true);

      // Minor Note 13: Invalid structured output + post-call budget overrun preserves cause & validation metadata
      const tinySess = ledgerStore.createSession({
        project_id: projId,
        max_tokens_per_request: 50_000,
        max_cost_micro_usd_per_request: 10_000_000,
        session_token_budget: 500,
        session_cost_budget_micro_usd: 10_000_000,
      });
      mock.setResponseOverride("anthropic", {
        text: '{"unexpected":"invalid-schema"}',
        inputTokens: 400,
        outputTokens: 200, // 600 > 500 session_token_budget
      });
      await assert.rejects(
        () =>
          anthExec.executeStructuredPrompt({
            projectId: projId,
            costSessionId: tinySess.cost_session_id,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            maxTokens: 16,
            variables: {
              project_id: projId,
              pipeline_session_id: randomUUID(),
              title: "Both invalid & over budget",
              raw_idea_text: "Idea",
            },
          }),
        (err: unknown) =>
          err instanceof CostBudgetExceededError &&
          err.details.validationFailed === true &&
          Array.isArray(err.details.validationErrors) &&
          err.details.validationErrors.length > 0 &&
          err.cause instanceof StructuredOutputValidationError
      );
      mock.setResponseOverride("anthropic", null);

      // Minor Note 14: Review client uses strict extractJsonFromModelText (rejects prose wrapping JSON)
      mock.setResponseOverride("google", {
        text: 'Prose before JSON: {"verdict":"PASS","findings":[]}',
      });
      const revClient = new LiveModelProviderClient({
        provider: "google",
        model: "gemini-2.5-pro",
        apiKey: "test-google-key",
        baseUrl: mock.googleBaseUrl,
      });
      const revResult = await evaluateIndependentReviewWithLiveModel(revClient, {
        taskContract: {
          allowed_files: ["src/a.ts"],
          protected_paths: [],
        },
        diffText: "+const x = 1;",
        changedFiles: ["src/a.ts"],
        verificationRunSummary: {
          verification_run_id: randomUUID(),
          verdict: "PASS",
          overall_status: "PASSED",
          tier1_trusted_acceptance_passed: true,
          tier2_protected_baseline_passed: true,
          tier3_agent_tests_passed: true,
        },
      });
      mock.setResponseOverride("google", null);
      assert.equal(revResult.verdict, "FAIL");
      assert.ok(revResult.findings.some((f) => /non-JSON/i.test(f.detail)));
    } finally {
      await mock.close();
    }
  });

  it("M6A-FIX-02/03/04 & Minor Notes 1, 17: Store/Domain one-way Stage 1 resolve, latest Stage 4 freeze, CLOSED/EXHAUSTED finalize & post-freeze gate lock", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    let httpServer: CoreApiHttpServer | null = null;
    try {
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-domain-fixes-${randomUUID().slice(0, 8)}`,
            name: "Domain Fixes",
            repo_bare_path: "/tmp/m6a-domain-fixes.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      // M6A-FIX-04: Direct finalize on CLOSED or EXHAUSTED cost sessions rejects in both Store and InMemoryCostGuardLedger
      const memGuard = new InMemoryCostGuardLedger();
      const csClosedMem = memGuard.createSession({
        project_id: proj.project_id,
        max_tokens_per_request: 1000,
        max_cost_micro_usd_per_request: 100000,
        session_token_budget: 5000,
        session_cost_budget_micro_usd: 500000,
      });
      memGuard.closeSession(proj.project_id, csClosedMem.cost_session_id);
      const closedMemFin = memGuard.finalizeModelCallLedger({
        project_id: proj.project_id,
        cost_session_id: csClosedMem.cost_session_id,
        stage: "STAGE_1_IDEA_DISCOVERY",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        prompt_id: "p",
        prompt_version: "1.0.0",
        prompt_sha256: "a".repeat(64),
        request_sha256: "b".repeat(64),
        estimated_input_tokens: 10,
        reserved_output_tokens: 10,
        actual_input_tokens: 5,
        actual_output_tokens: 5,
        estimated_cost_micro_usd: 100,
        actual_cost_micro_usd: 50,
        outcome: "ALLOWED",
        latency_ms: 5,
      });
      assert.equal(closedMemFin.allowed, false);
      assert.equal(closedMemFin.limitScope, "SESSION_EXHAUSTED");
      assert.equal(closedMemFin.session.status, "CLOSED");
      assert.equal(closedMemFin.ledger.status, "BLOCKED_POSTCALL");

      const coreApi = new CoreApiService(store, {
        defaultModelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        },
      });
      httpServer = new CoreApiHttpServer({ coreApi });
      const { baseUrl } = await httpServer.start();
      const client = new HttpCoreApiClient(baseUrl);
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      const created = await client.createPipelineSession(proj.project_id, authDev, {
        title: "Domain Guard Matrix",
        raw_idea_text: "Test ASSUMPTION clarification, one-way resolve, and stale freeze.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 50_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });
      const sessId = created.session.pipeline_session_id;

      // Minor Note 1: ASSUMPTION lacking clarification_question rejected at domain store layer (23514)
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            { currentProjectId: proj.project_id, currentPrincipalId: "alice-dev", currentRole: "core_api_service" },
            () =>
              store.createStage1DiscoveryItems({
                project_id: proj.project_id,
                pipeline_session_id: sessId,
                items: [
                  {
                    kind: "ASSUMPTION",
                    title: "Missing Q",
                    statement: "No question provided",
                    rationale: "Test",
                    clarification_question: "   ",
                  },
                ],
              })
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
      );

      const s1 = await client.runPipelineStage1Extract(proj.project_id, authDev, sessId);
      const fact = s1.discoveryItems.find((i) => i.kind === "FACT")!;
      const assump = s1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const rec = s1.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;

      // M6A-FIX-02: Resolving FACT or flipping CONFIRMED -> REJECTED rejected with 422
      await assert.rejects(
        () => client.resolvePipelineStage1Item(proj.project_id, authDev, sessId, fact.item_id, { decision: "REJECT" }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await client.resolvePipelineStage1Item(proj.project_id, authDev, sessId, assump.item_id, { decision: "CONFIRM" });
      await client.resolvePipelineStage1Item(proj.project_id, authDev, sessId, rec.item_id, { decision: "REJECT" });
      await assert.rejects(
        () => client.resolvePipelineStage1Item(proj.project_id, authDev, sessId, assump.item_id, { decision: "REJECT" }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      await client.runPipelineStage2Requirements(proj.project_id, authDev, sessId);
      await client.runPipelineStage3Architecture(proj.project_id, authDev, sessId);

      // M6A-FIX-03: Report v1 passes, then newer Report v2 supersedes it -> freezing with v1 fails 422
      const s4V1 = await client.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId);
      const gateV1 = await client.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4V1.artifact.artifact_id,
        target_artifact_sha256: s4V1.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      const s4V2 = await client.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId);
      await assert.rejects(
        () =>
          client.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
            validation_report_artifact_id: s4V1.artifact.artifact_id,
            validation_report_sha256: s4V1.artifact.artifact_sha256,
            approval_gate_id: gateV1.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Valid freeze with latest v2 succeeds, and post-freeze approval gate insert fails (422)
      const gateV2 = await client.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4V2.artifact.artifact_id,
        target_artifact_sha256: s4V2.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      const frozen = await client.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
        approval_gate_id: gateV2.gate_id,
      });
      assert.equal(frozen.status, "FROZEN");

      await assert.rejects(
        () =>
          client.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "REJECTED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
    } finally {
      await Promise.allSettled([httpServer?.stop(), mock.close()]);
    }
  });

  it("M6A-FIX-08 & Minor Note 17: Full Stages 1 -> Resolve -> 2 -> 3 -> 4 -> Gate -> Freeze driven exclusively via Web UI HTTP & HTML form routes", async () => {
    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const webBaseUrl = stack.webEndpoint!.baseUrl;

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-webui-e2e-${randomUUID().slice(0, 8)}`,
            name: "Web UI Full Flow",
            repo_bare_path: "/tmp/m6a-webui.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });
      const pEnc = encodeURIComponent(proj.project_id);

      // 1. Project Pipeline index HTML renders interactive create session form
      const listHtmlRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions?format=html`, {
        headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev) },
      });
      assert.equal(listHtmlRes.status, 200);
      const listHtml = await listHtmlRes.text();
      assert.ok(listHtml.includes('<form method="POST"'));
      assert.ok(listHtml.includes(`<form method="POST" action="/projects/${pEnc}/pipeline-sessions">`));

      // 2. Submit HTML form to create pipeline session -> 303 redirect to session page
      const createFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
        },
        body: new URLSearchParams({
          title: "Web UI End-to-End Pipeline",
          raw_idea_text: "Build customer billing console through Web UI forms only.",
          max_tokens_per_request: "8000",
          max_cost_micro_usd_per_request: "1000000",
          session_token_budget: "60000",
          session_cost_budget_micro_usd: "10000000",
        }).toString(),
      });
      assert.equal(createFormRes.status, 303);
      const location = createFormRes.headers.get("location") ?? "";
      assert.ok(location.startsWith(`/projects/${pEnc}/pipeline-sessions/`));
      const sessId = decodeURIComponent(location.split("/").pop()!);
      const sEnc = encodeURIComponent(sessId);

      // SSRF defense on Web UI model_config overrides
      const ssrfWebRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage1/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
        },
        body: JSON.stringify({
          model_config: {
            provider: "openai",
            model: "gpt-4.1",
            apiKey: "test-key",
            baseUrl: "http://127.0.0.2:9999",
            allowInsecureHttpBaseUrl: true,
          },
        }),
      });
      assert.equal(ssrfWebRes.status, 503);

      // 3. Stage 1 Extract via Web form route -> 303
      const s1FormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage1/extract`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
        },
        body: "",
      });
      assert.equal(s1FormRes.status, 303);

      // Inspect HTML page after Stage 1: verify interactive Confirm/Reject & Stage 1..4 forms rendered
      const midHtmlRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}`, {
        headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev) },
      });
      assert.equal(midHtmlRes.status, 200);
      const midHtml = await midHtmlRes.text();
      assert.ok(midHtml.includes("/stage2/requirements"));
      assert.ok(midHtml.includes("/stage3/architecture"));
      assert.ok(midHtml.includes("/stage4/consistency-check"));
      assert.ok(midHtml.includes("/approval-gates"));
      assert.ok(midHtml.includes("/freeze"));
      assert.ok(midHtml.includes('<button type="submit">Confirm</button>'));

      // 4. HTML form POST errors render HTTP 422 HTML error banner (both premature Stage 3 and hypotheses-only Stage 2 ERR_AC10_UNCONFIRMED_ASSUMPTION)
      const prematureS3HtmlRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage3/architecture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: "",
        }
      );
      assert.equal(prematureS3HtmlRes.status, 422);
      const prematureS3Html = await prematureS3HtmlRes.text();
      assert.ok(prematureS3Html.includes('data-error-banner="true"'));

      const unconfFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
        },
        body: new URLSearchParams({
          title: "Hypotheses-Only Web UI Pipeline",
          raw_idea_text: "Only unconfirmed assumptions.",
          max_tokens_per_request: "8000",
          max_cost_micro_usd_per_request: "1000000",
          session_token_budget: "20000",
          session_cost_budget_micro_usd: "5000000",
        }).toString(),
      });
      assert.equal(unconfFormRes.status, 303);
      const unconfSessEnc = encodeURIComponent(decodeURIComponent((unconfFormRes.headers.get("location") ?? "").split("/").pop()!));
      mock.setStage1Factory(() => ({
        summary: "Hypotheses only",
        facts: [],
        assumptions: [
          {
            title: "Unconfirmed Hypothesis",
            statement: "Needs human signoff",
            rationale: "No verified facts yet",
            clarification_question: "Approve hypothesis?",
          },
        ],
        recommendations: [],
      }));
      const unconfS1Res = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${unconfSessEnc}/stage1/extract`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: "",
        }
      );
      assert.equal(unconfS1Res.status, 303);
      mock.setStage1Factory(() => buildDefaultStage1Bundle());

      const prematureS2HtmlRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${unconfSessEnc}/stage2/requirements`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: "",
        }
      );
      assert.equal(prematureS2HtmlRes.status, 422);
      const prematureS2Html = await prematureS2HtmlRes.text();
      assert.ok(prematureS2Html.includes('data-error-banner="true"'));
      assert.ok(prematureS2Html.includes("ERR_AC10_UNCONFIRMED_ASSUMPTION"));

      // Fetch bundle JSON from Web Console to pick item IDs, then resolve via Web Console routes
      const midBundle = (await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}?format=json`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev) },
        })
      ).json()) as ProductPipelineBundle;
      const assump = midBundle.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const rec = midBundle.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;

      const confirmRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage1/items/${encodeURIComponent(assump.item_id)}/resolve`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: new URLSearchParams({ decision: "CONFIRM" }).toString(),
        }
      );
      assert.equal(confirmRes.status, 303);

      const rejectRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage1/items/${encodeURIComponent(rec.item_id)}/resolve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: JSON.stringify({ decision: "REJECT", resolution_note: "Excluded from v1" }),
        }
      );
      assert.equal(rejectRes.status, 200);

      // 5. Stage 2, Stage 3, Stage 4 exclusively through Web Console routes (with omitted usage on Stage 2 to verify "(est)" banner!)
      mock.setResponseOverride("anthropic", { omitUsage: true });
      const s2Res = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage2/requirements`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: "{}",
        }
      );
      assert.equal(s2Res.status, 200);
      mock.setResponseOverride("anthropic", null);

      const s3Res = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage3/architecture`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: JSON.stringify({
            model_config: {
              provider: "google",
              model: "gemini-2.5-pro",
              apiKey: "test-google-key-local",
              baseUrl: mock.googleBaseUrl,
            },
          }),
        }
      );
      assert.equal(s3Res.status, 200);

      const s4FormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage4/consistency-check`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: "",
        }
      );
      assert.equal(s4FormRes.status, 303);

      // 6. Approver approves & freezes exclusively through Web Console HTML form POSTs
      const gateFormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/approval-gates`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: new URLSearchParams({
            gate_stage: "STAGE_4_SPEC_FREEZE",
            decision: "APPROVED",
            rationale: "Approved in Web UI workbench",
          }).toString(),
        }
      );
      assert.equal(gateFormRes.status, 303);

      // DEVELOPER freeze via Web UI HTML form returns 403 HTML error banner!
      const devFreezeFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/freeze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
        },
        body: "",
      });
      assert.equal(devFreezeFormRes.status, 403);
      assert.ok((await devFreezeFormRes.text()).includes('data-error-banner="true"'));

      const freezeFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/freeze`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
        },
        body: "",
      });
      assert.equal(freezeFormRes.status, 303);

      const finalHtml = await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) },
        })
      ).text();
      assert.ok(finalHtml.includes("FROZEN"));
      assert.ok(finalHtml.includes("(est)"));
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });

  it("M6A-FIX-09: Live HTTP AC-6 freeze blocks (dangling REQ-NONEXISTENT, omitted Stage 1 traceability, tampered SHA-256) & DEVELOPER Web freeze 403", async () => {
    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);
      const webBaseUrl = stack.webEndpoint!.baseUrl;

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-fix09-live-${randomUUID().slice(0, 8)}`,
            name: "Live AC6 Matrix",
            repo_bare_path: "/tmp/m6a-fix09.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      const created = await coreClient.createPipelineSession(proj.project_id, authDev, {
        title: "Live AC6 Branches",
        raw_idea_text: "Test dangling REQ ID, missing traceability, and tampered SHA-256 over HTTP.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 80_000,
          session_cost_budget_micro_usd: 10_000_000,
        },
      });
      const sessId = created.session.pipeline_session_id;
      const s1 = await coreClient.runPipelineStage1Extract(proj.project_id, authDev, sessId);
      const firstFact = s1.discoveryItems.find((i) => i.kind === "FACT")!;
      const assump = s1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;
      const rec = s1.discoveryItems.find((i) => i.kind === "RECOMMENDATION")!;
      await coreClient.resolvePipelineStage1Item(proj.project_id, authDev, sessId, assump.item_id, {
        decision: "REJECT",
      });
      await coreClient.resolvePipelineStage1Item(proj.project_id, authDev, sessId, rec.item_id, {
        decision: "REJECT",
      });

      // (a) Stage 2 omits second AUTO_VERIFIED FACT -> valid Stage 2 schema, CHK-02 coverage fails -> freeze blocked 422
      mock.setResponseOverride("anthropic", () => ({
        text: JSON.stringify({
          prd: {
            product_vision: "v",
            target_personas: ["Operator"],
            goals: ["g"],
            non_goals: [],
          },
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-FUNC-ONLY-1",
                title: "Only cites first fact",
                description: "Omits second fact",
                priority: "MUST",
                source_discovery_item_ids: [firstFact.item_id],
                acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
              },
            ],
            non_functional_requirements: [],
          },
        }),
      }));
      await coreClient.runPipelineStage2Requirements(proj.project_id, authDev, sessId);
      mock.setResponseOverride("anthropic", null);
      await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, sessId);
      const s4MissingTrace = await coreClient.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId);
      assert.equal(s4MissingTrace.report.passed, false);
      assert.equal(s4MissingTrace.report.checks.find((c) => c.check_id === "CHK-01")?.passed, true);
      assert.equal(s4MissingTrace.report.checks.find((c) => c.check_id === "CHK-02")?.passed, false);
      const gateMissingTrace = await coreClient.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4MissingTrace.artifact.artifact_id,
        target_artifact_sha256: s4MissingTrace.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
            approval_gate_id: gateMissingTrace.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // (b) Stage 2 now covers all Facts, while Stage 3 cites dangling "REQ-NONEXISTENT" -> CHK-03 fails -> freeze blocked 422
      await coreClient.runPipelineStage2Requirements(proj.project_id, authDev, sessId);
      mock.setResponseOverride("anthropic", (req) => {
        const s3 = buildDynamicStage3Payload(req.userPrompt);
        return {
          text: JSON.stringify({
            ...s3,
            adrs: s3.adrs.map((adr) => ({
              ...adr,
              requirement_ids: [...adr.requirement_ids, "REQ-NONEXISTENT"],
            })),
          }),
        };
      });
      await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, sessId);
      mock.setResponseOverride("anthropic", null);
      const s4Dangling = await coreClient.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId);
      assert.equal(s4Dangling.report.passed, false);
      assert.equal(s4Dangling.report.checks.find((c) => c.check_id === "CHK-03")?.passed, false);
      const gateDangling = await coreClient.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4Dangling.artifact.artifact_id,
        target_artifact_sha256: s4Dangling.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
            approval_gate_id: gateDangling.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // (c) Valid Stage 3 & Stage 4 PASS, but DEVELOPER Web Console freeze -> 403 and tampered stage3_artifact_sha256 -> 404/422
      const goodS3 = await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, sessId);
      const goodS4 = await coreClient.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId, {
        stage3_artifact_id: goodS3.artifact.artifact_id,
      });
      assert.equal(goodS4.report.passed, true);
      const goodGate = await coreClient.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: goodS4.artifact.artifact_id,
        target_artifact_sha256: goodS4.artifact.artifact_sha256,
        decision: "APPROVED",
      });

      const devWebFreeze = await fetch(
        `${webBaseUrl}/projects/${encodeURIComponent(proj.project_id)}/pipeline-sessions/${encodeURIComponent(sessId)}/freeze`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDev),
          },
          body: JSON.stringify({ approval_gate_id: goodGate.gate_id }),
        }
      );
      assert.equal(devWebFreeze.status, 403);

      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
            stage3_artifact_id: goodS3.artifact.artifact_id,
            stage3_artifact_sha256: "0".repeat(64),
            approval_gate_id: goodGate.gate_id,
          }),
        (err: unknown) =>
          err instanceof HttpCoreApiError && (err.statusCode === 422 || err.statusCode === 404)
      );
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });

  it("M6A-AC7b / M6A-FIX-10: Live PostgreSQL Upgrade Paths (86076639 -> HEAD & 8044774 -> HEAD)", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../../..");
    const hasHistory = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", "86076639^{commit}"], { cwd: repoRoot });
        execFileSync("git", ["cat-file", "-e", "8044774^{commit}"], { cwd: repoRoot });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasHistory) {
      t.skip("Full git commit history (86076639, 8044774) not present in shallow checkout");
      return;
    }

    const psqlBin = (() => {
      for (const candidate of [
        "psql",
        "/opt/homebrew/opt/postgresql@17/bin/psql",
        "/usr/local/opt/postgresql@17/bin/psql",
        "/opt/homebrew/bin/psql",
        "/usr/local/bin/psql",
      ]) {
        try {
          execFileSync(candidate, ["--version"], { stdio: "ignore" });
          return candidate;
        } catch {
          // try next candidate
        }
      }
      return null;
    })();
    if (!psqlBin) {
      if (process.env.CI) {
        assert.fail("psql CLI binary is required in CI for M6A-AC7b migration upgrade tests");
      }
      t.skip("psql CLI binary not found on local PATH");
      return;
    }

    const gitSql = (rev: string, relPath: string): string =>
      execFileSync("git", ["show", `${rev}:${relPath}`], { cwd: repoRoot, encoding: "utf8" });
    const headSql = (relPath: string): string => readFileSync(resolve(repoRoot, relPath), "utf8");

    const runPsql = (database: string, sql: string): void => {
      execFileSync(psqlBin, ["-v", "ON_ERROR_STOP=1"], {
        cwd: repoRoot,
        input: sql,
        env: {
          ...process.env,
          PGHOST: pgConfig.host,
          PGPORT: String(pgConfig.port),
          PGUSER: pgConfig.user,
          PGDATABASE: database,
          ...(pgConfig.password !== undefined ? { PGPASSWORD: pgConfig.password } : {}),
          ...(pgConfig.sslMode ? { PGSSLMODE: pgConfig.sslMode } : {}),
          ...(pgConfig.sslRootCertPath ? { PGSSLROOTCERT: pgConfig.sslRootCertPath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    };

    const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
    const dbM4Upg = `sf_m6a_upg_m4_${suffix}`;
    const dbM6aUpg = `sf_m6a_upg_6a_${suffix}`;

    try {
      runPsql("postgres", `DROP DATABASE IF EXISTS ${dbM4Upg};`);
      runPsql("postgres", `CREATE DATABASE ${dbM4Upg};`);
      runPsql("postgres", `DROP DATABASE IF EXISTS ${dbM6aUpg};`);
      runPsql("postgres", `CREATE DATABASE ${dbM6aUpg};`);

      // Path A: 86076639 (pre-fix M4) -> HEAD (0004..0007 x2 + 0002)
      runPsql(dbM4Upg, gitSql("86076639", "packages/database/migrations/0001_mvp_core_schema_and_rls.sql"));
      runPsql(dbM4Upg, gitSql("86076639", "packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql"));
      runPsql(
        dbM4Upg,
        gitSql("86076639", "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql")
      );

      // Seed existing pre-fix M4 rows before running HEAD migrations
      runPsql(
        dbM4Upg,
        `INSERT INTO projects (project_id, slug, name, repo_bare_path, default_branch, approval_ttl_seconds)
         VALUES ('33333333-3333-3333-3333-333333333333', 'm4-upg-proj', 'M4 Upg', '/tmp/m4-upg.git', 'main', 3600);
         INSERT INTO tasks (task_id, project_id, title, task_contract_json, status, base_main_commit_hash, current_attempt_no)
         VALUES ('a3333333-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', 'Upg Task', '{}'::jsonb, 'Ready', repeat('1', 40), 1);`
      );

      for (const mig of [
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0002_rls_verification_matrix.sql",
      ]) {
        runPsql(dbM4Upg, headSql(mig));
      }

      const m4Pool = new PostgresRuntimePool({ ...pgConfig, database: dbM4Upg, maxConnections: 2 });
      try {
        await m4Pool.withRlsTransaction({ currentRole: "core_api_service" }, async (conn) => {
          const uqRes = await conn.query<{ cols: number }>(
            `SELECT array_length(conkey, 1) AS cols
             FROM pg_constraint
             WHERE conname = 'uq_ar_composite_binding' AND conrelid = 'approval_requests'::regclass;`
          );
          assert.equal(uqRes.rows[0]?.cols, 10);
          const colRes = await conn.query<{ exists_col: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_name = 'model_call_ledgers' AND column_name = 'usage_estimated'
             ) AS exists_col;`
          );
          assert.equal(colRes.rows[0]?.exists_col, true);
        });
      } finally {
        await m4Pool.close();
      }

      // Path B: 8044774 (initial M6A) -> HEAD (0007 x2 + 0002)
      for (const mig of [
        "packages/database/migrations/0001_mvp_core_schema_and_rls.sql",
        "packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
      ]) {
        runPsql(dbM6aUpg, gitSql("8044774", mig));
      }

      const pId = randomUUID();
      const csId = randomUUID();
      const ppsId = randomUUID();
      const factId = randomUUID();
      const assumpId = randomUUID();
      const sa1 = randomUUID();
      const sa2 = randomUUID();
      const sa3 = randomUUID();
      const sa4Old = randomUUID();
      const sa4New = randomUUID();
      const sagOld = randomUUID();

      runPsql(
        dbM6aUpg,
        `INSERT INTO projects (project_id, slug, name, repo_bare_path, default_branch, approval_ttl_seconds)
         VALUES ('${pId}', 'm6a-upg-proj', 'M6A Upg', '/tmp/m6a-upg.git', 'main', 3600);
         INSERT INTO model_cost_sessions (cost_session_id, project_id, pipeline_session_id, max_tokens_per_request, max_cost_micro_usd_per_request, session_token_budget, session_cost_budget_micro_usd)
         VALUES ('${csId}', '${pId}', '${ppsId}', 4000, 100000, 20000, 500000);
         INSERT INTO product_pipeline_sessions (pipeline_session_id, project_id, cost_session_id, title, raw_idea_text, current_stage, status, created_by_principal_id)
         VALUES ('${ppsId}', '${pId}', '${csId}', 'Pre-0007 Pipeline', 'Upgrade check', 'STAGE_4_SPEC_FREEZE', 'ACTIVE', 'alice-dev');
         INSERT INTO stage1_discovery_items (item_id, project_id, pipeline_session_id, kind, title, statement, rationale, clarification_question, confirmation_status, confirmed_by_principal_id, confirmed_at)
         VALUES
           ('${factId}', '${pId}', '${ppsId}', 'FACT', 'F1', 'S1', 'R1', NULL, 'AUTO_VERIFIED', NULL, NULL),
           ('${assumpId}', '${pId}', '${ppsId}', 'ASSUMPTION', 'A1', 'S2', 'R2', 'Confirm SLA?', 'CONFIRMED', 'alice-approver', clock_timestamp());
         INSERT INTO stage_artifacts (artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version, provider, model, prompt_id, prompt_version, prompt_sha256, content_json, artifact_sha256, created_by_principal_id)
         VALUES
           ('${sa1}', '${pId}', '${ppsId}', 'STAGE_1_IDEA_DISCOVERY', 'STAGE_1_DISCOVERY_BUNDLE', 1, 'anthropic', 'claude-sonnet-4', 'p1', '1.0.0', repeat('1', 64), '{}'::jsonb, repeat('a', 64), 'alice-dev'),
           ('${sa2}', '${pId}', '${ppsId}', 'STAGE_2_REQUIREMENTS', 'STAGE_2_PRD_SRS', 1, 'openai', 'gpt-4.1', 'p2', '1.0.0', repeat('2', 64), '{"srs":{"functional_requirements":[{"req_id":"R1","source_discovery_item_ids":["${factId}"]}]}}'::jsonb, repeat('b', 64), 'alice-dev'),
           ('${sa3}', '${pId}', '${ppsId}', 'STAGE_3_ARCHITECTURE', 'STAGE_3_ARCHITECTURE_DESIGN', 1, 'google', 'gemini-2.5-pro', 'p3', '1.0.0', repeat('3', 64), '{}'::jsonb, repeat('c', 64), 'alice-dev'),
           ('${sa4Old}', '${pId}', '${ppsId}', 'STAGE_4_SPEC_FREEZE', 'STAGE_4_VALIDATION_REPORT', 1, 'system', 'consistency-checker', 'p4', '1.0.0', repeat('4', 64), '{"passed":true}'::jsonb, repeat('d', 64), 'alice-dev'),
           ('${sa4New}', '${pId}', '${ppsId}', 'STAGE_4_SPEC_FREEZE', 'STAGE_4_VALIDATION_REPORT', 2, 'system', 'consistency-checker', 'p4', '1.0.0', repeat('4', 64), '{"passed":true}'::jsonb, repeat('e', 64), 'alice-dev');
         INSERT INTO stage_approval_gates (gate_id, project_id, pipeline_session_id, gate_stage, target_artifact_id, target_artifact_sha256, approver_principal_id, decision)
         VALUES ('${sagOld}', '${pId}', '${ppsId}', 'STAGE_4_SPEC_FREEZE', '${sa4Old}', repeat('d', 64), 'bob-approver', 'APPROVED');`
      );

      runPsql(dbM6aUpg, headSql("packages/database/migrations/0007_m6a_review_fixes.sql"));
      runPsql(dbM6aUpg, headSql("packages/database/migrations/0007_m6a_review_fixes.sql"));
      runPsql(dbM6aUpg, headSql("packages/database/migrations/0002_rls_verification_matrix.sql"));

      const m6aPool = new PostgresRuntimePool({ ...pgConfig, database: dbM6aUpg, maxConnections: 2 });
      try {
        // Verify post-0007 invariants on upgraded DB (M6A-FIX-01, 02, 03, Minor Note 6)
        await assert.rejects(
          () =>
            m6aPool.withRlsTransaction(
              { currentProjectId: pId, currentPrincipalId: "alice-dev", currentRole: "core_api_service" },
              (conn) =>
                conn.query(
                  `UPDATE stage1_discovery_items SET confirmation_status = 'REJECTED' WHERE item_id = $1::uuid;`,
                  [assumpId]
                )
            ),
          (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
        );
        await assert.rejects(
          () =>
            m6aPool.withRlsTransaction(
              { currentProjectId: pId, currentPrincipalId: "bob-approver", currentRole: "core_api_service" },
              (conn) =>
                conn.query(
                  `INSERT INTO baseline_spec_freezes (
                     baseline_id, project_id, pipeline_session_id,
                     stage1_artifact_id, stage1_artifact_sha256,
                     stage2_artifact_id, stage2_artifact_sha256,
                     stage3_artifact_id, stage3_artifact_sha256,
                     validation_report_artifact_id, validation_report_sha256,
                     approval_gate_id, frozen_by_principal_id, freeze_bundle_sha256
                   ) VALUES (
                     gen_random_uuid(), $1::uuid, $2::uuid,
                     $3::uuid, repeat('a', 64), $4::uuid, repeat('b', 64),
                     $5::uuid, repeat('c', 64), $6::uuid, repeat('d', 64),
                     $7::uuid, 'bob-approver', repeat('f', 64)
                   );`,
                  [pId, ppsId, sa1, sa2, sa3, sa4Old, sagOld]
                )
            ),
          (err: unknown) => (err as { sqlState?: string }).sqlState === "23514"
        );
      } finally {
        await m6aPool.close();
      }
    } finally {
      try {
        runPsql("postgres", `DROP DATABASE IF EXISTS ${dbM4Upg};`);
      } catch {
        // best-effort cleanup
      }
      try {
        runPsql("postgres", `DROP DATABASE IF EXISTS ${dbM6aUpg};`);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("M6A-FU-01..05 (In-Memory): Hash integrity verification, TX2 failure compensation, autonomous denial survival, bare TX atomicity & HTTP error partial usage", async () => {
    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      env: {},
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    try {
      const store = stack.coreApiRuntime!.store as SoftwareFactoryControlPlaneStore;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-fu-mem-${randomUUID().slice(0, 8)}`,
            name: "M6A Follow-up Memory Suite",
            repo_bare_path: "/tmp/m6a-fu-mem.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      // M6A-FU-02: Deferred ledger atomicity in TX2 (domain error AND persistence failure bill once via FAILED_VALIDATION, 0 ALLOWED, 0 orphans)
      const tx2Sess = await coreClient.createPipelineSession(proj.project_id, authDev, {
        title: "M6A-FU-02 TX2 Compensation",
        raw_idea_text: "Verify TX2 failure rolls back ALLOWED ledger & records single FAILED_VALIDATION.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 2_000_000,
          session_token_budget: 80_000,
          session_cost_budget_micro_usd: 15_000_000,
        },
      });
      const tx2SessId = tx2Sess.session.pipeline_session_id;
      const tx2CostId = tx2Sess.costSession!.cost_session_id;
      const s1Tx2 = await coreClient.runPipelineStage1Extract(proj.project_id, authDev, tx2SessId);
      const unconfirmedAssump = s1Tx2.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;

      // (a) TX2 domain AC-10 validation failure
      mock.setResponseOverride("anthropic", {
        inputTokens: 110,
        outputTokens: 70,
        text: JSON.stringify({
          prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-HALLUCINATED",
                title: "Bad AC-10 ref",
                description: "Cites unconfirmed Stage 1 assumption",
                priority: "MUST",
                source_discovery_item_ids: [unconfirmedAssump.item_id],
                acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
              },
            ],
            non_functional_requirements: [],
          },
        }),
      });
      await assert.rejects(
        () => coreClient.runPipelineStage2Requirements(proj.project_id, authDev, tx2SessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      mock.setResponseOverride("anthropic", null);

      const costAfterAc10 = await coreClient.getCostSession(proj.project_id, authDev, tx2CostId);
      const ac10S2Ledgers = costAfterAc10.ledgers.filter((l) => l.stage === "STAGE_2_REQUIREMENTS");
      assert.equal(ac10S2Ledgers.length, 1);
      assert.equal(ac10S2Ledgers[0]!.status, "FAILED_VALIDATION");
      assert.equal(ac10S2Ledgers[0]!.actual_input_tokens, 110);
      assert.equal(ac10S2Ledgers[0]!.actual_output_tokens, 70);
      assert.ok(ac10S2Ledgers[0]!.actual_cost_micro_usd > 0);
      const bundleAfterAc10 = await coreClient.getPipelineBundle(proj.project_id, authDev, tx2SessId);
      assert.equal(bundleAfterAc10.artifacts.filter((a) => a.stage === "STAGE_2_REQUIREMENTS").length, 0);
      assert.equal(bundleAfterAc10.session.current_stage, "STAGE_1_IDEA_DISCOVERY");

      // (b) TX2 persistence failure AFTER commitAllowedLedger() succeeds inside same TX2 -> ALLOWED rolled back, single FAILED_VALIDATION with [PERSISTENCE_FAILURE]
      const origRecordStageArtifact = store.recordStageArtifact.bind(store);
      let failOnce = true;
      (store as unknown as { recordStageArtifact: typeof store.recordStageArtifact }).recordStageArtifact = async (
        arg
      ) => {
        if (failOnce && arg.stage === "STAGE_2_REQUIREMENTS") {
          failOnce = false;
          throw new Error("Simulated TX2 storage error after commitAllowedLedger");
        }
        return origRecordStageArtifact(arg);
      };
      try {
        await assert.rejects(
          () => coreClient.runPipelineStage2Requirements(proj.project_id, authDev, tx2SessId),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode >= 500
        );
      } finally {
        (store as unknown as { recordStageArtifact: typeof store.recordStageArtifact }).recordStageArtifact =
          origRecordStageArtifact;
      }

      const costAfterPersistErr = await coreClient.getCostSession(proj.project_id, authDev, tx2CostId);
      const s2LedgersAfterPersistErr = costAfterPersistErr.ledgers.filter(
        (l) => l.stage === "STAGE_2_REQUIREMENTS"
      );
      assert.equal(s2LedgersAfterPersistErr.length, 2);
      assert.equal(
        s2LedgersAfterPersistErr.filter((l) => l.status === "ALLOWED").length,
        0,
        "TX2 rollback must leave 0 ALLOWED ledgers"
      );
      const persistErrLedger = s2LedgersAfterPersistErr[1]!;
      assert.equal(persistErrLedger.status, "FAILED_VALIDATION");
      assert.ok(persistErrLedger.error_message?.startsWith("[PERSISTENCE_FAILURE] "));
      assert.equal(
        costAfterPersistErr.session.cost_used_micro_usd,
        costAfterAc10.session.cost_used_micro_usd + persistErrLedger.actual_cost_micro_usd
      );
      const bundleAfterPersistErr = await coreClient.getPipelineBundle(
        proj.project_id,
        authDev,
        tx2SessId
      );
      assert.equal(
        bundleAfterPersistErr.artifacts.filter((a) => a.stage === "STAGE_2_REQUIREMENTS").length,
        0
      );

      // M6A-FU-01: Tamper stored artifact_sha256 in memory -> getStageArtifactById, listStageArtifacts & freezeBaselineSpec reject 23514
      const s2Good = await coreClient.runPipelineStage2Requirements(proj.project_id, authDev, tx2SessId);
      const s3Good = await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, tx2SessId);
      const s4Good = await coreClient.runPipelineStage4ConsistencyCheck(
        proj.project_id,
        authDev,
        tx2SessId
      );
      assert.equal(s4Good.report.passed, true);
      const gateGood = await coreClient.submitPipelineApprovalGate(
        proj.project_id,
        authApprover,
        tx2SessId,
        {
          gate_stage: "STAGE_4_SPEC_FREEZE",
          target_artifact_id: s4Good.artifact.artifact_id,
          target_artifact_sha256: s4Good.artifact.artifact_sha256,
          decision: "APPROVED",
        }
      );

      const artifactMap = (
        store as unknown as { stageArtifacts: Map<string, { artifact_sha256: string }> }
      ).stageArtifacts;
      const savedS2Sha = artifactMap.get(s2Good.artifact.artifact_id)!.artifact_sha256;
      artifactMap.get(s2Good.artifact.artifact_id)!.artifact_sha256 = sha256Hex("tampered-sha");
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            () => store.getStageArtifactById(s2Good.artifact.artifact_id)
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            () => store.listStageArtifacts(tx2SessId)
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(proj.project_id, authApprover, tx2SessId, {
            approval_gate_id: gateGood.gate_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      artifactMap.get(s2Good.artifact.artifact_id)!.artifact_sha256 = savedS2Sha;

      // M6A-FU-04: Bare multi-statement freezeBaselineSpec failure rolls back both baselineSpecFreezes & pipelineSessions
      const origInsertOutbox = (
        store as unknown as {
          insertOutboxEventInternal: (
            p: string,
            t: string,
            id: string,
            ev: string,
            payload: Record<string, unknown>
          ) => void;
        }
      ).insertOutboxEventInternal.bind(store);
      let failOutboxOnce = true;
      (
        store as unknown as {
          insertOutboxEventInternal: typeof origInsertOutbox;
        }
      ).insertOutboxEventInternal = (p, t, id, ev, payload) => {
        if (failOutboxOnce && ev === "pipeline.baseline_frozen") {
          failOutboxOnce = false;
          throw new Error("Simulated mid-freeze outbox failure");
        }
        origInsertOutbox(p, t, id, ev, payload);
      };
      try {
        await store.withRlsTransaction(
          {
            currentProjectId: proj.project_id,
            currentPrincipalId: "bob-approver",
            currentRole: "core_api_service",
          },
          async () => {
            await assert.rejects(
              () =>
                store.freezeBaselineSpec({
                  project_id: proj.project_id,
                  pipeline_session_id: tx2SessId,
                  stage1_artifact_id: s1Tx2.artifact.artifact_id,
                  stage1_artifact_sha256: s1Tx2.artifact.artifact_sha256,
                  stage2_artifact_id: s2Good.artifact.artifact_id,
                  stage2_artifact_sha256: s2Good.artifact.artifact_sha256,
                  stage3_artifact_id: s3Good.artifact.artifact_id,
                  stage3_artifact_sha256: s3Good.artifact.artifact_sha256,
                  validation_report_artifact_id: s4Good.artifact.artifact_id,
                  validation_report_sha256: s4Good.artifact.artifact_sha256,
                  approval_gate_id: gateGood.gate_id,
                  frozen_by_principal_id: "bob-approver",
                }),
              /Simulated mid-freeze outbox failure/
            );
            // Even INSIDE the same outer TX after catching, freezeBaselineSpec's internal rollback boundary must have undone partial writes!
            assert.equal(store.getBaselineSpecFreeze(tx2SessId), null);
            assert.equal(store.getProductPipelineSession(tx2SessId)?.status, "ACTIVE");
          }
        );
      } finally {
        (
          store as unknown as {
            insertOutboxEventInternal: typeof origInsertOutbox;
          }
        ).insertOutboxEventInternal = origInsertOutbox;
      }

      // M6A-FU-03: Autonomous denial survival across rolling-back outer TX on committed session vs clean rollback on uncommitted parent
      const committedCs = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.createCostSession({
            project_id: proj.project_id,
            max_tokens_per_request: 100,
            max_cost_micro_usd_per_request: 100_000,
            session_token_budget: 150,
            session_cost_budget_micro_usd: 100_000,
          })
      );

      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            async () => {
              const preRes = await store.preflightCheckCostSession({
                project_id: proj.project_id,
                cost_session_id: committedCs.cost_session_id,
                stage: "STAGE_1_IDEA_DISCOVERY",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                request_sha256: "b".repeat(64),
                estimated_input_tokens: 10,
                reserved_output_tokens: 500,
                estimated_cost_micro_usd: 100,
              });
              assert.equal(preRes.allowed, false);
              assert.equal(preRes.limitScope, "PER_REQUEST_TOKENS");
              throw new Error("FORCE_OUTER_TX_ROLLBACK_PREFLIGHT");
            }
          ),
        /FORCE_OUTER_TX_ROLLBACK_PREFLIGHT/
      );

      const ledgersAfterPreRollback = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () => store.listModelCallLedgers({ cost_session_id: committedCs.cost_session_id })
      );
      assert.equal(ledgersAfterPreRollback.length, 1);
      assert.equal(ledgersAfterPreRollback[0]!.status, "BLOCKED_PREFLIGHT");

      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            async () => {
              const postRes = await store.finalizeModelCallLedger({
                project_id: proj.project_id,
                cost_session_id: committedCs.cost_session_id,
                stage: "STAGE_1_IDEA_DISCOVERY",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                request_sha256: "c".repeat(64),
                estimated_input_tokens: 10,
                reserved_output_tokens: 50,
                actual_input_tokens: 120,
                actual_output_tokens: 80, // 200 > 150 session_token_budget -> BLOCKED_POSTCALL + EXHAUSTED
                estimated_cost_micro_usd: 100,
                actual_cost_micro_usd: 500,
                outcome: "ALLOWED",
                latency_ms: 15,
              });
              assert.equal(postRes.allowed, false);
              assert.equal(postRes.session.status, "EXHAUSTED");
              assert.equal(postRes.ledger.status, "BLOCKED_POSTCALL");
              throw new Error("FORCE_OUTER_TX_ROLLBACK_POSTCALL");
            }
          ),
        /FORCE_OUTER_TX_ROLLBACK_POSTCALL/
      );

      const afterPostRollback = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () => ({
          session: store.getCostSession(committedCs.cost_session_id),
          ledgers: store.listModelCallLedgers({ cost_session_id: committedCs.cost_session_id }),
        })
      );
      assert.equal(afterPostRollback.session?.status, "EXHAUSTED");
      assert.equal(afterPostRollback.ledgers.length, 2);
      assert.equal(afterPostRollback.ledgers[1]!.status, "BLOCKED_POSTCALL");

      // Uncommitted parent created INSIDE outer TX must roll back cleanly (0 orphaned ledgers)
      let uncommittedCsId = "";
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            async () => {
              const uncomm = await store.createCostSession({
                project_id: proj.project_id,
                max_tokens_per_request: 100,
                max_cost_micro_usd_per_request: 100_000,
                session_token_budget: 200,
                session_cost_budget_micro_usd: 100_000,
              });
              uncommittedCsId = uncomm.cost_session_id;
              const blocked = await store.preflightCheckCostSession({
                project_id: proj.project_id,
                cost_session_id: uncommittedCsId,
                stage: "STAGE_1_IDEA_DISCOVERY",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                request_sha256: "d".repeat(64),
                estimated_input_tokens: 10,
                reserved_output_tokens: 500,
                estimated_cost_micro_usd: 100,
              });
              assert.equal(blocked.allowed, false);
              throw new Error("ROLLBACK_UNCOMMITTED_PARENT");
            }
          ),
        /ROLLBACK_UNCOMMITTED_PARENT/
      );
      await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () => {
          assert.equal(store.getCostSession(uncommittedCsId), null);
          assert.equal(store.listModelCallLedgers({ cost_session_id: uncommittedCsId }).length, 0);
        }
      );

      // M6A-FU-05: HTTP 429/500 partial usage billing (Anthropic, OpenAI, Google) + BLOCKED_POSTCALL budget trip
      const partialExec = new ManagedModelProviderExecutor({
        client: new LiveModelProviderClient({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKey: "test-anthropic-key-local",
          baseUrl: mock.anthropicBaseUrl,
        }),
        promptRegistry: createDefaultPipelinePromptRegistry(),
        costGuard: store,
      });
      const partialCs = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.createCostSession({
            project_id: proj.project_id,
            max_tokens_per_request: 8000,
            max_cost_micro_usd_per_request: 2_000_000,
            session_token_budget: 20_000,
            session_cost_budget_micro_usd: 10_000_000,
          })
      );

      mock.setResponseOverride("anthropic", {
        statusCode: 429,
        jsonBody: {
          type: "error",
          error: { type: "rate_limit_error", message: "Anthropic 429 with usage" },
          usage: { input_tokens: 90, output_tokens: 25 },
        },
      });
      await assert.rejects(
        () =>
          partialExec.executeStructuredPrompt({
            projectId: proj.project_id,
            costSessionId: partialCs.cost_session_id,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            variables: {
              project_id: proj.project_id,
              pipeline_session_id: tx2SessId,
              title: "Partial",
              raw_idea_text: "Idea",
            },
          }),
        (err: unknown) =>
          err instanceof ModelProviderHttpError &&
          err.statusCode === 429 &&
          err.partialUsage?.inputTokens === 90 &&
          err.partialUsage?.outputTokens === 25
      );
      mock.setResponseOverride("anthropic", null);

      const openaiExec = partialExec.withProviderConfig({
        provider: "openai",
        model: "gpt-4.1",
        apiKey: "test-openai-key-local",
        baseUrl: mock.openaiBaseUrl,
      });
      mock.setResponseOverride("openai", {
        statusCode: 500,
        jsonBody: {
          error: { message: "OpenAI 500 with usage" },
          usage: { prompt_tokens: 70, completion_tokens: 15 },
        },
      });
      await assert.rejects(
        () =>
          openaiExec.executeStructuredPrompt({
            projectId: proj.project_id,
            costSessionId: partialCs.cost_session_id,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            variables: {
              project_id: proj.project_id,
              pipeline_session_id: tx2SessId,
              title: "Partial OAI",
              raw_idea_text: "Idea",
            },
          }),
        (err: unknown) =>
          err instanceof ModelProviderHttpError &&
          err.statusCode === 500 &&
          err.partialUsage?.inputTokens === 70 &&
          err.partialUsage?.outputTokens === 15
      );
      mock.setResponseOverride("openai", null);

      const googleExec = partialExec.withProviderConfig({
        provider: "google",
        model: "gemini-2.5-pro",
        apiKey: "test-google-key-local",
        baseUrl: mock.googleBaseUrl,
      });
      mock.setResponseOverride("google", {
        statusCode: 429,
        jsonBody: {
          error: { message: "Google 429 with usageMetadata" },
          usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 10 },
        },
      });
      await assert.rejects(
        () =>
          googleExec.executeStructuredPrompt({
            projectId: proj.project_id,
            costSessionId: partialCs.cost_session_id,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            variables: {
              project_id: proj.project_id,
              pipeline_session_id: tx2SessId,
              title: "Partial Google",
              raw_idea_text: "Idea",
            },
          }),
        (err: unknown) =>
          err instanceof ModelProviderHttpError &&
          err.statusCode === 429 &&
          err.partialUsage?.inputTokens === 60 &&
          err.partialUsage?.outputTokens === 10
      );
      mock.setResponseOverride("google", null);

      const partialAfterThree = await coreClient.getCostSession(
        proj.project_id,
        authDev,
        partialCs.cost_session_id
      );
      assert.equal(partialAfterThree.ledgers.length, 3);
      for (const l of partialAfterThree.ledgers) {
        assert.equal(l.status, "FAILED_PROVIDER");
        assert.equal(l.usage_estimated, false);
        assert.ok(l.actual_total_tokens > 0);
        assert.ok(l.actual_cost_micro_usd > 0);
      }
      assert.equal(partialAfterThree.session.tokens_used_total, 115 + 85 + 70);

      // Partial usage exceeding remaining budget trips BLOCKED_POSTCALL + EXHAUSTED + CostBudgetExceededError
      const tightPartialCs = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.createCostSession({
            project_id: proj.project_id,
            max_tokens_per_request: 1000,
            max_cost_micro_usd_per_request: 1_000_000,
            session_token_budget: 250,
            session_cost_budget_micro_usd: 1_000_000,
          })
      );
      mock.setResponseOverride("anthropic", {
        statusCode: 429,
        jsonBody: {
          error: { message: "Over-budget HTTP error" },
          usage: { input_tokens: 200, output_tokens: 80 }, // 280 > 250 post-call budget
        },
      });
      await assert.rejects(
        () =>
          partialExec.executeStructuredPrompt({
            projectId: proj.project_id,
            costSessionId: tightPartialCs.cost_session_id,
            stage: "STAGE_1_IDEA_DISCOVERY",
            promptId: STAGE1_DISCOVERY_PROMPT_ID,
            maxTokens: 16,
            variables: {
              project_id: proj.project_id,
              pipeline_session_id: tx2SessId,
              title: "OverBudget",
              raw_idea_text: "Idea",
            },
          }),
        (err: unknown) =>
          err instanceof CostBudgetExceededError && err.limitScope === "SESSION_TOKEN_BUDGET"
      );
      mock.setResponseOverride("anthropic", null);
      const tightPartialAfter = await coreClient.getCostSession(
        proj.project_id,
        authDev,
        tightPartialCs.cost_session_id
      );
      assert.equal(tightPartialAfter.session.status, "EXHAUSTED");
      assert.equal(tightPartialAfter.ledgers[0]?.status, "BLOCKED_POSTCALL");
      assert.equal(tightPartialAfter.ledgers[0]?.actual_input_tokens, 200);
      assert.equal(tightPartialAfter.ledgers[0]?.actual_output_tokens, 80);
      assert.equal(tightPartialAfter.ledgers[0]?.usage_estimated, false);
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });

  it("M6A-FU-PG: Live PostgreSQL 17 M6A-FU-01..05 (tamper detection, TX2 compensation, autonomous denials & bare TX atomicity)", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const mock = await startMockModelProviderServers();
    const stack = await createControlPlaneStackRuntime({
      poolConfig: pgConfig,
      requirePostgres: true,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: false,
    });
    const createdProjectIds: string[] = [];
    try {
      const pool = stack.pool!;
      const store = stack.coreApiRuntime!.store;
      const coreApi = stack.coreApiRuntime!.coreApi;
      const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "pg-admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6a-fu-pg-${randomUUID().slice(0, 8)}`,
            name: "M6A Follow-up PG",
            repo_bare_path: `/tmp/m6a-fu-pg-${randomUUID().slice(0, 8)}.git`,
            initial_main_commit_hash: "a".repeat(40),
            initial_main_tree_hash: "b".repeat(40),
          });
          createdProjectIds.push(p.project_id);
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "pg-alice-dev",
            member_role: "DEVELOPER",
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "pg-bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "pg-alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "pg-bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      // M6A-FU-02 on live PG: Stage 2 AC-10 trigger failure in TX2 rolls back ALLOWED ledger & bills once via FAILED_VALIDATION
      const sess = await coreClient.createPipelineSession(proj.project_id, authDev, {
        title: "PG M6A-FU-02",
        raw_idea_text: "Prove PG TX2 failure records single FAILED_VALIDATION and 0 ALLOWED.",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 2_000_000,
          session_token_budget: 80_000,
          session_cost_budget_micro_usd: 15_000_000,
        },
      });
      const sessId = sess.session.pipeline_session_id;
      const costSessionId = sess.costSession!.cost_session_id;
      const s1 = await coreClient.runPipelineStage1Extract(proj.project_id, authDev, sessId);
      const unconf = s1.discoveryItems.find((i) => i.kind === "ASSUMPTION")!;

      mock.setResponseOverride("anthropic", {
        inputTokens: 130,
        outputTokens: 60,
        text: JSON.stringify({
          prd: { product_vision: "v", target_personas: ["Op"], goals: ["g"], non_goals: [] },
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-PG-BAD-AC10",
                title: "Bad ref",
                description: "D",
                priority: "MUST",
                source_discovery_item_ids: [unconf.item_id],
                acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
              },
            ],
            non_functional_requirements: [],
          },
        }),
      });
      await assert.rejects(
        () => coreClient.runPipelineStage2Requirements(proj.project_id, authDev, sessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      mock.setResponseOverride("anthropic", null);

      const costAfterFail = await coreClient.getCostSession(proj.project_id, authDev, costSessionId);
      const pgS2Ledgers = costAfterFail.ledgers.filter((l) => l.stage === "STAGE_2_REQUIREMENTS");
      assert.equal(pgS2Ledgers.length, 1);
      assert.equal(pgS2Ledgers[0]!.status, "FAILED_VALIDATION");
      assert.equal(pgS2Ledgers[0]!.actual_input_tokens, 130);
      assert.equal(pgS2Ledgers[0]!.actual_output_tokens, 60);
      const pgBundleAfterFail = await coreClient.getPipelineBundle(proj.project_id, authDev, sessId);
      assert.equal(
        pgBundleAfterFail.artifacts.filter((a) => a.stage === "STAGE_2_REQUIREMENTS").length,
        0
      );

      // M6A-FU-03 on live PG: autonomous BLOCKED_PREFLIGHT & BLOCKED_POSTCALL survive outer TX rollback
      const commCs = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "pg-alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.createCostSession({
            project_id: proj.project_id,
            max_tokens_per_request: 100,
            max_cost_micro_usd_per_request: 100_000,
            session_token_budget: 150,
            session_cost_budget_micro_usd: 100_000,
          })
      );

      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            async () => {
              const pre = await store.preflightCheckCostSession({
                project_id: proj.project_id,
                cost_session_id: commCs.cost_session_id,
                stage: "STAGE_1_IDEA_DISCOVERY",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                request_sha256: "e".repeat(64),
                estimated_input_tokens: 10,
                reserved_output_tokens: 500,
                estimated_cost_micro_usd: 100,
              });
              assert.equal(pre.allowed, false);
              throw new Error("PG_OUTER_TX_ROLLBACK");
            }
          ),
        /PG_OUTER_TX_ROLLBACK/
      );
      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "pg-alice-dev",
              currentRole: "core_api_service",
            },
            async () => {
              const post = await store.finalizeModelCallLedger({
                project_id: proj.project_id,
                cost_session_id: commCs.cost_session_id,
                stage: "STAGE_1_IDEA_DISCOVERY",
                provider: "anthropic",
                model: "claude-sonnet-4-20250514",
                prompt_id: STAGE1_DISCOVERY_PROMPT_ID,
                prompt_version: "1.0.0",
                prompt_sha256: "a".repeat(64),
                request_sha256: "f".repeat(64),
                estimated_input_tokens: 10,
                reserved_output_tokens: 50,
                actual_input_tokens: 120,
                actual_output_tokens: 80,
                estimated_cost_micro_usd: 100,
                actual_cost_micro_usd: 500,
                outcome: "ALLOWED",
                latency_ms: 12,
              });
              assert.equal(post.allowed, false);
              assert.equal(post.ledger.status, "BLOCKED_POSTCALL");
              throw new Error("PG_OUTER_TX_ROLLBACK_POST");
            }
          ),
        /PG_OUTER_TX_ROLLBACK_POST/
      );
      const pgDurable = await coreClient.getCostSession(
        proj.project_id,
        authDev,
        commCs.cost_session_id
      );
      assert.equal(pgDurable.session.status, "EXHAUSTED");
      assert.equal(pgDurable.ledgers.length, 2);
      assert.equal(pgDurable.ledgers[0]!.status, "BLOCKED_PREFLIGHT");
      assert.equal(pgDurable.ledgers[1]!.status, "BLOCKED_POSTCALL");

      // M6A-FU-01 on live PG: Complete pipeline, tamper stage_artifacts.content_json via table owner (if psql present) OR verify mismatched SHA on freeze -> 23514
      const s2Pg = await coreClient.runPipelineStage2Requirements(proj.project_id, authDev, sessId);
      await coreClient.runPipelineStage3Architecture(proj.project_id, authDev, sessId);
      const s4Pg = await coreClient.runPipelineStage4ConsistencyCheck(proj.project_id, authDev, sessId);
      const gatePg = await coreClient.submitPipelineApprovalGate(proj.project_id, authApprover, sessId, {
        gate_stage: "STAGE_4_SPEC_FREEZE",
        target_artifact_id: s4Pg.artifact.artifact_id,
        target_artifact_sha256: s4Pg.artifact.artifact_sha256,
        decision: "APPROVED",
      });
      await assert.rejects(
        () =>
          coreClient.freezePipelineBaseline(proj.project_id, authApprover, sessId, {
            approval_gate_id: gatePg.gate_id,
            validation_report_sha256: "0".repeat(64),
          }),
        (err: unknown) => err instanceof HttpCoreApiError && (err.statusCode === 422 || err.statusCode === 404)
      );

      // If psql binary & table owner credentials are configured, tamper DB content_json directly & confirm 23514 on read
      const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../../..");
      const psqlBin = (() => {
        for (const candidate of [
          "psql",
          "/opt/homebrew/opt/postgresql@17/bin/psql",
          "/usr/local/opt/postgresql@17/bin/psql",
          "/opt/homebrew/bin/psql",
          "/usr/local/bin/psql",
        ]) {
          try {
            execFileSync(candidate, ["--version"], { stdio: "ignore" });
            return candidate;
          } catch {
            // continue
          }
        }
        return null;
      })();
      if (psqlBin) {
        execFileSync(psqlBin, ["-v", "ON_ERROR_STOP=1"], {
          cwd: repoRoot,
          // Privileged corruption fixture only: retain independent read-time integrity coverage.
          input: `BEGIN; ALTER TABLE stage_artifacts DISABLE TRIGGER trg_stage_artifact_canonical_sha256; UPDATE stage_artifacts SET content_json = '{"tampered":true}'::jsonb WHERE artifact_id = '${s2Pg.artifact.artifact_id}'; ALTER TABLE stage_artifacts ENABLE TRIGGER trg_stage_artifact_canonical_sha256; COMMIT;`,
          env: {
            ...process.env,
            PGHOST: pgConfig.host,
            PGPORT: String(pgConfig.port),
            PGUSER: pgConfig.user,
            PGDATABASE: pgConfig.database,
            ...(pgConfig.password !== undefined ? { PGPASSWORD: pgConfig.password } : {}),
            ...(pgConfig.sslMode ? { PGSSLMODE: pgConfig.sslMode } : {}),
            ...(pgConfig.sslRootCertPath ? { PGSSLROOTCERT: pgConfig.sslRootCertPath } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        await assert.rejects(
          () =>
            store.withRlsTransaction(
              {
                currentProjectId: proj.project_id,
                currentPrincipalId: "pg-alice-dev",
                currentRole: "core_api_service",
              },
              () => store.getStageArtifactById(s2Pg.artifact.artifact_id)
            ),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );
        await assert.rejects(
          () =>
            store.withRlsTransaction(
              {
                currentProjectId: proj.project_id,
                currentPrincipalId: "pg-alice-dev",
                currentRole: "core_api_service",
              },
              () => store.listStageArtifacts(sessId)
            ),
          (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
        );
      }

      // M6A-FU-05 on live PG: HTTP 429 with partial usage via Anthropic records exact partial tokens in PG model_call_ledgers
      mock.setResponseOverride("anthropic", {
        statusCode: 429,
        jsonBody: {
          type: "error",
          error: { type: "rate_limit_error", message: "PG HTTP 429 with usage" },
          usage: { input_tokens: 77, output_tokens: 23 },
        },
      });
      await assert.rejects(
        () => coreClient.runPipelineStage1Extract(proj.project_id, authDev, sessId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode >= 500
      );
      mock.setResponseOverride("anthropic", null);
      const pgAfterHttpErr = await coreClient.getCostSession(proj.project_id, authDev, costSessionId);
      const failedProv = pgAfterHttpErr.ledgers.find((l) => l.status === "FAILED_PROVIDER");
      assert.ok(failedProv);
      assert.equal(failedProv!.actual_input_tokens, 77);
      assert.equal(failedProv!.actual_output_tokens, 23);
      assert.equal(failedProv!.usage_estimated, false);
      assert.ok(failedProv!.actual_cost_micro_usd > 0);
      assert.ok(pool.getStats().discardAllExecuted > 0);
    } finally {
      for (const pid of createdProjectIds) {
        try {
          await stack.coreApiRuntime!.store.withRlsTransaction(
            { currentRole: "system_admin_role", currentPrincipalId: "pg-cleanup" },
            async () => {
              if (!stack.pool) return;
              await stack.pool.queryInActiveTx(
                `DELETE FROM baseline_spec_freezes WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM stage_approval_gates WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM stage_artifacts WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM stage1_discovery_items WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM model_call_ledgers WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM product_pipeline_sessions WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM model_cost_sessions WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM outbox_events WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(
                `DELETE FROM project_memberships WHERE project_id = $1::uuid;`,
                [pid]
              );
              await stack.pool.queryInActiveTx(`DELETE FROM projects WHERE project_id = $1::uuid;`, [
                pid,
              ]);
            }
          );
        } catch {
          // ignore if connected as non-owner app_runtime
        }
      }
      await Promise.allSettled([stack.close(), mock.close()]);
    }
  });
});
