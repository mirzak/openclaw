import { GatewayProtocolClient } from "@openclaw/gateway-client/browser";
import { expect, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createConfigCapabilityHarness } from "./config-test-harness.ts";

export function configSnapshot(config: Record<string, unknown>, hash = "hash-1"): ConfigSnapshot {
  return { config, raw: JSON.stringify(config), hash, valid: true, issues: [] };
}

export function configRequest(snapshot: ConfigSnapshot, write: (method: string) => unknown) {
  return vi.fn(async (method: string) => (method === "config.get" ? snapshot : write(method)));
}

export async function expectStoredConfig(
  server: { request: (method: string) => Promise<unknown> },
  config: Record<string, unknown>,
) {
  await expect(server.request("config.get")).resolves.toMatchObject({ config });
}

export function configTransport(
  options: Pick<
    ConstructorParameters<typeof GatewayProtocolClient<Record<string, never>>>[0],
    "createSocket" | "createRequestId"
  >,
) {
  return new GatewayProtocolClient<Record<string, never>>({
    ...options,
    createRequestError: (error) =>
      new GatewayRequestError({
        code: error.code ?? "UNAVAILABLE",
        message: error.message ?? "request failed",
        details: error.details,
      }),
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
}

/** Load the shared editor before exercising writes; read-race tests use the unloaded harness. */
export async function loadedConfig(request: Parameters<typeof createConfigCapabilityHarness>[0]) {
  const harness = createConfigCapabilityHarness(request);
  await harness.runtimeConfig.ensureLoaded();
  return harness;
}
