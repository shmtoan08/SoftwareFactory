import { createCoreApiRuntime } from "./runtime.ts";

async function main(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof createCoreApiRuntime>> | null = null;
  let closing = false;
  let shutdownSignal: string | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    shutdownSignal = signal;
    if (closing || !runtime) {
      return;
    }
    closing = true;
    console.error(`core-api shutting down on ${signal}...`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (err: unknown) {
      console.error("Error shutting down core-api:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  runtime = await createCoreApiRuntime();
  if (shutdownSignal) {
    await shutdown(shutdownSignal);
    return;
  }

  console.log(
    JSON.stringify({
      service: "core-api",
      mode: runtime.mode,
      coreApiEndpoint: runtime.coreApiEndpoint,
      gatewayEndpoint: runtime.gatewayEndpoint,
    })
  );
}

void main().catch((err: unknown) => {
  console.error("Failed to start core-api:", err);
  process.exit(1);
});
