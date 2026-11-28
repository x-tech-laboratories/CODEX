// SmartHarness's task tree as an engine, on a scripted model: it reaches only the tools CODEX hands the run, never its
// own; keeps nothing of the user's; streams what it does; stops when asked; and answers in a conversation, an isolated
// research run and a background job like any other engine.

import { afterEach, describe, expect, it, vi } from "vitest";

import { create_plugin_host, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../../../src/shared/collectors/collector.ts";
import type { ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import type { ChatCompletion, ChatModel, ChatRequest } from "../../../src/shared/engines/direct.ts";
import type { Engine, EngineEvent, EngineRequest, EngineTools, ToolOutcome } from "../../../src/shared/engines/engine.ts";
import { smartharness_manifest } from "../../../src/shared/engines/manifests.ts";
import { bridge_name, harness_engine, harness_input, harness_limits, harness_model, longest_earlier_turn, no_builtin_tool, no_builtin_toolbox, smartharness_plugin, type HarnessEngineOptions } from "../../../src/server/engines/smartharness.ts";
import { open_tool_bridge } from "../../../src/server/engines/tool_bridge.ts";
import { bundled_plugins } from "../../../src/server/collectors/index.ts";
import { start_fixture } from "../../fixtures/assistant_fixture.ts";
import { start_fake_openai, type FakeOpenAiServer } from "../../fixtures/fake_openai_server.ts";

// ── A scripted model ─────────────────────────────────────────────────────────

type Step = "decide" | "check" | "act" | "findings" | "write";

// Which step of the task tree a request is, from its reply schema and what it was offered.
function step_of(request: ChatRequest): Step {
  const properties = (request.json_schema?.properties ?? {}) as Record<string, unknown>;
  if ("approach" in properties) return "decide";
  if ("verdict" in properties) return "check";
  if (request.messages.some((message) => message.role === "tool")) return "findings";
  if (request.tools?.length) return "act";
  return "write";
}

interface Scripted {
  model: ChatModel;
  requests: ChatRequest[];
}

// A model that decides to act, calls the tools a test names in its first tool round, reports, writes and passes its
// check; every request it is sent is kept.
function scripted_model(options: { calls?: { name: string; arguments: Record<string, unknown> }[]; answer?: string; approach?: string; on_request?: (request: ChatRequest) => Promise<void> | void } = {}): Scripted {
  const requests: ChatRequest[] = [];
  const model: ChatModel = {
    async complete(request: ChatRequest): Promise<ChatCompletion> {
      requests.push(request);
      await options.on_request?.(request);
      const usage = { input_tokens: 100, output_tokens: 10 };
      const reply = (content: string): ChatCompletion => {
        request.on_text?.(content);
        return { content, tool_calls: [], finish_reason: "stop", usage };
      };
      const step = step_of(request);
      if (step === "decide") {
        const properties = (request.json_schema?.properties ?? {}) as Record<string, unknown>;
        return reply(JSON.stringify({ reason: "The user's own data.", facts_to_check: [], approach: options.approach ?? "act", search_queries: [], subtasks: [], ...("clarification" in properties ? { clarification: "" } : {}) }));
      }
      if (step === "check") return reply(JSON.stringify({ verdict: "met", problem: "" }));
      if (step === "act") {
        const calls = (options.calls ?? []).map((call, index) => ({ id: `call_${requests.length}_${index}`, name: call.name, arguments: JSON.stringify(call.arguments) }));
        if (calls.length > 0) return { content: "", tool_calls: calls, finish_reason: "tool_calls", usage };
        return reply("Nothing to call.");
      }
      if (step === "findings") return reply(`- Found: ${request.messages.filter((message) => message.role === "tool").map((message) => message.content).join(" | ")}`);
      return reply(options.answer ?? "You have one context, Kitchen.");
    },
  };
  return { model, requests };
}

function tools_of(names: string[], call: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>): EngineTools {
  return { definitions: names.map((name) => ({ name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} } })), call };
}

