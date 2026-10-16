import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorConfigPreflight } from "../commands/doctor-config-preflight.js";
import { runDoctorStateSqliteCompact } from "../commands/doctor-state-sqlite-compact.js";
import {
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "../config/io.health-state.js";
import * as stateOwnerHeartbeat from "../infra/gateway-state-owner-heartbeat.js";
import { requireNodeSqlite, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  invalidateSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import {
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "../infra/sqlite-lifecycle-errors.js";
import * as sqliteReadonlyLocation from "../infra/sqlite-snapshot-source.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "./openclaw-state-ownership-operations.js";
import { assertOpenClawStateWriteAllowedAtPath } from "./openclaw-state-ownership-preflight.js";
import * as ownershipWorker from "./openclaw-state-ownership-worker.js";
import {
  inspectOpenClawStateOwnershipAtPath,
  STATE_SUPERVISION_KEY,
} from "./openclaw-state-ownership.js";
import { findOpenFixtureFiles } from "./openclaw-state-ownership.test-support.js";

const heartbeatExits: Promise<void>[] = [];
beforeEach(() => {
  const start = stateOwnerHeartbeat.startGatewayStateOwnerHeartbeat;
  vi.spyOn(stateOwnerHeartbeat, "startGatewayStateOwnerHeartbeat").mockImplementation((...args) => {
    const heartbeat = start(...args);
    heartbeatExits.push(
      new Promise<void>((resolve) => {
        heartbeat.worker.once("exit", () => resolve());
      }),
    );
    return heartbeat;
  });
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      for (const directory of tempDirs.dirs) {
        retireFixtureAdmissions(directory);
      }
      // Synchronous lease release unlinks locks before its heartbeat worker finishes closing them.
      await Promise.all(heartbeatExits);
      const openFiles = findOpenFixtureFiles(tempDirs.dirs);
      assert.deepEqual(openFiles, [], "Fixture files remain open after database cleanup");
      cleanup();
    } finally {
      heartbeatExits.length = 0;
    }
  });
});

function retireFixtureAdmissions(root: string): void {
  const entry = fs.lstatSync(root, { throwIfNoEntry: false });
  if (entry?.isDirectory()) {
    for (const name of fs.readdirSync(root)) {
      retireFixtureAdmissions(path.join(root, name));
    }
  } else if (entry?.isFile() && root.endsWith(".sqlite")) {
    retireSqliteDatabaseAdmissionForPath(root);
  }
}

function createEnv(external = false) {
  return {
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-ownership-"),
    ...(external ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
  };
}

function withoutExternalMarker(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, OPENCLAW_SUPERVISOR_MODE: undefined };
}

function claimFixture(managerId = "gateway-supervisor") {
  const externalEnv = createEnv(true);
  const ownership = claim(externalEnv, managerId);
  const databasePath = openOpenClawStateDatabase({ env: externalEnv }).path;
  closeOpenClawStateDatabaseForTest();
  return { databasePath, externalEnv, ownership, unmarkedEnv: withoutExternalMarker(externalEnv) };
}

function claim(env: NodeJS.ProcessEnv, managerId = "gateway-supervisor") {
  return claimOpenClawStateOwnership(managerId, { env });
}

// Compare snapshots with Node: Vitest expands every Buffer byte into a JavaScript entry.
function snapshotSqliteFamily(databasePath: string) {
  const directory = path.dirname(databasePath);
  const entries = fs.readdirSync(directory).toSorted();
  return Object.fromEntries(
    entries.map((entry) => {
      const pathname = path.join(directory, entry);
      const stat = fs.statSync(pathname, { bigint: true });
      const { birthtimeNs, ctimeNs, dev, ino, mode, mtimeNs, size } = stat;
      return [
        entry,
        { bytes: fs.readFileSync(pathname), birthtimeNs, ctimeNs, dev, ino, mode, mtimeNs, size },
      ];
    }),
  );
}

