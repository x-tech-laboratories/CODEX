// A model behind an OpenAI-compatible chat completions endpoint: OpenAI itself, or a server such as Ollama, vLLM or
// llama-server, as a chat model for the direct loop.

// ── Imports ──────────────────────────────────────────────────────────────────

import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { ChatCompletion, ChatMessage, ChatModel, ChatRequest, FinishReason, ToolCall } from "../../shared/engines/direct.ts";
import { overflow_of } from "./errors.ts";
import { repetition_watch } from "./repetition.ts";

// ── Conversions ──────────────────────────────────────────────────────────────

const temperature = 0.1;

export function openai_messages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    if (message.role === "assistant") {
      const tool_calls = (message.tool_calls ?? []).map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }));
      return { role: "assistant", content: message.content || null, ...(tool_calls.length > 0 ? { tool_calls } : {}) };
    }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
    return { role: message.role, content: message.content };
  });
}

export function openai_request(model: string, request: ChatRequest): ChatCompletionCreateParamsStreaming {
  const body: ChatCompletionCreateParamsStreaming = {
    model,
    messages: openai_messages(request.messages),
    temperature,
    max_tokens: request.max_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  // llama.cpp's server and Ollama hold the reply to the schema as a grammar.
  if (request.json_schema) body.response_format = { type: "json_schema", json_schema: { name: "reply", schema: request.json_schema } };
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    body.tool_choice = "auto";
  }
  return body;
}

function finish_reason(reason: string | null, tool_calls: ToolCall[]): FinishReason {
  if (tool_calls.length > 0) return "tool_calls";
  return reason === "length" ? "length" : "stop";
}

// A reasoning model's thinking, which llama-server and others stream as `reasoning_content` beside the answer; the
// SDK's types name no such field.
type ReasoningDelta = { reasoning_content?: string | null };

// ── Model ────────────────────────────────────────────────────────────────────

export interface OpenAiModelOptions {
  endpoint: string;
  model: string;
  api_key: string;
  // A client to use instead of the SDK's own, for tests.
  client?: Pick<OpenAI, "chat">;
}

export class OpenAiModel implements ChatModel {
  private readonly client: Pick<OpenAI, "chat">;
  private readonly options: OpenAiModelOptions;

  constructor(options: OpenAiModelOptions) {
    this.options = options;
    // A local server takes any key, but the client library will not start without one.
    this.client = options.client ?? new OpenAI({ baseURL: options.endpoint || undefined, apiKey: options.api_key || "none" });
  }

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    const abort = new AbortController();
    const stop_from_outside = () => abort.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", stop_from_outside, { once: true });
    const repeating = repetition_watch();
    let content = "";
    let reason: string | null = null;
    let usage: ChatCompletion["usage"];
    const calls: ToolCall[] = [];
    try {
      const stream = await this.client.chat.completions.create(openai_request(this.options.model, request), { signal: abort.signal });
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens, output_tokens: chunk.usage.completion_tokens };
        const choice = chunk.choices[0];
        if (choice === undefined) continue;
        reason = choice.finish_reason ?? reason;
        for (const delta of choice.delta.tool_calls ?? []) {
          const call = (calls[delta.index] ??= { id: "", name: "", arguments: "" });
          call.id = delta.id ?? call.id;
          call.name += delta.function?.name ?? "";
          call.arguments += delta.function?.arguments ?? "";
        }
        const thinking = (choice.delta as ReasoningDelta).reasoning_content;
        if (thinking) request.on_reasoning?.(thinking);
        const text = choice.delta.content ?? "";
        if (!text) continue;
        content += text;
        request.on_text?.(text);
        if (repeating(content)) {
          abort.abort();
          return { content, tool_calls: [], finish_reason: "repetition" };
        }
      }
    } catch (error) {
      abort.abort();
      throw request.signal?.aborted ? (request.signal.reason ?? error) : (overflow_of(error) ?? error);
    } finally {
      request.signal?.removeEventListener("abort", stop_from_outside);
    }
    const tool_calls = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
    return { content, tool_calls, finish_reason: finish_reason(reason, tool_calls), ...(usage ? { usage } : {}) };
  }
}
