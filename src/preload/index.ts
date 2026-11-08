// Gives the window the bridge's methods and the daemon's events, unwrapping each reply so a failure reaches the page as its message.
import { contextBridge, ipcRenderer } from 'electron';

import { codex_bridge, codex_events, type Envelope } from '../shared/ipc.ts';

const unwrapping = {
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        const envelope = (await ipcRenderer.invoke(channel, ...args)) as Envelope;
        if (!envelope.ok) {
            throw new Error(envelope.error);
        }
        return envelope.result;
    },
};

codex_bridge.expose(contextBridge, unwrapping);
codex_events.expose(contextBridge, ipcRenderer);
