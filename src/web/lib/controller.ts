// What the pages ask of the daemon and the main process: runs, settings, background research, the inbox and the knowledge store.
import { describe_error } from '@x-tech-laboratories/x-libs/web/errors';
import { create_store } from '@x-tech-laboratories/x-libs/web/store';

import { inbox_tab_text } from '../inbox_view.ts';
import { NO_JOBS_TEXT, queue_lines, type TreeChoice } from '../knowledge_view.ts';
import {
    apply_status,
    begin_run,
    cancel_requested,
    clarification_answered,
    clear_workbench,
    connection_failed,
    DISCONNECTED_EVENT,
    reduce_event,
    show_unfinished_runs,
    stop_run,
    type Clarification,
    type Effect,
} from '../run_state.ts';
import { apply_size_choice, auto_size_request, collect_settings, settings_to_form, size_choice_message, type FormValues, type PathField } from '../settings_form.ts';
import type { Knowledge, ProposedAction, ResearchJob, Settings, SizeChoice, Status, UnfinishedRun, UserCommand } from '../types.ts';
import { call_daemon, codex, notify, on_daemon_event, request } from './api.ts';
import { dispatch, get_state, set_effect_handler } from './workbench.ts';

export const RECONNECT_SECONDS = 3;
export const COMMAND_CACHE_MILLISECONDS = 5000;
// The main process sends this alongside the daemon's events when launch at login changes from the tray.
export const AUTOSTART_CHANGED_EVENT = 'autostart.changed';
// The main process sends this when the tray or a notification asks for the Inbox page.
export const SHOW_INBOX_EVENT = 'inbox.show';
export const INBOX_ROUTE = '#/inbox';

export type PendingStep = { task_id: string; name: string; occurrence: number };

// ============================================================================
// Stores
// ============================================================================

export const prompt = create_store('');
export const form = create_store<FormValues | null>(null);
export const launch_at_login = create_store(false);
export const inbox = create_store<ProposedAction[]>([]);
export const queue_text = create_store(NO_JOBS_TEXT);
export const knowledge = create_store<Knowledge>({ topics: [], sources: [], facts: [], graph: [], matches: [] });
export const knowledge_query = create_store('');
export const knowledge_choice = create_store<TreeChoice>({ kind: 'all' });
// A step chosen in the graph, shown in its task's details once they are drawn.
export const pending_step = create_store<PendingStep | null>(null);

export function inbox_label(): string {
    return inbox_tab_text(inbox.get().length);
}

// ============================================================================
// Settings
// ============================================================================

export function show_settings(settings: Settings): void {
    dispatch({ ...get_state(), settings });
    form.set(settings_to_form(settings));
}

// Reads the form into settings, or tells the user what is wrong and returns null.
export function form_settings(): Settings | null {
    const state = get_state();
    const values = form.get();
    if (state.settings === null || values === null) {
        notify('Not connected to the daemon yet.', true);
        return null;
    }
    try {
        return collect_settings(state.settings, values);
    } catch (error) {
        notify(`Invalid settings: ${describe_error(error)}`, true);
        return null;
    }
}

export async function apply_settings(): Promise<void> {
    const settings = form_settings();
    if (settings === null) return;
    const applied = await call_daemon<Settings>('apply_settings', { settings });
    if (applied !== null) {
        show_settings(applied);
        notify('Settings applied.');
    }
}

export async function save_settings(): Promise<void> {
    const settings = form_settings();
    if (settings === null) return;
    const saved = await call_daemon<{ settings: Settings; path: string }>('save_settings', { settings });
    if (saved !== null) {
        show_settings(saved.settings);
        notify(`Settings saved to ${saved.path}.`);
    }
}

// Fills the context and token limits from the model file and free memory, ready to apply or save.
export async function auto_size(): Promise<void> {
    const values = form.get();
    if (values === null) {
        notify('Not connected to the daemon yet.', true);
        return;
    }
    let sizing: Record<string, unknown>;
    try {
        sizing = auto_size_request(values);
    } catch (error) {
        notify(`Invalid settings: ${describe_error(error)}`, true);
        return;
    }
    notify('Sizing the models for this machine...');
    const choice = await call_daemon<SizeChoice>('auto_size', sizing);
    if (choice !== null) {
        form.set(apply_size_choice(form.get() ?? values, choice));
        notify(size_choice_message(choice));
    }
}

