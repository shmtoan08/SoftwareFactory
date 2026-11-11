import {
  type Stage1DiscoveryItemRecord,
  type Stage2RequirementItem,
  type Stage2RequirementsSpec,
  type Stage3ArchitectureSpec,
  type Stage4ConsistencyCheckResult,
  type Stage4ConsistencyReport,
  type StageArtifactRecord,
  computeCanonicalPayloadSha256,
} from "@software-factory/shared-types";

export interface CrossArtifactConsistencyCheckInput {
  readonly pipelineSessionId: string;
  readonly stage1Items: readonly Stage1DiscoveryItemRecord[];
  readonly stage1Artifact: StageArtifactRecord | null;
  readonly stage2Artifact: StageArtifactRecord | null;
  readonly stage3Artifact: StageArtifactRecord | null;
  readonly checkedAt?: string;
}

function asRequirementArray(raw: unknown): Stage2RequirementItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (item): item is Stage2RequirementItem => Boolean(item) && typeof item === "object"
  );
}

/**
 * Deterministic Stage 4 `CrossArtifactConsistencyChecker` (`CHK-01` .. `CHK-05`).
 * Verifies `AC-10` grounding, Stage 1 -> Stage 2 coverage, Stage 2 <-> Stage 3 bidirectional
 * traceability, Stage 3 5-section completeness, and canonical SHA-256 integrity.
 */
