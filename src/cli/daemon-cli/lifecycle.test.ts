import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  expectNoCalls as expectUnused,
  expectPartialCall,
} from "./lifecycle-assertions.test-support.js";
import {
  createHealthyRestartSnapshot,
  createDeferredSafeRestartResult,
  createGatewayLockIdentity,
  createGatewayProcessExpectations,
  expectRestartError,
  type RestartHealthSnapshot,
  requireMockCallArg,
  runRestartPostCheck,
  type RestartParams,
} from "./lifecycle.test-helpers.js";

const service = {
  readCommand: vi.fn(async () => makeServiceCommand()),
  readRuntime: vi.fn(async () => ({ status: "stopped" })),
  restart: vi.fn(async () => ({ outcome: "completed" })),
  stop: vi.fn(),
};

const runServiceStart = vi.fn(),
  runServiceRestart = vi.fn(),
  runServiceStop = vi.fn(),
  runServiceUninstall = vi.fn();
const waitForListener = vi.fn(),
  waitForRestart = vi.fn();
const terminateStalePids = vi.fn();
const portDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const restartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18789));
const findListeners = vi.fn<
  typeof import("../../infra/gateway-processes.js").findVerifiedGatewayListenerPidsOnPortSync
>(() => []);
const signalPid =
  vi.fn<typeof import("../../infra/gateway-processes.js").signalVerifiedGatewayPidSync>();
const gatewayProcessChecks = createGatewayProcessExpectations(findListeners, signalPid);
const writeRestartIntent = vi.fn(() => true);
const clearRestartIntent = vi.fn();
const resolveProbeHosts = vi.fn(
  async (_params: { env?: Record<string, string | undefined>; command?: unknown }) =>
    ["127.0.0.1"] as readonly string[],
);
const probePortUsage = vi.fn(
  async (_port: number, _hosts?: readonly string[]) => "free" as "free" | "busy" | "unknown",
);
const formatGatewayPidList = vi.fn<(pids: number[]) => string>((pids) => pids.join(", "));
const probeGateway =
  vi.fn<
    (
      opts: Parameters<typeof import("../../gateway/probe.js").probeGateway>[0],
    ) => Promise<Pick<import("../../gateway/probe.js").GatewayProbeResult, "ok" | "configSnapshot">>
  >();
const callGatewayCli = vi.fn();
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const createConfigIO = vi.hoisted(() =>
  vi.fn((_opts?: { env?: Record<string, string | undefined>; observe?: boolean }) => ({
    readBestEffortConfig: async () => loadConfig(),
  })),
);
const readLockPort = vi.hoisted(() => vi.fn<() => Promise<number | undefined>>());
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
type LockIdentity = { pid: number; ownerId?: string; createdAt: string; port: number };
const readLockIdentity = vi.hoisted(() => vi.fn<() => Promise<LockIdentity | undefined>>());
const recoverLaunchAgent = vi.hoisted(() => vi.fn());
const repairService = vi.hoisted(() => vi.fn());
type SystemdScope = { scope: "user" | "system"; unitName: string; unitPath: string };
const findSystemdScope = vi.hoisted(() =>
  vi.fn<() => Promise<SystemdScope | null>>(async () => null),
);
const restartSystemd = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" }>>(async () => ({ outcome: "completed" })),
);
const stopSystemd = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const isTerminalInteractive = vi.fn(() => true);
const appendGatewayLifecycleAudit = vi.fn();
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
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../config/io.js", () => ({ createConfigIO }));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: findListeners,
  signalVerifiedGatewayPidSync: signalPid,
  formatGatewayPidList,
}));

vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: readLockPort,
  readActiveGatewayLockIdentity: readLockIdentity,
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  writeGatewayRestartIntentSync: writeRestartIntent,
  writeGatewayServiceRestartIntentSync: writeRestartIntent,
  clearGatewayRestartIntentSync: clearRestartIntent,
}));

