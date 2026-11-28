// The eighth maintenance job, Research interests: the accepted interest researched least recently gets one background
// run built to hold no private data. Its instructions hold only the interest's topic and the titles of its earlier
// findings; its tools are only the Web plugin's two and one to save a finding; it is given no earlier turn, context,
// blueprint or mood. What it saves is kept as findings, fenced as the web's text, and it may propose one interest.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { add_conversation_record, has_conversation, rename_conversation_record } from "../conversations/records.ts";
import { find_engine, start_run, stop_run_of, type RunEnd } from "../conversations/run.ts";
import { type RunTool } from "../conversations/tools.ts";
import { is_hosted } from "../engines/engine.ts";
import { untrusted_block } from "../engines/untrusted.ts";
import { findings_per_run, longest_finding_text, longest_finding_title, longest_topic } from "../interests/model.ts";
import { accepted_rows, checked_finding, finding_source, finding_titles, interest_row, save_finding, update_interest, type InterestRow } from "../interests/records.ts";
import { interests_feature } from "../interests/store.ts";
import { note_source, type Screen, type Screened } from "../privacy/screen.ts";
import { fill, fill_each, prompts } from "../prompts/prompts.ts";
import { web_tools_id } from "../tools/manifests.ts";
import { open_plugin_tools, tool_name_of } from "../tools/offered.ts";
import { background_engine } from "./engine.ts";
import type { Done, MaintenanceJob } from "./jobs.ts";

// ── Tools ────────────────────────────────────────────────────────────────────

// The Web plugin's tools as an engine sees them, and the run's own tool that saves a finding.
export const web_search_tool = tool_name_of(web_tools_id, "web_search");
export const web_fetch_tool = tool_name_of(web_tools_id, "web_fetch");
export const save_finding_name = "save_finding";

// The only tools a research run is offered, beside save_finding.
export const research_tools: readonly string[] = [web_search_tool, web_fetch_tool];

// How many rounds one research run may take at most.
export const research_rounds = 8;

export const research_message = "Research the topic now, then save what you learned.";

interface SaveState {
  saved: string[];
  proposed: string[];
}

// save_finding for one interest: keeps up to so many findings, and proposes at most one next topic.
function save_finding_tool(database: SqlDatabase, interest_id: string, state: SaveState, maker: { engine: string; model: string }): RunTool {
  return {
    name: save_finding_name,
    description: `Saves one thing you learned about the topic as a finding the assistant keeps: a short title, a few plain sentences in your own words, and the addresses of the pages you read for it. At most ${findings_per_run} in this run. You may name one closely related topic worth researching later in next_topic, once; it is only proposed, for the user to decide.`,
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: `A short title, at most ${longest_finding_title} characters.` },
        text: { type: "string", description: `What you learned, at most ${longest_finding_text} characters.` },
        addresses: { type: "array", items: { type: "string" }, description: "The addresses of the pages you read for it." },
        next_topic: { type: "string", description: `Optional: one related topic to research later, at most ${longest_topic} characters, with nothing personal in it.` },
        next_reason: { type: "string", description: "Optional: why that topic, in a short line." },
      },
      required: ["title", "text", "addresses"],
      additionalProperties: false,
    },
    call: (given, run) => {
      if (state.saved.length >= findings_per_run) return { text: `Not saved: this run has saved ${findings_per_run} findings already. Finish now.`, is_error: true };
      let fields;
      try {
        fields = checked_finding(given);
      } catch (error) {
        return { text: `Not saved: ${(error as Error).message}.`, is_error: true };
      }
      save_finding(database, interest_row(database, interest_id), fields, run.run_id, Date.now());
      state.saved.push(fields.title);
      const lines = [`Saved the finding “${fields.title}”.`];
      if (typeof given.next_topic === "string" && given.next_topic.trim()) {
        if (state.proposed.length > 0) lines.push("A next topic was proposed already in this run, so this one was not.");
        else {
          try {
            const outcome = interests_feature.methods.propose_interest(database, given.next_topic, String(given.next_reason ?? ""), { ...maker, sources: [finding_source], conversation_id: run.conversation_id });
            if (outcome.outcome === "proposed") state.proposed.push(given.next_topic.trim());
            lines.push(outcome.message);
          } catch (error) {
            lines.push(`The next topic was not proposed: ${(error as Error).message}`);
          }
        }
      }
      return { text: lines.join(" "), is_error: false };
    },
  };
}

// ── Instructions ─────────────────────────────────────────────────────────────

