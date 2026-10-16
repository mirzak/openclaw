import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RuntimeAuthProfileStore } from "../agents/auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  notifySkillsWatchAvailable,
  registerSkillsChangeListener,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import type { ChatMetadataRuntimeDeps } from "./server-methods/chat-metadata-facts.js";
import { createChatMetadataOwner } from "./server-methods/chat-metadata-runtime.test-support.js";
import { createPreparedReadHandler } from "./server-methods/prepared-read.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { dispatchSharedRead, invalidateSharedReadResponses } from "./shared-read-responses.js";

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  fail: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  readStartup: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  registerAuthListener: vi.fn(),
  registerModelListener: vi.fn(),
  registerSkillsListener: vi.fn(),
  unregisterAuthListener: vi.fn(),
  unregisterModelListener: vi.fn(),
  unregisterSkillsListener: vi.fn(),
}));

vi.mock("./server-methods/chat-metadata-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-metadata-runtime.js")>()),
  createGatewayChatMetadataRuntime: mocks.createRuntime,
}));
vi.mock("../agents/auth-profiles/runtime-snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/runtime-snapshots.js")>()),
  registerRuntimeAuthProfileStoreMutationListener: mocks.registerAuthListener,
}));
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/refresh.js")>()),
  registerSkillsChangeListener: mocks.registerSkillsListener,
}));

const { createGatewayChatMetadataLifecycle } = await import("./server-chat-metadata-lifecycle.js");
const { ChatMetadataSnapshotUnavailableError } =
  await import("./server-methods/chat-metadata-facts.js");
const authSnapshots = await vi.importActual<
  typeof import("../agents/auth-profiles/runtime-snapshots.js")
>("../agents/auth-profiles/runtime-snapshots.js");
type MetadataRuntime = typeof import("./server-methods/chat-metadata-runtime.js");

function realRuntime(
  actual: MetadataRuntime,
  params: Parameters<MetadataRuntime["createGatewayChatMetadataRuntime"]>[0],
  deps: Partial<ChatMetadataRuntimeDeps>,
) {
  return actual.createGatewayChatMetadataRuntime({
    ...params,
    deps: {
      getPreparedAuthStore: () => ({ version: 1, profiles: {} }),
      getSkillsVersion: () => 0,
      getPluginRegistryVersion: () => 0,
      buildCommands: async () => ({ commands: [] }),
      ...deps,
    },
  });
}

function expectBroadcast(broadcast: GatewayRequestContext["broadcast"], payload: object) {
  expect(broadcast).toHaveBeenCalledExactlyOnceWith("chat.metadata.changed", payload, {
    dropIfSlow: true,
  });
}

const config = {} as OpenClawConfig;
const tokenStore = (token = "synthetic-token"): RuntimeAuthProfileStore => ({
  version: 1,
  profiles: { "test:primary": { type: "token", provider: "test", token } },
});
const context = {} as GatewayRequestContext;
const sidecarOwners = new Set<ReturnType<typeof createGatewaySidecarStopOwner>>();

afterEach(async () => {
  for (const owner of sidecarOwners) {
    await owner.stop();
  }
  sidecarOwners.clear();
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createRuntime.mockReturnValue({
    fail: mocks.fail,
    invalidate: mocks.invalidate,
    read: mocks.read,
    readStartup: mocks.readStartup,
    refresh: mocks.refresh,
    stop: mocks.stop,
  });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.registerAuthListener.mockReturnValue(mocks.unregisterAuthListener);
  mocks.registerModelListener.mockReturnValue(mocks.unregisterModelListener);
  mocks.registerSkillsListener.mockReturnValue(mocks.unregisterSkillsListener);
});

async function createLifecycle(warn = vi.fn()) {
  const sidecarOwner = createGatewaySidecarStopOwner();
  sidecarOwners.add(sidecarOwner);
  return {
    lifecycle: await createGatewayChatMetadataLifecycle({
      getConfig: () => config,
      log: { warn } as never,
    }),
    sidecarOwner,
    warn,
  };
}

