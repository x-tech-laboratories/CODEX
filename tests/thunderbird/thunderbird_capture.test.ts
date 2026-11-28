import { describe, expect, it, vi } from "vitest";

import type { ContextSummary } from "../../src/shared/contexts/model.ts";
import { call_server, context_rows, contexts_holding, email_item, email_item_id, plain_text_of, server_origin } from "../../thunderbird/capture.ts";

const message: ThunderbirdMessageHeader = { id: 7, headerMessageId: "quote-123@builder.example.org", subject: "Your kitchen quote", author: "Builder <b@example.org>", date: new Date("2026-11-20T10:00:00Z") };
const settings = { address: "https://context.example.org/", token: "t0k" };

function answer(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status });
}

describe("the Thunderbird add-on", () => {
  it("turns the email shown into an item keyed by its Message-ID", () => {
    expect(email_item(message, "Dear customer,\n\nPlease find the quote attached.")).toEqual({
      source_id: "quote-123@builder.example.org",
      kind: "email",
      title: "Your kitchen quote",
      snippet: "Dear customer, Please find the quote attached.",
      uri: "mid:quote-123@builder.example.org",
      detail: { from: "Builder <b@example.org>", date: "2026-11-20T10:00:00.000Z" },
    });
    expect(email_item({ ...message, subject: " " }, "").snippet).toBe("From Builder <b@example.org>");
    expect(email_item({ ...message, subject: "" }, "").title).toBe("(no subject)");
    expect(email_item_id({ ...message, headerMessageId: "<a@b>" })).toBe("email:a@b");
  });

  it("finds the first plain text part of a message", () => {
    const full: ThunderbirdMessagePart = {
      contentType: "multipart/mixed",
      parts: [{ contentType: "multipart/alternative", parts: [{ contentType: "text/html", body: "<p>Hi</p>" }, { contentType: "text/plain; charset=utf-8", body: "Hi" }] }],
    };
    expect(plain_text_of(full)).toBe("Hi");
    expect(plain_text_of({ contentType: "text/html", body: "<p>Hi</p>" })).toBe("");
  });

  it("lays the contexts out as a tree, children under their parent in order", () => {
    const context = (id: string, name: string, parent_id: string | null, position: number): ContextSummary => ({ id, name, parent_id, position, is_archived: false, item_count: 0 });
    const rows = context_rows([context("b", "Beds", "g", 0), context("t", "Taxes", null, 1), context("g", "Garden", null, 0), context("o", "Orphan", "gone", 0)]);
    expect(rows.map((row) => [row.context.name, row.depth])).toEqual([
      ["Garden", 0],
      ["Beds", 1],
      ["Orphan", 0],
      ["Taxes", 0],
    ]);
  });

  it("calls the server by name with its token, and says plainly when the token is refused", async () => {
    const fetch = vi.fn(async () => answer([{ id: "g" }]));
    expect(await call_server(settings, "list_contexts", {}, fetch)).toEqual([{ id: "g" }]);
    expect(fetch).toHaveBeenCalledWith("https://context.example.org/api/call/list_contexts", expect.objectContaining({ method: "POST", body: "{}", headers: expect.objectContaining({ authorization: "Bearer t0k" }) }));
    expect(await call_server(settings, "add_item", {}, vi.fn(async () => answer(null, 204)))).toBeUndefined();
    await expect(call_server(settings, "x", {}, vi.fn(async () => answer({}, 401)))).rejects.toThrow("refused the token");
    await expect(call_server(settings, "x", {}, vi.fn(async () => new Response("There is no context c.", { status: 500 })))).rejects.toThrow("There is no context c.");
  });

  it("asks which contexts hold the email already, none when the server has never seen it", async () => {
    const held = vi.fn(async () => answer({ contexts: [{ id: "g", name: "Garden" }] }));
    expect(await contexts_holding(settings, message, held)).toEqual(["g"]);
    expect(await contexts_holding(settings, message, vi.fn(async () => answer({}, 500)))).toEqual([]);
  });

  it("takes only a web address as the server", () => {
    expect(server_origin(" https://context.example.org/x ")).toBe("https://context.example.org");
    expect(server_origin("context.example.org")).toBeNull();
    expect(server_origin("file:///etc")).toBeNull();
  });
});
