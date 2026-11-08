import { describe, expect, it } from 'vitest';

import {
    APPROVAL_QUESTION,
    apply_status,
    approval_plan,
    begin_run,
    choose_final_answer,
    choose_task,
    chosen_task,
    chosen_task_steps,
    clarification_answered,
    clear_workbench,
    DISCONNECTED_EVENT,
    FINAL_WAITING_TEXT,
    initial_state,
    reduce_event,
    RESUMED_TEXT,
    set_graph_shown,
    set_task_open,
    SUSPENDED_TEXT,
    unfinished_run_text,
} from '../src/web/run_state.ts';
import type { WorkbenchState } from '../src/web/run_state.ts';
import type { Settings, Status, TaskNode } from '../src/web/types.ts';

const settings = { mode: 'auto', model_path: 'm.gguf', filesystem_root: '.', allow_file_writes: false, background_research_enabled: true, mcp_servers: [] } as Settings;

function node(id: string, status = 'pending', extra: Partial<TaskNode> = {}): TaskNode {
    return { id, prompt: `Do ${id}`, deliverable: `Result ${id}`, status, ...extra };
}

function events(state: WorkbenchState, ...steps: Array<[string, Record<string, unknown>]>): WorkbenchState {
    return steps.reduce((current, [event, data]) => reduce_event(current, event, data).state, state);
}

// ============================================================================
// Runs
// ============================================================================