// Opens the native chooser for a path field and gives back the path picked, or null.
export async function browse_for_path(field: PathField, current: string): Promise<string | null> {
    const defaultPath = current.trim() || undefined;
    try {
        if (field.kind === 'directory') {
            return await codex.open_dialog({ title: field.label, defaultPath, directory: true });
        }
        if (field.kind === 'database') {
            return await codex.save_dialog({ title: field.label, defaultPath, filters: [{ name: 'SQLite database', extensions: ['sqlite3', 'sqlite', 'db'] }] });
        }
        return await codex.open_dialog({
            title: field.label,
            defaultPath,
            filters: [{ name: 'GGUF model', extensions: ['gguf'] }, { name: 'All files', extensions: ['*'] }],
        });
    } catch (error) {
        notify(describe_error(error), true);
        return null;
    }
}

export async function set_launch_at_login(enabled: boolean): Promise<boolean> {
    try {
        const now = await codex.set_autostart(enabled);
        launch_at_login.set(now);
        notify(now ? 'CODEX will start in the tray when you log in.' : 'CODEX will no longer start when you log in.');
        return now === enabled;
    } catch (error) {
        notify(describe_error(error), true);
        return false;
    }
}

async function read_launch_at_login(): Promise<void> {
    try {
        launch_at_login.set(await codex.get_autostart());
    } catch {
        // The switch stays as it is when the main process cannot read the entry.
    }
}

// The window reconnects by itself once the old daemon has gone.
export async function restart_daemon(): Promise<void> {
    try {
        await codex.restart_daemon();
        notify('Restarting the daemon...');
    } catch (error) {
        notify(describe_error(error), true);
    }
}

// ============================================================================
// Foreground run
// ============================================================================

export async function start_run(): Promise<void> {
    if (get_state().running) return;
    const text = prompt.get().trim();
    if (!text) {
        notify('Enter a prompt before running.');
        return;
    }
    const settings = form_settings();
    if (settings === null) return;
    dispatch(begin_run(get_state(), null));
    const applied = await call_daemon<Settings>('apply_settings', { settings });
    if (applied === null) {
        dispatch(stop_run(get_state(), '_The request could not start._', 'Ready'));
        return;
    }
    dispatch({ ...get_state(), settings: applied });
    const started = await call_daemon<{ run_id: number }>('run', { prompt: text, settings });
    if (started === null) {
        dispatch(stop_run(get_state(), '_The request could not start._', 'Ready'));
        return;
    }
    dispatch({ ...get_state(), run_id: started.run_id });
}

export async function resume_run(): Promise<void> {
    const state = get_state();
    if (state.running || state.unfinished_runs.length === 0) return;
    const run = state.unfinished_runs[0];
    prompt.set(run.prompt);
    dispatch(begin_run(state, null));
    const started = await call_daemon<{ run_id: number }>('resume_run', { run_id: run.id });
    if (started === null) {
        dispatch(stop_run(get_state(), '_The request could not resume._', 'Ready'));
        return;
    }
    dispatch({ ...get_state(), run_id: started.run_id });
}

export async function discard_run(): Promise<void> {
    const state = get_state();
    if (state.unfinished_runs.length === 0) return;
    const remaining = state.unfinished_runs.slice(1);
    if ((await call_daemon('discard_run', { run_id: state.unfinished_runs[0].id })) !== null) {
        dispatch(show_unfinished_runs(get_state(), remaining));
    }
}

export function cancel_run(): void {
    const state = get_state();
    if (!state.running) return;
    void call_daemon('cancel', { run_id: state.run_id });
    dispatch(cancel_requested(state));
}

export function clear_run(): void {
    if (get_state().running) return;
    prompt.set('');
    dispatch(clear_workbench(get_state()));
}

export async function copy_answer(): Promise<void> {
    const answer = get_state().last_answer;
    if (!answer) return;
    try {
        await codex.copy_text(answer);
        notify('Copied the answer.');
    } catch (error) {
        notify(describe_error(error), true);
    }
}

export function answer_clarification(clarification: Clarification, submitted: boolean, typed: string): void {
    let answer = submitted ? typed : '';
    if (clarification.approval) {
        // The task tree goes ahead only when the reply starts with yes.
        answer = submitted ? `yes${typed ? `. ${typed}` : ''}` : typed || 'no';
    }
    dispatch(clarification_answered(get_state(), clarification.clarification_id));
    void call_daemon('answer_clarification', {
        run_id: clarification.run_id,
        clarification_id: clarification.clarification_id,
        answer,
    });
}

// ============================================================================
// Slash commands
// ============================================================================

let user_commands: UserCommand[] = [];
let commands_loaded_at = 0;
let commands_root = '';

// The folder's own commands, read again at most every few seconds.
export async function load_user_commands(): Promise<UserCommand[]> {
    const root = String(get_state().settings?.filesystem_root ?? '');
    if (root === commands_root && performance.now() - commands_loaded_at < COMMAND_CACHE_MILLISECONDS) return user_commands;
    commands_root = root;
    commands_loaded_at = performance.now();
    try {
        user_commands = await codex.list_commands(root);
    } catch {
        user_commands = [];
    }
    return user_commands;
}

