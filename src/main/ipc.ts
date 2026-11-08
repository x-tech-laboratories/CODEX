// The IPC the window may use: daemon requests from a fixed list, native dialogs, the clipboard, user commands, launch at login, and restarting the daemon.
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, SaveDialogOptions } from 'electron';

import { loadCommands } from '../core/commands.js';
import { codex_bridge, codex_events, type CodexApi, type DialogRequest, type Envelope, type UserCommand } from '../shared/ipc.js';

// The window hears this alongside the daemon's events when launch at login changes from the tray.
export const AUTOSTART_CHANGED_EVENT = 'autostart.changed';

// The window hears this when the tray asks for the Inbox page.
export const SHOW_INBOX_EVENT = 'inbox.show';

// Shutdown is left out, since closing a window must never stop a daemon other interfaces share; a restart has its own method.
export const ALLOWED_METHODS = new Set([
    'status',
    'get_settings',
    'apply_settings',
    'save_settings',
    'auto_size',
    'set_background_enabled',
    'run',
    'cancel',
    'answer_clarification',
    'queue_topic',
    'queue_request',
    'research_now',
    'queue_status',
    'actions',
    'resolve_action',
    'knowledge',
    'unfinished_runs',
    'resume_run',
    'discard_run',
]);

export type { Envelope } from '../shared/ipc.js';

export type DaemonCaller = {
    call(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

// ============================================================================
// Requests
// ============================================================================

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function wrap<T>(work: () => Promise<T> | T): Promise<Envelope<T>> {
    try {
        return { ok: true, result: await work() };
    } catch (error) {
        return { ok: false, error: errorText(error) };
    }
}

export async function handleRequest(caller: DaemonCaller | null, method: unknown, params: unknown): Promise<Envelope> {
    return wrap(async () => {
        if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) {
            throw new Error(`Unknown method: ${String(method)}`);
        }
        if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
            throw new Error('params must be a JSON object.');
        }
        if (caller === null) {
            throw new Error('Not connected to the daemon yet.');
        }
        return caller.call(method, (params as Record<string, unknown> | undefined) ?? {});
    });
}

// Lists the commands the user defined in files for this folder, for the prompt's suggestions.
export function listUserCommands(filesystemRoot: unknown): UserCommand[] {
    if (typeof filesystemRoot !== 'string' || !filesystemRoot.trim()) {
        return [];
    }
    return [...loadCommands(filesystemRoot.trim()).values()]
        .map(({ name, description, mode }) => ({ name, description, mode }))
        .sort((first, second) => first.name.localeCompare(second.name));
}

// ============================================================================
// Dialog options
// ============================================================================

export function openDialogOptions(request: unknown): OpenDialogOptions {
    const given = (request && typeof request === 'object' ? request : {}) as DialogRequest;
    const options: OpenDialogOptions = {
        properties: [given.directory ? 'openDirectory' : 'openFile', 'showHiddenFiles'],
    };
    if (typeof given.title === 'string') options.title = given.title;
    if (typeof given.defaultPath === 'string' && given.defaultPath) options.defaultPath = given.defaultPath;
    if (Array.isArray(given.filters)) options.filters = given.filters;
    return options;
}

export function saveDialogOptions(request: unknown): SaveDialogOptions {
    const given = (request && typeof request === 'object' ? request : {}) as DialogRequest;
    const options: SaveDialogOptions = { properties: ['showHiddenFiles', 'showOverwriteConfirmation'] };
    if (typeof given.title === 'string') options.title = given.title;
    if (typeof given.defaultPath === 'string' && given.defaultPath) options.defaultPath = given.defaultPath;
    if (Array.isArray(given.filters)) options.filters = given.filters;
    return options;
}

// ============================================================================
// Registration
// ============================================================================

export type IpcDependencies = {
    ipcMain: Pick<IpcMain, 'handle'>;
    window: () => BrowserWindow | null;
    caller: () => DaemonCaller | null;
    connection: () => Promise<{ socket_path: string; started: boolean }>;
    showOpenDialog: (window: BrowserWindow, options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (window: BrowserWindow, options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
    writeClipboard: (text: string) => void;
    autostart: { isEnabled: () => boolean; setEnabled: (enabled: boolean) => void };
    restartDaemon: () => void;
    isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
};

type Answer = (...args: unknown[]) => Promise<Envelope>;

// Each bridge method's answer, every one wrapped in an envelope so the preload can hand the page a plain error.
export function ipcAnswers(dependencies: IpcDependencies): Record<keyof CodexApi, Answer> {
    return {
        connect: () => wrap(() => dependencies.connection()),
        request: (method, params) => handleRequest(dependencies.caller(), method, params),
        open_dialog: (request) => wrap(async () => {
            const window = dependencies.window();
            if (window === null) return null;
            const answer = await dependencies.showOpenDialog(window, openDialogOptions(request));
            return answer.canceled ? null : answer.filePaths[0] ?? null;
        }),
        save_dialog: (request) => wrap(async () => {
            const window = dependencies.window();
            if (window === null) return null;
            const answer = await dependencies.showSaveDialog(window, saveDialogOptions(request));
            return answer.canceled ? null : answer.filePath ?? null;
        }),
        copy_text: (text) => wrap(() => {
            dependencies.writeClipboard(String(text ?? ''));
            return true;
        }),
        list_commands: (filesystemRoot) => wrap(() => listUserCommands(filesystemRoot)),
        get_autostart: () => wrap(() => dependencies.autostart.isEnabled()),
        set_autostart: (enabled) => wrap(() => {
            dependencies.autostart.setEnabled(Boolean(enabled));
            return dependencies.autostart.isEnabled();
        }),
        restart_daemon: () => wrap(() => {
            dependencies.restartDaemon();
            return true;
        }),
    };
}

// Answers every bridge method on its channel, refusing calls from any page but the app's own.
export function registerIpc(dependencies: IpcDependencies): void {
    const answers = ipcAnswers(dependencies);
    for (const method of codex_bridge.method_names) {
        dependencies.ipcMain.handle(codex_bridge.channel(method), (event, ...args) =>
            dependencies.isTrustedSender(event) ? answers[method](...args) : { ok: false, error: 'Untrusted sender.' });
    }
}

// Passes one daemon event on to the window, if it is still open.
export function forwardEvent(window: BrowserWindow | null, event: string, data: Record<string, unknown>): void {
    if (window !== null && !window.isDestroyed()) {
        codex_events.emit([window], 'daemon', { event, data });
    }
}
