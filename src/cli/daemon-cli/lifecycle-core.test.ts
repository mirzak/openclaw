import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { GatewayRestartPreparationError } from "../../infra/restart-intent-error.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createGatewayServiceRunArgs as createServiceRunArgs,
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  lifecycleRuntimeLogs,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const loadConfig = vi.fn<() => OpenClawConfig>(makeTokenConfig);
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const appendGatewayLifecycleAudit = vi.fn();
const MISSING_SERVICE_PROGRAM = "/openclaw-test-missing-runtime/node";
function makeTokenConfig() {
  return { gateway: { auth: { token: "config-token" } } };
}
const serviceSnapshot = {
  label: "TestService",
  loaded: true,
  loadedText: "loaded",
  notLoadedText: "not loaded",
};
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  clearGatewayRestartIntentSync: () => clearGatewayRestartIntentSync(),
  writeGatewayRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
  writeGatewayServiceRestartIntentSync: (opts: unknown) => writeGatewayRestartIntentSync(opts),
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
  createServiceLifecycleMutationAudit: (params: { serviceNoun: string; action: string }) =>
    params.serviceNoun === "Gateway" ? createGatewayLifecycleMutationAudit(params) : undefined,
  appendServiceLifecycleRepairAudit: (params: {
    serviceNoun: string;
    action: string;
    pid?: number;
  }) => {
    if (params.serviceNoun === "Gateway") {
      appendGatewayLifecycleAudit({
        action: params.action,
        source: "cli",
        mode: "service-repair",
        ...(params.pid === undefined ? {} : { pid: params.pid }),
      });
    }
  },
}));

// The runtime mock consumes the initialized lifecycle harness, not an early static import.
const { ExitError } = await import("../../runtime.js");
const { runServiceRestart, runServiceStart, runServiceStop } = await import("./lifecycle-core.js");

type ActionPayload = Parameters<
  ReturnType<typeof import("./response.js").createDaemonActionContext>["emit"]
>[0];

function readJsonLog(): ActionPayload {
  const jsonLine = lifecycleRuntimeLogs.find((line) => line.trim().startsWith("{"));
  return JSON.parse(jsonLine ?? "{}");
}

function expectJsonOutput(payload: object) {
  expect(lifecycleRuntimeLogs).toEqual([JSON.stringify(payload, null, 2)]);
}

function clearResponseMocks() {
  lifecycleTestRuntime.exit.mockClear();
  lifecycleTestRuntime.writeJson.mockClear();
  lifecycleTestRuntime.error.mockClear();
}

function expectSingleRefusal(code: number, payload: object) {
  expect(lifecycleTestRuntime.exit).toHaveBeenCalledExactlyOnceWith(code);
  expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledOnce();
  expect(lifecycleTestRuntime.error).not.toHaveBeenCalled();
  expect(lifecycleRuntimeLogs).toHaveLength(1);
  expect(JSON.parse(lifecycleRuntimeLogs[0]!)).toMatchObject(payload);
}

async function expectReportedExit(code: number, run: () => Promise<unknown>) {
  const exit = new ExitError(code);
  await lifecycleTestRuntime.exit.withImplementation(
    (actualCode) => {
      expect(actualCode).toBe(code);
      throw exit;
    },
    async () => {
      await expect(run()).rejects.toBe(exit);
    },
  );
}