// ============================================================================
// Background research
// ============================================================================

export async function refresh_queue(): Promise<void> {
    let jobs: ResearchJob[] = [];
    try {
        jobs = await request<ResearchJob[]>('queue_status');
    } catch {
        jobs = [];
    }
    queue_text.set(queue_lines(jobs));
}

export async function set_background_enabled(enabled: boolean): Promise<void> {
    const applied = await call_daemon<Settings>('set_background_enabled', { enabled });
    if (applied !== null) {
        dispatch({ ...get_state(), settings: applied });
    }
}

export async function queue_topic(topic: string, priority: number): Promise<boolean> {
    if (!topic.trim()) {
        notify('Enter a topic to research.');
        return false;
    }
    if (!Number.isInteger(priority)) {
        notify('Priority must be an integer.', true);
        return false;
    }
    return (await call_daemon('queue_topic', { topic: topic.trim(), priority })) !== null;
}

export async function research_now(topic: string, priority: number): Promise<boolean> {
    if (topic.trim() && !(await queue_topic(topic, priority))) {
        return false;
    }
    await call_daemon('research_now');
    return true;
}

// ============================================================================
// Inbox
// ============================================================================

export async function refresh_inbox(): Promise<void> {
    try {
        inbox.set(await request<ProposedAction[]>('actions', { status: 'proposed', limit: 100 }));
    } catch {
        // The list keeps what it showed until the daemon answers again.
    }
}

export async function resolve_action(action_id: number, resolution: string): Promise<void> {
    await call_daemon('resolve_action', { action_id, resolution });
    await refresh_inbox();
}

// ============================================================================
// Knowledge
// ============================================================================

export async function refresh_knowledge(): Promise<void> {
    try {
        knowledge.set(await request<Knowledge>('knowledge', { query: knowledge_query.get() }));
    } catch {
        // The browser keeps what it showed until the daemon answers again.
    }
}

// Choosing a node needs nothing new from the daemon; leaving a search refreshes the store.
export function choose_knowledge(choice: TreeChoice): void {
    const searched = knowledge_query.get() !== '';
    knowledge_query.set('');
    knowledge_choice.set(choice);
    if (searched) {
        void refresh_knowledge();
    }
}

export function search_knowledge(query: string): void {
    knowledge_query.set(query.trim());
    knowledge_choice.set({ kind: 'all' });
    void refresh_knowledge();
}

// ============================================================================
// Connection
// ============================================================================

function run_effect(effect: Effect): void {
    switch (effect.kind) {
        case 'notify':
            notify(effect.message, effect.error);
            break;
        case 'refresh_queue':
            void refresh_queue();
            break;
        case 'refresh_unfinished':
            void call_daemon<UnfinishedRun[]>('unfinished_runs').then((runs) => dispatch(show_unfinished_runs(get_state(), runs ?? [])));
            break;
        case 'refresh_knowledge':
            void refresh_knowledge();
            break;
        case 'show_settings':
            show_settings(effect.settings);
            break;
    }
}

let reconnect_timer: ReturnType<typeof setTimeout> | null = null;

// Connects to the daemon and shows what it reports; a restart of the daemon is retried until it answers.
async function connect_to_daemon(): Promise<void> {
    await codex.connect();
    const status = await request<Status>('status');
    dispatch(apply_status(get_state(), status));
    void refresh_inbox();
}

function reconnect_soon(): void {
    if (reconnect_timer !== null) {
        return;
    }
    reconnect_timer = setTimeout(() => {
        reconnect_timer = null;
        connect_to_daemon().catch(reconnect_soon);
    }, RECONNECT_SECONDS * 1000);
}

function handle_event(event: string, data: Record<string, unknown>): void {
    if (event === AUTOSTART_CHANGED_EVENT) {
        launch_at_login.set(Boolean(data.enabled));
        return;
    }
    if (event === SHOW_INBOX_EVENT) {
        location.hash = INBOX_ROUTE;
        return;
    }
    if (event === 'actions.changed') {
        void refresh_inbox();
        return;
    }
    dispatch(reduce_event(get_state(), event, data));
    if (event === DISCONNECTED_EVENT) {
        reconnect_soon();
    }
}

// Wires the daemon's events to the state and connects; returns the function that stops listening.
export function start(): () => void {
    set_effect_handler(run_effect);
    const stop = on_daemon_event(handle_event);
    void read_launch_at_login();
    connect_to_daemon().catch((error: unknown) => {
        dispatch(connection_failed(get_state(), describe_error(error)));
        reconnect_soon();
    });
    return stop;
}
