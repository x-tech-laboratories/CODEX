import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TASKS_PATH, formatRun, loadBlueprintTasks, main, runTrial, summarizeTrial, type TrialRun } from './blueprintTrial.js';
import type { ChatModel } from './model.js';

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-blueprint-trial-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const PASSING = JSON.stringify({
    name: 'n',
    request_shape: 's',
    inputs: [],
    steps: [{ id: 'mail', kind: 'list', source: 'mail', query: 'unread', inputs: [], each: '' }],
    output: 'mail',
});

function run(fields: Partial<TrialRun>): TrialRun {
    return { id: 't', round: 1, request: 'r', first: null, firstProblems: [], final: null, problems: [], repaired: false, seconds: 1.25, error: null, ...fields };
}

describe('blueprint trial', () => {
    it('loads the shipped request shapes and refuses a malformed file', () => {
        expect(loadBlueprintTasks(TASKS_PATH).map((task) => task.id)).toEqual(['folder-categories', 'morning-inbox', 'free-slot', 'weekly-review']);

        const path = join(directory, 'bad.json');
        writeFileSync(path, '[{"id": 1}]', 'utf-8');
        expect(() => loadBlueprintTasks(path)).toThrow(/must be a list/);
    });

    it('drafts each request per round and records a failed call as an error', async () => {
        let calls = 0;
        const llm: ChatModel = {
            async createChatCompletion() {
                calls += 1;
                if (calls === 2) {
                    throw new Error('out of memory');
                }
                return { content: PASSING, tool_calls: [], finish_reason: 'stop' };
            },
        };

        const runs = await runTrial(llm, [{ id: 'a', request: 'x' }], 2, true);

        expect(runs.map((entry) => [entry.round, entry.error])).toEqual([
            [1, null],
            [2, 'out of memory'],
        ]);
        expect(summarizeTrial(runs)).toEqual({ runs: 2, errors: 1, firstPassed: 1, finalPassed: 1 });
    });

    it('runs the trial from the command line, writes the results and closes the model', async () => {
        const tasksPath = join(directory, 'requests.json');
        const outputPath = join(directory, 'out.json');
        writeFileSync(tasksPath, JSON.stringify([{ id: 'a', request: 'x' }]), 'utf-8');
        const close = vi.fn(async () => {});
        const loaded: string[] = [];
        const llm: ChatModel = {
            close,
            async createChatCompletion(request) {
                expect(request.response_format).toBeUndefined();
                return { content: PASSING, tool_calls: [], finish_reason: 'stop' };
            },
        };

        const code = await main(['--tasks', tasksPath, '--model-path', 'spark.gguf', '--repeat', '2', '--output', outputPath, '--no-grammar'], async (path) => {
            loaded.push(path);
            return llm;
        });

        expect(code).toBe(0);
        expect(loaded).toEqual(['spark.gguf']);
        expect(close).toHaveBeenCalledOnce();
        expect(JSON.parse(readFileSync(outputPath, 'utf-8')).summary).toEqual({ runs: 2, errors: 0, firstPassed: 2, finalPassed: 2 });
    });

    it('describes each run in one line plus what is left', () => {
        expect(formatRun(run({}))).toBe('[t round 1] 1.3s: passed first time');
        expect(formatRun(run({ error: 'boom' }))).toBe('[t round 1] 1.3s: error: boom');
        expect(formatRun(run({ firstProblems: ['a', 'b'], repaired: true }))).toBe('[t round 1] 1.3s: 2 problems first time, passed after repair');
        expect(formatRun(run({ firstProblems: ['a'], repaired: true, problems: ['c'] }))).toBe('[t round 1] 1.3s: 1 problems first time, 1 left after repair\n    - c');
    });
});