describe("Gateway service lifecycle", () => {
  it.each(["native-start", "recovered-start", "repaired-start", "restart-repair-refused"] as const)(
    "preserves the single reported outcome through %s catch boundaries",
    async (route) => {
      clearResponseMocks();
      if (route === "recovered-start") {
        service.isLoaded.mockResolvedValue(false);
        service.readCommand.mockResolvedValue(null);
      } else if (route === "repaired-start" || route === "restart-repair-refused") {
        service.readCommand.mockResolvedValue({
          programArguments: [MISSING_SERVICE_PROGRAM],
        });
      }
      const refusedRepair = route === "restart-repair-refused";
      const expectedCode = refusedRepair ? 1 : 2;
      await writeGatewayRestartIntentSync.withImplementation(
        () => true,
        () =>
          expectReportedExit(expectedCode, () =>
            refusedRepair
              ? runServiceRestart({
                  ...createServiceRunArgs(),
                  repairLoadedService: async () => null,
                })
              : runServiceStart({
                  ...createServiceRunArgs(),
                  ...(route === "recovered-start"
                    ? { onNotLoaded: async () => ({ result: "started" as const, loaded: true }) }
                    : {}),
                  ...(route === "repaired-start"
                    ? {
                        repairLoadedService: async () => ({
                          result: "started" as const,
                          loaded: true,
                        }),
                      }
                    : {}),
                  postStartCheck: async ({ fail }) => {
                    fail("Gateway is still starting", ["inspect"], "still-starting");
                  },
                }),
          ),
      );
      expectSingleRefusal(
        expectedCode,
        refusedRepair
          ? {
              ok: false,
              action: "restart",
              error: expect.stringContaining("service needs repair before restart"),
            }
          : {
              ok: false,
              action: "start",
              result: "still-starting",
              error: "Gateway is still starting",
            },
      );
      if (refusedRepair) {
        expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
        expect(service.restart).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["stop-recovery", "restart-recovery", "restart-owned"] as const)(
    "preserves one reported refusal from %s callbacks",
    async (route) => {
      clearResponseMocks();
      service.isLoaded.mockResolvedValue(false);
      service.readCommand.mockResolvedValue(null);
      const refuse = async (ctx: { fail: (message: string) => void }) => {
        ctx.fail("Recovery refused");
        return null;
      };
      await expectReportedExit(1, () =>
        route === "stop-recovery"
          ? runServiceStop({ ...createServiceRunArgs(), onNotLoaded: refuse })
          : runServiceRestart({
              ...createServiceRunArgs(),
              ...(route === "restart-owned"
                ? { restartOwnedProcess: refuse }
                : { onNotLoaded: refuse }),
            }),
      );
      expectSingleRefusal(1, {
        ok: false,
        action: route === "stop-recovery" ? "stop" : "restart",
        error: "Recovery refused",
      });
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.stop).not.toHaveBeenCalled();
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    mockSystemAccountHome();
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    resetLifecycleRuntimeLogs();
    loadConfig.mockReset().mockReturnValue(makeTokenConfig());
    resetLifecycleServiceMocks();
    writeGatewayRestartIntentSync.mockClear();
    clearGatewayRestartIntentSync.mockClear();
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "service-token" },
    });
    stubEmptyGatewayEnv();
  });

  it("rejects unsupported-platform start before not-loaded recovery", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "started" as const,
      message: "should not run",
      loaded: true,
    }));

    vi.spyOn(process, "platform", "get").mockReturnValue("aix");
    const { resolveGatewayService } = await import("../../daemon/service.js");
    await expect(
      runServiceStart({
        serviceNoun: "Gateway",
        service: resolveGatewayService(),
        renderStartHints: () => ["openclaw gateway install"],
        opts: { json: true },
        onNotLoaded,
      }),
    ).rejects.toThrow("__exit__:1");

    expect(onNotLoaded).not.toHaveBeenCalled();
    expect(readJsonLog()).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        "Gateway service check failed: Error: Gateway service install not supported on aix",
      ),
    });
  });

  it("fails restart with the container hint when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);
    const hasInstalledDefinition = vi.fn(async () => false);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "openclaw-demo-container");

    await expect(
      runServiceRestart({
        serviceNoun: "Gateway",
        service: { ...service, hasInstalledDefinition },
        renderStartHints: () => [
          "Restart the container or the service that manages it for openclaw-demo-container.",
          "openclaw gateway install",
        ],
        opts: { json: true },
      }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog();
    expect(payload).toMatchObject({
      action: "restart",
      ok: false,
      error: "Gateway service not loaded.",
    });
    expect(payload.hints).toContain(
      "Restart the container or the service that manages it for openclaw-demo-container.",
    );
    expect(payload.hintItems).toContainEqual(
      expect.objectContaining({ kind: "container-restart" }),
    );
    expect(hasInstalledDefinition).toHaveBeenCalledWith({ env: process.env });
  });

  it("runs the service mutation guard before restarting a loaded service", async () => {
    const beforeServiceMutation = vi.fn();

    await runServiceRestart({
      ...createServiceRunArgs(),
      beforeServiceMutation,
    });

    expect(beforeServiceMutation).toHaveBeenCalledTimes(1);
    expect(beforeServiceMutation.mock.invocationCallOrder[0]).toBeLessThan(
      service.restart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("aborts loaded-service mutation when the service guard rejects", async () => {
    const repairLoadedService = vi.fn();

    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        beforeServiceMutation: () => {
          throw new Error("service mutation denied");
        },
        repairLoadedService,
      }),
    ).rejects.toThrow("service mutation denied");

    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    expect(repairLoadedService).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("repairs managed port drift before restarting", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceRestart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async () => ({
      result: "restarted" as const,
      message: "Gateway service definition repaired and restarted.",
      loaded: true,
    }));

    await runServiceRestart({
      ...createServiceRunArgs(),
      opts: { json: true, restartIntent: { waitMs: 2_500 } },
      expectedPort: 19_001,
      repairLoadedService,
    });

    expect(repairLoadedService).toHaveBeenCalledWith(
      expect.objectContaining({
        issues: [
          {
            code: "port-mismatch",
            message: "service port 18789 does not match current gateway config port 19001",
          },
        ],
      }),
    );
    expect(service.restart).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.any(Object),
        reason: "gateway.restart",
        intent: { waitMs: 2_500 },
      }),
    );
    expect(readJsonLog()).toMatchObject({
      result: "restarted",
      message: "Gateway service definition repaired and restarted.",
    });
  });

  it("keeps Nix restart available without suggesting a forbidden token reinstall", async () => {
    await withEnvAsync({ OPENCLAW_NIX_MODE: "1" }, async () => {
      await expect(
        runServiceRestart({ ...createServiceRunArgs(true), opts: { json: false } }),
      ).resolves.toBe(true);

      expect(service.restart).toHaveBeenCalledOnce();
      const output = lifecycleRuntimeLogs.join("\n");
      expect(output).toContain("Config token differs from service token");
      expect(output).toContain("Nix mode detected; service install is disabled.");
      expect(output).not.toContain("gateway install --force");
    });
  });

  it("compares restart drift against config token even when caller env is set", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: [],
      environment: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
    });
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "env-token");

    await runServiceRestart(createServiceRunArgs(true));

    const payload = readJsonLog();
    expect(payload.warnings?.some((warning) => warning.includes("gateway install --force"))).toBe(
      true,
    );
  });

  it("skips drift warning when disabled", async () => {
    await runServiceRestart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
      opts: { json: true },
    });

    expect(loadConfig).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(writeGatewayRestartIntentSync).not.toHaveBeenCalled();
    const payload = readJsonLog();
    expect(payload.warnings).toBeUndefined();
  });

  it("runs a requested managed stop even when the service is not loaded", async () => {
    const onNotLoaded = vi.fn(async () => ({
      result: "stopped" as const,
      message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
    }));
    service.isLoaded.mockResolvedValue(false);

    await runServiceStop({
      serviceNoun: "Gateway",
      service,
      opts: { json: true, disable: true },
      stopWhenNotLoaded: true,
      onNotLoaded,
    });

    expect(readJsonLog()).toMatchObject({ result: "stopped", service: { loaded: false } });
    expect(service.stop).toHaveBeenCalledTimes(1);
    const [stopOptions] = service.stop.mock.calls[0] ?? [];
    expect(stopOptions?.env).toBe(process.env);
    expect(stopOptions?.disable).toBe(true);
    expect(onNotLoaded).not.toHaveBeenCalled();
  });

  it("skips restart health checks when restart is only scheduled", async () => {
    const postRestartCheck = vi.fn(async () => {});
    service.restart.mockResolvedValue({ outcome: "scheduled" });

    const result = await runServiceRestart({
      ...createServiceRunArgs(),
      postRestartCheck,
    });

    expect(result).toBe(true);
    expect(postRestartCheck).not.toHaveBeenCalled();
    expect(readJsonLog()).toMatchObject({
      result: "scheduled",
      message: "restart scheduled, gateway will restart momentarily",
    });
  });

  it("reports startup recovery instead of install hints when restart cannot verify a serving owner", async () => {
    writeGatewayRestartIntentSync.mockImplementationOnce(() => {
      throw new GatewayRestartPreparationError("serving-owner");
    });
    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        renderStartHints: () => ["openclaw gateway install"],
      }),
    ).rejects.toThrow("__exit__:1");
    const payload = readJsonLog();
    expect(payload.hints).toEqual([
      "openclaw gateway status --deep",
      "Fix the reported startup failure, then run `openclaw gateway start` to wait for readiness without restarting the process.",
    ]);
    expect(service.restart).not.toHaveBeenCalled();
  });

  it("clears restart intent when service-manager restart fails before signaling", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 1234 });
    writeGatewayRestartIntentSync.mockReturnValueOnce(true);
    service.restart.mockRejectedValueOnce(new Error("launchctl failed before signaling"));

    await expect(runServiceRestart(createServiceRunArgs())).rejects.toThrow("__exit__:1");

    expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.any(Object),
        reason: "gateway.restart",
      }),
    );
    expect(clearGatewayRestartIntentSync).toHaveBeenCalledOnce();
  });

  it.each(["ready", "still-starting", "failed"] as const)(
    "checks an already-running service before reporting start %s",
    async (outcome) => {
      service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
      const postStartCheck: NonNullable<
        Parameters<typeof runServiceStart>[0]["postStartCheck"]
      > = async ({ fail }) => {
        if (outcome !== "ready") {
          fail(
            "Gateway listener is unavailable.",
            [],
            outcome === "still-starting" ? outcome : undefined,
          );
        }
      };
      const start = runServiceStart({ ...createServiceRunArgs(), postStartCheck });
      if (outcome === "ready") {
        await start;
        expect(readJsonLog()).toMatchObject({ ok: true, result: "already-running" });
      } else {
        await expect(start).rejects.toThrow(`__exit__:${outcome === "still-starting" ? 2 : 1}`);
        expect(readJsonLog()).toMatchObject({
          ok: false,
          error: "Gateway listener is unavailable.",
        });
        if (outcome === "still-starting") {
          expect(readJsonLog()).toMatchObject({ result: "still-starting" });
        }
      }
      expect(lifecycleRuntimeLogs.filter((line) => line.trim().startsWith("{"))).toHaveLength(1);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    },
  );

  it("warns in JSON with the Gateway restart repair command", async () => {
    vi.stubEnv("OPENCLAW_PROFILE", "");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
    service.readCommand.mockResolvedValue({
      programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", "gateway"],
    });

    await runServiceStart({
      ...createServiceRunArgs(),
      repairLoadedService: vi.fn(async () => null),
    });

    expect(readJsonLog()).toMatchObject({
      result: "already-running",
      warnings: [
        `Gateway service already running, but its installed service definition needs repair: service command points at a missing path: ${MISSING_SERVICE_PROGRAM}; run \`openclaw gateway restart\` to apply.`,
      ],
    });
    expect(service.start).not.toHaveBeenCalled();
  });

  it("prints one warning line when an already-running Node service needs repair", async () => {
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4242 });
    service.readCommand.mockResolvedValue({
      programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", "node"],
    });

    await runServiceStart({
      serviceNoun: "Node",
      service,
      renderStartHints: () => [],
    });

    const repairWarnings = lifecycleRuntimeLogs.filter((line) =>
      line.startsWith(
        "Node service already running, but its installed service definition needs repair:",
      ),
    );
    expect(repairWarnings).toHaveLength(1);
    expect(repairWarnings[0]).toContain("run `openclaw node install --force` to apply.");
    expect(service.start).not.toHaveBeenCalled();
  });

  it("repairs loaded services with port drift during start before reporting success", async () => {
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
    });
    type RepairLoadedService = NonNullable<
      Parameters<typeof runServiceStart>[0]["repairLoadedService"]
    >;
    const repairLoadedService = vi.fn<RepairLoadedService>(async (ctx) => {
      ctx.warn?.(
        "Existing generated LaunchAgent env wrapper contains custom behavior and will be overwritten.",
      );
      return {
        result: "started" as const,
        message: "Gateway service definition repaired and started.",
        warnings: ["service port 18789 does not match current gateway config port 19001"],
        loaded: true,
      };
    });

    await runServiceStart({
      ...createServiceRunArgs(),
      repairLoadedService,
      expectedPort: 19_001,
    });

    expect(repairLoadedService).toHaveBeenCalledTimes(1);
    expect(service.start).not.toHaveBeenCalled();
    expect(readJsonLog()).toMatchObject({
      result: "started",
      message: "Gateway service definition repaired and started.",
      warnings: expect.arrayContaining([
        expect.stringContaining("service port 18789"),
        expect.stringContaining("custom behavior and will be overwritten"),
      ]),
      service: { loaded: true },
    });
  });

  it("fails Node service start with its container-scoped install hint when repair is required", async () => {
    const command = "openclaw --container demo node";
    vi.stubEnv("OPENCLAW_PROFILE", "work");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "demo");
    service.readCommand.mockResolvedValue({
      programArguments: [MISSING_SERVICE_PROGRAM, "openclaw", "node"],
    });

    await expect(
      runServiceStart({ ...createServiceRunArgs(), serviceNoun: "Node" }),
    ).rejects.toThrow("__exit__:1");

    const payload = readJsonLog();
    expect(payload).toMatchObject({
      ok: false,
      error: expect.stringContaining("service needs repair"),
      hints: [`${command} install --force`],
    });
    expect(payload.hintItems).toEqual([{ kind: "install", text: `${command} install --force` }]);

    resetLifecycleRuntimeLogs();
    await expect(
      runServiceStart({
        ...createServiceRunArgs(),
        serviceNoun: "Node",
        opts: { json: false },
      }),
    ).rejects.toThrow("__exit__:1");
    expect(lifecycleRuntimeLogs).toContain(`Tip: ${command} install --force`);
    expect(service.start).not.toHaveBeenCalled();
  });

  it("fails start with install hints when no service is installed", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);

    await expect(
      runServiceStart({
        ...createServiceRunArgs(),
        renderStartHints: () => ["openclaw gateway install"],
      }),
    ).rejects.toThrow("__exit__:1");

    expect(readJsonLog()).toMatchObject({
      ok: false,
      error: "Gateway service not loaded.",
      hints: expect.arrayContaining(["openclaw gateway install"]),
      hintItems: expect.arrayContaining([
        expect.objectContaining({ kind: "install", text: "openclaw gateway install" }),
      ]),
    });
    expect(service.start).not.toHaveBeenCalled();
  });
  it.each(
    (
      [
        ["start-recovery", "start", "started", "service repaired", true, true],
        ["stop-empty", "stop", "stopped", "", false, true],
        ["stop-missing", "stop", "not-loaded", "Gateway service not loaded.", false, false],
        ["restart-no-message", "restart", "restarted", undefined, false, true],
        [
          "restart-postcheck-scheduled",
          "restart",
          "scheduled",
          "restart scheduled, gateway will restart momentarily",
          true,
          true,
        ],
      ] as const
    ).map(
      ([route, action, result, message, loaded, json]) =>
        [route, json, { route, action, result, message, loaded }] as const,
    ),
  )("preserves exact %s output (json=%s)", async (_route, json, row) => {
    const args = {
      serviceNoun: "Gateway",
      service,
      renderStartHints: () => [],
      opts: { json },
    };
    const postCheck = vi.fn(async () =>
      row.route === "restart-postcheck-scheduled" ? { outcome: "scheduled" as const } : undefined,
    );
    lifecycleTestRuntime.error.mockClear();
    lifecycleTestRuntime.exit.mockClear();
    lifecycleTestRuntime.writeJson.mockClear();
    service.isLoaded.mockResolvedValue(row.loaded);
    service.readCommand.mockResolvedValue(
      row.loaded ? { programArguments: [], environment: {} } : null,
    );
    let result: unknown;
    if (row.route === "start-recovery") {
      service.isLoaded.mockResolvedValue(false);
      result = await runServiceStart({
        ...args,
        onNotLoaded: async () => ({ result: "started", message: row.message, loaded: true }),
        postStartCheck: async () => {
          await postCheck();
        },
      });
    } else if (row.action === "stop") {
      result = await runServiceStop({
        ...args,
        ...(row.route === "stop-missing"
          ? {}
          : {
              onNotLoaded: async () => ({ result: "stopped" as const, message: row.message }),
            }),
      });
    } else {
      result = await runServiceRestart({
        ...args,
        postRestartCheck: postCheck,
        ...(!row.loaded
          ? {
              onNotLoaded: async () => ({ result: "restarted" as const, message: row.message }),
            }
          : {}),
      });
    }
    expect(result).toBe(row.action === "restart" ? true : undefined);
    const payload = {
      action: row.action,
      ok: true,
      result: row.result,
      message: row.message,
      service: { ...serviceSnapshot, loaded: row.loaded },
    };
    expect(lifecycleRuntimeLogs).toEqual(
      json ? [JSON.stringify(payload, null, 2)] : row.message ? [row.message] : [],
    );
    expect(lifecycleTestRuntime.error).not.toHaveBeenCalled();
    expect(lifecycleTestRuntime.exit).not.toHaveBeenCalled();
    expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledTimes(json ? 1 : 0);
    if (row.action === "restart" || row.route === "start-recovery") {
      expect(postCheck).toHaveBeenCalledOnce();
      if (json) {
        expect(postCheck.mock.invocationCallOrder[0]).toBeLessThan(
          lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!,
        );
      }
    }
  });

  it("keeps native lifecycle warnings ordered in JSON", async () => {
    const events: string[] = [];
    service.restart.mockImplementationOnce(async (args) => {
      expect(args.warn).toBeDefined();
      args.warn?.("native warning");
      events.push("native");
      return { outcome: "completed" };
    });
    await runServiceRestart({
      ...createServiceRunArgs(),
      postRestartCheck: async (ctx) => {
        expect(ctx.warn).toBeDefined();
        ctx.warn?.("post-check warning");
        events.push("post-check");
      },
    });
    expect(events).toEqual(["native", "post-check"]);
    expectJsonOutput({
      action: "restart",
      ok: true,
      result: "restarted",
      service: serviceSnapshot,
      warnings: ["native warning", "post-check warning"],
    });
  });

  it("never reports recovery success after a failed post-check", async () => {
    service.isLoaded.mockResolvedValue(false);
    service.readCommand.mockResolvedValue(null);
    lifecycleTestRuntime.log.mockClear();
    lifecycleTestRuntime.error.mockClear();
    lifecycleTestRuntime.writeJson.mockClear();
    await expect(
      runServiceRestart({
        ...createServiceRunArgs(),
        onNotLoaded: async () => ({ result: "restarted", message: "must stay hidden" }),
        postRestartCheck: async ({ fail }) => {
          fail("not healthy", ["inspect"], "restart-health-failed");
        },
      }),
    ).rejects.toThrow("__exit__:1");
    expectJsonOutput({
      action: "restart",
      ok: false,
      error: "not healthy",
      hints: ["inspect"],
      result: "restart-health-failed",
      hintItems: [{ kind: "generic", text: "inspect" }],
    });
    expect(lifecycleTestRuntime.error.mock.calls).toEqual([]);
    expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledOnce();
    expect(service.restart).not.toHaveBeenCalled();
  });
});
