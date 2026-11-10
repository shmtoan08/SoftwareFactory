import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { SnapshotRetentionClass } from "@software-factory/shared-types";

export const DEFAULT_EPHEMERAL_SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export interface BuildMergeCandidateInput {
  readonly repoPath: string;
  readonly taskId: string;
  readonly agentCommitHash: string;
  readonly expectedBaseMainCommitHash?: string;
  readonly mainRef?: string;
  readonly candidateRef?: string;
  readonly gitDir?: string;
  readonly snapshotStore?: ImmutableSourceSnapshotStore;
  readonly createdAt?: Date;
}

export type BuildMergeCandidateResult =
  | {
      readonly ok: true;
      readonly baseMainCommitHash: string;
      readonly agentCommitHash: string;
      readonly mergeCandidateHash: string;
      readonly verifiedTreeHash: string;
      readonly candidateRef: string;
      readonly snapshotPath?: string;
      readonly snapshotSha256?: string;
      readonly snapshotSizeBytes?: number;
      readonly snapshotRetentionClass?: SnapshotRetentionClass;
    }
  | {
      readonly ok: false;
      readonly reason: "MERGE_CONFLICT";
      readonly baseMainCommitHash: string;
      readonly agentCommitHash: string;
      readonly conflictedFiles: readonly string[];
      readonly conflictSummary: string;
    };

export interface SnapshotManifest {
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
  readonly snapshotSizeBytes: number;
  readonly verifiedTreeHash: string;
  readonly mergeCandidateHash: string;
  retentionClass: SnapshotRetentionClass;
  readonly createdAt: string;
  expiresAt: string | null;
}

export interface SnapshotGcResult {
  readonly deletedPaths: readonly string[];
  readonly retainedPermanentPaths: readonly string[];
  readonly retainedActivePaths: readonly string[];
}

export class SnapshotIntegrityError extends Error {
  public readonly code:
    | "ERR_SNAPSHOT_NOT_FOUND"
    | "ERR_SNAPSHOT_INTEGRITY_MISMATCH"
    | "ERR_SNAPSHOT_CONTAINS_GIT_METADATA"
    | "ERR_SNAPSHOT_UNSAFE_ARCHIVE_MEMBER"
    | "ERR_SNAPSHOT_NOT_READONLY";

  constructor(
    code:
      | "ERR_SNAPSHOT_NOT_FOUND"
      | "ERR_SNAPSHOT_INTEGRITY_MISMATCH"
      | "ERR_SNAPSHOT_CONTAINS_GIT_METADATA"
      | "ERR_SNAPSHOT_UNSAFE_ARCHIVE_MEMBER"
      | "ERR_SNAPSHOT_NOT_READONLY",
    message: string
  ) {
    super(message);
    this.name = "SnapshotIntegrityError";
    this.code = code;
  }
}

export function sha256File(filePath: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, sizeBytes: bytes.byteLength };
}

function buildGitEnv(gitDir?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(gitDir ? { GIT_DIR: gitDir } : {}),
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Software Factory Control Plane",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "control-plane@software-factory.local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Software Factory Control Plane",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "control-plane@software-factory.local",
  };
}

function parseMergeTreeZOutput(stdoutText: string): {
  treeHash: string;
  conflictedFiles: string[];
  conflictSummary: string;
} {
  const tokens = stdoutText.split("\0");
  const treeHash = (tokens[0] ?? "").trim();
  const emptyMarkerIdx = tokens.indexOf("", 1);
  const conflictedEnd = emptyMarkerIdx === -1 ? tokens.length : emptyMarkerIdx;

  const conflictedFiles: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < conflictedEnd; i++) {
    const file = tokens[i]!;
    if (file && !seen.has(file)) {
      seen.add(file);
      conflictedFiles.push(file);
    }
  }

  const infoTokens =
    emptyMarkerIdx === -1
      ? []
      : tokens
          .slice(emptyMarkerIdx + 1)
          .map((t) => t.trim())
          .filter(Boolean);

  return {
    treeHash,
    conflictedFiles,
    conflictSummary: infoTokens.join(" | "),
  };
}

/**
 * Inspects entries of a `.tar` archive and rejects any `.git` metadata or path traversal members.
 */
export function assertArchiveContainsNoGitOrTraversal(tarPath: string): readonly string[] {
  const listOut = execFileSync("tar", ["-tf", tarPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  const entries = listOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, "");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").some((seg) => seg === "..")
    ) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_UNSAFE_ARCHIVE_MEMBER",
        `Refusing to extract snapshot containing unsafe archive path "${entry}"`
      );
    }
    const segments = normalized.replace(/\/+$/, "").split("/");
    if (segments.includes(".git")) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_CONTAINS_GIT_METADATA",
        `Refusing to extract snapshot containing forbidden .git metadata entry "${entry}"`
      );
    }
  }

  return entries;
}

