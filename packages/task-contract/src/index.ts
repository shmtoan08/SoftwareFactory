import { execFileSync } from "node:child_process";

export interface TaskContractSpec {
  readonly allowed_files: readonly string[];
  readonly protected_paths?: readonly string[];
  readonly forbidden_paths?: readonly string[];
  readonly max_changed_files?: number;
  readonly max_deleted_lines?: number;
  readonly max_binary_bytes?: number;
  readonly allow_binary_files?: boolean;
}

export const DEFAULT_SYSTEM_FORBIDDEN_PATHS: readonly string[] = [
  ".git/**",
  "**/.git/**",
  ".gitmodules",
  "**/.gitmodules",
  ".gitattributes",
  "**/.gitattributes",
  ".githooks/**",
  "**/.githooks/**",
  ".github/workflows/**",
  "**/.github/workflows/**",
  ".env*",
  "**/.env*",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/*id_rsa*",
];

export const DEFAULT_MAX_CHANGED_FILES = 25;
export const DEFAULT_MAX_DELETED_LINES = 500;
export const DEFAULT_MAX_BLOB_BYTES = 1_048_576; // 1 MB

export type PathPolicyVerdict =
  | { readonly allowed: true; readonly matchedRule: string }
  | {
      readonly allowed: false;
      readonly reason:
        | "FORBIDDEN_PATH"
        | "PROTECTED_PATH"
        | "DEFAULT_DENY_NOT_IN_ALLOWED_FILES"
        | "PATH_TRAVERSAL_OR_INVALID_FORMAT";
      readonly matchedRule?: string;
    };

/**
 * Converts a POSIX glob pattern (supporting `**`, `*`, `?`) to a strict RegExp.
 */
export function globToRegExp(globPattern: string, caseInsensitive = false): RegExp {
  const normalized = globPattern.replace(/\\/g, "/").replace(/^\/+/, "");
  let regexStr = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.+/)?";
          i += 3;
          continue;
        }
        regexStr += ".*";
        i += 2;
        continue;
      }
      regexStr += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
      continue;
    }
    if (".+^$()[]{}|\\".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }
  regexStr += "$";
  return new RegExp(regexStr, caseInsensitive ? "i" : undefined);
}