describe('a run from start to finish', () => {
    it('keeps each step with its input and streamed text, and ends on the final answer', () => {
        const running = begin_run(initial_state(), 1);

        const finished = events(
            running,
            ['run.progress', { run_id: 1, label: 'Loading model' }],
            ['run.tree', { run_id: 1, nodes: [node('1', 'running')] }],
            ['run.progress', { run_id: 1, label: 'Task 1 · research' }],
            ['run.input', { run_id: 1, label: 'Task 1 · research', system: 'Search well', input: 'Original user request' }],
            ['run.token', { run_id: 1, label: 'Task 1 · research', token: 'Look' }],
            ['run.token', { run_id: 1, label: 'Task 1 · research', token: 'ing' }],
            ['run.token', { run_id: 1, label: 'Planning', token: 'ignored' }],
            ['run.token', { run_id: 1, label: 'Task 1 · answer', token: 'Done' }],
            ['run.finished', { run_id: 1, result: '# Answer' }],
        );

        expect(finished.steps).toEqual([
            { label: 'Task 1 · research', system: 'Search well', input: 'Original user request', text: 'Looking' },
            { label: 'Task 1 · answer', system: '', input: '', text: 'Done' },
        ]);
        expect(finished.running).toBe(false);
        expect(finished.final_text).toBe('# Answer');
        expect(finished.last_answer).toBe('# Answer');
        expect(finished.phase).toBe('final');
        expect(finished.status).toBe('Complete');
    });

    it('shows the loading step in plain words and follows the running task until the user picks a row', () => {
        const running = { ...begin_run(initial_state(), 1), collapsed_task_ids: ['1', '1.2'] };

        const loading = events(running, ['run.progress', { label: 'Loading model' }]);
        const following = events(loading, ['run.progress', { label: 'Task 1.2.1 · plan' }]);
        const picked = choose_final_answer(following);
        const still_on_final = events(picked, ['run.progress', { label: 'Task 2 · plan' }]);

        expect(loading.status).toBe('Loading local model...');
        expect(following.phase).toBe('task');
        expect(following.chosen_task_id).toBe('1.2.1');
        expect(following.collapsed_task_ids).toEqual([]);
        expect(still_on_final.phase).toBe('final');
        expect(still_on_final.status).toBe('Task 2 · plan');
    });

    it("shows a picked task's details as the tree changes", () => {
        const running = events(begin_run(initial_state(), 1), ['run.tree', { nodes: [node('1'), node('1.1')] }]);

        const picked = choose_task(running, '1.1');
        const updated = events(picked, ['run.tree', { nodes: [node('1'), node('1.1', 'done', { result: 'Found it' })] }]);

        expect(picked.phase).toBe('task');
        expect(picked.follow_steps).toBe(false);
        expect(chosen_task(updated)?.result).toBe('Found it');
    });

    it("lists only the chosen task's steps, not those of tasks under it", () => {
        const ran = events(
            begin_run(initial_state(), 1),
            ['run.progress', { label: 'Task 1 · plan' }],
            ['run.progress', { label: 'Task 1.1 · research' }],
            ['run.progress', { label: 'Task 1 · combine' }],
        );

        const steps = chosen_task_steps(choose_task(ran, '1'));

        expect(steps.map((step) => step.label)).toEqual(['Task 1 · plan', 'Task 1 · combine']);
    });

    it('opens and closes a branch of the tree', () => {
        const closed = set_task_open(initial_state(), '1.1', false);

        const reopened = set_task_open(closed, '1.1', true);

        expect(closed.collapsed_task_ids).toEqual(['1.1']);
        expect(reopened.collapsed_task_ids).toEqual([]);
    });

    it('starts with the task graph shown, and keeps a later choice across runs', () => {
        const hidden = set_graph_shown(initial_state(), false);

        expect(initial_state().graph_shown).toBe(true);
        expect(hidden.graph_shown).toBe(false);
        expect(begin_run(hidden, 1).graph_shown).toBe(false);
        expect(set_graph_shown(hidden, true).graph_shown).toBe(true);
    });

    it('follows a run another interface starts, but not one this window already began', () => {
        const idle = initial_state();

        const watching = events(idle, ['run.started', { run_id: 7, prompt: 'x' }]);
        const ours = { ...begin_run(idle, 3), steps: [{ label: 'Task 1 · a', system: '', input: '', text: 'kept' }] };
        const unchanged = events(ours, ['run.started', { run_id: 3, prompt: 'x' }]);

        expect(watching.running).toBe(true);
        expect(watching.run_id).toBe(7);
        expect(unchanged.steps).toHaveLength(1);
    });

    it('reports a failed and a cancelled run on the final page', () => {
        const running = begin_run(initial_state(), 1);

        const failed = reduce_event(running, 'run.failed', { run_id: 1, message: 'No model file' });
        const cancelled = events(running, ['run.cancelled', { run_id: 1 }]);

        expect(failed.state.final_text).toBe('**Run failed**\n\nNo model file');
        expect(failed.state.status).toBe('Run failed');
        expect(failed.effects).toEqual([{ kind: 'notify', message: 'No model file', error: true }]);
        expect(cancelled.final_text).toBe('_Run cancelled._');
        expect(cancelled.status).toBe('Cancelled');
    });

    it('fails the run and marks the daemon unavailable when the connection drops', () => {
        const running = begin_run(initial_state(), 1);

        const dropped = reduce_event(running, DISCONNECTED_EVENT, {});

        expect(dropped.state.running).toBe(false);
        expect(dropped.state.connection).toBe('unavailable');
        expect(dropped.state.status).toBe('Daemon unavailable');
        expect(dropped.effects.map((effect) => effect.kind)).toEqual(['notify', 'notify']);
    });

    it('shows the daemon as connected again when it reports after a drop', () => {
        const dropped = reduce_event(begin_run(initial_state(), 1), DISCONNECTED_EVENT, {}).state;
        const status: Status = { settings, settings_path: '/home/u/settings.json', run: null, background: { status: 'Idle', output: '' }, unfinished_runs: [] };

        const back = apply_status(dropped, status).state;

        expect(dropped.connection).toBe('unavailable');
        expect(back.connection).toBe('connected');
        expect(back.running).toBe(false);
        expect(back.status).toBe('Ready');
    });

    it('clears only when no run is going', () => {
        const finished = events(begin_run(initial_state(), 1), ['run.finished', { result: 'answer' }]);

        const cleared = clear_workbench(finished);
        const running = begin_run(initial_state(), 2);

        expect(cleared.final_text).toBe(FINAL_WAITING_TEXT);
        expect(cleared.last_answer).toBe('');
        expect(cleared.status).toBe('Ready');
        expect(clear_workbench(running)).toBe(running);
    });
});

// ============================================================================
// Status, background and lists
// ============================================================================

