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
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
};

const runServiceStart = vi.fn(),
  runServiceRestart = vi.fn(),
  runServiceStop = vi.fn(),
  runServiceUninstall = vi.fn();
const waitForGatewayHealthyListener = vi.fn(),
  waitForGatewayHealthyRestart = vi.fn();
const terminateStaleGatewayPids = vi.fn();
const renderGatewayPortHealthDiagnostics = vi.fn(() => ["diag: unhealthy port"]);
const renderRestartDiagnostics = vi.fn(() => ["diag: unhealthy runtime"]);
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18789));
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn<
  typeof import("../../infra/gateway-processes.js").findVerifiedGatewayListenerPidsOnPortSync
>(() => []);
const signalVerifiedGatewayPidSync =
  vi.fn<typeof import("../../infra/gateway-processes.js").signalVerifiedGatewayPidSync>();
const gatewayProcessChecks = createGatewayProcessExpectations(
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
);
const writeGatewayRestartIntentSync = vi.fn();
const clearGatewayRestartIntentSync = vi.fn();
const resolveGatewayServiceProbeHosts = vi.fn(
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
const readActiveGatewayLockPort = vi.hoisted(() => vi.fn<() => Promise<number | undefined>>());
const readGatewayOwnerLease = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>(),
);
type LockIdentity = { pid: number; ownerId?: string; createdAt: string; port: number };
const readActiveGatewayLockIdentity = vi.hoisted(() =>
  vi.fn<() => Promise<LockIdentity | undefined>>(),
);
const recoverInstalledLaunchAgent = vi.hoisted(() => vi.fn());
const repairLoadedGatewayServiceForStart = vi.hoisted(() => vi.fn());
type SystemdScope = { scope: "user" | "system"; unitName: string; unitPath: string };
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<() => Promise<SystemdScope | null>>(async () => null),
);
const restartSystemdService = vi.hoisted(() =>
  vi.fn<() => Promise<{ outcome: "completed" }>>(async () => ({ outcome: "completed" })),
);
const stopSystemdService = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
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
  findVerifiedGatewayListenerPidsOnPortSync,
  signalVerifiedGatewayPidSync,
  formatGatewayPidList,
}));

vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort,
  readActiveGatewayLockIdentity,
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease }));

vi.mock("../../infra/restart-intent.js", () => ({
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  writeGatewayRestartIntentSync,
  writeGatewayServiceRestartIntentSync: writeGatewayRestartIntentSync,
  clearGatewayRestartIntentSync,
}));

vi.mock("../../gateway/probe.js", () => ({ probeGateway }));

vi.mock("../../gateway/call.js", () => ({ callGatewayCli }));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => service,
}));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope,
  refreshLegacySystemdServiceMetadata: vi.fn(async () => false),
  restartSystemdService,
  stopSystemdService,
}));
vi.mock("./launchd-recovery.js", () => ({
  recoverInstalledLaunchAgent,
}));

vi.mock("./start-repair.js", () => ({
  repairLoadedGatewayServiceForStart,
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

vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({ resolveGatewayServiceProbeHosts }));

vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage }));

vi.mock("./restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./restart-health.js")>()),
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  waitForGatewayHealthyListener,
  waitForGatewayHealthyRestart,
  renderGatewayPortHealthDiagnostics,
  terminateStaleGatewayPids,
  renderRestartDiagnostics,
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
}));

