// The direct loop: one chat model works the whole conversation in a tool-calling loop, calling CODEX's tools through
// the request's `call`. Both bundled engines run on it; only how each reaches its model differs.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { EngineEvent, EngineRequest, EngineTools, ToolDefinition, ToolSet } from "./engine.ts";
import { calibrate, chars_per_token, fit_request, least_ratio, tighten, type Fit } from "./fitting.ts";

// ── Chat models ──────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  // The arguments as the model wrote them, JSON text.
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type FinishReason = "stop" | "length" | "tool_calls" | "repetition";

export interface ChatRequest {
  messages: ChatMessage[];
  // Left out on the last round, so the model has to answer.
  tools?: ToolDefinition[];
  max_tokens: number;
  signal?: AbortSignal;
  // Each piece of text as it streams in.
  on_text?: (text: string) => void;
  // Each piece of a reasoning model's thinking as it streams in, before its answer.
  on_reasoning?: (text: string) => void;
}

export interface ChatCompletion {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: FinishReason;
  usage?: { input_tokens: number; output_tokens: number };
}

// One call to a model, such as Anthropic's Messages API or an OpenAI-compatible chat completion.
export interface ChatModel {
  complete(request: ChatRequest): Promise<ChatCompletion>;
}

// The engine refused a request as larger than its context, with the size it counted when it said.
export class ContextOverflow extends Error {
  readonly prompt_tokens: number | null;

  constructor(message: string, prompt_tokens: number | null = null) {
    super(message);
    this.name = "ContextOverflow";
    this.prompt_tokens = prompt_tokens;
  }
}

// A failure put in plain words, with the raw detail behind it.
export interface PlainError {
  message: string;
  detail?: string;
}

export class PlainFailure extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "PlainFailure";
    this.detail = detail;
  }
}

export interface DirectOptions {
  // The model's context window in tokens.
  context_size: number;
  // The longest reply asked for in one round; less when less is left.
  max_tokens: number;
  // Rounds of tool calls before the last, which has no tools.
  max_rounds: number;
  // Which tools the model is offered; automatic offers the core set to a context under `core_below` tokens.
  tool_set?: ToolSet;
  // Names the engine and model whose measured characters per token the estimate uses.
  calibration_key?: string;
  // Puts a failure the loop does not know in plain words.
  explain?: (error: unknown) => PlainError;
}

export const direct_defaults: DirectOptions = { context_size: 8192, max_tokens: 4096, max_rounds: 20 };

// Below this context size the automatic tool set is the core one.
export const core_below = 16_384;

// The tools the model is offered for a tool set and context size.
export function offered_tools(tools: EngineTools, tool_set: ToolSet = "auto", context_size: number = direct_defaults.context_size): ToolDefinition[] {
  const core = tool_set === "core" || (tool_set === "auto" && context_size < core_below);
  return core && tools.core ? tools.core : tools.definitions;
}

// ── Arguments ────────────────────────────────────────────────────────────────

