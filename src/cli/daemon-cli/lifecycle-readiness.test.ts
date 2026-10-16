import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGatewayStartupTiming } from "../../commands/gateway-startup-timing.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import type { RestartParams } from "./lifecycle.test-helpers.js";
import { createDaemonActionContext } from "./response.js";
import { formatGatewayRestartFailure } from "./restart-health-diagnostics.js";
import { DEFAULT_RESTART_HEALTH_DELAY_MS } from "./restart-health.constants.js";

const service = vi.hoisted(() => ({ readCommand: vi.fn(), restart: vi.fn() }));
const runServiceStart = vi.hoisted(() => vi.fn());
const runServiceRestart = vi.hoisted(() => vi.fn());
const terminateStaleGatewayPids = vi.hoisted(() => vi.fn());
const waitForGatewayHealthyRestart = vi.hoisted(() => vi.fn());
const waitForGatewayHttpReadiness = vi.hoisted(() => vi.fn());
const readCliConfig = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../config/config.js", () => ({
  readBestEffortConfig: readCliConfig,
  resolveGatewayPort: vi.fn(() => 18_789),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: () => ({ readBestEffortConfig: async () => ({}) }),
}));
vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: async () => undefined,
}));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
  formatExternalSupervisorActionRequired: vi.fn(),
  isGatewayExternallySupervised: vi.fn(),
  resolveGatewayServiceMutationError: vi.fn(),
}));
vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop: vi.fn(),
  runServiceUninstall: vi.fn(),
}));
vi.mock("./start-repair.js", () => ({ repairLoadedGatewayServiceForStart: vi.fn() }));
vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  formatGatewayRestartFailure,
  renderGatewayPortHealthDiagnostics: vi.fn(),
  renderRestartDiagnostics: () => ["runtime diagnostics"],
  terminateStaleGatewayPids,
  waitForGatewayHealthyListener: vi.fn(),
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
}));

const { runDaemonStart, runDaemonRestart } = await import("./lifecycle.js");

function checkReadiness(action: "start" | "restart", json = true, preserveDefinition?: boolean) {
  const context = { ...createDaemonActionContext({ action, json }), json };
  if (action === "start") {
    runServiceStart.mockImplementation(async ({ postStartCheck }) => {
      await postStartCheck(context);
    });
  } else {
    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await params.postRestartCheck?.({ ...context, activationAccepted: true, preserveDefinition });
      return true;
    });
  }
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
  service.readCommand.mockReset().mockResolvedValue({
    programArguments: ["openclaw", "gateway", "--port", "18789"],
    environment: {},
  });
  runServiceStart.mockReset();
  runServiceRestart.mockReset();
  checkReadiness("restart");
  service.restart.mockReset();
  terminateStaleGatewayPids.mockReset();
  readCliConfig.mockReset().mockResolvedValue({});
  waitForGatewayHealthyRestart.mockReset().mockResolvedValue({ healthy: true });
  waitForGatewayHttpReadiness.mockReset().mockResolvedValue({ healthz: 200, readyz: 200 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("gives Windows start and restart the same cold-boot readiness allowance", async () => {
  mockProcessPlatform("win32");
  checkReadiness("start");
  await runDaemonStart({ json: true });
  await runDaemonRestart({ json: true });
  expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(2);
  const { deadlineMs } = resolveGatewayStartupTiming("win32");
  const attempts = Math.ceil(deadlineMs / DEFAULT_RESTART_HEALTH_DELAY_MS);
  for (const [options] of waitForGatewayHealthyRestart.mock.calls) {
    expect(options).toMatchObject({
      timeoutMs: deadlineMs,
      attempts,
      delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
    });
  }
  expectPartialCall(waitForGatewayHttpReadiness, {
    attempts,
    delayMs: DEFAULT_RESTART_HEALTH_DELAY_MS,
  });
});

it.each([false, true])(
  "checks activated port and required health (preserve=%s)",
  async (preserve) => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", preserve ? "1" : undefined);
    readCliConfig.mockResolvedValue({ gateway: { port: 19001 } });
    checkReadiness("restart", true, preserve);
    await runDaemonRestart({ json: true });
    const [options] = waitForGatewayHealthyRestart.mock.calls[0]!;
    expect(options).toMatchObject({ port: preserve ? 18789 : 19001 });
    expect(options.requirePluginHealth).toBe(preserve ? undefined : false);
  },
);

it.each([
  ["start", "still-starting", 2, true, undefined, undefined],
  ["start", "stopped-free", 1, true, undefined, undefined],
  ["start", "timeout", 1, true, undefined, undefined],
  ["restart", "channel-errors", 1, true, undefined, /channel health checks failed/],
  ["restart", "plugin-errors", 1, true, undefined, /plugins reported load errors/],
  ["restart", "still-starting", 2, true, undefined, undefined],
  ["restart", "still-starting", 2, false, undefined, undefined],
  ["restart", "still-starting", 1, true, "1", undefined],
] as const)(
  "reports %s %s (exit=%s json=%s update=%s)",
  async (action, outcome, code, json, updateMarker, reason) => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", updateMarker);
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    if (action === "restart") {
      for (const method of ["log", "error"] as const) {
        vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
      }
    }
    const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation((exitCode) => {
      throw new Error(`exit ${exitCode}`);
    });
    checkReadiness(action, json);
    const starting = outcome === "still-starting";
    const start = action === "start";
    waitForGatewayHealthyRestart.mockResolvedValue({
      healthy: false,
      staleGatewayPids: [],
      runtime: { status: outcome === "stopped-free" ? "stopped" : "running", pid: 4242 },
      portUsage: { status: start || reason ? "busy" : "free" },
      waitOutcome: outcome,
      elapsedMs: start ? 45_000 : reason ? 0 : 300_000,
      startupPhase: starting ? (start ? "startup-sidecars" : "startup migration") : undefined,
    });
    if (start) {
      waitForGatewayHttpReadiness.mockResolvedValue({ healthz: 200, readyz: 503 });
    }
    await expect(start ? runDaemonStart({ json }) : runDaemonRestart({ json })).rejects.toThrow(
      `exit ${code}`,
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
    if (start) {
      const response = writeJson.mock.calls[0]?.[0];
      expect(response).toMatchObject({
        ok: false,
        action,
        warnings: expect.arrayContaining(["Gateway HTTP readiness: /healthz=200; /readyz=503."]),
        ...(starting
          ? {
              result: "still-starting",
              error: expect.stringMatching(/still starting.*openclaw gateway status/),
            }
          : {}),
      });
      if (!starting) {
        expect(response).not.toHaveProperty("result", "still-starting");
      }
    } else {
      const message =
        reason ?? /still starting after 300s.*startup migration.*openclaw gateway status --deep/;
      if (reason) {
        expect(JSON.stringify(writeJson.mock.calls)).not.toMatch(/timed out/);
      }
      if (json) {
        expect(writeJson).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            ok: false,
            action,
            result: code === 2 ? "still-starting" : "restart-health-failed",
            error: expect.stringMatching(message),
            ...(reason
              ? { warnings: expect.arrayContaining([expect.stringMatching(reason)]) }
              : {}),
          }),
        );
      } else {
        expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringMatching(message));
        expect(writeJson).not.toHaveBeenCalled();
      }
      const outputs = [writeJson, defaultRuntime.log, defaultRuntime.error].map(
        (mock) => vi.mocked(mock).mock.calls,
      );
      expect(JSON.stringify(outputs)).not.toMatch(/startup hang|crash loop|restart timed out/);
      expectNoCalls(service.restart, terminateStaleGatewayPids);
    }
  },
);