const { runDaemonStart, runDaemonRestart, runDaemonStop, runDaemonUninstall } =
  await import("./lifecycle.js");

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
  expect(waitForGatewayHealthyListener).toHaveBeenCalledWith({
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
  repairLoadedGatewayServiceForStart.mockResolvedValue({
    result,
    message: `Gateway service definition repaired and ${result}.`,
    loaded: true,
  });
}
function repairContext(state: unknown = {}) {
  return { json: true, stdout: process.stdout, state, issues: [stalePortIssue] };
}

describe("runDaemonRestart health checks", () => {
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
    await runDaemonStop(opts);
    return outcome;
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_SUPERVISOR_MODE",
      "OPENCLAW_CONTAINER_HINT",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SYSTEMD_UNIT",
    ]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    runServiceUninstall.mockReset();
    service.readCommand.mockReset();
    service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
    service.restart.mockReset().mockResolvedValue({ outcome: "completed" });
    service.stop.mockReset();
    runServiceStart.mockReset().mockResolvedValue(undefined);
    runServiceStop.mockReset().mockResolvedValue(undefined);
    terminateStaleGatewayPids.mockReset();
    renderGatewayPortHealthDiagnostics.mockReset();
    renderRestartDiagnostics.mockReset();
    resolveGatewayPort.mockReset();
    findVerifiedGatewayListenerPidsOnPortSync.mockReset();
    signalVerifiedGatewayPidSync.mockReset().mockImplementation(() => {});
    writeGatewayRestartIntentSync.mockReset().mockReturnValue(true);
    clearGatewayRestartIntentSync.mockReset();
    formatGatewayPidList.mockReset().mockImplementation((pids) => pids.join(", "));
    probeGateway.mockReset();
    callGatewayCli.mockReset();
    loadConfig.mockReset();
    createConfigIO
      .mockReset()
      .mockImplementation(() => ({ readBestEffortConfig: async () => loadConfig() }));
    readActiveGatewayLockPort.mockReset().mockResolvedValue(undefined);
    readGatewayOwnerLease.mockReset().mockReturnValue(undefined);
    readActiveGatewayLockIdentity.mockReset().mockResolvedValue(createGatewayLockIdentity());
    recoverInstalledLaunchAgent.mockReset().mockResolvedValue(null);
    repairLoadedGatewayServiceForStart.mockReset();
    isTerminalInteractive.mockReset().mockReturnValue(true);
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    resolveGatewayServiceProbeHosts.mockReset().mockResolvedValue(["127.0.0.1"]);
    probePortUsage.mockReset().mockResolvedValue("free");
    mockSystemAccountHome();

    service.readCommand.mockResolvedValue(makeServiceCommand());
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    restartSystemdService.mockReset().mockResolvedValue({ outcome: "completed" });
    stopSystemdService.mockReset().mockResolvedValue(undefined);

    runServiceRestart.mockReset().mockImplementation(async (params: RestartParams) => {
      await runRestartPostCheck(params, true);
      return true;
    });
    waitForGatewayHealthyListener.mockReset().mockResolvedValue({
      healthy: true,
      portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    });
    waitForGatewayHealthyRestart.mockReset().mockResolvedValue(createHealthyRestartSnapshot());
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
    "re-bootstraps an installed unloaded LaunchAgent (%s) before unmanaged signaling",
    async (result) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      recoverInstalledLaunchAgent.mockResolvedValue({
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
        await runDaemonStart({ json: true });
        expectExpectedPort(runServiceStart);
      } else {
        findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
        mockUnmanagedRestart(true);
        await runDaemonRestart({ json: true });
        expectUnused(signalVerifiedGatewayPidSync, waitForGatewayHealthyListener);
        expectPartialCall(waitForGatewayHealthyRestart, { supervisorKeepsAlive: true });
      }
      expect(recoverInstalledLaunchAgent).toHaveBeenCalledWith({ result });
    },
  );

  it("guards loaded service restart at the native mutation boundary", async () => {
    await runDaemonRestart({ json: true });

    const restartParams = requireMockCallArg(runServiceRestart, "runServiceRestart");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    expect(() => (restartParams.beforeServiceMutation as () => void)()).toThrow(
      /non-default state dir/,
    );
  });

  it("re-reads the installed service environment after restart repair", async () => {
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

    await runDaemonRestart({ json: true });

    expectExpectedPort(runServiceRestart);
    expectPartialCall(waitForGatewayHealthyRestart, {
      port: 19_001,
      env: expect.objectContaining({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-repaired-state",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-maintenance.service",
      }),
    });
  });

  it("rejects --skip-deferral without --safe", async () => {
    await expect(runDaemonRestart({ json: true, skipDeferral: true })).rejects.toThrow(
      "--skip-deferral requires --safe",
    );
    expectUnused(callGatewayCli, runServiceRestart);
  });

  it("repairs loaded service definitions with port drift from gateway start", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    resolveGatewayPort.mockReturnValue(19_001);
    mockRepairResult("started");
    const state = { command: { environment: { OPENCLAW_GATEWAY_PORT: "18789" } } };
    runServiceStart.mockImplementation(
      async (params: Pick<RestartParams, "repairLoadedService">) => {
        await params.repairLoadedService?.(repairContext(state));
      },
    );

    await runDaemonStart({ json: true });

    expectExpectedPort(runServiceStart, 19_001);
    expectPartialCall(repairLoadedGatewayServiceForStart, {
      service,
      json: true,
      state,
      issues: [stalePortIssue],
    });
  });

  it.each([
    { terminated: true, replaced: false, scheduled: false },
    { terminated: true, replaced: true, scheduled: false },
    { terminated: true, replaced: false, scheduled: true },
  ])(
    "retries stale cleanup only without a replacement owner (terminated=$terminated replaced=$replaced scheduled=$scheduled)",
    async ({ terminated, replaced, scheduled }) => {
      const unhealthy: RestartHealthSnapshot = {
        healthy: false,
        staleGatewayPids: [1993],
        runtime: { status: "stopped" },
        portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
      };
      waitForGatewayHealthyRestart.mockResolvedValueOnce(unhealthy);
      waitForGatewayHealthyRestart.mockResolvedValueOnce(createHealthyRestartSnapshot());
      terminateStaleGatewayPids.mockResolvedValue(terminated ? [1993] : []);
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

      await expect(runDaemonRestart({ json: true })).resolves.toBe(true);
      expect(service.restart).toHaveBeenCalledTimes(terminated && !replaced ? 1 : 0);
      expect(terminateStaleGatewayPids).toHaveBeenCalledWith(
        [1993],
        expect.objectContaining({ env: process.env, assertCurrent: expect.any(Function) }),
      );
      expect(waitForGatewayHealthyRestart).toHaveBeenCalledTimes(scheduled ? 1 : 2);
    },
  );

  it.each([
    {
      outcome: "timeout",
      elapsedMs: 360_000,
      runtime: "running",
      message: "Gateway restart timed out after 360s waiting for health checks.",
    },
    {
      outcome: "stopped-free",
      elapsedMs: 12_500,
      runtime: "stopped",
      message:
        "Gateway restart failed after 13s: service stayed stopped and health checks never came up.",
    },
  ])(
    "reports $outcome using the observed duration",
    async ({ outcome, elapsedMs, runtime, message }) => {
      const { formatCliCommand } = await import("../command-format.js");
      if (outcome === "timeout") {
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      }
      waitForGatewayHealthyRestart.mockResolvedValue({
        healthy: false,
        staleGatewayPids: [],
        runtime: { status: runtime },
        portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
        waitOutcome: outcome,
        elapsedMs,
      });
      const error = await expectRestartError(runDaemonRestart({ json: true }));
      expect({ message: error.message, hints: error.hints }).toEqual({
        message,
        hints: [
          formatCliCommand("openclaw gateway status --deep"),
          formatCliCommand("openclaw doctor"),
        ],
      });
      if (outcome === "timeout") {
        expectPartialCall(waitForGatewayHealthyRestart, {
          attempts: 10_800,
          delayMs: 500,
          port: 18789,
        });
      }
      expect(terminateStaleGatewayPids).not.toHaveBeenCalled();
      expect(renderRestartDiagnostics).toHaveBeenCalledTimes(1);
    },
  );

  it("forces non-interactive stop of verified listeners instead of the stale lock owner", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4300, 4300, 4400]);

    await runUnmanagedStop({ json: true, force: true });

    gatewayProcessChecks.listeners(18789, process.env);
    gatewayProcessChecks.signal(4300, "SIGTERM", 18789, process.env);
    gatewayProcessChecks.signal(4400, "SIGTERM", 18789, process.env);
    gatewayProcessChecks.noSignal(4200, "SIGTERM", 18789, process.env);
    expectAudit("stop", "sigterm", 4300);
  });

  it("blocks non-interactive stop without force before managed service access", async () => {
    isTerminalInteractive.mockReturnValue(false);
    const { defaultRuntime, ExitError } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    const stopping = runDaemonStop({ json: true });
    await expect(stopping).rejects.toBeInstanceOf(ExitError);
    await expect(stopping).rejects.toMatchObject({ code: 1 });

    expect(writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "stop",
        ok: false,
        error: expect.stringContaining("openclaw gateway run --dev"),
      }),
    );
    expectUnused(runServiceStop, service.stop, findVerifiedGatewayListenerPidsOnPortSync);
  });

  it("routes macOS disable stops through the service manager when not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonStop({ json: true, disable: true });

    expectPartialCall(runServiceStop, {
      opts: { json: true, disable: true },
      stopWhenNotLoaded: true,
    });
    expectUnused(service.readCommand, loadConfig, resolveGatewayPort);
  });

  it("stops a running disabled systemd unit through the service manager", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await runUnmanagedStop();

    expectPartialCall(service.stop, { env: process.env, stdout: process.stdout });
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("stops the active lock port when the configured port has drifted", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4300,
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 39_471,
    });

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

  it("rejects denied Darwin recovery when no unmanaged listener exists", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(/non-default state dir/);

    expectUnused(recoverInstalledLaunchAgent, signalVerifiedGatewayPidSync);
  });

  it.each([
    ["missing", undefined],
    ["another process", { pid: 4300, createdAt: "2026-07-16T12:00:00.000Z", port: 18_789 }],
    ["another port", { pid: 4200, createdAt: "2026-07-16T12:00:00.000Z", port: 19_001 }],
  ] as const)("refuses unmanaged restart when the lock identifies %s", async (_label, lock) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readActiveGatewayLockIdentity.mockResolvedValue(lock);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      'gateway lock identity does not match the verified listener on port 18789; use "openclaw gateway status --deep"',
    );

    expectUnused(writeGatewayRestartIntentSync, signalVerifiedGatewayPidSync, callGatewayCli);
  });

  it.each(["linux", "win32"] as const)(
    "preserves pre-upgrade restart delivery on %s",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      if (platform === "linux") {
        process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
      }
      const lock = createGatewayLockIdentity({ ownerId: undefined });
      readActiveGatewayLockIdentity.mockResolvedValue(lock);
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
      mockUnmanagedRestart(true);

      await runDaemonRestart({ json: true, wait: "30s" });

      expect(writeGatewayRestartIntentSync).toHaveBeenCalledWith({
        targetPid: 4200,
        reason: "gateway.restart",
        intent: { waitMs: 30_000 },
      });
      if (platform === "win32") {
        expectRestartRpc({ reason: "gateway.restart", skipDeferral: true }, 18_789);
        expectUnused(signalVerifiedGatewayPidSync, clearGatewayRestartIntentSync);
        expectListenerHealth(10_860, lock, process.env);
      } else {
        gatewayProcessChecks.listeners(18789);
        gatewayProcessChecks.signal(4200, "SIGUSR1", 18789);
        expectUnused(
          findInstalledSystemdGatewayScope,
          callGatewayCli,
          waitForGatewayHealthyRestart,
          terminateStaleGatewayPids,
          service.restart,
        );
        expectAudit("restart", "sigusr1");
        expect(probeGateway).toHaveBeenCalledTimes(1);
        expect(waitForGatewayHealthyListener).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("restarts and verifies the active unmanaged port despite a config edit", async () => {
    loadConfig.mockReturnValue({ gateway: { port: 19_001 } });
    callGatewayCli.mockResolvedValueOnce({ ok: true, status: "emitted", pid: 4200 });
    readActiveGatewayLockPort.mockResolvedValue(18_789);
    findVerifiedGatewayListenerPidsOnPortSync.mockImplementation((port) =>
      port === 18_789 ? [4200] : [],
    );
    mockUnmanagedRestart(true);

    await runDaemonRestart({ json: true });

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
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expectPartialCall(waitForGatewayHealthyListener, { port: 18_789 });
  });

  it("fails unmanaged restart when multiple gateway listeners are present", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200, 4300]);
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "multiple gateway processes are listening on port 18789",
    );
  });

  it("fails unmanaged restart when the running gateway has commands.restart disabled", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
    probeGateway.mockResolvedValue({
      ok: true,
      configSnapshot: { commands: { restart: false } },
    });
    mockUnmanagedRestart();

    await expect(runDaemonRestart({ json: true })).rejects.toThrow(
      "Gateway restart is disabled in the running gateway config",
    );
  });

  function mockSystemdScope(unit: string) {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system" as const,
      unitName: unit,
      unitPath: `/etc/systemd/system/${unit}`,
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
  }

  it.each([false, true])(
    "delegates system-scope restart without signaling (sudo required=%s, #87577)",
    async (sudoRequired) => {
      mockSystemdScope("openclaw.service");
      if (sudoRequired) {
        restartSystemdService.mockRejectedValue(
          new Error(
            "openclaw.service is a system-scope unit (/etc/systemd/system/openclaw.service); run `sudo systemctl restart openclaw.service` to restart it",
          ),
        );
      }
      mockUnmanagedRestart();

      const restarting = runDaemonRestart({ json: true });
      if (sudoRequired) {
        await expect(restarting).rejects.toThrow(/sudo systemctl restart openclaw\.service/);
      } else {
        await expect(restarting).resolves.toBe(true);
        expect(restartSystemdService).toHaveBeenCalled();
      }
      expectUnused(signalVerifiedGatewayPidSync, probeGateway);
    },
  );

  it("delegates system-scope stop to systemctl without unmanaged signaling when root (openclaw#87577)", async () => {
    mockSystemdScope("openclaw-gateway.service");
    stopSystemdService.mockResolvedValue(undefined);
    await expect(runUnmanagedStop()).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it.each([
    ["free", undefined],
    ["unknown", "Could not determine whether port 18789 is still in use"],
  ] as const)(
    "handles an unowned gateway port reported as %s",
    async (portUsage, expectedError) => {
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
      readActiveGatewayLockIdentity.mockResolvedValue(undefined);
      probePortUsage.mockResolvedValue(portUsage);

      const outcome = runUnmanagedStop();
      if (expectedError) {
        await expect(outcome).rejects.toThrow(expectedError);
      } else {
        await expect(outcome).resolves.toBeNull();
      }
    },
  );

  it("resolves port and probe hosts from selected service config/env (no --port arg)", async () => {
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
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    probePortUsage.mockResolvedValue("busy");

    await expect(runUnmanagedStop()).rejects.toThrow(/Port 19000/);
    expectPartialCall(resolveGatewayServiceProbeHosts, { command: serviceCommand });
    expect(probePortUsage).toHaveBeenCalledWith(19000, ["127.0.0.1"]);
  });
  describe("external supervision", () => {
    beforeEach(() => {
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
      callGatewayCli.mockResolvedValue({ ok: true, status: "emitted", pid: 4200 });
    });
    async function expectExternalRestartFailure(message: string) {
      const { defaultRuntime } = await import("../../runtime.js");
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

      await expectRestartError(runDaemonRestart({ json: true }));

      expectPartialCall(writeJson, {
        action: "restart",
        ok: false,
        error: expect.stringContaining(message),
      });
    }

    it("restarts through the exact running Gateway without candidate state access", async () => {
      const lockIdentity = createGatewayLockIdentity({ port: 19_455 });
      readActiveGatewayLockPort.mockResolvedValue(19_455);
      readActiveGatewayLockIdentity.mockResolvedValue(lockIdentity);

      const { defaultRuntime } = await import("../../runtime.js");
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await expect(runDaemonRestart({ force: true })).resolves.toBe(true);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Gateway restart request sent to externally supervised process on port 19455: 4200.",
      );
      expect(waitForGatewayHealthyListener.mock.invocationCallOrder[0]).toBeLessThan(
        log.mock.invocationCallOrder[0]!,
      );

      expectUnused(
        runServiceRestart,
        service.readCommand,
        findInstalledSystemdGatewayScope,
        probeGateway,
        loadConfig,
      );
      expectRestartRpc(
        {
          reason: "gateway.restart",
          target: { ...restartTarget, port: 19_455 },
          restartIntent: { force: true, drainBudgetMs: 300_000 },
        },
        19_455,
      );
      expectUnused(
        writeGatewayRestartIntentSync,
        clearGatewayRestartIntentSync,
        signalVerifiedGatewayPidSync,
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

      await runDaemonRestart({ json: true, safe: true, skipDeferral: true });

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
      expectUnused(loadConfig, writeGatewayRestartIntentSync, signalVerifiedGatewayPidSync);
    });

    it("does not touch state when lock ownership changes before delivery", async () => {
      const gatewayLockIdentity = createGatewayLockIdentity();
      readActiveGatewayLockIdentity
        .mockResolvedValueOnce(gatewayLockIdentity)
        .mockResolvedValueOnce(gatewayLockIdentity)
        .mockResolvedValue({
          ...gatewayLockIdentity,
          pid: 4300,
          ownerId: "gateway-owner-new",
          createdAt: "2026-07-16T12:00:01.000Z",
        });

      await expectExternalRestartFailure("gateway lock owner changed");

      expectUnused(
        writeGatewayRestartIntentSync,
        clearGatewayRestartIntentSync,
        callGatewayCli,
        signalVerifiedGatewayPidSync,
      );
    });

    it("rejects a legacy generic restart acknowledgement", async () => {
      callGatewayCli.mockResolvedValue({
        ok: true,
        status: "deferred",
        restart: { pid: 4200 },
      });

      await expectExternalRestartFailure("invalid restart acknowledgement");

      expectUnused(
        writeGatewayRestartIntentSync,
        signalVerifiedGatewayPidSync,
        waitForGatewayHealthyListener,
      );
    });

    it("fails closed before delivery for a pre-targeted-restart Gateway lock", async () => {
      readActiveGatewayLockIdentity.mockResolvedValue(
        createGatewayLockIdentity({ ownerId: undefined }),
      );

      await expectExternalRestartFailure("predates targeted restart ownership");

      expectUnused(callGatewayCli, writeGatewayRestartIntentSync, signalVerifiedGatewayPidSync);
    });

    it.each([
      ["start", () => runDaemonStart({ json: true })],
      ["stop", () => runDaemonStop({ json: true })],
      ["uninstall", () => runDaemonUninstall({ json: true })],
      ["preserved restart", () => runDaemonRestart({ json: true, preserveDefinition: true })],
    ])("blocks native %s lifecycle access", async (_action, run) => {
      await expect(run()).rejects.toThrow("gateway lifecycle is managed by an external supervisor");

      expectUnused(
        runServiceStart,
        runServiceRestart,
        runServiceStop,
        runServiceUninstall,
        service.readCommand,
        readActiveGatewayLockIdentity,
        callGatewayCli,
        writeGatewayRestartIntentSync,
        signalVerifiedGatewayPidSync,
      );
    });
  });
});
