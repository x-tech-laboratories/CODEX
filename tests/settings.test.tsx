// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import type { DeviceMethods } from "../src/shared/page_api.ts";
import { setting_defaults, type ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";

afterEach(() => {
  cleanup();
  forget_page_plugins();
});

function fake_calls(saved: Record<string, unknown>): Client<ContextMethods> {
  return {
    get_settings: vi.fn(async () => ({ ...setting_defaults, ...saved })),
    set_setting: vi.fn(async (key: string, value: unknown) => {
      saved[key] = value;
    }),
  } as unknown as Client<ContextMethods>;
}

const off = { state: "off", server_url: "", user: "", last_synced_at: "", pending_changes: 0, error: "" } as const;

describe("settings", () => {
  it("saves how often items refresh, and shows no Sync in a browser", async () => {
    const calls = fake_calls({});
    set_page_api({ host: "web", calls, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
    render(<SettingsView />);

    const minutes = await screen.findByLabelText("Refresh every");
    expect((minutes as HTMLInputElement).value).toBe("30");
    fireEvent.change(minutes, { target: { value: "10" } });
    fireEvent.blur(minutes);
    await waitFor(() => expect(calls.set_setting).toHaveBeenCalledWith("refresh_minutes", 10));
    expect(screen.queryByText("Sync")).toBeNull();
  });

  it("lists every collector with whether it is set up", async () => {
    const calls = fake_calls({ plugins: { "codex.trilium": { enabled: true, settings: { address: "https://notes.example.org", token: "hidden" } } } });
    set_page_api({ host: "web", calls, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    for (const name of ["Files", "X-Tasks", "Trilium", "Web links", "Email"]) expect(await screen.findByText(name)).toBeTruthy();
    const trilium_row = screen.getByText("Trilium").closest(".setting-row") as HTMLElement;
    expect(within(trilium_row).getByText("On")).toBeTruthy();
    const tasks_row = screen.getByText("X-Tasks").closest(".setting-row") as HTMLElement;
    expect(within(tasks_row).getByText("Not set up")).toBeTruthy();
  });

  it("offers sync on a device and signs it in with the choice of copy", async () => {
    const device = {
      get_sync_status: vi.fn(async () => off),
      connect_sync: vi.fn(async () => ({ ...off, state: "idle", server_url: "https://context.example.org/" })),
      disconnect_sync: vi.fn(),
      sync_now: vi.fn(),
    } as unknown as Client<DeviceMethods>;
    set_page_api({ host: "desktop", calls: fake_calls({}), device, on_change: () => () => undefined, on_conversation: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    fireEvent.change(await screen.findByLabelText("Server address"), { target: { value: "https://context.example.org" } });
    fireEvent.change(screen.getByLabelText("User name"), { target: { value: "ada" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Use the server's context data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use the server's" }));
    await waitFor(() => expect(device.connect_sync).toHaveBeenCalledWith("https://context.example.org", { name: "ada", password: "secret" }, "download"));
  });

  it("shows the server's backups in a browser and takes one by hand", async () => {
    const taken = { name: "context-2026-11-10T09-30-00Z.db", taken_at: "2026-11-10T09:30:00Z", is_automatic: false, size_bytes: 4096 };
    const backups = {
      list_backups: vi.fn(async () => [taken]),
      create_backup: vi.fn(async () => taken),
      restore_backup: vi.fn(),
      remove_backup: vi.fn(),
      get_backup_schedule: vi.fn(async () => ({ automatic: true, to_keep: 14 })),
      set_backup_schedule: vi.fn(),
    };
    set_page_api({ host: "web", calls: fake_calls({}), device: null, backups, on_change: () => () => undefined, on_conversation: () => () => undefined });
    render(<><SettingsView /><Dialogs /></>);

    expect((await screen.findAllByText("Server")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Backups")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Sync")).toBeNull();
    await waitFor(() => expect(backups.list_backups).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Back up" }));
    await waitFor(() => expect(backups.create_backup).toHaveBeenCalled());
  });
});
