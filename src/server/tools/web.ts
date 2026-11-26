// The bundled Web tool plugin: web_fetch reads a public web page as text, and web_search asks a SearXNG instance the
// user names. Both read only and send what they are given outside this computer. They need Node for the connection
// guard, so they run where the store does: the server or the desktop daemon.

// ── Imports ──────────────────────────────────────────────────────────────────

import { request as http_request, type IncomingMessage } from "node:http";
import { request as https_request } from "node:https";

import { define_plugin, type SettingValues } from "@x-tech-laboratories/x-libs/plugins";

import type { ContextPlugin, ContextPluginApi } from "../../shared/collectors/host.ts";
import { html_to_text } from "../../shared/tools/html_text.ts";
import { web_manifest, web_tools_id } from "../../shared/tools/manifests.ts";
import type { PluginTool, ToolPlugin } from "../../shared/tools/tool.ts";
import { checked_web_address, guarded_lookup, ports_of, public_addresses, type GuardOptions } from "./address_guard.ts";

// ── Limits ───────────────────────────────────────────────────────────────────

export interface WebOptions extends Pick<GuardOptions, "resolve" | "allow_address"> {
  // How long one page or search may take, in all.
  timeout_ms?: number;
  // The most of a page's body read.
  max_bytes?: number;
  // The most of its text given back.
  max_chars?: number;
}

export const web_defaults = { timeout_ms: 15_000, max_bytes: 2_000_000, max_chars: 10_000, max_redirects: 5, max_results: 8 };

const user_agent = "CODEX web reader";

const readable_types = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown"]);

// ── Reading ──────────────────────────────────────────────────────────────────

