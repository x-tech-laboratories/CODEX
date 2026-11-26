// The failures a user meets when an engine cannot answer, put in plain words that say what happened and what to do,
// with the raw detail kept for a Details disclosure. No message names a key, and the endpoint is named by host and port.

// ── Imports ──────────────────────────────────────────────────────────────────

import { ContextOverflow, type PlainError } from "../../shared/engines/direct.ts";

// ── Where ────────────────────────────────────────────────────────────────────

export interface EngineWhere {
  // The engine's endpoint, empty for the provider's own.
  endpoint: string;
  // The provider's own address, used when the endpoint is empty.
  default_endpoint: string;
  model: string;
}

// The endpoint's host and port, never its path, user or password.
export function host_of(endpoint: string, default_endpoint: string): string {
  try {
    const url = new URL(endpoint.trim() || default_endpoint);
    const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
    return port ? `${url.hostname}:${port}` : url.hostname;
  } catch {
    return "the address in its settings";
  }
}

// ── Raw detail ───────────────────────────────────────────────────────────────

// Anything shaped like an API key, which some providers quote back in part, is hidden.
export function hide_keys(text: string): string {
  return text.replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9*_.-]{5,}[A-Za-z0-9*_-]/gi, "[hidden]");
}

function status_of(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function message_of(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codes_of(error: unknown): string[] {
  const codes: string[] = [];
  for (let at: unknown = error, depth = 0; at && typeof at === "object" && depth < 5; at = (at as { cause?: unknown }).cause, depth += 1) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
  }
  return codes;
}

// ── Size ─────────────────────────────────────────────────────────────────────

const overflow_words = /context (?:length|size|window)|exceeds the available context|prompt is too long|too many tokens|maximum context|context_length_exceeded|input is too long/i;

// The engine refused a request as larger than its context, with the size it counted when it said; null for another failure.
export function overflow_of(error: unknown): ContextOverflow | null {
  if (error instanceof ContextOverflow) return error;
  const status = status_of(error);
  const message = message_of(error);
  if (status !== 413 && !(status === 400 && overflow_words.test(message))) return null;
  const counted = /request \((\d+) tokens\)|resulted in (\d+) tokens|too long: (\d+) tokens|prompt has (\d+) tokens/i.exec(message);
  const tokens = counted ? Number(counted.slice(1).find(Boolean)) : null;
  return new ContextOverflow(hide_keys(message), tokens);
}

// ── Explaining ───────────────────────────────────────────────────────────────

const connection_codes = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

// The SDKs' error classes keep the name "Error", so their class is told by its constructor too.
function is_named(error: unknown, name: string): boolean {
  const given = error as { name?: unknown; constructor?: { name?: unknown } } | null;
  return given?.name === name || given?.constructor?.name === name;
}

function is_timeout(error: unknown): boolean {
  return is_named(error, "APIConnectionTimeoutError") || codes_of(error).includes("ETIMEDOUT") || /^Request timed out\.?$/i.test(message_of(error));
}

function is_unreachable(error: unknown): boolean {
  return is_named(error, "APIConnectionError") || codes_of(error).some((code) => connection_codes.has(code)) || /^(Connection error\.|fetch failed)$/i.test(message_of(error));
}

// A failure reaching or asking the engine in plain words, with the raw text as its detail.
export function explain_failure(error: unknown, where: EngineWhere): PlainError {
  const host = host_of(where.endpoint, where.default_endpoint);
  const settings = "Settings → Assistant → Engine";
  const status = status_of(error);
  const raw = hide_keys(message_of(error));
  const codes = codes_of(error).filter((code) => !raw.includes(code));
  const detail = codes.length > 0 ? `${raw} (${codes.join(", ")})` : raw;
  const plain = (message: string): PlainError => ({ message, detail });
  // A refusal is already said in plain words by the model's own adapter.
  if (is_named(error, "ModelRefused")) return { message: raw };
  if (is_timeout(error)) return plain(`The engine at ${host} did not answer in time. Check that its server is running and not overloaded, then send again.`);
  if (status === null && is_unreachable(error)) return plain(`The engine at ${host} cannot be reached. Check that its server is running and that the endpoint under ${settings} is right.`);
  if (overflow_of(error)) return plain("The request was too large for the model's context. Raise the engine's context size under Settings → Assistant → Engine (and on the model's server), or start a new conversation.");
  if (status === 401 || status === 403) return plain(`The engine at ${host} refused the API key. Check the API key command under ${settings}.`);
  if (status === 404 && /model/i.test(raw)) return plain(`The engine at ${host} does not know the model “${where.model}”. Check the model's name under ${settings}.`);
  if (status === 404) return plain(`The engine at ${host} has no chat completions at that address. Check the endpoint under ${settings}; it usually ends in /v1.`);
  if (status === 429) return plain(`The engine at ${host} is limiting how often it is asked. Wait a minute and send again, or check the account's quota.`);
  return plain(`The engine at ${host} could not answer.`);
}

// A key command that failed, said without anything it printed.
export function key_command_failure(error: unknown): PlainError {
  return { message: "The API key command failed, so no key could be read. Run it in a terminal to see why, then send again.", detail: message_of(error) };
}
