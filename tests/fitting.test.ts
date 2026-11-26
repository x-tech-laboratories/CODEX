import { afterEach, describe, expect, it } from "vitest";

import type { ChatMessage } from "../src/shared/engines/direct.ts";
import { calibrate, chars_per_token, count_tokens, default_chars_per_token, dropped_result, fit_request, forget_calibrations, left_out_note, margin_of, reply_floor, tighten, tools_chars } from "../src/shared/engines/fitting.ts";

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
    expect(fit.messages.map((message) => message.content.slice(0, 5))).toEqual(["s", "quest", "", dropped_result.slice(0, 5), "yyyyy"]);
    expect(messages[3]!.content).toBe("x".repeat(5000));
    expect(fit.left_out).toBe(0);
  });

  it("leaves out whole turns, oldest first, with a note, so a tool result never loses its call", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "a".repeat(5000) },
      { role: "assistant", content: "b".repeat(5000) },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "newest" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", name: "t", arguments: "{}" }] },
      { role: "tool", tool_call_id: "a", content: "result" },
    ];

    const fit = fit_request(messages, undefined, at(4096, 512));

    expect(fit).toMatchObject({ fits: true, left_out: 2, shortened: null });
    if (!fit.fits) return;
    expect(fit.messages.map((message) => message.content)).toEqual([`s\n\n${left_out_note}`, "c", "d", "newest", "", "result"]);
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

  it("calibrates from reported usage, keeping the most cautious ratio seen, and ignores reports too small to tell", () => {
    calibrate("engine\nmodel", 4000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(3.8);
    calibrate("engine\nmodel", 6000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(3.8);
    calibrate("engine\nmodel", 3000, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(2.85);
    calibrate("engine\nmodel", 100, 10);
    calibrate("", 100, 1000);
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(2.85);
    // One odd report cannot make it reckless.
    calibrate("odd", 1_000_000, 100);
    expect(chars_per_token("odd")).toBe(6);
  });

  it("tightens the estimate after an engine found a request too large without saying its size", () => {
    tighten("engine\nmodel");
    expect(chars_per_token("engine\nmodel")).toBeCloseTo(default_chars_per_token * 0.75);
    tighten("");
    expect(chars_per_token("")).toBe(default_chars_per_token);
  });
});
