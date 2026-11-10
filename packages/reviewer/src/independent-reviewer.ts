import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import ts from "typescript";
import {
  type Tier3AssertionEvidence,
  type VerificationRunRecord,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import {
  type TaskContractSpec,
  evaluatePathPolicyPrecedence,
  matchesAnyGlob,
} from "@software-factory/task-contract";
import {
  ImmutableSourceSnapshotStore,
  extractTier3AssertionEvidence,
  sanitizeVerifierEnv,
} from "@software-factory/verifier";
import {
  LinuxCgroupV2SandboxBackend,
  type SandboxCleanupEvidence,
  type SandboxSecurityMetadata,
} from "@software-factory/wna";

export class ReviewerContextLeakError extends Error {
  public readonly code = "ERR_REVIEWER_CONTEXT_LEAK";
  constructor(message: string) {
    super(message);
    this.name = "ReviewerContextLeakError";
  }
}

export interface ReviewFinding {
  readonly code:
    | "VERIFICATION_NOT_PASSED"
    | "SCOPE_VIOLATION"
    | "DISABLED_OR_SKIPPED_TEST"
    | "TRIVIAL_OR_TAUTOLOGICAL_ASSERTION"
    | "NO_MEANINGFUL_ASSERTIONS"
    | "MISSING_MODIFIED_LOGIC_COVERAGE"
    | "READONLY_SANDBOX_VIOLATION"
    | "CUSTOM_REVIEW_REJECTION";
  readonly severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
  readonly filePath?: string;
  readonly detail: string;
}

export interface Tier3AstInspectionResult {
  readonly inspectedFiles: readonly string[];
  readonly changedSourceFiles: readonly string[];
  readonly exportedSymbolsFromDiff: readonly string[];
  readonly referencedSymbolsInTests: readonly string[];
  readonly findings: readonly ReviewFinding[];
  readonly verifierEvidence: readonly Tier3AssertionEvidence[];
}

export interface ReviewerCleanInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly mergeCandidateId: string;
  readonly mergeCandidateHash: string;
  readonly verifiedTreeHash: string;
  readonly baseMainCommitHash: string;
  readonly taskContract: TaskContractSpec;
  readonly diffText: string;
  readonly changedFiles: readonly string[];
  readonly verificationRunSummary: {
    readonly verification_run_id: string;
    readonly verdict: "PASS" | "FAIL";
    readonly overall_status: string;
    readonly exit_code: number;
    readonly duration_ms: number;
    readonly tier1_trusted_acceptance_passed: boolean | null;
    readonly tier2_protected_baseline_passed: boolean | null;
    readonly tier3_agent_tests_passed: boolean | null;
    readonly tier3_assertions: readonly Tier3AssertionEvidence[];
  };
  readonly extractedSnapshotDir: string;
  readonly tier3Inspection: Tier3AstInspectionResult;
}

export type IndependentReviewEvaluator = (
  cleanInput: ReviewerCleanInput
) =>
  | Promise<{
      readonly verdict: "PASS" | "FAIL";
      readonly findings?: readonly ReviewFinding[];
      readonly summaryMarkdown?: string;
    }>
  | {
      readonly verdict: "PASS" | "FAIL";
      readonly findings?: readonly ReviewFinding[];
      readonly summaryMarkdown?: string;
    };

export interface IndependentReviewRequest {
  readonly reviewSessionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly mergeCandidateId: string;
  readonly mergeCandidateHash: string;
  readonly verifiedTreeHash: string;
  readonly baseMainCommitHash: string;
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
  readonly taskContract: TaskContractSpec;
  readonly verificationRun: VerificationRunRecord;
  readonly reviewerIdentity: {
    readonly principalId: string;
    readonly credentialId: string;
    readonly sessionId: string;
    readonly agentProfileId: string;
    readonly provider: string;
    readonly model: string;
    readonly role: "ROLE_REVIEWER_READONLY";
  };
  readonly repoPath?: string;
  readonly gitDir?: string;
  readonly tier3TestFiles?: readonly string[];
  readonly snapshotStore?: ImmutableSourceSnapshotStore;
  readonly sandboxBackend?: LinuxCgroupV2SandboxBackend;
  readonly evaluator?: IndependentReviewEvaluator;
  readonly probeReadOnlyEnforcement?: boolean;
  readonly sandboxCommandHook?: {
    readonly command: string;
    readonly args?: readonly string[];
  };
}

export interface IndependentReviewExecutionResult {
  readonly reviewSessionId: string;
  readonly verdict: "PASS" | "FAIL";
  readonly findings: readonly ReviewFinding[];
  readonly summaryMarkdown: string;
  readonly reportSha256: string;
  readonly tier3Inspection: Tier3AstInspectionResult;
  readonly changedFiles: readonly string[];
  readonly diffText: string;
  readonly sandboxBackendMode: string;
  readonly sandboxPid: number | null;
  readonly sandboxCgroupPath: string | null;
  readonly sandboxSecurityMetadata: SandboxSecurityMetadata | null;
  readonly sandboxCleanupEvidence: SandboxCleanupEvidence | null;
  readonly readOnlyEnforced: boolean;
  readonly evaluatorSawCleanInputOnly: boolean;
}

