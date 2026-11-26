import { afterEach, describe, expect, it, vi } from "vitest";

import { create_plugin_host, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../src/shared/collectors/collector.ts";
import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import type { ChatRequest } from "../src/shared/engines/direct.ts";
import type { Engine, EngineEvent, EngineRequest } from "../src/shared/engines/engine.ts";
import { AnthropicModel, anthropic_messages, anthropic_request, ModelRefused } from "../src/server/engines/anthropic.ts";
import { anthropic_plugin, direct_engine, engine_plugins, make_anthropic, make_openai, openai_plugin } from "../src/server/engines/index.ts";
import { OpenAiModel, openai_messages, openai_request } from "../src/server/engines/openai.ts";
import { is_repeating, repeat_window_chars } from "../src/server/engines/repetition.ts";
import { command_words, key_from, max_secret_chars, read_secret } from "../src/server/engines/secret_command.ts";
import { start_fake_openai, type FakeOpenAiServer } from "./fake_openai_server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ask: ChatRequest = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hello" }], max_tokens: 500 };
const loop = "'Twenty-one' rhymes with 'twenty-one'. ";

type Final = { stop_reason: string; stop_details?: { category: string | null } | null; content: Record<string, unknown>[]; usage?: { input_tokens: number; output_tokens: number } };

function delta(text: string) {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

// An Anthropic client whose stream gives these events and then this final message.
function anthropic_streaming(events: unknown[], final: Final) {
  const abort = vi.fn();
  const stream = vi.fn((_body: unknown, _options: unknown) => ({
    abort,
    finalMessage: async () => final,
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  }));
  const model = new AnthropicModel({ model: "claude-opus-5-5", api_key: "", client: { messages: { stream } } as never });
  return { model, stream, abort };
}

// An OpenAI client whose stream gives these chunks.
function openai_streaming(chunks: unknown[]) {
  const create = vi.fn(async (_body: unknown, _options: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  }));
  const model = new OpenAiModel({ endpoint: "http://localhost:11434/v1", model: "llama3.1", api_key: "", client: { chat: { completions: { create } } } as never });
  return { model, create };
}

function text_chunk(content: string, finish_reason: string | null = null) {
  return { choices: [{ finish_reason, delta: { content } }] };
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const all: EngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function engine_of(plugin: ReturnType<typeof openai_plugin>, settings: SettingValues): Promise<Engine> {
  const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: { read: () => ({ [plugin.id]: { enabled: true, settings } }), write: () => undefined } });
  await host.add(plugin);
  await host.start();
  return host.providers("engine")[0]!.value;
}

const no_tools = { definitions: [], call: async () => ({ result: "", is_error: false }) };

// ── Anthropic ────────────────────────────────────────────────────────────────

