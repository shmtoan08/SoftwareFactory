#!/usr/bin/env bash
# scripts/ci/worker-isolation-linux.sh
# M6C-3 Step 5 — Linux Worker Isolation & Sandbox Cleanup Verification Runner
# Validates genuine Linux kernel isolation: cgroups v2 delegation, PR_SET_CHILD_SUBREAPER,
# unshare namespaces, and kill-and-verify evidence contracts.

set -euo pipefail

echo "========================================================================"
echo "M6C-3 Step 5 — Linux Kernel Worker Isolation & Cleanup Verification"
echo "========================================================================"

# 1. Platform & Kernel Check
OS="$(uname -s)"
KERNEL="$(uname -r)"
ARCH="$(uname -m)"

echo "[1/5] Host Environment:"
echo "  OS:           ${OS}"
echo "  Kernel:       ${KERNEL}"
echo "  Architecture: ${ARCH}"
echo "  UID:          $(id -u)"
echo "  User:         $(whoami)"

if [[ "${OS}" != "Linux" ]]; then
  echo "[-] WARNING: Platform '${OS}' is not Linux. Kernel tests will report honest SKIP."
  echo "    To execute genuine kernel isolation, run inside Linux container or VM with cgroups v2."
fi

# 2. Check cgroups v2 hierarchy and delegation
echo ""
echo "[2/5] Inspecting Linux Cgroups v2 Hierarchy:"
CGROUP_ROOT="/sys/fs/cgroup"
CGROUP_SLICE="${CGROUP_ROOT}/software-factory.slice"

if [[ -f "${CGROUP_ROOT}/cgroup.controllers" ]]; then
  echo "  [+] Cgroups v2 controllers available:"
  cat "${CGROUP_ROOT}/cgroup.controllers" || true

  # Ensure software-factory.slice exists and is writable
  if [[ -w "${CGROUP_ROOT}" ]]; then
    if [[ ! -d "${CGROUP_SLICE}" ]]; then
      echo "  [*] Creating software-factory.slice..."
      mkdir -p "${CGROUP_SLICE}"
      chmod 0755 "${CGROUP_SLICE}" || true
    fi
    echo "  [+] software-factory.slice ready at ${CGROUP_SLICE}"
  else
    echo "  [-] Insufficient permissions to create cgroup under ${CGROUP_ROOT} (requires delegation or root/subuid)"
  fi
else
  echo "  [-] Cgroup v2 hierarchy not detected at ${CGROUP_ROOT}"
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
  echo "  [-] No C compiler found (cc, gcc, clang). Native supervisor compilation may fail on Linux."
fi

# 5. Run Worker Isolation Test Suite
echo ""
echo "[5/5] Executing Isolation Test Suite with Node Test Runner:"
echo "------------------------------------------------------------------------"

# Ensure Node >= 22 is used
NODE_BIN="$(command -v node)"
echo "  Node binary: ${NODE_BIN} ($(${NODE_BIN} -v))"

"${NODE_BIN}" --test packages/test-harness/src/m6c3-worker-isolation.test.ts

echo "------------------------------------------------------------------------"
echo "[✓] Worker isolation and cleanup verification runner completed."
