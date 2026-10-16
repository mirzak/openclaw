import "../test-utils/prepare-compiled-subprocesses.js";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  LeaseHeartbeatParentMessage,
  LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import type { StateLeaseRenewal } from "./openclaw-state-lease-renewal.worker.js";

const fixture = vi.hoisted(() => ({
  worker: undefined as EventEmitter | undefined,
  data: undefined as LeaseHeartbeatWorkerData | undefined,
  renew: vi.fn<() => number | undefined>(),
  readExpiry: vi.fn<() => number | undefined>(),
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  const parentPort = Object.assign(new EventEmitter(), {
    postMessage: (message: unknown) => fixture.worker?.emit("message", structuredClone(message)),
    close: () => queueMicrotask(() => fixture.worker?.emit("exit", 0)),
  });
  return {
    ...actual,
    isMainThread: false,
    get workerData() {
      return fixture.data;
    },
    parentPort,
    Worker: class extends EventEmitter {
      stdout = { resume() {} };
      stderr = { resume() {} };
      constructor(_url: URL, options: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        fixture.data = options.workerData;
        fixture.worker = this;
      }
      postMessage(message: LeaseHeartbeatParentMessage) {
        queueMicrotask(() => parentPort.emit("message", structuredClone(message)));
      }
      async terminate() {
        this.emit("exit", 0);
        return 0;
      }
    },
  };
});
vi.mock("../infra/gateway-state-owner.js", () => ({
  assertStateDatabaseAccessAllowed() {},
  GatewayStateOwnerContentionError: class extends Error {},
}));
vi.mock("../infra/sqlite-worker-identity.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/sqlite-worker-identity.js")>(
    "../infra/sqlite-worker-identity.js",
  )),
  readDatabasePathIdentitySync: (canonicalPath: string) => ({ key: "file:12:34", canonicalPath }),
}));
vi.mock("../infra/sqlite-busy-timeout.js", () => ({
  runWithSqliteBusyTimeout: (_db: unknown, _ms: number, run: () => unknown) => run(),
}));
// mock-isolation: The heartbeat diagnostic fixture has no native database or transaction custody.
vi.mock("../infra/sqlite-transaction.js", () => ({
  runSqliteImmediateTransactionSync: (_db: unknown, run: () => unknown) => run(),
  runSqliteDeferredTransactionSync: (_db: unknown, run: () => unknown) => run(),
  runSqliteReadSnapshotSync: (_db: unknown, run: () => unknown) => run(),
  retainSqliteWriteAdmissionService: () => () => {},
}));
vi.mock("./openclaw-state-db-handle.js", () => ({
  openTrackedStateDatabase: () => ({}),
  closeTrackedStateDatabase() {},
}));
vi.mock("./openclaw-state-lease-store.js", () => ({
  renewOpenClawStateLeaseInTransaction: fixture.renew,
  readOpenClawStateLeaseExpiry: fixture.readExpiry,
}));
// mock-isolation: Diagnostics inject storage outcomes; scheduler tests cover native SQLite.
vi.mock("./openclaw-state-lease-renewal.worker.js", () => ({
  createStateLeaseRenewalScheduler: () => {
    const pending = new Map<StateLeaseRenewal, ReturnType<typeof setTimeout>>();
    return {
      schedule(entry: StateLeaseRenewal, expiresAt: number) {
        clearTimeout(pending.get(entry));
        const complete = () => {
          pending.delete(entry);
          try {
            entry.complete({ expiresAt: fixture.renew() });
          } catch (error) {
            entry.complete({ error });
          }
        };
        const delay = expiresAt - entry.leaseMs + entry.intervalMs - Date.now();
        pending.set(entry, setTimeout(complete, delay));
      },
      cancel(entry: StateLeaseRenewal) {
        clearTimeout(pending.get(entry));
        pending.delete(entry);
      },
    };
  },
}));

const acquiredAt = 1_800_000_000_000;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(acquiredAt + 100);
  fixture.renew.mockReset().mockImplementation(() => Date.now() + 60_000);
  fixture.readExpiry.mockReset().mockReturnValue(acquiredAt + 60_000);
});
afterEach(() => vi.useRealTimers());

