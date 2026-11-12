import { randomUUID } from "node:crypto";
import {
  type CostGuardRecorder,
  type LiveModelProviderClient,
  ManagedModelProviderExecutor,
  type ModelProviderConfig,
  type PromptRegistry,
  createModelProviderClient,
  loadModelProviderConfigFromEnv,
} from "@software-factory/adapter-sdk";
import {
  Ac10ViolationError,
  type ControlPlaneStore,
  PostgresRlsError,
  validateStage2Ac10References,
} from "@software-factory/database";
import {
  type AgentOrgRole,
  type AgentOrganizationProfileRecord,
  type BaselineSpecFreezeRecord,
  type BidirectionalTraceabilityMatrix,
  type ChangeRequestRecord,
  type CostSessionRecord,
  type M6BStages5To9Bundle,
  type ModelCallLedgerRecord,
  type ModelPricingRate,
  type PipelineStageName,
  type ProductPipelineBundle,
  type ProductPipelineSessionRecord,
  type ReleaseAcceptancePackageRecord,
  type Stage1DiscoveryBundle,
  type Stage1DiscoveryItemRecord,
  type Stage4ConsistencyReport,
  type StageApprovalGateRecord,
  type StageApprovalGateStage,
  type StageArtifactRecord,
  type TaskPlanLinkRecord,
  type TaskRecord,
} from "@software-factory/shared-types";
import {
  type RunStage5ProjectBootstrapInput,
  type Stage5BootstrapOutcome,
  runStage5ProjectBootstrap,
} from "./bootstrapper.ts";
import { runCrossArtifactConsistencyCheck } from "./consistency-checker.ts";
import {
  type RunStage7DevelopmentPlanInput,
  type Stage6ReviewerPairOutcome,
  type Stage7PlanExecutionOutcome,
  type UpsertAgentOrganizationProfileServiceInput,
  type ValidateStage6ReviewerPairInput,
  listAgentOrganizationProfilesService,
  runStage7DevelopmentPlan,
  upsertAgentOrganizationProfileService,
  validateStage6ReviewerPairService,
} from "./planning-service.ts";
import {
  STAGE1_DISCOVERY_PROMPT_ID,
  STAGE2_REQUIREMENTS_PROMPT_ID,
  STAGE3_ARCHITECTURE_PROMPT_ID,
  STAGE4_CONSISTENCY_CHECK_PROMPT_ID,
  STAGE4_CONSISTENCY_CHECK_PROMPT_SHA256,
  STAGE4_CONSISTENCY_CHECK_PROMPT_VERSION,
  createDefaultPipelinePromptRegistry,
} from "./prompts.ts";
import {
  type ApplyChangeRequestServiceInput,
  type DecideChangeRequestServiceInput,
  type IssueReleaseAcceptanceServiceInput,
  type SubmitChangeRequestServiceInput,
  applyChangeRequestService,
  decideChangeRequestService,
  getBidirectionalTraceabilityMatrixService,
  getM6BStages5To9BundleService,
  issueReleaseAcceptancePackageService,
  submitChangeRequestService,
} from "./traceability.ts";

const GATE_STAGE_TO_ARTIFACT_STAGE: Readonly<
  Record<StageApprovalGateStage, PipelineStageName>
> = {
  STAGE_1_DISCOVERY: "STAGE_1_IDEA_DISCOVERY",
  STAGE_2_REQUIREMENTS: "STAGE_2_REQUIREMENTS",
  STAGE_3_ARCHITECTURE: "STAGE_3_ARCHITECTURE",
  STAGE_4_SPEC_FREEZE: "STAGE_4_SPEC_FREEZE",
};

function findLatestArtifactForStage(
  artifacts: readonly StageArtifactRecord[],
  stage: PipelineStageName
): StageArtifactRecord | null {
  let latest: StageArtifactRecord | null = null;
  for (const art of artifacts) {
    if (art.stage !== stage) continue;
    if (!latest || art.version >= latest.version) {
      latest = art;
    }
  }
  return latest;
}

