// SmartHarness's task tree as an engine: each message is worked as a tree of small tasks on a model behind an
// OpenAI-compatible endpoint, reached through the `codex.openai` client. The tree acts only through the tools CODEX
// hands the run, served to it as one MCP server on a loopback port; SmartHarness's own web, file and test tools are
// never offered and refuse if called, and it is given no knowledge store, agents, skills or instruction files, so it
// keeps nothing of the user's. SmartHarness is loaded only when a reply is asked for, so CODEX starts without it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";
import type { ChatCompletion as HarnessCompletion, ChatCompletionRequest, ChatModel as HarnessModel } from "@x-tech-laboratories/smartharness/model";
import type { Section } from "@x-tech-laboratories/smartharness/contextBudget";
import type { McpServerSettings } from "@x-tech-laboratories/smartharness/settings";
import type { Toolbox } from "@x-tech-laboratories/smartharness/tools";

import type { ContextPlugin, ContextPluginApi } from "../../shared/collectors/host.ts";
import { chosen_request, offered_tools, stopped_message, type ChatMessage, type ChatModel } from "../../shared/engines/direct.ts";
import type { Engine, EngineEvent, EngineRequest, EngineTurn, ToolDefinition, ToolSet } from "../../shared/engines/engine.ts";
import { is_local_endpoint } from "../../shared/engines/hosting.ts";
import { smartharness_engine_id, smartharness_manifest } from "../../shared/engines/manifests.ts";
import { explain_failure, key_command_failure } from "./errors.ts";
import { default_endpoints, list_openai_models, listed_models, make_openai, specialists_of, without_key, type ModelLister, type ModelMaker } from "./index.ts";
import { plugin_key, read_secret, type SecretReader } from "./secret_command.ts";
import { open_tool_bridge, type ToolBridge } from "./tool_bridge.ts";

export type HarnessModule = typeof import("@x-tech-laboratories/smartharness/taskTree");

// SmartHarness's task tree module, imported on first use.
export const load_harness = (): Promise<HarnessModule> => import("@x-tech-laboratories/smartharness/taskTree");

export const engine_label = "SmartHarness";

// The name CODEX's tools go by in the tree: SmartHarness offers them as mcp__codex__<name>.
export const bridge_name = "codex";

// What the run's stand-in for SmartHarness's built-in tools says when the tree tries one anyway.
export const no_builtin_tool = "Tool error: SmartHarness's own tools are off in CODEX; only CODEX's tools, named mcp__codex__…, can be used.";

// ── Input ────────────────────────────────────────────────────────────────────

// SmartHarness puts its instructions in every model call beside each step's own input, so they and the conversation so
// far may take this share of the context, at CODEX's estimate of 2.5 characters a token.
export const instructions_share = 0.4;
const chars_per_token = 2.5;
// The longest an earlier message is kept, shortened in its middle.
export const longest_earlier_turn = 1500;

export type HarnessInput = { fits: true; prompt: string; instructions: string; left_out: number } | { fits: false; message: string };

function shortened(text: string, most: number): string {
  if (text.length <= most) return text;
  const half = Math.floor((most - 40) / 2);
  return `${text.slice(0, half)}\n[… ${(text.length - half * 2).toLocaleString("en")} characters left out …]\n${text.slice(-half)}`;
}

function turn_line(turn: EngineTurn): string {
  return `${turn.role === "user" ? "The user" : "You (the assistant)"}: ${shortened(turn.text.trim(), longest_earlier_turn)}`;
}

