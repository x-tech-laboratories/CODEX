// A reasoning model's thinking: kept with each reply where it happened, never sent back to any engine, and not kept
// at all while the Keep thinking setting is off.

import { afterEach, describe, expect, it, vi } from "vitest";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { add_message, list_messages } from "../src/shared/conversations/messages.ts";
import { add_thinking, keep_thinking_setting, reply_parts, type ThinkingPiece, type ToolCallRecord } from "../src/shared/conversations/model.ts";
import { add_conversation_record } from "../src/shared/conversations/records.ts";
import { keeps_thinking, thinking_placed_in, turns_of, wait_for_runs } from "../src/shared/conversations/run.ts";
import type { ChatCompletion, ChatModel, ChatRequest } from "../src/shared/engines/direct.ts";
import type { EngineEvent, EngineRequest } from "../src/shared/engines/engine.ts";
import { AnthropicModel } from "../src/server/engines/anthropic.ts";
import { direct_engine } from "../src/server/engines/index.ts";
import { OpenAiModel } from "../src/server/engines/openai.ts";
import { harness_engine } from "../src/server/engines/smartharness.ts";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function talk(fixture: Fixture, text: string, conversation_id?: string): Promise<string> {
  const { conversation_id: id } = await fixture.calls.send_message(null, text, conversation_id);
  await wait_for_runs();
  return id;
}

