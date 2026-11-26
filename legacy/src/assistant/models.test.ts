import { describe, expect, it, vi } from 'vitest';

import { localModelSource } from '@x-tech-laboratories/smartharness/model';
import { AnthropicModel } from './anthropicModel.js';
import { backgroundModelSource, hostedModelSource, mainModelSource } from './models.js';
import { OpenAiModel } from './openaiModel.js';
import { ASSISTANT_DEFAULT_SETTINGS, type AssistantSettings } from './settings.js';

const LOCAL: AssistantSettings = { ...ASSISTANT_DEFAULT_SETTINGS };
const HOSTED: AssistantSettings = {
    ...LOCAL,
    model_provider: 'anthropic',
    model_name: 'claude-opus-5-5',
    model_api_key_command: ['print-key', 'anthropic'],
    context_size: 200_000,
};

describe('mainModelSource', () => {
    it('loads the local GGUF file unless a hosted provider is chosen', () => {
        expect(mainModelSource(LOCAL).key).toBe(localModelSource(LOCAL.model_path, LOCAL.context_size, LOCAL.gpu_layers).key);
        expect(mainModelSource(HOSTED)).toMatchObject({ label: 'claude-opus-5-5 (Anthropic)', contextSize: 200_000 });
    });

    it('reads the key only when the model loads, and builds the provider’s model', async () => {
        const readKey = vi.fn(async () => 'secret-for-test');
        const source = mainModelSource(HOSTED, readKey);
        expect(readKey).not.toHaveBeenCalled();

        expect(await source.load()).toBeInstanceOf(AnthropicModel);
        expect(readKey).toHaveBeenCalledWith(['print-key', 'anthropic']);
    });
});

describe('hostedModelSource', () => {
    it('needs no key command for a local server, and changes its key with any setting', async () => {
        const readKey = vi.fn(async () => 'unused');
        const hosted = { provider: 'openai' as const, endpoint: 'http://localhost:11434/v1', model: 'llama3.1', apiKeyCommand: [], contextSize: 8192 };
        const source = hostedModelSource(hosted, readKey);

        expect(await source.load()).toBeInstanceOf(OpenAiModel);
        expect(readKey).not.toHaveBeenCalled();
        expect(source.label).toBe('llama3.1 (OpenAI-compatible at http://localhost:11434/v1)');
        expect(hostedModelSource({ ...hosted, contextSize: 16384 }).key).not.toBe(source.key);
    });
});

describe('backgroundModelSource', () => {
    it('shares the main model, hosted or not, until a background model of its own is set', () => {
        expect(backgroundModelSource(HOSTED).key).toBe(mainModelSource(HOSTED).key);
        expect(backgroundModelSource({ ...HOSTED, background_model_path: 'small.gguf', background_gpu_layers: 0 }).key).toBe(
            localModelSource('small.gguf', 200_000, 0).key,
        );
    });

    it('runs on a hosted background model with its own context size', () => {
        const settings: AssistantSettings = {
            ...LOCAL,
            background_model_provider: 'openai',
            background_model_name: 'gpt-5-mini',
            background_context_size: 32_768,
        };

        expect(backgroundModelSource(settings)).toMatchObject({ label: 'gpt-5-mini (OpenAI-compatible)', contextSize: 32_768 });
    });
});
