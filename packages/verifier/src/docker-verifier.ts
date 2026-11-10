import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import {
  type Tier3AssertionEvidence,
  type VerificationExecutionBackend,
  type VerificationOverallStatus,
  canonicalizeJson,
  sha256Hex,
} from "@software-factory/shared-types";
import { type TaskContractSpec, matchesAnyGlob } from "@software-factory/task-contract";
import { LinuxCgroupV2SandboxBackend } from "@software-factory/wna";
import {
  ImmutableSourceSnapshotStore,
  SnapshotIntegrityError,
} from "./candidate-builder.ts";

export class DockerVerifierUnavailableError extends Error {
  public readonly code = "ERR_DOCKER_VERIFIER_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "DockerVerifierUnavailableError";
  }
}

export class HardlinkCacheViolationError extends Error {
  public readonly code = "ERR_HARDLINK_CACHE_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "HardlinkCacheViolationError";
  }
}

export interface DockerSupportProbe {
  readonly dockerBinaryAvailable: boolean;
  readonly daemonAvailable: boolean;
  readonly serverVersion: string | null;
  readonly imageAvailable: boolean;
  readonly imageDigest: string | null;
}

export interface LinuxKernelHardlinkSymlinkSysctls {
  readonly supported: boolean;
  readonly protectedHardlinks: boolean | null;
  readonly protectedSymlinks: boolean | null;
}

export interface TierCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface VerifierRunInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly mergeCandidateId: string;
  readonly mergeCandidateHash: string;
  readonly verifiedTreeHash: string;
  readonly baseMainCommitHash: string;
  readonly taskContract: TaskContractSpec;
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
  readonly trustedAcceptanceDir: string;
  readonly expectedTrustedPolicySha256?: string;
  readonly repoPath?: string;
  readonly baseBaselineDir?: string;
  readonly depsCacheDir?: string;
  readonly dockerImage?: string;
  readonly executionMode?: "auto" | "docker" | "sandbox" | "subprocess";
  readonly requireDocker?: boolean;
  readonly networkDisabled?: boolean;
  readonly stepTimeoutMs?: number;
  readonly maxInfraRetries?: number;
  readonly tier1Command: TierCommandSpec;
  readonly tier2Command?: TierCommandSpec;
  readonly tier3Command?: TierCommandSpec;
  readonly tier3TestFiles?: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly infraErrorHook?: (attemptIndex: number) => boolean;
  readonly onAttemptRecorded?: (attemptResult: SingleVerificationAttemptResult, isFinal: boolean) => void | Promise<void>;
}

export interface TierExecutionOutcome {
  readonly tier: 1 | 2 | 3;
  readonly executed: boolean;
  readonly passed: boolean | null;
  readonly timedOut: boolean;
  readonly infraError: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface SingleVerificationAttemptResult {
  readonly attemptIndex: number;
  readonly verdict: "PASS" | "FAIL";
  readonly overallStatus: VerificationOverallStatus;
  readonly verifierImageDigest: string;
  readonly executionBackend: VerificationExecutionBackend;
  readonly isDockerIsolated: boolean;
  readonly hermeticNetworkDisabled: boolean;
  readonly hardlinkCacheForbidden: boolean;
  readonly kernelSysctls: LinuxKernelHardlinkSymlinkSysctls;
  readonly trustedPolicySha256: string | null;
  readonly trustedPolicyMatched: boolean;
  readonly tier1TrustedAcceptancePassed: boolean | null;
  readonly tier2ProtectedBaselinePassed: boolean | null;
  readonly tier2BaselineTamperDetected: boolean;
  readonly tamperedBaselinePaths: readonly string[];
  readonly tier3AgentTestsPassed: boolean | null;
  readonly tier3Assertions: readonly Tier3AssertionEvidence[];
  readonly tierOutcomes: readonly TierExecutionOutcome[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly reportSha256: string;
  readonly errorMessage?: string;
}

export interface RetryableVerificationResult {
  readonly finalResult: SingleVerificationAttemptResult;
  readonly infraRetryCount: number;
  readonly attempts: readonly SingleVerificationAttemptResult[];
}

export const FORBIDDEN_VERIFIER_ENV_PATTERNS: readonly RegExp[] = [
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GOOGLE_API_/i,
  /^GEMINI_/i,
  /^AWS_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^GITLAB_/i,
  /^PGPASSWORD$/i,
  /^DATABASE_URL$/i,
  /^NPM_TOKEN$/i,
  /^SF_CONTROL_PLANE_/i,
  /^SF_WNA_/i,
  /^NODE_OPTIONS$/i,
  /^LD_PRELOAD$/i,
  /^LD_LIBRARY_PATH$/i,
  /^DYLD_/i,
  /^PYTHONPATH$/i,
  /^PERL5OPT$/i,
  /^RUBYOPT$/i,
  /^BASH_ENV$/i,
  /^ENV$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_KEY$/i,
  /_PASSWORD$/i,
];

export function sanitizeVerifierEnv(
  sourceEnv: Readonly<Record<string, string | undefined>> = process.env,
  extraEnv?: Readonly<Record<string, string>>
): Record<string, string> {
  const safe: Record<string, string> = {
    PATH: sourceEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: sourceEnv.LANG ?? "C.UTF-8",
    LC_ALL: sourceEnv.LC_ALL ?? "C.UTF-8",
    HOME: "/tmp/sf-verifier-home",
    TERM: "xterm",
    CI: "true",
  };

  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (FORBIDDEN_VERIFIER_ENV_PATTERNS.some((rx) => rx.test(k))) {
        continue;
      }
      safe[k] = v;
    }
  }

  return safe;
}

