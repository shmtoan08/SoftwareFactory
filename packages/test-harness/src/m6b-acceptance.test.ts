import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WorkspaceCodingAgentAdapter } from "@software-factory/adapter-sdk";
import {
  AgentGatewayHttpServer,
  AgentGatewayService,
  EphemeralGitPushTokenService,
  EphemeralReviewerCredentialService,
  HttpAgentGatewayClient,
} from "@software-factory/agent-gateway";
import {
  CORE_API_AUTH_HEADER,
  type CoreApiAuthContext,
  CoreApiHttpServer,
  CoreApiService,
  HttpCoreApiClient,
  HttpCoreApiError,
  encodeCoreApiAuthHeader,
} from "@software-factory/core-api";
import {
  type ControlPlaneStore,
  PostgresControlPlaneRepository,
  PostgresRlsError,
  PostgresRuntimePool,
  REQUIRED_STAGE5_PROTECTED_PATHS,
  SoftwareFactoryControlPlaneStore,
  buildPostgresPoolConfigFromEnv,
  computeBaselineFreezeBundleSha256,
  computeProjectBootstrapSha256,
  extractStage2Requirements,
  validateCreateChangeRequestAgainstBaseline,
  validateProjectBootstrapInput,
  validateStage7PlanAgainstBaseline,
} from "@software-factory/database";
import {
  type AgentOrgRole,
  type BidirectionalTraceabilityMatrix,
  type ExecutionTargetType,
  type M6BStages5To9Bundle,
  type ModelProviderName,
  type Stage1DiscoveryBundle,
  type Stage2RequirementsSpec,
  type Stage3ArchitectureSpec,
  type Stage7PlanningOutput,
  type TargetTrustTier,
  computeCanonicalPayloadSha256,
  computeDirectorySha256,
} from "@software-factory/shared-types";
import {
  Docker3TierVerifier,
  ImmutableSourceSnapshotStore,
  buildRealGitMergeCandidate,
  probeDockerVerifierSupport,
} from "@software-factory/verifier";
import {
  WebApprovalConsoleHttpServer,
  createControlPlaneStackRuntime,
} from "@software-factory/web";
import { LinuxCgroupV2SandboxBackend, WnaWorkerDaemon } from "@software-factory/wna";

interface RecordedProviderRequest {
  readonly provider: ModelProviderName;
  readonly url: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

interface ProviderResponseOverride {
  readonly statusCode?: number;
  readonly text?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

interface MockModelProviderHarness {
  readonly anthropicBaseUrl: string;
  readonly openaiBaseUrl: string;
  readonly googleBaseUrl: string;
  readonly hits: Record<ModelProviderName, number>;
  readonly requests: RecordedProviderRequest[];
  setStage1Factory(factory: () => Stage1DiscoveryBundle): void;
  setStage7Override(
    override:
      | Stage7PlanningOutput
      | ((userPrompt: string) => Stage7PlanningOutput)
      | null
  ): void;
  setResponseOverride(
    provider: ModelProviderName | "any",
    override:
      | ProviderResponseOverride
      | ((req: RecordedProviderRequest) => ProviderResponseOverride)
      | null
  ): void;
  close(): Promise<void>;
}

function readHttpBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
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

function findPreReceiveHookSource(): string {
  let cursor = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(cursor, "scripts", "git-hooks", "pre-receive");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const fromCwd = resolve(process.cwd(), "scripts", "git-hooks", "pre-receive");
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  throw new Error("Could not locate scripts/git-hooks/pre-receive");
}

function restoreWritableRecursive(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  try {
    chmodSync(targetDir, 0o700);
  } catch {
    return;
  }
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    const full = join(targetDir, entry.name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        restoreWritableRecursive(full);
      } else {
        chmodSync(full, 0o600);
      }
    } catch {
      // best-effort cleanup
    }
  }
}

function gitAt(
  cwd: string,
  args: readonly string[],
  extraEnv?: Readonly<Record<string, string>>
): string {
  return execFileSync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Software Factory Test",
      GIT_AUTHOR_EMAIL: "sf-test@software-factory.local",
      GIT_COMMITTER_NAME: "Software Factory Test",
      GIT_COMMITTER_EMAIL: "sf-test@software-factory.local",
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  }).trim();
}

function buildDefaultStage1Bundle(): Stage1DiscoveryBundle {
  return {
    summary: "Deterministic ledger API intake separating verified facts from clarifications.",
    facts: [
      {
        title: "Ledger Entry Creation",
        statement: "Provide an audited function createLedgerEntry that enforces non-negative integer cents.",
        rationale: "Explicitly stated in the core product specification.",
      },
      {
        title: "Deterministic Hash Trail",
        statement: "Persist immutable SHA-256 verification evidence on every committed entry.",
        rationale: "Explicit compliance requirement stated by stakeholder.",
      },
    ],
    assumptions: [
      {
        title: "Default Settlement Currency",
        statement: "Default settlement currency is USD when currency code is supplied.",
        rationale: "Standard north-american ledger assumption.",
        clarification_question: "Confirm USD default settlement behavior?",
      },
    ],
    recommendations: [
      {
        title: "PDF Statement Rendering",
        statement: "Generate printable PDF ledger exports.",
        rationale: "Convenience feature outside v1 core scope.",
        clarification_question: "Include PDF rendering in v1?",
      },
    ],
  };
}

function buildDynamicStage2Payload(userPrompt: string): Stage2RequirementsSpec {
  const marker = "Verified Stage 1 Items (AUTO_VERIFIED / CONFIRMED only):\n";
  const idx = userPrompt.indexOf(marker);
  if (idx === -1) {
    throw new Error("Mock Stage 2 expected Verified Stage 1 Items marker");
  }
  const items = JSON.parse(userPrompt.slice(idx + marker.length).trim()) as Array<{
    item_id: string;
    kind: string;
    title: string;
    statement: string;
  }>;
  if (items.length === 0) {
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
        given: `Stage 1 verified item ${item.item_id} is active`,
        when: "Operator creates a ledger entry",
        then: `${item.title} behaves deterministically`,
      },
    ],
  }));

  const tailItem = items[items.length - 1]!;
  const nonFuncReqs = [
    {
      req_id: "REQ-NFR-001",
      title: `Audit Trail for ${tailItem.title}`,
      description: tailItem.statement,
      priority: "MUST" as const,
      source_discovery_item_ids: [tailItem.item_id],
      acceptance_criteria: [
        {
          ac_id: "AC-NFR-1",
          given: "PostgreSQL RLS storage is active",
          when: "Entry commits to ledger",
          then: "Canonical SHA-256 verification is deterministic",
        },
      ],
    },
  ];

  return {
    prd: {
      product_vision: "Deterministic multi-tenant accounting core",
      target_personas: ["Platform Architect", "Developer", "Project Approver"],
      goals: ["Zero hallucinated specs", "100% traceability from discovery to main"],
      non_goals: ["Unverified production edits outside Stage 9 CR"],
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
    throw new Error("Mock Stage 3 expected Stage 2 PRD & SRS marker");
  }
  const spec = JSON.parse(userPrompt.slice(idx + marker.length).trim()) as Stage2RequirementsSpec;
  const reqIds = [
    ...spec.srs.functional_requirements.map((r) => r.req_id),
    ...spec.srs.non_functional_requirements.map((r) => r.req_id),
  ];

  return {
    architecture: {
      overview: "Modular TypeScript/ESM core domain module behind hardened RLS control plane.",
      components: [
        {
          component_id: "COMP-LEDGER-CORE",
          name: "LedgerCoreEngine",
          responsibility: "Implements core ledger creation and deterministic digesting.",
          requirement_ids: reqIds,
        },
      ],
    },
    database_erd: {
      entities: [
        {
          entity_name: "ledger_entries",
          primary_key: "entry_id",
          columns: ["entry_id UUID", "project_id UUID", "amount_cents BIGINT", "digest CHAR(64)"],
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
          path: "/api/v1/projects/:projectId/ledger-entries",
          summary: "Creates audited ledger entry inside project boundary",
          auth_role: "DEVELOPER",
          requirement_ids: reqIds,
        },
      ],
    },
    security_design: {
      threat_controls: [
        {
          threat_id: "THREAT-TRACEABILITY-GAP",
          threat: "Unlinked code reaching production main without frozen baseline trace",
          mitigation: "AC-11b bidirectional traceability gate + Stage 5 protected paths",
          requirement_ids: reqIds,
        },
      ],
    },
    adrs: [
      {
        adr_id: "ADR-001",
        title: "Immutable Release Package & Change Request Governance",
        status: "ACCEPTED",
        context: "Post-freeze scope changes require auditable approval.",
        decision: "Gate all post-freeze edits through Stage 9 CR workflow and Stage 8 CAS.",
        consequences: "100% commit ancestry verification before Release Acceptance.",
        requirement_ids: reqIds,
      },
    ],
  };
}

function buildDynamicStage7Payload(userPrompt: string): Stage7PlanningOutput {
  const s2Start = userPrompt.indexOf("Frozen Stage 2 Requirements:\n");
  const s3Start = userPrompt.indexOf("\nFrozen Stage 3 Architecture:");
  const pStart = userPrompt.indexOf("Stage 6 Agent Organization Profiles:\n");
  if (s2Start === -1 || s3Start === -1 || pStart === -1) {
    throw new Error("Mock Stage 7 expected Stage 2 & Stage 6 markers");
  }
  const s2JsonText = userPrompt
    .slice(s2Start + "Frozen Stage 2 Requirements:\n".length, s3Start)
    .trim();
  const s2Spec = JSON.parse(s2JsonText) as Stage2RequirementsSpec;
  const profiles = JSON.parse(
    userPrompt.slice(pStart + "Stage 6 Agent Organization Profiles:\n".length).trim()
  ) as Array<{ profile_key: string; role: string }>;

  const allReqs = [
    ...s2Spec.srs.functional_requirements,
    ...s2Spec.srs.non_functional_requirements,
  ];
  const allReqIds = allReqs.map((r) => r.req_id);
  const allAcIds = allReqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
  const devProfileKey = profiles.find((p) => p.role === "DEVELOPER")?.profile_key;

  return {
    milestones: [
      {
        milestone_key: "MS-1",
        title: "Milestone 1: Core Ledger Implementation",
        description: "Complete implementation of all frozen requirements and trusted tests.",
      },
    ],
    epics: [
      {
        epic_key: "EPIC-1",
        milestone_key: "MS-1",
        title: "Deterministic Ledger Module",
        description: "Deliver src/ledger.mjs and verified agent tests.",
      },
    ],
    stories: [
      {
        story_key: "STORY-1",
        epic_key: "EPIC-1",
        title: "Implement core ledger functions and audit trail",
        description: "Satisfies all frozen functional & NFR criteria.",
        requirement_ids: allReqIds,
        ac_ids: allAcIds,
      },
    ],
    tasks: [
      {
        task_key: "TASK-IMPL",
        story_key: "STORY-1",
        title: "Implement ledger domain module and agent unit tests",
        description: "Creates src/ledger.mjs and test/ledger.agent.test.mjs",
        requirement_ids: allReqIds,
        ac_ids: allAcIds,
        allowed_files: ["src/**", "test/**"],
        depends_on_task_keys: [],
        ...(devProfileKey ? { developer_profile_key: devProfileKey } : {}),
      },
    ],
    planning_notes: "Single cohesive vertical implementation task covering 100% of frozen baseline.",
  };
}

