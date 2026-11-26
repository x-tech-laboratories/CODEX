import { describe, expect, it, vi } from 'vitest';

import type { ChatCompletionRequest } from '@x-tech-laboratories/smartharness/model';
import { AnthropicModel, anthropicMessages, anthropicRequest, ModelRefused, structuredSchema } from './anthropicModel.js';

// ============================================================================
// Helpers
// ============================================================================

type Final = { stop_reason: string; stop_details?: { category: string | null } | null; content: Array<Record<string, unknown>> };

function delta(text: string) {
    return { type: 'content_block_delta', delta: { type: 'text_delta', text } };
}

// A client whose stream gives these events and then this final message.
function streaming(events: unknown[], final: Final) {
    const abort = vi.fn();
    const stream = vi.fn((_body: unknown, _options: unknown) => ({
        abort,
        finalMessage: async () => final,
        async *[Symbol.asyncIterator]() {
            yield* events;
        },
    }));
    const model = new AnthropicModel({ endpoint: '', model: 'claude-opus-5-5', apiKey: '', client: { messages: { stream } } as never });
    return { model, stream, abort };
}

const ASK: ChatCompletionRequest = { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }] };

// ============================================================================
// Conversions
// ============================================================================

describe('anthropicMessages', () => {
    it('lifts system text out, turns calls into tool use, and groups results in one user turn', () => {
        const converted = anthropicMessages([
            { role: 'system', content: 'One.' },
            { role: 'user', content: 'Find both' },
            {
                role: 'assistant',
                content: 'Looking.',
                tool_calls: [
                    { id: 'a', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
                    { id: 'b', type: 'function', function: { name: 'search', arguments: 'not json' } },
                ],
            },
            { role: 'tool', tool_call_id: 'a', content: 'first' },
            { role: 'tool', tool_call_id: 'b', content: null },
            { role: 'system', content: 'Two.' },
            { role: 'assistant', content: null },
            { role: 'user', content: 'Thanks' },
            { role: 'tool', content: 'stray' },
        ]);

        expect(converted.system).toBe('One.\n\nTwo.');
        expect(converted.messages).toEqual([
            { role: 'user', content: 'Find both' },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Looking.' },
                    { type: 'tool_use', id: 'a', name: 'search', input: { q: 'x' } },
                    { type: 'tool_use', id: 'b', name: 'search', input: {} },
                ],
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'a', content: 'first' },
                    { type: 'tool_result', tool_use_id: 'b', content: '' },
                ],
            },
            { role: 'user', content: 'Thanks' },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: '', content: 'stray' }] },
        ]);
    });
});

describe('structuredSchema', () => {
    it('closes every object and drops limits structured outputs cannot hold', () => {
        const schema = {
            type: 'object',
            properties: { count: { type: 'integer', minimum: 0 }, tags: { type: 'array', maxItems: 3, items: { type: 'object', properties: {} } } },
            required: ['count'],
        };

        expect(structuredSchema(schema)).toEqual({
            type: 'object',
            properties: { count: { type: 'integer' }, tags: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false } } },
            required: ['count'],
            additionalProperties: false,
        });
        expect(structuredSchema({ anyOf: [{ type: 'string' }, null] })).toEqual({ anyOf: [{ type: 'string' }, null] });
    });
});

describe('anthropicRequest', () => {
    it('sends the schema as an output format and the tools with object schemas, and never a temperature', () => {
        const body = anthropicRequest('claude-opus-5-5', {
            ...ASK,
            temperature: 0.3,
            max_tokens: 500,
            response_format: { type: 'json_object', schema: { type: 'object', properties: {} } },
            tools: [{ type: 'function', function: { name: 'search', description: 'Search', parameters: { properties: { q: { type: 'string' } } } } }],
            tool_choice: 'none',
        });

        expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 500, system: 'Be brief.', tool_choice: { type: 'none' } });
        expect(body).not.toHaveProperty('temperature');
        expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: { type: 'object', properties: {}, additionalProperties: false } } });
        expect(body.tools).toEqual([{ name: 'search', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);
        expect(anthropicRequest('m', { messages: [{ role: 'user', content: 'Hi' }] })).toEqual({ model: 'm', max_tokens: 2048, messages: [{ role: 'user', content: 'Hi' }] });
    });
});

// ============================================================================
// Model
// ============================================================================

describe('AnthropicModel', () => {
    it('streams text to the token callback and returns the final message', async () => {
        const { model, stream } = streaming([{ type: 'message_start' }, delta('Hel'), delta('lo')], {
            stop_reason: 'end_turn',
            content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }],
        });
        const tokens: string[] = [];
        const cancel = new AbortController();

        const completion = await model.createChatCompletion({ ...ASK, signal: cancel.signal, on_token: (token) => tokens.push(token) });

        expect(tokens).toEqual(['Hel', 'lo']);
        expect(completion).toEqual({ content: 'Hello', tool_calls: [], finish_reason: 'stop' });
        expect(stream.mock.calls[0][1]).toEqual({ signal: cancel.signal });
    });

    it('turns tool use into tool calls, and a reply cut short into a length stop', async () => {
        const tools = streaming([], { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'wal' } }] });
        const cut = streaming([], { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial' }] });

        expect(await tools.model.createChatCompletion(ASK)).toEqual({
            content: '',
            tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"q":"wal"}' } }],
            finish_reason: 'tool_calls',
        });
        expect((await cut.model.createChatCompletion(ASK)).finish_reason).toBe('length');
    });

    it('fails a declined request, naming the reason when there is one', async () => {
        const declined = streaming([], { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
        const unexplained = streaming([], { stop_reason: 'refusal', content: [] });

        await expect(declined.model.createChatCompletion(ASK)).rejects.toThrow(new ModelRefused('cyber'));
        await expect(unexplained.model.createChatCompletion(ASK)).rejects.toThrow('The hosted model declined the request.');
    });

    it('stops a reply that goes round in circles', async () => {
        const loop = "'Twenty-one' rhymes with 'twenty-one'. ";
        const { model, abort } = streaming(
            Array.from({ length: 60 }, () => delta(loop)),
            { stop_reason: 'end_turn', content: [] },
        );

        expect((await model.createChatCompletion(ASK)).finish_reason).toBe('repetition');
        expect(abort).toHaveBeenCalled();
    });

    it('stops the stream when the token callback throws, passing its error on', async () => {
        const { model, abort } = streaming([delta('First')], { stop_reason: 'end_turn', content: [] });

        await expect(
            model.createChatCompletion({
                ...ASK,
                on_token: () => {
                    throw new Error('Foreground needs the model');
                },
            }),
        ).rejects.toThrow('Foreground needs the model');
        expect(abort).toHaveBeenCalled();
    });

    it('builds its own client when none is given', () => {
        expect(() => new AnthropicModel({ endpoint: '', model: 'claude-opus-5-5', apiKey: 'test-key' })).not.toThrow();
    });
});
