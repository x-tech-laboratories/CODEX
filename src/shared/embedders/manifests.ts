// The bundled embedder plugin as the plugin host knows it: its name and settings. The store's side runs it and the
// page's side shows its settings, from the same manifest, so this file imports nothing either would not.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginManifest } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../collectors/collector.ts";

// ── Embedders ────────────────────────────────────────────────────────────────

export const openai_embeddings_manifest: PluginManifest = {
  id: "codex.openai-embeddings",
  name: "OpenAI-compatible embeddings",
  version: app_info.version,
  app: app_info.id,
  description: "Turns text into vectors for the search index through an OpenAI-compatible embeddings endpoint, such as Ollama on this computer.",
  settings: [
    {
      key: "endpoint",
      label: "Endpoint",
      hint: "The address the API answers on, ending in /v1; Ollama's on this computer unless changed. An address outside this computer and your own network is hosted.",
      type: "text",
      default: "http://localhost:11434/v1",
      placeholder: "http://localhost:11434/v1",
    },
    { key: "model", label: "Model", hint: "The embedding model's name on that endpoint.", type: "text", default: "nomic-embed-text", placeholder: "nomic-embed-text" },
    { key: "dimensions", label: "Dimensions", hint: "How many numbers each vector the model gives holds, such as 768 for nomic-embed-text.", type: "number", default: 768, min: 8, max: 8192 },
    {
      key: "api_key_command",
      label: "API key command",
      hint: "A command that prints the API key; it runs each time text is embedded, and the key is never stored. Empty sends no key, as a local server needs none.",
      type: "text",
      default: "",
      placeholder: "a command printing the key",
    },
  ],
};

export const embedder_manifests = [openai_embeddings_manifest];

// The id the bundled embedder is provided under, which the embedder setting names.
export const openai_embedder_id = "openai-embeddings";
