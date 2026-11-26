// The seven maintenance jobs, each a cheap check that says how much work there is without calling a model or any app,
// and a run that does at most its budget's worth. Changes go through the action policy: a rule's links and the ending
// of links CODEX itself made are its own derived data, rebuilt from the items; ending a link the user, a program or an
// engine made is applied only at its `background` level and otherwise proposed; similar items, entities that look
// like one and what Suggest links finds are proposals by nature. No job writes to another app.

// ── Imports ──────────────────────────────────────────────────────────────────

import { and, eq, inArray, ne } from "@x-tech-laboratories/x-libs/drizzle";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_items, contexts, items } from "../contexts/schema.ts";
import { assistant_host } from "../conversations/host.ts";
import { conversation_collector, conversation_item_id } from "../conversations/model.ts";
import { add_conversation_record, has_conversation, rename_conversation_record } from "../conversations/records.ts";
import { maintenance_conversation_id } from "../jobs/model.ts";
import { start_run, stop_run_of, type RunEnd } from "../conversations/run.ts";
import { drizzle_of } from "../feature.ts";
import { node_key, parse_node_key, type NodeKind } from "../graph/model.ts";
import { from_key, is_open, name_key, now as graph_now, parse_names, read_joins, to_key, type LinkRow } from "../graph/records.ts";
import { rule_link_id, run_rules } from "../graph/rules.ts";
import { graph_entities, graph_links } from "../graph/schema.ts";
import { propose_similar } from "../graph/similarity.ts";
import { graph_part, proposals_note, suggest_links_message, suggest_rounds, suggest_tools } from "../graph/store.ts";
import { insert_link } from "../graph/writing.ts";
import { inbox_feature } from "../inbox/store.ts";
import { context_mark } from "../jobs/runner.ts";
import { decide, level_of } from "../policy/policy.ts";
import { add_proposal, list_proposals_of } from "../policy/proposals.ts";
import { count_changed, count_out_of_step, count_unembedded, drop_changed, embed_pending, find_embedder, peek_changed, sync_documents } from "../search/indexer.ts";
import { background_engine } from "./engine.ts";
import { research_job } from "./research.ts";
import { maintenance_contexts } from "./schema.ts";
import { maintenance_jobs, maintenance_keys, type MaintenanceBudget, type MaintenanceKey, type MaintenanceUse } from "./model.ts";
import { checks_of, runs_since } from "./records.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface JobContext {
  database: SqlDatabase;
  index: SqlDatabase;
  now: number;
  // Aborts at the run's time limit, when background work is paused, and when the loop stops.
  signal: AbortSignal;
  budget: MaintenanceBudget;
  // What the job used today before this run.
  used: MaintenanceUse;
  // This device's name, as runs record it.
  device: string;
}

// How much work there is, or why the job cannot run at all, in plain words.
export interface Work {
  count: number;
  reason?: string;
}

export interface Done {
  items: number;
  applied: string[];
  proposed: string[];
  // A plain note on how it ended, such as what waits for the next run.
  note: string;
  // Set when it failed; the run is kept as failed, and so listed in the Inbox.
  error?: string;
  // It gave way, to a conversation or a pause, before it was done.
  gave_way?: boolean;
  // It changed the store, so History records it and pages hear of it.
  changed_store?: boolean;
  engine?: string;
  model?: string;
  rounds?: number;
  input_tokens?: number;
  output_tokens?: number;
  conversation_id?: string;
  run_id?: string;
}

export interface MaintenanceJob {
  check(context: JobContext): Work | Promise<Work>;
  run(context: JobContext): Promise<Done>;
}

function count_words(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
}

function done(items: number, applied: string[] = [], proposed: string[] = [], note = ""): Done {
  return { items, applied, proposed, note };
}

// ── 1. Index ─────────────────────────────────────────────────────────────────