function expectCleanupColumn(database: ReturnType<typeof openOpenClawStateDatabase>) {
  expect(database.db.prepare("PRAGMA table_info(worktrees)").all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "run_end_cleanup_json" })]),
  );
}

function ownershipRecord(managerId: string, claimedAt = 1) {
  return { version: 1, mode: "external", managerId, claimedAt } as const;
}

function insertOwnership(
  db: DatabaseSync,
  ownership: ReturnType<typeof ownershipRecord> | string,
  upsert = false,
) {
  db.prepare(
    `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)
     ${upsert ? "ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms" : ""}`,
  ).run(
    STATE_SUPERVISION_KEY,
    typeof ownership === "string" ? ownership : JSON.stringify(ownership),
    typeof ownership === "string" ? 1 : ownership.claimedAt,
  );
}

function nativeFixture(withTimestamp = false) {
  const databasePath = path.join(tempDirs.make("ownership-native-"), "state.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(databasePath);
  database.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT${withTimestamp ? ",updated_at_ms INTEGER" : ""});`,
  );
  return database;
}

function walCopy() {
  const env = createEnv(true);
  const databasePath = closedDatabase(env);
  using writer = new (requireNodeSqlite().DatabaseSync)(databasePath);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  const ownership = ownershipRecord("wal-only-manager");
  insertOwnership(writer, ownership);
  const copyPath = path.join(tempDirs.make("ownership-wal-only-"), "openclaw.sqlite");
  for (const suffix of ["", "-wal"]) {
    fs.copyFileSync(`${databasePath}${suffix}`, `${copyPath}${suffix}`);
  }
  expect(fs.existsSync(`${copyPath}-shm`)).toBe(false);
  return { env, copyPath, ownership };
}

function spyOnExec(intercept: (this: DatabaseSync, sql: string, exec: () => void) => void) {
  const { DatabaseSync } = requireNodeSqlite();
  const original = DatabaseSync.prototype.exec;
  return vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    return intercept.call(this, sql, () => original.call(this, sql));
  });
}

function closedDatabase(env: NodeJS.ProcessEnv) {
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  return pathname;
}

function expectOwnershipRefusal(operation: () => unknown) {
  expect(operation).toThrow(OpenClawStateOwnershipError);
}

describe("external shared-state ownership", () => {
  it("returns unowned for a missing path without creating its state tree", async () => {
    const rootDir = tempDirs.make("openclaw-state-ownership-missing-");
    const missingStateDir = path.join(rootDir, "missing-state");
    const databasePath = path.join(missingStateDir, "state", "openclaw.sqlite");

    expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toBeNull();
    expect(fs.existsSync(missingStateDir)).toBe(false);
    await assertOpenClawStateWriteAllowedAtPath({ databasePath });
    expect(fs.existsSync(missingStateDir)).toBe(false);
  });

  it("rejects canceled ownership admission before orphan recovery or staging", async () => {
    const env = createEnv();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(`${databasePath}-wal`, Buffer.alloc(64, 1));
    const before = snapshotSqliteFamily(databasePath);
    const controller = new AbortController();
    const reason = new Error("ownership admission stopped");
    controller.abort(reason);
    const snapshot = vi.spyOn(sqliteReadonlyLocation, "prepareSqliteReadOnlyLocation");
    const options = { databasePath, env, signal: controller.signal };
    await expect(assertOpenClawStateWriteAllowedAtPath(options)).rejects.toBe(reason);
    expect(snapshot).not.toHaveBeenCalled();
    assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
  });

  it.each([
    { mode: "unmarked", external: false, recoverOrphanedSidecars: undefined },
    { mode: "external preview", external: true, recoverOrphanedSidecars: false },
  ])("cleans an adopted snapshot when $mode ownership admission stops", async (scenario) => {
    const env = createEnv(scenario.external);
    const databasePath = closedDatabase(env);
    const before = snapshotSqliteFamily(databasePath);
    const controller = new AbortController();
    const reason = new Error("ownership admission stopped after snapshot");
    const prepare = sqliteReadonlyLocation.prepareSqliteReadOnlyLocation;
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    const snapshot = vi
      .spyOn(sqliteReadonlyLocation, "prepareSqliteReadOnlyLocation")
      .mockImplementationOnce(async (pathname, options) => {
        prepared = await prepare(pathname, options);
        controller.abort(reason);
        return prepared;
      });
    try {
      const options = {
        databasePath,
        env,
        recoverOrphanedSidecars: scenario.recoverOrphanedSidecars,
        openStateSchemaReadAdmission: () => () => {},
        signal: controller.signal,
      };
      await expect(assertOpenClawStateWriteAllowedAtPath(options)).rejects.toBe(reason);
      expect(prepared).toBeDefined();
      expect(fs.existsSync(path.dirname(prepared!.location))).toBe(false);
      assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
    } finally {
      snapshot.mockRestore();
      prepared?.cleanup();
    }
  });

  it.each([false, true])(
    "reads active WAL ownership without copying the database (external=%s)",
    async (external) => {
      using database = nativeFixture(true);
      const databasePath = database.location()!;
      const preload = path.join(path.dirname(databasePath), "forbid-copy.cjs");
      fs.writeFileSync(
        preload,
        `const fs = require('node:fs'); fs.fsyncSync = () => { throw new Error('ownership inspection copied the database'); }; require('node:module').syncBuiltinESMExports();`,
      );
      if (external) {
        insertOwnership(database, ownershipRecord("live-manager"));
      }
      const main = fs.readFileSync(databasePath);
      const wal = fs.readFileSync(databasePath + "-wal");
      database.exec("BEGIN IMMEDIATE;");
      await withEnvAsync(sqliteWorkerPreloadEnv(preload), async () => {
        const admission = assertOpenClawStateWriteAllowedAtPath({ databasePath, env: {} });
        if (external) {
          await expect(admission).rejects.toThrow(OpenClawStateOwnershipError);
        } else {
          await expect(admission).resolves.toBeUndefined();
        }
      });
      expect(database.isTransaction).toBe(true);
      expect(fs.readFileSync(databasePath)).toEqual(main);
      expect(fs.readFileSync(databasePath + "-wal")).toEqual(wal);
    },
  );

  it("preserves typed malformed metadata refusal from the native ownership worker", async () => {
    using database = nativeFixture();
    database
      .prepare("INSERT INTO config_machine_state VALUES(?,?)")
      .run(STATE_SUPERVISION_KEY, "not-json");
    const admission = assertOpenClawStateWriteAllowedAtPath({ databasePath: database.location()! });
    await expect(admission).rejects.toBeInstanceOf(OpenClawStateOwnershipMetadataError);
    await expect(admission).rejects.toThrow("reserved value is not valid JSON");
    expect(database.prepare("SELECT value_json FROM config_machine_state").get()).toEqual({
      value_json: "not-json",
    });
  });

  it("rejects cancellation after the native ownership worker settles", async () => {
    using database = nativeFixture();
    const databasePath = database.location()!;
    const controller = new AbortController();
    const reason = new Error("ownership worker stopped");
    const run = ownershipWorker.inspectOpenClawStateOwnershipWithWorker;
    const worker = vi
      .spyOn(ownershipWorker, "inspectOpenClawStateOwnershipWithWorker")
      .mockImplementationOnce(async (pathname, signal) => {
        const result = await run(pathname, signal);
        controller.abort(reason);
        return result;
      });
    await expect(
      assertOpenClawStateWriteAllowedAtPath({ databasePath, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(worker).toHaveBeenCalledWith(databasePath, controller.signal);
  });

  it("refuses unauthorized Doctor admission before staging a public snapshot", async () => {
    const { unmarkedEnv, externalEnv } = claimFixture();
    const home = tempDirs.make("openclaw-state-ownership-doctor-");
    const snapshotStaging = vi.spyOn(sqliteReadonlyLocation, "prepareSqliteReadOnlyLocationSync");
    const runPreflight = (env: NodeJS.ProcessEnv) =>
      withEnvAsync(
        {
          HOME: home,
          OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
          OPENCLAW_SUPERVISOR_MODE: env.OPENCLAW_SUPERVISOR_MODE,
        },
        () =>
          runDoctorConfigPreflight({
            invalidConfigNote: false,
            migrateLegacyConfig: false,
            migrateState: true,
            observe: false,
          }),
      );
    await expect(runPreflight(unmarkedEnv)).rejects.toThrow(OpenClawStateOwnershipError);
    expect(snapshotStaging).not.toHaveBeenCalled();
    await expect(runPreflight(externalEnv)).resolves.toBeDefined();
  });

  it("reads ownership from a WAL when the SHM index is absent", () => {
    const { copyPath, ownership } = walCopy();
    expect(inspectOpenClawStateOwnershipAtPath(copyPath)).toEqual(ownership);
  });

  it("rejects unmarked WAL ownership without modifying the SQLite family", async () => {
    const { env, copyPath } = walCopy();
    const before = snapshotSqliteFamily(copyPath);
    await expect(
      assertOpenClawStateWriteAllowedAtPath({
        databasePath: copyPath,
        env: withoutExternalMarker(env),
      }),
    ).rejects.toThrow(OpenClawStateOwnershipError);
    assert.deepStrictEqual(snapshotSqliteFamily(copyPath), before);
  });

  it("keeps its snapshot stable when a WAL appears after capture", () => {
    const env = createEnv(true);
    const databasePath = closedDatabase(env);
    const ownership = ownershipRecord("transition-manager", 2);
    const { DatabaseSync } = requireNodeSqlite();
    const prepare = sqliteReadonlyLocation.prepareSqliteReadOnlyLocationSync;
    let writer: DatabaseSync | undefined;
    const snapshot = vi
      .spyOn(sqliteReadonlyLocation, "prepareSqliteReadOnlyLocationSync")
      .mockImplementationOnce((pathname) => {
        const prepared = prepare(pathname);
        writer = new DatabaseSync(databasePath);
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        insertOwnership(writer, ownership);
        return prepared;
      });

    try {
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toBeNull();
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(ownership);
    } finally {
      snapshot.mockRestore();
      writer?.close();
    }
  });

  it("does not expose rolled-back ownership from a rollback-journal race", () => {
    const env = createEnv();
    const databasePath = closedDatabase(env);
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    using writer = new DatabaseSync(databasePath);
    writer.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
        "PRAGMA cache_size = 2; PRAGMA cache_spill = ON; " +
        "CREATE TABLE rollback_race_pressure (payload TEXT NOT NULL) STRICT;",
    );
    const baselineOwnership = ownershipRecord("baseline-supervisor");
    const transientOwnership = ownershipRecord("rollback-race-supervisor", 2);
    const payload = JSON.stringify("x".repeat(8192));
    writer.exec("BEGIN IMMEDIATE;");
    insertOwnership(writer, baselineOwnership, true);
    const insertPressure = writer.prepare("INSERT INTO rollback_race_pressure VALUES (?)");
    writer.exec("COMMIT;");
    const originalGet = StatementSync.prototype.get;
    let transactionStarted = false;
    let transientOwnershipObserved = false;
    vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
      this: StatementSync,
      ...params: unknown[]
    ) {
      if (!transactionStarted && params[0] === STATE_SUPERVISION_KEY) {
        transactionStarted = true;
        writer.exec("BEGIN IMMEDIATE;");
        insertOwnership(writer, transientOwnership, true);
        // Fresh pages force cache misses even when SQLite's global cache retains existing rows.
        // Use another B-tree after releasing the ownership cursor; rollback discards these pages.
        for (let index = 0; index < 256; index += 1) {
          insertPressure.run(payload);
        }
        using racedReader = new DatabaseSync(resolveImmutableSqliteFileUri(databasePath), {
          readOnly: true,
        });
        const result = originalGet.call(
          racedReader.prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = ? LIMIT 1",
          ),
          STATE_SUPERVISION_KEY,
        );
        transientOwnershipObserved = result?.value_json === JSON.stringify(transientOwnership);
        writer.exec("ROLLBACK;");
        return originalGet.apply(this, params);
      }
      return originalGet.apply(this, params);
    });

    const inspected = inspectOpenClawStateOwnershipAtPath(databasePath);
    expect({ transactionStarted, transientOwnershipObserved, inspected }).toEqual({
      transactionStarted: true,
      transientOwnershipObserved: true,
      inspected: baselineOwnership,
    });
  });

  it("inspects consolidated ownership without modifying its SQLite family or state tree", () => {
    const { databasePath, externalEnv, ownership } = claimFixture();
    const stateDir = externalEnv.OPENCLAW_STATE_DIR;
    fs.rmSync(path.join(stateDir, "tmp"), { force: true, recursive: true });
    expect(fs.readdirSync(stateDir)).toEqual(["state"]);
    const before = snapshotSqliteFamily(databasePath);

    if (process.platform !== "win32") {
      fs.chmodSync(stateDir, 0o500);
    }
    try {
      expect(inspectOpenClawStateOwnershipAtPath(databasePath)).toEqual(ownership);
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(stateDir, 0o700);
      }
    }

    assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
    expect(fs.readdirSync(stateDir)).toEqual(["state"]);
  });

  it("requires the external marker and makes claims idempotent only for one manager", () => {
    const env = createEnv();
    expect(() => claim(env)).toThrow(/OPENCLAW_SUPERVISOR_MODE=external/u);
    const externalEnv = { ...env, OPENCLAW_SUPERVISOR_MODE: "external" };
    const first = claim(externalEnv);
    expect(claim(externalEnv)).toEqual(first);
    expect(
      inspectOpenClawStateOwnershipAtPath(openOpenClawStateDatabase({ env: externalEnv }).path),
    ).toEqual(first);
    expect(() => claim(externalEnv, "replacement-manager")).toThrow(
      /already claimed by external manager gateway-supervisor/u,
    );
  });

  it("refuses unmarked writable opens before changing the SQLite family", () => {
    const { databasePath, externalEnv, unmarkedEnv } = claimFixture();
    const pending = openOpenClawStateDatabase({ env: externalEnv });
    pending.db.exec(`
      ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;
      DROP INDEX idx_task_runs_runtime_run;
    `);
    closeOpenClawStateDatabaseForTest();
    if (process.platform !== "win32") {
      fs.chmodSync(databasePath, 0o666);
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(fs.existsSync(`${databasePath}${suffix}`)).toBe(false);
    }
    const before = snapshotSqliteFamily(databasePath);

    expectOwnershipRefusal(() => openOpenClawStateDatabase({ env: unmarkedEnv }));

    assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
    const repaired = openOpenClawStateDatabase({ env: externalEnv });
    expect(repaired.db.isOpen).toBe(true);
    expectCleanupColumn(repaired);
    expect(
      repaired.db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_task_runs_runtime_run"),
    ).toBeDefined();
  });

  it("fences a claim made immediately before dangling Workshop index repair", () => {
    const env = createEnv();
    const databasePath = closedDatabase(env);
    const { DatabaseSync } = requireNodeSqlite();
    const damaged = new DatabaseSync(databasePath);
    damaged.exec(
      "CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT; CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
    );
    damaged.enableDefensive?.(false);
    damaged.exec("PRAGMA writable_schema = ON;");
    damaged
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time
                         ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)'
          WHERE type = 'index'
            AND name = 'idx_skill_workshop_collection_reviews_workspace_time'`,
      )
      .run();
    const schemaVersion = damaged.prepare("PRAGMA schema_version").get() as {
      schema_version: number;
    };
    damaged.exec(
      `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion.schema_version + 1};`,
    );
    damaged.close();

    let immediateTransactionCount = 0;
    const exec = spyOnExec(function (sql, proceed) {
      if (sql === "BEGIN IMMEDIATE" && ++immediateTransactionCount === 1) {
        using claimant = new DatabaseSync(databasePath);
        claimant.enableDefensive?.(false);
        claimant.exec("PRAGMA writable_schema = ON;");
        insertOwnership(claimant, ownershipRecord("race-manager"));
      }
      proceed();
    });

    expectOwnershipRefusal(() => repairOpenClawStateDatabaseSchema({ env }));
    exec.mockRestore();
    expect(immediateTransactionCount).toBe(1);

    using verify = new DatabaseSync(databasePath, { readOnly: true });
    verify.enableDefensive?.(false);
    verify.exec("PRAGMA writable_schema = ON;");
    expect(
      verify
        .prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_skill_workshop_collection_reviews_workspace_time"),
    ).toBeDefined();
  });

  it("fences a claim made during a canonical current-schema cold open", () => {
    const env = createEnv();
    const { path: databasePath, db: seeded } = openOpenClawStateDatabase({ env });
    const databaseLocation = requireNativeSqliteDatabase(seeded).location();
    closeOpenClawStateDatabaseForTest();
    retireFixtureAdmissions(databasePath);
    fs.renameSync(databasePath, `${databasePath}.seed`);
    fs.copyFileSync(`${databasePath}.seed`, databasePath);
    let claimInjected = false;
    const validating = new Set<DatabaseSync>();
    spyOnExec(function (sql, proceed) {
      if (!validating.size && sql === "BEGIN" && this.location() === databaseLocation) {
        validating.add(this);
      }
      proceed();
      if (!claimInjected && validating.has(this) && sql === "COMMIT") {
        claimInjected = true;
        claimOpenClawStateOwnership("race-manager", {
          path: databasePath,
          env: { ...env, OPENCLAW_SUPERVISOR_MODE: "external" },
        });
      }
    });

    expectOwnershipRefusal(() => openOpenClawStateDatabase({ env }));
    expect(claimInjected).toBe(true);
  });

  it("reuses admitted ownership and fences cached handles after the owner commits a claim", () => {
    const externalEnv = createEnv(true);
    const unmarkedEnv = withoutExternalMarker(externalEnv);
    const opened = openOpenClawStateDatabase({ env: unmarkedEnv });
    const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      expect(openOpenClawStateDatabase({ env: unmarkedEnv })).toBe(opened);
      expect(openOpenClawStateDatabase({ env: unmarkedEnv, database: opened })).toBe(opened);
      runOpenClawStateWriteTransaction(() => undefined, { env: unmarkedEnv, database: opened });
      expect(reads.queries.filter((sql) => /FROM config_machine_state/u.test(sql))).toEqual([]);
    } finally {
      reads.restore();
    }

    const ownership = claim(externalEnv, "late-supervisor");
    const write = vi.fn();
    expectOwnershipRefusal(() => openOpenClawStateDatabase({ env: unmarkedEnv }));
    expectOwnershipRefusal(() => openOpenClawStateDatabase({ env: unmarkedEnv, database: opened }));
    expectOwnershipRefusal(() => runOpenClawStateWriteTransaction(write, { env: unmarkedEnv }));
    expectOwnershipRefusal(() =>
      runOpenClawStateWriteTransaction(write, { env: unmarkedEnv, database: opened }),
    );
    expect(write).not.toHaveBeenCalled();
    expect(openOpenClawStateDatabase({ env: externalEnv })).toBe(opened);
    expect(inspectOpenClawStateOwnershipAtPath(opened.path)).toEqual(ownership);
  });

  it("reports checkpoint failure and lets the same durable claim retry", () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    const checkpoint = vi.spyOn(database.walMaintenance, "checkpoint").mockReturnValueOnce(false);

    expect(() => claim(env)).toThrow(/ownership was committed.*checkpoint failed/iu);
    checkpoint.mockRestore();
    const ownership = claim(env);
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toEqual(ownership);
  });

  it("fails closed when unmarked and lets an external claim repair malformed metadata", async () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    insertOwnership(requireNativeSqliteDatabase(database.db), '{"version":1,"mode":"external"}');
    database.db.exec("ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json;");
    const owners = captureSqliteDatabaseAdmissions(undefined, { location: database.path });
    assert.equal(owners.length, 1);
    const [owner] = owners;
    assert(owner);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    retireSqliteDatabaseAdmissionForPath(database.path);
    assert.throws(() => fs.fstatSync(owner.descriptor), { code: "EBADF" });
    // Persisted startup damage gets a new physical admission, not a live foreign edit.
    fs.copyFileSync(database.path, `${database.path}.startup`);
    fs.renameSync(`${database.path}.startup`, database.path);

    expect(() => openOpenClawStateDatabase({ env: withoutExternalMarker(env) })).toThrow(
      OpenClawStateOwnershipMetadataError,
    );
    expect(() => openOpenClawStateDatabase({ env })).toThrow(OpenClawStateOwnershipMetadataError);
    const ownership = claim(env);
    expect(inspectOpenClawStateOwnershipAtPath(database.path)).toEqual(ownership);
    expectCleanupColumn(openOpenClawStateDatabase({ env }));
  });

  it("does not repair malformed ownership before blocking schema drift", () => {
    const env = createEnv(true);
    const database = openOpenClawStateDatabase({ env });
    const malformed = '{"version":1,"mode":"external"}';
    insertOwnership(requireNativeSqliteDatabase(database.db), malformed);
    database.db.exec("ALTER TABLE worktrees ADD COLUMN unexpected_claim_column TEXT DEFAULT NULL;");
    const databasePath = database.path;
    closeOpenClawStateDatabaseForTest();

    expect(() => claim(env)).toThrow(/column definitions differ for worktrees/u);
    const { DatabaseSync } = requireNodeSqlite();
    using raw = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      raw
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get(STATE_SUPERVISION_KEY),
    ).toEqual({ value_json: malformed });
  });

  it("fences state repair and config health writes while allowing health reads", async () => {
    const { databasePath, unmarkedEnv: env } = claimFixture();
    // Maintenance can discard derived seal proof before refusing a database write.
    invalidateSqliteDatabaseCleanClose(databasePath);
    if (process.platform !== "win32") {
      fs.chmodSync(databasePath, 0o666);
    }
    const before = snapshotSqliteFamily(databasePath);
    expectOwnershipRefusal(() => repairOpenClawStateDatabaseSchema({ env }));
    await expect(prepareOpenClawStateDatabaseSchema({ env })).rejects.toThrow(
      OpenClawStateOwnershipError,
    );
    expectOwnershipRefusal(() =>
      withOpenClawStateStartupMigrationCheckpointDatabase(() => undefined, { env }),
    );
    await expect(runDoctorStateSqliteCompact({ env })).rejects.toThrow(OpenClawStateOwnershipError);
    const healthDeps = {
      env,
      homedir: () => env.OPENCLAW_STATE_DIR ?? "",
      logger: { warn: () => undefined },
    };
    expect(
      withArtifactPreservingStateReads(() => readConfigHealthStateFromStore(healthDeps)),
    ).toEqual({ entries: {} });
    assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
    expectOwnershipRefusal(() =>
      patchConfigHealthEntryToStore(healthDeps, "/tmp/openclaw.json", {
        lastObservedSuspiciousSignature: "test",
      }),
    );
    assert.deepStrictEqual(snapshotSqliteFamily(databasePath), before);
  });

  it("allows read-only access without the external marker", async () => {
    const { unmarkedEnv: env } = claimFixture();
    const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
    expect(database?.db.isOpen).toBe(true);
    database?.walMaintenance.close();
  });
});
