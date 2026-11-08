// The page's side of the bridge: daemon calls that report a failure as a toast, and the daemon's events by name.
import { describe_error } from '@x-tech-laboratories/x-libs/web/errors';
import { toast } from '@x-tech-laboratories/x-libs/web/react/toasts';

import type { DaemonEvent } from '../../shared/ipc.ts';

export const NOTICE_MILLISECONDS = 8000;

export const codex = window.codex;

// Shows a short note; an error shows in red, and both fade after a few seconds as the old notice did.
export function notify(message: string, error = false): void {
    toast(message, { tone: error ? 'bad' : 'info', sticky: false, duration_in_milliseconds: NOTICE_MILLISECONDS });
}

export function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return codex.request(method, params) as Promise<T>;
}

// Calls the daemon and reports a failure as a notice; resolves to null when the call failed.
export async function call_daemon<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
    try {
        return await request<T>(method, params);
    } catch (error) {
        notify(describe_error(error), true);
        return null;
    }
}

export function on_daemon_event(handler: (event: string, data: Record<string, unknown>) => void): () => void {
    return window.codexEvents.on('daemon', (message: DaemonEvent) => handler(message.event, message.data));
}
