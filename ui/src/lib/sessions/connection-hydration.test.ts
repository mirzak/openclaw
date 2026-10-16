import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolClient,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { SessionCapability } from "./index.ts";
import {
  createSubscriptionHydrationHarness,
  createTestSessionCapability,
  runningSessionsResult,
  sessionsResult,
} from "./session-capability.test-support.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  vi.useRealTimers();
});
function requestFor(subscribe: () => unknown, list: (params?: Record<string, unknown>) => unknown) {
  return vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.subscribe") {
      return subscribe();
    }
    if (method === "sessions.list") {
      return list(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}
const retryError = (message: string) =>
  new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    retryAfterMs: 100,
  });
function hydration(request: GatewayBrowserClient["request"]) {
  const harness = createSubscriptionHydrationHarness(request);
  cleanup.push(harness.sessions.dispose);
  return harness;
}
function connection(
  request: GatewayBrowserClient["request"],
  selectedId = "main",
  initialFields: {
    sessionKey?: string;
    assistantAgentId?: string;
    selfUser?: { id: string; name: string };
  } = {},
) {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    client: null as GatewayBrowserClient | null,
    phase: "reconnecting" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main" as string | null,
    hello: null,
    canvasPluginSurfaceUrl: null as string | null,
    selfUser: null as { id: string; name?: string } | null,
    ...initialFields,
  };
  let listener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createTestSessionCapability(
    {
      get snapshot() {
        return snapshot;
      },
      subscribe(next) {
        listener = next;
        return () => undefined;
      },
      subscribeEvents: () => () => undefined,
    },
    selectedId,
  );
  return {
    sessions,
    client,
    update(fields: Partial<typeof snapshot>, notify = true) {
      snapshot = { ...snapshot, ...fields };
      if (notify) {
        listener?.(snapshot);
      }
    },
  };
}

const listCallsOf = (request: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  request.mock.calls.filter(([method]) => method === "sessions.list");

const targetedSessionReconciliationCases = [
  {
    description: "targeted session changes",
    reconcile: (sessions: SessionCapability, emitEvent: (event: GatewayEventFrame) => void) => {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:main",
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          status: "done",
        },
      });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        hasActiveRun: false,
        status: "done",
      });
    },
  },
  {
    description: "targeted run-terminal reconciliation",
    reconcile: (sessions: SessionCapability) => {
      expect(
        sessions.reconcileRunTerminal({
          sessionKeys: ["agent:main:main"],
          runId: "run-1",
          status: "done",
          endedAt: 2,
        }),
      ).toBe(true);
    },
  },
];

