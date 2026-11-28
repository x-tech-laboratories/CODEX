import { afterEach, describe, expect, it } from "vitest";

import { create_plugin_host, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../../../src/shared/collectors/collector.ts";
import type { ContextPluginApi } from "../../../src/shared/collectors/host.ts";
import { ContextOverflow } from "../../../src/shared/engines/direct.ts";
import type { Engine, EngineEvent, EngineRequest } from "../../../src/shared/engines/engine.ts";
import { chars_per_token, forget_calibrations } from "../../../src/shared/engines/fitting.ts";
import { ModelRefused } from "../../../src/server/engines/anthropic.ts";
import { explain_failure, hide_keys, host_of, overflow_of } from "../../../src/server/engines/errors.ts";
import { make_openai, openai_plugin } from "../../../src/server/engines/index.ts";
import { start_fake_openai, type FakeOpenAiServer, type ScriptedReply } from "../../fixtures/fake_openai_server.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const key = "made-up-key-0123456789";

async function engine_at(endpoint: string, settings: SettingValues = {}): Promise<Engine> {
  const plugin = openai_plugin(make_openai, async () => key);
  const values = { endpoint, model: "small-model", api_key_command: "print-key", context_size: 8192, ...settings };
  const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: { read: () => ({ [plugin.id]: { enabled: true, settings: values } }), write: () => undefined } });
  await host.add(plugin);
  await host.start();
  return host.providers("engine")[0]!.value;
}

const request: EngineRequest = { instructions: "You are CODEX.", conversation: [{ role: "user", text: "Hello" }], tools: { definitions: [], call: async () => ({ result: "", is_error: false }) } };

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const all: EngineEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

// An address with a user and a word in it, made here so no such address is written out.
function with_user(endpoint: string, word: string): string {
  const url = new URL(endpoint);
  url.username = "someone";
  url.password = word;
  return url.href;
}

let server: FakeOpenAiServer | null = null;

async function answering(reply: (body: Record<string, unknown>, index: number) => ScriptedReply): Promise<FakeOpenAiServer> {
  server = await start_fake_openai(reply);
  return server;
}

async function last_event(reply: ScriptedReply): Promise<EngineEvent> {
  const fake = await answering(() => reply);
  const events = await collect((await engine_at(fake.endpoint)).run(request, new AbortController().signal));
  expect(JSON.stringify(events)).not.toContain(key);
  return events.at(-1)!;
}

afterEach(async () => {
  await server?.close();
  server = null;
  forget_calibrations();
});

// ── Reasoning ────────────────────────────────────────────────────────────────