export function probeLinuxHardlinkSymlinkSysctls(): LinuxKernelHardlinkSymlinkSysctls {
  if (process.platform !== "linux") {
    return {
      supported: false,
      protectedHardlinks: null,
      protectedSymlinks: null,
    };
  }

  let protectedHardlinks: boolean | null = null;
  let protectedSymlinks: boolean | null = null;
  try {
    protectedHardlinks = readFileSync("/proc/sys/fs/protected_hardlinks", "utf8").trim() === "1";
  } catch {
    protectedHardlinks = null;
  }
  try {
    protectedSymlinks = readFileSync("/proc/sys/fs/protected_symlinks", "utf8").trim() === "1";
  } catch {
    protectedSymlinks = null;
  }

  return {
    supported: true,
    protectedHardlinks,
    protectedSymlinks,
  };
}

export function probeDockerVerifierSupport(dockerImage = "node:22-alpine"): DockerSupportProbe {
  const versionCheck = spawnSync("docker", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (versionCheck.error || versionCheck.status !== 0) {
    return {
      dockerBinaryAvailable: false,
      daemonAvailable: false,
      serverVersion: null,
      imageAvailable: false,
      imageDigest: null,
    };
  }

  const infoCheck = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (infoCheck.error || infoCheck.status !== 0) {
    return {
      dockerBinaryAvailable: true,
      daemonAvailable: false,
      serverVersion: null,
      imageAvailable: false,
      imageDigest: null,
    };
  }

  const serverVersion = (infoCheck.stdout ?? "").trim() || "unknown";
  const inspectCheck = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", dockerImage],
    {
      encoding: "utf8",
      timeout: 5_000,
    }
  );
  if (inspectCheck.error || inspectCheck.status !== 0) {
    return {
      dockerBinaryAvailable: true,
      daemonAvailable: true,
      serverVersion,
      imageAvailable: false,
      imageDigest: null,
    };
  }

  const digestRaw = (inspectCheck.stdout ?? "").trim();
  return {
    dockerBinaryAvailable: true,
    daemonAvailable: true,
    serverVersion,
    imageAvailable: Boolean(digestRaw),
    imageDigest: digestRaw || null,
  };
}

/**
 * Generates hardened `docker run` CLI flags per `MVP-SPEC-04` §2.1:
 * `--rm --read-only --cap-drop=ALL --security-opt=no-new-privileges:true
 *  --pids-limit=512 --memory=4g --memory-swap=4g --cpus=2 --network=none`
 */
export function buildDockerRunSecurityArgs(options: {
  readonly containerName?: string;
  readonly dockerImage: string;
  readonly baselineDir: string;
  readonly trustedAcceptanceDir: string;
  readonly depsCacheDir?: string;
  readonly networkDisabled?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly command: readonly string[];
}): string[] {
  const args: string[] = [
    "run",
    "--rm",
    ...(options.containerName ? ["--name", options.containerName] : []),
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=512",
    "--memory=4g",
    "--memory-swap=4g",
    "--cpus=2",
    ...(options.networkDisabled !== false ? ["--network=none"] : []),
    "--mount",
    `type=bind,src=${resolve(options.baselineDir)},dst=/workspace/baseline,readonly`,
    "--mount",
    `type=bind,src=${resolve(options.trustedAcceptanceDir)},dst=/trusted-policy/acceptance-tests,readonly`,
    ...(options.depsCacheDir
      ? [
          "--mount",
          `type=bind,src=${resolve(options.depsCacheDir)},dst=/workspace/deps-cache,readonly`,
        ]
      : []),
    "--tmpfs",
    "/workspace/run:rw,nosuid,nodev,size=512m",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=256m",
    "--workdir",
    "/workspace/run",
  ];

  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (!FORBIDDEN_VERIFIER_ENV_PATTERNS.some((rx) => rx.test(k))) {
        args.push("-e", `${k}=${v}`);
      }
    }
  }

  args.push(options.dockerImage, ...options.command);
  return args;
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

/**
 * Deterministic SHA-256 across an entire directory tree (sorted relative POSIX paths + bytes).
 */
export function computeDirectorySha256(dirPath: string): string {
  const absDir = resolve(dirPath);
  const relFiles = collectFilesRecursively(absDir).sort();
  const hash = createHash("sha256");

  for (const relPath of relFiles) {
    const absFile = join(absDir, ...relPath.split("/"));
    const st = lstatSync(absFile);
    if (st.isSymbolicLink()) {
      const target = readlinkSync(absFile);
      hash.update(`L\0${relPath}\0${target}\0`);
    } else if (st.isFile()) {
      const bytes = readFileSync(absFile);
      hash.update(`F\0${relPath}\0${bytes.byteLength}\0`);
      hash.update(bytes);
      hash.update("\0");
    }
  }

  return hash.digest("hex");
}

function findSymlinksInDirectory(rootDir: string): string[] {
  const absRoot = resolve(rootDir);
  const symlinks: string[] = [];
  for (const relPath of collectFilesRecursively(absRoot)) {
    const st = lstatSync(join(absRoot, ...relPath.split("/")));
    if (st.isSymbolicLink()) {
      symlinks.push(relPath);
    }
  }
  return symlinks;
}

/**
 * Recursively copies `srcDir` -> `dstDir` using independent file byte copies (`copyFileSync`),
 * guaranteeing `nlink === 1` and distinct `(dev, ino)` so dependency caches or baselines are NEVER hardlinked.
 */