/**
 * Write-Once-Read-Many (WORM) immutable `.tar` source snapshot store (`MVP-SPEC-04` §1.1 items 3-4).
 * Enforces `0o444` read-only mode on persisted archives, SHA-256 verification before extraction,
 * zero `.git` directory guarantees, and 14-day ephemeral vs permanent `MERGED` GC policy.
 */
export class ImmutableSourceSnapshotStore {
  public readonly storageDir: string;
  public readonly ephemeralTtlMs: number;

  constructor(options: { storageDir: string; ephemeralTtlMs?: number }) {
    this.storageDir = resolve(options.storageDir);
    this.ephemeralTtlMs = options.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_SNAPSHOT_TTL_MS;
    mkdirSync(this.storageDir, { recursive: true });
  }

  private getMetaPath(tarPath: string): string {
    return `${tarPath}.meta.json`;
  }

  public getManifest(tarPath: string): SnapshotManifest | null {
    const metaPath = this.getMetaPath(resolve(tarPath));
    if (!existsSync(metaPath)) {
      return null;
    }
    return JSON.parse(readFileSync(metaPath, "utf8")) as SnapshotManifest;
  }

  private writeManifest(manifest: SnapshotManifest): void {
    const metaPath = this.getMetaPath(manifest.snapshotPath);
    writeFileSync(metaPath, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  /**
   * Runs `git archive --format=tar <mergeCandidateHash>` (whose tree is `verifiedTreeHash`),
   * enforces zero `.git` members, seals file permissions as `0o444` WORM, and records metadata.
   */
  public exportFromGitCommit(options: {
    repoPath: string;
    gitDir?: string;
    mergeCandidateHash: string;
    verifiedTreeHash: string;
    createdAt?: Date;
  }): SnapshotManifest {
    const candidateDir = join(this.storageDir, options.mergeCandidateHash);
    mkdirSync(candidateDir, { recursive: true });

    const tarPath = join(candidateDir, `snapshot-${options.verifiedTreeHash}.tar`);
    const existingMeta = this.getManifest(tarPath);
    if (existsSync(tarPath) && existingMeta) {
      const actual = sha256File(tarPath);
      if (actual.sha256 !== existingMeta.snapshotSha256) {
        throw new SnapshotIntegrityError(
          "ERR_SNAPSHOT_INTEGRITY_MISMATCH",
          `Existing WORM snapshot ${tarPath} failed SHA-256 verification (${actual.sha256} !== ${existingMeta.snapshotSha256})`
        );
      }
      return existingMeta;
    }

    const tmpTarPath = `${tarPath}.tmp-${randomUUID()}`;
    try {
      execFileSync(
        "git",
        ["archive", "--format=tar", `--output=${tmpTarPath}`, options.mergeCandidateHash],
        {
          cwd: options.repoPath,
          env: buildGitEnv(options.gitDir),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        }
      );

      assertArchiveContainsNoGitOrTraversal(tmpTarPath);
      const { sha256, sizeBytes } = sha256File(tmpTarPath);

      chmodSync(tmpTarPath, 0o444);
      renameSync(tmpTarPath, tarPath);

      const createdDate = options.createdAt ?? new Date();
      const manifest: SnapshotManifest = {
        snapshotPath: tarPath,
        snapshotSha256: sha256,
        snapshotSizeBytes: sizeBytes,
        verifiedTreeHash: options.verifiedTreeHash,
        mergeCandidateHash: options.mergeCandidateHash,
        retentionClass: "EPHEMERAL_14D",
        createdAt: createdDate.toISOString(),
        expiresAt: new Date(createdDate.getTime() + this.ephemeralTtlMs).toISOString(),
      };
      this.writeManifest(manifest);
      return manifest;
    } catch (err) {
      if (existsSync(tmpTarPath)) {
        rmSync(tmpTarPath, { force: true });
      }
      throw err;
    }
  }

  /**
   * Fails closed if snapshot file was deleted, mutated even 1 byte, made writable without authorization,
   * or contains `.git` metadata. Extracts cleanly into `targetDir`.
   */
  public verifyAndExtractSnapshot(options: {
    snapshotPath: string;
    expectedSha256: string;
    targetDir: string;
    requireReadOnlyMode?: boolean;
  }): { readonly verifiedSha256: string; readonly extractedEntries: readonly string[] } {
    const absTar = resolve(options.snapshotPath);
    if (!existsSync(absTar)) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_NOT_FOUND",
        `Snapshot archive not found: ${absTar}`
      );
    }

    if (options.requireReadOnlyMode !== false) {
      const mode = statSync(absTar).mode & 0o777;
      if ((mode & 0o222) !== 0) {
        throw new SnapshotIntegrityError(
          "ERR_SNAPSHOT_NOT_READONLY",
          `WORM violation: snapshot ${absTar} has writable mode 0o${mode.toString(8)}`
        );
      }
    }

    const { sha256 } = sha256File(absTar);
    if (sha256 !== options.expectedSha256) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_INTEGRITY_MISMATCH",
        `Snapshot SHA-256 mismatch for ${absTar}: expected ${options.expectedSha256}, got ${sha256}`
      );
    }

    const entries = assertArchiveContainsNoGitOrTraversal(absTar);
    mkdirSync(options.targetDir, { recursive: true });
    execFileSync("tar", ["-xf", absTar, "-C", options.targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    return {
      verifiedSha256: sha256,
      extractedEntries: entries,
    };
  }

  public markMergedPermanent(snapshotPath: string): SnapshotManifest {
    const manifest = this.getManifest(snapshotPath);
    if (!manifest) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_NOT_FOUND",
        `Snapshot manifest not found for ${snapshotPath}`
      );
    }
    const updated: SnapshotManifest = {
      ...manifest,
      retentionClass: "MERGED_PERMANENT",
      expiresAt: null,
    };
    this.writeManifest(updated);
    return updated;
  }

  public markInvalidatedOrSuperseded(
    snapshotPath: string,
    invalidatedAt: Date = new Date()
  ): SnapshotManifest {
    const manifest = this.getManifest(snapshotPath);
    if (!manifest) {
      throw new SnapshotIntegrityError(
        "ERR_SNAPSHOT_NOT_FOUND",
        `Snapshot manifest not found for ${snapshotPath}`
      );
    }
    if (manifest.retentionClass === "MERGED_PERMANENT") {
      return manifest;
    }
    const updated: SnapshotManifest = {
      ...manifest,
      retentionClass: "EPHEMERAL_14D",
      expiresAt: new Date(invalidatedAt.getTime() + this.ephemeralTtlMs).toISOString(),
    };
    this.writeManifest(updated);
    return updated;
  }

  public pruneExpiredSnapshots(now: Date = new Date()): SnapshotGcResult {
    const deletedPaths: string[] = [];
    const retainedPermanentPaths: string[] = [];
    const retainedActivePaths: string[] = [];
    const nowMs = now.getTime();

    const subEntries = readdirSync(this.storageDir, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) {
        continue;
      }
      const candDir = join(this.storageDir, sub.name);
      for (const file of readdirSync(candDir)) {
        if (!file.endsWith(".meta.json")) {
          continue;
        }
        const metaPath = join(candDir, file);
        const manifest = JSON.parse(readFileSync(metaPath, "utf8")) as SnapshotManifest;
        if (manifest.retentionClass === "MERGED_PERMANENT") {
          retainedPermanentPaths.push(manifest.snapshotPath);
          continue;
        }
        const expMs = manifest.expiresAt ? Date.parse(manifest.expiresAt) : Number.POSITIVE_INFINITY;
        if (expMs <= nowMs) {
          if (existsSync(manifest.snapshotPath)) {
            chmodSync(manifest.snapshotPath, 0o600);
            unlinkSync(manifest.snapshotPath);
          }
          unlinkSync(metaPath);
          deletedPaths.push(manifest.snapshotPath);
          try {
            if (readdirSync(candDir).length === 0) {
              rmdirSync(candDir);
            }
          } catch {
            // ignore non-empty cleanup errors
          }
        } else {
          retainedActivePaths.push(manifest.snapshotPath);
        }
      }
    }

    return {
      deletedPaths,
      retainedPermanentPaths,
      retainedActivePaths,
    };
  }
}

