import { beforeEach, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const readConfigFileSnapshotMock = vi.fn();
const loadConfig = vi.fn(() => ({}));
const pluginPackagingRecoveryHints = [
  "This is a plugin packaging issue, not a local config problem.",
  "Update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then.",
] as const;

function expectLatestRuntimeJson(payload: Record<string, unknown>) {
  expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith({
    ok: false,
    hints: undefined,
    hintItems: undefined,
    warnings: undefined,
    ...payload,
  });
}

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readConfigFileSnapshot: () => readConfigFileSnapshotMock(),
}));

vi.mock("../../config/issue-format.js", () => ({
  formatConfigIssueLines: (issues: Array<{ path: string; message: string }>) =>
    issues.map((i) => `${i.path}: ${i.message}`),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));

function setConfigSnapshot(
  overrides: Partial<Pick<ConfigFileSnapshot, "valid" | "issues" | "warnings">> = {},
  config: OpenClawConfig = {},
) {
  readConfigFileSnapshotMock.mockResolvedValue({
    exists: true,
    valid: true,
    config,
    sourceConfig: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
    ...overrides,
  });
}

function setInvalidConfig(path: string) {
  setConfigSnapshot({
    valid: false,
    issues: [{ path, message: "Unrecognized key" }],
  });
}

const { runServiceRestart, runServiceStart, runServiceStop, runServiceUninstall } =
  await import("./lifecycle-core.js");

beforeEach(() => {
  resetLifecycleRuntimeLogs();
  readConfigFileSnapshotMock.mockReset();
  setConfigSnapshot();
  loadConfig.mockReset().mockReturnValue({});
  resetLifecycleServiceMocks();
  stubEmptyGatewayEnv();
});

it("restarts the recorded service and warns without repairing from invalid config", async () => {
  setInvalidConfig("agents.defaults.pdfModel");
  const repairLoadedService = vi.fn();
  const postRestartCheck = vi.fn();

  await expect(
    runServiceRestart({
      ...createServiceRunArgs(),
      repairLoadedService,
      postRestartCheck,
      checkTokenDrift: true,
    }),
  ).resolves.toBe(true);

  expectPartialCall(service.restart, { preserveDefinition: true });
  expectNoCalls(repairLoadedService, loadConfig);
  expectPartialCall(postRestartCheck, {
    activationAccepted: true,
    preserveDefinition: true,
    warnings: [expect.stringContaining("agents.defaults.pdfModel: Unrecognized key")],
  });
  expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
    expect.objectContaining({
      ok: true,
      result: "restarted",
      warnings: [expect.stringContaining("openclaw doctor --fix")],
    }),
  );
});

it("restarts the recorded service when config was written by a newer binary", async () => {
  setConfigSnapshot({}, { meta: { lastTouchedVersion: "9999.1.1" } });

  await expect(runServiceRestart(createServiceRunArgs())).resolves.toBe(true);
  expect(service.restart).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "blocks invalid config with packaging recovery=%s (#35862)",
  async (packaging) => {
    const path = packaging ? "plugins.slots.memory" : "agents.defaults.pdfModel";
    const message = packaging ? "plugin not found: source-only-pack" : "Unrecognized key";
    setConfigSnapshot({
      valid: false,
      issues: [{ path, message }],
      warnings: packaging
        ? [
            {
              path: "plugins",
              message:
                "plugin source-only-pack: installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js. This is a plugin packaging issue, not a local config problem.",
            },
          ]
        : [],
    });

    await expect(runServiceStart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(service.start).not.toHaveBeenCalled();
    expectLatestRuntimeJson({
      action: "start",
      error: packaging
        ? `Gateway start blocked: ${path}: ${message}`
        : `Gateway aborted: config is invalid.\n${path}: ${message}\nRun "openclaw doctor --fix" to repair, then retry.\nIf startup is still blocked, inspect the adjacent .bak backup before restoring it manually.`,
      ...(packaging
        ? {
            hints: pluginPackagingRecoveryHints,
            hintItems: pluginPackagingRecoveryHints.map((text) => ({ kind: "generic", text })),
          }
        : {}),
    });
  },
);

it("proceeds with start when config is valid", async () => {
  await runServiceStart(createServiceRunArgs());

  expect(service.start).toHaveBeenCalledTimes(1);
});

it.each([
  ["stop", "stopped", "meta.lastTouchedAt"],
  ["uninstall", "uninstalled", "memory.qmd"],
] as const)(
  "%s acts before warning without rewriting invalid config",
  async (action, result, path) => {
    setInvalidConfig(path);
    if (action === "uninstall") {
      service.isLoaded.mockResolvedValueOnce(true).mockResolvedValue(false);
      await runServiceUninstall({
        ...createServiceRunArgs(),
        stopBeforeUninstall: true,
        assertNotLoadedAfterUninstall: true,
      });
      expect(service.uninstall).toHaveBeenCalledTimes(1);
    } else {
      await runServiceStop(createServiceRunArgs());
    }
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service[action].mock.invocationCallOrder[0]).toBeLessThan(
      readConfigFileSnapshotMock.mock.invocationCallOrder[0]!,
    );
    expect(lifecycleTestRuntime.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ok: true,
        result,
        warnings: [expect.stringContaining(`${path}: Unrecognized key`)],
      }),
    );
  },
);
