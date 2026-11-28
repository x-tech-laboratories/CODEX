// Every text CODEX writes for a model to read, kept in prompts.json for review and tuning; a {name} in one is filled in
// by the code that uses it.

// ── Imports ──────────────────────────────────────────────────────────────────

import prompts_json from "./prompts.json" with { type: "json" };

// ── Prompts ──────────────────────────────────────────────────────────────────

export const prompts = prompts_json;

export type PromptValues = Record<string, string | number>;

const placeholder = /\{([a-z_]+)\}/g;

// The prompt with each {name} replaced by its value; a name with no value is a mistake in the code and throws.
export function fill(template: string, values: PromptValues = {}): string {
  return template.replace(placeholder, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The prompt “${template.slice(0, 60)}” needs a value for {${name}}.`);
    return String(value);
  });
}

// Each line of a prompt list, filled from the same values.
export function fill_each(templates: readonly string[], values: PromptValues = {}): string[] {
  return templates.map((template) => fill(template, values));
}
