// The direct loop: one chat model works the whole conversation in a tool-calling loop, calling CODEX's tools through
// the request's `call`. Both bundled engines run on it; only how each reaches its model differs.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { EngineEvent, EngineRequest, ToolDefinition } from "./engine.ts";

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

export interface DirectOptions {
  // The model's context window in tokens.
  context_size: number;
  // The longest reply asked for in one round.
  max_tokens: number;
  // Rounds of tool calls before the last, which has no tools.
  max_rounds: number;
}

export const direct_defaults: DirectOptions = { context_size: 8192, max_tokens: 4096, max_rounds: 20 };

// ── Context ──────────────────────────────────────────────────────────────────

export const dropped_result = "[An earlier tool result was dropped to fit the context.]";

// A cautious characters-per-token estimate, since a hosted model does not count for us.
const chars_per_token = 3;

export function count_tokens(text: string): number {
  return Math.ceil(text.length / chars_per_token);
}

function tokens_of(message: ChatMessage): number {
  const calls = message.role === "assistant" && message.tool_calls ? count_tokens(JSON.stringify(message.tool_calls)) : 0;
  return count_tokens(message.content) + calls;
}

// Drops the oldest tool results until the conversation fits beside the reply.
export function fit_messages(messages: ChatMessage[], budget: number): void {
  let total = messages.reduce((sum, message) => sum + tokens_of(message), 0);
  for (const message of messages) {
    if (total <= budget) return;
    if (message.role === "tool" && message.content !== dropped_result) {
      total -= tokens_of(message);
      message.content = dropped_result;
      total += tokens_of(message);
    }
  }
}

function parse_arguments(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Streaming ────────────────────────────────────────────────────────────────

// The text of one completion as it streams, then the completion itself.
async function* streamed(model: ChatModel, request: ChatRequest): AsyncGenerator<string, ChatCompletion> {
  const pieces: string[] = [];
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
        pieces.push(text);
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

// ── Running ──────────────────────────────────────────────────────────────────

export const stopped_message = "Stopped.";

// Works the conversation with one model and CODEX's tools, round by round, until the model answers without a tool.
export async function* run_direct(model: ChatModel, request: EngineRequest, signal: AbortSignal, options: DirectOptions = direct_defaults): AsyncGenerator<EngineEvent> {
  const messages: ChatMessage[] = [{ role: "system", content: request.instructions }, ...request.conversation.map((turn): ChatMessage => (turn.role === "user" ? { role: "user", content: turn.text } : { role: "assistant", content: turn.text }))];
  let said = "";
  try {
    for (let round = 0; round < options.max_rounds; round += 1) {
      if (signal.aborted) throw new Error(stopped_message);
      fit_messages(messages, Math.max(200, options.context_size - options.max_tokens));
      const last_round = round === options.max_rounds - 1;
      const stream = streamed(model, { messages, tools: last_round ? undefined : request.tools.definitions, max_tokens: options.max_tokens, signal });
      let started = false;
      let next = await stream.next();
      while (!next.done) {
        // Text from a later round starts a paragraph of its own.
        const text = !started && said ? `\n\n${next.value}` : next.value;
        started = true;
        said += text;
        yield { type: "text", text };
        next = await stream.next();
      }
      const completion = next.value;
      // A client may end its stream quietly when stopped, which is no answer.
      if (signal.aborted) throw new Error(stopped_message);
      if (completion.usage) yield { type: "usage", ...completion.usage };
      if (completion.finish_reason === "repetition") throw new Error("The model kept repeating itself, so it was stopped.");
      if (completion.tool_calls.length === 0) {
        if (!said.trim()) throw new Error("The model returned an empty answer.");
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
    throw new Error(`The model was still calling tools after ${options.max_rounds} rounds.`);
  } catch (error) {
    yield { type: "error", message: signal.aborted ? stopped_message : error instanceof Error ? error.message : String(error) };
  }
}
