// Approval reads and decisions retain reviewer, session, and channel authority.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateApprovalGetResult } from "../../../packages/gateway-protocol/src/index.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import {
  bindApprovalHandlers,
  createHandlers,
  createFixture,
  cleanupApprovalHandlerFixtures,
  createClient,
  createDatabaseOptions,
  createManagers,
  getOperatorApproval,
  registerExec,
  registerSystemAgent,
  tempDirs,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import { createContext, deleteDurableApproval } from "./approval.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

// mock-isolation: Approval fixtures control custody and config revocation without loading channel runtimes.
vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: (...args: unknown[]) => {
    const custody = prepareApprovalChannelCustodyMock(...args);
    return (
      custody && {
        ...custody,
        isCurrent:
          custody.isCurrent ??
          ((request: unknown) => {
            const input = args[0] as { cfg: unknown; getCfg?: () => unknown };
            return (!input.getCfg || input.getCfg() === input.cfg) && custody.authorizes(request);
          }),
        [Symbol.dispose]() {},
      }
    );
  },
}));

function approvalFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !("approval" in result)) {
    throw new Error("missing approval response");
  }
  return (result as { approval: Record<string, unknown> }).approval;
}

describe("approval authority boundaries", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
    clearRuntimeConfigSnapshot();
  });

  it("hides foreign pending and terminal approvals from roles without foreign-session access", async () => {
    const databaseOptions = createDatabaseOptions();
    const stateDir = databaseOptions.env?.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("expected isolated approval state directory");
    }
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const profile = ensureProfileForEmail("approval-guest@example.test", databaseOptions);
      setUserProfileRole(profile.id, "guest", databaseOptions);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog(databaseOptions)).release };
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.approvals"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const ownerKey = "agent:main:approval-owned";
      const foreignKey = "agent:main:approval-foreign";
      for (const [sessionKey, creatorId] of [
        [ownerKey, profile.id],
        [foreignKey, "foreign-owner"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `session-${sessionKey}`,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: creatorId },
          },
        );
      }
      const managers = createManagers(databaseOptions);
      const own = await registerExec(managers.exec, {
        id: "approval:owned",
        request: { sessionKey: ownerKey },
      });
      const foreign = await registerExec(managers.exec, {
        id: "approval:foreign",
        request: { sessionKey: foreignKey },
      });
      const context = {
        ...createContext(),
        getRuntimeConfig: () => cfg,
      } as GatewayRequestHandlerOptions["context"];
      const roleClient = {
        ...createClient({ deviceId: "reviewer" }),
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      } as GatewayRequestHandlerOptions["client"];
      const ownerClient = {
        ...createClient({ deviceId: "reviewer" }),
        internal: { operatorRoleActor: { kind: "system" } },
      } as GatewayRequestHandlerOptions["client"];
      const handlers = createHandlers(managers, databaseOptions);
      const request = bindApprovalHandlers(handlers);

      const hidden = await request("approval.get", { id: foreign.record.id }, roleClient, context);
      expect(hidden).toMatchObject({
        ok: false,
        error: { details: { reason: "APPROVAL_NOT_FOUND" } },
      });
      expect(
        await request("approval.get", { id: own.record.id }, roleClient, context),
      ).toMatchObject({ ok: true, result: { approval: { id: own.record.id } } });
      expect(
        await request("approval.get", { id: foreign.record.id }, undefined, context),
      ).toMatchObject({
        ok: false,
        error: { details: { reason: "APPROVAL_NOT_FOUND" } },
      });
      expect(
        await request("approval.get", { id: foreign.record.id }, ownerClient, context),
      ).toMatchObject({ ok: true, result: { approval: { id: foreign.record.id } } });

      for (const id of [own.record.id, foreign.record.id]) {
        expect(
          await request(
            "approval.resolve",
            { id, kind: "exec", decision: "deny" },
            ownerClient,
            context,
          ),
        ).toMatchObject({ ok: true });
      }
      const history = await request("approval.history", {}, roleClient, context);
      expect(history).toMatchObject({
        ok: true,
        result: { items: [{ id: own.record.id, source: { sessionKey: ownerKey } }] },
      });
      await Promise.all([own.decision, foreign.decision]);
    });
  });

  it("returns an exact-id, deep-linkable exec projection without execution bindings", async () => {
    const { managers, request } = createFixture();
    const id = "exec:approval.with_safe-punctuation";
    await registerExec(managers.exec, {
      id,
      reviewerDeviceIds: ["reviewer-a"],
      request: {
        commandPreview: "printf approval-handler",
        warningText: "Review carefully",
        cwd: "/private/workspace",
        systemRunBinding: {
          argv: ["printf", "approval-handler"],
          cwd: "/private/workspace",
          agentId: "main",
          sessionKey: "agent:main:child",
          envHash: "private-env-binding",
        },
      },
    });

    const response = await request(
      "approval.get",
      { id },
      createClient({ deviceId: "reviewer-a" }),
      createContext("/operator/"),
    );
    expect(response.ok).toBe(true);
    expect(validateApprovalGetResult(response.result)).toBe(true);
    expect(approvalFromResult(response.result)).toMatchObject({
      id,
      status: "pending",
      urlPath: "/operator/approve/exec%3Aapproval.with_safe-punctuation",
      presentation: {
        kind: "exec",
        commandText: "printf approval-handler",
        warningText: "Review carefully",
        host: "gateway",
        agentId: "main",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain("/private/workspace");
    expect(serialized).not.toContain("private-env-binding");

    const prefix = await request(
      "approval.get",
      { id: "exec:approval" },
      createClient({ deviceId: "reviewer-a" }),
    );
    expect(prefix.ok).toBe(false);
    expect(prefix.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: { reason: "APPROVAL_NOT_FOUND" },
    });
  });

  it("makes missing and unauthorized approval lookups indistinguishable", async () => {
    const { managers, request } = createFixture();
    await registerExec(managers.exec, { id: "authorization" });

    const unauthorized = await request(
      "approval.get",
      { id: "authorization" },
      createClient({ scopes: ["operator.approvals"] }),
    );
    const missing = await request("approval.get", { id: "missing" });
    expect(unauthorized).toMatchObject({ ok: false, error: missing.error });

    const internal = await request(
      "approval.get",
      { id: "authorization" },
      createClient({ internal: true }),
    );
    expect(internal).toMatchObject({ ok: false, error: missing.error });

    const underscopedInternal = await request(
      "approval.get",
      { id: "authorization" },
      createClient({ internal: true, scopes: ["operator.read"] }),
    );
    expect(underscopedInternal).toMatchObject({ ok: false, error: missing.error });
  });

  it("enforces explicit reviewer bindings over requester ownership", async () => {
    const { managers, request } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "reviewer-bound-unified-approval",
      reviewerDeviceIds: ["reviewer-a"],
    });

    for (const deviceId of ["reviewer-b", "requester-device"]) {
      for (const method of ["approval.get", "approval.resolve"] as const) {
        const response = await request(
          method,
          method === "approval.get"
            ? { id: pending.record.id }
            : { id: pending.record.id, kind: "exec", decision: "deny" },
          createClient({ deviceId }),
        );
        expect(response).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
        });
      }
    }
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const winner = await request(
      "approval.resolve",
      { id: pending.record.id, kind: "exec", decision: "deny" },
      createClient({ deviceId: "reviewer-a" }),
    );
    expect(winner.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny" },
    });

    const hiddenTerminal = await request(
      "approval.get",
      { id: pending.record.id },
      createClient({ deviceId: "reviewer-b" }),
    );
    expect(hiddenTerminal).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
  });

  it("lets only the server-authenticated device-less runtime resolve", async () => {
    const { databaseOptions, managers, request } = createFixture();
    const pending = await registerExec(managers.exec, { id: "trusted-runtime-resolve" });

    const body = { id: pending.record.id, kind: "exec", decision: "deny" };

    const untrusted = await request(
      "approval.resolve",
      body,
      createClient({ scopes: ["operator.approvals"] }),
    );
    expect(untrusted).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const underscopedInternal = await request(
      "approval.resolve",
      body,
      createClient({ internal: true, scopes: ["operator.read"] }),
    );
    expect(underscopedInternal).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", details: { reason: "APPROVAL_NOT_FOUND" } },
    });
    expect(managers.exec.getLiveSnapshot(pending.record.id)).toBe(pending.record);

    const trusted = await request("approval.resolve", body, createClient({ internal: true }));
    expect(trusted.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "user" },
    });
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({
      kind: "runtime",
      id: "approval-test",
    });
    await expect(pending.decision).resolves.toBe("deny");
  });

  it.for([
    ["approval.get", String.fromCharCode(0xd800)],
    ["approval.resolve", ".."],
  ] as const)("rejects unsafe approval id through %s: %s", async ([method, id], testContext) => {
    const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-unsafe-approval-id-"));
    tempDirs.push(databasePath);
    const handlers = createApprovalHandlers({
      execApprovalManager: createTestApprovalManager(testContext),
      pluginApprovalManager: createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
        approvalKind: "plugin",
      }),
      databaseOptions: { path: databasePath },
    });
    const request = bindApprovalHandlers(handlers);

    const response = await request(method, {
      id,
      ...(method === "approval.resolve" ? { kind: "exec", decision: "deny" } : {}),
    });

    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.for(["approval.get", "approval.resolve"] as const)(
    "returns sanitized UNAVAILABLE when %s cannot read durable state",
    async (method, testContext) => {
      const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-broken-db-"));
      tempDirs.push(databasePath);
      const context = createContext();
      const handlers = createApprovalHandlers({
        execApprovalManager: createTestApprovalManager(testContext),
        pluginApprovalManager: createTestApprovalManager<PluginApprovalRequestPayload>(
          testContext,
          {
            approvalKind: "plugin",
          },
        ),
        databaseOptions: { path: databasePath },
      });
      const request = bindApprovalHandlers(handlers);

      const response = await request(
        method,
        method === "approval.get"
          ? { id: "lookup" }
          : { id: "lookup", kind: "exec", decision: "deny" },
        undefined,
        context,
      );

      expect(response).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "approval lookup unavailable" },
      });
      expect(JSON.stringify(response.error)).not.toContain(databasePath);
      expect(context.logGateway.error).toHaveBeenCalledTimes(1);
    },
  );

  it("does not mutate a live waiter for an unauthorized durable lookup", async () => {
    const { databaseOptions, managers, request } = createFixture();
    const pending = await registerExec(managers.exec, { id: "unauthorized-missing-durable-row" });
    deleteDurableApproval(databaseOptions, pending.record.id);

    const response = await request(
      "approval.get",
      { id: pending.record.id },
      createClient({ deviceId: "unrelated-device", scopes: ["operator.approvals"] }),
    );

    expect(response.ok).toBe(false);
    expect(managers.exec.getLiveSnapshot(pending.record.id)?.resolvedAtMs).toBeUndefined();
  });

  it("resolves a system-agent proposal through its channel reviewer custody", async () => {
    const { databaseOptions, managers, request } = createFixture(true);
    const pending = await registerSystemAgent(
      managers.systemAgent,
      "system-agent:channel-reviewer",
    );
    prepareApprovalChannelCustodyMock.mockImplementation(
      ({ approvalKind }: { approvalKind: string }) =>
        approvalKind === "system-agent"
          ? {
              resolverId: "telegram:ops",
              authorizes: (record: { request: SystemAgentApprovalRequestPayload }) =>
                record.request.sessionId === "delegation-1",
            }
          : null,
    );
    const response = await request(
      "approval.resolve",
      {
        id: pending.record.id,
        kind: "system-agent",
        decision: "allow-once",
        reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
      },
      createClient({ internal: true }),
    );

    expect(response.result).toMatchObject({
      applied: true,
      approval: {
        status: "allowed",
        decision: "allow-once",
        presentation: {
          kind: "system-agent",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
        },
      },
    });
    await expect(pending.decision).resolves.toBe("allow-once");
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({ kind: "channel", id: "telegram:ops" });
  });

  it("refuses a system-agent decision when reviewer custody is revoked before the final write", async () => {
    const { databaseOptions, managers, request } = createFixture(true);
    const pending = await registerSystemAgent(managers.systemAgent, "system-agent:revoked-owner");
    // Custody holds when the request arrives, then the owner is removed before the decision write.
    prepareApprovalChannelCustodyMock.mockReturnValue({
      resolverId: "irc:default",
      authorizes: () => true,
      isCurrent: () => false,
    });
    const response = await request(
      "approval.resolve",
      {
        id: pending.record.id,
        kind: "system-agent",
        decision: "allow-once",
        reviewer: { channel: "irc", accountId: "default", senderId: "alice" },
      },
      createClient({ internal: true }),
    );

    expect(response.result).toBeUndefined();
    expect((await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.status).toBe(
      "pending",
    );
  });

  it("refuses a plugin reviewer revoked between lookup and the final decision write", async () => {
    const { databaseOptions, managers, request } = createFixture();
    const record = managers.plugin.create(
      {
        title: "Plugin permission",
        description: "Allow one action",
        severity: "warning",
        pluginId: "diffs",
        toolName: "view",
        agentId: "main",
        sessionKey: "agent:main:child",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
      600_000,
      "plugin:revoked-slack-reviewer",
    );
    record.requestedByDeviceId = "requester-device";
    record.requestedByClientId = "requester-client";
    record.requestedByDeviceTokenAuth = true;
    record.approvalReviewerDeviceIds = ["reviewer"];
    const pending = (await managers.plugin.register(record, 600_000)).decision;
    const reviewerId = (userId: string) => `team:T11111111:user:${userId}`;
    const configWithReviewer = (userId: string): OpenClawConfig => ({
      approvals: { plugin: { slack: { approvers: [reviewerId(userId)] } } },
    });
    const nextConfig = configWithReviewer("U22222222");
    let config = configWithReviewer("U11111111");
    prepareApprovalChannelCustodyMock.mockImplementation(
      ({ cfg, reviewer }: { cfg: OpenClawConfig; reviewer: { senderId: string } }) => {
        const authorized = cfg.approvals?.plugin?.slack?.approvers?.includes(
          reviewerId(reviewer.senderId),
        );
        if (authorized && reviewer.senderId === "U11111111") {
          config = nextConfig;
        }
        return authorized ? { resolverId: "slack:default", authorizes: () => true } : null;
      },
    );
    const context = { ...createContext(), getRuntimeConfig: () => config };
    const resolve = async (senderId: string) =>
      await request(
        "approval.resolve",
        {
          id: record.id,
          kind: "plugin",
          decision: "allow-once",
          reviewer: { channel: "slack", accountId: "default", senderId },
        },
        createClient({ internal: true }),
        context,
      );

    expect((await resolve("U11111111")).result).toBeUndefined();
    expect((await getOperatorApproval({ id: record.id, databaseOptions }))?.status).toBe("pending");
    expect((await resolve("U22222222")).result).toMatchObject({ applied: true });
    await expect(pending).resolves.toBe("allow-once");
  });

  it("checks live channel custody before the canonical resolution CAS", async () => {
    const { databaseOptions, managers, handlers } = createFixture();
    const pending = await registerExec(managers.exec, {
      id: "channel-custody-cas",
      request: { turnSourceChannel: "telegram", turnSourceAccountId: "ops" },
      reviewerDeviceIds: [],
    });
    prepareApprovalChannelCustodyMock.mockReturnValue({
      resolverId: "telegram:ops",
      authorizes: (request: { request: ExecApprovalRequestPayload }) =>
        request.request.turnSourceAccountId === "ops",
    });
    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: {
        id: pending.record.id,
        kind: "exec",
        decision: "deny",
        reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
      },
      client: createClient({ internal: true }),
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny" },
    });
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({
      kind: "channel",
      id: "telegram:ops",
    });
  });
});
