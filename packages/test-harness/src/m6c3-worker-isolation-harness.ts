import { readFileSync } from "node:fs";
import {
  type SandboxCleanupEvidence,
  probeLinuxCgroupV2Support,
  probeLinuxNamespaceSupport,
  probeLinuxSubreaperSupport,
} from "@software-factory/wna";
import { FORBIDDEN_SANDBOX_ENV_PATTERNS } from "@software-factory/adapter-sdk";

/**
 * Canary secret values injected into parent environment to verify they never
 * leak into child processes, logs, or runner outputs.
 */
export const CANARY_SECRETS: Readonly<Record<string, string>> = {
  SF_TARGET_KEY: "sf-target-key-secret-canary-0123456789abcdef0123456789abcdef",
  AGENT_GATEWAY_TOKEN: "gw-token-canary-never-leak-to-sandbox-subprocesses",
  PGPASSWORD: "postgres-super-secret-password-canary-9999",
  DATABASE_URL: "postgres://sf_user:secretpass@127.0.0.1:55441/sf_db",
  GIT_PUSH_TOKEN: "ephemeral-git-push-token-canary-abcdef123456",
  SF_WNA_TOKEN: "sf-wna-daemon-supervisor-token-canary",
  ANTHROPIC_API_KEY: "canary-mock-ant-key-never-expose-to-isolated-sandboxes",
  OPENAI_API_KEY: "canary-mock-openai-key-never-expose-to-isolated-sandboxes",
  AWS_SECRET_ACCESS_KEY: "aws-secret-access-key-canary-1234567890abcdef",
  CUSTOM_HOST_CANARY: "HOST_SUPER_SECRET_CANARY_VALUE_XYZ_9876543210",
};

export interface EnvironmentCanaryInspectionResult {
  readonly isClean: boolean;
  readonly leakedKeys: readonly string[];
  readonly leakedCanaryValues: readonly string[];
  readonly matchedForbiddenPatterns: readonly string[];
}

/**
 * Inspects a given environment dictionary (e.g. child process environment)
 * for any sensitive host credentials or canary values.
 */
export function inspectEnvironmentForCanaryLeaks(
  env: Readonly<Record<string, string | undefined>>,
  customCanaries: Readonly<Record<string, string>> = CANARY_SECRETS
): EnvironmentCanaryInspectionResult {
  const leakedKeys: string[] = [];
  const leakedCanaryValues: string[] = [];
  const matchedForbiddenPatterns: string[] = [];

  const canaryValues = Object.values(customCanaries).filter((v) => typeof v === "string" && v.length > 0);

  for (const [key, val] of Object.entries(env)) {
    if (val === undefined) {
      continue;
    }

    // Check key against forbidden sandbox env patterns
    for (const pattern of FORBIDDEN_SANDBOX_ENV_PATTERNS) {
      if (pattern.test(key)) {
        leakedKeys.push(key);
        matchedForbiddenPatterns.push(pattern.toString());
      }
    }

    // Check if key name contains explicit canary names
    if (Object.prototype.hasOwnProperty.call(customCanaries, key)) {
      if (!leakedKeys.includes(key)) {
        leakedKeys.push(key);
      }
    }

    // Check if any value contains any canary secret string
    for (const canaryVal of canaryValues) {
      if (val.includes(canaryVal)) {
        if (!leakedCanaryValues.includes(canaryVal)) {
          leakedCanaryValues.push(canaryVal);
        }
        if (!leakedKeys.includes(key)) {
          leakedKeys.push(key);
        }
      }
    }
  }

  return {
    isClean: leakedKeys.length === 0 && leakedCanaryValues.length === 0,
    leakedKeys,
    leakedCanaryValues,
    matchedForbiddenPatterns,
  };
}

/**
 * Creates a minimal whitelist-only sanitized environment for isolated child execution.
 */
export function buildMinimalSanitizedEnv(overrides?: Record<string, string>): Record<string, string> {
  const safeEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    NODE_ENV: "test",
    LC_ALL: "C",
  };
  if (process.env.TMPDIR) {
    safeEnv.TMPDIR = process.env.TMPDIR;
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      safeEnv[k] = v;
    }
  }
  return safeEnv;
}

