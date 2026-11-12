import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  type ControlPlaneStore,
  PostgresRlsError,
  REQUIRED_STAGE5_PROTECTED_PATHS,
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

const FORBIDDEN_ASSERTION_PATTERNS: readonly RegExp[] = [
  /[\r\n]/,
  /\b(?:process|eval|Function|require|import|child_process|fs|globalThis|global|fetch|Buffer|__dirname|__filename|Reflect|Proxy)\b/,
  /;/,
];

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

/**
 * Resolves the canonical filesystem path by following symlinks along every existing
 * prefix down to the target (including when the leaf directory itself does not yet exist).
 */
function resolveCanonicalPathFollowingExistingPrefix(targetPath: string): string {
  const abs = resolve(targetPath);
  const parsedRoot = parse(abs).root;
  const relFromRoot = abs.slice(parsedRoot.length);
  const parts = relFromRoot.split(sep).filter(Boolean);

  let current = parsedRoot;
  let existingPrefixReal = existsSync(parsedRoot) ? realpathSync(parsedRoot) : parsedRoot;
  let uncreatedStartIdx = parts.length;

  for (let i = 0; i < parts.length; i += 1) {
    const next = join(current, parts[i]!);
    if (existsSync(next)) {
      current = next;
      existingPrefixReal = realpathSync(next);
    } else {
      uncreatedStartIdx = i;
      break;
    }
  }

  return uncreatedStartIdx < parts.length
    ? join(existingPrefixReal, ...parts.slice(uncreatedStartIdx))
    : existingPrefixReal;
}

