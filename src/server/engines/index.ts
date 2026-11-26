// The bundled engine plugins, Anthropic and any OpenAI-compatible endpoint, both on the one direct loop. They need
// Node for their SDKs and for the key command, so they run where the store does: the server or the desktop daemon.

// ── Imports ──────────────────────────────────────────────────────────────────

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPlugin, ContextPluginApi } from "../../shared/collectors/host.ts";
import { direct_defaults, run_direct, type ChatModel } from "../../shared/engines/direct.ts";
import type { Engine, EngineEvent, EngineRequest, ToolSet } from "../../shared/engines/engine.ts";
import { is_local_endpoint } from "../../shared/engines/hosting.ts";
import { anthropic_engine_id, anthropic_manifest, openai_engine_id, openai_manifest } from "../../shared/engines/manifests.ts";
import { AnthropicModel } from "./anthropic.ts";
import { explain_failure, key_command_failure } from "./errors.ts";
import { OpenAiModel } from "./openai.ts";
import { key_from, read_secret, type SecretReader } from "./secret_command.ts";

// ── Engines ──────────────────────────────────────────────────────────────────

// How each engine reaches its model, given the plugin's settings and the key its command printed.
export type ModelMaker = (settings: SettingValues, api_key: string) => ChatModel;

export const make_anthropic: ModelMaker = (settings, api_key) => new AnthropicModel({ model: String(settings.model ?? ""), api_key });

export const make_openai: ModelMaker = (settings, api_key) => new OpenAiModel({ endpoint: String(settings.endpoint ?? "").trim(), model: String(settings.model ?? ""), api_key });

// Anthropic is always hosted; an OpenAI-compatible endpoint is local when its host is loopback or a private address.
export const anthropic_is_local = (): boolean => false;

export const openai_is_local = (settings: SettingValues): boolean => is_local_endpoint(String(settings.endpoint ?? ""));

// Where each engine's endpoint is when its settings name none.
export const default_endpoints: Record<string, string> = { Anthropic: "https://api.anthropic.com", "OpenAI-compatible": "https://api.openai.com/v1" };

function tool_set_of(value: unknown): ToolSet {
  return value === "core" || value === "all" ? value : "auto";
}

// An error event with every copy of the key taken out, should a provider quote it back.
function without_key(event: EngineEvent, api_key: string): EngineEvent {
  if (event.type !== "error" || api_key.length < 4) return event;
  const hide = (text: string) => text.split(api_key).join("[hidden]");
  return { ...event, message: hide(event.message), ...(event.detail === undefined ? {} : { detail: hide(event.detail) }) };
}

// An engine on the direct loop whose key is read afresh for each run and dropped with it.
export function direct_engine(label: string, settings: () => SettingValues, make: ModelMaker, read: SecretReader = read_secret, is_local: (settings: SettingValues) => boolean = () => false): Engine {
  const model = () => String(settings().model ?? "").trim();
  return {
    label,
    model,
    is_local: () => is_local(settings()),
    async *run(request: EngineRequest, signal: AbortSignal): AsyncGenerator<EngineEvent> {
      const values = settings();
      if (!model()) {
        yield { type: "error", message: `Set the ${label} engine's model under Settings → Assistant → Engine.` };
        return;
      }
      let api_key: string;
      try {
        api_key = await key_from(String(values.api_key_command ?? ""), read);
      } catch (error) {
        yield { type: "error", ...key_command_failure(error) };
        return;
      }
      const context_size = Number(values.context_size) || direct_defaults.context_size;
      const endpoint = String(values.endpoint ?? "").trim();
      const where = { endpoint, default_endpoint: default_endpoints[label] ?? "", model: model() };
      const options = {
        ...direct_defaults,
        context_size,
        tool_set: tool_set_of(values.tool_set),
        calibration_key: `${label}\n${endpoint}\n${model()}`,
        explain: (error: unknown) => explain_failure(error, where),
      };
      for await (const event of run_direct(make(values, api_key), request, signal, options)) yield without_key(event, api_key);
    },
  };
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export function anthropic_plugin(make: ModelMaker = make_anthropic, read?: SecretReader): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...anthropic_manifest,
    start: (context) => context.provide("engine", anthropic_engine_id, direct_engine("Anthropic", () => context.settings(), make, read, anthropic_is_local)),
  });
}

export function openai_plugin(make: ModelMaker = make_openai, read?: SecretReader): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...openai_manifest,
    start: (context) => context.provide("engine", openai_engine_id, direct_engine("OpenAI-compatible", () => context.settings(), make, read, openai_is_local)),
  });
}

export const engine_plugins: ContextPlugin[] = [anthropic_plugin(), openai_plugin()];
