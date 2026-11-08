// The bridge between the window and the main process: the methods the page may call and the one channel the daemon's events arrive on.
import { define_bridge } from '@x-tech-laboratories/x-libs/electron/bridge';
import { define_events } from '@x-tech-laboratories/x-libs/electron/events';

// ============================================================================
// Methods
// ============================================================================

export type DialogRequest = {
    title?: string;
    defaultPath?: string;
    directory?: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
};

export type UserCommand = { name: string; description: string; mode: string | null };

export type Connection = { socket_path: string; started: boolean };

// Each method as the main process answers it; the page sees every one as returning a promise.
export interface CodexApi {
    connect(): Connection;
    request(method: string, params?: Record<string, unknown>): unknown;
    open_dialog(options?: DialogRequest): string | null;
    save_dialog(options?: DialogRequest): string | null;
    copy_text(text: string): boolean;
    list_commands(filesystem_root: string): UserCommand[];
    get_autostart(): boolean;
    set_autostart(enabled: boolean): boolean;
    restart_daemon(): boolean;
}

export const CODEX_METHODS = [
    'connect',
    'request',
    'open_dialog',
    'save_dialog',
    'copy_text',
    'list_commands',
    'get_autostart',
    'set_autostart',
    'restart_daemon',
] as const;

export const codex_bridge = define_bridge<CodexApi>('codex', CODEX_METHODS);

// ============================================================================
// Events
// ============================================================================

// The daemon's events, and the main process's own, all travel as one named event with the daemon's shape.
export type DaemonEvent = { event: string; data: Record<string, unknown> };

export interface CodexEvents extends Record<string, unknown> {
    daemon: DaemonEvent;
}

export const codex_events = define_events<CodexEvents>('codexEvents');

// A reply from the main process: the result, or the error's text, so the page sees a plain message.
export type Envelope<T = unknown> = { ok: true; result: T } | { ok: false; error: string };