const index_job: MaintenanceJob = {
  check: ({ database, index }) => ({ count: count_out_of_step(database, index) }),
  async run({ database, index, budget }) {
    const problems: string[] = [];
    const synced = await sync_documents(database, index, problems, budget.items_per_run);
    const handled = synced.written + synced.removed;
    const applied = handled > 0 ? [`Brought ${count_words(handled, "document", "documents")} of the index up to date.`] : [];
    const note = [synced.waiting > 0 ? `${count_words(synced.waiting, "item's text waits", "items' text wait")} for the next run.` : "", ...problems].filter(Boolean).join(" ");
    return { ...done(handled, applied, [], note), ...(problems.length > 0 && handled === 0 ? { error: problems.join(" ") } : {}) };
  },
};

// ── 2. Embed ─────────────────────────────────────────────────────────────────

const embed_job: MaintenanceJob = {
  async check({ database, index }) {
    const { found, problem } = await find_embedder(database);
    if (problem) return { count: 0, reason: problem };
    if (!found) return { count: 0, reason: "No embedder is chosen under Settings → Index, so there is nothing to embed with." };
    return { count: await count_unembedded(database, index) };
  },
  async run({ database, index, signal, budget }) {
    const embedded = await embed_pending(database, index, signal, 250, new Set(), undefined, budget.items_per_run);
    const left = await count_unembedded(database, index);
    const note = signal.aborted ? "Stopped before it was done." : left > 0 ? `${count_words(left, "piece waits", "pieces wait")} for the next run.` : "";
    return { ...done(embedded, embedded > 0 ? [`Embedded ${count_words(embedded, "piece", "pieces")} of text.`] : [], [], note), gave_way: signal.aborted && embedded === 0 };
  },
};

// ── 3. Rules ─────────────────────────────────────────────────────────────────

function open_rule_links(database: SqlDatabase): Set<string> {
  const at = graph_now();
  return new Set(
    drizzle_of(database)
      .select({ id: graph_links.id, valid_until: graph_links.valid_until })
      .from(graph_links)
      .where(and(eq(graph_links.made_by, "rule"), ne(graph_links.status, "rejected")))
      .all()
      .filter((row) => is_open(row, at))
      .map((row) => row.id),
  );
}

const rules_job: MaintenanceJob = {
  check: ({ index }) => ({ count: count_changed(index, "rules") }),
  async run({ database, index, budget }) {
    const keys = peek_changed(index, "rules", budget.items_per_run);
    const before = open_rule_links(database);
    const wrote = run_rules(database, index, { written: keys, all: false, embedded: [], embedder: null });
    drop_changed(index, "rules", keys);
    const after = open_rule_links(database);
    const made = [...after].filter((id) => !before.has(id)).length;
    const ended = [...before].filter((id) => !after.has(id)).length;
    const applied = [made > 0 ? `The rules made ${count_words(made, "link", "links")}.` : "", ended > 0 ? `The rules ended ${count_words(ended, "link", "links")} no longer found.` : ""].filter(Boolean);
    const left = count_changed(index, "rules");
    return { ...done(keys.length, applied, [], left > 0 ? `${count_words(left, "document waits", "documents wait")} for the next run.` : ""), changed_store: wrote };
  },
};

// ── 4. Similarity ────────────────────────────────────────────────────────────

function proposed_similar_count(database: SqlDatabase): number {
  return drizzle_of(database).select({ id: graph_links.id }).from(graph_links).where(and(eq(graph_links.made_by, "similarity"), eq(graph_links.status, "proposed"))).all().length;
}

