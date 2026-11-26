// Which model a request and background work run on: a local GGUF file, or a hosted one the settings name.
import { localModelSource, type ChatModel, type ModelSource } from '@x-tech-laboratories/smartharness/model';

import { AnthropicModel } from './anthropicModel.js';
import { OpenAiModel } from './openaiModel.js';
import { readSecret, type SecretReader } from './secretCommand.js';
import type { AssistantSettings as Settings, ModelProvider } from './settings.js';

export type HostedModel = {
    provider: Exclude<ModelProvider, 'local'>;
    endpoint: string;
    model: string;
    apiKeyCommand: string[];
    contextSize: number;
};

const PROVIDER_NAMES: Record<HostedModel['provider'], string> = { openai: 'OpenAI-compatible', anthropic: 'Anthropic' };

// The key is read when the model loads, so it lives only in memory and only while the model does.
export function hostedModelSource(hosted: HostedModel, readKey: SecretReader = readSecret): ModelSource {
    const { provider, endpoint, model, apiKeyCommand, contextSize } = hosted;
    return {
        key: JSON.stringify([provider, endpoint, model, apiKeyCommand, contextSize]),
        label: `${model} (${PROVIDER_NAMES[provider]}${endpoint ? ` at ${endpoint}` : ''})`,
        contextSize,
        load: async (): Promise<ChatModel> => {
            const apiKey = apiKeyCommand.length > 0 ? await readKey(apiKeyCommand) : '';
            return provider === 'anthropic' ? new AnthropicModel({ endpoint, model, apiKey }) : new OpenAiModel({ endpoint, model, apiKey });
        },
    };
}

// The model a request runs on.
export function mainModelSource(settings: Settings, readKey: SecretReader = readSecret): ModelSource {
    if (settings.model_provider === 'local') {
        return localModelSource(settings.model_path, settings.context_size, settings.gpu_layers);
    }
    return hostedModelSource(
        {
            provider: settings.model_provider,
            endpoint: settings.model_endpoint,
            model: settings.model_name,
            apiKeyCommand: settings.model_api_key_command,
            contextSize: settings.context_size,
        },
        readKey,
    );
}

// The model background work and mail run on; a local provider with no path of its own shares the main model.
export function backgroundModelSource(settings: Settings, readKey: SecretReader = readSecret): ModelSource {
    const contextSize = settings.background_context_size || settings.context_size;
    if (settings.background_model_provider !== 'local') {
        return hostedModelSource(
            {
                provider: settings.background_model_provider,
                endpoint: settings.background_model_endpoint,
                model: settings.background_model_name,
                apiKeyCommand: settings.background_model_api_key_command,
                contextSize,
            },
            readKey,
        );
    }
    if (!settings.background_model_path) {
        return mainModelSource(settings, readKey);
    }
    return localModelSource(settings.background_model_path, contextSize, settings.background_gpu_layers);
}