const settings: SettingValues = { endpoint: "http://127.0.0.1:9/v1", model: "small-model", context_size: 16384, max_task_depth: 0, max_task_nodes: 1, tool_set: "all" };

function engine_with(model: ChatModel, values: SettingValues = settings, options: HarnessEngineOptions = {}): Engine {
  return harness_engine(() => values, { make: () => model, read: async () => "", ...options });
}

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const all: EngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const asked = (text: string, tools: EngineTools, instructions = "You are CODEX's assistant."): EngineRequest => ({ instructions, conversation: [{ role: "user", text }], tools });

// Every tool a model request offered, by name.
const offered_names = (requests: ChatRequest[]) => new Set(requests.flatMap((request) => (request.tools ?? []).map((tool) => tool.name)));

// ── Tools ────────────────────────────────────────────────────────────────────

describe("the SmartHarness engine's tools", () => {
  it("are the asks with the instructions written for them when the work goes to specialists", async () => {
    const plain = tools_of(["list_contexts"], async () => ({ result: "Kitchen", is_error: false }));
    const ask = { name: "ask_contexts", description: "Asks the contexts specialist.", parameters: { type: "object", properties: { request: { type: "string" } } } };
    const scripted = scripted_model();
    const request = { ...asked("Hello", { ...plain, specialists: { definitions: [ask], delegated: plain.definitions } }), instructions_with_specialists: "Rules for asking specialists." };
    await collect(engine_with(scripted.model, { ...settings, specialists: "on" }).run(request, new AbortController().signal));
    expect([...offered_names(scripted.requests)]).toEqual([`mcp__${bridge_name}__ask_contexts`]);
    expect(JSON.stringify(scripted.requests[0]!.messages)).toContain("Rules for asking specialists.");
  });

  it("are exactly the run's own, as mcp__codex__ tools, and the harness is never offered one of its own", async () => {
    const ran: string[] = [];
    const tools = tools_of(["list_contexts", "get_context"], async (name) => (ran.push(name), { result: "Kitchen", is_error: false }));
    const scripted = scripted_model({ calls: [{ name: "mcp__codex__list_contexts", arguments: {} }] });
    let toolbox: ReturnType<typeof no_builtin_toolbox> | undefined;
    const events = await collect(engine_with(scripted.model, settings, { on_toolbox: (given) => (toolbox = given) }).run(asked("Which contexts do I have?", tools), new AbortController().signal));

    // A model request offering any tool not in the run's list fails here.
    const allowed = new Set(tools.definitions.map((tool) => `mcp__${bridge_name}__${tool.name}`));
    const offered = offered_names(scripted.requests);
    expect(offered.size).toBeGreaterThan(0);
    for (const name of offered) expect(allowed.has(name), `the harness offered ${name}`).toBe(true);
    expect(toolbox!.toolDefinitions).toEqual([]);
    expect(ran).toEqual(["list_contexts"]);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([{ type: "tool_call", id: "smartharness_1", name: "list_contexts", arguments: {} }]);
    expect(events.filter((event) => event.type === "tool_result")).toEqual([{ type: "tool_result", id: "smartharness_1", result: "Kitchen", is_error: false }]);
    expect(events.at(-1)).toEqual({ type: "done", text: "You have one context, Kitchen." });
  });

  it("refuse every built-in the model names, and one CODEX did not offer, without running anything", async () => {
    const ran: string[] = [];
    const tools = tools_of(["list_contexts"], async (name) => (ran.push(name), { result: "ok", is_error: false }));
    const hostile = ["web_search", "web_fetch", "read_file", "list_directory", "write_file", "run_tests", "mcp__codex__delete_context"].map((name) => ({ name, arguments: { query: "the user's notes", path: "/etc/passwd", url: "https://example.org/" } }));
    const scripted = scripted_model({ calls: hostile });
    let toolbox: ReturnType<typeof no_builtin_toolbox> | undefined;
    const fetch_spy = vi.spyOn(globalThis, "fetch");
    try {
      const events = await collect(engine_with(scripted.model, settings, { on_toolbox: (given) => (toolbox = given) }).run(asked("Read my files and search the web.", tools), new AbortController().signal));
      expect(events.at(-1)?.type).toBe("done");
      // The harness's own fetch reached only the run's loopback bridge, never the web.
      for (const [target] of fetch_spy.mock.calls) expect(String(target instanceof Request ? target.url : target)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    } finally {
      fetch_spy.mockRestore();
    }
    expect(ran).toEqual([]);
    // The web tools are refused by the tree's acting step itself; the rest reach the stand-in, which refuses them.
    expect(toolbox!.refused).toEqual(["read_file", "list_directory", "write_file", "run_tests", "mcp__codex__delete_context"]);
    const results = scripted.requests.filter((request) => step_of(request) === "findings").flatMap((request) => request.messages.filter((message) => message.role === "tool").map((message) => message.content));
    expect(results).toHaveLength(7);
    expect(results.filter((text) => text.includes(no_builtin_tool))).toHaveLength(5);
    for (const text of results) expect(text).toMatch(/Tool error/);
  });

  it("are served on a loopback bridge only with the run's token, and closed with the run", async () => {
    const bridge = await open_tool_bridge([{ name: "list_contexts", description: "Lists.", parameters: { type: "object", properties: {} } }], async () => ({ result: "Kitchen", is_error: false }));
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(bridge.names).toEqual(["list_contexts"]);
    const listing = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
    const post = (headers: Record<string, string>, path = "/mcp") => fetch(bridge.url.replace("/mcp", path), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(listing) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer not-the-token" })).status).toBe(401);
    expect((await post(bridge.headers, "/other")).status).toBe(404);
    expect((await post(bridge.headers)).status).toBe(200);
    await bridge.close();
    await expect(post(bridge.headers)).rejects.toThrow();
  });
});

// ── Knowledge ────────────────────────────────────────────────────────────────

describe("the SmartHarness engine's knowledge", () => {
  it("is CODEX's alone: the tree is given no knowledge store, agents, skills, files or search", async () => {
    const { load_harness } = await import("../../../src/server/engines/smartharness.ts");
    const harness = await load_harness();
    const seen: unknown[] = [];
    const scripted = scripted_model();
    const load = async () =>
      ({
        ...harness,
        TaskTreeRun: class extends harness.TaskTreeRun {
          constructor(...args: ConstructorParameters<typeof harness.TaskTreeRun>) {
            super(...args);
            seen.push({ store: args[3], agents: this.agents.size, servers: this.mcpServers.map((server) => server.name), writes: this.allowFileWrites, tests: this.enableTestExecution, confirm: this.confirmActions });
          }
        },
      }) as typeof harness;
    const events = await collect(engine_with(scripted.model, settings, { load }).run(asked("Hello", tools_of(["list_contexts"], async () => ({ result: "", is_error: false }))), new AbortController().signal));
    expect(events.at(-1)?.type).toBe("done");
    expect(seen).toEqual([{ store: null, agents: 0, servers: ["codex"], writes: false, tests: false, confirm: false }]);
    // Its file-based instructions and skills are never read: every step's input holds only what CODEX sent.
    for (const request of scripted.requests) expect(JSON.stringify(request.messages)).not.toMatch(/SMARTHARNESS\.md|AGENTS\.md|skills\//);
  });

  it("puts the newest message as the request and as many earlier turns as fit beside CODEX's instructions", () => {
    const long = "x".repeat(longest_earlier_turn * 2);
    const conversation = [
      { role: "user" as const, text: "First question" },
      { role: "assistant" as const, text: long },
      { role: "user" as const, text: "Second question" },
      { role: "assistant" as const, text: "Second answer" },
      { role: "user" as const, text: "  The new message " },
    ];
    const roomy = harness_input({ instructions: "Rules.", conversation }, 16384);
    expect(roomy).toMatchObject({ fits: true, prompt: "The new message", left_out: 0 });
    if (!roomy.fits) throw new Error("expected to fit");
    expect(roomy.instructions).toMatch(/^Rules\.\n\nThe conversation so far, oldest first/);
    expect(roomy.instructions).toContain("The user: First question");
    expect(roomy.instructions).toContain("You (the assistant): Second answer");
    expect(roomy.instructions).toContain("characters left out");
    expect(roomy.instructions.indexOf("First question")).toBeLessThan(roomy.instructions.indexOf("Second question"));

    const tight = harness_input({ instructions: "y".repeat(3000), conversation }, 4096);
    expect(tight).toMatchObject({ fits: true, left_out: 2 });
    expect(harness_input({ instructions: "y".repeat(9000), conversation }, 4096)).toMatchObject({ fits: false, message: expect.stringContaining("Raise the SmartHarness engine's context size") });
    expect(harness_input({ instructions: "", conversation: [] }, 4096)).toMatchObject({ fits: false });
  });
});

// ── Running ──────────────────────────────────────────────────────────────────

describe("the SmartHarness engine", () => {
  let server: FakeOpenAiServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("is bundled off, labelled experimental, local by its endpoint, and kept within what the harness accepts", async () => {
    expect(bundled_plugins.map((plugin) => plugin.id)).toContain("codex.smartharness");
    expect(smartharness_manifest).toMatchObject({ name: "SmartHarness (experimental)", enabled_by_default: false });
    expect(smartharness_manifest.description).toMatch(/^Experimental\./);
    const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: { read: () => ({}), write: () => undefined } });
    await host.add(smartharness_plugin());
    await host.start();
    expect(host.providers("engine")).toEqual([]);

    const local = engine_with(scripted_model().model, { ...settings, endpoint: "http://192.168.1.5:8080/v1" });
    expect([local.label, local.model(), local.is_local?.()]).toEqual(["SmartHarness", "small-model", true]);
    expect(engine_with(scripted_model().model, { ...settings, endpoint: "" }).is_local?.()).toBe(false);
    expect(harness_limits({ context_size: 4096, max_tokens: 9000, max_task_depth: 9, max_task_nodes: 0, max_tool_calls: 11 })).toEqual({ context_size: 4096, max_tokens: 2048, max_task_depth: 2, max_task_nodes: 12, max_tool_calls: 5 });
  });

  it("streams each step as thinking, counts each model call's tokens and ends with a note of how the tree went", async () => {
    const events = await collect(engine_with(scripted_model({ approach: "answer" }).model).run(asked("Say hello", tools_of([], async () => ({ result: "", is_error: false }))), new AbortController().signal));
    const thinking = events.filter((event) => event.type === "reasoning").map((event) => (event as { text: string }).text).join("");
    expect(thinking).toContain("[Task 1 · Deciding]");
    expect(thinking).toContain("[Task 1 · Writing]");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.length).toBeGreaterThanOrEqual(3);
    expect(usage[0]).toEqual({ type: "usage", input_tokens: 100, output_tokens: 10 });
    const notice = events.find((event) => event.type === "notice") as { text: string };
    expect(notice.text).toMatch(/^Answered by SmartHarness's task tree: 1 of 1 task\(s\) met their deliverable, in \d+ model calls\.$/);
    expect(events.slice(-2)).toEqual([
      { type: "text", text: "You have one context, Kitchen." },
      { type: "done", text: "You have one context, Kitchen." },
    ]);
  });

  it("stops soon after the signal aborts, closing its bridge", async () => {
    const stop = new AbortController();
    const scripted = scripted_model({ on_request: () => stop.abort() });
    const events = await collect(engine_with(scripted.model).run(asked("Hello", tools_of(["list_contexts"], async () => ({ result: "", is_error: false }))), stop.signal));
    expect(events.at(-1)).toEqual({ type: "error", message: "Stopped." });
    expect(scripted.requests).toHaveLength(1);
  });

  it("says plainly when it has no model, cannot load SmartHarness, the key command fails or the endpoint fails", async () => {
    const tools = tools_of([], async () => ({ result: "", is_error: false }));
    const signal = new AbortController().signal;
    expect((await collect(engine_with(scripted_model().model, { ...settings, model: "" }).run(asked("Hi", tools), signal))).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("Set the SmartHarness engine's model") });
    const missing = engine_with(scripted_model().model, settings, { load: async () => Promise.reject(new Error("Cannot find package")) });
    expect((await collect(missing.run(asked("Hi", tools), signal))).at(-1)).toMatchObject({ type: "error", message: "SmartHarness is not installed with this copy of CODEX, so its engine cannot answer.", detail: "Cannot find package" });
    const no_key = harness_engine(() => ({ ...settings, api_key_command: "print-key" }), { make: () => scripted_model().model, read: async () => Promise.reject(new Error("exit 1")) });
    expect((await collect(no_key.run(asked("Hi", tools), signal))).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("The API key command failed") });
    const refused: ChatModel = { complete: async () => Promise.reject(Object.assign(new Error("401 bad key sk-abcdefghijkl"), { status: 401 })) };
    const failed = (await collect(engine_with(refused).run(asked("Hi", tools), signal))).at(-1) as { message: string; detail: string };
    expect(failed.message).toBe("The engine at 127.0.0.1:9 refused the API key. Check the API key command under Settings → Assistant → Engine.");
    expect(failed.detail).not.toContain("sk-abcdefghijkl");
    const huge = await collect(engine_with(scripted_model().model, { ...settings, context_size: 2048 }).run(asked("Hi", tools, "z".repeat(5000)), signal));
    expect(huge.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("CODEX's instructions take about") });
  });

  it("answers through an OpenAI-compatible endpoint with each step's JSON schema as the reply format", async () => {
    server = await start_fake_openai((body) => {
      const format = body.response_format as { json_schema?: { schema?: { properties?: Record<string, unknown> } } } | undefined;
      const properties = format?.json_schema?.schema?.properties ?? {};
      if ("approach" in properties) return { text: [JSON.stringify({ reason: "", facts_to_check: [], approach: "answer", search_queries: [], subtasks: [], ...("clarification" in properties ? { clarification: "" } : {}) })] };
      if ("verdict" in properties) return { text: [JSON.stringify({ verdict: "met", problem: "" })] };
      return { text: ["Hello ", "there."] };
    });
    const engine = harness_engine(() => ({ ...settings, endpoint: server!.endpoint }), { read: async () => "" });
    const events = await collect(engine.run(asked("Say hello", tools_of([], async () => ({ result: "", is_error: false }))), new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "done", text: "Hello there." });
    const formats = server.requests.map((request) => (request.body.response_format as { type?: string } | undefined)?.type ?? "none");
    expect(formats).toContain("json_schema");
    expect(formats).toContain("none");
    expect(server.requests.every((request) => request.body.model === "small-model")).toBe(true);
  });

  it("converts the harness's messages and tool calls to CODEX's and back", async () => {
    const seen: ChatRequest[] = [];
    const model = harness_model(
      { complete: async (request) => (seen.push(request), { content: "", tool_calls: [{ id: "c1", name: "mcp__codex__x", arguments: "{}" }], finish_reason: "tool_calls" }) },
      512,
    );
    const answer = await model.createChatCompletion({
      messages: [
        { role: "system", content: "Rules." },
        { role: "user", content: null },
        { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "mcp__codex__x", arguments: "{}" } }] },
        { role: "tool", content: "done", tool_call_id: "c0" },
      ],
      tools: [{ type: "function", function: { name: "mcp__codex__x" } }],
      tool_choice: "none",
    });
    expect(seen[0]).toMatchObject({ max_tokens: 512, messages: [{ role: "system", content: "Rules." }, { role: "user", content: "" }, { role: "assistant", content: "", tool_calls: [{ id: "c0", name: "mcp__codex__x", arguments: "{}" }] }, { role: "tool", tool_call_id: "c0", content: "done" }] });
    expect(seen[0]!.tools).toBeUndefined();
    expect(answer).toEqual({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "mcp__codex__x", arguments: "{}" } }], finish_reason: "tool_calls" });
  });
});