const similarity_job: MaintenanceJob = {
  async check({ database, index }) {
    const waiting = count_changed(index, "similarity");
    if (waiting === 0) return { count: 0 };
    const { found } = await find_embedder(database);
    if (!found) return { count: 0, reason: "No embedder is chosen under Settings → Index, so there are no meanings to compare." };
    return { count: waiting };
  },
  async run({ database, index, budget }) {
    const { found } = await find_embedder(database);
    const keys = peek_changed(index, "similarity", budget.items_per_run);
    const before = proposed_similar_count(database);
    const wrote = found ? propose_similar(database, index, { written: [], all: false, embedded: keys, embedder: { id: found.id, model: found.embedder.model() } }) : false;
    drop_changed(index, "similarity", keys);
    const made = Math.max(0, proposed_similar_count(database) - before);
    const left = count_changed(index, "similarity");
    return { ...done(keys.length, [], made > 0 ? [`Proposed ${count_words(made, "link", "links")} between similar items.`] : [], left > 0 ? `${count_words(left, "item waits", "items wait")} for the next run.` : ""), changed_store: wrote };
  },
};

// ── 5. Tidy ──────────────────────────────────────────────────────────────────

export const rule_same_name = "same_name";

// What a node is called, for a plain summary.
function label_of(database: SqlDatabase, key: string): string {
  const parsed = parse_node_key(key);
  if (!parsed) return key;
  const db = drizzle_of(database);
  if (parsed.kind === "item") return db.select({ title: items.title }).from(items).where(eq(items.id, parsed.id)).get()?.title ?? key;
  if (parsed.kind === "context") return db.select({ name: contexts.name }).from(contexts).where(eq(contexts.id, parsed.id)).get()?.name ?? key;
  return db.select({ name: graph_entities.name }).from(graph_entities).where(eq(graph_entities.id, parsed.id)).get()?.name ?? key;
}

// The open links, not rejected, that touch an item its app no longer has.
function links_to_missing(database: SqlDatabase): { link: LinkRow; missing: string }[] {
  const db = drizzle_of(database);
  const missing = new Set(db.select({ id: items.id }).from(items).where(eq(items.status, "missing")).all().map((row) => row.id));
  if (missing.size === 0) return [];
  const at = graph_now();
  const found: { link: LinkRow; missing: string }[] = [];
  for (const link of db.select().from(graph_links).where(ne(graph_links.status, "rejected")).all()) {
    if (!is_open(link, at)) continue;
    const gone = [from_key(link), to_key(link)].find((key) => key.startsWith("item:") && missing.has(key.slice(5)));
    if (gone) found.push({ link, missing: gone });
  }
  return found;
}

// The links a proposal to end them already waits for, or that the user said no to, so neither is proposed again.
function ending_asked(database: SqlDatabase): Set<string> {
  return new Set(
    list_proposals_of(database, null)
      .filter((proposal) => proposal.method === "close_graph_link" && (proposal.status === "waiting" || proposal.status === "rejected"))
      .map((proposal) => String(proposal.arguments.id ?? "")),
  );
}

// Pairs of entities of one kind sharing a name, not read as one already and with no same_as link between them in any state.
function likely_duplicates(database: SqlDatabase): [typeof graph_entities.$inferSelect, typeof graph_entities.$inferSelect][] {
  const rows = drizzle_of(database).select().from(graph_entities).where(eq(graph_entities.status, "accepted")).all();
  const joins = read_joins(database);
  const linked = new Set(
    drizzle_of(database)
      .select()
      .from(graph_links)
      .where(and(eq(graph_links.type, "same_as"), eq(graph_links.from_kind, "entity"), eq(graph_links.to_kind, "entity")))
      .all()
      .flatMap((row) => [`${row.from_id}|${row.to_id}`, `${row.to_id}|${row.from_id}`]),
  );
  const by_name = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    for (const name of new Set([row.name, ...parse_names(row.alt_names)].map(name_key).filter(Boolean))) {
      const key = `${row.kind}|${name}`;
      by_name.set(key, [...(by_name.get(key) ?? []), row]);
    }
  }
  const pairs = new Map<string, [(typeof rows)[number], (typeof rows)[number]]>();
  for (const group of by_name.values()) {
    for (let first = 0; first < group.length; first++) {
      for (let second = first + 1; second < group.length; second++) {
        const [a, b] = [group[first]!, group[second]!].sort((x, y) => x.id.localeCompare(y.id)) as [(typeof rows)[number], (typeof rows)[number]];
        if (a.id === b.id || joins.rep_of(a.id) === joins.rep_of(b.id) || linked.has(`${a.id}|${b.id}`)) continue;
        pairs.set(`${a.id}|${b.id}`, [a, b]);
      }
    }
  }
  return [...pairs.values()];
}