describe("the Anthropic model", () => {
  it("lifts system text out, turns calls into tool use, and groups results in one user turn", () => {
    const converted = anthropic_messages([
      { role: "system", content: "One." },
      { role: "user", content: "Find both" },
      { role: "assistant", content: "Looking.", tool_calls: [{ id: "a", name: "search", arguments: '{"q":"x"}' }, { id: "b", name: "search", arguments: "not json" }] },
      { role: "tool", tool_call_id: "a", content: "first" },
      { role: "tool", tool_call_id: "b", content: "" },
      { role: "system", content: "Two." },
      { role: "assistant", content: "" },
      { role: "user", content: "Thanks" },
      { role: "tool", tool_call_id: "c", content: "stray" },
    ]);

    expect(converted.system).toBe("One.\n\nTwo.");
    expect(converted.messages).toEqual([
      { role: "user", content: "Find both" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "a", name: "search", input: { q: "x" } },
          { type: "tool_use", id: "b", name: "search", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "first" },
          { type: "tool_result", tool_use_id: "b", content: "" },
        ],
      },
      { role: "user", content: "Thanks" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "stray" }] },
    ]);
  });

  it("sends the tools with object schemas and never a temperature", () => {
    const body = anthropic_request("claude-opus-5-5", { ...ask, tools: [{ name: "search", description: "Search", parameters: { properties: { q: { type: "string" } } } }] });

    expect(body).toMatchObject({ model: "claude-opus-5-5", max_tokens: 500, system: "Be brief.", tool_choice: { type: "auto" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body.tools).toEqual([{ name: "search", description: "Search", input_schema: { type: "object", properties: { q: { type: "string" } } } }]);
    expect(anthropic_request("m", { messages: [{ role: "user", content: "Hi" }], max_tokens: 10 })).toEqual({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "Hi" }] });
  });

  it("streams text, and gives the final message's text, tool calls and usage", async () => {
    const { model, stream } = anthropic_streaming([{ type: "message_start" }, delta("Hel"), delta("lo")], {
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hello" }],
      usage: { input_tokens: 12, output_tokens: 2 },
    });
    const pieces: string[] = [];
    const cancel = new AbortController();

    const completion = await model.complete({ ...ask, signal: cancel.signal, on_text: (text) => pieces.push(text) });

    expect(pieces).toEqual(["Hel", "lo"]);
    expect(completion).toEqual({ content: "Hello", tool_calls: [], finish_reason: "stop", usage: { input_tokens: 12, output_tokens: 2 } });
    expect(stream.mock.calls[0]![1]).toEqual({ signal: cancel.signal });

    const tools = anthropic_streaming([], { stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { q: "wal" } }] });
    expect(await tools.model.complete(ask)).toEqual({ content: "", tool_calls: [{ id: "toolu_1", name: "search", arguments: '{"q":"wal"}' }], finish_reason: "tool_calls" });
    const cut = anthropic_streaming([], { stop_reason: "max_tokens", content: [{ type: "text", text: "Partial" }] });
    expect((await cut.model.complete(ask)).finish_reason).toBe("length");
  });

  it("fails a declined request, naming the reason when there is one", async () => {
    await expect(anthropic_streaming([], { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }).model.complete(ask)).rejects.toThrow(new ModelRefused("cyber"));
    await expect(anthropic_streaming([], { stop_reason: "refusal", content: [] }).model.complete(ask)).rejects.toThrow("The model declined the request.");
  });

  it("stops a reply that goes round in circles, and a stream that breaks", async () => {
    const looping = anthropic_streaming(
      Array.from({ length: 60 }, () => delta(loop)),
      { stop_reason: "end_turn", content: [] },
    );
    expect((await looping.model.complete(ask)).finish_reason).toBe("repetition");
    expect(looping.abort).toHaveBeenCalled();

    const broken = anthropic_streaming([delta("First")], { stop_reason: "end_turn", content: [] });
    await expect(
      broken.model.complete({
        ...ask,
        on_text: () => {
          throw new Error("Gone");
        },
      }),
    ).rejects.toThrow("Gone");
    expect(broken.abort).toHaveBeenCalled();
  });

  it("builds its own client when none is given", () => {
    expect(() => make_anthropic({ model: "claude-opus-5-5" }, "made-up-key")).not.toThrow();
  });
});

// ── OpenAI-compatible ────────────────────────────────────────────────────────

