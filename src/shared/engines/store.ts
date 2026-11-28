// Choosing an engine's model from a list: the models its endpoint offers, asked where the store runs with the engine's
// own key, and the owner's choice, kept in the engine's settings, or on this device alone for an engine this
// computer's configuration declares, whose declared model is then only the default.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { id_of, text } from "../api_schemas.ts";
import { open_plugin_host } from "../collectors/host.ts";
import { declared_plugin } from "../declared/current.ts";
import { define_feature } from "../feature.ts";
import { set_chosen_model } from "./choices.ts";
import type { EndpointModel } from "./engine.ts";
import { engine_manifests } from "./manifests.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface EngineModels {
  plugin_id: string;
  // The model the engine answers with now.
  model: string;
  // The model this computer's configuration declares, which a choice holds over; empty when it declares none.
  declared_model: string;
  models: EndpointModel[];
  // Why there is no list, in plain words; empty when there is one.
  problem: string;
}

// The longest model name taken.
export const longest_model = 200;

// ── Calls ────────────────────────────────────────────────────────────────────

function engine_plugin(plugin_id: string): void {
  if (!engine_manifests.some((manifest) => manifest.id === plugin_id)) throw new Error(`There is no engine plugin ${plugin_id}; the engines are ${engine_manifests.map((manifest) => manifest.id).join(", ")}.`);
}

function declared_model_of(plugin_id: string): string {
  const model = declared_plugin(plugin_id)?.settings.model;
  return typeof model === "string" ? model.trim() : "";
}

async function list_engine_models(database: SqlDatabase, plugin_id: string): Promise<EngineModels> {
  engine_plugin(plugin_id);
  const declared_model = declared_model_of(plugin_id);
  const engine = (await open_plugin_host(database)).providers("engine").find((each) => each.plugin_id === plugin_id)?.value;
  if (!engine) return { plugin_id, model: "", declared_model, models: [], problem: "The engine is off; turn it on under Settings → Assistant → Engine." };
  const model = engine.model();
  if (!engine.list_models) return { plugin_id, model, declared_model, models: [], problem: "This engine does not list its models; type the model's name." };
  const listing = await engine.list_models(new AbortController().signal);
  return { plugin_id, model, declared_model, ...listing };
}

// An engine this computer's configuration declares keeps the choice on this device, and an empty one goes back to the
// declared model; any other engine keeps it in its synced settings.
async function set_engine_model(database: SqlDatabase, plugin_id: string, model: string): Promise<void> {
  engine_plugin(plugin_id);
  const name = model.trim();
  if (name.length > longest_model || /[\r\n]/.test(name)) throw new Error(`A model's name is one line of at most ${longest_model} characters.`);
  if (declared_plugin(plugin_id)) {
    set_chosen_model(database, plugin_id, name === declared_model_of(plugin_id) ? "" : name);
    return;
  }
  await (await open_plugin_host(database)).set_settings(plugin_id, { model: name });
}

// ── Feature ──────────────────────────────────────────────────────────────────

const plugin_param = { name: "plugin_id", schema: { ...id_of("engine plugin"), description: "The engine plugin's id: codex.anthropic, codex.openai or codex.smartharness." } };

export const engines_feature = define_feature({
  id: "engines",
  migrations: [],
  tables: [],
  methods: { list_engine_models, set_engine_model },
  api: {
    list_engine_models: {
      description:
        "Lists the models an engine's endpoint offers, asked from where CODEX's data is with the engine's own key, which is never shown: each model's name and, for a llama.cpp router, whether it is loaded, loading or unloaded. It also gives the model the engine answers with now and the one this computer's configuration declares. When the endpoint cannot be asked or lists nothing, the list is empty and problem says why.",
      params: [plugin_param],
    },
    set_engine_model: {
      page_only: true,
      description:
        "Chooses the model an engine answers with from the next reply on. For an engine this computer's configuration declares, the choice is kept on this device alone and holds over the declared model; an empty name, or the declared one, goes back to it. Only the user at CODEX's own page can call this; tokens and MCP clients are refused.",
      params: [plugin_param, { name: "model", schema: text("The model's name on the engine's endpoint, as list_engine_models gives it, or any name it takes.") }],
    },
  },
});
