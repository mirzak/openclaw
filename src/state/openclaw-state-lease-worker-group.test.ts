import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import { requestLeaseAdmission } from "./openclaw-state-lease-admission.test-support.js";
import type { OpenClawStateAsyncLeaseContext } from "./openclaw-state-lease-context.js";
import { runWithOpenClawStateLeasesWorker as runGroup } from "./openclaw-state-lease-worker-operation.js";
import {
  createOpenClawStateLeaseWorkerOwner,
  withOpenClawStateLeaseWorkerAdmission as withSingle,
  withOpenClawStateLeasesWorkerAdmission as withGroup,
  type OpenClawStateLeaseWorkerAuthority,
} from "./openclaw-state-lease-worker-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

const runWorkerOperation = vi.hoisted(() => vi.fn());
vi.mock("./openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: runWorkerOperation,
}));

type Owner = ReturnType<typeof createOpenClawStateLeaseWorkerOwner>;
const owners: Owner[] = [];
const jobs: Array<ReturnType<typeof job>> = [];
const noop = () => {};
const asyncNoop = async () => {};

afterEach(async () => {
  for (const current of jobs.splice(0)) {
    current.admission.finish();
    current.settled.resolve({ kind: "completed" });
  }
  for (const owner of owners.splice(0)) {
    await owner.settle();
    owner.close();
  }
  vi.restoreAllMocks();
  runWorkerOperation.mockReset();
});

function sourceContext(): OpenClawStateWorkerContext {
  return {
    environment: { OPENCLAW_STATE_DIR: "/synthetic-state" },
    admission: {
      coordinationKey: "file:1:2",
      databasePath: "/synthetic-alias/state.sqlite",
      identity: { key: "file:1:2", canonicalPath: "/synthetic-state/state.sqlite" },
      assertCurrent: noop,
    },
  };
}

