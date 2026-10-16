// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { childSessionListQuery, fetchChildSessionRows } from "./child-session-data.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const parentKey = "agent:main:parent";

function childRow(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:child-${index}`,
    spawnedBy: parentKey,
    kind: "direct",
    updatedAt: index,
  };
}

function listResult(
  sessions: GatewaySessionRow[],
  totalCount: number,
  nextOffset: number | null,
): SessionsListResult {
  return {
    ...sessionsResult(sessions, 1),
    path: "",
    totalCount,
    hasMore: nextOffset !== null,
    nextOffset,
  };
}

function capability(request: GatewayRequestHandler) {
  return createTestSessionCapability(
    createGatewayHarness(createTestGatewayClient(request)).gateway,
  );
}

const childQuery = childSessionListQuery(parentKey);
const load = (sessions: ReturnType<typeof capability>) =>
  fetchChildSessionRows({ sessions, parentKey, isCurrent: () => true });

describe("fetchChildSessionRows", () => {
  it("loads a default 50-child Swarm roster in one request", async () => {
    const children = Array.from({ length: 50 }, (_, index) => childRow(index));
    const renamed = {
      ...children[0]!,
      sessionId: "persisted-child-0",
      updatedAt: 20,
      label: "New child name",
    };
    children[0] = renamed;
    const previous = { ...renamed, updatedAt: 10, label: "Old child name" };
    const sessions = capability((method, params) => {
      expect(method).toBe("sessions.list");
      return (params as { spawnedBy?: string }).spawnedBy === parentKey
        ? listResult(children, children.length, null)
        : listResult([previous], 1, null);
    });
    await sessions.refresh({ force: true, agentId: "worker" });
    expect(sessions.state.result?.sessions[0]?.label).toBe(previous.label);
    const list = vi.spyOn(sessions, "refreshList");

    const rows = await load(sessions);

    expect(rows).toHaveLength(50);
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      spawnedBy: parentKey,
      limit: 100,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    const sampled = rows?.find((row) => row.key === renamed.key);
    expect(sampled).toBeDefined();
    expect(sessions.reconcile(sampled)).toBe(true);
    expect(sessions.state.result?.sessions.find((row) => row.key === renamed.key)?.label).toBe(
      renamed.label,
    );
  });

  it("continues paging when a child roster exceeds the default page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => childRow(index));
    const lastPage = [childRow(100)];
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(firstPage, 101, 100))
      .mockResolvedValueOnce(listResult(lastPage, 101, null));
    const sessions = capability(request);
    const list = vi.spyOn(sessions, "refreshList");

    const rows = await load(sessions);

    expect(rows).toHaveLength(101);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ offset: 100, limit: 100 });
  });

  it.each([
    { count: 1, deleted: true },
    { count: 2, deleted: false },
    { count: 101, deleted: true },
  ])(
    "completes a $count-child window during deletion (deleted: $deleted)",
    async ({ count, deleted }) => {
      let children = Array.from({ length: count }, (_, index) => ({
        ...childRow(index),
        sessionId: "child-session-" + index,
      }));
      const target = children[0]!;
      const deletion = createDeferred<{ ok: true; deleted: boolean }>();
      const offsets: number[] = [];
      const sessions = capability((method, params) => {
        if (method === "sessions.delete") {
          return deletion.promise;
        }
        expect(method).toBe("sessions.list");
        const query = params as { spawnedBy?: string; offset?: number; limit?: number };
        if (!query.spawnedBy) {
          return listResult(children, children.length, null);
        }
        const offset = query.offset ?? 0;
        offsets.push(offset);
        // Optional cursor flags are absent: advance using raw page membership.
        const page = children.slice(offset, offset + (query.limit ?? 100));
        return {
          ...listResult(page, children.length, null),
          hasMore: undefined,
          nextOffset: undefined,
        };
      });
      await sessions.refresh({ force: true });
      const removal = sessions.delete(target.key, { expectedSessionId: target.sessionId });
      try {
        const rows = await load(sessions);
        expect(rows).toHaveLength(count - 1);
        expect(rows?.some((row) => row.key === target.key)).toBe(false);
        expect(offsets).toEqual(count > 100 ? [0, 100] : [0]);
        expect(sessions.listSnapshot(childQuery).result).toMatchObject({
          count: count - 1,
          totalCount: count,
        });
        if (deleted) {
          children = children.slice(1);
        }
        deletion.resolve({ ok: true, deleted });
        await removal;
        expect(await load(sessions)).toHaveLength(deleted ? count - 1 : count);
      } finally {
        deletion.resolve({ ok: true, deleted: false });
        await removal;
      }
    },
  );

  it.each([true, false])(
    "requires a complete current window after moving pages (recovers: %s)",
    async (recovers) => {
      const children = Array.from({ length: 101 }, (_, index) => childRow(index));
      let pass = -1;
      let firstPage = children.slice(0, 100);
      const request = vi.fn(async (_method: string, params?: unknown) => {
        const offset = (params as { offset?: number })?.offset ?? 0;
        if (offset === 0) {
          pass += 1;
          firstPage = pass % 2 === 1 ? children.slice(1) : children.slice(0, 100);
          return listResult(firstPage, 101, 100);
        }
        const tail = recovers && pass >= 2 ? children[100]! : firstPage[0]!;
        return listResult([tail], 101, null);
      });
      const sessions = capability(request);
      const pending = load(sessions);
      if (recovers) {
        expect(await pending).toHaveLength(101);
        expect(sessions.listSnapshot(childQuery).result?.sessions).toHaveLength(101);
        expect(request).toHaveBeenCalledTimes(6);
      } else {
        await expect(pending).rejects.toThrow("child session list kept changing");
        expect(sessions.listSnapshot(childQuery).result?.sessions).toHaveLength(100);
        expect(request).toHaveBeenCalledTimes(8);
      }
    },
  );
});
