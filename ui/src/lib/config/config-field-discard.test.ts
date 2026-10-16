// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { REDACTED_SENTINEL } from "../config-form-utils.ts";
import { loadedConfig, configRequest } from "./config-suite.test-support.ts";
import { createConfigServerMock, createDeferredSetServerMock } from "./config-test-harness.ts";

beforeEach(() => vi.useFakeTimers());
const secretRef = (id: string) => ({ source: "file", provider: "team", id });

async function rejectedEdit(applied = false) {
  const server = createConfigServerMock();
  if (applied) {
    await server.request("config.set", { raw: '{"count":1}', baseHash: server.currentHash() });
  }
  let reject = true;
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.set" && reject) {
      reject = false;
      throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" });
    }
    return server.request(method, params);
  });
  const harness = await loadedConfig(request, true);
  harness.runtimeConfig.patchForm(["count"], 2);
  await harness.runtimeConfig.flushFormChanges();
  const snapshot = await server.request("config.get");
  return { server, request, snapshot, ...harness };
}

describe("field-scoped config draft cancellation", () => {
  it.each(["absent", "authored-empty", "sibling"])(
    "restores %s ancestor containers without creating a new write on Cancel",
    async (scenario) => {
      const saved = { plugins: { entries: { demo: { enabled: true } } } };
      const request = configRequest(
        { config: saved, raw: JSON.stringify(saved), hash: "saved", valid: true },
        async (method) => {
          if (method === "config.set") {
            throw new GatewayRequestError({ code: "INVALID_REQUEST", message: "Write rejected" });
          }
          return {};
        },
      );
      const { runtimeConfig, state } = await loadedConfig(request, true);
      const parent = ["plugins", "entries", "demo", "config", "search"];
      runtimeConfig.patchForm([...parent, "apiKey"], secretRef("/new-key"));
      await runtimeConfig.flushFormChanges();
      if (scenario === "sibling") {
        runtimeConfig.patchForm([...parent, "mode"], "web");
      }
      await expect(runtimeConfig.discardFormValue([...parent, "apiKey"])).resolves.toBe(true);
      const demo =
        scenario === "sibling"
          ? { enabled: true, config: { search: { mode: "web" } } }
          : { enabled: true };
      expect(state.configForm).toEqual({ plugins: { entries: { demo } } });
      expect(state.configFormDirty).toBe(scenario === "sibling");
      if (scenario === "sibling") {
        runtimeConfig.setWritesSuspended(true);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
    },
  );

  it("waits for a pending acknowledgement and preserves its committed value", async () => {
    const server = createDeferredSetServerMock();
    const { runtimeConfig, state } = await loadedConfig(server.request, true);
    runtimeConfig.patchForm(["count"], 2);
    const save = runtimeConfig.flushFormChanges();
    const cancel = runtimeConfig.discardFormValue(["count"]);
    server.firstSet.resolve({});
    await save;
    await expect(cancel).resolves.toBe(true);
    expect(state.configForm).toEqual({ count: 2 });
    expect(server.submissions).toHaveLength(1);
  });

  it.each(["same-value", "sibling", "raw", "connection"])(
    "does not let a delayed cancellation replace newer %s intent",
    async (change) => {
      const { runtimeConfig, state, request, server, publish, snapshot } = await rejectedEdit();
      const read = createDeferred<typeof snapshot>();
      request.mockImplementationOnce(() => read.promise);
      const cancel = runtimeConfig.discardFormValue(["count"]);
      if (change === "same-value") {
        runtimeConfig.patchForm(["count"], 2);
      } else if (change === "sibling") {
        runtimeConfig.patchForm(["other"], "new edit");
      } else {
        publish(false);
      }
      read.resolve(snapshot);
      await expect(cancel).resolves.toBe(change === "sibling");
      if (change === "sibling") {
        expect(state.configForm).toEqual({ count: 1, other: "new edit" });
        await expect(runtimeConfig.flushFormChanges()).resolves.toBe(true);
        expect(server.submissions.map((entry) => JSON.parse(entry.raw))).toEqual([
          { count: 1, other: "new edit" },
        ]);
      } else {
        expect(state.configForm).toEqual({ count: 2 });
      }
    },
  );

  it.each(["uncommitted", "exact", "redacted"])(
    "reconciles an unknown write only when the saved bytes confirm it (%s)",
    async (outcome) => {
      const confirmed = outcome === "exact";
      const server = createConfigServerMock();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.set") {
          await server.request(method, params);
          throw new Error("Transport acknowledgement unavailable");
        }
        const result = await server.request(method, params);
        if (method === "config.get" && outcome === "redacted" && server.submissions.length > 0) {
          const config = { count: secretRef(REDACTED_SENTINEL) };
          return { ...result, config, raw: JSON.stringify(config) };
        }
        return result;
      });
      const { runtimeConfig, state } = await loadedConfig(request, true);
      const value = outcome === "redacted" ? secretRef("/new-key") : 2;
      runtimeConfig.patchForm(["count"], value);
      await runtimeConfig.flushFormChanges();
      await expect(runtimeConfig.discardFormValue(["count"])).resolves.toBe(confirmed);
      expect(state.configForm).toEqual({ count: value });
      expect(state.configFormDirty).toBe(!confirmed);
      if (!confirmed) {
        await expect(
          runtimeConfig.patch({ raw: { unrelated: true }, note: "synthetic toggle" }),
        ).resolves.toBe(false);
        expect(request.mock.calls.some(([method]) => method === "config.patch")).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
    },
  );

  it("keeps a newer explicit refresh's failure after a superseded cancel read rejects", async () => {
    const { runtimeConfig, state, request, snapshot } = await rejectedEdit();
    const read = createDeferred<typeof snapshot>();
    request.mockImplementationOnce(() => read.promise);
    const cancel = runtimeConfig.discardFormValue(["count"]);
    request.mockRejectedValueOnce(new Error("Newer read unavailable"));
    await runtimeConfig.refresh();
    read.reject(new Error("Superseded cancel read unavailable"));
    await expect(cancel).resolves.toBe(false);
    expect(state.configForm).toEqual({ count: 2 });
    expect(state.lastError).toBe("Newer read unavailable");
  });

  it("keeps the cancel read error when applied-config polling overlaps its rejection", async () => {
    const { runtimeConfig, state, request, snapshot } = await rejectedEdit(true);
    expect(state.lastError).toContain("Write rejected");
    const read = createDeferred<typeof snapshot>();
    request.mockImplementationOnce(() => read.promise);
    const cancel = runtimeConfig.discardFormValue(["count"]);
    // The applied-revision timer fires while Cancel's config.get is pending.
    await vi.advanceTimersByTimeAsync(250);
    read.reject(new Error("Config read unavailable"));
    await expect(cancel).resolves.toBe(false);
    expect(state.configForm).toEqual({ count: 2 });
    expect(state.lastError).toContain("Config read unavailable");
    expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
  });
});