function after(ms: number, signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

// A failure in plain words: stopped by the run, out of time, or what went wrong.
function plain_failure(error: unknown, what: string, timeout_ms: number, signal: AbortSignal, within: AbortSignal): Error {
  if (signal.aborted) return new Error("Stopped.");
  if (within.aborted) return new Error(`${what} did not answer within ${timeout_ms / 1000} seconds.`);
  return error instanceof Error ? error : new Error(String(error));
}

// One GET over a connection that reaches only the addresses the guard let through.
function get(url: URL, guard: GuardOptions, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? https_request : http_request;
  return new Promise((resolve, reject) => {
    const sent = request(url, { method: "GET", agent: false, lookup: guarded_lookup(guard), signal, headers: { "User-Agent": user_agent, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1", "Accept-Encoding": "identity" } }, resolve);
    sent.on("error", reject);
    sent.end();
  });
}

// The body up to the limit, and whether there was more.
async function read_at_most(response: AsyncIterable<Uint8Array> & { destroy?: () => void }, limit: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > limit) break;
  }
  response.destroy?.();
  const bytes = Buffer.concat(chunks);
  return { bytes: bytes.subarray(0, limit), cut: bytes.length > limit };
}

function decoded(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// A public web page's title and readable text, following at most five redirects, each checked again.
export async function fetch_page(url: string, settings: SettingValues, signal: AbortSignal, options: WebOptions = {}): Promise<string> {
  const timeout_ms = options.timeout_ms ?? web_defaults.timeout_ms;
  const guard: GuardOptions = { allowed_ports: ports_of(settings.allowed_ports), ...(options.resolve ? { resolve: options.resolve } : {}), ...(options.allow_address ? { allow_address: options.allow_address } : {}) };
  const within = after(timeout_ms, signal);
  try {
    let address = checked_web_address(url, guard);
    let response: IncomingMessage;
    for (let redirects = 0; ; redirects += 1) {
      await public_addresses(address.hostname, guard);
      response = await get(address, guard, within);
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0) || !location) break;
      response.destroy();
      if (redirects >= web_defaults.max_redirects) throw new Error(`The page redirected more than ${web_defaults.max_redirects} times.`);
      address = checked_web_address(new URL(location, address).href, guard);
    }
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new Error(`The page answered HTTP ${status}${response.statusMessage ? ` ${response.statusMessage}` : ""}.`);
    }
    const [media, ...parameters] = String(response.headers["content-type"] ?? "text/plain").split(";");
    const type = media!.trim().toLowerCase() || "text/plain";
    if (!readable_types.has(type)) {
      response.destroy();
      throw new Error(`The page is ${type}, which web_fetch does not read; it reads web pages and plain text.`);
    }
    const charset = parameters.map((each) => each.trim()).find((each) => each.toLowerCase().startsWith("charset="));
    const body = await read_at_most(response, options.max_bytes ?? web_defaults.max_bytes);
    const content = decoded(body.bytes, charset ? charset.slice(8).replace(/^["']|["']$/g, "").toLowerCase() : "utf-8");
    const page = type === "text/html" || type === "application/xhtml+xml" ? html_to_text(content, address.href) : { title: "", text: content.trim() };
    const max_chars = options.max_chars ?? web_defaults.max_chars;
    const cut = body.cut || page.text.length > max_chars;
    const lines = [`Address: ${address.href}`, `Title: ${page.title || "(none)"}`, "", page.text.slice(0, max_chars) || "(The page has no readable text.)"];
    if (cut) lines.push("[Cut short: the page goes on.]");
    return lines.join("\n");
  } catch (error) {
    throw plain_failure(error, "The page", timeout_ms, signal, within);
  }
}

// ── Searching ────────────────────────────────────────────────────────────────

interface SearchResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

// Where a SearXNG instance answers a search: its /search, asked for JSON.
export function search_address(endpoint: string, query: string): URL {
  let base: URL;
  try {
    base = new URL(endpoint.trim());
  } catch {
    throw new Error("The search endpoint in the Web plugin's settings is not a whole address; give it as https://searx.example.org.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("The search endpoint must be an http or https address.");
  const address = new URL(base.pathname.replace(/\/+$/, "").endsWith("/search") ? base.href : `${base.href.replace(/\/+$/, "")}/search`);
  address.search = "";
  address.searchParams.set("q", query);
  address.searchParams.set("format", "json");
  return address;
}

// The best results' titles, addresses and snippets from the user's SearXNG instance.
export async function search_web(endpoint: string, query: string, signal: AbortSignal, options: WebOptions = {}): Promise<string> {
  const timeout_ms = options.timeout_ms ?? web_defaults.timeout_ms;
  const address = search_address(endpoint, query);
  const within = after(timeout_ms, signal);
  try {
    const response = await fetch(address, { signal: within, redirect: "error", headers: { Accept: "application/json", "User-Agent": user_agent } });
    if (!response.ok) throw new Error(`The search endpoint answered HTTP ${response.status}${response.status === 403 ? "; turn on SearXNG's JSON format (search: formats: json in its settings.yml)" : ""}.`);
    const body = await read_at_most(response.body ?? (async function* () {})(), options.max_bytes ?? web_defaults.max_bytes);
    let answer: { results?: unknown };
    try {
      answer = JSON.parse(new TextDecoder().decode(body.bytes)) as { results?: unknown };
    } catch {
      throw new Error("The search endpoint did not answer with JSON; is it a SearXNG instance with its JSON format turned on?");
    }
    const results = (Array.isArray(answer.results) ? (answer.results as SearchResult[]) : []).filter((each) => typeof each?.url === "string").slice(0, web_defaults.max_results);
    if (results.length === 0) return `No results for “${query}”.`;
    const flat = (value: unknown, most: number) => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      return text.length > most ? `${text.slice(0, most - 1)}…` : text;
    };
    return [`Results for “${query}”:`, ...results.map((each, index) => [`${index + 1}. ${flat(each.title, 200) || "(no title)"}`, `   ${String(each.url)}`, ...(each.content ? [`   ${flat(each.content, 400)}`] : [])].join("\n"))].join("\n");
  } catch (error) {
    throw plain_failure(error, "The search endpoint", timeout_ms, signal, within);
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

const fetch_tool: PluginTool = {
  name: "web_fetch",
  description:
    "Reads a public web page and gives back its title, then its readable text, links kept as plain text with their addresses after them. Only public http and https addresses are read. Never put personal details from the user's items into the address.",
  parameters: { type: "object", properties: { url: { type: "string", description: "The page's whole address, starting with http:// or https://." } }, required: ["url"], additionalProperties: false },
  changes: false,
  sends_outside: true,
};

const search_tool: PluginTool = {
  name: "web_search",
  description: "Searches the web and gives back the best results' titles, addresses and snippets; read a result whole with web_fetch. Never put personal details from the user's items into the query.",
  parameters: { type: "object", properties: { query: { type: "string", description: "What to search for, in a few words." } }, required: ["query"], additionalProperties: false },
  changes: false,
  sends_outside: true,
};

// The two tools on the plugin's settings now: web_search only once a search endpoint is set.
export function web_tools(settings: () => SettingValues, options: WebOptions = {}): ToolPlugin {
  const endpoint = () => String(settings().search_endpoint ?? "").trim();
  return {
    label: "Web",
    own_words: true,
    tools: () => (endpoint() ? [fetch_tool, search_tool] : [fetch_tool]),
    async call(name, args, signal) {
      if (name === "web_fetch") {
        if (typeof args.url !== "string" || !args.url.trim()) throw new Error("Give the page's address as url.");
        return fetch_page(args.url, settings(), signal, options);
      }
      if (name === "web_search") {
        if (!endpoint()) throw new Error("No search endpoint is set in the Web plugin's settings.");
        if (typeof args.query !== "string" || !args.query.trim()) throw new Error("Give what to search for as query.");
        return search_web(endpoint(), args.query.trim(), signal, options);
      }
      throw new Error(`The Web plugin has no tool named ${name}.`);
    },
  };
}

export function web_plugin(options: WebOptions = {}): ContextPlugin {
  return define_plugin<ContextPluginApi>({
    ...web_manifest,
    start: (context) => context.provide("tools", web_tools_id, web_tools(() => context.settings(), options)),
  });
}

export const tool_plugins: ContextPlugin[] = [web_plugin()];
