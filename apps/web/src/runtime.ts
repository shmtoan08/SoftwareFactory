import {
  type CoreApiRuntime,
  type CoreApiService,
  type CreateCoreApiRuntimeOptions,
  createCoreApiRuntime,
} from "@software-factory/core-api";
import type { PostgresRuntimePool } from "@software-factory/database";
import {
  WebApprovalConsoleController,
  WebApprovalConsoleHttpServer,
} from "./index.ts";

export interface CreateControlPlaneStackRuntimeOptions
  extends Omit<CreateCoreApiRuntimeOptions, "host" | "port" | "startServer"> {
  readonly coreApi?: CoreApiService;
  readonly coreApiHost?: string;
  readonly coreApiPort?: number;
  readonly webHost?: string;
  readonly webPort?: number;
  readonly startCoreApiHttp?: boolean;
  readonly startServer?: boolean;
}

export interface ControlPlaneStackRuntime {
  readonly mode: "postgres" | "memory" | "external";
  readonly pool: PostgresRuntimePool | null;
  readonly coreApiRuntime: CoreApiRuntime | null;
  readonly coreApi: CoreApiService;
  readonly controller: WebApprovalConsoleController;
  readonly webHttp: WebApprovalConsoleHttpServer;
  readonly webEndpoint: { readonly port: number; readonly baseUrl: string } | null;
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
 * Production runtime bootstrap for `WebApprovalConsoleHttpServer` + paired Control Plane stack (`M5-FIX-11`).
 * Unless a pre-built `coreApi` is injected, delegates to `createCoreApiRuntime` which selects
 * `PostgresRuntimePool` + `PostgresControlPlaneRepository` when `DATABASE_URL` or `PGHOST` is configured.
 */
export async function createControlPlaneStackRuntime(
  options?: CreateControlPlaneStackRuntimeOptions
): Promise<ControlPlaneStackRuntime> {
  const env = options?.env ?? process.env;
  const shouldStart = options?.startServer !== false;

  const coreApiRuntime = options?.coreApi
    ? null
    : await createCoreApiRuntime({
        env,
        requirePostgres: options?.requirePostgres,
        poolConfig: options?.poolConfig,
        store: options?.store,
        authSecret: options?.authSecret,
        pushTokenSigningSecret: options?.pushTokenSigningSecret,
        reviewerSigningSecret: options?.reviewerSigningSecret,
        snapshotRootDir: options?.snapshotRootDir,
        defaultProjectId: options?.defaultProjectId,
        host: options?.coreApiHost ?? env.CORE_API_HOST ?? "127.0.0.1",
        port: options?.coreApiPort ?? parseOptionalPort(env.CORE_API_PORT) ?? 0,
        gatewayHost: options?.gatewayHost,
        gatewayPort: options?.gatewayPort,
        withGatewayHttp: options?.withGatewayHttp,
        gatewayDeadlineMs: options?.gatewayDeadlineMs,
        transientFaultHook: options?.transientFaultHook,
        verifyPolicy: options?.verifyPolicy,
        enableTestFaultInjection: options?.enableTestFaultInjection,
        defaultModelConfig: options?.defaultModelConfig,
        promptRegistry: options?.promptRegistry,
        modelPricingOverrides: options?.modelPricingOverrides,
        clockFn: options?.clockFn,
        startServer: options?.startCoreApiHttp ?? shouldStart,
      });

  const coreApi = options?.coreApi ?? coreApiRuntime!.coreApi;
  const controller = new WebApprovalConsoleController(coreApi);
  const webHost = options?.webHost ?? env.WEB_HOST ?? env.HOST ?? "127.0.0.1";
  const webPort = options?.webPort ?? parseOptionalPort(env.WEB_PORT ?? env.PORT) ?? 0;

  const webHttp = new WebApprovalConsoleHttpServer({
    controller,
    host: webHost,
    port: webPort,
  });

  let webEndpoint: { readonly port: number; readonly baseUrl: string } | null = null;
  if (shouldStart) {
    try {
      webEndpoint = await webHttp.start();
    } catch (err: unknown) {
      await Promise.allSettled([
        webHttp.stop(),
        coreApiRuntime ? coreApiRuntime.close() : Promise.resolve(),
      ]);
      throw err;
    }
  }

  return {
    mode: coreApiRuntime ? coreApiRuntime.mode : "external",
    pool: coreApiRuntime ? coreApiRuntime.pool : null,
    coreApiRuntime,
    coreApi,
    controller,
    webHttp,
    webEndpoint,
    close: async () => {
      try {
        await webHttp.stop();
      } finally {
        if (coreApiRuntime) {
          await coreApiRuntime.close();
        }
      }
    },
  };
}
