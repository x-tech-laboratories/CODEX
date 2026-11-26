// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

function fake_thunderbird({ stored = {} as Record<string, unknown>, allowed = true } = {}) {
  const thunderbird = {
    storage: { local: { get: vi.fn(async () => stored), set: vi.fn(async () => undefined) } },
    permissions: { request: vi.fn(async () => allowed) },
  };
  vi.stubGlobal("browser", thunderbird);
  return thunderbird;
}

async function open_options() {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("../thunderbird/options.tsx");
}

async function fill(address: string, token: string) {
  fireEvent.change(await screen.findByLabelText("Server address"), { target: { value: address } });
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("the add-on's options", () => {
  it("shows what was saved before", async () => {
    fake_thunderbird({ stored: { address: "https://context.example.org", token: "t0k" } });
    await open_options();
    await waitFor(() => expect((screen.getByLabelText("Server address") as HTMLInputElement).value).toBe("https://context.example.org"));
    expect((screen.getByLabelText("Token") as HTMLInputElement).value).toBe("t0k");
  });

  it("refuses an address that is not a web address", async () => {
    const thunderbird = fake_thunderbird();
    await open_options();
    await fill("context.example.org", "t0k");
    expect((await screen.findByRole("status")).textContent).toContain("starting with https://");
    expect(thunderbird.storage.local.set).not.toHaveBeenCalled();
  });

  it("saves nothing without Thunderbird's leave to reach the server", async () => {
    const thunderbird = fake_thunderbird({ allowed: false });
    await open_options();
    await fill("https://context.example.org/", "t0k");
    expect((await screen.findByRole("status")).textContent).toContain("needs your leave");
    expect(thunderbird.permissions.request).toHaveBeenCalledWith({ origins: ["https://context.example.org/*"] });
    expect(thunderbird.storage.local.set).not.toHaveBeenCalled();
  });

  it("saves the server and checks it answers", async () => {
    const thunderbird = fake_thunderbird();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "g" }, { id: "t" }]), { status: 200 })));
    await open_options();
    await fill(" https://context.example.org ", " t0k ");
    expect((await screen.findByRole("status")).textContent).toBe("Connected; 2 contexts found.");
    expect(thunderbird.storage.local.set).toHaveBeenCalledWith({ address: "https://context.example.org", token: "t0k" });
  });

  it("says why the server did not answer", async () => {
    fake_thunderbird();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await open_options();
    await fill("https://context.example.org", "old");
    expect((await screen.findByRole("status")).textContent).toContain("refused the token");
  });
});

// The pages of earlier tests stay mounted, detached, so the fakes they reach go only once all are done.
afterAll(() => vi.unstubAllGlobals());
