// Where the assistant's runs live: set once by the host the store runs in, the web server or the desktop daemon, so a
// run started by a call can outlive that call, change data through the store's own calls and stream to open pages.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { ConversationEvent } from "./model.ts";

// ── Host ─────────────────────────────────────────────────────────────────────

export interface AssistantHost {
  database: () => SqlDatabase;
  // Runs one of the store's calls as the page would, so it is recorded in History and announced like any other.
  call: (method: string, args: unknown[]) => Promise<unknown>;
  // Tells open pages and devices the conversation's own rows changed.
  announce: () => void;
  // Streams a run's progress to open pages.
  emit: (event: ConversationEvent) => void;
}

let current: AssistantHost | null = null;

export function use_assistant_host(host: AssistantHost | null): void {
  current = host;
}

export function assistant_host(): AssistantHost {
  if (!current) throw new Error("The assistant runs only where the store runs: on the server or in the desktop app's daemon.");
  return current;
}