function link_words(database: SqlDatabase, link: LinkRow): string {
  return `${label_of(database, from_key(link))} ${link.type.replace("_", " ")}${link.label ? ` (${link.label})` : ""} ${label_of(database, to_key(link))}`;
}

function sources_of_ends(database: SqlDatabase, link: LinkRow): string[] {
  const ids = [from_key(link), to_key(link)].filter((key) => key.startsWith("item:")).map((key) => key.slice(5));
  if (ids.length === 0) return [];
  return [...new Set(drizzle_of(database).select({ collector: items.collector }).from(items).where(inArray(items.id, ids)).all().map((row) => row.collector))].sort();
}

// The conversation background maintenance's proposals are kept in, in no context, made the first time one is needed;
// approving or rejecting one is recorded there.
export function maintenance_conversation(database: SqlDatabase): string {
  if (!has_conversation(database, maintenance_conversation_id)) {
    add_conversation_record(database, null, maintenance_conversation_id);
    rename_conversation_record(database, maintenance_conversation_id, "Background maintenance");
  }
  return maintenance_conversation_id;
}

const tidy_job: MaintenanceJob = {
  check({ database }) {
    const asked = ending_asked(database);
    const to_end = links_to_missing(database).filter(({ link }) => !asked.has(link.id));
    return { count: to_end.length + likely_duplicates(database).length };
  },
  async run({ database, budget, signal }) {
    const asked = ending_asked(database);
    let left = budget.items_per_run;
    let ended = 0;
    let asking = 0;
    let handled = 0;
    const applied: string[] = [];
    const proposed: string[] = [];
    const notes: string[] = [];
    const at = graph_now();
    const level = level_of(database, "close_graph_link");
    const decision = decide(level, "background", false);
    for (const { link, missing } of links_to_missing(database)) {
      if (left <= 0 || signal.aborted) break;
      if (asked.has(link.id)) continue;
      left--;
      handled++;
      const words = link_words(database, link);
      // A link a rule or similarity made is CODEX's own, rebuilt from the items, so it ends like a rule's link no longer found.
      if (link.made_by === "rule" || link.made_by === "similarity" || decision.action === "run") {
        drizzle_of(database).update(graph_links).set({ valid_until: at }).where(eq(graph_links.id, link.id)).run();
        ended++;
        if (link.made_by !== "rule" && link.made_by !== "similarity") applied.push(`Ended the link “${words}”, since ${label_of(database, missing)} is gone from its app.`);
        continue;
      }
      if (decision.action === "refuse") {
        notes.push(`Left ${count_words(1, "link", "links")} to an item gone from its app, since ending links is restricted.`);
        continue;
      }
      const summary = `End the link “${words}”, since ${label_of(database, missing)} is gone from its app.`;
      add_proposal(database, { conversation_id: maintenance_conversation(database), method: "close_graph_link", arguments: { id: link.id }, summary, reason: "level", sources: sources_of_ends(database, link) });
      proposed.push(summary);
      asking++;
    }
    if (ended > applied.length) applied.unshift(`Ended ${count_words(ended - applied.length, "link", "links")} CODEX had made to items gone from their apps.`);
    let joined = 0;
    for (const [first, second] of likely_duplicates(database)) {
      if (left <= 0 || signal.aborted) break;
      left--;
      handled++;
      insert_link(database, {
        id: rule_link_id(rule_same_name, node_key("entity", first.id), node_key("entity", second.id)),
        from: node_key("entity", first.id),
        to: node_key("entity", second.id),
        type: "same_as",
        label: "same name",
        status: "proposed",
        made_by: "rule",
        rule: rule_same_name,
        sources: [...parse_names(first.sources), ...parse_names(second.sources)],
      });
      joined++;
    }
    if (joined > 0) proposed.push(`Proposed joining ${count_words(joined, "pair", "pairs")} of entities that share a name.`);
    // A run that proposed in the maintenance conversation names it, which marks it as a background job's, not one the user talks in.
    const proposed_in = asking > 0 ? { conversation_id: maintenance_conversation_id } : {};
    return { ...done(handled, applied, proposed, [...new Set(notes)].join(" ")), changed_store: handled > 0, ...proposed_in };
  },
};

