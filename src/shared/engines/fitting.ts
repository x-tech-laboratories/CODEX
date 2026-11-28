// Fitting a request into a model's context: tokens estimated from characters, following what engines report, and the
// conversation cut down, over-long messages shortened before the oldest turns go, until the instructions, the tools
// as sent, the messages and a reply all fit.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { ChatMessage } from "./direct.ts";
import { fill, prompts } from "../prompts/prompts.ts";
import type { ToolDefinition } from "./engine.ts";

// ── Estimating ───────────────────────────────────────────────────────────────

// A cautious characters-per-token ratio for an engine and model not measured yet.
export const default_chars_per_token = 2.5;

// Measured ratios are held within these, so one odd report cannot make the estimate reckless.
export const least_ratio = 1;
const most_ratio = 8;
// The estimate is the recent measured ratio with this much to spare.
export const safety = 0.92;
// How far one roomier measurement moves the ratio towards itself; a tighter one is taken at once.
const loosening = 0.5;
// A request the engine refused as too large is counted this much tighter than it measured.
const refused_headroom = 0.9;
// A report on a prompt smaller than this says too little about the ratio.
const least_measured_tokens = 64;

// The recent measured ratio by engine, endpoint and model, kept in memory while the store runs.
const calibrations = new Map<string, number>();

const bounded = (ratio: number) => Math.min(most_ratio, Math.max(least_ratio, ratio));

export function chars_per_token(key = ""): number {
  const measured = calibrations.get(key);
  return measured === undefined ? default_chars_per_token : Math.max(least_ratio, measured * safety);
}

// Follows the ratio an engine and model showed for a prompt of these characters: a tighter one at once, a roomier one halfway.
export function calibrate(key: string, chars: number, tokens: number): void {
  if (!key || chars <= 0 || tokens < least_measured_tokens) return;
  const measured = bounded(chars / tokens);
  const known = calibrations.get(key);
  calibrations.set(key, known === undefined || measured <= known ? measured : known + (measured - known) * loosening);
}

// After the engine refused a request as too large, a token is taken to be fewer characters than the request showed.
export function refused(key: string, chars: number, tokens: number | null): void {
  if (!key) return;
  const known = calibrations.get(key) ?? default_chars_per_token / safety;
  const measured = tokens && tokens > 0 && chars > 0 ? (chars / tokens) * refused_headroom : known * 0.75;
  calibrations.set(key, bounded(Math.min(known, measured)));
}

// After the engine refused a request as too large without saying its size, a token is taken to be fewer characters.
export function tighten(key: string): void {
  refused(key, 0, null);
}

export function forget_calibrations(): void {
  calibrations.clear();
}

export function count_tokens(text: string, ratio = default_chars_per_token): number {
  return Math.ceil(text.length / ratio);
}

// A little for each message's role and framing in the model's template.
const framing_chars = 16;

// The characters a message adds to a request: its text, its tool calls and its framing.
export function message_chars(message: ChatMessage): number {
  const calls = message.role === "assistant" && message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return message.content.length + calls + framing_chars;
}

// The characters the tool definitions add, as JSON with a little for each tool's wrapping.
export function tools_chars(tools: ToolDefinition[] | undefined): number {
  return tools?.length ? JSON.stringify(tools).length + tools.length * 32 : 0;
}

// ── Fitting ──────────────────────────────────────────────────────────────────

// What stands for a tool result dropped to fit: which call it was, and how to read it again when that tool is offered.
export function dropped_result(tool: string, call_id: string, readable: boolean): string {
  return fill(readable ? prompts.fitting.dropped : prompts.fitting.dropped_call_again, { tool, id: call_id });
}

export const left_out_note = prompts.fitting.left_out;

// The shortest reply an engine is asked for; below it nothing is sent.
export const reply_floor = 512;

// The shortest part of the newest message kept when it has to be shortened.
const least_kept_chars = 200;

// Room for the marker put where a shortened message was cut.
const marker_room = 160;

// Tokens kept free for what the estimate misses.
export function margin_of(context_size: number): number {
  return Math.max(256, Math.ceil(context_size * 0.05));
}

export interface FitOptions {
  context_size: number;
  // The longest reply wanted; the reply is given less when less is left.
  max_tokens: number;
  chars_per_token: number;
}

export type Fit =
  | {
      fits: true;
      messages: ChatMessage[];
      max_tokens: number;
      // How many earlier messages were left out.
      left_out: number;
      // The newest user message's characters left out of its middle, and its whole length; null when sent whole.
      shortened: { left_out: number; length: number } | null;
      // How many earlier messages were shortened in their middle, and the characters left out of them; null when none.
      shortened_earlier: { messages: number; left_out: number } | null;
      // The characters of the request as estimated, for calibrating against what the engine reports.
      prompt_chars: number;
    }
  | { fits: false; fixed_tokens: number; reply_floor: number };

function shorten(text: string, keep: number): string {
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const left = text.length - keep;
  return `${text.slice(0, head)}\n\n${fill(prompts.fitting.shortened, { count: left.toLocaleString("en") })}\n\n${text.slice(text.length - tail)}`;
}

// The shortest part of an earlier message kept when over-long earlier messages are shortened.
export const least_earlier_kept = 1500;

// The longest length every earlier message may keep so that together they give up at least `needed` characters.
function shared_cap(lengths: number[], needed: number): number {
  const saved = (cap: number) => lengths.reduce((sum, length) => sum + Math.max(0, length - cap - marker_room), 0);
  if (saved(least_earlier_kept) <= needed) return least_earlier_kept;
  let low = least_earlier_kept;
  let high = Math.max(...lengths);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (saved(middle) >= needed) low = middle;
    else high = middle;
  }
  return low;
}

