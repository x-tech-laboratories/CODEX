// The bundled engine plugins as the plugin host knows them: their names and settings. The store's side runs them and
// the page's side shows their settings, from the same manifests, so this file imports nothing either would not.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginManifest, SettingField } from "@x-tech-laboratories/x-libs/plugins";

import { app_info } from "../collectors/collector.ts";

// ── Settings ─────────────────────────────────────────────────────────────────

function key_command(example: string): SettingField {
  return {
    key: "api_key_command",
    label: "API key command",
    hint: `A command that prints the API key, such as ${example}; it runs each time the engine answers, and the key is never stored. Empty sends no key.`,
    type: "text",
    default: "",
    placeholder: example,
  };
}

function context_size(default_size: number): SettingField {
  return { key: "context_size", label: "Context size", hint: "How many tokens the model reads at once; older tool results are dropped to fit.", type: "number", default: default_size, min: 2048, max: 2_000_000, step: 1024 };
}

// ── Engines ──────────────────────────────────────────────────────────────────

export const anthropic_manifest: PluginManifest = {
  id: "codex.anthropic",
  name: "Anthropic",
  version: app_info.version,
  app: app_info.id,
  description: "Answers with a Claude model through Anthropic's API.",
  settings: [
    { key: "model", label: "Model", hint: "The model's id at Anthropic.", type: "text", default: "claude-opus-5-5", placeholder: "claude-opus-5-5" },
    context_size(200_000),
    key_command("pass show anthropic/api-key"),
  ],
};

export const openai_manifest: PluginManifest = {
  id: "codex.openai",
  name: "OpenAI-compatible",
  version: app_info.version,
  app: app_info.id,
  description: "Answers with a model behind an OpenAI-compatible endpoint: OpenAI itself, or a local server such as Ollama, llama-server or vLLM.",
  settings: [
    {
      key: "endpoint",
      label: "Endpoint",
      hint: "The address the API answers on, ending in /v1; empty for OpenAI's own.",
      type: "text",
      default: "",
      placeholder: "http://localhost:11434/v1",
    },
    { key: "model", label: "Model", hint: "The model's name on that endpoint.", type: "text", default: "", placeholder: "llama3.1" },
    context_size(8192),
    key_command("pass show openai/api-key"),
  ],
};

export const engine_manifests = [anthropic_manifest, openai_manifest];

// The id each bundled engine is provided under, which the engine setting names.
export const anthropic_engine_id = "anthropic";
export const openai_engine_id = "openai";
