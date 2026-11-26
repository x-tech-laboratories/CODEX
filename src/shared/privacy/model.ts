// The shapes the privacy feature hands the page and other programs: each source's marks and the log of what hosted
// engines were sent. The page imports only these types.

// ── Marks ────────────────────────────────────────────────────────────────────

// What the user allows of one collector plugin's items; both off until turned on.
export interface SourceMark {
  // Its items may be sent to a hosted engine; without this they are withheld from one.
  send_to_hosted: boolean;
  // Its items do not count as outside content, so reading them leaves the run's changes at their own levels.
  trusted: boolean;
}

export type MarkName = keyof SourceMark;

export const mark_names: MarkName[] = ["send_to_hosted", "trusted"];

export const unmarked: SourceMark = { send_to_hosted: false, trusted: false };

// One collector plugin as Settings lists it, with its marks.
export interface SourceMarkEntry extends SourceMark {
  // The plugin's id, or for an app marked on its own the plugin's id and its collector, such as codex.items/app.x-tasks.
  plugin_id: string;
  name: string;
  // The collectors it provides, by id, such as ["x-tasks"].
  collectors: string[];
}

// ── Log ──────────────────────────────────────────────────────────────────────

// How many items of one source a run sent or withheld.
export interface SourceCount {
  collector: string;
  label: string;
  count: number;
}

export interface HostedSend {
  id: string;
  run_id: string;
  conversation_id: string;
  engine: string;
  model: string;
  included: SourceCount[];
  withheld: SourceCount[];
  item_count: number;
  sent_at: string;
}
