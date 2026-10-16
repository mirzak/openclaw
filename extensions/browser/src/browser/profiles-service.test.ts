import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { BrowserProfileConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test-support.js";
import { resolveOpenClawUserDataDir } from "./chrome.js";
import type { BrowserRouteContext, BrowserServerState } from "./server-context.js";
import {
  enqueueProfileStart,
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  registerProfileHandle,
} from "./server-context.lifecycle.js";
import { movePathToTrash } from "./trash.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  getRuntimeConfigSourceSnapshot: vi.fn<() => OpenClawConfig | null>(() => null),
  writeConfigFile: vi.fn<(cfg: OpenClawConfig) => Promise<void>>(async (_cfg) => {}),
  mutateConfigFile: vi.fn(
    async (params: {
      mutate: (
        draft: OpenClawConfig,
        context: {
          snapshot: {
            path: string;
            runtimeConfig: OpenClawConfig;
            sourceConfig: OpenClawConfig;
          };
        },
      ) => unknown;
    }) => {
      const currentConfig = structuredClone(configMocks.getRuntimeConfig());
      const draft = structuredClone(currentConfig);
      const result = await params.mutate(draft, {
        snapshot: {
          path: "/tmp/openclaw.json",
          runtimeConfig: currentConfig,
          sourceConfig: currentConfig,
        },
      });
      await configMocks.writeConfigFile(draft);
      return {
        path: "/tmp/openclaw.json",
        previousHash: "test-hash",
        persistedHash: "test-hash",
        snapshot: { path: "/tmp/openclaw.json" },
        nextConfig: draft,
        result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { action: "none" },
      };
    },
  ),
}));
const writeConfigFile = configMocks.writeConfigFile;
const lifecycleMocks = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => false),
  stopOpenClawChrome: vi.fn(async () => {}),
  stopOwnedOpenClawChrome: vi.fn<typeof import("./chrome.js").stopOwnedOpenClawChrome>(),
}));

vi.mock("openclaw/plugin-sdk/config-mutation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/config-mutation")>()),
  replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
    await configMocks.writeConfigFile(nextConfig);
  }),
  mutateConfigFile: configMocks.mutateConfigFile,
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: configMocks.getRuntimeConfig,
  getRuntimeConfigSourceSnapshot: configMocks.getRuntimeConfigSourceSnapshot,
}));

vi.mock("./trash.js", () => ({
  movePathToTrash: vi.fn(async (targetPath: string) => targetPath),
}));

vi.mock("./chrome-mcp.js", () => ({
  closeChromeMcpSession: lifecycleMocks.closeChromeMcpSession,
}));

vi.mock("./pw-ai-module.js", () => ({
  getLoadedPwAiModule: () => null,
  getPwAiModule: async () => null,
}));

vi.mock("./chrome.js", () => ({
  resolveOpenClawUserDataDir: vi.fn(() => "/tmp/openclaw-test/openclaw/user-data"),
  stopOpenClawChrome: lifecycleMocks.stopOpenClawChrome,
  stopOwnedOpenClawChrome: lifecycleMocks.stopOwnedOpenClawChrome,
}));

const [
  { resolveBrowserConfig, resolveProfile },
  { createBrowserProfilesService },
  { getChromeMcpModule },
] = await Promise.all([
  import("./config.js"),
  import("./profiles-service.js"),
  import("./chrome-mcp.runtime.js"),
]);
const { setDefaultBrowserProfile } = await import("./config-mutations.js");

afterEach(() => getChromeMcpModule.clear());
afterAll(() => getChromeMcpModule.clear());

