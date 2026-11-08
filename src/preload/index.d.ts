import type { Client } from '@x-tech-laboratories/x-libs/electron/bridge';
import type { EventsClient } from '@x-tech-laboratories/x-libs/electron/events';
import type { CodexApi, CodexEvents } from '../shared/ipc.ts';

declare global {
    interface Window {
        codex: Client<CodexApi>;
        codexEvents: EventsClient<CodexEvents>;
    }
}

export {};
