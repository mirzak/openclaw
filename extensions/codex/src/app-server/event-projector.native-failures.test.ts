import { createContractToolTerminalObserver } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach } from "vitest";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  onInternalDiagnosticEvent,
  expect,
  it,
  vi,
  createMockPluginRegistry,
  flushDiagnosticEvents,
  initializeGlobalHookRunner,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  findAgentEvent,
  requireRecord,
  mockCallArg,
  forCurrentTurn,
  readAttemptTerminal,
  type DiagnosticEventPayload,
} from "./event-projector.test-harness.js";
import { codexApprovalTimeoutText } from "./plugin-approval-roundtrip.js";

function notify(
  projector: Awaited<ReturnType<typeof createProjector>>,
  method: Parameters<typeof forCurrentTurn>[0],
  params: Record<string, unknown>,
) {
  return projector.handleNotification(forCurrentTurn(method, params));
}

function commandEvent(
  projector: Awaited<ReturnType<typeof createProjector>>,
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return notify(projector, status === "inProgress" ? "item/started" : "item/completed", {
    item: {
      ...nativeCommand,
      id,
      status,
      durationMs: status === "inProgress" ? null : 1,
      ...overrides,
    },
  });
}

registerCodexEventProjectorTestLifecycle();

const diagnosticEvents: DiagnosticEventPayload[] = [];
let unsubscribeDiagnostics: (() => void) | undefined;
beforeEach(() => {
  diagnosticEvents.length = 0;
  unsubscribeDiagnostics = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));
});
afterEach(() => unsubscribeDiagnostics?.());

const nativeCommand = {
  type: "commandExecution" as const,
  command: "pnpm test extensions/codex",
  cwd: "/workspace",
  processId: null,
  source: "agent" as const,
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
};

describe("CodexAppServerEventProjector native tool failure recovery", () => {
  it.each([
    { status: "completed", outcome: { status: "completed", isError: false, success: true } },
    { status: "failed", outcome: { status: "failed", isError: true, success: false } },
    { status: "declined", outcome: { status: "blocked", isError: true, success: false } },
    { status: "inProgress", outcome: { status: "running", isError: false } },
    { status: undefined, outcome: { status: "unknown", isError: false } },
    { status: "unrecognized", outcome: { status: "unknown", isError: false } },
  ])(
    "records the native $status outcome without treating running as success",
    async ({ status, outcome }) => {
      const recordEvent = vi.fn();
      const projector = await createProjector(undefined, {
        trajectoryRecorder: { recordEvent, flush: vi.fn() },
      });
      const item = { ...nativeCommand, id: "command-outcome", status, durationMs: 1 };
      await notify(projector, "item/started", {
        item: { ...item, status: "inProgress" },
      });
      await notify(projector, "item/completed", { item });

      const results = recordEvent.mock.calls.filter(([type]) => type === "tool.result");
      expect(results).toHaveLength(1);
      expect(results[0]?.[1]).toMatchObject({ toolCallId: item.id, name: "bash", ...outcome });
      if (!("success" in outcome)) {
        expect(results[0]?.[1]).not.toHaveProperty("success");
      }
    },
  );

  it("orders declined native tool diagnostics after their start event", async () => {
    const onAgentEvent = vi.fn();
    const observeToolTerminal = vi.fn(
      createContractToolTerminalObserver("run-codex-native-declined"),
    );
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
      observeToolTerminal,
    });

    await commandEvent(projector, "cmd-declined", "inProgress");
    await commandEvent(projector, "cmd-declined", "declined");
    await flushDiagnosticEvents();

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (event): event is Extract<DiagnosticEventPayload, { type: `tool.execution.${string}` }> =>
        event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual(
      ["started", "blocked"].map((phase) => ({
        type: `tool.execution.${phase}`,
        toolName: "bash",
        toolCallId: "cmd-declined",
      })),
    );
    expect(
      findAgentEvent(onAgentEvent, { stream: "item", phase: "end", itemId: "cmd-declined" }).data,
    ).toMatchObject({
      kind: "command",
      name: "bash",
      status: "blocked",
      suppressChannelProgress: true,
    });
    expect(
      findAgentEvent(onAgentEvent, {
        stream: "tool",
        phase: "result",
        itemId: "cmd-declined",
        name: "bash",
      }).data,
    ).toMatchObject({ toolCallId: "cmd-declined", status: "blocked", isError: true });
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      executionStarted: false,
      mutatingAction: false,
    });
    expect(observeToolTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executionStarted: false,
        nativeMutation: { mutatingAction: false, replaySafe: true },
        outcome: "failure",
      }),
    );
  });

  it("persists an approval timeout as failed tool evidence without aborting the turn", async () => {
    const afterToolCall = vi.fn();
    const recordTrajectoryEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(undefined, {
      trajectoryRecorder: { recordEvent: recordTrajectoryEvent, flush: vi.fn() },
    });
    const id = "cmd-approval-timeout";
    const timeoutExplanation = codexApprovalTimeoutText("command");

    await commandEvent(projector, id, "inProgress");
    projector.recordNativeToolApprovalFailure(id, "timed_out", "command");
    await commandEvent(projector, id, "declined");

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const toolResult = result.messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === id,
    );
    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: id,
      isError: true,
      content: [{ type: "text", text: timeoutExplanation }],
    });
    expect(result.lastToolError).toMatchObject({
      toolName: "bash",
      error: timeoutExplanation,
      errorCode: "approval_timeout",
      timedOut: true,
    });
    expect(recordTrajectoryEvent).toHaveBeenCalledWith(
      "tool.result",
      expect.objectContaining({ output: timeoutExplanation, isError: true }),
    );
    await vi.waitFor(() =>
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({ error: timeoutExplanation }),
        expect.anything(),
      ),
    );
    expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
  });

  it("finalizes a native pre-tool failure when no item arrives", async () => {
    const runAbortController = new AbortController();
    const projector = await createProjector(undefined, {
      runAbortSignal: runAbortController.signal,
    });

    const recordFailure = (toolCallId: string, durationMs: number) =>
      projector.recordNativeToolPreToolUseFailure({
        toolName: "exec",
        toolCallId,
        disposition: "failed",
        durationMs,
      });
    recordFailure("native-no-item", 5);
    runAbortController.abort("codex_side_question_finished");
    projector.buildResult(buildEmptyToolTelemetry());
    recordFailure("native-late-no-item", 6);
    await flushDiagnosticEvents();

    expect(
      diagnosticEvents.filter(
        (event) =>
          event.type.startsWith("tool.execution.") &&
          "toolCallId" in event &&
          (event.toolCallId === "native-no-item" || event.toolCallId === "native-late-no-item"),
      ),
    ).toEqual(
      [
        { toolCallId: "native-no-item", durationMs: 5, terminalReason: "failed" },
        { toolCallId: "native-late-no-item", durationMs: 6, terminalReason: "cancelled" },
      ].map((event) =>
        expect.objectContaining({
          type: "tool.execution.error",
          toolName: "exec",
          errorCategory: "before_tool_call",
          ...event,
        }),
      ),
    );
  });

  it("clears a declined pre-execution error after an unrelated action succeeds", async () => {
    const projector = await createProjector();

    await commandEvent(projector, "cmd-declined", "declined");
    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toEqual({
      toolName: "bash",
      meta: "run tests (workspace)",
      error: "codex native tool blocked",
      mutatingAction: false,
    });

    await commandEvent(projector, "cmd-recovered", "completed", {
      command: "pnpm test src/foo.test.ts",
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 42,
    });

    expect(projector.buildResult(buildEmptyToolTelemetry()).lastToolError).toBeUndefined();
  });
});

