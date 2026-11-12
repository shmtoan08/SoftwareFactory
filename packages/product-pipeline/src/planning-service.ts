import {
  CostBudgetExceededError,
  type ManagedModelProviderExecutor,
} from "@software-factory/adapter-sdk";
import {
  BudgetAutoPausedError,
  type ControlPlaneStore,
  PostgresRlsError,
  validateStage6DeveloperReviewerPair,
  validateStage7PlanAgainstBaseline,
} from "@software-factory/database";
import {
  type AgentOrgRole,
  type AgentOrganizationProfileRecord,
  type BaselineSpecFreezeRecord,
  type CostSessionRecord,
  type ExecutionTargetType,
  type ModelCallLedgerRecord,
  type ProductPipelineSessionRecord,
  type ProjectBootstrapRecord,
  type Stage7DevelopmentPlanBundle,
  type Stage7PlanningOutput,
  type TargetTrustTier,
} from "@software-factory/shared-types";
import { STAGE7_PLANNING_PROMPT_ID } from "./prompts.ts";

export interface UpsertAgentOrganizationProfileServiceInput {
  readonly project_id: string;
  readonly actor_principal_id: string;
  readonly profile_id?: string;
  readonly profile_key: string;
  readonly role: AgentOrgRole;
  readonly principal_id: string;
  readonly provider: string;
  readonly model: string;
  readonly execution_target_type: ExecutionTargetType;
  readonly trust_tier: TargetTrustTier;
  readonly target_locator?: string | null;
  readonly capabilities_json?: Readonly<Record<string, unknown>>;
  readonly is_active?: boolean;
}

export interface ValidateStage6ReviewerPairInput {
  readonly project_id: string;
  readonly actor_principal_id: string;
  readonly developer_profile_id: string;
  readonly reviewer_profile_id: string;
}

export interface Stage6ReviewerPairOutcome {
  readonly valid: true;
  readonly developerProfile: AgentOrganizationProfileRecord;
  readonly reviewerProfile: AgentOrganizationProfileRecord;
}

export interface RunStage7DevelopmentPlanInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly actor_principal_id: string;
  readonly cost_session_id?: string;
  readonly prompt_version?: string;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly max_rework_cycles?: number;
}

export interface Stage7PlanExecutionOutcome {
  readonly session: ProductPipelineSessionRecord;
  readonly baseline: BaselineSpecFreezeRecord;
  readonly bootstrap: ProjectBootstrapRecord;
  readonly plan: Stage7PlanningOutput;
  readonly bundle: Stage7DevelopmentPlanBundle;
  readonly ledger: ModelCallLedgerRecord;
  readonly costSession: CostSessionRecord;
}

export async function upsertAgentOrganizationProfileService(
  store: ControlPlaneStore,
  input: UpsertAgentOrganizationProfileServiceInput
): Promise<AgentOrganizationProfileRecord> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    () =>
      store.upsertAgentOrganizationProfile({
        profile_id: input.profile_id,
        project_id: input.project_id,
        profile_key: input.profile_key,
        role: input.role,
        principal_id: input.principal_id,
        provider: input.provider,
        model: input.model,
        execution_target_type: input.execution_target_type,
        trust_tier: input.trust_tier,
        target_locator: input.target_locator ?? null,
        capabilities_json: input.capabilities_json ?? {},
        is_active: input.is_active ?? true,
        created_by_principal_id: input.actor_principal_id,
      })
  );
}

export async function listAgentOrganizationProfilesService(
  store: ControlPlaneStore,
  input: {
    readonly project_id: string;
    readonly actor_principal_id: string;
    readonly role?: AgentOrgRole;
    readonly active_only?: boolean;
  }
): Promise<AgentOrganizationProfileRecord[]> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    () =>
      store.listAgentOrganizationProfiles(input.project_id, {
        role: input.role,
        active_only: input.active_only,
      })
  );
}

export async function validateStage6ReviewerPairService(
  store: ControlPlaneStore,
  input: ValidateStage6ReviewerPairInput
): Promise<Stage6ReviewerPairOutcome> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const dev = await store.getAgentOrganizationProfileById(input.developer_profile_id);
      if (!dev || dev.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Developer profile ${input.developer_profile_id} not found for project ${input.project_id}`
        );
      }
      const rev = await store.getAgentOrganizationProfileById(input.reviewer_profile_id);
      if (!rev || rev.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Reviewer profile ${input.reviewer_profile_id} not found for project ${input.project_id}`
        );
      }
      validateStage6DeveloperReviewerPair(dev, rev);
      return {
        valid: true as const,
        developerProfile: dev,
        reviewerProfile: rev,
      };
    }
  );
}