export function matchesAnyGlob(
  relativePath: string,
  patterns: readonly string[],
  caseInsensitive = false
): string | null {
  for (const pattern of patterns) {
    if (globToRegExp(pattern, caseInsensitive).test(relativePath)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Validates that a relative path has no `..` traversal, leading `/`, NUL bytes, or ASCII control chars.
 */
export function isSafeRelativePosixPath(pathStr: string): boolean {
  if (!pathStr || pathStr.startsWith("/") || pathStr.includes("\\")) {
    return false;
  }
  // Reject NUL or ASCII control chars (0x00 - 0x1F, 0x7F)
  for (let i = 0; i < pathStr.length; i++) {
    const code = pathStr.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  const segments = pathStr.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      return false;
    }
  }
  return true;
}

/**
 * Evaluates Path Policy Precedence:
 * forbidden_paths > protected_paths > allowed_files > Default Deny
 * (MVP-SPEC-03 Section 5.2 Step 4)
 */
export function evaluatePathPolicyPrecedence(
  relativePath: string,
  contract: TaskContractSpec
): PathPolicyVerdict {
  if (!isSafeRelativePosixPath(relativePath)) {
    return {
      allowed: false,
      reason: "PATH_TRAVERSAL_OR_INVALID_FORMAT",
    };
  }

  const forbiddenList = [
    ...DEFAULT_SYSTEM_FORBIDDEN_PATHS,
    ...(contract.forbidden_paths ?? []),
  ];
  // Match forbidden paths case-insensitively to prevent extension/case evasion (e.g. .PEM, .KEY, .Env)
  const matchedForbidden = matchesAnyGlob(relativePath, forbiddenList, true);
  if (matchedForbidden !== null) {
    return {
      allowed: false,
      reason: "FORBIDDEN_PATH",
      matchedRule: matchedForbidden,
    };
  }

  const protectedList = contract.protected_paths ?? [];
  const matchedProtected = matchesAnyGlob(relativePath, protectedList);
  if (matchedProtected !== null) {
    return {
      allowed: false,
      reason: "PROTECTED_PATH",
      matchedRule: matchedProtected,
    };
  }

  const matchedAllowed = matchesAnyGlob(relativePath, contract.allowed_files);
  if (matchedAllowed !== null) {
    return {
      allowed: true,
      matchedRule: matchedAllowed,
    };
  }

  return {
    allowed: false,
    reason: "DEFAULT_DENY_NOT_IN_ALLOWED_FILES",
  };
}

export type GitObjectMode = "100644" | "100755" | "120000" | "160000" | string;

export interface GitTreeChangeEntry {
  readonly path: string;
  readonly old_path?: string;
  readonly mode: GitObjectMode;
  readonly size_bytes: number;
  readonly is_binary: boolean;
  readonly added_lines: number;
  readonly deleted_lines: number;
  readonly blob_sha: string;
}

export interface GitTreeImportCandidateInput {
  readonly agent_commit_hash: string;
  readonly verified_tree_hash: string;
  readonly parent_commit_hashes: readonly string[];
  readonly expected_base_main_commit_hash: string;
  readonly changes: readonly GitTreeChangeEntry[];
  readonly contract: TaskContractSpec;
}

export type TrustedImportValidationResult =
  | {
      readonly valid: true;
      readonly agent_commit_hash: string;
      readonly verified_tree_hash: string;
      readonly changed_files_count: number;
      readonly deleted_lines_count: number;
    }
  | {
      readonly valid: false;
      readonly error_code:
        | "ERR_IMPORT_LINEAGE_MISMATCH"
        | "ERR_IMPORT_FORBIDDEN_GIT_MODE"
        | "ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION"
        | "ERR_IMPORT_PATH_POLICY_VIOLATION"
        | "ERR_IMPORT_BINARY_OR_SIZE_LIMIT"
        | "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD";
      readonly message: string;
      readonly offending_path?: string;
    };

/**
 * 6-Step TrustedImportValidator (MVP-SPEC-03 Section 5.2 & Roadmap M2)
 */
export function validateGitTreeImport(
  input: GitTreeImportCandidateInput
): TrustedImportValidationResult {
  // Step 1: Single-Parent Lineage Check
  if (
    input.parent_commit_hashes.length !== 1 ||
    input.parent_commit_hashes[0] !== input.expected_base_main_commit_hash
  ) {
    return {
      valid: false,
      error_code: "ERR_IMPORT_LINEAGE_MISMATCH",
      message: `Expected single parent ${input.expected_base_main_commit_hash}, got [${input.parent_commit_hashes.join(", ")}]`,
    };
  }

  const maxChangedFiles = input.contract.max_changed_files ?? DEFAULT_MAX_CHANGED_FILES;
  const maxDeletedLines = input.contract.max_deleted_lines ?? DEFAULT_MAX_DELETED_LINES;
  const maxBlobBytes = input.contract.max_binary_bytes ?? DEFAULT_MAX_BLOB_BYTES;
  const allowBinary = input.contract.allow_binary_files ?? false;

  const lowerCasePaths = new Set<string>();
  let totalDeletedLines = 0;

  for (const entry of input.changes) {
    // Step 2: Git Object Mode & Symlink / Submodule Rejection
    if (entry.mode === "120000" || entry.mode === "160000") {
      return {
        valid: false,
        error_code: "ERR_IMPORT_FORBIDDEN_GIT_MODE",
        message: `Forbidden Git object mode ${entry.mode} (symlink/submodule) at ${entry.path}`,
        offending_path: entry.path,
      };
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      return {
        valid: false,
        error_code: "ERR_IMPORT_FORBIDDEN_GIT_MODE",
        message: `Unsupported Git object mode ${entry.mode} at ${entry.path}`,
        offending_path: entry.path,
      };
    }

    // Step 3: Path Traversal, Control Character & Case-Folding Collision Guard
    if (!isSafeRelativePosixPath(entry.path)) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION",
        message: `Unsafe or non-canonical relative path: ${entry.path}`,
        offending_path: entry.path,
      };
    }
    if (entry.old_path !== undefined && !isSafeRelativePosixPath(entry.old_path)) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION",
        message: `Unsafe or non-canonical source path in rename/copy: ${entry.old_path}`,
        offending_path: entry.old_path,
      };
    }
    const folded = entry.path.toLowerCase();
    if (lowerCasePaths.has(folded)) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION",
        message: `Case-folding path collision detected for ${entry.path}`,
        offending_path: entry.path,
      };
    }
    lowerCasePaths.add(folded);

    // Step 4: Precedence-Based Path Policy Enforcement (on both destination path and source old_path)
    const policyVerdict = evaluatePathPolicyPrecedence(entry.path, input.contract);
    if (!policyVerdict.allowed) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_PATH_POLICY_VIOLATION",
        message: `Path policy rejected ${entry.path}: ${policyVerdict.reason}${
          policyVerdict.matchedRule ? ` (rule: ${policyVerdict.matchedRule})` : ""
        }`,
        offending_path: entry.path,
      };
    }
    if (entry.old_path !== undefined) {
      const oldPolicyVerdict = evaluatePathPolicyPrecedence(entry.old_path, input.contract);
      if (!oldPolicyVerdict.allowed) {
        return {
          valid: false,
          error_code: "ERR_IMPORT_PATH_POLICY_VIOLATION",
          message: `Path policy rejected rename/copy source ${entry.old_path}: ${oldPolicyVerdict.reason}${
            oldPolicyVerdict.matchedRule ? ` (rule: ${oldPolicyVerdict.matchedRule})` : ""
          }`,
          offending_path: entry.old_path,
        };
      }
    }

    // Step 5: Binary & Blob Size Guard
    if (entry.size_bytes > maxBlobBytes) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_BINARY_OR_SIZE_LIMIT",
        message: `Blob size ${entry.size_bytes} exceeds limit ${maxBlobBytes} at ${entry.path}`,
        offending_path: entry.path,
      };
    }
    if (entry.is_binary && !allowBinary) {
      return {
        valid: false,
        error_code: "ERR_IMPORT_BINARY_OR_SIZE_LIMIT",
        message: `Binary file not allowed by TaskContract at ${entry.path}`,
        offending_path: entry.path,
      };
    }

    totalDeletedLines += entry.deleted_lines;
  }

  // Step 6: Abnormal Diff Threshold Guard
  if (input.changes.length > maxChangedFiles) {
    return {
      valid: false,
      error_code: "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD",
      message: `Changed files count ${input.changes.length} exceeds max_changed_files (${maxChangedFiles})`,
    };
  }
  if (totalDeletedLines > maxDeletedLines) {
    return {
      valid: false,
      error_code: "ERR_IMPORT_ABNORMAL_DIFF_THRESHOLD",
      message: `Total deleted lines ${totalDeletedLines} exceeds max_deleted_lines (${maxDeletedLines})`,
    };
  }

  return {
    valid: true,
    agent_commit_hash: input.agent_commit_hash,
    verified_tree_hash: input.verified_tree_hash,
    changed_files_count: input.changes.length,
    deleted_lines_count: totalDeletedLines,
  };
}

