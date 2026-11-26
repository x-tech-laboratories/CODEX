// The engine background work may use: the one chosen, local unless the user allows a hosted one for background work.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { find_engine } from "../conversations/run.ts";
import { is_hosted } from "../engines/engine.ts";
import { background_setting } from "../jobs/records.ts";

// ── Engine ───────────────────────────────────────────────────────────────────

// The engine background work may use, or why there is none, and whether that is because none is set up.
export async function background_engine(database: SqlDatabase): Promise<{ problem: string; no_engine?: boolean }> {
  const found = await find_engine(database);
  if (!found.running) return { problem: found.problem, no_engine: true };
  if (is_hosted(found.running) && !background_setting(database, "hosted")) {
    return { problem: `The engine in use, ${found.engine?.label ?? "the one chosen"}, is hosted, and background work uses only an engine on this computer or your own network unless you allow a hosted one above.` };
  }
  return { problem: "" };
}