async function startMockModelProviderServers(): Promise<MockModelProviderHarness> {
  const hits: Record<ModelProviderName, number> = {
    anthropic: 0,
    openai: 0,
    google: 0,
  };
  const requests: RecordedProviderRequest[] = [];
  let stage1Factory: () => Stage1DiscoveryBundle = () => buildDefaultStage1Bundle();
  let stage7Override:
    | Stage7PlanningOutput
    | ((userPrompt: string) => Stage7PlanningOutput)
    | null = null;
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
          url: req.url ?? "/",
          systemPrompt,
          userPrompt,
        };
        requests.push(recorded);

        const rawOverride = overrides.get(provider) ?? overrides.get("any");
        const resolvedOverride =
          typeof rawOverride === "function" ? rawOverride(recorded) : rawOverride;

        if (resolvedOverride?.statusCode && resolvedOverride.statusCode >= 400) {
          res.writeHead(resolvedOverride.statusCode, {
            "Content-Type": "text/plain",
            Connection: "close",
          });
          res.end(resolvedOverride.text ?? `Simulated HTTP ${resolvedOverride.statusCode}`);
          return;
        }

        let responseText: string;
        if (resolvedOverride?.text !== undefined) {
          responseText = resolvedOverride.text;
        } else if (userPrompt.includes("Frozen Stage 2 Requirements:")) {
          const plan =
            stage7Override === null
              ? buildDynamicStage7Payload(userPrompt)
              : typeof stage7Override === "function"
                ? stage7Override(userPrompt)
                : stage7Override;
          responseText = JSON.stringify(plan);
        } else if (userPrompt.includes("Verified Stage 1 Items")) {
          responseText = JSON.stringify(buildDynamicStage2Payload(userPrompt));
        } else if (userPrompt.includes("Stage 2 PRD & SRS:")) {
          responseText = JSON.stringify(buildDynamicStage3Payload(userPrompt));
        } else if (userPrompt.includes("Raw Product Idea:")) {
          responseText = JSON.stringify(stage1Factory());
        } else {
          responseText = JSON.stringify({ ok: true });
        }

        const inputTokens = resolvedOverride?.inputTokens ?? 120;
        const outputTokens = resolvedOverride?.outputTokens ?? 80;

        if (provider === "anthropic") {
          writeJsonResponse(res, 200, {
            id: `msg_${hits.anthropic}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          return;
        }
        if (provider === "openai") {
          writeJsonResponse(res, 200, {
            id: `chatcmpl_${hits.openai}`,
            choices: [{ index: 0, message: { role: "assistant", content: responseText } }],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          });
          return;
        }
        writeJsonResponse(res, 200, {
          candidates: [{ content: { role: "model", parts: [{ text: responseText }] } }],
          usageMetadata: {
            promptTokenCount: inputTokens,
            candidatesTokenCount: outputTokens,
            totalTokenCount: inputTokens + outputTokens,
          },
        });
      } catch (err: unknown) {
        writeJsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    };

  const listenServer = async (provider: ModelProviderName) => {
    const srv = createServer((req, res) => {
      void makeHandler(provider)(req, res);
    });
    await new Promise<void>((resolvePromise, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", reject);
        resolvePromise();
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
    setStage7Override(override) {
      stage7Override = override;
    },
    setResponseOverride(provider, override) {
      if (override === null) {
        overrides.delete(provider);
      } else {
        overrides.set(provider, override);
      }
    },
    async close() {
      await Promise.all(
        [anth.server, oai.server, goog.server].map(
          (srv) =>
            new Promise<void>((resolvePromise) => {
              srv.closeAllConnections?.();
              srv.close(() => resolvePromise());
            })
        )
      );
    },
  };
}

async function advanceToFrozenBaseline(options: {
  client: HttpCoreApiClient;
  projectId: string;
  authDev: CoreApiAuthContext;
  authApprover: CoreApiAuthContext;
  title?: string;
}) {
  const created = await options.client.createPipelineSession(options.projectId, options.authDev, {
    title: options.title ?? "M6B Pipeline",
    raw_idea_text: "Build audited ledger entry core with SHA-256 trail and strict ACID persistence.",
    cost_budget: {
      max_tokens_per_request: 16_000,
      max_cost_micro_usd_per_request: 2_000_000,
      session_token_budget: 200_000,
      session_cost_budget_micro_usd: 20_000_000,
    },
  });
  const sessId = created.session.pipeline_session_id;
  const s1 = await options.client.runPipelineStage1Extract(options.projectId, options.authDev, sessId);
  for (const item of s1.discoveryItems) {
    if (item.confirmation_status === "UNCONFIRMED") {
      await options.client.resolvePipelineStage1Item(
        options.projectId,
        options.authDev,
        sessId,
        item.item_id,
        {
          decision: item.kind === "ASSUMPTION" ? "CONFIRM" : "REJECT",
          resolution_note: item.kind === "ASSUMPTION" ? "Confirmed for v1" : "Out of v1 scope",
        }
      );
    }
  }
  const s2 = await options.client.runPipelineStage2Requirements(
    options.projectId,
    options.authDev,
    sessId
  );
  const s3 = await options.client.runPipelineStage3Architecture(
    options.projectId,
    options.authDev,
    sessId
  );
  const s4 = await options.client.runPipelineStage4ConsistencyCheck(
    options.projectId,
    options.authDev,
    sessId
  );
  assert.equal(s4.report.passed, true);
  const gate = await options.client.submitPipelineApprovalGate(
    options.projectId,
    options.authApprover,
    sessId,
    {
      gate_stage: "STAGE_4_SPEC_FREEZE",
      target_artifact_id: s4.artifact.artifact_id,
      target_artifact_sha256: s4.artifact.artifact_sha256,
      decision: "APPROVED",
      rationale: "Spec baseline ready for Stage 5 bootstrap",
    }
  );
  const baseline = await options.client.freezePipelineBaseline(
    options.projectId,
    options.authApprover,
    sessId,
    { approval_gate_id: gate.gate_id }
  );
  assert.equal(baseline.status, "FROZEN");
  return {
    sessionId: sessId,
    costSessionId: created.costSession!.cost_session_id,
    s1,
    s2,
    s3,
    s4,
    baseline,
  };
}

function buildVerifierCommandsForStage5(useDocker: boolean) {
  const nodeBin = useDocker ? "node" : process.execPath;
  return {
    tier1_command: {
      command: nodeBin,
      args: [
        "-e",
        'import("node:url").then(({ pathToFileURL }) => import("node:path").then(({ join }) => import(pathToFileURL(join(process.env.SF_TRUSTED_ACCEPTANCE_DIR, "acceptance.test.mjs")).href)))',
      ],
    },
    tier2_command: {
      command: nodeBin,
      args: ["tests/protected/baseline-spec.test.mjs"],
    },
  };
}

async function runFullStage8ToCasMerge(options: {
  store: ControlPlaneStore;
  coreClient: HttpCoreApiClient;
  webBaseUrl: string;
  tokenService: EphemeralGitPushTokenService;
  gatewayBaseUrl: string;
  preReceiveUrl: string;
  bareRepoDir: string;
  trustedAcceptanceDir: string;
  expectedTrustedPolicySha256: string;
  worktreeBaseDir: string;
  outboxDir: string;
  useDocker: boolean;
  projectId: string;
  taskId: string;
  authDev: CoreApiAuthContext;
  authApprover: CoreApiAuthContext;
  developerProfile: {
    readonly profile_id: string;
    readonly principal_id: string;
    readonly provider: string;
    readonly model: string;
  };
  reviewerProfile: {
    readonly profile_id: string;
    readonly principal_id: string;
    readonly provider: string;
    readonly model: string;
  };
  edits: readonly { readonly path: string; readonly content: string }[];
  agentTestFile: string;
}) {
  const task = await options.store.withRlsTransaction(
    {
      currentProjectId: options.projectId,
      currentPrincipalId: options.authDev.principalId,
      currentRole: "core_api_service",
    },
    () => options.store.getTaskById(options.taskId)
  );
  assert.ok(task, `Expected task ${options.taskId} to exist`);

  const workerId = `wna-${options.taskId.slice(0, 8)}`;
  const lease = await options.coreClient.dispatchTaskLease(
    options.projectId,
    options.authDev,
    task.task_id,
    { worker_id: workerId }
  );
  const workerToken = options.tokenService.issueLeasePushToken({
    projectId: options.projectId,
    taskId: task.task_id,
    leaseId: lease.lease_id,
    leaseEpoch: lease.lease_epoch,
    workerId,
  });
  const gitPushToken = options.tokenService.issueLeasePushToken({
    projectId: options.projectId,
    taskId: task.task_id,
    leaseId: lease.lease_id,
    leaseEpoch: lease.lease_epoch,
    workerId,
  });
  const daemon = new WnaWorkerDaemon({
    gateway: new HttpAgentGatewayClient({
      baseUrl: options.gatewayBaseUrl,
      bearerToken: workerToken,
    }),
    worktreeBaseDir: options.worktreeBaseDir,
    outboxDir: options.outboxDir,
    sandboxBackend: new LinuxCgroupV2SandboxBackend(),
  });
  const adapter = new WorkspaceCodingAgentAdapter({
    writerProvider: options.developerProfile.provider,
    writerModel: options.developerProfile.model,
    editsResolver: () => [...options.edits],
  });
  const workerRes = await daemon.executeLease({
    task,
    lease,
    repoBarePath: options.bareRepoDir,
    gitPushToken,
    preReceiveUrl: options.preReceiveUrl,
    adapter,
    stagingRefKind: "staging",
    isolateNamespaces: false,
    dropPrivileges: false,
  });
  assert.equal(workerRes.outcome, "COMPLETED");
  assert.ok(workerRes.pushedCommitHash);

  const built = await options.coreClient.buildCandidate(
    options.projectId,
    options.authDev,
    task.task_id,
    {
      lease_id: lease.lease_id,
      lease_epoch: lease.lease_epoch,
      staging_ref: workerRes.stagingRef,
      agent_commit_hash: workerRes.pushedCommitHash,
      repo_path: options.bareRepoDir,
    }
  );
  assert.equal(built.ok, true);
  if (!built.ok) {
    throw new Error("Expected merge candidate build to succeed");
  }

  const cmds = buildVerifierCommandsForStage5(options.useDocker);
  const nodeBin = options.useDocker ? "node" : process.execPath;
  const verified = await options.coreClient.verifyCandidate(
    options.projectId,
    options.authDev,
    task.task_id,
    {
      merge_candidate_id: built.mergeCandidate.merge_candidate_id,
      trusted_acceptance_dir: options.trustedAcceptanceDir,
      expected_trusted_policy_sha256: options.expectedTrustedPolicySha256,
      repo_path: options.bareRepoDir,
      execution_mode: "auto",
      network_disabled: true,
      tier1_command: cmds.tier1_command,
      tier2_command: cmds.tier2_command,
      tier3_command: {
        command: nodeBin,
        args: [options.agentTestFile],
      },
      tier3_test_files: [options.agentTestFile],
    }
  );
  assert.equal(verified.finalRun.verdict, "PASS");
  assert.equal(verified.finalRun.tier1_trusted_acceptance_passed, true);
  assert.equal(verified.finalRun.tier2_protected_baseline_passed, true);
  assert.equal(verified.finalRun.tier3_agent_tests_passed, true);
  assert.equal(verified.finalRun.trusted_policy_sha256, options.expectedTrustedPolicySha256);

  const reviewed = await options.coreClient.runIndependentReview(
    options.projectId,
    options.authDev,
    task.task_id,
    {
      merge_candidate_id: built.mergeCandidate.merge_candidate_id,
      verification_run_id: verified.finalRun.verification_run_id,
      reviewer_principal_id: options.reviewerProfile.principal_id,
      reviewer_agent_profile_id: options.reviewerProfile.profile_id,
      reviewer_provider: options.reviewerProfile.provider,
      reviewer_model: options.reviewerProfile.model,
      developer_principal_id: options.developerProfile.principal_id,
      developer_session_id: `dev-sess-${lease.lease_id}`,
      developer_credential_id: `dev-cred-${lease.lease_id}`,
      developer_agent_profile_id: options.developerProfile.profile_id,
      writer_provider: options.developerProfile.provider,
      writer_model: options.developerProfile.model,
      repo_path: options.bareRepoDir,
      tier3_test_files: [options.agentTestFile],
      probe_read_only_enforcement: true,
    }
  );
  assert.equal(reviewed.reviewArtifact.verdict, "PASS");
  assert.equal(reviewed.taskStatus, "AwaitingHumanApproval");

  const approveResp = await fetch(
    `${options.webBaseUrl}/projects/${encodeURIComponent(options.projectId)}/tasks/${encodeURIComponent(
      task.task_id
    )}/approvals`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(options.authApprover),
      },
      body: JSON.stringify({
        decision: "APPROVED",
        feedback: "Stage 8 approval bound to Stage 5 trusted policy & 3D review.",
        repo_path: options.bareRepoDir,
      }),
    }
  );
  assert.equal(approveResp.status, 201);
  const approval = (await approveResp.json()) as { approval_id: string; status: string };

  const casMerge = await options.coreClient.executeCasMerge(
    options.projectId,
    options.authApprover,
    task.task_id,
    {
      merge_candidate_id: built.mergeCandidate.merge_candidate_id,
      approval_id: approval.approval_id,
      repo_path: options.bareRepoDir,
      require_real_git: true,
    }
  );
  assert.equal(casMerge.status, "MERGED_BY_CAS");
  assert.equal(casMerge.task_status, "MergedAndCompleted");

  return {
    task,
    lease,
    workerRes,
    mergeCandidate: built.mergeCandidate,
    verificationRun: verified.finalRun,
    reviewArtifact: reviewed.reviewArtifact,
    approvalId: approval.approval_id,
    mergedCommitHash: gitAt(options.bareRepoDir, ["rev-parse", "refs/heads/main"]).toLowerCase(),
  };
}

describe("M6B Acceptance Gates (Stages 5–9, Multi-Target Execution Profiles, Post-Freeze CR & AC-11b)", () => {
  it("M6B-AC1: Stage 5 Project Bootstrapper & external immutable TrustedAcceptanceTests (fail before impl -> pass after impl -> tamper detection)", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    const coreApi = new CoreApiService(store, {
      env: {},
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({ coreApi });
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-ac1-"));
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    try {
      const { baseUrl } = await coreHttp.start();
      const client = new HttpCoreApiClient(baseUrl);
      const repoBarePath = join(rootDir, "target-app.git");
      const trustedDir = join(rootDir, "external-trusted-acceptance");

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6b-ac1-${randomUUID().slice(0, 8)}`,
            name: "M6B AC1 Project",
            repo_bare_path: repoBarePath,
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

      // Active (non-frozen) session MUST fail Stage 5 bootstrap (422)
      const activeSess = await client.createPipelineSession(proj.project_id, authDev, {
        title: "Not Frozen Yet",
        raw_idea_text: "Active session probe",
        cost_budget: {
          max_tokens_per_request: 8000,
          max_cost_micro_usd_per_request: 1_000_000,
          session_token_budget: 40_000,
          session_cost_budget_micro_usd: 5_000_000,
        },
      });
      await assert.rejects(
        () =>
          client.bootstrapPipelineProject(
            proj.project_id,
            authDev,
            activeSess.session.pipeline_session_id
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const frozen = await advanceToFrozenBaseline({
        client,
        projectId: proj.project_id,
        authDev,
        authApprover,
        title: "AC1 Bootstrap Target",
      });

      // Nested trusted_acceptance_dir inside repo_path MUST fail closed (422)
      await assert.rejects(
        () =>
          client.bootstrapPipelineProject(proj.project_id, authDev, frozen.sessionId, {
            repo_path: repoBarePath,
            trusted_acceptance_dir: join(repoBarePath, "nested-tests"),
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Valid Stage 5 bootstrap with custom acceptance_specs & scaffold_files
      const s2Parsed = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...s2Parsed.srs.functional_requirements,
        ...s2Parsed.srs.non_functional_requirements,
      ];
      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const req of s2Reqs) {
        for (const ac of req.acceptance_criteria) {
          acceptanceSpecs[ac.ac_id] = {
            target_file: "src/ledger.mjs",
            export_name: "createLedgerEntry",
            assertion_lines: [
              'const entry = mod.createLedgerEntry(2500, "USD");',
              "assert.equal(entry.amountCents, 2500);",
              'assert.equal(entry.currency, "USD");',
              `assert.equal(Array.isArray(mod.implementedAcIds) && mod.implementedAcIds.includes(${JSON.stringify(ac.ac_id)}), true);`,
            ],
          };
        }
      }

      await assert.rejects(
        () =>
          client.bootstrapPipelineProject(
            proj.project_id,
            authDev,
            frozen.sessionId,
            {
              repo_path: repoBarePath,
              trusted_acceptance_dir: trustedDir,
              extra_protected_paths: ["config/locked.json"],
              scaffold_files: { "src/.gitkeep": "" },
              acceptance_specs: acceptanceSpecs,
            }
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      // M6C-1 / 038d19a: simultaneous bootstrap attempts must reserve the trusted
      // directory atomically; the loser must not remove the winner's policy or Git ref.
      const bootstrapAttempts = await Promise.allSettled(Array.from({ length: 2 }, () =>
        client.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
          repo_path: repoBarePath,
          trusted_acceptance_dir: trustedDir,
          extra_protected_paths: ["config/locked.json"],
          scaffold_files: { "src/.gitkeep": "" },
          acceptance_specs: acceptanceSpecs,
        })
      ));
      assert.equal(bootstrapAttempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
      const winningBootstrap = bootstrapAttempts.find((attempt) => attempt.status === "fulfilled");
      const losingBootstrap = bootstrapAttempts.find((attempt) => attempt.status === "rejected");
      assert.ok(winningBootstrap?.status === "fulfilled");
      assert.ok(losingBootstrap?.status === "rejected");
      assert.ok(losingBootstrap.reason instanceof HttpCoreApiError && losingBootstrap.reason.statusCode === 409);
      const bootOutcome = winningBootstrap.value;

      const boot = bootOutcome.bootstrap;
      assert.equal(boot.baseline_id, frozen.baseline.baseline_id);
      assert.match(boot.base_main_commit_hash, /^[0-9a-f]{40}$/);
      assert.equal(
        gitAt(repoBarePath, ["rev-parse", "refs/heads/main"]).toLowerCase(),
        boot.base_main_commit_hash
      );
      assert.equal(existsSync(join(trustedDir, "acceptance.test.mjs")), true);
      assert.equal(existsSync(join(trustedDir, "trusted-manifest.json")), true);
      assert.equal(computeDirectorySha256(trustedDir), boot.trusted_policy_sha256);
      assert.ok(boot.protected_paths.includes("policy/trusted-verification-policy.json"));
      assert.ok(boot.protected_paths.includes("tests/protected/**"));
      assert.ok(boot.protected_paths.includes("config/locked.json"));

      // Duplicate bootstrap on same session MUST be rejected (409)
      await assert.rejects(
        () => client.bootstrapPipelineProject(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 409
      );

      // Verifier fail-before-impl -> pass-after-impl -> tamper detection
      const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
      const verifier = new Docker3TierVerifier({ snapshotStore });
      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;
      const cmds = buildVerifierCommandsForStage5(useDocker);

      // (a) Before implementation (agent pushes a placeholder without src/ledger.mjs) -> Tier 1 MUST FAIL
      const workNoImpl = join(rootDir, "work-no-impl");
      gitAt(rootDir, ["clone", repoBarePath, workNoImpl]);
      writeFileSync(join(workNoImpl, "src", "placeholder.mjs"), "export const ready = false;\n", "utf8");
      gitAt(workNoImpl, ["add", "src/placeholder.mjs"]);
      gitAt(workNoImpl, ["commit", "-m", "chore: placeholder without ledger"]);
      const noImplCommit = gitAt(workNoImpl, ["rev-parse", "HEAD"]);
      gitAt(repoBarePath, ["fetch", workNoImpl, "HEAD:refs/factory/Verify/preimpl/1"]);

      const taskBeforeId = randomUUID();
      const candBefore = await buildRealGitMergeCandidate({
        repoPath: repoBarePath,
        taskId: taskBeforeId,
        expectedBaseMainCommitHash: boot.base_main_commit_hash,
        agentCommitHash: noImplCommit,
        candidateRef: "refs/factory/Verify/preimpl/1",
        snapshotStore,
      });
      assert.equal(candBefore.ok, true);
      if (!candBefore.ok) throw new Error("Expected clean candidate before impl");

      const resBefore = await verifier.verifyCandidateWithRetries({
        projectId: proj.project_id,
        taskId: taskBeforeId,
        mergeCandidateId: randomUUID(),
        mergeCandidateHash: candBefore.mergeCandidateHash,
        verifiedTreeHash: candBefore.verifiedTreeHash,
        baseMainCommitHash: boot.base_main_commit_hash,
        taskContract: {
          allowed_files: ["src/**", "test/**"],
          protected_paths: [...boot.protected_paths],
          trusted_policy_sha256: boot.trusted_policy_sha256,
        },
        snapshotPath: candBefore.snapshotPath!,
        snapshotSha256: candBefore.snapshotSha256!,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: boot.trusted_policy_sha256,
        repoPath: repoBarePath,
        executionMode: useDocker ? "docker" : "subprocess",
        requireDocker: useDocker,
        tier1Command: cmds.tier1_command,
        tier2Command: cmds.tier2_command,
      });
      assert.equal(resBefore.finalResult.verdict, "FAIL");
      assert.equal(resBefore.finalResult.tier1TrustedAcceptancePassed, false);

      // (b) With genuine implementation -> PASS all 3 tiers + matching trusted_policy_sha256
      const workImpl = join(rootDir, "work-with-impl");
      gitAt(rootDir, ["clone", repoBarePath, workImpl]);
      const acList = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      writeFileSync(
        join(workImpl, "src", "ledger.mjs"),
        [
          `export const implementedAcIds = ${JSON.stringify(acList)};`,
          "export function createLedgerEntry(amountCents, currency = 'USD') {",
          "  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('invalid');",
          "  return { amountCents, currency };",
          "}",
          "",
        ].join("\n"),
        "utf8"
      );
      mkdirSync(join(workImpl, "test"), { recursive: true });
      writeFileSync(
        join(workImpl, "test", "ledger.agent.test.mjs"),
        'import assert from "node:assert/strict"; import { createLedgerEntry } from "../src/ledger.mjs"; assert.equal(createLedgerEntry(100, "USD").amountCents, 100);\n',
        "utf8"
      );
      gitAt(workImpl, ["add", "src/ledger.mjs", "test/ledger.agent.test.mjs"]);
      gitAt(workImpl, ["commit", "-m", "feat: implement ledger core"]);
      const implCommit = gitAt(workImpl, ["rev-parse", "HEAD"]);
      gitAt(repoBarePath, ["fetch", workImpl, "HEAD:refs/factory/Verify/impl/1"]);

      const taskAfterId = randomUUID();
      const candAfterId = randomUUID();
      const candAfter = await buildRealGitMergeCandidate({
        repoPath: repoBarePath,
        taskId: taskAfterId,
        expectedBaseMainCommitHash: boot.base_main_commit_hash,
        agentCommitHash: implCommit,
        candidateRef: "refs/factory/Verify/impl/1",
        snapshotStore,
      });
      assert.equal(candAfter.ok, true);
      if (!candAfter.ok) throw new Error("Expected clean candidate after impl");

      const nodeBin = useDocker ? "node" : process.execPath;
      const resAfter = await verifier.verifyCandidateWithRetries({
        projectId: proj.project_id,
        taskId: taskAfterId,
        mergeCandidateId: candAfterId,
        mergeCandidateHash: candAfter.mergeCandidateHash,
        verifiedTreeHash: candAfter.verifiedTreeHash,
        baseMainCommitHash: boot.base_main_commit_hash,
        taskContract: {
          allowed_files: ["src/**", "test/**"],
          protected_paths: [...boot.protected_paths],
          trusted_policy_sha256: boot.trusted_policy_sha256,
        },
        snapshotPath: candAfter.snapshotPath!,
        snapshotSha256: candAfter.snapshotSha256!,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: boot.trusted_policy_sha256,
        repoPath: repoBarePath,
        executionMode: useDocker ? "docker" : "subprocess",
        requireDocker: useDocker,
        tier1Command: cmds.tier1_command,
        tier2Command: cmds.tier2_command,
        tier3Command: { command: nodeBin, args: ["test/ledger.agent.test.mjs"] },
        tier3TestFiles: ["test/ledger.agent.test.mjs"],
      });
      assert.equal(resAfter.finalResult.verdict, "PASS");
      assert.equal(resAfter.finalResult.trustedPolicySha256, boot.trusted_policy_sha256);

      // (c) Protected baseline tamper attempt inside candidate -> TEST_TAMPERING_DETECTED
      const workTamperProtected = join(rootDir, "work-tamper-protected");
      gitAt(rootDir, ["clone", repoBarePath, workTamperProtected]);
      writeFileSync(
        join(workTamperProtected, "tests", "protected", "baseline-spec.test.mjs"),
        "// bypassed\n",
        "utf8"
      );
      gitAt(workTamperProtected, ["add", "tests/protected/baseline-spec.test.mjs"]);
      gitAt(workTamperProtected, ["commit", "-m", "tamper protected test"]);
      const tamperProtCommit = gitAt(workTamperProtected, ["rev-parse", "HEAD"]);
      gitAt(repoBarePath, ["fetch", workTamperProtected, "HEAD:refs/factory/Verify/tamper/1"]);

      const taskTamperId = randomUUID();
      const candTamperProt = await buildRealGitMergeCandidate({
        repoPath: repoBarePath,
        taskId: taskTamperId,
        expectedBaseMainCommitHash: boot.base_main_commit_hash,
        agentCommitHash: tamperProtCommit,
        candidateRef: "refs/factory/Verify/tamper/1",
        snapshotStore,
      });
      assert.equal(candTamperProt.ok, true);
      if (!candTamperProt.ok) throw new Error("Expected snapshot build for tamper probe");

      const resTamperProt = await verifier.verifyCandidateWithRetries({
        projectId: proj.project_id,
        taskId: taskTamperId,
        mergeCandidateId: randomUUID(),
        mergeCandidateHash: candTamperProt.mergeCandidateHash,
        verifiedTreeHash: candTamperProt.verifiedTreeHash,
        baseMainCommitHash: boot.base_main_commit_hash,
        taskContract: {
          allowed_files: ["src/**", "test/**"],
          protected_paths: [...boot.protected_paths],
          trusted_policy_sha256: boot.trusted_policy_sha256,
        },
        snapshotPath: candTamperProt.snapshotPath!,
        snapshotSha256: candTamperProt.snapshotSha256!,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: boot.trusted_policy_sha256,
        repoPath: repoBarePath,
        executionMode: useDocker ? "docker" : "subprocess",
        requireDocker: useDocker,
        tier1Command: cmds.tier1_command,
        tier2Command: cmds.tier2_command,
      });
      assert.equal(resTamperProt.finalResult.overallStatus, "TEST_TAMPERING_DETECTED");
      assert.equal(resTamperProt.finalResult.tier2BaselineTamperDetected, true);

      // (d) Tampered external trusted_acceptance_dir file -> SHA-256 mismatch TEST_TAMPERING_DETECTED
      writeFileSync(join(trustedDir, "acceptance.test.mjs"), "// modified externally\n", "utf8");
      const resTamperExt = await verifier.verifyCandidateWithRetries({
        projectId: proj.project_id,
        taskId: taskAfterId,
        mergeCandidateId: candAfterId,
        mergeCandidateHash: candAfter.mergeCandidateHash,
        verifiedTreeHash: candAfter.verifiedTreeHash,
        baseMainCommitHash: boot.base_main_commit_hash,
        taskContract: {
          allowed_files: ["src/**", "test/**"],
          protected_paths: [...boot.protected_paths],
          trusted_policy_sha256: boot.trusted_policy_sha256,
        },
        snapshotPath: candAfter.snapshotPath!,
        snapshotSha256: candAfter.snapshotSha256!,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: boot.trusted_policy_sha256,
        repoPath: repoBarePath,
        executionMode: useDocker ? "docker" : "subprocess",
        requireDocker: useDocker,
        tier1Command: cmds.tier1_command,
      });
      assert.equal(resTamperExt.finalResult.verdict, "FAIL");
      assert.equal(resTamperExt.finalResult.overallStatus, "FAILED_ACCEPTANCE");
      assert.equal(resTamperExt.finalResult.trustedPolicyMatched, false);
      assert.match(resTamperExt.finalResult.errorMessage ?? "", /ERR_TRUSTED_POLICY_SHA256_MISMATCH/);
    } finally {
      await Promise.allSettled([coreHttp.stop(), mock.close()]);
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC2: Stage 6 Agent Organization & Multi-Target Execution Profiles (4 roles x 4 target types x 4 trust tiers + 3D separation)", async () => {
    const store = new SoftwareFactoryControlPlaneStore();
    const coreApi = new CoreApiService(store, { env: {} });
    const coreHttp = new CoreApiHttpServer({ coreApi });
    try {
      const { baseUrl } = await coreHttp.start();
      const client = new HttpCoreApiClient(baseUrl);
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6b-ac2-${randomUUID().slice(0, 8)}`,
            name: "M6B AC2 Profiles",
            repo_bare_path: "/tmp/m6b-ac2.git",
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          return p;
        }
      );
      const authDev = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });

      const matrix: Array<{
        key: string;
        role: AgentOrgRole;
        principal: string;
        provider: string;
        model: string;
        targetType: ExecutionTargetType;
        tier: TargetTrustTier;
        locator: string | null;
      }> = [
        {
          key: "planner-managed",
          role: "PLANNER",
          principal: "planner-agent-1",
          provider: "openai",
          model: "gpt-4.1",
          targetType: "factory_managed_worker",
          tier: "TIER_1_FACTORY_MANAGED",
          locator: "wna-pool://default",
        },
        {
          key: "dev-user-worker",
          role: "DEVELOPER",
          principal: "dev-agent-1",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          targetType: "user_managed_worker",
          tier: "TIER_2_USER_MANAGED",
          locator: "ssh://runner-02.internal/repo",
        },
        {
          key: "rev-provider-vm",
          role: "REVIEWER_READONLY",
          principal: "rev-agent-1",
          provider: "google",
          model: "gemini-2.5-pro",
          targetType: "provider_managed_vm",
          tier: "TIER_3_PROVIDER_VM",
          locator: "vm://provider-readonly-sandbox",
        },
        {
          key: "ver-remote-session",
          role: "VERIFIER",
          principal: "verifier-agent-1",
          provider: "openai",
          model: "o3-verifier",
          targetType: "remote_agent_session",
          tier: "TIER_4_REMOTE_SESSION",
          locator: "wss://remote-verifier.internal/session",
        },
      ];

      const createdByKey = new Map<string, string>();
      for (const item of matrix) {
        const saved = await client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
          profile_key: item.key,
          role: item.role,
          principal_id: item.principal,
          provider: item.provider,
          model: item.model,
          execution_target_type: item.targetType,
          trust_tier: item.tier,
          target_locator: item.locator,
          capabilities_json: { sandbox: true, tier: item.tier },
        });
        assert.equal(saved.role, item.role);
        assert.equal(saved.execution_target_type, item.targetType);
        assert.equal(saved.trust_tier, item.tier);
        createdByKey.set(item.key, saved.profile_id);
      }

      const listed = await client.listAgentOrganizationProfiles(proj.project_id, authDev);
      assert.equal(listed.length, 4);
      const revOnly = await client.listAgentOrganizationProfiles(proj.project_id, authDev, {
        role: "REVIEWER_READONLY",
      });
      assert.equal(revOnly.length, 1);

      // Mismatched execution_target_type vs trust_tier rejected (422)
      await assert.rejects(
        () =>
          client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
            profile_key: "bad-tier-mismatch",
            role: "DEVELOPER",
            principal_id: "dev-x",
            provider: "anthropic",
            model: "claude-sonnet-4",
            execution_target_type: "factory_managed_worker",
            trust_tier: "TIER_4_REMOTE_SESSION",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Blank principal_id rejected (422)
      await assert.rejects(
        () =>
          client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
            profile_key: "bad-blank-principal",
            role: "DEVELOPER",
            principal_id: "   ",
            provider: "anthropic",
            model: "claude-sonnet-4",
            execution_target_type: "factory_managed_worker",
            trust_tier: "TIER_1_FACTORY_MANAGED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const devId = createdByKey.get("dev-user-worker")!;
      const revId = createdByKey.get("rev-provider-vm")!;

      // Valid independent 3D pair -> PASS
      const validPair = await client.validateStage6ReviewerPair(proj.project_id, authDev, {
        developer_profile_id: devId,
        reviewer_profile_id: revId,
      });
      assert.equal(validPair.valid, true);

      // 3D Violation A: same principal_id (case-insensitive)
      const revSamePrincipal = await client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "rev-same-principal",
        role: "REVIEWER_READONLY",
        principal_id: "DEV-AGENT-1",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      await assert.rejects(
        () =>
          client.validateStage6ReviewerPair(proj.project_id, authDev, {
            developer_profile_id: devId,
            reviewer_profile_id: revSamePrincipal.profile_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // 3D Violation B: same (provider, model) case-insensitive
      const revSameModel = await client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "rev-same-model",
        role: "REVIEWER_READONLY",
        principal_id: "rev-distinct-principal",
        provider: "Anthropic",
        model: "CLAUDE-SONNET-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      await assert.rejects(
        () =>
          client.validateStage6ReviewerPair(proj.project_id, authDev, {
            developer_profile_id: devId,
            reviewer_profile_id: revSameModel.profile_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Role / inactive violations -> 422
      await assert.rejects(
        () =>
          client.validateStage6ReviewerPair(proj.project_id, authDev, {
            developer_profile_id: devId,
            reviewer_profile_id: createdByKey.get("planner-managed")!,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "rev-provider-vm",
        role: "REVIEWER_READONLY",
        principal_id: "rev-agent-1",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "provider_managed_vm",
        trust_tier: "TIER_3_PROVIDER_VM",
        is_active: false,
      });
      await assert.rejects(
        () =>
          client.validateStage6ReviewerPair(proj.project_id, authDev, {
            developer_profile_id: devId,
            reviewer_profile_id: revId,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
    } finally {
      await coreHttp.stop();
    }
  });

  it("M6B-AC3: Stage 7 LLM Development Planning (AC-12b billing, 100% req/AC coverage, protected_paths overlap & cyclic DAG blocking, duplicate Stage 7 block)", async () => {
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    const coreApi = new CoreApiService(store, {
      env: {},
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({ coreApi });
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-ac3-"));
    try {
      const { baseUrl } = await coreHttp.start();
      const client = new HttpCoreApiClient(baseUrl);
      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6b-ac3-${randomUUID().slice(0, 8)}`,
            name: "M6B AC3 Stage7",
            repo_bare_path: join(rootDir, "repo.git"),
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

      const devProf = await client.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "dev-stage7-default",
        role: "DEVELOPER",
        principal_id: "dev-worker-1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });

      const frozen = await advanceToFrozenBaseline({
        client,
        projectId: proj.project_id,
        authDev,
        authApprover,
        title: "AC3 Planning Pipeline",
      });

      // Calling Stage 7 BEFORE Stage 5 Bootstrap MUST fail (422)
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const boot = await client.bootstrapPipelineProject(proj.project_id, authDev, frozen.sessionId, {
        repo_path: join(rootDir, "repo.git"),
        trusted_acceptance_dir: join(rootDir, "trusted"),
      });

      const s2Parsed = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...s2Parsed.srs.functional_requirements,
        ...s2Parsed.srs.non_functional_requirements,
      ];
      const reqIds = s2Reqs.map((r) => r.req_id);
      const acIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));

      // AC-12b Cost Guard Preflight Block -> 402 ERR_COST_LIMIT_EXCEEDED + BLOCKED_PREFLIGHT ledger row
      const tightCost = await client.createCostSession(proj.project_id, authDev, {
        pipeline_session_id: frozen.sessionId,
        max_tokens_per_request: 10,
        max_cost_micro_usd_per_request: 100,
        session_token_budget: 20,
        session_cost_budget_micro_usd: 100,
      });
      await assert.rejects(
        () =>
          client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId, {
            cost_session_id: tightCost.cost_session_id,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 402
      );
      const blockedCostView = await client.getCostSession(
        proj.project_id,
        authDev,
        tightCost.cost_session_id
      );
      assert.equal(blockedCostView.ledgers.length, 1);
      assert.equal(blockedCostView.ledgers[0]!.stage, "STAGE_7_PLANNING");
      assert.equal(blockedCostView.ledgers[0]!.status, "BLOCKED_PREFLIGHT");

      // Negative 1: Incomplete coverage (< 100% reqs) -> 422
      mock.setStage7Override({
        milestones: [{ milestone_key: "MS-1", title: "M1", description: "D1" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E1", description: "D1" }],
        stories: [
          {
            story_key: "ST-1",
            epic_key: "EP-1",
            title: "S1",
            description: "Partial reqs",
            requirement_ids: [reqIds[0]!],
            ac_ids: [acIds[0]!],
          },
        ],
        tasks: [
          {
            task_key: "T-1",
            story_key: "ST-1",
            title: "Task 1",
            description: "Partial task",
            requirement_ids: [reqIds[0]!],
            ac_ids: [acIds[0]!],
            allowed_files: ["src/**"],
            depends_on_task_keys: [],
          },
        ],
        planning_notes: "Incomplete coverage test",
      });
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Negative 2: protected_paths / forbidden path overlap -> 422
      mock.setStage7Override({
        milestones: [{ milestone_key: "MS-1", title: "M1", description: "D1" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E1", description: "D1" }],
        stories: [
          {
            story_key: "ST-1",
            epic_key: "EP-1",
            title: "S1",
            description: "All",
            requirement_ids: reqIds,
            ac_ids: acIds,
          },
        ],
        tasks: [
          {
            task_key: "T-BAD-PATH",
            story_key: "ST-1",
            title: "Touches protected path",
            description: "Illegal write",
            requirement_ids: reqIds,
            ac_ids: acIds,
            allowed_files: ["tests/protected/**", "src/**"],
            depends_on_task_keys: [],
          },
        ],
        planning_notes: "Protected overlap test",
      });
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Negative 3: Cyclic DAG (T-A <-> T-B) -> 422
      mock.setStage7Override({
        milestones: [{ milestone_key: "MS-1", title: "M1", description: "D1" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E1", description: "D1" }],
        stories: [
          {
            story_key: "ST-1",
            epic_key: "EP-1",
            title: "S1",
            description: "All",
            requirement_ids: reqIds,
            ac_ids: acIds,
          },
        ],
        tasks: [
          {
            task_key: "T-A",
            story_key: "ST-1",
            title: "Task A",
            description: "A",
            requirement_ids: [reqIds[0]!],
            ac_ids: [acIds[0]!],
            allowed_files: ["src/a.mjs"],
            depends_on_task_keys: ["T-B"],
          },
          {
            task_key: "T-B",
            story_key: "ST-1",
            title: "Task B",
            description: "B",
            requirement_ids: reqIds,
            ac_ids: acIds,
            allowed_files: ["src/b.mjs"],
            depends_on_task_keys: ["T-A"],
          },
        ],
        planning_notes: "Cyclic DAG test",
      });
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Negative 4: Unknown developer_profile_key -> 422
      mock.setStage7Override({
        milestones: [{ milestone_key: "MS-1", title: "M1", description: "D1" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E1", description: "D1" }],
        stories: [
          {
            story_key: "ST-1",
            epic_key: "EP-1",
            title: "S1",
            description: "All",
            requirement_ids: reqIds,
            ac_ids: acIds,
          },
        ],
        tasks: [
          {
            task_key: "T-UNKNOWN-PROF",
            story_key: "ST-1",
            title: "Unknown profile",
            description: "D",
            requirement_ids: reqIds,
            ac_ids: acIds,
            allowed_files: ["src/**"],
            depends_on_task_keys: [],
            developer_profile_key: "non-existent-profile-key",
          },
        ],
        planning_notes: "Unknown profile test",
      });
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Positive: Multi-task acyclic DAG covering 100% reqs/ACs + Stage 6 profile binding
      mock.setStage7Override({
        milestones: [{ milestone_key: "MS-1", title: "Milestone 1", description: "Core build" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "Epic 1", description: "Core" }],
        stories: [
          {
            story_key: "ST-1",
            epic_key: "EP-1",
            title: "Story 1",
            description: "Full baseline coverage",
            requirement_ids: reqIds,
            ac_ids: acIds,
          },
        ],
        tasks: [
          {
            task_key: "T-CORE",
            story_key: "ST-1",
            title: "Core Foundation",
            description: "Implements core functional requirement",
            requirement_ids: [reqIds[0]!],
            ac_ids: [acIds[0]!],
            allowed_files: ["src/core/**"],
            depends_on_task_keys: [],
            developer_profile_key: "dev-stage7-default",
          },
          {
            task_key: "T-AUDIT",
            story_key: "ST-1",
            title: "Audit Hash Integration",
            description: "Completes remaining reqs/ACs",
            requirement_ids: reqIds.slice(1),
            ac_ids: acIds.slice(1),
            allowed_files: ["src/audit/**", "test/**"],
            depends_on_task_keys: ["T-CORE"],
            developer_profile_key: "dev-stage7-default",
          },
        ],
        planning_notes: "Clean 2-task acyclic DAG",
      });

      const s7 = await client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId);
      assert.equal(s7.ledger.stage, "STAGE_7_PLANNING");
      assert.equal(s7.ledger.status, "ALLOWED");
      assert.equal(s7.bundle.milestones.length, 1);
      assert.equal(s7.bundle.epics.length, 1);
      assert.equal(s7.bundle.stories.length, 1);
      assert.equal(s7.bundle.tasks.length, 2);
      assert.equal(s7.bundle.taskLinks.length, 2);
      for (const task of s7.bundle.tasks) {
        assert.equal(task.status, "Ready");
        assert.equal(task.base_main_commit_hash, boot.bootstrap.base_main_commit_hash);
        const tc = task.task_contract_json as {
          trusted_policy_sha256?: string;
          protected_paths?: string[];
        };
        assert.equal(tc.trusted_policy_sha256, boot.bootstrap.trusted_policy_sha256);
        assert.ok(tc.protected_paths?.includes("tests/protected/**"));
      }
      assert.equal(s7.bundle.taskLinks[0]!.assigned_profile_id, devProf.profile_id);

      // Duplicate Stage 7 plan call on same frozen baseline MUST fail (422) -> forces Stage 9 CR
      mock.setStage7Override(null);
      await assert.rejects(
        () => client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
    } finally {
      await Promise.allSettled([coreHttp.stop(), mock.close()]);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC4: True End-to-End Stages 1 -> 9 Acceptance Gate (Stage 1..4 -> Stage 5 Bootstrap -> Stage 6 Profiles -> Stage 7 Plan -> Stage 8 WNA/pre-receive/3-Tier/3D/Web/CAS [C1] -> Stage 9 CR -> Stage 8 [C2] -> AC-11b 100% -> ReleaseAcceptancePackage)", async () => {
    const mock = await startMockModelProviderServers();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-e2e-"));
    const bareRepoDir = join(rootDir, "app.git");
    const trustedAcceptanceDir = join(rootDir, "trusted-acceptance");
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const store = new SoftwareFactoryControlPlaneStore();
    const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
    const verifier = new Docker3TierVerifier({ snapshotStore });
    const tokenService = new EphemeralGitPushTokenService();
    const reviewerCredService = new EphemeralReviewerCredentialService();

    let projectId = "";
    await store.withRlsTransaction(
      { currentRole: "system_admin_role", currentPrincipalId: "bootstrap-admin" },
      () => {
        const p = store.createProject({
          slug: `m6b-e2e-${randomUUID().slice(0, 8)}`,
          name: "M6B Full Lifecycle Project",
          repo_bare_path: bareRepoDir,
          initial_main_commit_hash: "1".repeat(40),
          initial_main_tree_hash: "2".repeat(40),
        });
        projectId = p.project_id;
        store.addProjectMembership({
          project_id: projectId,
          principal_id: "alice-dev",
          member_role: "DEVELOPER",
        });
        store.addProjectMembership({
          project_id: projectId,
          principal_id: "bob-approver",
          member_role: "PROJECT_APPROVER",
        });
      }
    );

    const gatewayService = new AgentGatewayService({
      store,
      projectId,
      reviewerCredentialService: reviewerCredService,
    });
    const gatewayHttp = new AgentGatewayHttpServer({ store, tokenService });
    const coreApi = new CoreApiService(store, {
      env: {},
      snapshotStore,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({
      coreApi,
      snapshotStore,
      defaultVerifier: verifier,
      defaultAgentGateway: gatewayService,
    });
    const webHttp = new WebApprovalConsoleHttpServer({ coreApi });

    try {
      const gwInfo = await gatewayHttp.start();
      const coreInfo = await coreHttp.start();
      const webInfo = await webHttp.start();
      const coreClient = new HttpCoreApiClient(coreInfo.baseUrl);

      const authDev = coreApi.issueAuthContext({
        projectId,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;

      // Stages 1 -> 4
      const frozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId,
        authDev,
        authApprover,
        title: "Full E2E Ledger Product",
      });

      // Stage 5 Project Bootstrap
      const s2Parsed = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...s2Parsed.srs.functional_requirements,
        ...s2Parsed.srs.non_functional_requirements,
      ];
      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const req of s2Reqs) {
        for (const ac of req.acceptance_criteria) {
          acceptanceSpecs[ac.ac_id] = {
            target_file: "src/ledger.mjs",
            export_name: "createLedgerEntry",
            assertion_lines: [
              'const entry = mod.createLedgerEntry(5000, "USD");',
              "assert.equal(entry.amountCents, 5000);",
              'assert.equal(entry.currency, "USD");',
              "assert.match(entry.entrySha256, /^[0-9a-f]{64}$/);",
              `assert.equal(mod.implementedAcIds.includes(${JSON.stringify(ac.ac_id)}), true);`,
            ],
          };
        }
      }

      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(
            projectId,
            authDev,
            frozen.sessionId,
            {
              repo_path: bareRepoDir,
              trusted_acceptance_dir: trustedAcceptanceDir,
              acceptance_specs: acceptanceSpecs,
            }
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      const bootOutcome = await coreClient.bootstrapPipelineProject(
        projectId,
        authApprover,
        frozen.sessionId,
        {
          repo_path: bareRepoDir,
          trusted_acceptance_dir: trustedAcceptanceDir,
          acceptance_specs: acceptanceSpecs,
        }
      );

      // Install real fail-closed pre-receive hook on bootstrapped bare repo
      const hooksDir = join(bareRepoDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookDest = join(hooksDir, "pre-receive");
      copyFileSync(findPreReceiveHookSource(), hookDest);
      chmodSync(hookDest, 0o755);

      // Stage 6 Multi-Target Execution & 3D Separation
      const devProfile = await coreClient.upsertAgentOrganizationProfile(projectId, authDev, {
        profile_key: "e2e-dev-worker",
        role: "DEVELOPER",
        principal_id: "coder-agent-claude",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      const revProfile = await coreClient.upsertAgentOrganizationProfile(projectId, authDev, {
        profile_key: "e2e-rev-sandbox",
        role: "REVIEWER_READONLY",
        principal_id: "reviewer-agent-gemini",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "provider_managed_vm",
        trust_tier: "TIER_3_PROVIDER_VM",
      });
      const plannerProfile = await coreClient.upsertAgentOrganizationProfile(projectId, authDev, {
        profile_key: "e2e-planner",
        role: "PLANNER",
        principal_id: "planner-agent-openai",
        provider: "openai",
        model: "gpt-4.1",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      const verifierProfile = await coreClient.upsertAgentOrganizationProfile(projectId, authDev, {
        profile_key: "e2e-verifier",
        role: "VERIFIER",
        principal_id: "verifier-agent-docker",
        provider: "system",
        model: "docker-3tier-verifier",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      assert.ok(plannerProfile.profile_id && verifierProfile.profile_id);
      const pairCheck = await coreClient.validateStage6ReviewerPair(projectId, authDev, {
        developer_profile_id: devProfile.profile_id,
        reviewer_profile_id: revProfile.profile_id,
      });
      assert.equal(pairCheck.valid, true);

      // Stage 7 Planning -> Stage 8 Task 1 (`TASK-IMPL`)
      const planOut = await coreClient.runPipelineStage7Plan(projectId, authDev, frozen.sessionId);
      assert.equal(planOut.bundle.tasks.length, 1);
      const task1 = planOut.bundle.tasks[0]!;
      const allReqIds = s2Reqs.map((r) => r.req_id);
      const allAcIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));

      const ledgerImplSource = [
        'import { createHash } from "node:crypto";',
        `export const implementedAcIds = ${JSON.stringify(allAcIds)};`,
        `export const implementedRequirements = ${JSON.stringify(allReqIds)};`,
        "export function createLedgerEntry(amountCents, currency = 'USD') {",
        "  if (!Number.isInteger(amountCents) || amountCents < 0) {",
        "    throw new Error('amountCents must be a non-negative integer');",
        "  }",
        "  const entrySha256 = createHash('sha256').update(`${amountCents}:${currency}`, 'utf8').digest('hex');",
        "  return { amountCents, currency, entrySha256 };",
        "}",
        "",
      ].join("\n");

      const agentTest1Source = [
        'import assert from "node:assert/strict";',
        'import { createLedgerEntry } from "../src/ledger.mjs";',
        'const entry = createLedgerEntry(1234, "USD");',
        "assert.equal(entry.amountCents, 1234);",
        "assert.match(entry.entrySha256, /^[0-9a-f]{64}$/);",
        "",
      ].join("\n");

      const stage8Task1 = await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId,
        taskId: task1.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/ledger.mjs", content: ledgerImplSource },
          { path: "test/ledger.agent.test.mjs", content: agentTest1Source },
        ],
        agentTestFile: "test/ledger.agent.test.mjs",
      });

      const commitC1 = stage8Task1.mergedCommitHash;
      assert.notEqual(commitC1, bootOutcome.bootstrap.base_main_commit_hash);

      // Verify pre-CR 100% traceability
      const preCrMatrix = await coreClient.getPipelineTraceabilityMatrix(
        projectId,
        authDev,
        frozen.sessionId
      );
      assert.equal(preCrMatrix.complete, true);
      assert.equal(preCrMatrix.coverage_percent, 100);
      assert.equal(preCrMatrix.covered_requirements, preCrMatrix.total_requirements);

      // Stage 9 Post-Freeze Change Request `CR-001`
      const cr1 = await coreClient.submitPipelineChangeRequest(
        projectId,
        authDev,
        frozen.sessionId,
        {
          cr_key: "CR-001",
          title: "Add batch ledger total formatter helper",
          rationale: "Audit stakeholders require deterministic batch sum formatting on top of C1.",
          impacted_requirement_ids: [allReqIds[0]!],
          impacted_component_ids: ["COMP-LEDGER-CORE"],
          proposed_tasks: [
            {
              task_key: "TASK-CR-001",
              story_id: planOut.bundle.stories[0]!.story_id,
              title: "Implement sumLedgerEntries helper & tests",
              description: "Adds src/ledger-batch.mjs cleanly on top of C1",
              requirement_ids: [allReqIds[0]!],
              ac_ids: [allAcIds[0]!],
              allowed_files: ["src/**", "test/**"],
              developer_profile_id: devProfile.profile_id,
            },
          ],
        }
      );
      assert.equal(cr1.status, "PENDING_APPROVAL");

      // Open CR MUST mark traceability incomplete & block Release Acceptance (422)
      const openCrMatrix = await coreClient.getPipelineTraceabilityMatrix(
        projectId,
        authDev,
        frozen.sessionId
      );
      assert.equal(openCrMatrix.complete, false);
      assert.ok(
        openCrMatrix.missing_links.some((m) => m.stage === "STAGE_9_CHANGE_REQUEST")
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(projectId, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Approve CR-001 -> Apply CR-001 -> Stage 8 -> CAS Merge C2
      const decidedCr = await coreClient.decidePipelineChangeRequest(
        projectId,
        authApprover,
        frozen.sessionId,
        cr1.cr_id,
        {
          decision: "APPROVED",
          decision_rationale: "Approved post-freeze CR-001 within protected path envelope",
        }
      );
      assert.equal(decidedCr.status, "APPROVED");

      const appliedCr = await coreClient.applyPipelineChangeRequest(
        projectId,
        authDev,
        frozen.sessionId,
        cr1.cr_id
      );
      assert.equal(appliedCr.changeRequest.status, "APPLIED");
      assert.equal(appliedCr.tasks.length, 1);
      const taskCr = appliedCr.tasks[0]!;
      assert.equal(taskCr.base_main_commit_hash, commitC1);

      const stage8TaskCr = await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId,
        taskId: taskCr.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          {
            path: "src/ledger-batch.mjs",
            content:
              "export function sumLedgerEntries(entries) { return entries.reduce((acc, e) => acc + e.amountCents, 0); }\n",
          },
          {
            path: "test/ledger-batch.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { sumLedgerEntries } from "../src/ledger-batch.mjs"; assert.equal(sumLedgerEntries([{ amountCents: 10 }, { amountCents: 25 }]), 35);\n',
          },
        ],
        agentTestFile: "test/ledger-batch.agent.test.mjs",
      });

      const commitC2 = stage8TaskCr.mergedCommitHash;
      assert.notEqual(commitC2, commitC1);

      // Final AC-11b Bidirectional Traceability Verification (both C1 ancestor & C2 head reachable on main)
      const finalMatrix = await coreClient.getPipelineTraceabilityMatrix(
        projectId,
        authDev,
        frozen.sessionId
      );
      assert.equal(finalMatrix.complete, true);
      assert.equal(finalMatrix.coverage_percent, 100);
      assert.equal(finalMatrix.covered_requirements, finalMatrix.total_requirements);
      assert.deepEqual(finalMatrix.missing_links, []);
      assert.deepEqual(finalMatrix.orphan_links, []);

      for (const req of finalMatrix.requirement_rows) {
        assert.equal(req.complete, true);
        assert.ok(req.stage8_lineage.every((t) => t.main_reachable === true));
      }
      const req0Row = finalMatrix.forward_index[allReqIds[0]!]!;
      assert.equal(req0Row.applied_cr_ids.length, 1);
      assert.equal(req0Row.applied_cr_ids[0], cr1.cr_id);
      assert.equal(req0Row.stage8_lineage.length, 2);
      assert.ok(finalMatrix.backward_index.merged_commits[commitC1]?.includes(allReqIds[0]!));
      assert.ok(finalMatrix.backward_index.merged_commits[commitC2]?.includes(allReqIds[0]!));
      assert.ok(finalMatrix.backward_index.change_requests[cr1.cr_id]?.includes(allReqIds[0]!));
      assert.ok(finalMatrix.backward_index.tasks[task1.task_id]?.includes(allReqIds[0]!));
      assert.ok(finalMatrix.backward_index.tasks[taskCr.task_id]?.includes(allReqIds[0]!));
      assert.ok(finalMatrix.backward_index.stories[planOut.bundle.stories[0]!.story_id]);

      // Stage 9 Release Acceptance Package
      const releasePkg = await coreClient.issuePipelineReleasePackage(
        projectId,
        authApprover,
        frozen.sessionId,
        { notes: "Final E2E Release Acceptance Package" }
      );
      assert.equal(releasePkg.complete, true);
      assert.equal(releasePkg.coverage_percent, 100);
      assert.equal(releasePkg.main_head_commit_hash, commitC2);
      assert.equal(releasePkg.traceability_sha256, finalMatrix.traceability_sha256);
      assert.equal(releasePkg.merged_task_ids.length, 2);
      assert.deepEqual(releasePkg.applied_cr_ids, [cr1.cr_id]);
      assert.match(releasePkg.package_sha256, /^[0-9a-f]{64}$/);
      assert.ok(releasePkg.summary_markdown.includes("100%"));

      const listedPkgs = await coreClient.listPipelineReleasePackages(
        projectId,
        authDev,
        frozen.sessionId
      );
      assert.equal(listedPkgs.length, 1);
      assert.equal(listedPkgs[0]!.release_id, releasePkg.release_id);

      const bundle = await coreClient.getPipelineM6BBundle(projectId, authDev, frozen.sessionId);
      assert.equal(bundle.release_packages.length, 1);
      assert.equal(bundle.traceability.complete, true);
      assert.equal(bundle.agent_profiles.length, 4);
    } finally {
      await Promise.allSettled([webHttp.stop(), coreHttp.stop(), gatewayHttp.close(), mock.close()]);
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC5: Stage 9 Change Request & Release Acceptance Governance (RBAC 403, one-way CR lock, dangling ID/protected overlap blocks, <100% / open CR blocks)", async () => {
    const mock = await startMockModelProviderServers();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-ac5-"));
    const store = new SoftwareFactoryControlPlaneStore();
    const coreApi = new CoreApiService(store, {
      env: {},
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({ coreApi });
    try {
      const { baseUrl } = await coreHttp.start();
      const client = new HttpCoreApiClient(baseUrl);

      const proj = await store.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "admin" },
        async () => {
          const p = await store.createProject({
            slug: `m6b-ac5-${randomUUID().slice(0, 8)}`,
            name: "M6B AC5 Governance",
            repo_bare_path: join(rootDir, "repo.git"),
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
          await store.addProjectMembership({
            project_id: p.project_id,
            principal_id: "eve-auditor",
            member_role: "AUDITOR",
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
      const authAuditor = coreApi.issueAuthContext({
        projectId: proj.project_id,
        principalId: "eve-auditor",
        roles: ["AUDITOR"],
      });

      const frozen = await advanceToFrozenBaseline({
        client,
        projectId: proj.project_id,
        authDev,
        authApprover,
        title: "AC5 Governance",
      });
      await client.bootstrapPipelineProject(proj.project_id, authDev, frozen.sessionId, {
        repo_path: join(rootDir, "repo.git"),
        trusted_acceptance_dir: join(rootDir, "trusted"),
      });
      const planOut = await client.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId);
      const s2Parsed = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const reqId0 = s2Parsed.srs.functional_requirements[0]!.req_id;
      const acId0 = s2Parsed.srs.functional_requirements[0]!.acceptance_criteria[0]!.ac_id;

      // AUDITOR can read M6B endpoints (200) and CANNOT mutate any M6B state (403)
      const profList = await client.listAgentOrganizationProfiles(proj.project_id, authAuditor);
      assert.deepEqual(profList, []);
      await assert.rejects(
        () =>
          client.upsertAgentOrganizationProfile(proj.project_id, authAuditor, {
            profile_key: "auditor-forbidden",
            role: "DEVELOPER",
            principal_id: "x",
            provider: "anthropic",
            model: "claude-sonnet-4",
            execution_target_type: "factory_managed_worker",
            trust_tier: "TIER_1_FACTORY_MANAGED",
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      await assert.rejects(
        () =>
          client.submitPipelineChangeRequest(proj.project_id, authAuditor, frozen.sessionId, {
            cr_key: "CR-AUDITOR",
            title: "Forbidden",
            rationale: "Test",
            impacted_requirement_ids: [reqId0],
            proposed_tasks: [
              {
                task_key: "T-X",
                story_id: planOut.bundle.stories[0]!.story_id,
                title: "X",
                description: "X",
                requirement_ids: [reqId0],
                ac_ids: [acId0],
                allowed_files: ["src/**"],
              },
            ],
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      // Dangling requirement_id or protected_paths overlap in CR MUST fail (422)
      await assert.rejects(
        () =>
          client.submitPipelineChangeRequest(proj.project_id, authDev, frozen.sessionId, {
            cr_key: "CR-BAD-REQ",
            title: "Bad req",
            rationale: "Unknown req ID",
            impacted_requirement_ids: ["REQ-DOES-NOT-EXIST"],
            proposed_tasks: [
              {
                task_key: "T-BAD",
                title: "T",
                description: "D",
                requirement_ids: ["REQ-DOES-NOT-EXIST"],
                ac_ids: [acId0],
                allowed_files: ["src/**"],
              },
            ],
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () =>
          client.submitPipelineChangeRequest(proj.project_id, authDev, frozen.sessionId, {
            cr_key: "CR-BAD-PATH",
            title: "Protected path overlap",
            rationale: "Tries to edit policy",
            impacted_requirement_ids: [reqId0],
            proposed_tasks: [
              {
                task_key: "T-BAD-PATH",
                title: "T",
                description: "D",
                requirement_ids: [reqId0],
                ac_ids: [acId0],
                allowed_files: ["policy/trusted-verification-policy.json"],
              },
            ],
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Submit CR-REJ (PENDING_APPROVAL)
      const crRej = await client.submitPipelineChangeRequest(proj.project_id, authDev, frozen.sessionId, {
        cr_key: "CR-REJ",
        title: "Rejected CR test",
        rationale: "Probe one-way reject lock",
        impacted_requirement_ids: [reqId0],
        proposed_tasks: [
          {
            task_key: "T-REJ",
            title: "Will be rejected",
            description: "Desc",
            requirement_ids: [reqId0],
            ac_ids: [acId0],
            allowed_files: ["src/rej.mjs"],
          },
        ],
      });

      // DEVELOPER CANNOT decide CR (403) and CANNOT apply PENDING_APPROVAL CR (422)
      await assert.rejects(
        () =>
          client.decidePipelineChangeRequest(
            proj.project_id,
            authDev,
            frozen.sessionId,
            crRej.cr_id,
            { decision: "APPROVED" }
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      await assert.rejects(
        () =>
          client.applyPipelineChangeRequest(
            proj.project_id,
            authDev,
            frozen.sessionId,
            crRej.cr_id
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Reject CR-REJ -> terminal REJECTED (cannot flip back to APPROVED or apply)
      const rejected = await client.decidePipelineChangeRequest(
        proj.project_id,
        authApprover,
        frozen.sessionId,
        crRej.cr_id,
        { decision: "REJECTED", decision_rationale: "Unnecessary scope" }
      );
      assert.equal(rejected.status, "REJECTED");
      await assert.rejects(
        () =>
          client.decidePipelineChangeRequest(
            proj.project_id,
            authApprover,
            frozen.sessionId,
            crRej.cr_id,
            { decision: "APPROVED" }
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      await assert.rejects(
        () =>
          client.applyPipelineChangeRequest(
            proj.project_id,
            authDev,
            frozen.sessionId,
            crRej.cr_id
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Incomplete (< 100%) traceability -> DEVELOPER release blocked 403, APPROVER blocked 422
      const traceIncomplete = await client.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(traceIncomplete.complete, false);
      assert.equal(traceIncomplete.coverage_percent, 0);
      await assert.rejects(
        () => client.issuePipelineReleasePackage(proj.project_id, authDev, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );
      await assert.rejects(
        () => client.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
    } finally {
      await Promise.allSettled([coreHttp.stop(), mock.close()]);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC6: Web Console Stages 5–9 Interactive Workbench (PRG HTML forms, [data-error-banner], clickable links, ?format=html|md|json, cross-tenant 403/404)", async () => {
    const mock = await startMockModelProviderServers();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-web-"));
    const bareRepoDir = join(rootDir, "web-app.git");
    const trustedAcceptanceDir = join(rootDir, "trusted");
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const stack = await createControlPlaneStackRuntime({
      env: {},
      snapshotRootDir: snapshotDir,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
      withGatewayHttp: true,
    });

    const store = stack.coreApiRuntime!.store;
    const coreApi = stack.coreApiRuntime!.coreApi;
    const tokenService = stack.coreApiRuntime!.pushTokenService;
    const gatewayEndpoint = stack.coreApiRuntime!.gatewayEndpoint!;
    const coreClient = new HttpCoreApiClient(stack.coreApiRuntime!.coreApiEndpoint!.baseUrl);
    const webBaseUrl = stack.webEndpoint!.baseUrl;

    let projAId = "";
    let projBId = "";
    await store.withRlsTransaction(
      { currentRole: "system_admin_role", currentPrincipalId: "admin" },
      async () => {
        const pA = await store.createProject({
          slug: `m6b-web-a-${randomUUID().slice(0, 8)}`,
          name: "Web Console Project A",
          repo_bare_path: bareRepoDir,
          initial_main_commit_hash: "1".repeat(40),
          initial_main_tree_hash: "2".repeat(40),
        });
        const pB = await store.createProject({
          slug: `m6b-web-b-${randomUUID().slice(0, 8)}`,
          name: "Web Console Project B",
          repo_bare_path: join(rootDir, "b.git"),
          initial_main_commit_hash: "1".repeat(40),
          initial_main_tree_hash: "2".repeat(40),
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
          principal_id: "bob-approver",
          member_role: "PROJECT_APPROVER",
        });
        await store.addProjectMembership({
          project_id: projBId,
          principal_id: "intruder-b",
          member_role: "PROJECT_APPROVER",
        });
      }
    );

    try {
      const authDevA = coreApi.issueAuthContext({
        projectId: projAId,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApproverA = coreApi.issueAuthContext({
        projectId: projAId,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });
      const authApproverB = coreApi.issueAuthContext({
        projectId: projBId,
        principalId: "intruder-b",
        roles: ["PROJECT_APPROVER"],
      });

      const pEnc = encodeURIComponent(projAId);
      const frozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId: projAId,
        authDev: authDevA,
        authApprover: authApproverA,
        title: "Web UI M6B Workbench",
      });
      const sEnc = encodeURIComponent(frozen.sessionId);

      // 1. Stage 1-4 Pipeline HTML renders links to /m6b and /agent-profiles
      const s14Html = await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) },
        })
      ).text();
      assert.ok(s14Html.includes(`/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b`));
      assert.ok(s14Html.includes(`/projects/${pEnc}/agent-profiles`));

      // 2. Stage 6 Agent Profiles HTML page + invalid trust_tier error banner + valid PRG 303 form submits
      const profilesHtml = await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) },
        })
      ).text();
      assert.ok(profilesHtml.includes(`<form method="POST" action="/projects/${pEnc}/agent-profiles">`));

      const badProfileForm = await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
        },
        body: new URLSearchParams({
          profile_key: "bad-mismatch",
          role: "DEVELOPER",
          principal_id: "coder-x",
          provider: "anthropic",
          model: "claude-sonnet-4",
          execution_target_type: "factory_managed_worker",
          trust_tier: "TIER_3_PROVIDER_VM",
        }).toString(),
      });
      assert.equal(badProfileForm.status, 422);
      assert.ok((await badProfileForm.text()).includes('data-error-banner="true"'));

      const devFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
        },
        body: new URLSearchParams({
          profile_key: "web-dev-1",
          role: "DEVELOPER",
          principal_id: "web-coder-1",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          execution_target_type: "factory_managed_worker",
          trust_tier: "TIER_1_FACTORY_MANAGED",
        }).toString(),
      });
      assert.equal(devFormRes.status, 303);

      const revFormRes = await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
        },
        body: new URLSearchParams({
          profile_key: "web-rev-1",
          role: "REVIEWER_READONLY",
          principal_id: "web-reviewer-1",
          provider: "google",
          model: "gemini-2.5-pro",
          execution_target_type: "provider_managed_vm",
          trust_tier: "TIER_3_PROVIDER_VM",
        }).toString(),
      });
      assert.equal(revFormRes.status, 303);

      const profiles = await coreClient.listAgentOrganizationProfiles(projAId, authDevA);
      const devProf = profiles.find((p) => p.profile_key === "web-dev-1")!;
      const revProf = profiles.find((p) => p.profile_key === "web-rev-1")!;

      const pairCheckRes = await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles/validate-pair`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
        },
        body: new URLSearchParams({
          developer_profile_id: devProf.profile_id,
          reviewer_profile_id: revProf.profile_id,
        }).toString(),
      });
      assert.equal(pairCheckRes.status, 200);
      assert.ok((await pairCheckRes.text()).includes("3D separation VALID"));

      // 3. Stage 5 Bootstrap via Web Console HTML PRG form
      const parsedS2 = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...parsedS2.srs.functional_requirements,
        ...parsedS2.srs.non_functional_requirements,
      ];
      const allAcIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      const allReqIds = s2Reqs.map((r) => r.req_id);
      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const acId of allAcIds) {
        acceptanceSpecs[acId] = {
          target_file: "src/ledger.mjs",
          export_name: "createLedgerEntry",
          assertion_lines: [`assert.equal(mod.implementedAcIds.includes(${JSON.stringify(acId)}), true);`],
        };
      }

      const devForbiddenBootFormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/bootstrap`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: new URLSearchParams({
            repo_path: bareRepoDir,
            trusted_acceptance_dir: trustedAcceptanceDir,
            extra_protected_paths: "docs/immutable.md",
            acceptance_specs: JSON.stringify(acceptanceSpecs),
          }).toString(),
        }
      );
      assert.equal(devForbiddenBootFormRes.status, 403);

      const bootFormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/bootstrap`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: new URLSearchParams({
            repo_path: bareRepoDir,
            trusted_acceptance_dir: trustedAcceptanceDir,
            extra_protected_paths: "docs/immutable.md",
            acceptance_specs: JSON.stringify(acceptanceSpecs),
          }).toString(),
        }
      );
      assert.equal(bootFormRes.status, 303);

      const hooksDir = join(bareRepoDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookDest = join(hooksDir, "pre-receive");
      copyFileSync(findPreReceiveHookSource(), hookDest);
      chmodSync(hookDest, 0o755);

      // 4. Stage 7 Plan via Web Console HTML PRG form
      const s7FormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/stage7/plan`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: "",
        }
      );
      assert.equal(s7FormRes.status, 303);

      // Inspect /m6b HTML & check clickable Approval Center / Lineage links
      const m6bHtml = await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) },
        })
      ).text();
      assert.ok(m6bHtml.includes("M6B Stages 5"));
      assert.ok(m6bHtml.includes("/approval-center"));
      assert.ok(m6bHtml.includes("/lineage"));
      assert.ok(m6bHtml.includes("/change-requests"));

      const m6bJson = (await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b?format=json`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) },
        })
      ).json()) as M6BStages5To9Bundle;
      assert.equal(m6bJson.stage7_plan.tasks.length, 1);

      // Release before 100% via Web HTML form -> 422 error banner (Approver) & 403 error banner (Developer)
      const relBefore = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/release-package`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: "",
        }
      );
      assert.equal(relBefore.status, 422);
      assert.ok((await relBefore.text()).includes('data-error-banner="true"'));

      const relDevForbidden = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/release-package`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: "",
        }
      );
      assert.equal(relDevForbidden.status, 403);
      assert.ok((await relDevForbidden.text()).includes('data-error-banner="true"'));

      // Complete Stage 8 initial task cleanly
      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;
      await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl,
        tokenService,
        gatewayBaseUrl: gatewayEndpoint.baseUrl,
        preReceiveUrl: gatewayEndpoint.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: m6bJson.bootstrap!.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: projAId,
        taskId: m6bJson.stage7_plan.tasks[0]!.task_id,
        authDev: authDevA,
        authApprover: authApproverA,
        developerProfile: devProf,
        reviewerProfile: revProf,
        edits: [
          {
            path: "src/ledger.mjs",
            content: `export const implementedAcIds = ${JSON.stringify(allAcIds)};\nexport function createLedgerEntry(a, c='USD'){ return { amountCents: a, currency: c }; }\n`,
          },
          {
            path: "test/ledger.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { createLedgerEntry } from "../src/ledger.mjs"; assert.equal(createLedgerEntry(5).amountCents, 5);\n',
          },
        ],
        agentTestFile: "test/ledger.agent.test.mjs",
      });

      // Stage 9 CR-WEB-01: Submit -> DEVELOPER decide 403 banner -> Approver decide REJECTED (303)
      const cr1FormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: new URLSearchParams({
            cr_key: "CR-WEB-01",
            title: "Rejected optional enhancement via Web Form",
            rationale: "Submit via HTML PRG form for rejection check",
            impacted_requirement_ids: allReqIds[0]!,
            proposed_tasks: JSON.stringify([
              {
                task_key: "T-WEB-CR-1",
                title: "Rejected CR Task",
                description: "Desc",
                requirement_ids: [allReqIds[0]!],
                ac_ids: [allAcIds[0]!],
                allowed_files: ["src/rejected.mjs"],
              },
            ]),
          }).toString(),
        }
      );
      assert.equal(cr1FormRes.status, 303);

      let crs = await coreClient.listPipelineChangeRequests(projAId, authDevA, frozen.sessionId);
      const cr1 = crs.find((c) => c.cr_key === "CR-WEB-01")!;
      const cr1IdEnc = encodeURIComponent(cr1.cr_id);

      const devDecideRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests/${cr1IdEnc}/decide`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: new URLSearchParams({ decision: "REJECTED" }).toString(),
        }
      );
      assert.equal(devDecideRes.status, 403);
      assert.ok((await devDecideRes.text()).includes('data-error-banner="true"'));

      const appRejectRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests/${cr1IdEnc}/decide`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: new URLSearchParams({
            decision: "REJECTED",
            decision_rationale: "Deferred past v1 release",
          }).toString(),
        }
      );
      assert.equal(appRejectRes.status, 303);

      // Stage 9 CR-WEB-02: Submit -> Approver APPROVED (303) -> Apply CR via Web Form (303) -> Complete Stage 8 task -> 100% traceability
      const cr2FormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: new URLSearchParams({
            cr_key: "CR-WEB-02",
            title: "Approved optimization task via Web Form",
            rationale: "Exercise APPROVED -> Apply PRG flow",
            impacted_requirement_ids: allReqIds[0]!,
            proposed_tasks: JSON.stringify([
              {
                task_key: "T-WEB-CR-2",
                title: "Web Approved CR Task",
                description: "Add optional helper module without breaking ledger",
                requirement_ids: [allReqIds[0]!],
                ac_ids: [allAcIds[0]!],
                allowed_files: ["src/opt.mjs", "test/opt.agent.test.mjs"],
              },
            ]),
          }).toString(),
        }
      );
      assert.equal(cr2FormRes.status, 303);

      crs = await coreClient.listPipelineChangeRequests(projAId, authDevA, frozen.sessionId);
      const cr2 = crs.find((c) => c.cr_key === "CR-WEB-02")!;
      const cr2IdEnc = encodeURIComponent(cr2.cr_id);

      const appApproveRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests/${cr2IdEnc}/decide`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: new URLSearchParams({
            decision: "APPROVED",
            decision_rationale: "Approved for v1 release scope",
          }).toString(),
        }
      );
      assert.equal(appApproveRes.status, 303);

      const applyCrRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/change-requests/${cr2IdEnc}/apply`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA),
          },
          body: "",
        }
      );
      assert.equal(applyCrRes.status, 303);

      const afterApplyBundle = (await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b?format=json`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) },
        })
      ).json()) as M6BStages5To9Bundle;
      assert.equal(afterApplyBundle.stage7_plan.tasks.length, 2);
      assert.equal(afterApplyBundle.traceability.complete, false);

      const appliedLink = afterApplyBundle.stage7_plan.taskLinks.find((l) => l.cr_id === cr2.cr_id)!;
      assert.ok(appliedLink, "Expected applied CR-WEB-02 task link");

      await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl,
        tokenService,
        gatewayBaseUrl: gatewayEndpoint.baseUrl,
        preReceiveUrl: gatewayEndpoint.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: m6bJson.bootstrap!.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: projAId,
        taskId: appliedLink.task_id,
        authDev: authDevA,
        authApprover: authApproverA,
        developerProfile: devProf,
        reviewerProfile: revProf,
        edits: [
          {
            path: "src/opt.mjs",
            content: "export function formatCents(cents) { return `$${(cents / 100).toFixed(2)}`; }\n",
          },
          {
            path: "test/opt.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { formatCents } from "../src/opt.mjs"; assert.equal(formatCents(250), "$2.50");\n',
          },
        ],
        agentTestFile: "test/opt.agent.test.mjs",
      });

      // Format variants on /traceability (?format=html, ?format=md, ?format=json)
      const traceHtml = await (
        await fetch(
          `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/traceability?format=html`,
          { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) } }
        )
      ).text();
      assert.ok(traceHtml.includes("AC-11b Bidirectional Traceability Matrix"));
      assert.ok(traceHtml.includes("100%"));
      assert.ok(traceHtml.includes("/approval-center"));

      const traceMd = await (
        await fetch(
          `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/traceability?format=md`,
          { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) } }
        )
      ).text();
      assert.ok(traceMd.includes("## Bidirectional Traceability Matrix (AC-11b)"));
      assert.ok(traceMd.includes("**100%**"));

      const traceJson = (await (
        await fetch(
          `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/traceability?format=json`,
          { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authDevA) } }
        )
      ).json()) as BidirectionalTraceabilityMatrix;
      assert.equal(traceJson.complete, true);
      assert.equal(traceJson.coverage_percent, 100);

      // Issue Release Acceptance Package via Web HTML PRG form -> 303 & visible on /m6b
      const relFormRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/release-package`,
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA),
          },
          body: new URLSearchParams({ notes: "Released from Web Workbench" }).toString(),
        }
      );
      assert.equal(relFormRes.status, 303);

      const finalM6bHtml = await (
        await fetch(`${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b`, {
          headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverA) },
        })
      ).text();
      assert.ok(finalM6bHtml.includes("Release Acceptance"));
      assert.ok(finalM6bHtml.includes("CR-WEB-01"));
      assert.ok(finalM6bHtml.includes("CR-WEB-02"));

      // Cross-tenant Web & API requests rejected (403/404)
      const crossWebRes = await fetch(
        `${webBaseUrl}/projects/${pEnc}/pipeline-sessions/${sEnc}/m6b`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverB) } }
      );
      assert.ok(crossWebRes.status === 403 || crossWebRes.status === 404);
      const crossProfileRes = await fetch(`${webBaseUrl}/projects/${pEnc}/agent-profiles`, {
        headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApproverB) },
      });
      assert.ok(crossProfileRes.status === 403 || crossProfileRes.status === 404);
    } finally {
      await Promise.allSettled([stack.close(), mock.close()]);
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC7: Live PostgreSQL 17 `0008` FORCE RLS, 42501 append-only & column GRANTs, triggers, DISCARD ALL & full HTTP E2E backed by PostgresControlPlaneRepository", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const pool = new PostgresRuntimePool(pgConfig);
    const repo = new PostgresControlPlaneRepository(pool);
    const mock = await startMockModelProviderServers();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-pg-"));
    const bareRepoDir = join(rootDir, "pg-app.git");
    const trustedAcceptanceDir = join(rootDir, "trusted");
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const createdProjIds: string[] = [];
    const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
    const verifier = new Docker3TierVerifier({ snapshotStore });
    const tokenService = new EphemeralGitPushTokenService();
    const reviewerCredService = new EphemeralReviewerCredentialService();

    const coreApi = new CoreApiService(repo, {
      env: {},
      snapshotStore,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({ coreApi, snapshotStore, defaultVerifier: verifier });
    const webHttp = new WebApprovalConsoleHttpServer({ coreApi });
    let gatewayHttp: AgentGatewayHttpServer | null = null;
    let coreWithGw: CoreApiHttpServer | null = null;

    try {
      const coreInfo = await coreHttp.start();
      const webInfo = await webHttp.start();
      const coreClient = new HttpCoreApiClient(coreInfo.baseUrl);

      // 1. Verify FORCE RLS & schema invariants on all 8 M6B tables
      await pool.withRlsTransaction({ currentRole: "core_api_service" }, async (conn) => {
        const res = await conn.query<{ relname: string; forced: boolean }>(
          `SELECT c.relname, c.relforcerowsecurity AS forced
           FROM pg_class c
           WHERE c.relnamespace = 'public'::regnamespace
             AND c.relname IN (
               'project_bootstraps',
               'agent_organization_profiles',
               'dev_milestones',
               'dev_epics',
               'dev_user_stories',
               'change_requests',
               'task_plan_links',
               'release_acceptance_packages'
             );`
        );
        assert.equal(res.rows.length, 8);
        for (const r of res.rows) {
          assert.equal(r.forced, true, `FORCE ROW LEVEL SECURITY missing on ${r.relname}`);
        }
      });

      const projA = await repo.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "pg-admin" },
        async () => {
          const p = await repo.createProject({
            slug: `m6b-pg-a-${randomUUID().slice(0, 8)}`,
            name: "PG M6B Project A",
            repo_bare_path: bareRepoDir,
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          createdProjIds.push(p.project_id);
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const projB = await repo.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "pg-admin" },
        async () => {
          const p = await repo.createProject({
            slug: `m6b-pg-b-${randomUUID().slice(0, 8)}`,
            name: "PG M6B Project B",
            repo_bare_path: join(rootDir, "pg-b.git"),
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          createdProjIds.push(p.project_id);
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-b",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDevA = coreApi.issueAuthContext({
        projectId: projA.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApproverA = coreApi.issueAuthContext({
        projectId: projA.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });
      const authApproverB = coreApi.issueAuthContext({
        projectId: projB.project_id,
        principalId: "bob-b",
        roles: ["PROJECT_APPROVER"],
      });

      const gatewayService = new AgentGatewayService({
        store: repo,
        projectId: projA.project_id,
        reviewerCredentialService: reviewerCredService,
      });
      gatewayHttp = new AgentGatewayHttpServer({ store: repo, tokenService });
      coreWithGw = new CoreApiHttpServer({
        coreApi,
        snapshotStore,
        defaultVerifier: verifier,
        defaultAgentGateway: gatewayService,
      });
      const gwInfo = await gatewayHttp.start();
      const coreGwInfo = await coreWithGw.start();
      const gwClient = new HttpCoreApiClient(coreGwInfo.baseUrl);

      // 2. Full Stage 1 -> 9 E2E backed by live PostgreSQL 17!
      const frozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId: projA.project_id,
        authDev: authDevA,
        authApprover: authApproverA,
        title: "PG Live E2E Pipeline",
      });

      const parsedS2 = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...parsedS2.srs.functional_requirements,
        ...parsedS2.srs.non_functional_requirements,
      ];
      const allAcIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      const allReqIds = s2Reqs.map((r) => r.req_id);
      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const acId of allAcIds) {
        acceptanceSpecs[acId] = {
          target_file: "src/ledger.mjs",
          export_name: "createLedgerEntry",
          assertion_lines: [
            `assert.equal(mod.implementedAcIds.includes(${JSON.stringify(acId)}), true);`,
          ],
        };
      }

      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(
            projA.project_id,
            authDevA,
            frozen.sessionId,
            {
              repo_path: bareRepoDir,
              trusted_acceptance_dir: trustedAcceptanceDir,
              acceptance_specs: acceptanceSpecs,
            }
          ),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 403
      );

      const bootOutcome = await coreClient.bootstrapPipelineProject(
        projA.project_id,
        authApproverA,
        frozen.sessionId,
        {
          repo_path: bareRepoDir,
          trusted_acceptance_dir: trustedAcceptanceDir,
          acceptance_specs: acceptanceSpecs,
        }
      );

      const hooksDir = join(bareRepoDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookDest = join(hooksDir, "pre-receive");
      copyFileSync(findPreReceiveHookSource(), hookDest);
      chmodSync(hookDest, 0o755);

      const devProfile = await coreClient.upsertAgentOrganizationProfile(projA.project_id, authDevA, {
        profile_key: "pg-dev-worker",
        role: "DEVELOPER",
        principal_id: "pg-coder",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      const revProfile = await coreClient.upsertAgentOrganizationProfile(projA.project_id, authDevA, {
        profile_key: "pg-rev-vm",
        role: "REVIEWER_READONLY",
        principal_id: "pg-reviewer",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "provider_managed_vm",
        trust_tier: "TIER_3_PROVIDER_VM",
      });
      const planOut = await coreClient.runPipelineStage7Plan(
        projA.project_id,
        authDevA,
        frozen.sessionId
      );

      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      await runFullStage8ToCasMerge({
        store: repo,
        coreClient: gwClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker: dockerProbe.daemonAvailable && dockerProbe.imageAvailable,
        projectId: projA.project_id,
        taskId: planOut.bundle.tasks[0]!.task_id,
        authDev: authDevA,
        authApprover: authApproverA,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          {
            path: "src/ledger.mjs",
            content: `export const implementedAcIds = ${JSON.stringify(allAcIds)};\nexport function createLedgerEntry(a, c='USD'){ return { amountCents: a, currency: c }; }\n`,
          },
          {
            path: "test/ledger.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { createLedgerEntry } from "../src/ledger.mjs"; assert.equal(createLedgerEntry(42).amountCents, 42);\n',
          },
        ],
        agentTestFile: "test/ledger.agent.test.mjs",
      });

      // Stage 9 CR-PG-01 -> Approve -> Apply -> Merge
      const crPg = await coreClient.submitPipelineChangeRequest(
        projA.project_id,
        authDevA,
        frozen.sessionId,
        {
          cr_key: "CR-PG-01",
          title: "PG Audit Enhancement",
          rationale: "Add extra helper on PG path",
          impacted_requirement_ids: [allReqIds[0]!],
          proposed_tasks: [
            {
              task_key: "TASK-PG-CR",
              story_id: planOut.bundle.stories[0]!.story_id,
              title: "Implement PG CR helper",
              description: "Adds src/pg-helper.mjs",
              requirement_ids: [allReqIds[0]!],
              ac_ids: [allAcIds[0]!],
              allowed_files: ["src/**", "test/**"],
            },
          ],
        }
      );
      await coreClient.decidePipelineChangeRequest(
        projA.project_id,
        authApproverA,
        frozen.sessionId,
        crPg.cr_id,
        { decision: "APPROVED" }
      );
      const appliedPg = await coreClient.applyPipelineChangeRequest(
        projA.project_id,
        authDevA,
        frozen.sessionId,
        crPg.cr_id
      );
      await runFullStage8ToCasMerge({
        store: repo,
        coreClient: gwClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker: dockerProbe.daemonAvailable && dockerProbe.imageAvailable,
        projectId: projA.project_id,
        taskId: appliedPg.tasks[0]!.task_id,
        authDev: authDevA,
        authApprover: authApproverA,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/pg-helper.mjs", content: "export const pgVerified = true;\n" },
          {
            path: "test/pg-helper.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { pgVerified } from "../src/pg-helper.mjs"; assert.equal(pgVerified, true);\n',
          },
        ],
        agentTestFile: "test/pg-helper.agent.test.mjs",
      });

      const relPkg = await coreClient.issuePipelineReleasePackage(
        projA.project_id,
        authApproverA,
        frozen.sessionId
      );
      assert.equal(relPkg.coverage_percent, 100);
      assert.equal(relPkg.complete, true);

      // 3. Cross-tenant PG isolation under Project B
      const bBundles = await coreClient.getPipelineM6BBundle(
        projB.project_id,
        authApproverB,
        frozen.sessionId
      ).catch(() => null);
      assert.equal(bBundles, null);

      const bProfiles = await coreClient.listAgentOrganizationProfiles(
        projB.project_id,
        authApproverB
      );
      assert.equal(bProfiles.length, 0);

      // 4. Raw PostgreSQL SQL probes under app_runtime: DISCARD ALL, 42501 append-only, column GRANTs, triggers & CHECK constraints
      await pool.withRlsTransaction({ currentRole: "core_api_service" }, async (conn) => {
        // Without app.current_project_id set, all 8 M6B tables MUST return 0 rows
        for (const tbl of [
          "project_bootstraps",
          "agent_organization_profiles",
          "dev_milestones",
          "dev_epics",
          "dev_user_stories",
          "change_requests",
          "task_plan_links",
          "release_acceptance_packages",
        ]) {
          const r = await conn.query<{ cnt: string }>(`SELECT count(*)::text AS cnt FROM ${tbl};`);
          assert.equal(r.rows[0]!.cnt, "0", `DISCARD ALL / unset project leaked ${tbl}`);
        }
      });

      await pool.withRlsTransaction(
        {
          currentProjectId: projA.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        async (conn) => {
          const assertProbeSqlState = async (
            spName: string,
            expectedSqlStates: readonly string[],
            sql: string,
            params: readonly unknown[] = []
          ): Promise<void> => {
            await conn.query(`SAVEPOINT ${spName};`);
            try {
              await conn.query(sql, params);
              assert.fail(`Expected SQLSTATE ${expectedSqlStates.join("/")} for ${spName}`);
            } catch (err) {
              const code = (err as { sqlState?: string }).sqlState;
              assert.ok(
                code !== undefined && expectedSqlStates.includes(code),
                `${spName}: expected SQLSTATE ${expectedSqlStates.join("/")}, got ${String(code)} (${
                  err instanceof Error ? err.message : String(err)
                })`
              );
              await conn.query(`ROLLBACK TO SAVEPOINT ${spName};`);
            } finally {
              await conn.query(`RELEASE SAVEPOINT ${spName};`).catch(() => undefined);
            }
          };

          // 4a. Append-only 42501 on all 6 append-only tables (UPDATE + DELETE)
          for (const tbl of [
            "project_bootstraps",
            "dev_milestones",
            "dev_epics",
            "dev_user_stories",
            "task_plan_links",
            "release_acceptance_packages",
          ]) {
            await assertProbeSqlState(`sp_del_${tbl}`, ["42501"], `DELETE FROM ${tbl};`);
          }
          await assertProbeSqlState(
            "sp_upd_pb",
            ["42501"],
            `UPDATE project_bootstraps SET repo_path = '/tmp/hijack';`
          );
          await assertProbeSqlState(
            "sp_upd_dm",
            ["42501"],
            `UPDATE dev_milestones SET title = 'hijack';`
          );
          await assertProbeSqlState(
            "sp_upd_rap",
            ["42501"],
            `UPDATE release_acceptance_packages SET coverage_percent = 50;`
          );

          // 4b. Column-level GRANTs + NO DELETE on agent_organization_profiles & change_requests
          await assertProbeSqlState(
            "sp_del_aop",
            ["42501"],
            `DELETE FROM agent_organization_profiles;`
          );
          await assertProbeSqlState("sp_del_cr", ["42501"], `DELETE FROM change_requests;`);
          await assertProbeSqlState(
            "sp_upd_aop_key",
            ["42501"],
            `UPDATE agent_organization_profiles SET profile_key = 'tampered';`
          );
          await assertProbeSqlState(
            "sp_upd_cr_rat",
            ["42501"],
            `UPDATE change_requests SET rationale = 'tampered';`
          );

          // 4c. chk_rap_complete_100: coverage_percent < 100 rejected (23514) even at raw SQL INSERT
          await assertProbeSqlState(
            "sp_chk_rap_100",
            ["23514"],
            `INSERT INTO release_acceptance_packages (
               release_id, project_id, pipeline_session_id, baseline_id,
               traceability_sha256, coverage_percent, is_complete, total_requirements,
               merged_task_ids_json, applied_cr_ids_json, main_head_commit_hash,
               summary_markdown, package_json, package_sha256, accepted_by_principal_id
             ) VALUES (
               gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
               repeat('a', 64), 80, false, 2,
               '["t1"]'::jsonb, '[]'::jsonb, repeat('b', 40),
               'incomplete', '{}'::jsonb, repeat('c', 64), 'bob-approver'
             );`,
            [projA.project_id, frozen.sessionId, frozen.baseline.baseline_id]
          );

          // 4d. trg_cr_transitions: terminal APPLIED CR cannot transition back to PENDING_APPROVAL (23514)
          await assertProbeSqlState(
            "sp_trg_cr_term",
            ["23514"],
            `UPDATE change_requests SET status = 'PENDING_APPROVAL', decided_by_principal_id = NULL, decided_at = NULL, applied_by_principal_id = NULL, applied_at = NULL WHERE cr_id = $1::uuid;`,
            [crPg.cr_id]
          );

          // 4e. trg_tpl_invariants: inserting task_plan_links referencing APPLIED/PENDING CR blocked (23514)
          await assertProbeSqlState(
            "sp_trg_tpl_applied",
            ["23514"],
            `INSERT INTO task_plan_links (
               link_id, project_id, pipeline_session_id, baseline_id,
               bootstrap_id, task_id, cr_id, requirement_ids_json, ac_ids_json
             ) VALUES (
               gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
               $4::uuid, $5::uuid, $6::uuid, '["REQ-FUNC-001"]'::jsonb, '["AC-FUNC-1"]'::jsonb
             );`,
            [
              projA.project_id,
              frozen.sessionId,
              frozen.baseline.baseline_id,
              bootOutcome.bootstrap.bootstrap_id,
              appliedPg.tasks[0]!.task_id,
              crPg.cr_id,
            ]
          );

          // 4f. trg_*_frozen_anchor: active (non-frozen) session rejected on Stage 5/7/9 tables (23514/23503)
          const actSessRes = await conn.query<{ pipeline_session_id: string }>(
            `INSERT INTO product_pipeline_sessions (
               pipeline_session_id, project_id, title, raw_idea_text, created_by_principal_id
             ) VALUES (gen_random_uuid(), $1::uuid, 'Active Unfrozen', 'Raw', 'alice-dev')
             RETURNING pipeline_session_id;`,
            [projA.project_id]
          );
          const actSessId = actSessRes.rows[0]!.pipeline_session_id;
          await assertProbeSqlState(
            "sp_trg_cr_unfrozen",
            ["23503", "23514"],
            `INSERT INTO change_requests (
               cr_id, project_id, pipeline_session_id, baseline_id,
               cr_key, title, rationale, impacted_requirement_ids_json,
               proposed_tasks_json, requested_by_principal_id, cr_sha256
             ) VALUES (
               gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid,
               'CR-UNFROZEN', 'T', 'R', '["REQ-1"]'::jsonb,
               '[{"task_key":"T1"}]'::jsonb, 'alice-dev', repeat('a', 64)
             );`,
            [projA.project_id, actSessId, frozen.baseline.baseline_id]
          );

          // 4g. chk_aop_target_tier_mapping: raw SQL mismatched execution_target_type / trust_tier rejected (23514)
          await assertProbeSqlState(
            "sp_chk_aop_tier",
            ["23514"],
            `INSERT INTO agent_organization_profiles (
               profile_id, project_id, profile_key, role, principal_id,
               provider, model, execution_target_type, trust_tier, created_by_principal_id
             ) VALUES (
               gen_random_uuid(), $1::uuid, 'bad-sql-tier', 'DEVELOPER', 'dev-bad',
               'anthropic', 'claude-sonnet-4', 'factory_managed_worker', 'TIER_4_REMOTE_SESSION', 'alice-dev'
             );`,
            [projA.project_id]
          );
        }
      );

      // 5. Cross-tenant INSERT blocked with 42501 when currentProjectId is Project A trying to insert Project B
      await assert.rejects(
        () =>
          pool.withRlsTransaction(
            {
              currentProjectId: projA.project_id,
              currentPrincipalId: "alice-dev",
              currentRole: "core_api_service",
            },
            (conn) =>
              conn.query(
                `INSERT INTO agent_organization_profiles (
                   profile_id, project_id, profile_key, role, principal_id,
                   provider, model, execution_target_type, trust_tier, created_by_principal_id
                 ) VALUES (
                   gen_random_uuid(), $1::uuid, 'intruder-b', 'DEVELOPER', 'intruder',
                   'openai', 'gpt-4.1', 'factory_managed_worker', 'TIER_1_FACTORY_MANAGED', 'alice-dev'
                 );`,
                [projB.project_id]
              )
          ),
        (err: unknown) => (err as { sqlState?: string }).sqlState === "42501"
      );
    } finally {
      await Promise.allSettled([
        coreWithGw?.stop(),
        gatewayHttp?.close(),
        webHttp.stop(),
        coreHttp.stop(),
        mock.close(),
      ]);
      // Clean test projects from PG as table owner / postgres superuser if needed
      for (const pid of createdProjIds) {
        try {
          await pool.withRlsTransaction(
            { currentRole: "system_admin_role", currentPrincipalId: "pg-cleanup" },
            async (conn) => {
              await conn.query("DELETE FROM release_acceptance_packages WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM task_plan_links WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM change_requests WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM dev_user_stories WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM dev_epics WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM dev_milestones WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM project_bootstraps WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM agent_organization_profiles WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM baseline_spec_freezes WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM stage_approval_gates WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM stage_artifacts WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM stage1_discovery_items WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM model_call_ledgers WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM product_pipeline_sessions WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM model_cost_sessions WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM resource_usage_metrics WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM merge_operations WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM approval_decisions WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM approval_requests WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM review_artifacts WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM review_sessions WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM verification_runs WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM merge_candidates WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM verified_code_imports WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM processed_worker_events WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM task_leases WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM tasks WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM outbox_events WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM audit_logs WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM project_memberships WHERE project_id = $1::uuid;", [pid]);
              await conn.query("DELETE FROM projects WHERE project_id = $1::uuid;", [pid]);
            }
          );
        } catch {
          // ignore if connected as non-owner app_runtime without DELETE privileges
        }
      }
      await pool.close();
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-AC7b: Live PostgreSQL 17 Upgrade Paths (6f1faa8 M6A -> HEAD, 8044774 -> HEAD & 86076639 -> HEAD)", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

    const repoRoot = resolve(import.meta.dirname ?? process.cwd(), "../../..");
    const hasHistory = (() => {
      try {
        execFileSync("git", ["cat-file", "-e", "6f1faa8^{commit}"], { cwd: repoRoot });
        execFileSync("git", ["cat-file", "-e", "8044774^{commit}"], { cwd: repoRoot });
        execFileSync("git", ["cat-file", "-e", "86076639^{commit}"], { cwd: repoRoot });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasHistory) {
      t.skip("Full git commit history (6f1faa8, 8044774, 86076639) not present in shallow checkout");
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
          // next candidate
        }
      }
      return null;
    })();
    if (!psqlBin) {
      if (process.env.CI) {
        assert.fail("psql CLI binary is required in CI for M6B-AC7b upgrade tests");
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
    const db6f = `sf_m6b_upg_6f_${suffix}`;
    const db80 = `sf_m6b_upg_80_${suffix}`;
    const db86 = `sf_m6b_upg_86_${suffix}`;

    try {
      for (const db of [db6f, db80, db86]) {
        runPsql("postgres", `DROP DATABASE IF EXISTS ${db};`);
        runPsql("postgres", `CREATE DATABASE ${db};`);
      }

      // Path 1: M6A baseline (6f1faa8) with pre-seeded FROZEN baseline -> HEAD 0008 x2 + 0002
      for (const mig of [
        "packages/database/migrations/0001_mvp_core_schema_and_rls.sql",
        "packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
      ]) {
        runPsql(db6f, gitSql("6f1faa8", mig));
      }

      const pId = randomUUID();
      const csId = randomUUID();
      const ppsId = randomUUID();
      const factId = randomUUID();
      const sa1 = randomUUID();
      const sa2 = randomUUID();
      const sa3 = randomUUID();
      const sa4 = randomUUID();
      const sag4 = randomUUID();
      const bsfId = randomUUID();
      runPsql(
        db6f,
        `BEGIN;
         INSERT INTO projects (project_id, slug, name, repo_bare_path, default_branch, approval_ttl_seconds)
         VALUES ('${pId}', 'm6b-upg-6f', 'M6B Upgrade 6f1faa8', '/tmp/upg6f.git', 'main', 3600);
         INSERT INTO model_cost_sessions (cost_session_id, project_id, pipeline_session_id, max_tokens_per_request, max_cost_micro_usd_per_request, session_token_budget, session_cost_budget_micro_usd)
         VALUES ('${csId}', '${pId}', '${ppsId}', 4000, 100000, 20000, 500000);
         INSERT INTO product_pipeline_sessions (pipeline_session_id, project_id, cost_session_id, title, raw_idea_text, current_stage, status, created_by_principal_id)
         VALUES ('${ppsId}', '${pId}', '${csId}', 'M6A Frozen Session', 'Upgrade M6B', 'STAGE_4_SPEC_FREEZE', 'ACTIVE', 'alice-dev');
         INSERT INTO stage1_discovery_items (item_id, project_id, pipeline_session_id, kind, title, statement, rationale, confirmation_status)
         VALUES ('${factId}', '${pId}', '${ppsId}', 'FACT', 'F1', 'Given', 'R', 'AUTO_VERIFIED');
         INSERT INTO stage_artifacts (artifact_id, project_id, pipeline_session_id, stage, artifact_kind, version, provider, model, prompt_id, prompt_version, prompt_sha256, content_json, artifact_sha256, created_by_principal_id)
         VALUES
           ('${sa1}', '${pId}', '${ppsId}', 'STAGE_1_IDEA_DISCOVERY', 'STAGE_1_DISCOVERY_BUNDLE', 1, 'anthropic', 'claude-sonnet-4', 'p1', '1.0.0', repeat('1', 64), '{}'::jsonb, repeat('a', 64), 'alice-dev'),
           ('${sa2}', '${pId}', '${ppsId}', 'STAGE_2_REQUIREMENTS', 'STAGE_2_PRD_SRS', 1, 'openai', 'gpt-4.1', 'p2', '1.0.0', repeat('2', 64), '{"srs":{"functional_requirements":[{"req_id":"R1","source_discovery_item_ids":["${factId}"]}]}}'::jsonb, repeat('b', 64), 'alice-dev'),
           ('${sa3}', '${pId}', '${ppsId}', 'STAGE_3_ARCHITECTURE', 'STAGE_3_ARCHITECTURE_DESIGN', 1, 'google', 'gemini-2.5-pro', 'p3', '1.0.0', repeat('3', 64), '{}'::jsonb, repeat('c', 64), 'alice-dev'),
           ('${sa4}', '${pId}', '${ppsId}', 'STAGE_4_SPEC_FREEZE', 'STAGE_4_VALIDATION_REPORT', 1, 'system', 'consistency-checker', 'p4', '1.0.0', repeat('4', 64), '{"passed":true}'::jsonb, repeat('d', 64), 'bob-approver');
         INSERT INTO stage_approval_gates (gate_id, project_id, pipeline_session_id, gate_stage, target_artifact_id, target_artifact_sha256, approver_principal_id, decision)
         VALUES ('${sag4}', '${pId}', '${ppsId}', 'STAGE_4_SPEC_FREEZE', '${sa4}', repeat('d', 64), 'bob-approver', 'APPROVED');
         INSERT INTO baseline_spec_freezes (baseline_id, project_id, pipeline_session_id, stage1_artifact_id, stage1_artifact_sha256, stage2_artifact_id, stage2_artifact_sha256, stage3_artifact_id, stage3_artifact_sha256, validation_report_artifact_id, validation_report_sha256, approval_gate_id, frozen_by_principal_id, freeze_bundle_sha256)
         VALUES ('${bsfId}', '${pId}', '${ppsId}', '${sa1}', repeat('a', 64), '${sa2}', repeat('b', 64), '${sa3}', repeat('c', 64), '${sa4}', repeat('d', 64), '${sag4}', 'bob-approver', repeat('f', 64));
         UPDATE product_pipeline_sessions SET status = 'FROZEN', frozen_baseline_id = '${bsfId}' WHERE pipeline_session_id = '${ppsId}';
         COMMIT;`
      );

      runPsql(db6f, headSql("packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0010_m6c_extended_code_import_submissions.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0010_m6c_extended_code_import_submissions.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0011_m6c_review_notes_hardening.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0011_m6c_review_notes_hardening.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0012_durable_budget_denial_journal.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0012_durable_budget_denial_journal.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0014_m6c3_production_deployment_gate.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0014_m6c3_production_deployment_gate.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0015_m6c3_deployment_reconciliation.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0015_m6c3_deployment_reconciliation.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0016_m6c3_execution_targets.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0016_m6c3_execution_targets.sql"));
      runPsql(db6f, headSql("packages/database/migrations/0002_rls_verification_matrix.sql"));

      const pool6f = new PostgresRuntimePool({ ...pgConfig, database: db6f, maxConnections: 2 });
      try {
        await pool6f.withRlsTransaction(
          { currentProjectId: pId, currentPrincipalId: "alice-dev", currentRole: "core_api_service" },
          async (conn) => {
            const profRes = await conn.query<{ profile_id: string }>(
              `INSERT INTO agent_organization_profiles (
                 profile_id, project_id, profile_key, role, principal_id,
                 provider, model, execution_target_type, trust_tier, created_by_principal_id
               ) VALUES (
                 gen_random_uuid(), $1::uuid, 'upg-dev', 'DEVELOPER', 'dev-u',
                 'anthropic', 'claude-sonnet-4', 'factory_managed_worker', 'TIER_1_FACTORY_MANAGED', 'alice-dev'
               ) RETURNING profile_id;`,
              [pId]
            );
            assert.ok(profRes.rows[0]?.profile_id);
          }
        );
      } finally {
        await pool6f.close();
      }

      // Path 2: Initial M6A (8044774) -> HEAD (0007 x2 + 0008 x2 + 0002)
      for (const mig of [
        "packages/database/migrations/0001_mvp_core_schema_and_rls.sql",
        "packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
      ]) {
        runPsql(db80, gitSql("8044774", mig));
      }
      for (const mig of [
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql",
        "packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql",
        "packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql",
        "packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql",
        "packages/database/migrations/0010_m6c_extended_code_import_submissions.sql",
        "packages/database/migrations/0010_m6c_extended_code_import_submissions.sql",
        "packages/database/migrations/0011_m6c_review_notes_hardening.sql",
        "packages/database/migrations/0011_m6c_review_notes_hardening.sql",
        "packages/database/migrations/0012_durable_budget_denial_journal.sql",
        "packages/database/migrations/0012_durable_budget_denial_journal.sql",
        "packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql",
        "packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql",
        "packages/database/migrations/0014_m6c3_production_deployment_gate.sql",
        "packages/database/migrations/0014_m6c3_production_deployment_gate.sql",
        "packages/database/migrations/0015_m6c3_deployment_reconciliation.sql",
        "packages/database/migrations/0015_m6c3_deployment_reconciliation.sql",
        "packages/database/migrations/0016_m6c3_execution_targets.sql",
        "packages/database/migrations/0016_m6c3_execution_targets.sql",
        "packages/database/migrations/0002_rls_verification_matrix.sql",
      ]) {
        runPsql(db80, headSql(mig));
      }

      // Path 3: Pre-fix M4 (86076639) -> HEAD (0004..0008 x2 + 0002)
      for (const mig of [
        "packages/database/migrations/0001_mvp_core_schema_and_rls.sql",
        "packages/database/migrations/0003_m3_candidate_snapshot_and_verifier_tiers.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
      ]) {
        runPsql(db86, gitSql("86076639", mig));
      }
      for (const mig of [
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0004_m4_reviewer_sessions_approval_ttl_and_merge_ops.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0005_m5_resource_metrics_and_runtime_pool.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
        "packages/database/migrations/0006_m6a_model_cost_guard_and_stages_1_4.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0007_m6a_review_fixes.sql",
        "packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql",
        "packages/database/migrations/0008_m6b_stages_5_9_and_traceability.sql",
        "packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql",
        "packages/database/migrations/0009_m6c_parallel_scheduler_cas_queue_and_budgets.sql",
        "packages/database/migrations/0010_m6c_extended_code_import_submissions.sql",
        "packages/database/migrations/0010_m6c_extended_code_import_submissions.sql",
        "packages/database/migrations/0011_m6c_review_notes_hardening.sql",
        "packages/database/migrations/0011_m6c_review_notes_hardening.sql",
        "packages/database/migrations/0012_durable_budget_denial_journal.sql",
        "packages/database/migrations/0012_durable_budget_denial_journal.sql",
        "packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql",
        "packages/database/migrations/0013_m6c3_verifier_isolation_runtime.sql",
        "packages/database/migrations/0014_m6c3_production_deployment_gate.sql",
        "packages/database/migrations/0014_m6c3_production_deployment_gate.sql",
        "packages/database/migrations/0015_m6c3_deployment_reconciliation.sql",
        "packages/database/migrations/0015_m6c3_deployment_reconciliation.sql",
        "packages/database/migrations/0016_m6c3_execution_targets.sql",
        "packages/database/migrations/0016_m6c3_execution_targets.sql",
        "packages/database/migrations/0002_rls_verification_matrix.sql",
      ]) {
        runPsql(db86, headSql(mig));
      }

      for (const db of [db80, db86]) {
        const p = new PostgresRuntimePool({ ...pgConfig, database: db, maxConnections: 1 });
        try {
          await p.withRlsTransaction({ currentRole: "core_api_service" }, async (conn) => {
            const cntRes = await conn.query<{ cnt: string }>(
              `SELECT count(*)::text AS cnt
               FROM pg_class c
               WHERE c.relnamespace = 'public'::regnamespace
                 AND c.relforcerowsecurity = true
                 AND c.relname IN (
                   'project_bootstraps',
                   'agent_organization_profiles',
                   'dev_milestones',
                   'dev_epics',
                   'dev_user_stories',
                   'change_requests',
                   'task_plan_links',
                   'release_acceptance_packages',
                   'task_dependencies', 'merge_queue_entries', 'project_budget_policies',
                   'task_budget_policies', 'budget_pause_events', 'code_import_submissions'
                 );`
            );
            assert.equal(cntRes.rows[0]!.cnt, "14");
          });
        } finally {
          await p.close();
        }
      }
    } finally {
      for (const db of [db6f, db80, db86]) {
        try {
          runPsql("postgres", `DROP DATABASE IF EXISTS ${db};`);
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  it("M6B-FIX-01..09 & Minor #1/#2/#5/#7/#9 (In-Memory): fail-closed validation, bootstrap hygiene, TX2 billing, git main verification & bidirectional orphan scans", async () => {
    // 1. Unit validations: M6B-FIX-04, Minor #5, M6B-FIX-05, M6B-FIX-08, Minor #2
    assert.throws(
      () => extractStage2Requirements({}),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () => extractStage2Requirements({ srs: { functional_requirements: "not-array" } }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () =>
        extractStage2Requirements({
          srs: {
            functional_requirements: [
              { req_id: "   ", title: "T", description: "D", acceptance_criteria: [] },
            ],
            non_functional_requirements: [],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () =>
        extractStage2Requirements({
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-DUP",
                title: "A",
                description: "D",
                acceptance_criteria: [{ ac_id: "AC-1", given: "g", when: "w", then: "t" }],
              },
            ],
            non_functional_requirements: [
              {
                req_id: "REQ-DUP",
                title: "B",
                description: "D",
                acceptance_criteria: [{ ac_id: "AC-2", given: "g", when: "w", then: "t" }],
              },
            ],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () =>
        extractStage2Requirements({
          srs: {
            functional_requirements: [
              { req_id: "REQ-1", title: "A", description: "D", acceptance_criteria: "bad" },
            ],
            non_functional_requirements: [],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () =>
        extractStage2Requirements({
          srs: {
            functional_requirements: [
              {
                req_id: "REQ-1",
                title: "A",
                description: "D",
                acceptance_criteria: [
                  { ac_id: "AC-DUP", given: "g", when: "w", then: "t" },
                  { ac_id: "AC-DUP", given: "g", when: "w", then: "t" },
                ],
              },
            ],
            non_functional_requirements: [],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    const sampleTestSpec = [
      {
        ac_id: "AC-1",
        req_id: "REQ-1",
        given: "g",
        when: "w",
        then: "t",
        test_file_path: "acceptance.test.mjs",
        component_ids: ["COMP-1"],
        expected_deliverables: ["src/a.mjs"],
      },
    ];
    for (const missingIdx of [0, 1]) {
      const partialProtected = REQUIRED_STAGE5_PROTECTED_PATHS.filter((_, idx) => idx !== missingIdx);
      assert.throws(
        () =>
          validateProjectBootstrapInput({
            repo_path: "/tmp/repo.git",
            trusted_acceptance_dir: "/tmp/trusted",
            base_main_commit_hash: "a".repeat(40),
            protected_paths: partialProtected,
            trusted_policy_sha256: "b".repeat(64),
            acceptance_tests: sampleTestSpec,
            created_by_principal_id: "bob-approver",
          }),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );
    }
    validateProjectBootstrapInput({
      repo_path: "/tmp/repo.git",
      trusted_acceptance_dir: "/tmp/trusted",
      base_main_commit_hash: "a".repeat(40),
      protected_paths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
      trusted_policy_sha256: "b".repeat(64),
      acceptance_tests: sampleTestSpec,
      created_by_principal_id: "bob-approver",
    });

    const unitS2: Record<string, unknown> = {
      srs: {
        functional_requirements: [
          {
            req_id: "REQ-U1",
            title: "U1",
            description: "U1",
            source_discovery_item_ids: [randomUUID()],
            acceptance_criteria: [{ ac_id: "AC-U1", given: "g1", when: "w1", then: "t1" }],
          },
          {
            req_id: "REQ-U2",
            title: "U2",
            description: "U2",
            source_discovery_item_ids: [randomUUID()],
            acceptance_criteria: [{ ac_id: "AC-U2", given: "g2", when: "w2", then: "t2" }],
          },
        ],
        non_functional_requirements: [],
      },
    };
    const unitS3: Record<string, unknown> = {
      architecture: {
        components: [{ component_id: "COMP-U", name: "UnitComp", requirement_ids: ["REQ-U1", "REQ-U2"] }],
      },
    };

    // Swapped (req_id, ac_id) on Stage 7 story & task MUST reject (23514)
    assert.throws(
      () =>
        validateStage7PlanAgainstBaseline({
          stage2ContentJson: unitS2,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          profiles: [],
          plan: {
            milestones: [{ milestone_key: "MS-1", title: "M", description: "M" }],
            epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E", description: "E" }],
            stories: [
              {
                story_key: "ST-1",
                epic_key: "EP-1",
                title: "S1",
                description: "S1",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U2"],
              },
              {
                story_key: "ST-2",
                epic_key: "EP-1",
                title: "S2",
                description: "S2",
                requirement_ids: ["REQ-U2"],
                ac_ids: ["AC-U1"],
              },
            ],
            tasks: [
              {
                task_key: "T-1",
                story_key: "ST-1",
                title: "T1",
                description: "T1",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U1"],
                allowed_files: ["src/**"],
                depends_on_task_keys: [],
              },
              {
                task_key: "T-2",
                story_key: "ST-2",
                title: "T2",
                description: "T2",
                requirement_ids: ["REQ-U2"],
                ac_ids: ["AC-U2"],
                allowed_files: ["src/**"],
                depends_on_task_keys: [],
              },
            ],
            planning_notes: "swapped pair",
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    // task.requirement_ids not subset of story.requirement_ids MUST reject (23514)
    assert.throws(
      () =>
        validateStage7PlanAgainstBaseline({
          stage2ContentJson: unitS2,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          profiles: [],
          plan: {
            milestones: [{ milestone_key: "MS-1", title: "M", description: "M" }],
            epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E", description: "E" }],
            stories: [
              {
                story_key: "ST-1",
                epic_key: "EP-1",
                title: "S1",
                description: "S1",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U1"],
              },
            ],
            tasks: [
              {
                task_key: "T-1",
                story_key: "ST-1",
                title: "T1",
                description: "T1",
                requirement_ids: ["REQ-U1", "REQ-U2"],
                ac_ids: ["AC-U1", "AC-U2"],
                allowed_files: ["src/**"],
                depends_on_task_keys: [],
              },
            ],
            planning_notes: "superset task",
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    // Whitespace-padded dependency cycle (`[" T-B "]` / `[" T-A "]`) MUST reject (23514)
    assert.throws(
      () =>
        validateStage7PlanAgainstBaseline({
          stage2ContentJson: unitS2,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          profiles: [],
          plan: {
            milestones: [{ milestone_key: "MS-1", title: "M", description: "M" }],
            epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E", description: "E" }],
            stories: [
              {
                story_key: "ST-1",
                epic_key: "EP-1",
                title: "S1",
                description: "S1",
                requirement_ids: ["REQ-U1", "REQ-U2"],
                ac_ids: ["AC-U1", "AC-U2"],
              },
            ],
            tasks: [
              {
                task_key: "T-A",
                story_key: "ST-1",
                title: "TA",
                description: "TA",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U1"],
                allowed_files: ["src/**"],
                depends_on_task_keys: [" T-B "],
              },
              {
                task_key: "T-B",
                story_key: "ST-1",
                title: "TB",
                description: "TB",
                requirement_ids: ["REQ-U2"],
                ac_ids: ["AC-U2"],
                allowed_files: ["src/**"],
                depends_on_task_keys: [" T-A "],
              },
            ],
            planning_notes: "padded cycle",
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    // Minor #2: Iterative Kahn topological sort handles 1,600-task chain without RangeError AND catches 1,600-task cycle
    const chainTasks = Array.from({ length: 1600 }, (_, i) => ({
      task_key: `TASK-${i}`,
      story_key: "ST-CHAIN",
      title: `Task ${i}`,
      description: "Chain task",
      requirement_ids: i === 0 ? ["REQ-U1", "REQ-U2"] : ["REQ-U1"],
      ac_ids: i === 0 ? ["AC-U1", "AC-U2"] : ["AC-U1"],
      allowed_files: ["src/**"],
      depends_on_task_keys: i === 0 ? [] : [`TASK-${i - 1}`],
    }));
    const valid1600 = validateStage7PlanAgainstBaseline({
      stage2ContentJson: unitS2,
      protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
      profiles: [],
      plan: {
        milestones: [{ milestone_key: "MS-1", title: "M", description: "M" }],
        epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E", description: "E" }],
        stories: [
          {
            story_key: "ST-CHAIN",
            epic_key: "EP-1",
            title: "Chain",
            description: "1600 chain",
            requirement_ids: ["REQ-U1", "REQ-U2"],
            ac_ids: ["AC-U1", "AC-U2"],
          },
        ],
        tasks: chainTasks,
        planning_notes: "1600 acyclic",
      },
    });
    assert.equal(valid1600.requirements.length, 2);

    const cyclicChainTasks = chainTasks.map((t, i) =>
      i === 0 ? { ...t, depends_on_task_keys: ["TASK-1599"] } : t
    );
    assert.throws(
      () =>
        validateStage7PlanAgainstBaseline({
          stage2ContentJson: unitS2,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          profiles: [],
          plan: {
            milestones: [{ milestone_key: "MS-1", title: "M", description: "M" }],
            epics: [{ epic_key: "EP-1", milestone_key: "MS-1", title: "E", description: "E" }],
            stories: [
              {
                story_key: "ST-CHAIN",
                epic_key: "EP-1",
                title: "Chain",
                description: "1600 cycle",
                requirement_ids: ["REQ-U1", "REQ-U2"],
                ac_ids: ["AC-U1", "AC-U2"],
              },
            ],
            tasks: cyclicChainTasks,
            planning_notes: "1600 cyclic",
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    // M6B-FIX-05: CR swapped (req_id, ac_id) & uncovered impacted req MUST reject (23514)
    assert.throws(
      () =>
        validateCreateChangeRequestAgainstBaseline({
          stage2ContentJson: unitS2,
          stage3ContentJson: unitS3,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          request: {
            cr_key: "CR-SWAP",
            title: "Swap",
            rationale: "Test",
            impacted_requirement_ids: ["REQ-U1"],
            proposed_tasks: [
              {
                task_key: "T-SWAP",
                title: "T",
                description: "D",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U2"],
                allowed_files: ["src/**"],
              },
            ],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );
    assert.throws(
      () =>
        validateCreateChangeRequestAgainstBaseline({
          stage2ContentJson: unitS2,
          stage3ContentJson: unitS3,
          protectedPaths: [...REQUIRED_STAGE5_PROTECTED_PATHS],
          request: {
            cr_key: "CR-UNCOV",
            title: "Uncov",
            rationale: "Test",
            impacted_requirement_ids: ["REQ-U1", "REQ-U2"],
            proposed_tasks: [
              {
                task_key: "T-ONE",
                title: "T",
                description: "D",
                requirement_ids: ["REQ-U1"],
                ac_ids: ["AC-U1"],
                allowed_files: ["src/**"],
              },
            ],
          },
        }),
      (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
    );

    // 2. End-to-end In-Memory Stack for M6B-FIX-01..09
    const mock = await startMockModelProviderServers();
    const store = new SoftwareFactoryControlPlaneStore();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-fix-mem-"));
    const snapshotDir = join(rootDir, "snapshots");
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const bareRepoDir = join(rootDir, "app.git");
    const trustedDir = join(rootDir, "trusted-acceptance");
    const trivialRepoDir = join(rootDir, "trivial.git");
    const trivialTrustedDir = join(rootDir, "trivial-trusted");
    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });

    const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
    const verifier = new Docker3TierVerifier({ snapshotStore });
    const tokenService = new EphemeralGitPushTokenService();
    const reviewerCredService = new EphemeralReviewerCredentialService();

    const projSetup = await store.withRlsTransaction(
      { currentRole: "system_admin_role", currentPrincipalId: "admin" },
      async () => {
        const mainProj = await store.createProject({
          slug: `m6b-fix-main-${randomUUID().slice(0, 8)}`,
          name: "M6B Fix Main",
          repo_bare_path: bareRepoDir,
          initial_main_commit_hash: "1".repeat(40),
          initial_main_tree_hash: "2".repeat(40),
        });
        await store.addProjectMembership({
          project_id: mainProj.project_id,
          principal_id: "alice-dev",
          member_role: "DEVELOPER",
        });
        await store.addProjectMembership({
          project_id: mainProj.project_id,
          principal_id: "bob-approver",
          member_role: "PROJECT_APPROVER",
        });

        const trivProj = await store.createProject({
          slug: `m6b-fix-triv-${randomUUID().slice(0, 8)}`,
          name: "M6B Fix Trivial Specs",
          repo_bare_path: trivialRepoDir,
          initial_main_commit_hash: "3".repeat(40),
          initial_main_tree_hash: "4".repeat(40),
        });
        await store.addProjectMembership({
          project_id: trivProj.project_id,
          principal_id: "alice-dev",
          member_role: "DEVELOPER",
        });
        await store.addProjectMembership({
          project_id: trivProj.project_id,
          principal_id: "bob-approver",
          member_role: "PROJECT_APPROVER",
        });
        return { mainProj, trivProj };
      }
    );
    const proj = projSetup.mainProj;
    const trivProj = projSetup.trivProj;

    const gatewayService = new AgentGatewayService({
      store,
      projectId: proj.project_id,
      reviewerCredentialService: reviewerCredService,
    });
    const gatewayHttp = new AgentGatewayHttpServer({ store, tokenService });
    const coreApi = new CoreApiService(store, {
      env: {},
      snapshotStore,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({
      coreApi,
      snapshotStore,
      defaultVerifier: verifier,
      defaultAgentGateway: gatewayService,
    });
    const webHttp = new WebApprovalConsoleHttpServer({ coreApi });

    try {
      const gwInfo = await gatewayHttp.start();
      const coreInfo = await coreHttp.start();
      const webInfo = await webHttp.start();
      const coreClient = new HttpCoreApiClient(coreInfo.baseUrl);
      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;

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
      const authTrivDev = coreApi.issueAuthContext({
        projectId: trivProj.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authTrivApprover = coreApi.issueAuthContext({
        projectId: trivProj.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      // 3. M6B-FIX-02 Execution Proof: trivial assertion_lines `["assert.equal(1, 1)"]` STILL enforces implementedAcIds & non-empty function
      const trivFrozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId: trivProj.project_id,
        authDev: authTrivDev,
        authApprover: authTrivApprover,
        title: "Trivial Override Test",
      });
      const trivS2 = trivFrozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const trivAcIds = [
        ...trivS2.srs.functional_requirements,
        ...trivS2.srs.non_functional_requirements,
      ].flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      const trivialSpecs: Record<string, { target_file: string; assertion_lines: string[] }> = {};
      for (const acId of trivAcIds) {
        trivialSpecs[acId] = {
          target_file: "src/ledger.mjs",
          assertion_lines: ["assert.equal(1, 1)"],
        };
      }
      await coreClient.bootstrapPipelineProject(
        trivProj.project_id,
        authTrivApprover,
        trivFrozen.sessionId,
        {
          repo_path: trivialRepoDir,
          trusted_acceptance_dir: trivialTrustedDir,
          acceptance_specs: trivialSpecs,
        }
      );
      const trivClone = join(rootDir, "trivial-clone");
      gitAt(rootDir, ["clone", trivialRepoDir, trivClone]);
      mkdirSync(join(trivClone, "src"), { recursive: true });
      const trivChildEnv = { ...process.env };
      delete trivChildEnv.NODE_TEST_CONTEXT;
      const runTrivialAcceptance = () =>
        execFileSync(
          process.execPath,
          ["--test", join(trivialTrustedDir, "acceptance.test.mjs")],
          {
            cwd: trivClone,
            env: trivChildEnv,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

      // (a) Missing implementedAcIds/implementedRequirements -> MUST fail
      writeFileSync(
        join(trivClone, "src", "ledger.mjs"),
        "export function createLedgerEntry(x) { return { amountCents: x }; }\n",
        "utf8"
      );
      assert.throws(() => runTrivialAcceptance());

      // (b) implementedAcIds present, empty body function -> MUST fail
      writeFileSync(
        join(trivClone, "src", "ledger.mjs"),
        `export const implementedAcIds = ${JSON.stringify(trivAcIds)};\nexport function createLedgerEntry() {}\n`,
        "utf8"
      );
      assert.throws(() => runTrivialAcceptance());

      // (c) implementedAcIds present + non-empty executable function -> PASS
      writeFileSync(
        join(trivClone, "src", "ledger.mjs"),
        `export const implementedAcIds = ${JSON.stringify(trivAcIds)};\nexport function createLedgerEntry(x) { return { amountCents: x }; }\n`,
        "utf8"
      );
      runTrivialAcceptance();

      // 4. Stage 5 Hygiene & Security Guards (M6B-FIX-02, M6B-FIX-09, Minor #9)
      const frozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId: proj.project_id,
        authDev,
        authApprover,
        title: "M6B Fixes Pipeline",
      });
      const parsedS2 = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...parsedS2.srs.functional_requirements,
        ...parsedS2.srs.non_functional_requirements,
      ];
      const allReqIds = s2Reqs.map((r) => r.req_id);
      const allAcIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      assert.equal(allReqIds.length, 3);

      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const acId of allAcIds) {
        acceptanceSpecs[acId] = {
          target_file: "src/ledger.mjs",
          export_name: "createLedgerEntry",
          assertion_lines: [
            'const entry = mod.createLedgerEntry(5000, "USD");',
            "assert.equal(entry.amountCents, 5000);",
            `assert.equal(mod.implementedAcIds.includes(${JSON.stringify(acId)}), true);`,
          ],
        };
      }

      // Unsafe assertion_lines MUST fail (422)
      for (const badLine of [
        "process.exit(1)",
        "const fs = require('fs')",
        "const a = 1; assert.equal(a, 1)",
      ]) {
        await assert.rejects(
          () =>
            coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
              repo_path: bareRepoDir,
              trusted_acceptance_dir: trustedDir,
              acceptance_specs: {
                [allAcIds[0]!]: { target_file: "src/ledger.mjs", assertion_lines: [badLine] },
              },
            }),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
        );
      }

      // Non-empty trusted_acceptance_dir MUST fail (422) and preserve leftover file
      mkdirSync(trustedDir, { recursive: true });
      const leftoverPath = join(trustedDir, "leftover.txt");
      writeFileSync(leftoverPath, "keep-me\n", "utf8");
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: trustedDir,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      assert.equal(readFileSync(leftoverPath, "utf8"), "keep-me\n");
      rmSync(trustedDir, { recursive: true, force: true });

      // Direct symlink trusted_acceptance_dir (outside empty dir) MUST fail (422)
      const outsideEmptyDir = join(rootDir, "outside-empty");
      mkdirSync(outsideEmptyDir, { recursive: true });
      const symlinkOutsideTrusted = join(rootDir, "symlink-outside-trusted");
      symlinkSync(outsideEmptyDir, symlinkOutsideTrusted);
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: symlinkOutsideTrusted,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Symlink pointing inside repo_path MUST fail (422)
      const symTargetRepo = join(rootDir, "sym-target-repo.git");
      mkdirSync(symTargetRepo, { recursive: true });
      const symlinkInsideTrusted = join(rootDir, "symlink-inside-trusted");
      symlinkSync(symTargetRepo, symlinkInsideTrusted);
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
            repo_path: symTargetRepo,
            trusted_acceptance_dir: symlinkInsideTrusted,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // Injected DB TX2 throw during bootstrap MUST leave refs/heads/main unwritten & trustedDir unpublished
      const origCreateBootstrap = store.createProjectBootstrap.bind(store);
      store.createProjectBootstrap = async () => {
        throw new Error("INJECTED_STAGE5_TX2_FAIL");
      };
      try {
        await assert.rejects(
          () =>
            coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
              repo_path: bareRepoDir,
              trusted_acceptance_dir: trustedDir,
              acceptance_specs: acceptanceSpecs,
            }),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode >= 500
        );
      } finally {
        store.createProjectBootstrap = origCreateBootstrap;
      }
      assert.equal(existsSync(trustedDir), false);
      assert.throws(() => gitAt(bareRepoDir, ["rev-parse", "--verify", "refs/heads/main"]));

      // Clean Stage 5 bootstrap + duplicate 409 check (Minor #9)
      const bootOutcome = await coreClient.bootstrapPipelineProject(
        proj.project_id,
        authApprover,
        frozen.sessionId,
        {
          repo_path: bareRepoDir,
          trusted_acceptance_dir: trustedDir,
          acceptance_specs: acceptanceSpecs,
        }
      );
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(proj.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: join(rootDir, "trusted-dup"),
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 409
      );
      assert.equal(
        gitAt(bareRepoDir, ["rev-parse", "refs/heads/main"]).toLowerCase(),
        bootOutcome.bootstrap.base_main_commit_hash
      );

      const hooksDir = join(bareRepoDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookDest = join(hooksDir, "pre-receive");
      copyFileSync(findPreReceiveHookSource(), hookDest);
      chmodSync(hookDest, 0o755);

      // 5. Stage 6 profiles
      const devProfile = await coreClient.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "fix-dev",
        role: "DEVELOPER",
        principal_id: "coder-claude",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      const revProfile = await coreClient.upsertAgentOrganizationProfile(proj.project_id, authDev, {
        profile_key: "fix-rev",
        role: "REVIEWER_READONLY",
        principal_id: "reviewer-gemini",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "provider_managed_vm",
        trust_tier: "TIER_3_PROVIDER_VM",
      });

      // 6. M6A-FU-02 & M6B-FIX-08: Stage 7 BLOCKED_POSTCALL (402 + EXHAUSTED + 0 tasks) & TX2 persistence compensation
      const postcallCost = await coreClient.createCostSession(proj.project_id, authDev, {
        pipeline_session_id: frozen.sessionId,
        max_tokens_per_request: 100_000,
        max_cost_micro_usd_per_request: 500_000_000,
        session_token_budget: 20_000,
        session_cost_budget_micro_usd: 500_000_000,
      });
      mock.setResponseOverride("anthropic", { inputTokens: 15_000, outputTokens: 10_000 });
      try {
        await assert.rejects(
          () =>
            coreClient.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId, {
              cost_session_id: postcallCost.cost_session_id,
              max_tokens: 1,
            }),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 402
        );
      } finally {
        mock.setResponseOverride("anthropic", null);
      }
      const postcallAfter = await coreClient.getCostSession(
        proj.project_id,
        authDev,
        postcallCost.cost_session_id
      );
      assert.equal(postcallAfter.session.status, "EXHAUSTED");
      assert.equal(postcallAfter.ledgers.some((l) => l.status === "BLOCKED_POSTCALL"), true);
      const bundleAfterPostcall = await coreClient.getPipelineM6BBundle(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(bundleAfterPostcall.stage7_plan.milestones.length, 0);
      assert.equal(bundleAfterPostcall.stage7_plan.tasks.length, 0);

      // Injected Stage 7 TX2 persistence failure -> single FAILED_VALIDATION with [PERSISTENCE_FAILURE], 0 ALLOWED, 0 tasks
      const origCreateStage7 = store.createStage7DevelopmentPlan.bind(store);
      store.createStage7DevelopmentPlan = async () => {
        throw new Error("INJECTED_STAGE7_TX2_FAIL");
      };
      try {
        await assert.rejects(
          () => coreClient.runPipelineStage7Plan(proj.project_id, authDev, frozen.sessionId),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode >= 500
        );
      } finally {
        store.createStage7DevelopmentPlan = origCreateStage7;
      }
      const costAfterTx2Fail = await coreClient.getCostSession(
        proj.project_id,
        authDev,
        frozen.costSessionId
      );
      const s7Ledgers = costAfterTx2Fail.ledgers.filter((l) => l.stage === "STAGE_7_PLANNING");
      assert.equal(s7Ledgers.length, 1);
      assert.equal(s7Ledgers[0]!.status, "FAILED_VALIDATION");
      assert.ok(s7Ledgers[0]!.error_message?.startsWith("[PERSISTENCE_FAILURE] "));
      const bundleAfterTx2Fail = await coreClient.getPipelineM6BBundle(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(bundleAfterTx2Fail.stage7_plan.milestones.length, 0);
      assert.equal(bundleAfterTx2Fail.stage7_plan.tasks.length, 0);

      // 7. Valid 2-task Stage 7 plan -> Partial Coverage (66.66% Minor #1) -> Full Coverage (100%)
      mock.setStage7Override(() => ({
        milestones: [{ milestone_key: "MS-1", title: "MS1", description: "MS1" }],
        epics: [{ epic_key: "EPIC-1", milestone_key: "MS-1", title: "E1", description: "E1" }],
        stories: [
          {
            story_key: "STORY-1",
            epic_key: "EPIC-1",
            title: "Story 1",
            description: "All 3 reqs",
            requirement_ids: allReqIds,
            ac_ids: allAcIds,
          },
        ],
        tasks: [
          {
            task_key: "TASK-PART-1",
            story_key: "STORY-1",
            title: "Implement ledger & 2 reqs",
            description: "Part 1",
            requirement_ids: allReqIds.slice(0, 2),
            ac_ids: allAcIds.slice(0, 2),
            allowed_files: ["src/**", "test/**"],
            depends_on_task_keys: [],
            developer_profile_key: "fix-dev",
          },
          {
            task_key: "TASK-PART-2",
            story_key: "STORY-1",
            title: "Implement audit helper & 3rd req",
            description: "Part 2",
            requirement_ids: allReqIds.slice(2),
            ac_ids: allAcIds.slice(2),
            allowed_files: ["src/**", "test/**"],
            depends_on_task_keys: [],
            developer_profile_key: "fix-dev",
          },
        ],
        planning_notes: "2 tasks for 2/3 partial coverage proof",
      }));
      const planOut = await coreClient.runPipelineStage7Plan(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      mock.setStage7Override(null);
      assert.equal(planOut.bundle.tasks.length, 2);

      // Merge ONLY T1 -> 2 / 3 => 66.66% (truncated, not rounded to 66.67)
      await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: proj.project_id,
        taskId: planOut.bundle.tasks[0]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          {
            path: "src/ledger.mjs",
            content: `export const implementedAcIds = ${JSON.stringify(allAcIds)};\nexport function createLedgerEntry(a, c='USD'){ return { amountCents: a, currency: c }; }\n`,
          },
          {
            path: "test/part1.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { createLedgerEntry } from "../src/ledger.mjs"; assert.equal(createLedgerEntry(10).amountCents, 10);\n',
          },
        ],
        agentTestFile: "test/part1.agent.test.mjs",
      });
      const partialMatrix = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(partialMatrix.covered_requirements, 2);
      assert.equal(partialMatrix.total_requirements, 3);
      assert.equal(partialMatrix.coverage_percent, 66.66);
      assert.equal(partialMatrix.complete, false);

      // Merge T2 -> 3 / 3 => 100%
      const stage8T2 = await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: proj.project_id,
        taskId: planOut.bundle.tasks[1]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/part2.mjs", content: "export const auditReady = true;\n" },
          {
            path: "test/part2.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { auditReady } from "../src/part2.mjs"; assert.equal(auditReady, true);\n',
          },
        ],
        agentTestFile: "test/part2.agent.test.mjs",
      });
      const c2Hash = stage8T2.mergedCommitHash;
      const cleanMatrix = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(cleanMatrix.coverage_percent, 100);
      assert.equal(cleanMatrix.complete, true);

      // 8. M6B-FIX-01: Forged ?live_main_head_commit_hash & body ignored when refs/heads/main is behind
      gitAt(bareRepoDir, ["update-ref", "refs/heads/main", bootOutcome.bootstrap.base_main_commit_hash]);
      await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.updateProjectMainRefCommitHash({
            project_id: proj.project_id,
            main_ref_commit_hash: bootOutcome.bootstrap.base_main_commit_hash,
          })
      );
      const forgedTraceResp = await fetch(
        `${coreInfo.baseUrl}/api/v1/projects/${encodeURIComponent(
          proj.project_id
        )}/pipeline-sessions/${encodeURIComponent(
          frozen.sessionId
        )}/traceability?live_main_head_commit_hash=${c2Hash}`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) } }
      );
      assert.equal(forgedTraceResp.status, 200);
      const forgedTrace = (await forgedTraceResp.json()) as BidirectionalTraceabilityMatrix;
      assert.equal(forgedTrace.coverage_percent, 0);
      assert.equal(forgedTrace.complete, false);
      assert.equal(
        forgedTrace.requirement_rows.every((r) => r.stage8_lineage.every((l) => l.main_reachable === false)),
        true
      );
      const forgedRelResp = await fetch(
        `${coreInfo.baseUrl}/api/v1/projects/${encodeURIComponent(
          proj.project_id
        )}/pipeline-sessions/${encodeURIComponent(
          frozen.sessionId
        )}/release-package?live_main_head_commit_hash=${c2Hash}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: JSON.stringify({ live_main_head_commit_hash: c2Hash }),
        }
      );
      assert.equal(forgedRelResp.status, 422);

      // Restore refs/heads/main & store main_ref_commit_hash -> 100%
      gitAt(bareRepoDir, ["update-ref", "refs/heads/main", c2Hash]);
      await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.updateProjectMainRefCommitHash({
            project_id: proj.project_id,
            main_ref_commit_hash: c2Hash,
          })
      );

      // 9. M6B-FIX-06: Bidirectional orphan scans (unlinked task, Stage 3 dangling req, bootstrap dangling ac)
      const internalStore = store as unknown as {
        tasks: Map<string, Record<string, unknown>>;
        stageArtifacts: Map<string, Record<string, unknown>>;
        baselineSpecFreezes: Map<string, Record<string, unknown>>;
        projectBootstraps: Map<string, Record<string, unknown>>;
        stage1DiscoveryItems: Map<string, Record<string, unknown>>;
        verificationRuns: Map<string, Record<string, unknown>>;
      };

      // (a) Unlinked project task
      const unlinkedTask = await coreClient.createTask(proj.project_id, authDev, {
        title: "Unlinked Rogue Task",
        task_contract: {
          allowed_files: ["src/**"],
          protected_paths: [...bootOutcome.bootstrap.protected_paths],
        },
        base_main_commit_hash: c2Hash,
      });
      const matrixUnlinked = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixUnlinked.orphan_links.some(
          (o) => o.entity_type === "task" && o.entity_id === unlinkedTask.task_id
        ),
        true
      );
      assert.equal(matrixUnlinked.complete, false);
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.tasks.delete(unlinkedTask.task_id);

      // (b) Stage 3 ADR referencing unknown req_id
      const origS3Art = structuredClone(internalStore.stageArtifacts.get(frozen.s3.artifact.artifact_id)!);
      const origFreeze = structuredClone(internalStore.baselineSpecFreezes.get(frozen.baseline.baseline_id)!);
      const s3ContentMut = structuredClone(origS3Art.content_json) as {
        adrs: Array<Record<string, unknown>>;
      };
      s3ContentMut.adrs.push({
        adr_id: "ADR-ORPHAN",
        title: "Orphan ADR",
        status: "ACCEPTED",
        context: "C",
        decision: "D",
        consequences: "X",
        requirement_ids: ["REQ-ORPHAN-999"],
      });
      const newS3Sha = computeCanonicalPayloadSha256(s3ContentMut);
      internalStore.stageArtifacts.set(frozen.s3.artifact.artifact_id, {
        ...origS3Art,
        content_json: s3ContentMut,
        artifact_sha256: newS3Sha,
      });
      const updatedFreeze: Record<string, unknown> = {
        ...origFreeze,
        stage3_artifact_sha256: newS3Sha,
      };
      updatedFreeze.freeze_bundle_sha256 = computeBaselineFreezeBundleSha256(
        updatedFreeze as unknown as Parameters<typeof computeBaselineFreezeBundleSha256>[0]
      );
      internalStore.baselineSpecFreezes.set(frozen.baseline.baseline_id, updatedFreeze);
      const matrixS3Orphan = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixS3Orphan.orphan_links.some(
          (o) => o.entity_type === "stage3_adr" && o.entity_id === "ADR-ORPHAN"
        ),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.stageArtifacts.set(frozen.s3.artifact.artifact_id, origS3Art);
      internalStore.baselineSpecFreezes.set(frozen.baseline.baseline_id, origFreeze);

      // (c) Bootstrap trusted acceptance test referencing unknown ac_id
      const origBoot = structuredClone(
        internalStore.projectBootstraps.get(bootOutcome.bootstrap.bootstrap_id)!
      );
      const mutBoot = structuredClone(origBoot) as {
        acceptance_tests: Array<Record<string, unknown>>;
        bootstrap_sha256: string;
      };
      mutBoot.acceptance_tests.push({
        ac_id: "AC-ORPHAN-999",
        req_id: allReqIds[0]!,
        given: "g",
        when: "w",
        then: "t",
        test_file_path: "acceptance.test.mjs",
        component_ids: ["COMP-LEDGER-CORE"],
        expected_deliverables: ["src/ledger.mjs"],
      });
      mutBoot.bootstrap_sha256 = computeProjectBootstrapSha256(
        mutBoot as unknown as Parameters<typeof computeProjectBootstrapSha256>[0]
      );
      internalStore.projectBootstraps.set(bootOutcome.bootstrap.bootstrap_id, mutBoot);
      const matrixBootOrphan = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixBootOrphan.orphan_links.some(
          (o) => o.entity_type === "bootstrap_acceptance_test" && o.entity_id.includes("AC-ORPHAN-999")
        ),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.projectBootstraps.set(bootOutcome.bootstrap.bootstrap_id, origBoot);

      // 10. M6B-FIX-03: Stage 1 provenance item in REJECTED status breaks traceability
      const verifiedS1 = frozen.s1.discoveryItems.find(
        (d) => d.confirmation_status === "AUTO_VERIFIED" || d.confirmation_status === "CONFIRMED"
      )!;
      const origS1Item = structuredClone(internalStore.stage1DiscoveryItems.get(verifiedS1.item_id)!);
      internalStore.stage1DiscoveryItems.set(verifiedS1.item_id, {
        ...origS1Item,
        confirmation_status: "REJECTED",
      });
      const matrixS1Rejected = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixS1Rejected.missing_links.some((m) => m.stage === "STAGE_1_DISCOVERY"),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.stage1DiscoveryItems.set(verifiedS1.item_id, origS1Item);

      // 11. M6B-FIX-07: Null tier1_trusted_acceptance_passed & mismatched contract trusted_policy_sha256
      const origVr2 = structuredClone(
        internalStore.verificationRuns.get(stage8T2.verificationRun.verification_run_id)!
      );
      internalStore.verificationRuns.set(stage8T2.verificationRun.verification_run_id, {
        ...origVr2,
        tier1_trusted_acceptance_passed: null,
      });
      const matrixNullTier1 = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixNullTier1.missing_links.some((m) => m.stage === "STAGE_8_EXECUTION"),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.verificationRuns.set(stage8T2.verificationRun.verification_run_id, origVr2);

      const origTask2 = structuredClone(internalStore.tasks.get(stage8T2.task.task_id)!);
      const mutTask2Contract = {
        ...(origTask2.task_contract_json as Record<string, unknown>),
        trusted_policy_sha256: "0".repeat(64),
      };
      internalStore.tasks.set(stage8T2.task.task_id, {
        ...origTask2,
        task_contract_json: mutTask2Contract,
      });
      const matrixMismatchPolicy = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        matrixMismatchPolicy.missing_links.some((m) => m.stage === "STAGE_8_EXECUTION"),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      internalStore.tasks.set(stage8T2.task.task_id, origTask2);

      // 12. Minor #7 & M6B-FIX-05: invalid decision 23514, HTTP gap CR 422, direct store CR-PARTIAL -> STAGE_9_CHANGE_REQUEST missing & 422
      await assert.rejects(
        () =>
          coreClient.submitPipelineChangeRequest(proj.project_id, authDev, frozen.sessionId, {
            cr_key: "CR-HTTP-GAP",
            title: "Gap CR",
            rationale: "Gap rejected",
            impacted_requirement_ids: [allReqIds[0]!, allReqIds[1]!],
            proposed_tasks: [
              {
                task_key: "TASK-HTTP-ONLY-ONE",
                story_id: planOut.bundle.stories[0]!.story_id,
                title: "Only req 0",
                description: "D",
                requirement_ids: [allReqIds[0]!],
                ac_ids: [allAcIds[0]!],
                allowed_files: ["src/**", "test/**"],
              },
            ],
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const crPartial = await store.withRlsTransaction(
        {
          currentProjectId: proj.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          store.createChangeRequest({
            project_id: proj.project_id,
            pipeline_session_id: frozen.sessionId,
            baseline_id: frozen.baseline.baseline_id,
            cr_key: "CR-PARTIAL",
            title: "Bypassed Partial CR",
            rationale: "Simulates direct store gap",
            impacted_requirement_ids: [allReqIds[0]!, allReqIds[1]!],
            impacted_component_ids: [],
            proposed_tasks: [
              {
                task_key: "TASK-CR-PARTIAL",
                story_id: planOut.bundle.stories[0]!.story_id,
                title: "CR Partial Task",
                description: "Only touches req 0",
                requirement_ids: [allReqIds[0]!],
                ac_ids: [allAcIds[0]!],
                allowed_files: ["src/**", "test/**"],
              },
            ],
            requested_by_principal_id: "alice-dev",
          })
      );

      await assert.rejects(
        () =>
          store.withRlsTransaction(
            {
              currentProjectId: proj.project_id,
              currentPrincipalId: "bob-approver",
              currentRole: "core_api_service",
            },
            () =>
              store.decideChangeRequest({
                project_id: proj.project_id,
                cr_id: crPartial.cr_id,
                decision: "INVALID" as "APPROVED",
                decided_by_principal_id: "bob-approver",
              })
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );

      await coreClient.decidePipelineChangeRequest(
        proj.project_id,
        authApprover,
        frozen.sessionId,
        crPartial.cr_id,
        { decision: "APPROVED" }
      );
      const appliedPartial = await coreClient.applyPipelineChangeRequest(
        proj.project_id,
        authDev,
        frozen.sessionId,
        crPartial.cr_id
      );
      await runFullStage8ToCasMerge({
        store,
        coreClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir: trustedDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: proj.project_id,
        taskId: appliedPartial.tasks[0]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/cr-partial.mjs", content: "export const crPartialDone = true;\n" },
          {
            path: "test/cr-partial.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { crPartialDone } from "../src/cr-partial.mjs"; assert.equal(crPartialDone, true);\n',
          },
        ],
        agentTestFile: "test/cr-partial.agent.test.mjs",
      });

      const matrixPartialCr = await coreClient.getPipelineTraceabilityMatrix(
        proj.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(matrixPartialCr.complete, false);
      assert.equal(
        matrixPartialCr.missing_links.some(
          (m) => m.stage === "STAGE_9_CHANGE_REQUEST" && m.req_id === allReqIds[1]!
        ),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(proj.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
    } finally {
      await Promise.allSettled([webHttp.stop(), coreHttp.stop(), gatewayHttp.close(), mock.close()]);
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("M6B-FIX-PG: Live PostgreSQL 17 M6B-FIX-01/03/05/06/07/08/09, Minor #1/#7/#9 & M6A-FU-04 Stage 7 Rollback", async (t) => {
    const pgConfig = buildPostgresPoolConfigFromEnv();
    if (!pgConfig) {
      t.skip("PostgreSQL connection env (PGHOST/DATABASE_URL) not configured on local workstation");
      return;
    }

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
          // next candidate
        }
      }
      return null;
    })();
    if (!psqlBin && process.env.CI) {
      assert.fail("psql CLI binary is required in CI for M6B-FIX-PG");
    }

    const runOwnerSql = (sql: string): void => {
      if (!psqlBin) {
        throw new Error("psqlBin unavailable for owner SQL");
      }
      execFileSync(psqlBin, ["-v", "ON_ERROR_STOP=1"], {
        cwd: repoRoot,
        input: sql,
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
    };

    const pool = new PostgresRuntimePool({ ...pgConfig, maxConnections: 8 });
    const repo = new PostgresControlPlaneRepository(pool);
    const mock = await startMockModelProviderServers();
    const rootDir = mkdtempSync(join(tmpdir(), "sf-m6b-fix-pg-"));
    const bareRepoDir = join(rootDir, "pg-fix-a.git");
    const trustedAcceptanceDir = join(rootDir, "pg-fix-trusted");
    const worktreeBaseDir = join(rootDir, "worktrees");
    const outboxDir = join(rootDir, "outbox");
    const snapshotDir = join(rootDir, "snapshots");
    mkdirSync(worktreeBaseDir, { recursive: true });
    mkdirSync(outboxDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });

    const createdProjIds: string[] = [];
    const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotDir });
    const verifier = new Docker3TierVerifier({ snapshotStore });
    const tokenService = new EphemeralGitPushTokenService();
    const reviewerCredService = new EphemeralReviewerCredentialService();

    const coreApi = new CoreApiService(repo, {
      env: {},
      snapshotStore,
      defaultModelConfig: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "test-anthropic-key-local",
        baseUrl: mock.anthropicBaseUrl,
      },
    });
    const coreHttp = new CoreApiHttpServer({ coreApi, snapshotStore, defaultVerifier: verifier });
    const webHttp = new WebApprovalConsoleHttpServer({ coreApi });
    let gatewayHttp: AgentGatewayHttpServer | null = null;
    let coreWithGw: CoreApiHttpServer | null = null;

    try {
      const coreInfo = await coreHttp.start();
      const webInfo = await webHttp.start();
      const coreClient = new HttpCoreApiClient(coreInfo.baseUrl);
      const dockerProbe = probeDockerVerifierSupport("node:22-alpine");
      const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;

      const projA = await repo.withRlsTransaction(
        { currentRole: "system_admin_role", currentPrincipalId: "pg-admin" },
        async () => {
          const p = await repo.createProject({
            slug: `m6b-fix-pg-${randomUUID().slice(0, 8)}`,
            name: "PG M6B Fix Project",
            repo_bare_path: bareRepoDir,
            initial_main_commit_hash: "1".repeat(40),
            initial_main_tree_hash: "2".repeat(40),
          });
          createdProjIds.push(p.project_id);
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "alice-dev",
            member_role: "DEVELOPER",
          });
          await repo.addProjectMembership({
            project_id: p.project_id,
            principal_id: "bob-approver",
            member_role: "PROJECT_APPROVER",
          });
          return p;
        }
      );

      const authDev = coreApi.issueAuthContext({
        projectId: projA.project_id,
        principalId: "alice-dev",
        roles: ["DEVELOPER"],
      });
      const authApprover = coreApi.issueAuthContext({
        projectId: projA.project_id,
        principalId: "bob-approver",
        roles: ["PROJECT_APPROVER"],
      });

      const gatewayService = new AgentGatewayService({
        store: repo,
        projectId: projA.project_id,
        reviewerCredentialService: reviewerCredService,
      });
      gatewayHttp = new AgentGatewayHttpServer({ store: repo, tokenService });
      coreWithGw = new CoreApiHttpServer({
        coreApi,
        snapshotStore,
        defaultVerifier: verifier,
        defaultAgentGateway: gatewayService,
      });
      const gwInfo = await gatewayHttp.start();
      const coreGwInfo = await coreWithGw.start();
      const gwClient = new HttpCoreApiClient(coreGwInfo.baseUrl);

      const frozen = await advanceToFrozenBaseline({
        client: coreClient,
        projectId: projA.project_id,
        authDev,
        authApprover,
        title: "PG M6B Fixes Pipeline",
      });
      const parsedS2 = frozen.s2.parsed as unknown as Stage2RequirementsSpec;
      const s2Reqs = [
        ...parsedS2.srs.functional_requirements,
        ...parsedS2.srs.non_functional_requirements,
      ];
      const allReqIds = s2Reqs.map((r) => r.req_id);
      const allAcIds = s2Reqs.flatMap((r) => r.acceptance_criteria.map((a) => a.ac_id));
      const acceptanceSpecs: Record<
        string,
        { target_file: string; export_name?: string; assertion_lines?: string[] }
      > = {};
      for (const acId of allAcIds) {
        acceptanceSpecs[acId] = {
          target_file: "src/ledger.mjs",
          export_name: "createLedgerEntry",
          assertion_lines: [
            `assert.equal(mod.implementedAcIds.includes(${JSON.stringify(acId)}), true);`,
          ],
        };
      }

      // 1. M6B-FIX-09 & Minor #9 on PG
      mkdirSync(trustedAcceptanceDir, { recursive: true });
      const leftoverPg = join(trustedAcceptanceDir, "leftover-pg.txt");
      writeFileSync(leftoverPg, "pg-keep\n", "utf8");
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(projA.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: trustedAcceptanceDir,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );
      assert.equal(readFileSync(leftoverPg, "utf8"), "pg-keep\n");
      rmSync(trustedAcceptanceDir, { recursive: true, force: true });

      const pgSymOutside = join(rootDir, "pg-outside-empty");
      mkdirSync(pgSymOutside, { recursive: true });
      const pgSymTrusted = join(rootDir, "pg-sym-trusted");
      symlinkSync(pgSymOutside, pgSymTrusted);
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(projA.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: pgSymTrusted,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const pgSymRepoTarget = join(rootDir, "pg-sym-target-repo.git");
      mkdirSync(pgSymRepoTarget, { recursive: true });
      const pgSymInsideTrusted = join(rootDir, "pg-sym-inside-trusted");
      symlinkSync(pgSymRepoTarget, pgSymInsideTrusted);
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(projA.project_id, authApprover, frozen.sessionId, {
            repo_path: pgSymRepoTarget,
            trusted_acceptance_dir: pgSymInsideTrusted,
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      const bootOutcome = await coreClient.bootstrapPipelineProject(
        projA.project_id,
        authApprover,
        frozen.sessionId,
        {
          repo_path: bareRepoDir,
          trusted_acceptance_dir: trustedAcceptanceDir,
          acceptance_specs: acceptanceSpecs,
        }
      );
      await assert.rejects(
        () =>
          coreClient.bootstrapPipelineProject(projA.project_id, authApprover, frozen.sessionId, {
            repo_path: bareRepoDir,
            trusted_acceptance_dir: join(rootDir, "pg-trusted-dup"),
            acceptance_specs: acceptanceSpecs,
          }),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 409
      );
      assert.equal(
        gitAt(bareRepoDir, ["rev-parse", "refs/heads/main"]).toLowerCase(),
        bootOutcome.bootstrap.base_main_commit_hash
      );

      const hooksDir = join(bareRepoDir, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookDest = join(hooksDir, "pre-receive");
      copyFileSync(findPreReceiveHookSource(), hookDest);
      chmodSync(hookDest, 0o755);

      const devProfile = await coreClient.upsertAgentOrganizationProfile(projA.project_id, authDev, {
        profile_key: "pg-fix-dev",
        role: "DEVELOPER",
        principal_id: "pg-coder",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        execution_target_type: "factory_managed_worker",
        trust_tier: "TIER_1_FACTORY_MANAGED",
      });
      const revProfile = await coreClient.upsertAgentOrganizationProfile(projA.project_id, authDev, {
        profile_key: "pg-fix-rev",
        role: "REVIEWER_READONLY",
        principal_id: "pg-reviewer",
        provider: "google",
        model: "gemini-2.5-pro",
        execution_target_type: "provider_managed_vm",
        trust_tier: "TIER_3_PROVIDER_VM",
      });

      // 2. M6A-FU-04 on live PG: bare repo.createStage7DevelopmentPlan rolls back completely on FK violation (23503)
      await assert.rejects(
        () =>
          repo.createStage7DevelopmentPlan({
            project_id: projA.project_id,
            pipeline_session_id: frozen.sessionId,
            baseline_id: frozen.baseline.baseline_id,
            bootstrap_id: bootOutcome.bootstrap.bootstrap_id,
            base_main_commit_hash: bootOutcome.bootstrap.base_main_commit_hash,
            milestones: [
              { milestone_key: "MS-RB", title: "Rollback", description: "Should rollback", sequence_order: 1 },
            ],
            epics: [
              {
                epic_key: "EP-RB",
                milestone_key: "MS-RB",
                title: "Epic",
                description: "Should rollback",
                sequence_order: 1,
              },
            ],
            stories: [
              {
                story_key: "ST-RB",
                epic_key: "EP-RB",
                title: "Story",
                description: "Should rollback",
                requirement_ids: allReqIds,
                ac_ids: allAcIds,
                sequence_order: 1,
              },
            ],
            tasks: [
              {
                story_key: "ST-RB",
                title: "FK violation rolls back entire Stage 7 TX",
                requirement_ids: allReqIds,
                ac_ids: allAcIds,
                assigned_profile_id: randomUUID(),
                task_contract: {
                  allowed_files: ["src/**"],
                  protected_paths: [...bootOutcome.bootstrap.protected_paths],
                  trusted_policy_sha256: bootOutcome.bootstrap.trusted_policy_sha256,
                },
              },
            ],
          }),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23503"
      );
      await pool.withRlsTransaction(
        {
          currentProjectId: projA.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        async (conn) => {
          for (const check of [
            {
              sql: "SELECT count(*)::text AS cnt FROM dev_milestones WHERE pipeline_session_id = $1::uuid;",
              params: [frozen.sessionId],
            },
            {
              sql: "SELECT count(*)::text AS cnt FROM dev_epics e JOIN dev_milestones m ON m.milestone_id = e.milestone_id WHERE m.pipeline_session_id = $1::uuid;",
              params: [frozen.sessionId],
            },
            {
              sql: "SELECT count(*)::text AS cnt FROM dev_user_stories s JOIN dev_epics e ON e.epic_id = s.epic_id JOIN dev_milestones m ON m.milestone_id = e.milestone_id WHERE m.pipeline_session_id = $1::uuid;",
              params: [frozen.sessionId],
            },
            {
              sql: "SELECT count(*)::text AS cnt FROM tasks WHERE project_id = $1::uuid;",
              params: [projA.project_id],
            },
            {
              sql: "SELECT count(*)::text AS cnt FROM task_plan_links WHERE pipeline_session_id = $1::uuid;",
              params: [frozen.sessionId],
            },
          ]) {
            const res = await conn.query<{ cnt: string }>(check.sql, check.params);
            assert.equal(res.rows[0]!.cnt, "0", `Expected 0 rows after Stage 7 rollback for ${check.sql}`);
          }
        }
      );

      // 3. M6A-FU-02 & M6B-FIX-08 on live PG: Stage 7 BLOCKED_POSTCALL (402 + EXHAUSTED + 0 rows)
      const pgPostcallCost = await coreClient.createCostSession(projA.project_id, authDev, {
        pipeline_session_id: frozen.sessionId,
        max_tokens_per_request: 100_000,
        max_cost_micro_usd_per_request: 500_000_000,
        session_token_budget: 20_000,
        session_cost_budget_micro_usd: 500_000_000,
      });
      mock.setResponseOverride("anthropic", { inputTokens: 15_000, outputTokens: 10_000 });
      try {
        await assert.rejects(
          () =>
            coreClient.runPipelineStage7Plan(projA.project_id, authDev, frozen.sessionId, {
              cost_session_id: pgPostcallCost.cost_session_id,
              max_tokens: 1,
            }),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 402
        );
      } finally {
        mock.setResponseOverride("anthropic", null);
      }
      const pgPostcallAfter = await coreClient.getCostSession(
        projA.project_id,
        authDev,
        pgPostcallCost.cost_session_id
      );
      assert.equal(pgPostcallAfter.session.status, "EXHAUSTED");
      assert.equal(pgPostcallAfter.ledgers.some((l) => l.status === "BLOCKED_POSTCALL"), true);

      // 4. Minor #1 on PG: 2-task Stage 7 -> 66.66% after T1 -> 100% after T2
      mock.setStage7Override(() => ({
        milestones: [{ milestone_key: "MS-PG", title: "PG MS", description: "PG MS" }],
        epics: [{ epic_key: "EPIC-PG", milestone_key: "MS-PG", title: "PG E", description: "PG E" }],
        stories: [
          {
            story_key: "STORY-PG",
            epic_key: "EPIC-PG",
            title: "PG Story",
            description: "All 3 reqs",
            requirement_ids: allReqIds,
            ac_ids: allAcIds,
          },
        ],
        tasks: [
          {
            task_key: "TASK-PG-1",
            story_key: "STORY-PG",
            title: "PG Part 1",
            description: "2 reqs",
            requirement_ids: allReqIds.slice(0, 2),
            ac_ids: allAcIds.slice(0, 2),
            allowed_files: ["src/**", "test/**"],
            depends_on_task_keys: [],
            developer_profile_key: "pg-fix-dev",
          },
          {
            task_key: "TASK-PG-2",
            story_key: "STORY-PG",
            title: "PG Part 2",
            description: "1 req",
            requirement_ids: allReqIds.slice(2),
            ac_ids: allAcIds.slice(2),
            allowed_files: ["src/**", "test/**"],
            depends_on_task_keys: [],
            developer_profile_key: "pg-fix-dev",
          },
        ],
        planning_notes: "PG 2/3 partial proof",
      }));
      const planOut = await coreClient.runPipelineStage7Plan(projA.project_id, authDev, frozen.sessionId);
      mock.setStage7Override(null);
      assert.equal(planOut.bundle.tasks.length, 2);

      const stage8T1 = await runFullStage8ToCasMerge({
        store: repo,
        coreClient: gwClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: projA.project_id,
        taskId: planOut.bundle.tasks[0]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          {
            path: "src/ledger.mjs",
            content: `export const implementedAcIds = ${JSON.stringify(allAcIds)};\nexport function createLedgerEntry(a, c='USD'){ return { amountCents: a, currency: c }; }\n`,
          },
          {
            path: "test/pg1.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { createLedgerEntry } from "../src/ledger.mjs"; assert.equal(createLedgerEntry(7).amountCents, 7);\n',
          },
        ],
        agentTestFile: "test/pg1.agent.test.mjs",
      });
      const partialPgTrace = await coreClient.getPipelineTraceabilityMatrix(
        projA.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(partialPgTrace.coverage_percent, 66.66);
      assert.equal(partialPgTrace.complete, false);

      const stage8T2 = await runFullStage8ToCasMerge({
        store: repo,
        coreClient: gwClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: projA.project_id,
        taskId: planOut.bundle.tasks[1]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/pg2.mjs", content: "export const pgPart2 = true;\n" },
          {
            path: "test/pg2.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { pgPart2 } from "../src/pg2.mjs"; assert.equal(pgPart2, true);\n',
          },
        ],
        agentTestFile: "test/pg2.agent.test.mjs",
      });
      const c2Hash = stage8T2.mergedCommitHash;

      // 5. M6B-FIX-01 on PG: forged live_main_head_commit_hash rejected when real main ref is behind
      gitAt(bareRepoDir, ["update-ref", "refs/heads/main", bootOutcome.bootstrap.base_main_commit_hash]);
      await repo.updateProjectMainRefCommitHash({
        project_id: projA.project_id,
        main_ref_commit_hash: bootOutcome.bootstrap.base_main_commit_hash,
      });
      const pgForgedResp = await fetch(
        `${coreInfo.baseUrl}/api/v1/projects/${encodeURIComponent(
          projA.project_id
        )}/pipeline-sessions/${encodeURIComponent(
          frozen.sessionId
        )}/traceability?live_main_head_commit_hash=${c2Hash}`,
        { headers: { [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover) } }
      );
      assert.equal(pgForgedResp.status, 200);
      const pgForgedTrace = (await pgForgedResp.json()) as BidirectionalTraceabilityMatrix;
      assert.equal(pgForgedTrace.coverage_percent, 0);
      assert.equal(pgForgedTrace.complete, false);
      const pgForgedRel = await fetch(
        `${coreInfo.baseUrl}/api/v1/projects/${encodeURIComponent(
          projA.project_id
        )}/pipeline-sessions/${encodeURIComponent(
          frozen.sessionId
        )}/release-package?live_main_head_commit_hash=${c2Hash}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [CORE_API_AUTH_HEADER]: encodeCoreApiAuthHeader(authApprover),
          },
          body: JSON.stringify({ live_main_head_commit_hash: c2Hash }),
        }
      );
      assert.equal(pgForgedRel.status, 422);

      gitAt(bareRepoDir, ["update-ref", "refs/heads/main", c2Hash]);
      await repo.updateProjectMainRefCommitHash({
        project_id: projA.project_id,
        main_ref_commit_hash: c2Hash,
      });

      // 6. M6B-FIX-07 on PG via owner SQL probes (null tier1 + mismatched contract policy SHA)
      if (psqlBin) {
        const vr1Id = stage8T1.verificationRun.verification_run_id;
        const t1Id = stage8T1.task.task_id;
        runOwnerSql(
          `UPDATE verification_runs SET tier1_trusted_acceptance_passed = NULL WHERE verification_run_id = '${vr1Id}';`
        );
        const pgNullTier1 = await coreClient.getPipelineTraceabilityMatrix(
          projA.project_id,
          authDev,
          frozen.sessionId
        );
        assert.equal(
          pgNullTier1.missing_links.some((m) => m.stage === "STAGE_8_EXECUTION"),
          true
        );
        await assert.rejects(
          () => coreClient.issuePipelineReleasePackage(projA.project_id, authApprover, frozen.sessionId),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
        );
        runOwnerSql(
          `UPDATE verification_runs SET tier1_trusted_acceptance_passed = TRUE WHERE verification_run_id = '${vr1Id}';`
        );

        runOwnerSql(
          `UPDATE tasks SET task_contract_json = jsonb_set(task_contract_json, '{trusted_policy_sha256}', '"0000000000000000000000000000000000000000000000000000000000000000"') WHERE task_id = '${t1Id}';`
        );
        const pgBadContractSha = await coreClient.getPipelineTraceabilityMatrix(
          projA.project_id,
          authDev,
          frozen.sessionId
        );
        assert.equal(
          pgBadContractSha.missing_links.some((m) => m.stage === "STAGE_8_EXECUTION"),
          true
        );
        await assert.rejects(
          () => coreClient.issuePipelineReleasePackage(projA.project_id, authApprover, frozen.sessionId),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
        );
        runOwnerSql(
          `UPDATE tasks SET task_contract_json = jsonb_set(task_contract_json, '{trusted_policy_sha256}', '"${bootOutcome.bootstrap.trusted_policy_sha256}"') WHERE task_id = '${t1Id}';`
        );
      }

      // 7. M6B-FIX-05 on PG: direct repo.createChangeRequest gap CR -> apply & merge -> STAGE_9_CHANGE_REQUEST missing & 422
      const crPgPartial = await repo.withRlsTransaction(
        {
          currentProjectId: projA.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        () =>
          repo.createChangeRequest({
            project_id: projA.project_id,
            pipeline_session_id: frozen.sessionId,
            baseline_id: frozen.baseline.baseline_id,
            cr_key: "CR-PG-PARTIAL",
            title: "PG Partial CR",
            rationale: "Direct store gap",
            impacted_requirement_ids: [allReqIds[0]!, allReqIds[1]!],
            impacted_component_ids: [],
            proposed_tasks: [
              {
                task_key: "TASK-PG-CR-PARTIAL",
                story_id: planOut.bundle.stories[0]!.story_id,
                title: "PG CR task",
                description: "Covers req 0 only",
                requirement_ids: [allReqIds[0]!],
                ac_ids: [allAcIds[0]!],
                allowed_files: ["src/**", "test/**"],
              },
            ],
            requested_by_principal_id: "alice-dev",
          })
      );
      await coreClient.decidePipelineChangeRequest(
        projA.project_id,
        authApprover,
        frozen.sessionId,
        crPgPartial.cr_id,
        { decision: "APPROVED" }
      );
      const appliedPgPartial = await coreClient.applyPipelineChangeRequest(
        projA.project_id,
        authDev,
        frozen.sessionId,
        crPgPartial.cr_id
      );
      await runFullStage8ToCasMerge({
        store: repo,
        coreClient: gwClient,
        webBaseUrl: webInfo.baseUrl,
        tokenService,
        gatewayBaseUrl: gwInfo.baseUrl,
        preReceiveUrl: gwInfo.url,
        bareRepoDir,
        trustedAcceptanceDir,
        expectedTrustedPolicySha256: bootOutcome.bootstrap.trusted_policy_sha256,
        worktreeBaseDir,
        outboxDir,
        useDocker,
        projectId: projA.project_id,
        taskId: appliedPgPartial.tasks[0]!.task_id,
        authDev,
        authApprover,
        developerProfile: devProfile,
        reviewerProfile: revProfile,
        edits: [
          { path: "src/pg-cr.mjs", content: "export const pgCr = true;\n" },
          {
            path: "test/pg-cr.agent.test.mjs",
            content:
              'import assert from "node:assert/strict"; import { pgCr } from "../src/pg-cr.mjs"; assert.equal(pgCr, true);\n',
          },
        ],
        agentTestFile: "test/pg-cr.agent.test.mjs",
      });
      const pgPartialCrTrace = await coreClient.getPipelineTraceabilityMatrix(
        projA.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(pgPartialCrTrace.complete, false);
      assert.equal(
        pgPartialCrTrace.missing_links.some(
          (m) => m.stage === "STAGE_9_CHANGE_REQUEST" && m.req_id === allReqIds[1]!
        ),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(projA.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // 8. Minor #7 on PG: invalid decision 23514 & concurrent decideChangeRequest FOR UPDATE serialization
      await assert.rejects(
        () =>
          repo.withRlsTransaction(
            {
              currentProjectId: projA.project_id,
              currentPrincipalId: "bob-approver",
              currentRole: "core_api_service",
            },
            () =>
              repo.decideChangeRequest({
                project_id: projA.project_id,
                cr_id: crPgPartial.cr_id,
                decision: "INVALID" as "APPROVED",
                decided_by_principal_id: "bob-approver",
              })
          ),
        (err: unknown) => err instanceof PostgresRlsError && err.sqlState === "23514"
      );

      const crRace = await coreClient.submitPipelineChangeRequest(
        projA.project_id,
        authDev,
        frozen.sessionId,
        {
          cr_key: "CR-PG-RACE",
          title: "PG Concurrent Decision Race",
          rationale: "Ensure single winner and single decided outbox event",
          impacted_requirement_ids: [allReqIds[0]!],
          proposed_tasks: [
            {
              task_key: "TASK-PG-RACE",
              story_id: planOut.bundle.stories[0]!.story_id,
              title: "Race Task",
              description: "Test",
              requirement_ids: [allReqIds[0]!],
              ac_ids: [allAcIds[0]!],
              allowed_files: ["src/**", "test/**"],
            },
          ],
        }
      );
      const raceResults = await Promise.allSettled([
        coreClient.decidePipelineChangeRequest(
          projA.project_id,
          authApprover,
          frozen.sessionId,
          crRace.cr_id,
          { decision: "APPROVED", decision_rationale: "race-approve" }
        ),
        coreClient.decidePipelineChangeRequest(
          projA.project_id,
          authApprover,
          frozen.sessionId,
          crRace.cr_id,
          { decision: "REJECTED", decision_rationale: "race-reject" }
        ),
      ]);
      const fulfilledRace = raceResults.filter((r) => r.status === "fulfilled");
      const rejectedRace = raceResults.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      assert.equal(fulfilledRace.length, 1);
      assert.equal(rejectedRace.length, 1);
      assert.ok(
        rejectedRace[0]!.reason instanceof HttpCoreApiError &&
          (rejectedRace[0]!.reason.statusCode === 422 || rejectedRace[0]!.reason.statusCode === 409)
      );
      await pool.withRlsTransaction(
        {
          currentProjectId: projA.project_id,
          currentPrincipalId: "alice-dev",
          currentRole: "core_api_service",
        },
        async (conn) => {
          const outRes = await conn.query<{ cnt: string }>(
            `SELECT count(*)::text AS cnt
             FROM outbox_events
             WHERE project_id = $1::uuid
               AND aggregate_id = $2::uuid
               AND event_type IN ('change_request.approved', 'change_request.rejected');`,
            [projA.project_id, crRace.cr_id]
          );
          assert.equal(outRes.rows[0]!.cnt, "1");
        }
      );

      // 9. M6B-FIX-06 on PG: unlinked task detected in orphan_links & blocks Release Acceptance (422)
      const unlinkedPgTask = await gwClient.createTask(projA.project_id, authDev, {
        title: "PG Unlinked Task",
        task_contract: {
          allowed_files: ["src/**"],
          protected_paths: [...bootOutcome.bootstrap.protected_paths],
        },
        base_main_commit_hash: c2Hash,
      });
      const pgOrphanTrace = await coreClient.getPipelineTraceabilityMatrix(
        projA.project_id,
        authDev,
        frozen.sessionId
      );
      assert.equal(
        pgOrphanTrace.orphan_links.some(
          (o) => o.entity_type === "task" && o.entity_id === unlinkedPgTask.task_id
        ),
        true
      );
      await assert.rejects(
        () => coreClient.issuePipelineReleasePackage(projA.project_id, authApprover, frozen.sessionId),
        (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
      );

      // 10. M6B-FIX-03 on PG: missing Stage 1 provenance item triggers STAGE_1_DISCOVERY gap & 422
      if (psqlBin) {
        const verifiedS1Pg = frozen.s1.discoveryItems.find(
          (d) => d.confirmation_status === "AUTO_VERIFIED"
        )!;
        runOwnerSql(`DELETE FROM stage1_discovery_items WHERE item_id = '${verifiedS1Pg.item_id}';`);
        const pgMissingS1Trace = await coreClient.getPipelineTraceabilityMatrix(
          projA.project_id,
          authDev,
          frozen.sessionId
        );
        assert.equal(
          pgMissingS1Trace.missing_links.some((m) => m.stage === "STAGE_1_DISCOVERY"),
          true
        );
        await assert.rejects(
          () =>
            coreClient.issuePipelineReleasePackage(projA.project_id, authApprover, frozen.sessionId),
          (err: unknown) => err instanceof HttpCoreApiError && err.statusCode === 422
        );
      }

      assert.ok(pool.getStats().discardAllExecuted > 0);
    } finally {
      await Promise.allSettled([
        coreWithGw?.stop(),
        gatewayHttp?.close(),
        webHttp.stop(),
        coreHttp.stop(),
        mock.close(),
      ]);
      if (psqlBin) {
        for (const pid of createdProjIds) {
          try {
            runOwnerSql(`
              BEGIN;
              UPDATE product_pipeline_sessions SET frozen_baseline_id = NULL WHERE project_id = '${pid}';
              DELETE FROM release_acceptance_packages WHERE project_id = '${pid}';
              DELETE FROM task_plan_links WHERE project_id = '${pid}';
              DELETE FROM change_requests WHERE project_id = '${pid}';
              DELETE FROM dev_user_stories WHERE project_id = '${pid}';
              DELETE FROM dev_epics WHERE project_id = '${pid}';
              DELETE FROM dev_milestones WHERE project_id = '${pid}';
              DELETE FROM project_bootstraps WHERE project_id = '${pid}';
              DELETE FROM agent_organization_profiles WHERE project_id = '${pid}';
              DELETE FROM baseline_spec_freezes WHERE project_id = '${pid}';
              DELETE FROM stage_approval_gates WHERE project_id = '${pid}';
              DELETE FROM stage_artifacts WHERE project_id = '${pid}';
              DELETE FROM stage1_discovery_items WHERE project_id = '${pid}';
              DELETE FROM model_call_ledgers WHERE project_id = '${pid}';
              DELETE FROM product_pipeline_sessions WHERE project_id = '${pid}';
              DELETE FROM model_cost_sessions WHERE project_id = '${pid}';
              DELETE FROM resource_usage_metrics WHERE project_id = '${pid}';
              DELETE FROM merge_operations WHERE project_id = '${pid}';
              DELETE FROM approval_decisions WHERE project_id = '${pid}';
              DELETE FROM approval_requests WHERE project_id = '${pid}';
              DELETE FROM review_artifacts WHERE project_id = '${pid}';
              DELETE FROM review_sessions WHERE project_id = '${pid}';
              DELETE FROM verification_runs WHERE project_id = '${pid}';
              DELETE FROM merge_candidates WHERE project_id = '${pid}';
              DELETE FROM verified_code_imports WHERE project_id = '${pid}';
              DELETE FROM processed_worker_events WHERE project_id = '${pid}';
              DELETE FROM task_leases WHERE project_id = '${pid}';
              DELETE FROM tasks WHERE project_id = '${pid}';
              DELETE FROM outbox_events WHERE project_id = '${pid}';
              DELETE FROM audit_logs WHERE project_id = '${pid}';
              DELETE FROM project_memberships WHERE project_id = '${pid}';
              DELETE FROM projects WHERE project_id = '${pid}';
              COMMIT;
            `);
          } catch {
            // best-effort cleanup
          }
        }
      }
      await pool.close();
      restoreWritableRecursive(rootDir);
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

