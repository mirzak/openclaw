import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type FakeDatabase = {
  isOpen: boolean;
  exec: () => void;
  prepare: (sql: string) => { get: () => unknown };
  close: () => void;
};
const mock = vi.hoisted(() => ({
  handler: vi.fn<(input: unknown) => Promise<OpenClawStateReadReply>>(),
  open: vi.fn<(location: string) => FakeDatabase>(),
  read: vi.fn<(sql: string) => unknown>(),
  close: vi.fn<() => void>(),
  query: vi.fn<() => []>(),
  claimAgentLease: vi.fn(() => "quarantine-test-lease"),
  databases: [] as FakeDatabase[],
}));
vi.mock("../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks: (handler: (input: unknown) => Promise<OpenClawStateReadReply>) => {
    mock.handler.mockImplementation(handler);
  },
}));
vi.mock("../infra/node-sqlite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/node-sqlite.js")>()),
  openNodeSqliteDatabase: mock.open,
}));
vi.mock("./backup-run-records.kernel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backup-run-records.kernel.js")>()),
  readBackupRunsInDatabase: mock.query,
}));
vi.mock("./openclaw-agent-db-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-agent-db-lease.js")>()),
  claimOpenClawAgentDatabaseLease: mock.claimAgentLease,
  releaseOpenClawAgentDatabaseLease: vi.fn(),
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  closeRetainedOpenClawStateReadConnections: vi.fn(),
  withOpenClawStateReadOnlyLocation: (operation: (source: { db: object }) => unknown) =>
    operation({ db: {} }),
}));

import "./openclaw-state-read.worker.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());
beforeEach(() => {
  mock.databases.length = 0;
  mock.read.mockReset().mockReturnValue({ user_version: 0 });
  mock.close.mockReset();
  mock.query.mockReset().mockReturnValue([]);
  mock.claimAgentLease.mockClear();
  mock.open.mockReset().mockImplementation((location) => {
    if (!location.endsWith("openclaw-quarantine.sqlite")) {
      throw new Error(`Unexpected source database open: ${location}`);
    }
    const database: FakeDatabase = {
      isOpen: true,
      exec() {},
      prepare: (sql) => ({ get: () => mock.read(sql) }),
      close() {
        mock.close();
        database.isOpen = false;
      },
    };
    mock.databases.push(database);
    return database;
  });
});

function request(): OpenClawStateReadRequest {
  const root = tempDirs.make("openclaw-quarantine-cleanup-");
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  // Only existence/identity are real; every SQLite connection is a plain mocked object.
  fs.writeFileSync(path.join(state, "openclaw-quarantine.sqlite"), "mock quarantine store");
  const databasePath = path.join(state, "openclaw.sqlite");
  fs.writeFileSync(databasePath, "mock state source");
  return {
    context: {
      environment: { OPENCLAW_STATE_DIR: root },
    },
    databasePath,
    location: databasePath,
    checkFreshAdmission: true,
    command: { type: "backup.runs" },
  };
}

function knownQuarantine(kind: "state" | "agent") {
  const reason = "verified synthetic database damage";
  mock.read.mockImplementation((sql) =>
    sql === "PRAGMA user_version"
      ? { user_version: 2 }
      : { user_version: 2, kind, reason, quarantined_at: 1, verified_generation: null },
  );
  return reason;
}

function fail(error: Error) {
  return () => {
    throw error;
  };
}

function agentOptions(agentId: string) {
  const input = request();
  const agentPath = path.join(path.dirname(input.databasePath), "openclaw-agent.sqlite");
  fs.writeFileSync(agentPath, "mock agent source");
  return { agentId, path: agentPath, env: input.context.environment };
}

function openFailure(options: ReturnType<typeof agentOptions>) {
  try {
    openOpenClawAgentDatabase(options);
  } catch (error) {
    assert(error instanceof Error);
    return error;
  }
  throw new Error("Expected agent database admission to fail");
}

it.each([
  { known: true, readFails: false, closeFails: false },
  { known: true, readFails: false, closeFails: true },
  { known: false, readFails: false, closeFails: true },
  { known: false, readFails: true, closeFails: true },
  { known: false, readFails: true, closeFails: false },
])(
  "preserves quarantine decisions and cleanup facts (%j)",
  async ({ known, readFails, closeFails }) => {
    const input = request();
    const reason = known ? knownQuarantine("state") : undefined;
    const readFailure = new Error("quarantine metadata read failed");
    const closeFailure = new Error("quarantine native reader close failed");
    if (readFails) {
      mock.read.mockImplementationOnce(fail(readFailure));
    }
    if (closeFails) {
      mock.close.mockImplementationOnce(fail(closeFailure));
    }
    const reply = await mock.handler(input);
    if (known) {
      expect(reply).toMatchObject({ ok: false, message: expect.stringContaining(reason!) });
      expect(reply).not.toHaveProperty("sourceAdmitted", true);
    } else if (closeFails) {
      expect(reply).toMatchObject({ ok: true, type: "backup.runs", runs: [] });
    } else {
      expect(reply).toEqual({ ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] });
    }
    if (closeFails) {
      expect(reply.nativeCleanupFailure?.error?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: closeFailure.message }),
          ...(readFails ? [expect.objectContaining({ message: readFailure.message })] : []),
        ]),
      );
    } else {
      expect(reply.nativeCleanupFailure).toBeUndefined();
    }
    expect(mock.query).toHaveBeenCalledTimes(known ? 0 : 1);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(mock.databases[0]?.isOpen).toBe(closeFails);
  },
);

it.each([
  { known: true, readFails: false },
  { known: false, readFails: false },
  { known: false, readFails: true },
])(
  "latches known agent quarantine but retries unvalidated cleanup failures (%j)",
  ({ known, readFails }) => {
    const options = agentOptions("quarantine-agent");
    const reason = known ? knownQuarantine("agent") : undefined;
    const readFailure = new Error("agent quarantine metadata unavailable");
    const closeFailure = new Error("agent quarantine reader close failed");
    if (readFails) {
      mock.read.mockImplementation(fail(readFailure));
    }
    mock.close.mockImplementation(fail(closeFailure));
    let firstFailure: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failure = openFailure(options);
      if (known) {
        expect(failure).toMatchObject({
          name: "SqliteIntegrityError",
          message: expect.stringContaining(reason!),
          cause: { errors: [closeFailure] },
        });
        if (attempt === 1) {
          expect(failure).toBe(firstFailure);
        }
      } else {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({
          name: "OpenClawQuarantineReadCleanupError",
          errors: [...(readFails ? [readFailure] : []), closeFailure],
        });
        expect(failure.cause).toBe(readFails ? readFailure : closeFailure);
      }
      firstFailure = failure;
      expect(mock.open).toHaveBeenCalledTimes(known ? 1 : attempt + 1);
      expect(mock.close).toHaveBeenCalledTimes(known ? 1 : attempt + 1);
    }
    expect(mock.claimAgentLease).not.toHaveBeenCalled();
  },
);
