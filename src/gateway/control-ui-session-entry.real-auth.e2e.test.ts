import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { get, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS,
  ensureControlUiAssetsBuilt,
} from "../infra/control-ui-assets.js";
import * as commandProcess from "../process/exec.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import * as documentTransport from "./control-ui-static.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

// Keyless opt-in Gateway E2E, not the default unit lane. One actual HTTP server,
// real SQLite profile/session/membership owners, and the existing built UI bundle.
// Only document transport is delayed; authentication and access decisions are never mocked.
// This models an already-authenticated trusted proxy, NOT Cloudflare login or its policy.
const basePath = "/control";
const privatePath = "/control/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001";
const publicPath = "/control/chat/main/dashboard/87654321-aaaa-4000-8000-000000000002";
const privateScope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001",
  sessionId: "private-http-instance",
};
const publicScope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:87654321-aaaa-4000-8000-000000000002",
  sessionId: "public-http-instance",
};
const entry = buildControlUiSessionEntryUrl(privatePath, basePath);
const memberEmail = "http-handoff-member@example.test";
const deniedEmail = "http-handoff-denied@example.test";
const ownerEmail = "http-handoff-owner@example.test";
const privateTitle = "Private HTTP handoff conversation";
const privateMessage = "Unpublished conversation text must not reach the anonymous document.";
const publishedMessage = "Published HTTP handoff conversation text.";
const proxyHeaders = {
  host: "threads.example.test",
  "x-forwarded-for": "203.0.113.42",
  "x-forwarded-proto": "https",
  "x-openclaw-scopes": "operator.read",
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };

function readHttp(
  port: number,
  route: string,
  email?: string,
  signal?: AbortSignal,
  ingressHeaders: Record<string, string> = proxyHeaders,
) {
  return new Promise<HttpResult>((resolve, reject) => {
    get(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        signal,
        agent: false,
        headers: {
          ...ingressHeaders,
          "accept-encoding": "gzip",
          ...(email ? { "x-forwarded-user": email } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: (response.headers["content-encoding"] === "gzip"
              ? gunzipSync(bytes)
              : bytes
            ).toString("utf8"),
          });
        });
      },
    ).once("error", reject);
  });
}

function expectNoApp(response: HttpResult) {
  for (const text of ["<openclaw-app", 'type="module"', privateTitle, privateMessage]) {
    expect(response.body).not.toContain(text);
  }
}

function holdPreparedDocument() {
  const entered = createDeferred<{ body: string; res: ServerResponse; current: boolean }>();
  const resume = createDeferred();
  const send = documentTransport.sendControlUiHtmlBody;
  const spy = vi
    .spyOn(documentTransport, "sendControlUiHtmlBody")
    .mockImplementationOnce(async (req, res, body, isCurrent) => {
      // Delay only transport; the production encoder still owns the final authority check.
      entered.resolve({ body, res, current: isCurrent?.() === true });
      await resume.promise;
      await send(req, res, body, isCurrent);
    });
  return { entered: entered.promise, resume: resume.resolve, restore: () => spy.mockRestore() };
}

