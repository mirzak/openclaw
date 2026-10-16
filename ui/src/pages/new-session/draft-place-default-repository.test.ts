import { describe, expect, it, vi } from "vitest";
import { buildSelectedSessionCreateParams } from "./draft-create-params.ts";
import { createRepositoryFixture } from "./draft-place-state.test-support.ts";
import type { NewSessionWhere } from "./preferences.ts";

const repository = {
  identity: "acme/private-repo",
  cloneUrl: "https://ghe.example.test/acme/private-repo.git",
};
const branchedRepository = { ...repository, defaultBranch: "main" };

function delayedCatalog(
  { browser }: ReturnType<typeof createRepositoryFixture>,
  project = repository,
) {
  let ready = false;
  vi.spyOn(browser, "projectsReady", "get").mockImplementation(() => ready);
  vi.spyOn(browser, "defaultRemoteProject", "get").mockImplementation(() =>
    ready ? project : null,
  );
  vi.spyOn(browser, "defaultRemoteProjectProfileId", "get").mockImplementation(() =>
    ready ? "aws" : "",
  );
  return () => {
    ready = true;
  };
}

describe("DraftPlaceState configured repository defaults", () => {
  it.each(["saved", "active"] as const)(
    "validates %s clone selections using the accepted Git URL forms",
    (source) => {
      for (const host of ["ghe.example.test", "old.ghe.example.test"]) {
        for (const cloneUrl of [
          `https://${host}/acme/private-repo.git`,
          `ssh://git@${host}/acme/private-repo.git`,
          `git@${host}:acme/private-repo.git`,
        ]) {
          const configured = createRepositoryFixture();
          const project = { identity: "acme/private-repo", cloneUrl };
          configured.readPreference.mockReturnValue(
            source === "saved" ? { remoteProject: project } : {},
          );
          vi.spyOn(configured.browser, "projectsReady", "get").mockReturnValue(true);
          vi.spyOn(configured.browser, "githubHost", "get").mockReturnValue("ghe.example.test");
          configured.state.adoptAgentDefaults();
          if (source === "active") {
            configured.state.selectRemoteProject(project);
          }
          configured.state.restorePreferenceSelections();
          expect(configured.browser.remoteProject, cloneUrl).toEqual(
            host === "ghe.example.test" ? project : null,
          );
        }
      }
    },
  );

  it.each(["saved-repository", "explicit"] as const)(
    "keeps a %s destination when the default repository catalog arrives later",
    (source) => {
      const destinations: NewSessionWhere[] = [
        { kind: "cloud", id: "selected-worker" },
        { kind: "device", id: "desktop" },
        { kind: "auto-device" },
        ...(source === "explicit" ? [{ kind: "local" } as const] : []),
      ];
      for (const where of destinations) {
        const configured = createRepositoryFixture({
          cloudProfiles: [
            { id: "aws", providerId: "crabbox" },
            { id: "selected-worker", providerId: "crabbox" },
          ],
        });
        configured.readPreference.mockReturnValue(
          source === "explicit" ? {} : { where, remoteProject: repository },
        );
        const publishCatalog = delayedCatalog(configured);
        vi.spyOn(configured.browser, "projectsLoading", "get").mockImplementation(
          () => !configured.browser.projectsReady,
        );
        configured.state.adoptAgentDefaults();
        configured.state.restorePreferenceSelections();
        if (source === "explicit") {
          if (where.kind === "cloud") {
            configured.state.selectCloudProfile(where.id);
          } else {
            configured.state.selectDevice(
              where.kind === "device" ? where.id : "",
              where.kind === "auto-device",
            );
          }
        }
        expect(configured.state.preferenceSelection().where).toEqual(where);
        expect(configured.state.placementPreferenceReady).toBe(false);

        publishCatalog();
        configured.state.restorePreferenceSelections();
        expect(configured.browser.remoteProject?.identity).toBe("acme/private-repo");
        expect(configured.state.preferenceSelection().where, where.kind).toEqual(where);
        expect(configured.state.placementPreferenceReady).toBe(true);
      }
    },
  );

  it("replaces an unrelated saved branch when the configured repository has no default ref", () => {
    const configured = createRepositoryFixture();
    configured.readPreference.mockReturnValue({
      folder: "/workspace",
      baseRef: "gateway/old-branch",
    });
    let projectsReady = false;
    vi.spyOn(configured.browser, "projectsReady", "get").mockImplementation(() => projectsReady);
    vi.spyOn(configured.browser, "projectsLoading", "get").mockImplementation(() => !projectsReady);
    vi.spyOn(configured.browser, "defaultRemoteProject", "get").mockReturnValue({
      identity: "acme/private-repo",
      cloneUrl: "https://ghe.example.test/acme/private-repo.git",
    });
    vi.spyOn(configured.browser, "defaultRemoteProjectProfileId", "get").mockReturnValue("aws");
    configured.state.adoptAgentDefaults();
    configured.state.restorePreferenceSelections();
    expect(configured.state.placementPreferenceReady).toBe(false);
    expect(configured.browser.remoteProject).toBeNull();

    projectsReady = true;
    configured.state.restorePreferenceSelections();
    expect(configured.browser.remoteProject).toEqual(repository);
    expect(configured.state).toMatchObject({ baseRef: "", cloudProfileId: "aws" });
    expect(configured.state.remoteRepository).toEqual({
      url: "https://ghe.example.test/acme/private-repo.git",
    });
    expect(
      buildSelectedSessionCreateParams(configured.state, {
        message: "Inspect the issue",
        visibility: "normal",
      }),
    ).toMatchObject({
      message: "",
      repository: { url: "https://ghe.example.test/acme/private-repo.git" },
    });
    expect(configured.state.placementPreferenceReady).toBe(true);

    configured.persistPreference.mockClear();
    configured.state.clearProjectSelection();
    expect(configured.persistPreference).toHaveBeenCalledWith(
      "main",
      "/workspace",
      expect.objectContaining({ defaultRepositoryOptOut: true, remoteProject: null }),
    );
  });

  it("does not clone a configured worker repository onto the Gateway", () => {
    const configured = createRepositoryFixture();
    configured.readPreference.mockReturnValue({
      folder: "/workspace",
      remoteProject: branchedRepository,
    });
    vi.spyOn(configured.browser, "projectsReady", "get").mockReturnValue(true);
    vi.spyOn(configured.browser, "defaultRemoteProject", "get").mockReturnValue(branchedRepository);
    vi.spyOn(configured.browser, "defaultRemoteProjectProfileId", "get").mockReturnValue(
      "missing-worker-profile",
    );

    configured.state.adoptAgentDefaults();
    configured.state.restorePreferenceSelections();

    expect(configured.browser.remoteProject).toBeNull();
    expect(configured.state).toMatchObject({ remoteRepository: undefined, cloudProfileId: "" });
  });

  it("moves a saved configured repository from the Gateway onto its worker profile", () => {
    const configured = createRepositoryFixture();
    configured.readPreference.mockReturnValue({
      folder: "/workspace",
      remoteProject: branchedRepository,
      baseRef: "topic/saved",
      where: { kind: "local" },
    });
    const publishCatalog = delayedCatalog(configured, branchedRepository);

    configured.state.adoptAgentDefaults();
    configured.state.restorePreferenceSelections();
    expect(configured.browser.remoteProject).toBeNull();
    expect(configured.state.placementPreferenceReady).toBe(false);

    publishCatalog();
    configured.state.restorePreferenceSelections();

    expect(configured.browser.remoteProject?.cloneUrl).toBe(
      "https://ghe.example.test/acme/private-repo.git",
    );
    expect(configured.state.cloudProfileId).toBe("aws");
    expect(configured.state.remoteRepository).toEqual({
      url: "https://ghe.example.test/acme/private-repo.git",
      ref: "topic/saved",
    });
  });
});