// ── 6. Suggest links ─────────────────────────────────────────────────────────

type SuggestRow = typeof maintenance_contexts.$inferSelect;

// Contexts holding items whose items changed since Suggest links last ran on them in the background, longest waiting first.
function contexts_to_suggest(database: SqlDatabase): { id: string; mark: string; row: SuggestRow | undefined }[] {
  const db = drizzle_of(database);
  const done_rows = new Map(db.select().from(maintenance_contexts).all().map((row) => [row.context_id, row]));
  const holding = new Set(db.select({ id: context_items.context_id }).from(context_items).innerJoin(items, eq(items.id, context_items.item_id)).where(ne(items.collector, conversation_collector)).all().map((row) => row.id));
  const found: { id: string; mark: string; row: SuggestRow | undefined }[] = [];
  for (const context of db.select({ id: contexts.id, is_archived: contexts.is_archived }).from(contexts).all()) {
    if (!holding.has(context.id) || context.is_archived) continue;
    const row = done_rows.get(context.id);
    const mark = context_mark(database, context.id, row?.conversation_id ? conversation_item_id(row.conversation_id) : "");
    if (row?.context_mark !== mark) found.push({ id: context.id, mark, row });
  }
  return found.sort((first, second) => (first.row?.suggested_at ?? "").localeCompare(second.row?.suggested_at ?? ""));
}

function keep_suggested(database: SqlDatabase, context_id: string, conversation_id: string, at: number): void {
  const mark = context_mark(database, context_id, conversation_item_id(conversation_id));
  const values = { context_mark: mark, conversation_id, suggested_at: new Date(at).toISOString() };
  drizzle_of(database).insert(maintenance_contexts).values({ context_id, ...values }).onConflictDoUpdate({ target: maintenance_contexts.context_id, set: values }).run();
}

// One Suggest links run in the background on a context, within what is left of today's model calls and tokens.
function suggest_on(database: SqlDatabase, context_id: string, conversation_id: string | null, limits: { max_rounds: number; max_tokens: number }, signal: AbortSignal): Promise<RunEnd> {
  return new Promise<RunEnd>((resolve, reject) => {
    start_run(database, context_id, suggest_links_message, conversation_id, {
      presence: "background",
      tools: suggest_tools,
      limits,
      instructions: (screen) => graph_part(database, context_id, screen),
      closing_note: proposals_note,
      on_end: resolve,
    }).then(
      async (started) => {
        if (conversation_id === null) await assistant_host().call("rename_conversation", [started.conversation_id, "Suggest links (background)"]);
        const stop = () => stop_run_of(started.conversation_id);
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      },
      reject,
    );
  });
}

