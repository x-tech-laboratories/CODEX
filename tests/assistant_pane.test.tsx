// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import type { ConversationEvent } from "../src/shared/conversations/model.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { data_watch, set_page_api } from "../src/web/api.ts";
import { AssistantPane } from "../src/web/assistant/AssistantPane.tsx";
import { Mascot } from "../src/web/assistant/Mascot.tsx";
import { lasting_mood, moment_after, screen_placement } from "../src/web/assistant/mascot.ts";
import { next_run } from "../src/web/assistant/use_conversation.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

// RoboBuddy needs a 2D canvas, which jsdom lacks, so a stand-in records the moods it is given.
const moods = vi.hoisted(() => [] as string[]);
vi.mock("@x-tech-laboratories/robobuddy", () => ({
  RoboBuddy: class {
    frameRate = 30;
    begin() {}
    start() {}
    stop() {}
    setMood(mood: string) {
      moods.push(mood);
    }
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const listeners = new Set<(event: ConversationEvent) => void>();

// The page on a real store with the scripted engine, hearing the run's events as a host would pass them on.
function open_page(options: { choose_engine?: boolean } = {}): Fixture {
  const fixture = start_fixture({ ...options, on_event: (event) => listeners.forEach((listener) => listener(event)), on_announce: () => data_watch.bump() });
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({
    host: "desktop",
    calls: calls as unknown as Client<ContextMethods>,
    device: null,
    on_change: () => () => undefined,
    on_conversation: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  });
  return fixture;
}

function type_and_send(text: string) {
  const box = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  moods.length = 0;
});

afterEach(async () => {
  cleanup();
  await wait_for_runs();
  use_assistant_host(null);
  listeners.clear();
});

// ── Pane ─────────────────────────────────────────────────────────────────────

describe("the assistant's pane", () => {
  it("says no engine is set up, links to Settings, and sleeps", async () => {
    open_page({ choose_engine: false });
    render(<AssistantPane context_id={null} />);

    expect(await screen.findByText("No engine is set up")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("#/settings");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("img", { name: "CODEX, asleep" })).toBeTruthy();
  });

  it("sends on Enter, streams the reply, and shows the tool calls folded with their arguments and results", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fixture.set_script(async function* (request) {
      yield { type: "text", text: "Looking at **Kitchen**" };
      await held;
      yield { type: "tool_call", id: "t1", name: "list_contexts", arguments: {} };
      const outcome = await request.tools.call("list_contexts", {});
      yield { type: "tool_result", id: "t1", ...outcome };
      yield { type: "done", text: "Looking at **Kitchen**: it is empty." };
    });
    render(<AssistantPane context_id={kitchen} />);
    expect(await screen.findByText("Fake · fake-model")).toBeTruthy();
    expect(screen.getByText("local").getAttribute("title")).toBe("Answers on this computer or your own network.");

    const box = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "first line" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fixture.calls.get_conversation(kitchen).messages).toEqual([]);
    type_and_send("What is here?");

    expect(await screen.findByText("Kitchen", { selector: "strong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "CODEX, thinking" })).toBeTruthy();
    await act(async () => {
      release();
      await wait_for_runs();
    });

    expect(await screen.findByText(/it is empty/)).toBeTruthy();
    expect(screen.getByText("What is here?")).toBeTruthy();
    const call = screen.getByText("list_contexts").closest("details")!;
    expect(call.open).toBe(false);
    expect(within(call).getByText("done")).toBeTruthy();
    expect(within(call).getByText(/"name": "Kitchen"/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    await waitFor(() => expect(moods).toContain("happy"));
  });

  it("stops a reply, keeping what it had written", async () => {
    const fixture = open_page();
    fixture.set_script(async function* (_request, signal) {
      yield { type: "text", text: "Half an answer" };
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    render(<AssistantPane context_id={null} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Talk");

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await act(() => wait_for_runs());

    expect(await screen.findByText("Stopped.")).toBeTruthy();
    expect(screen.getByText("Half an answer")).toBeTruthy();
    expect(moods).not.toContain("sad");
  });

  it("shows a failure plainly, and the face is sad for a moment", async () => {
    const fixture = open_page();
    fixture.set_script(async function* () {
      yield { type: "error", message: "The model declined the request." };
    });
    render(<AssistantPane context_id={null} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Hi");
    await act(() => wait_for_runs());

    expect(await screen.findByText("The model declined the request.")).toBeTruthy();
    await waitFor(() => expect(moods).toContain("sad"));
  });

  it("asks before changing, and approving a proposal changes the context and says so", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "rename_context", arguments: { id: kitchen, name: "Cooking" } };
      const outcome = await request.tools.call("rename_context", { id: kitchen, name: "Cooking" });
      yield { type: "tool_result", id: "t1", ...outcome };
      yield { type: "done", text: "I proposed it." };
    });
    render(<AssistantPane context_id={kitchen} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Call it Cooking");
    await act(() => wait_for_runs());

    const card = await screen.findByRole("article", { name: "Proposed change" });
    expect(within(card).getByText("Rename the context “Kitchen” to “Cooking”.")).toBeTruthy();
    expect(screen.getByText("waits for you")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved and done: Rename the context “Kitchen” to “Cooking”.")).toBeTruthy();
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    expect(screen.getByText("approved by you")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("article", { name: "Proposed change" })).toBeNull());
  });

  it("rejects a proposal, and clears the conversation after asking in its own dialog", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.set_script(async function* (request) {
      await request.tools.call("remove_context", { id: kitchen });
      yield { type: "done", text: "Proposed." };
    });
    render(
      <>
        <AssistantPane context_id={kitchen} />
        <Dialogs />
      </>,
    );
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Delete it");
    await act(() => wait_for_runs());
    fireEvent.click(within(await screen.findByRole("article", { name: "Proposed change" })).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/^Rejected: Delete the context/)).toBeTruthy();
    expect(fixture.calls.list_contexts().map((context) => context.name)).toEqual(["Kitchen"]);

    fireEvent.click(screen.getByRole("button", { name: "Clear the conversation" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(fixture.calls.get_conversation(kitchen).messages).toEqual([]));
    expect(await screen.findByText("Ask about this context, or ask CODEX to change it.")).toBeTruthy();
  });
});

// ── Parts ────────────────────────────────────────────────────────────────────

describe("the mascot's mood", () => {
  it("sleeps without an engine or a store, thinks while a reply is written, and is happy or sad after one", () => {
    expect(lasting_mood({ has_engine: false, is_reachable: true, is_running: false })).toBe("asleep");
    expect(lasting_mood({ has_engine: true, is_reachable: false, is_running: true })).toBe("asleep");
    expect(lasting_mood({ has_engine: true, is_reachable: true, is_running: true })).toBe("thinking");
    expect(lasting_mood({ has_engine: true, is_reachable: true, is_running: false })).toBe("default");
    expect([moment_after(""), moment_after("Broken"), moment_after("Stopped.")]).toEqual(["happy", "sad", null]);
  });
});

describe("the mascot's face", () => {
  it("lays the canvas over the head's screen at its real size rather than inside the drawing", () => {
    const placement = screen_placement();
    expect(Object.fromEntries(Object.entries(placement).map(([key, value]) => [key, Number(parseFloat(value).toFixed(2))]))).toEqual({ left: 14.86, top: 37.7, width: 70.27, height: 59.02 });

    const { container } = render(<Mascot mood="default" moment={null} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.closest("svg")).toBeNull();
    expect(parseFloat(canvas.style.left)).toBeCloseTo(parseFloat(placement.left));
    expect(parseFloat(canvas.style.height)).toBeCloseTo(parseFloat(placement.height));
    expect(screen.getByRole("img", { name: "CODEX, default" })).toBeTruthy();
  });
});

describe("a reply as its events arrive", () => {
  it("starts, gathers text and tool calls, and ends", () => {
    const base = { conversation_id: "general", run_id: "r1" };
    let run = next_run(null, { ...base, type: "started", engine: "Fake", model: "m" });
    run = next_run(run, { ...base, type: "text", text: "Hel" });
    run = next_run(run, { ...base, type: "text", text: "lo" });
    const call = { id: "t1", name: "list_contexts", arguments: {}, result: "", is_error: false, outcome: "pending" as const };
    run = next_run(run, { ...base, type: "tool_call", call });
    run = next_run(run, { ...base, type: "tool_result", call: { ...call, result: "[]", outcome: "ran" } });
    expect(run).toMatchObject({ engine: "Fake", text: "Hello", tool_calls: [{ id: "t1", result: "[]", outcome: "ran" }], finished: false });
    expect(next_run(run, { ...base, type: "finished", error: "" })!.finished).toBe(true);
    // A page that missed the start still follows the reply.
    expect(next_run(null, { ...base, run_id: "r2", type: "text", text: "x" })).toMatchObject({ run_id: "r2", text: "x" });
  });
});
