import { execFileSync } from "node:child_process";

export interface TaskContractSpec {
  readonly allowed_files: readonly string[];
  readonly protected_paths?: readonly string[];
  readonly forbidden_paths?: readonly string[];
  readonly trusted_policy_sha256?: string;
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
  readonly tree_entries?: readonly { readonly path: string; readonly mode: string }[];
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
        | "ERR_IMPORT_EMPTY_CHANGES"
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
  if (!input.changes || input.changes.length === 0) {
    return {
      valid: false,
      error_code: "ERR_IMPORT_EMPTY_CHANGES",
      message: "Import candidate must include at least one changed file; empty changes are rejected",
    };
  }

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

  const wholeTreePaths = new Set<string>();
  for (const entry of input.tree_entries ?? []) {
    // Modes are checked on changed entries below; inherited baseline symlinks
    // remain subject to the verifier's structured snapshot rejection.
    if (!isSafeRelativePosixPath(entry.path) || wholeTreePaths.has(entry.path.toLowerCase())) return { valid: false, error_code: "ERR_IMPORT_PATH_TRAVERSAL_OR_COLLISION", message: "Unsafe or case-colliding Git tree path", offending_path: entry.path };
    wholeTreePaths.add(entry.path.toLowerCase());
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

export function inspectRealGitCommitForImport(options: {
  repoPath: string;
  expectedBaseMainCommitHash: string;
  agentCommitHash: string;
  contract: TaskContractSpec;
  gitDir?: string;
  gitObjectDirectory?: string;
  gitAlternateObjectDirectories?: string;
  gitEnvironment?: NodeJS.ProcessEnv;
}): GitTreeImportCandidateInput {
  if (!/^[0-9a-f]{40}$/i.test(options.agentCommitHash) || !/^[0-9a-f]{40}$/i.test(options.expectedBaseMainCommitHash)) {
    throw new Error("ERR_IMPORT_INVALID_COMMIT_HASH");
  }
  const gitEnv: NodeJS.ProcessEnv = { ...(options.gitEnvironment ?? process.env), GIT_NO_REPLACE_OBJECTS: "1" };
  if (options.gitDir) gitEnv.GIT_DIR = options.gitDir;
  if (options.gitObjectDirectory) gitEnv.GIT_OBJECT_DIRECTORY = options.gitObjectDirectory;
  if (options.gitAlternateObjectDirectories) gitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES = options.gitAlternateObjectDirectories;
  const git = (args: string[], input?: string): string => new TextDecoder("utf-8", { fatal: true }).decode(execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: options.repoPath, env: gitEnv, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    stdio: input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], input,
  }));
  const parentCommitHashes = git(["rev-list", "--parents", "-n", "1", options.agentCommitHash]).trim().split(/\s+/).slice(1);
  const verifiedTreeHash = git(["rev-parse", `${options.agentCommitHash}^{tree}`]).trim();
  const numstat = git(["diff-tree", "--no-commit-id", "-r", "-M", "--no-ext-diff", "--no-textconv", "--numstat", "-z",
    options.expectedBaseMainCommitHash, options.agentCommitHash]).split("\0");
  const stats = new Map<string, { added: number; deleted: number; binary: boolean }>();
  for (let i = 0; i < numstat.length; i++) {
    const token = numstat[i]!;
    if (!token) continue;
    const firstTab = token.indexOf("\t"); const secondTab = token.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("ERR_IMPORT_INVALID_NUMSTAT");
    const added = token.slice(0, firstTab); const deleted = token.slice(firstTab + 1, secondTab);
    const stat = { added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted), binary: added === "-" || deleted === "-" };
    const target = token.slice(secondTab + 1);
    if (target) stats.set(target, stat);
    else { stats.set(numstat[++i]!, stat); stats.set(numstat[++i]!, stat); }
  }
  const raw = git(["diff-tree", "--no-commit-id", "-r", "-M", "--no-ext-diff", "--no-textconv", "--raw", "--no-abbrev", "-z",
    options.expectedBaseMainCommitHash, options.agentCommitHash]).split("\0");
  const changes: GitTreeChangeEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!raw[i]) continue;
    const meta = raw[i]!.replace(/^:/, "").split(" ");
    const oldMode = meta[0]!; const newMode = meta[1]!; const blob = meta[3]!; const status = meta[4]!;
    const source = raw[++i]!;
    const renamed = status.startsWith("R") || status.startsWith("C");
    const target = renamed ? raw[++i]! : source;
    const stat = stats.get(target) ?? stats.get(source) ?? { added: 0, deleted: 0, binary: false };
    const size = newMode === "000000" || newMode === "160000" ? 0 : Number(git(["cat-file", "-s", blob]).trim());
    changes.push({ path: target, ...(renamed ? { old_path: source } : {}), mode: newMode === "000000" ? oldMode : newMode,
      size_bytes: size, is_binary: stat.binary, added_lines: stat.added, deleted_lines: stat.deleted, blob_sha: blob });
  }
  const treeEntries = git(["ls-tree", "-r", "-z", options.agentCommitHash]).split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("ERR_IMPORT_INVALID_TREE_ENTRY");
    return { mode: entry.slice(0, tab).split(" ")[0]!, path: entry.slice(tab + 1) };
  });
  return { agent_commit_hash: options.agentCommitHash, verified_tree_hash: verifiedTreeHash,
    parent_commit_hashes: parentCommitHashes, expected_base_main_commit_hash: options.expectedBaseMainCommitHash,
    changes, tree_entries: treeEntries, contract: options.contract };
}