const FORBIDDEN_CONTEXT_KEYS = new Set<string>([
  "developerscratchpad",
  "scratchpad",
  "chainofthought",
  "chain_of_thought",
  "cot",
  "reasoningtrace",
  "reasoning_trace",
  "developermessages",
  "developer_messages",
  "conversationhistory",
  "conversation_history",
  "chathistory",
  "chat_history",
  "developerprompts",
  "developer_prompts",
  "workergitpushtoken",
  "worker_git_push_token",
  "developercredential",
  "developer_credential",
  "gitpushtoken",
  "git_push_token",
  "leasepushtoken",
  "lease_push_token",
]);

const FORBIDDEN_CONTEXT_CANONICAL_KEYS = new Set<string>(
  Array.from(FORBIDDEN_CONTEXT_KEYS, (k) => k.replace(/[-_\s]/g, "").toLowerCase())
);

const FORBIDDEN_STRING_RULES: ReadonlyArray<{
  readonly label: string;
  readonly regex: RegExp;
}> = [
  {
    label: "inline forbidden context assignment",
    regex:
      /(?:developer_?scratchpad|scratchpad|chain_?of_?thought|reasoning_?trace|developer_?messages|conversation_?history|chat_?history|developer_?prompts|worker_?git_?push_?token|lease_?push_?token|git_?push_?token|developer_?credential)\s*[:=]/i,
  },
  {
    label: "chain-of-thought markup tag",
    regex: /<\/?(?:thinking|scratchpad|chain_of_thought|antml:thinking|reasoning_trace)\b[^>]*>/i,
  },
  {
    label: "HTTP Authorization Bearer header",
    regex: /\bAuthorization\s*:\s*Bearer\s+\S+/i,
  },
  {
    label: "Bearer credential token",
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  },
  {
    label: "lease push token literal",
    regex: /\blease[-_]?token[-_:][A-Za-z0-9._-]{3,}/i,
  },
  {
    label: "secret environment credential assignment",
    regex:
      /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|PGPASSWORD|SF_GIT_PUSH_TOKEN|SF_WNA_PUSH_TOKEN)\s*[:=]\s*\S+/i,
  },
  {
    label: "provider API secret token",
    regex: new RegExp("\\bsk-" + "(?:ant|live|proj|svcacct)-[A-Za-z0-9_-]{12,}\\b"),
  },
  {
    label: "VCS personal access token",
    regex: new RegExp("\\bgh" + "[pousr]_[A-Za-z0-9_]{20,}\\b"),
  },
  {
    label: "AWS access key",
    regex: new RegExp("\\b(?:AK" + "IA|AS" + "IA)[0-9A-Z]{16}\\b"),
  },
  {
    label: "database connection string with embedded credentials",
    regex: new RegExp("postgres" + "(?:ql)?://[^:\\s/]+:[^@\\s/]+@[^\\s/]+", "i"),
  },
  {
    label: "private key header block",
    regex: new RegExp("-----BEGIN\\s+(?:[A-Z0-9]+\\s+)?PRIVATE" + "\\s+KEY-----"),
  },
];

function isForbiddenContextKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (FORBIDDEN_CONTEXT_KEYS.has(lowered)) {
    return true;
  }
  const canonical = lowered.replace(/[-_\s]/g, "");
  return FORBIDDEN_CONTEXT_CANONICAL_KEYS.has(canonical);
}

function assertStringHasNoForbiddenContext(
  raw: string,
  path: string,
  seen: Set<unknown>
): void {
  for (const rule of FORBIDDEN_STRING_RULES) {
    if (rule.regex.test(raw)) {
      throw new ReviewerContextLeakError(
        `ERR_REVIEWER_CONTEXT_LEAK: Forbidden ${rule.label} detected in string at ${path}`
      );
    }
  }

  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        assertNoForbiddenContextKeys(parsed, `${path}(json)`, seen);
      }
    } catch (err: unknown) {
      if (err instanceof ReviewerContextLeakError) {
        throw err;
      }
      // ignore non-JSON prose starting/ending with braces
    }
  }
}

function assertNoForbiddenContextKeys(
  value: unknown,
  path = "$",
  seen = new Set<unknown>()
): void {
  if (typeof value === "string") {
    assertStringHasNoForbiddenContext(value, path, seen);
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoForbiddenContextKeys(value[i], `${path}[${i}]`, seen);
    }
    return;
  }

  if (value instanceof Set) {
    let idx = 0;
    for (const item of value) {
      assertNoForbiddenContextKeys(item, `${path}[set:${idx}]`, seen);
      idx += 1;
    }
    return;
  }

  if (value instanceof Map) {
    for (const [k, v] of value.entries()) {
      const keyStr = String(k);
      if (isForbiddenContextKey(keyStr)) {
        throw new ReviewerContextLeakError(
          `ERR_REVIEWER_CONTEXT_LEAK: Forbidden developer context field '${keyStr}' detected at ${path}`
        );
      }
      assertNoForbiddenContextKeys(v, `${path}.${keyStr}`, seen);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenContextKey(key)) {
      throw new ReviewerContextLeakError(
        `ERR_REVIEWER_CONTEXT_LEAK: Forbidden developer context field '${key}' detected at ${path}`
      );
    }
    if (key === "snapshotStore" || key === "sandboxBackend" || typeof nested === "function") {
      continue;
    }
    assertNoForbiddenContextKeys(nested, `${path}.${key}`, seen);
  }
}

