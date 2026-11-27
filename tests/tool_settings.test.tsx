// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { web_plugin } from "../src/server/tools/web.ts";
import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { tool_facts } from "../src/web/tools/ToolSettings.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_assistant_host(null);
});

const poster = define_plugin<ContextPluginApi>({
  id: "tests.poster",
  name: "Poster",
  version: "1.0.0",
  start: (context) =>
    context.provide("tools", "poster", {
      label: "Poster",
      tools: () => [{ name: "post", description: "Posts a message.", parameters: { type: "object", properties: {} }, changes: true, sends_outside: true }],
      call: async () => "Posted.",
    }),
});

function open_settings(fixture: Fixture): void {
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  render(
    <>
      <SettingsView />
      <Dialogs />
    </>,
  );
}

function section(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest("section")!;
}

describe("the tool plugins in Settings", () => {
  it("show the Web plugin's marks and tools in its row, each turned on or off on its own", async () => {
    const fixture = start_fixture({ plugins: [web_plugin(), poster] });
    fixture.calls.set_setting("plugins", { "codex.web": { enabled: true, settings: { search_endpoint: "https://searx.example.org", allowed_ports: "" } } });
    open_settings(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "Open Web" }));
    const dialog = await screen.findByRole("dialog");
    const trusted = (await within(dialog).findByLabelText("Trusted content")) as HTMLInputElement;
    const after_private = within(dialog).getByLabelText("May be used after reading private sources") as HTMLInputElement;
    expect([trusted.checked, after_private.checked]).toEqual([false, false]);
    // Its tools all send outside, so what they read may go to a hosted engine until the user says otherwise.
    const hosted = within(dialog).getByLabelText("May be sent to a hosted engine") as HTMLInputElement;
    expect(hosted.checked).toBe(true);
    expect(within(dialog).getByText(/such an engine is not offered its tools at all/)).toBeTruthy();
    expect(within(dialog).getByText(/nothing private can leave through them/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Offer web_fetch") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText("Also offer web_search to small models") as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getAllByText(/It only reads and sends what it is given outside this computer\./)).toHaveLength(2);

    fireEvent.click(hosted);
    await waitFor(() => expect(fixture.calls.get_settings().tool_plugins).toEqual({ "codex.web/web": { send_to_hosted: false } }));
    fireEvent.click(after_private);
    await waitFor(() => expect(fixture.calls.get_settings().tool_plugins).toEqual({ "codex.web/web": { send_to_hosted: false, after_private: true } }));
    fireEvent.click(within(dialog).getByLabelText("Offer web_search"));
    await waitFor(() => expect((fixture.calls.get_settings().tool_plugins as Record<string, { tools?: unknown }>)["codex.web/web"]!.tools).toEqual({ web_search: { off: true } }));
    fireEvent.click(within(dialog).getByLabelText("Also offer web_fetch to small models"));
    await waitFor(async () => expect((await fixture.calls.list_plugin_tools())[0]!.tools.find((tool) => tool.tool === "web_fetch")!.small).toBe(true));
  });

  it("list a plugin tool that changes something under Action policy, with its level, and a folder plugin's row", async () => {
    const fixture = start_fixture({ plugins: [poster] });
    open_settings(fixture);
    const policy = await waitFor(() => section("Action policy"));
    const level = (await within(policy).findByLabelText("Poster: post")) as HTMLSelectElement;
    expect(level.value).toBe("proposal");
    expect(within(policy).getByText("sends outside")).toBeTruthy();
    fireEvent.change(level, { target: { value: "auto" } });
    await waitFor(() => expect((fixture.calls.get_settings().action_policy as Record<string, string>).poster__post).toBe("auto"));

    // A tool plugin the page has no manifest of, such as one from the plugins folder, has a row of its own under Plugins.
    fireEvent.click(await screen.findByRole("button", { name: "Open Poster" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByLabelText("Trusted content"));
    await waitFor(() => expect(fixture.calls.get_settings().tool_plugins).toEqual({ "tests.poster/poster": { trusted: true } }));
  });

  it("hold the user's guidance for each plugin's and source app's specialist, as kept in the synced settings", async () => {
    const fixture = start_fixture({ plugins: [web_plugin()] });
    fixture.calls.set_setting("plugins", { "codex.web": { enabled: true, settings: { search_endpoint: "", allowed_ports: "" } } });
    fixture.calls.set_plugin_guidance("tool:codex.web/web", "Search in English.");
    fixture.calls.set_plugin_guidance("x-tasks", "Someday tasks are not due.");
    open_settings(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "Open Web" }));
    const web = await screen.findByRole("dialog");
    expect(await within(web).findByText("Search in English.")).toBeTruthy();
    expect(within(web).getAllByText("Guidance for its specialist").length).toBeGreaterThan(0);
    cleanup();
    open_settings(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "Open X-Tasks" }));
    const tasks = await screen.findByRole("dialog");
    expect(await within(tasks).findByText("Someday tasks are not due.")).toBeTruthy();
  });

  it("say what a tool does in plain words", () => {
    expect(tool_facts({ changes: true, sends_outside: false })).toBe("It changes something and stays on this computer.");
  });
});