export interface GlobIntersectionResult {
  readonly intersects: boolean;
  readonly witnessPath?: string;
}

export interface TaskAllowedFilesIntersectionDetail {
  readonly patternA: string;
  readonly patternB: string;
  readonly witnessPath: string;
}

export interface TaskAllowedFilesIntersectionResult {
  readonly intersects: boolean;
  readonly details: readonly TaskAllowedFilesIntersectionDetail[];
}

interface GlobNfaEdge {
  readonly kind: "ANY" | "NON_SLASH" | "LITERAL";
  readonly ch?: string;
  readonly target: number;
}

interface CompiledGlobNfa {
  readonly acceptState: number;
  readonly numStates: number;
  readonly epsilons: readonly number[][];
  readonly edges: readonly GlobNfaEdge[][];
  readonly literals: readonly string[];
}

function compileGlobPatternToNfa(globPattern: string): CompiledGlobNfa {
  const normalized = globPattern.replace(/\\/g, "/").replace(/^\/+/, "");
  const epsilons: number[][] = [];
  const edges: GlobNfaEdge[][] = [];
  const literalSet = new Set<string>();

  const addState = (): number => {
    const id = epsilons.length;
    epsilons.push([]);
    edges.push([]);
    return id;
  };

  let cur = addState();
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          // `(?:.+/)?`
          const p1 = addState();
          const p2 = addState();
          const next = addState();
          epsilons[cur]!.push(next);
          epsilons[cur]!.push(p1);
          edges[p1]!.push({ kind: "ANY", target: p2 });
          edges[p2]!.push({ kind: "ANY", target: p2 });
          edges[p2]!.push({ kind: "LITERAL", ch: "/", target: next });
          cur = next;
          i += 3;
          continue;
        }
        // `.*`
        const next = addState();
        edges[cur]!.push({ kind: "ANY", target: cur });
        epsilons[cur]!.push(next);
        cur = next;
        i += 2;
        continue;
      }
      // `[^/]*`
      const next = addState();
      edges[cur]!.push({ kind: "NON_SLASH", target: cur });
      epsilons[cur]!.push(next);
      cur = next;
      i += 1;
      continue;
    }
    if (ch === "?") {
      // `[^/]`
      const next = addState();
      edges[cur]!.push({ kind: "NON_SLASH", target: next });
      cur = next;
      i += 1;
      continue;
    }
    const next = addState();
    edges[cur]!.push({ kind: "LITERAL", ch, target: next });
    if (ch !== "/") {
      literalSet.add(ch);
    }
    cur = next;
    i += 1;
  }

  return {
    acceptState: cur,
    numStates: epsilons.length,
    epsilons,
    edges,
    literals: [...literalSet],
  };
}

function computeEpsilonClosure(nfa: CompiledGlobNfa): number[][] {
  const closures: number[][] = [];
  for (let start = 0; start < nfa.numStates; start += 1) {
    const seen = new Set<number>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const s = stack.pop()!;
      for (const next of nfa.epsilons[s]!) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    closures.push([...seen]);
  }
  return closures;
}