export interface ProductPipelineServiceOptions {
  readonly store: ControlPlaneStore;
  readonly promptRegistry?: PromptRegistry;
  readonly defaultModelConfig?: ModelProviderConfig;
  readonly defaultModelExecutor?: ManagedModelProviderExecutor;
  readonly pricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CreateCostSessionServiceInput {
  readonly cost_session_id?: string;
  readonly project_id: string;
  readonly actor_principal_id: string;
  readonly pipeline_session_id?: string | null;
  readonly task_id?: string | null;
  readonly max_tokens_per_request: number;
  readonly max_cost_micro_usd_per_request: number;
  readonly session_token_budget: number;
  readonly session_cost_budget_micro_usd: number;
}

export interface CreatePipelineSessionServiceInput {
  readonly pipeline_session_id?: string;
  readonly project_id: string;
  readonly cost_session_id?: string | null;
  readonly cost_budget?: {
    readonly cost_session_id?: string;
    readonly max_tokens_per_request: number;
    readonly max_cost_micro_usd_per_request: number;
    readonly session_token_budget: number;
    readonly session_cost_budget_micro_usd: number;
  };
  readonly title: string;
  readonly raw_idea_text: string;
  readonly created_by_principal_id: string;
}

export interface RunModelStageOptions {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly actor_principal_id: string;
  readonly cost_session_id?: string;
  readonly prompt_version?: string;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly model_config?: ModelProviderConfig;
  readonly model_executor?: ManagedModelProviderExecutor;
  readonly model_client?: LiveModelProviderClient;
}

export interface StageExecutionOutcome<TParsed> {
  readonly session: ProductPipelineSessionRecord;
  readonly artifact: StageArtifactRecord;
  readonly parsed: TParsed;
  readonly ledger: ModelCallLedgerRecord;
  readonly costSession: CostSessionRecord;
}

export interface Stage1ExtractOutcome extends StageExecutionOutcome<Stage1DiscoveryBundle> {
  readonly discoveryItems: readonly Stage1DiscoveryItemRecord[];
}

export interface ResolveStage1ItemServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly item_id: string;
  readonly actor_principal_id: string;
  readonly decision: "CONFIRM" | "REJECT";
  readonly resolution_note?: string | null;
}

export interface RunStage4ConsistencyCheckInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly actor_principal_id: string;
  readonly stage1_artifact_id?: string;
  readonly stage2_artifact_id?: string;
  readonly stage3_artifact_id?: string;
  readonly checked_at?: string;
}

export interface SubmitStageApprovalGateServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly gate_stage: StageApprovalGateStage;
  readonly target_artifact_id?: string;
  readonly target_artifact_sha256?: string;
  readonly approver_principal_id: string;
  readonly decision: "APPROVED" | "REJECTED" | "REQUEST_CHANGES";
  readonly rationale?: string | null;
}

export interface FreezeBaselineSpecServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly frozen_by_principal_id: string;
  readonly stage1_artifact_id?: string;
  readonly stage1_artifact_sha256?: string;
  readonly stage2_artifact_id?: string;
  readonly stage2_artifact_sha256?: string;
  readonly stage3_artifact_id?: string;
  readonly stage3_artifact_sha256?: string;
  readonly validation_report_artifact_id?: string;
  readonly validation_report_sha256?: string;
  readonly approval_gate_id?: string;
}

/**
 * Product Pipeline Orchestration Service (`M6A`: Stages 1 -> 4 + `AC-10` + `AC-12b` Cost Guard).
 *
 * Strictly enforces short RLS transactions around LLM boundaries:
 *   `TX1 (read & precondition check) -> No TX (Preflight -> HTTP Model Call -> Postcall Ledger) -> TX2 (persist artifacts)`
 * ensuring `BLOCKED_PREFLIGHT`, `BLOCKED_POSTCALL`, `FAILED_VALIDATION`, and `FAILED_PROVIDER`
 * ledgers commit durably even when an error is thrown.
 */