describe('daemon status and other events', () => {
    it("picks up a run in progress from the daemon's status", () => {
        const status: Status = {
            settings,
            settings_path: '/home/u/settings.json',
            run: {
                run_id: 5,
                prompt: 'Write it',
                tree: [node('1', 'running')],
                progress: ['Loading model', 'Task 1 · draft'],
                outputs: { 'Task 1 · draft': 'Hello', Planning: 'hidden' },
                inputs: { 'Task 1 · draft': { system: 'Write it well', input: 'Original user request' } },
            },
            background: { status: 'Foreground prompt active', output: 'old notes' },
            unfinished_runs: [],
        };

        const { state, effects } = apply_status(initial_state(), status);

        expect(state.connection).toBe('connected');
        expect(state.running).toBe(true);
        expect(state.run_id).toBe(5);
        expect(state.nodes).toHaveLength(1);
        expect(state.steps).toEqual([{ label: 'Task 1 · draft', system: 'Write it well', input: 'Original user request', text: 'Hello' }]);
        expect(state.phase).toBe('task');
        expect(state.chosen_task_id).toBe('1');
        expect(state.background_output).toBe('old notes');
        expect(effects.map((effect) => effect.kind)).toEqual(['show_settings', 'refresh_knowledge', 'refresh_queue']);
    });

    it('starts the background output afresh with each search', () => {
        const writing = events(initial_state(), ['background.token', { token: 'a' }], ['background.token', { token: 'b' }]);

        const searching = events(writing, ['background.status', { message: 'Searching: rust' }]);

        expect(writing.background_output).toBe('ab');
        expect(searching.background_output).toBe('');
        expect(searching.background_status).toBe('Searching: rust');
    });

    it('asks for fresh lists when the daemon says they changed', () => {
        const kinds = ['queue.changed', 'runs.changed', 'knowledge.changed'].map(
            (event) => reduce_event(initial_state(), event, {}).effects[0].kind,
        );

        expect(kinds).toEqual(['refresh_queue', 'refresh_unfinished', 'refresh_knowledge']);
    });

    it('keeps the settings another interface applied', () => {
        const changed = events(initial_state(), ['settings.changed', { settings: { ...settings, background_research_enabled: false } }]);

        expect(changed.settings?.background_research_enabled).toBe(false);
    });

    it('shows a suspension and tells the user when it starts and ends', () => {
        const ready = { ...initial_state(), status: 'Ready' };

        const suspended = reduce_event(ready, 'suspended.changed', { suspended: true });
        const again = reduce_event(suspended.state, 'suspended.changed', { suspended: true });
        const resumed = reduce_event(suspended.state, 'suspended.changed', { suspended: false });
        const running = reduce_event({ ...begin_run(ready, 1), status: 'Task 1 · draft' }, 'suspended.changed', { suspended: true });

        expect(suspended.state.suspended).toBe(true);
        expect(suspended.state.status).toBe(SUSPENDED_TEXT);
        expect(suspended.effects).toEqual([{ kind: 'notify', message: SUSPENDED_TEXT }]);
        expect(again.effects).toEqual([]);
        expect(resumed.state.status).toBe('Ready');
        expect(resumed.effects).toEqual([{ kind: 'notify', message: RESUMED_TEXT }]);
        expect(running.state.status).toBe('Task 1 · draft');
    });

    it("picks up a suspension from the daemon's status", () => {
        const status: Status = {
            settings,
            settings_path: '',
            run: null,
            background: { status: SUSPENDED_TEXT, output: '' },
            suspended: true,
            unfinished_runs: [],
        };

        const { state, effects } = apply_status(initial_state(), status);

        expect(state.suspended).toBe(true);
        expect(state.status).toBe(SUSPENDED_TEXT);
        expect(effects).toContainEqual({ kind: 'notify', message: SUSPENDED_TEXT });
    });

    it('offers the newest unfinished run with a shortened prompt', () => {
        const prompt = 'word '.repeat(30);
        const state = { ...initial_state(), unfinished_runs: [{ id: 2, prompt, status: 'stopped', tasks_done: 1, tasks_total: 4 }] };

        const text = unfinished_run_text(state);

        expect(text).toBe(`Unfinished: ${prompt.trim().slice(0, 80)}… (1 of 4 tasks done)`);
        expect(unfinished_run_text({ ...state, running: true })).toBeNull();
    });

    it('names an unfinished run by its title once it has one', () => {
        const state = { ...initial_state(), unfinished_runs: [{ id: 2, prompt: 'word '.repeat(30), title: 'Word list', status: 'stopped', tasks_done: 1, tasks_total: 4 }] };

        expect(unfinished_run_text(state)).toBe('Unfinished: Word list (1 of 4 tasks done)');
    });
});

// ============================================================================
// Clarifications and approvals
// ============================================================================

describe('clarifications and approvals', () => {
    it('queues questions and tells an approval apart from a clarification', () => {
        const question = `${APPROVAL_QUESTION}\n\nTask 1: Edit the README`;

        const asked = events(
            begin_run(initial_state(), 1),
            ['run.clarification', { run_id: 1, clarification_id: 1, question: 'Which folder?' }],
            ['run.clarification', { run_id: 1, clarification_id: 2, question }],
        );

        expect(asked.clarifications.map((item) => item.approval)).toEqual([false, true]);
        expect(approval_plan(question)).toBe('Task 1: Edit the README');
        expect(clarification_answered(asked, 1).clarifications.map((item) => item.clarification_id)).toEqual([2]);
    });

    it('drops open questions when the run ends', () => {
        const asked = events(begin_run(initial_state(), 1), ['run.clarification', { run_id: 1, clarification_id: 1, question: 'Why?' }]);

        const ended = events(asked, ['run.cancelled', { run_id: 1 }]);

        expect(ended.clarifications).toEqual([]);
    });
});
