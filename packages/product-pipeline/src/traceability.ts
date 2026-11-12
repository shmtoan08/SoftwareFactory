import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  type ControlPlaneStore,
  PostgresRlsError,
  extractStage2Requirements,
  extractStage3DesignIndex,
  validateCreateChangeRequestAgainstBaseline,
} from "@software-factory/database";
import {
  type BidirectionalTraceabilityMatrix,
  type CandidateBoundLineage,
  type ChangeRequestProposedTaskSpec,
  type ChangeRequestRecord,
  type M6BStages5To9Bundle,
  type ReleaseAcceptancePackageRecord,
  type TaskPlanLinkRecord,
  type TaskRecord,
  type TraceabilityMissingLink,
  type TraceabilityOrphanLink,
  type TraceabilityRequirementRow,
  type TraceabilityStage8TaskLineage,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";

export interface SubmitChangeRequestServiceInput {
  readonly cr_id?: string;
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly cr_key: string;
  readonly title: string;
  readonly rationale: string;
  readonly impacted_requirement_ids: readonly string[];
  readonly impacted_component_ids?: readonly string[];
  readonly proposed_tasks: readonly ChangeRequestProposedTaskSpec[];
  readonly requested_by_principal_id: string;
}

export interface DecideChangeRequestServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id?: string;
  readonly cr_id: string;
  readonly decision: "APPROVED" | "REJECTED";
  readonly decided_by_principal_id: string;
  readonly decision_rationale?: string | null;
}

export interface ApplyChangeRequestServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id?: string;
  readonly cr_id: string;
  readonly applied_by_principal_id: string;
}

export interface IssueReleaseAcceptanceServiceInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly accepted_by_principal_id: string;
  readonly live_main_head_commit_hash?: string;
  readonly notes?: string;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function tryGitRevParseMain(repoPath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", "refs/heads/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
}

function isCommitAncestorOfMain(repoPath: string, commitHash: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "merge-base", "--is-ancestor", commitHash, "refs/heads/main"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return true;
  } catch {
    return false;
  }
}

function pushBackIndex(map: Record<string, string[]>, key: string, reqId: string): void {
  const existing = map[key];
  if (existing) {
    if (!existing.includes(reqId)) {
      existing.push(reqId);
      existing.sort();
    }
  } else {
    map[key] = [reqId];
  }
}

export async function submitChangeRequestService(
  store: ControlPlaneStore,
  input: SubmitChangeRequestServiceInput
): Promise<ChangeRequestRecord> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.requested_by_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
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
          `Change Requests require a FROZEN Stage 4 baseline (session status is ${session.status})`
        );
      }
      const baseline = await store.getBaselineSpecFreeze(input.pipeline_session_id);
      if (!baseline || baseline.status !== "FROZEN") {
        throw new PostgresRlsError("23514", "No FROZEN baseline exists for this session");
      }
      const bootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
      if (!bootstrap) {
        throw new PostgresRlsError(
          "23514",
          "Change Requests require Stage 5 Project Bootstrap to enforce protected_paths"
        );
      }
      const stage2 = await store.getStageArtifactById(baseline.stage2_artifact_id);
      const stage3 = await store.getStageArtifactById(baseline.stage3_artifact_id);
      if (!stage2 || !stage3) {
        throw new PostgresRlsError("23503", "Frozen Stage 2 or Stage 3 artifact missing");
      }

      validateCreateChangeRequestAgainstBaseline({
        request: {
          cr_key: input.cr_key,
          title: input.title,
          rationale: input.rationale,
          impacted_requirement_ids: input.impacted_requirement_ids,
          impacted_component_ids: input.impacted_component_ids,
          proposed_tasks: input.proposed_tasks,
        },
        stage2ContentJson: stage2.content_json,
        stage3ContentJson: stage3.content_json,
        protectedPaths: bootstrap.protected_paths,
      });

      const stories = await store.listDevUserStories(input.pipeline_session_id);
      const validStoryIds = new Set(stories.map((s) => s.story_id));
      for (const pt of input.proposed_tasks) {
        if (pt.story_id && !validStoryIds.has(pt.story_id)) {
          throw new PostgresRlsError(
            "23503",
            `Proposed CR task '${pt.task_key}' references unknown story_id '${pt.story_id}'`
          );
        }
        if (pt.developer_profile_id) {
          const prof = await store.getAgentOrganizationProfileById(pt.developer_profile_id);
          if (!prof || prof.project_id !== input.project_id || prof.role !== "DEVELOPER" || !prof.is_active) {
            throw new PostgresRlsError(
              "23514",
              `Proposed CR task '${pt.task_key}' references invalid or inactive DEVELOPER profile '${pt.developer_profile_id}'`
            );
          }
        }
      }

      return store.createChangeRequest({
        cr_id: input.cr_id,
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: baseline.baseline_id,
        cr_key: input.cr_key,
        title: input.title,
        rationale: input.rationale,
        impacted_requirement_ids: input.impacted_requirement_ids,
        impacted_component_ids: input.impacted_component_ids ?? [],
        proposed_tasks: input.proposed_tasks,
        requested_by_principal_id: input.requested_by_principal_id,
      });
    }
  );
}

