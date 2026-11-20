import type { LiveModelProviderClient } from "@software-factory/adapter-sdk";

/** Compile-only fixture proving the readiness audit follows structural subtypes. */
interface WrappedModelClient extends LiveModelProviderClient {
  readonly wrapperMarker: "fixture";
}

export function dispatchThroughSubtypeFixture(provider: WrappedModelClient) {
  return provider.complete({ systemPrompt: "fixture", userPrompt: "fixture" });
}
