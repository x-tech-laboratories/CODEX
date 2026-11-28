import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../src/shared/engines/direct.ts";
import { calibrate, chars_per_token, count_tokens, default_chars_per_token, dropped_result, fit_request, forget_calibrations, least_earlier_kept, left_out_note, margin_of, refused, reply_floor, safety, tighten, tools_chars } from "../src/shared/engines/fitting.ts";

afterEach(() => forget_calibrations());

const at = (context_size: number, max_tokens = 1024) => ({ context_size, max_tokens, chars_per_token: default_chars_per_token });

describe("fitting a request", () => {
  it("sends a conversation that fits as it is, asking for the most wanted reply", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "hello" }];
    const fit = fit_request(messages, undefined, at(8192));
    expect(fit).toMatchObject({ fits: true, messages, max_tokens: 1024, left_out: 0, shortened: null });
  });

  it("blanks the oldest tool results first, leaving the messages given unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "question" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "t", arguments: "{}" }, { id: "b", name: "t", arguments: "{}" }] },
      { role: "tool", tool_call_id: "a", content: "x".repeat(5000) },
      { role: "tool", tool_call_id: "b", content: "y".repeat(5000) },
    ];

    const fit = fit_request(messages, undefined, at(4096, 512));

    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.messages.map((message) => message.content.slice(0, 5))).toEqual(["s", "quest", "", "[The ", "yyyyy"]);
    expect(fit.messages[3]!.content).toBe(dropped_result("t", "a", false));
    expect(messages[3]!.content).toBe("x".repeat(5000));
    expect(fit.left_out).toBe(0);
  });

  it("names the dropped call and how to read it again when read_tool_result is offered", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "question" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "search_index", arguments: "{}" }] },
      { role: "tool", tool_call_id: "a", content: "x".repeat(5000) },
      { role: "assistant", content: "", tool_calls: [{ id: "b", name: "get_item", arguments: "{}" }] },
      { role: "tool", tool_call_id: "b", content: "y".repeat(5000) },
    ];
    const tools = [{ name: "read_tool_result", description: "Reads more.", parameters: { type: "object" } }];

    const fit = fit_request(messages, tools, at(4096, 512));

    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.messages[3]!.content).toBe('[The result of search_index call "a" was dropped to fit the context. To read it again call read_tool_result with call_id "a".]');
  });

  it("leaves out whole turns, oldest first, with a note, so a tool result never loses its call", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "a".repeat(1600) },
      { role: "assistant", content: "b".repeat(1600) },
      { role: "user", content: "e".repeat(1600) },
      { role: "assistant", content: "f".repeat(1600) },
      { role: "user", content: "g".repeat(1600) },
      { role: "assistant", content: "h".repeat(1600) },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "newest" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "t", arguments: "{}" }] },
      { role: "tool", tool_call_id: "a", content: "result" },
    ];

    const fit = fit_request(messages, undefined, at(4096, 512));

    expect(fit).toMatchObject({ fits: true, left_out: 2, shortened: null });
    if (!fit.fits) return;
    expect(fit.messages.map((message) => message.content)).toEqual([`s\n\n${left_out_note}`, "e".repeat(1600), "f".repeat(1600), "g".repeat(1600), "h".repeat(1600), "c", "d", "newest", "", "result"]);
  });

  it("counts the tools as sent, and says it cannot fit when the instructions and tools leave no room", () => {
    const tools = [{ name: "big", description: "d".repeat(9000), parameters: { type: "object" } }];
    const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];

    expect(fit_request(messages, undefined, at(4096)).fits).toBe(true);
    const fit = fit_request(messages, tools, at(4096));

    expect(fit).toEqual({ fits: false, fixed_tokens: Math.ceil((tools_chars(tools) + 1 + 16) / default_chars_per_token), reply_floor });
  });

  it("refuses a context too small to leave the reply floor, and caps the reply by what is left", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "s".repeat(4000) }, { role: "user", content: "hi" }];
    expect(fit_request(messages, undefined, at(2048, 4096)).fits).toBe(false);

    const fit = fit_request([{ role: "system", content: "s" }, { role: "user", content: "u".repeat(8000) }], undefined, at(8192, 8192));
    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.max_tokens).toBe(8192 - margin_of(8192) - Math.ceil(fit.prompt_chars / default_chars_per_token));
  });

  it("shortens the newest message only when leaving out every older turn is not enough, and refuses when too little would be left", () => {
    const fit = fit_request([{ role: "system", content: "s" }, { role: "user", content: "old" }, { role: "assistant", content: "old answer" }, { role: "user", content: `${"h".repeat(10_000)}${"t".repeat(10_000)}` }], undefined, at(4096, 512));
    expect(fit).toMatchObject({ fits: true, left_out: 2, shortened: { length: 20_000 } });
    if (!fit.fits) return;
    const sent = fit.messages.at(-1)!.content;
    expect(sent).toMatch(/^h+\n\n\[… [\d,]+ characters left out here: the message was too long for this model's context …\]\n\nt+$/);

    // A turn of the current round that cannot shrink leaves too little of the message.
    const crowded = fit_request([{ role: "system", content: "s" }, { role: "user", content: "q".repeat(5000) }, { role: "assistant", content: "a".repeat(9000) }], undefined, at(4096, 512));
    expect(crowded.fits).toBe(false);
  });
});

