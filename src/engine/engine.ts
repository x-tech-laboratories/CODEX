// The engine that works a request: SmartHarness's task tree, or one direct tool-calling loop on any model.
import type { TreeRunner } from '@x-tech-laboratories/smartharness/events';
import { executeTaskTree } from '@x-tech-laboratories/smartharness/taskTree';

import type { AssistantSettings as Settings, EngineName } from '../assistant/settings.js';
import { runDirect } from './directEngine.js';

// What an engine shows beyond its answer, so interfaces leave out what it does not have.
export type EngineFeatures = {
    // It reports a task tree as it works.
    task_tree: boolean;
    // A run it leaves unfinished can be resumed.
    resumable: boolean;
};

// An engine has the task tree's signature, so the daemon, the CLI and SmartHarness's event queue can each run on it.
export type Engine = {
    name: EngineName;
    label: string;
    features: EngineFeatures;
    run: TreeRunner;
};

export const TASK_TREE_ENGINE: Engine = {
    name: 'task_tree',
    label: 'SmartHarness task tree',
    features: { task_tree: true, resumable: true },
    run: executeTaskTree,
};

export const DIRECT_ENGINE: Engine = {
    name: 'direct',
    label: 'Direct tool loop',
    features: { task_tree: false, resumable: false },
    run: runDirect,
};

export const ENGINES: Readonly<Record<EngineName, Engine>> = { task_tree: TASK_TREE_ENGINE, direct: DIRECT_ENGINE };

export function engineFor(settings: Pick<Settings, 'engine'>): Engine {
    return ENGINES[settings.engine];
}