const SEG_START = 0;
const SEG_DOT1 = 1;
const SEG_DOT2 = 2;
const SEG_OK = 3;

function stepSafePathSegDfa(segState: number, ch: string): number {
  if (ch === "/") {
    return segState === SEG_OK ? SEG_START : -1;
  }
  if (ch === ".") {
    if (segState === SEG_START) return SEG_DOT1;
    if (segState === SEG_DOT1) return SEG_DOT2;
    return SEG_OK;
  }
  return SEG_OK;
}

function chooseWildcardRepresentativeChars(excludedLiterals: Set<string>): string[] {
  const candidates = "xabcdefyzghijklmnopqrstuvw0123456789_-";
  const picks: string[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const ch = candidates[i]!;
    if (!excludedLiterals.has(ch) && ch !== "/" && ch !== "." && ch !== "*" && ch !== "?") {
      picks.push(ch);
      if (picks.length >= 2) {
        return picks;
      }
    }
  }
  for (let code = 0x20; code <= 0xffff && picks.length < 2; code += 1) {
    const ch = String.fromCharCode(code);
    if (code !== 0x7f && ch !== "\\" && ch !== "/" && ch !== "." && !excludedLiterals.has(ch)) {
      picks.push(ch);
    }
  }
  return picks.length > 0 ? picks : ["x"];
}

function extractLiteralsFromPatterns(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const pat of patterns) {
    const normalized = pat.replace(/\\/g, "/").replace(/^\/+/, "");
    for (let i = 0; i < normalized.length; i += 1) {
      const ch = normalized[i]!;
      if (ch !== "*" && ch !== "?" && ch !== "/" && ch !== "\\") {
        const code = ch.charCodeAt(0);
        if (code > 0x1f && code !== 0x7f) {
          out.add(ch);
        }
      }
    }
  }
  return [...out];
}

interface ExcludedGlobPattern {
  readonly pattern: string;
  readonly caseInsensitive: boolean;
}

export class GlobIntersectionComplexityError extends Error {
  public readonly code = "ERR_GLOB_INTERSECTION_COMPLEXITY";
  constructor() {
    super("ERR_GLOB_INTERSECTION_COMPLEXITY: refusing unsafe dispatch");
    this.name = "GlobIntersectionComplexityError";
  }
}