vi.mock("../../gateway/probe.js", () => ({ probeGateway }));

vi.mock("../../gateway/call.js", () => ({ callGatewayCli }));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: findSystemdScope,
  refreshLegacySystemdServiceMetadata: vi.fn(async () => false),
  restartSystemdService: restartSystemd,
  stopSystemdService: stopSystemd,
}));
vi.mock("./launchd-recovery.js", () => ({
  recoverInstalledLaunchAgent: recoverLaunchAgent,
}));

vi.mock("./start-repair.js", () => ({
  repairLoadedGatewayServiceForStart: repairService,
}));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive,
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE:
    "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force if you really mean it.",
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit,
  createGatewayLifecycleMutationAudit,
}));

vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: resolveProbeHosts,
}));

vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage }));

vi.mock("./restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-health.js")>()),
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyListener: waitForListener,
  waitForGatewayHealthyRestart: waitForRestart,
  renderGatewayPortHealthDiagnostics: portDiagnostics,
  terminateStaleGatewayPids: terminateStalePids,
  renderRestartDiagnostics: restartDiagnostics,
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
}));

const {
  runDaemonStart: start,
  runDaemonRestart: restart,
  runDaemonStop: stop,
  runDaemonUninstall: uninstall,
} = await import("./lifecycle.js");

function expectRestartRpc(params: Record<string, unknown>, port?: number, safeTarget = false) {
  expect(callGatewayCli).toHaveBeenCalledWith({
    method: "gateway.restart.request",
    params,
    timeoutMs: 10_000,
    ...(port === undefined ? {} : { localPortOverride: port, ignoreEnvUrlOverride: true }),
    ...(safeTarget ? { requiredCapabilities: ["gateway-restart-target-safe-v1"] } : {}),
  });
}
function expectListenerHealth(
  attempts: number,
  lock = createGatewayLockIdentity(),
  env?: NodeJS.ProcessEnv,
) {
  expect(waitForListener).toHaveBeenCalledWith({
    port: lock.port,
    attempts,
    delayMs: 500,
    previousLockIdentity: lock,
    waitIndefinitelyForPreviousOwner: false,
    ...(env ? { env } : {}),
  });
}
const restartTarget = { pid: 4200, ownerId: "gateway-owner-old", port: 18_789 };
const stalePortIssue = { code: "port-mismatch", message: "service port is stale" };

function makeServiceCommand(port = "18789", environment: NodeJS.ProcessEnv = {}) {
  return { programArguments: ["openclaw", "gateway", "--port", port], environment };
}
function expectAudit(action: string, mode: string, pid = 4200, source = "cli") {
  expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({ action, source, mode, pid });
}
function expectExpectedPort(mock: typeof runServiceRestart, port?: number) {
  expect(requireMockCallArg(mock, "service lifecycle").expectedPort).toBe(port);
}
function mockRepairResult(result: "started" | "restarted") {
  repairService.mockResolvedValue({
    result,
    message: `Gateway service definition repaired and ${result}.`,
    loaded: true,
  });
}
function repairContext(state: unknown = {}) {
  return { json: true, stdout: process.stdout, state, issues: [stalePortIssue] };
}
function expectNoRestartDelivery(...otherMocks: unknown[]) {
  expectUnused(writeRestartIntent, signalPid, ...otherMocks);
}
function mockPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}
function unhealthySnapshot(overrides: Partial<RestartHealthSnapshot> = {}): RestartHealthSnapshot {
  return { ...createHealthyRestartSnapshot(), healthy: false, ...overrides };
}

