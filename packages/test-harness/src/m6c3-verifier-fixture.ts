import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ImmutableSourceSnapshotStore, type VerifierRunInput } from "@software-factory/verifier";

export function createGvisorVerifierFixture() {
  const root = mkdtempSync(join(tmpdir(), "sf-m6c3-verifier-"));
  const repo = join(root, "repo"); const trusted = join(root, "trusted");
  mkdirSync(join(repo, "src"), { recursive: true }); mkdirSync(join(repo, "tests/baseline"), { recursive: true }); mkdirSync(trusted);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Factory", GIT_AUTHOR_EMAIL: "factory@example.test", GIT_COMMITTER_NAME: "Factory", GIT_COMMITTER_EMAIL: "factory@example.test" } }).trim();
  git(["init", "--initial-branch=main"]);
  writeFileSync(join(repo, "src/value.cjs"), "module.exports = 41;\n");
  writeFileSync(join(repo, "tests/baseline/check.cjs"), 'require("node:assert/strict").equal(require("../../src/value.cjs"),42);\n');
  writeFileSync(join(trusted, "acceptance.cjs"), `
    const assert = require("node:assert/strict"); const fs = require("node:fs");
    assert.equal(require("/workspace/run/src/value.cjs"),42);
    assert.throws(()=>fs.writeFileSync("/workspace/baseline/pwn","x"));
    assert.throws(()=>fs.writeFileSync("/trusted-policy/acceptance-tests/pwn","x"));
    assert.throws(()=>fs.writeFileSync("/root/pwn","x"));
    assert.equal(fs.existsSync("/var/run/docker.sock"),false);
    assert.equal(process.env.OPENAI_API_KEY,undefined);
    assert.equal(process.env.PGPASSWORD,undefined);
    for (const entries of Object.values(require("node:os").networkInterfaces())) {
      for (const entry of entries) assert.equal(entry.internal,true);
    }
  `);
  git(["add", "."]); git(["commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["checkout", "-b", "agent"]); writeFileSync(join(repo,"src/value.cjs"), "module.exports = 42;\n");
  git(["add", "."]); git(["commit", "-m", "agent change"]);
  const hash = git(["rev-parse", "HEAD"]); const tree = git(["rev-parse", "HEAD^{tree}"]);
  const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: join(root, "snapshots") });
  const snapshot = snapshotStore.exportFromGitCommit({ repoPath: repo, mergeCandidateHash: hash, verifiedTreeHash: tree });
  const input: VerifierRunInput = {
    projectId: randomUUID(), taskId: randomUUID(), mergeCandidateId: randomUUID(), mergeCandidateHash: hash,
    verifiedTreeHash: tree, baseMainCommitHash: base, taskContract: { allowed_files: ["src/**"], protected_paths: ["tests/baseline/**"] },
    snapshotPath: snapshot.snapshotPath, snapshotSha256: snapshot.snapshotSha256, trustedAcceptanceDir: trusted,
    extraEnv: { OPENAI_API_KEY: "test-only", PGPASSWORD: "test-only" },
    repoPath: repo, dockerImage: "node:22-alpine", stepTimeoutMs: 30_000, maxInfraRetries: 1,
    tier1Command: { command: "node", args: ["/trusted-policy/acceptance-tests/acceptance.cjs"] },
    tier2Command: { command: "node", args: ["tests/baseline/check.cjs"] },
    tier3Command: { command: "node", args: ["-e", 'require("node:assert/strict").equal(require("./src/value.cjs"),42)'] },
  };
  return { root, repo, input, snapshotStore, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