describe("an OpenAI-compatible reasoning model", () => {
  it("streams its reasoning_content as reasoning events before the answer, never in it", async () => {
    const fake = await answering(() => ({ reasoning: ["The user ", "greets me."], text: ["Hello ", "there."] }));

    const events = await collect((await engine_at(fake.endpoint)).run(request, new AbortController().signal));

    expect(events.filter((event) => event.type === "reasoning" || event.type === "text")).toEqual([
      { type: "reasoning", text: "The user " },
      { type: "reasoning", text: "greets me." },
      { type: "text", text: "Hello " },
      { type: "text", text: "there." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", text: "Hello there." });
  });

  it("calibrates the estimate for its endpoint and model from the usage the server reports", async () => {
    const fake = await answering(() => ({ text: ["Hi."], prompt_tokens: 200 }));
    await collect((await engine_at(fake.endpoint)).run(request, new AbortController().signal));
    expect(chars_per_token(`OpenAI-compatible\n${fake.endpoint}\nsmall-model`)).toBeLessThan(1.5);
  });
});

// ── Failures ─────────────────────────────────────────────────────────────────

describe("an engine's failures in plain words", () => {
  it("names the host and port of an endpoint that cannot be reached, and never what else its address holds", async () => {
    const fake = await answering(() => ({}));
    const word = ["hun", "ter", "22"].join("");
    const endpoint = with_user(fake.endpoint, word);
    await fake.close();
    server = null;

    const events = await collect((await engine_at(endpoint)).run(request, new AbortController().signal));

    const port = new URL(endpoint).port;
    expect(events.at(-1)).toEqual({ type: "error", message: `The engine at 127.0.0.1:${port} cannot be reached. Check that its server is running and that the endpoint under Settings → Assistant → Engine is right.`, detail: expect.any(String) });
    expect(JSON.stringify(events)).not.toContain(word);
  }, 20_000);

  it("says the key was refused, hiding any key the server quotes back", async () => {
    expect(await last_event({ status: 401, error: `Incorrect API key provided: ${key} or sk-abcdef123456.` })).toEqual({
      type: "error",
      message: expect.stringMatching(/^The engine at 127\.0\.0\.1:\d+ refused the API key\. Check the API key command under Settings → Assistant → Engine\.$/),
      detail: "401 Incorrect API key provided: [hidden] or [hidden].",
    });
  });

  it("says the model's name is unknown", async () => {
    expect(await last_event({ status: 404, error: "model 'small-model' not found" })).toMatchObject({ message: expect.stringMatching(/^The engine at 127\.0\.0\.1:\d+ does not know the model “small-model”\. Check the model's name under Settings → Assistant → Engine\.$/) });
  });

  it("says the service is limiting how often it is asked", async () => {
    expect(await last_event({ status: 429, error: "Rate limit reached" })).toMatchObject({ message: expect.stringMatching(/is limiting how often it is asked\. Wait a minute and send again, or check the account's quota\.$/), detail: "429 Rate limit reached" });
  });

  it("refits a request the server finds too large, then says so plainly if it still is", async () => {
    const fake = await answering(() => ({ status: 400, error: "request (17931 tokens) exceeds the available context size (8192 tokens), try increasing it" }));

    const events = await collect((await engine_at(fake.endpoint)).run(request, new AbortController().signal));

    expect(fake.requests).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "The request was too large for the model's context, even after CODEX cut the conversation down. Raise the engine's context size under Settings → Assistant → Engine (and on the model's server), or start a new conversation.",
      detail: "400 request (17931 tokens) exceeds the available context size (8192 tokens), try increasing it",
    });
  });

  it("says a reply was cut off at its limit", async () => {
    expect(await last_event({ text: ["Half of it"], finish_reason: "length" })).toMatchObject({ message: expect.stringMatching(/^The reply was cut off at its limit of [\d,]+ tokens\./) });
  });

  it("keeps anything else behind Details with a plain lead-in", async () => {
    expect(await last_event({ status: 500, error: "CUDA out of memory" })).toEqual({ type: "error", message: expect.stringMatching(/^The engine at 127\.0\.0\.1:\d+ could not answer\.$/), detail: "500 CUDA out of memory" });
  });

  it("names a provider's own host when the endpoint is empty, and never a user or what follows it", () => {
    expect(host_of("", "https://api.openai.com/v1")).toBe("api.openai.com:443");
    expect(host_of(with_user("http://192.168.1.5:8080/v1", "word"), "")).toBe("192.168.1.5:8080");
    expect(host_of("not a url", "")).toBe("the address in its settings");
    expect(explain_failure(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }), { endpoint: "", default_endpoint: "https://api.anthropic.com", model: "m" }).message).toBe(
      "The engine at api.anthropic.com:443 did not answer in time. Check that its server is running and not overloaded, then send again.",
    );
    expect(explain_failure(Object.assign(new Error("404 Not Found"), { status: 404 }), { endpoint: "http://localhost:1234", default_endpoint: "", model: "m" }).message).toBe(
      "The engine at localhost:1234 has no chat completions at that address. Check the endpoint under Settings → Assistant → Engine; it usually ends in /v1.",
    );
    expect(hide_keys("key sk-ant-api03-abcdefgh and more")).toBe("key [hidden] and more");
    expect(explain_failure(new ModelRefused("cyber"), { endpoint: "", default_endpoint: "https://api.anthropic.com", model: "m" })).toEqual({ message: "The model declined the request (cyber)." });
  });

  it("knows a size failure by its words or its status, with the tokens counted when said", () => {
    expect(overflow_of(Object.assign(new Error("400 prompt is too long: 210000 tokens > 200000 maximum"), { status: 400 }))).toMatchObject({ prompt_tokens: 210_000 });
    expect(overflow_of(Object.assign(new Error("400 This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."), { status: 400 }))).toMatchObject({ prompt_tokens: 9000 });
    expect(overflow_of(Object.assign(new Error("Payload too large"), { status: 413 }))).toMatchObject({ prompt_tokens: null });
    expect(overflow_of(Object.assign(new Error("400 bad tool schema"), { status: 400 }))).toBeNull();
    const known = new ContextOverflow("x", 5);
    expect(overflow_of(known)).toBe(known);
  });
});
