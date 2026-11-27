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
  return {
    key: "context_size",
    label: "Context size",
    hint: "How many tokens the model reads at once, as its server is set to; CODEX leaves out older messages to fit, and a small model reads faster with less.",
    type: "number",
    default: default_size,
    min: 2048,
    max: 2_000_000,
    step: 1024,
  };
}

const tool_set: SettingField = {
  key: "tool_set",
  label: "Tools offered",
  hint: "Which of CODEX's tools the model is offered. Automatic offers the core set, the reads and the most-used changes briefly described, when the context size is under 16,384 tokens, and every tool above it.",
  type: "choice",
  default: "auto",
  choices: [
    { value: "auto", label: "Automatic" },
    { value: "core", label: "Core set" },
    { value: "all", label: "All tools" },
  ],
};

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
    tool_set,
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
    tool_set,
    key_command("pass show openai/api-key"),
  ],
};

function whole(key: string, label: string, hint: string, default_value: number, min: number, max: number): SettingField {
  return { key, label, hint, type: "number", default: default_value, min, max, step: 1 };
}

// SmartHarness works each message as a tree of small tasks on a model behind an OpenAI-compatible endpoint. Its plugin
// starts off, and while it is experimental its name says so.
export const smartharness_manifest: PluginManifest = {
  id: "codex.smartharness",
  name: "SmartHarness (experimental)",
  version: app_info.version,
  app: app_info.id,
  enabled_by_default: false,
  description:
    "Experimental. Answers through SmartHarness's task tree, which splits each message into small tasks with one narrow step per model call, so a small local model does better. It uses a model behind an OpenAI-compatible endpoint, such as a llama.cpp server or Ollama you already run, acts only through CODEX's tools under the action policy, and keeps nothing of its own. A reply takes many model calls.",
  settings: [
    {
      key: "endpoint",
      label: "Endpoint",
      hint: "The address the model's OpenAI-compatible API answers on, ending in /v1, such as a llama.cpp server or Ollama on this machine. Empty is OpenAI's own, which is hosted.",
      type: "text",
      default: "",
      placeholder: "http://localhost:8080/v1",
    },
    { key: "model", label: "Model", hint: "The model's name on that endpoint.", type: "text", default: "", placeholder: "qwen3-4b" },
    context_size(8192),
    whole("max_tokens", "Longest step", "The most tokens one step of the task tree may write; it must leave room for the step's input within the context size.", 2048, 256, 32_768),
    whole("max_task_depth", "Levels of subtasks", "How many levels of subtasks may sit under a message's own task; 0 works each message as one task.", 2, 0, 6),
    whole("max_task_nodes", "Most tasks", "The most tasks one reply may take, its own task included. Each takes three to six model calls.", 12, 1, 60),
    whole("max_tool_calls", "Tool calls a task", "The most calls to CODEX's tools one task may make.", 5, 1, 10),
    tool_set,
    key_command("pass show openai/api-key"),
  ],
};

export const engine_manifests = [anthropic_manifest, openai_manifest, smartharness_manifest];

// The id each bundled engine is provided under, which the engine setting names.
export const anthropic_engine_id = "anthropic";
export const openai_engine_id = "openai";
export const smartharness_engine_id = "smartharness";
