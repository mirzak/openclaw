import { hostname } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveConfigPath } from "../../config/paths.js";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { acquireGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import * as stateOwner from "../../infra/gateway-state-owner.js";
import {
  prepareGatewayRestartIntentConsumption,
  type GatewayRestartIntent,
} from "../../infra/restart-intent.js";
import * as processOwners from "../../infra/state-lease-process-owner.js";
import * as existingWrites from "../../state/openclaw-state-db-existing-write.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  createGatewayServiceRunArgs,
  lifecycleTestRuntime as runtime,
  lifecycleRuntimeLogs as logs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
} from "./test-helpers/lifecycle-core-harness.js";

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("./lifecycle-audit.js", () => ({
  createServiceLifecycleMutationAudit: () => undefined,
  appendServiceLifecycleRepairAudit: vi.fn(),
}));

const tempDirs = createTempDirTracker();
const { runServiceRestart } = await import("./lifecycle-core.js");
const releases: Array<() => void | Promise<void>> = [];
type RestartOptions = Parameters<typeof runServiceRestart>[0]["opts"];
const restart = (opts: RestartOptions = { json: true }) =>
  runServiceRestart({ ...createGatewayServiceRunArgs(), opts });

const readIntent = () =>
  stateDatabase
    .openOpenClawStateDatabase()
    .db.prepare("SELECT pid, reason FROM gateway_restart_intent")
    .get();
const runtimeOutput = () => [...logs, ...runtime.error.mock.calls.flat()].join("\n");

async function expectConsumedIntent(
  expected: GatewayRestartIntent,
  env = process.env,
  opts: RestartOptions = { json: true },
) {
  let consumed: GatewayRestartIntent | null = null;
  service.restart.mockImplementationOnce(async () => {
    consumed = await prepareGatewayRestartIntentConsumption(env)();
    return { outcome: "completed" };
  });
  await expect(restart(opts)).resolves.toBe(true);
  expect(consumed).toEqual(expected);
}

function expectNoRestart() {
  expect(service.restart).not.toHaveBeenCalled();
  expect(readIntent()).toBeUndefined();
}

async function expectRestartRefused(message?: string, json = true) {
  await expect(restart({ json })).rejects.toThrow("__exit__:1");
  expectNoRestart();
  if (message) {
    expect(runtimeOutput()).toContain(message);
  }
}

function acquireStateOwner(env = process.env, serving = true) {
  const owner = stateOwner.acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(env),
    payload: serving
      ? {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          configPath: resolveConfigPath(env),
          role: "gateway",
        }
      : undefined,
  });
  releases.push(() => owner.release());
}

function beforeIntentWriteAdmission(operation: () => void) {
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (mutate, options, contract) => {
      if (contract.operationLabel === "gateway.restart-intent.write") {
        operation();
      }
      return write(mutate, options, contract);
    },
  );
}

function publishServingOwner(
  pid: number,
  mode: "supervised" | "foreground" = "supervised",
  name: string | null = "openclaw-gateway.service",
) {
  const { db } = stateDatabase.openOpenClawStateDatabase();
  const now = Date.now();
  const payload = JSON.stringify({
    owner: { pid, host: hostname(), startedAt: 1 },
    port: 18789,
    mode,
    supervisor: mode === "supervised" ? { kind: "systemd", name } : null,
  });
  db.prepare(
    `INSERT INTO state_leases
     (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
     VALUES ('gateway-owner', 'global', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, lease_key) DO UPDATE SET
       owner = excluded.owner, payload_json = excluded.payload_json`,
  ).run(`generation-${pid}`, now + 60_000, now, payload, now, now);
}

beforeEach(() => {
  resetLifecycleRuntimeLogs();
  runtime.error.mockClear();
  resetLifecycleServiceMocks();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-restart-intent-cli-"));
  vi.stubEnv("OPENCLAW_PROFILE", "default");
  vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "");
  vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "");
  service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid + 1 });
});