describe("session connection hydration", () => {
  it("lets a queued foreground refresh supersede an owner-first bootstrap roster", async () => {
    const roster: SessionsListResult = {
      ...sessionsResult([], 1),
      count: 3,
      sessions: [
        {
          key: "agent:main:mine-new",
          kind: "direct",
          updatedAt: 3,
          createdActor: { type: "human", id: "operator" },
        },
        {
          key: "agent:main:mine-old",
          kind: "direct",
          updatedAt: 1,
          createdActor: { type: "human", id: "operator" },
        },
        {
          key: "agent:main:theirs",
          kind: "direct",
          updatedAt: 2,
          createdActor: { type: "human", id: "collaborator" },
        },
      ],
    };
    const bootstrap = createDeferred<SessionsListResult>();
    const queuedResult = sessionsResult(
      [{ key: "agent:other:queued", kind: "direct", updatedAt: 4 }],
      1,
    );
    const queuedList = createDeferred<SessionsListResult>();
    const request = requestFor(
      () => ({ subscribed: true }),
      (params) => (params?.search === "queued" ? queuedList.promise : bootstrap.promise),
    );

    const h = connection(request as unknown as GatewayBrowserClient["request"], "main", {
      sessionKey: "agent:main:mine-new",
      selfUser: { id: "operator", name: "Operator" },
    });
    const { sessions, client } = h;
    h.update({ client, phase: "connected" });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({
          agentId: "main",
          ownerFirst: true,
          limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        }),
      ),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.subscribe",
      {},
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    expect(listCallsOf(request)).toHaveLength(1);
    expect(sessions.state.result).toBeNull();
    const queuedRefresh = sessions.refresh({ agentId: "other", search: "queued", force: true });
    h.update({ selfUser: { id: "collaborator", name: "Collaborator" } });

    bootstrap.resolve(roster);
    await waitForFast(() => expect(listCallsOf(request)).toHaveLength(2));
    expect(sessions.state.result).toBeNull();
    expect(request.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ agentId: "other", search: "queued" }),
    );
    queuedList.resolve(queuedResult);
    await queuedRefresh;
    expect(sessions.state.agentId).toBe("other");
    expect(sessions.state.result).toStrictEqual(queuedResult);
    sessions.dispose();
  });

  it("uses the selected agent before a session key is available", async () => {
    const result = sessionsResult(
      [{ key: "agent:roboclaw:dashboard:one", kind: "direct", updatedAt: 1 }],
      1,
    );
    const request = requestFor(
      () => ({ subscribed: true }),
      () => result,
    );

    const h = connection(request as unknown as GatewayBrowserClient["request"], "roboclaw", {
      sessionKey: "",
      assistantAgentId: "roboclaw",
    });
    const { sessions, client } = h;
    h.update({ client, phase: "connected" });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "roboclaw", includeDerivedTitles: true }),
      ),
    );
    await waitForFast(() => expect(sessions.state.agentId).toBe("roboclaw"));
    expect(sessions.state.result).toStrictEqual(result);
    sessions.dispose();
  });

  it.each(["main", "work"])(
    "rehydrates the current %s roster when identity arrives on the same connection",
    async (agentId) => {
      const pendingList = createDeferred<SessionsListResult>();
      let listCalls = 0;
      const result = sessionsResult([], 1);
      const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          listCalls += 1;
          return listCalls === 1 ? await pendingList.promise : result;
        }
        throw new Error(`Unexpected request: ${method}`);
      });

      const h = connection(request as unknown as GatewayBrowserClient["request"]);
      const { sessions, client } = h;
      h.update({ client, phase: "connected" });
      await waitForFast(() => expect(listCalls).toBe(1));

      h.update({ canvasPluginSurfaceUrl: "https://gateway.example.test/canvas" });
      await Promise.resolve();
      expect(listCalls).toBe(1);

      if (agentId === "work") {
        pendingList.resolve(result);
        await waitForFast(() => expect(sessions.state.result).toStrictEqual(result));
        // A foreground query can select a roster independently of the current route.
        h.update({ sessionKey: "global" }, false);
        await sessions.refresh({ agentId, search: "selected", force: true });
        expect(sessions.state.agentId).toBe(agentId);
      }
      vi.useFakeTimers();
      try {
        h.update({ selfUser: { id: "operator", name: "Operator" } });
        pendingList.resolve(result);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listCalls).toBe(agentId === "work" ? 3 : 2);
      } finally {
        vi.useRealTimers();
      }

      expect(
        request.mock.calls
          .filter(([method]) => method === "sessions.list")
          .map(([, params]) => params),
      ).toEqual([
        expect.not.objectContaining({ ownerFirst: expect.anything() }),
        ...(agentId === "work" ? [expect.objectContaining({ agentId, search: "selected" })] : []),
        expect.objectContaining({
          agentId,
          limit: SIDEBAR_SESSION_ROSTER_LIMIT,
          ...(agentId === "work" ? { search: "selected" } : { ownerFirst: true }),
        }),
      ]);
      await waitForFast(() => expect(sessions.state.agentId).toBe(agentId));
      expect(sessions.state.result?.sessions).toEqual([]);

      // A new connection returns to the application's selected agent.
      h.update({ phase: "reconnecting" });
      h.update({ phase: "connected", sessionKey: "agent:main:main" });
      await waitForFast(() => expect(sessions.state.agentId).toBe("main"));
      sessions.dispose();
    },
  );

  it("recovers primary and managed lists after retrying the current session observer", async () => {
    vi.useFakeTimers();
    const result = sessionsResult([], 1);
    const recoveredResult = sessionsResult(
      [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
      1,
    );
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = requestFor(
      () => {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw retryError("session observer temporarily unavailable");
        }
        return { subscribed: true };
      },
      (params) => {
        if (params?.agentId === "writer") {
          const done = subscriptionCalls > 1;
          return {
            ...result,
            count: 1,
            sessions: [
              {
                key: "agent:writer:linked",
                kind: "direct",
                updatedAt: done ? 2 : 1,
                hasActiveRun: !done,
                status: done ? "done" : "running",
              },
            ],
          } satisfies SessionsListResult;
        }
        listCalls += 1;
        return listCalls === 1 ? result : recoveredResult;
      },
    );

    const { sessions, connect } = hydration(request as unknown as GatewayBrowserClient["request"]);
    const writerQuery = { agentId: "writer", archivedFilter: "all" as const, limit: 2 };
    const stopWriter = sessions.subscribeList(writerQuery, () => undefined);

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.result).toStrictEqual(result);
      expect(sessions.state.error).toBe("session observer temporarily unavailable");
      expect(subscriptionCalls).toBe(1);
      expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
        key: "agent:writer:linked",
        hasActiveRun: true,
        status: "running",
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(subscriptionCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
      expect(sessions.state.result).toStrictEqual(recoveredResult);
      expect(listCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
        key: "agent:writer:linked",
        hasActiveRun: false,
        status: "done",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stopWriter();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("recovers the roster after a subscription deadline without admitting late replies", async () => {
    vi.useFakeTimers();
    const initialResult = sessionsResult([], 1);
    const recoveredResult = sessionsResult(
      [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
      1,
    );
    const sent: Array<{ id: string; method: string }> = [];
    let handlers: GatewayProtocolSocketHandlers | undefined;
    const protocol = new GatewayProtocolClient<Record<string, never>>({
      createSocket: (nextHandlers) => {
        handlers = nextHandlers;
        return {
          isOpen: () => true,
          send: (data) => {
            const frame = JSON.parse(data) as { id: string; method: string };
            sent.push({ id: frame.id, method: frame.method });
          },
          close: () => undefined,
        };
      },
      createRequestId: () => "request",
      buildConnectPlan: () => ({}),
      buildConnectParams: (plan) => plan,
      resolveClose: () => ({ retry: false, notify: false }),
      handshake: { mode: "require-challenge", timeoutMs: 100 },
      reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
    });
    protocol.start();
    const request = protocol.request.bind(protocol) as GatewayBrowserClient["request"];
    const { sessions, connect } = hydration(request);
    const recoveredStates: SessionsListResult[] = [];
    const unsubscribe = sessions.subscribe((next) => {
      if (next.result?.sessions.some((row) => row.key === "agent:main:recovered")) {
        recoveredStates.push(next.result);
      }
    });
    const respond = (id: string, payload: unknown) => {
      handlers?.message(JSON.stringify({ type: "res", id, ok: true, payload }));
    };

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([
        { id: "1:request", method: "sessions.subscribe" },
        { id: "2:request", method: "sessions.list" },
      ]);
      respond("2:request", initialResult);
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.result).toEqual(initialResult);

      await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
      expect(sessions.state.error).not.toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toContainEqual({ id: "3:request", method: "sessions.subscribe" });

      respond("1:request", { status: "accepted" });
      respond("1:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.error).not.toBeNull();
      expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(1);

      respond("3:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toContainEqual({ id: "4:request", method: "sessions.list" });
      respond("4:request", recoveredResult);
      await vi.advanceTimersByTimeAsync(0);

      respond("1:request", { status: "accepted" });
      respond("1:request", { subscribed: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.error).toBeNull();
      expect(sessions.state.result).toEqual(recoveredResult);
      expect(recoveredStates).toEqual([recoveredResult]);
      expect(sent.filter(({ method }) => method === "sessions.subscribe")).toHaveLength(2);
      expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      unsubscribe();
      sessions.dispose();
      protocol.stop();
      vi.useRealTimers();
    }
  });

  it.each([{ description: "an unacknowledged", response: {} }])(
    "rejects $description session observer and retries until acknowledged",
    async ({ response }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      const request = requestFor(
        () => {
          subscriptionCalls += 1;
          return subscriptionCalls === 1 ? response : { subscribed: true };
        },
        () => sessionsResult([], 1),
      );

      const { sessions, connect } = hydration(
        request as unknown as GatewayBrowserClient["request"],
      );

      connect();
      await vi.advanceTimersByTimeAsync(0);

      expect(subscriptionCalls).toBe(1);
      expect(sessions.state.result).not.toBeNull();
      expect(sessions.state.error).toContain("did not activate the session event subscription");

      await vi.advanceTimersByTimeAsync(500);

      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
      expect(listCallsOf(request)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retires observer retries on disconnect before the same client reconnects", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    const request = requestFor(
      () => {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw retryError("session observer temporarily unavailable");
        }
        return { subscribed: true };
      },
      () => sessionsResult([], 1),
    );

    const { sessions, connect, disconnect } = hydration(
      request as unknown as GatewayBrowserClient["request"],
    );

    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(subscriptionCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    disconnect();
    expect(sessions.state.error).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(subscriptionCalls).toBe(1);

    connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBeNull();
    expect(listCallsOf(request)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not recreate a retry timer when an observer-error listener disposes its owner", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    const request = requestFor(
      () => {
        subscriptionCalls += 1;
        throw retryError("observer unavailable during teardown");
      },
      () => sessionsResult([], 1),
    );

    const { sessions, connect } = hydration(request as unknown as GatewayBrowserClient["request"]);
    sessions.subscribe((next) => {
      if (next.error) {
        sessions.dispose();
      }
    });

    connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriptionCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(subscriptionCalls).toBe(1);
  });

  it.each(targetedSessionReconciliationCases)(
    "preserves an active observer failure across $description",
    async ({ reconcile }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      const result = runningSessionsResult();
      const request = requestFor(
        () => {
          subscriptionCalls += 1;
          if (subscriptionCalls === 1) {
            throw retryError("broad session observer unavailable");
          }
          return { subscribed: true };
        },
        () => result,
      );

      const { sessions, connect, emitEvent } = hydration(
        request as unknown as GatewayBrowserClient["request"],
      );

      connect();
      await vi.advanceTimersByTimeAsync(0);
      const observerError = "broad session observer unavailable";
      expect(sessions.state.error).toBe(observerError);

      reconcile(sessions, emitEvent);
      expect(sessions.state.error).toBe(observerError);

      await vi.advanceTimersByTimeAsync(100);
      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
    },
  );

  it.each(targetedSessionReconciliationCases)(
    "preserves a newer operation failure across $description",
    async ({ reconcile }) => {
      vi.useFakeTimers();
      let subscriptionCalls = 0;
      let listCalls = 0;
      const result = runningSessionsResult();
      const request = requestFor(
        () => {
          subscriptionCalls += 1;
          if (subscriptionCalls === 1) {
            throw retryError("broad session observer unavailable");
          }
          return { subscribed: true };
        },
        () => {
          listCalls += 1;
          if (listCalls === 2) {
            throw new Error("newer session list failure");
          }
          return result;
        },
      );

      const { sessions, connect, emitEvent } = hydration(
        request as unknown as GatewayBrowserClient["request"],
      );

      connect();
      await vi.advanceTimersByTimeAsync(0);
      await sessions.refresh({ force: true });
      const operationError = "newer session list failure";
      expect(sessions.state.error).toBe(operationError);

      reconcile(sessions, emitEvent);
      expect(sessions.state.error).toBe(operationError);

      await vi.advanceTimersByTimeAsync(100);
      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.error).toBeNull();
    },
  );

  it("keeps newer session-list failures visible across repeated observer retry failures", async () => {
    vi.useFakeTimers();
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = requestFor(
      () => {
        subscriptionCalls += 1;
        throw retryError(`observer unavailable ${subscriptionCalls}`);
      },
      () => {
        listCalls += 1;
        if (listCalls > 1) {
          throw new Error("newer session list failure");
        }
        return sessionsResult([], 1);
      },
    );

    const { sessions, connect } = hydration(request as unknown as GatewayBrowserClient["request"]);

    connect();
    await vi.advanceTimersByTimeAsync(0);
    await sessions.refresh({ force: true });
    expect(sessions.state.error).toBe("newer session list failure");

    await vi.advanceTimersByTimeAsync(100);

    expect(subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBe("newer session list failure");
  });

  it("does not clear an unrelated list error with the same observer error message", async () => {
    vi.useFakeTimers();
    const pendingCatchUpList = createDeferred<SessionsListResult>();
    const sharedError = retryError("same failure message");
    let subscriptionCalls = 0;
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        if (subscriptionCalls === 1) {
          throw sharedError;
        }
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        listCalls += 1;
        if (listCalls === 2) {
          throw sharedError;
        }
        return listCalls === 3 ? await pendingCatchUpList.promise : sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const { sessions, connect } = hydration(request as unknown as GatewayBrowserClient["request"]);

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      await sessions.refresh({ force: true });
      expect(sessions.state.error).toBe("same failure message");

      await vi.advanceTimersByTimeAsync(100);

      expect(subscriptionCalls).toBe(2);
      expect(listCalls).toBe(3);
      expect(sessions.state.error).toBe("same failure message");
      pendingCatchUpList.resolve(sessionsResult([], 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.error).toBeNull();
    } finally {
      pendingCatchUpList.resolve(sessionsResult([], 1));
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("ignores an outdated observer refusal after the same client reconnects", async () => {
    vi.useFakeTimers();
    const retiredSubscription = createDeferred<{ subscribed: boolean }>();
    let subscriptionCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.subscribe") {
        subscriptionCalls += 1;
        return subscriptionCalls === 1 ? await retiredSubscription.promise : { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    const { sessions, connect, disconnect } = hydration(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(subscriptionCalls).toBe(1);

      disconnect();
      connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(subscriptionCalls).toBe(2);
      expect(sessions.state.result).not.toBeNull();

      retiredSubscription.resolve({ subscribed: false });
      await vi.advanceTimersByTimeAsync(0);

      expect(sessions.state.error).toBeNull();
      expect(subscriptionCalls).toBe(2);
      expect(listCallsOf(request)).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      retiredSubscription.resolve({ subscribed: false });
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