function createCtx(resolved = resolveBrowserConfig({})) {
  const state: BrowserServerState = {
    server: null as unknown as BrowserServerState["server"],
    port: 0,
    resolved,
    profiles: new Map(),
  };

  const ctx = {
    state: () => state,
    listProfiles: vi.fn(async () => []),
    forProfile: vi.fn(() => ({
      stopRunningBrowser: vi.fn(async () => ({ stopped: true })),
    })),
  } as unknown as BrowserRouteContext;

  return { state, ctx, service: createBrowserProfilesService(ctx) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function writtenBrowserConfig() {
  return expectDefined(writeConfigFile.mock.calls[0]?.[0].browser, "written browser config");
}

function writtenProfiles() {
  return expectDefined(writtenBrowserConfig().profiles, "written browser profiles");
}

const OPENCLAW_PROFILE = { cdpPort: 18800, color: "#FF4500" } as const;
const WORK_PROFILE = { cdpPort: 18801, color: "#0066CC" };

function profileConfig(work: BrowserProfileConfig, defaultProfile = "openclaw"): OpenClawConfig {
  return { browser: { defaultProfile, profiles: { openclaw: OPENCLAW_PROFILE, work } } };
}

function profileRuntime(state: BrowserServerState) {
  return getOrCreateProfileRuntime(
    state,
    expectDefined(resolveProfile(state.resolved, "work"), "work profile"),
  );
}

async function pendingStart(
  state: BrowserServerState,
  runtime: ReturnType<typeof profileRuntime>,
  run: (signal: AbortSignal) => Promise<void>,
) {
  const entered = deferred();
  const starting = enqueueProfileStart({
    state,
    runtime,
    key: "default",
    run: async (signal) => {
      entered.resolve();
      await run(signal);
    },
  });
  const rejected = expect(starting).rejects.toThrow(/deletion|lifecycle changed/i);
  await entered.promise;
  return { rejected };
}

function localUserDataDir(prefix: string, createUserData = true) {
  const userDataDir = path.join(tempDirs.make(prefix), "work", "user-data");
  fs.mkdirSync(createUserData ? userDataDir : path.dirname(userDataDir), { recursive: true });
  vi.mocked(resolveOpenClawUserDataDir).mockReturnValue(userDataDir);
  return userDataDir;
}

function createDeletionFixture(
  params: {
    name?: string;
    resolvedProfile?: BrowserProfileConfig;
    persistedProfile?: BrowserProfileConfig;
  } = {},
) {
  const name = params.name ?? "work";
  const profile = params.resolvedProfile ?? WORK_PROFILE;
  const fixture = createCtx(resolveBrowserConfig({ profiles: { [name]: profile } }));
  vi.mocked(getRuntimeConfig).mockReturnValue({
    browser: {
      defaultProfile: "openclaw",
      profiles: {
        openclaw: OPENCLAW_PROFILE,
        [name]: params.persistedProfile ?? profile,
      },
    },
  });
  return fixture;
}

describe("BrowserProfilesService", () => {
  beforeEach(() => {
    getChromeMcpModule.clear();
    vi.clearAllMocks();
    configMocks.getRuntimeConfigSourceSnapshot.mockReset().mockReturnValue(null);
    configMocks.writeConfigFile.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.closeChromeMcpSession.mockReset().mockResolvedValue(false);
    lifecycleMocks.stopOpenClawChrome.mockReset().mockResolvedValue(undefined);
    lifecycleMocks.stopOwnedOpenClawChrome.mockReset().mockResolvedValue({ status: "not-running" });
    vi.mocked(resolveOpenClawUserDataDir)
      .mockReset()
      .mockReturnValue("/tmp/openclaw-test/openclaw/user-data");
    vi.mocked(movePathToTrash)
      .mockReset()
      .mockImplementation(async (targetPath) => targetPath);
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });
  });

  it("round-trips prototype-like profile names as own entries", async () => {
    for (const profileName of ["constructor", "prototype"] as const) {
      writeConfigFile.mockClear();
      vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { profiles: {} } });
      const { state, service } = createCtx();
      const result = await service.createProfile({ name: profileName });

      expect(result.profile).toBe(profileName);
      expect(Object.hasOwn(state.resolved.profiles, profileName)).toBe(true);
      const createdProfiles = writtenProfiles();
      expect(Object.hasOwn(createdProfiles, profileName)).toBe(true);

      writeConfigFile.mockClear();
      const createdProfile = expectDefined(createdProfiles[profileName], "created browser profile");
      vi.mocked(getRuntimeConfig).mockReturnValue({
        browser: {
          defaultProfile: "openclaw",
          profiles: { [profileName]: createdProfile },
        },
      });
      await service.deleteProfile(profileName);

      const deletedProfiles = writtenProfiles();
      expect(Object.hasOwn(deletedProfiles, profileName)).toBe(false);
      expect(Object.hasOwn(state.resolved.profiles, profileName)).toBe(false);
      expect(resolveProfile(resolveBrowserConfig({ profiles: deletedProfiles }), profileName)).toBe(
        null,
      );
    }
  });

  it("persists an existing managed profile as the browser default", async () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      browser: { profiles: { imported: WORK_PROFILE } },
    });

    await setDefaultBrowserProfile("imported");

    expect(writtenBrowserConfig().defaultProfile).toBe("imported");
  });

  it("allocates local ports from a gateway port changed during config rebase", async () => {
    const { state, service } = createCtx();
    vi.mocked(getRuntimeConfig)
      .mockReturnValueOnce({ browser: { profiles: {} } })
      .mockReturnValue({ gateway: { port: 30000 }, browser: { profiles: {} } });
    const result = await service.createProfile({ name: "work" });

    expect(result.cdpPort).toBe(30012);
    expect(state.resolved.profiles.work?.cdpPort).toBe(30012);
    expect(writtenProfiles().work?.cdpPort).toBe(30012);
  });

  it("redacts CDP credentials from create responses while preserving profile auth", async () => {
    const { service } = createCtx(
      resolveBrowserConfig({ ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } }),
    );
    const cdpUrl = "http://browser-user:browser-password@127.0.0.1:9222/?token=browser-token";

    const result = await service.createProfile({ name: "remote", cdpUrl });

    expect(result.cdpUrl).toBe("http://127.0.0.1:9222/?token=***");
    expect(result.cdpUrl).not.toContain("browser-user");
    expect(result.cdpUrl).not.toContain("browser-password");
    expect(result.cdpUrl).not.toContain("browser-token");
    expect(writtenProfiles().remote?.cdpUrl).toBe(cdpUrl);
  });

  it("rejects private-network cdpUrl before creating an existing-session profile", async () => {
    const strictConfig = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } };
    const { ctx } = createCtx(resolveBrowserConfig(strictConfig));
    vi.mocked(getRuntimeConfig).mockReturnValue({ browser: { ...strictConfig, profiles: {} } });

    await expect(
      createBrowserProfilesService(ctx).createProfile({
        name: "chrome-live",
        driver: "existing-session",
        cdpUrl: "http://10.0.0.42:9222",
      }),
    ).rejects.toThrow(/private\/internal\/special-use ip address/i);
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it.each([
    ["creates existing-session profiles as attach-only local entries", undefined, null],
    [
      "accepts driver=existing-session with cdpUrl",
      "http://127.0.0.1:9222/",
      "http://127.0.0.1:9222",
    ],
  ] as Array<[string, string | undefined, string | null]>)(
    "%s",
    async (_name, cdpUrl, expectedCdpUrl) => {
      const { service, state } = createCtx();
      const result = await service.createProfile({
        name: "chrome-live",
        driver: "existing-session",
        cdpUrl,
      });
      expect(result).toMatchObject({
        transport: "chrome-mcp",
        cdpPort: null,
        cdpUrl: expectedCdpUrl,
        userDataDir: null,
        isRemote: false,
      });
      const expectedProfile = {
        driver: "existing-session",
        attachOnly: true,
        ...(expectedCdpUrl ? { cdpUrl: expectedCdpUrl } : {}),
      };
      expect(state.resolved.profiles["chrome-live"]).toMatchObject(expectedProfile);
      expect(writtenProfiles()["chrome-live"]).toMatchObject(expectedProfile);
    },
  );

  it("deletes existing-session profiles without touching local browser data", async () => {
    const { ctx, service } = createDeletionFixture({
      name: "chrome-live",
      resolvedProfile: {
        ...WORK_PROFILE,
        driver: "existing-session",
        attachOnly: true,
      },
    });
    const result = await service.deleteProfile("chrome-live");

    expect(result.deleted).toBe(false);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(resolveOpenClawUserDataDir).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("rejects deletion when the profile became default before persistence", async () => {
    const work = { cdpUrl: "http://10.0.0.42:9222", color: "#0066CC" };
    const { ctx, state, service } = createCtx(resolveBrowserConfig({ profiles: { work } }));
    vi.mocked(getRuntimeConfig)
      .mockReturnValueOnce(profileConfig(work))
      .mockReturnValue(profileConfig(work, "work"));
    await expect(service.deleteProfile("work")).rejects.toThrow(
      'cannot delete the default profile "work"',
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(state.resolved.profiles).toHaveProperty("work");
    expect(state.profiles.has("work")).toBe(true);
    expect(ctx.forProfile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
  });

  it("preserves profile config and data when a live browser cannot be safely stopped", async () => {
    const { service, state } = createDeletionFixture();
    lifecycleMocks.stopOwnedOpenClawChrome.mockResolvedValueOnce({
      status: "unverified",
      reason: "managed process identity changed",
    });

    await expect(service.deleteProfile("work")).rejects.toThrow("managed process identity changed");

    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
    expect(state.resolved.profiles).toHaveProperty("work");

    await expect(service.deleteProfile("work")).resolves.toMatchObject({ ok: true });
    expect(writeConfigFile).toHaveBeenCalledOnce();
  });

  it("keeps local data and reports deleted=false when Trash rejects", async () => {
    const { service, state } = createDeletionFixture();
    const userDataDir = localUserDataDir("openclaw-trash-failure-", false);
    vi.mocked(movePathToTrash).mockRejectedValueOnce(new Error("Trash unavailable"));

    const result = await service.deleteProfile("work");

    expect(result.deleted).toBe(false);
    expect(state.resolved.profiles).not.toHaveProperty("work");
    expect(state.profiles.has("work")).toBe(false);
    expect(fs.existsSync(path.dirname(userDataDir))).toBe(true);
  });

  it("cleans a pending managed start before persisting deletion", async () => {
    const { service, state } = createDeletionFixture();
    const runtime = profileRuntime(state);
    const userDataDir = localUserDataDir("openclaw-delete-race-");
    const launch = deferred();
    const running = {
      pid: 42,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir,
      cdpPort: 18801,
      proc: { on: vi.fn(), exitCode: null, signalCode: null },
    } as unknown as import("./chrome.js").RunningChrome;
    const { rejected } = await pendingStart(state, runtime, async () => {
      await launch.promise;
      registerProfileHandle(runtime, running);
      runtime.running = running;
    });
    const order: string[] = [];
    lifecycleMocks.stopOpenClawChrome.mockImplementationOnce(async () => {
      order.push("stop");
    });
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      order.push("config");
    });
    vi.mocked(movePathToTrash).mockImplementationOnce(async (targetPath) => {
      order.push("trash");
      return targetPath;
    });

    const deleting = service.deleteProfile("work");
    launch.resolve();
    await Promise.all([rejected, deleting]);

    expect(order).toEqual(["stop", "config", "trash"]);
    expect(state.profiles.has("work")).toBe(false);
  });

  it("preserves a same-name replacement config that appears during lifecycle drain", async () => {
    let currentConfig = profileConfig(WORK_PROFILE);
    vi.mocked(getRuntimeConfig).mockImplementation(() => currentConfig);
    const { service, state } = createCtx(
      resolveBrowserConfig({ profiles: { work: WORK_PROFILE } }),
    );
    const runtime = profileRuntime(state);
    const release = deferred();
    const { rejected } = await pendingStart(state, runtime, async (signal) => {
      await release.promise;
      signal.throwIfAborted();
    });

    const deleting = service.deleteProfile("work");
    const deleteExpectation = expect(deleting).rejects.toThrow(
      'profile "work" changed while deletion was pending; retry the delete request',
    );
    currentConfig = profileConfig({ cdpPort: 18802, color: "#00AA00" });
    release.resolve();

    await Promise.all([rejected, deleteExpectation]);
    expect(writeConfigFile).not.toHaveBeenCalled();
    expect(movePathToTrash).not.toHaveBeenCalled();
    expect(state.profiles.get("work")).toBe(runtime);
    expect(getProfileLifecycle(runtime).terminal).toBeNull();
    expect(getProfileLifecycle(runtime).blockedReason).toBeNull();
    await expect(
      enqueueProfileStart({
        state,
        runtime,
        key: "after-drift",
        run: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});
