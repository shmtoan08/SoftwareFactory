#!/usr/bin/env bash
# scripts/ci/worker-isolation-tap-summary.sh
# Strict TAP Summary Validator for Worker Isolation Acceptance.
#
# Contract:
#   Input: exactly 1 argument (LOG_PATH to TAP log).
#   Exit 0: exactly one root-level summary counter for tests, pass, fail, cancelled, skipped, todo.
#           tests > 0, pass == tests, fail == 0, cancelled == 0, skipped == 0, todo == 0.
#   Exit 1: invalid / missing / duplicate / inconsistent TAP summary or unreadable log file.
#           stderr MUST contain prefix: "Strict acceptance requires an executed TAP summary".
#   Exit 2: CLI argument error.
#
# Implementation is pure shell / awk and does NOT depend on 'node' binary in PATH.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 LOG_PATH" >&2
  exit 2
fi

sf_tap_log="$1"

if [[ -z "$sf_tap_log" || "$sf_tap_log" == -* ]]; then
  echo "Usage: $0 LOG_PATH" >&2
  exit 2
fi

if [[ ! -f "$sf_tap_log" || ! -r "$sf_tap_log" ]]; then
  echo "Strict acceptance requires an executed TAP summary: cannot read log file '$sf_tap_log'" >&2
  exit 1
fi

sf_awk_bin="awk"
if ! command -v "$sf_awk_bin" >/dev/null 2>&1; then
  echo "Strict acceptance requires an executed TAP summary: awk is required for TAP validation" >&2
  exit 1
fi

sf_err_msg=""
sf_eval_status=0

# Execute strict TAP stream parsing via awk
sf_err_msg="$("$sf_awk_bin" '
BEGIN {
  tests_seen = 0; tests_val = -1;
  pass_seen = 0; pass_val = -1;
  fail_seen = 0; fail_val = -1;
  cancelled_seen = 0; cancelled_val = -1;
  skipped_seen = 0; skipped_val = -1;
  todo_seen = 0; todo_val = -1;
  malformed_line = "";
}

# Only match lines starting with "# " at column 0 (root-level, no indentation)
/^# (tests|pass|fail|cancelled|skipped|todo)($|[[:space:]])/ {
  sub(/\r$/, "", $0);

  # Must match exact format: "# <counter> <non-negative-integer>"
  if ($0 !~ /^# (tests|pass|fail|cancelled|skipped|todo)[[:space:]]+[0-9]+$/) {
    if (malformed_line == "") {
      malformed_line = $0;
    }
    next;
  }

  counter = $2;
  val = $3 + 0;

  if (counter == "tests") { tests_seen++; tests_val = val; }
  else if (counter == "pass") { pass_seen++; pass_val = val; }
  else if (counter == "fail") { fail_seen++; fail_val = val; }
  else if (counter == "cancelled") { cancelled_seen++; cancelled_val = val; }
  else if (counter == "skipped") { skipped_seen++; skipped_val = val; }
  else if (counter == "todo") { todo_seen++; todo_val = val; }
}

END {
  if (malformed_line != "") {
    printf "Strict acceptance requires an executed TAP summary: malformed counter line (%s)\n", malformed_line;
    exit 1;
  }

  # Check missing counters
  if (tests_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# tests\" counter\n"; exit 1; }
  if (pass_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# pass\" counter\n"; exit 1; }
  if (fail_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# fail\" counter\n"; exit 1; }
  if (cancelled_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# cancelled\" counter\n"; exit 1; }
  if (skipped_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# skipped\" counter\n"; exit 1; }
  if (todo_seen == 0) { printf "Strict acceptance requires an executed TAP summary: missing root-level \"# todo\" counter\n"; exit 1; }

  # Check duplicate counters
  if (tests_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# tests\" counter (seen %d times)\n", tests_seen; exit 1; }
  if (pass_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# pass\" counter (seen %d times)\n", pass_seen; exit 1; }
  if (fail_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# fail\" counter (seen %d times)\n", fail_seen; exit 1; }
  if (cancelled_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# cancelled\" counter (seen %d times)\n", cancelled_seen; exit 1; }
  if (skipped_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# skipped\" counter (seen %d times)\n", skipped_seen; exit 1; }
  if (todo_seen > 1) { printf "Strict acceptance requires an executed TAP summary: duplicate \"# todo\" counter (seen %d times)\n", todo_seen; exit 1; }

  # Check values
  if (tests_val <= 0) { printf "Strict acceptance requires an executed TAP summary: tests count must be > 0 (got %d)\n", tests_val; exit 1; }
  if (pass_val != tests_val) { printf "Strict acceptance requires an executed TAP summary: pass count (%d) does not match tests count (%d)\n", pass_val, tests_val; exit 1; }
  if (fail_val != 0) { printf "Strict acceptance requires an executed TAP summary: fail count must be 0 (got %d)\n", fail_val; exit 1; }
  if (cancelled_val != 0) { printf "Strict acceptance requires an executed TAP summary: cancelled count must be 0 (got %d)\n", cancelled_val; exit 1; }
  if (skipped_val != 0) { printf "Strict acceptance requires an executed TAP summary: skipped count must be 0 (got %d)\n", skipped_val; exit 1; }
  if (todo_val != 0) { printf "Strict acceptance requires an executed TAP summary: todo count must be 0 (got %d)\n", todo_val; exit 1; }

  exit 0;
}
' "$sf_tap_log")" || sf_eval_status=$?

if [[ "$sf_eval_status" -ne 0 ]]; then
  echo "$sf_err_msg" >&2
  exit 1
fi

exit 0
