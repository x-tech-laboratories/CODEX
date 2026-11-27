// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { ContextMenus } from "@x-tech-laboratories/x-libs/web/react/menus";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import type { ConversationEvent } from "../src/shared/conversations/model.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { data_watch, set_page_api } from "../src/web/api.ts";
import { AssistantPane, ProposalCard, Thinking, ToolCallRow } from "../src/web/assistant/AssistantPane.tsx";
import { Mascot } from "../src/web/assistant/Mascot.tsx";
import { lasting_mood, moment_after, mood_summary, screen_placement } from "../src/web/assistant/mascot.ts";
import { moods as moods_of } from "../src/shared/mood/model.ts";
import { want_conversation } from "../src/web/assistant/selection.ts";
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
    expect(fixture.calls.list_conversations(kitchen)).toEqual([]);
    type_and_send("What is here?");

    expect(await screen.findByText("Kitchen", { selector: "strong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "CODEX, thinking" })).toBeTruthy();
    await act(async () => {
      release();
      await wait_for_runs();
    });

    expect(await screen.findByText(/it is empty/)).toBeTruthy();
    expect(screen.getByText("What is here?", { selector: ".from-user p" })).toBeTruthy();
    const call = screen.getByText("list_contexts").closest("details")!;
    expect(call.open).toBe(false);
    expect(within(call).getByText("done")).toBeTruthy();
    expect(within(call).getByText(/"name": "Kitchen"/)).toBeTruthy();
    // The call shows where it was made: after the text written before it, before the text after it.
    const before_call = screen.getByText("Kitchen", { selector: ".from-assistant strong" });
    const after_call = screen.getByText(/it is empty/);
    expect(before_call.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(call.compareDocumentPosition(after_call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Send" })).toBeTruthy();
    await waitFor(() => expect(moods).toContain("happy"));
  });

  it("shows a reasoning model's thinking folded under a Thinking row that opens to it streaming, replaced by the answer", async () => {
    const fixture = open_page();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fixture.set_script(async function* () {
      yield { type: "reasoning", text: "The user wants " };
      yield { type: "reasoning", text: "a greeting." };
      await held;
      yield { type: "text", text: "Hello there." };
      yield { type: "done", text: "Hello there." };
    });
    render(<AssistantPane context_id={null} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Hi");

    const row = (await screen.findByText("Thinking…")).closest("details")!;
    expect(row.open).toBe(false);
    await waitFor(() => expect(within(row).getByText("The user wants a greeting.")).toBeTruthy());
    expect(screen.getByRole("img", { name: "CODEX, thinking" })).toBeTruthy();
    await act(async () => {
      release();
      await wait_for_runs();
    });

    expect(await screen.findByText("Hello there.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
    expect(screen.queryByText(/a greeting/)).toBeNull();
  });

  it("keeps the opened thinking at its newest text as it streams, until the reader scrolls up", () => {
    // jsdom lays nothing out, so the box reports a fixed height and a content height that grows with the text.
    const sized = (element: HTMLElement) => {
      Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 100 });
      Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => element.textContent!.length * 10 });
    };
    const { rerender, container } = render(<Thinking text={"a".repeat(30)} />);
    const box = container.querySelector<HTMLElement>(".reply-thinking-text")!;
    sized(box);

    rerender(<Thinking text={"a".repeat(60)} />);
    expect(box.scrollTop).toBe(600);

    box.scrollTop = 100;
    fireEvent.scroll(box);
    rerender(<Thinking text={"a".repeat(90)} />);
    expect(box.scrollTop).toBe(100);

    box.scrollTop = 800;
    fireEvent.scroll(box);
    rerender(<Thinking text={"a".repeat(120)} />);
    expect(box.scrollTop).toBe(1200);
  });

  it("puts a failure in plain words with its raw detail behind Details, and shows what was left out to fit", async () => {
    const fixture = open_page();
    fixture.set_script(async function* () {
      yield { type: "notice", text: "Your message was too long for this model's context, so 30,000 of its 45,000 characters, from the middle, were left out of what the model read. Your message is kept whole." };
      yield { type: "error", message: "The engine at 127.0.0.1:8080 cannot be reached.", detail: "Connection error. (ECONNREFUSED)" };
    });
    render(<AssistantPane context_id={null} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("A very long message");
    await act(() => wait_for_runs());

    expect(await screen.findByText("The engine at 127.0.0.1:8080 cannot be reached.")).toBeTruthy();
    const details = screen.getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("Connection error. (ECONNREFUSED)")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/^Your message was too long for this model's context/);
    await waitFor(() => expect(moods).toContain("sad"));
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
    // Folded under the summary: the message that asked for it, and that nothing was read first.
    const why = within(card).getByText("Why, and from what").closest("details")!;
    expect(why.open).toBe(false);
    expect(within(why).getByText("“Call it Cooking”")).toBeTruthy();
    expect(within(why).getByText("It read nothing before proposing.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));

    expect(await screen.findByText("Approved and done: Rename the context “Kitchen” to “Cooking”.")).toBeTruthy();
    expect(fixture.calls.get_context(kitchen).name).toBe("Cooking");
    // The proposed call's row and the approval's row both say who decided.
    expect(screen.getAllByText("approved by you")).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("article", { name: "Proposed change" })).toBeNull());

    // The approved change can be undone from the conversation, once.
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone by you: Rename the context “Kitchen” to “Cooking”.")).toBeTruthy();
    expect(fixture.calls.get_context(kitchen).name).toBe("Kitchen");
    expect(await screen.findByText("Undone by you.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows a proposal's reads, quoting only what may leave this computer and naming the rest's sources", () => {
    open_page();
    const proposal = {
      id: "p1",
      conversation_id: "c1",
      method: "rename_context",
      arguments: {},
      summary: "Rename the context “Kitchen” to “Tiling”.",
      reason: "outside content" as const,
      sources: ["links"],
      status: "waiting" as const,
      result: "",
      created_at: "",
      resolved_at: "",
      evidence: {
        asked_by: "m1",
        run_id: "r1",
        reads: [
          { call_id: "t1", name: "list_contexts", arguments: {}, sources: [], excerpt: "Kitchen, Garden" },
          { call_id: "t2", name: "get_item", arguments: { id: "links:tiles" }, sources: ["links"], excerpt: "" },
        ],
        seen: ["links"],
      },
    };
    render(<ProposalCard proposal={proposal} asked="Name it after the tiles" label_of={(source) => (source === "links" ? "Web links" : source)} />);

    expect(screen.getByText("“Name it after the tiles”")).toBeTruthy();
    expect(screen.getByText(/“Kitchen, Garden”/)).toBeTruthy();
    expect(screen.getByText(/not quoted, as Web links may not leave this computer/)).toBeTruthy();
    expect(screen.getByText("From: Web links")).toBeTruthy();
    cleanup();
    // A run that had no other app's content in front of it names no source, whatever the proposal itself names.
    render(<ProposalCard proposal={{ ...proposal, sources: ["links", "x-tasks"], evidence: { asked_by: "m1", run_id: "r1", reads: [], seen: [] } }} />);
    expect(screen.getByText("It read nothing before proposing.")).toBeTruthy();
    expect(screen.queryByText(/^From:/)).toBeNull();
    cleanup();
    render(<ProposalCard proposal={{ ...proposal, evidence: { asked_by: "", run_id: "", reads: [] } }} />);
    expect(screen.getByText("No evidence was kept for this proposal.")).toBeTruthy();
  });

  it("says on an applied change's row why it cannot be undone", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    fixture.calls.set_action_level("rename_context", "auto");
    fixture.set_script(async function* (request) {
      yield { type: "tool_call", id: "t1", name: "rename_context", arguments: { id: kitchen, name: "Cooking" } };
      yield { type: "tool_result", id: "t1", ...(await request.tools.call("rename_context", { id: kitchen, name: "Cooking" })) };
      yield { type: "done", text: "Renamed." };
    });
    render(<AssistantPane context_id={kitchen} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Call it Cooking");
    await act(() => wait_for_runs());
    expect(await screen.findByRole("button", { name: "Undo" })).toBeTruthy();

    await act(async () => {
      fixture.calls.set_context_notes(kitchen, "Tiles first.");
      data_watch.bump();
    });

    expect(await screen.findByText("Cooking has changed since, so undoing this would undo that too.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("rejects a proposal, and deletes the conversation after asking in its own dialog", async () => {
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
        <ContextMenus />
      </>,
    );
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Delete it");
    await act(() => wait_for_runs());
    fireEvent.click(within(await screen.findByRole("article", { name: "Proposed change" })).getByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/^Rejected: Delete the context/)).toBeTruthy();
    // A rejection reads as the user's, never as the policy refusing it.
    await waitFor(() => expect(screen.getAllByText("rejected by you")).toHaveLength(2));
    expect(screen.queryByText("not permitted")).toBeNull();
    expect(fixture.calls.list_contexts().map((context) => context.name)).toEqual(["Kitchen"]);

    fireEvent.click(screen.getByRole("button", { name: "More for this conversation" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fixture.calls.list_conversations(kitchen)).toEqual([]));
    expect(await screen.findByText("A new conversation about this context: ask about it, or ask CODEX to change it.")).toBeTruthy();
    expect(fixture.calls.list_contexts().map((context) => context.name)).toEqual(["Kitchen"]);
  });

  it("starts another conversation, switches between them while one is written, shows which are running, and renames one from its head", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    render(
      <>
        <AssistantPane context_id={kitchen} />
        <Dialogs />
        <ContextMenus />
      </>,
    );
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("Tiles");
    expect(await screen.findByText("Hello.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("Tiles"));

    // A second conversation, whose reply is held while the user looks at the first.
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(screen.queryByText("Hello.")).toBeNull());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fixture.set_script(async function* () {
      yield { type: "text", text: "Reading the manual" };
      await held;
      yield { type: "done", text: "Page 4." };
    });
    type_and_send("Oven");
    expect(await screen.findByText("Reading the manual")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    const oven_row = await screen.findByRole("menuitemradio", { name: /Oven/ });
    expect(oven_row.textContent).toContain("writing…");
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Tiles/ }));
    expect(await screen.findByText("Hello.")).toBeTruthy();
    expect(screen.queryByText("Reading the manual")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("1 writing"));

    await act(async () => {
      release();
      await wait_for_runs();
    });
    const [oven] = fixture.calls.list_conversations(kitchen);
    expect(fixture.calls.get_conversation(oven!.id).messages.at(-1)!.text).toBe("Page 4.");

    fireEvent.click(screen.getByRole("button", { name: "Rename the conversation" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Floor tiles" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("Floor tiles"));
    expect(fixture.calls.list_conversations(kitchen).map((each) => each.title).sort()).toEqual(["Floor tiles", "Oven"]);
  });

  it("opens on the most recent conversation that is not a job's, listing the jobs' under a heading of their own", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { conversation_id: talk } = await fixture.calls.send_message(kitchen, "Tiles");
    await wait_for_runs();
    // A job's conversation, used after the user's.
    const job = fixture.calls.add_job({ title: "Tidy the kitchen", instruction: "Tidy.", context_id: kitchen, schedule: { kind: "every", every: 1, unit: "hours" }, only_when_changed: false, limits: { max_rounds: 4, max_tokens: 10_000, max_runs_per_day: 6 } });
    const { conversation_id: job_talk } = await fixture.calls.send_message(kitchen, "Tidy.", null);
    await wait_for_runs();
    fixture.database.prepare("UPDATE jobs SET conversation_id = ? WHERE id = ?").run(job_talk, job);
    expect(fixture.calls.list_conversations(kitchen).map((each) => [each.id, each.job])).toEqual([
      [job_talk, { title: "Tidy the kitchen" }],
      [talk, null],
    ]);

    render(
      <>
        <AssistantPane context_id={kitchen} />
        <ContextMenus />
      </>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("Tiles"));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    const menu = await screen.findByRole("menu");
    const rows = [...menu.querySelectorAll(".menu-item")].map((row) => (row.textContent ?? "").replace(/\d+s ago$/, "").trim());
    expect(rows).toEqual(["Tiles", "New conversation", "Background jobs", "Tidy."]);
    expect(within(menu).getByRole("menuitem", { name: "Background jobs" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Tidy\./ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("Tidy."));

    // A message sent to the context with no conversation named goes to the user's, not the job's.
    const { conversation_id } = await fixture.calls.send_message(kitchen, "And the grout?");
    await wait_for_runs();
    expect(conversation_id).toBe(talk);
  });

  it("shows a conversation asked for by an item or a link once it is open on that context", async () => {
    const fixture = open_page();
    const kitchen = fixture.calls.add_context("Kitchen");
    const { conversation_id: first } = await fixture.calls.send_message(kitchen, "First");
    await wait_for_runs();
    await fixture.calls.send_message(kitchen, "Second", null);
    await wait_for_runs();
    render(<AssistantPane context_id={kitchen} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("Second"));

    act(() => want_conversation(kitchen, first));
    await waitFor(() => expect(screen.getByRole("button", { name: "Conversations" }).textContent).toContain("First"));
  });
});

// ── Parts ────────────────────────────────────────────────────────────────────

describe("a specialist's calls", () => {
  it("are listed inside the ask that made them, each with its outcome, a proposal as the user decided it", () => {
    const nested = [
      { id: "specialist_1", name: "mcp_budget__list_budgets", arguments: {}, result: "main", is_error: false, outcome: "ran" as const },
      { id: "specialist_2", name: "mcp_budget__add_budget", arguments: { name: "Trip" }, result: "", is_error: false, outcome: "proposed" as const, proposal_id: "p1" },
    ];
    const { container } = render(<ToolCallRow call={{ id: "t1", name: "ask_budget", arguments: { request: "Add a trip budget." }, result: "Proposed it.", is_error: false, outcome: "ran", calls: nested }} decisions={new Map([["p1", "approved"]])} />);
    const inside = container.querySelector(".tool-call-nested")!;
    expect(screen.getByText("The specialist's calls")).toBeTruthy();
    expect(within(inside as HTMLElement).getByText("mcp_budget__list_budgets")).toBeTruthy();
    expect(within(inside as HTMLElement).getByText("mcp_budget__add_budget")).toBeTruthy();
    expect(inside.querySelectorAll(".tool-call").length).toBe(2);
  });
});

describe("the mascot's mood", () => {
  it("sleeps without an engine or a store, thinks while a reply is written, and is happy or sad after one", () => {
    expect(lasting_mood({ has_engine: false, is_reachable: true, is_running: false })).toBe("asleep");
    expect(lasting_mood({ has_engine: true, is_reachable: false, is_running: true })).toBe("asleep");
    expect(lasting_mood({ has_engine: true, is_reachable: true, is_running: true })).toBe("thinking");
    expect(lasting_mood({ has_engine: true, is_reachable: true, is_running: false })).toBe("default");
    expect([moment_after(""), moment_after("Broken"), moment_after("Stopped.")]).toEqual(["happy", "sad", null]);
  });

  it("shows the assistant's own mood when idle, each through a face RoboBuddy has, and says why in words", () => {
    const idle = { has_engine: true, is_reachable: true, is_running: false };
    expect(moods_of.map((mood) => lasting_mood({ ...idle, mood }))).toEqual(["default", "happy", "laughing", "sad", "curious", "worried"]);
    expect(lasting_mood({ ...idle, is_running: true, mood: "sad" })).toBe("thinking");
    expect(lasting_mood({ ...idle, has_engine: false, mood: "celebrating" })).toBe("asleep");
    const state = { enabled: true, tone: true, mood: "celebrating" as const, strength: 0.9, reason: "My birthday", set_at: "", by: "date" as const };
    expect(mood_summary(state)).toBe("Celebrating: My birthday From a date you listed.");
    expect(mood_summary({ ...state, mood: "concerned", reason: "The job “Tidy” failed.", by: "event" })).toBe("A little concerned: The job “Tidy” failed. From CODEX's own background work.");
    expect(mood_summary({ ...state, mood: "neutral" })).toBe("Neutral: nothing in particular.");
    expect(mood_summary({ ...state, enabled: false })).toBe("The mood is off, so the face stays neutral.");
  });

  it("shows on the pane's face, with why on hover and in a note when tapped, and stays neutral while off", async () => {
    const fixture = open_page();
    fixture.set_script(async function* (request) {
      await request.tools.call("set_mood", { mood: "celebrating", reason: "The user's thesis is done." });
      yield { type: "done", text: "Congratulations!" };
    });
    render(<AssistantPane context_id={null} />);
    await screen.findByRole("textbox", { name: "Message" });
    type_and_send("My thesis is done!");
    await wait_for_runs();
    data_watch.bump();
    const face = await screen.findByRole("button", { name: /CODEX's mood\. Celebrating: The user's thesis is done\./ });
    expect(face.getAttribute("title")).toBe("Celebrating: The user's thesis is done. Set in a reply.");
    await waitFor(() => expect(moods.at(-1)).toBe("laughing"));
    fireEvent.click(face);
    expect(await screen.findByText("Celebrating: The user's thesis is done. Set in a reply.", { selector: ".mood-note" })).toBeTruthy();

    fixture.calls.set_setting("mood.enabled", false);
    data_watch.bump();
    await waitFor(() => expect(moods.at(-1)).toBe("default"));
    expect(screen.getByRole("button", { name: /The mood is off/ })).toBeTruthy();
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