describe("the OpenAI-compatible model", () => {
  it("keeps tool calls and results, and asks for usage with the tools on offer", () => {
    expect(
      openai_messages([
        { role: "system", content: "s" },
        { role: "assistant", content: "", tool_calls: [{ id: "a", name: "search", arguments: "{}" }] },
        { role: "assistant", content: "Done." },
        { role: "tool", tool_call_id: "a", content: "found" },
      ]),
    ).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search", arguments: "{}" } }] },
      { role: "assistant", content: "Done." },
      { role: "tool", tool_call_id: "a", content: "found" },
    ]);
    const body = openai_request("llama3.1", { ...ask, tools: [{ name: "search", description: "Search", parameters: { type: "object" } }] });
    expect(body).toMatchObject({ model: "llama3.1", stream: true, temperature: 0.1, max_tokens: 500, tool_choice: "auto", stream_options: { include_usage: true } });
    expect(body.tools).toEqual([{ type: "function", function: { name: "search", description: "Search", parameters: { type: "object" } } }]);
    expect(openai_request("m", ask).tools).toBeUndefined();
  });

  it("streams the reply, joins tool calls streamed in pieces and names one that came without an id", async () => {
    const plain = openai_streaming([{ choices: [] }, text_chunk("Hel"), text_chunk("lo", "length"), { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }]);
    const pieces: string[] = [];
    expect(await plain.model.complete({ ...ask, on_text: (text) => pieces.push(text) })).toEqual({ content: "Hello", tool_calls: [], finish_reason: "length", usage: { input_tokens: 5, output_tokens: 2 } });
    expect(pieces).toEqual(["Hel", "lo"]);

    const calls = openai_streaming([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "sea", arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "rch", arguments: '"wal"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "b", function: { name: "read" } }] }, finish_reason: "tool_calls" }] },
    ]);
    const completion = await calls.model.complete(ask);
    expect(completion.finish_reason).toBe("tool_calls");
    expect(completion.tool_calls).toEqual([
      { id: "call_0", name: "search", arguments: '{"q":"wal"}' },
      { id: "b", name: "read", arguments: "" },
    ]);
  });

  it("stops a reply that goes round in circles, and gives the caller's reason when the caller cancels", async () => {
    const looping = openai_streaming(Array.from({ length: 60 }, () => text_chunk(loop)));
    expect((await looping.model.complete(ask)).finish_reason).toBe("repetition");
    expect(looping.create.mock.calls[0]![1].signal.aborted).toBe(true);

    const cancel = new AbortController();
    const create = vi.fn(async () => {
      cancel.abort(new Error("Cancelled by the user"));
      throw new Error("Request was aborted.");
    });
    const model = new OpenAiModel({ endpoint: "", model: "m", api_key: "", client: { chat: { completions: { create } } } as never });
    await expect(model.complete({ ...ask, signal: cancel.signal })).rejects.toThrow("Cancelled by the user");
  });

  it("tells repetition from prose", () => {
    expect(is_repeating(loop.repeat(40))).toBe(true);
    expect(is_repeating("short")).toBe(false);
    const prose = Array.from({ length: repeat_window_chars / 10 }, (_, index) => `w${index * 7919}x `).join("");
    expect(is_repeating(prose)).toBe(false);
  });
});

// ── Key commands ─────────────────────────────────────────────────────────────

describe("the API key command", () => {
  it("splits a command line as a shell would, without expanding anything", () => {
    expect(command_words(`print-key  --name 'my key' "a \\"b\\"" c\\ d $HOME`)).toEqual(["print-key", "--name", "my key", 'a "b"', "c d", "$HOME"]);
    expect(command_words("   ")).toEqual([]);
    expect(command_words(`x ''`)).toEqual(["x", ""]);
    expect(() => command_words(`x 'open`)).toThrow("never closed");
  });

  it("takes the first line the program prints, and refuses in its own words", async () => {
    expect(await read_secret(["printf", "first\r\nsecond\n"])).toBe("first");
    await expect(read_secret(["printf", ""])).rejects.toThrow("The API key command printf printed no usable key.");
    await expect(read_secret(["printf", "x".repeat(max_secret_chars + 1)])).rejects.toThrow("no usable key");
    await expect(read_secret(["false"])).rejects.toThrow("The API key command false failed with exit code 1.");
    await expect(read_secret([])).rejects.toThrow("empty");
    expect(await key_from("")).toBe("");
    expect(await key_from("printf made-up-key")).toBe("made-up-key");
  });
});

// ── Engines ──────────────────────────────────────────────────────────────────