// A reply that thinks, calls a tool, thinks again and answers, with one more thought after its first words.
function thinks_around_a_call(fixture: Fixture) {
  fixture.set_script(async function* (request) {
    yield { type: "reasoning", text: "I should look " };
    yield { type: "reasoning", text: "at the contexts." };
    yield { type: "tool_call", id: "t1", name: "list_contexts", arguments: {} };
    const outcome = await request.tools.call("list_contexts", {});
    yield { type: "tool_result", id: "t1", ...outcome };
    yield { type: "reasoning", text: "Kitchen is there." };
    yield { type: "text", text: "You have Kitchen." };
    yield { type: "reasoning", text: "That is all." };
    yield { type: "done", text: "You have Kitchen." };
  });
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const all: EngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const no_tools = { definitions: [], call: async () => ({ result: "", is_error: false }) };

// ── Keeping ──────────────────────────────────────────────────────────────────

describe("a reply's thinking", () => {
  it("is kept with the reply, each stretch where it happened among the text and tool calls", async () => {
    const fixture = start_fixture();
    fixture.calls.add_context("Kitchen");
    thinks_around_a_call(fixture);

    const id = await talk(fixture, "What is here?");

    const answer = fixture.calls.get_conversation(id).messages[1]!;
    expect(answer.thinking).toEqual([
      { text: "I should look at the contexts.", text_at: 0, calls_before: 0 },
      { text: "Kitchen is there.", text_at: 0, calls_before: 1 },
      { text: "That is all.", text_at: 17, calls_before: 1 },
    ]);
    const parts = reply_parts(answer.text, answer.tool_calls, answer.thinking).map((part) => ("call" in part ? `[${part.call.id}]` : "thinking" in part ? `(${part.thinking})` : part.text));
    expect(parts).toEqual(["(I should look at the contexts.)", "[t1]", "(Kitchen is there.)", "You have Kitchen.", "(That is all.)"]);
    expect(fixture.events.filter((event) => event.type === "reasoning")).toHaveLength(4);
  });

  it("stands in the run as it streams, so a page opened mid-reply sees it", async () => {
    const fixture = start_fixture();
    let peek!: () => void;
    const peeked = new Promise<void>((resolve) => (peek = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fixture.set_script(async function* () {
      yield { type: "reasoning", text: "Thinking it over." };
      peek();
      await held;
      yield { type: "done", text: "Done." };
    });

    const { conversation_id } = await fixture.calls.send_message(null, "Hi");
    await peeked;
    expect(fixture.calls.get_conversation(conversation_id).run!.thinking).toEqual([{ text: "Thinking it over.", text_at: 0, calls_before: 0 }]);
    release();
  });

  it("is kept whole, however long", async () => {
    const fixture = start_fixture();
    const long = "a long thought ".repeat(20_000);
    fixture.set_script(async function* () {
      for (let at = 0; at < long.length; at += 1000) yield { type: "reasoning", text: long.slice(at, at + 1000) };
      yield { type: "done", text: "Short answer." };
    });

    const id = await talk(fixture, "Think hard.");

    const kept = list_messages(fixture.database, id)[1]!.thinking;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe(long);
  });

  it("is not kept while the Keep thinking setting is off, though pages still see it stream", async () => {
    const fixture = start_fixture();
    expect(keeps_thinking(fixture.database)).toBe(true);
    fixture.calls.set_setting(keep_thinking_setting, false);
    expect(keeps_thinking(fixture.database)).toBe(false);
    thinks_around_a_call(fixture);

    const id = await talk(fixture, "What is here?");

    const answer = fixture.calls.get_conversation(id).messages[1]!;
    expect(answer.thinking).toEqual([]);
    expect(answer.tool_calls).toHaveLength(1);
    expect(JSON.stringify(fixture.calls.get_conversation(id))).not.toContain("Kitchen is there");
    expect(fixture.events.filter((event) => event.type === "reasoning").map((event) => ("text" in event ? event.text : ""))).toContain("Kitchen is there.");

    fixture.calls.set_setting(keep_thinking_setting, true);
    await talk(fixture, "Again?", id);
    expect(fixture.calls.get_conversation(id).messages[3]!.thinking.map((piece) => piece.text)).toContain("Kitchen is there.");
  });

  it("reads back an empty list from a row with none or with a broken one", () => {
    const fixture = start_fixture();
    const id = add_conversation_record(fixture.database, null);
    const kept = add_message(fixture.database, { conversation_id: id, role: "assistant", text: "Old." });
    expect(kept.thinking).toEqual([]);
    fixture.database.prepare("UPDATE conversation_messages SET thinking = ? WHERE id = ?").run('[{"text":"fine","text_at":0,"calls_before":0},{"text":3},"odd"]', kept.id);
    expect(list_messages(fixture.database, id)[0]!.thinking).toEqual([{ text: "fine", text_at: 0, calls_before: 0 }]);
    fixture.database.prepare("UPDATE conversation_messages SET thinking = ? WHERE id = ?").run("not json", kept.id);
    expect(list_messages(fixture.database, id)[0]!.thinking).toEqual([]);
  });
});

describe("placing thinking", () => {
  const call = (id: string, text_at: number): ToolCallRecord => ({ id, name: "get_context", arguments: {}, result: "", is_error: false, outcome: "ran", text_at });
  const read = (text: string, calls: ToolCallRecord[], thinking: ThinkingPiece[]) => reply_parts(text, calls, thinking).map((part) => ("call" in part ? `[${part.call.id}]` : "thinking" in part ? `(${part.thinking})` : part.text));

  it("adds to the last stretch until text or a call comes between", () => {
    let thinking = add_thinking([], "a", 0, 0);
    thinking = add_thinking(thinking, "b", 0, 0);
    thinking = add_thinking(thinking, "c", 0, 1);
    thinking = add_thinking(thinking, "d", 4, 1);
    expect(thinking).toEqual([
      { text: "ab", text_at: 0, calls_before: 0 },
      { text: "c", text_at: 0, calls_before: 1 },
      { text: "d", text_at: 4, calls_before: 1 },
    ]);
  });

  it("puts each stretch between the calls made before and after it, and leaves out blank ones", () => {
    const thinking = [
      { text: "before both", text_at: 0, calls_before: 0 },
      { text: "between", text_at: 0, calls_before: 1 },
      { text: "  ", text_at: 0, calls_before: 2 },
      { text: "after the text", text_at: 99, calls_before: 2 },
    ];
    expect(read("Done.", [call("a", 0), call("b", 0)], thinking)).toEqual(["(before both)", "[a]", "(between)", "[b]", "Done.", "(after the text)"]);
  });

  it("moves each stretch back by the spaces the kept text lost at its start", () => {
    expect(thinking_placed_in("  Hello", "Hello", [{ text: "x", text_at: 7, calls_before: 0 }, { text: "y", text_at: 0, calls_before: 0 }]).map((piece) => piece.text_at)).toEqual([5, 0]);
  });
});

// ── Never sent back ──────────────────────────────────────────────────────────

describe("the conversation an engine is sent", () => {
  // A conversation whose kept answer thought something, and the request the next reply would be given.
  async function after_thinking(): Promise<EngineRequest> {
    const fixture = start_fixture();
    fixture.set_script(async function* () {
      yield { type: "reasoning", text: "SECRET-THOUGHT" };
      yield { type: "done", text: "First answer." };
    });
    const id = await talk(fixture, "First question");
    expect(JSON.stringify(fixture.calls.get_conversation(id).messages)).toContain("SECRET-THOUGHT");
    fixture.set_script(async function* () {
      yield { type: "done", text: "Second answer." };
    });
    await talk(fixture, "Second question", id);
    const request = fixture.requests.at(-1)!;
    expect(turns_of(fixture.database, id).slice(0, 3)).toEqual(request.conversation);
    expect(request.conversation.map((turn) => turn.text)).toEqual(["First question", "First answer.", "Second question"]);
    return request;
  }

  it("leaves the thinking out of the turns any engine is given", async () => {
    const request = await after_thinking();
    expect(JSON.stringify(request)).not.toContain("SECRET-THOUGHT");
  });

  it("leaves it out of what the Anthropic engine sends", async () => {
    const request = await after_thinking();
    const stream = vi.fn((_body: unknown, _options: unknown) => ({
      abort: () => undefined,
      finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Fine." }], usage: { input_tokens: 1, output_tokens: 1 } }),
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Fine." } };
      },
    }));
    const make = () => new AnthropicModel({ model: "claude-opus-5-5", api_key: "", client: { messages: { stream } } as never });
    const engine = direct_engine("Anthropic", () => ({ model: "claude-opus-5-5", api_key_command: "print-key" }), make, async () => "made-up-key");

    expect((await collect(engine.run({ ...request, tools: no_tools }, new AbortController().signal))).at(-1)).toEqual({ type: "done", text: "Fine." });

    const sent = JSON.stringify(stream.mock.calls[0]![0]);
    expect(sent).toContain("First answer.");
    expect(sent).not.toContain("SECRET-THOUGHT");
  });

  it("leaves it out of what an OpenAI-compatible engine sends", async () => {
    const request = await after_thinking();
    const create = vi.fn(async (_body: unknown, _options: unknown) => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ finish_reason: "stop", delta: { content: "Fine." } }] };
      },
    }));
    const make = () => new OpenAiModel({ endpoint: "http://localhost:11434/v1", model: "llama3.1", api_key: "", client: { chat: { completions: { create } } } as never });
    const engine = direct_engine("OpenAI-compatible", () => ({ model: "llama3.1", api_key_command: "print-key" }), make, async () => "made-up-key");

    expect((await collect(engine.run({ ...request, tools: no_tools }, new AbortController().signal))).at(-1)).toEqual({ type: "done", text: "Fine." });

    const sent = JSON.stringify(create.mock.calls[0]![0]);
    expect(sent).toContain("First answer.");
    expect(sent).not.toContain("SECRET-THOUGHT");
  });

  it("leaves it out of what the SmartHarness engine sends", async () => {
    const request = await after_thinking();
    const requests: ChatRequest[] = [];
    const model: ChatModel = {
      async complete(chat: ChatRequest): Promise<ChatCompletion> {
        requests.push(chat);
        const properties = (chat.json_schema?.properties ?? {}) as Record<string, unknown>;
        const content =
          "approach" in properties
            ? JSON.stringify({ reason: "Simple.", facts_to_check: [], approach: "act", search_queries: [], subtasks: [], ...("clarification" in properties ? { clarification: "" } : {}) })
            : "verdict" in properties
              ? JSON.stringify({ verdict: "met", problem: "" })
              : "Fine.";
        chat.on_text?.(content);
        return { content, tool_calls: [], finish_reason: "stop", usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const settings = { endpoint: "http://127.0.0.1:9/v1", model: "small-model", context_size: 16384, max_task_depth: 0, max_task_nodes: 1, tool_set: "all" };
    const engine = harness_engine(() => settings, { make: () => model, read: async () => "" });

    const events = await collect(engine.run({ ...request, tools: no_tools }, new AbortController().signal));

    expect(events.at(-1)!.type).toBe("done");
    const sent = JSON.stringify(requests.map((each) => each.messages));
    expect(requests.length).toBeGreaterThan(0);
    expect(sent).toContain("First answer.");
    expect(sent).not.toContain("SECRET-THOUGHT");
  });
});
