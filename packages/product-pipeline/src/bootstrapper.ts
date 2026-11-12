import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ControlPlaneStore,
  PostgresRlsError,
  extractStage2Requirements,
  extractStage3DesignIndex,
  slugifyIdentifier,
} from "@software-factory/database";
import {
  type BaselineSpecFreezeRecord,
  type ProjectBootstrapRecord,
  type TrustedAcceptanceTestSpec,
  canonicalizeJson,
  computeDirectorySha256,
} from "@software-factory/shared-types";
import {
  DEFAULT_SYSTEM_FORBIDDEN_PATHS,
  isSafeRelativePosixPath,
  matchesAnyGlob,
} from "@software-factory/task-contract";

export interface Stage5AcceptanceSpecOverride {
  readonly target_file: string;
  readonly export_name?: string;
  readonly assertion_lines?: readonly string[];
}

export interface RunStage5ProjectBootstrapInput {
  readonly project_id: string;
  readonly pipeline_session_id: string;
  readonly actor_principal_id: string;
  readonly repo_path?: string;
  readonly trusted_acceptance_dir?: string;
  readonly extra_protected_paths?: readonly string[];
  readonly scaffold_files?: Readonly<Record<string, string>>;
  readonly acceptance_specs?: Readonly<Record<string, Stage5AcceptanceSpecOverride>>;
}

