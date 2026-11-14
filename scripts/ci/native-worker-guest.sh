#!/usr/bin/env bash
# Run only against this job's root-owned source copy. Never labels it native VM evidence.
set -euo pipefail
[[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || { echo 'Linux root required' >&2; exit 1; }
: "${SF_NATIVE_SOURCE_ROOT:?Root-owned source copy is required}"
: "${SF_WORKER_TEST_CGROUP_ROOT:?Dedicated cgroups delegation required}"
cd "$SF_NATIVE_SOURCE_ROOT"
sf_native_guest_log="$(mktemp -t sf-native-guest.XXXXXX)"
trap 'rm -f -- "$sf_native_guest_log"' EXIT
if node --test --test-reporter=tap packages/test-harness/src/native-worker-guest.test.ts > "$sf_native_guest_log" 2>&1; then
  cat "$sf_native_guest_log"
else
  cat "$sf_native_guest_log"
  exit 1
fi
bash scripts/ci/worker-isolation-tap-summary.sh "$sf_native_guest_log"
