// The orchestrator's request on an Odin-like setup: a local engine at 32,768 tokens with the core tool set, three MCP-like
// servers with many tools, the X-Tasks and Trilium collectors and the Web plugin. Its instructions and tool definitions
// stay well under what they were when CODEX's own calls went to the model directly.

import { afterEach, describe, expect, it } from "vitest";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { web_plugin } from "../src/server/tools/web.ts";
import type { ContextPlugin, ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import { chosen_request, offered_tools } from "../src/shared/engines/direct.ts";
import { default_chars_per_token, tools_chars } from "../src/shared/engines/fitting.ts";
import type { PluginTool } from "../src/shared/tools/tool.ts";
import { start_fixture } from "./assistant_fixture.ts";

afterEach(async () => {
  await wait_for_runs();
  use_assistant_host(null);
});

// ── Setup ────────────────────────────────────────────────────────────────────

// The size of the request before CODEX's own calls became specialists, measured on this same setup.
const tokens_before = 7001;

const odin = { context_size: 32_768, tool_set: "core", specialists: "auto" } as const;

// A server with as many tools as given, each described and shaped like an X-app's MCP tool.
function server_like(id: string, label: string, count: number): ContextPlugin {
  const tools: PluginTool[] = Array.from({ length: count }, (_, at) => ({
    name: `tool_${at}`,
    description: `Lists, reads or changes one kind of record in ${label}, such as entries by day, with their ids, names, amounts and notes. ${"Days are local dates and amounts are in the units its settings give. ".repeat(2)}`,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The record's id, from a list_ call." }, day: { type: "string", description: "A local date such as 2026-11-10." }, note: { type: "string", description: "A note in plain words." } },
      required: ["id"],
    },
    changes: at % 2 === 1,
    sends_outside: false,
  }));
  return define_plugin<ContextPluginApi>({
    id: `tests.${id}`,
    name: label,
    version: "1.0.0",
    start: (context) => context.provide("tools", id, { label, tools: () => tools, call: async () => "ok" }),
  });
}

// ── Size ─────────────────────────────────────────────────────────────────────

describe("the orchestrator's request", () => {
  it("holds only ask_ tools, set_mood, the task list and read_tool_result, and is well under its size with CODEX's own calls offered directly", async () => {
    const fixture = start_fixture({ plugins: [web_plugin({}), server_like("fitness", "X-Fitness", 90), server_like("budget", "X-Budget", 23), server_like("media", "X-Media-Tracker", 130)] });
    fixture.calls.set_setting("plugins", { "codex.web": { enabled: true, settings: { search_endpoint: "https://search.example.org" } } });
    await fixture.calls.send_message(null, "What did I eat today, and what is left in my budget?");
    await wait_for_runs();

    const request = fixture.requests[0]!;
    const chosen = chosen_request(request, odin.specialists, odin.context_size);
    const offered = offered_tools(chosen.tools, odin.tool_set, odin.context_size, chosen.instructions);
    const names = offered.map((tool) => tool.name);
    expect(names.filter((name) => !name.startsWith("ask_"))).toEqual(["set_mood", "set_task_list", "read_tool_result"]);
    expect(names).toEqual(expect.arrayContaining(["ask_contexts", "ask_graph", "ask_blueprints", "ask_interests", "ask_jobs", "ask_web", "ask_x_fitness", "ask_x_tasks", "ask_trilium"]));

    // What the orchestrator no longer has is not described to it.
    for (const moved of ["propose_entity", "propose_blueprint", "propose_interest", "search_collector", "web__web_fetch"]) expect(chosen.instructions).not.toContain(moved);
    expect(chosen.instructions).toContain("Your tools are specialists");

    // Under two thirds of before, with the task list and the rule to work one step at a time.
    const tokens = Math.ceil((chosen.instructions.length + tools_chars(offered)) / default_chars_per_token);
    expect(tokens).toBeLessThan(tokens_before * 0.65);
  });

  it("goes to specialists on a small context even with no plugin, and keeps CODEX's calls for a large one", async () => {
    const fixture = start_fixture();
    await fixture.calls.send_message(null, "Hello");
    await wait_for_runs();
    const request = fixture.requests[0]!;
    const names = (context_size: number) => chosen_request(request, "auto", context_size).tools.definitions.map((tool) => tool.name);
    expect(names(32_768).filter((name) => !name.startsWith("ask_"))).toEqual(["set_mood", "set_task_list", "read_tool_result"]);
    expect(names(200_000)).toContain("add_item");
    expect(chosen_request(request, "off", 32_768).instructions).toBe(request.instructions);
  });
});