function collectFilesRecursively(rootDir: string, relPrefix = ""): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  const out: string[] = [];
  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const absPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        continue;
      }
      out.push(...collectFilesRecursively(absPath, relPath));
    } else {
      out.push(relPath);
    }
  }
  return out;
}

function setDirectoryTreeReadOnly(rootDir: string): void {
  const walk = (dirPath: string): void => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
        chmodSync(fullPath, 0o555);
      } else if (entry.isFile()) {
        chmodSync(fullPath, 0o444);
      }
    }
  };
  walk(rootDir);
  chmodSync(rootDir, 0o555);
}

function restoreDirectoryTreeWritableForCleanup(rootDir: string): void {
  if (!existsSync(rootDir)) {
    return;
  }
  try {
    chmodSync(rootDir, 0o700);
  } catch {
    // best-effort
  }
  const walk = (dirPath: string): void => {
    let entries;
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      try {
        const st = lstatSync(fullPath);
        if (st.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          chmodSync(fullPath, 0o700);
          walk(fullPath);
        } else {
          chmodSync(fullPath, 0o600);
        }
      } catch {
        // best-effort cleanup permissions
      }
    }
  };
  walk(rootDir);
}

function verifyExtractedTreeIsReadOnly(rootDir: string): boolean {
  const check = (dirPath: string): boolean => {
    const dirMode = lstatSync(dirPath).mode & 0o777;
    if ((dirMode & 0o222) !== 0) {
      return false;
    }
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        continue;
      }
      const mode = st.mode & 0o777;
      if ((mode & 0o222) !== 0) {
        return false;
      }
      if (entry.isDirectory() && !check(fullPath)) {
        return false;
      }
    }
    return true;
  };
  return check(rootDir);
}

function isTestFilePath(relPath: string): boolean {
  return (
    /(?:^|\/)[^/]+\.(?:agent\.)?(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i.test(
      relPath
    ) || /(?:^|\/)tests?\/[^/]+\.(?:ts|mts|js|mjs)$/i.test(relPath)
  );
}

function isSourceCodeFile(relPath: string): boolean {
  return /\.(?:ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i.test(relPath) && !isTestFilePath(relPath);
}

function extractExportedSymbolsFromFile(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const sourceText = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const symbols = new Set<string>();

  const hasExportModifier = (node: ts.Node): boolean => {
    if (!ts.canHaveModifiers(node)) {
      return false;
    }
    const modifiers = ts.getModifiers(node);
    return Boolean(modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      symbols.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      symbols.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.add(decl.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        symbols.add(el.name.text);
      }
    } else if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const leftText = stmt.expression.left.getText(sf);
      if (leftText.startsWith("module.exports") || leftText.startsWith("exports.")) {
        const rhs = stmt.expression.right;
        if (ts.isObjectLiteralExpression(rhs)) {
          for (const prop of rhs.properties) {
            if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
              symbols.add(prop.name.getText(sf));
            }
          }
        } else if (leftText.startsWith("exports.")) {
          const propName = leftText.slice("exports.".length).trim();
          if (propName) {
            symbols.add(propName);
          }
        }
      }
    }
  }

  return Array.from(symbols).sort();
}

function getCalleeText(expr: ts.Expression, sf: ts.SourceFile): string {
  return expr.getText(sf).replace(/\s+/g, "");
}

function isLiteralOrConstantExpr(expr: ts.Expression): boolean {
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined")
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return isLiteralOrConstantExpr(expr.operand);
  }
  if (ts.isParenthesizedExpression(expr)) {
    return isLiteralOrConstantExpr(expr.expression);
  }
  if (ts.isTypeOfExpression(expr)) {
    return isLiteralOrConstantExpr(expr.expression);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.every((el) => !ts.isSpreadElement(el) && isLiteralOrConstantExpr(el));
  }
  return false;
}

function collectIdentifiers(node: ts.Node, out: Set<string>): void {
  if (ts.isIdentifier(node)) {
    out.add(node.text);
  }
  ts.forEachChild(node, (child) => collectIdentifiers(child, out));
}

function getTestCaseCallbackBody(callExpr: ts.CallExpression): ts.Node | null {
  for (const arg of callExpr.arguments) {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return arg.body;
    }
  }
  return null;
}

function isEmptyCallbackBody(body: ts.Node): boolean {
  if (!ts.isBlock(body)) {
    return false;
  }
  return body.statements.length === 0;
}

/**
 * Tier-3 AST & Structural Test Quality Analyzer (`MVP-SPEC-04` §3.1):
 * Parses Tier-3 test files via TypeScript AST and detects:
 * 1. Disabled/skipped tests (`it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, `{ skip: true }`, `@Disabled`, empty test body).
 * 2. Trivial/tautological assertions (`expect(true).toBe(true)`, `assert.equal(1, 1)`, literal comparisons, `assert.equal(x, x)`).
 * 3. Zero non-trivial assertions in a test file.
 * 4. Disconnected tests that import/reference zero changed source modules or exported symbols from the diff.
 */
