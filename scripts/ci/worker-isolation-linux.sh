#!/usr/bin/env bash
# Independent worker acceptance. CI must provide a dedicated delegated cgroup root.
set -euo pipefail

sf_isolation_strict="${SF_STRICT_LINUX:-0}"
for sf_isolation_arg in "$@"; do
  case "$sf_isolation_arg" in
    --strict-linux) sf_isolation_strict=1 ;;
    *) echo "Unknown isolation runner option: $sf_isolation_arg" >&2; exit 2 ;;
  esac
done

if [[ "$sf_isolation_strict" == 1 ]]; then
  [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || { echo 'Strict acceptance requires Linux and root' >&2; exit 1; }
  [[ -n "${SF_WORKER_TEST_CGROUP_ROOT:-}" ]] || { echo 'Dedicated SF_WORKER_TEST_CGROUP_ROOT is required' >&2; exit 1; }
  sf_isolation_root="$(realpath -- "$SF_WORKER_TEST_CGROUP_ROOT")"
  case "$sf_isolation_root" in
    /sys/fs/cgroup/*) ;;
    *) echo 'Acceptance cgroup root must be a dedicated cgroups v2 subtree' >&2; exit 1 ;;
  esac
  [[ -w "$sf_isolation_root" && -f "$sf_isolation_root/cgroup.controllers" && -d "$sf_isolation_root/software-factory.slice" ]] || { echo 'Dedicated cgroup delegation is unavailable' >&2; exit 1; }
  for sf_isolation_controller in cpu memory pids; do
    [[ " $(cat "$sf_isolation_root/software-factory.slice/cgroup.controllers") " == *" $sf_isolation_controller "* ]] || { echo "Missing controller: $sf_isolation_controller" >&2; exit 1; }
  done
  command -v cc >/dev/null || command -v gcc >/dev/null || command -v clang >/dev/null || { echo 'Native compiler is required' >&2; exit 1; }
  export SF_WORKER_TEST_CGROUP_ROOT="$sf_isolation_root"
fi

sf_isolation_log="$(mktemp -t sf-isolation.XXXXXX)"
trap 'rm -f "$sf_isolation_log"' EXIT
# Force TAP so the no-skip assertion works in CI and local terminals alike.
if node --test --test-reporter=tap packages/test-harness/src/m6c3-worker-isolation.test.ts > "$sf_isolation_log" 2>&1; then
  cat "$sf_isolation_log"
else
  sf_isolation_result=$?
  cat "$sf_isolation_log"
  exit "$sf_isolation_result"
fi
if [[ "$sf_isolation_strict" == 1 ]]; then
  sf_isolation_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "$sf_isolation_dir/worker-isolation-tap-summary.sh" "$sf_isolation_log"
fi
