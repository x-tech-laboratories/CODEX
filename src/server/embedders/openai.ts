// The bundled embedder: any OpenAI-compatible embeddings endpoint, Ollama's on this computer unless changed. It needs
// Node for the key command, so it runs where the store does: the server or the desktop daemon.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPlugin, ContextPluginApi } from "../../shared/collectors/host.ts";
import type { Embedder } from "../../shared/embedders/embedder.ts";
import { openai_embedder_id, openai_embeddings_manifest } from "../../shared/embedders/manifests.ts";
import { is_local_endpoint } from "../../shared/engines/hosting.ts";
import { PlainFailure } from "../../shared/engines/direct.ts";
import { explain_embedder_failure } from "../engines/errors.ts";
import { key_from, read_secret, type SecretReader } from "../engines/secret_command.ts";

// ── Embedder ─────────────────────────────────────────────────────────────────

const default_endpoint = "http://localhost:11434/v1";

function endpoint_of(settings: SettingValues): string {
  return (String(settings.endpoint ?? "").trim() || default_endpoint).replace(/\/+$/, "");
}

// An embedder on the endpoint the settings name, its key read afresh for each call and dropped with it.
export function openai_embedder(settings: () => SettingValues, read: SecretReader = read_secret): Embedder {
  const model = () => String(settings().model ?? "").trim();
  const dimensions = () => Number(settings().dimensions) || 768;
  const query_prefix = () => String(settings().query_prefix ?? "").replace(/\\n/g, "\n");
  const embedder: Embedder = {
    label: "OpenAI-compatible embeddings",
    model,
    dimensions,
    is_local: () => is_local_endpoint(endpoint_of(settings())),
    async embed(texts, signal) {
      if (texts.length === 0) return [];
      if (!model()) throw new Error("Set the embedding model under Settings → Index.");
      const api_key = await key_from(String(settings().api_key_command ?? ""), read);
      const endpoint = endpoint_of(settings());
      const failure = (error: unknown) => {
        const { message, detail } = explain_embedder_failure(error, endpoint, default_endpoint, model());
        return new PlainFailure(message, detail);
      };
      let response: Response;
      try {
        response = await fetch(`${endpoint}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(api_key ? { authorization: `Bearer ${api_key}` } : {}) },
          body: JSON.stringify({ model: model(), input: texts }),
          signal: signal ?? null,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw failure(error);
      }
      if (!response.ok) {
        const said = await response.text().catch(() => "");
        throw failure(Object.assign(new Error(`The embeddings endpoint answered ${response.status} ${response.statusText}.${said ? ` ${said.slice(0, 500)}` : ""}`), { status: response.status }));
      }
      const answer = (await response.json()) as { data?: { index?: number; embedding?: unknown }[] };
      const rows = [...(answer.data ?? [])].sort((first, second) => (first.index ?? 0) - (second.index ?? 0));
      if (rows.length !== texts.length) throw new Error(`The embeddings endpoint gave ${rows.length} vectors for ${texts.length} texts.`);
      return rows.map((row) => {
        const vector = row.embedding;
        if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number")) throw new Error("The embeddings endpoint gave something other than a list of numbers.");
        if (vector.length !== dimensions()) throw new Error(`The model gives vectors of ${vector.length} numbers, not the ${dimensions()} set under Settings → Index.`);
        return vector as number[];
      });
    },
    async embed_query(query, signal) {
      const [vector] = await embedder.embed([`${query_prefix()}${query}`], signal);
      return vector!;
    },
  };
  return embedder;
}

export function openai_embedder_plugin(read?: SecretReader): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...openai_embeddings_manifest,
    start: (context) => context.provide("embedder", openai_embedder_id, openai_embedder(() => context.settings(), read)),
  });
}

export const embedder_plugins: ContextPlugin[] = [openai_embedder_plugin()];
