// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionsListResult,
  SessionsPatchResult,
} from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  runningSessionsResult,
  sessionsResult,
} from "./session-capability.test-support.ts";

const mainKey = "agent:main:main";
const row = (key = mainKey, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt: 1,
  ...fields,
});
const emptyList = () => sessionsResult([], 2);
const subscribed = () => ({ subscribed: true });
const reconnectRoutes = { "sessions.subscribe": subscribed, "sessions.list": emptyList };
const listRoute = (rows: GatewaySessionRow[], ts = 1) => ({
  "sessions.list": () => sessionsResult(rows, ts),
});
const listReplies = (
  first: SessionsListResult | Promise<SessionsListResult>,
  next: SessionsListResult | Promise<SessionsListResult>,
) => ({
  "sessions.list": vi
    .fn<() => Promise<SessionsListResult>>()
    .mockImplementation(() => Promise.resolve(next))
    .mockImplementationOnce(() => Promise.resolve(first)),
});

function requestRoutes(routes: Record<string, (params?: unknown) => unknown>) {
  return createGatewayRequestMock(async (method, params) => {
    const handler = routes[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return await handler(params);
  });
}

function sessionHarness(
  routes: Record<string, (params?: unknown) => unknown>,
  featureMethods?: string[],
  sessionKey = mainKey,
  ownerId?: string,
) {
  const request = requestRoutes(routes);
  const harness = createGatewayHarness(createTestGatewayClient(request), featureMethods, {
    selfUser: ownerId ? { id: ownerId } : null,
  });
  harness.gateway.snapshot.sessionKey = sessionKey;
  const sessions = createTestSessionCapability(harness.gateway);
  return {
    ...harness,
    request,
    sessions,
    current: () => sessions.state.result?.sessions[0],
    refresh: () => sessions.refresh({ agentId: "main", force: true }),
    change: (payload: Record<string, unknown>) => harness.emitEvent(event(payload)),
  };
}

function event(payload: Record<string, unknown>, name = "sessions.changed") {
  return {
    type: "event",
    event: name,
    payload,
  } as const;
}

function groupHarness(
  name: "list" | "put" | "rename",
  handler: () => unknown,
  routes: Record<string, () => unknown> = {},
) {
  const method = `sessions.groups.${name}`;
  return sessionHarness({ ...routes, [method]: handler }, [method]);
}

afterEach(() => vi.useRealTimers());

it.each([false, null])(
  "shares confirmed archive visibility after a %s restore event",
  async (restored) => {
    const key = "agent:main:archive-from-agent";
    const held = row(key, { sessionId: "archive-session" });
    const { sessions, change, refresh } = sessionHarness(listRoute([held]));
    const reconcile = (archived: boolean | null, updatedAt: number) =>
      change({ ...held, sessionKey: key, reason: "patch", archived, updatedAt });
    await refresh();
    reconcile(true, 2);
    expect(sessions.archiveVisibility(key)).toBe("archived");
    await refresh();
    expect(sessions.archiveVisibility(key)).toBe("archived");
    reconcile(restored, 3);
    expect(sessions.archiveVisibility(key)).toBeUndefined();
  },
);

it("accepts a descriptor restore outside the primary list", async () => {
  const key = "agent:main:descriptor-restore";
  const held = row(key, { sessionId: "restored-session", archived: true, updatedAt: 2 });
  let listed = [held];
  const { sessions, change, refresh } = sessionHarness({
    "sessions.list": () => sessionsResult(listed, 2),
    "sessions.describe": () => ({ session: { ...held, archived: false, updatedAt: 3 } }),
  });
  const observation = sessions.observeRow({ key, agentId: "main" }, () => {});
  onTestFinished(() => observation.dispose());
  await refresh();
  change({ ...held, sessionKey: key, reason: "patch" });
  expect(sessions.archiveVisibility(key)).toBe("archived");
  listed = [];
  await refresh();
  expect(sessions.state.result?.sessions).toEqual([]);
  const reconcile = observation.captureReconcile();
  const described = await sessions.describe({ key, agentId: "main" }, { refresh: true });
  reconcile(described.session ?? undefined);
  expect(observation.row?.archived).toBe(false);
  expect(sessions.archiveVisibility(key)).toBeUndefined();
});

it("automatically retries an explicitly retryable group catalog failure", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { sessions } = groupHarness("list", () => {
    if (++calls === 1) {
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "temporary catalog failure",
        retryable: true,
        retryAfterMs: 100,
      });
    }
    return { groups: [{ name: "Recovered" }], sectionOrder: ["work", "category:Recovered"] };
  });
  await sessions.groupsLoad();
  await vi.advanceTimersByTimeAsync(100);
  expect(sessions.state).toMatchObject({
    groups: ["Recovered"],
    sectionOrder: ["work", "category:Recovered"],
  });
  expect(calls).toBe(2);
});

