/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  expectPalettePromptMode,
  findPaletteOption,
  mountPalette,
  settlePalette,
  paletteInput,
  setInputValue,
  pressKey,
} from "./command-palette.test-support.ts";
import "./command-palette.tsx";

describe("CommandPalette pending searches", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "debounces input until the final key or IME commit: %s",
    async (composing) => {
      const request = vi.fn(async (_method: string) => ({ sessions: [], results: [], models: [] }));
      const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
      const list = vi.fn(async () => null);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, composing ? "plugins" : "");
      const original = palette.querySelector(".cmd-palette__search")!.textContent;
      const input = paletteInput(palette);
      if (composing) {
        input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      }
      for (const query of composing
        ? ["plugin"]
        : ["p", "pl", "plu", "plug", "plugi", "plugin", "plugins"]) {
        setInputValue(input, query);
        await palette.updateComplete;
        expect(input.value).toBe(query);
        expect(palette.querySelector(".cmd-palette__search")!.textContent).toBe(original);
        await vi.advanceTimersByTimeAsync(100);
        expect(list).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      }
      if (composing) {
        await vi.advanceTimersByTimeAsync(200);
        expect(list).not.toHaveBeenCalled();
        input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(100);
      }
      await vi.advanceTimersByTimeAsync(99);
      expect(list).not.toHaveBeenCalled();
      await settlePalette(palette, 1);
      expect(list).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ search: composing ? "plugin" : "plugins" }),
      );
      expect(request.mock.calls.filter(([method]) => method === "sessions.search")).toHaveLength(1);
      expect(request).toHaveBeenCalledWith(
        "sessions.search",
        expect.objectContaining({ query: composing ? "plugin" : "plugins" }),
      );
      expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
    },
  );

  it("cancels a pending search when the query becomes a multiline prompt", async () => {
    const request = vi.fn(async (method: string) =>
      method === "sessions.search" ? { results: [], sessions: [] } : { models: [] },
    );
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const list = vi.fn(async () => createSessionResult("agent:main:plugins", "Plugins discussion"));
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "plugins");
    expect(palette.textContent).not.toContain("Searching sessions");
    await vi.advanceTimersByTimeAsync(199);

    const input = paletteInput(palette);
    const prompt = "plugins\nReview the available integrations and explain how to configure them.";
    setInputValue(input, prompt);
    await palette.updateComplete;
    await settlePalette(palette, 100);

    expect(list).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expectPalettePromptMode(palette);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(palette.onNavigate).not.toHaveBeenCalled();
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    expect(input.value).toBe(prompt);

    setInputValue(input, "");
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Plugins", true)).toBeDefined();
    expect(palette.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(list).not.toHaveBeenCalled();

    setInputValue(input, "plugins");
    await settlePalette(palette);
    expect(list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ search: "plugins" }));
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ query: "plugins" }),
    );
    expect(request).toHaveBeenCalledWith("models.list", expect.anything());
    expect(palette.querySelectorAll(".cmd-palette__filter")).toHaveLength(3);
    findPaletteOption(palette, "Plugins discussion")!.click();
    expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:plugins");
  });

  it("does not restore late session, transcript, or catalog results after entering a prompt", async () => {
    const metadata = createDeferred<SessionsListResult | null>();
    const transcript = createDeferred<SessionsSearchResult>();
    const catalog = createDeferred<{
      models: { id: string; provider: string; name: string }[];
      refreshFailed: boolean;
    }>();
    const prompt = "zzfixtureunique\nExplain the findings in a new session.";
    const request = vi.fn((method: string) =>
      method === "sessions.search" ? transcript.promise : catalog.promise,
    );
    const { gateway } = createGateway(true, { methods: ["sessions.search"], request });
    const list = vi.fn(() => metadata.promise);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzfixtureunique");
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);

    const input = paletteInput(palette);
    setInputValue(input, prompt);
    await palette.updateComplete;
    const stale = createSessionResult("agent:main:stale", "zzfixtureunique stale session");
    metadata.resolve(stale);
    transcript.resolve({
      sessions: stale.sessions,
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message",
          role: "assistant",
          timestamp: 1,
          score: 1,
          snippet: "zzfixtureunique stale transcript",
        },
      ],
      indexing: true,
      archivedTranscriptsExcluded: 2,
    });
    catalog.resolve({
      models: [{ id: "stale", provider: "fixture", name: prompt }],
      refreshFailed: true,
    });
    await settlePalette(palette, 100);

    expect(list).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
    expectPalettePromptMode(palette);
    expect(input.value).toBe(prompt);

    setInputValue(input, "zzfixtureunique");
    await palette.updateComplete;
    expect(palette.querySelector('[inert][aria-hidden="true"]')).toBeNull();
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(palette.querySelector(".cmd-palette__source-error")).toBeNull();
    expect(list).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["match", "empty", "failure", "static command"])(
    "announces session search through debounce and deferred settlement: %s",
    async (outcome) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const { gateway } = createGateway(true);
      const list = vi.fn(() => deferred.promise);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, outcome === "static command" ? "plugins" : "zzfixtureunique");
      const results = palette.querySelector('[role="listbox"]')!;
      expect(results.getAttribute("aria-busy")).toBe("true");
      expect(palette.textContent).not.toContain("Searching sessions");
      expect(palette.textContent).not.toContain("No results");
      await vi.advanceTimersByTimeAsync(199);
      expect(list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledOnce();
      expect(palette.querySelector('.cmd-palette__search [role="status"]')?.textContent).toContain(
        "Searching sessions",
      );
      expect(results.getAttribute("aria-busy")).toBe("true");
      if (outcome === "static command") {
        findPaletteOption(palette, "Plugins")!.click();
        expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
        return;
      }
      expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
      if (outcome === "failure") {
        deferred.reject(new Error("Search failed"));
      } else {
        deferred.resolve(
          outcome === "match"
            ? createSessionResult("agent:main:fixture", "zzfixtureunique session")
            : { ...createSessionResult("agent:main:fixture", "Unused"), sessions: [] },
        );
      }
      await settlePalette(palette, 0);
      expect(results.getAttribute("aria-busy")).toBe("false");
      expect(palette.textContent).not.toContain("Searching sessions");
      if (outcome === "match") {
        findPaletteOption(palette, "zzfixtureunique session")!.click();
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:fixture");
      } else if (outcome === "empty") {
        expect(palette.textContent).toContain("No results found");
        const empty = palette.querySelector(".cmd-palette__no-results")!;
        expect(empty.querySelector("h2")?.textContent).toBe("No results found");
        expect(empty.textContent).toContain("to start a new session.");
        expect(empty.querySelector("button")).toBeNull();
      } else {
        expect(palette.textContent).toContain("Chat search failed");
        expect(palette.textContent).not.toContain("No results");
      }
    },
  );

  it("waits for uncached command sources without announcing a session search when unavailable", async () => {
    const catalog = createDeferred<{ models: { id: string; provider: string; name: string }[] }>();
    const request = vi.fn(() => catalog.promise);
    const { gateway } = createGateway(true, { request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    palette.onSelectSession = undefined;
    await enterQuery(palette, "zzcatalog");
    expect(palette.textContent).not.toContain("Searching commands");
    await vi.advanceTimersByTimeAsync(200);
    expect(palette.textContent).toContain("Searching commands");
    expect(palette.textContent).not.toContain("Searching sessions");
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    const input = paletteInput(palette);
    setInputValue(input, "z");
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    catalog.resolve({ models: [{ id: "fixture", provider: "fixture", name: "zzcatalog model" }] });
    await settlePalette(palette);
    expect(findPaletteOption(palette, "zzcatalog model")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    await enterQuery(palette, "zzmissing");
    await settlePalette(palette);
    expect(palette.textContent).toContain("No results");
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("waits for the transcript source after metadata settles", async () => {
    const transcript = createDeferred<SessionsSearchResult>();
    const roster = createSessionResult("agent:main:fixture", "Unrelated title");
    const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
      options?.search ? { ...roster, sessions: [] } : roster,
    );
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: (method) => (method === "sessions.search" ? transcript.promise : { models: [] }),
    });
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzfixtureunique");
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledOnce();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    transcript.resolve({
      sessions: roster.sessions,
      results: [
        {
          sessionKey: "agent:main:fixture",
          sessionId: "fixture",
          messageId: "message",
          role: "assistant",
          timestamp: 1,
          score: 1,
          snippet: "zzfixtureunique transcript match",
        },
      ],
    });
    await settlePalette(palette, 0);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(findPaletteOption(palette, "Unrelated title")?.textContent).toContain(
      "zzfixtureunique transcript match",
    );
  });

  it.each([
    { name: "partial", result: {}, notice: "Transcript search unavailable" },
    { name: "model failure", result: {}, notice: "Model search unavailable" },
    {
      name: "indexing",
      result: { indexing: true },
      notice: "Indexing older messages — search again shortly.",
    },
    { name: "archived", result: { archivedTranscriptsExcluded: 2 }, notice: "archived" },
  ])(
    "does not announce empty success for $name transcript results",
    async ({ name, result, notice }) => {
      const roster = createSessionResult("agent:main:fixture", "Unused");
      const { gateway } = createGateway(true, {
        methods: ["sessions.search"],
        request: (method) => {
          if (method !== "sessions.search") {
            if (name === "model failure") {
              throw new Error("Model source unavailable");
            }
            return { models: [] };
          }
          if (name === "partial") {
            throw new Error("Transcript source unavailable");
          }
          return { results: [], ...result };
        },
      });
      const list = vi.fn<ApplicationContext["sessions"]["list"]>(async (options) =>
        options?.search ? { ...roster, sessions: [] } : roster,
      );
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, "zzfixtureunique");
      await settlePalette(palette);
      expect(palette.textContent).toContain(notice);
      expect(palette.querySelector(".cmd-palette__no-results")).toBeNull();
      const input = paletteInput(palette);
      setInputValue(input, "zzfixtureunique\nSummarize the findings in a new session.");
      await settlePalette(palette);
      expectPalettePromptMode(palette);
      expect(list).toHaveBeenCalledOnce();
    },
  );

  it("does not let an old query settle or select rows during a newer debounce", async () => {
    const old = createDeferred<SessionsListResult | null>();
    const current = createDeferred<SessionsListResult | null>();
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext["sessions"]["list"]>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzold");
    await vi.advanceTimersByTimeAsync(200);
    const input = paletteInput(palette);
    setInputValue(input, "zznew");
    old.resolve(createSessionResult("agent:main:old", "zzold match"));
    await settlePalette(palette, 0);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
    pressKey(input, "Enter");
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: "zznew" }));
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(list).toHaveBeenCalledTimes(2);
    current.resolve(createSessionResult("agent:main:new", "zznew match"));
    await settlePalette(palette, 0);
    expect(palette.textContent).not.toContain("zzold match");
    expect(findPaletteOption(palette, "zznew match")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    pressKey(input, "Enter");
    expect(palette.onSelectSession).toHaveBeenCalledExactlyOnceWith("agent:main:new");
  });

  it.each(["close", "detach", "short-query", "disconnect"])(
    "clears pending search on %s and ignores its late completion",
    async (action) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const harness = createGateway(true);
      const { palette, provider } = await mountPalette(
        createContext(harness.gateway, () => deferred.promise),
      );
      await enterQuery(palette, "zzfixtureunique");
      await vi.advanceTimersByTimeAsync(200);
      if (action === "close") {
        palette.togglePalette();
        palette.openPalette();
      } else if (action === "detach") {
        palette.remove();
        provider.append(palette);
        palette.openPalette();
      } else if (action === "disconnect") {
        harness.setConnected(false);
      } else {
        const input = paletteInput(palette);
        setInputValue(input, "z");
      }
      await palette.updateComplete;
      if (action === "short-query") {
        expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
        await vi.advanceTimersByTimeAsync(200);
      }
      expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
      deferred.resolve(createSessionResult("agent:main:stale", "zzfixtureunique stale"));
      await settlePalette(palette, 0);
      expect(palette.textContent).not.toContain("Searching sessions");
      expect(findPaletteOption(palette, "zzfixtureunique stale")).toBeUndefined();
    },
  );
});
