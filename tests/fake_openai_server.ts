// An OpenAI-compatible chat completions server on a random local port, streaming scripted replies, for tests and for
// driving the app against an engine with no model behind it.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// One reply: text streamed in pieces, or tool calls; a function decides from the request.
export type ScriptedReply = { text?: string[]; tool_calls?: { name: string; arguments: Record<string, unknown> }[]; delay_ms?: number };

export interface FakeOpenAiServer {
  endpoint: string;
  requests: { body: Record<string, unknown>; authorization: string }[];
  close: () => Promise<void>;
}

async function read_body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function start_fake_openai(reply: (body: Record<string, unknown>, index: number) => ScriptedReply): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiServer["requests"] = [];
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await read_body(request)) as Record<string, unknown>;
    requests.push({ body, authorization: String(request.headers.authorization ?? "") });
    const scripted = reply(body, requests.length - 1);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => send({ id: "fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    let closed = false;
    response.on("close", () => (closed = true));
    for (const piece of scripted.text ?? []) {
      if (closed) return;
      chunk({ role: "assistant", content: piece });
      if (scripted.delay_ms) await pause(scripted.delay_ms);
    }
    (scripted.tool_calls ?? []).forEach((call, index) =>
      chunk({ tool_calls: [{ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }),
    );
    chunk({}, scripted.tool_calls?.length ? "tool_calls" : "stop");
    send({ id: "fake", object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