export function runCrossArtifactConsistencyCheck(
  input: CrossArtifactConsistencyCheckInput
): Stage4ConsistencyReport {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const checks: Stage4ConsistencyCheckResult[] = [];
  const blockingErrors: string[] = [];

  const recordCheck = (result: Stage4ConsistencyCheckResult): void => {
    checks.push(result);
    if (!result.passed && result.severity === "ERROR") {
      blockingErrors.push(`${result.check_id} (${result.name}): ${result.details}`);
    }
  };

  // Parse Stage 2 Requirements safely
  const stage2Content = (input.stage2Artifact?.content_json ?? {}) as Partial<Stage2RequirementsSpec>;
  const functionalReqs = asRequirementArray(stage2Content?.srs?.functional_requirements);
  const nonFunctionalReqs = asRequirementArray(stage2Content?.srs?.non_functional_requirements);
  const allReqs = [...functionalReqs, ...nonFunctionalReqs];

  // Parse Stage 3 Architecture safely
  const stage3Content = (input.stage3Artifact?.content_json ?? {}) as Partial<Stage3ArchitectureSpec>;
  const components = Array.isArray(stage3Content?.architecture?.components)
    ? stage3Content.architecture.components
    : [];
  const entities = Array.isArray(stage3Content?.database_erd?.entities)
    ? stage3Content.database_erd.entities
    : [];
  const endpoints = Array.isArray(stage3Content?.api_spec?.endpoints)
    ? stage3Content.api_spec.endpoints
    : [];
  const threatControls = Array.isArray(stage3Content?.security_design?.threat_controls)
    ? stage3Content.security_design.threat_controls
    : [];
  const adrs = Array.isArray(stage3Content?.adrs) ? stage3Content.adrs : [];

  // CHK-01: AC-10 Non-Promotion & Grounding Verification
  const stage1ItemMap = new Map<string, Stage1DiscoveryItemRecord>();
  for (const item of input.stage1Items) {
    stage1ItemMap.set(item.item_id, item);
  }
  const chk01Affected: string[] = [];
  const chk01Reasons: string[] = [];
  if (!input.stage2Artifact || allReqs.length === 0) {
    chk01Affected.push(input.stage2Artifact?.artifact_id ?? input.pipelineSessionId);
    chk01Reasons.push("Stage 2 artifact is missing or defines zero requirements");
  } else {
    for (const req of allReqs) {
      const reqId = typeof req.req_id === "string" && req.req_id.trim() ? req.req_id : "unknown";
      const srcIds = Array.isArray(req.source_discovery_item_ids)
        ? req.source_discovery_item_ids
        : [];
      if (srcIds.length === 0) {
        chk01Affected.push(reqId);
        chk01Reasons.push(`Requirement ${reqId} has empty source_discovery_item_ids`);
        continue;
      }
      for (const srcId of srcIds) {
        const item = stage1ItemMap.get(srcId);
        if (!item || item.pipeline_session_id !== input.pipelineSessionId) {
          chk01Affected.push(srcId);
          chk01Reasons.push(`Requirement ${reqId} references missing Stage 1 item ${srcId}`);
        } else if (
          item.confirmation_status !== "AUTO_VERIFIED" &&
          item.confirmation_status !== "CONFIRMED"
        ) {
          chk01Affected.push(item.item_id);
          chk01Reasons.push(
            `AC-10 violation: ${reqId} references Stage 1 ${item.kind} ${item.item_id} in status ${item.confirmation_status}`
          );
        }
      }
    }
  }
  recordCheck({
    check_id: "CHK-01",
    name: "AC-10 Stage 1 Grounding & Confirmed Reference Integrity",
    passed: chk01Reasons.length === 0,
    severity: "ERROR",
    details:
      chk01Reasons.length === 0
        ? `All ${allReqs.length} Stage 2 requirements reference verified AUTO_VERIFIED/CONFIRMED Stage 1 items`
        : chk01Reasons.join("; "),
    affected_ids: [...new Set(chk01Affected)],
  });

  // CHK-02: Stage 1 -> Stage 2 Coverage, Unique req_id & Acceptance Criteria Presence
  const referencedItemIds = new Set<string>();
  const seenReqIds = new Set<string>();
  const chk02Affected: string[] = [];
  const chk02Reasons: string[] = [];
  for (const req of allReqs) {
    const reqId = typeof req.req_id === "string" ? req.req_id.trim() : "";
    if (!reqId) {
      chk02Reasons.push("Requirement missing non-empty req_id");
      continue;
    }
    if (seenReqIds.has(reqId)) {
      chk02Affected.push(reqId);
      chk02Reasons.push(`Duplicate Stage 2 req_id ${reqId}`);
    }
    seenReqIds.add(reqId);
    if (!Array.isArray(req.acceptance_criteria) || req.acceptance_criteria.length === 0) {
      chk02Affected.push(reqId);
      chk02Reasons.push(`Requirement ${reqId} has zero acceptance_criteria`);
    }
    if (Array.isArray(req.source_discovery_item_ids)) {
      for (const id of req.source_discovery_item_ids) {
        referencedItemIds.add(id);
      }
    }
  }
  for (const item of input.stage1Items) {
    if (
      item.confirmation_status === "AUTO_VERIFIED" ||
      item.confirmation_status === "CONFIRMED"
    ) {
      if (!referencedItemIds.has(item.item_id)) {
        chk02Affected.push(item.item_id);
        chk02Reasons.push(
          `Verified Stage 1 ${item.kind} "${item.title}" (${item.item_id}) is not covered by any Stage 2 requirement`
        );
      }
    }
  }
  recordCheck({
    check_id: "CHK-02",
    name: "Stage 1 to Stage 2 Coverage & Acceptance Criteria",
    passed: chk02Reasons.length === 0,
    severity: "ERROR",
    details:
      chk02Reasons.length === 0
        ? "All verified Stage 1 items are traced into unique Stage 2 requirements with acceptance criteria"
        : chk02Reasons.join("; "),
    affected_ids: [...new Set(chk02Affected)],
  });

  // CHK-03: Stage 2 <-> Stage 3 Bidirectional Traceability
  const componentCoveredReqs = new Set<string>();
  const techCoveredReqs = new Set<string>();
  const danglingStage3Reqs: string[] = [];
  const chk03Affected: string[] = [];
  const chk03Reasons: string[] = [];

  for (const comp of components) {
    for (const rid of comp.requirement_ids ?? []) {
      componentCoveredReqs.add(rid);
      if (!seenReqIds.has(rid)) {
        danglingStage3Reqs.push(`${comp.component_id}->${rid}`);
        chk03Affected.push(rid);
      }
    }
  }
  const collectTech = (label: string, entries: ReadonlyArray<{ readonly requirement_ids?: readonly string[] }>) => {
    for (const entry of entries) {
      for (const rid of entry.requirement_ids ?? []) {
        techCoveredReqs.add(rid);
        if (!seenReqIds.has(rid)) {
          danglingStage3Reqs.push(`${label}->${rid}`);
          chk03Affected.push(rid);
        }
      }
    }
  };
  collectTech("ERD", entities);
  collectTech("API", endpoints);
  collectTech("Security", threatControls);
  collectTech("ADR", adrs);

  if (!input.stage3Artifact) {
    chk03Affected.push(input.pipelineSessionId);
    chk03Reasons.push("Stage 3 Architecture artifact is missing");
  } else {
    for (const reqId of seenReqIds) {
      if (!componentCoveredReqs.has(reqId)) {
        chk03Affected.push(reqId);
        chk03Reasons.push(`Stage 2 requirement ${reqId} has no covering Stage 3 architecture component`);
      }
      if (!techCoveredReqs.has(reqId)) {
        chk03Affected.push(reqId);
        chk03Reasons.push(
          `Stage 2 requirement ${reqId} has no covering ERD, API endpoint, Security control, or ADR`
        );
      }
    }
    if (danglingStage3Reqs.length > 0) {
      chk03Reasons.push(
        `Stage 3 references unknown Stage 2 requirement_ids: ${[...new Set(danglingStage3Reqs)].join(", ")}`
      );
    }
  }
  recordCheck({
    check_id: "CHK-03",
    name: "Stage 2 <-> Stage 3 Bidirectional Traceability",
    passed: chk03Reasons.length === 0,
    severity: "ERROR",
    details:
      chk03Reasons.length === 0
        ? `Bidirectional traceability verified across all ${seenReqIds.size} Stage 2 requirements`
        : chk03Reasons.join("; "),
    affected_ids: [...new Set(chk03Affected)],
  });

  // CHK-04: Stage 3 5-Section Completeness
  const chk04Missing: string[] = [];
  if (
    !stage3Content?.architecture?.overview ||
    !stage3Content.architecture.overview.trim()
  ) {
    chk04Missing.push("architecture.overview");
  }
  if (components.length === 0) chk04Missing.push("architecture.components");
  if (entities.length === 0) chk04Missing.push("database_erd.entities");
  if (endpoints.length === 0) chk04Missing.push("api_spec.endpoints");
  if (threatControls.length === 0) chk04Missing.push("security_design.threat_controls");
  if (adrs.length === 0) chk04Missing.push("adrs");
  recordCheck({
    check_id: "CHK-04",
    name: "Stage 3 Technical Specification Completeness",
    passed: chk04Missing.length === 0,
    severity: "ERROR",
    details:
      chk04Missing.length === 0
        ? "All 5 Stage 3 sections (architecture, database_erd, api_spec, security_design, adrs) are populated"
        : `Missing or empty Stage 3 sections: ${chk04Missing.join(", ")}`,
    affected_ids: chk04Missing,
  });

  // CHK-05: Cryptographic Canonical JSON SHA-256 Verification
  const chk05Affected: string[] = [];
  const chk05Reasons: string[] = [];
  const artifactsToVerify: Array<[string, StageArtifactRecord | null]> = [
    ["Stage 1", input.stage1Artifact],
    ["Stage 2", input.stage2Artifact],
    ["Stage 3", input.stage3Artifact],
  ];
  for (const [label, artifact] of artifactsToVerify) {
    if (!artifact) {
      chk05Affected.push(label);
      chk05Reasons.push(`${label} artifact missing for hash verification`);
      continue;
    }
    const recomputed = computeCanonicalPayloadSha256(
      artifact.content_json as Record<string, unknown>
    );
    if (recomputed !== artifact.artifact_sha256) {
      chk05Affected.push(artifact.artifact_id);
      chk05Reasons.push(
        `${label} artifact (${artifact.artifact_id}) canonical SHA-256 mismatch: expected ${artifact.artifact_sha256}, computed ${recomputed}`
      );
    }
  }
  recordCheck({
    check_id: "CHK-05",
    name: "Cryptographic Artifact SHA-256 Integrity",
    passed: chk05Reasons.length === 0,
    severity: "ERROR",
    details:
      chk05Reasons.length === 0
        ? "Canonical JSON SHA-256 digests verified for Stages 1..3 artifacts"
        : chk05Reasons.join("; "),
    affected_ids: [...new Set(chk05Affected)],
  });

  return {
    pipeline_session_id: input.pipelineSessionId,
    passed: blockingErrors.length === 0,
    checks,
    blocking_errors: blockingErrors,
    referenced_stage1_artifact_id: input.stage1Artifact?.artifact_id ?? "",
    referenced_stage2_artifact_id: input.stage2Artifact?.artifact_id ?? "",
    referenced_stage3_artifact_id: input.stage3Artifact?.artifact_id ?? "",
    checked_at: checkedAt,
  };
}
