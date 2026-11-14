/** Explicit operator-run Mac entrypoint; accepts only a preprovisioned running dedicated guest. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { lstatSync,readFileSync,realpathSync,writeFileSync } from "node:fs";
import { dirname,join,isAbsolute,resolve } from "node:path";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import { NativeLimaWorkerConnector,nativeVmProfileSha256,type NativeLimaWorkerConfig } from "@software-factory/wna";
import { canonicalizeJson } from "@software-factory/shared-types";
async function main():Promise<void> {
if(process.platform!=="darwin")throw new Error("Native Lima host acceptance requires macOS; no fallback");
const [configPath,guestManifestPath,outputPath]=process.argv.slice(2);
if(!configPath || !guestManifestPath || !outputPath)throw new Error("Usage: native-vm-host-acceptance.ts PRIVATE_CONFIG_JSON GUEST_MANIFEST_JSON NEW_RECEIPT_JSON");
const inputStat=lstatSync(configPath),parent=lstatSync(dirname(configPath));
if(!inputStat.isFile() || inputStat.isSymbolicLink() || inputStat.uid!==process.getuid?.() || (inputStat.mode&0o077)!==0 || inputStat.size>65536 || !parent.isDirectory() || parent.uid!==process.getuid?.() || (parent.mode&0o077)!==0 || realpathSync(configPath)!==configPath)throw new Error("Private owned native config required");
if(!isAbsolute(outputPath) || resolve(outputPath).startsWith(realpathSync(fileURLToPath(new URL("../../../",import.meta.url)))+"/"))throw new Error("Receipt must be outside source checkout");
const input=JSON.parse(readFileSync(configPath,"utf8")) as {bridge:NativeLimaWorkerConfig;baselineCommit:string};
if(input.bridge.testOnlyEmulator!==undefined && input.bridge.testOnlyEmulator!==false || !/^[a-f0-9]{40}$/.test(input.baselineCommit))throw new Error("Native acceptance forbids emulator flags");
const sourceRoot=realpathSync(fileURLToPath(new URL("../../../",import.meta.url)));
const git=(args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd:sourceRoot,encoding:"utf8",timeout:10000,stdio:"pipe"}).trim();
assert.equal(git(["rev-parse","HEAD"]),input.bridge.profile.sourceSha);assert.equal(git(["status","--porcelain"]),"");
const manifestBytes=readFileSync(guestManifestPath);
if(manifestBytes.length>65536)throw new Error("Guest evidence bound exceeded");
const guest=JSON.parse(manifestBytes.toString("utf8")) as {schemaVersion:string;status:string;sourceSha:string;profileHash:string;bootId:string;runs:{name:string;logFile:string;sha256:string}[]};
assert.equal(guest.schemaVersion,"sf-native-guest-acceptance-v1");assert.equal(guest.status,"PASSED");assert.equal(guest.sourceSha,input.bridge.profile.sourceSha);assert.equal(guest.profileHash,nativeVmProfileSha256(input.bridge.profile));
assert.equal(guest.runs.length,2);
for(const [index,name] of ["worker","isolation"].entries()){
  const run=guest.runs[index]!;assert.equal(run.name,name);assert.equal(run.logFile,`${name}.tap`);
  const file=join(dirname(guestManifestPath),run.logFile),stat=lstatSync(file);assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size<=8*1024*1024);
  assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"),run.sha256);
  execFileSync("bash",[join(sourceRoot,"scripts/ci/worker-isolation-tap-summary.sh"),file],{timeout:10000,stdio:"pipe"});
}
const connector=new NativeLimaWorkerConnector(input.bridge);
const before=await connector.health(AbortSignal.timeout(10000));assert.equal(before.runtime_attestation.guest_boot_id,guest.bootId);
const action={execution_id:randomUUID(),task_id:randomUUID(),lease_epoch:1,base_main_commit_hash:input.baselineCommit,deadline:new Date(Date.now()+45000).toISOString(),allowed_files:["src/**"],public_context:"Public provider-free native acceptance"};
const submission=await connector.execute(action,AbortSignal.timeout(30000));
assert.equal(submission.kind,"artifact");
if(submission.kind!=="artifact")throw new Error("Artifact required");
assert.deepEqual(submission.files,[{action:"write",path:"src/value.txt",content_base64:Buffer.from("native acceptance\n").toString("base64"),mode:"100644"}]);
assert.equal(canonicalizeJson(await connector.execute(action,AbortSignal.timeout(15000))),canonicalizeJson(submission));
await assert.rejects(connector.execute({...action,lease_epoch:2},AbortSignal.timeout(10000)));
const after=await connector.health(AbortSignal.timeout(10000));assert.equal(after.runtime_attestation.guest_boot_id,guest.bootId);
assert.equal(git(["rev-parse","HEAD"]),input.bridge.profile.sourceSha);
assert.equal(git(["status","--porcelain"]),"");
const receipt={schemaVersion:"sf-native-host-acceptance-v1",status:"HOST_BRIDGE_PASSED",sourceSha:input.bridge.profile.sourceSha,host:{os:"macOS",version:execFileSync("/usr/bin/sw_vers",["-productVersion"],{encoding:"utf8"}).trim(),kernel:release(),arch:process.arch,node:process.version},limaVersion:"2.3.0",binarySha256:input.bridge.binarySha256,profile:input.bridge.profile,measurements:after.runtime_attestation,guestManifestSha256:createHash("sha256").update(manifestBytes).digest("hex"),executionId:action.execution_id,artifactSha256:createHash("sha256").update(canonicalizeJson(submission)).digest("hex"),checks:["guest-suites-zero-skips","source-profile-boot-binding","signed-https-worker","artifact","durable-replay","epoch-conflict"]};
writeFileSync(outputPath,JSON.stringify(receipt,null,2)+"\n",{mode:0o600,flag:"wx"});
process.stdout.write("Native host bridge evidence written. Team G7 acceptance remains a separate decision.\n");

}
void main().catch(()=>{process.stderr.write("ERR_NATIVE_HOST_ACCEPTANCE: failed; no acceptance receipt issued\n");process.exitCode=1;});
