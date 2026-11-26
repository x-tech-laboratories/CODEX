// What the tray shows, worked out apart from Electron: the top-level contexts to open, and the window and quit commands.

// ── Imports ──────────────────────────────────────────────────────────────────

import { app_rows, tray_groups, type TrayRow, type TrayView } from "@x-tech-laboratories/x-libs/electron/tray";

import type { ContextSummary } from "../shared/contexts/model.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface TrayState {
  contexts: ContextSummary[];
}

// What the tray's rows do.
export interface TrayActions {
  open_route: (route: string) => void;
  show: () => void;
  quit: () => void;
  quit_completely: () => void;
}

// How many contexts the menu lists.
const most_contexts = 8;

// ── Menu ─────────────────────────────────────────────────────────────────────

// The top-level contexts in their order, each opening the window on it, then showing the window, quitting the window
// and tray, and quitting the daemon too.
export function tray_view(state: TrayState, actions: TrayActions): TrayView {
  const context_rows = state.contexts
    .filter((context) => context.parent_id === null)
    .slice(0, most_contexts)
    .map((context): TrayRow => ({ kind: "item", label: context.name, run: () => actions.open_route(`#/context/${context.id}`) }));
  return {
    tooltip: "CODEX",
    rows: tray_groups(context_rows, app_rows({ app_name: "CODEX", show: actions.show, quit: actions.quit, quit_completely: actions.quit_completely })),
  };
}
