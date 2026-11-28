// What this computer's configuration declares: read and checked from its file, laid over the stored plugin records with
// secrets read from their files and never written back, choosing the engine and embedder, adding MCP servers that
// cannot be changed from the page, and shown only to the page.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { declared_file_of, keep_declared, read_declared_file, read_secret_from } from "../src/server/declared.ts";
import { key_command_failure } from "../src/server/engines/errors.ts";
import { engine_plugins } from "../src/server/engines/index.ts";
import { DeclaredKeyFailure, plugin_key } from "../src/server/engines/secret_command.ts";
import { node_mcp_connector } from "../src/server/tools/mcp_client.ts";
import { open_plugin_host } from "../src/shared/collectors/host.ts";
import { declarations, declared_summary, use_declared, with_declared, without_declared } from "../src/shared/declared/current.ts";
import { declarable_plugin_ids, read_declarations, type DeclaredConfig } from "../src/shared/declared/model.ts";
import { use_mcp_connector } from "../src/shared/mcp/connector.ts";
import { page_only_methods } from "../src/shared/page_api.ts";
import { context_api, page_only } from "../src/shared/store.ts";
import { open_plugin_tools } from "../src/shared/tools/offered.ts";
import { start_fixture } from "./assistant_fixture.ts";
import { start_fake_mcp_http } from "./fake_mcp_server.ts";

let folder = "";

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "codex-declared-"));
});

afterEach(async () => {
  use_declared(null);
  use_mcp_connector(null);
  await node_mcp_connector.forget();
  rmSync(folder, { recursive: true, force: true });
});

function secret_file(name: string, value: string): string {
  const path = join(folder, name);
  writeFileSync(path, `${value}\n`);
  return path;
}

function declare(config: DeclaredConfig): void {
  use_declared({ declarations: () => config, read_secret: read_secret_from });
}

