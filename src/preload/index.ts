// Gives the window the bridge's methods and the daemon's events; each reply's envelope is opened so a failure reaches the page as its message.
import { contextBridge, ipcRenderer } from 'electron';

import { codex_bridge, codex_events } from '../shared/ipc.ts';

codex_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
codex_events.expose(contextBridge, ipcRenderer);