function parse_arguments(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Streaming ────────────────────────────────────────────────────────────────

type Piece = { kind: "text" | "reasoning"; text: string };

// The text and thinking of one completion as they stream, then the completion itself.
async function* streamed(model: ChatModel, request: ChatRequest): AsyncGenerator<Piece, ChatCompletion> {
  const pieces: Piece[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  const completion = model
    .complete({
      ...request,
      on_text: (text) => {
        pieces.push({ kind: "text", text });
        nudge();
      },
      on_reasoning: (text) => {
        pieces.push({ kind: "reasoning", text });
        nudge();
      },
    })
    .finally(() => {
      finished = true;
      nudge();
    });
  // Keeps a failure from being reported as unhandled before it is awaited below.
  completion.catch(() => undefined);
  while (true) {
    while (pieces.length > 0) yield pieces.shift()!;
    if (finished) break;
    await new Promise<void>((resolve) => (wake = resolve));
  }
  return completion;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export const stopped_message = "Stopped.";

const count = (value: number) => value.toLocaleString("en");

function too_small_message(context_size: number, fit: Extract<Fit, { fits: false }>, could_use_core: boolean): string {
  const core = could_use_core ? " Choosing the core tool set in the engine's settings also makes room." : "";
  return `This conversation does not fit the model's context of ${count(context_size)} tokens: CODEX's instructions and tools take about ${count(fit.fixed_tokens)} of them, and a reply needs at least ${count(fit.reply_floor)}. Raise the engine's context size under Settings → Assistant → Engine (and on the model's server), or start a new conversation.${core}`;
}

export const too_large_message = "The request was too large for the model's context, even after CODEX cut the conversation down. Raise the engine's context size under Settings → Assistant → Engine (and on the model's server), or start a new conversation.";

function cut_off_message(max_tokens: number, said: boolean, thought: boolean): string {
  if (!said && thought) return `The model spent its whole reply allowance of ${count(max_tokens)} tokens thinking, and wrote no answer. Ask again more simply, or raise the engine's context size to leave more room for replies.`;
  return `The reply was cut off at its limit of ${count(max_tokens)} tokens. Ask for a shorter answer, or raise the engine's context size to leave more room for replies.`;
}

function fit_notices(fit: Extract<Fit, { fits: true }>): [key: string, text: string][] {
  const notices: [string, string][] = [];
  if (fit.left_out > 0) notices.push(["left_out", `${count(fit.left_out)} earlier message${fit.left_out === 1 ? " was" : "s were"} left out of what the model read, to fit its context.`]);
  if (fit.shortened) {
    notices.push(["shortened", `Your message was too long for this model's context, so ${count(fit.shortened.left_out)} of its ${count(fit.shortened.length)} characters, from the middle, were left out of what the model read. Your message is kept whole.`]);
  }
  return notices;
}

function plain_of(error: unknown, options: DirectOptions): PlainError {
  if (error instanceof PlainFailure) return { message: error.message, ...(error.detail ? { detail: error.detail } : {}) };
  if (error instanceof ContextOverflow) return { message: too_large_message, detail: error.message };
  if (options.explain) return options.explain(error);
  return { message: error instanceof Error ? error.message : String(error) };
}

// ── Running ──────────────────────────────────────────────────────────────────

// Works the conversation with one model and CODEX's tools, round by round, until the model answers without a tool.
export async function* run_direct(model: ChatModel, request: EngineRequest, signal: AbortSignal, options: DirectOptions = direct_defaults): AsyncGenerator<EngineEvent> {
  const messages: ChatMessage[] = [{ role: "system", content: request.instructions }, ...request.conversation.map((turn): ChatMessage => (turn.role === "user" ? { role: "user", content: turn.text } : { role: "assistant", content: turn.text }))];
  const key = options.calibration_key ?? "";
  const tools = offered_tools(request.tools, options.tool_set, options.context_size);
  const could_use_core = request.tools.core !== undefined && tools !== request.tools.core;
  const told = new Set<string>();
  let ratio = chars_per_token(key);
  let said = "";
  // A background job may allow fewer rounds than the engine's own limit.
  const max_rounds = Math.max(1, Math.min(options.max_rounds, request.limits?.max_rounds ?? options.max_rounds));
  try {
    for (let round = 0; round < max_rounds; round += 1) {
      if (signal.aborted) throw new Error(stopped_message);
      const offered = round === max_rounds - 1 ? undefined : tools;
      let completion: ChatCompletion | undefined;
      let fit: Extract<Fit, { fits: true }> | undefined;
      let thought = false;
      let started = false;
      // A request the engine finds too large is fitted again once, with the estimate corrected.
      for (let attempt = 0; completion === undefined; attempt += 1) {
        const fitted = fit_request(messages, offered, { context_size: options.context_size, max_tokens: options.max_tokens, chars_per_token: ratio });
        if (!fitted.fits) throw new PlainFailure(too_small_message(options.context_size, fitted, could_use_core));
        fit = fitted;
        for (const [notice, text] of fit_notices(fitted)) {
          if (told.has(notice)) continue;
          told.add(notice);
          yield { type: "notice", text };
        }
        const stream = streamed(model, { messages: fitted.messages, tools: offered, max_tokens: fitted.max_tokens, signal });
        try {
          let next = await stream.next();
          while (!next.done) {
            if (next.value.kind === "reasoning") {
              thought = true;
              yield { type: "reasoning", text: next.value.text };
            } else {
              // Text from a later round starts a paragraph of its own.
              const text = !started && said ? `\n\n${next.value.text}` : next.value.text;
              started = true;
              said += text;
              yield { type: "text", text };
            }
            next = await stream.next();
          }
          completion = next.value;
        } catch (error) {
          if (!(error instanceof ContextOverflow) || attempt > 0 || started || signal.aborted) throw error;
          if (error.prompt_tokens) calibrate(key, fitted.prompt_chars, error.prompt_tokens);
          else tighten(key);
          const measured = error.prompt_tokens ? (fitted.prompt_chars / error.prompt_tokens) * 0.9 : ratio * 0.75;
          ratio = Math.max(least_ratio, Math.min(key ? chars_per_token(key) : ratio, measured));
        }
      }
      // A client may end its stream quietly when stopped, which is no answer.
      if (signal.aborted) throw new Error(stopped_message);
      if (completion.usage) {
        yield { type: "usage", ...completion.usage };
        if (key) {
          calibrate(key, fit!.prompt_chars, completion.usage.input_tokens);
          ratio = chars_per_token(key);
        }
      }
      if (completion.finish_reason === "repetition") throw new PlainFailure("The model kept repeating itself, so it was stopped.");
      if (completion.tool_calls.length === 0) {
        if (completion.finish_reason === "length") throw new PlainFailure(cut_off_message(fit!.max_tokens, started, thought));
        if (!said.trim()) throw new PlainFailure("The model returned an empty answer.");
        yield { type: "done", text: said.trim() };
        return;
      }
      messages.push({ role: "assistant", content: completion.content, tool_calls: completion.tool_calls });
      for (const call of completion.tool_calls) {
        if (signal.aborted) throw new Error(stopped_message);
        const given = parse_arguments(call.arguments);
        yield { type: "tool_call", id: call.id, name: call.name, arguments: given ?? {} };
        const outcome = given === null ? { result: "Tool error: arguments must be a JSON object.", is_error: true } : await request.tools.call(call.name, given);
        yield { type: "tool_result", id: call.id, result: outcome.result, is_error: outcome.is_error };
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.result });
      }
    }
    throw new PlainFailure(`The model was still calling tools after ${max_rounds} rounds.`);
  } catch (error) {
    if (signal.aborted) yield { type: "error", message: stopped_message };
    else yield { type: "error", ...plain_of(error, options) };
  }
}
