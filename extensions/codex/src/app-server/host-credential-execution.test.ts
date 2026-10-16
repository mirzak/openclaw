import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import {
  buildDynamicToolsForTest,
  cleanupDynamicToolBuildFixture,
  createParams,
  setupDynamicToolBuildFixture,
} from "./dynamic-tool-build.test-support.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";
import { buildCodexRuntimeThreadConfig } from "./thread-requests.js";

let root: string;
const closers: Array<() => void> = [];
beforeEach(async () => {
  root = await setupDynamicToolBuildFixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("GH_TOKEN", "synthetic-native-token");
  vi.stubEnv("GITHUB_TOKEN", "synthetic-native-fallback");
});
afterEach(async () => {
  resetGlobalHookRunner();
  await cleanupDynamicToolBuildFixture(root, closers);
});

async function writeProfile(profileDir: string) {
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(profileDir, "hosts.yml"),
    "github.com:\n  oauth_token: synthetic-selected-token\n",
    { mode: 0o600 },
  );
}

async function effectCommand(body = '"unexpected"') {
  const effect = path.join(root, "effect");
  const script = path.join(root, "write-effect.cjs");
  await fs.writeFile(script, `require("node:fs").writeFileSync(process.argv[2], ${body});`);
  const command = [process.execPath, script, effect].map((v) => JSON.stringify(v)).join(" ");
  return { effect, command };
}

async function fixture(
  options: { mode?: "full" | "deny"; assertCurrent?: () => void; mutateSelection?: boolean } = {},
) {
  const params = createParams(path.join(root, "session.jsonl"), root);
  params.agentId = "main";
  params.disableTools = false;
  params.config = {
    tools: {
      exec: { host: "gateway", mode: options.mode ?? "full" },
      github: { profileId: "ghp_11111111111111111111111111111111" },
    },
  };
  const { hostCapabilities: _unused, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({
    attempt,
    pluginId: "codex",
    operatorSource: options.assertCurrent
      ? { profileId: "original", scopes: ["operator.admin"], assertCurrent: options.assertCurrent }
      : undefined,
  });
  params.hostCapabilities = host.capabilities;
  closers.push(host.close);
  const profileDir = host.capabilities.preparedEnvironment!().localIdentityEnv.GH_CONFIG_DIR!;
  await writeProfile(profileDir);
  if (options.mutateSelection) {
    params.config.tools!.github!.profileId = "ghp_22222222222222222222222222222222";
  }
  const policy = { nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params) };
  const native = shouldEnableCodexAppServerNativeToolSurface(params, undefined, policy);
  const tools = await buildDynamicToolsForTest(params, root, {
    sandbox: null,
    nativeToolSurfaceEnabled: native,
    ...policy,
  });
  const bridge = createCodexDynamicToolBridge({ tools, signal: new AbortController().signal });
  let sequence = 0;
  return {
    host,
    native,
    profileDir,
    tools,
    execute: (command: string) =>
      bridge.handleToolCall({
        threadId: "thread",
        turnId: "turn",
        callId: "call-" + ++sequence,
        tool: "exec",
        arguments: { command, yieldMs: 10000 },
      }),
  };
}

describe.skipIf(process.platform === "win32")("Codex host-owned credential execution", () => {
  it("executes with the selected identity and never falls back when its profile disappears", async () => {
    const f = await fixture({ mutateSelection: true });
    expect(f.native).toBe(false);
    expect(f.tools.find((tool) => tool.name === "exec")?.catalogMode).toBe("direct-only");
    const { effect, command } = await effectCommand(
      'process.env.GH_TOKEN === "synthetic-selected-token" ? "selected" : "wrong"',
    );
    const response = await f.execute(command);
    expect(response, JSON.stringify(response.contentItems)).toMatchObject({ success: true });
    expect(await fs.readFile(effect, "utf8")).toBe("selected");
    await fs.rm(effect);
    await fs.rm(f.profileDir, { recursive: true });
    const failed = await f.execute(command);
    expect(JSON.stringify(failed)).toContain("Reconnect or change GitHub Identity");
    expect(await fs.stat(effect).catch(() => undefined)).toBeUndefined();
    await writeProfile(f.profileDir);
    expect(await f.execute(command)).toMatchObject({ success: true });
    expect(await fs.readFile(effect, "utf8")).toBe("selected");
  });

  it.each([
    ["denied", false],
    ["closed", false],
    ["revoked", false],
    ["reassigned", false],
    ["closed", true],
    ["revoked", true],
  ] as const)("starts no child for a %s caller (awaited hook: %s)", async (state, awaitedHook) => {
    let caller = "original";
    const f = await fixture({
      mode: state === "denied" ? "deny" : "full",
      assertCurrent: () => {
        if (caller !== "original") {
          throw new Error("source no longer current");
        }
      },
    });
    expect(f.native).toBe(false);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    if (awaitedHook) {
      const handler = async () => {
        entered.resolve();
        await release.promise;
        return {};
      };
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_tool_call", handler }]),
      );
    }
    const { effect, command } = await effectCommand();
    const pending = awaitedHook ? f.execute(command) : undefined;
    if (awaitedHook) {
      await entered.promise;
    }
    if (state === "closed") {
      f.host.close();
    } else if (state !== "denied") {
      caller = state === "reassigned" ? "replacement" : "revoked";
    }
    release.resolve();
    const result = await (pending ?? f.execute(command));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.contentItems)).toContain(
      state === "denied" ? "denied" : "no longer active",
    );
    expect(await fs.stat(effect).catch(() => undefined)).toBeUndefined();
  });

  it("retains the native surface by default and disables inherited shell features for host-owned execution", async () => {
    const params = createParams(path.join(root, "default.jsonl"), root);
    params.disableTools = false;
    const { hostCapabilities: _unused, ...attempt } = params;
    const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
    closers.push(host.close);
    params.hostCapabilities = host.capabilities;
    const policy = { nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params) };
    expect(shouldEnableCodexAppServerNativeToolSurface(params, undefined, policy)).toBe(true);
    expect(
      buildCodexRuntimeThreadConfig(
        { "features.shell_tool": true, "features.unified_exec": true },
        { nativeCodeModeEnabled: false },
      ),
    ).toMatchObject({
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.shell_tool": false,
      "features.unified_exec": false,
    });
  });
});
