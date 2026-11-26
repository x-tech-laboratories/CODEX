import { describe, expect, it } from 'vitest';

import { executeTaskTree } from '@x-tech-laboratories/smartharness/taskTree';
import { ASSISTANT_DEFAULT_SETTINGS, validateAssistantSettings } from '../assistant/settings.js';
import { runDirect } from './directEngine.js';
import { DIRECT_ENGINE, engineFor, TASK_TREE_ENGINE } from './engine.js';

describe('engineFor', () => {
    it('runs on the task tree by default and on the direct loop when chosen', () => {
        expect(engineFor(ASSISTANT_DEFAULT_SETTINGS)).toBe(TASK_TREE_ENGINE);
        expect(engineFor({ engine: 'direct' })).toBe(DIRECT_ENGINE);
        expect(TASK_TREE_ENGINE.run).toBe(executeTaskTree);
        expect(DIRECT_ENGINE.run).toBe(runDirect);
    });

    it('says which engines keep a task tree and resumable runs', () => {
        expect(TASK_TREE_ENGINE.features).toEqual({ task_tree: true, resumable: true });
        expect(DIRECT_ENGINE.features).toEqual({ task_tree: false, resumable: false });
    });

    it('refuses an engine the settings do not know', () => {
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, engine: 'magic' })).toThrow(/engine must be one of: task_tree, direct/);
    });
});
