// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import { loadConfig } from "./config-gateway-operations.ts";
import { nextRequestVersion } from "./config-state-model.ts";
import { configSnapshot, configHarness, disposeConfig } from "./config-suite.test-support.ts";

const snapshot = (count: number) => configSnapshot({ count }, `hash-${count}`);
const refreshError = "current refresh unavailable";

function mutationHarness(
  tail: (read: number, pending: Promise<ConfigSnapshot>) => Promise<ConfigSnapshot>,
) {
  const read = deferred<ConfigSnapshot>();
  const started = deferred();
  let reads = 0;
  const request = vi.fn((method: string) => {
    if (method !== "config.get") {
      return Promise.resolve({ ok: true });
    }
    if (++reads === 1) {
      return Promise.resolve(snapshot(1));
    }
    if (reads === 2) {
      started.resolve();
      return read.promise;
    }
    return tail(reads, read.promise);
  });
  return { ...configHarness(request), read, started, reads: () => reads };
}

function mutate(runtimeConfig: ReturnType<typeof mutationHarness>["runtimeConfig"]) {
  return runtimeConfig.runExternalMutation((client) =>
    client.request("plugins.setEnabled", { pluginId: "test-plugin", enabled: true }),
  );
}

type MutationRefresh = { ok: true } | { ok: false; error: string };
function expectMutation(result: Promise<unknown>, refresh: MutationRefresh = { ok: true }) {
  return expect(result).resolves.toEqual({ ok: true, value: { ok: true }, refresh });
}

describe("external mutation config refresh", () => {
  it.each([
    { order: "mutation read first", failure: false },
    { order: "successor read first", failure: false },
    { order: "mutation read first", failure: true },
    { order: "successor read first", failure: true },
  ])(
    "uses the actual successor result with $order (failure: $failure)",
    async ({ order, failure }) => {
      const successorRead = deferred<ConfigSnapshot>();
      const flight = mutationHarness((reads) => {
        if (reads === 3) {
          return successorRead.promise;
        }
        throw new Error(`Unexpected configuration read ${reads}`);
      });
      const { runtimeConfig, state } = flight;
      await runtimeConfig.ensureLoaded();
      const mutation = mutate(runtimeConfig);
      await flight.started.promise;
      runtimeConfig.setRaw('{"count":9}');
      // The generation-triggered page refresh starts after the RPC and its own fresh read.
      const refresh = runtimeConfig.refresh();
      expect(flight.reads()).toBe(3);
      const finishSuccessor = () =>
        failure
          ? successorRead.reject(new Error(refreshError))
          : successorRead.resolve(snapshot(3));
      if (order === "mutation read first") {
        flight.read.resolve(snapshot(2));
        await flight.read.promise;
        finishSuccessor();
      } else {
        finishSuccessor();
        await refresh;
        flight.read.resolve(snapshot(2));
      }
      await refresh;
      await expectMutation(mutation, failure ? { ok: false, error: refreshError } : { ok: true });
      expect(state.configSnapshot?.hash).toBe(failure ? "hash-1" : "hash-3");
      expect(state).toMatchObject({
        lastError: failure ? refreshError : null,
        configRaw: '{"count":9}',
        configDraftBaseHash: "hash-1",
        configFormDirty: true,
      });
    },
  );
  it.each(["write acknowledgement", "disconnect", "same-client reconnect", "dispose"] as const)(
    "ends a pending mutation refresh on %s without waiting for its transport reply",
    async (retirement) => {
      const flight = mutationHarness((reads, pending) =>
        reads === 3 ? Promise.resolve(snapshot(3)) : pending,
      );
      const { runtimeConfig, state, publish } = flight;
      await runtimeConfig.ensureLoaded();
      const mutation = mutate(runtimeConfig);
      await flight.started.promise;
      if (retirement === "write acknowledgement") {
        // Config write acknowledgements invalidate older reads without issuing a replacement.
        nextRequestVersion(state, "config");
      } else if (retirement === "disconnect" || retirement === "same-client reconnect") {
        publish(false);
        if (retirement === "same-client reconnect") {
          publish(true);
        }
      } else {
        disposeConfig(runtimeConfig);
      }
      const error =
        retirement === "write acknowledgement"
          ? "The configuration refresh was superseded by a configuration write."
          : "Connection changed before the configuration update was refreshed.";
      await expectMutation(mutation, { ok: false, error });
      expect(flight.reads()).toBe(retirement === "same-client reconnect" ? 3 : 2);
      flight.read.resolve(snapshot(99));
      await flight.read.promise;
      expect(state.configSnapshot?.hash).toBe(
        retirement === "same-client reconnect" ? "hash-3" : "hash-1",
      );
    },
  );

  it("does not borrow a successor's apply outcome for reconnect draft recovery", async () => {
    const stale = deferred<ConfigSnapshot>();
    const request = vi.fn((method: string) => {
      if (method !== "config.get") {
        throw new Error(`Unexpected request ${method}`);
      }
      return request.mock.calls.length === 1 ? stale.promise : Promise.resolve(snapshot(2));
    });
    const { state } = configHarness(request);
    const captureDraft = vi.fn();
    const original = loadConfig(state, { beforeApplySnapshot: captureDraft });
    await expect(loadConfig(state)).resolves.toBe(true);
    stale.resolve(snapshot(1));
    await expect(original).resolves.toBe(false);
    expect(captureDraft).not.toHaveBeenCalled();
    expect(state.configSnapshot?.hash).toBe("hash-2");
  });

  it("rechecks connection ownership after the pre-adoption recovery callback", async () => {
    const request = vi.fn(async () => snapshot(1));
    const { state, publish } = configHarness(request);
    await expect(loadConfig(state, { beforeApplySnapshot: () => publish(false) })).resolves.toBe(
      false,
    );
    expect(state.configSnapshot).toBeNull();
  });
  it("records a successor started synchronously by a loading-state subscriber", async () => {
    const flight = mutationHarness((reads) => Promise.resolve(snapshot(reads)));
    const { runtimeConfig, state } = flight;
    let successor: Promise<void> | undefined;
    let observe = false;
    runtimeConfig.subscribe((current) => {
      if (observe && current.configLoading) {
        observe = false;
        successor = runtimeConfig.refresh();
      }
    });
    await runtimeConfig.ensureLoaded();
    observe = true;
    const mutation = mutate(runtimeConfig);
    await expectMutation(mutation);
    await successor;
    expect(flight.reads()).toBe(3);
    expect(state.configSnapshot?.hash).toBe("hash-3");
    flight.read.resolve(snapshot(2));
    await flight.read.promise;
    expect(state.configSnapshot?.hash).toBe("hash-3");
  });
});
