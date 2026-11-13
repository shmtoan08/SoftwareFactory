import { validateDeploymentConfiguration, validateDeploymentStore, type ProductionDeploymentConfiguration } from "./production-deployment.ts";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ModelProviderConfig,
  type PromptRegistry,
  loadModelProviderConfigFromEnv,
} from "@software-factory/adapter-sdk";
import {
  AgentGatewayHttpServer,
  AgentGatewayService,
  EphemeralGitPushTokenService,
  EphemeralReviewerCredentialService,
  type GatewayTransientFaultHook,
} from "@software-factory/agent-gateway";
import {
  type ControlPlaneStore,
  PostgresControlPlaneRepository,
  type PostgresPoolConfig,
  PostgresRuntimePool,
  createControlPlaneStoreFromEnv,
} from "@software-factory/database";
import type { ModelPricingRate } from "@software-factory/shared-types";
import {
  Docker3TierVerifier,
  parseVerifierIsolationPolicy,
  ImmutableSourceSnapshotStore,
} from "@software-factory/verifier";
import { CoreApiHttpServer, type CoreApiVerifyHttpPolicy } from "./http-server.ts";
import { CoreApiService, CoreApiTokenAuthenticator } from "./index.ts";

export interface CreateCoreApiRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requirePostgres?: boolean;
  readonly poolConfig?: PostgresPoolConfig;
  readonly store?: ControlPlaneStore;
  readonly authSecret?: string;
  readonly pushTokenSigningSecret?: string;
  readonly reviewerSigningSecret?: string;
  readonly snapshotRootDir?: string;
  readonly defaultProjectId?: string;
  readonly host?: string;
  readonly port?: number;
  readonly gatewayHost?: string;
  readonly gatewayPort?: number;
  readonly withGatewayHttp?: boolean;
  readonly gatewayDeadlineMs?: number;
  readonly transientFaultHook?: GatewayTransientFaultHook;
  readonly verifyPolicy?: CoreApiVerifyHttpPolicy;
  readonly enableTestFaultInjection?: boolean;
  readonly defaultModelConfig?: ModelProviderConfig;
  readonly promptRegistry?: PromptRegistry;
  readonly modelPricingOverrides?: Readonly<Record<string, ModelPricingRate>>;
  readonly clockFn?: () => Date;
  readonly startServer?: boolean;
  readonly productionDeployment?: ProductionDeploymentConfiguration;
}