describe("reading the declarations", () => {
  it("takes engines, the embedder, the X-Tasks and Trilium collectors, the Web plugin and MCP servers, secrets only as paths", () => {
    const config = read_declarations({
      engines: {
        "codex.openai": {
          endpoint: "http://127.0.0.1:8080/v1",
          model: "qwen3",
          context_size: 16384,
          key_file: "/run/secrets/engine",
        },
      },
      embedder: {
        endpoint: "http://127.0.0.1:11434/v1",
        model: "nomic-embed-text",
      },
      sources: {
        "codex.x-tasks": {
          address: "https://tasks.example.org",
          token_file: "/run/secrets/tasks",
        },
        "codex.trilium": {
          address: "http://127.0.0.1:37840",
          token_file: "/run/secrets/trilium",
        },
      },
      web: { search_endpoint: "https://searx.example.org" },
      mcp_servers: [
        {
          id: "x-budget",
          name: "X-Budget",
          address: "https://budget.example.org/api/mcp",
          token_file: "/run/secrets/budget",
        },
        { id: "files", command: "/bin/mcp-files", args: ["--root", "/srv"] },
      ],
    });
    expect(config.problems).toEqual([]);
    expect(config.engine).toBe("openai");
    expect(config.embedder).toBe("openai-embeddings");
    expect(config.plugins.map((plugin) => plugin.plugin_id)).toEqual([
      "codex.openai",
      "codex.openai-embeddings",
      "codex.x-tasks",
      "codex.trilium",
      "codex.web",
    ]);
    expect(config.plugins[0]).toMatchObject({
      settings: {
        endpoint: "http://127.0.0.1:8080/v1",
        model: "qwen3",
        context_size: 16384,
      },
      key_file: "/run/secrets/engine",
      problems: [],
    });
    expect(config.plugins[2]).toMatchObject({
      settings: { address: "https://tasks.example.org" },
      secret_files: { token: "/run/secrets/tasks" },
    });
    expect(config.mcp_servers).toEqual([
      {
        id: "cfg-x-budget",
        name: "X-Budget",
        transport: "http",
        address: "https://budget.example.org/api/mcp",
        token_file: "/run/secrets/budget",
        command: "",
        args: [],
        collector: "",
      },
      {
        id: "cfg-files",
        name: "files",
        transport: "stdio",
        address: "",
        token_file: "",
        command: "/bin/mcp-files",
        args: ["--root", "/srv"],
        collector: "",
      },
    ]);
    expect(declarable_plugin_ids).toContain("codex.web");
  });

  it("says what is wrong, leaving out only what is wrong", () => {
    const config = read_declarations({
      colour: "blue",
      engines: {
        "codex.openai": {
          model: "qwen3",
          api_key_command: "pass show key",
          context_size: "big",
          shoe: 1,
          key_file: "",
        },
        "codex.nope": {},
      },
      sources: {
        "codex.x-tasks": {
          address: "https://tasks.example.org",
          token: "inline",
        },
        "codex.trilium": "no",
      },
      engine: "anthropic",
      mcp_servers: [
        { id: "Bad Id" },
        { id: "both", address: "https://a.example.org", command: "x" },
        { id: "plain", address: "ftp://a.example.org" },
        { id: "nowhere" },
        { id: "user", address: "https://me:pw@a.example.org" },
        7,
        { id: "twice", command: "a" },
        { id: "twice", command: "b" },
        { id: "tasks", address: "https://tasks.example.org/api/mcp", collector: "x-tasks" },
        { id: "tasks-two", address: "https://tasks.example.org/api/mcp", collector: "x-tasks" },
        { id: "odd", command: "c", collector: "Not An Id" },
      ],
    });
    expect(config.plugins[0]).toMatchObject({
      settings: { model: "qwen3" },
      key_file: "",
    });
    expect(config.plugins[0]!.problems).toEqual([
      "OpenAI-compatible has no setting api_key_command; name a key_file instead.",
      'OpenAI-compatible\'s context_size does not fit: "big".',
      "OpenAI-compatible has no setting shoe.",
      "OpenAI-compatible's key_file is not a path.",
    ]);
    expect(config.plugins[1]!.problems).toEqual(["X-Tasks's token is a secret; give the file holding it as token_file."]);
    expect(config.plugins[2]!.problems).toEqual(["Trilium is not a set of settings."]);
    expect(config.engine).toBeNull();
    expect(config.mcp_servers.map((server) => [server.id, server.collector])).toEqual([
      ["cfg-twice", ""],
      ["cfg-tasks", "x-tasks"],
      ["cfg-tasks-two", ""],
      ["cfg-odd", ""],
    ]);
    expect(config.problems).toEqual([
      "The configuration has no part colour; it takes engines, engine, embedder, sources, web, mcp_servers.",
      "engines has no plugin codex.nope; it takes codex.anthropic, codex.openai, codex.smartharness.",
      'engine names "anthropic", which is not a declared engine; it takes openai.',
      "MCP server 1 needs an id of lowercase letters, digits and single hyphens, such as x-budget.",
      "MCP server both gives both an address and a command; give one.",
      "MCP server plain's address must start with http:// or https:// and hold no user or password.",
      "MCP server nowhere needs a whole address, such as https://mcp.example.org/mcp, or a command.",
      "MCP server user's address must start with http:// or https:// and hold no user or password.",
      "MCP server 6 is not a set of fields.",
      "MCP server twice is declared twice; the first holds.",
      "MCP servers tasks and tasks-two both name the collector x-tasks; the first holds.",
      "MCP server odd's collector must be a collector's id, such as x-tasks or trilium; it is linked to none.",
    ]);
    expect(read_declarations(null).plugins).toEqual([]);
    expect(read_declarations([]).problems).toEqual(["The configuration is not a JSON object."]);
    expect(read_declarations({ engines: [], sources: 1, mcp_servers: {} }).problems).toEqual([
      "engines is not a set of plugins by id.",
      "sources is not a set of plugins by id.",
      "mcp_servers is not a list.",
    ]);
    expect(read_declarations({ engine: "openai" }).problems[0]).toContain("it takes none, as no engine is declared");
  });

  it("reads its file, saying so when the file is missing or not JSON", () => {
    const good = join(folder, "declared.json");
    writeFileSync(good, JSON.stringify({ web: { search_endpoint: "https://searx.example.org" } }));
    expect(read_declared_file(good).plugins[0]!.plugin_id).toBe("codex.web");
    const bad = join(folder, "bad.json");
    writeFileSync(bad, "{");
    expect(read_declared_file(bad).problems).toEqual([`The configuration file ${bad} is not JSON.`]);
    expect(read_declared_file(join(folder, "none.json")).problems[0]).toContain("could not be read");
    expect(declared_file_of({})).toBe("/etc/codex/declared.json");
    expect(declared_file_of({}, "")).toBe("");
    expect(declared_file_of({ CODEX_DECLARED_FILE: "" })).toBe("");
  });
});

