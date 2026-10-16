import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { ChatLog } from "./components/chat-log.js";
import type { TuiBackend } from "./tui-backend.js";
import { createCommandHandlers } from "./tui-command-handlers.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTui,
  makeTuiBackend,
  makeTuiSessionDescription,
} from "./tui-session-actions-test-support.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import {
  getPendingSubmitAcceptedRunId,
  getPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import type { TuiHistoryLoadResult, TuiStateAccess } from "./tui-types.js";

type TuiSessionDescription = Awaited<ReturnType<TuiBackend["describeSession"]>>;
type ActionContext = Parameters<typeof createTestSessionActions>[0];
type HarnessContext = Omit<ActionContext, "client" | "state" | "chatLog" | "tui" | "btw">;
const defaultChatMocks = [
  "addSystem",
  "addUser",
  "addLiveUser",
  "addPendingUser",
  "finalizeAssistant",
  "clearAll",
] as const;
const historyChatMocks = [...defaultChatMocks, "updateAssistant", "startTool"] as const;
type ChatMockMethod = (typeof historyChatMocks)[number];
function createHarness({
  state: stateOverrides = {},
  backend = {},
  context = {},
  chatLog: providedChatLog,
  mockChatMethods = providedChatLog ? [] : defaultChatMocks,
}: {
  state?: Partial<TuiStateAccess>;
  backend?: Partial<TuiBackend>;
  context?: HarnessContext | ((state: TuiStateAccess) => HarnessContext);
  chatLog?: ChatLog;
  mockChatMethods?: readonly ChatMockMethod[];
} = {}) {
  const state = createBaseState(stateOverrides);
  const client = makeTuiBackend(backend);
  const tui = makeTui();
  const chatLog = providedChatLog ?? new ChatLog();
  for (const method of mockChatMethods) {
    vi.spyOn(chatLog, method).mockImplementation(vi.fn());
  }
  const btw = { clear: vi.fn(), showResult: vi.fn() };
  const spies = {
    updateHeader: vi.fn(),
    updateFooter: vi.fn(),
    updateAutocompleteProvider: vi.fn(),
    setActivityStatus: vi.fn(),
    invalidateRunOwnership: vi.fn(),
    clearLocalRunIds: vi.fn(),
    rememberSessionKey: vi.fn(),
    requestRender: vi.spyOn(tui, "requestRender"),
    addSystem: vi.spyOn(chatLog, "addSystem"),
    addUser: vi.spyOn(chatLog, "addUser"),
    clearAll: vi.spyOn(chatLog, "clearAll"),
    updateAssistant: vi.spyOn(chatLog, "updateAssistant"),
    finalizeAssistant: vi.spyOn(chatLog, "finalizeAssistant"),
    addPendingUser: vi.spyOn(chatLog, "addPendingUser"),
  };
  const shared = {
    ...spies,
    client,
    chatLog,
    tui,
    btw,
    state,
    ...(typeof context === "function" ? context(state) : context),
  };
  const actions = createTestSessionActions(shared);
  return {
    ...shared,
    ...actions,
    spies,
    events: (overrides: Partial<Parameters<typeof createEventHandlers>[0]> = {}) =>
      createEventHandlers({ ...shared, loadHistory: actions.loadHistory, ...overrides }),
    commands: (overrides: Partial<Parameters<typeof createCommandHandlers>[0]> = {}) =>
      createCommandHandlers({
        ...shared,
        ...actions,
        opts: {},
        deliverDefault: false,
        openOverlay: (component) => tui.showOverlay(component),
        closeOverlay: () => tui.hideOverlay(),
        requestExit: vi.fn(),
        ...overrides,
      }),
  };
}
const renderChat = (chatLog: ChatLog) => chatLog.render(120).join("\n");
const flushImmediate = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
const mainSession = { key: "agent:main:main", sessionId: "session-main" };
const userMessage = (
  content: string,
  id: string,
  seq: number,
  imported: Record<string, unknown> = {},
) => ({
  role: "user",
  content,
  __openclaw: { id, seq, ...imported },
});
const createDeferredHistory = (
  stateOverrides: Partial<TuiStateAccess> = { currentSessionId: "session-main" },
  chatLog = new ChatLog(),
) => {
  const history = createDeferred<unknown>();
  return {
    history,
    ...createHarness({
      state: stateOverrides,
      backend: { describeSession: vi.fn(), loadHistory: vi.fn(() => history.promise) },
      chatLog,
    }),
  };
};

