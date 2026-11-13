// Deliberately separate from provider-free/default tests: this gate requires real runsc.
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Docker3TierVerifier, probeGvisorRuntime } from "@software-factory/verifier";
import { createGvisorVerifierFixture } from "./m6c3-verifier-fixture.ts";

it("M6C-3 real gVisor: all three tiers, protected mounts, no credentials/network, container cleanup", async () => {
  assert.equal(probeGvisorRuntime(), true, "runsc must be registered; no skip or fallback");
  const fixture = createGvisorVerifierFixture();
  try {
    const verifier = new Docker3TierVerifier({ snapshotStore: fixture.snapshotStore, isolationPolicy: "gvisor" });
    const result = await verifier.verifyCandidateWithRetries(fixture.input);
    assert.equal(result.finalResult.verdict, "PASS", JSON.stringify(result.finalResult));
    assert.equal(result.finalResult.isolationRuntime, "runsc");
    assert.equal(result.finalResult.executionBackend, "docker");
    assert.equal(result.finalResult.isDockerIsolated, true);
    assert.equal(result.finalResult.hermeticNetworkDisabled, true);
    assert.match(result.finalResult.verifierImageDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(result.finalResult.tierOutcomes.map((t) => [t.tier,t.executed,t.passed]), [[1,true,true],[2,true,true],[3,true,true]]);
    const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `name=sf-verifier-${fixture.input.mergeCandidateHash.slice(0,12)}-`], { encoding: "utf8" }).trim();
    assert.equal(remaining, "", "no surviving verifier containers");
  } finally { fixture.cleanup(); }
});

it("M6C-3 real gVisor: timeout removes the container and never retries on host", async () => {
  assert.equal(probeGvisorRuntime(), true);
  const fixture = createGvisorVerifierFixture();
  try {
    const verifier = new Docker3TierVerifier({ snapshotStore: fixture.snapshotStore, isolationPolicy: "gvisor" });
    const result = await verifier.verifyCandidateWithRetries({ ...fixture.input,
      tier1Command: { command: "node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 1000 },
    });
    assert.equal(result.attempts.length, 1);
    assert.equal(result.finalResult.overallStatus, "TEST_TIMEOUT");
    assert.equal(result.finalResult.isolationRuntime, "runsc");
    assert.equal(result.finalResult.tierOutcomes[0]!.timedOut, true);
    const remaining = execFileSync("docker", ["ps", "-aq", "--filter", `name=sf-verifier-${fixture.input.mergeCandidateHash.slice(0,12)}-`], { encoding: "utf8" }).trim();
    assert.equal(remaining, "");
  } finally { fixture.cleanup(); }
});
