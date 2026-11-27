// Choosing an engine's model from a list: the endpoint's models asked with the engine's own key, a llama.cpp router's
// load state, failures as no list, the choice kept in the engine's settings or, over a declared model, on this device
// alone, and each reply recording the model that wrote it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { read_secret_from } from "../src/server/declared.ts";
import { list_endpoint_models, models_of, state_of } from "../src/server/engines/models.ts";
import { make_openai, openai_plugin, type ModelLister } from "../src/server/engines/index.ts";
import { smartharness_plugin } from "../src/server/engines/smartharness.ts";
import { open_plugin_host } from "../src/shared/collectors/host.ts";
import { use_assistant_host } from "../src/shared/conversations/host.ts";
import { wait_for_runs } from "../src/shared/conversations/run.ts";
import { use_declared } from "../src/shared/declared/current.ts";
import { read_declarations } from "../src/shared/declared/model.ts";
import { chosen_model } from "../src/shared/engines/choices.ts";
import { page_only } from "../src/shared/store.ts";
import { start_fixture } from "./assistant_fixture.ts";
import { start_fake_openai, type FakeOpenAiServer } from "./fake_openai_server.ts";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  use_declared(null);
  use_assistant_host(null);
  for (const close of closers.splice(0)) await close();
});

// A server answering GET /models with what `answer` gives, keeping each request's authorization.
async function models_server(answer: () => { status?: number; body: string }): Promise<{ endpoint: string; authorizations: string[] }> {
  const authorizations: string[] = [];
  const server: Server = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    if (request.method !== "GET" || request.url !== "/v1/models") return void response.writeHead(404).end();
    const { status = 200, body } = answer();
    response.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, authorizations };
}

// A port nothing listens on, found by opening and closing a server.
async function closed_port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const router_answer = JSON.stringify({
  object: "list",
  data: [
    { id: "qwen3.6-35b-a3b", object: "model", owned_by: "llamacpp", in_cache: true, status: { value: "loaded", args: [] } },
    { id: "bonsai-2.5-27b", object: "model", owned_by: "llamacpp", status: { value: "unloaded" } },
    { id: "inkling-2-mini", object: "model", status: { value: "loading" } },
  ],
});

describe("listing an endpoint's models", () => {
  it("lists an OpenAI-format answer, sending the key only as a bearer token", async () => {
    const server = await models_server(() => ({ body: JSON.stringify({ data: [{ id: "gpt-a" }, { id: "gpt-b" }, { id: "gpt-a" }, { nope: 1 }] }) }));
    expect(await list_endpoint_models(`${server.endpoint}/`, "sk-secret-key")).toEqual({
      models: [
        { id: "gpt-a", state: "" },
        { id: "gpt-b", state: "" },
      ],
      problem: "",
    });
    expect(server.authorizations).toEqual(["Bearer sk-secret-key"]);
    await list_endpoint_models(server.endpoint, "");
    expect(server.authorizations[1]).toBe("");
  });

  it("keeps what a llama.cpp router says of each model's load state", async () => {
    const server = await models_server(() => ({ body: router_answer }));
    const listing = await list_endpoint_models(server.endpoint, "");
    expect(listing.models).toEqual([
      { id: "qwen3.6-35b-a3b", state: "loaded" },
      { id: "bonsai-2.5-27b", state: "unloaded" },
      { id: "inkling-2-mini", state: "loading" },
    ]);
    expect(state_of({ status: "loaded" })).toBe("loaded");
    expect(state_of({ status: { value: "odd", failed: true } })).toBe("failed");
    expect(state_of({ loaded: false })).toBe("unloaded");
    expect(state_of({ loaded: true })).toBe("loaded");
    expect(state_of({ status: 3 })).toBe("");
    expect(models_of({ data: "no" })).toBeNull();
  });

  it("gives no list, saying why in words that never hold the key, when the endpoint fails", async () => {
    let answer = { status: 500, body: "sk-secret-key went wrong" };
    const server = await models_server(() => answer);
    const host = new URL(server.endpoint).host;
    expect(await list_endpoint_models(server.endpoint, "sk-secret-key")).toEqual({ models: [], problem: `${host} does not list its models (it answered 500).` });
    answer = { status: 401, body: "" };
    expect((await list_endpoint_models(server.endpoint, "sk-secret-key")).problem).toBe(`${host} refused the API key when asked for its models.`);
    answer = { status: 200, body: "not json" };
    expect((await list_endpoint_models(server.endpoint, "")).problem).toBe(`${host} answered, but not with a list of models.`);
    answer = { status: 200, body: JSON.stringify({ data: [] }) };
    expect((await list_endpoint_models(server.endpoint, "")).problem).toBe(`${host} lists no models.`);
    const port = await closed_port();
    expect(await list_endpoint_models(`http://127.0.0.1:${port}/v1`, "sk-secret-key")).toEqual({ models: [], problem: `127.0.0.1:${port} could not be reached to list its models.` });
  });
});

// ── Through the store ────────────────────────────────────────────────────────

const listed: ModelLister = async (settings) => ({
  models: [
    { id: "qwen3.6-35b-a3b", state: "loaded" },
    { id: "bonsai-2.5-27b", state: "unloaded" },
  ],
  problem: String(settings.endpoint) === "http://down" ? "down" : "",
});

const no_key = async () => "";

