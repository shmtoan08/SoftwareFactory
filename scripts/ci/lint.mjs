import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();

function getTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: rootDir, encoding: "utf8" });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const files = getTrackedFiles();

// 1. Validate shell hook syntax
execFileSync("bash", ["-n", resolve(rootDir, "scripts/git-hooks/pre-receive")], {
  stdio: "inherit",
});

// 2. Enforce strict TypeScript lint flags (unused locals/params, implicit returns, switch fallthrough)
const tscBin = resolve(rootDir, "node_modules/.bin/tsc");
execFileSync(
  tscBin,
  [
    "-p",
    resolve(rootDir, "tsconfig.json"),
    "--noEmit",
    "--noUnusedLocals",
    "--noUnusedParameters",
    "--noImplicitReturns",
    "--noFallthroughCasesInSwitch",
  ],
  { stdio: "inherit" }
);

// 3. Static hygiene checks across TypeScript & runtime scripts
const BANNED_TS_PATTERNS = [
  { regex: /@ts-ignore\b/, reason: "Disallowed @ts-ignore suppression" },
  { regex: /@ts-nocheck\b/, reason: "Disallowed @ts-nocheck suppression" },
  { regex: /\beval\s*\(/, reason: "Disallowed dynamic eval()" },
  { regex: /\bnew\s+Function\s*\(/, reason: "Disallowed dynamic new Function()" },
];

const violations = [];
for (const relPath of files) {
  if (
    relPath.startsWith("scripts/ci/") ||
    (!relPath.endsWith(".ts") && !relPath.endsWith(".mjs"))
  ) {
    continue;
  }
  const content = readFileSync(resolve(rootDir, relPath), "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of BANNED_TS_PATTERNS) {
      if (rule.regex.test(line)) {
        violations.push(`${relPath}:${i + 1}: ${rule.reason}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Lint violations detected:\n" + violations.join("\n"));
  process.exit(1);
}

console.log(`Lint PASSED (${files.length} source files checked, strict tsc & bash -n clean).`);