it("publishes state.error when replacing the group catalog is rejected", async () => {
  const { sessions } = groupHarness("put", () => {
    throw new Error("group catalog rejected");
  });
  await expect(sessions.groupsPut(["Alpha"])).rejects.toThrow("group catalog rejected");
  expect(sessions.state.error).toBe("group catalog rejected");
});

it("reports a group catalog replacement as stale after a same-client reconnect", async () => {
  const replaced = createDeferred<{ groups: Array<{ name: string }> }>();
  const { sessions, publish } = groupHarness("put", () => replaced.promise, reconnectRoutes);
  const operation = sessions.groupsPut(["Alpha"]);
  publish(false);
  publish(true);
  replaced.resolve({ groups: [{ name: "Alpha" }] });
  await expect(operation).resolves.toBe("stale");
  expect(sessions.state).toMatchObject({ groups: [], error: null });
});

it("keeps a confirmed group rename completed when its row refresh outlives the connection", async () => {
  const refreshed = createDeferred<SessionsListResult>();
  const { sessions, publish, request } = groupHarness(
    "rename",
    () => ({ groups: [{ name: "Beta" }] }),
    {
      "sessions.list": () => refreshed.promise,
    },
  );
  const mutation = sessions.groupsRename("Alpha", "Beta");
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("sessions.list", expect.any(Object)),
  );
  publish(false);
  refreshed.resolve(emptyList());
  await expect(mutation).resolves.toBe("completed");
});

it("excludes lifecycle no-ops from batch deletion results", async () => {
  const rejected = { key: "agent:main:rejected" };
  const kept = { key: "agent:main:kept", expectedSessionId: "kept-generation" };
  const deleted = { key: "agent:main:deleted", archivedOnly: true };
  const error = new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: `Session ${rejected.key} changed before deletion. Retry.`,
  });
  const { sessions, request } = sessionHarness({
    "sessions.delete": (params) => {
      const key = asOptionalRecord(params)?.key;
      if (key === rejected.key) {
        throw error;
      }
      return { ok: true, deleted: key === deleted.key };
    },
    "sessions.list": () => sessionsResult([row(kept.key)], 2),
  });
  const deletedSnapshots: string[][] = [];
  const unsubscribe = sessions.subscribe((next) =>
    deletedSnapshots.push(next.deletedSessions.map((target) => target.key)),
  );
  await expect(sessions.deleteMany([rejected, kept, deleted])).resolves.toEqual({
    deleted: [deleted.key],
    errors: [{ target: { key: rejected.key }, error }],
    preservedWorktrees: [],
  });
  expect(deletedSnapshots.some((keys) => keys.includes(deleted.key))).toBe(true);
  expect(deletedSnapshots.some((keys) => keys.includes(kept.key))).toBe(false);
  expect(request).toHaveBeenCalledTimes(4);
  for (const target of [kept, deleted]) {
    expect(request).toHaveBeenCalledWith(
      "sessions.delete",
      { ...target, deleteTranscript: true },
      { timeoutMs: 10 * 60_000 },
    );
  }
  unsubscribe();
});

it("creates a session while a list refresh is in flight", async () => {
  const pending = createDeferred<SessionsListResult>();
  const key = "agent:main:created";
  const { sessions, request } = sessionHarness({
    ...listReplies(pending.promise, sessionsResult([row(key, { updatedAt: 2 })], 2)),
    "sessions.create": () => ({ key }),
  });
  const refresh = sessions.refresh({ force: true });
  expect(sessions.state.loading).toBe(true);
  const created = sessions.create({ agentId: "main" });
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("sessions.create", { agentId: "main" }),
  );
  pending.resolve(sessionsResult([], 1));
  await expect(created).resolves.toBe(key);
  await refresh;
  expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(2);
  expect(sessions.state.result?.sessions[0]?.key).toBe(key);
});

