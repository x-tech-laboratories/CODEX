// A model behind an OpenAI-compatible chat completions endpoint: OpenAI itself, or a server such as Ollama, vLLM or llama-server.
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
    isRepeating,
    REPEAT_CHECK_CHARS,
    type ChatCompletion,
    type ChatCompletionRequest,
    type ChatMessage,
    type ChatModel,
    type FinishReason,
    type ToolCall,
} from '@x-tech-laboratories/smartharness/model';
import { MAX_TOKENS, TEMPERATURE } from '@x-tech-laboratories/smartharness/settings';

export type OpenAiModelOptions = {
    endpoint: string;
    model: string;
    apiKey: string;
    client?: Pick<OpenAI, 'chat'>;
};

// ============================================================================
// Conversions
// ============================================================================

export function openAiMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message): ChatCompletionMessageParam => {
        if (message.role === 'assistant') {
            return {
                role: 'assistant',
                content: message.content,
                ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
            };
        }
        if (message.role === 'tool') {
            return { role: 'tool', tool_call_id: message.tool_call_id ?? '', content: message.content ?? '' };
        }
        return { role: message.role, content: message.content ?? '' };
    });
}

export function openAiRequest(model: string, request: ChatCompletionRequest): ChatCompletionCreateParamsStreaming {
    const body: ChatCompletionCreateParamsStreaming = {
        model,
        messages: openAiMessages(request.messages),
        temperature: request.temperature ?? TEMPERATURE,
        max_tokens: request.max_tokens ?? MAX_TOKENS,
        stream: true,
    };
    if (request.response_format?.schema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema: request.response_format.schema } };
    } else if (request.response_format) {
        body.response_format = { type: 'json_object' };
    }
    if (request.tools?.length) {
        body.tools = request.tools;
        body.tool_choice = request.tool_choice ?? 'auto';
    }
    return body;
}

function finishReason(reason: string | null, toolCalls: ToolCall[]): FinishReason {
    if (toolCalls.length > 0) {
        return 'tool_calls';
    }
    return reason === 'length' ? 'length' : 'stop';
}

// ============================================================================
// Model
// ============================================================================

export class OpenAiModel implements ChatModel {
    private readonly client: Pick<OpenAI, 'chat'>;

    constructor(private readonly options: OpenAiModelOptions) {
        // A local server takes any key, but the client library will not start without one.
        const apiKey = options.apiKey || process.env.OPENAI_API_KEY || 'none';
        this.client = options.client ?? new OpenAI({ baseURL: options.endpoint || undefined, apiKey });
    }

    async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletion> {
        // A token callback that throws stops the call, which is how a waiting run takes the model back.
        const abort = new AbortController();
        const stopFromOutside = () => abort.abort(request.signal?.reason);
        request.signal?.addEventListener('abort', stopFromOutside, { once: true });
        let content = '';
        let checkedLength = 0;
        let reason: string | null = null;
        const calls: ToolCall[] = [];
        try {
            const stream = await this.client.chat.completions.create(openAiRequest(this.options.model, request), { signal: abort.signal });
            for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
                const choice = chunk.choices[0];
                if (choice === undefined) {
                    continue;
                }
                reason = choice.finish_reason ?? reason;
                for (const delta of choice.delta.tool_calls ?? []) {
                    const call = (calls[delta.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
                    call.id = delta.id ?? call.id;
                    call.function.name += delta.function?.name ?? '';
                    call.function.arguments += delta.function?.arguments ?? '';
                }
                const text = choice.delta.content ?? '';
                if (!text) {
                    continue;
                }
                content += text;
                request.on_token?.(text);
                if (content.length - checkedLength >= REPEAT_CHECK_CHARS) {
                    checkedLength = content.length;
                    if (isRepeating(content)) {
                        abort.abort();
                        return { content, tool_calls: [], finish_reason: 'repetition' };
                    }
                }
            }
        } catch (error) {
            abort.abort();
            throw request.signal?.aborted ? (request.signal.reason ?? error) : error;
        } finally {
            request.signal?.removeEventListener('abort', stopFromOutside);
        }
        const toolCalls = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call_${index}` }));
        return { content, tool_calls: toolCalls, finish_reason: finishReason(reason, toolCalls) };
    }
}