describe("restart health checks", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  function mockUnmanagedRestart(runPostRestartCheck = false) {
    runServiceRestart.mockImplementation(
      async (params: RestartParams & { onNotLoaded?: () => Promise<unknown> }) => {
        const activationAccepted = Boolean(await params.onNotLoaded?.());
        if (runPostRestartCheck) {
          await runRestartPostCheck(params, activationAccepted);
        }
        return true;
      },
    );
  }

  async function runUnmanagedStop(opts: { json?: boolean; force?: boolean } = { json: true }) {
    let outcome: unknown;
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        outcome = await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );
    await stop(opts);
    return outcome;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    envSnapshot = captureEnv([
      "OPENCLAW_SUPERVISOR_MODE",
      "OPENCLAW_CONTAINER_HINT",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SYSTEMD_UNIT",
    ]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    runServiceStart.mockResolvedValue(undefined);
    runServiceStop.mockResolvedValue(undefined);
    readLockPort.mockResolvedValue(undefined);
    readLockIdentity.mockResolvedValue(createGatewayLockIdentity());
    recoverLaunchAgent.mockResolvedValue(null);
    mockSystemAccountHome();

    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await runRestartPostCheck(params, true);
      return true;
    });
    waitForListener.mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    waitForRestart.mockResolvedValue(createHealthyRestartSnapshot());
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: true } },
    });
    callGatewayCli.mockResolvedValue(createDeferredSafeRestartResult());
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it.each(["started", "restarted"] as const)(
    "recovers an unloaded LaunchAgent (%s) before signaling",
    async (result) => {
      mockPlatform("darwin");
      recoverLaunchAgent.mockResolvedValue({
        result,
        loaded: true,
        message:
          "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.",
      });
      if (result === "started") {
        runServiceStart.mockImplementation(
          async (params: { onNotLoaded?: () => Promise<unknown> }) => {
            await params.onNotLoaded?.();
          },
        );
        await start({ json: true });
        expectExpectedPort(runServiceStart);
      } else {
        findListeners.mockReturnValue([4200]);
        mockUnmanagedRestart(true);
        await restart({ json: true });
        expectUnused(signalPid, waitForListener);
        expectPartialCall(waitForRestart, { supervisorKeepsAlive: true });
      }
      expect(recoverLaunchAgent).toHaveBeenCalledWith({ result });
    },
  );

  it("revalidates native restart authority before mutation", async () => {
    await restart({ json: true });

    const restartParams = requireMockCallArg(runServiceRestart, "runServiceRestart");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    expect(() => (restartParams.beforeServiceMutation as () => void)()).toThrow(
      /non-default state dir/,
    );
  });

  it("re-reads the service environment after repair", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-caller-state";
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway-maintenance.service";
    service.readCommand
      .mockResolvedValueOnce(
        makeServiceCommand("18789", { OPENCLAW_STATE_DIR: "/tmp/openclaw-stale-state" }),
      )
      .mockResolvedValue(
        makeServiceCommand("19001", {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        }),
      );
    mockRepairResult("restarted");
    runServiceRestart.mockImplementation(async (params: RestartParams) => {
      await params.repairLoadedService?.(repairContext());
      await runRestartPostCheck(params, false);
      return true;
    });

    await restart({ json: true });

    expectExpectedPort(runServiceRestart);
    expectPartialCall(waitForRestart, {
      port: 19_001,
      env: expect.objectContaining({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service",
      }),
    });
  });

  it("rejects --skip-deferral without --safe", async () => {
    await expect(restart({ json: true, skipDeferral: true })).rejects.toThrow(
      "--skip-deferral requires --safe",
    );
    expectUnused(callGatewayCli, runServiceRestart);
  });

  it("repairs service port drift on start", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    resolveGatewayPort.mockReturnValue(19_001);
    mockRepairResult("started");
    const state = { command: { environment: { OPENCLAW_GATEWAY_PORT: "18789" } } };
    runServiceStart.mockImplementation(
      async (params: Pick<RestartParams, "repairLoadedService">) => {
        await params.repairLoadedService?.(repairContext(state));
      },
    );

    await start({ json: true });

    expectExpectedPort(runServiceStart, 19_001);
    expectPartialCall(repairService, {
      service,
      json: true,
      state,
      issues: [stalePortIssue],
    });
  });

  it.each([
    { replaced: false, scheduled: false },
    { replaced: true, scheduled: false },
    { replaced: false, scheduled: true },
  ])(
    "retries stale cleanup (replaced=$replaced scheduled=$scheduled)",
    async ({ replaced, scheduled }) => {
      waitForRestart.mockResolvedValueOnce(
        unhealthySnapshot({
          staleGatewayPids: [1993],
          runtime: { status: "stopped" },
        }),
      );
      waitForRestart.mockResolvedValueOnce(createHealthyRestartSnapshot());
      terminateStalePids.mockResolvedValue([1993]);
      service.restart.mockResolvedValue({ outcome: scheduled ? "scheduled" : "completed" });
      if (replaced) {
        readGatewayOwnerLease.mockReturnValue({
          owner: "replacement-owner",
          pid: 1994,
          host: "fixture-host",
          startedAt: 2000,
          port: 18789,
          mode: "supervised",
          supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
          state: "live",
          expired: false,
        });
      }

      await expect(restart({ json: true })).resolves.toBe(true);
      expect(service.restart).toHaveBeenCalledTimes(replaced ? 0 : 1);
      expect(terminateStalePids).toHaveBeenCalledWith(
        [1993],
        expect.objectContaining({ env: process.env, assertCurrent: expect.any(Function) }),
      );
      expect(waitForRestart).toHaveBeenCalledTimes(scheduled ? 1 : 2);
    },
  );

  it.each([
    [
      "timeout",
      360_000,
      "running",
      "Gateway restart timed out after 360s waiting for health checks.",
    ],
    [
      "stopped-free",
      12_500,
      "stopped",
      "Gateway restart failed after 13s: service stayed stopped and health checks never came up.",
    ],
  ] as const)(
    "reports %s using the observed duration",
    async (outcome, elapsedMs, runtime, message) => {
      const { formatCliCommand } = await import("../command-format.js");
      if (outcome === "timeout") {
        mockPlatform("win32");
      }
      waitForRestart.mockResolvedValue(
        unhealthySnapshot({
          runtime: { status: runtime },
          portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
          waitOutcome: outcome,
          elapsedMs,
        }),
      );
      const error = await expectRestartError(restart({ json: true }));
      expect({ message: error.message, hints: error.hints }).toEqual({
        message,
        hints: [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor"),
        ],
      });
      if (outcome === "timeout") {
        expectPartialCall(waitForRestart, {
          attempts: 10_800,
          delayMs: 500,
          port: 18789,
        });
      }
      expect(terminateStalePids).not.toHaveBeenCalled();
      expect(restartDiagnostics).toHaveBeenCalledTimes(1);
    },
  );

  it("force-stops verified listeners instead of the stale lock owner", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findListeners.mockReturnValue([4300, 4300, 4400]);

    await runUnmanagedStop({ json: true, force: true });

    gatewayProcessChecks.listeners(18789, process.env);
    gatewayProcessChecks.signal(4300, "SIGTERM", 18789, process.env);
    gatewayProcessChecks.signal(4400, "SIGTERM", 18789, process.env);
    gatewayProcessChecks.noSignal(4200, "SIGTERM", 18789, process.env);
    expectAudit("stop", "sigterm", 4300);
  });

  it("blocks non-interactive stop before service access", async () => {
    isTerminalInteractive.mockReturnValue(false);
    const { defaultRuntime, ExitError } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    const stopping = stop({ json: true });
    await expect(stopping).rejects.toBeInstanceOf(ExitError);
    await expect(stopping).rejects.toMatchObject({ code: 1 });

    expect(writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "stop",
        ok: false,
        error: expect.stringContaining("openclaw gateway run --dev"),
      }),
    );
    expectUnused(runServiceStop, service.stop, findListeners);
  });

  it("disables unloaded macOS services through the service manager", async () => {
    mockPlatform("darwin");

    await stop({ json: true, disable: true });

    expectPartialCall(runServiceStop, {
      opts: { json: true, disable: true },
      stopWhenNotLoaded: true,
    });
    expectUnused(service.readCommand, loadConfig, resolveGatewayPort);
  });

  it("stops disabled running systemd units through their manager", async () => {
    mockPlatform("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await runUnmanagedStop();

    expectPartialCall(service.stop, { env: process.env, stdout: process.stdout });
    expect(findListeners).not.toHaveBeenCalled();
  });

  it("stops the active lock port despite config drift", async () => {
    readLockIdentity.mockResolvedValue(
      createGatewayLockIdentity({ pid: 4300, port: 39_471, ownerId: undefined }),
    );

    const outcome = await runUnmanagedStop();

    expect(service.readCommand).not.toHaveBeenCalled();
    expectAudit("stop", "sigterm", 4300);
    expect(outcome).toEqual({
      result: "stopped",
      message: "Gateway stop signal sent to unmanaged process on port 39471: 4300.",
    });
    gatewayProcessChecks.listeners(39_471, process.env);
    gatewayProcessChecks.signal(4300, "SIGTERM", 39_471, process.env);
  });

  it("rejects denied Darwin recovery without a listener", async () => {
    mockPlatform("darwin");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    mockUnmanagedRestart();

    await expect(restart({ json: true })).rejects.toThrow(/non-default state dir/);

    expectUnused(recoverLaunchAgent, signalPid);
  });

  it.each([
    ["missing", undefined],
    ["another process", createGatewayLockIdentity({ pid: 4300, ownerId: undefined })],
    ["another port", createGatewayLockIdentity({ port: 19_001, ownerId: undefined })],
  ] as const)("refuses unmanaged restart when the lock identifies %s", async (_label, lock) => {
    mockPlatform("linux");
    readLockIdentity.mockResolvedValue(lock);
    findListeners.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(restart({ json: true })).rejects.toThrow(
      'gateway lock identity does not match the verified listener on port 18789; use "openclaw gateway status --deep"',
    );

    expectNoRestartDelivery(callGatewayCli);
  });

  it.each(["linux", "win32"] as const)(
    "preserves pre-upgrade restart delivery on %s",
    async (platform) => {
      mockPlatform(platform);
      if (platform === "linux") {
        process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
      }
      const lock = createGatewayLockIdentity({ ownerId: undefined });
      readLockIdentity.mockResolvedValue(lock);
      findListeners.mockReturnValue([4200]);
      mockUnmanagedRestart(true);

      await restart({ json: true, wait: "30s" });

      expect(writeRestartIntent).toHaveBeenCalledWith({
        targetPid: 4200,
        reason: "gateway.restart",
        intent: { waitMs: 30_000 },
      });
      if (platform === "win32") {
        expectRestartRpc({ reason: "gateway.restart", skipDeferral: true }, 18_789);
        expectUnused(signalPid, clearRestartIntent);
        expectListenerHealth(10_860, lock, process.env);
      } else {
        gatewayProcessChecks.listeners(18789);
        gatewayProcessChecks.signal(4200, "SIGUSR1", 18789);
        expectUnused(
          findSystemdScope,
          callGatewayCli,
          waitForRestart,
          terminateStalePids,
          service.restart,
        );
        expectAudit("restart", "sigusr1");
        expect(probeGateway).toHaveBeenCalledTimes(1);
        expect(waitForListener).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("restarts and verifies the active port despite config drift", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    callGatewayCli.mockResolvedValueOnce({ ok: true, status: "emitted", pid: 4200 });
    readLockPort.mockResolvedValue(18_789);
    findListeners.mockImplementation((port) => (port === 18_789 ? [4200] : []));
    mockUnmanagedRestart(true);

    await restart({ json: true });

    expectExpectedPort(runServiceRestart, 19_001);
    gatewayProcessChecks.listeners(18_789);
    expectPartialCall(probeGateway, { url: "ws://127.0.0.1:18789" });
    expectPartialCall(callGatewayCli, {
      method: "gateway.restart.request",
      localPortOverride: 18_789,
      params: expect.objectContaining({
        target: { pid: 4200, ownerId: "gateway-owner-old", port: 18_789 },
      }),
    });
    expect(signalPid).not.toHaveBeenCalled();
    expectPartialCall(waitForListener, { port: 18_789 });
  });

  it("rejects restart with multiple listeners", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    findListeners.mockReturnValue([4200, 4300]);
    mockUnmanagedRestart();

    await expect(restart({ json: true })).rejects.toThrow(
      "multiple gateway processes are listening on port 18789",
    );
  });

  it("honors commands.restart in the running gateway config", async () => {
    findListeners.mockReturnValue([4200]);
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: false } },
    });
    mockUnmanagedRestart();

    await expect(restart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
    );
  });

  function mockSystemdScope(unit: string) {
    mockPlatform("linux");
    findSystemdScope.mockResolvedValue({
      scope: "system" as const,
      unitName: unit,
      unitPath: `/etc/systemd/system/${unit}`,
    });
    findListeners.mockReturnValue([4200]);
  }

  it.each([false, true])(
    "delegates system restart (sudo required=%s, #87577)",
    async (sudoRequired) => {
      mockSystemdScope("openclaw.service");
      if (sudoRequired) {
        restartSystemd.mockRejectedValue(
          new Error(
            "openclaw.service is a system-scope unit (/etc/systemd/system/openclaw.service); run `sudo systemctl restart openclaw.service` to restart it",
          ),
        );
      }
      mockUnmanagedRestart();

      const restarting = restart({ json: true });
      if (sudoRequired) {
        await expect(restarting).rejects.toThrow(/sudo systemctl restart openclaw\.service/);
      } else {
        await expect(restarting).resolves.toBe(true);
        expect(restartSystemd).toHaveBeenCalled();
      }
      expectUnused(signalPid, probeGateway);
    },
  );

  it("delegates system stop without signaling (#87577)", async () => {
    mockSystemdScope("openclaw-gateway.service");
    await expect(runUnmanagedStop()).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );
    expect(stopSystemd).toHaveBeenCalled();
    expect(signalPid).not.toHaveBeenCalled();
  });

  it.each([
    ["free", undefined],
    ["unknown", "Could not determine whether port 18789 is still in use"],
  ] as const)(
    "handles an unowned gateway port reported as %s",
    async (portUsage, expectedError) => {
      readLockIdentity.mockResolvedValue(undefined);
      probePortUsage.mockResolvedValue(portUsage);

      const outcome = runUnmanagedStop();
      if (expectedError) {
        await expect(outcome).rejects.toThrow(expectedError);
      } else {
        await expect(outcome).resolves.toBeNull();
      }
    },
  );

  it("resolves port/hosts from service env without --port", async () => {
    const serviceCommand = {
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_STATE_DIR: "/tmp/service-state" },
    };
    service.readCommand.mockResolvedValue(serviceCommand);
    loadConfig.mockReturnValue({ gateway: { port: 18789 } });
    createConfigIO.mockImplementation((opts) => ({
      readBestEffortConfig: async () => ({
        gateway: { port: opts?.env?.OPENCLAW_STATE_DIR === "/tmp/service-state" ? 19000 : 18789 },
      }),
    }));
    resolveGatewayPort.mockImplementation((cfg) => {
      return (cfg as { gateway?: { port?: number } } | undefined)?.gateway?.port ?? 18789;
    });
    readLockIdentity.mockResolvedValue(undefined);
    probePortUsage.mockResolvedValue("busy");

    await expect(runUnmanagedStop()).rejects.toThrow(/Port 19000/);
    expectPartialCall(resolveProbeHosts, { command: serviceCommand });
    expect(probePortUsage).toHaveBeenCalledWith(19000, ["127.0.0.1"]);
  });
  describe("external supervision", () => {
    beforeEach(() => {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      findListeners.mockReturnValue([4200]);
      callGatewayCli.mockResolvedValue({ ok: true, status: "emitted", pid: 4200 });
    });
    async function expectExternalRestartFailure(message: string) {
      const { defaultRuntime } = await import("../../runtime.js");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

      await expectRestartError(restart({ json: true }));

      expectPartialCall(writeJson, {
        action: "restart",
        ok: false,
        error: expect.stringContaining(message),
      });
    }

    it("targets the running Gateway without candidate state access", async () => {
      const lockIdentity = createGatewayLockIdentity({ port: 19_455 });
      readLockPort.mockResolvedValue(19_455);
      readLockIdentity.mockResolvedValue(lockIdentity);

      const { defaultRuntime } = await import("../../runtime.js");
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await expect(restart({ force: true })).resolves.toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Gateway restart request sent to externally supervised process on port 19455: 4200.",
      );
      expect(waitForListener.mock.invocationCallOrder[0]).toBeLessThan(
        log.mock.invocationCallOrder[0]!,
      );

      expectRestartRpc(
        {
          reason: "gateway.restart",
          target: { ...restartTarget, port: 19_455 },
          restartIntent: { force: true, drainBudgetMs: 300_000 },
        },
        19_455,
      );
      expectNoRestartDelivery(
        runServiceRestart,
        service.readCommand,
        findSystemdScope,
        probeGateway,
        loadConfig,
        clearRestartIntent,
      );
      expectAudit("restart", "rpc", 4200, "supervisor");
      expectListenerHealth(720, lockIdentity);
    });

    it("keeps safe restarts on the exact local lock owner", async () => {
      callGatewayCli.mockResolvedValue({
        ok: true,
        status: "scheduled",
        preflight: { safe: false, summary: "restart deferred", blockers: [] },
        restart: { pid: 4200 },
      });

      await restart({ json: true, safe: true, skipDeferral: true });

      expectRestartRpc(
        {
          reason: "gateway.restart.safe",
          safe: true,
          skipDeferral: true,
          target: restartTarget,
        },
        18_789,
        true,
      );
      expectNoRestartDelivery(loadConfig);
    });

    it.each([
      [
        "gateway lock owner changed",
        () => {
          const lock = createGatewayLockIdentity();
          readLockIdentity
            .mockResolvedValueOnce(lock)
            .mockResolvedValueOnce(lock)
            .mockResolvedValue({
              ...lock,
              pid: 4300,
              ownerId: "gateway-owner-new",
              createdAt: "2026-07-16T12:00:01.000Z",
            });
        },
        [clearRestartIntent, callGatewayCli],
      ],
      [
        "invalid restart acknowledgement",
        () => {
          callGatewayCli.mockResolvedValue({
            ok: true,
            status: "deferred",
            restart: { pid: 4200 },
          });
        },
        [waitForListener],
      ],
      [
        "predates targeted restart ownership",
        () => {
          readLockIdentity.mockResolvedValue(createGatewayLockIdentity({ ownerId: undefined }));
        },
        [callGatewayCli],
      ],
    ] as const)("fails closed: %s", async (message, setup, untouched) => {
      setup();
      await expectExternalRestartFailure(message);
      expectNoRestartDelivery(...untouched);
    });

    it.each([
      ["start", () => start({ json: true })],
      ["stop", () => stop({ json: true })],
      ["uninstall", () => uninstall({ json: true })],
      ["preserved restart", () => restart({ json: true, preserveDefinition: true })],
    ])("blocks native %s lifecycle access", async (_action, run) => {
      await expect(run()).rejects.toThrow("gateway lifecycle is managed by an external supervisor");

      expectUnused(
        runServiceStart,
        runServiceRestart,
        runServiceStop,
        runServiceUninstall,
        service.readCommand,
        readLockIdentity,
        callGatewayCli,
        writeRestartIntent,
        signalPid,
      );
    });
  });
});
