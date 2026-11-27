// @vitest-environment jsdom
import "@x-tech-laboratories/x-libs/web/react/test_stubs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";
import { Dialogs } from "@x-tech-laboratories/x-libs/web/react/dialog";

import { read_secret_from } from "../src/server/declared.ts";
import { embedder_plugins } from "../src/server/embedders/openai.ts";
import { engine_plugins } from "../src/server/engines/index.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { use_declared } from "../src/shared/declared/current.ts";
import { read_declarations } from "../src/shared/declared/model.ts";
import { use_mcp_connector, type McpConnector } from "../src/shared/mcp/connector.ts";
import type { McpServerRecord } from "../src/shared/mcp/model.ts";
import type { ContextMethods } from "../src/shared/store.ts";
import { set_page_api } from "../src/web/api.ts";
import { declared_value } from "../src/web/declared.tsx";
import { forget_page_plugins } from "../src/web/plugins.tsx";
import { SettingsView } from "../src/web/settings/SettingsView.tsx";
import { start_fixture } from "./assistant_fixture.ts";

let folder = "";

afterEach(() => {
  cleanup();
  forget_page_plugins();
  use_declared(null);
  use_mcp_connector(null);
  use_assistant_host(null);
  if (folder) rmSync(folder, { recursive: true, force: true });
});

function start(): { listed: McpServerRecord[] } {
  folder = mkdtempSync(join(tmpdir(), "codex-declared-page-"));
  const token = join(folder, "token");
  writeFileSync(token, "secret-token\n");
  const config = read_declarations({
    engines: {
      "codex.openai": {
        endpoint: "http://127.0.0.1:8080/v1",
        model: "qwen3",
        key_file: token,
      },
    },
    embedder: { model: "nomic-embed-text" },
    sources: {
      "codex.x-tasks": {
        address: "https://tasks.example.org",
        token_file: token,
        include_done: true,
      },
      "codex.trilium": {
        address: "http://127.0.0.1:37840",
        token_file: join(folder, "gone"),
      },
    },
    mcp_servers: [
      {
        id: "budget",
        name: "Budget",
        address: "https://budget.example.org/api/mcp",
        token_file: token,
      },
    ],
    colour: "blue",
  });
  use_declared({ declarations: () => config, read_secret: read_secret_from });
  const listed: McpServerRecord[] = [];
  const connector: McpConnector = {
    list_tools: async (server) => (
      listed.push(server),
      {
        tools: [
          {
            name: "list_budgets",
            description: "Lists the budgets.",
            read_only: true,
            input_schema: { type: "object", properties: {} },
          },
        ],
        instructions: "",
      }
    ),
    call_tool: async () => "ok",
    forget: async () => undefined,
  };
  use_mcp_connector(connector);
  const fixture = start_fixture({
    choose_engine: false,
    plugins: [...engine_plugins, ...embedder_plugins],
  });
  const calls = Object.fromEntries(
    Object.entries(fixture.calls).map(([name, call]) => [name, async (...args: unknown[]) => (call as (...args: unknown[]) => unknown)(...args)]),
  );
  set_page_api({
    host: "web",
    calls: calls as unknown as Client<ContextMethods>,
    device: null,
    on_change: () => () => undefined,
    on_conversation: () => () => undefined,
  });
  render(
    <>
      <SettingsView />
      <Dialogs />
    </>,
  );
  return { listed };
}

describe("what the configuration declares, in Settings", () => {
  it("shows a declared collector's settings read-only, its secret only as read from a file", async () => {
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Open X-Tasks" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(dialog).getByText(/Set by this computer's configuration: it is on/)).toBeTruthy();
    expect(within(dialog).getByText("https://tasks.example.org")).toBeTruthy();
    expect(within(dialog).getByText("From a file")).toBeTruthy();
    expect(within(dialog).getByText("On")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Token")).toBeNull();
    expect(dialog.textContent).not.toContain("secret-token");
  });

  it("says when a declared secret's file cannot be read, and what in the file was left out", async () => {
    start();
    expect(await screen.findByText(/no part colour/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open Trilium" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(await within(dialog).findByText(/could not be read: it does not exist/)).toBeTruthy();
  });

  it("starts Answering on the declared engine and lets the user choose another, and shows the declared embedder", async () => {
    start();
    const answering = (await screen.findAllByLabelText("Answering")).find((each) => each.tagName === "SELECT") as HTMLSelectElement;
    await waitFor(() => expect(answering.value).toBe("openai"));
    expect(screen.getByText(/starts with it; choosing another here holds over it/)).toBeTruthy();
    fireEvent.change(answering, { target: { value: "fake" } });
    await waitFor(() => expect(answering.value).toBe("fake"));
    await waitFor(() => expect(screen.getAllByText("OpenAI-compatible").length).toBeGreaterThan(0));
    expect(await screen.findByText("OpenAI-compatible embeddings")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open OpenAI-compatible" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(dialog).getByText("qwen3")).toBeTruthy();
    expect(within(dialog).getByText("API key")).toBeTruthy();
  });

  it("lists a declared MCP server's tools again when asked, its token read from its file", async () => {
    const { listed } = start();
    fireEvent.click(await screen.findByRole("button", { name: "Open Budget" }));
    const dialog = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(within(dialog).getByText("https://budget.example.org/api/mcp")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listed).toHaveLength(1));
    expect(listed[0]).toMatchObject({
      id: "cfg-budget",
      token: "secret-token",
    });
    expect(await within(dialog).findByText(/1 listed/)).toBeTruthy();
  });

  it("puts each kind of value in words", () => {
    expect(declared_value({ key: "a", label: "A", type: "switch", default: false }, false)).toBe("Off");
    expect(
      declared_value(
        {
          key: "a",
          label: "A",
          type: "choice",
          default: "x",
          choices: [{ value: "x", label: "Ex" }],
        },
        "x",
      ),
    ).toBe("Ex");
    expect(declared_value({ key: "a", label: "A", type: "choice", default: "x", choices: [] }, "y")).toBe("y");
    expect(declared_value({ key: "a", label: "A", type: "text", default: "" }, "")).toBe("Empty");
  });
});
