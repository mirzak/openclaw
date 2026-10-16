import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserModelAccount } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { createDraftTitleFixture } from "./draft-title.test-support.ts";
import { renderControl } from "./model-control.test-support.ts";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

async function prepareTitle(fixture: ReturnType<typeof createDraftTitleFixture>, message?: string) {
  if (message !== undefined) {
    fixture.flow.setMessage(message);
  }
  fixture.synchronizeTitles();
  await vi.advanceTimersByTimeAsync(1_000);
}

function createdParams(context: ReturnType<typeof createDraftTitleFixture>["context"]) {
  return vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
}

const personal = ({ authProfileId, label }: UserModelAccount) => ({
  kind: "personal" as const,
  authProfileId,
  label,
});

function accountTitleFixture(preview?: Promise<ModelCatalogResult>) {
  const makeAccount = (id: string): UserModelAccount => ({
    authProfileId: `personal:person-a:test:${id}`,
    provider: "test",
    label: `Saved account ${id}`,
    authType: "token",
    selected: false,
  });
  const accounts: [UserModelAccount, UserModelAccount] = [makeAccount("one"), makeAccount("two")];
  const confirmed: ModelCatalogResult = {
    models: [{ id: "primary", name: "Primary", provider: "test", available: true }],
    accountSelection: personal(accounts[0]),
  };
  const titleRequest = vi.fn(async (_params?: unknown) => ({ title: "Prepared title" }));
  const fixture = createDraftTitleFixture(
    async (_method, params) => titleRequest(params),
    undefined,
    async (method, params) => {
      if (method === "users.listModelAccounts") {
        return { profileId: "person-a", accounts, links: [] };
      }
      if (method === "models.list") {
        const account =
          params && typeof params === "object" && "authProfileId" in params
            ? accounts.find((candidate) => candidate.authProfileId === params.authProfileId)
            : undefined;
        return account
          ? (preview ?? {
              ...confirmed,
              accountSelection: personal(account),
            })
          : {
              models: confirmed.models.map((model) =>
                Object.assign({}, model, { available: false, unavailableReason: "missing-auth" }),
              ),
              accountSelection: { kind: "automatic", label: "Automatic" },
            };
      }
      return {};
    },
  );
  const { context, place } = fixture;
  Object.assign(context.gateway.snapshot, { selfUser: { id: "person-a", name: "Person A" } });
  place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
  const draw = () => renderControl(place.modelControl, context, "main", place.selectedAgent());
  const select = (value: string) =>
    draw().querySelector<HTMLButtonElement>(`[data-chat-account-option="${value}"]`)!.click();
  return {
    ...fixture,
    accounts,
    confirmed,
    titleRequest,
    select,
    chooseAccount: async (account: UserModelAccount) => {
      draw().querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(draw().textContent).toContain(account.label);
      select(`account:${account.authProfileId}`);
      await vi.advanceTimersByTimeAsync(0);
    },
    dispose: () => place.modelControl.reset(),
  };
}

describe("prepared title creation handoff", () => {
  it("keeps a title handoff on the selected draft account before update", async () => {
    const fixture = accountTitleFixture();
    const { accounts, context, flow, place, titleRequest, chooseAccount } = fixture;
    try {
      titleRequest
        .mockResolvedValueOnce({ title: "Automatic title" })
        .mockResolvedValueOnce({ title: "First account title" });
      await prepareTitle(fixture, "repair the sidebar naming");
      expect(titleRequest).toHaveBeenCalledOnce();

      await chooseAccount(accounts[0]);
      await prepareTitle(fixture);
      expect(titleRequest).toHaveBeenLastCalledWith({
        agentId: "main",
        message: flow.message,
        model: `test/primary@${accounts[0].authProfileId}`,
      });
      await chooseAccount(accounts[1]);
      expect(place.modelControl.selected).toBe("");
      await flow.submit();
      expect(context.sessions.createResult).toHaveBeenCalledWith(
        expect.objectContaining({
          model: `test/primary@${accounts[1].authProfileId}`,
        }),
        { reconciliation: "background" },
      );
      expect(createdParams(context)).not.toHaveProperty("displayName");
    } finally {
      fixture.dispose();
    }
  });

  it.each(["pending", "unconfirmed", "different provider"])(
    "pauses personal title inference for a %s preview without disabling ordinary naming",
    async (outcome) => {
      const preview = createDeferred<ModelCatalogResult>();
      const fixture = accountTitleFixture(preview.promise);
      const { accounts, confirmed, titles, titleRequest, chooseAccount, select } = fixture;
      try {
        await prepareTitle(fixture, "repair the sidebar naming");
        expect(titleRequest).toHaveBeenCalledOnce();
        await chooseAccount(accounts[0]);
        if (outcome !== "pending") {
          preview.resolve({
            ...confirmed,
            ...(outcome === "unconfirmed"
              ? {
                  accountSelection: personal(accounts[1]),
                }
              : {
                  models: confirmed.models?.map((model) =>
                    Object.assign({}, model, { provider: "other" }),
                  ),
                }),
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        await prepareTitle(fixture);
        expect(titles.takePreparedTitle()).toBeUndefined();
        expect(titleRequest).toHaveBeenCalledOnce();

        select("automatic");
        await prepareTitle(fixture);
        expect(titleRequest).toHaveBeenCalledTimes(2);
        expect(titles.takePreparedTitle()).toBe("Prepared title");
      } finally {
        preview.resolve(confirmed);
        fixture.dispose();
      }
    },
  );

  it("uses a ready title at creation without changing an explicit worktree name", async () => {
    const fixture = createDraftTitleFixture();
    const { flow, context, place } = fixture;
    await vi.advanceTimersByTimeAsync(0);
    expect(place.worktreeAvailable()).toBe(true);
    place.selectWorktree(true);
    place.setWorktreeName("my-explicit-branch");
    await prepareTitle(fixture, "repair the sidebar naming");
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Repair naming", worktreeName: "my-explicit-branch" }),
      { reconciliation: "background" },
    );
  });

  it("sends immediately while preparation is pending and ignores its late result", async () => {
    const pending = createDeferred<unknown>();
    const fixture = createDraftTitleFixture(async () => pending.promise);
    const { flow, context, titles } = fixture;
    await prepareTitle(fixture, "repair the sidebar naming");
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(createdParams(context)).not.toHaveProperty("displayName");
    pending.resolve({ title: "Too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(titles.takePreparedTitle()).toBeUndefined();
  });

  it("never sends an incognito draft and discards an earlier normal suggestion", async () => {
    const fixture = createDraftTitleFixture();
    const { flow, request, context, synchronizeTitles } = fixture;
    await prepareTitle(fixture, "repair the sidebar naming");
    flow.setVisibility("incognito");
    synchronizeTitles();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
    expect(createdParams(context)).toMatchObject({ incognito: true });
    expect(createdParams(context)).not.toHaveProperty("displayName");
  });

  it("does not restart speculation when a submitted draft is retried", async () => {
    const fixture = createDraftTitleFixture();
    const { flow, request } = fixture;
    await prepareTitle(fixture, "repair the sidebar naming");
    await flow.submit();
    await flow.submit();
    await prepareTitle(fixture);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
  });

  it("rejects a stale title even when Send beats the next UI update", async () => {
    const fixture = createDraftTitleFixture();
    const { flow, context } = fixture;
    await prepareTitle(fixture, "repair the sidebar naming");
    flow.setMessage("investigate a different reconnect bug");
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(createdParams(context)).not.toHaveProperty("displayName");
  });
});