export interface Stage5BootstrapOutcome {
  readonly bootstrap: ProjectBootstrapRecord;
  readonly baseline: BaselineSpecFreezeRecord;
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryRunGit(cwd: string, args: readonly string[]): string | null {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function normalizeExtraProtectedPaths(
  extras: readonly string[] | undefined
): string[] {
  const base = [
    "policy/trusted-verification-policy.json",
    "tests/protected/**",
    "README.md",
    "package.json",
  ];
  const seen = new Set(base);
  for (const raw of extras ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isSafeRelativePosixPath(trimmed)) {
      throw new PostgresRlsError(
        "23514",
        `Unsafe Stage 5 protected_paths entry '${raw}'`
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      base.push(trimmed);
    }
  }
  return base;
}

function buildBaselineReadme(input: {
  readonly title: string;
  readonly baseline: BaselineSpecFreezeRecord;
  readonly reqCount: number;
}): string {
  return [
    `# ${input.title}`,
    "",
    `- Baseline ID: \`${input.baseline.baseline_id}\``,
    `- Pipeline Session ID: \`${input.baseline.pipeline_session_id}\``,
    `- Stage 2 Artifact SHA-256: \`${input.baseline.stage2_artifact_sha256}\``,
    `- Stage 3 Artifact SHA-256: \`${input.baseline.stage3_artifact_sha256}\``,
    `- Frozen Requirements Count: ${input.reqCount}`,
    "",
    "Bootstrapped deterministically by Software Factory v1.5 Stage 5 Project Bootstrapper.",
    "",
  ].join("\n");
}

function buildProtectedBaselineTestSource(input: {
  readonly baseline: BaselineSpecFreezeRecord;
}): string {
  return [
    'import assert from "node:assert/strict";',
    'import { existsSync, readFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    "",
    'const policyPath = resolve(process.cwd(), "policy/trusted-verification-policy.json");',
    'assert.equal(existsSync(policyPath), true, "Missing policy/trusted-verification-policy.json");',
    'const policy = JSON.parse(readFileSync(policyPath, "utf8"));',
    `assert.equal(policy.baseline_id, ${JSON.stringify(input.baseline.baseline_id)});`,
    `assert.equal(policy.pipeline_session_id, ${JSON.stringify(input.baseline.pipeline_session_id)});`,
    `assert.equal(policy.stage2_artifact_sha256, ${JSON.stringify(input.baseline.stage2_artifact_sha256)});`,
    `assert.equal(policy.stage3_artifact_sha256, ${JSON.stringify(input.baseline.stage3_artifact_sha256)});`,
    'console.log("tier2-protected-baseline-pass");',
    "",
  ].join("\n");
}

function buildTrustedAcceptanceTestSource(input: {
  readonly baseline: BaselineSpecFreezeRecord;
  readonly specs: readonly TrustedAcceptanceTestSpec[];
  readonly overrides: Readonly<Record<string, Stage5AcceptanceSpecOverride>>;
}): string {
  const lines: string[] = [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { existsSync, readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    "",
    'const EXPECTED_BASELINE_ID = ' + JSON.stringify(input.baseline.baseline_id) + ";",
    'const EXPECTED_STAGE2_SHA = ' + JSON.stringify(input.baseline.stage2_artifact_sha256) + ";",
    "",
    'test("Protected Verification Policy manifest matches frozen Stage 4 baseline", () => {',
    '  const policyPath = join(process.cwd(), "policy/trusted-verification-policy.json");',
    '  assert.equal(existsSync(policyPath), true, "policy/trusted-verification-policy.json must exist");',
    '  const policy = JSON.parse(readFileSync(policyPath, "utf8"));',
    '  assert.equal(policy.baseline_id, EXPECTED_BASELINE_ID);',
    '  assert.equal(policy.stage2_artifact_sha256, EXPECTED_STAGE2_SHA);',
    "});",
    "",
  ];

  for (const spec of input.specs) {
    const override = input.overrides[spec.ac_id];
    const targetRel = override?.target_file ?? spec.expected_deliverables[0]!;
    if (!isSafeRelativePosixPath(targetRel)) {
      throw new PostgresRlsError(
        "23514",
        `Unsafe target_file '${targetRel}' for acceptance criterion '${spec.ac_id}'`
      );
    }
    const testLabel = `[${spec.req_id}/${spec.ac_id}] Given ${spec.given} When ${spec.when} Then ${spec.then}`;
    lines.push(`test(${JSON.stringify(testLabel)}, async () => {`);
    lines.push(`  const targetPath = join(process.cwd(), ${JSON.stringify(targetRel)});`);
    lines.push(
      `  assert.equal(existsSync(targetPath), true, ${JSON.stringify(
        `Missing deliverable '${targetRel}' required for ${spec.req_id} (${spec.ac_id})`
      )});`
    );
    lines.push("  const mod = await import(pathToFileURL(targetPath).href);");
    if (override?.export_name) {
      lines.push(
        `  assert.notEqual(mod[${JSON.stringify(override.export_name)}], undefined, ${JSON.stringify(
          `Expected export '${override.export_name}' on ${targetRel} for ${spec.ac_id}`
        )});`
      );
    }
    if (override?.assertion_lines && override.assertion_lines.length > 0) {
      for (const stmt of override.assertion_lines) {
        lines.push(`  ${stmt}`);
      }
    } else {
      lines.push(
        "  const implementedAcs = Array.isArray(mod.implementedAcIds) ? mod.implementedAcIds : [];"
      );
      lines.push(
        "  const implementedReqs = Array.isArray(mod.implementedRequirements) ? mod.implementedRequirements : [];"
      );
      lines.push(
        `  assert.equal(implementedAcs.includes(${JSON.stringify(
          spec.ac_id
        )}) || implementedReqs.includes(${JSON.stringify(
          spec.req_id
        )}), true, ${JSON.stringify(
          `Deliverable '${targetRel}' must declare implementation of ${spec.ac_id} or ${spec.req_id}`
        )});`
      );
    }
    lines.push("});");
    lines.push("");
  }

  return lines.join("\n");
}

function commitBaselineFilesToGitRepo(input: {
  readonly repoPath: string;
  readonly files: Readonly<Record<string, string>>;
  readonly commitMessage: string;
}): string {
  const absRepo = resolve(input.repoPath);
  if (!existsSync(absRepo)) {
    mkdirSync(absRepo, { recursive: true });
    runGit(absRepo, ["init", "--bare", "--initial-branch=main"]);
  } else {
    const entries = readdirSync(absRepo);
    if (entries.length === 0) {
      runGit(absRepo, ["init", "--bare", "--initial-branch=main"]);
    }
  }

  const isBareRaw = tryRunGit(absRepo, ["rev-parse", "--is-bare-repository"]);
  if (isBareRaw === null) {
    throw new PostgresRlsError(
      "23514",
      `Repository path '${absRepo}' is not a valid Git repository`
    );
  }
  const isBare = isBareRaw === "true";
  const existingMainSha = tryRunGit(absRepo, ["rev-parse", "--verify", "refs/heads/main"]);

  if (!isBare) {
    if (!existingMainSha) {
      tryRunGit(absRepo, ["checkout", "-B", "main"]);
    } else {
      runGit(absRepo, ["checkout", "main"]);
    }
    runGit(absRepo, ["config", "user.name", "Software Factory Stage5 Bootstrapper"]);
    runGit(absRepo, ["config", "user.email", "bootstrapper@software-factory.local"]);
    for (const [relPath, content] of Object.entries(input.files)) {
      const dest = join(absRepo, ...relPath.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
    runGit(absRepo, ["add", ...Object.keys(input.files)]);
    const statusOut = runGit(absRepo, ["status", "--porcelain"]);
    if (statusOut.length > 0 || !existingMainSha) {
      runGit(absRepo, ["commit", "--allow-empty", "-m", input.commitMessage]);
    }
    return runGit(absRepo, ["rev-parse", "refs/heads/main"]).toLowerCase();
  }

  // Bare repo flow via ephemeral working directory + atomic update-ref
  const scratchDir = mkdtempSync(join(tmpdir(), "sf-stage5-bootstrap-"));
  try {
    if (existingMainSha) {
      runGit(tmpdir(), ["clone", absRepo, scratchDir]);
      runGit(scratchDir, ["checkout", "main"]);
    } else {
      runGit(scratchDir, ["init", "-b", "main"]);
    }
    runGit(scratchDir, ["config", "user.name", "Software Factory Stage5 Bootstrapper"]);
    runGit(scratchDir, ["config", "user.email", "bootstrapper@software-factory.local"]);

    for (const [relPath, content] of Object.entries(input.files)) {
      const dest = join(scratchDir, ...relPath.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, "utf8");
    }
    runGit(scratchDir, ["add", ...Object.keys(input.files)]);
    runGit(scratchDir, ["commit", "--allow-empty", "-m", input.commitMessage]);
    const newMainSha = runGit(scratchDir, ["rev-parse", "HEAD"]).toLowerCase();
    runGit(absRepo, ["fetch", scratchDir, "main"]);
    if (existingMainSha) {
      runGit(absRepo, ["update-ref", "refs/heads/main", newMainSha, existingMainSha]);
    } else {
      runGit(absRepo, ["update-ref", "refs/heads/main", newMainSha]);
    }
    tryRunGit(absRepo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return newMainSha;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

export async function runStage5ProjectBootstrap(
  store: ControlPlaneStore,
  input: RunStage5ProjectBootstrapInput
): Promise<Stage5BootstrapOutcome> {
  if (!input.actor_principal_id.trim()) {
    throw new PostgresRlsError("23514", "actor_principal_id is required for Stage 5 bootstrap");
  }

  // Short TX1: validate frozen baseline and extract Stage 2/3 specs
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
          `Stage 5 requires FROZEN Stage 4 baseline (session status is ${session.status})`
        );
      }
      const baseline = await store.getBaselineSpecFreeze(input.pipeline_session_id);
      if (!baseline || baseline.status !== "FROZEN") {
        throw new PostgresRlsError(
          "23514",
          `No FROZEN baseline_spec_freezes record exists for session ${input.pipeline_session_id}`
        );
      }
      const existingBootstrap = await store.getProjectBootstrapBySession(input.pipeline_session_id);
      if (existingBootstrap) {
        throw new PostgresRlsError(
          "23505",
          `Project bootstrap already exists for session ${input.pipeline_session_id} (${existingBootstrap.bootstrap_id})`
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
      return { project, session, baseline, stage2, stage3 };
    }
  );

  const reqs = extractStage2Requirements(pre.stage2.content_json);
  if (reqs.length === 0) {
    throw new PostgresRlsError("23514", "Frozen Stage 2 artifact contains zero requirements");
  }
  const designIndex = extractStage3DesignIndex(pre.stage3.content_json);
  const protectedPaths = normalizeExtraProtectedPaths(input.extra_protected_paths);

  const repoPath = resolve(input.repo_path?.trim() || pre.project.repo_bare_path);
  const trustedAcceptanceDir = resolve(
    input.trusted_acceptance_dir?.trim() ||
      join(dirname(repoPath), `.sf-trusted-acceptance-${pre.baseline.baseline_id}`)
  );

  // Guard against trustedAcceptanceDir nested inside non-bare repoPath
  if (trustedAcceptanceDir === repoPath || trustedAcceptanceDir.startsWith(`${repoPath}/`)) {
    throw new PostgresRlsError(
      "23514",
      `trusted_acceptance_dir (${trustedAcceptanceDir}) must reside outside repo_path (${repoPath}) so agents cannot read or tamper with it`
    );
  }

  const overrides = input.acceptance_specs ?? {};
  const acceptanceTests: TrustedAcceptanceTestSpec[] = [];
  for (const req of reqs) {
    if (req.acceptance_criteria.length === 0) {
      throw new PostgresRlsError(
        "23514",
        `Requirement ${req.req_id} has zero acceptance_criteria; cannot synthesize Trusted Acceptance Tests`
      );
    }
    const compIds = designIndex.componentsByReqId.get(req.req_id) ?? [];
    for (const ac of req.acceptance_criteria) {
      const ov = overrides[ac.ac_id];
      const defaultDeliverable =
        compIds.length > 0
          ? `src/components/${slugifyIdentifier(compIds[0]!)}.mjs`
          : `src/requirements/${slugifyIdentifier(req.req_id)}.mjs`;
      const targetDeliverable = ov?.target_file ?? defaultDeliverable;
      acceptanceTests.push({
        ac_id: ac.ac_id,
        req_id: req.req_id,
        given: ac.given,
        when: ac.when,
        then: ac.then,
        test_file_path: "acceptance.test.mjs",
        component_ids: [...compIds],
        expected_deliverables: [targetDeliverable],
      });
    }
  }

  // Write Trusted Acceptance Tests outside the agent workspace and hash the directory
  mkdirSync(trustedAcceptanceDir, { recursive: true });
  const trustedManifest = canonicalizeJson({
    baseline_id: pre.baseline.baseline_id,
    pipeline_session_id: pre.session.pipeline_session_id,
    stage2_artifact_sha256: pre.baseline.stage2_artifact_sha256,
    stage3_artifact_sha256: pre.baseline.stage3_artifact_sha256,
    protected_paths: protectedPaths,
    acceptance_tests: acceptanceTests,
  });
  writeFileSync(join(trustedAcceptanceDir, "trusted-manifest.json"), trustedManifest, "utf8");
  writeFileSync(
    join(trustedAcceptanceDir, "acceptance.test.mjs"),
    buildTrustedAcceptanceTestSource({
      baseline: pre.baseline,
      specs: acceptanceTests,
      overrides,
    }),
    "utf8"
  );
  const trustedPolicySha256 = computeDirectorySha256(trustedAcceptanceDir);

  const policyJson = JSON.stringify(
    {
      schema_version: "1.5",
      baseline_id: pre.baseline.baseline_id,
      pipeline_session_id: pre.session.pipeline_session_id,
      stage2_artifact_sha256: pre.baseline.stage2_artifact_sha256,
      stage3_artifact_sha256: pre.baseline.stage3_artifact_sha256,
      trusted_policy_sha256: trustedPolicySha256,
      protected_paths: protectedPaths,
      requirements: reqs.map((r) => ({ req_id: r.req_id, ac_ids: r.ac_ids })),
    },
    null,
    2
  );

  const repoFiles: Record<string, string> = {
    "policy/trusted-verification-policy.json": `${policyJson}\n`,
    "tests/protected/baseline-spec.test.mjs": buildProtectedBaselineTestSource({
      baseline: pre.baseline,
    }),
    "README.md": buildBaselineReadme({
      title: pre.session.title,
      baseline: pre.baseline,
      reqCount: reqs.length,
    }),
    "package.json": `${JSON.stringify(
      {
        name: slugifyIdentifier(pre.project.slug || pre.session.title),
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          "test:baseline": "node tests/protected/baseline-spec.test.mjs",
        },
      },
      null,
      2
    )}\n`,
  };

  for (const [relPath, content] of Object.entries(input.scaffold_files ?? {})) {
    const cleanRel = relPath.trim();
    if (!isSafeRelativePosixPath(cleanRel)) {
      throw new PostgresRlsError("23514", `Unsafe Stage 5 scaffold_files path '${relPath}'`);
    }
    if (
      matchesAnyGlob(cleanRel, protectedPaths, false) ||
      matchesAnyGlob(cleanRel, DEFAULT_SYSTEM_FORBIDDEN_PATHS, true)
    ) {
      throw new PostgresRlsError(
        "23514",
        `Stage 5 scaffold_files '${cleanRel}' cannot collide with protected or forbidden paths`
      );
    }
    repoFiles[cleanRel] = content;
  }

  const baseMainCommitHash = commitBaselineFilesToGitRepo({
    repoPath,
    files: repoFiles,
    commitMessage: `chore(stage5): bootstrap baseline ${pre.baseline.baseline_id}`,
  });

  // Short TX2: update project main_ref_commit_hash & persist immutable project_bootstraps record
  const bootstrap = await store.withRlsTransaction(
    {
      currentProjectId: input.project_id,
      currentPrincipalId: input.actor_principal_id,
      currentRole: "core_api_service",
    },
    async () => {
      await store.updateProjectMainRefCommitHash({
        project_id: input.project_id,
        main_ref_commit_hash: baseMainCommitHash,
      });
      return store.createProjectBootstrap({
        project_id: input.project_id,
        pipeline_session_id: input.pipeline_session_id,
        baseline_id: pre.baseline.baseline_id,
        repo_path: repoPath,
        trusted_acceptance_dir: trustedAcceptanceDir,
        base_main_commit_hash: baseMainCommitHash,
        protected_paths: protectedPaths,
        trusted_policy_sha256: trustedPolicySha256,
        generated_files: Object.keys(repoFiles).sort(),
        acceptance_tests: acceptanceTests,
        created_by_principal_id: input.actor_principal_id,
      });
    }
  );

  return {
    bootstrap,
    baseline: pre.baseline,
  };
}
