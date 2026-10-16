import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import * as reads from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import * as state from "./openclaw-state-db.js";
import { createSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";

const tempDirs = useStateDatabaseTempDirs();

async function fixture() {
  const root = tempDirs.make("fixed-read-existing-schema-");
  const env = { OPENCLAW_STATE_DIR: root };
  const record = {
    id: "alpha",
    createdAt: 1,
    archivePath: path.join(root, "backup.tar.gz"),
    status: "ok",
    kind: "archive",
  } as const;
  const database = state.openOpenClawStateDatabase({ env });
  state.runOpenClawStateWriteTransaction(
    ({ db }) =>
      recordBackupRunInDatabase(db, {
        id: record.id,
        created_at: record.createdAt,
        archive_path: record.archivePath,
        status: record.status,
        manifest_json: JSON.stringify({ kind: record.kind }),
      }),
    { database, env },
  );
  database.db
    .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
    .run("synthetic-installed-runtime");
  const options = { path: database.path, env };
  await state.closeOpenClawStateDatabaseAsync();
  replaceFile(options.path, "seed");
  return {
    env,
    options,
    record,
    read: async () => reads.executeExistingOpenClawStateRead({ env }, { type: "backup.runs" }),
  };
}

function backupReply(record: Awaited<ReturnType<typeof fixture>>["record"]) {
  return { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [record] };
}

async function withSqlite<T>(
  file: string,
  run: (db: DatabaseSync) => T | Promise<T>,
  readOnly = false,
): Promise<T> {
  const db = new (requireNodeSqlite().DatabaseSync)(file, { readOnly });
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

const dropListingIndex = (file: string) =>
  withSqlite(file, (db) => db.exec("DROP INDEX idx_plugin_state_listing"));
function replaceFile(file: string, suffix: string) {
  renameSync(file, `${file}.${suffix}`);
  copyFileSync(`${file}.${suffix}`, file);
}
async function withoutHostSql<T>(run: () => Promise<T>) {
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  try {
    return await run();
  } finally {
    try {
      sql.expectIdle();
    } finally {
      vi.restoreAllMocks();
    }
  }
}

it("prepares ACP and workspace facets together and observes foreign changes at each new phase", async () => {
  const root = tempDirs.make("row-shared-facts-");
  const env = { OPENCLAW_STATE_DIR: root };
  const database = state.openOpenClawStateDatabase({ env });
  const owner = { agentId: "main", sessionKey: "agent:main:shared-facts" };
  const workspace = createSessionRepositoryWorkspaceInDatabase(
    database.db,
    {
      ...owner,
      url: "https://example.test/fixture.git",
      runSetupScript: false,
    },
    1,
  ).workspace!;
  const command = {
    type: "sessionRows.sharedFacts" as const,
    entries: [
      {
        acp: {
          keys: [buildAcpDatabaseSessionKey(owner.sessionKey, owner.agentId)],
          entry: { sessionId: "original", lifecycleRevision: "generation" },
        },
        repositoryWorkspace: { ...owner, workspaceId: workspace.workspaceId },
      },
    ],
  };
  const read = async () => {
    const result = await withoutHostSql(() =>
      reads.executeExistingOpenClawStateRead({ env, path: database.path }, command),
    );
    if (!result?.ok || result.type !== command.type) {
      throw new Error("Expected the row shared-state cohort");
    }
    return result.rows;
  };
  expect(await read()).toEqual([{ acp: null, repositoryWorkspace: workspace }]);
  await withSqlite(database.path, async (foreign) => {
    foreign
      .prepare(`INSERT INTO acp_sessions
      (session_key, session_id, backend, agent, runtime_session_name, mode, state, last_activity_at, updated_at)
      VALUES (?, 'generation', 'fixture', 'main', 'foreign', 'persistent', 'idle', 2, 2)`)
      .run(command.entries[0]!.acp.keys[0]!);
    foreign.prepare("UPDATE session_repository_workspaces SET branch = 'foreign'").run();
    expect(await read()).toEqual([
      {
        acp: expect.objectContaining({ runtime_session_name: "foreign" }),
        repositoryWorkspace: { ...workspace, branch: "foreign" },
      },
    ]);
    foreign.prepare("DELETE FROM acp_sessions").run();
    foreign.prepare("DELETE FROM session_repository_workspaces").run();
    expect(await read()).toEqual([{ acp: null, repositoryWorkspace: null }]);
  });
});

it.each(["fresh", "cached", "artifact"] as const)(
  "validates replacement runtime shape on %s fixed reads without host SQL or schema repair",
  async (mode) => {
    const { options, record, read: readRows } = await fixture();
    const read = () =>
      withoutHostSql(() =>
        mode === "artifact" ? reads.withArtifactPreservingStateReads(readRows) : readRows(),
      );
    await withExistingOpenClawStateSchema(options, async () => {
      if (mode === "cached") {
        state.openOpenClawStateDatabase(options);
      }
      expect(await read()).toEqual(backupReply(record));
      await state.closeOpenClawStateDatabaseAsync();
      replaceFile(options.path, "previous");
      await dropListingIndex(options.path);
      await expect(read()).rejects.toThrow(/idx_plugin_state_listing|schema/i);
    });
    await state.closeOpenClawStateDatabaseAsync();
    await withSqlite(
      options.path,
      (persisted) => {
        const get = (sql: string) => persisted.prepare(sql).get();
        expect(get("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'")).toEqual({
          app_version: "synthetic-installed-runtime",
        });
        expect(
          get("SELECT name FROM sqlite_schema WHERE name = 'idx_plugin_state_listing'"),
        ).toBeUndefined();
      },
      true,
    );
  },
);

it("refuses fixed-read custody of a restricted cached handle outside its scope", async () => {
  const { options, record, read } = await fixture();
  const database = withExistingOpenClawStateSchema(options, () =>
    state.openOpenClawStateDatabase(options),
  );
  await withoutHostSql(async () => {
    await expect(read()).rejects.toThrow(/without schema repair/i);
  });
  expect(database.db.isOpen).toBe(true);
  await state.closeOpenClawStateDatabaseAsync();
  await withoutHostSql(async () => {
    expect(await read()).toEqual(backupReply(record));
  });
});

it("rejects detached fixed reads after their existing-schema scope ends", async () => {
  const { options, read } = await fixture();
  const gate = createDeferred();
  const { pending } = await withExistingOpenClawStateSchema(options, async () => ({
    pending: gate.promise.then(read),
  }));
  await withoutHostSql(async () => {
    const rejected = expect(pending).rejects.toThrow(/schema admission has ended/i);
    gate.resolve();
    await rejected;
  });
});

it("validates existing runtime shape before a fresh native read callback", async () => {
  const { options } = await fixture();
  await withExistingOpenClawStateSchema(options, async () => {
    await dropListingIndex(options.path);
    const read = vi.fn(() => "must not run");
    expect(() => reads.withExistingOpenClawStateDatabaseReadOnly(read, options)).toThrow(
      /idx_plugin_state_listing|schema/i,
    );
    expect(read).not.toHaveBeenCalled();
  });
});
