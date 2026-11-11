import {
  type ControlPlaneStore,
  PostgresControlPlaneRepository,
  type PostgresPoolConfig,
  PostgresRuntimePool,
  createControlPlaneStoreFromEnv,
} from "@software-factory/database";
import {
  AgentGatewayHttpServer,
  EphemeralGitPushTokenService,
  type GatewayTransientFaultHook,
} from "./index.ts";

export interface CreateAgentGatewayRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requirePostgres?: boolean;
  readonly poolConfig?: PostgresPoolConfig;
  readonly store?: ControlPlaneStore;
  readonly tokenService?: EphemeralGitPushTokenService;
  readonly pushTokenSigningSecret?: string;
  readonly host?: string;
  readonly port?: number;
  readonly deadlineMs?: number;
  readonly simulateControlPlaneOutage?: boolean;
  readonly authorizeCheckHook?: (signal: AbortSignal) => Promise<void>;
  readonly transientFaultHook?: GatewayTransientFaultHook;
  readonly startServer?: boolean;
}

export interface AgentGatewayRuntime {
  readonly mode: "postgres" | "memory";
  readonly pool: PostgresRuntimePool | null;
  readonly store: ControlPlaneStore;
  readonly tokenService: EphemeralGitPushTokenService;
  readonly gatewayHttp: AgentGatewayHttpServer;
  readonly endpoint: { readonly port: number; readonly url: string; readonly baseUrl: string } | null;
  close(): Promise<void>;
}

function parseOptionalPort(raw: string | undefined): number | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid port value '${raw}'`);
  }
  return parsed;
}

/**
 * Production runtime bootstrap for `AgentGatewayHttpServer` (`M5-FIX-11`).
 * Automatically selects `PostgresRuntimePool` + `PostgresControlPlaneRepository` whenever
 * `DATABASE_URL` or `PGHOST` is configured (or throws fail-closed when `requirePostgres: true`).
 */
export async function createAgentGatewayRuntime(
  options?: CreateAgentGatewayRuntimeOptions
): Promise<AgentGatewayRuntime> {
  const env = options?.env ?? process.env;
  const requirePostgres = options?.requirePostgres ?? env.SF_REQUIRE_POSTGRES === "1";

  const ownedHandle = options?.store
    ? null
    : createControlPlaneStoreFromEnv({
        env,
        poolConfig: options?.poolConfig,
        requirePostgres,
      });

  const store = options?.store ?? ownedHandle!.store;
  const pool =
    ownedHandle?.pool ??
    (store instanceof PostgresControlPlaneRepository ? store.pool : null);
  const mode: "postgres" | "memory" =
    ownedHandle?.mode ?? (store instanceof PostgresControlPlaneRepository ? "postgres" : "memory");

  const tokenService =
    options?.tokenService ??
    new EphemeralGitPushTokenService({
      signingSecret: options?.pushTokenSigningSecret ?? env.SF_GIT_PUSH_TOKEN_SECRET,
    });

  const host = options?.host ?? env.GATEWAY_HOST ?? env.HOST ?? "127.0.0.1";
  const port = options?.port ?? parseOptionalPort(env.GATEWAY_PORT ?? env.PORT) ?? 0;

  const gatewayHttp = new AgentGatewayHttpServer({
    store,
    tokenService,
    host,
    port,
    deadlineMs: options?.deadlineMs,
    simulateControlPlaneOutage: options?.simulateControlPlaneOutage,
    authorizeCheckHook: options?.authorizeCheckHook,
    transientFaultHook: options?.transientFaultHook,
  });

  let endpoint: { readonly port: number; readonly url: string; readonly baseUrl: string } | null = null;
  if (options?.startServer !== false) {
    try {
      endpoint = await gatewayHttp.start();
    } catch (err: unknown) {
      await Promise.allSettled([
        gatewayHttp.close(),
        ownedHandle ? ownedHandle.close() : Promise.resolve(),
      ]);
      throw err;
    }
  }

  return {
    mode,
    pool,
    store,
    tokenService,
    gatewayHttp,
    endpoint,
    close: async () => {
      try {
        await gatewayHttp.close();
      } finally {
        if (ownedHandle) {
          await ownedHandle.close();
        }
      }
    },
  };
}
