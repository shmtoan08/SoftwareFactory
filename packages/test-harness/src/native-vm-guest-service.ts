import { dirname } from "node:path";
/** Deterministic acceptance service; never starts a paid model or a production adapter. */
import { lstatSync,readFileSync,realpathSync } from "node:fs";
import { createNativeAcceptanceWorkerService,type NativeWorkerServiceConfig } from "@software-factory/wna";
async function main():Promise<void> {
  if(process.platform!=="linux" || process.getuid?.()!==0)throw new Error("Linux root required");
  const path=process.argv[2];if(!path)throw new Error("Private guest service config required");
  const parent=lstatSync(dirname(path));if(parent.uid!==0 || !parent.isDirectory() || (parent.mode&0o077)!==0 || realpathSync(path)!==path)throw new Error("Private config root required");
  const stat=lstatSync(path);if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==0 || (stat.mode&0o077)!==0 || stat.size>65536)throw new Error("Private root-owned config required");
  const config=JSON.parse(readFileSync(path,"utf8")) as NativeWorkerServiceConfig;
  const service=createNativeAcceptanceWorkerService(config);
  await service.verifyHealth(AbortSignal.timeout(10000));
  const listener=await service.server.listen();
  process.stdout.write(JSON.stringify({status:"LISTENING",port:listener.port,measurements:service.measurements})+"\n");
  const stop=()=>{void service.server.close().then(()=>{process.exitCode=0;},()=>{process.stderr.write("ERR_NATIVE_GUEST_SHUTDOWN\n");process.exitCode=1;});};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
}
void main().catch(()=>{process.stderr.write("ERR_NATIVE_GUEST_SERVICE: bootstrap failed\n");process.exitCode=1;});
