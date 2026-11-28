// @vitest-environment jsdom
// Choosing an engine's model on the page: the Model field in Settings offering the endpoint's models and still taking a
// typed name, a declared engine's model chosen over its default, and the compact picker beside the engine in the pane.
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { read_secret_from } from "../../../src/server/declared.ts";
import { make_openai, openai_plugin, type ModelLister, type ModelMaker } from "../../../src/server/engines/index.ts";
import { open_plugin_host } from "../../../src/shared/collectors/host.ts";
import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { wait_for_runs } from "../../../src/shared/conversations/run.ts";
import { use_declared } from "../../../src/shared/declared/current.ts";
import { read_declarations } from "../../../src/shared/declared/model.ts";
import { chosen_model } from "../../../src/shared/engines/choices.ts";
import type { ContextMethods } from "../../../src/shared/store.ts";
import { data_watch, set_page_api } from "../../../src/web/api.ts";
import { AssistantPane } from "../../../src/web/assistant/AssistantPane.tsx";
import { may_load, model_label } from "../../../src/web/engines/ModelPicker.tsx";
import { forget_page_plugins } from "../../../src/web/plugins.tsx";
import { SettingsView } from "../../../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

// RoboBuddy needs a 2D canvas, which jsdom lacks.
vi.mock("@x-tech-laboratories/robobuddy", () => ({
  RoboBuddy: class {
    frameRate = 30;
    begin() {}
    start() {}
    stop() {}
    setMood() {}
  },
}));

afterEach(async () => {
  cleanup();
  await wait_for_runs();
  forget_page_plugins();
  use_declared(null);
  use_assistant_host(null);
});

const listed: ModelLister = async () => ({
  models: [
    { id: "qwen3.6-35b-a3b", state: "loaded" },
    { id: "bonsai-2.5-27b", state: "unloaded" },
  ],
  problem: "",
});

// The page on a real store whose OpenAI-compatible engine lists two models.
function open_page(choose_engine = false, make: ModelMaker = make_openai): Fixture {
  const fixture = start_fixture({ choose_engine, plugins: [openai_plugin(make, async () => "", listed)], on_announce: () => data_watch.bump() });
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  return fixture;
}

async function open_engine_dialog(): Promise<HTMLElement> {
  render(
    <>
      <SettingsView />
      <Dialogs />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open OpenAI-compatible" }));
  return (await screen.findAllByRole("dialog")).at(-1)!;
}

function stored_model(fixture: Fixture): unknown {
  return (fixture.calls.get_settings().plugins as Record<string, { settings?: Record<string, unknown> }> | undefined)?.["codex.openai"]?.settings?.model;
}

describe("the Model setting", () => {
  it("offers the models the endpoint lists, with their load state, and still takes a name typed", async () => {
    const fixture = open_page();
    const dialog = await open_engine_dialog();
    expect(await within(dialog).findByText("qwen3.6-35b-a3b (loaded), bonsai-2.5-27b (not loaded)")).toBeTruthy();
    const field = within(dialog).getByRole("combobox", { name: "Model" }) as HTMLInputElement;
    fireEvent.focus(field);
    expect(await screen.findByRole("option", { name: "bonsai-2.5-27b" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "bonsai-2.5-27b" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(stored_model(fixture)).toBe("bonsai-2.5-27b"));
    fireEvent.change(field, { target: { value: "unlisted-model" } });
    fireEvent.blur(field);
    await waitFor(() => expect(stored_model(fixture)).toBe("unlisted-model"));
    // The other settings still write as before, keeping the model.
    fireEvent.click(within(dialog).getByLabelText("Turn OpenAI-compatible on"));
    await waitFor(() => expect((fixture.calls.get_settings().plugins as Record<string, { enabled?: boolean }>)["codex.openai"]!.enabled).toBe(false));
    expect(stored_model(fixture)).toBe("unlisted-model");
  });

  it("lets a declared engine's model be chosen over its default on this device, and goes back to it", async () => {
    use_declared({ declarations: () => read_declarations({ engines: { "codex.openai": { endpoint: "http://127.0.0.1:1/v1", model: "qwen3.6-35b-a3b" } } }), read_secret: read_secret_from });
    const fixture = open_page();
    const dialog = await open_engine_dialog();
    expect(within(dialog).getByText(/but for the model, which you can choose on this device/)).toBeTruthy();
    const field = (await within(dialog).findByRole("combobox", { name: "Model" })) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("qwen3.6-35b-a3b"));
    fireEvent.change(field, { target: { value: "bonsai-2.5-27b" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(chosen_model(fixture.database, "codex.openai")).toBe("bonsai-2.5-27b"));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Use qwen3.6-35b-a3b" }));
    await waitFor(() => expect(chosen_model(fixture.database, "codex.openai")).toBe(""));
    await waitFor(() => expect(field.value).toBe("qwen3.6-35b-a3b"));
  });
});

describe("the pane's model picker", () => {
  it("switches the engine's model, says the first reply may wait while it loads, and the next reply uses it", async () => {
    // The SDK refuses to run under jsdom, so the model is a stand-in that notes which model each reply asked.
    const asked: string[] = [];
    const make: ModelMaker = (settings) => ({
      complete: async () => (asked.push(String(settings.model)), { content: "Hi.", tool_calls: [], finish_reason: "stop" }),
    });
    const fixture = open_page(false, make);
    await (await open_plugin_host(fixture.database)).set_settings("codex.openai", { endpoint: "http://127.0.0.1:1/v1", model: "qwen3.6-35b-a3b" });
    fixture.calls.set_setting("engine", "openai");
    render(<AssistantPane context_id={null} />);
    const picker = (await screen.findByLabelText("Model")) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.text)).toEqual(["qwen3.6-35b-a3b (loaded)", "bonsai-2.5-27b (not loaded)"]);
    expect(screen.queryByText(/may take a minute or more/)).toBeNull();

    fireEvent.change(picker, { target: { value: "bonsai-2.5-27b" } });
    await waitFor(() => expect(stored_model(fixture)).toBe("bonsai-2.5-27b"));
    await waitFor(() => expect(picker.value).toBe("bonsai-2.5-27b"));
    expect(await screen.findByText(/may take a minute or more while the server loads the model/)).toBeTruthy();

    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "Hello" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fixture.calls.list_conversations(null).length).toBe(1));
    await wait_for_runs();
    expect(asked).toEqual(["bonsai-2.5-27b"]);
    expect(fixture.calls.list_conversations(null)[0]).toBeTruthy();
    const [kept] = fixture.calls.get_conversation(fixture.calls.list_conversations(null)[0]!.id).messages.filter((message) => message.role === "assistant");
    expect(kept).toMatchObject({ engine: "OpenAI-compatible", model: "bonsai-2.5-27b" });
  });

  it("shows the model as text when the endpoint lists none", async () => {
    const fixture = start_fixture({ on_announce: () => data_watch.bump() });
    const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
    set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
    render(<AssistantPane context_id={null} />);
    expect(await screen.findByText("Fake · fake-model")).toBeTruthy();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  it("knows when a model may have to load", () => {
    const listing = { plugin_id: "p", model: "a", declared_model: "", problem: "", models: [{ id: "a", state: "loaded" as const }, { id: "b", state: "" as const }] };
    expect(may_load(listing, "a", true)).toBe(false);
    expect(may_load(listing, "b", true)).toBe(true);
    expect(may_load(listing, "b", false)).toBe(false);
    expect(may_load(null, "c", false)).toBe(false);
    expect(model_label({ id: "x", state: "failed" })).toBe("x (failed to load)");
  });
});
