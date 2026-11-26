// A store with the assistant started on a throwaway database and a scripted engine, for the conversation and policy tests.

import { DatabaseSync } from "node:sqlite";

import { define_plugin } from "@x-tech-laboratories/x-libs/plugins";

import { network_plugins } from "../src/shared/collectors/bundled.ts";
import { use_plugins, type ContextPluginApi } from "../src/shared/collectors/host.ts";
import type { ConversationEvent } from "../src/shared/conversations/model.ts";
import type { EngineEvent, EngineRequest } from "../src/shared/engines/engine.ts";
import { bind_methods, open_store, start_assistant, type ContextMethods } from "../src/shared/store.ts";

// What the scripted engine does with each request: yields events, calling tools as it likes.
export type Script = (request: EngineRequest, signal: AbortSignal) => AsyncGenerator<EngineEvent>;

export interface Fixture {
  database: DatabaseSync;
  calls: ContextMethods;
  events: ConversationEvent[];
  requests: EngineRequest[];
  announced: () => number;
  set_script: (script: Script) => void;
}

// A scripted engine plugin, provided as "fake", answering with whatever the test's script yields.
export function start_fixture(options: { choose_engine?: boolean; on_event?: (event: ConversationEvent) => void; on_announce?: () => void } = {}): Fixture {
  const database = new DatabaseSync(":memory:");
  open_store(database);
  const events: ConversationEvent[] = [];
  const requests: EngineRequest[] = [];
  let announcements = 0;
  let script: Script = async function* () {
    yield { type: "done", text: "Hello." };
  };
  const fake = define_plugin<ContextPluginApi>({
    id: "tests.fake-engine",
    name: "Fake engine",
    version: "1.0.0",
    start: (context) =>
      context.provide("engine", "fake", {
        label: "Fake",
        model: () => "fake-model",
        run: (request, signal) => {
          requests.push(request);
          return script(request, signal);
        },
      }),
  });
  use_plugins([...network_plugins, fake]);
  const announce = () => {
    announcements += 1;
    options.on_announce?.();
  };
  start_assistant({ database: () => database, announce, emit: (event) => (events.push(event), options.on_event?.(event)) });
  const calls = bind_methods(() => database, announce);
  if (options.choose_engine !== false) calls.set_setting("engine", "fake");
  return { database, calls, events, requests, announced: () => announcements, set_script: (next) => (script = next) };
}