describe("tui session actions", () => {
  const acceptedSubmit = (
    runId: string,
    draftText: string | null = "pending",
  ): TuiPendingSubmit => ({ phase: "accepted", runId, draftText });
  const createBtwPresenter = () => ({
    clear: vi.fn(),
    showResult: vi.fn(),
  });

  const persistLiveUser = (
    state: TuiStateAccess,
    params: { text: string; messageId: string; messageSeq?: number; runId?: string },
  ) =>
    reduceTuiSessionProjection(state, {
      type: "messagePersisted",
      message: {
        role: "user",
        content: params.text,
        __openclaw: {
          id: params.messageId,
          ...(params.messageSeq !== undefined ? { seq: params.messageSeq } : {}),
          ...(params.runId ? { idempotencyKey: `${params.runId}:user` } : {}),
        },
      },
      scope: readTuiSessionProjectionScope(state),
    });

  const sendPendingUser = (state: TuiStateAccess, runId: string, text: string) =>
    reduceTuiSessionProjection(state, {
      type: "sendPending",
      message: { role: "user", content: text, idempotencyKey: `${runId}:user` },
      runId,
      scope: readTuiSessionProjectionScope(state),
    });

  it("keeps the cached agent roster when a refresh fails", async () => {
    const cachedAgents = [{ id: "cached", name: "Cached Agent" }];
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const { state, refreshAgents, spies } = createHarness({
      mockChatMethods: ["addSystem"],
      state: {
        agentDefaultId: "cached",
        sessionMainKey: "cached-main",
        sessionScope: "per-sender",
        agents: cachedAgents,
        currentAgentId: "cached",
      },
      backend: {
        listAgents: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      },
      context: { agentNames },
    });

    await expect(refreshAgents()).resolves.toEqual({
      ok: false,
      error: "gateway unavailable",
    });
    expect(state.agents).toBe(cachedAgents);
    expect(state).toMatchObject({
      agentDefaultId: "cached",
      sessionMainKey: "cached-main",
      sessionScope: "per-sender",
    });
    expect([...agentNames]).toEqual([["cached", "Cached Agent"]]);
    expect(spies.addSystem).toHaveBeenCalledWith("agents list failed: gateway unavailable");
  });

  it("retires the previous global agent before replacement history resolves", async () => {
    const history = createDeferred<{
      messages: unknown[];
      sessionInfo: { sessionId: string };
      defaults: { modelProvider: string; model: string; contextTokens: number };
    }>();
    const loadHistory = vi.fn(() => history.promise);
    const { state, chatLog, setSession, spies } = createHarness({
      mockChatMethods: [],
      backend: { loadHistory },
      context: (currentState) => ({
        resolveSessionSelection: vi.fn((_raw?: string, agentId = currentState.currentAgentId) => ({
          key: "global",
          agentId,
        })),
      }),
      state: {
        currentAgentId: "research",
        currentSessionKey: "global",
        currentSessionId: "research-session",
        activeChatRunId: "research-run",
        pendingSubmit: acceptedSubmit("research-pending", "private draft"),
        historyLoaded: true,
        sessionInfo: {
          displayName: "Research secret",
          updatedAt: 100,
          modelProvider: "anthropic",
          model: "private-research-model",
          thinkingLevel: "high",
          thinkingLevels: [{ id: "high", label: "high" }],
          agentRuntime: { id: "private-runtime", source: "agent" },
          responseUsage: "full",
          effectiveResponseUsage: "full",
          contextTokens: 999_999,
          verboseLevel: "full",
        },
      },
    });
    sendPendingUser(state, "research-pending", "private draft");
    chatLog.addUser("PRIVATE RESEARCH HISTORY");

    const switching = setSession("", "ops");

    expect(state).toMatchObject({
      currentAgentId: "ops",
      currentSessionKey: "global",
      currentSessionId: null,
      activeChatRunId: null,
      pendingSubmit: null,
      historyLoaded: false,
    });
    expect(state.sessionInfo).toEqual({});
    expect(state.sessionProjection?.entries).toEqual([]);
    expect(renderChat(chatLog)).not.toContain("PRIVATE RESEARCH HISTORY");
    expect(spies.invalidateRunOwnership).toHaveBeenCalledOnce();
    expect(spies.clearLocalRunIds).toHaveBeenCalledOnce();
    expect(loadHistory).toHaveBeenCalledWith({ sessionKey: "global", agentId: "ops", limit: 200 });

    history.resolve({
      messages: [],
      sessionInfo: { sessionId: "ops-session" },
      defaults: { modelProvider: "openai", model: "gpt-5.4", contextTokens: 128_000 },
    });
    await switching;
    expect(state.currentSessionId).toBe("ops-session");
    expect(state.sessionInfo).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.4",
      contextTokens: 128_000,
    });
    expect(state.sessionInfo.thinkingLevel).toBeUndefined();
    expect(state.sessionInfo.agentRuntime).toBeUndefined();
    expect(state.sessionInfo.responseUsage).toBeUndefined();
  });

  it("returns success after applying a normalized fresh agent roster", async () => {
    const agentNames = new Map([["cached", "Cached Agent"]]);
    const { state, refreshAgents, spies } = createHarness({
      state: { agents: [{ id: "cached", name: "Cached Agent" }], currentAgentId: "cached" },
      backend: {
        listAgents: vi.fn().mockResolvedValue({
          defaultId: " Team Lead ",
          mainKey: " Primary ",
          scope: "per-sender",
          agents: [
            { id: " Team Lead ", name: " Lead Agent " },
            { id: " System Agent ", kind: "system", name: " System Agent " },
          ],
        }),
      },
      context: (currentState) => ({
        agentNames,
        resolveSessionSelection: vi.fn((_raw?: string, agentId = currentState.currentAgentId) => ({
          key: `agent:${agentId}:${currentState.sessionMainKey}`,
          agentId,
        })),
      }),
    });

    await expect(refreshAgents()).resolves.toEqual({ ok: true, value: undefined });
    expect(state).toMatchObject({
      agentDefaultId: "team-lead",
      sessionMainKey: "primary",
      sessionScope: "per-sender",
      currentAgentId: "team-lead",
      currentSessionKey: "agent:team-lead:primary",
    });
    expect(state.agents).toEqual([
      { id: "team-lead", kind: undefined, name: "Lead Agent" },
      { id: "system-agent", kind: "system", name: "System Agent" },
    ]);
    expect([...agentNames]).toEqual([
      ["team-lead", "Lead Agent"],
      ["system-agent", "System Agent"],
    ]);
    expect(spies.updateHeader).toHaveBeenCalledTimes(1);
    expect(spies.updateFooter).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])(
    "does not publish a superseded picker roster %s",
    async (outcome) => {
      const pendingRoster = createDeferred<Awaited<ReturnType<TuiBackend["listAgents"]>>>();
      const cachedAgents = [{ id: "research", name: "Research" }];
      const agentNames = new Map([["research", "Research"]]);
      const { state, refreshAgents, addSystem } = createHarness({
        mockChatMethods: ["addSystem"],
        backend: { listAgents: vi.fn(() => pendingRoster.promise) },
        context: { agentNames },
        state: {
          agentDefaultId: "research",
          agents: cachedAgents,
          currentAgentId: "research",
          currentSessionKey: "agent:research:incident",
        },
      });
      let ownsRefresh = true;

      const refresh = refreshAgents(() => ownsRefresh);
      ownsRefresh = false;
      if (outcome === "success") {
        pendingRoster.resolve({
          defaultId: "ops",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "ops", name: "Operations" }],
        });
      } else {
        pendingRoster.reject(new Error("obsolete roster request failed"));
      }
      await refresh;

      expect(state.currentAgentId).toBe("research");
      expect(state.currentSessionKey).toBe("agent:research:incident");
      expect(state.agents).toBe(cachedAgents);
      expect([...agentNames]).toEqual([["research", "Research"]]);
      expect(addSystem).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      scope: "per-sender" as const,
      previousKey: "agent:research:main",
      nextKey: "agent:ops:main",
    },
    {
      scope: "global" as const,
      previousKey: "global",
      nextKey: "global",
    },
  ])(
    "retires the complete $scope session when its selected agent disappears",
    async ({ scope, previousKey, nextKey }) => {
      const { state, refreshAgents, spies, btw, client } = createHarness({
        mockChatMethods: ["clearAll"],
        backend: {
          loadHistory: vi.fn(),
          listAgents: vi.fn().mockResolvedValue({
            defaultId: "ops",
            mainKey: "main",
            scope,
            agents: [{ id: "ops" }],
          }),
        },
        context: (currentState) => ({
          resolveSessionSelection: vi.fn(
            (_raw?: string, agentId = currentState.currentAgentId) => ({
              key: scope === "global" ? "global" : `agent:${agentId}:main`,
              agentId,
            }),
          ),
        }),
        state: {
          agents: [{ id: "research" }],
          currentAgentId: "research",
          currentSessionKey: previousKey,
          currentSessionId: "old-session",
          sessionMainKey: "main",
          sessionScope: scope,
          activeChatRunId: "old-run",
          pendingSubmit: acceptedSubmit("pending-run"),
          historyLoaded: true,
          sessionInfo: { updatedAt: 100, thinkingLevel: "high", verboseLevel: "full" },
        },
      });
      sendPendingUser(state, "pending-run", "stale prompt");

      await expect(refreshAgents()).resolves.toEqual({ ok: true, value: undefined });

      expect(state).toMatchObject({
        currentAgentId: "ops",
        currentSessionKey: nextKey,
        currentSessionId: null,
        activeChatRunId: null,
        pendingSubmit: null,
        historyLoaded: false,
        sessionInfo: {},
      });
      expect(state.sessionInfo.thinkingLevel).toBeUndefined();
      expect(state.sessionInfo.verboseLevel).toBeUndefined();
      expect(state.sessionProjection?.entries).toEqual([]);
      expect(spies.invalidateRunOwnership).toHaveBeenCalledOnce();
      expect(spies.clearLocalRunIds).toHaveBeenCalledOnce();
      expect(spies.clearAll).toHaveBeenCalledOnce();
      expect(btw.clear).toHaveBeenCalledOnce();
      expect(client.loadHistory).not.toHaveBeenCalled();
    },
  );

  it("preserves the complete selected session when its agent remains in the roster", async () => {
    const resolveSessionSelection = vi.fn();
    const { state, refreshAgents, invalidateRunOwnership } = createHarness({
      backend: {
        listAgents: vi.fn().mockResolvedValue({
          defaultId: "ops",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "ops" }, { id: "research" }],
        }),
      },
      context: { resolveSessionSelection },
      state: {
        agents: [{ id: "research" }],
        currentAgentId: "research",
        currentSessionKey: "agent:research:incident",
        currentSessionId: "current-session",
        sessionScope: "per-sender",
        activeChatRunId: "current-run",
        pendingSubmit: acceptedSubmit("pending-run"),
        historyLoaded: true,
        sessionInfo: { updatedAt: 100, thinkingLevel: "high" },
      },
    });
    sendPendingUser(state, "pending-run", "current prompt");
    const previousProjection = state.sessionProjection;

    await expect(refreshAgents()).resolves.toEqual({ ok: true, value: undefined });

    expect(state).toMatchObject({
      currentAgentId: "research",
      currentSessionKey: "agent:research:incident",
      currentSessionId: "current-session",
      activeChatRunId: "current-run",
      historyLoaded: true,
      sessionInfo: { updatedAt: 100, thinkingLevel: "high" },
    });
    expect(state.pendingSubmit).toEqual(acceptedSubmit("pending-run"));
    expect(state.sessionProjection).toBe(previousProjection);
    expect(invalidateRunOwnership).not.toHaveBeenCalled();
    expect(resolveSessionSelection).not.toHaveBeenCalled();
  });

  it("coalesces refresh bursts and applies the latest result", async () => {
    const firstResult = createDeferred<TuiSessionDescription>();
    const secondResult = createDeferred<TuiSessionDescription>();
    const describeSession = vi
      .fn()
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);

    const { state, refreshSessionInfo, updateFooter, updateAutocompleteProvider, requestRender } =
      createHarness({
        mockChatMethods: ["addSystem"],
        backend: { describeSession },
      });

    const first = refreshSessionInfo();
    const second = refreshSessionInfo();
    const third = refreshSessionInfo();

    await flushImmediate();
    expect(describeSession).toHaveBeenCalledTimes(1);
    expect(describeSession).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:main:main",
    });

    firstResult.resolve({
      defaults: {},
      session: {
        key: "agent:main:main",
        sessionId: "session-old",
        model: "old",
        modelProvider: "anthropic",
      },
    });

    await flushImmediate();

    expect(describeSession).toHaveBeenCalledTimes(2);

    secondResult.resolve({
      defaults: {},
      session: {
        key: "agent:main:main",
        sessionId: "session-current",
        model: "Minimax-M2.7",
        modelProvider: "minimax",
      },
    });

    await Promise.all([first, second, third]);
    expect(describeSession).toHaveBeenCalledTimes(2);

    expect(state.sessionInfo.model).toBe("Minimax-M2.7");
    expect(state.currentSessionId).toBe("session-current");
    expect(updateAutocompleteProvider).toHaveBeenCalledTimes(2);
    expect(updateFooter).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("skips UI work when session refresh metadata is unchanged", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: {
        key: "agent:main:main",
        model: "sonnet-4.6",
        modelProvider: "anthropic",
        totalTokens: 42,
        updatedAt: 200,
      },
    });
    const { state, refreshSessionInfo, updateFooter, updateAutocompleteProvider, requestRender } =
      createHarness({
        backend: { describeSession },
        state: {
          sessionInfo: {
            model: "sonnet-4.6",
            modelProvider: "anthropic",
            totalTokens: 42,
            updatedAt: 100,
          },
        },
      });

    await refreshSessionInfo();

    expect(state.sessionInfo.updatedAt).toBe(200);
    expect(updateAutocompleteProvider).not.toHaveBeenCalled();
    expect(updateFooter).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("keeps patched model selection when a refresh returns an older snapshot", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: {
        key: "agent:main:main",
        model: "old-model",
        modelProvider: "ollama",
        updatedAt: 100,
      },
    });

    const { state, applySessionInfoFromPatch, refreshSessionInfo } = createHarness({
      backend: { describeSession },
      state: {
        sessionInfo: {
          model: "old-model",
          modelProvider: "ollama",
          updatedAt: 100,
          fastMode: true,
          verboseLevel: "full",
          traceLevel: "off",
          reasoningLevel: "stream",
        },
      },
    });

    applySessionInfoFromPatch({
      ok: true,
      key: "agent:main:main",
      entry: {
        sessionId: "session-1",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 200,
        traceLevel: "raw",
      },
    });

    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");

    await refreshSessionInfo();

    expect(state.sessionInfo).toMatchObject({
      model: "new-model",
      modelProvider: "openai",
      updatedAt: 200,
      fastMode: true,
      verboseLevel: "full",
      traceLevel: "raw",
      reasoningLevel: "stream",
    });
  });

  it("applies the runtime-aware thinking projection returned by session patches", () => {
    const { state, applySessionInfoFromPatch } = createHarness();

    applySessionInfoFromPatch({
      ok: true,
      key: "agent:main:main",
      entry: { sessionId: "session-1", updatedAt: 200 },
      resolved: {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevel: "ultra",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "ultra", label: "ultra" },
        ],
      },
    });

    expect(state.sessionInfo).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "openclaw", source: "session-key" },
      thinkingLevel: "ultra",
      thinkingLevels: [
        { id: "off", label: "off" },
        { id: "ultra", label: "ultra" },
      ],
    });
  });

  it.each([
    {
      name: "another session",
      currentAgentId: "main",
      currentSessionKey: "agent:main:current",
      resultKey: "agent:main:previous",
    },
    {
      name: "the same request key owned by another agent",
      currentAgentId: "main",
      currentSessionKey: "agent:main:main",
      resultKey: "agent:work:main",
    },
  ])(
    "ignores a session patch belonging to $name",
    ({ currentAgentId, currentSessionKey, resultKey }) => {
      const { state, applySessionInfoFromPatch, updateHeader, updateFooter } = createHarness({
        state: {
          currentAgentId,
          currentSessionKey,
          sessionInfo: { model: "current-model", modelProvider: "openai" },
        },
      });

      applySessionInfoFromPatch({
        ok: true,
        path: "/sessions/patch",
        key: resultKey,
        entry: { model: "stale-model", modelProvider: "anthropic" },
      });

      expect(state.currentSessionKey).toBe(currentSessionKey);
      expect(state.currentAgentId).toBe(currentAgentId);
      expect(state.sessionInfo.model).toBe("current-model");
      expect(state.sessionInfo.modelProvider).toBe("openai");
      expect(updateHeader).not.toHaveBeenCalled();
      expect(updateFooter).not.toHaveBeenCalled();
    },
  );

  it("adopts the canonical key for a patch belonging to the selected alias", () => {
    const { state, applySessionInfoFromPatch, updateHeader } = createHarness({
      state: { currentSessionKey: "main" },
    });

    applySessionInfoFromPatch({
      ok: true,
      path: "/sessions/patch",
      key: "agent:main:main",
      entry: { model: "gpt-5.6-luna", modelProvider: "openai" },
    });

    expect(state.currentSessionKey).toBe("agent:main:main");
    expect(state.currentAgentId).toBe("main");
    expect(state.sessionInfo.model).toBe("gpt-5.6-luna");
    expect(updateHeader).toHaveBeenCalledOnce();
  });

  it("clears the footer goal when the current session has no row yet", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: { model: "gpt-5.4", modelProvider: "openai", contextTokens: 272000 },
      session: null,
    });
    const { state, refreshSessionInfo } = createHarness({
      backend: { describeSession },
      state: {
        sessionInfo: {
          goal: {
            schemaVersion: 1,
            id: "goal-1",
            objective: "old goal",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            tokenStart: 0,
            tokenStartFresh: true,
            tokensUsed: 0,
            continuationTurns: 0,
          },
        },
      },
    });

    await refreshSessionInfo();

    expect(state.sessionInfo.goal).toBeUndefined();
    expect(state.sessionInfo).toMatchObject({
      model: "gpt-5.4",
      modelProvider: "openai",
      contextTokens: 272000,
    });
  });

  it.each([
    { snapshot: "stale", included: false, scrollback: false, userSeq: 3, replySeq: 4 },
    { snapshot: "includes live user", included: true, scrollback: false, userSeq: 1, replySeq: 2 },
    { snapshot: "full scrollback", included: false, scrollback: true, userSeq: 19, replySeq: 20 },
  ])(
    "reconciles an authoritative live user against $snapshot history",
    async ({ included, scrollback, userSeq, replySeq }) => {
      const chatLog = new ChatLog(scrollback ? 20 : undefined);
      chatLog.addUser("Deleted prompt from an earlier branch", {
        messageId: "deleted-history-user",
      });
      const {
        history: deferredHistory,
        state,
        loadHistory,
      } = createDeferredHistory(undefined, chatLog);

      const loading = loadHistory();
      persistLiveUser(state, {
        text: "Browser prompt received during refresh",
        messageId: "live-user",
        messageSeq: userSeq,
        runId: "live-run",
      });
      deferredHistory.resolve({
        sessionId: "session-main",
        sessionInfo: mainSession,
        messages: [
          ...(scrollback
            ? Array.from({ length: 18 }, (_, index) => ({
                role: "user",
                content: `Earlier history ${index + 1}`,
                __openclaw: { id: `history-user-${index + 1}`, seq: index + 1 },
              }))
            : [
                {
                  role: "user",
                  content: included
                    ? "Browser prompt received during refresh"
                    : "Current branch prompt",
                  __openclaw: {
                    id: included ? "live-user" : "current-history-user",
                    seq: included ? userSeq : 2,
                  },
                },
              ]),
          {
            role: "assistant",
            content: "Current branch reply",
            __openclaw: { id: "current-assistant", seq: replySeq },
          },
        ],
      });

      await expect(loading).resolves.toMatchObject({ loaded: true });
      const rendered = renderChat(chatLog);
      expect(rendered).not.toContain("Deleted prompt from an earlier branch");
      expect(rendered.match(/Browser prompt received during refresh/g)).toHaveLength(1);
      expect(rendered).toContain("Current branch reply");
      expect(rendered.indexOf("Browser prompt received during refresh")).toBeLessThan(
        rendered.indexOf("Current branch reply"),
      );
      if (scrollback) {
        expect(chatLog.children).toHaveLength(20);
      }
    },
  );

  it("preserves distinct imported live users through a stale history snapshot", async () => {
    const { history: deferredHistory, state, chatLog, loadHistory } = createDeferredHistory();

    const loading = loadHistory();
    for (const [index, cliSessionId] of ["first-cli-session", "second-cli-session"].entries()) {
      reduceTuiSessionProjection(state, {
        type: "messagePersisted",
        message: {
          role: "user",
          content: `Imported live prompt ${index + 1}`,
          __openclaw: {
            id: "shared-provider-id",
            importedFrom: "claude-cli",
            cliSessionId,
            externalId: "shared-provider-id",
            seq: index + 1,
          },
        },
        scope: readTuiSessionProjectionScope(state),
      });
    }
    deferredHistory.resolve({
      sessionId: "session-main",
      sessionInfo: mainSession,
      messages: [
        {
          role: "assistant",
          content: "Current branch reply",
          __openclaw: { id: "imported-live-reply", seq: 3 },
        },
      ],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = renderChat(chatLog);
    expect(rendered.match(/Imported live prompt 1/g)).toHaveLength(1);
    expect(rendered.match(/Imported live prompt 2/g)).toHaveLength(1);
    expect(rendered).toContain("Current branch reply");
  });

  it("keeps native and separately imported users with the same provider-local ID distinct", async () => {
    const sharedId = "provider-local-user";
    const { chatLog, loadHistory } = createHarness({
      mockChatMethods: [],
      state: { currentSessionId: "session-main" },
      backend: {
        describeSession: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo: mainSession,
          messages: [
            userMessage("Native canonical prompt", sharedId, 1),
            userMessage("First imported prompt", sharedId, 2, {
              importedFrom: "claude-cli",
              cliSessionId: "first-cli-session",
              externalId: sharedId,
            }),
            userMessage("Second imported prompt", sharedId, 3, {
              importedFrom: "claude-cli",
              cliSessionId: "second-cli-session",
              externalId: sharedId,
            }),
            userMessage("First partially imported prompt", sharedId, 4, {
              importedFrom: "claude-cli",
              externalId: sharedId,
            }),
            userMessage("Second partially imported prompt", sharedId, 5, {
              importedFrom: "claude-cli",
              externalId: sharedId,
            }),
          ],
        }),
      },
    });

    await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

    const rendered = renderChat(chatLog);
    expect(rendered.match(/Native canonical prompt/g)).toHaveLength(1);
    expect(rendered.match(/First imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/Second imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/First partially imported prompt/g)).toHaveLength(1);
    expect(rendered.match(/Second partially imported prompt/g)).toHaveLength(1);
  });

  it("preserves new-session live users without leaking the previous session during a switch", async () => {
    const { history: deferredHistory, state, chatLog, setSession } = createDeferredHistory();
    persistLiveUser(state, {
      text: "Private prompt from previous session",
      messageId: "previous-user",
      runId: "previous-run",
    });
    const switching = setSession("agent:main:other");
    persistLiveUser(state, {
      text: "Browser prompt in selected session",
      messageId: "other-user",
      messageSeq: 1,
      runId: "other-run",
    });
    deferredHistory.resolve({
      sessionId: "session-other",
      sessionInfo: { key: "agent:main:other", sessionId: "session-other" },
      messages: [
        {
          role: "assistant",
          content: "Other session reply",
          __openclaw: { id: "other-assistant", seq: 2 },
        },
      ],
    });

    await switching;
    const rendered = renderChat(chatLog);
    expect(rendered).toContain("Browser prompt in selected session");
    expect(rendered.match(/Browser prompt in selected session/g)).toHaveLength(1);
    expect(rendered).toContain("Other session reply");
    expect(rendered.indexOf("Browser prompt in selected session")).toBeLessThan(
      rendered.indexOf("Other session reply"),
    );
    expect(rendered).not.toContain("Private prompt from previous session");
  });

  it("discards old live users when a same-key history response rotates the session id", async () => {
    const {
      history: deferredHistory,
      state,
      chatLog,
      loadHistory,
    } = createDeferredHistory({
      currentSessionId: "session-before-reset",
    });

    const loading = loadHistory();
    persistLiveUser(state, {
      text: "Private prompt from before reset",
      messageId: "before-reset-user",
      runId: "before-reset-run",
    });
    deferredHistory.resolve({
      sessionId: "session-after-reset",
      sessionInfo: { key: "agent:main:main", sessionId: "session-after-reset" },
      messages: [{ role: "assistant", content: "Fresh session reply" }],
    });

    await expect(loading).resolves.toMatchObject({ loaded: true });
    const rendered = renderChat(chatLog);
    expect(rendered).toContain("Fresh session reply");
    expect(rendered).not.toContain("Private prompt from before reset");
  });

  it("accepts older session snapshots after switching session keys", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: {
        key: "agent:main:other",
        model: "session-model",
        modelProvider: "openai",
        updatedAt: 50,
      },
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-2",
      sessionInfo: {
        key: "agent:main:other",
        sessionId: "session-2",
        model: "session-model",
        modelProvider: "openai",
        thinkingLevel: "medium",
        contextTokens: 120_000,
        updatedAt: 50,
      },
      messages: [],
    });
    const { state, setSession, btw, setActivityStatus } = createHarness({
      backend: { describeSession, loadHistory },
      state: {
        historyLoaded: true,
        sessionInfo: {
          model: "previous-model",
          modelProvider: "anthropic",
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          updatedAt: 500,
        },
      },
    });

    await setSession("agent:main:other");

    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: "agent:main:other",
      limit: 200,
    });
    expect(state).toMatchObject({
      currentSessionKey: "agent:main:other",
      currentSessionId: "session-2",
      sessionInfo: {
        model: "session-model",
        modelProvider: "openai",
        updatedAt: 50,
        thinkingLevel: "medium",
        contextTokens: 120_000,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      },
    });
    expect(describeSession).not.toHaveBeenCalled();
    expect(btw.clear).toHaveBeenCalled();
  });

  it("renders a fresh session total as 0 (not '?') when totalTokensFresh is set", async () => {
    const describeSession = vi.fn().mockResolvedValue({ session: null });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-fresh",
      sessionInfo: {
        key: "agent:main:fresh",
        sessionId: "session-fresh",
        model: "session-model",
        modelProvider: "openai",
        // The gateway strips the fresh 0 via resolvePositiveNumber but still
        // flags it fresh, so the footer must show 0 rather than "?". (#93798)
        totalTokensFresh: true,
        updatedAt: 60,
      },
      messages: [],
    });
    const { state, setSession } = createHarness({
      backend: { describeSession, loadHistory },
      state: {
        historyLoaded: true,
        sessionInfo: {
          totalTokens: 3,
          updatedAt: 500,
        },
      },
    });

    await setSession("agent:main:fresh");

    expect(state.sessionInfo.totalTokens).toBe(0);
    expect(state.sessionInfo.totalTokensFresh).toBe(true);
  });

  it.each([
    ["a different session", false, undefined, false],
    ["a same-session replacement with exact active runs", true, ["run-next"], false],
    ["a same-session concurrent run", true, ["run-previous", "run-next"], true],
    ["a same-session run with unknown active membership", true, undefined, true],
    ["a same-session run with malformed active membership", true, ["run-next", 42], true],
  ])(
    "reconciles previous run ownership when restoring %s",
    async (_description, sameSession, activeRunIds, preservesOld) => {
      vi.useFakeTimers();
      try {
        const previousSessionKey = "agent:main:previous";
        const nextSessionKey = sameSession ? previousSessionKey : "agent:main:next";
        const previousRunId = "run-previous";
        const nextRunId = "run-next";
        const state = createBaseState({
          currentSessionKey: previousSessionKey,
          currentSessionId: "session-previous",
          historyLoaded: true,
        });
        const chatLog = new ChatLog();
        const addPendingSystem = vi.spyOn(chatLog, "addPendingSystem");
        const tui = makeTui();
        const setActivityStatus = vi.fn((status: string) => {
          state.activityStatus = status;
        });
        let loadSelectedHistory: () => Promise<TuiHistoryLoadResult> = async () => ({
          loaded: false,
        });
        const handlers = createEventHandlers({
          chatLog,
          btw: createBtwPresenter(),
          tui,
          state,
          setActivityStatus,
          updateFooter: vi.fn(),
          loadHistory: () => loadSelectedHistory(),
          streamingWatchdogMs: 100,
        });
        handlers.handleChatEvent({
          runId: previousRunId,
          sessionKey: previousSessionKey,
          seq: 1,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: "old partial" }] },
        });
        expect(state.activeChatRunId).toBe(previousRunId);

        const actions = createTestSessionActions({
          client: makeTuiBackend({
            describeSession: vi.fn(),
            loadHistory: vi.fn().mockResolvedValue({
              sessionId: sameSession ? "session-previous" : "session-next",
              sessionInfo: {
                key: nextSessionKey,
                sessionId: sameSession ? "session-previous" : "session-next",
                activeRunIds,
                updatedAt: 1,
              },
              messages: [],
              inFlightRun: { runId: nextRunId, text: "new partial" },
            }),
          }),
          chatLog,
          state,
          tui,
          setActivityStatus,
          invalidateRunOwnership: handlers.dispose,
        });
        loadSelectedHistory = async () => {
          const reconcileMembership = handlers.captureHistoryRunMembership();
          const result = await actions.loadHistory();
          if (result.loaded) {
            reconcileMembership(result.activeRunIds);
          }
          return result;
        };

        if (sameSession) {
          handlers.pauseStreamingWatchdog();
          handlers.reconnectStreamingWatchdog();
          const recovered = await loadSelectedHistory();
          expect(recovered.loaded).toBe(true);
          if (recovered.loaded) {
            handlers.reconnectStreamingWatchdog(recovered.runOutcome);
          }
        } else {
          await actions.setSession(nextSessionKey);
        }
        expect(state.activeChatRunId).toBe(nextRunId);

        handlers.handleChatEvent({
          runId: nextRunId,
          sessionKey: nextSessionKey,
          seq: 2,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "new final" }] },
        });

        expect(state.activeChatRunId).toBe(preservesOld ? previousRunId : null);
        expect(setActivityStatus).toHaveBeenLastCalledWith(preservesOld ? "running" : "idle");
        vi.advanceTimersByTime(101);
        expect(addPendingSystem).toHaveBeenCalledTimes(preservesOld ? 1 : 0);
        if (sameSession && !preservesOld) {
          handlers.handleChatEvent({
            runId: previousRunId,
            sessionKey: previousSessionKey,
            seq: 3,
            state: "final",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "late complete reply" }],
            },
          });
          expect(renderChat(chatLog)).toContain("late complete reply");
          expect(state.activeChatRunId).toBeNull();
        }
        handlers.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["agent:main:main", "main"])(
    "preserves run ownership when reselecting the same session as %s",
    async (selectedKey) => {
      const sessionKey = "agent:main:main";
      const activeRunId = "run-active";
      const pendingRunId = "run-pending";
      const pendingText = "still waiting for the Gateway";
      const loadHistory = vi.fn();
      const { state, chatLog, setSession, invalidateRunOwnership, clearLocalRunIds } =
        createHarness({
          mockChatMethods: [],
          context: (currentState) => ({
            setActivityStatus: (text) => {
              currentState.activityStatus = text;
            },
          }),

          backend: { describeSession: vi.fn(), loadHistory },
          state: {
            currentSessionKey: sessionKey,
            activeChatRunId: activeRunId,
            pendingSubmit: acceptedSubmit(pendingRunId, pendingText),
            activityStatus: "streaming",
            historyLoaded: true,
          },
        });
      sendPendingUser(state, pendingRunId, pendingText);
      chatLog.addPendingUser(pendingRunId, pendingText);

      await setSession(selectedKey);

      expect(state.activeChatRunId).toBe(activeRunId);
      expect(state.pendingSubmit).toEqual(acceptedSubmit(pendingRunId, pendingText));
      expect(state.activityStatus).toBe("streaming");
      expect(renderChat(chatLog)).toContain(pendingText);
      expect(invalidateRunOwnership).not.toHaveBeenCalled();
      expect(clearLocalRunIds).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
    },
  );

  it("reloads the current session when its initial history never loaded", async () => {
    const sessionKey = "agent:main:main";
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      sessionInfo: { key: sessionKey, sessionId: "session-main" },
      messages: [],
    });
    const { state, setSession } = createHarness({
      backend: { describeSession: vi.fn(), loadHistory },
      state: { currentSessionKey: sessionKey, historyLoaded: false },
    });

    await setSession(sessionKey);

    expect(loadHistory).toHaveBeenCalledOnce();
    expect(state.historyLoaded).toBe(true);
  });

  it("adopts an in-flight run with no buffered text (Codex) and shows streaming", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-bg",
      messages: [],
      inFlightRun: { runId: "run-bg", text: "" },
    });
    const { state, setSession, updateAssistant, setActivityStatus } = createHarness({
      mockChatMethods: [
        "addSystem",
        "clearAll",
        "addUser",
        "finalizeAssistant",
        "updateAssistant",
        "startTool",
      ],

      backend: { describeSession: vi.fn(), loadHistory },
      state: { currentSessionKey: "agent:main:other" },
    });

    await setSession("agent:main:main");

    expect(updateAssistant).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-bg");
    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
  });

  it.each(["success", "failure"] as const)(
    "ignores a superseded switch whose history settles with %s",
    async (outcome) => {
      const historyA = createDeferred<unknown>();
      const historyB = createDeferred<unknown>();
      const loadHistory = vi
        .fn()
        .mockImplementationOnce(() => historyA.promise)
        .mockImplementationOnce(() => historyB.promise);
      const { state, setSession, addSystem, addUser } = createHarness({
        mockChatMethods: historyChatMocks,
        state: { currentSessionKey: "agent:main:home" },
        backend: { describeSession: vi.fn(), loadHistory },
      });

      const firstSwitch = setSession("agent:main:A");
      const secondSwitch = setSession("agent:main:B");

      historyB.resolve({
        sessionId: "session-b",
        sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
        messages: [{ role: "user", content: "message from B" }],
      });
      if (outcome === "failure") {
        historyA.reject(new Error("history rpc aborted"));
      } else {
        historyA.resolve({
          sessionId: "session-a",
          sessionInfo: { key: "agent:main:A", sessionId: "session-a", updatedAt: 10 },
          messages: [{ role: "user", content: "message from A" }],
          inFlightRun: { runId: "run-a", text: "stale A run" },
        });
      }

      await Promise.all([firstSwitch, secondSwitch]);

      expect(state.currentSessionKey).toBe("agent:main:B");
      expect(state.currentSessionId).toBe("session-b");
      expect(state.activeChatRunId).toBeNull();
      const renderedUsers = addUser.mock.calls.map((call) => call[0]);
      expect(renderedUsers).toContain("message from B");
      expect(renderedUsers).not.toContain("message from A");
      const systemMessages = addSystem.mock.calls.map((call) => String(call[0]));
      expect(systemMessages.some((message) => message.includes("history failed"))).toBe(false);
    },
  );

  it.each([
    {
      scenario: "shutdown cancellation",
      error: new DOMException("history loading stopped", "AbortError"),
      expectedMessages: [],
      expectedRenders: [],
    },
    {
      scenario: "backend failure",
      error: new Error("gateway unavailable"),
      expectedMessages: [["history failed: gateway unavailable"]],
      expectedRenders: [[true]],
    },
  ])(
    "renders only genuine history errors for $scenario",
    async ({ error, expectedMessages, expectedRenders }) => {
      const { loadHistory, addSystem, requestRender } = createHarness({
        mockChatMethods: ["addSystem"],
        backend: { loadHistory: vi.fn().mockRejectedValue(error) },
      });

      await expect(loadHistory()).resolves.toEqual({ loaded: false });
      expect(addSystem.mock.calls).toEqual(expectedMessages);
      expect(requestRender.mock.calls).toEqual(expectedRenders);
    },
  );

  it("keeps the newer session when an earlier history load awaits session info", async () => {
    const historyA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const sessionInfoA = createDeferred<TuiSessionDescription>();
    const sessionInfoB = createDeferred<TuiSessionDescription>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => historyA.promise)
      .mockImplementationOnce(() => historyB.promise);
    const describeSession = vi
      .fn()
      .mockImplementationOnce(() => sessionInfoA.promise)
      .mockImplementationOnce(() => sessionInfoB.promise);
    const { state, setSession, addSystem, addUser } = createHarness({
      mockChatMethods: historyChatMocks,
      state: { currentSessionKey: "agent:main:home" },
      backend: { describeSession, loadHistory },
    });

    const firstSwitch = setSession("agent:main:A");
    historyA.resolve({
      sessionId: "session-a",
      messages: [{ role: "user", content: "message from A" }],
    });
    await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(1));

    const secondSwitch = setSession("agent:main:B");
    historyB.resolve({
      sessionId: "session-b",
      messages: [{ role: "user", content: "message from B" }],
    });

    sessionInfoA.resolve(
      makeTuiSessionDescription({
        defaults: {},
        session: { key: "agent:main:A", sessionId: "session-a", updatedAt: 10 },
      }),
    );
    await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(2));
    sessionInfoB.resolve(
      makeTuiSessionDescription({
        defaults: {},
        session: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      }),
    );
    await Promise.all([firstSwitch, secondSwitch]);

    expect(state.currentSessionKey).toBe("agent:main:B");
    expect(state.currentSessionId).toBe("session-b");
    const renderedUsers = addUser.mock.calls.map((call) => call[0]);
    expect(renderedUsers).toContain("message from B");
    expect(renderedUsers).not.toContain("message from A");
    expect(addSystem).not.toHaveBeenCalledWith(
      expect.stringContaining("session description failed"),
    );
  });

  it("ignores stale session info after switching away and back to the same key", async () => {
    const firstHistoryA = createDeferred<unknown>();
    const historyB = createDeferred<unknown>();
    const secondHistoryA = createDeferred<unknown>();
    const firstSessionInfoA = createDeferred<TuiSessionDescription>();
    const loadHistory = vi
      .fn()
      .mockImplementationOnce(() => firstHistoryA.promise)
      .mockImplementationOnce(() => historyB.promise)
      .mockImplementationOnce(() => secondHistoryA.promise);
    const describeSession = vi.fn(() => firstSessionInfoA.promise);
    const { state, setSession } = createHarness({
      state: { currentSessionKey: "agent:main:home" },
      backend: { describeSession, loadHistory },
    });

    const firstSwitchA = setSession("agent:main:A");
    firstHistoryA.resolve({ sessionId: "session-a-old", messages: [] });
    await vi.waitFor(() => expect(describeSession).toHaveBeenCalledTimes(1));

    const switchB = setSession("agent:main:B");
    historyB.resolve({
      sessionInfo: { key: "agent:main:B", sessionId: "session-b", updatedAt: 20 },
      messages: [],
    });
    await switchB;

    const secondSwitchA = setSession("agent:main:A");
    secondHistoryA.resolve({
      sessionInfo: {
        key: "agent:main:A",
        sessionId: "session-a-new",
        model: "new-model",
        updatedAt: 30,
      },
      messages: [],
    });
    await secondSwitchA;

    firstSessionInfoA.resolve(
      makeTuiSessionDescription({
        defaults: {},
        session: {
          key: "agent:main:A",
          sessionId: "session-a-old",
          model: "old-model",
          updatedAt: 10,
        },
      }),
    );
    await firstSwitchA;

    expect(state.currentSessionKey).toBe("agent:main:A");
    expect(state.currentSessionId).toBe("session-a-new");
    expect(state.sessionInfo.model).toBe("new-model");
  });

  it("adopts a reset mutation's replacement key without reloading gateway history", () => {
    const loadHistory = vi.fn().mockResolvedValue({ messages: [] });
    const { state, applySessionMutationResult, addSystem, clearAll } = createHarness({
      mockChatMethods: ["addSystem", "clearAll"],
      backend: { loadHistory },
      state: {
        currentSessionKey: "old",
        currentSessionId: "old-session",
        sessionInfo: {
          model: "old-model",
          modelProvider: "old-provider",
        },
      },
    });

    const applied = applySessionMutationResult({
      ok: true,
      key: "agent:main:new",
      entry: {
        sessionId: "new-session",
        model: "new-model",
        modelProvider: "openai",
        updatedAt: 123,
      },
    });

    expect(applied).toBe(true);
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.currentSessionKey).toBe("agent:main:new");
    expect(state.currentSessionId).toBe("new-session");
    expect(state.sessionInfo.model).toBe("new-model");
    expect(state.sessionInfo.modelProvider).toBe("openai");
    expect(state.sessionInfo.updatedAt).toBe(123);
    expect(state.historyLoaded).toBe(true);
    expect(clearAll).toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("session agent:main:new");
  });

  it.each(["none", "before adoption", "during refresh", "after acknowledgement"])(
    "keeps the reset acknowledgement with a notification %s",
    async (notification) => {
      const entry = { sessionId: "same-session", updatedAt: 20, totalTokens: 0 };
      const result = { ok: true, key: mainSession.key, entry };
      const refreshStarted = createDeferred();
      const refreshResult = createDeferred<TuiSessionDescription>();
      const resetResponse = createDeferred<typeof result>();
      const h = createHarness({
        mockChatMethods: [],
        state: {
          currentSessionId: "same-session",
          sessionGeneration: 4,
          historyLoaded: true,
          sessionInfo: { updatedAt: 10, totalTokens: 42 },
        },
        backend: {
          resetSession: vi.fn(() => resetResponse.promise),
          describeSession: vi.fn(() => {
            refreshStarted.resolve();
            return refreshResult.promise;
          }),
          loadHistory: vi.fn(async () => ({
            messages: [],
            sessionInfo: { key: result.key, ...entry },
          })),
        },
      });
      const { state, chatLog } = h;
      chatLog.addUser("before reset");
      const setActivityStatus = (text: string) => {
        state.activityStatus = text;
      };
      const histories: Array<Promise<TuiHistoryLoadResult>> = [];
      const events = h.events({
        setActivityStatus,
        updateFooter: vi.fn(),
        loadHistory: () => {
          const history = h.loadHistory();
          histories.push(history);
          return history;
        },
        refreshSessionInfo: h.refreshSessionInfo,
      });
      const commands = h.commands({ setActivityStatus });
      const notify = () =>
        events.handleSessionsChangedEvent({
          sessionKey: result.key,
          agentId: "main",
          reason: "reset",
          ...entry,
        });
      try {
        const resetting = commands.handleCommand("/reset");
        resetResponse.resolve(result);
        if (notification === "before adoption") {
          notify();
        } else {
          await refreshStarted.promise;
          if (notification === "during refresh") {
            notify();
          }
        }
        refreshResult.resolve(
          makeTuiSessionDescription({ session: { key: result.key, ...entry } }),
        );
        await resetting;
        if (notification === "after acknowledgement") {
          notify();
        }
        await Promise.all(histories);
        await vi.waitFor(() => {
          const rendered = renderChat(chatLog);
          expect(rendered).not.toContain("before reset");
          expect(rendered.match(/session agent:main:main reset/g)).toHaveLength(1);
        });
        expect(commands.resolveMessageAdmission("after reset")).toEqual({ status: "allowed" });
      } finally {
        events.dispose();
      }
    },
  );

  it("fences pre-reset history and session-info reads when reset commits", async () => {
    const history = createDeferred<unknown>();
    const sessionInfo = createDeferred<TuiSessionDescription>();
    const loadHistory = vi.fn(() => history.promise);
    const describeSession = vi.fn(() => sessionInfo.promise);
    const {
      state,
      addUser,
      clearAll,
      applySessionMutationResult,
      loadHistory: readHistory,
      refreshSessionInfo,
    } = createHarness({
      mockChatMethods: historyChatMocks,
      backend: { loadHistory, describeSession },
      state: {
        currentSessionId: "session-before-reset",
        sessionGeneration: 4,
        sessionInfo: { model: "model-before-reset", updatedAt: 10 },
      },
    });

    const staleHistory = readHistory();
    const staleSessionInfo = refreshSessionInfo();
    await vi.waitFor(() => {
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(describeSession).toHaveBeenCalledOnce();
    });

    expect(
      applySessionMutationResult({
        ok: true,
        key: "agent:main:main",
        entry: {
          sessionId: "session-after-reset",
          model: "model-after-reset",
          updatedAt: 20,
        },
      }),
    ).toBe(true);

    history.resolve({
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-before-reset",
        model: "stale-history-model",
        updatedAt: 10,
      },
      messages: [{ role: "user", content: "before reset" }],
    });
    sessionInfo.resolve(
      makeTuiSessionDescription({
        defaults: {},
        session: {
          key: "agent:main:main",
          sessionId: "session-before-reset",
          model: "stale-session-info-model",
          updatedAt: 10,
        },
      }),
    );

    await expect(staleHistory).resolves.toEqual({ loaded: false });
    await staleSessionInfo;

    expect(state.sessionGeneration).toBe(5);
    expect(state.currentSessionId).toBe("session-after-reset");
    expect(state.sessionInfo.model).toBe("model-after-reset");
    expect(addUser).not.toHaveBeenCalled();
    expect(clearAll).toHaveBeenCalledOnce();
  });

  it("discards in-flight history when an external event replaces the same session", async () => {
    const history = createDeferred<unknown>();
    const { state, addUser, clearAll, loadHistory } = createHarness({
      mockChatMethods: historyChatMocks,
      backend: { loadHistory: vi.fn(() => history.promise) },
      state: {
        currentSessionId: "session-before-reset",
        sessionGeneration: 4,
        sessionInfo: { model: "model-before-reset" },
      },
    });

    const staleHistory = loadHistory();
    state.sessionGeneration = 5;
    state.currentSessionId = "session-after-reset";
    state.sessionInfo = { model: "model-after-reset" };
    history.resolve({
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-before-reset",
        model: "private-old-model",
      },
      messages: [{ role: "user", content: "PRIVATE OLD HISTORY" }],
    });

    await expect(staleHistory).resolves.toEqual({ loaded: false });
    expect(state.currentSessionId).toBe("session-after-reset");
    expect(state.sessionInfo.model).toBe("model-after-reset");
    expect(addUser).not.toHaveBeenCalled();
    expect(clearAll).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "discards an in-flight session-info %s after an external same-key reset",
    async (outcome) => {
      const sessionInfo = createDeferred<TuiSessionDescription>();
      const { state, refreshSessionInfo, addSystem } = createHarness({
        mockChatMethods: ["addSystem"],
        backend: { describeSession: vi.fn(() => sessionInfo.promise) },
        state: {
          currentSessionId: "session-before-reset",
          sessionGeneration: 4,
          sessionInfo: { model: "model-before-reset", updatedAt: 10 },
        },
      });

      const staleSessionInfo = refreshSessionInfo();
      state.sessionGeneration = 5;
      state.currentSessionId = "session-after-reset";
      state.sessionInfo = { model: "model-after-reset", updatedAt: 20 };
      if (outcome === "failure") {
        sessionInfo.reject(new Error("private previous-session details"));
      } else {
        sessionInfo.resolve(
          makeTuiSessionDescription({
            defaults: {},
            session: {
              key: "agent:main:main",
              sessionId: "session-before-reset",
              model: "private-old-model",
              updatedAt: 10,
            },
          }),
        );
      }

      await staleSessionInfo;

      expect(state.currentSessionId).toBe("session-after-reset");
      expect(state.sessionInfo.model).toBe("model-after-reset");
      expect(addSystem).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      reason: "another selection",
      result: {
        ok: true,
        key: "agent:main:previous",
        entry: {
          sessionId: "stale-reset-session",
          model: "stale-model",
          modelProvider: "anthropic",
        },
      },
      requestSelection: { sessionKey: "agent:main:previous", agentId: "main" },
      historyLoaded: true,
    },
    {
      reason: "no replacement entry",
      result: { ok: true },
      requestSelection: undefined,
      historyLoaded: false,
    },
  ])(
    "does not fast-clear a reset result with $reason",
    ({ result, requestSelection, historyLoaded }) => {
      const { state, applySessionMutationResult, clearAll, addSystem, updateHeader } =
        createHarness({
          mockChatMethods: ["addSystem", "clearAll"],
          state: {
            currentSessionKey: "agent:main:current",
            currentSessionId: "current-session",
            historyLoaded,
            sessionInfo: { model: "current-model", modelProvider: "openai" },
          },
        });

      const applied = applySessionMutationResult(result, requestSelection);

      expect(applied).toBe(false);
      expect(state.currentSessionKey).toBe("agent:main:current");
      expect(state.currentSessionId).toBe("current-session");
      expect(state.sessionInfo.model).toBe("current-model");
      expect(state.historyLoaded).toBe(historyLoaded);
      expect(clearAll).not.toHaveBeenCalled();
      expect(addSystem).not.toHaveBeenCalled();
      expect(updateHeader).not.toHaveBeenCalled();
    },
  );

  it("remembers the selected session after history loads", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: { key: "agent:main:main", sessionId: "session-main" },
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [],
    });
    const {
      state,
      loadHistory: runLoadHistory,
      rememberSessionKey,
    } = createHarness({
      backend: { describeSession, loadHistory },
      state: { currentSessionKey: "main" },
    });

    await runLoadHistory();

    expect(state.currentSessionId).toBe("session-main");
    expect(state.currentSessionKey).toBe("agent:main:main");
    expect(rememberSessionKey).toHaveBeenCalledWith("agent:main:main");
  });

  it("preserves optimistic user messages across stale history rebuilds", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: { key: "agent:main:main", sessionId: "session-main" },
    });
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [
        { role: "user", content: "persisted", timestamp: 2_000 },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
    });
    const {
      state,
      spies,
      loadHistory: runLoadHistory,
      requestRender,
    } = createHarness({
      mockChatMethods: ["addSystem", "addUser", "addPendingUser", "finalizeAssistant", "clearAll"],
      backend: { describeSession, loadHistory },
      state: { currentSessionId: "session-main" },
    });
    sendPendingUser(state, "optimistic-run", "optimistic prompt");

    const result = await runLoadHistory();

    expect(spies.clearAll).toHaveBeenCalledWith();
    expect(spies.addUser).toHaveBeenCalledWith("persisted", { images: [] });
    expect(spies.addPendingUser).toHaveBeenCalledWith("optimistic-run", "optimistic prompt");
    expect(spies.finalizeAssistant).toHaveBeenCalledWith("reply", undefined, []);
    expect(requestRender).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      loaded: true,
      runOutcome: { state: "completed" },
    });
  });

  it.each([
    {
      name: "interrupted",
      sessionInfo: { status: "killed", abortedLastRun: true },
      runOutcome: { state: "interrupted" },
    },
    {
      name: "failed",
      sessionInfo: { status: "failed", lastRunError: "provider failed" },
      runOutcome: { state: "failed", errorMessage: "provider failed" },
    },
  ])("projects a closed $name history outcome", async ({ sessionInfo, runOutcome }) => {
    const { loadHistory } = createHarness({
      backend: {
        describeSession: vi.fn(),
        loadHistory: vi.fn().mockResolvedValue({
          sessionId: "session-main",
          sessionInfo,
          messages: [],
        }),
      },
    });

    await expect(loadHistory()).resolves.toEqual({ loaded: true, runOutcome });
  });

  it.each([
    { verboseLevel: "off", showsTool: false, showsOutput: false },
    { verboseLevel: "on", showsTool: true, showsOutput: false },
    { verboseLevel: "full", showsTool: true, showsOutput: true },
  ] as const)(
    "preserves $verboseLevel tool-output visibility when rebuilding history",
    async ({ verboseLevel, showsTool, showsOutput }) => {
      const privateOutput = "TUI_PRIVATE_TOOL_OUTPUT";
      const { chatLog, loadHistory } = createHarness({
        mockChatMethods: [],
        state: { sessionInfo: { verboseLevel } },
        backend: {
          describeSession: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-main",
            sessionInfo: {
              key: "agent:main:main",
              sessionId: "session-main",
              verboseLevel,
            },
            messages: [
              {
                role: "toolResult",
                toolCallId: "tool-private",
                toolName: "read_file",
                content: [{ type: "text", text: privateOutput }],
                details: { accessToken: "TUI_PRIVATE_TOOL_DETAILS" },
              },
            ],
          }),
        },
      });
      const startTool = vi.spyOn(chatLog, "startTool");

      await loadHistory();

      expect(startTool).toHaveBeenCalledTimes(showsTool ? 1 : 0);
      expect(renderChat(chatLog).includes(privateOutput)).toBe(showsOutput);
    },
  );

  it("restores attachment-only assistant rows from history without exposing references", async () => {
    const loadHistory = vi.fn().mockResolvedValue({
      sessionId: "session-main",
      messages: [
        { role: "assistant", content: [{ type: "image", data: "secret-image" }] },
        {
          role: "assistant",
          content: [{ type: "audio", source: { type: "url", url: "file:///private/audio.mp3" } }],
        },
        { role: "assistant", content: [{ type: "video", url: "file:///private/video.mp4" }] },
        { role: "assistant", content: [{ type: "file", url: "file:///etc/passwd" }] },
      ],
    });
    const { loadHistory: runLoadHistory, finalizeAssistant } = createHarness({
      mockChatMethods: ["addSystem", "finalizeAssistant", "clearAll"],
      backend: { describeSession: vi.fn(), loadHistory },
    });

    await runLoadHistory();

    expect(finalizeAssistant.mock.calls.map(([text]) => text)).toEqual([
      "Attached image",
      "Attached audio",
      "Attached video",
      "Attached file",
    ]);
  });

  it.each(["active", "accepted", "concurrent", "superseded"] as const)(
    "settles a delivered %s turn through real history reconciliation",
    async (phase) => {
      const runId = "run-delivered";
      const history = createDeferred<Awaited<ReturnType<TuiBackend["loadHistory"]>>>();
      const h = createHarness({
        mockChatMethods: [],
        backend: { loadHistory: vi.fn(() => history.promise) },
        context: (currentState) => ({
          setActivityStatus: (value) => {
            currentState.activityStatus = value;
          },
        }),
        state: {
          currentSessionId: "session-main",
          activeChatRunId: phase === "active" ? runId : null,
          pendingSubmit: phase === "active" ? null : acceptedSubmit(runId),
          activityStatus: "waiting",
        },
      });
      const { state, chatLog } = h;
      sendPendingUser(state, runId, "question");
      const handlers = h.events();

      handlers.handleSessionsChangedEvent({
        sessionKey: state.currentSessionKey,
        clientRunId: runId,
        runId: "runtime-run",
        phase: "end",
      });
      if (phase === "superseded") {
        state.pendingSubmit = acceptedSubmit("run-new");
      }
      history.resolve({
        sessionInfo: {
          key: state.currentSessionKey,
          sessionId: "session-main",
          activeRunIds: phase === "concurrent" ? ["run-other"] : [],
        },
        ...(phase === "concurrent"
          ? { inFlightRun: { runId: "run-other", text: "Still running" } }
          : {}),
        messages: [
          {
            role: "user",
            content: "question",
            __openclaw: { id: "user", idempotencyKey: `${runId}:user`, seq: 1 },
          },
          { role: "assistant", content: "Delivered reply" },
        ],
      });
      await flushImmediate();

      expect(state.activeChatRunId).toBe(phase === "concurrent" ? "run-other" : null);
      expect(getPendingSubmitAcceptedRunId(state)).toBe(phase === "superseded" ? "run-new" : null);
      expect(state.activityStatus).toBe(
        phase === "concurrent" ? "streaming" : phase === "superseded" ? "waiting" : "idle",
      );
      expect(renderChat(chatLog)).toContain("Delivered reply");
      handlers.dispose();
    },
  );

  it.each([
    { persistedRunId: "local-run", pendingRunId: null, pendingUsers: 0, copies: 1 },
    { persistedRunId: "remote-client-run", pendingRunId: "local-run", pendingUsers: 1, copies: 2 },
    { persistedRunId: undefined, pendingRunId: "local-run", pendingUsers: 1, copies: 1 },
  ])(
    "reconciles a pending submit against $persistedRunId history",
    async ({ persistedRunId, pendingRunId, pendingUsers, copies }) => {
      const { state, chatLog, loadHistory } = createHarness({
        chatLog: new ChatLog(40),
        state: {
          currentSessionId: persistedRunId ? "session-main" : null,
          pendingSubmit: acceptedSubmit("local-run", "continue"),
        },
        backend: {
          describeSession: vi.fn(),
          loadHistory: vi.fn().mockResolvedValue({
            sessionId: "session-main",
            ...(persistedRunId ? { sessionInfo: mainSession } : {}),
            messages: persistedRunId
              ? [
                  {
                    role: "user",
                    content: "continue",
                    timestamp: Date.now(),
                    __openclaw: {
                      id: "persisted-pending-user",
                      idempotencyKey: `${persistedRunId}:user`,
                      runId: "execution-run",
                      seq: 1,
                    },
                  },
                ]
              : [],
          }),
        },
      });
      sendPendingUser(state, "local-run", "continue");

      await expect(loadHistory()).resolves.toMatchObject({ loaded: true });

      if (pendingRunId === null) {
        expect(state.pendingSubmit).toBeNull();
      }
      expect(getPendingSubmitAcceptedRunId(state)).toBe(pendingRunId);
      expect(getPendingSubmitDraft(state)).toEqual(
        pendingRunId ? { runId: pendingRunId, text: "continue" } : null,
      );
      expect(chatLog.countPendingUsers()).toBe(pendingUsers);
      expect(renderChat(chatLog).match(/continue/g)).toHaveLength(copies);
    },
  );

  it("uses top-level chat history thinking level when session info inherits it", async () => {
    const describeSession = vi.fn();
    const loadHistory = vi.fn().mockResolvedValue({
      messages: [],
      thinkingLevel: "medium",
      sessionInfo: {
        key: "agent:main:main",
        sessionId: "session-main",
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 120_000,
        thinkingDefault: "medium",
        updatedAt: 200,
      },
    });
    const { state, loadHistory: runLoadHistory } = createHarness({
      backend: { describeSession, loadHistory },
    });

    await runLoadHistory();

    expect(describeSession).not.toHaveBeenCalled();
    expect(state.sessionInfo.thinkingLevel).toBe("medium");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
