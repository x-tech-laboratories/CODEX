// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Client } from "@x-tech-laboratories/x-libs/electron/bridge";

import type { ContextMethods } from "../src/shared/store.ts";
import { calls, data_watch, set_page_api } from "../src/web/api.ts";
import { web_api } from "../src/web/hosts/web.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stands in for the browser's EventSource, which jsdom lacks; it never connects.
class QuietEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  addEventListener(): void {}
}

describe("the page's calls", () => {
  it("reach a host whose calls are a proxy with no list of names, and a write bumps the watch", async () => {
    const made: string[] = [];
    const host_calls = new Proxy({} as Client<ContextMethods>, {
      get: (_target, name) => async () => {
        made.push(String(name));
        return name === "get_settings" ? { refresh_minutes: 30 } : undefined;
      },
    });
    set_page_api({ host: "web", calls: host_calls, device: null, on_change: () => () => undefined, on_conversation: () => () => undefined });

    const before = data_watch.version();
    expect(await calls().get_settings()).toEqual({ refresh_minutes: 30 });
    expect(data_watch.version()).toBe(before);
    await calls().set_setting("refresh_minutes", 5);
    expect(data_watch.version()).toBe(before + 1);
    expect(made).toEqual(["get_settings", "set_setting"]);
  });

  it("go from the browser to the server by name with the arguments as a list", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ refresh_minutes: 5 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("EventSource", QuietEventSource);
    set_page_api(web_api());

    expect(await calls().get_settings()).toEqual({ refresh_minutes: 5 });
    expect(fetch).toHaveBeenCalledWith("api/call/get_settings", expect.objectContaining({ method: "POST", body: "[]" }));
  });

  it("hear a reply's progress on the server's event stream", () => {
    const sources: ListeningEventSource[] = [];
    class ListeningEventSource {
      static readonly CLOSED = 2;
      readyState = 0;
      readonly listeners = new Map<string, (event: { data: string }) => void>();
      constructor() {
        sources.push(this);
      }
      addEventListener(name: string, listener: (event: { data: string }) => void): void {
        this.listeners.set(name, listener);
      }
    }
    vi.stubGlobal("EventSource", ListeningEventSource);
    const api = web_api();
    const heard: unknown[] = [];
    const stop = api.on_conversation((event) => heard.push(event));
    const event = { conversation_id: "general", run_id: "r1", type: "text", text: "Hel" };

    sources[0]!.listeners.get("conversation")!({ data: JSON.stringify(event) });
    stop();
    sources[0]!.listeners.get("conversation")!({ data: JSON.stringify(event) });

    expect(heard).toEqual([event]);
  });
});
