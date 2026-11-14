/** Operator-only management of a pre-existing Firecracker v1.18.0 API socket.
 * This is transport/state evidence, never KVM, guest cleanup or worker attestation.
 * No boot, shutdown, provisioning, task execution, image or network API is exposed.
 */
import { lstatSync, realpathSync } from "node:fs";
import { Agent, request } from "node:http";
import { dirname, isAbsolute, normalize } from "node:path";
import type { Socket } from "node:net";

export interface FirecrackerApiConfig {
  readonly socketPath: string;
  readonly instanceId: string;
  readonly applicationName: string;
  readonly allowLifecycle?: boolean;
  readonly dedicatedInstance?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly testOnlyEmulator?: boolean;
}
export interface FirecrackerInstanceInfo {
  readonly backend: "firecracker-api";
  readonly identity: string;
  readonly state: "Not started" | "Running" | "Paused";
  readonly version: "1.18.0";
  readonly evidenceKind: "api-transport";
  readonly kernelIsolationVerified: false;
}
interface Operation {
  agent: Agent;
  signal: AbortSignal;
  socket?: Socket;
}
const error = (code: string) => new Error(`ERR_FIRECRACKER_${code}`);
const uncertain = () => error("OUTCOME_UNCERTAIN: VM state may have changed; no automatic retry or cleanup is permitted");

