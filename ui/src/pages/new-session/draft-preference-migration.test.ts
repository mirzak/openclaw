import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { identityPreferences } from "./draft-worktree-preferences.test-support.ts";
import { replaceBrowserPreference } from "./preferences.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("does not restore an accepted name when an older first-load browser migration commits last", async () => {
  const prefs = migration();
  const migrationStarted = createDeferred();
  const releaseMigration = createDeferred();
  let heldMigration = false;
  prefs.beforeSave.mockImplementation(async (params) => {
    if (!heldMigration && params.entries["new-session.migration.v1"] === true) {
      heldMigration = true;
      migrationStarted.resolve();
      await releaseMigration.promise;
    }
  });
  const first = prefs.make();
  let acceptedPreference: unknown;
  try {
    await migrationStarted.promise;
    expect(prefs.stored()).toBeUndefined();
    const next = prefs.make();
    expect(first.context.gateway).not.toBe(next.context.gateway);
    expect(first.context.gateway.snapshot.client).not.toBe(next.context.gateway.snapshot.client);
    expect(first.context.gateway.snapshot.selfUser?.id).toBe(
      next.context.gateway.snapshot.selfUser?.id,
    );
    await prefs.ready(next);
    expect(next.place.worktreeName).toBe("first-task");
    expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
    vi.mocked(next.context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:next",
      initialRun: { status: "started", runId: "next-run" },
    });
    next.flow.setMessage("next task");
    await next.flow.submit(undefined, true);
    expect(next.context.sessions.createResult).toHaveBeenCalledOnce();
    expect(next.flow.error).toBeNull();
    expect(prefs.stored()).toMatchObject({ worktreeName: "" });
    acceptedPreference = structuredClone(prefs.stored());
  } finally {
    releaseMigration.resolve();
    await prefs.ready(first);
  }
  expect(first.context.sessions.createResult).not.toHaveBeenCalled();
  expect(prefs.stored()).toEqual(acceptedPreference);
});

const migrationKey = "new-session.migration.v1";
const mainKey = "new-session.v1:main";
type DraftFixture = ReturnType<ReturnType<typeof identityPreferences>["make"]>;

function setEntries(draft: DraftFixture, entries: Record<string, unknown>) {
  return draft.context.gateway.snapshot.client!.request("users.prefs.set", { entries });
}

function getEntries(draft: DraftFixture) {
  return draft.context.gateway.snapshot.client!.request("users.prefs.get", {});
}

function migration(extraAgents = 0, entries: Record<string, unknown> = {}) {
  const preference = {
    workspace: "/repo",
    folder: "/repo",
    worktree: true,
    baseRef: "main",
    worktreeName: "first-task",
  };
  expect(replaceBrowserPreference("ws://gateway.example", "main", preference)).toBe(true);
  for (let index = 0; index < extraAgents; index += 1) {
    expect(
      replaceBrowserPreference(
        "ws://gateway.example",
        `agent-${String(index).padStart(2, "0")}`,
        preference,
      ),
    ).toBe(true);
  }
  return { ...identityPreferences(true, undefined, entries), preference };
}

it("imports bounded batches, compares raw undecodable values, and completes the marker last", async () => {
  const prefs = migration(33, { [mainKey]: "legacy" });
  const first = prefs.make();
  await prefs.ready(first);
  const batches = prefs.beforeSave.mock.calls.map(([params]) => params);
  expect(batches).toHaveLength(2);
  for (const batch of batches) {
    expect(Object.keys(batch.entries).length).toBeLessThanOrEqual(32);
    expect(Object.keys(batch.expectedEntries ?? {}).length).toBeLessThanOrEqual(32);
    expect(batch.expectedEntries).toHaveProperty(migrationKey, null);
  }
  expect(batches[0]!.entries).not.toHaveProperty(migrationKey);
  expect(batches[1]!.entries).toHaveProperty(migrationKey, true);
  expect(batches[1]!.expectedEntries).toHaveProperty("new-session.v1:main", "legacy");
  expect(prefs.stored()).toMatchObject({ worktreeName: "first-task" });
  expect(prefs.stored("agent-32")).toMatchObject({ worktreeName: "first-task" });
});

it("honors another completed marker before a later non-final import batch", async () => {
  const prefs = migration(65);
  let batches = 0;
  prefs.beforeSave.mockImplementation(async (params) => {
    if (Object.hasOwn(params.expectedEntries ?? {}, migrationKey)) {
      batches += 1;
      if (batches === 2) {
        expect(params.entries).not.toHaveProperty(migrationKey);
        await setEntries(first, {
          [migrationKey]: true,
          [mainKey]: { ...prefs.preference, worktreeName: "" },
        });
      }
    }
  });
  const first = prefs.make();
  await prefs.ready(first);
  expect(batches).toBe(2);
  expect(prefs.stored("agent-00")).toMatchObject({ worktreeName: "first-task" });
  expect(prefs.stored("agent-31")).toBeUndefined();
  expect(prefs.stored()).toMatchObject({ worktreeName: "" });
  expect(first.gateway.readPreference("main")).not.toHaveProperty("worktreeName");
});

