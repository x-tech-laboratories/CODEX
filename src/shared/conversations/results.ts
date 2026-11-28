// A run's tool results kept whole in memory for the life of the run, so a result cut to fit or dropped from the
// context can be read again in slices with read_tool_result. Each tool context keeps its own, so a specialist reads
// only its own calls' results. Nothing here is written to the store.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ToolDefinition } from "../engines/engine.ts";
import { untrusted_block } from "../engines/untrusted.ts";

// ── Kept results ─────────────────────────────────────────────────────────────

// The longest result, or slice of one, an engine is given, so one large search cannot crowd out the conversation.
export const max_result_chars = 12_000;

export const read_result_name = "read_tool_result";

// One call's whole result as the engine was given it before any cut: whether it was fenced as outside data, the
// sources it carried, and whether it lowered the run.
export interface KeptResult {
  name: string;
  text: string;
  fenced: boolean;
  sources: ReadonlySet<string>;
  taints: boolean;
}

export type KeptResults = Map<string, KeptResult>;

// The id a call's result is kept under: the engine's own call id when it gave one, made unique within the run.
export function result_id(results: KeptResults, given: string | undefined): string {
  const base = given || `result_${results.size + 1}`;
  let id = base;
  for (let count = 2; results.has(id); count += 1) id = `${base}_${count}`;
  return id;
}

// The result as the engine is shown it: whole when it fits, else its start, fenced when it was, and how to get the rest.
export function shown_result(id: string, kept: KeptResult): string {
  const fence = (text: string) => (kept.fenced ? untrusted_block(text) : text);
  if (kept.text.length <= max_result_chars) return fence(kept.text);
  const total = kept.text.length.toLocaleString("en");
  const cut = max_result_chars.toLocaleString("en");
  const marker = `[Cut at ${cut} of ${total} characters. For the rest call ${read_result_name} with call_id "${id}" and offset ${max_result_chars}, or call ${kept.name} again with narrower arguments.]`;
  return `${fence(kept.text.slice(0, max_result_chars))}\n${marker}`;
}

// ── Reading back ─────────────────────────────────────────────────────────────

// Brief on purpose, since it is offered to every run and specialist beside their own tools.
export const read_result_tool: ToolDefinition = {
  name: read_result_name,
  description: "Reads more of a tool result that was cut short or dropped, by its call_id.",
  parameters: { type: "object", properties: { call_id: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" } }, required: ["call_id"] },
};

// A whole number from the arguments, held within its bounds, or the fallback when it is not one.
function whole_number(value: unknown, fallback: number, least: number, most: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(most, Math.max(least, Math.floor(value))) : fallback;
}

// A slice of a kept result and a line saying where it stands, or why there is none; the result read for taint and sources.
export function read_kept(results: KeptResults, given: Record<string, unknown>): { text: string; is_error: boolean; kept?: KeptResult; slice?: string } {
  const id = typeof given.call_id === "string" ? given.call_id : "";
  const kept = results.get(id);
  if (!kept) {
    const known = [...results.keys()];
    const listed = known.length > 0 ? ` The calls kept in this run are: ${known.slice(-20).join(", ")}.` : " This run has kept no results yet.";
    return { text: `Tool error: there is no result with call_id "${id}" in this run.${listed}`, is_error: true };
  }
  const total = kept.text.length;
  const offset = whole_number(given.offset, 0, 0, total);
  const length = whole_number(given.length, max_result_chars, 1, max_result_chars);
  if (offset >= total) return { text: `There is no more: the result of ${kept.name} call "${id}" has ${total.toLocaleString("en")} characters.`, is_error: false };
  const slice = kept.text.slice(offset, offset + length);
  const next = offset + slice.length;
  const where = `Characters ${offset.toLocaleString("en")} to ${next.toLocaleString("en")} of ${total.toLocaleString("en")} of ${kept.name} call "${id}".`;
  const marker = next < total ? `[${where} For the rest call ${read_result_name} with call_id "${id}" and offset ${next}.]` : `[${where} That is the end.]`;
  return { text: `${kept.fenced ? untrusted_block(slice) : slice}\n${marker}`, is_error: false, kept, slice };
}