// ── In CODEX ─────────────────────────────────────────────────────────────────

describe("the SmartHarness engine in CODEX", () => {
  it("answers a conversation through the action policy, its calls kept with the reply", async () => {
    const scripted = scripted_model({ calls: [{ name: "mcp__codex__add_context", arguments: { name: "Garden", parent_id: null } }], answer: "I asked to add Garden." });
    const fixture = start_fixture({ plugins: [smartharness_plugin({ make: () => scripted.model, read: async () => "" })] });
    // With specialists off, CODEX's own calls go to the harness as they are.
    fixture.calls.set_setting("plugins", { "codex.smartharness": { enabled: true, settings: { ...settings, specialists: "off" } } });
    fixture.calls.set_setting("engine", "smartharness");
    const { conversation_id } = await fixture.calls.send_message(null, "Add a context called Garden");
    await wait_for_runs();
    const reply = fixture.calls.get_conversation(conversation_id).messages[1]!;
    expect(reply).toMatchObject({ role: "assistant", text: "I asked to add Garden.", engine: "SmartHarness", model: "small-model", error: "" });
    expect(reply.tool_calls.map((call) => [call.name, call.outcome])).toEqual([["add_context", "proposed"]]);
    expect(fixture.calls.list_proposals(conversation_id)).toHaveLength(1);
    expect(fixture.calls.list_contexts().map((context) => context.name)).not.toContain("Garden");
    expect(reply.notices.at(-1)).toMatch(/^Answered by SmartHarness's task tree/);
  });

  it("runs a background job within its limits, stopped once its model calls pass the job's rounds", async () => {
    const scripted = scripted_model({ approach: "answer" });
    const fixture = start_fixture({ plugins: [smartharness_plugin({ make: () => scripted.model, read: async () => "" })] });
    fixture.calls.set_setting("plugins", { "codex.smartharness": { enabled: true, settings } });
    fixture.calls.set_setting("engine", "smartharness");
    const { start_run } = await import("../../../src/shared/conversations/run.ts");
    let ended: { stopped_by: string; rounds: number } | null = null;
    await start_run(fixture.database, null, "Tidy up.", null, { presence: "background", limits: { max_rounds: 1 }, on_end: (end) => (ended = end) });
    await wait_for_runs();
    expect(ended).toMatchObject({ stopped_by: "rounds", rounds: 2 });
  });

  it("works in an isolated research run, offered only that run's tools", async () => {
    const scripted = scripted_model({ calls: [{ name: "mcp__codex__web__web_search", arguments: { query: "cold greenhouses" } }] });
    const fixture = start_fixture({ plugins: [smartharness_plugin({ make: () => scripted.model, read: async () => "" })] });
    fixture.calls.set_setting("plugins", { "codex.smartharness": { enabled: true, settings } });
    fixture.calls.set_setting("engine", "smartharness");
    const { start_run } = await import("../../../src/shared/conversations/run.ts");
    const own = { name: "save_finding", description: "Saves.", parameters: { type: "object", properties: {} }, run: async () => "Saved." };
    await start_run(fixture.database, null, "Research cold greenhouses.", null, { presence: "background", isolated: true, tools: ["save_finding"], own_tools: [own as never] });
    await wait_for_runs();
    expect([...offered_names(scripted.requests)]).toEqual(["mcp__codex__save_finding", "mcp__codex__read_tool_result"]);
    const instructions = scripted.requests.map((request) => request.messages.map((message) => message.content).join("\n")).join("\n");
    expect(instructions).not.toContain("The conversation so far");
  });
});