export interface KernelIsolationCapabilityReport {
  readonly isLinux: boolean;
  readonly platform: string;
  readonly cgroupsV2: {
    readonly supported: boolean;
    readonly cgroupRoot: string;
    readonly reason?: string;
  };
  readonly subreaper: {
    readonly supported: boolean;
    readonly reason?: string;
  };
  readonly namespaces: {
    readonly supported: boolean;
    readonly userNamespaceUsed: boolean;
    readonly mountMaskSupported: boolean;
    readonly reason?: string;
  };
  readonly canExecuteGenuineKernelTests: boolean;
  readonly skipReason?: string;
}

/**
 * Performs a comprehensive probe of host OS isolation capabilities.
 */
export function probeHostKernelIsolationCapabilities(): KernelIsolationCapabilityReport {
  const isLinux = process.platform === "linux";
  const cgroupsV2 = probeLinuxCgroupV2Support(process.env.SF_WORKER_TEST_CGROUP_ROOT);
  const subreaper = probeLinuxSubreaperSupport();
  const namespaces = probeLinuxNamespaceSupport({ testMaskMount: isLinux });

  const canExecuteGenuineKernelTests = isLinux && cgroupsV2.supported && subreaper.supported && namespaces.supported;

  let skipReason: string | undefined;
  if (!isLinux) {
    skipReason = `Platform '${process.platform}' is not Linux. Kernel isolation tests (cgroups v2, namespaces, subreaper) require Linux kernel.`;
  } else if (!cgroupsV2.supported) {
    skipReason = `Linux cgroups v2 not supported or unwritable: ${cgroupsV2.reason ?? "unknown"}`;
  } else if (!subreaper.supported) {
    skipReason = `Linux PR_SET_CHILD_SUBREAPER unavailable: ${subreaper.reason ?? "unknown"}`;
  } else if (!namespaces.supported) {
    skipReason = `Linux namespaces unshare/mount-mask unavailable: ${namespaces.reason ?? "unknown"}`;
  }

  return {
    isLinux,
    platform: process.platform,
    cgroupsV2,
    subreaper,
    namespaces,
    canExecuteGenuineKernelTests,
    skipReason,
  };
}

export interface CleanupEvidenceValidationOptions {
  readonly requireRealKernelOperations?: boolean;
  readonly requirePopulatedZero?: boolean;
  readonly requireCgroupDirRemoved?: boolean;
  readonly maxRemainingProcs?: number;
}

export interface CleanupEvidenceValidationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

/**
 * Validates the internal consistency and honest reporting of a SandboxCleanupEvidence record.
 * Ensures simulated runs never fabricate kernel evidence, and real runs meet kernel guarantees.
 */
