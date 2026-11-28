// ── Imports ──────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";

import { fill, fill_each, prompts } from "../../../src/shared/prompts/prompts.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Every text in the prompts file with where it sits, such as specialists.own.0.
function every_prompt(value: unknown, at = ""): [string, string][] {
  if (typeof value === "string") return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((each, index) => every_prompt(each, `${at}.${index}`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, each]) => every_prompt(each, at ? `${at}.${key}` : key));
}

// ── Prompts file ─────────────────────────────────────────────────────────────

describe("the prompts file", () => {
  it("holds only texts, lists of texts and groups of them", () => {
    const all = every_prompt(prompts);

    expect(all.length).toBeGreaterThan(50);
    for (const [at, text] of all) expect(text.trim(), at).not.toBe("");
  });

  it("uses braces only around snake_case placeholder names", () => {
    for (const [at, text] of every_prompt(prompts)) {
      const without_placeholders = text.replace(/\{[a-z_]+\}/g, "");

      expect(without_placeholders, at).not.toMatch(/[{}]/);
    }
  });
});

// ── Filling ──────────────────────────────────────────────────────────────────

describe("fill", () => {
  it("puts each value in its placeholder, numbers as written", () => {
    const filled = fill("Step {number}: “{step}”, {number} again.", { number: 2, step: "Read the mail" });

    expect(filled).toBe("Step 2: “Read the mail”, 2 again.");
  });

  it("never reads placeholders inside the values it puts in", () => {
    const filled = fill("The user wrote: {text}", { text: "{text} and {other}" });

    expect(filled).toBe("The user wrote: {text} and {other}");
  });

  it("throws when a placeholder has no value", () => {
    expect(() => fill("Today is {today}.", {})).toThrow(/\{today\}/);
  });

  it("fills every line of a list from the same values", () => {
    const filled = fill_each(["You are the {label} specialist.", "{remainder}"], { label: "Web", remainder: "Stop at 8." });

    expect(filled).toEqual(["You are the Web specialist.", "Stop at 8."]);
  });
});