export async function decideChangeRequestService(
  store: ControlPlaneStore,
  input: DecideChangeRequestServiceInput
): Promise<ChangeRequestRecord> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.decided_by_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const existing = await store.getChangeRequestById(input.cr_id);
      if (
        !existing ||
        existing.project_id !== input.project_id ||
        (input.pipeline_session_id && existing.pipeline_session_id !== input.pipeline_session_id)
      ) {
        throw new PostgresRlsError(
          "23503",
          `Change Request ${input.cr_id} not found for project ${input.project_id}`
        );
      }
      return store.decideChangeRequest({
        project_id: input.project_id,
        cr_id: input.cr_id,
        decision: input.decision,
        decided_by_principal_id: input.decided_by_principal_id,
        decision_rationale: input.decision_rationale ?? null,
      });
    }
  );
}

export async function applyChangeRequestService(
  store: ControlPlaneStore,
  input: ApplyChangeRequestServiceInput
): Promise<{
  readonly changeRequest: ChangeRequestRecord;
  readonly tasks: readonly TaskRecord[];
  readonly taskLinks: readonly TaskPlanLinkRecord[];
}> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.applied_by_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const project = await store.getProjectById(input.project_id);
      if (!project) {
        throw new PostgresRlsError("23503", `Project ${input.project_id} not found`);
      }
      const existing = await store.getChangeRequestById(input.cr_id);
      if (
        !existing ||
        existing.project_id !== input.project_id ||
        (input.pipeline_session_id && existing.pipeline_session_id !== input.pipeline_session_id)
      ) {
        throw new PostgresRlsError(
          "23503",
          `Change Request ${input.cr_id} not found for project ${input.project_id}`
        );
      }
      const bootstrap = await store.getProjectBootstrapBySession(existing.pipeline_session_id);
      if (!bootstrap) {
        throw new PostgresRlsError(
          "23514",
          `Stage 5 Project Bootstrap required to apply Change Request ${input.cr_id}`
        );
      }
      const liveMainHead =
        (await store.getMainRefCommitHash(input.project_id)) ??
        project.main_ref_commit_hash ??
        bootstrap.base_main_commit_hash;

      return store.applyChangeRequestAndMaterializeTasks({
        project_id: input.project_id,
        cr_id: input.cr_id,
        bootstrap_id: bootstrap.bootstrap_id,
        applied_by_principal_id: input.applied_by_principal_id,
        base_main_commit_hash: liveMainHead,
        protected_paths: bootstrap.protected_paths,
        trusted_policy_sha256: bootstrap.trusted_policy_sha256,
      });
    }
  );
}