function isPathSameOrInside(parentReal: string, candidateReal: string): boolean {
  if (candidateReal === parentReal) {
    return true;
  }
  const rel = relative(parentReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validateAssertionLines(
  acId: string,
  lines: readonly string[] | undefined
): string[] {
  const validated: string[] = [];
  for (const rawLine of lines ?? []) {
    const trimmed = rawLine.trim().replace(/;+\s*$/, "");
    if (!trimmed) {
      throw new PostgresRlsError(
        "23514",
        `Stage 5 acceptance_specs['${acId}'] contains blank assertion_line`
      );
    }
    for (const pattern of FORBIDDEN_ASSERTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        throw new PostgresRlsError(
          "23514",
          `Stage 5 acceptance_specs['${acId}'] assertion_line contains forbidden construct or delimiter`
        );
      }
    }
    if (!/^(?:const\s+[A-Za-z_$][\w$]*\s*=|assert\.[A-Za-z_$][\w$]*\()/.test(trimmed)) {
      throw new PostgresRlsError(
        "23514",
        `Stage 5 acceptance_specs['${acId}'] assertion_line must be an assert.*(...) call or const binding`
      );
    }
    validated.push(`${trimmed};`);
  }
  return validated;
}

function normalizeExtraProtectedPaths(
  extras: readonly string[] | undefined
): string[] {
  const base = [
    ...REQUIRED_STAGE5_PROTECTED_PATHS,
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
    'const EMPTY_FN_PATTERN = /^(?:async\\s+)?(?:function(?:\\s+\\w+)?\\s*)?\\([^)]*\\)\\s*(?:=>\\s*)?\\{\\s*(?:return\\s*;?)?\\s*\\}$/;',
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
    const extraAssertions = validateAssertionLines(spec.ac_id, override?.assertion_lines);
    const testLabel = `[${spec.req_id}/${spec.ac_id}] Given ${spec.given} When ${spec.when} Then ${spec.then}`;
    lines.push(`test(${JSON.stringify(testLabel)}, async () => {`);
    lines.push(`  const targetPath = join(process.cwd(), ${JSON.stringify(targetRel)});`);
    lines.push(
      `  assert.equal(existsSync(targetPath), true, ${JSON.stringify(
        `Missing deliverable '${targetRel}' required for ${spec.req_id} (${spec.ac_id})`
      )});`
    );
    lines.push("  const mod = await import(pathToFileURL(targetPath).href);");
    // Independent baseline verification always runs first and cannot be replaced by overrides (M6B-FIX-02)
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
    lines.push(
      '  const exportedFns = Object.entries(mod).filter(([k, v]) => typeof v === "function" && !k.startsWith("_"));'
    );
    lines.push(
      `  assert.ok(exportedFns.length >= 1, ${JSON.stringify(
        `Deliverable '${targetRel}' must export at least one executable function for ${spec.ac_id}`
      )});`
    );
    lines.push(
      `  assert.equal(exportedFns.some(([, fn]) => !EMPTY_FN_PATTERN.test(Function.prototype.toString.call(fn).trim())), true, ${JSON.stringify(
        `Deliverable '${targetRel}' must implement non-empty executable behavior for ${spec.ac_id}`
      )});`
    );
    if (extraAssertions.length === 0) {
      lines.push(
        `  if (typeof mod.verifyAcceptance === "function") {`,
        `    const ok = await mod.verifyAcceptance(${JSON.stringify(spec.ac_id)}, ${JSON.stringify(spec.req_id)});`,
        `    assert.equal(ok, true, ${JSON.stringify(
          `verifyAcceptance('${spec.ac_id}') on '${targetRel}' must return true`
        )});`,
        `  } else {`,
        `    const zeroArgFn = exportedFns.find(([, fn]) => fn.length === 0)?.[1];`,
        `    if (zeroArgFn) {`,
        `      const out = await zeroArgFn();`,
        `      assert.ok(out !== undefined && out !== null && out !== false, ${JSON.stringify(
          `Default behavioral invocation on '${targetRel}' returned empty/false outcome`
        )});`,
        `    }`,
        `  }`
      );
    }
    if (override?.export_name) {
      lines.push(
        `  assert.notEqual(mod[${JSON.stringify(override.export_name)}], undefined, ${JSON.stringify(
          `Expected export '${override.export_name}' on ${targetRel} for ${spec.ac_id}`
        )});`
      );
    }
    for (const stmt of extraAssertions) {
      lines.push(`  ${stmt}`);
    }
    lines.push("});");
    lines.push("");
  }

  return lines.join("\n");
}

interface PreparedBaselineGitCommit {
  readonly baseMainCommitHash: string;
  finalizeGitMainRef(): void;
  cleanup(): void;
}

export function pruneStalePendingBootstrapRefs(
  repoPath: string,
  maxAgeMs = 3_600_000,
  nowMs = Date.now()
): number {
  const absRepo = resolve(repoPath);
  const refsRaw = tryRunGit(absRepo, [
    "for-each-ref",
    "--format=%(refname)\t%(committerdate:unix)",
    "refs/sf/pending-bootstrap",
  ]);
  if (!refsRaw) {
    return 0;
  }
  let removed = 0;
  const cutoffMs = nowMs - Math.max(0, maxAgeMs);
  for (const line of refsRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [refName, unixSecRaw] = trimmed.split("\t");
    if (!refName) continue;
    const commitMs = Number(unixSecRaw ?? 0) * 1000;
    if (!Number.isFinite(commitMs) || commitMs <= cutoffMs) {
      if (tryRunGit(absRepo, ["update-ref", "-d", refName]) !== null) {
        removed += 1;
      }
    }
  }
  return removed;
}

function assertCleanNonBareWorkingTree(absRepo: string): void {
  const dirty = runGit(absRepo, ["status", "--porcelain"]);
  if (dirty.length > 0) {
    throw new PostgresRlsError(
      "23514",
      `Repository '${absRepo}' has uncommitted working tree changes; aborting Stage 5 checkout without discarding local modifications`
    );
  }
}

function prepareBaselineGitCommit(input: {
  readonly baselineId: string;
  readonly repoPath: string;
  readonly files: Readonly<Record<string, string>>;
  readonly commitMessage: string;
}): PreparedBaselineGitCommit {
  const absRepo = resolve(input.repoPath);
  let createdRepoDir = false;
  if (!existsSync(absRepo)) {
    mkdirSync(absRepo, { recursive: true });
    runGit(absRepo, ["init", "--bare", "--initial-branch=main"]);
    createdRepoDir = true;
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
  if (!isBare) {
    assertCleanNonBareWorkingTree(absRepo);
  }
  const existingMainSha = tryRunGit(absRepo, ["rev-parse", "--verify", "refs/heads/main"]);

  // Build commit in an isolated scratch clone so refs/heads/main is untouched until TX2 succeeds
  const scratchDir = mkdtempSync(join(tmpdir(), "sf-stage5-bootstrap-"));
  const pendingRef = `refs/sf/pending-bootstrap/${input.baselineId}-${Date.now()}-${randomUUID()}`;
  let pendingRefWritten = false;
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
    runGit(absRepo, ["fetch", scratchDir, `refs/heads/main:${pendingRef}`]);
    pendingRefWritten = true;

    return {
      baseMainCommitHash: newMainSha,
      finalizeGitMainRef: () => {
        if (!isBare) {
          assertCleanNonBareWorkingTree(absRepo);
        }
        if (existingMainSha) {
          runGit(absRepo, ["update-ref", "refs/heads/main", newMainSha, existingMainSha]);
        } else {
          runGit(absRepo, ["update-ref", "refs/heads/main", newMainSha]);
        }
        tryRunGit(absRepo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
        if (!isBare) {
          runGit(absRepo, ["checkout", "main"]);
        }
        tryRunGit(absRepo, ["update-ref", "-d", pendingRef]);
        pendingRefWritten = false;
      },
      cleanup: () => {
        rmSync(scratchDir, { recursive: true, force: true });
        if (pendingRefWritten) {
          tryRunGit(absRepo, ["update-ref", "-d", pendingRef]);
          pendingRefWritten = false;
        }
        if (createdRepoDir && !tryRunGit(absRepo, ["rev-parse", "--verify", "refs/heads/main"])) {
          try {
            rmSync(absRepo, { recursive: true, force: true });
          } catch {
            // ignore cleanup failure
          }
        }
      },
    };
  } catch (err) {
    rmSync(scratchDir, { recursive: true, force: true });
    if (pendingRefWritten) {
      tryRunGit(absRepo, ["update-ref", "-d", pendingRef]);
    }
    throw err;
  }
}

function publishDirectoryAtomically(stagingDir: string, destinationDir: string): void {
  mkdirSync(dirname(destinationDir), { recursive: true });
  if (existsSync(destinationDir)) {
    const entries = readdirSync(destinationDir);
    if (entries.length > 0) {
      throw new PostgresRlsError(
        "23514",
        `trusted_acceptance_dir (${destinationDir}) must be empty before publishing`
      );
    }
    rmSync(destinationDir, { recursive: true, force: true });
  }
  try {
    renameSync(stagingDir, destinationDir);
  } catch {
    // Cross-device EXDEV fallback: copy staged files and remove staging dir
    cpSync(stagingDir, destinationDir, { recursive: true });
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

  const rawRepoPath = input.repo_path?.trim() || pre.project.repo_bare_path;
  if (!rawRepoPath) {
    throw new PostgresRlsError("23514", "repo_path is required for Stage 5 bootstrap");
  }
  const repoPath = resolve(rawRepoPath);
  const trustedAcceptanceDir = resolve(
    input.trusted_acceptance_dir?.trim() ||
      join(dirname(repoPath), `.sf-trusted-acceptance-${pre.baseline.baseline_id}`)
  );

  // Guard against symlinked or nested trusted_acceptance_dir inside repo_path (M6B-FIX-09)
  const repoReal = resolveCanonicalPathFollowingExistingPrefix(repoPath);
  const trustedReal = resolveCanonicalPathFollowingExistingPrefix(trustedAcceptanceDir);
  if (isPathSameOrInside(repoReal, trustedReal)) {
    throw new PostgresRlsError(
      "23514",
      `trusted_acceptance_dir (${trustedAcceptanceDir}) must reside outside repo_path (${repoPath}) so agents cannot read or tamper with it`
    );
  }
  if (trustedReal === parse(trustedReal).root) {
    throw new PostgresRlsError(
      "23514",
      `trusted_acceptance_dir (${trustedAcceptanceDir}) cannot be a filesystem root`
    );
  }

  // Reserve canonical trusted_acceptance_dir exclusively across concurrent processes/baselines (M6B review Minor Note #3)
  mkdirSync(dirname(trustedReal), { recursive: true });
  const bootstrapLockPath = `${trustedReal}.sf-bootstrap.lock`;
  let bootstrapLockAcquired = false;
  try {
    const lockFd = openSync(bootstrapLockPath, "wx");
    closeSync(lockFd);
    bootstrapLockAcquired = true;
  } catch (lockErr: unknown) {
    const code = (lockErr as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      throw new PostgresRlsError(
        "23505",
        `Concurrent Stage 5 bootstrap already reserves trusted_acceptance_dir (${trustedReal})`
      );
    }
    throw lockErr;
  }

  const stagingTrustedDir = mkdtempSync(join(tmpdir(), "sf-stage5-trusted-"));
  let preparedGit: PreparedBaselineGitCommit | null = null;
  try {
    // Reject pre-existing symlinks, files, or non-empty trusted_acceptance_dir
    if (existsSync(trustedAcceptanceDir)) {
      const stat = lstatSync(trustedAcceptanceDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new PostgresRlsError(
          "23514",
          `trusted_acceptance_dir (${trustedAcceptanceDir}) must be an empty directory, not a file or symlink`
        );
      }
      const existingFiles = readdirSync(trustedAcceptanceDir);
      if (existingFiles.length > 0) {
        throw new PostgresRlsError(
          "23514",
          `trusted_acceptance_dir (${trustedAcceptanceDir}) must be empty prior to Stage 5 bootstrap (found ${existingFiles.length} leftover entries)`
        );
      }
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

    // Stage Trusted Acceptance Tests in isolated temporary directory before DB TX2
    const trustedManifest = canonicalizeJson({
      baseline_id: pre.baseline.baseline_id,
      pipeline_session_id: pre.session.pipeline_session_id,
      stage2_artifact_sha256: pre.baseline.stage2_artifact_sha256,
      stage3_artifact_sha256: pre.baseline.stage3_artifact_sha256,
      protected_paths: protectedPaths,
      acceptance_tests: acceptanceTests,
    });
    writeFileSync(join(stagingTrustedDir, "trusted-manifest.json"), trustedManifest, "utf8");
    writeFileSync(
      join(stagingTrustedDir, "acceptance.test.mjs"),
      buildTrustedAcceptanceTestSource({
        baseline: pre.baseline,
        specs: acceptanceTests,
        overrides,
      }),
      "utf8"
    );
    const trustedPolicySha256 = computeDirectorySha256(stagingTrustedDir);

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

    preparedGit = prepareBaselineGitCommit({
      baselineId: pre.baseline.baseline_id,
      repoPath,
      files: repoFiles,
      commitMessage: `chore(stage5): bootstrap baseline ${pre.baseline.baseline_id}`,
    });
    const baseMainCommitHash = preparedGit.baseMainCommitHash;

    // Short TX2: enforce DB UNIQUE (project_id, baseline_id) & trusted_acceptance_dir BEFORE publishing
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
          trusted_acceptance_dir: trustedReal,
          base_main_commit_hash: baseMainCommitHash,
          protected_paths: protectedPaths,
          trusted_policy_sha256: trustedPolicySha256,
          generated_files: Object.keys(repoFiles).sort(),
          acceptance_tests: acceptanceTests,
          created_by_principal_id: input.actor_principal_id,
        });
      }
    );

    // TX2 committed -> atomically publish trusted acceptance directory and move refs/heads/main
    publishDirectoryAtomically(stagingTrustedDir, trustedAcceptanceDir);
    preparedGit.finalizeGitMainRef();

    return {
      bootstrap,
      baseline: pre.baseline,
    };
  } finally {
    rmSync(stagingTrustedDir, { recursive: true, force: true });
    preparedGit?.cleanup();
    if (bootstrapLockAcquired) {
      try {
        unlinkSync(bootstrapLockPath);
      } catch {
        // ignore lock cleanup failure
      }
    }
  }
}