describe("choosing an engine's model", () => {
  it("lists the endpoint's models for the OpenAI-compatible and SmartHarness engines, and none for an engine that is off", async () => {
    const fixture = start_fixture({ plugins: [openai_plugin(make_openai, no_key, listed), smartharness_plugin({ read: no_key, list: listed })] });
    await (await open_plugin_host(fixture.database)).set_settings("codex.openai", { endpoint: "http://127.0.0.1:1/v1", model: "qwen3.6-35b-a3b" });
    expect(await fixture.calls.list_engine_models("codex.openai")).toEqual({
      plugin_id: "codex.openai",
      model: "qwen3.6-35b-a3b",
      declared_model: "",
      models: [
        { id: "qwen3.6-35b-a3b", state: "loaded" },
        { id: "bonsai-2.5-27b", state: "unloaded" },
      ],
      problem: "",
    });
    expect((await fixture.calls.list_engine_models("codex.smartharness")).problem).toContain("The engine is off");
    await (await open_plugin_host(fixture.database)).enable("codex.smartharness");
    expect((await fixture.calls.list_engine_models("codex.smartharness")).models).toHaveLength(2);
    await expect(fixture.calls.list_engine_models("codex.nope")).rejects.toThrow("There is no engine plugin codex.nope");
  });

  it("gives no list when the key cannot be read, naming no key", async () => {
    const fixture = start_fixture({ plugins: [openai_plugin(make_openai, async () => Promise.reject(new Error("boom")), listed)] });
    await (await open_plugin_host(fixture.database)).set_settings("codex.openai", { model: "m", api_key_command: "print-key" });
    const listing = await fixture.calls.list_engine_models("codex.openai");
    expect(listing.models).toEqual([]);
    expect(listing.problem).not.toBe("");
  });

  it("keeps a choice for an engine of the user's own in its settings, and only the page may make it", async () => {
    const fixture = start_fixture({ plugins: [openai_plugin(make_openai, no_key, listed)] });
    fixture.calls.set_setting("engine", "openai");
    await fixture.calls.set_engine_model("codex.openai", " bonsai-2.5-27b ");
    expect((await fixture.calls.get_assistant_status()).engine).toMatchObject({ id: "openai", model: "bonsai-2.5-27b" });
    expect((fixture.calls.get_settings().plugins as Record<string, { settings: Record<string, unknown> }>)["codex.openai"]!.settings.model).toBe("bonsai-2.5-27b");
    await expect(fixture.calls.set_engine_model("codex.openai", "a\nb")).rejects.toThrow("one line");
    expect(page_only.is_page_only("set_engine_model")).toBe(true);
    expect(page_only.is_page_only("list_engine_models")).toBe(false);
  });

  it("starts a declared engine on its declared model, holds the owner's choice over it on this device alone, and goes back to it", async () => {
    use_declared({ declarations: () => read_declarations({ engines: { "codex.openai": { endpoint: "http://127.0.0.1:1/v1", model: "qwen3.6-35b-a3b" } } }), read_secret: read_secret_from });
    const fixture = start_fixture({ choose_engine: false, plugins: [openai_plugin(make_openai, no_key, listed)] });
    expect((await fixture.calls.get_assistant_status()).engine).toMatchObject({ id: "openai", model: "qwen3.6-35b-a3b" });

    await fixture.calls.set_engine_model("codex.openai", "bonsai-2.5-27b");
    expect(await fixture.calls.list_engine_models("codex.openai")).toMatchObject({ model: "bonsai-2.5-27b", declared_model: "qwen3.6-35b-a3b" });
    // A host opened afresh, as after a restart, reads the choice from this device's own table.
    const host = await open_plugin_host(fixture.database);
    expect(host.settings("codex.openai")).toMatchObject({ model: "bonsai-2.5-27b", endpoint: "http://127.0.0.1:1/v1" });
    expect(chosen_model(fixture.database, "codex.openai")).toBe("bonsai-2.5-27b");
    // Nothing of it reaches the synced settings, and the endpoint stays declared whatever is written.
    await host.set_settings("codex.openai", { endpoint: "http://elsewhere/v1", model: "x" });
    expect(JSON.stringify(fixture.calls.get_settings())).not.toContain("bonsai");
    expect((await open_plugin_host(fixture.database)).settings("codex.openai")).toMatchObject({ endpoint: "http://127.0.0.1:1/v1", model: "bonsai-2.5-27b" });

    await fixture.calls.set_engine_model("codex.openai", "qwen3.6-35b-a3b");
    expect(chosen_model(fixture.database, "codex.openai")).toBe("");
    await fixture.calls.set_engine_model("codex.openai", "bonsai-2.5-27b");
    await fixture.calls.set_engine_model("codex.openai", "");
    expect((await fixture.calls.get_assistant_status()).engine).toMatchObject({ model: "qwen3.6-35b-a3b" });
  });

  it("answers the next reply with the model chosen, and records it on the reply", async () => {
    const server: FakeOpenAiServer = await start_fake_openai(() => ({ text: ["Hi."] }));
    closers.push(server.close);
    use_declared({ declarations: () => read_declarations({ engines: { "codex.openai": { endpoint: server.endpoint, model: "qwen3.6-35b-a3b" } } }), read_secret: read_secret_from });
    const fixture = start_fixture({ choose_engine: false, plugins: [openai_plugin(make_openai, no_key, listed)] });
    const { conversation_id } = await fixture.calls.send_message(null, "One");
    await wait_for_runs();
    await fixture.calls.set_engine_model("codex.openai", "bonsai-2.5-27b");
    await fixture.calls.send_message(null, "Two", conversation_id);
    await wait_for_runs();
    expect(server.requests.map((request) => request.body.model)).toEqual(["qwen3.6-35b-a3b", "bonsai-2.5-27b"]);
    const answers = fixture.calls.get_conversation(conversation_id).messages.filter((message) => message.role === "assistant");
    expect(answers.map((message) => [message.engine, message.model])).toEqual([
      ["OpenAI-compatible", "qwen3.6-35b-a3b"],
      ["OpenAI-compatible", "bonsai-2.5-27b"],
    ]);
  });
});
