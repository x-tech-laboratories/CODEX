// The direct engine: one model works the whole request in a tool-calling loop, for models able enough not to need a task tree.
import { resolve } from 'node:path';

import { tokenCounter, untrustedBlock } from '@x-tech-laboratories/smartharness/contextBudget';
import { KnowledgeStore } from '@x-tech-laboratories/smartharness/knowledge';
import { MCPToolbox } from '@x-tech-laboratories/smartharness/mcpTools';
import { loadModel, localModelSource, type ChatMessage, type ChatModel, type ToolCall, type ToolDefinition } from '@x-tech-laboratories/smartharness/model';
import { CONTEXT_SIZE, DEFAULT_MODEL_PATH, expandUser, MAX_TASK_NODES, MAX_TOKENS, TEMPERATURE } from '@x-tech-laboratories/smartharness/settings';
import { actionsApproved, declinedActionsNote, RunStopped, type ExecuteTaskTreeOptions, type NodeStatus, type TaskSnapshot } from '@x-tech-laboratories/smartharness/taskTree';
import { ACTION_TOOL_NAMES, MAX_TOOL_OUTPUT_CHARS, Toolbox, ValueError } from '@x-tech-laboratories/smartharness/tools';

import { assistantPrompt } from '../assistant/prompts.js';

// The one step the window shows for a direct run; the prefix is what its step list follows.
export const DIRECT_STEP_LABEL = 'Task 1 · Working';
export const RECALL_TOOL = 'recall';
export const DROPPED_RESULT = '[An earlier tool result was dropped to fit the context.]';
const MAX_RECALLED = 8;

const RECALL_DEFINITION: ToolDefinition = {
    type: 'function',
    function: {
        name: RECALL_TOOL,
        description: "Search the owner's knowledge store: what was researched and remembered before.",
        parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } }, required: ['query'] },
    },
};

const MODE_RULES: Record<string, string> = {
    answer: 'Only answer: never change a file or run anything, even if a tool would let you.',
    draft: 'Only draft: describe what you would change, and never change a file or run anything.',
    auto: 'Change files or run tests only when the request asks for it.',
    execute: 'Carry the request out with the tools you have.',
};

// ============================================================================
// Context
// ============================================================================

// Drop the oldest tool results until the conversation fits beside the reply.
export function fitMessages(messages: ChatMessage[], budget: number, countTokens: (text: string) => number): void {
    const total = () => messages.reduce((sum, message) => sum + countTokens(message.content ?? '') + (message.tool_calls ? countTokens(JSON.stringify(message.tool_calls)) : 0), 0);
    for (const message of messages) {
        if (total() <= budget) {
            return;
        }
        if (message.role === 'tool' && message.content !== DROPPED_RESULT) {
            message.content = DROPPED_RESULT;
        }
    }
}

// The whole run as one task, so the window can show its streamed work like any task's.
export function directTask(prompt: string, status: NodeStatus, result = '', note = ''): TaskSnapshot {
    return { id: '1', parent: null, prompt, deliverable: 'An answer to the request', depends_on: [], status, approach: 'direct', result, result_shortened: false, note, steps: [] };
}

