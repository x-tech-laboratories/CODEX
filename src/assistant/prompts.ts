// The assistant's own prompts, shipped in share/assistant/prompts/ beside the harness ones.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prompt } from '../core/prompts.js';

export const ASSISTANT_PROMPTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'share', 'assistant', 'prompts');

export function assistantPrompt(name: string, values: Record<string, string | number> = {}): string {
    return prompt(name, values, ASSISTANT_PROMPTS_DIRECTORY);
}
