// What a stored message, proposal or event records of the sources its run had read: collector ids, never content.

// ── Sources ──────────────────────────────────────────────────────────────────

// Stands for sources not recorded, as on everything kept before 2026-11-26; never sent to a hosted model.
export const unrecorded_source = "*";

export const unrecorded_label = "sources not recorded (kept before 2026-11-26)";

// The collector ids in a stored JSON list; anything unreadable counts as not recorded.
export function parse_sources(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value) && value.every((each) => typeof each === "string")) return value as string[];
  } catch {
    // Read below as not recorded.
  }
  return [unrecorded_source];
}