export async function buildBidirectionalTraceabilityMatrixInTx(
  store: ControlPlaneStore,
  input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly live_main_head_commit_hash?: string;
  }
): Promise<BidirectionalTraceabilityMatrix> {
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
  const baseline = await store.getBaselineSpecFreeze(input.pipeline_session_id);
  if (!baseline) {
    throw new PostgresRlsError(
      "23514",
      `Traceability Matrix requires a FROZEN Stage 4 baseline for session ${input.pipeline_session_id}`
    );
  }
  const stage2 = await store.getStageArtifactById(baseline.stage2_artifact_id);
  const stage3 = await store.getStageArtifactById(baseline.stage3_artifact_id);
  if (!stage2 || !stage3) {
    throw new PostgresRlsError("23503", "Frozen Stage 2 or Stage 3 artifact missing");
  }

  const bootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
  const milestones = await store.listDevMilestones(input.pipeline_session_id);
  const epics = await store.listDevEpics(input.pipeline_session_id);
  const stories = await store.listDevUserStories(input.pipeline_session_id);
  const taskLinks = await store.listTaskPlanLinks(input.pipeline_session_id);
  const changeRequests = await store.listChangeRequests(input.pipeline_session_id);

  const repoPath = bootstrap?.repo_path ?? project.repo_bare_path;
  const repoExists = Boolean(repoPath && existsSync(repoPath));
  const diskMainHead = repoExists ? tryGitRevParseMain(repoPath) : null;
  const storeMainHead = await store.getMainRefCommitHash(input.project_id);
  const liveMainHead = (
    input.live_main_head_commit_hash ??
    diskMainHead ??
    storeMainHead ??
    project.main_ref_commit_hash ??
    ""
  ).toLowerCase() || null;

  const reqs = extractStage2Requirements(stage2.content_json);
  const validReqIds = new Set(reqs.map((r) => r.req_id));
  const validAcIds = new Set(reqs.flatMap((r) => r.ac_ids));
  const designIndex = extractStage3DesignIndex(stage3.content_json);

  const epicById = new Map(epics.map((e) => [e.epic_id, e] as const));
  const storyById = new Map(stories.map((s) => [s.story_id, s] as const));

  const lineageByTaskId = new Map<string, CandidateBoundLineage | null>();
  const stage8ByTaskId = new Map<string, TraceabilityStage8TaskLineage>();
  const taskCompleteById = new Map<string, boolean>();
  const orphanLinks: TraceabilityOrphanLink[] = [];

  for (const link of taskLinks) {
    for (const r of link.requirement_ids) {
      if (!validReqIds.has(r)) {
        orphanLinks.push({
          entity_type: "task_plan_link",
          entity_id: link.link_id,
          reason: `Task link ${link.link_id} references unknown req_id '${r}'`,
        });
      }
    }
    for (const ac of link.ac_ids) {
      if (!validAcIds.has(ac)) {
        orphanLinks.push({
          entity_type: "task_plan_link",
          entity_id: link.link_id,
          reason: `Task link ${link.link_id} references unknown ac_id '${ac}'`,
        });
      }
    }

    if (!lineageByTaskId.has(link.task_id)) {
      const lineage = await store.getCandidateBoundLineage(link.task_id, liveMainHead);
      lineageByTaskId.set(link.task_id, lineage);
      if (!lineage) {
        orphanLinks.push({
          entity_type: "task",
          entity_id: link.task_id,
          reason: `TaskPlanLink ${link.link_id} points to missing Stage 8 task ${link.task_id}`,
        });
        continue;
      }
      const mergedOp = [...lineage.mergeOperations]
        .reverse()
        .find((m) => m.status === "MERGED");
      const mergedCommit = (
        lineage.task.merged_commit_hash ??
        mergedOp?.merge_candidate_hash ??
        null
      )?.toLowerCase() ?? null;

      let mainReachable = false;
      if (lineage.task.status === "MergedAndCompleted" && mergedCommit) {
        if (liveMainHead && mergedCommit === liveMainHead) {
          mainReachable = true;
        } else if (repoExists) {
          mainReachable = isCommitAncestorOfMain(repoPath, mergedCommit);
        }
      }

      const trustedPolicyMatch =
        !bootstrap ||
        !lineage.verificationRun?.trusted_policy_sha256 ||
        lineage.verificationRun.trusted_policy_sha256 === bootstrap.trusted_policy_sha256;

      const stage8Lineage: TraceabilityStage8TaskLineage = {
        task_id: link.task_id,
        title: lineage.task.title,
        status: lineage.task.status,
        cr_id: link.cr_id,
        trusted_policy_sha256: lineage.verificationRun?.trusted_policy_sha256 ?? null,
        lease_ids: lineage.taskLeases.map((l) => l.lease_id),
        import_ids: lineage.verifiedImport ? [lineage.verifiedImport.import_id] : [],
        merge_candidate_ids: lineage.allMergeCandidates.map((mc) => mc.merge_candidate_id),
        verification_run_ids: lineage.verificationRun
          ? [lineage.verificationRun.verification_run_id]
          : [],
        review_session_ids: lineage.reviewSession ? [lineage.reviewSession.review_session_id] : [],
        review_artifact_ids: lineage.reviewArtifact
          ? [lineage.reviewArtifact.review_artifact_id]
          : [],
        approval_request_ids: lineage.approvalRequest
          ? [lineage.approvalRequest.approval_request_id]
          : [],
        approval_decision_ids: lineage.approvalDecisions.map((d) => d.approval_id),
        merged_commit_hash: mergedCommit,
        main_reachable: mainReachable,
      };
      stage8ByTaskId.set(link.task_id, stage8Lineage);
      taskCompleteById.set(
        link.task_id,
        lineage.task.status === "MergedAndCompleted" &&
          lineage.lineageComplete &&
          mainReachable &&
          trustedPolicyMatch &&
          lineage.verificationRun?.tier1_trusted_acceptance_passed !== false
      );
    }
  }

  for (const s of stories) {
    for (const r of s.requirement_ids) {
      if (!validReqIds.has(r)) {
        orphanLinks.push({
          entity_type: "dev_user_story",
          entity_id: s.story_id,
          reason: `Story ${s.story_key} references unknown req_id '${r}'`,
        });
      }
    }
    for (const ac of s.ac_ids) {
      if (!validAcIds.has(ac)) {
        orphanLinks.push({
          entity_type: "dev_user_story",
          entity_id: s.story_id,
          reason: `Story ${s.story_key} references unknown ac_id '${ac}'`,
        });
      }
    }
  }

  const crStatusById = new Map(changeRequests.map((cr) => [cr.cr_id, cr] as const));
  const openCrsByReqId = new Map<string, ChangeRequestRecord[]>();
  for (const cr of changeRequests) {
    for (const r of cr.impacted_requirement_ids) {
      if (!validReqIds.has(r)) {
        orphanLinks.push({
          entity_type: "change_request",
          entity_id: cr.cr_id,
          reason: `Change Request ${cr.cr_key} references unknown req_id '${r}'`,
        });
      }
    }
    if (cr.status === "PENDING_APPROVAL" || cr.status === "APPROVED") {
      for (const r of cr.impacted_requirement_ids) {
        const list = openCrsByReqId.get(r);
        if (list) list.push(cr);
        else openCrsByReqId.set(r, [cr]);
      }
    }
  }

  const milestoneSet = new Set(milestones.map((m) => m.milestone_id));
  const missingLinksGlobal: TraceabilityMissingLink[] = [];
  const requirementRows: TraceabilityRequirementRow[] = [];
  const forwardIndex: Record<string, TraceabilityRequirementRow> = {};

  const backStage1: Record<string, string[]> = {};
  const backStage2Acs: Record<string, string[]> = {};
  const backComponents: Record<string, string[]> = {};
  const backTrustedTests: Record<string, string[]> = {};
  const backStories: Record<string, string[]> = {};
  const backTasks: Record<string, string[]> = {};
  const backCrs: Record<string, string[]> = {};
  const backMergedCommits: Record<string, string[]> = {};

  for (const req of reqs) {
    const reqMissing: string[] = [];
    const pushReqMissing = (stage: string, reason: string) => {
      reqMissing.push(`[${stage}] ${reason}`);
      missingLinksGlobal.push({ req_id: req.req_id, stage, reason });
    };

    const stage1Ids = uniqueSorted(req.source_discovery_item_ids);
    if (stage1Ids.length === 0) {
      pushReqMissing("STAGE_1_DISCOVERY", `Requirement ${req.req_id} has no Stage 1 discovery provenance`);
    }
    for (const s1 of stage1Ids) pushBackIndex(backStage1, s1, req.req_id);

    const acIds = uniqueSorted(req.ac_ids);
    if (acIds.length === 0) {
      pushReqMissing("STAGE_2_REQUIREMENTS", `Requirement ${req.req_id} has zero acceptance_criteria`);
    }
    for (const ac of acIds) pushBackIndex(backStage2Acs, ac, req.req_id);

    const compIds = uniqueSorted(designIndex.componentsByReqId.get(req.req_id) ?? []);
    const erdTables = uniqueSorted(designIndex.erdTablesByReqId.get(req.req_id) ?? []);
    const apiEndpoints = uniqueSorted(designIndex.apiEndpointsByReqId.get(req.req_id) ?? []);
    const secControls = uniqueSorted(designIndex.securityControlsByReqId.get(req.req_id) ?? []);
    const adrIds = uniqueSorted(designIndex.adrsByReqId.get(req.req_id) ?? []);

    if (compIds.length === 0) {
      pushReqMissing("STAGE_3_ARCHITECTURE", `Requirement ${req.req_id} has no covering Stage 3 component`);
    }
    if (
      erdTables.length + apiEndpoints.length + secControls.length + adrIds.length ===
      0
    ) {
      pushReqMissing(
        "STAGE_3_ARCHITECTURE",
        `Requirement ${req.req_id} has no ERD, API, Security, or ADR technical artifact`
      );
    }
    for (const cid of compIds) pushBackIndex(backComponents, cid, req.req_id);

    // Stage 5 Trusted Acceptance Tests
    const matchingTests =
      bootstrap?.acceptance_tests.filter((t) => t.req_id === req.req_id) ?? [];
    const testFiles = uniqueSorted(matchingTests.map((t) => `${t.test_file_path}#${t.ac_id}`));
    if (!bootstrap) {
      pushReqMissing("STAGE_5_BOOTSTRAP", `Stage 5 Project Bootstrap has not run for session`);
    } else {
      const coveredTestAcs = new Set(matchingTests.map((t) => t.ac_id));
      for (const ac of acIds) {
        if (!coveredTestAcs.has(ac)) {
          pushReqMissing(
            "STAGE_5_BOOTSTRAP",
            `Acceptance criterion ${ac} (${req.req_id}) has no Stage 5 Trusted Acceptance Test`
          );
        }
      }
      for (const t of matchingTests) {
        pushBackIndex(backTrustedTests, `${t.test_file_path}#${t.ac_id}`, req.req_id);
      }
    }

    // Stage 7 Stories -> Epics -> Milestones
    const coveringStories = stories.filter((s) => s.requirement_ids.includes(req.req_id));
    const storyIds = uniqueSorted(coveringStories.map((s) => s.story_id));
    const storyAcCovered = new Set(coveringStories.flatMap((s) => s.ac_ids));
    const epicIds = uniqueSorted(
      coveringStories
        .map((s) => s.epic_id)
        .filter((eid) => epicById.has(eid))
    );
    const milestoneIds = uniqueSorted(
      epicIds
        .map((eid) => epicById.get(eid)?.milestone_id)
        .filter((mid): mid is string => Boolean(mid && milestoneSet.has(mid)))
    );

    if (storyIds.length === 0 || epicIds.length === 0 || milestoneIds.length === 0) {
      pushReqMissing(
        "STAGE_7_PLANNING",
        `Requirement ${req.req_id} is not traced through Milestone -> Epic -> Story`
      );
    } else {
      for (const ac of acIds) {
        if (!storyAcCovered.has(ac)) {
          pushReqMissing(
            "STAGE_7_PLANNING",
            `Acceptance criterion ${ac} (${req.req_id}) is not covered by any Stage 7 Story`
          );
        }
      }
    }
    for (const sid of storyIds) pushBackIndex(backStories, sid, req.req_id);

    // Stage 7 + Stage 9 Task Links & Stage 8 Execution Lineage
    const coveringTaskLinks = taskLinks.filter((l) => l.requirement_ids.includes(req.req_id));
    const taskIds = uniqueSorted(coveringTaskLinks.map((l) => l.task_id));
    const taskAcCovered = new Set(coveringTaskLinks.flatMap((l) => l.ac_ids));
    const appliedCrIds = uniqueSorted(
      coveringTaskLinks
        .map((l) => l.cr_id)
        .filter((crId): crId is string => {
          if (!crId) return false;
          const cr = crStatusById.get(crId);
          return Boolean(cr && cr.status === "APPLIED");
        })
    );

    if (taskIds.length === 0) {
      pushReqMissing(
        "STAGE_7_PLANNING",
        `Requirement ${req.req_id} has zero Stage 8 tasks in task_plan_links`
      );
    } else {
      for (const ac of acIds) {
        if (!taskAcCovered.has(ac)) {
          pushReqMissing(
            "STAGE_7_PLANNING",
            `Acceptance criterion ${ac} (${req.req_id}) is not covered by any task in task_plan_links`
          );
        }
      }
    }

    const stage8Lineages: TraceabilityStage8TaskLineage[] = [];
    for (const taskId of taskIds) {
      pushBackIndex(backTasks, taskId, req.req_id);
      const st8 = stage8ByTaskId.get(taskId);
      if (st8) {
        stage8Lineages.push(st8);
        if (st8.merged_commit_hash && st8.main_reachable) {
          pushBackIndex(backMergedCommits, st8.merged_commit_hash, req.req_id);
        }
      }
      if (!taskCompleteById.get(taskId)) {
        const reason = !st8
          ? `Task ${taskId} is missing Stage 8 lineage`
          : st8.status !== "MergedAndCompleted"
          ? `Task ${taskId} (${st8.title}) is in status ${st8.status}, expected MergedAndCompleted`
          : !st8.main_reachable
          ? `Task ${taskId} merged commit ${st8.merged_commit_hash ?? "(none)"} is not reachable on refs/heads/main`
          : `Task ${taskId} Stage 8 hash-bound lineage is incomplete`;
        pushReqMissing("STAGE_8_EXECUTION", reason);
      }
    }
    for (const crId of appliedCrIds) {
      pushBackIndex(backCrs, crId, req.req_id);
    }

    const openCrs = openCrsByReqId.get(req.req_id) ?? [];
    for (const openCr of openCrs) {
      pushBackIndex(backCrs, openCr.cr_id, req.req_id);
      pushReqMissing(
        "STAGE_9_CHANGE_REQUEST",
        `Change Request ${openCr.cr_key} impacting ${req.req_id} is ${openCr.status} and has not been applied/resolved`
      );
    }

    // Check any story_id referenced by coveringTaskLinks resolves
    for (const link of coveringTaskLinks) {
      if (link.story_id && !storyById.has(link.story_id)) {
        orphanLinks.push({
          entity_type: "task_plan_link",
          entity_id: link.link_id,
          reason: `Task link ${link.link_id} references missing story ${link.story_id}`,
        });
      }
    }

    const row: TraceabilityRequirementRow = {
      req_id: req.req_id,
      title: req.title,
      stage1_item_ids: stage1Ids,
      ac_ids: acIds,
      stage3_component_ids: compIds,
      stage3_erd_tables: erdTables,
      stage3_api_endpoints: apiEndpoints,
      stage3_security_controls: secControls,
      stage3_adr_ids: adrIds,
      bootstrap_id: bootstrap?.bootstrap_id ?? null,
      trusted_acceptance_test_files: testFiles,
      milestone_ids: milestoneIds,
      epic_ids: epicIds,
      story_ids: storyIds,
      task_ids: taskIds,
      applied_cr_ids: appliedCrIds,
      stage8_lineage: stage8Lineages,
      complete: reqMissing.length === 0,
      missing_links: reqMissing,
    };
    requirementRows.push(row);
    forwardIndex[req.req_id] = row;
  }

  // Also ensure REJECTED CRs are indexed cleanly in backCrs if desired for discoverability?
  // Wait: keep backCrs reflecting applied & active CRs mapped in rows; add rejected CRs only if none conflict.
  const totalReqs = requirementRows.length;
  const coveredReqs = requirementRows.filter((r) => r.complete).length;
  const coveragePercent =
    totalReqs === 0 ? 0 : Math.round((coveredReqs / totalReqs) * 10000) / 100;
  const complete =
    totalReqs > 0 &&
    coveredReqs === totalReqs &&
    missingLinksGlobal.length === 0 &&
    orphanLinks.length === 0;

  const traceabilitySha = sha256Hex(
    canonicalizeJson({
      project_id: input.project_id,
      pipeline_session_id: input.pipeline_session_id,
      baseline_id: baseline.baseline_id,
      total_requirements: totalReqs,
      covered_requirements: coveredReqs,
      coverage_percent: coveragePercent,
      complete,
      requirement_rows: requirementRows,
      missing_links: missingLinksGlobal,
      orphan_links: orphanLinks,
    })
  );

  return {
    project_id: input.project_id,
    pipeline_session_id: input.pipeline_session_id,
    baseline_id: baseline.baseline_id,
    generated_at: await store.clockTimestampIso(),
    total_requirements: totalReqs,
    covered_requirements: coveredReqs,
    coverage_percent: coveragePercent,
    complete,
    requirement_rows: requirementRows,
    forward_index: forwardIndex,
    backward_index: {
      stage1_items: backStage1,
      stage2_ac_ids: backStage2Acs,
      stage3_components: backComponents,
      trusted_acceptance_tests: backTrustedTests,
      stories: backStories,
      tasks: backTasks,
      change_requests: backCrs,
      merged_commits: backMergedCommits,
    },
    missing_links: missingLinksGlobal,
    orphan_links: orphanLinks,
    traceability_sha256: traceabilitySha,
  };
}

