// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { use_mcp_connector, type McpConnector } from "../src/shared/mcp/connector.ts";
import type { McpServerRecord } from "../src/shared/mcp/model.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { fields_of } from "../src/web/mcp/McpServers.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { start_fixture, type Fixture } from "./assistant_fixture.ts";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_mcp_connector(null);
  use_assistant_host(null);
});

// A stand-in for the servers, so the page's test starts nothing.
function start(): { fixture: Fixture; listed: McpServerRecord[] } {
  const fixture = start_fixture();
  const listed: McpServerRecord[] = [];
  const connector: McpConnector = {
    list_tools: async (server) => (listed.push(server), [
      { name: "read_file", description: "Reads a file.", read_only: true, input_schema: { type: "object", properties: {} } },
      { name: "write_file", description: "Writes a file.", read_only: false, input_schema: { type: "object", properties: {} } },
    ]),
    call_tool: async () => "ok",
    forget: async () => undefined,
  };
  use_mcp_connector(connector);
  const calls = Object.fromEntries(Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]));
  set_page_api({ host: "web", calls: calls as unknown as Client<ContextMethods>, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });
  render(
    <>
      <SettingsView />
      <Dialogs />
    </>,
  );
  return { fixture, listed };
}

describe("the MCP servers in Settings", () => {
  it("add a local server, show its tools with their marks and switches, turn it off and remove it", async () => {
    const { fixture, listed } = start();
    fireEvent.click(await screen.findByRole("button", { name: "Add an MCP server…" }));
    const adding = await screen.findByRole("dialog");
    fireEvent.change(within(adding).getByLabelText("Name"), { target: { value: "Notes" } });
    fireEvent.change(within(adding).getByLabelText("Program"), { target: { value: "/usr/bin/mcp-files" } });
    fireEvent.change(within(adding).getByLabelText("Arguments"), { target: { value: "--root\n/home/notes\n" } });
    fireEvent.change(within(adding).getByLabelText("Variables passed"), { target: { value: "NOTES_TOKEN, OTHER" } });
    fireEvent.click(within(adding).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fixture.calls.list_mcp_servers()).toHaveLength(1));
    expect(listed[0]).toMatchObject({ name: "Notes", transport: "stdio", command: "/usr/bin/mcp-files", args: ["--root", "/home/notes"], variables: ["NOTES_TOKEN", "OTHER"] });

    fireEvent.click(await screen.findByRole("button", { name: "Open Notes" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(await within(dialog).findByText(/2 listed/)).toBeTruthy();
    expect(within(dialog).getByText(/They stay on this computer\./)).toBeTruthy();
    fireEvent.click(await within(dialog).findByLabelText("May be used after reading private sources"));
    await waitFor(() => expect(fixture.calls.get_settings().tool_plugins).toEqual({ "codex.mcp/mcp_notes": { after_private: true } }));
    fireEvent.click(within(dialog).getByLabelText("Offer write_file"));
    await waitFor(async () => expect((await fixture.calls.list_plugin_tools())[0]!.tools.find((tool) => tool.tool === "write_file")!.enabled).toBe(false));

    fireEvent.click(within(dialog).getByLabelText("Notes on"));
    await waitFor(() => expect(fixture.calls.list_mcp_servers()[0]!.enabled).toBe(false));
    expect(listed).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove…" }));
    const confirm = (await screen.findAllByRole("dialog")).at(-1)!;
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fixture.calls.list_mcp_servers()).toEqual([]));
  });

  it("send an address server's token only when one is typed, keeping the stored one otherwise", () => {
    const values = { name: "Far", transport: "http" as const, address: "https://mcp.example.org/mcp", token: "", command: "", args: "", variables: "" };
    expect(fields_of(values, true)).toEqual({ name: "Far", transport: "http", address: "https://mcp.example.org/mcp", token: null });
    expect(fields_of(values, false)).toMatchObject({ token: "" });
    expect(fields_of({ ...values, token: "new" }, true, false)).toMatchObject({ token: "new", enabled: false });
  });
});
