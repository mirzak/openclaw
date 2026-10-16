import { describe, expect, it } from "vitest";
import { createBaseState } from "./tui-session-actions-test-support.js";
import { matchesSelectedTuiSession, readTuiSessionUserMessage } from "./tui-session-events.js";
import type { SessionMessageEvent, TuiStateAccess } from "./tui-types.js";

function makeState(overrides?: Partial<TuiStateAccess>): TuiStateAccess {
  return createBaseState({
    currentSessionId: "session-main",
    historyLoaded: true,
    ...overrides,
  });
}

function readUserMessage(
  content: unknown,
  metadata: Record<string, unknown> = {},
  envelope: Omit<SessionMessageEvent, "message"> = {},
) {
  return readTuiSessionUserMessage({
    ...envelope,
    message: { role: "user", content, __openclaw: metadata },
  });
}

describe("matchesSelectedTuiSession", () => {
  it.each([
    {
      provider: "Matrix",
      selectedSessionKey: "agent:main:matrix:channel:!MixedRoom:example.org",
      otherSessionKey: "agent:main:matrix:channel:!mixedroom:example.org",
    },
    {
      provider: "Signal",
      selectedSessionKey: "agent:main:signal:group:AbC123=",
      otherSessionKey: "agent:main:signal:group:abc123=",
    },
  ])(
    "preserves case-sensitive $provider conversation ownership",
    ({ selectedSessionKey, otherSessionKey }) => {
      const state = makeState({ currentSessionKey: selectedSessionKey });

      expect(matchesSelectedTuiSession(state, { sessionKey: selectedSessionKey })).toBe(true);
      expect(matchesSelectedTuiSession(state, { sessionKey: otherSessionKey })).toBe(false);
    },
  );

  it("accepts legacy global events only for the default agent", () => {
    expect(
      matchesSelectedTuiSession(makeState({ currentSessionKey: "global" }), {
        sessionKey: "global",
      }),
    ).toBe(true);
  });

  it("rejects empty and unrelated session events", () => {
    const state = makeState();

    expect(matchesSelectedTuiSession(state, {})).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "  " })).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "agent:main:other" })).toBe(false);
  });
});

describe("readTuiSessionUserMessage", () => {
  const importedIdentity = {
    id: "provider-local-id",
    importedFrom: "claude-cli",
    externalId: "provider-local-id",
  };
  it.each([
    {
      name: "image block",
      content: [{ type: "image", source: { type: "url", url: "/image.png" } }],
      media: undefined,
      expected: "Attached image",
      images: [{ source: "/image.png" }],
    },
    {
      name: "document block",
      content: [
        {
          type: "attachment",
          attachment: { url: "/report.pdf", kind: "document", label: "report.pdf" },
        },
      ],
      media: undefined,
      expected: "Attached file: report.pdf",
      images: undefined,
    },
    {
      name: "canonical persisted media",
      content: "",
      media: [{ path: "/media/inbound/image.png", contentType: "image/png" }],
      expected: "Attached image",
      images: [{ source: "/media/inbound/image.png" }],
    },
  ])(
    "accepts an authoritative attachment-only $name event",
    ({ content, media, expected, images }) => {
      expect(
        readUserMessage(
          content,
          {
            id: "attachment-user-1",
            idempotencyKey: "attachment-run-1:user",
            seq: 1,
            ...(media ? { media } : {}),
          },
          { sessionKey: "agent:main:main", messageId: "attachment-user-1" },
        ),
      ).toEqual({
        messageId: "attachment-user-1",
        runId: "attachment-run-1",
        sendId: "attachment-run-1",
        text: expected,
        ...(images ? { images } : {}),
      });
    },
  );

  it("prefers persisted sequence over a conflicting Gateway envelope without a message ID", () => {
    expect(readUserMessage("sequenced persisted prompt", { seq: 7 }, { messageSeq: 99 })).toEqual({
      messageId: "seq:7",
      text: "sequenced persisted prompt",
    });
  });

  it("normalizes exactly one persisted user-turn suffix", () => {
    expect(
      readUserMessage(
        "nested user suffix",
        { id: "persisted-message", idempotencyKey: "actual:user:user" },
        { clientRunId: "another-client-run" },
      ),
    ).toEqual({
      messageId: "persisted-message",
      runId: "actual:user",
      sendId: "actual:user",
      text: "nested user suffix",
    });
  });

  it("keys imported messages by their complete provider and CLI session identity", () => {
    const readImportedMessage = (cliSessionId: string) =>
      readUserMessage(
        "imported prompt",
        { ...importedIdentity, cliSessionId },
        { messageId: "native-or-other-provider-id" },
      );

    expect(readImportedMessage("cli-session-1")).toEqual({
      messageId: `external:${JSON.stringify(["claude-cli", "cli-session-1", "provider-local-id"])}`,
      text: "imported prompt",
    });
    expect(readImportedMessage("cli-session-2")?.messageId).not.toBe(
      readImportedMessage("cli-session-1")?.messageId,
    );
  });

  it("uses the persisted transcript position for an incomplete imported identity", () => {
    expect(
      readUserMessage(
        "partially imported prompt",
        { ...importedIdentity, seq: 7 },
        { messageId: "native-message", messageSeq: 99 },
      ),
    ).toEqual({ messageId: "imported-seq:7", text: "partially imported prompt" });
  });

  it("does not use envelope sequence to deduplicate incomplete imported ownership", () => {
    expect(
      readUserMessage("imported prompt", importedIdentity, {
        messageId: "native-message",
        messageSeq: 7,
      }),
    ).toBeNull();
  });

  it("uses the authoritative transcript sequence when no message id is available", () => {
    expect(
      readTuiSessionUserMessage({
        messageSeq: 7,
        message: { content: "shared prompt", idempotencyKey: "run-7:user", role: "user" },
      }),
    ).toEqual({ messageId: "seq:7", runId: "run-7", sendId: "run-7", text: "shared prompt" });
  });

  it("rejects assistant and identity-free transcript messages", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "assistant-1",
        message: { content: "reply", role: "assistant" },
      }),
    ).toBeNull();
    expect(
      readTuiSessionUserMessage({ message: { content: "unidentified", role: "user" } }),
    ).toBeNull();
  });
});
