import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { expectNoCalls, expectPartialCall } from "./lifecycle-assertions.test-support.js";
import {
  lifecycleTestRuntime,
  lifecycleRuntimeLogs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const owner = vi.hoisted(() => ({
  owner: "foreground-generation",
  pid: 9472,
  host: "fixture-host",
  startedAt: 100,
  port: 18789,
  mode: "foreground" as const,
  state: "live" as const,
}));
const readyProbe = vi.hoisted(() => ({
  ok: true,
  configSnapshot: { commands: { restart: true } },
}));
const mocks = vi.hoisted(() => ({
  readOwner: vi.fn<(params?: { env?: NodeJS.ProcessEnv }) => typeof owner | undefined>(() => owner),
  readLock: vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockIdentity>(),
  probeGateway: vi.fn(async () => readyProbe),
  writeIntent: vi.fn(() => true),
  clearIntent: vi.fn(),
  signalPid: vi.fn(),
  callGatewayCli: vi.fn(async () => ({ pid: owner.pid })),
  waitForGatewayHealthyListener: vi.fn(async () => ({ healthy: true })),
}));
const lock = {
  ownerId: owner.owner,
  pid: owner.pid,
  port: owner.port,
  createdAt: "2026-09-13T02:27:25Z",
};
const command = { programArguments: ["gateway", "--port", "18789"], environment: {} };

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));
vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  readBestEffortConfig: async () => ({ gateway: { port: 18789 } }),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: () => ({ readBestEffortConfig: async () => ({ gateway: { port: 18789 } }) }),
}));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease: mocks.readOwner }));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: async () => owner.port,
  readActiveGatewayLockIdentity: mocks.readLock,
  isSameGatewayLockIdentity: (a: { ownerId?: string }, b: { ownerId?: string }) =>
    a.ownerId === b.ownerId,
}));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: () => [owner.pid],
  signalVerifiedGatewayPidSync: mocks.signalPid,
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));
vi.mock("../../gateway/probe.js", () => ({ probeGateway: mocks.probeGateway }));
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: mocks.callGatewayCli }));
vi.mock("./restart-health.js", async (original) => ({
  ...(await original<typeof import("./restart-health.js")>()),
  waitForGatewayHealthyListener: mocks.waitForGatewayHealthyListener,
}));
vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: vi.fn(),
  createGatewayLifecycleMutationAudit: () => undefined,
  createServiceLifecycleMutationAudit: () => undefined,
  appendServiceLifecycleRepairAudit: vi.fn(),
}));
vi.mock("../../infra/restart-intent.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-intent.js")>()),
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  writeGatewayRestartIntentSync: mocks.writeIntent,
  writeGatewayServiceRestartIntentSync: () => true,
  clearGatewayRestartIntentSync: mocks.clearIntent,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetLifecycleRuntimeLogs();
  resetLifecycleServiceMocks();
  stubEmptyGatewayEnv();
  mockSystemAccountHome();
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
  mocks.readOwner.mockImplementation((params) =>
    params?.env?.OPENCLAW_STATE_DIR === "foreign-service-state" ? undefined : owner,
  );
  mocks.readLock.mockReset().mockResolvedValue(lock);
  mocks.probeGateway.mockReset().mockResolvedValue(readyProbe);
  mocks.writeIntent.mockReset().mockReturnValue(true);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  service.readCommand.mockResolvedValue(command);
  service.restart.mockRejectedValue(new Error("gateway port 18789 is still busy before restart"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["config probe", "legacy intent write"])(
  "refuses a replacement owner at %s",
  async (phase) => {
    const replaceOwner = () =>
      mocks.readLock.mockResolvedValue({ ...lock, ownerId: "replacement-owner" });
    if (phase === "config probe") {
      mocks.probeGateway.mockImplementationOnce(async () => {
        replaceOwner();
        return readyProbe;
      });
    } else {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      mocks.readLock.mockResolvedValue({ ...lock, ownerId: undefined });
      mocks.writeIntent.mockImplementationOnce(() => {
        replaceOwner();
        return true;
      });
    }
    const { signalGatewayRestart } = await import("./lifecycle-unmanaged.js");
    await expect(
      signalGatewayRestart(owner.port, {
        enforceRestartConfig: true,
        processLabel: "unmanaged",
        auditSource: "cli",
      }),
    ).rejects.toThrow("gateway lock owner changed");
    expectNoCalls(mocks.signalPid, mocks.callGatewayCli);
    if (phase === "config probe") {
      expect(mocks.writeIntent).not.toHaveBeenCalled();
    } else {
      expect(mocks.writeIntent).toHaveBeenCalledOnce();
      expect(mocks.clearIntent).toHaveBeenCalledOnce();
    }
  },
);

it("restarts the selected foreground owner before reporting healthy recovery", async () => {
  service.readCommand.mockResolvedValue({
    ...command,
    environment: { OPENCLAW_STATE_DIR: "foreign-service-state" },
  });
  const { runDaemonRestart } = await import("./lifecycle.js");
  await expect(runDaemonRestart({ json: true })).resolves.toBe(true);
  expect(lifecycleRuntimeLogs).toHaveLength(1);
  expect(JSON.parse(lifecycleRuntimeLogs[0]!)).toMatchObject({ ok: true, result: "restarted" });
  expectPartialCall(mocks.callGatewayCli, {
    method: "gateway.restart.request",
    params: expect.objectContaining({
      target: { pid: owner.pid, ownerId: owner.owner, port: owner.port },
    }),
  });
  expectNoCalls(service.restart, service.install);
  expect(mocks.callGatewayCli).toHaveBeenCalledOnce();
  expect(mocks.waitForGatewayHealthyListener).toHaveBeenCalledTimes(2);
  expect(mocks.waitForGatewayHealthyListener).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      port: owner.port,
      previousLockIdentity: lock,
    }),
  );
  const [before, after] = mocks.waitForGatewayHealthyListener.mock.invocationCallOrder;
  const request = mocks.callGatewayCli.mock.invocationCallOrder[0]!;
  expect(before).toBeLessThan(request);
  expect(request).toBeLessThan(after!);
  expect(after).toBeLessThan(lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!);
});
