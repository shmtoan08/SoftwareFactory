import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { arch, release } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { type AgentRuntimeAdapter, validateNativeWorkerAttestation } from "@software-factory/adapter-sdk";
import { nativeVmProfileSha256, type NativeVmProfile } from "./native-lima-worker.ts";
import { LinuxWorkerEndpointRunner, type LinuxWorkerEndpointRunnerConfig } from "./worker-endpoint-runner.ts";
import { createWorkerEndpointServer } from "./worker-endpoint.ts";

export interface NativeWorkerServiceConfig extends Omit<LinuxWorkerEndpointRunnerConfig,"adapter"> {
  readonly profile:NativeVmProfile;
  readonly sourceRoot:string;
  readonly principalId:string;
  readonly workerId:string;
  readonly signingSecret:string;
  readonly port:number;
}
function protectedRoot(path:string):void {
  if (!isAbsolute(path) || realpathSync(path)!==path) throw new Error("ERR_NATIVE_GUEST_PATH");
  // Task UIDs must not replace this root through writable ancestor directories.
  let current=path;
  while(true){const s=lstatSync(current);if(!s.isDirectory() || s.uid!==0 || (s.mode & 0o022)!==0)throw new Error("ERR_NATIVE_GUEST_PATH");const parent=dirname(current);if(parent===current)break;current=parent;}
}
/** Root-owned bootstrap inside the dedicated guest. No HTTP/host command can choose an adapter. */
export function createNativeWorkerService(config:NativeWorkerServiceConfig,adapter:AgentRuntimeAdapter) {
  if (process.platform!=="linux" || process.getuid?.()!==0 || !Number.isInteger(config.port) || config.port<1024 || config.port>65535) throw new Error("ERR_NATIVE_GUEST_HOST");
  const profileHash=nativeVmProfileSha256(config.profile);
  protectedRoot(config.sourceRoot);protectedRoot(config.stateDir);protectedRoot(config.worktreeBaseDir);
  if (realpathSync(fileURLToPath(import.meta.url))!==join(config.sourceRoot,"packages/wna/src/native-worker-service.ts"))throw new Error("ERR_NATIVE_GUEST_SOURCE");
  const roots=[config.sourceRoot,config.stateDir,config.worktreeBaseDir];
  if (!config.worktreeBaseDir.startsWith("/var/lib/") || roots.some((a,i)=>roots.some((b,j)=>i!==j && (a===b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)))))throw new Error("ERR_NATIVE_GUEST_PATH");
  for(const repo of Object.values(config.baselineCommitRegistry))protectedRoot(repo);
  // Plain Lima must not expose host filesystem mounts even to the service guest.
  if (readFileSync("/proc/self/mountinfo","utf8").split("\n").some(line=>/ - (?:virtiofs|9p|fuse\.sshfs) /.test(line)))throw new Error("ERR_NATIVE_GUEST_HOST_MOUNT");
  if (!config.cgroupRoot || !config.cgroupRoot.startsWith("/sys/fs/cgroup/")) throw new Error("ERR_NATIVE_GUEST_CGROUP");
  const git=(args:string[])=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",...args],{cwd:config.sourceRoot,env:{PATH:"/usr/bin:/bin",HOME:"/nonexistent",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0"},encoding:"utf8",timeout:10000,maxBuffer:1048576,stdio:["ignore","pipe","pipe"]}).trim();
  if (git(["rev-parse","HEAD"])!==config.profile.sourceSha || git(["status","--porcelain","--untracked-files=normal"])!=="")throw new Error("ERR_NATIVE_GUEST_SOURCE");
  // Root owns every tracked input; service source cannot be edited by a task UID.
  for(const file of git(["ls-files","-z"]).split("\0").filter(Boolean)){
    const path=join(config.sourceRoot,file),s=lstatSync(path);
    if(!s.isFile() || s.isSymbolicLink() || s.uid!==0 || (s.mode & 0o022)!==0)throw new Error("ERR_NATIVE_GUEST_SOURCE");
  }
  const osRelease=readFileSync("/etc/os-release","utf8");
  const osField=(key:string)=>osRelease.split("\n").find(line=>line.startsWith(`${key}=`))?.slice(key.length+1).replace(/^"|"$/g,"")??"unknown";
  const measurements=validateNativeWorkerAttestation({schema_version:"sf-native-worker-v1",instance_id:config.profile.instanceId,source_sha:config.profile.sourceSha,profile_sha256:profileHash,guest_kernel:release(),guest_os:`${osField("ID")}:${osField("VERSION_ID")}`,guest_arch:arch(),guest_boot_id:readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim()});
  const runner=new LinuxWorkerEndpointRunner({...config,adapter,additionalMaskedPaths:[config.sourceRoot,"/run","/home","/root","/etc/sf-native","/Users","/Volumes"]});
  const server=createWorkerEndpointServer({tenantNamespace:config.tenantNamespace,principalId:config.principalId,workerId:config.workerId,provider:adapter.writerProvider,model:adapter.writerModel,signingSecret:config.signingSecret,stateDir:config.stateDir,runner,port:config.port,runtimeAttestation:measurements});
  return {server,measurements,verifyHealth:(signal:AbortSignal)=>runner.health(signal)};
}

/** Deterministic provider-free adapter for native acceptance only; no AI/provider execution. */
export function createNativeAcceptanceWorkerService(config:NativeWorkerServiceConfig) {
  const adapter:AgentRuntimeAdapter={runtimeId:"fake-agent-harness",writerProvider:"native-acceptance",writerModel:"provider-free",prepareInvocation:async()=>({binaryPath:process.execPath,args:["-e","require('node:fs').writeFileSync('src/value.txt','native acceptance\\n')"],sanitizedEnv:{PATH:"/usr/bin:/bin"},timeoutMs:3000}),parseExecutionResult:async()=>{throw new Error("Native acceptance exports only filesystem artifacts");}};
  return createNativeWorkerService(config,adapter);
}