/**
 * Stage 7: Development Planning (`Milestones -> Epics -> Stories -> Stage 8 Tasks`)
 * with short RLS transactions framing the LLM call (`TX1 -> Model Call + AC-12b -> TX2`).
 */
export async function runStage7DevelopmentPlan(
  store: ControlPlaneStore,
  executor: ManagedModelProviderExecutor,
  input: RunStage7DevelopmentPlanInput
): Promise<Stage7PlanExecutionOutcome> {
  const pre = await store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const project = await store.getProjectById(input.project_id);
      if (!project) {
        throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
      }
      const session = await store.getProductPipelineSession(input.pipeline_session_id);
      if (!session || session.project_id !== input.project_id) {
        throw new PostgresRlsError(
          "23503",
          `Product pipeline session ${input.pipeline_session_id} not found for project ${input.project_id}`
        );
      }
      if (session.status !== "FROZEN") {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 Planning requires FROZEN Stage 4 baseline (session status is ${session.status})`
        );
      }
      const costSessionId = input.cost_session_id ?? session.cost_session_id;
      if (!costSessionId) {
        throw new PostgresRlsError(
          "23514",
          `Pipeline session ${input.pipeline_session_id} requires an AC-12b cost_session_id before Stage 7 model invocation`
        );
      }
      const baseline = await store.getBaselineSpecFreeze(input.pipeline_session_id);
      if (!baseline || baseline.status !== "FROZEN") {
        throw new PostgresRlsError(
          "23514",
          `No FROZEN baseline exists for session ${input.pipeline_session_id}`
        );
      }
      const bootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
      if (!bootstrap) {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 requires Stage 5 Project Bootstrap first for session ${input.pipeline_session_id}`
        );
      }
      const existingMilestones = await store.listDevMilestones(input.pipeline_session_id);
      if (existingMilestones.length > 0) {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 development plan already exists for frozen baseline ${baseline.baseline_id}; submit a Stage 9 Change Request to modify or add tasks`
        );
      }
      const stage2 = await store.getStageArtifactById(baseline.stage2_artifact_id);
      const stage3 = await store.getStageArtifactById(baseline.stage3_artifact_id);
      if (!stage2 || !stage3) {
        throw new PostgresRlsError(
          "23503",
          "Frozen Stage 2 or Stage 3 artifact missing from baseline freeze"
        );
      }
      const profiles = await store.listAgentOrganizationProfiles(input.project_id, {
        active_only: true,
      });

      return {
        project,
        session,
        costSessionId,
        baseline,
        bootstrap,
        stage2,
        stage3,
        profiles,
      };
    }
  );

  // Outside DB transaction: AC-12b preflight + LLM call + structured schema validation (ledger deferred to TX2)
  const deferredExec = await executor.executeStructuredPromptDeferred<Stage7PlanningOutput>({
    projectId: input.project_id,
    costSessionId: pre.costSessionId,
    pipelineSessionId: pre.session.pipeline_session_id,
    stage: "STAGE_7_PLANNING",
    promptId: STAGE7_PLANNING_PROMPT_ID,
    promptVersion: input.prompt_version,
    maxTokens: input.max_tokens,
    temperature: input.temperature,
    variables: {
      project_id: input.project_id,
      pipeline_session_id: pre.session.pipeline_session_id,
      baseline_id: pre.baseline.baseline_id,
      title: pre.session.title,
      stage2_requirements_json: JSON.stringify(pre.stage2.content_json),
      stage3_architecture_json: JSON.stringify(pre.stage3.content_json),
      protected_paths_json: JSON.stringify(pre.bootstrap.protected_paths),
      agent_profiles_json: JSON.stringify(
        pre.profiles.map((p) => ({
          profile_key: p.profile_key,
          role: p.role,
          provider: p.provider,
          model: p.model,
          execution_target_type: p.execution_target_type,
          trust_tier: p.trust_tier,
        }))
      ),
    },
  });

  // Deterministic fail-closed baseline verification (100% req/AC coverage, zero protected overlap, acyclic DAG)
  let validated: ReturnType<typeof validateStage7PlanAgainstBaseline>;
  try {
    validated = validateStage7PlanAgainstBaseline({
      plan: deferredExec.parsed,
      stage2ContentJson: pre.stage2.content_json,
      protectedPaths: pre.bootstrap.protected_paths,
      profiles: pre.profiles,
    });
  } catch (domainErr: unknown) {
    await deferredExec.finalizeDomainFailure(
      domainErr instanceof Error ? domainErr.message : String(domainErr)
    );
    throw domainErr;
  }

  // Short TX2: materialize Milestones -> Epics -> Stories -> Stage 8 Tasks + task_plan_links + ALLOWED ledger atomically
  let persisted: {
    readonly bundle: Stage7DevelopmentPlanBundle;
    readonly ledger: ModelCallLedgerRecord;
    readonly costSession: CostSessionRecord;
  };
  try {
    persisted = await store.withRlsTransaction(
      {
        currentProjectId: input.project_id,
        currentPrincipalId: input.actor_principal_id,
        currentRole: "core_api_service",
      },
      async () => {
        const liveMainHead =
          (await store.getMainRefCommitHash(input.project_id)) ??
          pre.project.main_ref_commit_hash ??
          pre.bootstrap.base_main_commit_hash;

        const bundle = await store.createStage7DevelopmentPlan({
          project_id: input.project_id,
          pipeline_session_id: pre.session.pipeline_session_id,
          baseline_id: pre.baseline.baseline_id,
          bootstrap_id: pre.bootstrap.bootstrap_id,
          base_main_commit_hash: liveMainHead,
          milestones: deferredExec.parsed.milestones.map((m, idx) => ({
            milestone_key: m.milestone_key,
            title: m.title,
            description: m.description,
            sequence_order: idx + 1,
          })),
          epics: deferredExec.parsed.epics.map((e, idx) => ({
            milestone_key: e.milestone_key,
            epic_key: e.epic_key,
            title: e.title,
            description: e.description,
            sequence_order: idx + 1,
          })),
          stories: deferredExec.parsed.stories.map((s, idx) => ({
            epic_key: s.epic_key,
            story_key: s.story_key,
            title: s.title,
            description: s.description,
            requirement_ids: s.requirement_ids,
            ac_ids: s.ac_ids,
            sequence_order: idx + 1,
          })),
          tasks: deferredExec.parsed.tasks.map((t) => {
            const prof = t.developer_profile_key
              ? validated.profileByKey.get(t.developer_profile_key)
              : undefined;
            return {
              task_key: t.task_key,
              story_key: t.story_key,
              title: t.title,
              task_contract: {
                allowed_files: [...t.allowed_files],
                protected_paths: [...pre.bootstrap.protected_paths],
                trusted_policy_sha256: pre.bootstrap.trusted_policy_sha256,
              },
              requirement_ids: t.requirement_ids,
              ac_ids: t.ac_ids,
              depends_on_task_keys: t.depends_on_task_keys,
              assigned_profile_id: prof?.profile_id ?? null,
              max_rework_cycles: input.max_rework_cycles,
            };
          }),
        });
        const committed = await deferredExec.commitAllowedLedger();
        return {
          bundle,
          ledger: committed.ledger,
          costSession: committed.costSession,
        };
      }
    );
  } catch (persistErr: unknown) {
    if (
      persistErr instanceof CostBudgetExceededError ||
      persistErr instanceof BudgetAutoPausedError
    ) {
      throw persistErr;
    }
    const isValidation =
      persistErr instanceof PostgresRlsError &&
      (persistErr.sqlState === "23514" ||
        persistErr.sqlState === "23505" ||
        persistErr.sqlState === "23503");
    const rawMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    await deferredExec.finalizeDomainFailure(
      isValidation ? rawMsg : `[PERSISTENCE_FAILURE] ${rawMsg}`,
      "FAILED_VALIDATION"
    );
    throw persistErr;
  }

  return {
    session: pre.session,
    baseline: pre.baseline,
    bootstrap: pre.bootstrap,
    plan: deferredExec.parsed,
    bundle: persisted.bundle,
    ledger: persisted.ledger,
    costSession: persisted.costSession,
  };
}
