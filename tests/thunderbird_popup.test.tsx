// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextSummary } from "../src/shared/contexts/model.ts";

const message: ThunderbirdMessageHeader = { id: 7, headerMessageId: "quote-123@builder.example.org", subject: "Your kitchen quote", author: "Builder <b@example.org>", date: "2026-11-20T10:00:00Z" };
const context = (id: string, name: string, parent_id: string | null): ContextSummary => ({ id, name, parent_id, position: 0, is_archived: false, item_count: 0 });

// The server's answers by method, and every call the popup made to it.
function fake_server(answers: Record<string, (args: Record<string, unknown>) => Response>) {
  const sent: { method: string; args: Record<string, unknown> }[] = [];
  const fetch_mock = vi.fn(async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const args = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ method, args });
    return (answers[method] ?? (() => new Response("no such call", { status: 404 })))(args);
  });
  vi.stubGlobal("fetch", fetch_mock);
  return sent;
}

function fake_thunderbird({ stored = { address: "https://context.example.org", token: "t0k" }, shown = message as ThunderbirdMessageHeader | null } = {}) {
  const thunderbird = {
    storage: { local: { get: vi.fn(async () => stored), set: vi.fn(async () => undefined) } },
    tabs: { query: vi.fn(async () => [{ id: 3 }]) },
    messageDisplay: { getDisplayedMessage: vi.fn(async () => shown) },
    messages: { getFull: vi.fn(async () => ({ contentType: "text/plain", body: "Please find the quote attached." })) },
    permissions: { request: vi.fn(async () => true) },
    runtime: { openOptionsPage: vi.fn(async () => undefined) },
  };
  vi.stubGlobal("browser", thunderbird);
  return thunderbird;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

async function open_popup() {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("../thunderbird/popup.tsx");
}

beforeEach(() => vi.spyOn(window, "close").mockImplementation(() => undefined));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the add-on's popup", () => {
  it("asks for the server first, and opens the options", async () => {
    const thunderbird = fake_thunderbird({ stored: { address: "", token: "" } });
    await open_popup();
    fireEvent.click(await screen.findByRole("button", { name: "Open the options" }));
    expect(thunderbird.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it("says so when no email is shown", async () => {
    fake_thunderbird({ shown: null });
    fake_server({});
    await open_popup();
    expect(await screen.findByText("No email shown")).toBeTruthy();
  });

  it("says so when there are no contexts yet", async () => {
    fake_thunderbird();
    fake_server({ list_contexts: () => json([]), get_item: () => new Response("", { status: 404 }) });
    await open_popup();
    expect(await screen.findByText("No contexts yet")).toBeTruthy();
  });

  it("shows why it could not load", async () => {
    fake_thunderbird();
    fake_server({ list_contexts: () => new Response("", { status: 401 }) });
    await open_popup();
    expect((await screen.findByRole("alert")).textContent).toContain("refused the token");
  });

  it("ticks the contexts holding the email already, and adds it to the ones picked with a note", async () => {
    fake_thunderbird();
    const sent = fake_server({
      list_contexts: () => json([context("g", "Garden", null), context("b", "Beds", "g"), context("t", "Taxes", null)]),
      get_item: () => json({ contexts: [{ id: "t" }] }),
      add_item: () => new Response(null, { status: 204 }),
    });
    await open_popup();

    const list = await screen.findByRole("list", { name: "Contexts" });
    expect(screen.getByText("Your kitchen quote")).toBeTruthy();
    const taxes = within(list).getByRole("checkbox", { name: /Taxes/ }) as HTMLInputElement;
    expect(taxes.checked && taxes.disabled).toBe(true);
    const add = screen.getByRole("button", { name: "Add to context" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(within(list).getByRole("checkbox", { name: "Beds" }));
    fireEvent.click(within(list).getByRole("checkbox", { name: "Garden" }));
    fireEvent.click(within(list).getByRole("checkbox", { name: "Garden" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "For the builder" } });
    fireEvent.click(add);

    expect((await screen.findByRole("status")).textContent).toBe("Added to the context.");
    const added = sent.find((call) => call.method === "add_item")!;
    expect(added.args).toMatchObject({ context_ids: ["b"], collector: "email", note: "For the builder", item: { source_id: "quote-123@builder.example.org", snippet: "Please find the quote attached." } });
    await waitFor(() => expect(window.close).toHaveBeenCalled(), { timeout: 2000 });
  });

  it("keeps the picks and shows the server's answer when adding fails", async () => {
    fake_thunderbird({ shown: { ...message, subject: "" } });
    fake_server({
      list_contexts: () => json([context("g", "Garden", null), context("t", "Taxes", null)]),
      get_item: () => new Response("", { status: 404 }),
      add_item: () => new Response("The context is gone.", { status: 400 }),
    });
    await open_popup();

    expect(await screen.findByText("(no subject)")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Garden" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Taxes" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to context" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The context is gone.");
    expect((screen.getByRole("checkbox", { name: "Garden" }) as HTMLInputElement).checked).toBe(true);
  });

  it("counts the contexts it added to", async () => {
    fake_thunderbird();
    fake_server({
      list_contexts: () => json([context("g", "Garden", null), context("t", "Taxes", null)]),
      get_item: () => new Response("", { status: 404 }),
      add_item: () => new Response(null, { status: 204 }),
    });
    await open_popup();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Garden" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Taxes" }));
    fireEvent.submit(screen.getByRole("button", { name: "Add to context" }).closest("form")!);
    expect((await screen.findByRole("status")).textContent).toBe("Added to 2 contexts.");
  });
});

// The pages of earlier tests stay mounted, detached, so the fakes they reach go only once all are done.
afterAll(() => vi.unstubAllGlobals());
