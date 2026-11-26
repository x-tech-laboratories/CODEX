// A Claude model through Anthropic's Messages API, using the official SDK, as a chat model for the direct loop.

// ── Imports ──────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";

import type { ChatCompletion, ChatMessage, ChatModel, ChatRequest, ToolCall } from "../../shared/engines/direct.ts";
import { overflow_of } from "./errors.ts";
import { repetition_watch } from "./repetition.ts";

// ── Conversions ──────────────────────────────────────────────────────────────

export class ModelRefused extends Error {
  constructor(category: string | null) {
    super(`The model declined the request${category ? ` (${category})` : ""}.`);
    this.name = "ModelRefused";
  }
}

function tool_input(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// System messages become the system prompt; tool results answer the call before them, grouped in one user turn.
export function anthropic_messages(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const converted: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(message.content);
    else if (message.role === "user") converted.push({ role: "user", content: message.content });
    else if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: tool_input(call.arguments) });
      // An empty turn is left out, since the API refuses one.
      if (content.length > 0) converted.push({ role: "assistant", content });
    } else {
      const result: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content };
      const previous = converted.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content) && previous.content.every((block) => block.type === "tool_result")) previous.content.push(result);
      else converted.push({ role: "user", content: [result] });
    }
  }
  return { system: system.filter(Boolean).join("\n\n"), messages: converted };
}

// The request body; never a temperature, which the newer models refuse.
export function anthropic_request(model: string, request: ChatRequest): Anthropic.MessageStreamParams {
  const { system, messages } = anthropic_messages(request.messages);
  const body: Anthropic.MessageStreamParams = { model, max_tokens: request.max_tokens, messages };
  if (system) body.system = system;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: { ...tool.parameters, type: "object" } }));
    body.tool_choice = { type: "auto" };
  }
  return body;
}

// ── Model ────────────────────────────────────────────────────────────────────

export interface AnthropicModelOptions {
  model: string;
  api_key: string;
  // A client to use instead of the SDK's own, for tests.
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicModel implements ChatModel {
  private readonly client: Pick<Anthropic, "messages">;
  private readonly options: AnthropicModelOptions;

  constructor(options: AnthropicModelOptions) {
    this.options = options;
    // Without a key of its own the client finds one the usual way, such as ANTHROPIC_API_KEY.
    this.client = options.client ?? new Anthropic({ apiKey: options.api_key || undefined });
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const stream = this.client.messages.stream(anthropic_request(this.options.model, request), { signal: request.signal });
    const repeating = repetition_watch();
    let content = "";
    try {
      for await (const event of stream) {
        if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") continue;
        content += event.delta.text;
        request.on_text?.(event.delta.text);
        if (repeating(content)) {
          stream.abort();
          return { content, tool_calls: [], finish_reason: "repetition" };
        }
      }
    } catch (error) {
      stream.abort();
      throw overflow_of(error) ?? error;
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new ModelRefused(message.stop_details?.category ?? null);
    const tool_calls: ToolCall[] = message.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }));
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      content: text,
      tool_calls,
      finish_reason: message.stop_reason === "max_tokens" ? "length" : tool_calls.length > 0 ? "tool_calls" : "stop",
      ...(message.usage ? { usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens } } : {}),
    };
  }
}