function parseArguments(text: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(text || '{}');
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

// ============================================================================
// Running
// ============================================================================

// Work a request with one model and the tools the settings allow, asking before any tool that changes something.
export async function runDirect(userPrompt: string, options: ExecuteTaskTreeOptions = {}): Promise<string> {
    if (options.resumeRunId !== undefined && options.resumeRunId !== null) {
        throw new ValueError('The direct engine keeps no task tree, so it has no run to resume.');
    }
    const prompt = userPrompt.trim();
    if (!prompt) {
        throw new ValueError('The prompt cannot be empty.');
    }
    const external = (options.trust ?? 'user') === 'external';
    const mode = external ? 'draft' : (options.mode ?? 'auto');
    const acting = mode === 'auto' || mode === 'execute';
    const contextSize = options.contextSize ?? options.modelSource?.contextSize ?? CONTEXT_SIZE;
    const maxTokens = options.maxTokens ?? MAX_TOKENS;
    const maxRounds = options.maxTaskNodes ?? MAX_TASK_NODES;
    const toolbox = new Toolbox(options.filesystemRoot ?? '.', {
        maxSearchResults: options.maxSearchResults ?? 5,
        allowFileWrites: acting && !external && (options.allowFileWrites ?? false),
        enableTestExecution: acting && !external && (options.enableTestExecution ?? false),
    });
    const knowledge = options.knowledgeDbPath ? new KnowledgeStore(resolve(expandUser(options.knowledgeDbPath))) : null;
    const mcp = new MCPToolbox(external || !acting ? [] : (options.mcpServers ?? []));
    const stopped = () => Boolean(options.signal?.aborted || options.shouldStop?.());
    const report = (text: string) => {
        if (stopped()) {
            throw new RunStopped();
        }
        options.stageOutputCallback?.(DIRECT_STEP_LABEL, text);
    };

    const modelSource = options.modelSource ?? localModelSource(options.modelPath ?? DEFAULT_MODEL_PATH, contextSize, options.gpuLayers ?? -1);
    const llm: ChatModel = await loadModel(options.llm, modelSource, options.modelCache ?? null, options.progressCallback ?? undefined);
    await mcp.open();
    options.treeCallback?.([directTask(prompt, 'running')]);
    try {
        const tools = [...toolbox.toolDefinitions, ...(knowledge ? [RECALL_DEFINITION] : []), ...mcp.toolDefinitions];
        const system = assistantPrompt('direct', { TODAY: new Date().toISOString().slice(0, 10), MODE_RULE: MODE_RULES[mode] ?? MODE_RULES.auto });
        const messages: ChatMessage[] = [
            { role: 'system', content: system },
            { role: 'user', content: external ? `Request:\n${untrustedBlock(prompt)}` : prompt },
        ];
        const countTokens = tokenCounter(llm);
        const ask = options.clarificationCallback ?? null;
        let approved = !(options.confirmActions ?? true) || ask === null;
        options.progressCallback?.(DIRECT_STEP_LABEL);
        options.stageInputCallback?.(DIRECT_STEP_LABEL, system, prompt);

        for (let round = 0; round < maxRounds; round += 1) {
            if (stopped()) {
                throw new RunStopped();
            }
            fitMessages(messages, Math.max(200, contextSize - maxTokens), countTokens);
            const lastRound = round === maxRounds - 1;
            const completion = await llm.createChatCompletion({
                messages,
                temperature: options.temperature ?? TEMPERATURE,
                max_tokens: maxTokens,
                tools: lastRound ? undefined : tools,
                on_token: report,
                signal: options.signal ?? undefined,
            });
            if (completion.finish_reason === 'repetition') {
                throw new Error('A model call kept repeating itself, so it was stopped.');
            }
            if (completion.tool_calls.length === 0) {
                const answer = completion.content.trim();
                if (!answer) {
                    throw new Error('The model returned an empty answer.');
                }
                options.treeCallback?.([directTask(prompt, 'done', answer)]);
                return answer;
            }
            messages.push({ role: 'assistant', content: completion.content || null, tool_calls: completion.tool_calls });
            const acts = completion.tool_calls.some((call) => ACTION_TOOL_NAMES.has(call.function.name) || mcp.handles(call.function.name));
            let declined = '';
            if (acts && !approved) {
                const plan = completion.tool_calls.map((call) => `${call.function.name} ${call.function.arguments}`).join('\n');
                const [yes, reply] = await actionsApproved(ask!, plan);
                approved = yes;
                declined = yes ? '' : declinedActionsNote(reply);
            }
            for (const call of completion.tool_calls) {
                report(`\n[${call.function.name}]\n`);
                messages.push({ role: 'tool', tool_call_id: call.id, content: await callTool(call, { toolbox, knowledge, mcp, declined }) });
            }
        }
        throw new Error(`The model was still calling tools after ${maxRounds} rounds; raise Max tasks to give it more.`);
    } catch (error) {
        if (!(error instanceof RunStopped)) {
            options.treeCallback?.([directTask(prompt, 'failed', '', error instanceof Error ? error.message : String(error))]);
        }
        throw error;
    } finally {
        await mcp.close();
    }
}

type Tools = { toolbox: Toolbox; knowledge: KnowledgeStore | null; mcp: MCPToolbox; declined: string };

// Run one call and fence its result, since anyone could have written what a tool returns.
async function callTool(call: ToolCall, { toolbox, knowledge, mcp, declined }: Tools): Promise<string> {
    const name = call.function.name;
    const given = parseArguments(call.function.arguments);
    if (given === null) {
        return 'Tool error: arguments must be a JSON object.';
    }
    if (declined && (ACTION_TOOL_NAMES.has(name) || mcp.handles(name))) {
        return declined;
    }
    let result: string;
    if (name === RECALL_TOOL && knowledge !== null) {
        const query = typeof given.query === 'string' ? given.query.trim() : '';
        result = query ? JSON.stringify(knowledge.search(query, { limit: MAX_RECALLED })) : 'Tool error: recall needs a query.';
    } else if (mcp.handles(name)) {
        result = await mcp.call(name, given);
    } else {
        result = await toolbox.call(name, given);
    }
    return untrustedBlock(result.slice(0, MAX_TOOL_OUTPUT_CHARS));
}