describe("a secret file", () => {
  it("gives its secret trimmed and fails plainly, naming the file and never its content", () => {
    expect(read_secret_from(secret_file("token", "  abc  "))).toBe("abc");
    expect(() => read_secret_from(join(folder, "missing"))).toThrow(`The secret file ${join(folder, "missing")} could not be read: it does not exist.`);
    expect(() => read_secret_from(folder)).toThrow("it is a folder");
    expect(() => read_secret_from(secret_file("empty", " "))).toThrow("is empty");
    expect(() => read_secret_from(secret_file("big", "x".repeat(20_000)))).toThrow("holds more than a secret");
    if (process.getuid?.() !== 0) {
      const locked = secret_file("locked", "hidden-value");
      chmodSync(locked, 0o000);
      expect(() => read_secret_from(locked)).toThrow("CODEX may not read it");
    }
  });
});

describe("declared plugins", () => {
  it("are laid over the stored records with their secrets from files, and never written back", () => {
    const token = secret_file("tasks", "tasks-token");
    declare(
      read_declarations({
        sources: {
          "codex.x-tasks": {
            address: "https://tasks.example.org",
            token_file: token,
          },
        },
        engines: { "codex.openai": { model: "m", key_file: token } },
      }),
    );
    const stored = {
      "codex.x-tasks": {
        enabled: false,
        settings: { address: "https://mine.example.org", include_done: true },
      },
      "codex.files": { enabled: false },
    };
    const read = with_declared(stored);
    expect(read["codex.x-tasks"]).toEqual({
      enabled: true,
      settings: {
        address: "https://tasks.example.org",
        include_done: true,
        token: "tasks-token",
      },
    });
    expect(read["codex.openai"]).toEqual({
      enabled: true,
      settings: { model: "m", api_key_command: "" },
    });
    expect(read["codex.files"]).toEqual({ enabled: false });
    const written = without_declared({ ...read, "codex.files": { enabled: true } }, stored);
    expect(written).toEqual({
      "codex.x-tasks": stored["codex.x-tasks"],
      "codex.files": { enabled: true },
    });
    expect(JSON.stringify(written)).not.toContain("tasks-token");
  });

  it("leave a secret empty when its file cannot be read, and say why", () => {
    declare(
      read_declarations({
        sources: {
          "codex.trilium": {
            address: "http://127.0.0.1:37840",
            token_file: join(folder, "gone"),
          },
        },
      }),
    );
    expect(with_declared({})["codex.trilium"]!.settings!.token).toBe("");
    const [plugin] = declared_summary().plugins;
    expect(plugin).toMatchObject({
      plugin_id: "codex.trilium",
      secret_fields: ["token"],
      has_key_file: false,
    });
    expect(plugin!.problems[0]).toContain("could not be read: it does not exist");
  });

  it("run in the store's plugin host, which writes nothing declared into the synced settings", async () => {
    const token = secret_file("tasks", "tasks-token");
    declare(
      read_declarations({
        sources: {
          "codex.x-tasks": {
            address: "https://tasks.example.org",
            token_file: token,
          },
        },
      }),
    );
    const fixture = start_fixture();
    const host = await open_plugin_host(fixture.database);
    expect(host.settings("codex.x-tasks")).toMatchObject({
      address: "https://tasks.example.org",
      token: "tasks-token",
    });
    await host.disable("codex.links");
    await host.set_settings("codex.x-tasks", { include_done: true });
    expect(JSON.stringify(fixture.calls.get_settings())).not.toContain("tasks-token");
    expect(JSON.stringify(fixture.calls.get_settings())).not.toContain("tasks.example.org");
    expect((fixture.calls.get_settings().plugins as Record<string, unknown>)["codex.links"]).toEqual({ enabled: false });
  });

  it("start with the declared engine, and leave the choice to the user from then on", async () => {
    declare(
      read_declarations({
        engines: {
          "codex.openai": {
            model: "qwen3",
            endpoint: "http://127.0.0.1:8080/v1",
          },
        },
      }),
    );
    const fixture = start_fixture({ plugins: engine_plugins });
    fixture.calls.set_setting("engine", "fake");
    expect((await fixture.calls.get_assistant_status()).engine).toMatchObject({ id: "fake" });
    fixture.calls.set_setting("engine", "");
    const status = await fixture.calls.get_assistant_status();
    expect(status.engine).toMatchObject({
      id: "openai",
      model: "qwen3",
      is_local: true,
    });
  });

  it("give an engine its key from the declared file, or a plain failure", async () => {
    const key = secret_file("key", "sk-declared");
    declare(
      read_declarations({
        engines: {
          "codex.openai": { model: "m", key_file: key },
          "codex.anthropic": { key_file: join(folder, "gone") },
        },
        engine: "openai",
      }),
    );
    expect(await plugin_key("codex.openai", "")).toBe("sk-declared");
    expect(await plugin_key("codex.files", "", async () => "from-command")).toBe("");
    expect(await plugin_key("codex.files", "pass show key", async () => "from-command")).toBe("from-command");
    const failure = await plugin_key("codex.anthropic", "").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeclaredKeyFailure);
    expect(key_command_failure(failure).message).toBe("The API key file this computer's configuration names could not be read, so no key could be sent.");
    expect(key_command_failure(new Error("x")).message).toContain("The API key command failed");
  });
});