describe("the bundled engines", () => {
  let server: FakeOpenAiServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("are both bundled, with their labels and the model their settings name", async () => {
    expect(engine_plugins.map((plugin) => plugin.id)).toEqual(["codex.anthropic", "codex.openai"]);
    const anthropic = await engine_of(anthropic_plugin(), {});
    expect([anthropic.label, anthropic.model()]).toEqual(["Anthropic", "claude-opus-5-5"]);
    const openai = await engine_of(openai_plugin(), { model: " qwen3 " });
    expect([openai.label, openai.model()]).toEqual(["OpenAI-compatible", "qwen3"]);
  });

  it("answer through an OpenAI-compatible server, calling a tool, with the key the command printed", async () => {
    server = await start_fake_openai((_body, index) => (index === 0 ? { text: ["Let me look."], tool_calls: [{ name: "list_contexts", arguments: {} }] } : { text: ["You have ", "Kitchen."] }));
    const read = vi.fn(async (command: string[]) => (command.join(" ") === "print-key --for openai" ? "made-up-key" : ""));
    const engine = await engine_of(openai_plugin(make_openai, read), { endpoint: server.endpoint, model: "fake-model", api_key_command: "print-key --for openai", context_size: 8192 });
    const call = vi.fn(async () => ({ result: '[{"name":"Kitchen"}]', is_error: false }));
    const request: EngineRequest = {
      instructions: "You are CODEX.",
      conversation: [{ role: "user", text: "What contexts are there?" }],
      tools: { definitions: [{ name: "list_contexts", description: "Lists the contexts.", parameters: { type: "object", properties: {} } }], call },
    };

    const events = await collect(engine.run(request, new AbortController().signal));

    expect(events.at(-1)).toEqual({ type: "done", text: "Let me look.\n\nYou have Kitchen." });
    expect(events).toContainEqual({ type: "tool_call", id: "call_1_0", name: "list_contexts", arguments: {} });
    expect(events).toContainEqual({ type: "usage", input_tokens: 42, output_tokens: 7 });
    expect(call).toHaveBeenCalledWith("list_contexts", {});
    expect(server.requests.map((each) => each.authorization)).toEqual(["Bearer made-up-key", "Bearer made-up-key"]);
    expect(server.requests[0]!.body).toMatchObject({ model: "fake-model", stream: true, tools: [{ type: "function", function: { name: "list_contexts" } }] });
    expect(server.requests[1]!.body.messages).toContainEqual({ role: "tool", tool_call_id: "call_1_0", content: '[{"name":"Kitchen"}]' });
    // The key reaches the server and nothing else.
    expect(JSON.stringify(events)).not.toContain("made-up-key");
  });

  it("stop mid-reply when the run is stopped", async () => {
    server = await start_fake_openai(() => ({ text: Array.from({ length: 50 }, (_, index) => `word${index} `), delay_ms: 20 }));
    const engine = await engine_of(openai_plugin(), { endpoint: server.endpoint, model: "fake-model" });
    const stop = new AbortController();
    const events: EngineEvent[] = [];

    for await (const event of engine.run({ instructions: "", conversation: [{ role: "user", text: "Talk" }], tools: no_tools }, stop.signal)) {
      events.push(event);
      if (events.length === 3) stop.abort();
    }

    expect(events.at(-1)).toEqual({ type: "error", message: "Stopped." });
    expect(events.filter((event) => event.type === "text").length).toBeLessThan(10);
  });

  it("say what is missing: a model, or a key the command gives", async () => {
    const no_model = await engine_of(openai_plugin(), {});
    expect(await collect(no_model.run({ instructions: "", conversation: [], tools: no_tools }, new AbortController().signal))).toEqual([
      { type: "error", message: "Set the OpenAI-compatible engine's model under Settings → Engine." },
    ]);
    const make = vi.fn();
    const failing = direct_engine("Anthropic", () => ({ model: "claude-opus-5-5", api_key_command: "print-key" }), make, async () => {
      throw new Error("The API key command print-key failed with exit code 1.");
    });
    expect(await collect(failing.run({ instructions: "", conversation: [], tools: no_tools }, new AbortController().signal))).toEqual([
      { type: "error", message: "The API key command failed, so no key could be read. Run it in a terminal to see why, then send again.", detail: "The API key command print-key failed with exit code 1." },
    ]);
    expect(make).not.toHaveBeenCalled();
  });
});