// What a research run is told: how to work, the topic, and the titles of what it found before, fenced since the web
// wrote them. Nothing else from the store.
export function research_instructions(interest: Pick<InterestRow, "topic">, titles: string[], screen: Screen): Screened<string> {
  const sources = new Set<string>();
  const lines = fill_each(prompts.research.instructions, { search_tool: web_search_tool, fetch_tool: web_fetch_tool, save_tool: save_finding_name, most: findings_per_run, topic: interest.topic });
  if (titles.length > 0) {
    sources.add(finding_source);
    note_source(screen.included, finding_source, "earlier findings");
    lines.push(fill(prompts.research.earlier_findings, { titles: untrusted_block(titles.map((title) => `- ${title}`).join("\n")) }));
  }
  return { value: lines.join("\n"), sources, withheld: new Map() };
}

// ── Checking ─────────────────────────────────────────────────────────────────

// Why research cannot run now, in plain words, or empty when it can.
export async function research_problem(database: SqlDatabase): Promise<string> {
  const tools = (await open_plugin_tools(database)).filter((tool) => tool.enabled && research_tools.includes(tool.name));
  if (!tools.some((tool) => tool.name === web_search_tool)) return "Research needs the Web plugin turned on with a search endpoint, under Settings → Plugins.";
  const { problem } = await background_engine(database);
  if (problem) return problem;
  const found = await find_engine(database);
  if (found.running && is_hosted(found.running) && !tools[0]!.marks.send_to_hosted) return "The engine in use is hosted, and the Web plugin is not marked “May be sent to a hosted engine”, so it could not be offered the web.";
  return "";
}

// ── Running ──────────────────────────────────────────────────────────────────

// The conversation a research run on an interest is kept in, in Global, made the first time.
export function research_conversation(database: SqlDatabase, interest: InterestRow): string {
  const id = `research-${interest.id}`;
  if (!has_conversation(database, id)) {
    add_conversation_record(database, null, id);
    rename_conversation_record(database, id, `Research: ${interest.topic}`.slice(0, 120));
  }
  return id;
}

// One research run on an interest, within the limits given; settles with how it ended and what it saved.
export async function research_on(database: SqlDatabase, interest: InterestRow, limits: { max_rounds: number; max_tokens: number }, web_requests: number, signal: AbortSignal): Promise<{ end: RunEnd; state: SaveState }> {
  const found = await find_engine(database);
  const conversation_id = research_conversation(database, interest);
  const state: SaveState = { saved: [], proposed: [] };
  const tool = save_finding_tool(database, interest.id, state, { engine: found.engine?.id ?? "", model: found.engine?.model ?? "" });
  const titles = finding_titles(database, interest.id);
  const end = await new Promise<RunEnd>((resolve, reject) => {
    start_run(database, null, research_message, conversation_id, {
      presence: "background",
      isolated: true,
      tools: research_tools,
      own_tools: [tool],
      max_plugin_calls: web_requests,
      limits,
      instructions: (screen) => research_instructions(interest, titles, screen),
      on_end: resolve,
    }).then((started) => {
      const stop = () => stop_run_of(started.conversation_id);
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }, reject);
  });
  return { end, state };
}

export const research_job: MaintenanceJob = {
  async check({ database }) {
    if (accepted_rows(database).length === 0) return { count: 0, reason: "No interest is accepted; accept one under Settings → Assistant → Interests." };
    const problem = await research_problem(database);
    if (problem) return { count: 0, reason: problem };
    return { count: accepted_rows(database).length };
  },
  async run({ database, budget, used, signal, now }) {
    const result: Done = { items: 0, applied: [], proposed: [], note: "", rounds: 0, input_tokens: 0, output_tokens: 0 };
    for (const interest of accepted_rows(database).slice(0, budget.items_per_run)) {
      const calls_left = budget.model_calls_per_day - used.model_calls - result.rounds!;
      const tokens_left = budget.tokens_per_day - used.tokens - result.input_tokens! - result.output_tokens!;
      if (calls_left <= 0 || tokens_left <= 0 || signal.aborted) break;
      const { end, state } = await research_on(database, interest, { max_rounds: Math.min(research_rounds, calls_left), max_tokens: tokens_left }, budget.web_requests_per_run, signal);
      result.rounds! += end.rounds;
      result.input_tokens! += end.input_tokens;
      result.output_tokens! += end.output_tokens;
      result.engine = end.engine;
      result.model = end.model;
      result.conversation_id = end.conversation_id;
      result.run_id = end.run_id;
      result.applied.push(...state.saved.map((title) => `${interest.topic}: found “${title}”.`));
      result.proposed.push(...state.proposed.map((topic) => `Proposed the interest “${topic}”.`));
      if (end.stopped_by === "gave_way" || (signal.aborted && end.rounds === 0)) {
        result.gave_way = true;
        break;
      }
      result.items += 1;
      update_interest(database, interest.id, { researched_at: new Date(now).toISOString() });
      if (end.error && !end.stopped_by) {
        result.error = end.error;
        break;
      }
    }
    result.changed_store = result.items > 0 || result.applied.length > 0;
    if (result.applied.length === 0 && !result.error && !result.gave_way) result.note = "It found nothing new to save.";
    return result;
  },
};