export function validateCleanupEvidenceContract(
  evidence: SandboxCleanupEvidence,
  options?: CleanupEvidenceValidationOptions
): CleanupEvidenceValidationResult {
  const violations: string[] = [];

  // Timestamp must be a valid ISO string
  const timestamp = Date.parse(evidence.verifiedAt);
  if (Number.isNaN(timestamp)) {
    violations.push(`Invalid verifiedAt timestamp: '${evidence.verifiedAt}'`);
  }

  // PIDs arrays must be well-formed
  if (!Array.isArray(evidence.killedPids)) {
    violations.push("killedPids is not an array");
  } else if (evidence.killedPids.some((p) => !Number.isInteger(p) || p <= 0)) {
    violations.push("killedPids contains non-positive integer PID");
  }

  if (!Array.isArray(evidence.subreaperWaitpidReapedPids)) {
    violations.push("subreaperWaitpidReapedPids is not an array");
  }

  // Check remaining process count
  const maxProcs = options?.maxRemainingProcs ?? 0;
  if (evidence.remainingProcsCount > maxProcs) {
    violations.push(
      `remainingProcsCount (${evidence.remainingProcsCount}) exceeds maximum allowed (${maxProcs})`
    );
  }

  // Consistency check: Simulated mode must NOT claim kernel operations
  if (evidence.isSimulated) {
    if (evidence.realKernelOperationsExecuted) {
      violations.push("isSimulated is true but realKernelOperationsExecuted is also true (fabricated kernel claim)");
    }
    if (evidence.freezeApplied) {
      violations.push("isSimulated is true but freezeApplied is true");
    }
    if (evidence.cgroupKillWritten) {
      violations.push("isSimulated is true but cgroupKillWritten is true");
    }
    if (evidence.cgroupDirRemoved) {
      violations.push("isSimulated is true but cgroupDirRemoved is true");
    }
    if (evidence.backendMode === "linux-cgroup-v2") {
      violations.push("isSimulated is true but backendMode is claimed as 'linux-cgroup-v2'");
    }
  }

  // Consistency check: Real cgroup v2 mode MUST have executed kernel operations
  if (evidence.backendMode === "linux-cgroup-v2") {
    if (evidence.isSimulated) {
      violations.push("backendMode is 'linux-cgroup-v2' but isSimulated is true");
    }
    if (!evidence.realKernelOperationsExecuted) {
      violations.push("backendMode is 'linux-cgroup-v2' but realKernelOperationsExecuted is false");
    }
    if (!evidence.freezeApplied) {
      violations.push("backendMode is 'linux-cgroup-v2' but freezeApplied is false");
    }
    if (!evidence.cgroupKillWritten) {
      violations.push("backendMode is 'linux-cgroup-v2' but cgroupKillWritten is false");
    }
    if (options?.requirePopulatedZero && !evidence.populatedZeroVerified) {
      violations.push("populatedZeroVerified is false when real cgroup cleanup was required");
    }
    if (options?.requireCgroupDirRemoved && !evidence.cgroupDirRemoved) {
      violations.push("cgroupDirRemoved is false when real cgroup cleanup was required");
    }
  }

  // If real kernel operations were required by test options:
  if (options?.requireRealKernelOperations && !evidence.realKernelOperationsExecuted) {
    violations.push("Test required realKernelOperationsExecuted but evidence reported false");
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Reads parent PID of a Linux process from /proc/<pid>/stat.
 */
export function readLinuxProcessPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen === -1) {
      return null;
    }
    const fields = stat.slice(rparen + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether an OS process is alive (excluding Linux zombie/dead state if on Linux).
 */
export function checkOsProcessAlive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rparen = stat.lastIndexOf(")");
      if (rparen !== -1 && stat.length > rparen + 2) {
        const state = stat[rparen + 2];
        if (state === "Z" || state === "X") {
          return false;
        }
      }
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 12-Case Adversarial Contract Matrix Specification for Worker Endpoint
 */
export interface AdversarialMatrixScenario {
  readonly id: string;
  readonly name: string;
  readonly category: "security" | "protocol" | "lifecycle" | "crash_recovery";
  readonly description: string;
  readonly expectedOutcome: string;
}

export const WORKER_ENDPOINT_ADVERSARIAL_MATRIX: readonly AdversarialMatrixScenario[] = [
  {
    id: "TC01_INVALID_SIGNATURE",
    name: "Bad or Missing HMAC Signature Rejection",
    category: "security",
    description: "Requests with missing, expired, altered, or incorrect HMAC MAC in x-sf-target-signature must be rejected immediately before executing any side effects or spawning tasks.",
    expectedOutcome: "HTTP 401/403 or signature rejection error; zero processes spawned; zero journal claims created.",
  },
  {
    id: "TC02_IDENTITY_MISMATCH",
    name: "Target Identity Mismatch Defense",
    category: "security",
    description: "Caller requesting mismatching principal_id, worker_id, provider, or model against operator configured identity must be rejected.",
    expectedOutcome: "ERR_TARGET_PROTOCOL / identity validation failure; execution refused.",
  },
  {
    id: "TC03_UNKNOWN_FIELDS",
    name: "Strict Schema Unknown Fields Rejection",
    category: "protocol",
    description: "Requests containing unexpected or injected parameters (e.g. command override, arbitrary paths, credential injections) must be strictly rejected by schema validation.",
    expectedOutcome: "Request schema validation error; no unvalidated fields processed.",
  },
  {
    id: "TC04_OVERSIZED_PAYLOAD",
    name: "Bounded Request Payload Size Limit",
    category: "protocol",
    description: "Requests exceeding maximum permitted payload boundaries (16KB for health, 3MB for execute) must be aborted before buffering entire stream to prevent DoS.",
    expectedOutcome: "HTTP 413 / stream size limit error; connection closed.",
  },
  {
    id: "TC05_EXPIRED_DEADLINE",
    name: "Expired Deadline Rejection Before Spawn",
    category: "lifecycle",
    description: "Execution action with deadline already in the past or within tight margin must be rejected immediately without spawning any OS process.",
    expectedOutcome: "Deadline expired error; zero processes spawned.",
  },
  {
    id: "TC06_IDEMPOTENT_REPLAY_SAME_PAYLOAD",
    name: "Idempotent Replay with Same Action Payload",
    category: "lifecycle",
    description: "Subsequent execute calls with the exact same execution_id and identical payload must return the already-persisted terminal result, freshly re-signed with the current request nonce.",
    expectedOutcome: "Idempotent response with persisted terminal DTO; response signature matches new request nonce; no duplicate runner spawned.",
  },
  {
    id: "TC07_CONFLICTING_REPLAY_DIFFERENT_PAYLOAD",
    name: "Conflicting Replay with Altered Payload Rejection",
    category: "security",
    description: "Execute call with a previously claimed execution_id but a different action payload hash must be strictly rejected as a conflict/tampering attempt.",
    expectedOutcome: "HTTP 409 / Conflict error; existing claim/execution preserved; tampered payload rejected.",
  },
  {
    id: "TC08_CONCURRENT_EXECUTION_LOCK",
    name: "Atomic Journal Concurrency & Single Spawn Lock",
    category: "lifecycle",
    description: "Two simultaneous requests for the same execution_id must atomically race for the journal claim; exactly one process group may be spawned.",
    expectedOutcome: "Exactly one spawn occurs; second request either awaits execution or receives cached result.",
  },
  {
    id: "TC09_CRASH_RECOVERY_BEFORE_SPAWN",
    name: "Crash Recovery for Orphaned Pre-Spawn Claim",
    category: "crash_recovery",
    description: "Server crashes after writing journal claim but before runner spawn. On restart, the orphan claim must be held in UNKNOWN/HOLD state and NEVER blindly auto-spawned.",
    expectedOutcome: "Claim state marked UNKNOWN/HOLD; no uncoordinated auto-spawn on restart.",
  },
  {
    id: "TC10_CRASH_RECOVERY_DURING_RUN",
    name: "Watchdog Reconciliation for Running Processes on Crash",
    category: "crash_recovery",
    description: "Server/coordinator dies while runner process is active. On restart, watchdog reconciles via cgroup/process identifier, reaps lingering processes, and records terminal failure.",
    expectedOutcome: "Processes terminated cleanly; cgroup cleaned; journal state marked FAILED.",
  },
  {
    id: "TC11_ENVIRONMENT_CANARY_ISOLATION",
    name: "Environment Canaries & Secret Sanitization",
    category: "security",
    description: "Child processes must run under clean environment (env -i) where host credentials (SF_TARGET_KEY, AGENT_GATEWAY_TOKEN, DB credentials, cloud keys) are strictly absent.",
    expectedOutcome: "Zero canaries or sensitive variables present in runner environment.",
  },
  {
    id: "TC12_PATH_TRAVERSAL_MOUNT_ISOLATION",
    name: "Mount Namespace & Path Traversal Guard",
    category: "security",
    description: "Worktree path isolation prevents traversal (../, null bytes) and blocks access to /etc/sf-wna, forbidden credentials, or sibling worktrees.",
    expectedOutcome: "EACCES on traversal or forbidden path access; access confined to worktree.",
  },
];