describe("declared MCP servers", () => {
  it("offer their tools with the token from a file, cannot be changed from the page, and are listed only for the page", async () => {
    const fake = await start_fake_mcp_http("mcp-token");
    try {
      const token = secret_file("budget", "mcp-token");
      const config = join(folder, "declared.json");
      writeFileSync(
        config,
        JSON.stringify({
          mcp_servers: [
            {
              id: "budget",
              name: "Budget",
              address: fake.address,
              token_file: token,
            },
          ],
        }),
      );
      const fixture = start_fixture();
      use_mcp_connector(node_mcp_connector);
      let changes = 0;
      const watch = keep_declared(
        config,
        () => fixture.database,
        () => (changes += 1),
      );
      await watch.reload();
      expect(changes).toBe(1);
      expect(fake.authorizations).toContain("Bearer mcp-token");
      const summary = fixture.calls.get_declared_config();
      expect(summary.mcp_servers[0]).toMatchObject({
        id: "cfg-budget",
        name: "Budget",
        has_token_file: true,
        key: "codex.mcp/mcp_cfg-budget",
        sends_outside: false,
        problem: "",
      });
      expect(summary.mcp_servers[0]!.tools.map((tool) => tool.name)).toContain("read_note");
      expect(JSON.stringify(summary)).not.toContain("mcp-token");
      expect(JSON.stringify(summary)).not.toContain(token);
      expect((await open_plugin_tools(fixture.database)).map((tool) => tool.name)).toContain("mcp_cfg-budget__read_note");
      expect(fixture.calls.list_mcp_servers()).toEqual([]);
      expect(JSON.stringify(fixture.calls.get_settings())).not.toContain("Budget");
      await expect(fixture.calls.remove_mcp_server("cfg-budget")).rejects.toThrow(
        "Budget is set by this computer's configuration, so it is changed there, not here.",
      );
      await expect(
        fixture.calls.change_mcp_server("cfg-budget", {
          name: "B",
          transport: "http",
          address: fake.address,
        }),
      ).rejects.toThrow("set by this computer's configuration");
      expect((await fixture.calls.refresh_declared_mcp_server("cfg-budget")).mcp_servers[0]!.problem).toBe("");
      await expect(fixture.calls.refresh_declared_mcp_server("nothing")).rejects.toThrow("declares no MCP server nothing");

      writeFileSync(token, "wrong-token");
      await fixture.calls.refresh_declared_mcp_server("cfg-budget");
      expect(fixture.calls.get_declared_config().mcp_servers[0]!.problem).toBe("Budget refused the token.");
      rmSync(token);
      await fixture.calls.refresh_declared_mcp_server("cfg-budget");
      expect(fixture.calls.get_declared_config().mcp_servers[0]!.problem).toContain("could not be read");
      expect((await open_plugin_tools(fixture.database)).some((tool) => tool.name.startsWith("mcp_cfg-budget"))).toBe(false);
      watch.stop();
    } finally {
      await fake.close();
    }
  });

  it("are read again when the file changes, and none are declared without a file", async () => {
    const fixture = start_fixture();
    const config = join(folder, "declared.json");
    const watch = keep_declared(config, () => fixture.database);
    await watch.reload();
    expect(declarations().plugins).toEqual([]);
    writeFileSync(config, JSON.stringify({ web: { search_endpoint: "https://searx.example.org" } }));
    await watch.reload();
    expect(declarations().plugins.map((plugin) => plugin.plugin_id)).toEqual(["codex.web"]);
    writeFileSync(config, JSON.stringify({ web: { search_endpoint: 3 } }));
    await watch.reload();
    expect(declarations().plugins[0]!.problems[0]).toContain("search_endpoint does not fit");
    watch.stop();
    const none = keep_declared("", () => fixture.database);
    await none.reload();
    expect(declarations()).toMatchObject({ plugins: [], mcp_servers: [] });
    none.stop();
  });
});

describe("the declarations' calls", () => {
  it("are the page's alone", () => {
    for (const method of ["get_declared_config", "refresh_declared_mcp_server"]) {
      expect(page_only_methods.has(method)).toBe(true);
      expect(context_api[method as keyof typeof context_api].page_only).toBe(true);
      expect(page_only.is_page_only(method)).toBe(true);
    }
  });
});
