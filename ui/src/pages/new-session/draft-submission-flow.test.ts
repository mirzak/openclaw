import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CREATE_RETRY_WINDOW_MS } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { writeSessionPlacementRecovery } from "../../lib/sessions/session-placement-recovery.ts";
import * as toast from "../../lib/toast.ts";
import { buildChatApiAttachments } from "../chat/attachment-api.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../chat/attachment-payload-store.ts";
import { CHAT_ROUTE_READY_EVENT } from "../chat/chat-history-events.ts";
import { buildDraftSessionCreateParams } from "./create-params.ts";
import {
  createDraftFixture,
  registerTextPayload,
  stubObjectUrls,
} from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const REMOTE_PROJECT = {
  identity: "openclaw/openclaw",
  cloneUrl: "https://github.com/openclaw/openclaw.git",
};
const remoteAccess = {
  methods: ["sessions.create", "sessions.dispatch"],
  scopes: ["operator.admin", "operator.read", "operator.write"],
};
const note = {
  id: "attachment-1",
  dataUrl: "data:text/plain;base64,SGk=",
  mimeType: "text/plain",
  fileName: "note.txt",
};
const alex = [{ profileId: "profile-alex", start: 0, end: 5 }];
const outcome = (key: string, runId?: string): SessionCreateOutcome => ({
  key,
  initialRun: runId ? { status: "started", runId } : { status: "idle" },
});

function expectUnused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function expectRequest(
  request: ReturnType<typeof createDraftFixture>["request"],
  method: string,
  params: unknown,
) {
  expect(request).toHaveBeenCalledWith(method, params, { timeoutMs: null });
}

function createParamsOf(context: ApplicationContext, index = 0) {
  return vi.mocked(context.sessions.createResult).mock.calls[index]?.[0];
}

function expectCreated(context: ApplicationContext, params: Record<string, unknown>) {
  expect(context.sessions.createResult).toHaveBeenCalledWith(expect.objectContaining(params), {
    reconciliation: "background",
  });
}

function expectEmptyDraft(flow: ReturnType<typeof createDraftFixture>["flow"]) {
  expect(flow).toMatchObject({ message: "", mentions: [] });
  expect(flow.attachmentDraft.attachments).toEqual([]);
}

async function readyChatRoute() {
  queueMicrotask(() => document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT)));
}

