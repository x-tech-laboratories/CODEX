// Ask the model for a blueprint per request shape and count the drafts that pass the code checks, first time and after one repair.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { draftBlueprint, type BlueprintDraft } from './blueprints.js';
import { EVALS_DIRECTORY } from './evaluation.js';
import { loadModel, type ChatModel } from './model.js';
import { defaultSettingsPath, loadSettings } from './settings.js';

export const TASKS_PATH = join(EVALS_DIRECTORY, 'blueprint_requests.json');

// ============================================================================
// Requests and results
// ============================================================================

export type BlueprintTask = { id: string; request: string };

export type TrialRun = BlueprintDraft & { id: string; round: number; seconds: number; error: string | null };

export function loadBlueprintTasks(path: string): BlueprintTask[] {
    const tasks: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const valid = Array.isArray(tasks) && tasks.every((task) => task && typeof task.id === 'string' && typeof task.request === 'string');
    if (!valid) {
        throw new Error(`${path} must be a list of {"id", "request"} objects.`);
    }
    return tasks as BlueprintTask[];
}

// Draft every request once per round, recording a failed call as an error instead of stopping.
export async function runTrial(llm: ChatModel, tasks: BlueprintTask[], rounds: number, useGrammar: boolean): Promise<TrialRun[]> {
    const runs: TrialRun[] = [];
    for (let round = 1; round <= rounds; round++) {
        for (const task of tasks) {
            const started = performance.now();
            try {
                const draft = await draftBlueprint(llm, task.request, undefined, { useGrammar });
                runs.push({ ...draft, id: task.id, round, seconds: (performance.now() - started) / 1000, error: null });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                runs.push({ id: task.id, round, request: task.request, first: null, firstProblems: [], final: null, problems: [], repaired: false, seconds: (performance.now() - started) / 1000, error: message });
            }
            const last = runs.at(-1)!;
            console.log(formatRun(last));
        }
    }
    return runs;
}

// ============================================================================
// Reporting
// ============================================================================

export function formatRun(run: TrialRun): string {
    const head = `[${run.id} round ${run.round}] ${run.seconds.toFixed(1)}s:`;
    if (run.error !== null) {
        return `${head} error: ${run.error}`;
    }
    const first = run.firstProblems.length === 0 ? 'passed first time' : `${run.firstProblems.length} problems first time`;
    const final = !run.repaired ? '' : run.problems.length === 0 ? ', passed after repair' : `, ${run.problems.length} left after repair`;
    const left = run.problems.map((problem) => `\n    - ${problem}`).join('');
    return `${head} ${first}${final}${left}`;
}

export function summarizeTrial(runs: TrialRun[]): { runs: number; errors: number; firstPassed: number; finalPassed: number } {
    const ok = runs.filter((run) => run.error === null);
    return {
        runs: runs.length,
        errors: runs.length - ok.length,
        firstPassed: ok.filter((run) => run.firstProblems.length === 0).length,
        finalPassed: ok.filter((run) => run.problems.length === 0).length,
    };
}

// ============================================================================
// Command line
// ============================================================================

export async function main(argv = process.argv.slice(2)): Promise<number> {
    const { values } = parseArgs({
        args: argv,
        options: {
            tasks: { type: 'string', default: TASKS_PATH },
            settings: { type: 'string', default: defaultSettingsPath() },
            'model-path': { type: 'string' },
            repeat: { type: 'string', default: '1' },
            output: { type: 'string' },
            'no-grammar': { type: 'boolean', default: false },
        },
    });
    const settings = loadSettings(values.settings);
    const tasks = loadBlueprintTasks(values.tasks);
    const llm = await loadModel(null, values['model-path'] ?? settings.model_path, settings.context_size, settings.gpu_layers, null);
    try {
        const runs = await runTrial(llm, tasks, Number(values.repeat), !values['no-grammar']);
        const summary = summarizeTrial(runs);
        console.log(`\n${summary.runs} drafts: ${summary.firstPassed} passed first time, ${summary.finalPassed} after one repair, ${summary.errors} errors.`);
        if (values.output) {
            writeFileSync(values.output, JSON.stringify({ summary, runs }, null, 2) + '\n', 'utf-8');
        }
    } finally {
        await llm.close?.();
    }
    return 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    process.exit(await main());
}