function fixture(context?: OpenClawStateWorkerContext, key = "collection") {
  const controller = new AbortController();
  const lease: OpenClawStateAsyncLeaseContext = {
    signal: controller.signal,
    assertOwned: asyncNoop,
    renew: asyncNoop,
  };
  const owner = createOpenClawStateLeaseWorkerOwner({
    lease,
    identity: { scope: "core:test", key, owner: `owner-${key}` },
    databasePath: context?.admission.databasePath ?? "/synthetic-alias/state.sqlite",
    sourceContext: context,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
  owners.push(owner);
  return { owner, lease, controller };
}

function job(createAdmission: SqliteWorkerAdmissionFactory) {
  const settled = createDeferredCore<SqliteWorkerOperationSettlement>();
  const { admission } = createAdmission({ settled: settled.promise });
  const current = {
    admission,
    settled,
    request(stage: "transaction" | "commit", leases: unknown) {
      return requestLeaseAdmission(admission, stage, { kind: "state-leases", leases });
    },
  };
  jobs.push(current);
  return current;
}

function facts(identities: readonly OpenClawStateLeaseIdentity[], expiresAt = Date.now() + 30_000) {
  return identities.map((identity) => ({ identity, expiresAt }));
}

type GroupScope = Parameters<Parameters<typeof withGroup>[2]>[0];
function group(context = sourceContext()) {
  const members = [fixture(context), fixture(context, "target")] as const;
  const leases = members.map(({ lease }) => lease);
  return {
    context,
    members,
    leases,
    run<T>(
      operation: (scope: GroupScope) => Promise<T>,
      authority?: OpenClawStateLeaseWorkerAuthority,
    ) {
      return withGroup(leases, context, operation, authority);
    },
    expectReleasable(value: boolean) {
      expect(members.map(({ owner }) => owner.canRelease())).toEqual([value, value]);
    },
  };
}

describe("state lease group admission", () => {
  it.each([
    "admission",
    "maintenance",
    "effect",
    "transaction-replacement",
    "commit",
    "member-0",
    "member-1",
    "caller",
    "expiry",
    "async",
  ] as const)("refuses grants after %s authority changes", async (kind) => {
    const context = sourceContext();
    let now = 1_000;
    let sourceCurrent = true;
    let currentCaller = true;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sourceError = new Error("original source retired");
    const callerError = new Error(kind === "caller" ? "caller retired" : "original caller retired");
    const revoked = new Error("lease retired during host commit preparation");
    const assertSourceCurrent = () => {
      if (!sourceCurrent) {
        throw sourceError;
      }
    };
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      assertOwnerCurrent: assertSourceCurrent,
    });
    if (kind === "admission") {
      context.admission.assertCurrent = assertSourceCurrent;
    } else if (kind === "maintenance") {
      context.maintenanceScope = maintenance;
    }
    const { members, run } = group(context);
    const authority = {
      assertCurrent() {
        if (kind === "transaction-replacement") {
          authority.beforeTransaction = noop;
        }
        if (!currentCaller) {
          throw callerError;
        }
      },
      beforeTransaction() {
        if (kind === "transaction-replacement") {
          throw callerError;
        }
      },
      beforeCommit() {
        if (kind === "member-0" || kind === "member-1") {
          members[kind === "member-0" ? 0 : 1].controller.abort(revoked);
        } else if (kind === "caller" || kind === "commit") {
          currentCaller = false;
        } else if (kind === "expiry") {
          now = 2_000;
        }
      },
    };
    if (kind === "async") {
      // oxlint-disable-next-line typescript/no-misused-promises -- Deliberately violates the synchronous authority contract.
      authority.beforeCommit = asyncNoop;
    }
    try {
      await run(async (scope) => {
        const current = job(scope.createAdmission);
        const held = facts(scope.identities, 2_000);
        if (kind === "transaction-replacement") {
          expect(current.request("transaction", held)).toBe(2);
          expect(current.admission.failure).toBe(callerError);
          current.settled.resolve({ kind: "completed" });
          return;
        }
        expect(current.request("transaction", held)).toBe(1);
        if (kind === "admission") {
          context.admission.assertCurrent = noop;
        } else if (kind === "maintenance") {
          maintenance.assertAdmission = noop;
        } else if (kind === "effect") {
          authority.assertCurrent = noop;
          currentCaller = false;
        } else if (kind === "commit") {
          authority.beforeCommit = noop;
        }
        sourceCurrent = false;
        expect(current.request("commit", held)).toBe(2);
        const expected = {
          effect: callerError,
          commit: callerError,
          "member-0": revoked,
          "member-1": revoked,
          caller: callerError,
          admission: sourceError,
          maintenance: sourceError,
          expiry: "State lease worker ownership was refused",
          async: "State lease worker authority must complete synchronously",
        }[kind];
        if (typeof expected === "string") {
          expect(current.admission.failure).toMatchObject({ message: expected });
        } else {
          expect(current.admission.failure).toBe(expected);
        }
        current.settled.resolve({ kind: "completed" });
      }, authority);
    } finally {
      sourceCurrent = true;
      await maintenance.close();
    }
  });

  it("routes the plural storage entry point through one retained worker operation", async () => {
    const { context, leases, expectReleasable } = group();
    let expectedIdentities: readonly OpenClawStateLeaseIdentity[] = [];
    const execute = vi.fn(async () => 42);
    runWorkerOperation.mockImplementation(
      async (
        captured: OpenClawStateWorkerContext,
        operation: (scope: { execute: typeof execute }) => Promise<number>,
        options: { assertCurrent: () => void; createAdmission: SqliteWorkerAdmissionFactory },
      ) => {
        expect(captured).toBe(context);
        expectReleasable(false);
        execute.mockImplementationOnce(async () => {
          options.assertCurrent();
          const current = job(options.createAdmission);
          expect(current.request("transaction", facts(expectedIdentities))).toBe(1);
          expect(current.request("commit", facts(expectedIdentities))).toBe(1);
          current.settled.resolve({ kind: "completed" });
          return 42;
        });
        return operation({ execute });
      },
    );
    const value = await runGroup(leases, context, async (scope, identities) => {
      expectedIdentities = identities;
      return scope.execute({
        type: "stateLease.verify",
        input: { identity: expectDefined(identities[0], "collection identity") },
      });
    });
    expect(value).toBe(42);
    expect(runWorkerOperation).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expectReleasable(true);
  });

  it("retains both owners before callback entry and joins each job's native settlement", async () => {
    const { members, run, expectReleasable } = group();
    const callbacks: string[] = [];
    await run(
      async (scope) => {
        expectReleasable(false);
        // Schema and domain commands share their retained actor, not a grant port or stage.
        for (let index = 0; index < 2; index += 1) {
          const current = job(scope.createAdmission);
          if (index === 0) {
            expect(current.request("transaction", facts(scope.identities))).toBe(1);
          }
          expect(current.request("commit", facts(scope.identities))).toBe(1);
        }
      },
      {
        assertCurrent: noop,
        beforeTransaction: () => {
          callbacks.push("prepare");
        },
        beforeCommit: () => {
          callbacks.push("commit");
        },
      },
    );
    expect(callbacks).toEqual(["prepare", "commit", "prepare", "commit"]);
    const firstJob = expectDefined(jobs[0], "schema job");
    const secondJob = expectDefined(jobs[1], "domain job");
    expect(firstJob.admission.port).not.toBe(secondJob.admission.port);
    firstJob.settled.resolve({ kind: "completed" });
    await firstJob.settled.promise;
    expectReleasable(false);
    secondJob.settled.resolve({ kind: "completed" });
    await Promise.all(members.map(({ owner }) => owner.drain()));
    expectReleasable(true);
  });

  it.each(["missing", "extra", "reordered", "wrong-owner", "expired"] as const)(
    "refuses invalid %s grant requests",
    async (kind) => {
      await group().run(async (scope) => {
        const current = job(scope.createAdmission);
        const held = facts(scope.identities);
        if (kind === "missing") {
          held.pop();
        }
        if (kind === "extra") {
          held.push(expectDefined(held[0], "first lease facts"));
        }
        if (kind === "reordered") {
          held.reverse();
        }
        if (kind === "wrong-owner") {
          expectDefined(held[1], "second lease facts").identity.owner = "unrelated";
        }
        if (kind === "expired") {
          expectDefined(held[1], "second lease facts").expiresAt = Date.now();
        }
        expect(current.request("transaction", held)).toBe(2);
        expect(current.admission.failure).toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        current.settled.resolve({ kind: "not-entered", error: current.admission.failure });
      });
    },
  );

  it.each([
    "empty",
    "repeated",
    "same-key",
    "uncaptured",
    "copied-context",
    "alias-context",
  ] as const)("rejects %s source membership before callback entry", async (kind) => {
    const context = sourceContext();
    const first = fixture(context);
    const otherContext = { ...context, admission: { ...context.admission } };
    if (kind === "alias-context") {
      otherContext.admission.databasePath = context.admission.identity.canonicalPath;
    }
    const second = fixture(
      kind === "uncaptured" ? undefined : kind.endsWith("context") ? otherContext : context,
      kind === "same-key" ? "collection" : "target",
    );
    const selected =
      kind === "empty"
        ? []
        : kind === "repeated"
          ? [first.lease, first.lease]
          : [first.lease, second.lease];
    const operation = vi.fn(asyncNoop);
    expect(() => withGroup(selected, context, operation)).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(second.owner.canRelease()).toBe(true);
  });

  it("unwinds earlier custody when a later owner refuses and preserves single selected-path checks", async () => {
    const context = sourceContext();
    const first = fixture(context);
    const second = fixture(context, "target");
    second.controller.abort(new Error("target retired"));
    const operation = vi.fn(asyncNoop);
    expect(() => withGroup([first.lease, second.lease], context, operation)).toThrow(
      "target retired",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(first.owner.canRelease()).toBe(true);
    expect(() =>
      withSingle(first.lease, context.admission.identity.canonicalPath, operation),
    ).toThrow("differs from its live owner");
    await withSingle(first.lease, context.admission.databasePath, operation);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("poisons both owners from one unknown native outcome even after a handled callback failure", async () => {
    const { context, members, run } = group();
    const failure = new Error("native outcome unavailable");
    await expect(
      run(async (scope) => {
        const current = job(scope.createAdmission);
        current.settled.resolve({ kind: "unknown", error: failure });
        await Promise.reject(new Error("delivery lost")).catch(() => {});
        return "handled";
      }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    for (const member of members) {
      expect(member.owner.canRelease()).toBe(false);
      expect(() => withSingle(member.lease, context.admission.databasePath, asyncNoop)).toThrow(
        "outcome is unknown",
      );
      await expect(member.owner.drain()).rejects.toMatchObject({ code: "outcome-unknown" });
    }
  });
});
