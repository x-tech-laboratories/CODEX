// The workbench's state and how each daemon event and user action changes it, kept free of the DOM so it can be tested.
import { TASK_STEP_PREFIX, step_task_id } from './task_view.ts';
import type { RunSnapshot, Settings, Status, StepInput, TaskNode, UnfinishedRun } from './types.ts';

export const FINAL_WAITING_TEXT = 'Your final response will appear here.';
export const BACKGROUND_WAITING_TEXT = 'Waiting for background work...';
export const DISCONNECTED_EVENT = 'daemon.disconnected';
// The task tree asks for approval with this question before any task changes files, runs tests, or calls MCP tools.
export const APPROVAL_QUESTION =
    'Approve these actions before anything is changed? Reply yes to go ahead; any other reply stops them.';
export const UNFINISHED_PROMPT_CHARS = 80;
export const SUSPENDED_TEXT = 'Suspended';
export const RESUMED_TEXT = 'CODEX is working again.';

export type Phase = 'task' | 'final';
export type StepSection = { label: string; system: string; input: string; text: string };
export type Clarification = { run_id: number; clarification_id: number; question: string; approval: boolean };
export type Connection = 'connecting' | 'connected' | 'unavailable';

export type WorkbenchState = {
    connection: Connection;
    settings: Settings | null;
    settings_path: string;
    run_id: number | null;
    running: boolean;
    cancelling: boolean;
    last_answer: string;
    // True while the view moves to each task as it starts running.
    follow_steps: boolean;
    phase: Phase;
    chosen_task_id: string | null;
    collapsed_task_ids: string[];
    // True while the task graph shows above the output.
    graph_shown: boolean;
    nodes: TaskNode[];
    steps: StepSection[];
    last_step_label: string;
    status: string;
    final_text: string;
    unfinished_runs: UnfinishedRun[];
    background_status: string;
    background_output: string;
    clarifications: Clarification[];
    // True while the daemon is suspended and has freed the GPU.
    suspended: boolean;
};

export type Effect =
    | { kind: 'notify'; message: string; error?: boolean }
    | { kind: 'refresh_queue' }
    | { kind: 'refresh_unfinished' }
    | { kind: 'refresh_knowledge' }
    | { kind: 'show_settings'; settings: Settings };

export type Reduction = { state: WorkbenchState; effects: Effect[] };

// ============================================================================
// Starting state
// ============================================================================

export function initial_state(): WorkbenchState {
    return {
        connection: 'connecting',
        settings: null,
        settings_path: '',
        run_id: null,
        running: false,
        cancelling: false,
        last_answer: '',
        follow_steps: true,
        phase: 'final',
        chosen_task_id: null,
        collapsed_task_ids: [],
        graph_shown: true,
        nodes: [],
        steps: [],
        last_step_label: '',
        status: 'Connecting to the daemon...',
        final_text: FINAL_WAITING_TEXT,
        unfinished_runs: [],
        background_status: 'Idle',
        background_output: '',
        clarifications: [],
        suspended: false,
    };
}

// ============================================================================
// Run view
// ============================================================================

function reset_run_view(state: WorkbenchState): WorkbenchState {
    return { ...state, follow_steps: true, steps: [], last_step_label: '', chosen_task_id: null, collapsed_task_ids: [], nodes: [], phase: 'final' };
}

export function begin_run(state: WorkbenchState, run_id: number | null): WorkbenchState {
    return {
        ...reset_run_view(state),
        run_id,
        running: true,
        cancelling: false,
        final_text: '_Working on your request..._',
        status: 'Starting local model...',
    };
}

// Starts a new step whenever the step changes.
function note_step(state: WorkbenchState, label: string): WorkbenchState {
    if (label === state.last_step_label) {
        return state;
    }
    return { ...state, last_step_label: label, steps: [...state.steps, { label, system: '', input: '', text: '' }] };
}

export function append_step_input(state: WorkbenchState, label: string, input: StepInput): WorkbenchState {
    if (!label.startsWith(TASK_STEP_PREFIX)) {
        return state;
    }
    const noted = note_step(state, label);
    const steps = noted.steps.slice();
    steps[steps.length - 1] = { ...steps[steps.length - 1], system: input.system, input: input.input };
    return { ...noted, steps };
}

export function append_step_output(state: WorkbenchState, label: string, token: string): WorkbenchState {
    if (!label.startsWith(TASK_STEP_PREFIX)) {
        return state;
    }
    const noted = note_step(state, label);
    const steps = noted.steps.slice();
    const last = steps[steps.length - 1];
    steps[steps.length - 1] = { ...last, text: last.text + token };
    return { ...noted, steps };
}

export function update_progress(state: WorkbenchState, label: string): WorkbenchState {
    let next = label.startsWith(TASK_STEP_PREFIX) ? note_step(state, label) : state;
    if (label === 'Loading model') {
        return { ...next, status: 'Loading local model...' };
    }
    next = { ...next, status: label };
    if (label.startsWith(TASK_STEP_PREFIX) && next.follow_steps) {
        next = show_task(next, step_task_id(label));
    }
    return next;
}