// The request cut down to fit: old tool results blanked, then over-long earlier messages shortened in their middle,
// then the oldest turns left out with a note saying so, then the newest user message shortened in its middle; the
// reply is what is left, up to the most wanted. The messages given are not changed.
export function fit_request(given: ChatMessage[], tools: ToolDefinition[] | undefined, options: FitOptions): Fit {
  const ratio = options.chars_per_token;
  const tokens = (chars: number) => Math.ceil(chars / ratio);
  const system = given[0]?.role === "system" ? given[0] : null;
  let body = (system ? given.slice(1) : given).map((message) => ({ ...message }));
  const fixed_chars = (system ? message_chars(system) : 0) + tools_chars(tools);
  const fixed_tokens = tokens(fixed_chars);
  const margin = margin_of(options.context_size);
  const floor = Math.min(reply_floor, options.max_tokens);
  const too_small = { fits: false as const, fixed_tokens, reply_floor: floor };
  const reserve = Math.min(options.max_tokens, Math.max(floor, Math.floor(options.context_size / 4)));
  const room = (options.context_size - margin - fixed_tokens - reserve) * ratio;
  if (room <= 0) return too_small;
  let total = body.reduce((sum, message) => sum + message_chars(message), 0);
  const tool_names = new Map(body.flatMap((message) => (message.role === "assistant" ? (message.tool_calls ?? []).map((call) => [call.id, call.name] as const) : [])));
  const readable = tools?.some((tool) => tool.name === "read_tool_result") === true;
  const blanked = new Set<ChatMessage>();
  // Tool results are blanked oldest first: those of earlier rounds, and the latest round's only when nothing else is left.
  const blank = (until: number) => {
    for (const message of body.slice(0, until)) {
      if (total <= room) break;
      if (message.role === "tool" && !blanked.has(message)) {
        const marker = dropped_result(tool_names.get(message.tool_call_id) ?? "the tool", message.tool_call_id, readable);
        total -= message.content.length - marker.length;
        message.content = marker;
        blanked.add(message);
      }
    }
  };
  blank(Math.max(0, body.findLastIndex((message) => message.role === "assistant")));

  // An earlier message can be shortened to its least; the newest user message and what follows it are left to the end.
  let newest = body.findLastIndex((message) => message.role === "user");
  const shrinkable = (message: ChatMessage, index: number) => index < newest && (message.role === "user" || message.role === "assistant");
  const least_chars = (message: ChatMessage, index: number) => message_chars(message) - (shrinkable(message, index) ? Math.max(0, message.content.length - least_earlier_kept - marker_room) : 0);
  let least_total = body.reduce((sum, message, index) => sum + least_chars(message, index), 0);

  // Whole turns go, oldest first, only when shortening every earlier message would not be enough; each turn runs from
  // a user message to the next, so a tool result never loses the call it answers.
  let left_out = 0;
  let note_chars = 0;
  if (least_total > room && newest > 0) {
    note_chars = left_out_note.length + 2;
    total += note_chars;
    least_total += note_chars;
    let cut = 0;
    while (least_total > room && cut < newest) {
      let next = cut + 1;
      while (next < newest && body[next]!.role !== "user") next += 1;
      for (let index = cut; index < next; index += 1) {
        const message = body[index]!;
        total -= message_chars(message);
        least_total -= least_chars(message, index);
        if (message.role !== "tool") left_out += 1;
      }
      cut = next;
    }
    body = body.slice(cut);
    newest -= cut;
  }

  // Over-long earlier messages are shortened alike, longest first, keeping as much of each as fits.
  const cut_earlier = new Map<ChatMessage, number>();
  const earlier = body.filter(shrinkable);
  if (total > room && earlier.length > 0) {
    const cap = shared_cap(earlier.map((message) => message.content.length), total - room);
    for (const message of earlier) {
      if (message.content.length <= cap + marker_room) continue;
      const before = message_chars(message);
      cut_earlier.set(message, message.content.length - cap);
      message.content = shorten(message.content, cap);
      total -= before - message_chars(message);
    }
  }
  blank(body.length);

  let shortened: { left_out: number; length: number } | null = null;
  if (total > room) {
    const index = body.findLastIndex((message) => message.role === "user");
    const message = body[index];
    if (!message) return too_small;
    const others = total - message_chars(message);
    const keep = Math.floor(room - others) - framing_chars - marker_room;
    if (keep < least_kept_chars || keep >= message.content.length) return too_small;
    shortened = { left_out: message.content.length - keep, length: message.content.length };
    message.content = shorten(message.content, keep);
    total = others + message_chars(message);
  }
  if (total > room) return too_small;

  const head: ChatMessage[] = system ? [{ ...system, content: left_out > 0 ? `${system.content}\n\n${left_out_note}` : system.content }] : left_out > 0 ? [{ role: "system", content: left_out_note }] : [];
  const prompt_chars = fixed_chars + total;
  const max_tokens = Math.min(options.max_tokens, options.context_size - margin - tokens(prompt_chars));
  if (max_tokens < floor) return too_small;
  const kept_cuts = [...cut_earlier.values()];
  const shortened_earlier = kept_cuts.length > 0 ? { messages: kept_cuts.length, left_out: kept_cuts.reduce((sum, chars) => sum + chars, 0) } : null;
  return { fits: true, messages: [...head, ...body], max_tokens, left_out, shortened, shortened_earlier, prompt_chars };
}
