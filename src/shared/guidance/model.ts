// The shapes the guidance feature hands the page and other programs: what the user wrote about how one tool plugin or
// source app works, for the assistant's specialist for it, by the source the run counts it as. The page imports only these.

// ── Names ────────────────────────────────────────────────────────────────────

// The synced setting holding the user's guidance, by source: a collector's id, such as x-tasks, or a tool plugin's
// source, such as tool:codex.web/web.
export const guidance_setting = "plugin_guidance";

// The longest guidance the user may keep for one source.
export const longest_guidance = 4000;

// The user's guidance for one source in a stored setting, empty for none.
export function guidance_in(saved: unknown, source: string): string {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return "";
  const text = (saved as Record<string, unknown>)[source];
  return typeof text === "string" ? text : "";
}