export function show_task_tree(state: WorkbenchState, nodes: TaskNode[]): WorkbenchState {
    return { ...state, nodes };
}

// Shows a task and opens every branch above it, so its row is in sight.
function show_task(state: WorkbenchState, task_id: string): WorkbenchState {
    const collapsed_task_ids = state.collapsed_task_ids.filter((id) => !task_id.startsWith(`${id}.`));
    return { ...state, chosen_task_id: task_id, phase: 'task', collapsed_task_ids };
}

// Choosing a task or the final answer is the user's own pick, so the view stops following the running task.
export function choose_task(state: WorkbenchState, task_id: string): WorkbenchState {
    return { ...show_task(state, task_id), follow_steps: state.running ? false : state.follow_steps };
}

export function choose_final_answer(state: WorkbenchState): WorkbenchState {
    return { ...state, phase: 'final', chosen_task_id: null, follow_steps: state.running ? false : state.follow_steps };
}

export function set_task_open(state: WorkbenchState, task_id: string, open: boolean): WorkbenchState {
    const others = state.collapsed_task_ids.filter((id) => id !== task_id);
    return { ...state, collapsed_task_ids: open ? others : [...others, task_id] };
}

export function set_graph_shown(state: WorkbenchState, shown: boolean): WorkbenchState {
    return { ...state, graph_shown: shown };
}

export function chosen_task(state: WorkbenchState): TaskNode | null {
    return state.nodes.find((node) => node.id === state.chosen_task_id) ?? null;
}

export function chosen_task_steps(state: WorkbenchState): StepSection[] {
    return state.chosen_task_id === null ? [] : state.steps.filter((step) => step_task_id(step.label) === state.chosen_task_id);
}

export function finish_run(state: WorkbenchState, result: string): WorkbenchState {
    return { ...state, last_answer: result, running: false, cancelling: false, final_text: result, phase: 'final', status: 'Complete' };
}

export function stop_run(state: WorkbenchState, final_text: string, status: string): WorkbenchState {
    return { ...state, running: false, cancelling: false, final_text, phase: 'final', status };
}

export function fail_run(state: WorkbenchState, message: string): Reduction {
    return {
        state: stop_run(state, `**Run failed**\n\n${message}`, 'Run failed'),
        effects: [{ kind: 'notify', message, error: true }],
    };
}

export function cancel_requested(state: WorkbenchState): WorkbenchState {
    return { ...state, cancelling: true, status: 'Cancelling...' };
}

export function clear_workbench(state: WorkbenchState): WorkbenchState {
    if (state.running) {
        return state;
    }
    return { ...reset_run_view(state), final_text: FINAL_WAITING_TEXT, last_answer: '', status: 'Ready' };
}

// ============================================================================
// Unfinished runs
// ============================================================================

export function show_unfinished_runs(state: WorkbenchState, runs: UnfinishedRun[]): WorkbenchState {
    return { ...state, unfinished_runs: runs };
}

// Describes the newest run a crash, restart, or cancel left unfinished, or returns null when there is none to offer.
export function unfinished_run_text(state: WorkbenchState): string | null {
    if (state.running || state.unfinished_runs.length === 0) {
        return null;
    }
    const run = state.unfinished_runs[0];
    const prompt = run.prompt.split(/\s+/).filter(Boolean).join(' ');
    const shown = run.title || prompt.slice(0, UNFINISHED_PROMPT_CHARS) + (prompt.length > UNFINISHED_PROMPT_CHARS ? '…' : '');
    return `Unfinished: ${shown} (${run.tasks_done} of ${run.tasks_total} tasks done)`;
}

// ============================================================================
// Background work
// ============================================================================

export function set_background_status(state: WorkbenchState, message: string): WorkbenchState {
    const searching = message.startsWith('Searching:');
    return { ...state, background_status: message, background_output: searching ? '' : state.background_output };
}

// Sorts a background status message into idle, working, paused or error, for the status dot and the mascot.
export function background_state(message: string): 'idle' | 'working' | 'paused' | 'error' {
    if (message === 'Paused' || message === SUSPENDED_TEXT) return 'paused';
    if (message.startsWith('Worker error')) return 'error';
    if (message.startsWith('Idle') || message === 'Foreground prompt active') return 'idle';
    return 'working';
}

export function append_background_token(state: WorkbenchState, token: string): WorkbenchState {
    return { ...state, background_output: state.background_output + token };
}

// ============================================================================
// Clarifications and approvals
// ============================================================================

export function is_approval_question(question: string): boolean {
    return question.startsWith(APPROVAL_QUESTION);
}

// Splits an approval question into its question and the planned actions it shows.
export function approval_plan(question: string): string {
    return is_approval_question(question) ? question.slice(APPROVAL_QUESTION.length).trim() : '';
}

export function request_clarification(state: WorkbenchState, run_id: number, clarification_id: number, question: string): WorkbenchState {
    const clarification = { run_id, clarification_id, question, approval: is_approval_question(question) };
    return { ...state, clarifications: [...state.clarifications, clarification] };
}