afterEach(async () => {
  try {
    for (const release of releases.splice(0).toReversed()) {
      await release();
    }
  } finally {
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it.each([
  { platform: "linux", supervisor: { kind: "systemd", name: "openclaw-gateway" } },
  { platform: "darwin", supervisor: { kind: "launchd", name: "ai.openclaw.gateway" } },
] as const)("delivers managed $platform restart intent", async ({ platform, supervisor }) => {
  const nativePlatform = process.platform;
  const stateDir = tempDirs.make("openclaw-serving-state-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  acquireStateOwner(env);
  const lease = acquireGatewayOwnerLease({ env, port: 18789, mode: "supervised", supervisor });
  releases.push(() => lease.release());
  await lease.ready;
  const servicePlatform = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const readOwnerStatus = processOwners.readStateLeaseProcessOwnerStatus;
  // Service selection is synthetic; the real lease still belongs to this host.
  vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockImplementation((...args) => {
    servicePlatform.mockReturnValue(nativePlatform);
    try {
      return readOwnerStatus(...args);
    } finally {
      servicePlatform.mockReturnValue(platform);
    }
  });
  service.readRuntime.mockResolvedValue({
    status: "running",
    pid: process.pid + 1,
    ...(platform === "linux" ? { systemd: { unit: "openclaw-gateway.service" } } : {}),
  });
  service.readCommand.mockResolvedValue({
    programArguments: ["node", "openclaw.mjs", "gateway", "run"],
    environment: { OPENCLAW_STATE_DIR: stateDir },
  });
  await expectConsumedIntent({ reason: "gateway.restart", waitMs: 30_000 }, env, {
    json: true,
    preserveDefinition: true,
    restartIntent: { waitMs: 30_000 },
  });
  expect(await prepareGatewayRestartIntentConsumption(env)()).toBeNull();
});

it("targets the replacement at write admission despite stopped native status", async () => {
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  mockProcessPlatform("linux");
  // Only process liveness is synthetic; owner replacement and intent consumption use SQLite.
  vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue("live");
  acquireStateOwner();
  publishServingOwner(process.pid + 2);
  const publish = vi.fn(() => {
    publishServingOwner(process.pid);
  });
  beforeIntentWriteAdmission(publish);
  await expectConsumedIntent({ reason: "gateway.restart" });
  expect(publish).toHaveBeenCalledOnce();
});

it.each([
  { state: "unknown", mode: "supervised", name: "openclaw-gateway.service" },
  { state: "live", mode: "foreground", name: "openclaw-gateway.service" },
  { state: "live", mode: "supervised", name: "another-gateway.service" },
  { state: "live", mode: "supervised", name: null },
] as const)("refuses owner $state/$mode/$name", async ({ state, mode, name }) => {
  mockProcessPlatform("linux");
  vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue(state);
  stateDatabase.openOpenClawStateDatabase();
  acquireStateOwner();
  publishServingOwner(process.pid + 2, mode, name);
  service.readRuntime.mockResolvedValue({ status: "running", pid: process.pid });

  await expectRestartRefused("live serving Gateway owner");
});

it.each(["command inspection", "missing command", "intent recording"])(
  "refuses native restart after failed %s",
  async (failure) => {
    mockProcessPlatform("linux");
    stateDatabase.openOpenClawStateDatabase();
    if (failure === "command inspection") {
      publishServingOwner(process.pid);
      vi.spyOn(processOwners, "readStateLeaseProcessOwnerStatus").mockReturnValue("live");
      service.readCommand.mockRejectedValue(new Error("native command inspection unavailable"));
    } else if (failure === "missing command") {
      service.readCommand.mockResolvedValue(null);
    } else {
      beforeIntentWriteAdmission(() => {
        throw new Error("write admission unavailable");
      });
    }
    await expectRestartRefused(
      failure === "intent recording" ? "Cannot record restart intent" : "effective service command",
      failure !== "command inspection",
    );
    if (failure === "command inspection") {
      expect(runtimeOutput()).toContain("GATEWAY_RESTART_PREPARATION_REFUSED");
      expect(runtimeOutput()).toContain("Gateway was not signaled");
    }
  },
);

it.each([false, true])("requires no active owner for startup (%s)", async (active) => {
  mockProcessPlatform("linux");
  const { db } = stateDatabase.openOpenClawStateDatabase();
  if (active) {
    acquireStateOwner(process.env, false);
  } else {
    stateDatabase.closeOpenClawStateDatabaseForTest();
  }
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  service.restart.mockImplementationOnce(async () => {
    const exclusion = stateOwner.tryAcquireGatewayStateOwner(
      resolveOpenClawStateSqlitePath(process.env),
    );
    expect(exclusion).not.toBeNull();
    exclusion?.release();
    return { outcome: "completed" };
  });

  if (active) {
    await expect(restart()).rejects.toThrow("__exit__:1");
    expect(service.restart).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM gateway_restart_intent").get()).toEqual({
      count: 0,
    });
  } else {
    await expect(restart()).resolves.toBe(true);
    expect(service.restart).toHaveBeenCalledOnce();
    expect(readIntent()).toBeUndefined();
  }
});

it.each(["runtime", "command", "write admission"])(
  "revalidates authority after %s inspection",
  async (inspection) => {
    mockProcessPlatform("linux");
    stateDatabase.openOpenClawStateDatabase();
    const authority = new AbortController();
    const revoke = () => authority.abort(new Error("update owner revoked"));
    if (inspection === "runtime") {
      service.readRuntime.mockImplementationOnce(async () => {
        revoke();
        return { status: "running", pid: process.pid };
      });
    } else if (inspection === "command") {
      service.readCommand.mockImplementationOnce(async () => {
        revoke();
        return { programArguments: [] };
      });
    } else {
      beforeIntentWriteAdmission(revoke);
    }

    await expect(
      withGatewayServiceUpdateAuthority(() => authority.signal.throwIfAborted(), restart),
    ).rejects.toThrow();

    expectNoRestart();
  },
);