it.each([false, true])(
  "publishes usage completion (failed: %s) without rebuilding metadata and retires its listener on stop",
  async (failed) => {
    const broadcast = vi.fn();
    const { lifecycle, sidecarOwner } = await createLifecycle();
    await lifecycle.attachContext({ ...context, broadcast }, sidecarOwner.publish);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.refresh.mockClear();
    expect(sidecarOwner.snapshot()).toHaveLength(1);
    publishSessionCostUsageUpdated("main", failed);
    expectBroadcast(broadcast, {
      agentId: "main",
      usageUpdatedAt: expect.any(Number),
      modelCatalogChanged: false,
      authChanged: false,
      commandsChanged: false,
      ...(failed ? { usageRefreshFailed: true } : {}),
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
    let runtimeStopped = false;
    mocks.stop.mockImplementationOnce(async () => {
      await nextEventLoopTurn();
      runtimeStopped = true;
    });
    await sidecarOwner.stop();
    expect(runtimeStopped).toBe(true);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.unregisterAuthListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterModelListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterSkillsListener).toHaveBeenCalledOnce();
    publishSessionCostUsageUpdated("main");
    expect(broadcast).toHaveBeenCalledTimes(1);
  },
);

it("retires model choices at its config commit before pending metadata settles", async () => {
  const broadcast = vi.fn();
  let committedConfig: OpenClawConfig = {};
  const ownedContext = {
    ...context,
    broadcast,
    getCommittedRuntimeConfig: () => committedConfig,
  };
  const entered = createDeferred();
  const release = createDeferred();
  mocks.refresh.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const { lifecycle, sidecarOwner } = await createLifecycle();
  const attaching = lifecycle.attachContext(ownedContext, sidecarOwner.publish);
  try {
    await entered.promise;
    publishOperatorRoleConfigChange({});
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { auth: { profiles: { account: { provider: "fixture", mode: "api_key" } } } };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { ...committedConfig, models: { mode: "replace" } };
    publishOperatorRoleConfigChange(ownedContext);
    expectBroadcast(broadcast, { modelSelectionChanged: true, commandsChanged: false });
    broadcast.mockClear();
    committedConfig = {
      ...committedConfig,
      agents: { defaults: { modelPolicy: { allow: ["fixture/allowed"] } } },
    };
    publishOperatorRoleConfigChange(ownedContext);
    expectBroadcast(broadcast, { modelSelectionChanged: true, commandsChanged: false });
  } finally {
    release.resolve();
    await attaching;
    await sidecarOwner.stop();
  }
  broadcast.mockClear();
  publishOperatorRoleConfigChange(ownedContext);
  expect(broadcast).not.toHaveBeenCalled();
});

async function createRealMetadataLifecycle(
  options: {
    attach?: boolean;
    ownerAvailable?: boolean;
    authStore?: RuntimeAuthProfileStore;
    skillsWorkspaceDir?: string;
  } = {},
) {
  const actual = await vi.importActual<MetadataRuntime>(
    "./server-methods/chat-metadata-runtime.js",
  );
  let owner = createChatMetadataOwner(config, "before-publication");
  let ownerAvailable = options.ownerAvailable ?? true;
  let latestRefresh = Promise.resolve();
  const refresh = vi.fn<() => Promise<void>>();
  const buildCommands = vi.fn(async () => ({ commands: [] }));
  const broadcast = vi.fn();
  if (options.skillsWorkspaceDir) {
    owner = { ...owner, workspaceDir: options.skillsWorkspaceDir };
    mocks.registerSkillsListener.mockImplementation(registerSkillsChangeListener);
  }
  if (options.authStore) {
    authSnapshots.setRuntimeAuthProfileStoreSnapshot(options.authStore, owner.agentDir);
    mocks.registerAuthListener.mockImplementation(
      authSnapshots.registerRuntimeAuthProfileStoreMutationListener,
    );
  }
  mocks.createRuntime.mockImplementation(
    (params: Parameters<MetadataRuntime["createGatewayChatMetadataRuntime"]>[0]) => {
      const runtime = realRuntime(actual, params, {
        getPreparedOwner: () => (ownerAvailable ? owner : undefined),
        ...(options.authStore
          ? { getPreparedAuthStore: authSnapshots.getPreparedRuntimeAuthProfileStoreSnapshotCore }
          : { getAuthStoreRevision: () => 0 }),
        getSkillsVersion: options.skillsWorkspaceDir ? getSkillsSnapshotVersion : () => 0,
        buildCommands,
        buildProjection: async ({ facts }) => ({
          modelCatalog: facts.modelCatalog.entries,
          read: () => ({ models: facts.modelCatalog.entries }),
          isCurrent: () => true,
        }),
      });
      refresh.mockImplementation(() => {
        latestRefresh = runtime.refresh();
        return latestRefresh;
      });
      return { ...runtime, refresh };
    },
  );
  const { lifecycle, sidecarOwner, warn } = await createLifecycle();
  const attach = () =>
    lifecycle.attachContext(
      { broadcast } as unknown as GatewayRequestContext,
      sidecarOwner.publish,
    );
  if (options.attach !== false) {
    await attach();
  }
  const modelEvent = (event: { phase: string; error?: Error; modelFactsChanged?: boolean }) =>
    mocks.registerModelListener.mock.calls[0]![0](event);
  const authEvent = () => mocks.registerAuthListener.mock.calls[0]![0]();
  const stop = async () => {
    await sidecarOwner.stop();
    if (options.authStore) {
      authSnapshots.clearRuntimeAuthProfileStoreSnapshotCore(owner.agentDir);
    }
  };
  onTestFinished(stop);
  return {
    lifecycle,
    read: () => lifecycle.read({ agentId: "main" }),
    reset: () => {
      refresh.mockClear();
      broadcast.mockClear();
    },
    attach,
    buildCommands,
    broadcast,
    refresh,
    publishAuthStore(store: RuntimeAuthProfileStore) {
      authSnapshots.updateRuntimeAuthProfileStoreSnapshot(store, owner.agentDir);
      return latestRefresh;
    },
    warn,
    modelEvent,
    replaceOwner() {
      owner = createChatMetadataOwner(config, "after-publication");
      ownerAvailable = true;
      modelEvent({ phase: "published" });
    },
    invalidateOwner() {
      ownerAvailable = false;
      modelEvent({ phase: "invalidated" });
    },
    events: {
      auth: () => authEvent(),
      owner: () => modelEvent({ phase: "invalidated" }),
    },
    stop,
  };
}

describe("gateway chat metadata lifecycle", () => {
  it("ignores coverage-only skills events and publishes completed revisions", async () => {
    resetSkillsRefreshStateForTest();
    const workspaceDir = "/tmp/chat-metadata-skills";
    const version = getSkillsSnapshotVersion(workspaceDir);
    const harness = await createRealMetadataLifecycle({ skillsWorkspaceDir: workspaceDir });
    onTestFinished(resetSkillsRefreshStateForTest);
    const before = await harness.read();
    harness.reset();
    notifySkillsWatchAvailable({ workspaceDir, sourceScope: {} });
    expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
    expect(await harness.read()).toEqual(before);
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.broadcast).not.toHaveBeenCalled();
    expect(harness.buildCommands).toHaveBeenCalledOnce();

    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    await harness.read();
    expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.buildCommands).toHaveBeenCalledTimes(2);
    expectBroadcast(harness.broadcast, { modelCatalogChanged: false, authChanged: false });
  });

  it("keeps inherited bookkeeping from refreshing or broadcasting metadata", async () => {
    const store = tokenStore();
    const harness = await createRealMetadataLifecycle({ authStore: store });
    const before = await harness.read();
    harness.reset();
    for (let count = 1; count <= 3; count += 1) {
      await harness.publishAuthStore({
        ...store,
        runtimeInheritsMainState: true,
        lastGood: { test: "test:primary" },
        usageStats: {
          "test:primary": {
            lastUsed: count,
            errorCount: count,
            failureCounts: { timeout: count },
            lastFailureAt: count,
            lastProbeAt: count,
          },
        },
      });
      expect(harness.refresh).not.toHaveBeenCalled();
      harness.modelEvent({ phase: "catalog-published", modelFactsChanged: false });
      expect(await harness.read()).toEqual(before);
      harness.refresh.mockClear();
    }
    expect(harness.buildCommands).toHaveBeenCalledOnce();
    expect(harness.broadcast).not.toHaveBeenCalled();
  });

  it("refreshes and broadcasts metadata when a token rotates", async () => {
    const store = tokenStore();
    const harness = await createRealMetadataLifecycle({ authStore: store });
    await harness.read();
    harness.reset();
    await harness.publishAuthStore(tokenStore("rotated-token"));
    expect(harness.refresh).toHaveBeenCalledOnce();
    expectBroadcast(harness.broadcast, {
      modelCatalogChanged: true,
      authChanged: true,
      commandsChanged: false,
    });
    await harness.read();
    expect(harness.buildCommands).toHaveBeenCalledTimes(2);
    await harness.publishAuthStore(store);
    expect(harness.broadcast).toHaveBeenCalledTimes(2);
  });

  it("waits for owner publication when no owner is available", async () => {
    const harness = await createRealMetadataLifecycle({
      attach: false,
      ownerAvailable: false,
    });
    let settled = false;
    let read: Promise<unknown> | undefined;
    try {
      await harness.attach();
      expect(harness.warn).not.toHaveBeenCalled();
      await expect(harness.read()).rejects.toBeInstanceOf(ChatMetadataSnapshotUnavailableError);
      harness.invalidateOwner();
      read = harness
        .read()
        .catch((error: unknown) => error)
        .then((value) => {
          settled = true;
          return value;
        });
      await nextEventLoopTurn();
      expect(harness.warn).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      harness.replaceOwner();
      await expect(read).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "after-publication" })],
      });
    } finally {
      await harness.stop();
      await read;
    }
  });

  it.each(["auth", "owner"] as const)(
    "retains a terminal metadata failure through a later %s invalidation",
    async (event) => {
      const harness = await createRealMetadataLifecycle();
      const failure = new Error("prepared owner publication failed");
      let read: Promise<void> | undefined;
      try {
        harness.invalidateOwner();
        harness.modelEvent({ phase: "failed", error: failure });
        await expect(harness.read()).rejects.toBe(failure);
        harness.events[event]();
        let outcome: unknown = Symbol("pending");
        read = harness
          .read()
          .catch((error: unknown) => error)
          .then((value) => {
            outcome = value;
          });
        await nextEventLoopTurn();

        expect(outcome).toBe(failure);
        harness.replaceOwner();
        await expect(harness.read()).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "after-publication" })],
        });
      } finally {
        await harness.stop();
        await read;
      }
    },
  );

  it("broadcasts settled metadata through the production lifecycle without a failure feedback loop", async () => {
    const actual = await vi.importActual<MetadataRuntime>(
      "./server-methods/chat-metadata-runtime.js",
    );
    const owner = {
      ...createChatMetadataOwner(config, "model"),
      createStores: () => {
        throw new Error("metadata must not create live model stores");
      },
    };
    const getPreparedOwner = vi.fn<() => PreparedModelRuntimeSnapshot | undefined>();
    let available = false;
    let revision = 0;
    const buildProjection = vi.fn(async () => {
      const projection = {
        modelCatalog: owner.modelCatalog.entries,
        models: [{ ...owner.modelCatalog.entries[0], available }],
      };
      return { read: () => projection, isCurrent: () => true };
    });
    mocks.createRuntime.mockImplementation((params) =>
      realRuntime(actual, params, {
        getPreparedOwner,
        getAuthStoreRevision: () => revision,
        buildProjection,
      }),
    );
    const { lifecycle, sidecarOwner } = await createLifecycle();
    const outcomes: unknown[] = [];
    const reads: Promise<void>[] = [];
    const broadcast = vi.fn(() => {
      // Read immediately from the outbound boundary: the replacement must already be settled.
      reads.push(
        lifecycle.read({ agentId: "main" }).then(
          (metadata) => {
            outcomes.push(metadata.models);
          },
          (error: unknown) => {
            outcomes.push(error instanceof Error ? error.message : error);
          },
        ),
      );
    });
    await lifecycle.attachContext(
      { broadcast } as unknown as GatewayRequestContext,
      sidecarOwner.publish,
    );
    await Promise.all(reads);
    expect(outcomes).toEqual([expect.stringContaining("metadata is unavailable")]);
    expect(broadcast).toHaveBeenCalledOnce();
    getPreparedOwner.mockReturnValue(owner);
    const modelListener = mocks.registerModelListener.mock.calls[0]![0];
    const authListener = mocks.registerAuthListener.mock.calls[0]![0];
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toEqual([expect.objectContaining({ available: false })]);

    modelListener({ phase: "invalidated" });
    available = true;
    revision += 1;
    authListener();
    expect(broadcast).toHaveBeenCalledTimes(2);
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));
    expect(outcomes[2]).toEqual([expect.objectContaining({ available: true })]);

    available = false;
    revision += 1;
    authListener();
    await vi.waitFor(() => expect(outcomes).toHaveLength(4));
    expect(outcomes[3]).toEqual([expect.objectContaining({ available: false })]);

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "failed", error: new Error("owner publication failed") });
    await Promise.all(reads);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow("owner publication failed");
    expect(outcomes[4]).toBe("owner publication failed");
    expect(broadcast.mock.calls).toEqual(
      Array.from({ length: 5 }, (_, index) => [
        "chat.metadata.changed",
        {
          modelCatalogChanged: true,
          authChanged: true,
          ...(index === 3 ? { commandsChanged: false } : {}),
        },
        { dropIfSlow: true },
      ]),
    );
  });

  it.each(["build failed", "catalog during attachment", "owner invalidated"] as const)(
    "refreshes subordinate changes after %s catch-up",
    async (startup) => {
      const entered = createDeferred();
      const release = createDeferred();
      if (startup === "build failed") {
        mocks.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
      } else if (startup === "owner invalidated") {
        mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
      } else if (startup === "catalog during attachment") {
        mocks.refresh.mockImplementationOnce(() => {
          entered.resolve();
          return release.promise;
        });
      }
      const { lifecycle, sidecarOwner, warn } = await createLifecycle();
      const attachment = lifecycle.attachContext(context, sidecarOwner.publish);
      try {
        if (startup === "catalog during attachment") {
          await entered.promise;
          expect(mocks.refresh).toHaveBeenCalledOnce();
          mocks.registerModelListener.mock.calls[0]![0]({ phase: "catalog-published" });
          release.resolve();
        }
        await expect(attachment).resolves.toBeUndefined();
        expect(mocks.refresh).toHaveBeenCalledOnce();
        if (startup === "build failed") {
          expect(warn).toHaveBeenCalledWith(
            "chat metadata catch-up refresh failed: Error: metadata unavailable",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        const modelListener = mocks.registerModelListener.mock.calls[0]![0];
        const authListener = mocks.registerAuthListener.mock.calls[0]![0];
        const skillsListener = mocks.registerSkillsListener.mock.calls[0]![0];
        for (const listener of [modelListener, authListener, skillsListener]) {
          expect(listener).toEqual(expect.any(Function));
        }
        if (startup === "owner invalidated") {
          modelListener({ phase: "invalidated" });
          modelListener({ phase: "catalog-published" });
          modelListener({ phase: "catalog-failed", error: new Error("obsolete catalog failed") });
          authListener();
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledOnce();
          expect(warn).not.toHaveBeenCalled();
          modelListener({ phase: "published" });
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          expect(warn).not.toHaveBeenCalled();
        } else {
          authListener();
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledTimes(3);
        }
      } finally {
        release.resolve();
        await attachment;
      }
    },
  );

  it.each([
    ["catalog-observation", false, false, false],
    ["catalog-published", true, false, true],
    ["catalog-published", false, false, false],
    ["catalog-published", undefined, false, true],
    ["catalog-published", false, true, true],
    ["catalog-status", false, false, false],
  ] as const)(
    "refreshes catalog metadata only for a change (%s, facts=%s, status=%s)",
    async (phase, modelFactsChanged, refreshStatusChanged, refreshes) => {
      const { lifecycle, sidecarOwner } = await createLifecycle();
      const requestContext = { ...context, broadcast: vi.fn(), getRuntimeConfig: () => config };
      let pending = true;
      let payloadJson: string | undefined;
      const produce = vi.fn(() => ({ pendingProviders: pending ? ["synthetic"] : undefined }));
      const handler = createPreparedReadHandler(() => ({
        run: (respond) => respond(true, produce()),
      }));
      const options = {
        req: { type: "req", id: "catalog", method: "models.list" },
        params: {},
        client: null,
        context: requestContext,
        isWebchatConnect: () => false,
        respond: (_ok, payload) => {
          payloadJson = JSON.stringify(payload);
        },
      } satisfies GatewayRequestHandlerOptions;
      const sharing = {
        shareKey: () => "catalog",
        shareInvalidationEvents: ["chat.metadata.changed"],
        shareMaxAgeMs: 1_000,
      };
      const read = () => dispatchSharedRead(handler, options, sharing, () => {});
      vi.useFakeTimers();
      try {
        await lifecycle.attachContext(requestContext, sidecarOwner.publish);
        const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
        modelListener({ phase: "published" });
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
        mocks.invalidate.mockClear();
        await read();
        await read();
        expect(produce).toHaveBeenCalledOnce();
        expect(payloadJson).toBe('{"pendingProviders":["synthetic"]}');

        pending = false;
        modelListener({ phase, modelFactsChanged, refreshStatusChanged, agentId: "main" });
        await read();

        expect(payloadJson).toBe("{}");
        if (phase === "catalog-observation") {
          expectBroadcast(requestContext.broadcast, {
            agentId: "main",
            modelCatalogChanged: true,
            authChanged: false,
            commandsChanged: false,
          });
        }
        expect(produce).toHaveBeenCalledTimes(2);
        expect(mocks.invalidate).not.toHaveBeenCalled();
        expect(mocks.refresh).toHaveBeenCalledTimes(refreshes ? 3 : 2);
        if (refreshes) {
          expect(mocks.refresh).toHaveBeenLastCalledWith({
            notifyIfUnchanged: refreshStatusChanged,
          });
        }
      } finally {
        invalidateSharedReadResponses(requestContext.broadcast);
        vi.useRealTimers();
      }
    },
  );
});