export function copyDirectoryWithoutHardlinks(srcDir: string, dstDir: string): void {
  const absSrc = resolve(srcDir);
  const absDst = resolve(dstDir);
  mkdirSync(absDst, { recursive: true });

  for (const entry of readdirSync(absSrc, { withFileTypes: true })) {
    const srcPath = join(absSrc, entry.name);
    const dstPath = join(absDst, entry.name);
    if (entry.isSymbolicLink()) {
      throw new HardlinkCacheViolationError(
        `Symlink prohibited inside verifier workspace/cache copy: ${srcPath}`
      );
    }
    if (entry.isDirectory()) {
      if (entry.name === ".git") {
        continue;
      }
      copyDirectoryWithoutHardlinks(srcPath, dstPath);
    } else if (entry.isFile()) {
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Verifies zero hardlink sharing between a dependency cache directory and an ephemeral run directory,
 * and ensures no file inside `depsCacheDir` has `nlink > 1`.
 */
export function assertZeroHardlinkSharing(runDir: string, depsCacheDir: string): void {
  const absDeps = resolve(depsCacheDir);
  const absRun = resolve(runDir);
  const depsInodes = new Set<string>();

  for (const relPath of collectFilesRecursively(absDeps)) {
    const st = lstatSync(join(absDeps, ...relPath.split("/")));
    if (st.isSymbolicLink()) {
      throw new HardlinkCacheViolationError(
        `Symbolic link prohibited in deps-cache: ${relPath}`
      );
    }
    if (st.nlink > 1) {
      throw new HardlinkCacheViolationError(
        `Hardlink detected in deps-cache file ${relPath} (nlink=${st.nlink} > 1)`
      );
    }
    depsInodes.add(`${st.dev}:${st.ino}`);
  }

  for (const relPath of collectFilesRecursively(absRun)) {
    const st = lstatSync(join(absRun, ...relPath.split("/")));
    const key = `${st.dev}:${st.ino}`;
    if (depsInodes.has(key)) {
      throw new HardlinkCacheViolationError(
        `Run workspace file ${relPath} shares inode (${key}) with deps-cache`
      );
    }
  }
}

function readProtectedDigestsFromGit(
  repoPath: string,
  commitHash: string,
  protectedPaths: readonly string[]
): Map<string, string> {
  const digests = new Map<string, string>();
  const lsOut = execFileSync("git", ["ls-tree", "-r", "-z", commitHash], {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  for (const entry of lsOut.split("\0").filter(Boolean)) {
    const tabIdx = entry.indexOf("\t");
    if (tabIdx === -1) continue;
    const meta = entry.slice(0, tabIdx).split(/\s+/);
    const mode = meta[0] ?? "";
    const objType = meta[1] ?? "";
    const relPath = entry.slice(tabIdx + 1);
    if (objType !== "blob") continue;
    if (matchesAnyGlob(relPath, protectedPaths) === null) continue;
    if (mode === "120000" || mode === "160000") {
      digests.set(relPath, `forbidden-mode:${mode}`);
      continue;
    }
    const blobSha = meta[2]!;
    const bytes = execFileSync("git", ["cat-file", "blob", blobSha], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    digests.set(relPath, `${mode}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return digests;
}

function readProtectedDigestsFromDir(
  dirPath: string,
  protectedPaths: readonly string[]
): Map<string, string> {
  const digests = new Map<string, string>();
  const absDir = resolve(dirPath);
  for (const relPath of collectFilesRecursively(absDir)) {
    if (matchesAnyGlob(relPath, protectedPaths) === null) continue;
    const absFile = join(absDir, ...relPath.split("/"));
    const st = lstatSync(absFile);
    if (st.isSymbolicLink()) {
      digests.set(relPath, "forbidden-mode:120000");
      continue;
    }
    const mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
    const bytes = readFileSync(absFile);
    digests.set(relPath, `${mode}:${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return digests;
}

/**
 * Compares SHA-256 of every file matching `protectedPaths` in `C_candidate` (extracted tar directory)
 * against `B_base` (`repoPath` + `baseMainCommitHash`, or `baseBaselineDir`).
 * Returns list of modified/deleted/injected paths (`FAH-01B`).
 */
export function verifyProtectedBaselineIntegrity(options: {
  readonly candidateDir: string;
  readonly protectedPaths: readonly string[];
  readonly repoPath?: string;
  readonly baseMainCommitHash?: string;
  readonly baseBaselineDir?: string;
}): readonly string[] {
  if (options.protectedPaths.length === 0) {
    return [];
  }

  let baseDigests: Map<string, string>;
  if (options.baseBaselineDir) {
    baseDigests = readProtectedDigestsFromDir(options.baseBaselineDir, options.protectedPaths);
  } else if (options.repoPath && options.baseMainCommitHash) {
    baseDigests = readProtectedDigestsFromGit(
      options.repoPath,
      options.baseMainCommitHash,
      options.protectedPaths
    );
  } else {
    throw new Error(
      "verifyProtectedBaselineIntegrity requires either baseBaselineDir or (repoPath + baseMainCommitHash) when protected_paths is non-empty"
    );
  }

  const candDigests = readProtectedDigestsFromDir(options.candidateDir, options.protectedPaths);
  const allPaths = new Set<string>([...baseDigests.keys(), ...candDigests.keys()]);
  const tampered: string[] = [];

  for (const p of Array.from(allPaths).sort()) {
    const baseVal = baseDigests.get(p);
    const candVal = candDigests.get(p);
    if (baseVal !== candVal) {
      tampered.push(p);
    }
  }

  return tampered;
}

/**
 * Extracts assertion expressions, `it.skip`/`@Disabled` markers, and trivial assertion patterns
 * from Tier 3 Agent-Generated Test files (`MVP-SPEC-04` §2.2 & `FAH-01C`) for M4 3D Independent Reviewer.
 */
export function extractTier3AssertionEvidence(
  candidateDir: string,
  explicitTestFiles?: readonly string[],
  protectedPaths: readonly string[] = []
): readonly Tier3AssertionEvidence[] {
  const absDir = resolve(candidateDir);
  const candidateFiles = explicitTestFiles
    ? [...explicitTestFiles]
    : collectFilesRecursively(absDir).filter(
        (rel) =>
          /(?:^|\/)[^/]+\.(?:agent\.)?(?:test|spec)\.(?:ts|mts|js|mjs|tsx|jsx)$/i.test(rel) &&
          matchesAnyGlob(rel, protectedPaths) === null
      );

  const evidence: Tier3AssertionEvidence[] = [];
  for (const relPath of candidateFiles.sort()) {
    const fullPath = join(absDir, ...relPath.split("/"));
    if (!existsSync(fullPath)) {
      continue;
    }
    const content = readFileSync(fullPath, "utf8");
    const skippedPatterns: string[] = [];
    const trivialPatterns: string[] = [];
    const assertionSnippets: string[] = [];

    for (const m of content.matchAll(/\b(?:it|test|describe)\.skip\s*\([^)\n]{0,120}/g)) {
      skippedPatterns.push(m[0].trim());
    }
    for (const m of content.matchAll(/\bx(?:it|test|describe)\s*\([^)\n]{0,120}/g)) {
      skippedPatterns.push(m[0].trim());
    }
    if (/@Disabled\b/.test(content)) {
      skippedPatterns.push("@Disabled");
    }

    for (const m of content.matchAll(
      /expect\s*\(\s*(?:true|false|1|0|['"][^'"]*['"])\s*\)\s*\.toBe\s*\(\s*(?:true|false|1|0|['"][^'"]*['"])\s*\)/g
    )) {
      trivialPatterns.push(m[0].trim());
    }
    for (const m of content.matchAll(
      /expect\s*\(\s*typeof\s+[^)]+\)\s*\.toBe\s*\(\s*['"][a-z]+['"]\s*\)/gi
    )) {
      trivialPatterns.push(m[0].trim());
    }
    for (const m of content.matchAll(
      /assert\s*\.\s*(?:ok\s*\(\s*true\s*\)|(?:strict)?[eE]qual\s*\(\s*1\s*,\s*1\s*\))/g
    )) {
      trivialPatterns.push(m[0].trim());
    }

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (/\b(?:expect\s*\(|assert\.)/.test(trimmed)) {
        assertionSnippets.push(trimmed.slice(0, 200));
      }
    }

    const trivialSet = new Set(trivialPatterns);
    const hasNonTrivialAssertion = assertionSnippets.some((snippet) => {
      for (const triv of trivialSet) {
        if (snippet.includes(triv)) {
          return false;
        }
      }
      return true;
    });

    evidence.push({
      filePath: relPath,
      skippedPatterns,
      assertionSnippets,
      trivialPatterns,
      hasRealAssertions: hasNonTrivialAssertion && skippedPatterns.length === 0,
    });
  }

  return evidence;
}

interface CommandSpawnOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly infraError: boolean;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

async function runHostCommandWithTimeout(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly useLinuxSupervisor: boolean;
  readonly supervisorBackend?: LinuxCgroupV2SandboxBackend;
  readonly taskId: string;
  readonly tierEpoch: number;
}): Promise<CommandSpawnOutcome> {
  const startMs = Date.now();

  if (options.useLinuxSupervisor && options.supervisorBackend && process.platform === "linux") {
    try {
      const spawned = options.supervisorBackend.spawnRealProcessInSandbox({
        taskId: options.taskId,
        leaseEpoch: options.tierEpoch,
        command: options.command,
        args: options.args,
        cwd: options.cwd,
        worktreePath: options.cwd,
        sanitizedEnv: options.env,
        isolateNamespaces: false,
        dropPrivileges: false,
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        void options.supervisorBackend?.killAndVerifyClean(options.taskId, options.tierEpoch);
      }, options.timeoutMs);

      try {
        const res = await spawned.exitPromise;
        const signalSuffix = res.signal ? `signal:${res.signal}` : "";
        const rawStderr = res.stderrTail ?? "";
        const stderrCombined = rawStderr
          ? signalSuffix
            ? `${rawStderr}\n${signalSuffix}`
            : rawStderr
          : signalSuffix;
        return {
          exitCode: res.code,
          timedOut,
          infraError: !timedOut && res.code === null && res.signal !== null,
          durationMs: Date.now() - startMs,
          stdoutTail: (res.stdoutTail ?? "").slice(-2048),
          stderrTail: stderrCombined.slice(-2048),
        };
      } finally {
        clearTimeout(timer);
        await options.supervisorBackend
          .killAndVerifyClean(options.taskId, options.tierEpoch)
          .catch(() => {});
      }
    } catch (err) {
      return {
        exitCode: null,
        timedOut: false,
        infraError: true,
        durationMs: Date.now() - startMs,
        stdoutTail: "",
        stderrTail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return await new Promise<CommandSpawnOutcome>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8192) {
        stdout = stdout.slice(-8192);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8192) {
        stderr = stderr.slice(-8192);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, options.timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        timedOut: false,
        infraError: true,
        durationMs: Date.now() - startMs,
        stdoutTail: stdout.slice(-2048),
        stderrTail: `${stderr}\n${err.message}`.slice(-2048),
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        timedOut,
        infraError: !timedOut && code === null && signal !== null,
        durationMs: Date.now() - startMs,
        stdoutTail: stdout.slice(-2048),
        stderrTail: stderr.slice(-2048),
      });
    });
  });
}

async function runDockerContainerCommandWithTimeout(options: {
  readonly containerName: string;
  readonly dockerArgs: readonly string[];
  readonly timeoutMs: number;
}): Promise<CommandSpawnOutcome> {
  const startMs = Date.now();
  return await new Promise<CommandSpawnOutcome>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn("docker", [...options.dockerArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8192) stdout = stdout.slice(-8192);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync("docker", ["rm", "-f", options.containerName], { timeout: 5_000 });
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, options.timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: null,
        timedOut: false,
        infraError: true,
        durationMs: Date.now() - startMs,
        stdoutTail: stdout.slice(-2048),
        stderrTail: err.message.slice(-2048),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Docker CLI exit codes 125/126/127 denote container/daemon launch errors
      const isDockerLaunchInfraError =
        !timedOut && (code === null || code === 125 || code === 126 || code === 127);
      resolvePromise({
        exitCode: code,
        timedOut,
        infraError: isDockerLaunchInfraError,
        durationMs: Date.now() - startMs,
        stdoutTail: stdout.slice(-2048),
        stderrTail: stderr.slice(-2048),
      });
    });
  });
}

function setDirectoryReadOnlyRecursive(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      setDirectoryReadOnlyRecursive(full);
      chmodSync(full, 0o555);
    } else if (entry.isFile()) {
      const curMode = lstatSync(full).mode & 0o777;
      chmodSync(full, (curMode & 0o111) !== 0 ? 0o555 : 0o444);
    }
  }
  chmodSync(dirPath, 0o555);
}

function restoreDirectoryWritableRecursive(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  try {
    chmodSync(dirPath, 0o755);
  } catch {
    return;
  }
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        restoreDirectoryWritableRecursive(full);
      } else if (entry.isFile()) {
        chmodSync(full, 0o644);
      }
    } catch {
      // best effort cleanup
    }
  }
}

