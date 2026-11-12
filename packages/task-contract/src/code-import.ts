import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJson, sha256Hex } from "@software-factory/shared-types";
import { inspectRealGitCommitForImport, isSafeRelativePosixPath, validateGitTreeImport,
  type GitTreeImportCandidateInput, type TaskContractSpec } from "./index.ts";

export type CodeImportSubmission =
  | { readonly kind: "bundle"; readonly bundle_base64: string; readonly agent_commit_hash: string }
  | { readonly kind: "patch"; readonly patch: string }
  | { readonly kind: "artifact"; readonly files: readonly ArtifactFileSubmission[] };
export type ArtifactFileSubmission =
  | { readonly action: "write"; readonly path: string; readonly content_base64: string; readonly mode?: "100644" | "100755" }
  | { readonly action: "delete"; readonly path: string };

export class CodeImportError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 422) {
    super(message); this.name = "CodeImportError"; this.code = code; this.httpStatus = httpStatus;
  }
}

const MAX_SUBMISSION_BYTES = 2 * 1024 * 1024;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Expected an object containing only supported submission fields", 400);
  }
  return value as Record<string, unknown>;
}
function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_SUBMISSION_BYTES / 3) * 4 ||
    value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new CodeImportError("ERR_IMPORT_INVALID_ENCODING", "Payload must be canonical base64 within the 2 MiB decoded limit", 400);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_SUBMISSION_BYTES) throw new CodeImportError("ERR_IMPORT_SIZE_LIMIT", "Payload exceeds 2 MiB decoded limit", 413);
  if (bytes.toString("base64") !== value) throw new CodeImportError("ERR_IMPORT_INVALID_ENCODING", "Non-canonical base64", 400);
  return bytes;
}
export function validateCodeImportSubmission(raw: unknown): CodeImportSubmission {
  const input = object(raw, ["kind", "bundle_base64", "agent_commit_hash", "patch", "files"]);
  if (input.kind === "bundle") {
    object(input, ["kind", "bundle_base64", "agent_commit_hash"]);
    if (!decodeBase64(input.bundle_base64).length || typeof input.agent_commit_hash !== "string" || !/^[0-9a-f]{40}$/.test(input.agent_commit_hash))
      throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Bundle requires non-empty bytes and a lowercase 40-hex commit", 400);
    return { kind: "bundle", bundle_base64: input.bundle_base64 as string, agent_commit_hash: input.agent_commit_hash };
  }
  if (input.kind === "patch") {
    object(input, ["kind", "patch"]);
    if (typeof input.patch !== "string" || !input.patch.trim() || Buffer.byteLength(input.patch) > MAX_SUBMISSION_BYTES)
      throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Patch must be non-empty UTF-8 text within 2 MiB", 400);
    return { kind: "patch", patch: input.patch };
  }
  if (input.kind === "artifact") {
    object(input, ["kind", "files"]);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 256)
      throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Artifact requires 1–256 explicit file operations", 400);
    let totalBytes = 0;
    const seen = new Set<string>();
    const files = input.files.map((rawFile): ArtifactFileSubmission => {
      const file = object(rawFile, ["action", "path", "content_base64", "mode"]);
      if (typeof file.path !== "string" || !isSafeRelativePosixPath(file.path) || seen.has(file.path.toLowerCase()))
        throw new CodeImportError("ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION", "Unsafe or duplicate artifact path");
      seen.add(file.path.toLowerCase());
      if (file.action === "delete") { object(file, ["action", "path"]); return { action: "delete", path: file.path }; }
      if (file.action !== "write") throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Unknown artifact operation", 400);
      if (file.mode !== undefined && file.mode !== "100644" && file.mode !== "100755")
        throw new CodeImportError("ERR_IMPORT_FORBIDDEN_GIT_MODE", "Artifacts may only write regular files");
      totalBytes += decodeBase64(file.content_base64).length;
      if (totalBytes > MAX_SUBMISSION_BYTES) throw new CodeImportError("ERR_IMPORT_SIZE_LIMIT", "Artifact exceeds 2 MiB decoded limit", 413);
      return { action: "write", path: file.path, content_base64: file.content_base64 as string,
        ...(file.mode !== undefined ? { mode: file.mode } : {}) };
    });
    return { kind: "artifact", files };
  }
  throw new CodeImportError("ERR_IMPORT_INVALID_SUBMISSION", "Import kind must be bundle, patch or artifact", 400);
}

export function codeImportPayloadSha256(submission: CodeImportSubmission): string {
  return sha256Hex(canonicalizeJson(submission));
}