function parseNumstatPath(rawPath: string): { oldPath?: string; newPath: string } {
  // Case 1: prefix{old => new}suffix or {old => new}
  const braceMatch = rawPath.match(/^(.*?)\{(.*?)\s*=>\s*(.*?)\}(.*)$/);
  if (braceMatch) {
    const prefix = braceMatch[1]!;
    const oldPart = braceMatch[2]!;
    const newPart = braceMatch[3]!;
    const suffix = braceMatch[4]!;
    return {
      oldPath: `${prefix}${oldPart}${suffix}`.replace(/\/+/g, "/").replace(/^\/+/, ""),
      newPath: `${prefix}${newPart}${suffix}`.replace(/\/+/g, "/").replace(/^\/+/, ""),
    };
  }
  // Case 2: old => new
  const arrowMatch = rawPath.match(/^(.*?)\s*=>\s*(.*?)$/);
  if (arrowMatch) {
    return {
      oldPath: arrowMatch[1]!.trim().replace(/^\/+/, ""),
      newPath: arrowMatch[2]!.trim().replace(/^\/+/, ""),
    };
  }
  return { newPath: rawPath.trim().replace(/^\/+/, "") };
}

/**
 * Inspects a real Git repository on disk (`git rev-list`, `git rev-parse`, `git diff-tree`)
 * and constructs a `GitTreeImportCandidateInput` for `validateGitTreeImport` (Milestone M2).
 */
