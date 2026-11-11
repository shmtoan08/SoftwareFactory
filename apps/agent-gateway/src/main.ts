import { createAgentGatewayRuntime } from "./runtime.ts";

async function main(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof createAgentGatewayRuntime>> | null = null;
  let closing = false;
  let shutdownSignal: string | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    shutdownSignal = signal;
    if (closing || !runtime) {
      return;
    }
    closing = true;
    console.error(`agent-gateway shutting down on ${signal}...`);
    try {
      await runtime.close();
      process.exit(0);
    } catch (err: unknown) {
      console.error("Error shutting down agent-gateway:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  runtime = await createAgentGatewayRuntime();
  if (shutdownSignal) {
    await shutdown(shutdownSignal);
    return;
  }

  console.log(
    JSON.stringify({
      service: "agent-gateway",
      mode: runtime.mode,
      endpoint: runtime.endpoint,
    })
  );
}

void main().catch((err: unknown) => {
  console.error("Failed to start agent-gateway:", err);
  process.exit(1);
});
