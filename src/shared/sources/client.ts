// Talking to an app through the Application Standard's four read-only item calls, and nothing else: the standard's
// POST /api/call/<method> with the arguments as a JSON list in order, falling back to POST /api/<method> for an app not
// yet on the standard path, and the first that answers is remembered. Failures are put in plain words, and the token
// never reaches one.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { DeletedItem, Item, ItemChange, ItemKind } from "@x-tech-laboratories/x-libs/items";

// ── Calls ────────────────────────────────────────────────────────────────────

export const item_read_calls = ["list_item_kinds", "search_items", "get_items", "list_item_changes"] as const;

export type ItemReadCall = (typeof item_read_calls)[number];

// The standard path, then X-Tasks' older one; the fallback can go once every X-Tasks server CODEX reads answers at /api/call/.
const call_prefixes = ["/api/call/", "/api/"];

const wait_ms = 15_000;

// The prefix each address answered on, so later calls go straight there.
const known_prefixes = new Map<string, string>();

export interface SourceAddress {
  name: string;
  address: string;
  token: string;
}

// The address without a slash at its end, or a plain refusal for anything that is not a web address.
export function checked_address(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Give the app's address, such as https://tasks.example.org.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The app's address starts with https:// or http://.");
  return trimmed;
}

function host_of(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

interface Answer {
  status: number;
  text: string;
}

async function post(source: SourceAddress, base: string, prefix: string, method: ItemReadCall, args: unknown[]): Promise<Answer> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (source.token) headers.authorization = `Bearer ${source.token}`;
  let response: Response;
  try {
    response = await fetch(`${base}${prefix}${method}`, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(wait_ms) });
  } catch (error) {
    const cause = (error as Error).name === "TimeoutError" ? "it did not answer in time" : "nothing answered there";
    throw new Error(`Could not reach ${source.name} at ${host_of(base)}: ${cause}. Check its address, and that it is running.`);
  }
  return { status: response.status, text: await response.text() };
}

function parsed(source: SourceAddress, method: ItemReadCall, answer: Answer): unknown {
  if (answer.status === 204) return null;
  try {
    return JSON.parse(answer.text);
  } catch {
    throw new Error(`${source.name} does not answer the item calls: ${method} gave no JSON.`);
  }
}

// Makes one of the four calls with its arguments in order, and gives back what the app answered.
export async function call_source(source: SourceAddress, method: ItemReadCall, args: unknown[]): Promise<unknown> {
  const base = checked_address(source.address);
  const known = known_prefixes.get(base);
  const answers: Answer[] = [];
  for (const prefix of known ? [known, ...call_prefixes.filter((each) => each !== known)] : call_prefixes) {
    const answer = await post(source, base, prefix, method, args);
    if (answer.status >= 200 && answer.status < 300) {
      known_prefixes.set(base, prefix);
      return parsed(source, method, answer);
    }
    answers.push(answer);
    // An app found on its prefix that refuses the call says why; another prefix would only be refused too.
    if (prefix === known && answer.status !== 404) break;
  }
  const statuses = answers.map((answer) => answer.status);
  if (statuses.includes(401)) throw new Error(`${source.name} refused the token; make a read-only token in ${source.name} and give it again.`);
  if (statuses.includes(404)) throw new Error(`${source.name} does not answer the item calls: ${method} is missing.`);
  if (statuses.includes(403)) throw new Error(`${source.name} refused the token for ${method}; give a token that may read.`);
  const last = answers.at(-1)!;
  const said = last.text.trim().slice(0, 200);
  throw new Error(`${source.name} could not answer ${method} (${last.status}${said ? `: ${said}` : ""}).`);
}

function list_of<Value>(source: SourceAddress, method: ItemReadCall, value: unknown): Value[] {
  if (!Array.isArray(value)) throw new Error(`${source.name} does not answer the item calls: ${method} gave no list.`);
  return value as Value[];
}

// ── The four calls ───────────────────────────────────────────────────────────

export async function list_kinds(source: SourceAddress): Promise<ItemKind[]> {
  const kinds = list_of<ItemKind>(source, "list_item_kinds", await call_source(source, "list_item_kinds", []));
  return kinds.filter((each) => typeof each?.kind === "string").map((each) => ({ kind: each.kind, label: typeof each.label === "string" && each.label ? each.label : each.kind }));
}

export async function search(source: SourceAddress, query: string, limit: number): Promise<Item[]> {
  return list_of<Item>(source, "search_items", await call_source(source, "search_items", [query, limit])).filter(is_item);
}

// The items with these ids, asked for at most a hundred at a time, as the standard allows.
export async function get(source: SourceAddress, ids: string[]): Promise<Item[]> {
  const found: Item[] = [];
  for (let start = 0; start < ids.length; start += page_size) {
    found.push(...list_of<Item>(source, "get_items", await call_source(source, "get_items", [ids.slice(start, start + page_size)])).filter(is_item));
  }
  return found;
}

export async function changes(source: SourceAddress, since: string | null, limit: number): Promise<ItemChange[]> {
  return list_of<ItemChange>(source, "list_item_changes", await call_source(source, "list_item_changes", [since, limit])).filter(
    (change) => typeof change?.id === "string" && typeof change.changed_at === "string" && (is_deleted(change) || is_item(change)),
  );
}

export const page_size = 100;

export function is_deleted(change: ItemChange): change is DeletedItem & { is_deleted: true } {
  return (change as DeletedItem).is_deleted === true;
}

function is_item(value: unknown): value is Item {
  const item = value as Item | null;
  return typeof item?.id === "string" && item.id !== "" && typeof item.kind === "string";
}

// For tests, which start each server afresh.
export function forget_prefixes(): void {
  known_prefixes.clear();
}
