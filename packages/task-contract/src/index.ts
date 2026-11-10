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
  ".github/workflows/**",
  ".env*",
  "**/*.pem",
  "**/*.key",
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
export function globToRegExp(globPattern: string): RegExp {
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
  return new RegExp(regexStr);
}

export function matchesAnyGlob(
  relativePath: string,
  patterns: readonly string[]
): string | null {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(relativePath)) {
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
  const matchedForbidden = matchesAnyGlob(relativePath, forbiddenList);
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
 * 6-Step TrustedImportValidator (MVP-SPEC-03 Section 5.2)
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

    // Step 4: Precedence-Based Path Policy Enforcement
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