export function analyzeTier3AgentTests(options: {
  readonly extractedSnapshotDir: string;
  readonly changedFiles: readonly string[];
  readonly protectedPaths?: readonly string[];
  readonly explicitTestFiles?: readonly string[];
}): Tier3AstInspectionResult {
  const absDir = resolve(options.extractedSnapshotDir);
  const protectedPaths = options.protectedPaths ?? [];
  const allSnapshotFiles = collectFilesRecursively(absDir);

  const testFiles = options.explicitTestFiles
    ? [...options.explicitTestFiles]
    : Array.from(
        new Set(
          [
            ...options.changedFiles.filter(
              (f) => isTestFilePath(f) && matchesAnyGlob(f, protectedPaths) === null
            ),
            ...allSnapshotFiles.filter(
              (f) =>
                /(?:^|\/)[^/]+\.agent\.(?:test|spec)\.(?:ts|mts|js|mjs|tsx|jsx)$/i.test(f) &&
                matchesAnyGlob(f, protectedPaths) === null
            ),
          ]
        )
      ).sort();

  const changedSourceFiles = options.changedFiles
    .filter((f) => isSourceCodeFile(f) && matchesAnyGlob(f, protectedPaths) === null)
    .sort();

  const exportedSymbols = new Set<string>();
  const changedModuleStemNames = new Set<string>();
  for (const srcRel of changedSourceFiles) {
    const absSrc = join(absDir, ...srcRel.split("/"));
    for (const sym of extractExportedSymbolsFromFile(absSrc)) {
      exportedSymbols.add(sym);
    }
    const base = basename(srcRel, extname(srcRel));
    if (base && base !== "index") {
      changedModuleStemNames.add(base.toLowerCase());
    }
  }

  const findings: ReviewFinding[] = [];
  const referencedSymbolsInTests = new Set<string>();
  let totalNonTrivialAssertions = 0;

  for (const relTest of testFiles) {
    const absTest = join(absDir, ...relTest.split("/"));
    if (!existsSync(absTest)) {
      continue;
    }
    const content = readFileSync(absTest, "utf8");
    const sf = ts.createSourceFile(absTest, content, ts.ScriptTarget.Latest, true);

    if (/@Disabled\b/.test(content)) {
      findings.push({
        code: "DISABLED_OR_SKIPPED_TEST",
        severity: "CRITICAL",
        filePath: relTest,
        detail: `Disabled test annotation '@Disabled' detected in Tier-3 test ${relTest}`,
      });
    }

    const fileModuleSpecifiers: string[] = [];
    const fileIdentifiers = new Set<string>();
    const nonTrivialAssertionIdentifiers = new Set<string>();
    let fileNonTrivialAssertions = 0;

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        fileModuleSpecifiers.push(node.moduleSpecifier.text);
      }

      if (ts.isCallExpression(node)) {
        const callee = getCalleeText(node.expression, sf);

        // require("...")
        if (
          callee === "require" &&
          node.arguments.length >= 1 &&
          ts.isStringLiteral(node.arguments[0]!)
        ) {
          fileModuleSpecifiers.push(node.arguments[0]!.text);
        }

        // Dynamic import("...")
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length >= 1 &&
          ts.isStringLiteral(node.arguments[0]!)
        ) {
          fileModuleSpecifiers.push(node.arguments[0]!.text);
        }

        // Skipped test forms
        if (
          /^(?:it|test|describe)\.skip$/.test(callee) ||
          /^(?:xit|xtest|xdescribe)$/.test(callee) ||
          /\.todo$/.test(callee)
        ) {
          findings.push({
            code: "DISABLED_OR_SKIPPED_TEST",
            severity: "CRITICAL",
            filePath: relTest,
            detail: `Skipped test construct '${callee}' detected in ${relTest}`,
          });
        }

        // Node test runner options: test("name", { skip: true }, fn)
        if (/^(?:it|test|describe)$/.test(callee)) {
          for (const arg of node.arguments) {
            if (ts.isObjectLiteralExpression(arg)) {
              for (const prop of arg.properties) {
                if (
                  ts.isPropertyAssignment(prop) &&
                  prop.name.getText(sf) === "skip" &&
                  prop.initializer.kind !== ts.SyntaxKind.FalseKeyword
                ) {
                  findings.push({
                    code: "DISABLED_OR_SKIPPED_TEST",
                    severity: "CRITICAL",
                    filePath: relTest,
                    detail: `Skipped test option '{ skip: ... }' detected in ${relTest}`,
                  });
                }
              }
            }
          }
          const cbBody = getTestCaseCallbackBody(node);
          if (cbBody && isEmptyCallbackBody(cbBody)) {
            findings.push({
              code: "DISABLED_OR_SKIPPED_TEST",
              severity: "HIGH",
              filePath: relTest,
              detail: `Empty test case body detected in ${relTest}`,
            });
          }
        }

        // Vitest / Jest style assertions: expect(actual).matcher(expected)
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isCallExpression(node.expression.expression) &&
          getCalleeText(node.expression.expression.expression, sf) === "expect"
        ) {
          const actualArg = node.expression.expression.arguments[0];
          const expectedArg = node.arguments[0];

          const isLiteralPair =
            actualArg !== undefined &&
            isLiteralOrConstantExpr(actualArg) &&
            (expectedArg === undefined || isLiteralOrConstantExpr(expectedArg));
          const isSelfComparison =
            actualArg !== undefined &&
            expectedArg !== undefined &&
            actualArg.getText(sf) === expectedArg.getText(sf);

          if (isLiteralPair || isSelfComparison) {
            findings.push({
              code: "TRIVIAL_OR_TAUTOLOGICAL_ASSERTION",
              severity: "CRITICAL",
              filePath: relTest,
              detail: `Trivial/tautological assertion '${node.getText(sf).slice(0, 120)}' detected in ${relTest}`,
            });
          } else {
            fileNonTrivialAssertions += 1;
            totalNonTrivialAssertions += 1;
            if (actualArg) {
              collectIdentifiers(actualArg, nonTrivialAssertionIdentifiers);
            }
          }
        }

        // Node assert.* assertions
        if (/^assert(?:\.strict)?\./.test(callee) || callee === "assert") {
          const methodName = callee.startsWith("assert") ? callee.slice(callee.lastIndexOf(".") + 1) : "assert";
          const arg0 = node.arguments[0];
          const arg1 = node.arguments[1];

          const isAssertTrue =
            (methodName === "ok" || methodName === "assert") &&
            arg0 !== undefined &&
            isLiteralOrConstantExpr(arg0);
          const isLiteralEquality =
            (methodName === "equal" ||
              methodName === "strictEqual" ||
              methodName === "deepEqual" ||
              methodName === "deepStrictEqual" ||
              methodName === "notEqual" ||
              methodName === "notStrictEqual") &&
            arg0 !== undefined &&
            arg1 !== undefined &&
            isLiteralOrConstantExpr(arg0) &&
            isLiteralOrConstantExpr(arg1);
          const isSelfEquality =
            (methodName === "equal" ||
              methodName === "strictEqual" ||
              methodName === "deepEqual" ||
              methodName === "deepStrictEqual") &&
            arg0 !== undefined &&
            arg1 !== undefined &&
            arg0.getText(sf) === arg1.getText(sf);

          if (isAssertTrue || isLiteralEquality || isSelfEquality) {
            findings.push({
              code: "TRIVIAL_OR_TAUTOLOGICAL_ASSERTION",
              severity: "CRITICAL",
              filePath: relTest,
              detail: `Trivial/tautological assert '${node.getText(sf).slice(0, 120)}' detected in ${relTest}`,
            });
          } else {
            fileNonTrivialAssertions += 1;
            totalNonTrivialAssertions += 1;
            if (arg0) {
              collectIdentifiers(arg0, nonTrivialAssertionIdentifiers);
            }
            if (arg1) {
              collectIdentifiers(arg1, nonTrivialAssertionIdentifiers);
            }
          }
        }
      }

      if (ts.isIdentifier(node)) {
        fileIdentifiers.add(node.text);
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    if (fileNonTrivialAssertions === 0) {
      findings.push({
        code: "NO_MEANINGFUL_ASSERTIONS",
        severity: "CRITICAL",
        filePath: relTest,
        detail: `Tier-3 test file ${relTest} contains 0 non-trivial assertions`,
      });
    }

    // Track overlap with changed source symbols/modules
    for (const sym of exportedSymbols) {
      if (fileIdentifiers.has(sym)) {
        referencedSymbolsInTests.add(sym);
      }
    }
    for (const spec of fileModuleSpecifiers) {
      const normalizedSpec = spec.toLowerCase();
      for (const stem of changedModuleStemNames) {
        if (normalizedSpec.includes(stem)) {
          referencedSymbolsInTests.add(`module:${stem}`);
        }
      }
    }
    // Check if non-trivial assertions touch at least one imported/source symbol when exports exist
    if (
      changedSourceFiles.length > 0 &&
      exportedSymbols.size > 0 &&
      fileNonTrivialAssertions > 0
    ) {
      const touchesExportedInFile = Array.from(exportedSymbols).some(
        (sym) => fileIdentifiers.has(sym) || nonTrivialAssertionIdentifiers.has(sym)
      );
      const importsChangedModule = fileModuleSpecifiers.some((spec) => {
        const lower = spec.toLowerCase();
        return (
          changedSourceFiles.some((src) => lower.includes(src.toLowerCase())) ||
          Array.from(changedModuleStemNames).some((stem) => lower.includes(stem))
        );
      });
      if (!touchesExportedInFile && !importsChangedModule) {
        findings.push({
          code: "MISSING_MODIFIED_LOGIC_COVERAGE",
          severity: "HIGH",
          filePath: relTest,
          detail: `Tier-3 test ${relTest} does not import or assert against modified source files (${changedSourceFiles.join(
            ", "
          )}) or exports (${Array.from(exportedSymbols).join(", ")})`,
        });
      }
    }
  }

  if (
    testFiles.length > 0 &&
    changedSourceFiles.length > 0 &&
    exportedSymbols.size > 0 &&
    referencedSymbolsInTests.size === 0 &&
    !findings.some((f) => f.code === "MISSING_MODIFIED_LOGIC_COVERAGE")
  ) {
    findings.push({
      code: "MISSING_MODIFIED_LOGIC_COVERAGE",
      severity: "HIGH",
      detail: `None of the inspected Tier-3 tests reference modified source modules (${changedSourceFiles.join(
        ", "
      )})`,
    });
  }

  if (testFiles.length > 0 && totalNonTrivialAssertions === 0) {
    // Already captured per-file via NO_MEANINGFUL_ASSERTIONS
  }

  const verifierEvidence = extractTier3AssertionEvidence(absDir, testFiles, protectedPaths);

  return {
    inspectedFiles: testFiles,
    changedSourceFiles,
    exportedSymbolsFromDiff: Array.from(exportedSymbols).sort(),
    referencedSymbolsInTests: Array.from(referencedSymbolsInTests).sort(),
    findings,
    verifierEvidence,
  };
}