it.each(["reconnect", "rejection"])("reports a reset as uncertain after %s", async (outcome) => {
  const pending = createDeferred<unknown>();
  const { sessions, publish } = sessionHarness({
    "sessions.reset": () => pending.promise,
    ...reconnectRoutes,
  });
  const reset = sessions.reset(mainKey);
  if (outcome === "reconnect") {
    publish(false);
    publish(true);
    pending.resolve({});
  } else {
    pending.reject(new Error("post-commit lifecycle failed"));
  }
  await expect(reset).resolves.toBe("uncertain");
  if (outcome === "rejection") {
    expect(sessions.state.error).toContain("post-commit lifecycle failed");
  }
});

it("keeps background hydration non-blocking and retains an omitted selected row", async () => {
  const pending = createDeferred<SessionsListResult>();
  const key = "agent:main:oldest";
  const { sessions } = sessionHarness(
    listReplies(sessionsResult([row(key, { label: "Oldest" })], 1), pending.promise),
    undefined,
    key,
  );
  await sessions.refresh({ agentId: "main", force: true });
  const loading: boolean[] = [];
  const stop = sessions.subscribe((state) => loading.push(state.loading));
  const hydration = sessions.refresh({ agentId: "main", backgroundHydrate: true, force: true });
  expect(sessions.state.loading).toBe(false);
  pending.resolve(emptyList());
  await hydration;
  expect(loading).not.toContain(true);
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key, label: "Oldest" }),
  ]);
  stop();
});

it("requires a terminal run ID and clips errors after redaction", async () => {
  const { sessions, current, refresh } = sessionHarness({ "sessions.list": runningSessionsResult });
  await refresh();
  const terminal = {
    sessionKeys: ["main"],
    status: "failed" as const,
    endedAt: 61,
    errorMessage: `Provider failed.\npassword=synthetic-password\n${"x".repeat(180)}`,
  };
  expect(sessions.reconcileRunTerminal(terminal)).toBe(false);
  expect(sessions.reconcileRunTerminal({ ...terminal, runId: "run-1" })).toBe(true);
  expect(current()).toMatchObject({
    key: mainKey,
    hasActiveRun: false,
    activeRunIds: [],
    status: "failed",
    lastRunError: `Provider failed. password=[redacted] ${"x".repeat(123)}`,
    endedAt: 61,
    runtimeMs: 60,
  });
});