function findGlobIntersectionWitness(
  patternA: string,
  patternB: string,
  excludedPatterns: readonly ExcludedGlobPattern[] = []
): string | null {
  // Determinize *all* languages in the search state. Tracking only allowed NFA
  // states and rejecting one witness afterwards loses valid alternate paths.
  const machines = [patternA, patternB, ...excludedPatterns.map((p) => p.pattern)].map(compileGlobPatternToNfa);
  const closures = machines.map(computeEpsilonClosure);
  const insensitive = [false, false, ...excludedPatterns.map((p) => p.caseInsensitive)];
  const literals = new Set<string>(extractLiteralsFromPatterns([
    patternA, patternB, ...excludedPatterns.map((p) => p.pattern),
  ]));
  for (const literal of [...literals]) {
    if (literal.toUpperCase().length === 1) literals.add(literal.toUpperCase());
    if (literal.toLowerCase().length === 1) literals.add(literal.toLowerCase());
  }
  const alphabet = [...new Set([...chooseWildcardRepresentativeChars(literals), ...literals, "/", "."])]
    .filter((ch) => ch !== "\\" && ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f);
  const literalRegexes = new Map<string, RegExp>();
  const caseMatches = (literal: string, ch: string): boolean => {
    let regex = literalRegexes.get(literal);
    if (!regex) {
      regex = new RegExp(`^${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      literalRegexes.set(literal, regex);
    }
    return regex.test(ch);
  };
  const transitionCaches = machines.map(() => new Map<string, number[]>());
  const step = (machineIndex: number, states: readonly number[], ch: string): number[] => {
    const cacheKey = `${states.join(",")}:${ch}`;
    const cached = transitionCaches[machineIndex]!.get(cacheKey);
    if (cached) return cached;
    const nfa = machines[machineIndex]!;
    const next = new Set<number>();
    for (const state of states) for (const edge of nfa.edges[state]!) {
      const matches = edge.kind === "ANY" ? !["\n", "\r", "\u2028", "\u2029"].includes(ch)
        : edge.kind === "NON_SLASH" ? ch !== "/"
          : edge.ch === ch || (insensitive[machineIndex] && caseMatches(edge.ch!, ch));
      if (matches) for (const target of closures[machineIndex]![edge.target]!) next.add(target);
    }
    const result = [...next].sort((a, b) => a - b);
    transitionCaches[machineIndex]!.set(cacheKey, result);
    return result;
  };
  interface SearchState { readonly states: readonly number[][]; readonly segment: number; readonly parent: number; readonly ch: string }
  const initial: SearchState = { states: closures.map((closure) => [...closure[0]!].sort((a, b) => a - b)), segment: SEG_START, parent: -1, ch: "" };
  const queue: SearchState[] = [initial];
  const keyOf = (states: readonly number[][], segment: number) => `${segment}|${states.map((set) => set.join(",")).join("|")}`;
  const visited = new Set([keyOf(initial.states, initial.segment)]);
  const reconstruct = (index: number): string => {
    const chars: string[] = [];
    while (index >= 0) { const node = queue[index]!; chars.push(node.ch); index = node.parent; }
    return chars.reverse().join("");
  };
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    if (current.segment === SEG_OK && current.states[0]!.includes(machines[0]!.acceptState) &&
      current.states[1]!.includes(machines[1]!.acceptState) &&
      !current.states.slice(2).some((states, i) => states.includes(machines[i + 2]!.acceptState))) {
      return reconstruct(head);
    }
    for (const ch of alphabet) {
      const segment = stepSafePathSegDfa(current.segment, ch);
      if (segment < 0) continue;
      const a = step(0, current.states[0]!, ch);
      if (!a.length) continue;
      const b = step(1, current.states[1]!, ch);
      if (!b.length) continue;
      const states = [a, b, ...current.states.slice(2).map((set, i) => step(i + 2, set, ch))];
      const key = keyOf(states, segment);
      if (visited.has(key)) continue;
      // An adversarially complex glob must deny dispatch, never be classified disjoint.
      if (queue.length >= 50_000) throw new GlobIntersectionComplexityError();
      visited.add(key);
      queue.push({ states, segment, parent: head, ch });
    }
  }
  return null;
}

/**
 * Sound NFA-product intersection check between two POSIX glob patterns matching
 * `globToRegExp(..., false)` semantics over valid safe relative POSIX paths.
 */
export function doGlobPatternsIntersect(
  patternA: string,
  patternB: string
): GlobIntersectionResult {
  const witness = findGlobIntersectionWitness(patternA, patternB);
  if (witness === null) {
    return { intersects: false };
  }
  return {
    intersects: true,
    witnessPath: witness,
  };
}

/**
 * Sound overlap check between two `TaskContractSpec` instances. Returns all overlapping
 * `(patternA, patternB)` pairs whose intersecting paths are permitted by both contracts'
 * path precedence rules (not blocked by `forbidden_paths` or `protected_paths`).
 */
export function doTaskAllowedFilesIntersect(
  contractA: TaskContractSpec,
  contractB: TaskContractSpec
): TaskAllowedFilesIntersectionResult {
  const extraProtectedAndForbidden: ExcludedGlobPattern[] = [
    ...[...DEFAULT_SYSTEM_FORBIDDEN_PATHS, ...(contractA.forbidden_paths ?? []), ...(contractB.forbidden_paths ?? [])]
      .map((pattern) => ({ pattern, caseInsensitive: true })),
    ...[...(contractA.protected_paths ?? []), ...(contractB.protected_paths ?? [])]
      .map((pattern) => ({ pattern, caseInsensitive: false })),
  ];
  const details: TaskAllowedFilesIntersectionDetail[] = [];

  for (const patternA of contractA.allowed_files) {
    for (const patternB of contractB.allowed_files) {
      const witness = findGlobIntersectionWitness(
        patternA,
        patternB,
        extraProtectedAndForbidden
      );
      if (witness !== null) {
        details.push({
          patternA,
          patternB,
          witnessPath: witness,
        });
      }
    }
  }

  return {
    intersects: details.length > 0,
    details,
  };
}

export * from "./code-import.ts";