async function createObservedProjector(options?: Parameters<typeof createProjector>[1]) {
  const afterToolCall = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
  );
  const projector = await createProjector(
    { ...(await createParams()), agentId: "main", sessionKey: "agent:main:session-1" },
    options,
  );
  return { afterToolCall, projector };
}

async function hookEvent(afterToolCall: ReturnType<typeof vi.fn>) {
  await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
  return requireRecord(
    mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
    "after_tool_call event",
  );
}

describe("CodexAppServerEventProjector native tool hook projection", () => {
  it("does not duplicate native items already covered by PostToolUse relay", async () => {
    const { afterToolCall, projector } = await createObservedProjector({
      nativePostToolUseRelayEnabled: true,
    });

    await notify(projector, "item/completed", {
      item: createNativeCommandItem({ id: "cmd-relayed", aggregatedOutput: "ok" }),
    });
    expect(afterToolCall).not.toHaveBeenCalled();

    await notify(projector, "item/completed", {
      item: {
        type: "webSearch",
        id: "search-observed",
        query: "",
        action: {
          type: "search",
          query: "native action query",
          queries: ["native action query", "secondary query"],
        },
        status: "completed",
        durationMs: 5,
      },
    });

    const event = await hookEvent(afterToolCall);
    const query = {
      query: "native action query",
      queries: ["native action query", "secondary query"],
    };
    expect({
      toolName: event.toolName,
      params: event.params,
      runId: event.runId,
      toolCallId: event.toolCallId,
      result: event.result,
    }).toEqual({
      toolName: "web_search",
      params: query,
      runId: "run-1",
      toolCallId: "search-observed",
      result: { status: "completed", durationMs: 5, ...query },
    });
  });

  it("marks unavailable Codex web search queries explicitly", async () => {
    const { afterToolCall, projector } = await createObservedProjector();

    await notify(projector, "item/completed", {
      item: {
        type: "webSearch",
        id: "search-observed",
        query: "",
        action: { type: "other" },
        status: "completed",
      },
    });

    const event = await hookEvent(afterToolCall);
    const unavailable = { action: "other", queryUnavailable: true };
    expect({ params: event.params, result: event.result }).toEqual({
      params: unavailable,
      result: { status: "completed", ...unavailable },
    });
  });
});
