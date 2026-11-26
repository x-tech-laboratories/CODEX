import { describe, expect, it, vi } from 'vitest';

import type { ChatCompletionRequest } from '@x-tech-laboratories/smartharness/model';
import { OpenAiModel, openAiMessages, openAiRequest } from './openaiModel.js';

// ============================================================================
// Helpers
// ============================================================================

type Chunk = { choices: Array<{ finish_reason?: string | null; delta: { content?: string | null; tool_calls?: unknown[] } }> };

function text(content: string, finish_reason: string | null = null): Chunk {
    return { choices: [{ finish_reason, delta: { content } }] };
}

// A client whose stream gives these chunks and records each request.
function streaming(chunks: Chunk[]) {
    const create = vi.fn(async (_body: unknown, _options: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
            yield* chunks;
        },
    }));
    const model = new OpenAiModel({ endpoint: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '', client: { chat: { completions: { create } } } as never });
    return { model, create };
}

const ASK: ChatCompletionRequest = { messages: [{ role: 'user', content: 'Hello' }] };

// ============================================================================
// Conversions
// ============================================================================

describe('openAiMessages', () => {
    it('keeps tool calls and results, and fills empty text', () => {
        const call = { id: 'a', type: 'function' as const, function: { name: 'search', arguments: '{}' } };

        expect(
            openAiMessages([
                { role: 'system', content: null },
                { role: 'assistant', content: null, tool_calls: [call] },
                { role: 'assistant', content: 'Done.' },
                { role: 'tool', tool_call_id: 'a', content: 'found' },
                { role: 'tool', content: null },
            ]),
        ).toEqual([
            { role: 'system', content: '' },
            { role: 'assistant', content: null, tool_calls: [call] },
            { role: 'assistant', content: 'Done.' },
            { role: 'tool', tool_call_id: 'a', content: 'found' },
            { role: 'tool', tool_call_id: '', content: '' },
        ]);
    });
});

describe('openAiRequest', () => {
    it('streams with the harness defaults, a named schema and the tools on offer', () => {
        const tools = [{ type: 'function' as const, function: { name: 'search' } }];
        const schema = { type: 'object', properties: {} };

        const body = openAiRequest('llama3.1', { ...ASK, response_format: { type: 'json_object', schema }, tools });

        expect(body).toMatchObject({ model: 'llama3.1', stream: true, temperature: 0.1, max_tokens: 2048, tools, tool_choice: 'auto' });
        expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reply', schema } });
        expect(openAiRequest('m', { ...ASK, response_format: { type: 'json_object' } }).response_format).toEqual({ type: 'json_object' });
        expect(openAiRequest('m', ASK).tools).toBeUndefined();
    });
});

// ============================================================================
// Model
// ============================================================================

describe('OpenAiModel', () => {
    it('streams the reply to the token callback and reports how it stopped', async () => {
        const { model } = streaming([{ choices: [] }, text('Hel'), text('lo', 'length')]);
        const tokens: string[] = [];

        const completion = await model.createChatCompletion({ ...ASK, on_token: (token) => tokens.push(token) });

        expect(tokens).toEqual(['Hel', 'lo']);
        expect(completion).toEqual({ content: 'Hello', tool_calls: [], finish_reason: 'length' });
    });

    it('joins tool calls streamed in pieces, naming one that came without an id', async () => {
        const { model } = streaming([
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'sea', arguments: '{"q":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'rch', arguments: '"wal"}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'read' } }] }, finish_reason: 'tool_calls' }] },
        ]);

        const completion = await model.createChatCompletion(ASK);

        expect(completion.finish_reason).toBe('tool_calls');
        expect(completion.tool_calls).toEqual([
            { id: 'call_0', type: 'function', function: { name: 'search', arguments: '{"q":"wal"}' } },
            { id: 'b', type: 'function', function: { name: 'read', arguments: '' } },
        ]);
    });

    it('stops a reply that goes round in circles', async () => {
        const loop = "'Twenty-one' rhymes with 'twenty-one'. ";
        const { model, create } = streaming(Array.from({ length: 60 }, () => text(loop)));

        const completion = await model.createChatCompletion(ASK);

        expect(completion.finish_reason).toBe('repetition');
        expect(create.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('stops when the token callback throws, passing its error on', async () => {
        const { model } = streaming([text('First'), text('Second')]);

        await expect(
            model.createChatCompletion({
                ...ASK,
                on_token: () => {
                    throw new Error('Foreground needs the model');
                },
            }),
        ).rejects.toThrow('Foreground needs the model');
    });

    it('gives the caller’s reason when the caller cancels', async () => {
        const cancel = new AbortController();
        const create = vi.fn(async () => {
            cancel.abort(new Error('Cancelled by the user'));
            throw new Error('Request was aborted.');
        });
        const model = new OpenAiModel({ endpoint: '', model: 'm', apiKey: 'key', client: { chat: { completions: { create } } } as never });

        await expect(model.createChatCompletion({ ...ASK, signal: cancel.signal })).rejects.toThrow('Cancelled by the user');
    });

    it('builds its own client when none is given', () => {
        expect(() => new OpenAiModel({ endpoint: 'http://localhost:8080/v1', model: 'm', apiKey: '' })).not.toThrow();
    });
});