export async function getBidirectionalTraceabilityMatrixService(
  store: ControlPlaneStore,
  input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
    readonly live_main_head_commit_hash?: string;
  }
): Promise<BidirectionalTraceabilityMatrix> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    () => buildBidirectionalTraceabilityMatrixInTx(store, input)
  );
}

export async function issueReleaseAcceptancePackageService(
  store: ControlPlaneStore,
  input: IssueReleaseAcceptanceServiceInput
): Promise<ReleaseAcceptancePackageRecord> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.accepted_by_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const matrix = await buildBidirectionalTraceabilityMatrixInTx(store, input);
      if (!matrix.complete || matrix.coverage_percent !== 100) {
        const preview = matrix.missing_links
          .slice(0, 3)
          .map((m) => `${m.req_id}:${m.stage}:${m.reason}`)
          .join("; ");
        throw new PostgresRlsError(
          "23514",
          `Cannot issue Release Acceptance Package: AC-11b traceability coverage is ${matrix.coverage_percent}% (${matrix.covered_requirements}/${matrix.total_requirements}); missing: ${preview || "incomplete coverage"}`
        );
      }

      const project = await store.getProjectById(input.project_id);
      const bootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
      const repoPath = bootstrap?.repo_path ?? project?.repo_bare_path ?? "";
      const diskMainHead = repoPath && existsSync(repoPath) ? tryGitRevParseMain(repoPath) : null;
      const storeMainHead = await store.getMainRefCommitHash(input.project_id);
      const mainHeadCommitHash = (
        input.live_main_head_commit_hash ??
        diskMainHead ??
        storeMainHead ??
        project?.main_ref_commit_hash ??
        bootstrap?.base_main_commit_hash ??
        ""
      ).toLowerCase();

      if (!/^[0-9a-f]{40}$/.test(mainHeadCommitHash)) {
        throw new PostgresRlsError(
          "23514",
          `Invalid main_head_commit_hash '${mainHeadCommitHash}' for Release Acceptance Package`
        );
      }

      const mergedTaskIds = uniqueSorted(
        matrix.requirement_rows.flatMap((r) => r.task_ids)
      );
      const appliedCrIds = uniqueSorted(
        matrix.requirement_rows.flatMap((r) => r.applied_cr_ids)
      );

      const summaryMarkdown = [
        `# Release Acceptance Package — Baseline \`${matrix.baseline_id}\``,
        "",
        `- **Project ID**: \`${input.project_id}\``,
        `- **Pipeline Session ID**: \`${input.pipeline_session_id}\``,
        `- **Accepted By**: \`${input.accepted_by_principal_id}\``,
        `- **AC-11b Coverage**: ${matrix.covered_requirements}/${matrix.total_requirements} (${matrix.coverage_percent}%)`,
        `- **Traceability SHA-256**: \`${matrix.traceability_sha256}\``,
        `- **Main HEAD Commit**: \`${mainHeadCommitHash}\``,
        `- **Merged Tasks (${mergedTaskIds.length})**: ${mergedTaskIds.join(", ") || "none"}`,
        `- **Applied Change Requests (${appliedCrIds.length})**: ${appliedCrIds.join(", ") || "none"}`,
        input.notes ? `- **Notes**: ${input.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const packageJson: Record<string, unknown> = {
        schema_version: "1.5",
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: matrix.baseline_id,
        bootstrap_id: bootstrap?.bootstrap_id ?? null,
        trusted_policy_sha256: bootstrap?.trusted_policy_sha256 ?? null,
        traceability_sha256: matrix.traceability_sha256,
        coverage_percent: matrix.coverage_percent,
        total_requirements: matrix.total_requirements,
        merged_task_ids: mergedTaskIds,
        applied_cr_ids: appliedCrIds,
        main_head_commit_hash: mainHeadCommitHash,
        notes: input.notes ?? null,
        requirements: matrix.requirement_rows.map((r) => ({
          req_id: r.req_id,
          ac_ids: r.ac_ids,
          stage3_component_ids: r.stage3_component_ids,
          story_ids: r.story_ids,
          task_ids: r.task_ids,
          applied_cr_ids: r.applied_cr_ids,
          merged_commits: r.stage8_lineage
            .map((s) => s.merged_commit_hash)
            .filter((h): h is string => Boolean(h)),
        })),
      };

      return store.recordReleaseAcceptancePackage({
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: matrix.baseline_id,
        traceability_sha256: matrix.traceability_sha256,
        coverage_percent: matrix.coverage_percent,
        complete: matrix.complete,
        total_requirements: matrix.total_requirements,
        merged_task_ids: mergedTaskIds,
        applied_cr_ids: appliedCrIds,
        main_head_commit_hash: mainHeadCommitHash,
        summary_markdown: summaryMarkdown,
        package_json: packageJson,
        accepted_by_principal_id: input.accepted_by_principal_id,
      });
    }
  );
}

export async function getM6BStages5To9BundleService(
  store: ControlPlaneStore,
  input: {
    readonly project_id: string;
    readonly pipeline_session_id: string;
    readonly actor_principal_id: string;
    readonly live_main_head_commit_hash?: string;
  }
): Promise<M6BStages5To9Bundle> {
  return store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      const baseline = await store.getBaselineSpecFreeze(input.pipeline_session_id);
      if (!baseline) {
        throw new PostgresRlsError(
          "23514",
          `M6B Stages 5-9 Bundle requires a FROZEN Stage 4 baseline for session ${input.pipeline_session_id}`
        );
      }
      const bootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
      const agentProfiles = await store.listAgentOrganizationProfiles(input.project_id);
      const milestones = await store.listDevMilestones(input.pipeline_session_id);
      const epics = await store.listDevEpics(input.pipeline_session_id);
      const stories = await store.listDevUserStories(input.pipeline_session_id);
      const taskLinks = await store.listTaskPlanLinks(input.pipeline_session_id);
      const uniqueTaskIds = uniqueSorted(taskLinks.map((l) => l.task_id));
      const tasks: TaskRecord[] = [];
      for (const taskId of uniqueTaskIds) {
        const t = await store.getTaskById(taskId);
        if (t) tasks.push(t);
      }
      const changeRequests = await store.listChangeRequests(input.pipeline_session_id);
      const traceability = await buildBidirectionalTraceabilityMatrixInTx(store, input);
      const releasePackages = await store.listReleaseAcceptancePackages(
        input.pipeline_session_id
      );

      return {
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline,
        bootstrap,
        agent_profiles: agentProfiles,
        stage7_plan: {
          milestones,
          epics,
          stories,
          taskLinks,
          tasks,
        },
        change_requests: changeRequests,
        traceability,
        release_packages: releasePackages,
      };
    }
  );
}