export function clarification_answered(state: WorkbenchState, clarification_id: number): WorkbenchState {
    return { ...state, clarifications: state.clarifications.filter((item) => item.clarification_id !== clarification_id) };
}

// ============================================================================
// Suspending
// ============================================================================

// Tells the user when the daemon is suspended or resumed, and shows it as the status while no run is going.
export function set_suspended(state: WorkbenchState, suspended: boolean): Reduction {
    if (suspended === state.suspended) {
        return { state, effects: [] };
    }
    const next = { ...state, suspended, status: state.running ? state.status : suspended ? SUSPENDED_TEXT : 'Ready' };
    return { state: next, effects: [{ kind: 'notify', message: suspended ? SUSPENDED_TEXT : RESUMED_TEXT }] };
}

// ============================================================================
// Daemon status and events
// ============================================================================

// Shows what the daemon reports on connecting, including a run another interface started.
export function apply_status(state: WorkbenchState, status: Status): Reduction {
    let next: WorkbenchState = {
        ...state,
        connection: 'connected',
        settings: status.settings,
        settings_path: status.settings_path,
        background_output: status.background.output,
    };
    next = set_background_status(next, status.background.status);
    const run: RunSnapshot | null = status.run;
    if (run === null) {
        next = { ...next, status: next.suspended ? SUSPENDED_TEXT : 'Ready' };
    } else {
        next = show_task_tree(begin_run(next, run.run_id), run.tree);
        const inputs = run.inputs ?? {};
        for (const label of new Set([...run.progress, ...Object.keys(inputs), ...Object.keys(run.outputs)])) {
            if (label in inputs) {
                next = append_step_input(next, label, inputs[label]);
            }
            next = append_step_output(next, label, run.outputs[label] ?? '');
        }
        if (run.progress.length > 0) {
            next = update_progress(next, run.progress[run.progress.length - 1]);
        }
    }
    next = show_unfinished_runs(next, status.unfinished_runs);
    const suspension = set_suspended(next, Boolean(status.suspended));
    return {
        state: suspension.state,
        effects: [
            { kind: 'show_settings', settings: status.settings },
            { kind: 'refresh_knowledge' },
            { kind: 'refresh_queue' },
            ...suspension.effects,
        ],
    };
}

export function connection_failed(state: WorkbenchState, message: string): Reduction {
    return { state: { ...state, connection: 'unavailable', status: 'Daemon unavailable' }, effects: [{ kind: 'notify', message, error: true }] };
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
}

export function reduce_event(state: WorkbenchState, event: string, data: Record<string, unknown>): Reduction {
    switch (event) {
        case 'run.started':
            if (!state.running || state.run_id === null) {
                return { state: begin_run(state, Number(data.run_id)), effects: [] };
            }
            return { state, effects: [] };
        case 'run.tree':
            return { state: show_task_tree(state, (data.nodes as TaskNode[]) ?? []), effects: [] };
        case 'run.progress':
            return { state: update_progress(state, text(data.label)), effects: [] };
        case 'run.input':
            return { state: append_step_input(state, text(data.label), { system: text(data.system), input: text(data.input) }), effects: [] };
        case 'run.token':
            return { state: append_step_output(state, text(data.label), text(data.token)), effects: [] };
        case 'run.clarification':
            return {
                state: request_clarification(state, Number(data.run_id), Number(data.clarification_id), text(data.question)),
                effects: [],
            };
        case 'run.finished':
            return { state: finish_run({ ...state, clarifications: [] }, text(data.result)), effects: [] };
        case 'run.failed':
            return fail_run({ ...state, clarifications: [] }, text(data.message));
        case 'run.cancelled':
            return { state: stop_run({ ...state, clarifications: [] }, '_Run cancelled._', 'Cancelled'), effects: [] };
        case 'background.status':
            return { state: set_background_status(state, text(data.message)), effects: [] };
        case 'background.token':
            return { state: append_background_token(state, text(data.token)), effects: [] };
        case 'queue.changed':
            return { state, effects: [{ kind: 'refresh_queue' }] };
        case 'runs.changed':
            return { state, effects: [{ kind: 'refresh_unfinished' }] };
        case 'knowledge.changed':
            return { state, effects: [{ kind: 'refresh_knowledge' }] };
        case 'settings.changed':
            return { state: { ...state, settings: data.settings as Settings }, effects: [] };
        case 'suspended.changed':
            return set_suspended(state, Boolean(data.suspended));
        case DISCONNECTED_EVENT: {
            let next = state;
            const effects: Effect[] = [];
            if (state.running) {
                const failed = fail_run(state, 'The daemon closed the connection.');
                next = failed.state;
                effects.push(...failed.effects);
            }
            next = { ...next, connection: 'unavailable', status: 'Daemon unavailable', clarifications: [] };
            effects.push({ kind: 'notify', message: 'Lost the connection to the CODEX daemon.', error: true });
            return { state: next, effects };
        }
        default:
            return { state, effects: [] };
    }
}
