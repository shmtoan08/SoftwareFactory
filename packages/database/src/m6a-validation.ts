import {
  type BaselineSpecFreezeRecord,
  type CostSessionRecord,
  type ModelCallLedgerRecord,
  type PipelineStageName,
  type ProductPipelineBundle,
  type ProductPipelineSessionRecord,
  type Stage1ConfirmationStatus,
  type Stage1DiscoveryItemRecord,
  type StageApprovalGateRecord,
  type StageArtifactKind,
  type StageArtifactRecord,
  canonicalizeJson,
  computeCanonicalPayloadSha256,
  isUuidString,
  sha256Hex,
} from "@software-factory/shared-types";
import {
  Ac10ViolationError,
  type CreateCostSessionInput,
  type CreateStage1DiscoveryItemInput,
  type FreezeBaselineSpecInput,
  PostgresRlsError,
} from "./types.ts";

export const STAGE_TO_ARTIFACT_KIND: Readonly<Record<PipelineStageName, StageArtifactKind>> = {
  STAGE_1_IDEA_DISCOVERY: "STAGE_1_DISCOVERY_BUNDLE",
  STAGE_2_REQUIREMENTS: "STAGE_2_PRD_SRS",
  STAGE_3_ARCHITECTURE: "STAGE_3_ARCHITECTURE_DESIGN",
  STAGE_4_SPEC_FREEZE: "STAGE_4_VALIDATION_REPORT",
};

