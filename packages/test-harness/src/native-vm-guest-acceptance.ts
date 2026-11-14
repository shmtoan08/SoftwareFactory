import { dirname } from "node:path";
/** Explicit operator-run Linux guest entrypoint. No VM installation or host control. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync,mkdtempSync,readFileSync,realpathSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch,release } from "node:os";
import { nativeVmProfileSha256,type NativeVmProfile } from "@software-factory/wna";
async function main():Promise<void> {
if(process.platform!=="linux" || process.getuid?.()!==0)throw new Error("Native guest acceptance requires Linux root; no fallback");
const profilePath=process.argv[2];
if(!profilePath)throw new Error("Usage: native-vm-guest-acceptance.ts PRIVATE_PROFILE_JSON");
const parent=lstatSync(dirname(profilePath));if(parent.uid!==0 || !parent.isDirectory() || (parent.mode&0o077)!==0 || realpathSync(profilePath)!==profilePath)throw new Error("Private profile root required");
const stat=lstatSync(profilePath);
if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==0 || (stat.mode&0o077)!==0 || stat.size>65536)throw new Error("Private root-owned profile required");
const profile=JSON.parse(readFileSync(profilePath,"utf8")) as NativeVmProfile,profileHash=nativeVmProfileSha256(profile);
const sourceRoot=realpathSync(process.cwd());
if(process.env.SF_NATIVE_SOURCE_ROOT!==sourceRoot || !process.env.SF_WORKER_TEST_CGROUP_ROOT)throw new Error("Explicit source root and delegated cgroup root required");
const git=(args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd:sourceRoot,env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},encoding:"utf8",timeout:10000,stdio:"pipe"}).trim();
if(git(["rev-parse","HEAD"])!==profile.sourceSha || git(["status","--porcelain"])!=="")throw new Error("Source SHA/clean checkout required");
const evidenceRoot=mkdtempSync("/var/lib/sf-native-evidence-");
const definitions=[
  {name:"worker",file:"worker.tap",command:process.execPath,args:["--test","--test-concurrency=1","--test-reporter=tap","packages/test-harness/src/native-worker-guest.test.ts","packages/test-harness/src/m6c3-worker-endpoint-linux-smoke.ts"]},
  {name:"isolation",file:"isolation.tap",command:"bash",args:["scripts/ci/worker-isolation-linux.sh","--strict-linux"]},
];
const runs=definitions.map(definition=>{
  const log=execFileSync(definition.command,definition.args,{cwd:sourceRoot,env:{PATH:process.env.PATH??"/usr/bin:/bin",LANG:"C.UTF-8",SF_NATIVE_SOURCE_ROOT:sourceRoot,SF_WORKER_TEST_CGROUP_ROOT:process.env.SF_WORKER_TEST_CGROUP_ROOT!,SF_STRICT_LINUX:"1"},timeout:180000,maxBuffer:8*1024*1024,stdio:["ignore","pipe","pipe"]});
  const file=join(evidenceRoot,definition.file);writeFileSync(file,log,{mode:0o600,flag:"wx"});
  execFileSync("bash",["scripts/ci/worker-isolation-tap-summary.sh",file],{cwd:sourceRoot,timeout:10000,stdio:"pipe"});
  return {name:definition.name,logFile:definition.file,sha256:createHash("sha256").update(log).digest("hex")};
});
if(git(["status","--porcelain"])!=="" || git(["rev-parse","HEAD"])!==profile.sourceSha)throw new Error("Source changed during acceptance");
const manifest={schemaVersion:"sf-native-guest-acceptance-v1",status:"PASSED",sourceSha:profile.sourceSha,profileHash,bootId:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim(),guestKernel:release(),guestArch:arch(),nodeVersion:process.version,runs};
writeFileSync(join(evidenceRoot,"guest-manifest.json"),JSON.stringify(manifest,null,2)+"\n",{mode:0o600,flag:"wx"});
process.stdout.write(`Guest suites completed. Evidence: ${evidenceRoot}\n`);

}
void main().catch(()=>{process.stderr.write("ERR_NATIVE_GUEST_ACCEPTANCE: failed; no acceptance receipt issued\n");process.exitCode=1;});