const suggest_job: MaintenanceJob = {
  async check({ database }) {
    const { problem, no_engine } = await background_engine(database);
    if (problem) return { count: 0, reason: no_engine ? `${problem} Suggest links needs one.` : problem };
    return { count: contexts_to_suggest(database).length };
  },
  async run({ database, budget, used, signal, now }) {
    const result: Done = { ...done(0), rounds: 0, input_tokens: 0, output_tokens: 0 };
    const proposed: string[] = [];
    for (const { id, row } of contexts_to_suggest(database).slice(0, budget.items_per_run)) {
      const calls_left = budget.model_calls_per_day - used.model_calls - result.rounds!;
      const tokens_left = budget.tokens_per_day - used.tokens - result.input_tokens! - result.output_tokens!;
      if (calls_left <= 0 || tokens_left <= 0 || signal.aborted) break;
      const conversation = row?.conversation_id && has_conversation(database, row.conversation_id) ? row.conversation_id : null;
      const end = await suggest_on(database, id, conversation, { max_rounds: Math.min(suggest_rounds, calls_left), max_tokens: tokens_left }, signal);
      result.rounds! += end.rounds;
      result.input_tokens! += end.input_tokens;
      result.output_tokens! += end.output_tokens;
      result.engine = end.engine;
      result.model = end.model;
      result.conversation_id = end.conversation_id;
      result.run_id = end.run_id;
      if (end.stopped_by === "gave_way" || (signal.aborted && end.rounds === 0)) {
        result.gave_way = true;
        break;
      }
      result.items += 1;
      keep_suggested(database, id, end.conversation_id, now);
      proposed.push(`${label_of(database, node_key("context" as NodeKind, id))}: ${proposals_note(end.tool_calls)}`);
      if (end.error && !end.stopped_by) {
        result.error = end.error;
        break;
      }
    }
    result.proposed = proposed;
    result.changed_store = result.items > 0;
    return result;
  },
};

// ── 7. Digest ────────────────────────────────────────────────────────────────

export const digest_title = "Background work";

// What the loop did since the last digest, and what waits, as plain lines; empty when there is nothing to say.
export function digest_lines(database: SqlDatabase, now: number): string[] {
  const last = runs_since(database, "").find((run) => run.job_id === "maintenance:digest" && run.outcome === "done" && run.items > 0);
  const since = last?.started_at ?? new Date(now - 86_400_000).toISOString();
  const runs = runs_since(database, since).filter((run) => run.job_id !== "maintenance:digest");
  const lines: string[] = [];
  for (const key of maintenance_keys) {
    if (key === "digest") continue;
    const own = runs.filter((run) => run.job_id === `maintenance:${key}`);
    const did = own.flatMap((run) => [...run.applied, ...run.proposed]);
    const failed = own.filter((run) => run.outcome === "error").length;
    if (did.length === 0 && failed === 0) continue;
    const parts = [...new Set(did)].slice(0, 3);
    const more = new Set(did).size - parts.length;
    lines.push(`${maintenance_jobs[key].title}: ${[...parts, more > 0 ? `and ${count_words(more, "more", "more")}` : "", failed > 0 ? `${count_words(failed, "run", "runs")} failed.` : ""].filter(Boolean).join(" ")}`);
  }
  const used_up = checks_of(database).filter((check) => check.used_up && check.skipped_at >= since);
  for (const check of used_up) if (maintenance_jobs[check.job as MaintenanceKey]) lines.push(`${maintenance_jobs[check.job as MaintenanceKey].title} stopped for the day on ${check.device}: ${check.used_up}`);
  const waiting = inbox_feature.methods.list_inbox(database).filter((entry) => entry.kind !== "digest").length;
  if (lines.length > 0 || waiting > 0) lines.push(waiting > 0 ? `Waiting for you in the Inbox: ${waiting.toLocaleString("en")}.` : "Nothing waits for you in the Inbox.");
  return lines;
}

const digest_job: MaintenanceJob = {
  check: ({ database, now }) => ({ count: digest_lines(database, now).length > 0 ? 1 : 0 }),
  async run({ database, now }) {
    const lines = digest_lines(database, now);
    return done(lines.length > 0 ? 1 : 0, lines, [], "");
  },
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const job_work: Record<MaintenanceKey, MaintenanceJob> = {
  index: index_job,
  embed: embed_job,
  rules: rules_job,
  similarity: similarity_job,
  tidy: tidy_job,
  suggest: suggest_job,
  research: research_job,
  digest: digest_job,
};
