// Asks every collector what became of its items every so often, as the refresh_minutes setting says, so titles and
// states stay current with no window open.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import type { RefreshReport } from "../shared/contexts/model.ts";import { bind_methods } from "../shared/store.ts";

// ── Refreshing ───────────────────────────────────────────────────────────────

const check_ms = 60_000;
const minute_ms = 60_000;

// Refreshes once the set minutes have passed since the last refresh, checking each minute; on_change tells open pages
// and on_report hears what each refresh found.
export function keep_refreshing(
  database: () => SqlDatabase,
  { on_change = () => undefined, on_report = () => undefined, now = () => Date.now() }: { on_change?: () => void; on_report?: (report: RefreshReport) => void; now?: () => number } = {},
): { stop: () => void; check: () => Promise<void> } {
  let last = 0;
  let running = false;
  const check = async (): Promise<void> => {
    if (running) return;
    const methods = bind_methods(database, on_change);
    const minutes = Number(methods.get_settings().refresh_minutes);
    if (!(minutes > 0) || now() - last < minutes * minute_ms) return;
    running = true;
    try {
      const report = await methods.refresh_items(null);
      for (const problem of report.problems) console.warn(`refresh: ${problem}`);
      on_report(report);
    } catch (error) {
      console.warn("refresh:", error);
    } finally {
      last = now();
      running = false;
    }
  };
  const timer = setInterval(() => void check(), check_ms);
  return { stop: () => clearInterval(timer), check };
}
