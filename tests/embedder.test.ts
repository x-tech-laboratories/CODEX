import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { create_plugin_host } from "@x-tech-laboratories/x-libs/plugins";

import { embedder_plugins, openai_embedder } from "../src/server/embedders/openai.ts";
import { app_info } from "../src/shared/collectors/collector.ts";
import type { ContextPluginApi } from "../src/shared/collectors/host.ts";
import { openai_embedder_id } from "../src/shared/embedders/manifests.ts";
import { is_hosted } from "../src/shared/engines/engine.ts";

// An OpenAI-compatible embeddings endpoint on a random local port, answering what the test says.
interface FakeEndpoint {
  endpoint: string;
  requests: { url: string; body: { model: string; input: string[] }; authorization: string }[];
  close: () => Promise<void>;
}

let server: Server | null = null;

async function start_endpoint(answer: (input: string[]) => { status?: number; body: unknown }): Promise<FakeEndpoint> {
  const requests: FakeEndpoint["requests"] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; input: string[] };
    requests.push({ url: String(request.url), body, authorization: String(request.headers.authorization ?? "") });
    const { status = 200, body: reply } = answer(body.input);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}/v1/`, requests, close: () => new Promise((resolve) => server!.close(() => resolve())) };
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const vectors_of = (input: string[], size = 3) => ({ data: input.map((text, index) => ({ index, embedding: Array.from({ length: size }, (_, at) => text.length + at) })).reverse() });

describe("the OpenAI-compatible embedder", () => {
  it("posts the texts to the endpoint's embeddings and gives one vector per text, in order", async () => {
    const fake = await start_endpoint((input) => ({ body: vectors_of(input) }));
    const embedder = openai_embedder(() => ({ endpoint: fake.endpoint, model: "nomic-embed-text", dimensions: 3, api_key_command: "print-key" }), async () => "k3y\n");

    expect(await embedder.embed(["a", "abc"])).toEqual([
      [1, 2, 3],
      [3, 4, 5],
    ]);
    expect(fake.requests).toEqual([{ url: "/v1/embeddings", body: { model: "nomic-embed-text", input: ["a", "abc"] }, authorization: "Bearer k3y" }]);
    expect([embedder.label, embedder.model(), embedder.dimensions(), is_hosted(embedder)]).toEqual(["OpenAI-compatible embeddings", "nomic-embed-text", 3, false]);
    expect(await embedder.embed([])).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  it("puts the query prefix before a search alone, reading \\n as a new line, and nothing before what is searched", async () => {
    const fake = await start_endpoint((input) => ({ body: vectors_of(input) }));
    const settings: Record<string, string | number> = { endpoint: fake.endpoint, model: "qwen3-embedding", dimensions: 3, query_prefix: "Instruct: find notes\\nQuery: " };
    const embedder = openai_embedder(() => settings);

    await embedder.embed(["Pick worktop colour"]);
    expect(await embedder.embed_query!("countertop colour choice")).toHaveLength(3);
    settings.query_prefix = "";
    await embedder.embed_query!("bare");

    expect(fake.requests.map((request) => request.body.input)).toEqual([["Pick worktop colour"], ["Instruct: find notes\nQuery: countertop colour choice"], ["bare"]]);
  });

  it("sends no key without a command, and refuses vectors of the wrong size or number, and a failed answer", async () => {
    let answer: (input: string[]) => { status?: number; body: unknown } = (input) => ({ body: vectors_of(input, 4) });
    const fake = await start_endpoint((input) => answer(input));
    const settings = { endpoint: fake.endpoint, model: "m", dimensions: 3 };
    const embedder = openai_embedder(() => settings);

    await expect(embedder.embed(["a"])).rejects.toThrow("The model gives vectors of 4 numbers, not the 3 set under Settings → Index.");
    expect(fake.requests[0]!.authorization).toBe("");
    answer = () => ({ body: { data: [] } });
    await expect(embedder.embed(["a"])).rejects.toThrow("gave 0 vectors for 1 texts");
    answer = () => ({ body: { data: [{ index: 0, embedding: ["x"] }] } });
    await expect(embedder.embed(["a"])).rejects.toThrow("something other than a list of numbers");
    answer = () => ({ status: 503, body: {} });
    await expect(embedder.embed(["a"])).rejects.toThrow("answered 503");
    await expect(openai_embedder(() => ({ ...settings, model: " " })).embed(["a"])).rejects.toThrow("Set the embedding model");
  });

  it("is local on Ollama's address by default and hosted elsewhere, and is provided as a plugin", async () => {
    expect(is_hosted(openai_embedder(() => ({})))).toBe(false);
    expect(is_hosted(openai_embedder(() => ({ endpoint: "https://api.openai.com/v1" })))).toBe(true);
    const host = create_plugin_host<ContextPluginApi>({ app: app_info, storage: { read: () => ({}), write: () => undefined } });
    for (const plugin of embedder_plugins) await host.add(plugin);
    await host.start();
    const [provided] = host.providers("embedder");
    expect([provided!.id, provided!.value.model(), provided!.value.dimensions()]).toEqual([openai_embedder_id, "nomic-embed-text", 768]);
  });
});