it.each([false, true])(
  "rebases migration conflicts on authoritative values (exhausted: %s)",
  async (exhausted) => {
    const prefs = migration(1);
    let attempts = 0;
    prefs.beforeSave.mockImplementation(async (params) => {
      if (params.entries[migrationKey] === true && (exhausted || attempts === 0)) {
        attempts += 1;
        await setEntries(first, {
          ...(exhausted ? { [migrationKey]: attempts } : {}),
          [mainKey]: { ...prefs.preference, worktreeName: `newer-${attempts}` },
        });
      }
    });
    const first = prefs.make();
    await prefs.ready(first);
    expect(attempts).toBe(exhausted ? 3 : 1);
    expect(prefs.stored()).toMatchObject({ worktreeName: exhausted ? "newer-3" : "newer-1" });
    if (exhausted) {
      expect(first.gateway.readPreference("main")).toMatchObject({ worktreeName: "newer-3" });
      expect(first.gateway.readPreference("agent-00")).toBeNull();
      expect(prefs.stored("agent-00")).toBeUndefined();
    } else {
      expect(prefs.stored("agent-00")).toMatchObject({ worktreeName: "first-task" });
      expect(await getEntries(first)).toMatchObject({ entries: { [migrationKey]: true } });
    }
  },
);

it("does not publish browser fallback when a conflict reread fails", async () => {
  const prefs = migration();
  prefs.beforeSave.mockImplementationOnce(async () => {
    await setEntries(first, {
      [migrationKey]: true,
      [mainKey]: { ...prefs.preference, worktreeName: "" },
    });
    prefs.beforeRead.mockRejectedValue(new Error("preference read unavailable"));
  });
  const first = prefs.make();
  await prefs.ready(first);
  expect(prefs.stored()).toMatchObject({ worktreeName: "" });
  expect(first.gateway.readPreference("main")).toBeNull();
});

it("keeps browser fallback after a non-conflict partial migration failure", async () => {
  const prefs = migration(33);
  prefs.beforeSave.mockImplementation(async (params) => {
    if (params.entries[migrationKey] === true) {
      throw new Error("preference save unavailable");
    }
  });
  const first = prefs.make();
  await prefs.ready(first);
  expect(prefs.stored("agent-00")).toMatchObject({ worktreeName: "first-task" });
  expect(prefs.stored()).toBeUndefined();
  expect(first.gateway.readPreference("main")).toMatchObject({ worktreeName: "first-task" });
  expect(await getEntries(first)).toMatchObject({
    entries: { "new-session.v1:agent-00": expect.any(Object) },
  });
});

it("does not publish a rejected old migration into a replacement identity scope", async () => {
  const prefs = migration();
  const started = createDeferred();
  const release = createDeferred();
  prefs.beforeSave.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("old preference save unavailable");
  });
  const first = prefs.make();
  await started.promise;
  first.gateway.disconnect();
  const replacement = identityPreferences(true, undefined, {
    [migrationKey]: true,
    "new-session.v1:main": {
      workspace: "/repo",
      folder: "/repo",
      worktree: true,
      worktreeName: "replacement-task",
    },
  }).make();
  first.context.gateway.snapshot.client = replacement.context.gateway.snapshot.client;
  first.context.gateway.snapshot.selfUser = { id: "person-b" };
  first.gateway.synchronize(first.context.gateway);
  await vi.waitFor(() => expect(first.gateway.preferenceLoading).toBe(false));
  expect(first.gateway.readPreference("main")).toMatchObject({ worktreeName: "replacement-task" });
  release.resolve();
  await Promise.allSettled(first.request.mock.results.map((result) => result.value));
  // Let the rejected request's loader continuations finish before checking the replacement view.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(first.gateway.readPreference("main")).toMatchObject({ worktreeName: "replacement-task" });
});

it("keeps a private repository with person A instead of importing its browser mirror into person B", async () => {
  const privateChoice = {
    folder: "/repo",
    remoteProject: {
      identity: "acme/private",
      cloneUrl: "https://ghe.example.test/acme/private.git",
    },
    defaultRepositoryOptOut: true,
  };
  const alice = identityPreferences(
    true,
    undefined,
    { [migrationKey]: true, "new-session.v1:main": privateChoice },
    "person-a",
  );
  const first = alice.make();
  await alice.ready(first);
  expect(alice.stored()).toEqual(privateChoice);
  const bob = identityPreferences(true, undefined, {}, "person-b");
  const second = bob.make();
  await bob.ready(second);
  expect(bob.stored()).toEqual({ folder: "/repo" });
});
