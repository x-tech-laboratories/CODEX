// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Toasts } from "@x-tech-laboratories/x-libs/web/react/toasts";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { forget_prefixes } from "../src/shared/sources/client.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";
import { start_fake_item_app, type FakeItemApp } from "./fake_item_app.ts";

let app: FakeItemApp | null = null;

afterEach(async () => {
  cleanup();
  forget_page_plugins();
  forget_prefixes();
  use_assistant_host(null);
  await app?.close();
  app = null;
});

function open_settings(fixture: Fixture): void {
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  render(
    <>
      <SettingsView />
      <Dialogs />
      <Toasts />
    </>,
  );
}

describe("apps in Settings", () => {
  it("adds an app, shows it as a row with its kinds, and marks it on its own", async () => {
    app = await start_fake_item_app({ notes: [{ id: "n1", title: "Boiler", notes: "" }] });
    const fixture = start_fixture();
    open_settings(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "Add an app…" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Notes" } });
    fireEvent.change(within(dialog).getByLabelText("Address"), { target: { value: app.address } });
    fireEvent.change(within(dialog).getByLabelText("Token"), { target: { value: "wrong" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/Notes refused the token/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Token"), { target: { value: "read-only-test-token" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fixture.calls.list_item_sources().map((each) => each.name)).toEqual(["Notes"]));

    fireEvent.click(await screen.findByRole("button", { name: "Open Notes" }));
    dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Answers, with Note.")).toBeTruthy();
    expect((within(dialog).getByLabelText("Token") as HTMLInputElement).value).toBe("");
    fireEvent.click(within(dialog).getByLabelText("Trusted content"));
    await waitFor(() => expect(fixture.calls.get_settings().source_marks).toEqual({ "codex.items/app.notes": { send_to_hosted: false, trusted: true } }));

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My notes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fixture.calls.list_item_sources()[0]).toMatchObject({ name: "My notes", has_token: true }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove…" }));
    const confirm = await screen.findByRole("dialog", { name: /Remove My notes/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fixture.calls.list_item_sources()).toEqual([]));
  });
});