// The newest message as the tree's request, and CODEX's instructions followed by as many earlier turns as fit, newest
// kept first, each shortened to the longest an earlier message is kept.
export function harness_input(request: Pick<EngineRequest, "instructions" | "conversation">, context_size: number): HarnessInput {
  const room = Math.floor(context_size * chars_per_token * instructions_share);
  const instructions = request.instructions.trim();
  const newest = request.conversation.at(-1);
  if (!newest || newest.role !== "user" || !newest.text.trim()) return { fits: false, message: "There is no message to answer." };
  if (instructions.length > room) {
    const tokens = Math.ceil(instructions.length / chars_per_token);
    return {
      fits: false,
      message: `CODEX's instructions take about ${tokens.toLocaleString("en")} tokens, more than SmartHarness can carry into each of its steps with a context of ${context_size.toLocaleString("en")} tokens. Raise the SmartHarness engine's context size under Settings → Assistant → Engine (and on the model's server).`,
    };
  }
  const earlier = request.conversation.slice(0, -1);
  const kept: string[] = [];
  const heading = "The conversation so far, oldest first, for what the user's new message refers to:";
  let used = instructions.length + heading.length + 4;
  for (const turn of [...earlier].reverse()) {
    if (!turn.text.trim()) continue;
    const line = turn_line(turn);
    if (used + line.length + 2 > room) break;
    kept.unshift(line);
    used += line.length + 2;
  }
  const history = kept.length > 0 ? `\n\n${heading}\n\n${kept.join("\n\n")}` : "";
  return { fits: true, prompt: newest.text.trim(), instructions: `${instructions}${history}`.trim(), left_out: earlier.filter((turn) => turn.text.trim()).length - kept.length };
}

// ── Model ────────────────────────────────────────────────────────────────────

export interface ModelHooks {
  on_usage?: (usage: { input_tokens: number; output_tokens: number }) => void;
  on_reasoning?: (text: string) => void;
}

function codex_messages(messages: ChatCompletionRequest["messages"]): ChatMessage[] {
  return messages.map((message): ChatMessage => {
    const content = message.content ?? "";
    if (message.role === "tool") return { role: "tool", tool_call_id: message.tool_call_id ?? "", content };
    if (message.role === "assistant") {
      const calls = (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }));
      return { role: "assistant", content, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
    }
    return { role: message.role, content };
  });
}

// CODEX's chat model as SmartHarness's: the same client, with each step's JSON schema sent as the reply's format.
export function harness_model(model: ChatModel, max_tokens: number, hooks: ModelHooks = {}): HarnessModel {
  return {
    async createChatCompletion(request: ChatCompletionRequest): Promise<HarnessCompletion> {
      const tools: ToolDefinition[] | undefined =
        request.tool_choice === "none" || !request.tools?.length
          ? undefined
          : request.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description ?? "", parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as ToolDefinition["parameters"] }));
      const schema = request.response_format?.schema;
      const completion = await model.complete({
        messages: codex_messages(request.messages),
        ...(tools ? { tools } : {}),
        max_tokens: request.max_tokens ?? max_tokens,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.on_token ? { on_text: request.on_token } : {}),
        ...(hooks.on_reasoning ? { on_reasoning: hooks.on_reasoning } : {}),
        ...(schema ? { json_schema: schema } : {}),
      });
      if (completion.usage) hooks.on_usage?.(completion.usage);
      return {
        content: completion.content,
        tool_calls: completion.tool_calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })),
        finish_reason: completion.finish_reason,
      };
    },
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

// What the tree is given in place of SmartHarness's own toolbox: no tools, no files, and a refusal for any it names,
// with the attempts kept so a test can see none ran. Its automatic web search finds nothing.
export function no_builtin_toolbox(): Toolbox & { refused: string[] } {
  const refused: string[] = [];
  const stand_in = {
    root: "(none: this run has no files, only CODEX's tools)",
    usedTools: new Set<string>(),
    actionLog: [],
    pathsSeen: [],
    toolDefinitions: [],
    refused,
    call: async (name: string) => {
      refused.push(name);
      return name === "web_search" ? "[]" : no_builtin_tool;
    },
  };
  return stand_in as unknown as Toolbox & { refused: string[] };
}

// The one connected server the tree may use: CODEX's tools for this run, on the run's own bridge.
export function bridge_settings(bridge: ToolBridge): McpServerSettings {
  return { name: bridge_name, enabled: true, transport: "http", url: bridge.url, headers: bridge.headers, allowed_tools: bridge.names };
}

// ── Events ───────────────────────────────────────────────────────────────────

// Events pushed from the tree's callbacks, read in order by the engine's stream until closed. One pushed with `handed`
// settles once the stream's reader has taken it in and asked for the next, so a tool call is on the run's record
// before CODEX's policy decides it.
class EventQueue {
  private readonly items: { event: EngineEvent; taken?: () => void }[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(event: EngineEvent): void {
    if (this.closed) return;
    this.items.push({ event });
    this.nudge();
  }

  handed(event: EngineEvent): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((taken) => {
      this.items.push({ event, taken });
      this.nudge();
    });
  }