describe("DraftSubmissionFlow", () => {
  it.each(["available", "unavailable before create", "unavailable after create"] as const)(
    "preserves the runtime through Auto placement when recovery storage is %s",
    async (storage) => {
      const { context, flow, place } = createDraftFixture(remoteAccess);
      place.applyPendingPlacement({ agentId: "main", profileId: "", autoDevice: true });
      place.modelControl.selected = "openai/gpt-5.6-sol";
      place.modelControl.agentRuntime = "codex";
      vi.spyOn(flow, "canSubmit").mockReturnValue(true);
      context.placementStartup.start = vi.fn();
      const failStorage = () => {
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new DOMException("storage disabled", "SecurityError");
        });
      };
      vi.mocked(context.sessions.createResult).mockImplementation(async (params) => {
        if (storage === "unavailable after create") {
          failStorage();
        }
        return {
          key: expectDefined(params?.key, "Auto placement create key"),
          initialRun: { status: "idle" },
        };
      });
      vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
      flow.setMessage("Keep my model and runtime");
      if (storage === "unavailable before create") {
        failStorage();
      }

      await flow.submit();

      if (storage !== "unavailable before create") {
        expect(context.sessions.createResult).toHaveBeenCalledOnce();
        expectCreated(context, {
          agentId: "main",
          message: "",
          worktree: true,
          model: "openai/gpt-5.6-sol",
          agentRuntime: "codex",
        });
        if (storage === "available") {
          expect(context.placementStartup.start).toHaveBeenCalledOnce();
        } else {
          expect(context.placementStartup.start).not.toHaveBeenCalled();
          expect(flow).toMatchObject({
            error:
              "The session was created, but startup needs attention: placement recovery storage is unavailable",
            message: "Keep my model and runtime",
          });
        }
      } else {
        expect(context.sessions.createResult).not.toHaveBeenCalled();
        expect(context.placementStartup.start).not.toHaveBeenCalled();
        expect(flow).toMatchObject({
          error: "Couldn't prepare session recovery. Your draft has been kept.",
          message: "Keep my model and runtime",
        });
      }
      flow.disconnect();
    },
  );

  it.each(["disabled uploads", "oversized attachments"])(
    "retains drafts with %s before creating a session",
    async (reason) => {
      const oversized = reason === "oversized attachments";
      const takePreparedTitle = vi.fn(() => "Review files");
      const { context, flow } = createDraftFixture({ takePreparedTitle });
      if (oversized) {
        expectDefined(context.gateway.snapshot.hello, "connected hello").policy = {
          maxPayload: 256 * 1024 + 2,
          attachments: { maxBytes: 10, maxImageBytes: 10 },
        };
      } else {
        context.config.current.uploadsEnabled = false;
      }
      const attachments = oversized
        ? ["first.txt", "second.txt"].map((fileName) => ({
            id: fileName,
            fileName,
            mimeType: "text/plain",
            dataUrl: "data:text/plain;base64,aQ==",
          }))
        : [registerTextPayload("retained-upload")];
      const mentions = oversized ? [{ profileId: "profile-alex", start: 0, end: 5 }] : [];
      const message = oversized ? "@Alex review these" : "Keep this prompt";
      flow.setMessage(message, mentions);
      if (oversized) {
        flow.attachmentDraft.replace(attachments);
      } else {
        flow.attachmentDraft.restore(attachments);
      }
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);

      await flow.submit();

      expectUnused(context.sessions.createResult, context.navigateAndWait, takePreparedTitle);
      expect(flow).toMatchObject({ message, mentions, submitting: false });
      expect(flow.attachmentDraft.attachments).toEqual(attachments);
      if (oversized) {
        expect(showToast).toHaveBeenCalledExactlyOnceWith({
          message: "Too large to send: second.txt",
        });
      } else {
        expect(flow.error).toContain("uploads are disabled");
      }
      flow.disconnect();
    },
  );

  it.each(["navigation", "reconnect"])("retires only the captured draft after %s", async (mode) => {
    const { context, flow } = createDraftFixture();
    const accepted = createDeferred<SessionCreateOutcome>();
    vi.mocked(context.sessions.createResult).mockReturnValueOnce(accepted.promise);
    const clear = vi.spyOn(flow.draftPersistence, "clearSubmittedDraft");
    flow.draftPersistence.setOwner("ws://gateway.example", "principal-a");
    flow.draftPersistence.selectRoute("original-route");
    flow.setMessage("  @Alex submitted prompt  ", [{ profileId: "alex", start: 2, end: 7 }]);
    stubObjectUrls("blob:submitted-file");
    const attachment = registerTextPayload("submitted-file");
    flow.attachmentDraft.replace([attachment]);
    const pending = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    flow.invalidate("gateway-changed");
    if (mode === "navigation") {
      flow.disconnect();
      flow.resetDraft();
      flow.draftPersistence.selectRoute("replacement-route");
      flow.setMessage("a newer prompt");
    }
    accepted.resolve(outcome("agent:main:created", "created-run"));
    await pending;
    expect(flow).toMatchObject({
      message: mode === "navigation" ? "a newer prompt" : "",
      submitting: false,
      pendingMessage: null,
    });
    expect(clear).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope: expect.objectContaining({ scopeKey: "original-route" }),
        writeIds: expect.any(Set),
      }),
      expect.any(Function),
    );
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    flow.disconnect();
  });

  it.each(["navigation", "reconnect"] as const)(
    "consumes an accepted draft before asynchronous cleanup and %s",
    async (next) => {
      const { context, flow } = createDraftFixture();
      const sessionKey = "agent:main:dashboard:accepted-draft";
      vi.mocked(context.sessions.createResult).mockResolvedValue(
        outcome(sessionKey, "accepted-draft-run"),
      );
      vi.mocked(context.navigateAndWait).mockImplementation(async () => {
        throw new Error("Chat route failed to load");
      });
      const cleanupFinished = createDeferred<void>();
      const cleanup = vi
        .spyOn(flow.draftPersistence, "clearSubmittedDraft")
        .mockImplementation((_submitted, consume) => {
          consume?.();
          return cleanupFinished.promise;
        });
      flow.setMessage("@Alex keep the accepted prompt", alex);
      stubObjectUrls("blob:accepted-note");
      flow.attachmentDraft.replace([registerTextPayload("accepted-note")]);

      const submission = flow.submit();
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      const consumed = {
        message: flow.message,
        mentions: flow.mentions,
        attachments: flow.attachmentDraft.attachments,
      };
      const navigationsBeforeCleanup = vi.mocked(context.navigateAndWait).mock.calls.length;
      if (next === "reconnect") {
        flow.invalidate("gateway-changed");
      }
      cleanupFinished.resolve();
      await submission;

      expect(consumed).toEqual({ message: "", mentions: [], attachments: [] });
      expectEmptyDraft(flow);
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      expect(navigationsBeforeCleanup).toBe(0);
      expect(context.navigateAndWait).toHaveBeenCalledTimes(next === "navigation" ? 1 : 0);
      const retained = context.chatSubmissions.readInitial(
        sessionKey,
        context.gateway.snapshot.client,
      );
      expect(retained?.message?.content).toContainEqual({
        type: "text",
        text: "@Alex keep the accepted prompt",
      });
      expect(retained?.message?.["__openclaw"]).toMatchObject({
        humanMentions: alex,
      });
      if (next === "reconnect") {
        cleanup.mockRestore();
        flow.resumeInterruptedSubmission();
        expect(flow.submissionOutcomeUnknown).toBeNull();
        flow.setMessage("a new prompt after reconnect");
        expect(flow.canSubmit()).toBe(true);
        vi.mocked(context.sessions.createResult).mockResolvedValue(
          outcome("agent:main:dashboard:next-draft", "next-draft-run"),
        );
        vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
        await flow.submit();
        expect(
          vi.mocked(context.sessions.createResult).mock.calls.map(([params]) => params?.message),
        ).toEqual(["@Alex keep the accepted prompt", "a new prompt after reconnect"]);
        expect(flow.message).toBe("");
      }
    },
  );
  it("starts a cloud repository with its selected ref without cloning on the Gateway", async () => {
    const { context, flow, gateway, place, request } = createDraftFixture(remoteAccess);
    vi.spyOn(gateway, "cloudProfiles", "get").mockReturnValue([
      { id: "cloud", providerId: "crabbox", executionModes: ["worker-turn", "remote-exec"] },
    ]);
    vi.spyOn(gateway, "cloudProfilesReady", "get").mockReturnValue(true);
    vi.spyOn(gateway, "cloudProfilesPending", "get").mockReturnValue(false);
    const start = vi.fn();
    context.placementStartup.start = start;
    vi.mocked(context.sessions.createResult).mockImplementation(async (params) => ({
      key: expectDefined(params?.key, "remote session create key"),
      initialRun: { status: "idle" },
    }));
    vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
    place.selectRemoteProject({ ...REMOTE_PROJECT, projectId: "old-local-clone" });
    place.setBaseRef("release/next");
    place.selectCloudProfile("cloud");
    flow.setMessage("Run only on the cloud worker");

    expect(flow.submitDisabledReason()).toBeUndefined();
    await flow.submit();

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    const created = expectDefined(createParamsOf(context), "remote session create request");
    expect(created).toMatchObject({
      agentId: "main",
      message: "",
      repository: { url: "https://github.com/openclaw/openclaw.git", ref: "release/next" },
    });
    for (const field of [
      "projectId",
      "projectGitUrl",
      "cwd",
      "worktree",
      "worktreeBaseRef",
      "worktreeName",
    ]) {
      expect(created).not.toHaveProperty(field);
    }
    expect(request.mock.calls.some(([method]) => method === "projects.add")).toBe(false);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0].recovery).toMatchObject({
      sessionKey: created.key,
      message: "Run only on the cloud worker",
      phase: "dispatching",
      target: { kind: "profile", profileId: "cloud" },
    });
  });
  it("keeps a direct background completion watch through a Gateway reconnect", async () => {
    vi.useFakeTimers();
    const { context, flow, request } = createDraftFixture();
    request.mockImplementation(async (method) => {
      if (method !== "agent.wait") {
        return {};
      }
      if (
        request.mock.calls.filter(([calledMethod]) => calledMethod === "agent.wait").length === 1
      ) {
        context.gateway.snapshot.phase = "reconnecting";
        throw new Error("gateway closed");
      }
      return { status: "ok", endedAt: 1 };
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue(
      outcome("agent:main:dashboard:background", "run-background"),
    );
    flow.setMessage("  @Alex start this in the background  ", [
      { profileId: "profile-alex", start: 2, end: 7 },
    ]);
    stubObjectUrls("blob:background-note");
    const attachment = registerTextPayload("background-note");
    flow.attachmentDraft.replace([attachment]);

    await flow.submit(undefined, true);
    await Promise.resolve();
    context.gateway.snapshot.phase = "connected";
    await vi.advanceTimersByTimeAsync(1_000);

    expectCreated(context, {
      agentId: "main",
      message: "@Alex start this in the background",
      mentions: alex,
    });
    expect(context.navigateAndWait).not.toHaveBeenCalled();
    expectRequest(request, "agent.wait", { runId: "run-background", timeoutMs: 30_000 });
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    const retained = context.chatSubmissions.readInitial(
      "agent:main:dashboard:background",
      context.gateway.snapshot.client,
    );
    expect(retained?.message?.["__openclaw"]).toMatchObject({ humanMentions: alex });
    expect(retained?.message?.content).toContainEqual({
      type: "attachment",
      attachment: {
        url: `data:text/plain;base64,${btoa("background-note")}`,
        kind: "document",
        label: "background-note.txt",
        mimeType: "text/plain",
      },
    });
    expect(flow).toMatchObject({ message: "", mentions: [], submitting: false });
  });

  it.each([false, true])(
    "replays a frozen create with background=%s without inheriting mutable draft state",
    async (background) => {
      const takePreparedTitle = vi.fn(() => "Original prepared title");
      const { context, flow, place } = createDraftFixture({
        takePreparedTitle,
        ...remoteAccess,
      });
      const original = createDeferred<SessionCreateOutcome>();
      const result = outcome("agent:main:direct-resumed");
      vi.mocked(context.sessions.createResult)
        .mockReturnValueOnce(original.promise)
        .mockResolvedValueOnce(result);
      vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
      const originalMentions = [{ profileId: "profile-original", start: 0, end: 5 }];
      flow.setMessage("@Alex keep the original direct request", originalMentions);

      const initialSubmission = flow.submit(undefined, background);
      await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
      const originalParams = createParamsOf(context);
      expect(originalParams).toMatchObject({
        displayName: "Original prepared title",
        mentions: originalMentions,
      });
      expect(flow.pendingMessage?.["__openclaw"].humanMentions).toEqual(originalMentions);
      flow.invalidate("gateway-changed");
      takePreparedTitle.mockReturnValue("Replacement prepared title");
      flow.setMessage("@Alex a different draft", [
        { profileId: "profile-replacement", start: 0, end: 5 },
      ]);
      expect(flow.pendingMessage?.["__openclaw"].humanMentions).toEqual(originalMentions);
      place.applyPendingPlacement({ agentId: "main", profileId: "new-cloud-discovery" });
      expect(flow.canSubmit()).toBe(false);
      expect(flow.submitting).toBe(true);

      flow.resumeInterruptedSubmission();
      expect(flow.pendingMessage?.["__openclaw"].humanMentions).toEqual(originalMentions);
      await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledTimes(2));
      expect(createParamsOf(context, 1)).toEqual(originalParams);
      expect(flow.pendingPlacement.sessionKey).toBe("");
      original.resolve(result);
      await initialSubmission;
      await vi.waitFor(() => expect(flow.submitting).toBe(false));
      if (background) {
        expectUnused(context.navigateAndWait, context.gateway.setSessionKey);
      }
    },
  );

  it.each(["lost authority", "expired retry"])(
    "unlocks an interrupted create after %s",
    async (reason) => {
      const expired = reason === "expired retry";
      const clock = expired ? vi.spyOn(Date, "now").mockReturnValue(1_000) : undefined;
      const { context, flow } = createDraftFixture();
      const original = createDeferred<SessionCreateOutcome>();
      vi.mocked(context.sessions.createResult).mockReturnValueOnce(original.promise);
      flow.setMessage(
        expired ? "the original outcome is unknown" : "do not replay without authority",
      );
      const initialSubmission = flow.submit();
      await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
      flow.invalidate("gateway-changed");
      if (expired) {
        clock?.mockReturnValue(1_000 + SESSION_CREATE_RETRY_WINDOW_MS);
      } else if (context.gateway.snapshot.hello?.features) {
        context.gateway.snapshot.hello.features.methods = [];
      }

      flow.resumeInterruptedSubmission();

      if (expired) {
        expect(flow.submissionOutcomeUnknown).toBe("gateway-changed");
        expect(flow.canSubmit()).toBe(false);
      } else {
        expect(flow.error).toBeTruthy();
      }
      expect(flow.submitting).toBe(false);
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      original.resolve(outcome("agent:main:old"));
      await initialSubmission;
      clock?.mockRestore();
    },
  );

  it("makes attachment restore release only displaced payload ids", () => {
    const revokeObjectURL = stubObjectUrls("blob:shared", "blob:displaced", "blob:incoming");
    const { flow, changed } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const shared = registerTextPayload("shared");
    const displaced = registerTextPayload("displaced");
    const incoming = registerTextPayload("incoming");
    expect([shared, displaced, incoming].map(getChatAttachmentPreviewUrl)).toEqual([
      "blob:shared",
      "blob:displaced",
      "blob:incoming",
    ]);
    flow.attachmentDraft.replace([shared, displaced]);
    noteUserMutation.mockClear();
    changed.mockClear();
    revokeObjectURL.mockClear();

    flow.attachmentDraft.restore([shared, incoming]);

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:displaced");
    expect(getChatAttachmentDataUrl(shared)).not.toBeNull();
    expect(getChatAttachmentDataUrl(incoming)).not.toBeNull();
    expect(getChatAttachmentDataUrl(displaced)).toBeNull();
    expect(noteUserMutation).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    flow.attachmentDraft.reset();
  });

  it("releases the displaced payload and renders placement recovery once without a user mutation", () => {
    const revokeObjectURL = stubObjectUrls("blob:current-draft");
    const { flow, changed } = createDraftFixture();
    const noteUserMutation = vi.spyOn(flow.draftPersistence, "noteUserMutation");
    const current = registerTextPayload("current");
    expect(getChatAttachmentPreviewUrl(current)).toBe("blob:current-draft");
    flow.attachmentDraft.replace([current]);
    noteUserMutation.mockClear();
    changed.mockClear();
    revokeObjectURL.mockClear();
    const recoveredAttachments = [
      {
        type: "file" as const,
        mimeType: "text/plain",
        fileName: "recovered.txt",
        content: "cmVjb3ZlcmVk",
      },
    ];
    expect(
      writeSessionPlacementRecovery({
        sessionKey: "agent:main:dashboard:recovery",
        messageId: "message-recovery",
        message: "@Alex recovered cloud prompt",
        mentions: alex,
        attachments: recoveredAttachments,
        target: { kind: "profile", profileId: "aws" },
        agentId: "main",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "creating",
        createParams: {
          key: "agent:main:dashboard:recovery",
          agentId: "main",
          message: "",
          worktree: true,
        },
      }),
    ).toBe(true);

    flow.restorePendingPlacementRecovery("ws://gateway.example", "principal-a");

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:current-draft");
    expect(getChatAttachmentDataUrl(current)).toBeNull();
    expect(noteUserMutation).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(flow).toMatchObject({ message: "@Alex recovered cloud prompt", mentions: alex });
    expect(buildChatApiAttachments(flow.attachmentDraft.attachments)).toEqual(recoveredAttachments);
    flow.attachmentDraft.reset();
  });

  it.each([
    { methods: ["sessions.create"], allowed: false, worktree: false },
    { methods: ["projects.add"], allowed: false, worktree: false },
    { methods: ["projects.add", "sessions.create"], allowed: true, worktree: false },
    { methods: ["sessions.create"], allowed: true, worktree: true },
  ])("checks remote-project access with worktree=$worktree", ({ methods, allowed, worktree }) => {
    const { flow, place } = createDraftFixture({ methods });
    place.selectRemoteProject({ ...REMOTE_PROJECT });
    if (worktree) {
      place.selectWorktree(true);
      flow.setMessage("start in a worktree");
    }

    expect(flow.submissionAccess().allowed).toBe(allowed);
  });

  it.each([
    { scenario: "an empty session", message: "", worktree: false },
    { scenario: "an empty worktree session", message: "", worktree: true },
    { scenario: "a failed clone", message: "", worktree: false, error: "clone failed" },
  ])("materializes a remote project before $scenario", async ({ message, worktree, error }) => {
    const materializedProject = createDeferred<{ id: string }>();
    const { context, flow, place, request } = createDraftFixture({
      methods: ["projects.add", "sessions.create"],
      request: async (method) => (method === "projects.add" ? materializedProject.promise : {}),
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue(
      outcome("agent:main:empty-remote-project"),
    );
    vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
    place.selectRemoteProject({ ...REMOTE_PROJECT });
    if (worktree) {
      place.selectWorktree(true);
    }
    flow.setMessage(message);
    // Empty-draft button gating is independent from the remote-project submission contract.
    vi.spyOn(flow, "canSubmit").mockReturnValue(true);

    const submitted = flow.submit();
    await vi.waitFor(() =>
      expectRequest(request, "projects.add", { gitUrl: REMOTE_PROJECT.cloneUrl }),
    );
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    if (error) {
      materializedProject.reject(new Error(error));
    } else {
      materializedProject.resolve({ id: "openclaw" });
    }
    await submitted;

    if (error) {
      expect(flow.error).toBe(error);
      expect(place.browser.remoteProject?.identity).toBe("openclaw/openclaw");
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      return;
    }
    const createParams = createParamsOf(context);
    expect(createParams).toMatchObject({ agentId: "main", message, projectId: "openclaw" });
    expect(createParams?.worktree).toBe(worktree || undefined);
    expect(createParams).not.toHaveProperty("projectGitUrl");
    expect(createParams).not.toHaveProperty("cwd");
    expect(request.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(context.sessions.createResult).mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    { scenario: "an initial prompt and attachments", message: "keep this prompt", worktree: false },
    { scenario: "attachments without an initial prompt", message: "", worktree: false },
    { scenario: "a prompted worktree", message: "keep this prompt", worktree: true },
    { scenario: "an attachment-only worktree", message: "", worktree: true },
  ])("admits a remote project once with $scenario", async ({ message, worktree }) => {
    const { context, flow, place, request } = createDraftFixture();
    const admission = createDeferred<SessionCreateOutcome>();
    vi.mocked(context.sessions.createResult).mockReturnValueOnce(admission.promise);
    vi.mocked(context.navigateAndWait).mockImplementation(readyChatRoute);
    place.selectRemoteProject({ ...REMOTE_PROJECT });
    if (worktree) {
      place.selectWorktree(true);
    }
    flow.setMessage(message);
    flow.attachmentDraft.replace([{ ...note }]);

    const submitted = flow.submit();
    const duplicate = flow.submit();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    expectCreated(context, {
      agentId: "main",
      message,
      projectGitUrl: REMOTE_PROJECT.cloneUrl,
      attachments: [expect.objectContaining({ fileName: "note.txt", mimeType: "text/plain" })],
    });
    expect(request).not.toHaveBeenCalledWith("projects.add", expect.anything(), expect.anything());
    expect(createParamsOf(context)?.worktree).toBe(worktree || undefined);

    admission.resolve(outcome("agent:main:remote-project"));
    await Promise.all([submitted, duplicate]);

    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(context.navigateAndWait).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "promoted key", "failed navigation", "background"])(
    "retains committed placement startup through %s",
    async (scenario) => {
      const background = scenario === "background";
      const navigationError =
        scenario === "failed navigation" ? "Placement chat route failed to load" : null;
      const canonicalSessionKey =
        scenario === "promoted key"
          ? "agent:cloud:dashboard:server-key"
          : background
            ? "agent:cloud:dashboard:background-placement"
            : null;
      const createResult = vi.fn<ApplicationContext["sessions"]["createResult"]>(
        async (params) => ({
          key: canonicalSessionKey ?? String(params?.key),
          initialRun: { status: "idle" as const },
        }),
      );
      // Application-owned startup intentionally outlives this route.
      const startup = createDeferred<void>();
      const start = vi.fn<NonNullable<ApplicationContext["placementStartup"]["start"]>>(
        () => startup.promise,
      );
      const navigation = createDeferred<void>();
      let failedNavigation = false;
      const navigateAndWait = vi.fn<ApplicationContext["navigateAndWait"]>(() => {
        if (navigationError && !failedNavigation) {
          failedNavigation = true;
          return Promise.reject(new Error(navigationError));
        }
        return navigation.promise;
      });
      let startupPending = background;
      let backgroundWaitAttempts = 0;
      const { context, flow, place, request } = createDraftFixture({
        agents: [{ id: "cloud", workspace: "/workspace", workspaceGit: true }],
        ...remoteAccess,
        request: async (method) => {
          if (method === "worktrees.branches") {
            return { repositoryStatus: "git", branches: [] };
          }
          if (method === "agent.wait") {
            backgroundWaitAttempts += 1;
            if (background && backgroundWaitAttempts === 1) {
              context.gateway.snapshot.phase = "reconnecting";
              throw new Error("gateway closed");
            }
            if (background && backgroundWaitAttempts === 2) {
              // Placement custody retires when sending is accepted, before the run finishes.
              startupPending = false;
              return { status: "timeout" };
            }
            if (background && backgroundWaitAttempts === 3) {
              return { status: "pending" };
            }
            return { status: "ok", endedAt: 1 };
          }
          return {};
        },
      });
      const setSessionKey = vi.mocked(context.gateway.setSessionKey);
      const selectAgent = vi.mocked(context.agentSelection.set);
      context.agentSelection.state.selectedId = "cloud";
      context.sessions.createResult = createResult;
      vi.mocked(context.navigateAndWait).mockImplementation(navigateAndWait);
      Object.assign(context.placementStartup, {
        start,
        hasPendingTurn: vi.fn(() => startupPending),
      });
      await context.router.navigate("chat", context);
      flow.setMessage("@Alex keep this cloud task", alex);
      const apiAttachments = [{ fileName: "note.txt", content: "SGk=" }];
      const createParams = buildDraftSessionCreateParams({
        agentId: "cloud",
        message: "",
        worktree: true,
        cwd: "/workspace",
        workspace: "/workspace",
      });
      flow.pendingPlacement.stageCreate({
        agentId: "cloud",
        target: { kind: "profile", profileId: "aws" },
        message: "@Alex keep this cloud task",
        mentions: alex,
        attachments: apiAttachments,
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        createParams,
      });
      flow.pendingPlacement.retryAllowed = true;
      place.applyPendingPlacement({ agentId: "cloud", profileId: "aws", cwd: "/workspace" });
      flow.attachmentDraft.replace([{ ...note }]);

      if (background) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const submission = flow.submit(undefined, background);
      if (background) {
        await submission;
        expect(start).toHaveBeenCalledOnce();
        expect(navigateAndWait).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(navigateAndWait).toHaveBeenCalledOnce());
        expect(setSessionKey.mock.invocationCallOrder[0]).toBeLessThan(
          navigateAndWait.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
      }
      if (!navigationError && !background) {
        expect(flow.submitting).toBe(true);
        navigation.resolve();
        document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
      }
      await submission;
      if (background) {
        context.gateway.snapshot.phase = "connected";
        await vi.advanceTimersByTimeAsync(3_000);
      }

      expect(start).toHaveBeenCalledOnce();
      const recovery = start.mock.calls[0]?.[0].recovery;
      expect(recovery).toMatchObject({
        message: "@Alex keep this cloud task",
        mentions: alex,
        attachments: apiAttachments,
        phase: "dispatching",
      });
      expect(flow.pendingPlacement.capture()).toBeNull();
      expect(flow.completedSubmission?.key).toBe(recovery?.sessionKey);
      expect(flow.pendingMessage?.content).toContainEqual({
        type: "text",
        text: "@Alex keep this cloud task",
      });
      expectEmptyDraft(flow);
      expect(flow).toMatchObject({ error: navigationError, submitting: false });
      expect(createResult).toHaveBeenCalledOnce();
      if (background) {
        expectUnused(setSessionKey, selectAgent);
        expect(flow.message).toBe("");
        expectRequest(request, "agent.wait", { runId: recovery?.messageId, timeoutMs: 30_000 });
        expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(4);
      } else {
        expect(setSessionKey).toHaveBeenCalledWith(recovery?.sessionKey);
        expect(selectAgent).toHaveBeenCalledWith("cloud");
      }

      if (navigationError) {
        expect(flow.canSubmit()).toBe(true);
        const retry = flow.submit();
        await vi.waitFor(() => expect(navigateAndWait).toHaveBeenCalledTimes(2));
        expect(flow.canSubmit()).toBe(false);
        navigation.resolve();
        document.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT));
        await retry;

        expect(createResult).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(flow.error).toBeNull();
      }
    },
  );
});
