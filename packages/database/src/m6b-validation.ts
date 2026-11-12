import {
  type AgentOrgRole,
  type AgentOrganizationProfileRecord,
  type ExecutionTargetType,
  type Stage7PlanningOutput,
  type TargetTrustTier,
  type TrustedAcceptanceTestSpec,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import {
  DEFAULT_SYSTEM_FORBIDDEN_PATHS,
  isSafeRelativePosixPath,
  matchesAnyGlob,
} from "@software-factory/task-contract";
import {
  type CreateChangeRequestStoreInput,
  type CreateProjectBootstrapInput,
  PostgresRlsError,
  type RecordReleaseAcceptancePackageInput,
  type UpsertAgentOrganizationProfileInput,
} from "./types.ts";

export const AGENT_ORG_ROLES: readonly AgentOrgRole[] = [
  "PLANNER",
  "DEVELOPER",
  "REVIEWER_READONLY",
  "VERIFIER",
];

export const EXECUTION_TARGET_TYPES: readonly ExecutionTargetType[] = [
  "factory_managed_worker",
  "user_managed_worker",
  "provider_managed_vm",
  "remote_agent_session",
];

export const TARGET_TRUST_TIERS: readonly TargetTrustTier[] = [
  "TIER_1_FACTORY_MANAGED",
  "TIER_2_USER_MANAGED",
  "TIER_3_PROVIDER_VM",
  "TIER_4_REMOTE_SESSION",
];

export const EXPECTED_TRUST_TIER_BY_TARGET: Readonly<Record<ExecutionTargetType, TargetTrustTier>> = {
  factory_managed_worker: "TIER_1_FACTORY_MANAGED",
  user_managed_worker: "TIER_2_USER_MANAGED",
  provider_managed_vm: "TIER_3_PROVIDER_VM",
  remote_agent_session: "TIER_4_REMOTE_SESSION",
};

export const REQUIRED_STAGE5_PROTECTED_PATHS: readonly string[] = [
  "policy/trusted-verification-policy.json",
  "tests/protected/**",
];

export function validateProjectBootstrapInput(
  input: Pick<
    CreateProjectBootstrapInput,
    | "repo_path"
    | "trusted_acceptance_dir"
    | "base_main_commit_hash"
    | "protected_paths"
    | "trusted_policy_sha256"
    | "acceptance_tests"
    | "created_by_principal_id"
  >
): void {
  if (
    !input.repo_path.trim() ||
    !input.trusted_acceptance_dir.trim() ||
    !input.created_by_principal_id.trim()
  ) {
    throw new PostgresRlsError(
      "23514",
      "repo_path, trusted_acceptance_dir, and created_by_principal_id must be non-empty"
    );
  }
  if (
    !/^[0-9a-f]{40}$/i.test(input.base_main_commit_hash) ||
    !/^[0-9a-f]{64}$/i.test(input.trusted_policy_sha256) ||
    input.acceptance_tests.length === 0
  ) {
    throw new PostgresRlsError(
      "23514",
      "Invalid project bootstrap hashes or empty acceptance_tests"
    );
  }
  for (const requiredPath of REQUIRED_STAGE5_PROTECTED_PATHS) {
    if (!input.protected_paths.includes(requiredPath)) {
      throw new PostgresRlsError(
        "23514",
        `Project bootstrap protected_paths must include '${requiredPath}'`
      );
    }
  }
}

export interface ExtractedStage2Requirement {
  readonly req_id: string;
  readonly category: "FR" | "NFR";
  readonly title: string;
  readonly statement: string;
  readonly source_discovery_item_ids: readonly string[];
  readonly ac_ids: readonly string[];
  readonly acceptance_criteria: ReadonlyArray<{
    readonly ac_id: string;
    readonly given: string;
    readonly when: string;
    readonly then: string;
  }>;
}

export interface ExtractedStage3DesignIndex {
  readonly componentIds: readonly string[];
  readonly componentsById: ReadonlyMap<string, { readonly component_id: string; readonly name: string; readonly requirement_ids: readonly string[] }>;
  readonly componentsByReqId: ReadonlyMap<string, readonly string[]>;
  readonly erdTablesByReqId: ReadonlyMap<string, readonly string[]>;
  readonly apiEndpointsByReqId: ReadonlyMap<string, readonly string[]>;
  readonly securityControlsByReqId: ReadonlyMap<string, readonly string[]>;
  readonly adrsByReqId: ReadonlyMap<string, readonly string[]>;
}

function asNonEmptyStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

export function extractStage2Requirements(
  stage2ContentJson: Readonly<Record<string, unknown>>
): ExtractedStage2Requirement[] {
  const srs = stage2ContentJson.srs;
  if (!srs || typeof srs !== "object" || Array.isArray(srs)) {
    throw new PostgresRlsError("23514", "Frozen Stage 2 artifact is missing object srs");
  }
  const srsObj = srs as Record<string, unknown>;
  if (!Array.isArray(srsObj.functional_requirements)) {
    throw new PostgresRlsError(
      "23514",
      "Frozen Stage 2 artifact srs.functional_requirements must be an array"
    );
  }
  if (
    srsObj.non_functional_requirements !== undefined &&
    !Array.isArray(srsObj.non_functional_requirements)
  ) {
    throw new PostgresRlsError(
      "23514",
      "Frozen Stage 2 artifact srs.non_functional_requirements must be an array"
    );
  }
  const frs = srsObj.functional_requirements;
  const nfrs = srsObj.non_functional_requirements ?? [];

  const result: ExtractedStage2Requirement[] = [];
  const seenReqIds = new Set<string>();
  const seenAcIds = new Set<string>();
  const pushList = (list: unknown[], category: "FR" | "NFR") => {
    for (let idx = 0; idx < list.length; idx += 1) {
      const rawReq = list[idx];
      if (!rawReq || typeof rawReq !== "object" || Array.isArray(rawReq)) {
        throw new PostgresRlsError(
          "23514",
          `Frozen Stage 2 ${category} requirement at index ${idx} must be an object`
        );
      }
      const req = rawReq as Record<string, unknown>;
      const req_id = typeof req.req_id === "string" ? req.req_id.trim() : "";
      if (!req_id) {
        throw new PostgresRlsError(
          "23514",
          `Frozen Stage 2 ${category} requirement at index ${idx} is missing non-empty req_id`
        );
      }
      if (seenReqIds.has(req_id)) {
        throw new PostgresRlsError(
          "23514",
          `Frozen Stage 2 artifact contains duplicate req_id '${req_id}'`
        );
      }
      seenReqIds.add(req_id);
      if (!Array.isArray(req.acceptance_criteria)) {
        throw new PostgresRlsError(
          "23514",
          `Frozen Stage 2 requirement '${req_id}' must have an acceptance_criteria array`
        );
      }
      const acceptance_criteria: Array<{
        ac_id: string;
        given: string;
        when: string;
        then: string;
      }> = [];
      for (let acIdx = 0; acIdx < req.acceptance_criteria.length; acIdx += 1) {
        const rawAc = req.acceptance_criteria[acIdx];
        if (!rawAc || typeof rawAc !== "object" || Array.isArray(rawAc)) {
          throw new PostgresRlsError(
            "23514",
            `Frozen Stage 2 requirement '${req_id}' acceptance criterion at index ${acIdx} must be an object`
          );
        }
        const ac = rawAc as Record<string, unknown>;
        const ac_id = typeof ac.ac_id === "string" ? ac.ac_id.trim() : "";
        if (!ac_id) {
          throw new PostgresRlsError(
            "23514",
            `Frozen Stage 2 requirement '${req_id}' acceptance criterion at index ${acIdx} is missing non-empty ac_id`
          );
        }
        if (seenAcIds.has(ac_id)) {
          throw new PostgresRlsError(
            "23514",
            `Frozen Stage 2 artifact contains duplicate ac_id '${ac_id}'`
          );
        }
        seenAcIds.add(ac_id);
        const given = typeof ac.given === "string" ? ac.given.trim() : "";
        const when = typeof ac.when === "string" ? ac.when.trim() : "";
        const thenText = typeof ac.then === "string" ? ac.then.trim() : "";
        acceptance_criteria.push({ ac_id, given, when, then: thenText });
      }
      result.push({
        req_id,
        category,
        title: typeof req.title === "string" ? req.title.trim() : req_id,
        statement:
          typeof req.description === "string" && req.description.trim()
            ? req.description.trim()
            : typeof req.statement === "string"
            ? req.statement.trim()
            : "",
        source_discovery_item_ids: asNonEmptyStringArray(req.source_discovery_item_ids),
        ac_ids: acceptance_criteria.map((a) => a.ac_id),
        acceptance_criteria,
      });
    }
  };
  pushList(frs, "FR");
  pushList(nfrs, "NFR");
  return result;
}

export function extractStage3DesignIndex(
  stage3ContentJson: Readonly<Record<string, unknown>>
): ExtractedStage3DesignIndex {
  const componentIds: string[] = [];
  const componentsById = new Map<
    string,
    { readonly component_id: string; readonly name: string; readonly requirement_ids: readonly string[] }
  >();
  const componentsByReqId = new Map<string, string[]>();
  const erdTablesByReqId = new Map<string, string[]>();
  const apiEndpointsByReqId = new Map<string, string[]>();
  const securityControlsByReqId = new Map<string, string[]>();
  const adrsByReqId = new Map<string, string[]>();

  const pushToMap = (map: Map<string, string[]>, reqId: string, val: string) => {
    const existing = map.get(reqId);
    if (existing) {
      if (!existing.includes(val)) {
        existing.push(val);
      }
    } else {
      map.set(reqId, [val]);
    }
  };

  const arch = stage3ContentJson.architecture;
  if (arch && typeof arch === "object" && !Array.isArray(arch)) {
    const comps = (arch as Record<string, unknown>).components;
    if (Array.isArray(comps)) {
      for (const rawComp of comps) {
        if (!rawComp || typeof rawComp !== "object" || Array.isArray(rawComp)) continue;
        const c = rawComp as Record<string, unknown>;
        const cid = typeof c.component_id === "string" ? c.component_id.trim() : "";
        const name = typeof c.name === "string" ? c.name.trim() : cid;
        const reqIds = asNonEmptyStringArray(c.requirement_ids);
        if (!cid) continue;
        componentIds.push(cid);
        componentsById.set(cid, { component_id: cid, name, requirement_ids: reqIds });
        for (const r of reqIds) {
          pushToMap(componentsByReqId, r, cid);
        }
      }
    }
  }

  const erd = stage3ContentJson.database_erd;
  if (erd && typeof erd === "object" && !Array.isArray(erd)) {
    const entities = (erd as Record<string, unknown>).entities;
    if (Array.isArray(entities)) {
      for (const rawEnt of entities) {
        if (!rawEnt || typeof rawEnt !== "object" || Array.isArray(rawEnt)) continue;
        const e = rawEnt as Record<string, unknown>;
        const name = typeof e.entity_name === "string" ? e.entity_name.trim() : "";
        if (!name) continue;
        for (const r of asNonEmptyStringArray(e.requirement_ids)) {
          pushToMap(erdTablesByReqId, r, name);
        }
      }
    }
  }

  const apiSpec = stage3ContentJson.api_spec;
  if (apiSpec && typeof apiSpec === "object" && !Array.isArray(apiSpec)) {
    const endpoints = (apiSpec as Record<string, unknown>).endpoints;
    if (Array.isArray(endpoints)) {
      for (const rawEp of endpoints) {
        if (!rawEp || typeof rawEp !== "object" || Array.isArray(rawEp)) continue;
        const ep = rawEp as Record<string, unknown>;
        const method = typeof ep.method === "string" ? ep.method.trim() : "";
        const path = typeof ep.path === "string" ? ep.path.trim() : "";
        if (!method || !path) continue;
        const label = `${method} ${path}`;
        for (const r of asNonEmptyStringArray(ep.requirement_ids)) {
          pushToMap(apiEndpointsByReqId, r, label);
        }
      }
    }
  }

  const sec = stage3ContentJson.security_design;
  if (sec && typeof sec === "object" && !Array.isArray(sec)) {
    const controls = (sec as Record<string, unknown>).threat_controls;
    if (Array.isArray(controls)) {
      for (const rawCtrl of controls) {
        if (!rawCtrl || typeof rawCtrl !== "object" || Array.isArray(rawCtrl)) continue;
        const ctrl = rawCtrl as Record<string, unknown>;
        const cid =
          typeof ctrl.threat_id === "string" && ctrl.threat_id.trim()
            ? ctrl.threat_id.trim()
            : typeof ctrl.control_id === "string"
            ? ctrl.control_id.trim()
            : "";
        if (!cid) continue;
        for (const r of asNonEmptyStringArray(ctrl.requirement_ids)) {
          pushToMap(securityControlsByReqId, r, cid);
        }
      }
    }
  }

  const adrs = stage3ContentJson.adrs;
  if (Array.isArray(adrs)) {
    for (const rawAdr of adrs) {
      if (!rawAdr || typeof rawAdr !== "object" || Array.isArray(rawAdr)) continue;
      const adr = rawAdr as Record<string, unknown>;
      const adrId = typeof adr.adr_id === "string" ? adr.adr_id.trim() : "";
      if (!adrId) continue;
      for (const r of asNonEmptyStringArray(adr.requirement_ids)) {
        pushToMap(adrsByReqId, r, adrId);
      }
    }
  }

  return {
    componentIds,
    componentsById,
    componentsByReqId,
    erdTablesByReqId,
    apiEndpointsByReqId,
    securityControlsByReqId,
    adrsByReqId,
  };
}

export function validateAgentOrganizationProfileInput(
  input: UpsertAgentOrganizationProfileInput
): void {
  if (!input.profile_key.trim()) {
    throw new PostgresRlsError("23514", "agent_organization_profiles.profile_key must be non-empty");
  }
  if (!AGENT_ORG_ROLES.includes(input.role)) {
    throw new PostgresRlsError("23514", `Unsupported AgentOrgRole: ${input.role}`);
  }
  if (!input.principal_id.trim() || !input.provider.trim() || !input.model.trim()) {
    throw new PostgresRlsError(
      "23514",
      "Agent organization profile principal_id, provider, and model must be non-empty"
    );
  }
  if (!EXECUTION_TARGET_TYPES.includes(input.execution_target_type)) {
    throw new PostgresRlsError(
      "23514",
      `Unsupported execution_target_type: ${input.execution_target_type}`
    );
  }
  if (!TARGET_TRUST_TIERS.includes(input.trust_tier)) {
    throw new PostgresRlsError("23514", `Unsupported trust_tier: ${input.trust_tier}`);
  }
  const expectedTier = EXPECTED_TRUST_TIER_BY_TARGET[input.execution_target_type];
  if (input.trust_tier !== expectedTier) {
    throw new PostgresRlsError(
      "23514",
      `execution_target_type '${input.execution_target_type}' requires trust_tier '${expectedTier}' (got '${input.trust_tier}')`
    );
  }
  if (!input.created_by_principal_id.trim()) {
    throw new PostgresRlsError("23514", "created_by_principal_id must be non-empty");
  }
}

/**
 * Enforces M4/Stage 6 3D Independent Reviewer Separation across Stage 6 Org Profiles:
 *  - distinct human/agent principal identity
 *  - distinct profile_id & profile_key
 *  - distinct (provider, model) pair (case-insensitive)
 */
export function validateStage6DeveloperReviewerPair(
  developerProfile: AgentOrganizationProfileRecord,
  reviewerProfile: AgentOrganizationProfileRecord
): void {
  if (developerProfile.project_id !== reviewerProfile.project_id) {
    throw new PostgresRlsError(
      "23514",
      "3D separation check requires both developer and reviewer profiles in the same project"
    );
  }
  if (developerProfile.role !== "DEVELOPER") {
    throw new PostgresRlsError(
      "23514",
      `Expected DEVELOPER role for developer profile, got ${developerProfile.role}`
    );
  }
  if (reviewerProfile.role !== "REVIEWER_READONLY") {
    throw new PostgresRlsError(
      "23514",
      `Expected REVIEWER_READONLY role for reviewer profile, got ${reviewerProfile.role}`
    );
  }
  if (!developerProfile.is_active || !reviewerProfile.is_active) {
    throw new PostgresRlsError(
      "23514",
      "Both DEVELOPER and REVIEWER_READONLY profiles must be active"
    );
  }
  if (
    developerProfile.profile_id === reviewerProfile.profile_id ||
    developerProfile.profile_key.trim().toLowerCase() ===
      reviewerProfile.profile_key.trim().toLowerCase()
  ) {
    throw new PostgresRlsError(
      "23514",
      "3D separation violation: developer and reviewer cannot share the same agent profile"
    );
  }
  if (
    developerProfile.principal_id.trim().toLowerCase() ===
    reviewerProfile.principal_id.trim().toLowerCase()
  ) {
    throw new PostgresRlsError(
      "23514",
      `3D separation violation: developer and reviewer share principal_id '${developerProfile.principal_id}'`
    );
  }
  if (
    developerProfile.provider.trim().toLowerCase() ===
      reviewerProfile.provider.trim().toLowerCase() &&
    developerProfile.model.trim().toLowerCase() === reviewerProfile.model.trim().toLowerCase()
  ) {
    throw new PostgresRlsError(
      "23514",
      `3D separation violation: developer and reviewer share provider/model '${developerProfile.provider}:${developerProfile.model}'`
    );
  }
}

export function validateAllowedFilesAgainstProtectedAndForbidden(input: {
  readonly allowedFiles: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly contextLabel: string;
}): void {
  if (input.allowedFiles.length === 0) {
    throw new PostgresRlsError(
      "23514",
      `${input.contextLabel}: allowed_files must contain >= 1 relative POSIX path or glob`
    );
  }
  for (const rawPattern of input.allowedFiles) {
    const pattern = rawPattern.trim();
    if (!isSafeRelativePosixPath(pattern)) {
      throw new PostgresRlsError(
        "23514",
        `${input.contextLabel}: unsafe allowed_files path '${rawPattern}'`
      );
    }
    const samplePath = pattern
      .replace(/\/\*\*$/g, "/sample.txt")
      .replace(/\*\*/g, "sub/file")
      .replace(/\*/g, "file")
      .replace(/\?/g, "a");

    const forbiddenMatch =
      matchesAnyGlob(pattern, DEFAULT_SYSTEM_FORBIDDEN_PATHS, true) ??
      matchesAnyGlob(samplePath, DEFAULT_SYSTEM_FORBIDDEN_PATHS, true);
    if (forbiddenMatch) {
      throw new PostgresRlsError(
        "23514",
        `${input.contextLabel}: allowed_files '${pattern}' overlaps system forbidden pattern '${forbiddenMatch}'`
      );
    }
    const protectedMatch =
      matchesAnyGlob(pattern, input.protectedPaths, false) ??
      matchesAnyGlob(samplePath, input.protectedPaths, false);
    if (protectedMatch) {
      throw new PostgresRlsError(
        "23514",
        `${input.contextLabel}: allowed_files '${pattern}' overlaps Stage 5 protected path '${protectedMatch}'`
      );
    }
    for (const prot of input.protectedPaths) {
      const sampleProt = prot
        .replace(/\/\*\*$/g, "/sample.txt")
        .replace(/\*\*/g, "sub/file")
        .replace(/\*/g, "file")
        .replace(/\?/g, "a");
      if (matchesAnyGlob(sampleProt, [pattern], false)) {
        throw new PostgresRlsError(
          "23514",
          `${input.contextLabel}: broad allowed_files pattern '${pattern}' captures protected path '${prot}'`
        );
      }
    }
  }
}

export function validateStage7PlanAgainstBaseline(input: {
  readonly plan: Stage7PlanningOutput;
  readonly stage2ContentJson: Readonly<Record<string, unknown>>;
  readonly protectedPaths: readonly string[];
  readonly profiles: readonly AgentOrganizationProfileRecord[];
}): {
  readonly requirements: readonly ExtractedStage2Requirement[];
  readonly profileByKey: ReadonlyMap<string, AgentOrganizationProfileRecord>;
} {
  const { plan } = input;
  if (
    plan.milestones.length === 0 ||
    plan.epics.length === 0 ||
    plan.stories.length === 0 ||
    plan.tasks.length === 0
  ) {
    throw new PostgresRlsError(
      "23514",
      "Stage 7 plan must contain at least one milestone, epic, story, and task"
    );
  }

  const requirements = extractStage2Requirements(input.stage2ContentJson);
  const validReqIds = new Set(requirements.map((r) => r.req_id));
  const validAcIds = new Set<string>();
  const acsByReqId = new Map<string, Set<string>>();
  const acToReq = new Map<string, string>();
  for (const r of requirements) {
    const acSet = new Set(r.ac_ids);
    acsByReqId.set(r.req_id, acSet);
    for (const ac of r.ac_ids) {
      validAcIds.add(ac);
      acToReq.set(ac, r.req_id);
    }
  }

  const assertReqAcConsistent = (
    entityLabel: string,
    reqIds: readonly string[],
    acIds: readonly string[]
  ): { reqSet: Set<string>; acSet: Set<string> } => {
    const reqSet = new Set(reqIds);
    const acSet = new Set(acIds);
    for (const ac of acSet) {
      const owningReq = acToReq.get(ac);
      if (!owningReq || !reqSet.has(owningReq)) {
        throw new PostgresRlsError(
          "23514",
          `${entityLabel}: ac_id '${ac}' belongs to req_id '${owningReq ?? "unknown"}', which is not listed in requirement_ids`
        );
      }
    }
    for (const r of reqSet) {
      const expectedAcs = acsByReqId.get(r) ?? new Set<string>();
      const hasMatchingAc = [...acSet].some((ac) => expectedAcs.has(ac));
      if (!hasMatchingAc) {
        throw new PostgresRlsError(
          "23514",
          `${entityLabel}: requirement_id '${r}' has no corresponding ac_id in ac_ids`
        );
      }
    }
    return { reqSet, acSet };
  };

  const milestoneKeys = new Set<string>();
  for (const m of plan.milestones) {
    const key = m.milestone_key.trim();
    if (!key || !m.title.trim() || milestoneKeys.has(key)) {
      throw new PostgresRlsError("23514", `Invalid or duplicate milestone_key '${m.milestone_key}'`);
    }
    milestoneKeys.add(key);
  }

  const epicKeys = new Set<string>();
  for (const e of plan.epics) {
    const key = e.epic_key.trim();
    if (!key || !e.title.trim() || epicKeys.has(key)) {
      throw new PostgresRlsError("23514", `Invalid or duplicate epic_key '${e.epic_key}'`);
    }
    if (!milestoneKeys.has(e.milestone_key.trim())) {
      throw new PostgresRlsError(
        "23514",
        `Epic '${key}' references unknown milestone_key '${e.milestone_key}'`
      );
    }
    epicKeys.add(key);
  }

  const storyKeys = new Set<string>();
  const storyScopes = new Map<string, { readonly reqSet: Set<string>; readonly acSet: Set<string> }>();
  const storyCoveredReqs = new Set<string>();
  const storyCoveredAcs = new Set<string>();
  for (const s of plan.stories) {
    const key = s.story_key.trim();
    if (!key || !s.title.trim() || storyKeys.has(key)) {
      throw new PostgresRlsError("23514", `Invalid or duplicate story_key '${s.story_key}'`);
    }
    if (!epicKeys.has(s.epic_key.trim())) {
      throw new PostgresRlsError("23514", `Story '${key}' references unknown epic_key '${s.epic_key}'`);
    }
    if (s.requirement_ids.length === 0 || s.ac_ids.length === 0) {
      throw new PostgresRlsError(
        "23514",
        `Story '${key}' must reference >= 1 requirement_id and >= 1 ac_id`
      );
    }
    for (const r of s.requirement_ids) {
      if (!validReqIds.has(r)) {
        throw new PostgresRlsError("23514", `Story '${key}' references unknown Stage 2 req_id '${r}'`);
      }
      storyCoveredReqs.add(r);
    }
    for (const ac of s.ac_ids) {
      if (!validAcIds.has(ac)) {
        throw new PostgresRlsError("23514", `Story '${key}' references unknown Stage 2 ac_id '${ac}'`);
      }
      storyCoveredAcs.add(ac);
    }
    const scope = assertReqAcConsistent(`Story '${key}'`, s.requirement_ids, s.ac_ids);
    storyKeys.add(key);
    storyScopes.set(key, scope);
  }

  const profileByKey = new Map<string, AgentOrganizationProfileRecord>();
  for (const p of input.profiles) {
    profileByKey.set(p.profile_key, p);
  }

  const taskKeys = new Set<string>();
  const taskCoveredReqs = new Set<string>();
  const taskCoveredAcs = new Set<string>();
  const depsByTask = new Map<string, readonly string[]>();

  for (const t of plan.tasks) {
    const key = t.task_key.trim();
    const storyKey = t.story_key.trim();
    if (!key || !t.title.trim() || taskKeys.has(key)) {
      throw new PostgresRlsError("23514", `Invalid or duplicate task_key '${t.task_key}'`);
    }
    const parentScope = storyScopes.get(storyKey);
    if (!parentScope) {
      throw new PostgresRlsError("23514", `Task '${key}' references unknown story_key '${t.story_key}'`);
    }
    if (t.requirement_ids.length === 0 || t.ac_ids.length === 0) {
      throw new PostgresRlsError(
        "23514",
        `Task '${key}' must reference >= 1 requirement_id and >= 1 ac_id`
      );
    }
    for (const r of t.requirement_ids) {
      if (!validReqIds.has(r)) {
        throw new PostgresRlsError("23514", `Task '${key}' references unknown Stage 2 req_id '${r}'`);
      }
      if (!parentScope.reqSet.has(r)) {
        throw new PostgresRlsError(
          "23514",
          `Task '${key}' references req_id '${r}' outside parent Story '${storyKey}' scope`
        );
      }
      taskCoveredReqs.add(r);
    }
    for (const ac of t.ac_ids) {
      if (!validAcIds.has(ac)) {
        throw new PostgresRlsError("23514", `Task '${key}' references unknown Stage 2 ac_id '${ac}'`);
      }
      if (!parentScope.acSet.has(ac)) {
        throw new PostgresRlsError(
          "23514",
          `Task '${key}' references ac_id '${ac}' outside parent Story '${storyKey}' scope`
        );
      }
      taskCoveredAcs.add(ac);
    }
    assertReqAcConsistent(`Task '${key}'`, t.requirement_ids, t.ac_ids);
    validateAllowedFilesAgainstProtectedAndForbidden({
      allowedFiles: t.allowed_files,
      protectedPaths: input.protectedPaths,
      contextLabel: `Stage 7 task '${key}'`,
    });
    if (t.developer_profile_key) {
      const prof = profileByKey.get(t.developer_profile_key);
      if (!prof || !prof.is_active || prof.role !== "DEVELOPER") {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 task '${key}' references invalid or inactive DEVELOPER profile '${t.developer_profile_key}'`
        );
      }
    }
    taskKeys.add(key);
    const trimmedDeps: string[] = [];
    for (const rawDep of t.depends_on_task_keys) {
      const dep = rawDep.trim();
      if (!dep) {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 task '${key}' contains blank dependency key`
        );
      }
      if (dep === key) {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 task '${key}' cannot depend on itself`
        );
      }
      if (!trimmedDeps.includes(dep)) {
        trimmedDeps.push(dep);
      }
    }
    depsByTask.set(key, trimmedDeps);
  }

  // Iterative Kahn topological sort for dependency resolution & acyclicity (Minor #2)
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const key of taskKeys) {
    inDegree.set(key, 0);
    dependents.set(key, []);
  }
  for (const [taskKey, deps] of depsByTask.entries()) {
    for (const dep of deps) {
      if (!taskKeys.has(dep)) {
        throw new PostgresRlsError(
          "23514",
          `Stage 7 task '${taskKey}' depends on unknown task_key '${dep}'`
        );
      }
      dependents.get(dep)!.push(taskKey);
      inDegree.set(taskKey, (inDegree.get(taskKey) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [key, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(key);
    }
  }
  let visitedCount = 0;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    visitedCount += 1;
    for (const next of dependents.get(cur) ?? []) {
      const rem = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, rem);
      if (rem === 0) {
        queue.push(next);
      }
    }
  }
  if (visitedCount !== taskKeys.size) {
    const cycleNodes = [...inDegree.entries()]
      .filter(([, deg]) => deg > 0)
      .map(([k]) => k);
    throw new PostgresRlsError(
      "23514",
      `Stage 7 task dependency cycle detected involving '${cycleNodes[0] ?? "unknown"}'`
    );
  }

  // Enforce 100% Stage 2 requirement & AC coverage across stories and tasks
  const uncoveredStoryReqs = [...validReqIds].filter((r) => !storyCoveredReqs.has(r));
  if (uncoveredStoryReqs.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Stage 7 stories do not cover 100% of Stage 2 requirements: missing ${uncoveredStoryReqs.join(", ")}`
    );
  }
  const uncoveredTaskReqs = [...validReqIds].filter((r) => !taskCoveredReqs.has(r));
  if (uncoveredTaskReqs.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Stage 7 tasks do not cover 100% of Stage 2 requirements: missing ${uncoveredTaskReqs.join(", ")}`
    );
  }
  const uncoveredStoryAcs = [...validAcIds].filter((a) => !storyCoveredAcs.has(a));
  if (uncoveredStoryAcs.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Stage 7 stories do not cover 100% of Stage 2 acceptance criteria: missing ${uncoveredStoryAcs.join(", ")}`
    );
  }
  const uncoveredTaskAcs = [...validAcIds].filter((a) => !taskCoveredAcs.has(a));
  if (uncoveredTaskAcs.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Stage 7 tasks do not cover 100% of Stage 2 acceptance criteria: missing ${uncoveredTaskAcs.join(", ")}`
    );
  }

  return { requirements, profileByKey };
}

export function validateCreateChangeRequestAgainstBaseline(input: {
  readonly request: Pick<
    CreateChangeRequestStoreInput,
    | "cr_key"
    | "title"
    | "rationale"
    | "impacted_requirement_ids"
    | "impacted_component_ids"
    | "proposed_tasks"
  >;
  readonly stage2ContentJson: Readonly<Record<string, unknown>>;
  readonly stage3ContentJson: Readonly<Record<string, unknown>>;
  readonly protectedPaths: readonly string[];
}): void {
  const { request } = input;
  if (!request.cr_key.trim() || !request.title.trim() || !request.rationale.trim()) {
    throw new PostgresRlsError(
      "23514",
      "Change Request requires non-empty cr_key, title, and rationale"
    );
  }
  if (request.impacted_requirement_ids.length === 0) {
    throw new PostgresRlsError(
      "23514",
      "Change Request must identify >= 1 impacted_requirement_id"
    );
  }
  if (request.proposed_tasks.length === 0) {
    throw new PostgresRlsError(
      "23514",
      "Change Request must propose >= 1 Stage 8 task"
    );
  }

  const reqs = extractStage2Requirements(input.stage2ContentJson);
  const validReqIds = new Set(reqs.map((r) => r.req_id));
  const validAcIds = new Set(reqs.flatMap((r) => r.ac_ids));
  const acsByReqId = new Map<string, Set<string>>();
  const acToReq = new Map<string, string>();
  for (const r of reqs) {
    acsByReqId.set(r.req_id, new Set(r.ac_ids));
    for (const a of r.ac_ids) {
      acToReq.set(a, r.req_id);
    }
  }
  const designIndex = extractStage3DesignIndex(input.stage3ContentJson);
  const validComponentIds = new Set(designIndex.componentIds);

  for (const r of request.impacted_requirement_ids) {
    if (!validReqIds.has(r)) {
      throw new PostgresRlsError(
        "23514",
        `Change Request references unknown Stage 2 req_id '${r}'`
      );
    }
  }
  for (const c of request.impacted_component_ids ?? []) {
    if (!validComponentIds.has(c)) {
      throw new PostgresRlsError(
        "23514",
        `Change Request references unknown Stage 3 component_id '${c}'`
      );
    }
  }

  const seenKeys = new Set<string>();
  const proposedTaskCoveredReqs = new Set<string>();
  const depsByKey = new Map<string, string[]>();
  for (const pt of request.proposed_tasks) {
    const key = pt.task_key.trim();
    if (!key || !pt.title.trim() || seenKeys.has(key)) {
      throw new PostgresRlsError(
        "23514",
        `Invalid or duplicate proposed task_key '${pt.task_key}' in Change Request`
      );
    }
    seenKeys.add(key);
    if (pt.requirement_ids.length === 0 || pt.ac_ids.length === 0) {
      throw new PostgresRlsError(
        "23514",
        `Proposed CR task '${key}' must reference >= 1 requirement_id and >= 1 ac_id`
      );
    }
    const ptReqSet = new Set<string>();
    for (const r of pt.requirement_ids) {
      if (!validReqIds.has(r)) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' references unknown req_id '${r}'`
        );
      }
      ptReqSet.add(r);
      proposedTaskCoveredReqs.add(r);
    }
    const ptAcSet = new Set<string>();
    for (const a of pt.ac_ids) {
      if (!validAcIds.has(a)) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' references unknown ac_id '${a}'`
        );
      }
      const owningReq = acToReq.get(a);
      if (!owningReq || !ptReqSet.has(owningReq)) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}': ac_id '${a}' belongs to req_id '${owningReq ?? "unknown"}', which is not listed in requirement_ids`
        );
      }
      ptAcSet.add(a);
    }
    for (const r of ptReqSet) {
      const expectedAcs = acsByReqId.get(r) ?? new Set<string>();
      if (![...ptAcSet].some((a) => expectedAcs.has(a))) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}': requirement_id '${r}' has no corresponding ac_id in ac_ids`
        );
      }
    }
    validateAllowedFilesAgainstProtectedAndForbidden({
      allowedFiles: pt.allowed_files,
      protectedPaths: input.protectedPaths,
      contextLabel: `Change Request task '${key}'`,
    });

    const cleanKeyDeps: string[] = [];
    for (const rawDep of pt.depends_on_task_keys ?? []) {
      const dep = rawDep.trim();
      if (!dep) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' contains blank dependency key`
        );
      }
      if (dep === key) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' cannot depend on itself`
        );
      }
      if (!cleanKeyDeps.includes(dep)) {
        cleanKeyDeps.push(dep);
      }
    }
    depsByKey.set(key, cleanKeyDeps);

    for (const rawId of pt.depends_on_task_ids ?? []) {
      if (!rawId.trim()) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' contains blank dependency task_id`
        );
      }
    }
  }

  const crInDegree = new Map<string, number>();
  const crDependents = new Map<string, string[]>();
  for (const key of seenKeys) {
    crInDegree.set(key, 0);
    crDependents.set(key, []);
  }
  for (const [key, deps] of depsByKey.entries()) {
    for (const dep of deps) {
      if (!seenKeys.has(dep)) {
        throw new PostgresRlsError(
          "23514",
          `Proposed CR task '${key}' depends on unknown task_key '${dep}'`
        );
      }
      crDependents.get(dep)!.push(key);
      crInDegree.set(key, (crInDegree.get(key) ?? 0) + 1);
    }
  }
  const crQueue: string[] = [];
  for (const [k, deg] of crInDegree.entries()) {
    if (deg === 0) crQueue.push(k);
  }
  let crVisited = 0;
  while (crQueue.length > 0) {
    const cur = crQueue.shift()!;
    crVisited += 1;
    for (const nxt of crDependents.get(cur) ?? []) {
      const rem = (crInDegree.get(nxt) ?? 0) - 1;
      crInDegree.set(nxt, rem);
      if (rem === 0) crQueue.push(nxt);
    }
  }
  if (crVisited !== seenKeys.size) {
    const cycleNode = [...crInDegree.entries()].find(([, deg]) => deg > 0)?.[0] ?? "unknown";
    throw new PostgresRlsError(
      "23514",
      `Proposed CR task dependency cycle detected involving '${cycleNode}'`
    );
  }

  const uncoveredImpacted = request.impacted_requirement_ids.filter(
    (r) => !proposedTaskCoveredReqs.has(r)
  );
  if (uncoveredImpacted.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Change Request proposed_tasks do not cover impacted_requirement_ids: missing ${uncoveredImpacted.join(", ")}`
    );
  }
}

export function computeProjectBootstrapSha256(
  input: Pick<
    CreateProjectBootstrapInput,
    | "project_id"
    | "pipeline_session_id"
    | "baseline_id"
    | "repo_path"
    | "trusted_acceptance_dir"
    | "base_main_commit_hash"
    | "protected_paths"
    | "trusted_policy_sha256"
    | "generated_files"
    | "acceptance_tests"
  >
): string {
  return sha256Hex(
    canonicalizeJson({
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id,
      baseline_id: input.baseline_id,
      repo_path: input.repo_path,
      trusted_acceptance_dir: input.trusted_acceptance_dir,
      base_main_commit_hash: input.base_main_commit_hash.toLowerCase(),
      protected_paths: input.protected_paths,
      trusted_policy_sha256: input.trusted_policy_sha256.toLowerCase(),
      generated_files: input.generated_files,
      acceptance_tests: input.acceptance_tests,
    })
  );
}

export function computeChangeRequestSha256(
  input: Pick<
    CreateChangeRequestStoreInput,
    | "project_id"
    | "pipeline_session_id"
    | "baseline_id"
    | "cr_key"
    | "title"
    | "rationale"
    | "impacted_requirement_ids"
    | "impacted_component_ids"
    | "proposed_tasks"
    | "requested_by_principal_id"
  >
): string {
  return sha256Hex(
    canonicalizeJson({
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id,
      baseline_id: input.baseline_id,
      cr_key: input.cr_key.trim(),
      title: input.title.trim(),
      rationale: input.rationale.trim(),
      impacted_requirement_ids: input.impacted_requirement_ids,
      impacted_component_ids: input.impacted_component_ids ?? [],
      proposed_tasks: input.proposed_tasks,
      requested_by_principal_id: input.requested_by_principal_id,
    })
  );
}

export function computeReleasePackageSha256(
  input: Pick<
    RecordReleaseAcceptancePackageInput,
    | "project_id"
    | "pipeline_session_id"
    | "baseline_id"
    | "traceability_sha256"
    | "coverage_percent"
    | "complete"
    | "total_requirements"
    | "merged_task_ids"
    | "applied_cr_ids"
    | "main_head_commit_hash"
    | "summary_markdown"
    | "package_json"
    | "accepted_by_principal_id"
  >
): string {
  return sha256Hex(
    canonicalizeJson({
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id,
      baseline_id: input.baseline_id,
      traceability_sha256: input.traceability_sha256.toLowerCase(),
      coverage_percent: input.coverage_percent,
      complete: input.complete,
      total_requirements: input.total_requirements,
      merged_task_ids: input.merged_task_ids,
      applied_cr_ids: input.applied_cr_ids,
      main_head_commit_hash: input.main_head_commit_hash.toLowerCase(),
      summary_markdown: input.summary_markdown,
      package_json: input.package_json,
      accepted_by_principal_id: input.accepted_by_principal_id,
    })
  );
}

export function slugifyIdentifier(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "component";
}

export function serializeTrustedAcceptanceTestSpecs(
  specs: readonly TrustedAcceptanceTestSpec[]
): TrustedAcceptanceTestSpec[] {
  return specs.map((s) => ({
    ac_id: s.ac_id,
    req_id: s.req_id,
    given: s.given,
    when: s.when,
    then: s.then,
    test_file_path: s.test_file_path,
    component_ids: [...s.component_ids],
    expected_deliverables: [...s.expected_deliverables],
  }));
}