/**
 * 3D Independent Reviewer Service (`MVP-SPEC-04` §3):
 * - Dimension 1 (Identity): Runs only with `ROLE_REVIEWER_READONLY` credentials.
 * - Dimension 2 (Execution): Enforces strict Context Firewall (blocks scratchpad/CoT/push tokens),
 *   verifies & extracts WORM `.tar` snapshot read-only (`0o444`/`0o555`), spawns clean isolated
 *   sandbox process with stripped `env -i` environment, and guarantees `killAndVerifyClean`.
 * - Dimension 3 (Decision): Inspects real Git diff scope, verification run status, and AST-level
 *   Tier-3 test quality before producing SHA-256 checksummed `ReviewArtifact` report.
 */
export class IndependentReviewerService {
  private readonly defaultSnapshotStore?: ImmutableSourceSnapshotStore;
  private readonly defaultSandboxBackend: LinuxCgroupV2SandboxBackend;

  constructor(options?: {
    snapshotStore?: ImmutableSourceSnapshotStore;
    sandboxBackend?: LinuxCgroupV2SandboxBackend;
  }) {
    this.defaultSnapshotStore = options?.snapshotStore;
    this.defaultSandboxBackend = options?.sandboxBackend ?? new LinuxCgroupV2SandboxBackend();
  }