export function validateCreateCostSessionInput(input: CreateCostSessionInput): void {
  if (!Number.isSafeInteger(input.max_tokens_per_request) || input.max_tokens_per_request <= 0) {
    throw new PostgresRlsError("23514", "max_tokens_per_request must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(input.max_cost_micro_usd_per_request) ||
    input.max_cost_micro_usd_per_request < 0
  ) {
    throw new PostgresRlsError(
      "23514",
      "max_cost_micro_usd_per_request must be a non-negative safe integer"
    );
  }
  if (!Number.isSafeInteger(input.session_token_budget) || input.session_token_budget <= 0) {
    throw new PostgresRlsError("23514", "session_token_budget must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(input.session_cost_budget_micro_usd) ||
    input.session_cost_budget_micro_usd < 0
  ) {
    throw new PostgresRlsError(
      "23514",
      "session_cost_budget_micro_usd must be a non-negative safe integer"
    );
  }
}

export function normalizeCreateStage1DiscoveryItem(
  item: CreateStage1DiscoveryItemInput
): {
  readonly title: string;
  readonly statement: string;
  readonly confirmation_status: Stage1ConfirmationStatus;
  readonly clarification_question: string | null;
} {
  const title = item.title.trim();
  const statement = item.statement.trim();
  if (!title || !statement) {
    throw new PostgresRlsError("23514", "Stage 1 discovery item title and statement must be non-empty");
  }

  const defaultStatus: Stage1ConfirmationStatus =
    item.kind === "FACT" ? "AUTO_VERIFIED" : "UNCONFIRMED";
  const status = item.confirmation_status ?? defaultStatus;

  if ((item.kind === "ASSUMPTION" || item.kind === "RECOMMENDATION") && status === "AUTO_VERIFIED") {
    throw new Ac10ViolationError(
      `AC-10 violation: Stage 1 ${item.kind} "${title}" cannot be AUTO_VERIFIED; human confirmation is required`
    );
  }
  if (status === "CONFIRMED" || status === "REJECTED") {
    throw new PostgresRlsError(
      "23514",
      "Stage 1 items cannot be created directly as CONFIRMED/REJECTED without human resolution actor"
    );
  }

  const trimmedQuestion =
    typeof item.clarification_question === "string" ? item.clarification_question.trim() : "";
  const clarification_question = trimmedQuestion.length > 0 ? trimmedQuestion : null;
  if ((item.kind === "ASSUMPTION" || item.kind === "RECOMMENDATION") && !clarification_question) {
    throw new PostgresRlsError(
      "23514",
      `Stage 1 ${item.kind} "${title}" requires a non-empty clarification_question`
    );
  }

  return {
    title,
    statement,
    confirmation_status: status,
    clarification_question,
  };
}

export function validateStageArtifactKindAndHash(input: {
  readonly stage: PipelineStageName;
  readonly artifact_kind: StageArtifactKind;
  readonly content_json: Readonly<Record<string, unknown>>;
  readonly artifact_sha256?: string;
}): string {
  const expectedKind = STAGE_TO_ARTIFACT_KIND[input.stage];
  if (input.artifact_kind !== expectedKind) {
    throw new PostgresRlsError(
      "23514",
      `Artifact kind ${input.artifact_kind} is invalid for stage ${input.stage} (expected ${expectedKind})`
    );
  }
  if (!input.content_json || typeof input.content_json !== "object" || Array.isArray(input.content_json)) {
    throw new PostgresRlsError("23514", "Stage artifact content_json must be a JSON object");
  }
  const computedSha = computeCanonicalPayloadSha256(input.content_json as Record<string, unknown>);
  if (input.artifact_sha256 !== undefined && input.artifact_sha256 !== computedSha) {
    throw new PostgresRlsError(
      "23514",
      `artifact_sha256 (${input.artifact_sha256}) does not match canonical hash (${computedSha})`
    );
  }
  return computedSha;
}

export function validateStage2Ac10References(
  contentJson: Readonly<Record<string, unknown>>,
  sessionItems: readonly Stage1DiscoveryItemRecord[],
  pipelineSessionId: string
): void {
  const rawSrs = contentJson.srs;
  if (!rawSrs || typeof rawSrs !== "object" || Array.isArray(rawSrs)) {
    throw new PostgresRlsError("23514", "Stage 2 artifact must contain object content_json.srs");
  }
  const srs = rawSrs as Record<string, unknown>;
  if (srs.functional_requirements !== undefined && !Array.isArray(srs.functional_requirements)) {
    throw new PostgresRlsError(
      "23514",
      "AC-10 violation: content_json.srs.functional_requirements must be a JSON array"
    );
  }
  if (
    srs.non_functional_requirements !== undefined &&
    !Array.isArray(srs.non_functional_requirements)
  ) {
    throw new PostgresRlsError(
      "23514",
      "AC-10 violation: content_json.srs.non_functional_requirements must be a JSON array"
    );
  }
  const functionalReqs = srs.functional_requirements ?? [];
  const nonFunctionalReqs = srs.non_functional_requirements ?? [];
  const allReqs = [...functionalReqs, ...nonFunctionalReqs];

  const itemMap = new Map<string, Stage1DiscoveryItemRecord>();
  for (const item of sessionItems) {
    itemMap.set(item.item_id, item);
  }

  for (const rawReq of allReqs) {
    if (!rawReq || typeof rawReq !== "object" || Array.isArray(rawReq)) {
      throw new Ac10ViolationError("AC-10 violation: invalid Stage 2 requirement entry");
    }
    const req = rawReq as Record<string, unknown>;
    const reqId = typeof req.req_id === "string" && req.req_id.trim() ? req.req_id : "unknown";
    const sourceIds = req.source_discovery_item_ids;
    if (!Array.isArray(sourceIds) || sourceIds.length < 1) {
      throw new Ac10ViolationError(
        `AC-10 violation: Stage 2 requirement ${reqId} must reference >= 1 Stage 1 discovery item`
      );
    }

    for (const rawSrcId of sourceIds) {
      if (!isUuidString(rawSrcId)) {
        throw new Ac10ViolationError(
          `AC-10 violation: invalid Stage 1 source UUID ${String(rawSrcId)} in requirement ${reqId}`
        );
      }
      const item = itemMap.get(rawSrcId);
      if (!item || item.pipeline_session_id !== pipelineSessionId) {
        throw new Ac10ViolationError(
          `AC-10 violation: referenced Stage 1 item ${rawSrcId} does not belong to session ${pipelineSessionId}`,
          [rawSrcId]
        );
      }
      if (item.confirmation_status !== "AUTO_VERIFIED" && item.confirmation_status !== "CONFIRMED") {
        throw new Ac10ViolationError(
          `AC-10 violation: Stage 2 requirement ${reqId} references Stage 1 ${item.kind} (${rawSrcId}) in non-confirmed status ${item.confirmation_status}`,
          [rawSrcId]
        );
      }
    }
  }
}

export function computeBaselineFreezeBundleSha256(
  input: Pick<
    FreezeBaselineSpecInput,
    | "project_id"
    | "pipeline_session_id"
    | "stage1_artifact_id"
    | "stage1_artifact_sha256"
    | "stage2_artifact_id"
    | "stage2_artifact_sha256"
    | "stage3_artifact_id"
    | "stage3_artifact_sha256"
    | "validation_report_artifact_id"
    | "validation_report_sha256"
    | "approval_gate_id"
  >
): string {
  return sha256Hex(
    canonicalizeJson({
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id,
      stage1_artifact_id: input.stage1_artifact_id,
      stage1_artifact_sha256: input.stage1_artifact_sha256,
      stage2_artifact_id: input.stage2_artifact_id,
      stage2_artifact_sha256: input.stage2_artifact_sha256,
      stage3_artifact_id: input.stage3_artifact_id,
      stage3_artifact_sha256: input.stage3_artifact_sha256,
      validation_report_artifact_id: input.validation_report_artifact_id,
      validation_report_sha256: input.validation_report_sha256,
      approval_gate_id: input.approval_gate_id,
    })
  );
}

export function validateFreezeBaselineSpecInvariants(input: {
  readonly request: FreezeBaselineSpecInput;
  readonly session: ProductPipelineSessionRecord | null;
  readonly stage1Artifact: StageArtifactRecord | null;
  readonly stage2Artifact: StageArtifactRecord | null;
  readonly stage3Artifact: StageArtifactRecord | null;
  readonly validationReportArtifact: StageArtifactRecord | null;
  readonly latestStage4Artifact?: StageArtifactRecord | null;
  readonly stage1Items?: readonly Stage1DiscoveryItemRecord[];
  readonly approvalGate: StageApprovalGateRecord | null;
  readonly existingFreeze: BaselineSpecFreezeRecord | null;
}): void {
  const { request, session } = input;
  if (!session || session.project_id !== request.project_id) {
    throw new PostgresRlsError("23503", `Pipeline session ${request.pipeline_session_id} not found`);
  }
  if (session.status !== "ACTIVE") {
    throw new PostgresRlsError(
      "23514",
      `Cannot freeze baseline when session ${request.pipeline_session_id} status is ${session.status}`
    );
  }
  if (input.existingFreeze) {
    throw new PostgresRlsError(
      "23505",
      `Pipeline session ${request.pipeline_session_id} already has a frozen baseline ${input.existingFreeze.baseline_id}`
    );
  }

  const verifyStageRef = (
    artifact: StageArtifactRecord | null,
    expectedId: string,
    expectedSha: string,
    expectedStage: PipelineStageName,
    label: string
  ): void => {
    if (
      !artifact ||
      artifact.artifact_id !== expectedId ||
      artifact.project_id !== request.project_id ||
      artifact.pipeline_session_id !== request.pipeline_session_id ||
      artifact.artifact_sha256 !== expectedSha
    ) {
      throw new PostgresRlsError(
        "23503",
        `Baseline freeze ${label} artifact (${expectedId}) or sha256 mismatch`
      );
    }
    if (artifact.stage !== expectedStage) {
      throw new PostgresRlsError(
        "23514",
        `BaselineSpecFreeze ${label} stage is ${artifact.stage}, expected ${expectedStage}`
      );
    }
  };

  verifyStageRef(
    input.stage1Artifact,
    request.stage1_artifact_id,
    request.stage1_artifact_sha256,
    "STAGE_1_IDEA_DISCOVERY",
    "stage1"
  );
  verifyStageRef(
    input.stage2Artifact,
    request.stage2_artifact_id,
    request.stage2_artifact_sha256,
    "STAGE_2_REQUIREMENTS",
    "stage2"
  );
  verifyStageRef(
    input.stage3Artifact,
    request.stage3_artifact_id,
    request.stage3_artifact_sha256,
    "STAGE_3_ARCHITECTURE",
    "stage3"
  );
  verifyStageRef(
    input.validationReportArtifact,
    request.validation_report_artifact_id,
    request.validation_report_sha256,
    "STAGE_4_SPEC_FREEZE",
    "validation_report"
  );

  const report = input.validationReportArtifact!;
  if (
    input.latestStage4Artifact &&
    (report.artifact_id !== input.latestStage4Artifact.artifact_id ||
      report.version !== input.latestStage4Artifact.version)
  ) {
    throw new PostgresRlsError(
      "23514",
      `Cannot freeze baseline: Stage 4 validation report ${report.artifact_id} (v${report.version}) is not the latest report (v${input.latestStage4Artifact.version}: ${input.latestStage4Artifact.artifact_id})`
    );
  }

  if (report.content_json.passed !== true) {
    throw new PostgresRlsError(
      "23514",
      "Cannot freeze baseline: Stage 4 CrossArtifactConsistencyChecker report passed is not TRUE"
    );
  }

  const reportJson = report.content_json as Record<string, unknown>;
  const refS1 =
    typeof reportJson.referenced_stage1_artifact_id === "string"
      ? reportJson.referenced_stage1_artifact_id.trim()
      : "";
  const refS2 =
    typeof reportJson.referenced_stage2_artifact_id === "string"
      ? reportJson.referenced_stage2_artifact_id.trim()
      : "";
  const refS3 =
    typeof reportJson.referenced_stage3_artifact_id === "string"
      ? reportJson.referenced_stage3_artifact_id.trim()
      : "";
  if (
    (refS1 && refS1 !== request.stage1_artifact_id) ||
    (refS2 && refS2 !== request.stage2_artifact_id) ||
    (refS3 && refS3 !== request.stage3_artifact_id)
  ) {
    throw new PostgresRlsError(
      "23514",
      `Cannot freeze baseline: Stage 1..3 artifact IDs do not match Stage 4 validation report ${report.artifact_id} references`
    );
  }

  if (input.stage1Items !== undefined) {
    validateStage2Ac10References(
      input.stage2Artifact!.content_json,
      input.stage1Items,
      request.pipeline_session_id
    );
  }

  const gate = input.approvalGate;
  if (
    !gate ||
    gate.gate_id !== request.approval_gate_id ||
    gate.project_id !== request.project_id ||
    gate.pipeline_session_id !== request.pipeline_session_id ||
    gate.gate_stage !== "STAGE_4_SPEC_FREEZE" ||
    gate.target_artifact_id !== request.validation_report_artifact_id ||
    gate.target_artifact_sha256 !== request.validation_report_sha256 ||
    gate.decision !== "APPROVED"
  ) {
    throw new PostgresRlsError(
      "23503",
      `Baseline freeze requires an APPROVED STAGE_4_SPEC_FREEZE approval gate bound to validation report ${request.validation_report_artifact_id}`
    );
  }
}

export function buildProductPipelineBundle(input: {
  readonly session: ProductPipelineSessionRecord;
  readonly costSession: CostSessionRecord | null;
  readonly modelCallLedgers: readonly ModelCallLedgerRecord[];
  readonly discoveryItems: readonly Stage1DiscoveryItemRecord[];
  readonly artifacts: readonly StageArtifactRecord[];
  readonly approvalGates: readonly StageApprovalGateRecord[];
  readonly baselineFreeze: BaselineSpecFreezeRecord | null;
}): ProductPipelineBundle {
  return {
    session: { ...input.session },
    costSession: input.costSession ? { ...input.costSession } : null,
    modelCallLedgers: input.modelCallLedgers.map((l) => ({ ...l })),
    discoveryItems: input.discoveryItems.map((d) => ({ ...d })),
    artifacts: input.artifacts.map((a) => ({ ...a })),
    approvalGates: input.approvalGates.map((g) => ({ ...g })),
    baselineFreeze: input.baselineFreeze ? { ...input.baselineFreeze } : null,
  };
}