/** No caller environment, hooks, network transport, checkout or external diff driver. */
export function codeImportGitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}
function runGit(repoPath: string, args: readonly string[], env: NodeJS.ProcessEnv, input?: string | Buffer): string {
  try {
    const out = execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null",
      "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "transfer.fsckObjects=true",
      ...args], { cwd: repoPath, env, input, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    return new TextDecoder("utf-8", { fatal: true }).decode(out);
  } catch {
    throw new CodeImportError("ERR_IMPORT_GIT_REJECTED", `Git rejected import operation '${args[0] ?? "unknown"}'`);
  }
}
export interface PreparedCodeImport {
  readonly quarantinePath: string;
  readonly candidate: GitTreeImportCandidateInput;
  readonly payloadSha256: string;
  readonly sourceType: CodeImportSubmission["kind"];
  copyObjectsTo(repoPath: string): void;
  dispose(): void;
}

/** Normalize all additional import transports into one isolated commit and the shared six-step validator. */
export function prepareCodeImport(input: {
  repoPath: string; baseCommitHash: string; taskId: string; leaseEpoch: number;
  contract: TaskContractSpec; submission: CodeImportSubmission;
}): PreparedCodeImport {
  const submission = validateCodeImportSubmission(input.submission);
  if (!/^[0-9a-f]{40}$/.test(input.baseCommitHash)) throw new CodeImportError("ERR_IMPORT_INVALID_BASE", "Invalid task base commit");
  const payloadSha256 = codeImportPayloadSha256(submission);
  const root = mkdtempSync(join(tmpdir(), "sf-code-import-"));
  const env = { ...codeImportGitEnvironment(), GIT_INDEX_FILE: join(root, "candidate.index") };
  try {
    runGit(root, ["init", "--bare", "--object-format=sha1", "repository.git"], env);
    const repo = join(root, "repository.git");
    runGit(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", input.repoPath, input.baseCommitHash], env);
    let commit: string;
    if (submission.kind === "bundle") {
      const bundlePath = join(root, "submission.bundle");
      writeFileSync(bundlePath, decodeBase64(submission.bundle_base64), { mode: 0o600 });
      const heads = runGit(repo, ["bundle", "list-heads", bundlePath], env).trim().split(/\r?\n/);
      if (heads.length !== 1 || !heads[0]!.startsWith(`${submission.agent_commit_hash} refs/heads/`))
        throw new CodeImportError("ERR_IMPORT_BUNDLE_HEAD_MISMATCH", "Bundle must advertise exactly one branch matching the submitted commit");
      runGit(repo, ["bundle", "verify", bundlePath], env);
      runGit(repo, ["bundle", "unbundle", bundlePath], env);
      commit = submission.agent_commit_hash;
    } else {
      runGit(repo, ["read-tree", input.baseCommitHash], env);
      if (submission.kind === "patch") {
        runGit(repo, ["apply", "--cached", "--check", "--whitespace=nowarn", "-"], env, submission.patch);
        runGit(repo, ["apply", "--cached", "--whitespace=nowarn", "-"], env, submission.patch);
      } else {
        for (const file of submission.files) {
          if (file.action === "delete") {
            runGit(repo, ["update-index", "-z", "--index-info"], env, `0 ${"0".repeat(40)}\t${file.path}\0`);
          } else {
            const blob = runGit(repo, ["hash-object", "-w", "--stdin"], env, decodeBase64(file.content_base64)).trim();
            runGit(repo, ["update-index", "-z", "--index-info"], env, `${file.mode ?? "100644"} ${blob}\t${file.path}\0`);
          }
        }
      }
      const tree = runGit(repo, ["write-tree"], env).trim();
      const timestamp = Number(runGit(repo, ["show", "-s", "--format=%ct", input.baseCommitHash], env).trim()) + 1;
      const commitEnv = { ...env, GIT_AUTHOR_NAME: "Software Factory Import", GIT_AUTHOR_EMAIL: "import@software-factory.local",
        GIT_COMMITTER_NAME: "Software Factory Import", GIT_COMMITTER_EMAIL: "import@software-factory.local",
        GIT_AUTHOR_DATE: `@${timestamp} +0000`, GIT_COMMITTER_DATE: `@${timestamp} +0000` };
      commit = runGit(repo, ["commit-tree", tree, "-p", input.baseCommitHash], commitEnv,
        `sf import ${submission.kind}: ${input.taskId} epoch ${input.leaseEpoch}\n\nSubmission-SHA256: ${payloadSha256}\n`).trim();
    }
    const candidate = inspectRealGitCommitForImport({ repoPath: repo, agentCommitHash: commit,
      expectedBaseMainCommitHash: input.baseCommitHash, contract: input.contract, gitEnvironment: env });
    const validation = validateGitTreeImport(candidate);
    if (!validation.valid) throw new CodeImportError(validation.error_code, validation.message);
    return { quarantinePath: repo, candidate, payloadSha256, sourceType: submission.kind,
      copyObjectsTo(repoPath) {
        runGit(repo, ["update-ref", "refs/heads/validated-import", commit], env);
        runGit(repoPath, ["fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", repo, "refs/heads/validated-import"], codeImportGitEnvironment());
      },
      dispose() { rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
