// A small app answering the standard item calls through X-Libs `items` on a random local port, behind a bearer token,
// with its calls at POST <prefix><method> taking a JSON list as an X-Libs call table does, for tests and for driving
// CODEX's Settings against an app. With with_text, notes have text beyond their snippet and get_item_texts answers.

import fastify, { type FastifyInstance } from "fastify";
import { item_calls, type ItemFields, type ItemMethods, type ItemSource, type ItemTextMethods } from "@x-tech-laboratories/x-libs/items";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";

export interface FakeNote {
  id: string;
  title: string;
  notes: string;
  done?: boolean;
  changed_at: string;
}

export interface FakeItemApp {
  address: string;
  // Each call made, by name, in order.
  calls: string[];
  put: (note: Omit<FakeNote, "changed_at">) => void;
  remove: (id: string) => void;
  close: () => Promise<void>;
}

export interface FakeItemAppOptions {
  token?: string;
  // Where calls are taken: "/api/" as an X-Libs call table serves them, or "/api/call/" as CODEX does.
  prefix?: "/api/" | "/api/call/";
  // Calls the app does not answer, to see a missing one named.
  without?: (keyof ItemMethods | keyof ItemTextMethods)[];
  // Whether a note's whole text is given through get_item_texts, as Markdown.
  with_text?: boolean;
  notes?: Omit<FakeNote, "changed_at">[];
  scheme?: string;
}

export async function start_fake_item_app(options: FakeItemAppOptions = {}): Promise<FakeItemApp> {
  const token = options.token ?? "read-only-test-token";
  const notes = new Map<string, FakeNote>();
  const deleted = new Map<string, string>();
  let clock = Date.parse("2026-11-20T09:00:00.000Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const put = (note: Omit<FakeNote, "changed_at">) => {
    deleted.delete(note.id);
    notes.set(note.id, { ...note, changed_at: tick() });
  };
  for (const note of options.notes ?? []) put(note);

  const as_item = (note: FakeNote): ItemFields => ({ id: note.id, kind: "note", title: note.title, snippet: note.notes, status: note.done ? "done" : "", changed_at: note.changed_at, detail: { words: String(note.notes.split(/\s+/).filter(Boolean).length) } });
  const source: ItemSource = {
    kinds: [{ kind: "note", label: "Note", ...(options.with_text ? { has_text: true } : {}) }],
    search: (query, limit) => [...notes.values()].filter((note) => `${note.title} ${note.notes}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit).map(as_item),
    get: (ids) => ids.flatMap((id) => (notes.has(id) ? [as_item(notes.get(id)!)] : [])),
    changes: (since) => [
      ...[...notes.values()].filter((note) => since === null || note.changed_at > since).map(as_item),
      ...[...deleted].filter(([, at]) => since === null || at > since).map(([id, changed_at]) => ({ id, kind: "note", is_deleted: true as const, changed_at })),
    ],
  };
  const text: ItemSource["text"] = (ids) => ids.flatMap((id) => (notes.has(id) ? [{ id, text: notes.get(id)!.notes, format: "markdown" as const, changed_at: notes.get(id)!.changed_at }] : []));
  const items = item_calls(options.with_text ? { ...source, text } : source, { scheme: options.scheme ?? "x-notes" });
  const calls: string[] = [];
  const served = Object.fromEntries(
    Object.entries(items.methods)
      .filter(([name]) => !(options.without ?? []).includes(name as keyof ItemMethods))
      .map(([name, method]) => [name, (...args: unknown[]) => (calls.push(name), (method as (...args: unknown[]) => unknown)(...args))]),
  );

  const app: FastifyInstance = fastify();
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${token}`) await reply.code(401).send("sign in first");
  });
  const prefix = options.prefix ?? "/api/";
  await app.register(async (api) => register_call_table(api, "", served, { is_read_only: () => true }), { prefix: prefix.replace(/\/$/, "") });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    address,
    calls,
    put,
    remove: (id) => {
      notes.delete(id);
      deleted.set(id, tick());
    },
    close: () => app.close(),
  };
}