export function inspectRealGitCommitForImport(options: {
  repoPath: string;
  expectedBaseMainCommitHash: string;
  agentCommitHash: string;
  contract: TaskContractSpec;
}): GitTreeImportCandidateInput {
  const git = (args: string[], inputStdin?: string): string =>
    execFileSync("git", args, {
      cwd: options.repoPath,
      encoding: "utf8",
      stdio: inputStdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      input: inputStdin,
      timeout: 10_000,
    }).trim();

  // 1. Extract commit + parents (`<commit> <parent1> ...`)
  const revListLine = git(["rev-list", "--parents", "-n", "1", options.agentCommitHash]);
  const parts = revListLine.split(/\s+/).filter(Boolean);
  const parentCommitHashes = parts.slice(1);

  // 2. Extract tree SHA
  const verifiedTreeHash = git(["rev-parse", `${options.agentCommitHash}^{tree}`]);

  // 3. Extract raw mode/blob changes (`git diff-tree --no-commit-id -r -M --raw`)
  const rawOutput = git([
    "diff-tree",
    "--no-commit-id",
    "-r",
    "-M",
    "--raw",
    options.expectedBaseMainCommitHash,
    options.agentCommitHash,
  ]);
  const numstatOutput = git([
    "diff-tree",
    "--no-commit-id",
    "-r",
    "-M",
    "--numstat",
    options.expectedBaseMainCommitHash,
    options.agentCommitHash,
  ]);

  const numstatByPath = new Map<string, { added: number; deleted: number; isBinary: boolean }>();
  for (const line of numstatOutput.split("\n").filter(Boolean)) {
    const cols = line.split("\t");
    if (cols.length >= 3) {
      const addedRaw = cols[0]!;
      const deletedRaw = cols[1]!;
      const rawPath = cols[cols.length - 1]!;
      const isBinary = addedRaw === "-" || deletedRaw === "-";
      const statObj = {
        added: isBinary ? 0 : Number.parseInt(addedRaw, 10) || 0,
        deleted: isBinary ? 0 : Number.parseInt(deletedRaw, 10) || 0,
        isBinary,
      };
      numstatByPath.set(rawPath, statObj);
      const parsed = parseNumstatPath(rawPath);
      numstatByPath.set(parsed.newPath, statObj);
      if (parsed.oldPath) {
        numstatByPath.set(parsed.oldPath, statObj);
      }
    }
  }

  // Pre-fetch all blob sizes in one batch with `git cat-file --batch-check`
  const rawLines = rawOutput.split("\n").filter(Boolean);
  const blobShasToQuery: string[] = [];
  for (const line of rawLines) {
    const [metaPart] = line.split("\t");
    if (!metaPart) continue;
    const metaTokens = metaPart.replace(/^:/, "").split(/\s+/);
    const newMode = metaTokens[1] ?? "100644";
    const newBlobSha = metaTokens[3] ?? "0000000000000000000000000000000000000000";
    if (newMode !== "000000" && newMode !== "160000" && !/^0+$/.test(newBlobSha)) {
      blobShasToQuery.push(newBlobSha);
    }
  }

  const blobSizeBySha = new Map<string, number>();
  if (blobShasToQuery.length > 0) {
    try {
      const batchCheckOut = git(["cat-file", "--batch-check"], blobShasToQuery.join("\n") + "\n");
      for (const line of batchCheckOut.split("\n").filter(Boolean)) {
        const tokens = line.split(" ");
        if (tokens.length >= 3) {
          const sha = tokens[0]!;
          const size = Number.parseInt(tokens[2]!, 10) || 0;
          blobSizeBySha.set(sha, size);
        }
      }
    } catch {
      // Fallback on single cat-file if batch-check fails
    }
  }

  const changes: GitTreeChangeEntry[] = [];
  for (const line of rawLines) {
    const [metaPart, ...pathParts] = line.split("\t");
    if (!metaPart || pathParts.length === 0) {
      continue;
    }
    const metaTokens = metaPart.replace(/^:/, "").split(/\s+/);
    const oldMode = metaTokens[0] ?? "100644";
    const newMode = metaTokens[1] ?? "100644";
    const newBlobSha = metaTokens[3] ?? "0000000000000000000000000000000000000000";
    const statusToken = metaTokens[4] ?? "M";

    const isRenameOrCopy = statusToken.startsWith("R") || statusToken.startsWith("C");
    const oldPath = isRenameOrCopy && pathParts.length >= 2 ? pathParts[0] : undefined;
    const targetPath = isRenameOrCopy && pathParts.length >= 2 ? pathParts[1]! : pathParts[0]!;

    const effectiveMode = newMode === "000000" ? oldMode : newMode;
    let sizeBytes = 0;
    if (newMode !== "000000" && newMode !== "160000" && !/^0+$/.test(newBlobSha)) {
      sizeBytes =
        blobSizeBySha.get(newBlobSha) ??
        (Number.parseInt(git(["cat-file", "-s", newBlobSha]), 10) || 0);
    }

    const stat =
      numstatByPath.get(targetPath) ??
      (oldPath ? numstatByPath.get(oldPath) : undefined) ??
      { added: 0, deleted: 0, isBinary: false };

    changes.push({
      path: targetPath,
      ...(oldPath !== undefined ? { old_path: oldPath } : {}),
      mode: effectiveMode,
      size_bytes: sizeBytes,
      is_binary: stat.isBinary,
      added_lines: stat.added,
      deleted_lines: stat.deleted,
      blob_sha: newBlobSha,
    });
  }

  return {
    agent_commit_hash: options.agentCommitHash,
    verified_tree_hash: verifiedTreeHash,
    parent_commit_hashes: parentCommitHashes,
    expected_base_main_commit_hash: options.expectedBaseMainCommitHash,
    changes,
    contract: options.contract,
  };
}

