// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { call_words } from "../src/web/assistant/AssistantSettings.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_assistant_host(null);
});

function open_settings(choose_engine: boolean): Fixture {
  const fixture = start_fixture({ choose_engine });
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  render(<SettingsView />);
  return fixture;
}

function section(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest("section")!;
}

describe("the assistant's settings", () => {
  it("choose the engine that answers, and list each bundled engine with its own settings", async () => {
    const fixture = open_settings(false);

    const choice = (await screen.findByLabelText("Answering")) as HTMLSelectElement;
    expect([...choice.options].map((option) => option.text)).toEqual(["None", "Fake"]);
    fireEvent.change(choice, { target: { value: "fake" } });
    await waitFor(() => expect(fixture.calls.get_settings().engine).toBe("fake"));

    const engine = section("Engine");
    expect(await within(engine).findByText("Anthropic")).toBeTruthy();
    expect(within(engine).getByText("OpenAI-compatible")).toBeTruthy();
    // The engines are not listed again among the collectors.
    expect(within(section("Plugins")).queryByText("Anthropic")).toBeNull();
  });

  it("keep a chosen engine that is not running in the choice", async () => {
    const fixture = open_settings(false);
    fixture.calls.set_setting("engine", "gone");
    cleanup();
    render(<SettingsView />);
    const choice = (await screen.findByLabelText("Answering")) as HTMLSelectElement;
    expect(choice.value).toBe("gone");
    expect([...choice.options].map((option) => option.text)).toContain("gone (not running)");
  });

  it("set each change's level in plain words, marking the riskier ones", async () => {
    const fixture = open_settings(true);
    const policy = await waitFor(() => section("Action policy"));

    const rename = (await within(policy).findByLabelText("Rename context")) as HTMLSelectElement;
    expect([...rename.options].map((option) => option.text)).toEqual(["Never", "Ask me first", "Allowed while I'm in the conversation", "Allowed, even in the background"]);
    expect(rename.value).toBe("proposal");
    expect(within(policy).queryByText("risky")).toBeNull();
    expect(within(policy).getAllByText("deletes").length).toBeGreaterThan(0);

    fireEvent.change(rename, { target: { value: "auto" } });
    await waitFor(() => expect(fixture.calls.get_action_policy().find((entry) => entry.method === "rename_context")!.level).toBe("auto"));
    expect(await within(policy).findByText("risky")).toBeTruthy();
    fireEvent.change(within(policy).getByLabelText("Remove context"), { target: { value: "background" } });
    expect(await within(policy).findByText("most risky")).toBeTruthy();
  });

  it("name each call in words", () => {
    expect(call_words("add_contexts_from_feed_group")).toBe("Add contexts from feed group");
  });
});