describe("estimating tokens", () => {
  it("starts cautious, at two and a half characters a token", () => {
    expect(count_tokens("x".repeat(250))).toBe(100);
    expect(chars_per_token("never measured")).toBe(default_chars_per_token);
  });

  it("follows reported usage: a tighter ratio at once, a roomier one halfway, and ignores reports too small to tell", () => {
    calibrate("engine\nmodel", 4000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(4 * safety);
    calibrate("engine\nmodel", 6000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(5 * safety);
    calibrate("engine\nmodel", 3000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(3 * safety);
    calibrate("engine\nmodel", 100, 10);
    calibrate("", 100, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(3 * safety);
    // One odd report cannot make it reckless.
    calibrate("odd", 1_000_000, 100);
    expect(chars_per_token("odd")).toBe(8 * safety);
    calibrate("low", 100, 1000);
    expect(chars_per_token("low")).toBe(1);
  });

  it("counts a refused request tighter than it measured, and never looser than it was", () => {
    calibrate("engine\nmodel", 5000, 1000);
    refused("engine\nmodel", 9000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(5 * safety);
    refused("engine\nmodel", 4000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(4 * 0.9 * safety);
    refused("", 4000, 1000);
    expect(chars_per_token("")).toBe(default_chars_per_token);
  });

  it("tightens the estimate after an engine found a request too large without saying its size", () => {
    tighten("engine\nmodel");
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(default_chars_per_token * 0.75);
    tighten("");
    expect(chars_per_token("")).toBe(default_chars_per_token);
  });
});

describe("fitting at the edges", () => {
  it("puts the note on what was left out in a system message of its own when there are no instructions", () => {
    const messages: ChatMessage[] = [];
    for (let turn = 0; turn < 6; turn += 1) messages.push({ role: "user", content: "q".repeat(1600) }, { role: "assistant", content: "a".repeat(1600) });
    messages.push({ role: "user", content: "newest" });

    const fit = fit_request(messages, undefined, at(4096, 512));

    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.messages[0]).toEqual({ role: "system", content: left_out_note });
    expect(fit.messages.at(-1)!.content).toBe("newest");
  });

  it("says it cannot fit a conversation with no user message to shorten", () => {
    expect(fit_request([{ role: "system", content: "s" }, { role: "assistant", content: "a".repeat(20_000) }], undefined, at(4096, 512)).fits).toBe(false);
  });
});

describe("shortening before leaving out", () => {
  const marker = /\n\n\[… [\d,]+ characters left out here: the message was too long for this model's context …\]\n\n/;

  // A conversation of short turns with one huge message in its middle, then a plain greeting.
  function with_huge_middle(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: "s" }];
    for (let turn = 0; turn < 10; turn += 1) messages.push({ role: "user", content: `question ${turn}` }, { role: "assistant", content: `answer ${turn}` });
    messages.push({ role: "user", content: "x".repeat(45_000) }, { role: "assistant", content: "That is a long text." });
    for (let turn = 10; turn < 14; turn += 1) messages.push({ role: "user", content: `question ${turn}` }, { role: "assistant", content: `answer ${turn}` });
    messages.push({ role: "user", content: "Hello" });
    return messages;
  }

  it("shortens a huge earlier message in its middle and keeps every smaller turn around it", () => {
    const messages = with_huge_middle();

    const fit = fit_request(messages, undefined, at(8192, 4096));

    expect(fit).toMatchObject({ fits: true, left_out: 0, shortened: null, shortened_earlier: { messages: 1 } });
    if (!fit.fits) return;
    expect(fit.messages).toHaveLength(messages.length);
    const huge = fit.messages[21]!.content;
    expect(huge).toMatch(marker);
    expect(huge.length).toBeLessThan(45_000);
    expect(fit.shortened_earlier!.left_out).toBe(45_000 - (huge.length - huge.match(marker)![0].length));
    expect(fit.messages.at(-1)!.content).toBe("Hello");
    expect(messages[21]!.content).toBe("x".repeat(45_000));
  });

  it("shortens the longest earlier messages alike, keeping as much of each as fits", () => {
    const fit = fit_request([{ role: "system", content: "s" }, { role: "user", content: "a".repeat(9000) }, { role: "assistant", content: "b".repeat(6000) }, { role: "user", content: "c".repeat(800) }, { role: "assistant", content: "ok" }, { role: "user", content: "newest" }], undefined, at(4096, 512));

    expect(fit).toMatchObject({ fits: true, left_out: 0, shortened: null, shortened_earlier: { messages: 2 } });
    if (!fit.fits) return;
    const [, first, second, third] = fit.messages.map((message) => message.content.replace(marker, ""));
    expect(first!.length).toBe(second!.length);
    expect(first!.length).toBeGreaterThan(least_earlier_kept);
    expect(third).toBe("c".repeat(800));
  });

  it("leaves out the oldest turns only when shortening every earlier message is not enough, and counts only the shortened ones kept", () => {
    const letters = "abcdefghijkl";
    const messages: ChatMessage[] = [{ role: "system", content: "s" }];
    for (let turn = 0; turn < 12; turn += 1) messages.push({ role: "user", content: letters[turn]!.repeat(4000) }, { role: "assistant", content: "fine" });
    messages.push({ role: "user", content: "newest" });

    const fit = fit_request(messages, undefined, at(4096, 512));

    expect(fit.fits).toBe(true);
    if (!fit.fits) return;
    expect(fit.left_out).toBeGreaterThan(0);
    expect(fit.left_out % 2).toBe(0);
    const kept = fit.messages.slice(1);
    // The newest turns stay, the oldest went.
    expect(kept.at(-1)!.content).toBe("newest");
    expect(kept.at(-3)!.content.startsWith("l")).toBe(true);
    expect(kept[0]!.content.startsWith(letters[12 - (kept.length - 1) / 2]!)).toBe(true);
    const { messages: shortened_messages, left_out } = fit.shortened_earlier!;
    expect(shortened_messages).toBe((kept.length - 1) / 2);
    expect(left_out % shortened_messages).toBe(0);
    expect(left_out / shortened_messages).toBeLessThanOrEqual(4000 - least_earlier_kept);
  });
});

describe("a conversation's requests over time", () => {
  // Characters per token the simulated engine really counts.
  const real_ratio = 5.8;
  const context_size = 8192;
  const max_tokens = 4096;
  const budget = context_size - margin_of(context_size) - Math.min(max_tokens, context_size / 4);

  // Sends one request built from the conversation, lets the engine count it, and returns the tokens it counted.
  function send(key: string, messages: ChatMessage[], ratio_reported = real_ratio): number {
    const fit = fit_request(messages, undefined, { context_size, max_tokens, chars_per_token: chars_per_token(key) });
    if (!fit.fits) throw new Error("did not fit");
    const tokens = Math.ceil(fit.prompt_chars / real_ratio);
    expect(tokens + fit.max_tokens).toBeLessThanOrEqual(context_size);
    calibrate(key, fit.prompt_chars, Math.ceil(fit.prompt_chars / ratio_reported));
    return tokens;
  }

  function growing(turns: number): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: "s".repeat(2000) }];
    for (let turn = 0; turn < turns; turn += 1) messages.push({ role: "user", content: `${turn % 10}`.repeat(3000) }, { role: "assistant", content: "r".repeat(3000) });
    messages.push({ role: "user", content: "next" });
    return messages;
  }

  it("climbs toward the budget instead of settling far below it, and is never refused", () => {
    const sizes: number[] = [];
    // The first, short request counts fewer characters a token than the conversation's later ones.
    for (let turns = 1; turns <= 20; turns += 1) sizes.push(send("climb", growing(turns), turns === 1 ? 3.9 : real_ratio));

    const late = sizes.slice(-5);
    for (const size of late) expect(size / budget).toBeGreaterThan(0.85);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(budget);
  });

  it("recovers after a misleading measurement", () => {
    for (let turns = 10; turns < 14; turns += 1) send("recover", growing(turns));
    const before = send("recover", growing(14), 1.5);
    const right_after = send("recover", growing(15));
    const later = [16, 17, 18, 19, 20, 21].map((turns) => send("recover", growing(turns)));

    expect(right_after / budget).toBeLessThan(0.4);
    expect(before / budget).toBeGreaterThan(0.85);
    for (const [index, size] of later.slice(0, 4).entries()) expect(size).toBeGreaterThan(index === 0 ? right_after : later[index - 1]!);
    expect(later.at(-1)! / budget).toBeGreaterThan(0.85);
  });
});