export class FirecrackerApiClient {
  readonly config: Readonly<FirecrackerApiConfig>;
  private readonly pinnedPath: string;
  constructor(config: FirecrackerApiConfig) {
    if (!config || typeof config !== "object") throw error("CONFIG");
    for (const key of ["testOnlyEmulator", "allowLifecycle", "dedicatedInstance"] as const) {
      if (config[key] !== undefined && typeof config[key] !== "boolean") throw error("CONFIG");
    }
    if (process.platform !== "linux" && config.testOnlyEmulator !== true) throw error("PLATFORM_UNSUPPORTED");
    if (typeof config.socketPath !== "string" || !isAbsolute(config.socketPath) || normalize(config.socketPath) !== config.socketPath || config.socketPath.includes("\0") || Buffer.byteLength(config.socketPath) > 100) throw error("CONFIG");
    for (const value of [config.instanceId, config.applicationName]) {
      if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw error("CONFIG");
    }
    const timeoutMs = config.timeoutMs ?? 10000;
    const maxResponseBytes = config.maxResponseBytes ?? 65536;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1048576) throw error("CONFIG");
    this.config = Object.freeze({ socketPath: config.socketPath, instanceId: config.instanceId, applicationName: config.applicationName, timeoutMs, maxResponseBytes, testOnlyEmulator: config.testOnlyEmulator === true, allowLifecycle: config.allowLifecycle === true, dedicatedInstance: config.dedicatedInstance === true });
    this.pinnedPath = this.pathIdentity();
  }

  /** Filesystem checks do not authenticate a malicious root/operator. Such principals remain trusted. */
  private pathIdentity(): string {
    try {
      const parent = dirname(this.config.socketPath);
      if (realpathSync(parent) !== parent) throw error("SOCKET_TRUST");
      const uid = process.getuid?.();
      const dir = lstatSync(parent);
      const socket = lstatSync(this.config.socketPath);
      if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || (dir.uid !== uid && dir.uid !== 0) || !socket.isSocket() || (socket.mode & 0o077) !== 0 || (socket.uid !== uid && socket.uid !== 0)) throw error("SOCKET_TRUST");
      // Parent must itself be protected from replacement by untrusted ancestors.
      let ancestor = dirname(parent);
      for (;;) {
        const stat = lstatSync(ancestor);
        if ((stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))) throw error("SOCKET_TRUST");
        const next = dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
      return `${dir.dev}:${dir.ino}:${socket.dev}:${socket.ino}`;
    } catch { throw error("SOCKET_TRUST"); }
  }

  private async operation<T>(signal: AbortSignal | undefined, action: (op: Operation) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw error("ABORTED");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.config.timeoutMs);
    const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    const op: Operation = { agent, signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal };
    try { return await action(op); }
    finally { clearTimeout(timer); agent.destroy(); }
  }

  private call(op: Operation, method: "GET" | "PATCH", path: "/" | "/vm", state?: "Paused" | "Resumed"): Promise<Buffer> {
    if (op.signal.aborted) return Promise.reject(error("ABORTED"));
    if (this.pathIdentity() !== this.pinnedPath) return Promise.reject(error("SOCKET_CHANGED"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const payload = state === undefined ? undefined : JSON.stringify({ state });
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(method === "PATCH" ? uncertain() : error("TRANSPORT: response invalid, unavailable, aborted or timed out"));
        req.destroy();
      };
      const req = request({ socketPath: this.config.socketPath, host: "localhost", method, path, agent: op.agent, signal: op.signal, maxHeaderSize: 8192, headers: { accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
        const validStatus = res.statusCode === (method === "PATCH" ? 204 : 200);
        if (!validStatus || res.headers["content-encoding"] !== undefined || (method === "GET" && !/^application\/json(?:\s*;|$)/i.test(String(res.headers["content-type"] ?? ""))) || (method === "PATCH" && res.headers["content-length"] !== undefined && res.headers["content-length"] !== "0")) { fail(); res.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.config.maxResponseBytes! || (method === "PATCH" && size !== 0)) { fail(); res.destroy(); return; }
          if (!settled) chunks.push(chunk);
        });
        res.on("error", fail);
        res.on("aborted", fail);
        res.on("end", () => {
          if (settled) return;
          if (!res.complete) { fail(); return; }
          settled = true;
          resolve(Buffer.concat(chunks));
        });
      });
      req.once("socket", (socket) => {
        // Keep preflight, mutation and postflight on one connection; never reconnect a mutation.
        if (op.socket && socket !== op.socket) { fail(); return; }
        op.socket = socket;
      });
      req.on("error", fail);
      req.end(payload);
    });
  }

  private async describe(op: Operation): Promise<FirecrackerInstanceInfo> {
    const raw = await this.call(op, "GET", "/");
    try {
      const info: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      if (!info || typeof info !== "object" || Array.isArray(info)) throw error("IDENTITY");
      const value = info as Record<string, unknown>;
      if (Object.keys(value).length !== 4 || value.id !== this.config.instanceId || value.app_name !== this.config.applicationName || value.vmm_version !== "1.18.0" || typeof value.state !== "string" || !["Not started", "Running", "Paused"].includes(value.state)) throw error("IDENTITY");
      return { backend: "firecracker-api", identity: this.config.instanceId, state: value.state as FirecrackerInstanceInfo["state"], version: "1.18.0", evidenceKind: "api-transport", kernelIsolationVerified: false };
    } catch { throw error("IDENTITY: response schema, instance or version mismatch"); }
  }
  probe(signal?: AbortSignal): Promise<FirecrackerInstanceInfo> { return this.operation(signal, (op) => this.describe(op)); }

  private transition(target: "Paused" | "Running", signal?: AbortSignal): Promise<FirecrackerInstanceInfo> {
    if (!this.config.allowLifecycle || !this.config.dedicatedInstance) return Promise.reject(error("LIFECYCLE_DISABLED"));
    return this.operation(signal, async (op) => {
      const before = await this.describe(op);
      if (before.state === target) return before;
      if (before.state === "Not started") throw error("STATE: VM has not been started by the operator");
      try {
        await this.call(op, "PATCH", "/vm", target === "Paused" ? "Paused" : "Resumed");
        const after = await this.describe(op);
        if (after.state !== target) throw uncertain();
        return after;
      } catch { throw uncertain(); }
    });
  }
  pause(signal?: AbortSignal): Promise<FirecrackerInstanceInfo> { return this.transition("Paused", signal); }
  resume(signal?: AbortSignal): Promise<FirecrackerInstanceInfo> { return this.transition("Running", signal); }
}