/**
 * Builds the real `C_candidate` commit BEFORE verification (`Candidate-First Principle`, `MVP-SPEC-04` §1.1):
 * 1. Resolves current `HEAD` of `refs/heads/main` (`B_base`).
 * 2. Runs `git merge-tree --write-tree --name-only -z <B_base> <C_agent>` without mutating working trees.
 * 3. On Git merge conflict, returns `{ ok: false, reason: "MERGE_CONFLICT", conflictedFiles }`.
 * 4. Creates 2-parent merge commit `C_candidate` via `git commit-tree -p <B_base> -p <C_agent>` and pins `candidateRef`.
 * 5. Verifies `git rev-parse <C_candidate>^{tree}` equals `verifiedTreeHash`.
 * 6. Optionally exports immutable `.tar` snapshot via `git archive` (no `.git`, `0o444`, SHA-256).
 */
export function buildRealGitMergeCandidate(
  input: BuildMergeCandidateInput
): BuildMergeCandidateResult {
  const mainRef = input.mainRef ?? "refs/heads/main";
  const gitEnv = buildGitEnv(input.gitDir);
  const git = (args: string[], stdinText?: string): string =>
    execFileSync("git", args, {
      cwd: input.repoPath,
      env: gitEnv,
      encoding: "utf8",
      stdio: stdinText !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: stdinText,
      timeout: 15_000,
    }).trim();

  const baseMainCommitHash = git(["rev-parse", "--verify", `${mainRef}^{commit}`]);
  if (
    input.expectedBaseMainCommitHash !== undefined &&
    baseMainCommitHash !== input.expectedBaseMainCommitHash
  ) {
    throw new Error(
      `Base main commit mismatch: ${mainRef} is at ${baseMainCommitHash}, expected ${input.expectedBaseMainCommitHash}`
    );
  }

  // Ensure agent commit exists as a commit object
  git(["cat-file", "-e", `${input.agentCommitHash}^{commit}`]);

  const mergeTreeResult = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", "-z", baseMainCommitHash, input.agentCommitHash],
    {
      cwd: input.repoPath,
      env: gitEnv,
      encoding: "utf8",
      timeout: 20_000,
    }
  );

  if (mergeTreeResult.status === 1) {
    const parsed = parseMergeTreeZOutput(mergeTreeResult.stdout ?? "");
    return {
      ok: false,
      reason: "MERGE_CONFLICT",
      baseMainCommitHash,
      agentCommitHash: input.agentCommitHash,
      conflictedFiles: parsed.conflictedFiles,
      conflictSummary:
        parsed.conflictSummary ||
        `Git merge conflict merging ${input.agentCommitHash} onto ${baseMainCommitHash}`,
    };
  }

  if (mergeTreeResult.status !== 0) {
    throw new Error(
      `git merge-tree failed with status ${String(mergeTreeResult.status)}: ${
        mergeTreeResult.stderr ?? ""
      }`
    );
  }

  const parsedClean = parseMergeTreeZOutput(mergeTreeResult.stdout ?? "");
  const verifiedTreeHash = parsedClean.treeHash;
  if (!/^[0-9a-f]{40,64}$/.test(verifiedTreeHash)) {
    throw new Error(`Unexpected git merge-tree output tree hash: "${verifiedTreeHash}"`);
  }

  const commitMessage = [
    `chore(factory): build merge candidate for task ${input.taskId}`,
    "",
    `Base-Main: ${baseMainCommitHash}`,
    `Agent-Commit: ${input.agentCommitHash}`,
    `Verified-Tree: ${verifiedTreeHash}`,
  ].join("\n");

  const mergeCandidateHash = git(
    [
      "commit-tree",
      verifiedTreeHash,
      "-p",
      baseMainCommitHash,
      "-p",
      input.agentCommitHash,
    ],
    `${commitMessage}\n`
  );

  const actualCandidateTree = git(["rev-parse", "--verify", `${mergeCandidateHash}^{tree}`]);
  if (actualCandidateTree !== verifiedTreeHash) {
    throw new Error(
      `Verified tree hash mismatch on created candidate ${mergeCandidateHash}: expected ${verifiedTreeHash}, got ${actualCandidateTree}`
    );
  }

  const candidateRef = input.candidateRef ?? `refs/factory/candidates/${input.taskId}`;
  git(["update-ref", candidateRef, mergeCandidateHash]);

  let snapshotInfo: SnapshotManifest | undefined;
  if (input.snapshotStore) {
    snapshotInfo = input.snapshotStore.exportFromGitCommit({
      repoPath: input.repoPath,
      gitDir: input.gitDir,
      mergeCandidateHash,
      verifiedTreeHash,
      createdAt: input.createdAt,
    });
  }

  return {
    ok: true,
    baseMainCommitHash,
    agentCommitHash: input.agentCommitHash,
    mergeCandidateHash,
    verifiedTreeHash,
    candidateRef,
    ...(snapshotInfo
      ? {
          snapshotPath: snapshotInfo.snapshotPath,
          snapshotSha256: snapshotInfo.snapshotSha256,
          snapshotSizeBytes: snapshotInfo.snapshotSizeBytes,
          snapshotRetentionClass: snapshotInfo.retentionClass,
        }
      : {}),
  };
}
