// What the add-on does apart from Thunderbird: turn the email shown into an item, lay the contexts out as a tree of
// rows, and call the CODEX server with the token set in the add-on's options.

// ── Imports ──────────────────────────────────────────────────────────────────

import { bare_message_id, email_uri, shorten } from "../src/shared/collectors/bundled.ts";
import type { FoundItem } from "../src/shared/collectors/collector.ts";
import type { ContextSummary, KeptItem } from "../src/shared/contexts/model.ts";

// ── Server ───────────────────────────────────────────────────────────────────

export interface ServerSettings {
  address: string;
  token: string;
}

// The address without a slash at its end, or null when the setting is not a web address.
export function server_origin(address: string): string | null {
  try {
    const url = new URL(address.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

// One call to the server's API with the arguments by name, as other programs make them.
export async function call_server<Result>(settings: ServerSettings, method: string, args: Record<string, unknown>, fetch_with = fetch): Promise<Result> {
  const base = settings.address.trim().replace(/\/+$/, "");
  const response = await fetch_with(`${base}/api/call/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
    body: JSON.stringify(args),
  });
  if (response.status === 401 || response.status === 403) throw new Error("The server refused the token; make a new one on your account page in CODEX.");
  if (!response.ok) throw new Error((await response.text()) || `The server answered ${response.status}.`);
  if (response.status === 204) return undefined as Result;
  return (await response.json()) as Result;
}

// ── Email ────────────────────────────────────────────────────────────────────

// The first plain text part of a message, such as its body, or "" when it has none.
export function plain_text_of(part: ThunderbirdMessagePart): string {
  if (part.contentType?.startsWith("text/plain") && part.body) return part.body;
  for (const inner of part.parts ?? []) {
    const found = plain_text_of(inner);
    if (found) return found;
  }
  return "";
}

// The email as an item: its Message-ID, subject, sender and the start of its text.
export function email_item(message: ThunderbirdMessageHeader, body: string): FoundItem {
  const date = message.date instanceof Date ? message.date.toISOString() : String(message.date ?? "");
  return {
    source_id: bare_message_id(message.headerMessageId),
    kind: "email",
    title: message.subject?.trim() || "(no subject)",
    snippet: shorten(body) || `From ${message.author}`,
    uri: email_uri(message.headerMessageId),
    detail: { from: message.author, date },
  };
}

// The id CODEX gives the email, to ask which contexts hold it already.
export function email_item_id(message: ThunderbirdMessageHeader): string {
  return `email:${bare_message_id(message.headerMessageId)}`;
}

// The contexts holding the email already, or none when the server has never seen it.
export async function contexts_holding(settings: ServerSettings, message: ThunderbirdMessageHeader, fetch_with = fetch): Promise<string[]> {
  try {
    return (await call_server<KeptItem>(settings, "get_item", { id: email_item_id(message) }, fetch_with)).contexts.map((context) => context.id);
  } catch {
    return [];
  }
}

// ── Contexts ─────────────────────────────────────────────────────────────────

export interface ContextRow {
  context: ContextSummary;
  depth: number;
}

// Every context under its parent in order, each with how deep it sits; one whose parent is gone sits at the top.
export function context_rows(contexts: ContextSummary[]): ContextRow[] {
  const ids = new Set(contexts.map((context) => context.id));
  const children = (parent_id: string | null) =>
    contexts
      .filter((context) => (context.parent_id !== null && ids.has(context.parent_id) ? context.parent_id : null) === parent_id)
      .sort((first, second) => first.position - second.position || first.name.localeCompare(second.name));
  const rows: ContextRow[] = [];
  const walk = (parent_id: string | null, depth: number) => {
    for (const context of children(parent_id)) {
      rows.push({ context, depth });
      walk(context.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}