/**
 * 3-Tier Trusted Docker Verifier (`MVP-SPEC-04` §2 & Roadmap `M3`):
 * - Always unpacks & SHA-256 verifies the immutable `.tar` snapshot of `C_candidate` (NEVER runs on `C_agent`).
 * - Verifies `trusted_policy_sha256` against read-only Tier 1 acceptance tests before running.
 * - Verifies SHA-256 of every file matching `protected_paths` vs `B_base` -> immediate `TEST_TAMPERING_DETECTED`.
 * - Enforces no-hardlink cache guarantees & secret stripping before execution.
 * - Runs hardened Docker container when daemon & image are available, or honestly reports
 *   `linux-supervisor` / `host-subprocess` fallback (`isDockerIsolated: false`), while failing closed
 *   on `requireDocker: true` when Docker is absent.
 * - Separates `TEST_TIMEOUT` (`ReworkRequired`) from `INFRA_ERROR` (retries up to 2 times cleanly).
 */
export class Docker3TierVerifier {
  public readonly snapshotStore: ImmutableSourceSnapshotStore;

  constructor(options: { snapshotStore: ImmutableSourceSnapshotStore }) {
    this.snapshotStore = options.snapshotStore;
  }

  public async runSingleAttempt(
    input: VerifierRunInput,
    attemptIndex = 0
  ): Promise<SingleVerificationAttemptResult> {
    const startedMs = Date.now();
    const dockerImage = input.dockerImage ?? "node:22-alpine";
    const mode = input.executionMode ?? "auto";
    const kernelSysctls = probeLinuxHardlinkSymlinkSysctls();
    const dockerProbe =
      mode === "subprocess" || mode === "sandbox"
        ? {
            dockerBinaryAvailable: false,
            daemonAvailable: false,
            serverVersion: null,
            imageAvailable: false,
            imageDigest: null,
          }
        : probeDockerVerifierSupport(dockerImage);

    if ((input.requireDocker || mode === "docker") && (!dockerProbe.daemonAvailable || !dockerProbe.imageAvailable)) {
      throw new DockerVerifierUnavailableError(
        `Docker verifier unavailable for image ${dockerImage} (daemonAvailable=${String(
          dockerProbe.daemonAvailable
        )}, imageAvailable=${String(dockerProbe.imageAvailable)})`
      );
    }

    const useDocker = dockerProbe.daemonAvailable && dockerProbe.imageAvailable;
    const useLinuxSupervisor = !useDocker && mode === "sandbox" && process.platform === "linux";
    const executionBackend: VerificationExecutionBackend = useDocker
      ? "docker"
      : useLinuxSupervisor
      ? "linux-supervisor"
      : "host-subprocess";
    const verifierImageDigest =
      useDocker && dockerProbe.imageDigest
        ? dockerProbe.imageDigest
        : `host-fallback:${executionBackend}:${process.version}`;

    const sanitizedEnv = sanitizeVerifierEnv(process.env, input.extraEnv);
    const stepTimeoutMs = input.stepTimeoutMs ?? 300_000;
    const networkDisabled = input.networkDisabled ?? true;

    const finalizeReport = (
      partial: Omit<
        SingleVerificationAttemptResult,
        "reportSha256" | "durationMs"
      > & { durationMs?: number }
    ): SingleVerificationAttemptResult => {
      const durationMs = partial.durationMs ?? Date.now() - startedMs;
      const reportSha256 = sha256Hex(
        canonicalizeJson({
          attemptIndex: partial.attemptIndex,
          verdict: partial.verdict,
          overallStatus: partial.overallStatus,
          mergeCandidateHash: input.mergeCandidateHash,
          verifiedTreeHash: input.verifiedTreeHash,
          verifierImageDigest: partial.verifierImageDigest,
          executionBackend: partial.executionBackend,
          isDockerIsolated: partial.isDockerIsolated,
          tier1TrustedAcceptancePassed: partial.tier1TrustedAcceptancePassed,
          tier2ProtectedBaselinePassed: partial.tier2ProtectedBaselinePassed,
          tier2BaselineTamperDetected: partial.tier2BaselineTamperDetected,
          tamperedBaselinePaths: partial.tamperedBaselinePaths,
          tier3AgentTestsPassed: partial.tier3AgentTestsPassed,
          tier3Assertions: partial.tier3Assertions,
          trustedPolicySha256: partial.trustedPolicySha256,
          trustedPolicyMatched: partial.trustedPolicyMatched,
          exitCode: partial.exitCode,
        })
      );
      return {
        ...partial,
        durationMs,
        reportSha256,
      };
    };

    // Simulated or injected container/host infra fault BEFORE running tests
    if (input.infraErrorHook?.(attemptIndex)) {
      return finalizeReport({
        attemptIndex,
        verdict: "FAIL",
        overallStatus: "INFRA_ERROR",
        verifierImageDigest,
        executionBackend,
        isDockerIsolated: useDocker,
        hermeticNetworkDisabled: networkDisabled,
        hardlinkCacheForbidden: true,
        kernelSysctls,
        trustedPolicySha256: null,
        trustedPolicyMatched: true,
        tier1TrustedAcceptancePassed: null,
        tier2ProtectedBaselinePassed: null,
        tier2BaselineTamperDetected: false,
        tamperedBaselinePaths: [],
        tier3AgentTestsPassed: null,
        tier3Assertions: [],
        tierOutcomes: [],
        exitCode: 125,
        errorMessage: `Injected verifier infrastructure failure on attempt ${attemptIndex}`,
      });
    }

    const workRoot = mkdtempSync(join(tmpdir(), "sf-verifier-"));
    const baselineDir = join(workRoot, "baseline");
    const runDir = join(workRoot, "run");
    const roAcceptanceDir = join(workRoot, "trusted-acceptance-ro");
    let roDepsDir: string | undefined;

    try {
      // Step 1: Verify & unpack immutable `.tar` snapshot of C_candidate
      try {
        this.snapshotStore.verifyAndExtractSnapshot({
          snapshotPath: input.snapshotPath,
          expectedSha256: input.snapshotSha256,
          targetDir: baselineDir,
        });
      } catch (err) {
        const isSnapshotTamper =
          err instanceof SnapshotIntegrityError &&
          (err.code === "ERR_SNAPSHOT_INTEGRITY_MISMATCH" ||
            err.code === "ERR_SNAPSHOT_NOT_READONLY" ||
            err.code === "ERR_SNAPSHOT_CONTAINS_GIT_METADATA" ||
            err.code === "ERR_SNAPSHOT_UNSAFE_ARCHIVE_MEMBER");
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: isSnapshotTamper ? "TEST_TAMPERING_DETECTED" : "INFRA_ERROR",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: null,
          trustedPolicyMatched: true,
          tier1TrustedAcceptancePassed: null,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions: [],
          tierOutcomes: [],
          exitCode: isSnapshotTamper ? 1 : 125,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }

      // Step 2: Check Tier 1 Trusted Acceptance Tests SHA-256 against trusted_policy_sha256
      if (!existsSync(input.trustedAcceptanceDir)) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "INFRA_ERROR",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: null,
          trustedPolicyMatched: false,
          tier1TrustedAcceptancePassed: false,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions: [],
          tierOutcomes: [],
          exitCode: 125,
          errorMessage: `Trusted acceptance tests directory not found: ${input.trustedAcceptanceDir}`,
        });
      }

      const actualPolicySha = computeDirectorySha256(input.trustedAcceptanceDir);
      const expectedPolicySha =
        input.expectedTrustedPolicySha256 ?? input.taskContract.trusted_policy_sha256;
      const policyMatched =
        expectedPolicySha === undefined || expectedPolicySha === actualPolicySha;

      if (!policyMatched) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "FAILED_ACCEPTANCE",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: actualPolicySha,
          trustedPolicyMatched: false,
          tier1TrustedAcceptancePassed: false,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions: [],
          tierOutcomes: [],
          exitCode: 1,
          errorMessage: `ERR_TRUSTED_POLICY_SHA256_MISMATCH: expected ${expectedPolicySha}, got ${actualPolicySha}`,
        });
      }

      // Step 3: Tier 2 Pre-Execution Check — Protected Baseline SHA-256 comparison vs B_base (FAH-01B)
      const protectedPaths = input.taskContract.protected_paths ?? [];
      const tamperedBaselinePaths = verifyProtectedBaselineIntegrity({
        candidateDir: baselineDir,
        protectedPaths,
        repoPath: input.repoPath,
        baseMainCommitHash: input.baseMainCommitHash,
        baseBaselineDir: input.baseBaselineDir,
      });

      if (tamperedBaselinePaths.length > 0) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "TEST_TAMPERING_DETECTED",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: actualPolicySha,
          trustedPolicyMatched: true,
          tier1TrustedAcceptancePassed: null,
          tier2ProtectedBaselinePassed: false,
          tier2BaselineTamperDetected: true,
          tamperedBaselinePaths,
          tier3AgentTestsPassed: null,
          tier3Assertions: [],
          tierOutcomes: [],
          exitCode: 1,
          errorMessage: `Protected baseline tests tampered: ${tamperedBaselinePaths.join(", ")}`,
        });
      }

      // Step 4: Reject symlinks in candidate & prepare non-hardlinked ephemeral run directory + read-only copies
      const candidateSymlinks = findSymlinksInDirectory(baselineDir);
      if (candidateSymlinks.length > 0) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "FAILED_ACCEPTANCE",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: actualPolicySha,
          trustedPolicyMatched: true,
          tier1TrustedAcceptancePassed: null,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions: [],
          tierOutcomes: [],
          exitCode: 1,
          errorMessage: `ERR_CANDIDATE_SYMLINK_PROHIBITED: Symbolic links prohibited inside candidate workspace: ${candidateSymlinks.join(
            ", "
          )}`,
        });
      }

      try {
        copyDirectoryWithoutHardlinks(baselineDir, runDir);
      } catch (err) {
        if (err instanceof HardlinkCacheViolationError) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "FAILED_ACCEPTANCE",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: null,
            tier2ProtectedBaselinePassed: null,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: null,
            tier3Assertions: [],
            tierOutcomes: [],
            exitCode: 1,
            errorMessage: err.message,
          });
        }
        throw err;
      }

      try {
        copyDirectoryWithoutHardlinks(input.trustedAcceptanceDir, roAcceptanceDir);
      } catch (err) {
        if (err instanceof HardlinkCacheViolationError) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "FAILED_ACCEPTANCE",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: false,
            tier1TrustedAcceptancePassed: false,
            tier2ProtectedBaselinePassed: null,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: null,
            tier3Assertions: [],
            tierOutcomes: [],
            exitCode: 1,
            errorMessage: err.message,
          });
        }
        throw err;
      }

      if (input.depsCacheDir && existsSync(input.depsCacheDir)) {
        roDepsDir = join(workRoot, "deps-cache-ro");
        try {
          copyDirectoryWithoutHardlinks(input.depsCacheDir, roDepsDir);
          assertZeroHardlinkSharing(runDir, input.depsCacheDir);
          assertZeroHardlinkSharing(runDir, roDepsDir);
        } catch (err) {
          if (err instanceof HardlinkCacheViolationError) {
            return finalizeReport({
              attemptIndex,
              verdict: "FAIL",
              overallStatus: "TEST_TAMPERING_DETECTED",
              verifierImageDigest,
              executionBackend,
              isDockerIsolated: useDocker,
              hermeticNetworkDisabled: networkDisabled,
              hardlinkCacheForbidden: true,
              kernelSysctls,
              trustedPolicySha256: actualPolicySha,
              trustedPolicyMatched: true,
              tier1TrustedAcceptancePassed: null,
              tier2ProtectedBaselinePassed: null,
              tier2BaselineTamperDetected: false,
              tamperedBaselinePaths: [],
              tier3AgentTestsPassed: null,
              tier3Assertions: [],
              tierOutcomes: [],
              exitCode: 1,
              errorMessage: err.message,
            });
          }
          throw err;
        }
        setDirectoryReadOnlyRecursive(roDepsDir);
      }
      setDirectoryReadOnlyRecursive(baselineDir);
      setDirectoryReadOnlyRecursive(roAcceptanceDir);

      // Step 5: Extract Tier 3 assertions evidence for M4 3D Independent Reviewer (FAH-01C)
      const tier3Assertions = extractTier3AssertionEvidence(
        baselineDir,
        input.tier3TestFiles,
        protectedPaths
      );

      const supervisorBackend = useLinuxSupervisor ? new LinuxCgroupV2SandboxBackend() : undefined;

      const executeTier = async (
        tier: 1 | 2 | 3,
        spec: TierCommandSpec
      ): Promise<TierExecutionOutcome> => {
        const tierTimeout = spec.timeoutMs ?? stepTimeoutMs;
        const tierEnv: Record<string, string> = {
          ...sanitizedEnv,
          SF_VERIFIER_TIER: String(tier),
          SF_BASELINE_DIR: useDocker ? "/workspace/baseline" : baselineDir,
          SF_RUN_DIR: useDocker ? "/workspace/run" : runDir,
          SF_TRUSTED_ACCEPTANCE_DIR: useDocker
            ? "/trusted-policy/acceptance-tests"
            : roAcceptanceDir,
          ...(roDepsDir
            ? { SF_DEPS_CACHE_DIR: useDocker ? "/workspace/deps-cache" : roDepsDir }
            : {}),
        };

        let outcome: CommandSpawnOutcome;
        if (useDocker) {
          const containerName = `sf-verifier-${input.mergeCandidateHash.slice(0, 12)}-t${tier}-${randomUUID().slice(0, 8)}`;
          const innerCmd = [spec.command, ...(spec.args ?? [])]
            .map((tok) => `'${tok.replace(/'/g, "'\\''")}'`)
            .join(" ");
          const dockerArgs = buildDockerRunSecurityArgs({
            containerName,
            dockerImage,
            baselineDir,
            trustedAcceptanceDir: roAcceptanceDir,
            depsCacheDir: roDepsDir,
            networkDisabled,
            env: tierEnv,
            command: ["sh", "-c", `cp -r /workspace/baseline/. /workspace/run && cd /workspace/run && ${innerCmd}`],
          });
          outcome = await runDockerContainerCommandWithTimeout({
            containerName,
            dockerArgs,
            timeoutMs: tierTimeout,
          });
        } else {
          outcome = await runHostCommandWithTimeout({
            command: spec.command,
            args: spec.args ?? [],
            cwd: runDir,
            env: tierEnv,
            timeoutMs: tierTimeout,
            useLinuxSupervisor,
            supervisorBackend,
            taskId: `${input.taskId}-t${tier}`,
            tierEpoch: attemptIndex * 10 + tier,
          });
        }

        const passed =
          outcome.timedOut || outcome.infraError ? false : outcome.exitCode === 0;
        return {
          tier,
          executed: true,
          passed,
          timedOut: outcome.timedOut,
          infraError: outcome.infraError,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          stdoutTail: outcome.stdoutTail,
          stderrTail: outcome.stderrTail,
        };
      };

      const tierOutcomes: TierExecutionOutcome[] = [];

      // Execute Tier 1 -> Tier 2 -> Tier 3
      const tier1Out = await executeTier(1, input.tier1Command);
      tierOutcomes.push(tier1Out);
      if (tier1Out.infraError) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "INFRA_ERROR",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: actualPolicySha,
          trustedPolicyMatched: true,
          tier1TrustedAcceptancePassed: false,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions,
          tierOutcomes,
          exitCode: tier1Out.exitCode ?? 125,
          errorMessage: `Infrastructure failure during Tier 1 execution: ${tier1Out.stderrTail}`,
        });
      }
      if (tier1Out.timedOut) {
        return finalizeReport({
          attemptIndex,
          verdict: "FAIL",
          overallStatus: "TEST_TIMEOUT",
          verifierImageDigest,
          executionBackend,
          isDockerIsolated: useDocker,
          hermeticNetworkDisabled: networkDisabled,
          hardlinkCacheForbidden: true,
          kernelSysctls,
          trustedPolicySha256: actualPolicySha,
          trustedPolicyMatched: true,
          tier1TrustedAcceptancePassed: false,
          tier2ProtectedBaselinePassed: null,
          tier2BaselineTamperDetected: false,
          tamperedBaselinePaths: [],
          tier3AgentTestsPassed: null,
          tier3Assertions,
          tierOutcomes,
          exitCode: 124,
          errorMessage: "Tier 1 Trusted Acceptance Tests exceeded step timeout",
        });
      }

      let tier2Passed: boolean | null = null;
      if (input.tier2Command) {
        const tier2Out = await executeTier(2, input.tier2Command);
        tierOutcomes.push(tier2Out);
        if (tier2Out.infraError) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "INFRA_ERROR",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: tier1Out.passed,
            tier2ProtectedBaselinePassed: false,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: null,
            tier3Assertions,
            tierOutcomes,
            exitCode: tier2Out.exitCode ?? 125,
            errorMessage: `Infrastructure failure during Tier 2 execution: ${tier2Out.stderrTail}`,
          });
        }
        if (tier2Out.timedOut) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "TEST_TIMEOUT",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: tier1Out.passed,
            tier2ProtectedBaselinePassed: false,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: null,
            tier3Assertions,
            tierOutcomes,
            exitCode: 124,
            errorMessage: "Tier 2 Protected Baseline Tests exceeded step timeout",
          });
        }
        tier2Passed = tier2Out.passed;
      }

      let tier3Passed: boolean | null = null;
      if (input.tier3Command) {
        const tier3Out = await executeTier(3, input.tier3Command);
        tierOutcomes.push(tier3Out);
        if (tier3Out.infraError) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "INFRA_ERROR",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: tier1Out.passed,
            tier2ProtectedBaselinePassed: tier2Passed,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: false,
            tier3Assertions,
            tierOutcomes,
            exitCode: tier3Out.exitCode ?? 125,
            errorMessage: `Infrastructure failure during Tier 3 execution: ${tier3Out.stderrTail}`,
          });
        }
        if (tier3Out.timedOut) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "TEST_TIMEOUT",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: tier1Out.passed,
            tier2ProtectedBaselinePassed: tier2Passed,
            tier2BaselineTamperDetected: false,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: false,
            tier3Assertions,
            tierOutcomes,
            exitCode: 124,
            errorMessage: "Tier 3 Agent-Generated Tests exceeded step timeout",
          });
        }
        tier3Passed = tier3Out.passed;
      }

      // Re-verify after test execution that untrusted code created zero hardlinks to deps-cache
      if (roDepsDir && input.depsCacheDir) {
        try {
          assertZeroHardlinkSharing(runDir, roDepsDir);
          assertZeroHardlinkSharing(runDir, input.depsCacheDir);
        } catch (err) {
          return finalizeReport({
            attemptIndex,
            verdict: "FAIL",
            overallStatus: "TEST_TAMPERING_DETECTED",
            verifierImageDigest,
            executionBackend,
            isDockerIsolated: useDocker,
            hermeticNetworkDisabled: networkDisabled,
            hardlinkCacheForbidden: true,
            kernelSysctls,
            trustedPolicySha256: actualPolicySha,
            trustedPolicyMatched: true,
            tier1TrustedAcceptancePassed: tier1Out.passed,
            tier2ProtectedBaselinePassed: tier2Passed,
            tier2BaselineTamperDetected: true,
            tamperedBaselinePaths: [],
            tier3AgentTestsPassed: false,
            tier3Assertions,
            tierOutcomes,
            exitCode: 1,
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const allPassed =
        tier1Out.passed === true && tier2Passed !== false && tier3Passed !== false;
      return finalizeReport({
        attemptIndex,
        verdict: allPassed ? "PASS" : "FAIL",
        overallStatus: allPassed ? "PASSED" : "FAILED_ACCEPTANCE",
        verifierImageDigest,
        executionBackend,
        isDockerIsolated: useDocker,
        hermeticNetworkDisabled: networkDisabled,
        hardlinkCacheForbidden: true,
        kernelSysctls,
        trustedPolicySha256: actualPolicySha,
        trustedPolicyMatched: true,
        tier1TrustedAcceptancePassed: tier1Out.passed,
        tier2ProtectedBaselinePassed: tier2Passed,
        tier2BaselineTamperDetected: false,
        tamperedBaselinePaths: [],
        tier3AgentTestsPassed: tier3Passed,
        tier3Assertions,
        tierOutcomes,
        exitCode: allPassed ? 0 : 1,
      });
    } finally {
      restoreDirectoryWritableRecursive(baselineDir);
      restoreDirectoryWritableRecursive(roAcceptanceDir);
      if (roDepsDir) {
        restoreDirectoryWritableRecursive(roDepsDir);
      }
      rmSync(workRoot, { recursive: true, force: true });
    }
  }

  /**
   * Executes verification with automatic retry on `INFRA_ERROR` (`maxInfraRetries` default 2 -> up to 3 attempts)
   * without consuming `rework_count` (`MVP-SPEC-04` §2.3), while failing immediately on `TEST_TIMEOUT`,
   * `TEST_TAMPERING_DETECTED`, or `FAILED_ACCEPTANCE`.
   */
  public async verifyCandidateWithRetries(
    input: VerifierRunInput
  ): Promise<RetryableVerificationResult> {
    const maxRetries = Math.max(0, input.maxInfraRetries ?? 2);
    const attempts: SingleVerificationAttemptResult[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await this.runSingleAttempt(input, attempt);
      attempts.push(result);
      const isFinal = result.overallStatus !== "INFRA_ERROR" || attempt === maxRetries;
      if (input.onAttemptRecorded) {
        await input.onAttemptRecorded(result, isFinal);
      }
      if (isFinal) {
        return {
          finalResult: result,
          infraRetryCount: attempt,
          attempts,
        };
      }
    }

    const last = attempts[attempts.length - 1]!;
    return {
      finalResult: last,
      infraRetryCount: maxRetries,
      attempts,
    };
  }
}

export function resolveArtifactRelativePath(base: string, rel: string): string {
  return join(base, ...posix.normalize(rel).split("/"));
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
