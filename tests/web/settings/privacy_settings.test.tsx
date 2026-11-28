// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../../../src/shared/conversations/host.ts";
import { record_hosted_send } from "../../../src/shared/privacy/store.ts";
import type { ContextMethods } from "../../../src/shared/store.ts";
import { set_page_api } from "../../../src/web/api.ts";
import { forget_page_plugins } from "../../../src/web/plugins/plugins.tsx";
import { send_words } from "../../../src/web/privacy/PrivacySettings.tsx";
import { SettingsView } from "../../../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "../../fixtures/assistant_fixture.ts";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_assistant_host(null);
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

describe("privacy and trust in Settings", () => {
  it("shows both marks off in a collector's row, explained, and turns one on", async () => {
    const fixture = start_fixture();
    open_settings(fixture);

    fireEvent.click(await screen.findByRole("button", { name: "Open Web links" }));
    const dialog = await screen.findByRole("dialog");
    const hosted = (await within(dialog).findByLabelText("May be sent to a hosted engine")) as HTMLInputElement;
    const trusted = within(dialog).getByLabelText("Trusted content") as HTMLInputElement;
    expect([hosted.checked, trusted.checked]).toEqual([false, false]);
    expect(within(dialog).getByText(/a hosted engine is told only how many items were left out/)).toBeTruthy();
    expect(within(dialog).getByText(/every change it asks for waits for your approval/)).toBeTruthy();

    fireEvent.click(hosted);
    await waitFor(() => expect(fixture.calls.get_settings().source_marks).toEqual({ "codex.links": { send_to_hosted: true, trusted: false } }));
  });

  it("says whether the answering engine is hosted, and lists what hosted engines were sent", async () => {
    const fixture = start_fixture({ hosted: true });
    record_hosted_send(fixture.database, { run_id: "r1", conversation_id: "general", engine: "Fake", model: "fake-model", included: [{ collector: "email", label: "Email", count: 2 }], withheld: [{ collector: "links", label: "Web links", count: 1 }] });
    open_settings(fixture);

    expect(await screen.findByText(/It is hosted: it is sent only the items of sources marked/)).toBeTruthy();
    const log = await waitFor(() => section("Sent to hosted engines"));
    expect(await within(log).findByText("Fake, fake-model: 2 items (2 from Email); 1 withheld (1 from Web links)")).toBeTruthy();
    expect((within(log).getByLabelText("Keep the log for") as HTMLInputElement).value).toBe("90");
  });

  it("says a run sent nothing in plain words", () => {
    expect(send_words({ id: "1", run_id: "r", conversation_id: "general", engine: "Anthropic", model: "", included: [], withheld: [], item_count: 0, sent_at: "", kind: "reply", tool: "", argument_count: 0, argument_chars: 0 })).toBe("Anthropic: no items");
    const use = { id: "2", run_id: "r", conversation_id: "c", engine: "Fake", model: "fake-model", included: [], withheld: [], item_count: 0, sent_at: "", kind: "tool" as const, tool: "Web: web_search", argument_count: 1, argument_chars: 12 };
    expect(send_words(use)).toBe("Web: web_search, asked by Fake, fake-model: sent 1 argument of 12 characters");
  });
});
