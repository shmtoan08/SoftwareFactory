import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PostgresRlsError } from "@software-factory/database";

let lockBinary: string | undefined;
export async function acquireBootstrapLock(path: string): Promise<{ assertHeld(): void; release(): Promise<void> }> {
  if (!lockBinary) {
    const dir = mkdtempSync(join(tmpdir(), "sf-bootstrap-lock-bin-"));
    try {
      lockBinary = join(dir, "lock");
      execFileSync("cc", ["-O2", "-Wall", "-Werror", resolve(import.meta.dirname, "../../../scripts/native/sf_bootstrap_lock.c"), "-o", lockBinary], { timeout: 15_000, stdio: "pipe" });
    } catch (error) { lockBinary = undefined; rmSync(dir, { recursive: true, force: true }); throw error; }
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  const child = spawn(lockBinary, [path], { stdio: ["pipe", "pipe", "pipe"] });
  let held = false;
  const exited = new Promise<void>((resolveExit) => child.once("close", () => { held = false; resolveExit(); }));
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Bootstrap lock startup timeout")); }, 10_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new PostgresRlsError(code === 75 ? "23505" : "23514", code === 75
        ? "Concurrent Stage 5 bootstrap already reserves trusted_acceptance_dir"
        : "Bootstrap kernel lock unavailable")));
      child.stdout.once("data", (data: Buffer) => {
        if (data.toString().trim() !== "LOCKED") { child.kill("SIGKILL"); fail(new Error("Invalid bootstrap lock handshake")); return; }
        clearTimeout(timer); held = true; resolveReady();
      });
    });
  } catch (error) { child.stdin?.end(); await exited; throw error; }
  return {
    assertHeld() { if (!held || child.exitCode !== null) throw new PostgresRlsError("23514", "Bootstrap lock ownership lost"); },
    async release() { child.stdin?.end(); await exited; },
  };
}
