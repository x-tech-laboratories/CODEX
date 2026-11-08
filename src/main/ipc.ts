// The IPC the window may use: daemon requests from a fixed list, native dialogs, the clipboard, user commands, launch at login, and restarting the daemon.
import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron';

import type { Implementation } from '@x-tech-laboratories/x-libs/electron/bridge';

import { loadCommands } from '../core/commands.js';
import { codex_events, type CodexApi, type DialogRequest, type UserCommand } from '../shared/ipc.js';

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

export type DaemonCaller = {
    call(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

// ============================================================================
// Requests
// ============================================================================

// Passes one allowed request to the daemon; the bridge puts a thrown error's words in the reply's envelope.
export async function handleRequest(caller: DaemonCaller | null, method: unknown, params: unknown): Promise<unknown> {
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
    window: () => BrowserWindow | null;
    caller: () => DaemonCaller | null;
    connection: () => Promise<{ socket_path: string; started: boolean }>;
    showOpenDialog: (window: BrowserWindow, options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (window: BrowserWindow, options: SaveDialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
    writeClipboard: (text: string) => void;
    autostart: { isEnabled: () => boolean; setEnabled: (enabled: boolean) => void };
    restartDaemon: () => void;
};

// Each bridge method's answer; codex_bridge.handle puts each in an envelope and refuses pages other than the app's own.
export function ipcAnswers(dependencies: IpcDependencies): Implementation<CodexApi> {
    return {
        connect: () => dependencies.connection(),
        request: (method, params) => handleRequest(dependencies.caller(), method, params),
        open_dialog: async (request) => {
            const window = dependencies.window();
            if (window === null) return null;
            const answer = await dependencies.showOpenDialog(window, openDialogOptions(request));
            return answer.canceled ? null : answer.filePaths[0] ?? null;
        },
        save_dialog: async (request) => {
            const window = dependencies.window();
            if (window === null) return null;
            const answer = await dependencies.showSaveDialog(window, saveDialogOptions(request));
            return answer.canceled ? null : answer.filePath ?? null;
        },
        copy_text: (text) => {
            dependencies.writeClipboard(String(text ?? ''));
            return true;
        },
        list_commands: (filesystemRoot) => listUserCommands(filesystemRoot),
        get_autostart: () => dependencies.autostart.isEnabled(),
        set_autostart: (enabled) => {
            dependencies.autostart.setEnabled(Boolean(enabled));
            return dependencies.autostart.isEnabled();
        },
        restart_daemon: () => {
            dependencies.restartDaemon();
            return true;
        },
    };
}

// Passes one daemon event on to the window, if it is still open.
export function forwardEvent(window: BrowserWindow | null, event: string, data: Record<string, unknown>): void {
    if (window !== null && !window.isDestroyed()) {
        codex_events.emit([window], 'daemon', { event, data });
    }
}
