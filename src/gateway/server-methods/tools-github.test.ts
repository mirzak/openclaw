import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubCliUnavailableError } from "../github-cli-preflight.js";
import { toolsGitHubHandlers } from "./tools-github.js";

const github = vi.hoisted(() => ({
  createProfileId: vi.fn(() => "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
  install: vi.fn(),
  profileDir: vi.fn(() => "/tmp/managed-github"),
  configured: vi.fn(),
  status: vi.fn(),
  updateConfig: vi.fn(),
}));
const secrets = vi.hoisted(() => ({ consumeHandoff: vi.fn() }));
const oauth = {
  startAuthorization: vi.fn(),
  pollAuthorization: vi.fn(),
  cancelAuthorizationAsync: vi.fn(),
  retireProfileAsync: vi.fn(),
};

vi.mock("../../agents/github-tool-identity.js", () => ({
  createManagedGitHubProfileId: github.createProfileId,
  installManagedGitHubProfile: github.install,
  resolveConfiguredGitHubToolIdentity: github.configured,
  resolveManagedGitHubProfileDir: github.profileDir,
  resolveGitHubToolIdentityStatus: github.status,
}));
vi.mock("../github-tool-identity-config.js", () => ({
  updateGitHubToolIdentityConfig: github.updateConfig,
}));
vi.mock("../../secrets/store/secret-store.js", () => ({
  consumeGitHubSetupHandoff: secrets.consumeHandoff,
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  listAgentIds: vi.fn(() => ["main", "reviewer"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

const agentScope = { scope: "agent", agentId: "main" } as const;
const systemScope = { scope: "system", agentId: "main" } as const;
// Status is an opaque owner result here; identity resolution has its own suite.
const status = { agentId: "main", selectedScope: "agent" } as const;

async function invoke(
  method: `tools.github.${"status" | "configure" | "authorize.start" | "authorize.poll" | "authorize.cancel"}`,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  const handler = expectDefined(toolsGitHubHandlers[method], `${method} handler`);
  await handler({
    params,
    respond: respond as never,
    context: { getRuntimeConfig: () => ({}), githubOAuthService: oauth } as never,
    client: null,
    req: { type: "req", id: "req-github", method },
    isWebchatConnect: () => false,
  });
  return respond;
}

function configure(secretDigit: string, params: Record<string, unknown> = {}) {
  return invoke("tools.github.configure", {
    ...systemScope,
    mode: "managed",
    secretName: `github-setup-${secretDigit.repeat(32)}`,
    ...params,
  });
}

describe("tools.github handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    github.configured.mockReturnValue(undefined);
    github.status.mockResolvedValue(status);
    github.updateConfig.mockResolvedValue({ next: true });
    Object.values(oauth).forEach((mock) => mock.mockReset());
  });

  it("returns selected-scope plus effective status without refreshing credentials", async () => {
    const respond = await invoke("tools.github.status", {
      agentId: "main",
      selectedScope: "system",
    });
    expect(oauth.refreshEffectiveIdentity).not.toHaveBeenCalled();
    expect(github.status).toHaveBeenCalledWith({
      config: {},
      sourceConfig: {},
      agentId: "main",
      selectedScope: "system",
    });
    expect(respond).toHaveBeenCalledWith(true, status);
  });

  it("uses the selected agent when returning system-scope effective status", async () => {
    github.status.mockResolvedValue({
      ...status,
      agentId: "reviewer",
      selectedScope: "system",
      selected: { ...status.selected, scope: "system" },
    });
    const respond = await invoke("tools.github.configure", {
      scope: "system",
      agentId: "reviewer",
      mode: "inherit",
    });

    expect(github.updateConfig).toHaveBeenCalledWith({
      scope: "system",
      agentId: "reviewer",
      expectedIdentity: null,
    });
    expect(github.status).toHaveBeenCalledWith({
      config: { next: true },
      agentId: "reviewer",
      selectedScope: "system",
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ agentId: "reviewer" });
  });

  it("keeps the one-use PAT fallback functional and returns fresh status", async () => {
    secrets.consumeHandoff.mockReturnValue("temporary-test-token");
    github.install.mockImplementation(
      async ({
        commitConfig,
      }: {
        commitConfig: (account: { accountId: number; login: string }) => Promise<void>;
      }) => commitConfig({ accountId: 100, login: "managed-user" }),
    );

    const respond = await configure("1", {
      ...agentScope,
      gitAuthor: { name: "  Managed Author  ", email: "  managed@example.test  " },
    });

    expect(github.updateConfig).toHaveBeenCalledWith({
      ...agentScope,
      identity: {
        profileId: "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        gitAuthor: { name: "Managed Author", email: "managed@example.test" },
      },
      expectedIdentity: null,
    });
    expect(github.status).toHaveBeenLastCalledWith({
      config: { next: true },
      agentId: "main",
      selectedScope: "agent",
    });
    expect(respond).toHaveBeenCalledWith(true, status);
    expect(JSON.stringify(respond.mock.calls)).not.toContain("temporary-test-token");
  });

  it("defaults managed commit authorship to the verified GitHub user", async () => {
    secrets.consumeHandoff.mockReturnValue("temporary-test-token");
    github.install.mockImplementation(
      async (params: {
        commitConfig: (account: { accountId: number; login: string }) => Promise<void>;
      }) => {
        await params.commitConfig({ accountId: 123, login: "roboclaw-bot" });
        return { accountId: 123, login: "roboclaw-bot", avatarUrl: null };
      },
    );

    await invoke("tools.github.configure", {
      scope: "system",
      agentId: "main",
      mode: "managed",
      secretName: "github-setup-22222222222222222222222222222222",
    });

    expect(github.updateConfig).toHaveBeenCalledWith({
      scope: "system",
      agentId: "main",
      identity: {
        profileId: "ghp_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        gitAuthor: {
          name: "roboclaw-bot",
          email: "123+roboclaw-bot@users.noreply.github.com",
        },
      },
      expectedIdentity: null,
    });
  });

  it("rejects blank author data without consuming the setup handoff", async () => {
    const respond = await configure("4", { ...agentScope, gitAuthor: { name: "  \t" } });

    expect([
      secrets.consumeHandoff.mock.calls,
      github.createProfileId.mock.calls,
      github.install.mock.calls,
      github.updateConfig.mock.calls,
    ]).toEqual([[], [], [], []]);
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });

  it("removes an override without reading a handoff", async () => {
    const respond = await invoke("tools.github.configure", {
      scope: "agent",
      agentId: "main",
      mode: "inherit",
    });

    expect(secrets.consumeHandoff).not.toHaveBeenCalled();
    expect(github.updateConfig).toHaveBeenCalledWith({
      scope: "agent",
      agentId: "main",
      expectedIdentity: null,
    });
    expect(respond).toHaveBeenCalledWith(true, status);
  });

  it("retires disconnected OAuth metadata after the guarded config mutation", async () => {
    const profileId = "ghp_12121212121212121212121212121212";
    github.configured.mockReturnValue({ profileId, kind: "oauth" });

    await invoke("tools.github.configure", { ...systemScope, mode: "inherit" });

    expect(github.updateConfig).toHaveBeenCalledWith({
      ...systemScope,
      expectedIdentity: { profileId, kind: "oauth" },
    });
    expect(oauth.retireProfileAsync).toHaveBeenCalledWith(profileId);
  });

  it("delegates device start, poll, and cancel without exposing private authorization fields", async () => {
    const requestId = `github-device-${"1".repeat(32)}`;
    const authorization = {
      requestId,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresInMs: 900_000,
      pollAfterMs: 5_000,
    };
    oauth.startAuthorization.mockResolvedValue(authorization);
    oauth.pollAuthorization.mockResolvedValue({ status: "pending", retryAfterMs: 10_000 });
    oauth.cancelAuthorizationAsync.mockReturnValue(true);

    const start = await invoke("tools.github.authorize.start", agentScope);
    const poll = await invoke("tools.github.authorize.poll", { requestId });
    const cancel = await invoke("tools.github.authorize.cancel", { requestId });

    expect(oauth.startAuthorization).toHaveBeenCalledWith(agentScope);
    expect(oauth.pollAuthorization).toHaveBeenCalledWith(requestId);
    expect(oauth.cancelAuthorizationAsync).toHaveBeenCalledWith(requestId);
    expect(start.mock.calls[0]?.[1]).toEqual(authorization);
    expect(poll).toHaveBeenCalledWith(true, { status: "pending", retryAfterMs: 10_000 });
    expect(cancel).toHaveBeenCalledWith(true, { cancelled: true });
    expect(JSON.stringify(start.mock.calls)).not.toMatch(/device_code|access_token/);
  });

  it.each([
    ["poll", "GitHub authorization polling failed"],
    ["start", "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry."],
  ] as const)(
    "bounds %s failures without exposing authorization fields",
    async (action, message) => {
      const polling = action === "poll";
      (polling ? oauth.pollAuthorization : oauth.startAuthorization).mockRejectedValue(
        polling
          ? new Error("device_code=private access_token=private")
          : new GitHubCliUnavailableError(),
      );
      const respond = await invoke(
        `tools.github.authorize.${action}`,
        polling ? { requestId: `github-device-${"2".repeat(32)}` } : systemScope,
      );
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(JSON.stringify(respond.mock.calls)).toContain(message);
      expect(JSON.stringify(respond.mock.calls)).not.toMatch(/device_code|access_token/);
    },
  );

  it("fails closed when the secrets owner rejects the handoff", async () => {
    secrets.consumeHandoff.mockReturnValue(undefined);
    const respond = await configure("2");

    expect(github.install).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });

  it("consumes the setup handoff before gh validation can fail", async () => {
    secrets.consumeHandoff.mockReturnValue("invalid-test-token");
    github.install.mockRejectedValue(new Error("GitHub CLI rejected the managed credential."));

    const respond = await configure("3");

    expect(secrets.consumeHandoff.mock.invocationCallOrder[0]).toBeLessThan(
      github.install.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(github.updateConfig).not.toHaveBeenCalled();
    expect(respond.mock.calls[0]?.[0]).toBe(false);
  });
});