export class ProductPipelineService {
  private readonly store: ControlPlaneStore;
  public readonly promptRegistry: PromptRegistry;
  private readonly defaultModelConfig?: ModelProviderConfig;
  private readonly defaultModelExecutor?: ManagedModelProviderExecutor;
  private readonly pricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ProductPipelineServiceOptions) {
    this.store = options.store;
    this.promptRegistry = options.promptRegistry ?? createDefaultPipelinePromptRegistry();
    this.defaultModelConfig = options.defaultModelConfig;
    this.defaultModelExecutor = options.defaultModelExecutor;
    this.pricingOverrides = options.pricingOverrides;
    this.env = options.env ?? process.env;
  }

  public resolveExecutor(options?: {
    readonly model_config?: ModelProviderConfig;
    readonly model_executor?: ManagedModelProviderExecutor;
    readonly model_client?: LiveModelProviderClient;
  }): ManagedModelProviderExecutor {
    const costGuard: CostGuardRecorder = this.store;
    if (options?.model_executor) {
      if (options.model_config) {
        return options.model_executor.withProviderConfig(options.model_config, this.env);
      }
      return options.model_executor;
    }
    if (options?.model_client) {
      const client = options.model_config
        ? createModelProviderClient(options.model_config, this.env)
        : options.model_client;
      return new ManagedModelProviderExecutor({
        client,
        promptRegistry: this.promptRegistry,
        costGuard,
        pricingOverrides: this.pricingOverrides,
      });
    }
    if (options?.model_config) {
      if (this.defaultModelExecutor) {
        return this.defaultModelExecutor.withProviderConfig(options.model_config, this.env);
      }
      return new ManagedModelProviderExecutor({
        client: createModelProviderClient(options.model_config, this.env),
        promptRegistry: this.promptRegistry,
        costGuard,
        pricingOverrides: this.pricingOverrides,
      });
    }
    if (this.defaultModelExecutor) {
      return this.defaultModelExecutor;
    }
    if (this.defaultModelConfig) {
      return new ManagedModelProviderExecutor({
        client: createModelProviderClient(this.defaultModelConfig, this.env),
        promptRegistry: this.promptRegistry,
        costGuard,
        pricingOverrides: this.pricingOverrides,
      });
    }
    const envConfig = loadModelProviderConfigFromEnv(this.env);
    return new ManagedModelProviderExecutor({
      client: createModelProviderClient(envConfig, this.env),
      promptRegistry: this.promptRegistry,
      costGuard,
      pricingOverrides: this.pricingOverrides,
      defaultMaxTokens: envConfig.defaultMaxTokens,
      defaultTemperature: envConfig.defaultTemperature,
    });
  }

  public async createCostSession(input: CreateCostSessionServiceInput): Promise<CostSessionRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () =>
        this.store.createCostSession({
          cost_session_id: input.cost_session_id,
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id ?? null,
          task_id: input.task_id ?? null,
          max_tokens_per_request: input.max_tokens_per_request,
          max_cost_micro_usd_per_request: input.max_cost_micro_usd_per_request,
          session_token_budget: input.session_token_budget,
          session_cost_budget_micro_usd: input.session_cost_budget_micro_usd,
        })
    );
  }

  public async getCostSessionWithLedgers(input: {
    readonly project_id: string;
    readonly actor_principal_id: string;
    readonly cost_session_id: string;
  }): Promise<{ readonly session: CostSessionRecord; readonly ledgers: readonly ModelCallLedgerRecord[] } | null> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const session = await this.store.getCostSession(input.cost_session_id);
        if (!session || session.project_id !== input.project_id) {
          return null;
        }
        const ledgers = await this.store.listModelCallLedgers({
          cost_session_id: input.cost_session_id,
        });
        return { session, ledgers };
      }
    );
  }

  public async createSession(
    input: CreatePipelineSessionServiceInput
  ): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly costSession: CostSessionRecord | null;
  }> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.created_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const pipelineSessionId = input.pipeline_session_id ?? randomUUID();
        let costSession: CostSessionRecord | null = null;
        let costSessionId = input.cost_session_id ?? null;

        if (costSessionId && input.cost_budget) {
          throw new PostgresRlsError(
            "23514",
            "Specify either cost_session_id or cost_budget, not both"
          );
        }

        if (input.cost_budget) {
          costSession = await this.store.createCostSession({
            cost_session_id: input.cost_budget.cost_session_id,
            project_id: input.project_id,
            pipeline_session_id: pipelineSessionId,
            max_tokens_per_request: input.cost_budget.max_tokens_per_request,
            max_cost_micro_usd_per_request: input.cost_budget.max_cost_micro_usd_per_request,
            session_token_budget: input.cost_budget.session_token_budget,
            session_cost_budget_micro_usd: input.cost_budget.session_cost_budget_micro_usd,
          });
          costSessionId = costSession.cost_session_id;
        } else if (costSessionId) {
          costSession = await this.store.getCostSession(costSessionId);
        }

        const session = await this.store.createProductPipelineSession({
          pipeline_session_id: pipelineSessionId,
          project_id: input.project_id,
          cost_session_id: costSessionId,
          title: input.title,
          raw_idea_text: input.raw_idea_text,
          created_by_principal_id: input.created_by_principal_id,
        });

        return { session, costSession };
      }
    );
  }

  public async listSessions(input: {
    readonly project_id: string;
    readonly actor_principal_id: string;
  }): Promise<ProductPipelineSessionRecord[]> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () => this.store.listProductPipelineSessions()
    );
  }

  public async getBundle(input: {
    readonly project_id: string;
    readonly actor_principal_id: string;
    readonly pipeline_session_id: string;
  }): Promise<ProductPipelineBundle | null> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () => this.store.getProductPipelineBundle(input.pipeline_session_id)
    );
  }

  /**
   * Stage 1: Idea Discovery Extraction (`FACT` = `AUTO_VERIFIED`, `ASSUMPTION`/`RECOMMENDATION` = `UNCONFIRMED`).
   */
  public async intakeAndExtractStage1(
    input: RunModelStageOptions
  ): Promise<Stage1ExtractOutcome> {
    const pre = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        let session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }
        if (session.status !== "ACTIVE") {
          throw new PostgresRlsError(
            "23514",
            `Session ${input.pipeline_session_id} is ${session.status}; Stage 1 extraction is forbidden`
          );
        }
        const costSessionId = input.cost_session_id ?? session.cost_session_id;
        if (!costSessionId) {
          throw new PostgresRlsError(
            "23514",
            `Pipeline session ${input.pipeline_session_id} requires an AC-12b cost_session_id before Stage 1 model invocation`
          );
        }
        if (input.cost_session_id && !session.cost_session_id) {
          session = await this.store.updateProductPipelineSessionCostSession({
            project_id: input.project_id,
            pipeline_session_id: input.pipeline_session_id,
            cost_session_id: input.cost_session_id,
          });
        }
        return { session, costSessionId };
      }
    );

    const executor = this.resolveExecutor(input);
    const execRes = await executor.executeStructuredPrompt<Stage1DiscoveryBundle>({
      projectId: input.project_id,
      costSessionId: pre.costSessionId,
      pipelineSessionId: pre.session.pipeline_session_id,
      stage: "STAGE_1_IDEA_DISCOVERY",
      promptId: STAGE1_DISCOVERY_PROMPT_ID,
      promptVersion: input.prompt_version,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      variables: {
        project_id: input.project_id,
        pipeline_session_id: pre.session.pipeline_session_id,
        title: pre.session.title,
        raw_idea_text: pre.session.raw_idea_text,
      },
    });

    const persisted = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const itemsInput = [
          ...execRes.parsed.facts.map((f) => ({
            kind: "FACT" as const,
            title: f.title,
            statement: f.statement,
            rationale: f.rationale,
            confirmation_status: "AUTO_VERIFIED" as const,
          })),
          ...execRes.parsed.assumptions.map((a) => ({
            kind: "ASSUMPTION" as const,
            title: a.title,
            statement: a.statement,
            rationale: a.rationale,
            clarification_question: a.clarification_question,
            confirmation_status: "UNCONFIRMED" as const,
          })),
          ...execRes.parsed.recommendations.map((r) => ({
            kind: "RECOMMENDATION" as const,
            title: r.title,
            statement: r.statement,
            rationale: r.rationale,
            clarification_question: r.clarification_question,
            confirmation_status: "UNCONFIRMED" as const,
          })),
        ];

        const discoveryItems =
          itemsInput.length > 0
            ? await this.store.createStage1DiscoveryItems({
                project_id: input.project_id,
                pipeline_session_id: pre.session.pipeline_session_id,
                items: itemsInput,
              })
            : [];

        const factsCreated = discoveryItems.filter((i) => i.kind === "FACT");
        const assumptionsCreated = discoveryItems.filter((i) => i.kind === "ASSUMPTION");
        const recommendationsCreated = discoveryItems.filter((i) => i.kind === "RECOMMENDATION");

        const contentJson: Record<string, unknown> = {
          summary: execRes.parsed.summary,
          facts: factsCreated.map((i) => ({
            item_id: i.item_id,
            title: i.title,
            statement: i.statement,
            rationale: i.rationale,
            confirmation_status: i.confirmation_status,
          })),
          assumptions: assumptionsCreated.map((i) => ({
            item_id: i.item_id,
            title: i.title,
            statement: i.statement,
            rationale: i.rationale,
            clarification_question: i.clarification_question,
            confirmation_status: i.confirmation_status,
          })),
          recommendations: recommendationsCreated.map((i) => ({
            item_id: i.item_id,
            title: i.title,
            statement: i.statement,
            rationale: i.rationale,
            clarification_question: i.clarification_question,
            confirmation_status: i.confirmation_status,
          })),
        };

        const artifact = await this.store.recordStageArtifact({
          project_id: input.project_id,
          pipeline_session_id: pre.session.pipeline_session_id,
          stage: "STAGE_1_IDEA_DISCOVERY",
          artifact_kind: "STAGE_1_DISCOVERY_BUNDLE",
          provider: execRes.rawCompletion.provider,
          model: execRes.rawCompletion.model,
          prompt_id: execRes.renderedPrompt.promptId,
          prompt_version: execRes.renderedPrompt.version,
          prompt_sha256: execRes.renderedPrompt.promptSha256,
          content_json: contentJson,
          created_by_principal_id: input.actor_principal_id,
          advance_session_stage: "STAGE_1_IDEA_DISCOVERY",
        });

        const updatedSession =
          (await this.store.getProductPipelineSession(pre.session.pipeline_session_id)) ??
          pre.session;

        return { session: updatedSession, artifact, discoveryItems };
      }
    );

    return {
      session: persisted.session,
      artifact: persisted.artifact,
      discoveryItems: persisted.discoveryItems,
      parsed: execRes.parsed,
      ledger: execRes.ledger,
      costSession: execRes.costSession,
    };
  }

  public async resolveStage1Item(
    input: ResolveStage1ItemServiceInput
  ): Promise<Stage1DiscoveryItemRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () =>
        this.store.resolveStage1DiscoveryItem({
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          item_id: input.item_id,
          actor_principal_id: input.actor_principal_id,
          decision: input.decision,
          resolution_note: input.resolution_note,
        })
    );
  }

  /**
   * Stage 2: PRD & SRS Generation (`AC-10` enforced via confirmed-only prompt filtering,
   * domain validation, and PostgreSQL trigger `trg_stage_artifact_invariants`).
   */
  public async generateStage2Requirements(
    input: RunModelStageOptions
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const pre = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        let session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }
        if (session.status !== "ACTIVE") {
          throw new PostgresRlsError(
            "23514",
            `Session ${input.pipeline_session_id} is ${session.status}; Stage 2 generation is forbidden`
          );
        }
        const costSessionId = input.cost_session_id ?? session.cost_session_id;
        if (!costSessionId) {
          throw new PostgresRlsError(
            "23514",
            `Pipeline session ${input.pipeline_session_id} requires an AC-12b cost_session_id before Stage 2 model invocation`
          );
        }
        if (input.cost_session_id && !session.cost_session_id) {
          session = await this.store.updateProductPipelineSessionCostSession({
            project_id: input.project_id,
            pipeline_session_id: input.pipeline_session_id,
            cost_session_id: input.cost_session_id,
          });
        }

        const allItems = await this.store.listStage1DiscoveryItems(input.pipeline_session_id);
        // Layer 1 (AC-10): ONLY AUTO_VERIFIED FACTS and human CONFIRMED items enter the Stage 2 prompt.
        const verifiedItems = allItems.filter(
          (i) => i.confirmation_status === "AUTO_VERIFIED" || i.confirmation_status === "CONFIRMED"
        );
        if (verifiedItems.length === 0) {
          throw new Ac10ViolationError(
            "AC-10 violation: Stage 2 cannot proceed without at least one AUTO_VERIFIED or CONFIRMED Stage 1 discovery item",
            allItems.filter((i) => i.confirmation_status === "UNCONFIRMED").map((i) => i.item_id)
          );
        }

        return {
          session,
          costSessionId,
          verifiedItems,
        };
      }
    );

    const executor = this.resolveExecutor(input);
    const execRes = await executor.executeStructuredPrompt<Record<string, unknown>>({
      projectId: input.project_id,
      costSessionId: pre.costSessionId,
      pipelineSessionId: pre.session.pipeline_session_id,
      stage: "STAGE_2_REQUIREMENTS",
      promptId: STAGE2_REQUIREMENTS_PROMPT_ID,
      promptVersion: input.prompt_version,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      variables: {
        project_id: input.project_id,
        pipeline_session_id: pre.session.pipeline_session_id,
        title: pre.session.title,
        raw_idea_text: pre.session.raw_idea_text,
        confirmed_discovery_items_json: JSON.stringify(
          pre.verifiedItems.map((i) => ({
            item_id: i.item_id,
            kind: i.kind,
            title: i.title,
            statement: i.statement,
            rationale: i.rationale,
            confirmation_status: i.confirmation_status,
            resolution_note: i.resolution_note,
          }))
        ),
      },
    });

    const persisted = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const artifact = await this.store.recordStageArtifact({
          project_id: input.project_id,
          pipeline_session_id: pre.session.pipeline_session_id,
          stage: "STAGE_2_REQUIREMENTS",
          artifact_kind: "STAGE_2_PRD_SRS",
          provider: execRes.rawCompletion.provider,
          model: execRes.rawCompletion.model,
          prompt_id: execRes.renderedPrompt.promptId,
          prompt_version: execRes.renderedPrompt.version,
          prompt_sha256: execRes.renderedPrompt.promptSha256,
          content_json: execRes.parsed,
          created_by_principal_id: input.actor_principal_id,
          advance_session_stage: "STAGE_2_REQUIREMENTS",
        });
        const updatedSession =
          (await this.store.getProductPipelineSession(pre.session.pipeline_session_id)) ??
          pre.session;
        return { session: updatedSession, artifact };
      }
    );

    return {
      session: persisted.session,
      artifact: persisted.artifact,
      parsed: execRes.parsed,
      ledger: execRes.ledger,
      costSession: execRes.costSession,
    };
  }

  /**
   * Stage 3: Technology & Architecture Design (Components, ERD, API Spec, Security Controls, ADRs).
   */
  public async generateStage3Architecture(
    input: RunModelStageOptions & { readonly stage2_artifact_id?: string }
  ): Promise<StageExecutionOutcome<Record<string, unknown>>> {
    const pre = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        let session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }
        if (session.status !== "ACTIVE") {
          throw new PostgresRlsError(
            "23514",
            `Session ${input.pipeline_session_id} is ${session.status}; Stage 3 architecture generation is forbidden`
          );
        }
        const costSessionId = input.cost_session_id ?? session.cost_session_id;
        if (!costSessionId) {
          throw new PostgresRlsError(
            "23514",
            `Pipeline session ${input.pipeline_session_id} requires an AC-12b cost_session_id before Stage 3 model invocation`
          );
        }
        if (input.cost_session_id && !session.cost_session_id) {
          session = await this.store.updateProductPipelineSessionCostSession({
            project_id: input.project_id,
            pipeline_session_id: input.pipeline_session_id,
            cost_session_id: input.cost_session_id,
          });
        }

        const artifacts = await this.store.listStageArtifacts(input.pipeline_session_id);
        let stage2Artifact: StageArtifactRecord | null = null;
        if (input.stage2_artifact_id) {
          stage2Artifact =
            artifacts.find(
              (a) =>
                a.artifact_id === input.stage2_artifact_id && a.stage === "STAGE_2_REQUIREMENTS"
            ) ?? null;
          if (!stage2Artifact) {
            throw new PostgresRlsError(
              "23503",
              `Stage 2 artifact ${input.stage2_artifact_id} not found in pipeline session ${input.pipeline_session_id}`
            );
          }
        } else {
          stage2Artifact = findLatestArtifactForStage(artifacts, "STAGE_2_REQUIREMENTS");
          if (!stage2Artifact) {
            throw new PostgresRlsError(
              "23514",
              `Cannot run Stage 3 Architecture: no STAGE_2_REQUIREMENTS artifact exists for session ${input.pipeline_session_id}`
            );
          }
        }

        const stage1Items = await this.store.listStage1DiscoveryItems(input.pipeline_session_id);
        validateStage2Ac10References(
          stage2Artifact.content_json,
          stage1Items,
          input.pipeline_session_id
        );

        return { session, costSessionId, stage2Artifact };
      }
    );

    const executor = this.resolveExecutor(input);
    const execRes = await executor.executeStructuredPrompt<Record<string, unknown>>({
      projectId: input.project_id,
      costSessionId: pre.costSessionId,
      pipelineSessionId: pre.session.pipeline_session_id,
      stage: "STAGE_3_ARCHITECTURE",
      promptId: STAGE3_ARCHITECTURE_PROMPT_ID,
      promptVersion: input.prompt_version,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
      variables: {
        project_id: input.project_id,
        pipeline_session_id: pre.session.pipeline_session_id,
        title: pre.session.title,
        stage2_prd_srs_json: JSON.stringify(pre.stage2Artifact.content_json),
      },
    });

    const persisted = await this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const artifact = await this.store.recordStageArtifact({
          project_id: input.project_id,
          pipeline_session_id: pre.session.pipeline_session_id,
          stage: "STAGE_3_ARCHITECTURE",
          artifact_kind: "STAGE_3_ARCHITECTURE_DESIGN",
          provider: execRes.rawCompletion.provider,
          model: execRes.rawCompletion.model,
          prompt_id: execRes.renderedPrompt.promptId,
          prompt_version: execRes.renderedPrompt.version,
          prompt_sha256: execRes.renderedPrompt.promptSha256,
          content_json: execRes.parsed,
          created_by_principal_id: input.actor_principal_id,
          advance_session_stage: "STAGE_3_ARCHITECTURE",
        });
        const updatedSession =
          (await this.store.getProductPipelineSession(pre.session.pipeline_session_id)) ??
          pre.session;
        return { session: updatedSession, artifact };
      }
    );

    return {
      session: persisted.session,
      artifact: persisted.artifact,
      parsed: execRes.parsed,
      ledger: execRes.ledger,
      costSession: execRes.costSession,
    };
  }

  /**
   * Stage 4: Runs `CrossArtifactConsistencyChecker` (`CHK-01` .. `CHK-05`) and persists
   * an immutable `STAGE_4_VALIDATION_REPORT` artifact.
   */
  public async runStage4ConsistencyCheck(input: RunStage4ConsistencyCheckInput): Promise<{
    readonly session: ProductPipelineSessionRecord;
    readonly report: Stage4ConsistencyReport;
    readonly artifact: StageArtifactRecord;
  }> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }
        if (session.status !== "ACTIVE") {
          throw new PostgresRlsError(
            "23514",
            `Session ${input.pipeline_session_id} is ${session.status}; Stage 4 validation cannot run after freeze`
          );
        }

        const stage1Items = await this.store.listStage1DiscoveryItems(input.pipeline_session_id);
        const artifacts = await this.store.listStageArtifacts(input.pipeline_session_id);

        const resolveArtifact = (
          explicitId: string | undefined,
          stage: PipelineStageName
        ): StageArtifactRecord | null => {
          if (explicitId) {
            const match = artifacts.find(
              (a) => a.artifact_id === explicitId && a.stage === stage
            );
            if (!match) {
              throw new PostgresRlsError(
                "23503",
                `Stage artifact ${explicitId} (${stage}) not found in session ${input.pipeline_session_id}`
              );
            }
            return match;
          }
          return findLatestArtifactForStage(artifacts, stage);
        };

        const stage1Artifact = resolveArtifact(
          input.stage1_artifact_id,
          "STAGE_1_IDEA_DISCOVERY"
        );
        const stage2Artifact = resolveArtifact(input.stage2_artifact_id, "STAGE_2_REQUIREMENTS");
        const stage3Artifact = resolveArtifact(input.stage3_artifact_id, "STAGE_3_ARCHITECTURE");

        const report = runCrossArtifactConsistencyCheck({
          pipelineSessionId: input.pipeline_session_id,
          stage1Items,
          stage1Artifact,
          stage2Artifact,
          stage3Artifact,
          checkedAt: input.checked_at,
        });

        const artifact = await this.store.recordStageArtifact({
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          stage: "STAGE_4_SPEC_FREEZE",
          artifact_kind: "STAGE_4_VALIDATION_REPORT",
          provider: "system",
          model: "deterministic-cross-artifact-checker-v1",
          prompt_id: STAGE4_CONSISTENCY_CHECK_PROMPT_ID,
          prompt_version: STAGE4_CONSISTENCY_CHECK_PROMPT_VERSION,
          prompt_sha256: STAGE4_CONSISTENCY_CHECK_PROMPT_SHA256,
          content_json: report as unknown as Record<string, unknown>,
          created_by_principal_id: input.actor_principal_id,
          advance_session_stage: "STAGE_4_SPEC_FREEZE",
        });

        const updatedSession =
          (await this.store.getProductPipelineSession(input.pipeline_session_id)) ?? session;
        return { session: updatedSession, report, artifact };
      }
    );
  }

  public async submitStageApprovalGate(
    input: SubmitStageApprovalGateServiceInput
  ): Promise<StageApprovalGateRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.approver_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }
        if (session.status !== "ACTIVE") {
          throw new PostgresRlsError(
            "23514",
            `Session ${input.pipeline_session_id} is ${session.status}; stage approval gates cannot be recorded`
          );
        }

        const expectedArtifactStage = GATE_STAGE_TO_ARTIFACT_STAGE[input.gate_stage];
        const artifacts = await this.store.listStageArtifacts(input.pipeline_session_id);

        const targetArtifact = input.target_artifact_id
          ? artifacts.find((a) => a.artifact_id === input.target_artifact_id) ?? null
          : findLatestArtifactForStage(artifacts, expectedArtifactStage);

        if (!targetArtifact) {
          throw new PostgresRlsError(
            "23503",
            `Target artifact for gate ${input.gate_stage} not found in pipeline session ${input.pipeline_session_id}`
          );
        }
        if (targetArtifact.stage !== expectedArtifactStage) {
          throw new PostgresRlsError(
            "23514",
            `Approval gate stage ${input.gate_stage} requires artifact from ${expectedArtifactStage}, got ${targetArtifact.stage}`
          );
        }

        return this.store.recordStageApprovalGate({
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          gate_stage: input.gate_stage,
          target_artifact_id: targetArtifact.artifact_id,
          target_artifact_sha256: input.target_artifact_sha256 ?? targetArtifact.artifact_sha256,
          approver_principal_id: input.approver_principal_id,
          decision: input.decision,
          rationale: input.rationale ?? null,
        });
      }
    );
  }

  public async freezeBaselineSpec(
    input: FreezeBaselineSpecServiceInput
  ): Promise<BaselineSpecFreezeRecord> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.frozen_by_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const session = await this.store.getProductPipelineSession(input.pipeline_session_id);
        if (!session || session.project_id !== input.project_id) {
          throw new PostgresRlsError(
            "23503",
            `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
          );
        }

        const artifacts = await this.store.listStageArtifacts(input.pipeline_session_id);
        const gates = await this.store.listStageApprovalGates(input.pipeline_session_id);

        const pickArtifact = (
          explicitId: string | undefined,
          stage: PipelineStageName,
          label: string
        ): StageArtifactRecord => {
          const found = explicitId
            ? artifacts.find((a) => a.artifact_id === explicitId)
            : findLatestArtifactForStage(artifacts, stage);
          if (!found) {
            throw new PostgresRlsError(
              explicitId ? "23503" : "23514",
              `Baseline freeze missing ${label} artifact (${stage})`
            );
          }
          return found;
        };

        const stage1 = pickArtifact(
          input.stage1_artifact_id,
          "STAGE_1_IDEA_DISCOVERY",
          "Stage 1 Discovery"
        );
        const stage2 = pickArtifact(
          input.stage2_artifact_id,
          "STAGE_2_REQUIREMENTS",
          "Stage 2 Requirements"
        );
        const stage3 = pickArtifact(
          input.stage3_artifact_id,
          "STAGE_3_ARCHITECTURE",
          "Stage 3 Architecture"
        );
        const latestStage4 = findLatestArtifactForStage(artifacts, "STAGE_4_SPEC_FREEZE");
        const validationReport = pickArtifact(
          input.validation_report_artifact_id,
          "STAGE_4_SPEC_FREEZE",
          "Stage 4 Validation Report"
        );
        if (latestStage4 && validationReport.artifact_id !== latestStage4.artifact_id) {
          throw new PostgresRlsError(
            "23514",
            `Cannot freeze baseline: Stage 4 validation report ${validationReport.artifact_id} (v${validationReport.version}) is not the latest report (v${latestStage4.version}: ${latestStage4.artifact_id})`
          );
        }

        const resolvedValidationSha = input.validation_report_sha256 ?? validationReport.artifact_sha256;
        let gate: StageApprovalGateRecord | undefined;
        if (input.approval_gate_id) {
          gate = gates.find((g) => g.gate_id === input.approval_gate_id);
          if (!gate) {
            throw new PostgresRlsError(
              "23503",
              `Approval gate ${input.approval_gate_id} not found in pipeline session ${input.pipeline_session_id}`
            );
          }
        } else {
          const matchingGates = gates.filter(
            (g) =>
              g.gate_stage === "STAGE_4_SPEC_FREEZE" &&
              g.decision === "APPROVED" &&
              g.target_artifact_id === validationReport.artifact_id &&
              g.target_artifact_sha256 === resolvedValidationSha
          );
          gate = matchingGates[matchingGates.length - 1];
          if (!gate) {
            throw new PostgresRlsError(
              "23514",
              `Baseline freeze requires an APPROVED STAGE_4_SPEC_FREEZE approval gate for validation report ${validationReport.artifact_id}`
            );
          }
        }

        return this.store.freezeBaselineSpec({
          project_id: input.project_id,
          pipeline_session_id: input.pipeline_session_id,
          stage1_artifact_id: stage1.artifact_id,
          stage1_artifact_sha256: input.stage1_artifact_sha256 ?? stage1.artifact_sha256,
          stage2_artifact_id: stage2.artifact_id,
          stage2_artifact_sha256: input.stage2_artifact_sha256 ?? stage2.artifact_sha256,
          stage3_artifact_id: stage3.artifact_id,
          stage3_artifact_sha256: input.stage3_artifact_sha256 ?? stage3.artifact_sha256,
          validation_report_artifact_id: validationReport.artifact_id,
          validation_report_sha256: resolvedValidationSha,
          approval_gate_id: gate.gate_id,
          frozen_by_principal_id: input.frozen_by_principal_id,
        });
      }
    );
  }

  // ===========================================================================
  // Milestone M6B: Stages 5–9 Lifecycle, 3D Profiles, CR & AC-11b Release Acceptance
  // ===========================================================================

  public async bootstrapProject(
    input: RunStage5ProjectBootstrapInput
  ): Promise<Stage5BootstrapOutcome> {
    return runStage5ProjectBootstrap(this.store, input);
  }

  public async upsertAgentOrganizationProfile(
    input: UpsertAgentOrganizationProfileServiceInput
  ): Promise<AgentOrganizationProfileRecord> {
    return upsertAgentOrganizationProfileService(this.store, input);
  }

  public async listAgentOrganizationProfiles(input: {
    readonly project_id: string;
    readonly actor_principal_id: string;
    readonly role?: AgentOrgRole;
    readonly active_only?: boolean;
  }): Promise<AgentOrganizationProfileRecord[]> {
    return listAgentOrganizationProfilesService(this.store, input);
  }

  public async validateStage6ReviewerPair(
    input: ValidateStage6ReviewerPairInput
  ): Promise<Stage6ReviewerPairOutcome> {
    return validateStage6ReviewerPairService(this.store, input);
  }

  public async generateStage7DevelopmentPlan(
    input: RunStage7DevelopmentPlanInput & {
      readonly model_config?: ModelProviderConfig;
      readonly model_executor?: ManagedModelProviderExecutor;
      readonly model_client?: LiveModelProviderClient;
    }
  ): Promise<Stage7PlanExecutionOutcome> {
    const executor = this.resolveExecutor(input);
    return runStage7DevelopmentPlan(this.store, executor, input);
  }

  public async submitChangeRequest(
    input: SubmitChangeRequestServiceInput
  ): Promise<ChangeRequestRecord> {
    return submitChangeRequestService(this.store, input);
  }

  public async decideChangeRequest(
    input: DecideChangeRequestServiceInput
  ): Promise<ChangeRequestRecord> {
    return decideChangeRequestService(this.store, input);
  }

  public async applyChangeRequest(input: ApplyChangeRequestServiceInput): Promise<{
    readonly changeRequest: ChangeRequestRecord;
    readonly tasks: readonly TaskRecord[];
    readonly taskLinks: readonly TaskPlanLinkRecord[];
  }> {
    return applyChangeRequestService(this.store, input);
  }

  public async listChangeRequests(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
  }): Promise<ChangeRequestRecord[]> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () => this.store.listChangeRequests(input.pipeline_session_id)
    );
  }

  public async getBidirectionalTraceabilityMatrix(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
    readonly live_main_head_commit_hash?: string;
  }): Promise<BidirectionalTraceabilityMatrix> {
    return getBidirectionalTraceabilityMatrixService(this.store, input);
  }

  public async issueReleaseAcceptancePackage(
    input: IssueReleaseAcceptanceServiceInput
  ): Promise<ReleaseAcceptancePackageRecord> {
    return issueReleaseAcceptancePackageService(this.store, input);
  }

  public async listReleaseAcceptancePackages(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
  }): Promise<ReleaseAcceptancePackageRecord[]> {
    return this.store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      () => this.store.listReleaseAcceptancePackages(input.pipeline_session_id)
    );
  }

  public async getM6BStages5To9Bundle(input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
    readonly live_main_head_commit_hash?: string;
  }): Promise<M6BStages5To9Bundle> {
    return getM6BStages5To9BundleService(this.store, input);
  }
}
