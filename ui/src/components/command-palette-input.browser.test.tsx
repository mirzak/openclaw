import { createSignal } from "solid-js";
import type { ComponentProps } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../styles.css";
import { CommandPaletteInput } from "./command-palette-input.tsx";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

describe.skipIf(!hasBrowserLayout)("command palette input layout", () => {
  type InputProps = ComponentProps<typeof CommandPaletteInput>;
  let cleanup = () => {};
  const propsFor = (value: string, extra: Partial<InputProps> = {}): InputProps => ({
    value,
    placeholder: "Search or start a task…",
    onInputRef: () => undefined,
    onValueChange: () => undefined,
    ...extra,
  });
  const edit = (input: HTMLTextAreaElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const expectFades = (entry: Element, top: boolean, bottom: boolean) =>
    expect(["top", "bottom"].map((edge) => entry.hasAttribute("data-scroll-fade-" + edge))).toEqual(
      [top, bottom],
    );
  function mountInput(initial: InputProps, css = "width: 740px; max-width: 100%;") {
    const host = document.body.appendChild(document.createElement("div"));
    host.style.cssText = css;
    const [current, setCurrent] = createSignal(initial);
    const mounted = mountSolid(() => <CommandPaletteInput {...current()} />, { container: host });
    cleanup = () => {
      mounted.unmount();
      host.remove();
    };
    flush();
    return {
      host,
      input: host.querySelector("textarea")!,
      entry: host.querySelector<HTMLElement>(".cmd-palette__entry")!,
      renderInput: (next: InputProps) => {
        setCurrent(() => next);
        flush();
      },
    };
  }
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("preserves the prompt without remeasuring result navigation and measures again on reconnect", async () => {
    const props = propsFor("Keep this prompt and its caret while changing preferences.", {
      actions: <button type="button">Settings</button>,
    });
    // A fixed width/font makes reconnection cross a wrapping boundary.
    const { host, input, renderInput } = mountInput(props, "width: 740px; font-family: monospace;");
    await document.fonts.ready;
    // Initial layout installs ResizeObserver; its first delivery schedules
    // the next frame. Observe result navigation after that commit completes.
    await nextFrame();
    await nextFrame();
    await nextFrame();
    const originalHeight = input.clientHeight;
    expect(host.clientWidth).toBe(740);
    expect(originalHeight).toBe(24);
    const measureContent = vi.spyOn(input, "scrollHeight", "get");
    const settings = host.querySelector("button")!;
    input.focus();
    input.setSelectionRange(5, 11, "backward");
    settings.focus();
    renderInput({ ...props, activeDescendant: "next-result" });
    await nextFrame();
    expect(document.activeElement).toBe(settings);
    expect(input).toMatchObject({
      value: props.value,
      selectionStart: 5,
      selectionEnd: 11,
      selectionDirection: "backward",
    });
    expect(measureContent).not.toHaveBeenCalled();
    expect(input.clientHeight).toBe(originalHeight);

    host.remove();
    host.style.width = "320px";
    document.body.append(host);
    await vi.waitFor(() => expect(input.clientHeight).toBeGreaterThan(originalHeight));
    expect(measureContent).toHaveBeenCalled();
    expect(input.value).toBe(props.value);
  });

  it("keeps a scrolled prompt in place through rerenders and resizing until the user edits", async () => {
    const props = propsFor(
      Array.from({ length: 12 }, (_, index) => "Prompt line " + (index + 1)).join("\n"),
      {
        onValueChange: (value) => {
          props.value = value;
        },
      },
    );
    const { host, input, entry, renderInput } = mountInput(props);
    await vi.waitFor(() => expect(input.style.overflowY).toBe("auto"));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.scrollTop = 22;
    input.dispatchEvent(new Event("scroll"));
    const previousScroll = input.scrollTop;

    renderInput({ ...props, activeDescendant: "next-result" });
    await nextFrame();
    expect(input.scrollTop).toBe(previousScroll);
    expectFades(entry, true, true);

    host.style.width = "500px";
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        requestAnimationFrame(() => resolve());
      });
      observer.observe(entry);
    });
    expect(input.scrollTop).toBe(previousScroll);
    expect(input.selectionEnd).toBe(props.value.length);

    input.value += "\nContinue writing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    renderInput(props);
    await nextFrame();
    expect(input.scrollTop).toBe(input.scrollHeight - input.clientHeight);
    expect(entry.hasAttribute("data-scroll-fade-bottom")).toBe(false);

    input.setSelectionRange(0, 0);
    input.scrollTop = 0;
    input.setRangeText("Edit the beginning: ", 0, 0, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    renderInput(props);
    await nextFrame();
    expect(input.scrollTop).toBe(0);
  });

  it("grows down through three lines, keeps actions fixed and fades clear of the far-right scrollbar", async () => {
    const { host, input, entry } = mountInput(
      propsFor("One line", {
        actions: (
          <button type="button" class="cmd-palette__create">
            New session<kbd>Ctrl+Enter</kbd>
          </button>
        ),
      }),
    );
    const actions = host.querySelector<HTMLElement>(".cmd-palette__input-actions")!;
    const textScroll = host.querySelector<HTMLElement>(".cmd-palette__input-scroll")!;
    await nextFrame();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const top = input.getBoundingClientRect().top;
    const actionTop = actions.getBoundingClientRect().top;
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
    expect(input.clientHeight).toBe(24);

    edit(input, "One line\nTwo lines");
    expect(input.clientHeight).toBe(lineHeight * 2);
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    edit(input, "One line\nTwo lines\nThree lines\nFour lines\nFive lines");
    expect(input.clientHeight).toBe(lineHeight * 3);
    expect(input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(getComputedStyle(input).overflowY).toBe("auto");
    expect(getComputedStyle(input).scrollbarWidth).not.toBe("none");
    expect(input.getBoundingClientRect().top).toBe(top);
    expect(actions.getBoundingClientRect().top).toBe(actionTop);
    expect(input.getBoundingClientRect().right).toBeGreaterThan(
      actions.getBoundingClientRect().right + 8,
    );
    const textRight =
      input.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(input).paddingRight);
    expect(textRight).toBeLessThan(actions.getBoundingClientRect().left);
    const fadeRight =
      textScroll.getBoundingClientRect().right -
      Number.parseFloat(getComputedStyle(textScroll, "::after").right);
    expect(fadeRight).toBeLessThan(actions.getBoundingClientRect().left);
    // Autofocus keeps an edited caret visible; explicitly inspect the top edge.
    for (const scrollTop of [0, input.scrollHeight, 0]) {
      input.scrollTop = scrollTop;
      input.dispatchEvent(new Event("scroll"));
      expectFades(entry, scrollTop > 0, scrollTop === 0);
    }

    edit(input, "A short task");
    expect(input.clientHeight).toBe(24);
    expectFades(entry, false, false);
    expect(input.getBoundingClientRect().top).toBe(top);

    edit(input, "A wrapping task with enough text to grow after the available width changes.");
    host.style.width = "320px";
    await vi.waitFor(() => expect(input.clientHeight).toBe(lineHeight * 3));
    expect(actions.getBoundingClientRect().top).toBe(actionTop);

    await document.fonts.ready;
    const styleChanges: MutationRecord[] = [];
    const observer = new MutationObserver((records) => styleChanges.push(...records));
    observer.observe(input, { attributes: true, attributeFilter: ["style"] });
    try {
      // Frame callbacks run before ResizeObserver delivery; a fixed pair of
      // frames can still leave the final resize queued on a busy browser.
      // Require a quiet three-frame window after those finite updates settle.
      await vi.waitFor(async () => {
        styleChanges.length = 0;
        await nextFrame();
        await nextFrame();
        await nextFrame();
        expect(styleChanges).toEqual([]);
      });
    } finally {
      observer.disconnect();
    }
  });
});
