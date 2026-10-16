import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveBrowserControlAuth: vi.fn(() => ({})),
  getBridgeAuthForPort: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return { ...actual, readRuntimeConfig: authMocks.loadConfig, loadConfig: authMocks.loadConfig };
});
vi.mock("./control-auth.js", () => ({
  resolveBrowserControlAuth: authMocks.resolveBrowserControlAuth,
}));
vi.mock("./bridge-auth-registry.js", () => ({
  getBridgeAuthForPort: authMocks.getBridgeAuthForPort,
}));

const { fetchBrowserJson } = await import("./client-fetch.js");

const STREAM_CHUNK = Buffer.alloc(4 * 1024, "x");
const STREAM_BODY_BYTES = 1024 * 1024;
const SUCCESS_STREAM_CHUNK = Buffer.alloc(64 * 1024, "x");
const SUCCESS_STREAM_BODY_BYTES = 33 * 1024 * 1024;
const BROWSER_SUCCESS_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const MALFORMED_UTF8_STATUSES = [200, 401, 408, 500, 504] as const;

function streamBody(res: http.ServerResponse, success: boolean, onClose: () => void) {
  const chunk = success ? SUCCESS_STREAM_CHUNK : STREAM_CHUNK;
  const total = success ? SUCCESS_STREAM_BODY_BYTES : STREAM_BODY_BYTES;
  const state = { completed: false };
  let written = 0;
  let closed = false;
  res.once("close", () => {
    closed = true;
    onClose();
  });
  res.writeHead(success ? 200 : 500, {
    "Content-Type": success ? "application/json" : "text/plain",
  });
  if (success) {
    res.write('{"payload":"');
  }
  const writeNext = () => {
    if (closed) {
      return;
    }
    if (written >= total) {
      state.completed = true;
      res.end(success ? '"}' : undefined);
      return;
    }
    const next = chunk.subarray(0, total - written);
    written += next.byteLength;
    // Preserve separate event-loop turns and backpressure without wall-clock sleeps.
    if (res.write(next)) {
      setImmediate(writeNext);
    } else {
      res.once("drain", () => setImmediate(writeNext));
    }
  };
  writeNext();
  return state;
}

describe("fetchHttpJson error body boundary", () => {
  let server: http.Server;
  let baseUrl: string;
  let streamClosed: ReturnType<typeof Promise.withResolvers<void>>;
  let successStreamClosed: ReturnType<typeof Promise.withResolvers<void>>;
  let malformedConnectionClosed: Map<number, ReturnType<typeof Promise.withResolvers<void>>>;
  let stream: ReturnType<typeof streamBody>;
  let successStream: ReturnType<typeof streamBody>;

  beforeEach(async () => {
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }

    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    streamClosed = Promise.withResolvers<void>();
    successStreamClosed = Promise.withResolvers<void>();
    malformedConnectionClosed = new Map(
      MALFORMED_UTF8_STATUSES.map((status) => [status, Promise.withResolvers<void>()]),
    );
    server = http.createServer((req, res) => {
      if (req.url === "/rate-limit") {
        req.socket.once("close", () => streamClosed.resolve());
        res.writeHead(429, { "Content-Type": "application/json" });
        res.write('{"error":"rate-limited"');
        return;
      }
      const malformedStatus = Number(req.url?.match(/^\/malformed-utf8\/(\d+)$/)?.[1]);
      if (MALFORMED_UTF8_STATUSES.some((status) => status === malformedStatus)) {
        req.socket.once("close", () => malformedConnectionClosed.get(malformedStatus)?.resolve());
        res.writeHead(malformedStatus, { "Content-Type": "application/json" });
        // Latin-1 emits a literal 0xff byte, invalid in UTF-8.
        res.end(Buffer.from('{"error":"control \xff"}', "latin1"));
        return;
      }
      if (req.url === "/success-large") {
        successStream = streamBody(res, true, successStreamClosed.resolve);
        return;
      }

      if (req.url === "/navigation-blocked") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "browser navigation blocked by policy",
            reason: "navigation_blocked",
            details: { url: "http://internal.example/admin" },
          }),
        );
        return;
      }

      stream = streamBody(res, false, streamClosed.resolve);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("rejects 429 and closes the hanging loopback socket", async ({ signal }) => {
    await expect(fetchBrowserJson(`${baseUrl}/rate-limit`, { signal })).rejects.toThrow(
      /rate[ -]?limit/i,
    );
    await streamClosed.promise;
  });

  it("cancels an overflowing stream and releases the guarded fetch", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/large`).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "BrowserServiceError", message: "HTTP 500" });
    await expect(streamClosed.promise).resolves.toBeUndefined();
    expect(stream.completed).toBe(false);
  });

  it("cancels an overflowing successful JSON response", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/success-large`).catch((err: unknown) => err);

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: `Browser control response exceeded ${BROWSER_SUCCESS_BODY_LIMIT_BYTES} bytes`,
    });
    await expect(successStreamClosed.promise).resolves.toBeUndefined();
    expect(successStream.completed).toBe(false);
  });

  it("rejects malformed UTF-8 responses, preserves retry policy, and releases each fetch", async () => {
    for (const status of MALFORMED_UTF8_STATUSES) {
      const error = await fetchBrowserJson(`${baseUrl}/malformed-utf8/${status}`).catch(
        (err: unknown) => err,
      );

      expect(error).toMatchObject({
        name: "BrowserServiceError",
        status,
      });
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain(`Browser control response was not valid UTF-8 (HTTP ${status})`);
      if (status === 401) {
        expect(message).toContain("Do NOT retry the browser tool");
      } else if (status === 408 || status === 504) {
        expect(message).toContain("Retry the browser tool once");
      } else {
        expect(message).not.toContain("Retry the browser tool");
      }
      const connectionClosed = malformedConnectionClosed.get(status);
      expect(connectionClosed).toBeDefined();
      await expect(connectionClosed?.promise).resolves.toBeUndefined();
    }
  });

  it("preserves a navigation denial without exposing raw policy details over HTTP", async () => {
    const error = await fetchBrowserJson(`${baseUrl}/navigation-blocked`).catch(
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      name: "BrowserServiceError",
      message: "browser navigation blocked by policy",
      reason: "navigation_blocked",
      status: 400,
      details: undefined,
    });
  });
});
