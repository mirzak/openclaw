import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  resolveInactiveCodexHeartbeatResponseDescriptor,
  selectInactiveCodexHeartbeatResponseTool,
} from "./heartbeat-tool-fallback.js";
import type { CodexDynamicToolSpec } from "./protocol.js";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "message",
    description: "Test tool",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as AnyAgentTool;
}

function specNames(specs: readonly CodexDynamicToolSpec[]): string[] {
  return specs.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : [spec.name],
  );
}

const heartbeatName = HEARTBEAT_RESPONSE_TOOL_NAME;
function heartbeatTool(overrides: Partial<AnyAgentTool> = {}) {
  return createTool({ name: heartbeatName, ...overrides });
}

function createBridge(options: Partial<Parameters<typeof createCodexDynamicToolBridge>[0]> = {}) {
  return createCodexDynamicToolBridge({
    tools: [createTool({ name: "message" })],
    registeredTools: [createTool({ name: "message" }), heartbeatTool()],
    signal: new AbortController().signal,
    ...options,
  });
}

function nativeSpec(name: string): CodexDynamicToolSpec {
  return {
    type: "function",
    name,
    description: `Test ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  };
}

function heartbeatCall(notify: boolean) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    namespace: null,
    tool: HEARTBEAT_RESPONSE_TOOL_NAME,
    arguments: {
      outcome: notify ? "needs_attention" : "progress",
      notify,
      summary: notify ? "Operator action required" : "Still monitoring",
      ...(notify ? { notificationText: "Operator action required" } : {}),
    },
  } as const;
}

const closeHosts: Array<() => void> = [];

function fallbackTool(
  descriptor: Parameters<typeof selectInactiveCodexHeartbeatResponseTool>[0]["descriptor"],
): AnyAgentTool {
  const fallback = selectInactiveCodexHeartbeatResponseTool({ descriptor, pluginConfig: {} });
  if (!fallback) {
    throw new Error("inactive heartbeat fallback was not selected");
  }
  return fallback;
}

afterEach(() => {
  resetGlobalHookRunner();
  for (const close of closeHosts.splice(0)) {
    close();
  }
});

async function createHostedBridge(options: Parameters<typeof createBridge>[0] = {}) {
  const controller = new AbortController();
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt: {
      runId: "run-stale-heartbeat",
      agentId: "main",
      sessionId: "session-stale-heartbeat",
      sessionKey: "agent:main:session-stale-heartbeat",
      config: {},
      abortSignal: controller.signal,
    },
    pluginId: "codex",
  });
  closeHosts.push(host.close);
  const fallback = host.capabilities.bindToolSurface([fallbackTool(heartbeatTool())], {
    cwd: process.cwd(),
  })[0];
  if (!fallback) {
    throw new Error("host did not bind the inactive heartbeat fallback");
  }
  const bridge = createBridge({
    registeredFallbackTools: [fallback],
    signal: controller.signal,
    ...options,
  });
  return { bridge, controller, close: host.close };
}

function nativeCatalog(names: string[]) {
  const specs = names.map(nativeSpec);
  const descriptor = resolveInactiveCodexHeartbeatResponseDescriptor({
    registeredTools: [],
    registeredSpecs: specs,
  });
  if (!descriptor) {
    throw new Error("native catalog did not resolve the heartbeat fallback descriptor");
  }
  return { specs, descriptor };
}

function expectResult(
  result: Awaited<ReturnType<ReturnType<typeof createBridge>["handleToolCall"]>>,
  expected: Record<string, unknown>,
) {
  expect(result).toMatchObject(expected);
  expect(result.terminate).toBeUndefined();
}

describe("inactive Codex heartbeat endpoint", () => {
  it.each<[string, { disableTools?: boolean; toolsAllow?: string[] }, boolean]>([
    ["all tools disabled", { disableTools: true }, false],
    ["excluded by allowlist", { toolsAllow: ["message"] }, false],
    ["explicitly allowed", { toolsAllow: [HEARTBEAT_RESPONSE_TOOL_NAME] }, true],
  ])("honors current turn restrictions when %s", (_label, restrictions, expected) => {
    const selected = selectInactiveCodexHeartbeatResponseTool({
      descriptor: heartbeatTool(),
      ...restrictions,
      pluginConfig: {},
    });

    expect(Boolean(selected)).toBe(expected);
  });

  it("handles a stale quiet call through the normal execution pipeline", async () => {
    const heartbeatExecute = vi.fn();
    const onAgentToolResult = vi.fn();
    const onToolOutcome = vi.fn();
    const { bridge } = await createHostedBridge({
      registeredTools: [
        createTool({ name: "message" }),
        heartbeatTool({ execute: heartbeatExecute }),
      ],
      hookContext: { runId: "run-stale-heartbeat", onToolOutcome },
    });

    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(specNames(bridge.specs)).toEqual([HEARTBEAT_RESPONSE_TOOL_NAME, "message"]);

    const result = await bridge.handleToolCall(heartbeatCall(false), { onAgentToolResult });

    expectResult(result, {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "No heartbeat is active for this turn. Continue the current task and respond normally.",
        },
      ],
      executionStarted: true,
      executedArguments: { outcome: "progress", notify: false, summary: "Still monitoring" },
    });
    expect(heartbeatExecute).not.toHaveBeenCalled();
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      result: expect.objectContaining({
        details: { status: "ignored", reason: "non-heartbeat-turn" },
      }),
      isError: false,
    });
    expect(onToolOutcome).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolName: HEARTBEAT_RESPONSE_TOOL_NAME }),
    );
  });

  it("rejects quiet fallback calls when current host policy vetoes execution", async () => {
    const beforeToolCall = vi.fn(async () => ({
      block: true,
      blockReason: "blocked by current policy",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    const { bridge } = await createHostedBridge();

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expectResult(result, { success: false });
    expect(JSON.stringify(result.contentItems)).toContain("blocked by current policy");
    expect(beforeToolCall).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "revoked"] as const)(
    "rejects quiet fallback calls after host authority is %s",
    async (authorityState) => {
      const { bridge, controller, close } = await createHostedBridge();
      if (authorityState === "cancelled") {
        controller.abort(new Error("test cancellation"));
      } else {
        close();
      }

      const result = await bridge.handleToolCall(heartbeatCall(false));

      expectResult(result, { success: false, executionStarted: false });
    },
  );

  it("creates the fallback from an inherited native catalog without rewriting declarations", async () => {
    const { specs: nativeSpecs, descriptor } = nativeCatalog([heartbeatName, "message"]);
    const bridge = createBridge({
      registeredTools: [],
      registeredSpecs: nativeSpecs,
      registeredFallbackTools: [fallbackTool(descriptor)],
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expectResult(result, { success: true });
    expect(bridge.specs).toEqual(nativeSpecs);
    expect(specNames(bridge.availableSpecs)).toEqual(["message"]);
    expect(bridge.availableTools.map((tool) => tool.name)).toEqual(["message"]);
  });

  it("rejects an inherited native heartbeat after the current plugin config excludes it", async () => {
    const { specs: nativeSpecs, descriptor } = nativeCatalog([heartbeatName]);
    const fallback = selectInactiveCodexHeartbeatResponseTool({
      descriptor,
      pluginConfig: { codexDynamicToolsExclude: [HEARTBEAT_RESPONSE_TOOL_NAME] },
    });
    const bridge = createBridge({
      tools: [],
      registeredTools: [],
      registeredSpecs: nativeSpecs,
      registeredFallbackTools: fallback ? [fallback] : [],
    });

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expect(fallback).toBeUndefined();
    expectResult(result, { success: false, executionStarted: false });
  });

  it("rejects stale notification calls rather than silently discarding them", async () => {
    const bridge = createBridge({
      registeredFallbackTools: [fallbackTool(heartbeatTool())],
    });

    const result = await bridge.handleToolCall(heartbeatCall(true));

    expectResult(result, { success: false });
    expect(JSON.stringify(result.contentItems)).toContain(
      "heartbeat_respond cannot send notifications outside a heartbeat turn",
    );
  });

  it("does not mask a missing executor on an active heartbeat turn", async () => {
    const bridge = createBridge();

    const result = await bridge.handleToolCall(heartbeatCall(false));

    expectResult(result, { success: false });
    expect(JSON.stringify(result.contentItems)).toContain(
      `OpenClaw tool is not available for this turn: ${HEARTBEAT_RESPONSE_TOOL_NAME}`,
    );
  });
});