async function start() {
  const { startOpenClawStateLeaseHeartbeat } = await import("./openclaw-state-lease-heartbeat.js");
  const onLost = vi.fn();
  const heartbeat = startOpenClawStateLeaseHeartbeat({
    path: "/synthetic-state/lease.sqlite",
    identity: { scope: "test:diagnostics", key: "lease", owner: "owner" },
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    acquiredAt,
    expiresAt: acquiredAt + 60_000,
    onLost,
  });
  const outcome = heartbeat.ready.catch((error: unknown) => error);
  await import("./openclaw-state-lease-heartbeat.worker.js");
  await vi.advanceTimersByTimeAsync(0);
  return { ...heartbeat, outcome, onLost, [Symbol.asyncDispose]: () => heartbeat.stop() };
}

it("retains activation storage failure diagnostics", async () => {
  const failure = Object.assign(new Error("synthetic disk I/O error"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 266,
  });
  fixture.renew.mockImplementation(() => {
    throw failure;
  });
  await using heartbeat = await start();
  const { outcome, onLost } = heartbeat;
  const error: unknown = onLost.mock.calls[0]?.[0];
  expect(String(error)).toContain("lossPath=activation");
  expect(error).toMatchObject({
    cause: {
      name: "Error",
      message: failure.message,
      code: failure.code,
      errcode: 266,
      attempt: 1,
      elapsedMs: 100,
    },
  });
  expect(String(error)).toContain("state lease heartbeat exited");
  expect(String(error)).toContain("Error: synthetic disk I/O error");
  expect(String(error)).toContain("code=ERR_SQLITE_ERROR, errcode=266");
  expect(String(error)).toContain(`acquiredAt=${acquiredAt}`);
  expect(String(error)).toContain("lastRenewedAt=never");
  expect(String(error)).toContain("attempt=1");
  expect(String(error)).toContain("elapsedMs=100");
  expect(String(error)).toContain("lossOutcome=operation-error");
  expect(await outcome).toBe(error);
});

it("retains automatic ownership-loss diagnostics after renewal", async () => {
  fixture.renew.mockReturnValue(undefined).mockImplementationOnce(() => Date.now() + 60_000);
  await using heartbeat = await start();
  const { outcome, onLost } = heartbeat;
  await expect(outcome).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(20_000);
  const error: unknown = onLost.mock.calls[0]?.[0];
  expect(String(error)).toContain("lossPath=automatic-renewal");
  expect(String(error)).toContain("expired or ownership lost");
  expect(String(error)).toContain("lossOutcome=no-current-owned-unexpired-row");
  expect(error).not.toHaveProperty("cause");
});

it.each([
  ["verify", true],
  ["renew", false],
  ["renew", true],
] as const)("retains explicit %s loss with operation error=%s", async (operation, throws) => {
  await using heartbeat = await start();
  const { outcome, onLost } = heartbeat;
  await expect(outcome).resolves.toBeUndefined();
  const action = operation === "verify" ? fixture.readExpiry : fixture.renew;
  action.mockImplementation(() => {
    if (throws) {
      throw new Error("synthetic operation failure");
    }
    return undefined;
  });
  const rejected = heartbeat[operation]().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(await rejected).toMatchObject({
    code: throws ? "OPENCLAW_STATE_LEASE_STORAGE_FAILED" : "OPENCLAW_STATE_LEASE_LOST",
    message: expect.stringContaining(
      `lossPath=explicit-${operation}, lossOutcome=${throws ? "operation-error" : "no-current-owned-unexpired-row"}`,
    ),
    ...(throws ? { cause: { message: "synthetic operation failure" } } : {}),
  });
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(String(onLost.mock.calls[0]?.[0])).toContain(`lossPath=explicit-${operation}`);
});

it("still retries SQLite contention", async () => {
  const errcode = 6;
  fixture.renew.mockImplementationOnce(() => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode });
  });
  await using heartbeat = await start();
  const { outcome, onLost } = heartbeat;
  await expect(outcome).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(24);
  expect(fixture.renew).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.renew).toHaveBeenCalledTimes(2);
  expect(onLost).not.toHaveBeenCalled();
  fixture.worker?.emit("exit", 1);
  expect(String(onLost.mock.calls[0]?.[0])).toContain("exitCode=1");
  expect(String(onLost.mock.calls[0]?.[0])).toContain(`lastRenewedAt=${acquiredAt + 125}`);
  expect(String(onLost.mock.calls[0]?.[0])).not.toContain("lossPath=");
});
