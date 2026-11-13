#!/usr/bin/env bash
# scripts/ci/worker-isolation-linux.sh
# M6C-3 Step 5 — Linux Worker Isolation & Sandbox Cleanup Verification Runner
# Validates genuine Linux kernel isolation: cgroups v2 delegation, PR_SET_CHILD_SUBREAPER,
# unshare namespaces, and kill-and-verify evidence contracts.
#
# Flags:
#   --strict-linux: Enforce strict Linux kernel prerequisites (root, cgroups v2, compiler, no skips allowed).
#                   Also enabled by setting environment variable SF_STRICT_LINUX=1.

set -euo pipefail

STRICT_LINUX="${SF_STRICT_LINUX:-0}"
for arg in "$@"; do
  if [[ "${arg}" == "--strict-linux" ]]; then
    STRICT_LINUX=1
  fi
done

echo "========================================================================"
echo "M6C-3 Step 5 — Linux Kernel Worker Isolation & Cleanup Verification"
echo "  Mode: $([[ "${STRICT_LINUX}" == "1" ]] && echo "STRICT LINUX (No Skips Permitted)" || echo "LOCAL / RELAXED (Honest Skips on Non-Linux)")"
echo "========================================================================"

# 1. Platform & Kernel Check
OS="$(uname -s)"
KERNEL="$(uname -r)"
ARCH="$(uname -m)"
CURRENT_UID="$(id -u)"

echo "[1/5] Host Environment:"
echo "  OS:           ${OS}"
echo "  Kernel:       ${KERNEL}"
echo "  Architecture: ${ARCH}"
echo "  UID:          ${CURRENT_UID}"
echo "  User:         $(whoami)"

if [[ "${OS}" != "Linux" ]]; then
  if [[ "${STRICT_LINUX}" == "1" ]]; then
    echo "[-] ERROR: Strict Linux mode requires Linux host (current: ${OS}). Failing as required by CI contract." >&2
    exit 1
  fi
  echo "[-] WARNING: Platform '${OS}' is not Linux. Kernel tests will report honest SKIP."
fi

if [[ "${STRICT_LINUX}" == "1" && "${CURRENT_UID}" -ne 0 ]]; then
  echo "[-] ERROR: Strict Linux worker acceptance requires root privilege (current UID: ${CURRENT_UID})." >&2
  exit 1
fi

# 2. Check cgroups v2 hierarchy and agent-specific delegation
echo ""
echo "[2/5] Inspecting Linux Cgroups v2 Hierarchy & Delegation:"
# Use agent-specific cgroup slice to avoid touching or clearing shared or agent A cgroups
CGROUP_BASE="/sys/fs/cgroup"
AGENT_B_CGROUP_ROOT="${SF_WORKER_TEST_CGROUP_ROOT:-${CGROUP_BASE}/sf-m6c3-b-slice}"

if [[ -f "${CGROUP_BASE}/cgroup.controllers" ]]; then
  echo "  [+] Cgroups v2 controllers available at ${CGROUP_BASE}:"
  cat "${CGROUP_BASE}/cgroup.controllers" || true

  if [[ -w "${CGROUP_BASE}" || -d "${AGENT_B_CGROUP_ROOT}" ]]; then
    if [[ ! -d "${AGENT_B_CGROUP_ROOT}" ]]; then
      echo "  [*] Creating agent-B specific cgroup delegation at ${AGENT_B_CGROUP_ROOT}..."
      mkdir -p "${AGENT_B_CGROUP_ROOT}"
      chmod 0755 "${AGENT_B_CGROUP_ROOT}" || true
    fi

    # Delegate controllers if root
    if [[ "${CURRENT_UID}" -eq 0 && -f "${AGENT_B_CGROUP_ROOT}/cgroup.subtree_control" ]]; then
      echo "+cpu +memory +pids" > "${AGENT_B_CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null || true
    fi

    export SF_WORKER_TEST_CGROUP_ROOT="${AGENT_B_CGROUP_ROOT}"
    echo "  [+] SF_WORKER_TEST_CGROUP_ROOT=${SF_WORKER_TEST_CGROUP_ROOT}"
  else
    if [[ "${STRICT_LINUX}" == "1" ]]; then
      echo "[-] ERROR: Cannot write to ${CGROUP_BASE} and ${AGENT_B_CGROUP_ROOT} does not exist." >&2
      exit 1
    fi
    echo "  [-] Insufficient permissions to create cgroup under ${CGROUP_BASE}"
  fi
else
  if [[ "${STRICT_LINUX}" == "1" ]]; then
    echo "[-] ERROR: Cgroups v2 hierarchy not mounted at ${CGROUP_BASE}." >&2
    exit 1
  fi
  echo "  [-] Cgroup v2 hierarchy not detected at ${CGROUP_BASE}"
fi

# 3. Check Linux namespaces & unprivileged user namespace
echo ""
echo "[3/5] Inspecting Linux Namespaces & Unprivileged Userns Clone:"
if [[ -f "/proc/sys/kernel/unprivileged_userns_clone" ]]; then
  USERNS_STATUS="$(cat /proc/sys/kernel/unprivileged_userns_clone)"
  echo "  kernel.unprivileged_userns_clone = ${USERNS_STATUS}"
fi

# 4. Check C compiler for native supervisor compilation
echo ""
echo "[4/5] Checking Native C Compiler for sf_sandbox_supervisor:"
COMPILER=""
for cc in cc gcc clang; do
  if command -v "${cc}" >/dev/null 2>&1; then
    COMPILER="${cc}"
    break
  fi
done

if [[ -n "${COMPILER}" ]]; then
  echo "  [+] Found C compiler: ${COMPILER} ($(${COMPILER} --version | head -n 1))"
else
  if [[ "${STRICT_LINUX}" == "1" ]]; then
    echo "[-] ERROR: C compiler (cc, gcc, clang) required for sf_sandbox_supervisor compilation on Linux." >&2
    exit 1
  fi
  echo "  [-] No C compiler found (cc, gcc, clang)."
fi

# 5. Run Worker Isolation Test Suite
echo ""
echo "[5/5] Executing Isolation Test Suite with Node Test Runner:"
echo "------------------------------------------------------------------------"

NODE_BIN="$(command -v node)"
echo "  Node binary: ${NODE_BIN} ($(${NODE_BIN} -v))"

TEST_OUTPUT_LOG="$(mktemp -t sf-iso-test-XXXXXX.log)"
trap 'rm -f "${TEST_OUTPUT_LOG}"' EXIT

set +e
"${NODE_BIN}" --test packages/test-harness/src/m6c3-worker-isolation.test.ts 2>&1 | tee "${TEST_OUTPUT_LOG}"
TEST_EXIT_CODE=$?
set -e

if [[ "${TEST_EXIT_CODE}" -ne 0 ]]; then
  echo "[-] ERROR: Test suite failed with exit code ${TEST_EXIT_CODE}" >&2
  exit "${TEST_EXIT_CODE}"
fi

if [[ "${STRICT_LINUX}" == "1" ]]; then
  # Strict mode requires that no test was skipped
  if grep -E "ℹ skipped [1-9]" "${TEST_OUTPUT_LOG}" >/dev/null 2>&1; then
    echo "[-] ERROR: Strict Linux mode forbids skipped tests, but test output reported skips." >&2
    exit 1
  fi
  echo "  [+] Strict Linux check passed: all kernel tests executed and verified with 0 skips."
fi

echo "------------------------------------------------------------------------"
echo "[✓] Worker isolation and cleanup verification runner completed successfully."
