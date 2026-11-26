// A Claude model through Anthropic's Messages API, using the official SDK.
import Anthropic from '@anthropic-ai/sdk';

import {
    isRepeating,
    REPEAT_CHECK_CHARS,
    type ChatCompletion,
    type ChatCompletionRequest,
    type ChatMessage,
    type ChatModel,
    type ToolCall,
} from '@x-tech-laboratories/smartharness/model';
import { MAX_TOKENS } from '@x-tech-laboratories/smartharness/settings';

export type AnthropicModelOptions = {
    endpoint: string;
    model: string;
    apiKey: string;
    client?: Pick<Anthropic, 'messages'>;
};

export class ModelRefused extends Error {
    constructor(category: string | null) {
        super(`The hosted model declined the request${category ? ` (${category})` : ''}.`);
        this.name = 'ModelRefused';
    }
}

// Schema keywords structured outputs cannot hold, which the harness checks itself after the reply.
const UNSUPPORTED_KEYWORDS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'default']);

// ============================================================================
// Conversions
// ============================================================================

// Structured outputs want every object closed and no numeric or length limits.
export function structuredSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(structuredSchema);
    }
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        if (UNSUPPORTED_KEYWORDS.has(key)) {
            continue;
        }
        if (key === 'properties' && value && typeof value === 'object') {
            result.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, structuredSchema(child)]));
        } else {
            result[key] = typeof value === 'object' ? structuredSchema(value) : value;
        }
    }
    if (result.type === 'object') {
        result.additionalProperties = false;
    }
    return result;
}

function toolInput(argumentsText: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(argumentsText);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// System messages become the system prompt; tool results answer the call before them, grouped in one user turn.
export function anthropicMessages(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
    const system: string[] = [];
    const converted: Anthropic.MessageParam[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            system.push(message.content ?? '');
        } else if (message.role === 'user') {
            converted.push({ role: 'user', content: message.content ?? '' });
        } else if (message.role === 'assistant') {
            const content: Anthropic.ContentBlockParam[] = [];
            if (message.content) {
                content.push({ type: 'text', text: message.content });
            }
            for (const call of message.tool_calls ?? []) {
                content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: toolInput(call.function.arguments) });
            }
            // An empty turn is left out, since the API refuses one.
            if (content.length > 0) {
                converted.push({ role: 'assistant', content });
            }
        } else {
            const result: Anthropic.ToolResultBlockParam = { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content ?? '' };
            const previous = converted.at(-1);
            if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((block) => block.type === 'tool_result')) {
                previous.content.push(result);
            } else {
                converted.push({ role: 'user', content: [result] });
            }
        }
    }
    return { system: system.filter(Boolean).join('\n\n'), messages: converted };
}

export function anthropicRequest(model: string, request: ChatCompletionRequest): Anthropic.MessageStreamParams {
    const { system, messages } = anthropicMessages(request.messages);
    const body: Anthropic.MessageStreamParams = { model, max_tokens: request.max_tokens ?? MAX_TOKENS, messages };
    if (system) {
        body.system = system;
    }
    if (request.response_format?.schema) {
        body.output_config = { format: { type: 'json_schema', schema: structuredSchema(request.response_format.schema) as Record<string, unknown> } };
    }
    if (request.tools?.length) {
        body.tools = request.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: { type: 'object', ...tool.function.parameters },
        }));
        body.tool_choice = { type: request.tool_choice === 'none' ? 'none' : 'auto' };
    }
    return body;
}

// ============================================================================
// Model
// ============================================================================

export class AnthropicModel implements ChatModel {
    private readonly client: Pick<Anthropic, 'messages'>;

    constructor(private readonly options: AnthropicModelOptions) {
        // Without a key of its own the client finds one the usual way, such as ANTHROPIC_API_KEY.
        this.client = options.client ?? new Anthropic({ apiKey: options.apiKey || undefined, baseURL: options.endpoint || undefined });
    }

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        const stream = this.client.messages.stream(anthropicRequest(this.options.model, request), { signal: request.signal });
        let content = '';
        let checkedLength = 0;
        try {
            for await (const event of stream) {
                if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
                    continue;
                }
                content += event.delta.text;
                // A token callback that throws stops the call, which is how a waiting run takes the model back.
                request.on_token?.(event.delta.text);
                if (content.length - checkedLength >= REPEAT_CHECK_CHARS) {
                    checkedLength = content.length;
                    if (isRepeating(content)) {
                        stream.abort();
                        return { content, tool_calls: [], finish_reason: 'repetition' };
                    }
                }
            }
        } catch (error) {
            stream.abort();
            throw error;
        }
        const message = await stream.finalMessage();
        if (message.stop_reason === 'refusal') {
            throw new ModelRefused(message.stop_details?.category ?? null);
        }
        const toolCalls: ToolCall[] = message.content
            .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
            .map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }));
        const text = message.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
        return {
            content: text,
            tool_calls: toolCalls,
            finish_reason: message.stop_reason === 'max_tokens' ? 'length' : toolCalls.length > 0 ? 'tool_calls' : 'stop',
        };
    }
}