  close(): void {
    this.closed = true;
    this.nudge();
  }

  private nudge(): void {
    this.wake?.();
    this.wake = null;
  }

  async *drain(): AsyncGenerator<EngineEvent> {
    try {
      while (true) {
        while (this.items.length > 0) {
          const item = this.items.shift()!;
          yield item.event;
          item.taken?.();
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    } finally {
      // A reader that stopped early leaves no tool call waiting on it.
      this.closed = true;
      for (const item of this.items.splice(0)) item.taken?.();
    }
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

function tool_set_of(value: unknown): ToolSet {
  return value === "core" || value === "all" ? value : "auto";
}

function whole_of(value: unknown, fallback: number, least: number, most: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= least && number <= most ? number : fallback;
}

// The engine's limits from its settings, each kept within what SmartHarness accepts.
export function harness_limits(values: SettingValues): { context_size: number; max_tokens: number; max_task_depth: number; max_task_nodes: number; max_tool_calls: number } {
  const context_size = whole_of(values.context_size, 8192, 2048, 2_000_000);
  return {
    context_size,
    max_tokens: Math.min(whole_of(values.max_tokens, 2048, 256, 32_768), Math.floor(context_size / 2)),
    max_task_depth: whole_of(values.max_task_depth, 2, 0, 6),
    max_task_nodes: whole_of(values.max_task_nodes, 12, 1, 60),
    max_tool_calls: whole_of(values.max_tool_calls, 5, 1, 10),
  };
}

export interface HarnessEngineOptions {
  make?: ModelMaker;
  read?: SecretReader;
  load?: () => Promise<HarnessModule>;
  // How its endpoint's models are listed, for tests.
  list?: ModelLister;
  // Hears the stand-in toolbox of each run, for tests.
  on_toolbox?: (toolbox: ReturnType<typeof no_builtin_toolbox>) => void;
}

// The task tree's run, kept from the user's own skill files and from SmartHarness's web search.
function codex_run_class(harness: HarnessModule) {
  return class CodexTaskTreeRun extends harness.TaskTreeRun {
    override skillsFor(): [guides: string, lessons: string] {
      return ["", ""];
    }

    override async search(): Promise<[Section[], boolean]> {
      return [[], false];
    }
  };
}

function failure_of(error: unknown, where: { endpoint: string; default_endpoint: string; model: string }): { message: string; detail?: string } {
  const name = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  const text = error instanceof Error ? error.message : String(error);
  // The harness's own refusals, such as a setting it does not accept, are already plain.
  if (name === "ValueError" || text.startsWith("Failed to start an MCP server")) return { message: `SmartHarness stopped: ${text}` };
  return explain_failure(error, where);
}

export function harness_engine(settings: () => SettingValues, options: HarnessEngineOptions = {}): Engine {
  const make = options.make ?? make_openai;
  const read = options.read ?? read_secret;
  const load = options.load ?? load_harness;
  const list = options.list ?? list_openai_models;
  const model = () => String(settings().model ?? "").trim();
  return {
    label: engine_label,
    model,
    is_local: () => is_local_endpoint(String(settings().endpoint ?? "")),
    list_models: (signal) => listed_models(smartharness_manifest.id, settings(), list, read, signal),
    async *run(request: EngineRequest, signal: AbortSignal): AsyncGenerator<EngineEvent> {
      const values = settings();
      if (!model()) {
        yield { type: "error", message: "Set the SmartHarness engine's model under Settings → Assistant → Engine." };
        return;
      }
      let harness: HarnessModule;
      try {
        harness = await load();
      } catch (error) {
        yield { type: "error", message: "SmartHarness is not installed with this copy of CODEX, so its engine cannot answer.", detail: error instanceof Error ? error.message : String(error) };
        return;
      }
      let api_key: string;
      try {
        api_key = await plugin_key(smartharness_manifest.id, String(values.api_key_command ?? ""), read);
      } catch (error) {
        yield { type: "error", ...key_command_failure(error) };
        return;
      }
      const limits = harness_limits(values);
      const chosen = chosen_request(request, specialists_of(values.specialists), limits.context_size);
      const input = harness_input({ instructions: chosen.instructions, conversation: request.conversation }, limits.context_size);
      if (!input.fits) {
        yield { type: "error", message: input.message };
        return;
      }
      const endpoint = String(values.endpoint ?? "").trim();
      const where = { endpoint, default_endpoint: default_endpoints["OpenAI-compatible"] ?? "", model: model() };
      const queue = new EventQueue();
      let model_calls = 0;
      let tool_calls = 0;
      const offered = offered_tools(chosen.tools, tool_set_of(values.tool_set), limits.context_size, chosen.instructions);
      let bridge: ToolBridge | null = null;
      try {
        if (input.left_out > 0) yield { type: "notice", text: `The ${input.left_out === 1 ? "oldest message was" : `${input.left_out.toLocaleString("en")} oldest messages were`} left out of what SmartHarness read, to fit its context.` };
        if (offered.length > 0) {
          bridge = await open_tool_bridge(offered, async (name, args) => {
            tool_calls += 1;
            const id = `smartharness_${tool_calls}`;
            await queue.handed({ type: "tool_call", id, name, arguments: args });
            const outcome = await request.tools.call(name, args);
            queue.push({ type: "tool_result", id, result: outcome.result, is_error: outcome.is_error });
            return outcome;
          });
        }
        const llm = harness_model(make(values, api_key), limits.max_tokens, {
          on_usage: (usage) => {
            model_calls += 1;
            queue.push({ type: "usage", ...usage });
          },
          on_reasoning: (text) => queue.push({ type: "reasoning", text }),
        });
        const toolbox = no_builtin_toolbox();
        options.on_toolbox?.(toolbox);
        let step = "";
        const CodexRun = codex_run_class(harness);
        const run = new CodexRun(input.prompt, llm, toolbox, null, new Set(), {
          contextSize: limits.context_size,
          maxTokens: limits.max_tokens,
          maxToolCalls: limits.max_tool_calls,
          maxTaskDepth: limits.max_task_depth,
          maxTaskNodes: limits.max_task_nodes,
          allowFileWrites: false,
          enableTestExecution: false,
          mcpServers: bridge ? [bridge_settings(bridge)] : [],
          mode: "auto",
          trust: "user",
          instructions: input.instructions,
          confirmActions: false,
          clarificationCallback: null,
          agents: new Map(),
          signal,
          // Each step's name and what it writes stream as the reply's thinking, so the pane shows what the tree does.
          progressCallback: (label) => {
            step = label;
            queue.push({ type: "reasoning", text: `\n[${label}]\n` });
          },
          stageOutputCallback: (label, token) => {
            if (label !== step) {
              step = label;
              queue.push({ type: "reasoning", text: `\n[${label}]\n` });
            }
            queue.push({ type: "reasoning", text: token });
          },
        });
        let answer: string | null = null;
        let failure: unknown = null;
        const working = run.run().then(
          (text) => void (answer = text),
          (error: unknown) => void (failure = error),
        );
        void working.finally(() => queue.close());
        for await (const event of queue.drain()) yield without_key(event, api_key);
        await working;
        if (signal.aborted || failure instanceof harness.RunStopped) {
          yield { type: "error", message: stopped_message };
          return;
        }
        if (failure !== null) {
          yield without_key({ type: "error", ...failure_of(failure, where) }, api_key);
          return;
        }
        const text = String(answer ?? "").trim();
        if (!text) {
          yield { type: "error", message: "SmartHarness's task tree finished without an answer." };
          return;
        }
        const calls = `${model_calls.toLocaleString("en")} model ${model_calls === 1 ? "call" : "calls"}`;
        yield { type: "notice", text: `Answered by SmartHarness's task tree: ${run.outcome()}, in ${calls}.` };
        yield { type: "text", text };
        yield { type: "done", text };
      } catch (error) {
        yield signal.aborted ? { type: "error", message: stopped_message } : without_key({ type: "error", ...failure_of(error, where) }, api_key);
      } finally {
        await bridge?.close();
      }
    },
  };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function smartharness_plugin(options: HarnessEngineOptions = {}): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...smartharness_manifest,
    start: (context) => context.provide("engine", smartharness_engine_id, harness_engine(() => context.settings(), options)),
  });
}