describe("real HTTP authentication to canonical thread app delivery", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let listener:
    | Awaited<
        ReturnType<typeof reserveTestPortListener<ReturnType<typeof createGatewayHttpServer>>>
      >
    | undefined;
  let projection: SessionRowProjection | undefined;
  let memberId: string;
  let ownerId: string;
  let index: string;
  let port: number;
  let auth: ResolvedGatewayAuth;
  const request = (
    route: string,
    signal: AbortSignal,
    email?: string,
    headers: Record<string, string> = proxyHeaders,
  ) => readHttp(port, route, email, signal, headers);

  beforeAll(async () => {
    // qaRuntime snapshots omit UI assets. The existing owner builds the real bundle
    // once inside the admitted isolated checkout; no host artifacts or fake shell.
    const run = commandProcess.runCommandWithTimeout;
    const diagnostics = vi
      .spyOn(commandProcess, "runCommandWithTimeout")
      .mockImplementation(async (...args) => {
        const result = await run(...args);
        if (result.code !== 0 || result.termination !== "exit") {
          console.error("Control UI build process failure:", result);
        }
        return result;
      });
    try {
      const assets = await ensureControlUiAssetsBuilt(undefined, { root: process.cwd() });
      if (!assets.ok) {
        throw new Error(assets.message);
      }
    } finally {
      diagnostics.mockRestore();
    }
  }, CONTROL_UI_ASSETS_BUILD_TIMEOUT_MS);

  beforeAll(async () => {
    const root = path.resolve("dist/control-ui");
    index = await readFile(path.join(root, "index.html"), "utf8");
    expect(index).toContain("<openclaw-app");
    expect(index).toContain('type="module"');
    console.info("HTTP handoff UI index sha256:", createHash("sha256").update(index).digest("hex"));
    state = await createOpenClawTestState({
      scenario: "minimal",
      label: "session-entry-real-auth",
    });
    const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
    auth = {
      mode: "trusted-proxy",
      trustedProxy,
      allowTailscale: false,
    };
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        publicOrigin: "https://threads.example.test",
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        controlUi: { basePath },
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
            denied: { agents: "*", sessions: { others: "none" }, scopes: ["operator.read"] },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    ownerId = (await ensureCanonicalUserProfileForEmail(ownerEmail)).id;
    memberId = (await ensureCanonicalUserProfileForEmail(memberEmail)).id;
    const deniedId = (await ensureCanonicalUserProfileForEmail(deniedEmail)).id;
    await setCanonicalUserProfileRole(deniedId, "denied", {
      onCommitted: invalidateOperatorRolePolicy,
    });
    const seedThread = async (
      scope: typeof privateScope,
      displayName: string,
      content: string,
      updatedAt: number,
      patch: Partial<SessionEntry>,
    ) => {
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt,
        displayName,
        createdActor: { type: "human", source: "profile", id: ownerId },
        ...patch,
      });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: updatedAt === 1 ? "private-message" : "public-message",
          message: { role: "user", content },
        },
      ]);
    };
    await seedThread(privateScope, privateTitle, privateMessage, 1, { visibility: "read-only" });
    await addSessionMember(privateScope, { identityId: memberId, addedBy: ownerId });
    await seedThread(publicScope, "Public HTTP handoff conversation", publishedMessage, 2, {
      publicShare: { id: "a".repeat(48), sessionId: publicScope.sessionId, createdAt: 1 },
    });
    projection = await createSessionRowProjection({ cfg, getConfig: () => cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    // Reuse the suite context fixture only for unrelated scheduler/WS services.
    // The bound resident projection and every HTTP auth/profile/access owner are real.
    const context = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    bindSessionRowProjection(context, () => projection);
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: basePath,
          controlUiRoot: { kind: "resolved", path: root },
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth: auth,
          getResolvedAuth: () => auth,
          getRuntimeConfig: () => cfg,
          getGatewayRequestContext: () => context,
          httpRequestLifetime: context,
          isTerminalEnabled: () => false,
        }),
    });
    port = listener.claim.port;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (listener) {
        listener.listener.closeAllConnections();
        await listener.releaseListener();
      }
    } finally {
      try {
        await listener?.claim.release();
      } finally {
        projection?.dispose();
        await state?.cleanup();
      }
    }
  });

  for (const mode of ["token", "password"] as const) {
    it(`reopens private ${mode} chat links through the real HTTP entry`, async ({ signal }) => {
      const previousAuth = auth;
      auth = {
        mode,
        token: "synthetic-token",
        password: "synthetic-password",
        allowTailscale: false,
      };
      try {
        for (const headers of [{ host: "localhost" }, proxyHeaders]) {
          const response = await request(privatePath, signal, undefined, headers);
          expect(response.status).toBe(404);
          expectNoApp(response);
          expect(response.body).toContain('data-gateway-path="/control"');
          expect((await request(entry + "&probe=1", signal, undefined, headers)).status).toBe(401);
          const app = await request(entry, signal, undefined, headers);
          expect(app.status).toBe(200);
          expect(app.body).toContain("<openclaw-app");
        }
        const nonSecure = await request(privatePath, signal, undefined, {
          host: "gateway.lan",
        });
        expect(nonSecure.status).toBe(200);
        expect(nonSecure.body).toContain("<openclaw-app");
        expect(nonSecure.body).not.toContain(privateMessage);
        const published = await request(publicPath, signal, undefined);
        expect(published.status).toBe(200);
        expect(published.body).toContain(publishedMessage);
        expectNoApp(published);
      } finally {
        auth = previousAuth;
      }
    });
  }

  it("delivers the real app for both the owner and an allowed authenticated reader", async ({
    signal,
  }) => {
    for (const email of [ownerEmail, memberEmail]) {
      expect((await request(entry + "&probe=1", signal, email)).status, email).toBe(204);
      const response = await request(entry, signal, email);
      expect(response.status, email).toBe(200);
      expect(response.body).toContain("<openclaw-app");
      expect(response.body).toContain('type="module"');
      const moduleSource = index.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/u)?.[1];
      expect(moduleSource).toBeTruthy();
      expect(response.body).toContain(moduleSource!.replace("./assets/", basePath + "/assets/"));
      expect(response.body).toContain(
        'history.replaceState(null,"",' + JSON.stringify(privatePath),
      );
      expect(response.body.indexOf("history.replaceState")).toBeLessThan(
        response.body.indexOf('type="module"'),
      );
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-encoding"]).toBe("gzip");
      for (const hash of computeInlineScriptHashes(response.body)) {
        expect(response.headers["content-security-policy"]).toContain(hash);
      }
    }
  });

  it("keeps a genuinely authenticated but denied profile on the unavailable reader", async ({
    signal,
  }) => {
    // 403 (not 401) proves identity admission succeeded before session access was denied.
    const probe = await request(entry + "&probe=1", signal, deniedEmail);
    expect(probe.status).toBe(403);
    expectNoApp(probe);
    const document = await request(entry, signal, deniedEmail);
    expect(document.status).toBe(403);
    expect(document.headers.location).toBeUndefined();
    expectNoApp(document);
    expect(document.body).toContain("Session unavailable");
  });

  it("ignores spoofed identity on anonymous canonical documents while protecting the handoff", async ({
    signal,
  }) => {
    const anonymous = await request(publicPath, signal, undefined);
    const spoofed = await request(publicPath, signal, ownerEmail);
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toContain(publishedMessage);
    expect(spoofed.status).toBe(200);
    expect(spoofed.body).toBe(anonymous.body);
    expectNoApp(spoofed);
    const privateAnonymous = await request(privatePath, signal, undefined);
    const privateSpoofed = await request(privatePath, signal, ownerEmail);
    expect(privateAnonymous.status).toBe(404);
    expect(privateSpoofed.status).toBe(404);
    expect(privateSpoofed.body).toBe(privateAnonymous.body);
    expectNoApp(privateSpoofed);
    for (const route of [
      entry,
      entry + "&probe=1",
      basePath + "/__openclaw__/assistant-media?source=missing.png",
    ]) {
      const protectedResponse = await request(route, signal, undefined);
      expect(protectedResponse.status).toBe(401);
      expectNoApp(protectedResponse);
    }
  });

  for (const change of ["membership", "role"] as const) {
    it(`withholds all app bytes when ${change} changes after real document preparation`, async ({
      signal,
    }) => {
      await addSessionMember(privateScope, { identityId: memberId, addedBy: ownerId });
      const held = holdPreparedDocument();
      const pending = request(entry, signal, memberEmail);
      try {
        const prepared = await withinTest(
          awaitGateBeforeSettlement(
            held.entered,
            pending,
            "HTTP request ended before authorized app preparation",
          ),
          signal,
        );
        expect(prepared.current).toBe(true);
        expect(prepared.body).toContain("<openclaw-app");
        expect(prepared.res.headersSent).toBe(false);
        if (change === "membership") {
          expect(await removeSessionMember(privateScope, memberId)).not.toBeNull();
        } else {
          await setCanonicalUserProfileRole(memberId, "denied", {
            onCommitted: invalidateOperatorRolePolicy,
          });
        }
        expect(prepared.res.headersSent).toBe(false);
        held.resume();
        const response = await pending;
        expect(response.status).toBe(403);
        expect(response.headers.location).toBeUndefined();
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["content-encoding"]).toBeUndefined();
        expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
        expect(response.headers["content-security-policy"]).toBeUndefined();
        expect(response.body).toContain("Session access changed");
        expectNoApp(response);
      } finally {
        held.resume();
        await Promise.allSettled([pending]);
        held.restore();
        await setCanonicalUserProfileRole(memberId, null, {
          onCommitted: invalidateOperatorRolePolicy,
        });
      }
    });
  }
});
