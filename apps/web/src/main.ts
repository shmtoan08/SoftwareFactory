import { createControlPlaneStackRuntime } from "./runtime.ts";

async function main(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof createControlPlaneStackRuntime>> | null = null;
  let closing = false;
  let shutdownSignal: string | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    shutdownSignal = signal;
    if (closing || !runtime) {
      return;
    }
    closing = true;
    console.error(`web-approval-console shutting down on ${signal}...`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (err: unknown) {
      console.error("Error shutting down web-approval-console:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  runtime = await createControlPlaneStackRuntime();
  if (shutdownSignal) {
    await shutdown(shutdownSignal);
    return;
  }

  console.log(
    JSON.stringify({
      service: "web-approval-console",
      mode: runtime.mode,
      webEndpoint: runtime.webEndpoint,
      coreApiEndpoint: runtime.coreApiRuntime?.coreApiEndpoint ?? null,
      gatewayEndpoint: runtime.coreApiRuntime?.gatewayEndpoint ?? null,
    })
  );
}

void main().catch((err: unknown) => {
  console.error("Failed to start web-approval-console:", err);
  process.exit(1);
});