  private computeCandidateDiffFromGit(input: IndependentReviewRequest): {
    diffText: string;
    changedFiles: string[];
  } {
    if (!input.repoPath || !existsSync(input.repoPath)) {
      return {
        diffText: `(synthetic diff for ${input.baseMainCommitHash}..${input.mergeCandidateHash})`,
        changedFiles: [...(input.tier3TestFiles ?? [])],
      };
    }

    const gitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.gitDir ? { GIT_DIR: input.gitDir } : {}),
    };
    const nameOut = execFileSync(
      "git",
      ["diff", "--name-only", input.baseMainCommitHash, input.mergeCandidateHash],
      {
        cwd: input.repoPath,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }
    );
    const changedFiles = nameOut
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();

    const diffText = execFileSync(
      "git",
      ["diff", "--unified=3", input.baseMainCommitHash, input.mergeCandidateHash],
      {
        cwd: input.repoPath,
        env: gitEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }
    );

    return { diffText, changedFiles };
  }

  public async executeIndependentReview(
    request: IndependentReviewRequest
  ): Promise<IndependentReviewExecutionResult> {
    // 1. Fail-closed Context Firewall inspection before doing ANY work
    assertNoForbiddenContextKeys(request);
    if (request.reviewerIdentity.role !== "ROLE_REVIEWER_READONLY") {
      throw new ReviewerContextLeakError(
        `ERR_REVIEWER_CONTEXT_LEAK: Reviewer must run as ROLE_REVIEWER_READONLY, got ${String(
          request.reviewerIdentity.role
        )}`
      );
    }

    const snapshotStore = request.snapshotStore ?? this.defaultSnapshotStore;
    if (!snapshotStore) {
      throw new Error(
        "IndependentReviewerService requires an ImmutableSourceSnapshotStore to verify and extract candidate snapshots"
      );
    }

    const sandboxBackend = request.sandboxBackend ?? this.defaultSandboxBackend;
    const sandboxRoot = mkdtempSync(join(tmpdir(), "sf-reviewer-snap-"));
    const extractedSnapshotDir = join(sandboxRoot, "workspace");

    const sandboxTaskKey = `review-${request.reviewSessionId}`;
    const sandboxEpoch = 1;
    let sandboxPid: number | null = null;
    let sandboxBackendMode = "real-process";
    let sandboxCgroupPath: string | null = null;
    let sandboxSecurityMetadata: SandboxSecurityMetadata | null = null;
    let sandboxCleanupEvidence: SandboxCleanupEvidence | null = null;
    let readOnlyEnforced = false;

    try {
      // 2. Verify WORM snapshot SHA-256 + 0o444 and extract into isolated workspace
      snapshotStore.verifyAndExtractSnapshot({
        snapshotPath: request.snapshotPath,
        expectedSha256: request.snapshotSha256,
        targetDir: extractedSnapshotDir,
        requireReadOnlyMode: true,
      });

      // Lock extracted workspace & parent container strictly read-only (0o444 files / 0o555 dirs)
      // while keeping sandboxRoot traversable (0o555) for dropped unprivileged Linux UIDs.
      setDirectoryTreeReadOnly(extractedSnapshotDir);
      chmodSync(sandboxRoot, 0o555);
      const treeBitsReadOnly =
        verifyExtractedTreeIsReadOnly(extractedSnapshotDir) &&
        (lstatSync(sandboxRoot).mode & 0o222) === 0;

      // 3. Build sanitized env -i environment with zero Git push / developer credentials
      const cleanEnv = sanitizeVerifierEnv(process.env, {
        SF_REVIEW_ROLE: "ROLE_REVIEWER_READONLY",
        SF_REVIEW_SESSION_ID: request.reviewSessionId,
        SF_REVIEWER_CREDENTIAL_ID: request.reviewerIdentity.credentialId,
        GIT_TERMINAL_PROMPT: "0",
        SF_GIT_WRITE_DISABLED: "1",
      });

      // 4. Execute clean isolated OS sandbox session verifying read-only workspace & env hygiene
      const probeWriteScript = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.env.SF_REVIEW_ROLE !== 'ROLE_REVIEWER_READONLY') process.exit(11);",
        "for (const k of Object.keys(process.env)) {",
        "  if (/^(ANTHROPIC_|OPENAI_|PGPASSWORD$|DATABASE_URL$|GITHUB_TOKEN$|GH_TOKEN$|SF_WNA_)/.test(k) || /_(TOKEN|SECRET|PASSWORD)$/.test(k)) {",
        "    if (k !== 'SF_REVIEWER_CREDENTIAL_ID') process.exit(12);",
        "  }",
        "}",
        "const probeFlag = process.argv[1] === '1';",
        "if (probeFlag) {",
        "  let blocked = false;",
        "  const probePath = path.join(process.cwd(), '__sf_ro_violation_probe');",
        "  try {",
        "    fs.writeFileSync(probePath, 'tamper');",
        "  } catch (err) {",
        "    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {",
        "      blocked = true;",
        "    }",
        "  } finally {",
        "    try {",
        "      if (fs.existsSync(probePath)) fs.unlinkSync(probePath);",
        "    } catch {}",
        "  }",
        "  if (!blocked) process.exit(13);",
        "}",
        "process.exit(0);",
      ].join("\n");

      const cmd = request.sandboxCommandHook?.command ?? process.execPath;
      const args =
        request.sandboxCommandHook?.args ??
        ["-e", probeWriteScript, request.probeReadOnlyEnforcement !== false ? "1" : "0"];

      const spawned = sandboxBackend.spawnRealProcessInSandbox({
        taskId: sandboxTaskKey,
        leaseEpoch: sandboxEpoch,
        command: cmd,
        args,
        sanitizedEnv: cleanEnv,
        cwd: extractedSnapshotDir,
        worktreePath: extractedSnapshotDir,
        maskedPaths: request.repoPath ? [request.repoPath] : [],
        readOnlyPaths: [extractedSnapshotDir],
        isolateNamespaces: true,
        requireNamespaceIsolation: false,
      });

      sandboxPid = spawned.pid;
      sandboxCgroupPath = spawned.cgroupPath;
      sandboxSecurityMetadata = spawned.securityMetadata;
      sandboxBackendMode = spawned.securityMetadata.backendMode;

      const exitRes = await spawned.exitPromise;
      sandboxCleanupEvidence = await sandboxBackend.killAndVerifyClean(
        sandboxTaskKey,
        sandboxEpoch
      );
      sandboxBackendMode = sandboxCleanupEvidence.backendMode;

      const sandboxUid = sandboxSecurityMetadata.sandboxUid;
      const kernelRoMountApplied = Boolean(
        sandboxSecurityMetadata.readOnlyMountsApplied?.includes(extractedSnapshotDir)
      );
      const effectiveWriteIsolation = sandboxUid !== 0 || kernelRoMountApplied;
      readOnlyEnforced =
        treeBitsReadOnly && exitRes.code === 0 && effectiveWriteIsolation;

      const findings: ReviewFinding[] = [];
      if (exitRes.code !== 0 || !readOnlyEnforced) {
        findings.push({
          code: "READONLY_SANDBOX_VIOLATION",
          severity: "CRITICAL",
          detail: `Reviewer read-only sandbox failed verification (exitCode=${String(
            exitRes.code
          )}, treeBitsReadOnly=${String(treeBitsReadOnly)}, sandboxUid=${String(
            sandboxUid
          )}, kernelRoMountApplied=${String(kernelRoMountApplied)}, stderr=${
            exitRes.stderrTail ?? ""
          })`,
        });
        readOnlyEnforced = false;
      }

      // 5. Inspect VerificationRun status
      if (
        request.verificationRun.verdict !== "PASS" ||
        request.verificationRun.overall_status !== "PASSED" ||
        request.verificationRun.tier2_baseline_tamper_detected
      ) {
        findings.push({
          code: "VERIFICATION_NOT_PASSED",
          severity: "CRITICAL",
          detail: `VerificationRun ${request.verificationRun.verification_run_id} did not pass all verifier tiers (verdict=${request.verificationRun.verdict}, overall_status=${request.verificationRun.overall_status})`,
        });
      }

      // 6. Generate real git diff <B_base>..<C_candidate> and enforce TaskContract path policy
      const { diffText, changedFiles } = this.computeCandidateDiffFromGit(request);
      for (const filePath of changedFiles) {
        const verdict = evaluatePathPolicyPrecedence(filePath, request.taskContract);
        if (!verdict.allowed) {
          findings.push({
            code: "SCOPE_VIOLATION",
            severity: "CRITICAL",
            filePath,
            detail: `Changed file '${filePath}' violates TaskContract path policy (${verdict.reason})`,
          });
        }
      }

      // 7. Run Tier-3 AST & structural anti-cheat inspection
      const tier3Inspection = analyzeTier3AgentTests({
        extractedSnapshotDir,
        changedFiles,
        protectedPaths: request.taskContract.protected_paths,
        explicitTestFiles: request.tier3TestFiles,
      });
      findings.push(...tier3Inspection.findings);

      // 8. Construct strict whitelisted Clean Input for optional evaluator
      const resolvedOverallStatus =
        request.verificationRun.overall_status ??
        (request.verificationRun.verdict === "PASS" ? "PASSED" : "FAILED_ACCEPTANCE");
      const cleanInput: ReviewerCleanInput = Object.freeze({
        projectId: request.projectId,
        taskId: request.taskId,
        mergeCandidateId: request.mergeCandidateId,
        mergeCandidateHash: request.mergeCandidateHash,
        verifiedTreeHash: request.verifiedTreeHash,
        baseMainCommitHash: request.baseMainCommitHash,
        taskContract: structuredClone(request.taskContract),
        diffText,
        changedFiles: Object.freeze([...changedFiles]),
        verificationRunSummary: Object.freeze({
          verification_run_id: request.verificationRun.verification_run_id,
          verdict: request.verificationRun.verdict,
          overall_status: resolvedOverallStatus,
          exit_code: request.verificationRun.exit_code,
          duration_ms: request.verificationRun.duration_ms,
          tier1_trusted_acceptance_passed:
            request.verificationRun.tier1_trusted_acceptance_passed ?? null,
          tier2_protected_baseline_passed:
            request.verificationRun.tier2_protected_baseline_passed ?? null,
          tier3_agent_tests_passed: request.verificationRun.tier3_agent_tests_passed ?? null,
          tier3_assertions: structuredClone(request.verificationRun.tier3_assertions ?? []),
        }),
        extractedSnapshotDir,
        tier3Inspection,
      });

      let customSummary: string | undefined;
      if (request.evaluator) {
        const customOutcome = await request.evaluator(cleanInput);
        if (customOutcome.findings) {
          findings.push(...customOutcome.findings);
        }
        if (customOutcome.verdict === "FAIL" && !(customOutcome.findings?.length)) {
          findings.push({
            code: "CUSTOM_REVIEW_REJECTION",
            severity: "HIGH",
            detail: "Independent evaluator rejected merge candidate",
          });
        }
        customSummary = customOutcome.summaryMarkdown;
      }

      const hasBlockingFinding = findings.some(
        (f) => f.severity === "CRITICAL" || f.severity === "HIGH"
      );
      const verdict: "PASS" | "FAIL" = hasBlockingFinding ? "FAIL" : "PASS";

      const summaryMarkdown =
        customSummary ??
        [
          `## 3D Independent Review (${verdict})`,
          `- **Candidate:** \`${request.mergeCandidateHash}\` (tree \`${request.verifiedTreeHash}\`)`,
          `- **Reviewer:** \`${request.reviewerIdentity.principalId}\` (${request.reviewerIdentity.provider}/${request.reviewerIdentity.model}, role \`${request.reviewerIdentity.role}\`)`,
          `- **Sandbox:** \`${sandboxBackendMode}\`, readOnlyEnforced=\`${String(readOnlyEnforced)}\`, populatedZeroVerified=\`${String(
            sandboxCleanupEvidence?.populatedZeroVerified ?? false
          )}\``,
          `- **Changed Files (${changedFiles.length}):** ${changedFiles.join(", ") || "none"}`,
          `- **Tier-3 AST Inspected Files (${tier3Inspection.inspectedFiles.length}):** ${
            tier3Inspection.inspectedFiles.join(", ") || "none"
          }`,
          findings.length > 0
            ? `- **Findings (${findings.length}):** ${findings
                .map((f) => `[${f.code}] ${f.detail}`)
                .join(" | ")}`
            : "- **Findings:** None",
        ].join("\n");

      const reportSha256 = sha256Hex(
        canonicalizeJson({
          reviewSessionId: request.reviewSessionId,
          projectId: request.projectId,
          taskId: request.taskId,
          mergeCandidateId: request.mergeCandidateId,
          mergeCandidateHash: request.mergeCandidateHash,
          verifiedTreeHash: request.verifiedTreeHash,
          verificationRunId: request.verificationRun.verification_run_id,
          verdict,
          findings,
          summaryMarkdown,
        })
      );

      return {
        reviewSessionId: request.reviewSessionId,
        verdict,
        findings,
        summaryMarkdown,
        reportSha256,
        tier3Inspection,
        changedFiles,
        diffText,
        sandboxBackendMode,
        sandboxPid,
        sandboxCgroupPath,
        sandboxSecurityMetadata,
        sandboxCleanupEvidence,
        readOnlyEnforced,
        evaluatorSawCleanInputOnly: true,
      };
    } finally {
      try {
        if (sandboxCleanupEvidence === null && sandboxPid !== null) {
          await sandboxBackend.killAndVerifyClean(sandboxTaskKey, sandboxEpoch);
        }
      } catch {
        // best effort sandbox cleanup
      }
      restoreDirectoryTreeWritableForCleanup(sandboxRoot);
      try {
        rmSync(sandboxRoot, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}
