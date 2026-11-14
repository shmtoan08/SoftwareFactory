import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FirecrackerApiClient, type FirecrackerApiConfig } from "../../wna/src/firecracker-api-client.ts";

interface Call { method: string; path: string; body: string; headers: IncomingHttpHeaders; }
interface Fixture {
  config: FirecrackerApiConfig;
  calls: Call[];
  state: string;
  info: Record<string, unknown>;
  reply?: (call: Call, response: ServerResponse) => void;
}
async function fixture(run: (fx: Fixture) => Promise<void>): Promise<void> {
  // Short canonical path: Unix domain sockets have a platform-specific path limit.
  const dir = realpathSync(mkdtempSync("/tmp/sf-fc-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "api.sock");
  const fx: Fixture = { config: { socketPath, instanceId: "factory-vm", applicationName: "Firecracker", testOnlyEmulator: true }, calls: [], state: "Running", info: {} };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const call: Call = { method: req.method!, path: req.url!, body: Buffer.concat(chunks).toString(), headers: req.headers };
    fx.calls.push(call);
    if (fx.reply) { fx.reply(call, res); return; }
    if (call.method === "GET" && call.path === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "factory-vm", app_name: "Firecracker", vmm_version: "1.18.0", state: fx.state, ...fx.info }));
    } else if (call.method === "PATCH" && call.path === "/vm") {
      const body: unknown = JSON.parse(call.body);
      assert.deepEqual(Object.keys(body as object), ["state"]);
      const state = (body as { state: string }).state;
      assert.ok(state === "Paused" || state === "Resumed");
      fx.state = state === "Paused" ? "Paused" : "Running";
      res.writeHead(204); res.end();
    } else { res.writeHead(400); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  try { await run(fx); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}
const lifecycle = (fx: Fixture, extra: Partial<FirecrackerApiConfig> = {}) => new FirecrackerApiClient({ ...fx.config, allowLifecycle: true, dedicatedInstance: true, ...extra });

describe("Firecracker v1.18.0 management API (real Unix socket fixture, no KVM)", () => {
  it("probes exact identity/version and marks evidence as transport only", async () => fixture(async (fx) => {
    const result = await new FirecrackerApiClient(fx.config).probe();
    assert.deepEqual(result, { backend: "firecracker-api", identity: "factory-vm", state: "Running", version: "1.18.0", evidenceKind: "api-transport", kernelIsolationVerified: false });
    assert.deepEqual(fx.calls.map((call) => [call.method, call.path, call.body]), [["GET", "/", ""]]);
  }));
  for (const info of [{ id: "other" }, { app_name: "other" }, { vmm_version: "1.19.0-dev" }, { state: "Stopped" }, { state: ["Running"] }, { extra: true }]) {
    it(`rejects incompatible identity/schema ${JSON.stringify(info)}`, async () => fixture(async (fx) => {
      fx.info = info;
      await assert.rejects(lifecycle(fx).pause(), /ERR_FIRECRACKER_IDENTITY/);
      assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0]!.method, "GET");
    }));
  }
  for (const flag of ["allowLifecycle", "dedicatedInstance"] as const) {
    it(`requires ${flag} opt-in before any API calls`, async () => fixture(async (fx) => {
      await assert.rejects(lifecycle(fx, { [flag]: false }).pause(), /LIFECYCLE_DISABLED/);
      assert.equal(fx.calls.length, 0);
    }));
  }
  it("pauses/resumes using exact PATCH states with preflight and postflight", async () => fixture(async (fx) => {
    const client = lifecycle(fx);
    assert.equal((await client.pause()).state, "Paused");
    assert.equal((await client.resume()).state, "Running");
    assert.deepEqual(fx.calls.map((call) => [call.method, call.path, call.body]), [
      ["GET", "/", ""], ["PATCH", "/vm", '{"state":"Paused"}'], ["GET", "/", ""],
      ["GET", "/", ""], ["PATCH", "/vm", '{"state":"Resumed"}'], ["GET", "/", ""],
    ]);
  }));
  it("does not mutate when already in the target state", async () => fixture(async (fx) => {
    const client = lifecycle(fx);
    await client.resume(); fx.state = "Paused"; await client.pause();
    assert.ok(fx.calls.every((call) => call.method === "GET"));
  }));
  it("rejects Not started without boot/action calls", async () => fixture(async (fx) => {
    fx.state = "Not started";
    await assert.rejects(lifecycle(fx).pause(), /ERR_FIRECRACKER_STATE/);
    assert.equal(fx.calls.length, 1);
  }));
  for (const mode of ["mismatch", "dropped", "timeout", "error"] as const) {
    it(`reports uncertain ${mode} mutation without retry or cleanup`, async () => fixture(async (fx) => {
      fx.reply = (call, res) => {
        if (call.method === "GET") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "factory-vm", app_name: "Firecracker", vmm_version: "1.18.0", state: "Running" }));
        } else if (mode === "mismatch") { res.writeHead(204); res.end(); }
        else if (mode === "dropped") res.destroy();
        else if (mode === "error") { res.writeHead(500); res.end("PRIVATE_PROVIDER_SECRET"); }
        // timeout deliberately leaves the response open.
      };
      await assert.rejects(lifecycle(fx, { timeoutMs: 150 }).pause(), (err: Error) => {
        assert.match(err.message, /OUTCOME_UNCERTAIN/); assert.doesNotMatch(err.message, /PRIVATE_PROVIDER_SECRET/); return true;
      });
      assert.equal(fx.calls.filter((call) => call.method === "PATCH").length, 1);
      assert.ok(fx.calls.every((call) => call.path === "/" || call.path === "/vm"));
    }));
  }
  it("reports uncertain on abort after mutation reaches the endpoint", async () => fixture(async (fx) => {
    const abort = new AbortController();
    fx.reply = (call, res) => {
      if (call.method === "PATCH") { abort.abort(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "factory-vm", app_name: "Firecracker", vmm_version: "1.18.0", state: "Running" }));
    };
    await assert.rejects(lifecycle(fx).pause(abort.signal), /OUTCOME_UNCERTAIN/);
    assert.equal(fx.calls.filter((call) => call.method === "PATCH").length, 1);
  }));
  it("treats postflight identity drift as uncertain without a compensating mutation", async () => fixture(async (fx) => {
    let mutated = false;
    fx.reply = (call, res) => {
      if (call.method === "PATCH") { mutated = true; res.writeHead(204); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: mutated ? "other-vm" : "factory-vm", app_name: "Firecracker", vmm_version: "1.18.0", state: mutated ? "Paused" : "Running" }));
    };
    await assert.rejects(lifecycle(fx).pause(), /OUTCOME_UNCERTAIN/);
    assert.equal(fx.calls.length, 3);
    assert.equal(fx.calls.filter((call) => call.method === "PATCH").length, 1);
  }));
  it("rejects reconnection after preflight without sending a mutation", async () => fixture(async (fx) => {
    fx.reply = (_call, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ id: "factory-vm", app_name: "Firecracker", vmm_version: "1.18.0", state: "Running" }));
    };
    await assert.rejects(lifecycle(fx).pause(), /OUTCOME_UNCERTAIN/);
    assert.equal(fx.calls.length, 1);
  }));
  for (const mode of ["redirect", "bad-json", "bad-utf8", "overflow", "truncated", "content-type", "headers", "gzip"] as const) {
    it(`bounds/rejects ${mode} responses without raw output leakage`, async () => fixture(async (fx) => {
      fx.reply = (_call, res) => {
        const headers = { "content-type": mode === "content-type" ? "text/plain" : "application/json", ...(mode === "gzip" ? { "content-encoding": "gzip" } : {}), ...(mode === "headers" ? { "x-large": "a".repeat(9000) } : {}), ...(mode === "truncated" ? { "content-length": "1000" } : {}) };
        res.writeHead(mode === "redirect" ? 302 : 200, headers);
        if (mode === "truncated") { res.flushHeaders(); res.write("{"); setTimeout(() => res.destroy(), 10); }
        else res.end(mode === "overflow" ? "x".repeat(10000) : mode === "bad-utf8" ? Buffer.from([255]) : "PRIVATE_PROVIDER_SECRET");
      };
      await assert.rejects(new FirecrackerApiClient({ ...fx.config, maxResponseBytes: 512 }).probe(), (err: Error) => {
        assert.match(err.message, /ERR_FIRECRACKER_/); assert.doesNotMatch(err.message, /PRIVATE_PROVIDER_SECRET/); return true;
      });
      assert.equal(fx.calls.length, 1);
    }));
  }
  it("enforces an absolute deadline during streaming, not just idle timeout", async () => fixture(async (fx) => {
    let interval: NodeJS.Timeout | undefined;
    fx.reply = (_call, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      interval = setInterval(() => res.write(" "), 5);
      res.once("close", () => clearInterval(interval));
    };
    const begin = Date.now();
    try { await assert.rejects(new FirecrackerApiClient({ ...fx.config, timeoutMs: 80 }).probe(), /ERR_FIRECRACKER_TRANSPORT/); }
    finally { clearInterval(interval); }
    assert.ok(Date.now() - begin < 1500);
  }));
  it("aborts before connecting and during requests", async () => fixture(async (fx) => {
    const before = AbortSignal.abort();
    await assert.rejects(new FirecrackerApiClient(fx.config).probe(before), /ABORTED/);
    assert.equal(fx.calls.length, 0);
    fx.reply = () => {};
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 40);
    try { await assert.rejects(new FirecrackerApiClient(fx.config).probe(abort.signal), /TRANSPORT/); }
    finally { clearTimeout(timer); }
    assert.equal(fx.calls.length, 1);
  }));
  it("does not forward environment credentials or proxy configuration", async () => fixture(async (fx) => {
    const prior = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://PRIVATE_PROVIDER_SECRET.invalid";
    try {
      await new FirecrackerApiClient(fx.config).probe();
      assert.doesNotMatch(JSON.stringify(fx.calls), /PRIVATE_PROVIDER_SECRET/);
      assert.equal(fx.calls[0]!.headers.authorization, undefined);
    } finally { if (prior === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = prior; }
  }));
  it("rejects bad constructor types and limits", async () => fixture(async (fx) => {
    for (const extra of [{ allowLifecycle: "true" }, { dedicatedInstance: 1 }, { testOnlyEmulator: "false" }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { maxResponseBytes: 0.5 }, { maxResponseBytes: 1048577 }, { socketPath: "relative.sock" }, { instanceId: "../vm" }]) {
      assert.throws(() => new FirecrackerApiClient({ ...fx.config, ...extra } as FirecrackerApiConfig), /CONFIG/);
    }
  }));
  it("enforces platform guard unless explicit boolean fixture mode", async () => fixture(async (fx) => {
    if (process.platform === "linux") assert.equal(new FirecrackerApiClient({ ...fx.config, testOnlyEmulator: false }).config.testOnlyEmulator, false);
    else assert.throws(() => new FirecrackerApiClient({ ...fx.config, testOnlyEmulator: false }), /PLATFORM_UNSUPPORTED/);
  }));
  it("requires a private real socket and canonical private parent", async () => fixture(async (fx) => {
    chmodSync(fx.config.socketPath, 0o666);
    assert.throws(() => new FirecrackerApiClient(fx.config), /SOCKET_TRUST/);
    chmodSync(fx.config.socketPath, 0o600);
    const parent = join(fx.config.socketPath, "..");
    assert.throws(() => new FirecrackerApiClient({ ...fx.config, socketPath: parent }), /CONFIG|SOCKET_TRUST/);
    const file = join(fx.config.socketPath, "..", "regular");
    writeFileSync(file, "not socket");
    assert.throws(() => new FirecrackerApiClient({ ...fx.config, socketPath: realpathSync(file) }), /SOCKET_TRUST/);
    const link = join(fx.config.socketPath, "..", "linked");
    symlinkSync(fx.config.socketPath, link);
    assert.throws(() => new FirecrackerApiClient({ ...fx.config, socketPath: realpathSync(file).replace("regular", "linked") }), /SOCKET_TRUST/);
  }));
  it("rejects a replaced socket inode even with the same advertised identity", async () => fixture(async (fx) => {
    const client = new FirecrackerApiClient(fx.config);
    let contacted = false;
    const other = createServer((_req, res) => { contacted = true; res.end(); });
    const replacement = join(fx.config.socketPath, "..", "replacement.sock");
    await new Promise<void>((resolve, reject) => { other.once("error", reject); other.listen(replacement, resolve); });
    chmodSync(replacement, 0o600);
    try {
      renameSync(replacement, fx.config.socketPath);
      await assert.rejects(client.probe(), /SOCKET_CHANGED/);
      assert.equal(contacted, false); assert.equal(fx.calls.length, 0);
    } finally { other.closeAllConnections(); await new Promise<void>((resolve) => other.close(() => resolve())); }
  }));
  it("rejects a writable parent or symlinked parent path", async () => fixture(async (fx) => {
    const parent = realpathSync(join(fx.config.socketPath, ".."));
    chmodSync(parent, 0o777);
    try { assert.throws(() => new FirecrackerApiClient(fx.config), /SOCKET_TRUST/); }
    finally { chmodSync(parent, 0o700); }
    const link = join(parent, "parent-link"); symlinkSync(parent, link);
    assert.throws(() => new FirecrackerApiClient({ ...fx.config, socketPath: join(link, "api.sock") }), /SOCKET_TRUST/);
  }));
  it("rejects missing socket after construction without reconnect/retry", async () => fixture(async (fx) => {
    const client = new FirecrackerApiClient(fx.config);
    unlinkSync(fx.config.socketPath);
    await assert.rejects(client.probe(), /SOCKET_TRUST/);
    assert.equal(fx.calls.length, 0);
  }));
});
