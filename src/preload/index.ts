// Gives the desktop app's page its calls to the main process, under the names the page looks for.

// ── Imports ──────────────────────────────────────────────────────────────────

import { contextBridge, ipcRenderer } from "electron";

import { certificate_bridge, desktop_bridge, device_bridge, context_bridge, context_events, local_mcp_bridge } from "../shared/bridge.ts";

// ── Bridge ───────────────────────────────────────────────────────────────────

context_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
device_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
certificate_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
local_mcp_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
desktop_bridge.expose(contextBridge, ipcRenderer, { envelopes: true });
context_events.expose(contextBridge, ipcRenderer);