it("publishes remote deletion before refreshing the canonical list", async () => {
  vi.useFakeTimers();
  const pending = createDeferred<SessionsListResult>();
  const { sessions, change, request } = sessionHarness(
    listReplies(
      sessionsResult([row(mainKey, { sessionId: "deleted-generation" })], 1),
      pending.promise,
    ),
  );
  await sessions.refresh({ force: true });
  const deleted: string[][] = [];
  sessions.subscribe((next) => deleted.push(next.deletedSessions.map((target) => target.key)));
  change({ sessionKey: mainKey, sessionId: "deleted-generation", reason: "delete" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(deleted.some((keys) => keys.includes(mainKey))).toBe(true);
  pending.resolve(emptyList());
  await vi.advanceTimersByTimeAsync(0);
  expect(sessions.state.loading).toBe(false);
});

it("refreshes broad lists when the client omits the server-side window limit", async () => {
  vi.useFakeTimers();
  const hiddenKey = "agent:local:hidden";
  const { sessions, change, request } = sessionHarness(listRoute([row()]));
  await sessions.refresh({ configuredAgentsOnly: false, force: true, limit: 0 });
  const params = request.mock.calls[0]?.[1];
  expect(params).toMatchObject({
    configuredAgentsOnly: false,
    includeGlobal: true,
    includeUnknown: true,
  });
  expect(params).not.toHaveProperty("limit");
  change({
    sessionKey: hiddenKey,
    reason: "create",
    ...row(hiddenKey, { updatedAt: 2, sessionId: "hidden-session", label: "Hidden" }),
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(sessions.state.result?.sessions.map((entry) => entry.key)).not.toContain(hiddenKey);
});

it("ignores stale archive state after a newer unarchive via Gateway events", async () => {
  const held = row(mainKey, { sessionId: "main-session", updatedAt: 30, archived: false });
  const { sessions, change, refresh } = sessionHarness(listRoute([held], 30));
  await refresh();
  change({
    ...held,
    sessionKey: mainKey,
    updatedAt: 20,
    archived: true,
    archivedAt: 20,
    reason: "update",
  });
  expect(sessions.state.result?.sessions.find((entry) => entry.key === mainKey)).toMatchObject({
    archived: false,
    updatedAt: 30,
  });
});

it("does not probe for a group catalog when the method is explicitly absent", async () => {
  const { sessions, request } = sessionHarness({}, []);
  await sessions.groupsLoad();
  await sessions.groupsLoad();
  expect(request).not.toHaveBeenCalled();
  expect(sessions.state.groups).toEqual([]);
});

it("refreshes stale active rows after a terminal session message", async () => {
  vi.useFakeTimers();
  const { sessions, emitEvent, request } = sessionHarness({
    "sessions.list": vi
      .fn()
      .mockResolvedValueOnce(
        sessionsResult([row(mainKey, { hasActiveRun: true, status: "running" })], 1),
      )
      .mockResolvedValueOnce(
        sessionsResult([row(mainKey, { updatedAt: 2, hasActiveRun: false, status: "done" })], 2),
      ),
  });
  await sessions.refresh({ agentId: "main", force: true });
  emitEvent(event({ sessionKey: mainKey, updatedAt: 1, status: "done" }, "session.message"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sessions.state.result?.sessions[0]).toMatchObject({
    key: mainKey,
    hasActiveRun: false,
    status: "done",
  });
  expect(request).toHaveBeenCalledTimes(2);
});

describe("session capability dashboard default acknowledgements", () => {
  const key = "agent:main:dashboard";
  const sessionId = "dashboard-incarnation";
  const patchOptions = { agentId: "main", expectedSessionId: sessionId, deferListRefresh: true };
  const retained = {
    sessionId,
    pinned: true,
    pinnedAt: 5,
    unread: true,
    lastReadAt: 1,
  };
  const initial = row(key, {
    ...retained,
    agentId: "main",
    updatedAt: 10,
    boardFace: "dashboard",
    boardPresentation: "split",
    lastActivityAt: 10,
  });

  function acknowledgement(
    presentation: GatewaySessionRow["boardPresentation"],
  ): SessionsPatchResult {
    return {
      ok: true,
      key,
      path: "(multiple)",
      entry: {
        sessionId,
        updatedAt: 20,
        boardFace: "dashboard",
        ...(presentation ? { boardPresentation: presentation } : {}),
      },
    };
  }

  async function createPresentationHarness(initialRow = initial) {
    let current = initialRow;
    const patchReply = createDeferred<SessionsPatchResult>();
    const list = vi.fn(async () => sessionsResult([current], current.updatedAt ?? 0));
    const h = sessionHarness({
      "sessions.list": list,
      "sessions.patch": () => patchReply.promise,
      "sessions.describe": () => ({ session: current }),
      "sessions.subscribe": subscribed,
    });
    onTestFinished(() => patchReply.resolve(acknowledgement("expanded")));
    await h.refresh();
    return {
      ...h,
      acknowledge: (
        operation: Promise<unknown>,
        presentation: GatewaySessionRow["boardPresentation"],
      ) => {
        patchReply.resolve(acknowledgement(presentation));
        return operation;
      },
      patch: (
        fields: Parameters<typeof h.sessions.patch>[1],
        options: Parameters<typeof h.sessions.patch>[2] = patchOptions,
      ) => {
        const operation = h.sessions.patch(key, fields, options);
        expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
          1,
        );
        return operation;
      },
      setCurrent: (next: GatewaySessionRow) => {
        current = next;
      },
      failList: () => list.mockRejectedValue(new Error("Roster refresh unavailable")),
    };
  }

  it("clears the optional default on a null patch instead of retaining an expanded cache value", async () => {
    const h = await createPresentationHarness({
      ...initial,
      boardFace: "chat",
      boardPresentation: "expanded",
    });
    const query = { agentId: "main", hasBoard: true, archivedFilter: "all" as const };
    await h.sessions.refreshList({ ...query, force: true });
    const operation = h.patch({ boardFace: "dashboard", boardPresentation: null });
    for (const result of [h.sessions.state.result, h.sessions.listSnapshot(query).result]) {
      expect(result?.sessions[0]?.boardPresentation).toBe("expanded");
    }
    await h.acknowledge(operation, undefined);
    for (const result of [h.sessions.state.result, h.sessions.listSnapshot(query).result]) {
      expect(result?.sessions[0]).not.toHaveProperty("boardPresentation");
      expect(result?.sessions[0]).toMatchObject({
        ...retained,
        boardFace: "dashboard",
      });
    }
  });

  it("retains the acknowledged default when the follow-up list fails and an older read arrives", async () => {
    const h = await createPresentationHarness();
    const reconcileEarlierRead = h.sessions.captureReconcile();
    const operation = h.patch(
      { boardPresentation: "split" },
      { agentId: "main", expectedSessionId: sessionId },
    );
    h.failList();
    await expect(h.acknowledge(operation, "expanded")).resolves.toBeTruthy();
    expect(h.current()?.boardPresentation).toBe("expanded");
    reconcileEarlierRead({ ...initial });
    expect(h.current()?.boardPresentation).toBe("expanded");
  });

  it("keeps a newer external default ahead of an older successful patch acknowledgement", async () => {
    const h = await createPresentationHarness();
    const operation = h.patch({ boardPresentation: "expanded" });
    h.change({
      ...initial,
      sessionKey: key,
      reason: "patch",
      updatedAt: 30,
      boardPresentation: "split",
    });
    await h.acknowledge(operation, "expanded");
    expect(h.current()).toMatchObject({
      sessionId,
      updatedAt: 30,
      boardPresentation: "split",
    });
  });

  it.each(["row", "Gateway"])(
    "does not apply an old acknowledgement to a replacement %s",
    async (replacementKind) => {
      const h = await createPresentationHarness();
      const operation = h.patch({ boardPresentation: "expanded" });
      const replacement = { ...initial, sessionId: "other-gateway-session", updatedAt: 40 };
      if (replacementKind === "row") {
        h.setCurrent(replacement);
      } else {
        h.publish(false);
        h.publish(true, createTestGatewayClient(requestRoutes(listRoute([replacement], 40))));
      }
      await h.refresh();
      await h.acknowledge(operation, "expanded");
      expect(h.current()).toMatchObject({
        sessionId: replacement.sessionId,
        boardPresentation: "split",
      });
    },
  );
});

it("ignores recap-only changes for canonical, filtered, and child rosters", async () => {
  vi.useFakeTimers();
  const key = "agent:main:parent";
  const recapRow = row(key);
  const child = { ...recapRow, key: "agent:main:child", spawnedBy: key };
  const { sessions, change, request, refresh } = sessionHarness(
    {
      "sessions.list": (params) =>
        sessionsResult(asOptionalRecord(params)?.spawnedBy ? [child] : [recapRow], 1),
    },
    undefined,
    mainKey,
    "viewer",
  );
  const scopes = [
    { agentId: "main", involvingMe: true },
    ...[100, 10_000].map((limit) => ({
      agentId: "main",
      spawnedBy: key,
      limit,
      includeGlobal: false,
      includeUnknown: false,
    })),
  ];
  const stops = scopes.map((scope) => sessions.subscribeList(scope, vi.fn()));
  onTestFinished(() => stops.forEach((stop) => stop()));
  await refresh();
  await Promise.all(scopes.map((scope) => sessions.refreshList({ ...scope, force: true })));
  expect(request).toHaveBeenCalledTimes(4);
  request.mockClear();

  for (let index = 0; index < 4; index += 1) {
    change({ agentId: "main", sessionKey: key, reason: "activity-summary" });
    await vi.advanceTimersByTimeAsync(5_000);
  }
  expect(request).not.toHaveBeenCalled();

  change({ agentId: "main", sessionKey: key, reason: "patch" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(4);
  expect(request).toHaveBeenCalledWith(
    "sessions.list",
    expect.objectContaining({ ownerFirst: true }),
  );
  expect(sessions.state.result?.sessions).toEqual([recapRow]);
});