export interface CoreApiRuntime {
  readonly mode: "postgres" | "memory";
  readonly pool: PostgresRuntimePool | null;
  readonly store: ControlPlaneStore;
  readonly authenticator: CoreApiTokenAuthenticator;
  readonly snapshotStore: ImmutableSourceSnapshotStore;
  readonly verifier: Docker3TierVerifier;
  readonly coreApi: CoreApiService;
  readonly coreApiHttp: CoreApiHttpServer;
  readonly pushTokenService: EphemeralGitPushTokenService;
  readonly reviewerCredentialService: EphemeralReviewerCredentialService;
  readonly defaultAgentGateway: AgentGatewayService;
  readonly gatewayHttp: AgentGatewayHttpServer | null;
  readonly coreApiEndpoint: { readonly port: number; readonly baseUrl: string } | null;
  readonly gatewayEndpoint: { readonly port: number; readonly url: string; readonly baseUrl: string } | null;
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

function restoreWritableRecursive(targetPath: string): void {
  if (!existsSync(targetPath)) {
    return;
  }
  try {
    const st = statSync(targetPath);
    if (st.isDirectory()) {
      chmodSync(targetPath, 0o755);
      for (const entry of readdirSync(targetPath)) {
        restoreWritableRecursive(join(targetPath, entry));
      }
    } else {
      chmodSync(targetPath, 0o644);
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Production runtime bootstrap for `CoreApiService` + `CoreApiHttpServer` (and optional paired
 * `AgentGatewayHttpServer`) (`M5-FIX-11`).
 * Automatically selects `PostgresRuntimePool` + `PostgresControlPlaneRepository` when `DATABASE_URL`
 * or `PGHOST` (or `poolConfig`) is configured.
 */
export async function createCoreApiRuntime(
  options?: CreateCoreApiRuntimeOptions
): Promise<CoreApiRuntime> {
  const env = options?.env ?? process.env;
  const isolationPolicy = parseVerifierIsolationPolicy(env.SF_VERIFIER_ISOLATION);
  const productionDeployment = { ...options?.productionDeployment, signingSecret: options?.productionDeployment?.signingSecret ?? env.SF_DEPLOYMENT_APPROVAL_SECRET };
  validateDeploymentConfiguration(productionDeployment);
  if (options?.store) validateDeploymentStore(options.store,productionDeployment);
  const productionRequiresPostgres = (Object.keys(productionDeployment.executors ?? {}).length > 0 || Object.keys(productionDeployment.resolutionVerifiers ?? {}).length > 0) && productionDeployment.testOnlyEmulator !== true;
  const requirePostgres = productionRequiresPostgres || (options?.requirePostgres ?? env.SF_REQUIRE_POSTGRES === "1");

  const ownedHandle = options?.store
    ? null
    : createControlPlaneStoreFromEnv({
        env,
        poolConfig: options?.poolConfig,
        requirePostgres,
        clockFn: options?.clockFn,
      });

  const store = options?.store ?? ownedHandle!.store;
  const pool =
    ownedHandle?.pool ??
    (store instanceof PostgresControlPlaneRepository ? store.pool : null);
  const mode: "postgres" | "memory" =
    ownedHandle?.mode ?? (store instanceof PostgresControlPlaneRepository ? "postgres" : "memory");

  let ephemeralSnapshotDir: string | null = null;
  const configuredSnapshotDir = options?.snapshotRootDir ?? env.SF_SNAPSHOT_ROOT_DIR?.trim();
  const snapshotRootDir = configuredSnapshotDir
    ? resolve(configuredSnapshotDir)
    : (ephemeralSnapshotDir = mkdtempSync(join(tmpdir(), "sf-core-api-snapshots-")));

  const snapshotStore = new ImmutableSourceSnapshotStore({ storageDir: snapshotRootDir });
  const verifier = new Docker3TierVerifier({ snapshotStore, isolationPolicy });
  const authenticator = new CoreApiTokenAuthenticator({
    signingSecret: options?.authSecret ?? env.SF_CORE_API_AUTH_SECRET,
    clockFn: options?.clockFn,
  });

  const pushTokenService = new EphemeralGitPushTokenService({
    signingSecret: options?.pushTokenSigningSecret ?? env.SF_GIT_PUSH_TOKEN_SECRET,
    clockFn: options?.clockFn,
  });
  const reviewerCredentialService = new EphemeralReviewerCredentialService({
    signingSecret: options?.reviewerSigningSecret ?? env.SF_REVIEWER_CREDENTIAL_SECRET,
    clockFn: options?.clockFn,
  });
  const defaultAgentGateway = new AgentGatewayService({
    store,
    projectId: options?.defaultProjectId ?? "default",
    reviewerCredentialService,
  });

  const resolvedModelConfig =
    options?.defaultModelConfig ??
    (env.SF_MODEL_PROVIDER?.trim() ? loadModelProviderConfigFromEnv(env) : undefined);

  const coreApi = new CoreApiService(store, {
    authenticator,
    productionDeployment,
    clockFn: options?.clockFn,
    snapshotStore,
    defaultModelConfig: resolvedModelConfig,
    promptRegistry: options?.promptRegistry,
    modelPricingOverrides: options?.modelPricingOverrides,
    env,
  });

  const host = options?.host ?? env.CORE_API_HOST ?? env.HOST ?? "127.0.0.1";
  const port = options?.port ?? parseOptionalPort(env.CORE_API_PORT ?? env.PORT) ?? 0;

  const coreApiHttp = new CoreApiHttpServer({
    coreApi,
    host,
    port,
    snapshotStore,
    defaultVerifier: verifier,
    defaultAgentGateway,
    verifyPolicy: options?.verifyPolicy,
    enableTestFaultInjection: options?.enableTestFaultInjection ?? false,
  });

  const withGateway = options?.withGatewayHttp ?? true;
  const gatewayHttp = withGateway
    ? new AgentGatewayHttpServer({
        store,
        tokenService: pushTokenService,
        host: options?.gatewayHost ?? env.GATEWAY_HOST ?? host,
        port: options?.gatewayPort ?? parseOptionalPort(env.GATEWAY_PORT) ?? 0,
        deadlineMs: options?.gatewayDeadlineMs,
        transientFaultHook: options?.transientFaultHook,
      })
    : null;

  const shouldStart = options?.startServer !== false;
  let coreApiEndpoint: { readonly port: number; readonly baseUrl: string } | null = null;
  let gatewayEndpoint: { readonly port: number; readonly url: string; readonly baseUrl: string } | null =
    null;

  if (shouldStart) {
    try {
      coreApiEndpoint = await coreApiHttp.start();
      if (gatewayHttp) {
        gatewayEndpoint = await gatewayHttp.start();
      }
    } catch (err: unknown) {
      await Promise.allSettled([
        coreApiHttp.stop(),
        gatewayHttp ? gatewayHttp.close() : Promise.resolve(),
      ]);
      if (ownedHandle) {
        await ownedHandle.close();
      }
      if (ephemeralSnapshotDir) {
        restoreWritableRecursive(ephemeralSnapshotDir);
        rmSync(ephemeralSnapshotDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  return {
    mode,
    pool,
    store,
    authenticator,
    snapshotStore,
    verifier,
    coreApi,
    coreApiHttp,
    pushTokenService,
    reviewerCredentialService,
    defaultAgentGateway,
    gatewayHttp,
    coreApiEndpoint,
    gatewayEndpoint,
    close: async () => {
      try {
        await Promise.allSettled([
          coreApiHttp.stop(),
          gatewayHttp ? gatewayHttp.close() : Promise.resolve(),
        ]);
      } finally {
        if (ownedHandle) {
          await ownedHandle.close();
        }
        if (ephemeralSnapshotDir) {
          restoreWritableRecursive(ephemeralSnapshotDir);
          try {
            rmSync(ephemeralSnapshotDir, { recursive: true, force: true });
          } catch {
            // best-effort temp dir cleanup
          }
        }
      }
    },
  };
}
