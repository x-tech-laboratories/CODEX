// The assistant's interests: topics it may research on the public web for its own knowledge. An engine, or a program,
// only proposes one; the user adds, accepts, pauses and drops them at CODEX's own page alone, since an accepted topic is
// the text sent to a search engine. At most so many are accepted at once.

// ── Imports ──────────────────────────────────────────────────────────────────

import { synced_tables } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { current_caller } from "../caller.ts";
import { define_feature } from "../feature.ts";
import { settings_feature } from "../settings.ts";
import { migrations } from "./migrations/index.ts";
import { interest_defaults, interest_settings, max_accepted_bounds, type Interest, type InterestState } from "./model.ts";
import { checked_reason, checked_topic, insert_interest, interest_row, list_interest_rows, max_accepted, update_interest } from "./records.ts";
import { interest_tables } from "./schema.ts";

// ── Reading ──────────────────────────────────────────────────────────────────

function list_interests(database: SqlDatabase): Interest[] {
  return list_interest_rows(database);
}

// ── Checking ─────────────────────────────────────────────────────────────────

// An interest with the same topic, whatever its state, so a dropped one is not proposed again.
function same_topic(database: SqlDatabase, topic: string, except = ""): Interest | undefined {
  const plain = topic.toLowerCase();
  return list_interest_rows(database).find((each) => each.id !== except && each.topic.toLowerCase() === plain);
}

// Refuses to accept one more than the most allowed at once.
function check_room(database: SqlDatabase, except = ""): void {
  const most = max_accepted(database);
  const accepted = list_interest_rows(database).filter((each) => each.state === "accepted" && each.id !== except).length;
  if (accepted >= most) throw new Error(`${most} interests are accepted already, the most allowed at once; pause or drop one first, or allow more under Settings → Assistant → Interests.`);
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface InterestMakerInput {
  engine?: string;
  model?: string;
  sources?: string[];
  conversation_id?: string;
}

export interface InterestOutcome {
  outcome: "proposed" | "refused";
  id: string;
  message: string;
}

// An engine's or a program's proposal; it is never researched until the user accepts it at the page.
function propose_interest(database: SqlDatabase, topic: string, reason: string, maker?: InterestMakerInput): InterestOutcome {
  const checked = checked_topic(topic);
  const found = same_topic(database, checked);
  if (found) return { outcome: "refused", id: found.id, message: `An interest in “${found.topic}” is already ${found.state}; it is not proposed again.` };
  const by = maker === undefined ? (current_caller() === "program" ? "program" : "user") : "engine";
  const id = insert_interest(database, {
    topic: checked,
    reason: checked_reason(reason),
    state: "proposed",
    made_by: by,
    engine: String(maker?.engine ?? ""),
    model: String(maker?.model ?? ""),
    conversation_id: String(maker?.conversation_id ?? ""),
    sources: Array.isArray(maker?.sources) ? maker.sources.map(String) : [],
  });
  return { outcome: "proposed", id, message: `Proposed the interest “${checked}” as ${id}; it waits for the user, who reads the exact topic before anything is searched.` };
}

// The user's own interest, accepted as typed, since the user wrote the words sent to the search engine.
function add_interest(database: SqlDatabase, topic: string, reason = ""): string {
  const checked = checked_topic(topic);
  const found = same_topic(database, checked);
  if (found) throw new Error(`An interest in “${found.topic}” is already listed, ${found.state}.`);
  check_room(database);
  return insert_interest(database, { topic: checked, reason: checked_reason(reason), state: "accepted", made_by: "user" });
}

// Accepts an interest with the topic as the user read and perhaps edited it, the exact text a search engine is sent.
function accept_interest(database: SqlDatabase, id: string, topic: string): void {
  const row = interest_row(database, id);
  const checked = checked_topic(topic);
  const found = same_topic(database, checked, id);
  if (found) throw new Error(`An interest in “${found.topic}” is already listed, ${found.state}.`);
  if (row.state !== "accepted") check_room(database, id);
  update_interest(database, id, { topic: checked, state: "accepted" });
}

// Pauses or drops an interest, or proposes it again; its findings stay.
function set_interest_state(database: SqlDatabase, id: string, state: Exclude<InterestState, "accepted">): void {
  interest_row(database, id);
  if (state !== "paused" && state !== "dropped" && state !== "proposed") throw new Error("An interest is paused, dropped or proposed here; accept_interest accepts one.");
  update_interest(database, id, { state });
}

function set_max_interests(database: SqlDatabase, most: number): void {
  const [least, highest] = max_accepted_bounds;
  if (!Number.isInteger(most) || most < least || most > highest) throw new Error(`The most interests accepted at once is a whole number from ${least} to ${highest}.`);
  settings_feature.methods.set_setting(database, interest_settings.max_accepted, most);
}

// ── Feature ──────────────────────────────────────────────────────────────────

const topic_schema = text("The topic, a short phrase a search engine is sent as it is, such as growing tomatoes in a cold greenhouse. Never put anything personal in it: no names, places, numbers or what a note says.");

export const interests_feature = define_feature({
  id: "interests",
  migrations: migrations.map((migration) => migration.statements),
  tables: synced_tables(interest_tables),
  methods: { list_interests, propose_interest, add_interest, accept_interest, set_interest_state, set_max_interests },
  api: {
    list_interests: {
      description:
        "Lists the assistant's interests, topics it may research on the public web for its own knowledge: each topic, why, whether it is proposed, accepted, paused or dropped, who made it, the conversation it came from, how many findings it has, the context they are kept in, and when it was last researched.",
      params: [],
    },
    propose_interest: {
      description:
        "Proposes an interest of the assistant's own: a topic the user's conversations show they care about, which the assistant would like to research on the public web. It only proposes: nothing is searched until the user reads the exact topic and accepts it. A topic already listed, dropped ones included, is not proposed again.",
      params: [
        { name: "topic", schema: topic_schema },
        { name: "reason", schema: text("Why, in a short plain line.") },
      ],
    },
    add_interest: {
      description: "Adds an interest the user typed, accepted at once. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "topic", schema: topic_schema },
        { name: "reason", schema: text("Why, in a short plain line; may be empty."), optional: true },
      ],
    },
    accept_interest: {
      description:
        "Accepts an interest with its topic as the user read and perhaps edited it, the exact text a search engine is sent. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("interest") },
        { name: "topic", schema: topic_schema },
      ],
    },
    set_interest_state: {
      description: "Pauses or drops an interest, or puts it back to proposed; its findings stay. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [
        { name: "id", schema: id_of("interest") },
        { name: "state", schema: { type: "string", enum: ["paused", "dropped", "proposed"], description: "paused, dropped or proposed." } },
      ],
    },
    set_max_interests: {
      description: `Sets the most interests accepted at once, from ${max_accepted_bounds[0]} to ${max_accepted_bounds[1]}. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.`,
      params: [{ name: "most", schema: { type: "integer", description: "The most accepted at once." } }],
    },
  },
  setting_defaults: interest_defaults,
});
