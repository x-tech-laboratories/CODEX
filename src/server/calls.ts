// The page's data calls on the database, as the web server and the desktop daemon both answer them, taking the
// arguments in order or by name and telling the other pages when a call changed something.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { FastifyInstance, FastifyRequest } from "fastify";
import { positional_args } from "@x-tech-laboratories/x-libs/api_spec";
import type { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { send_text } from "@x-tech-laboratories/x-libs/server/replies";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_bridge } from "../shared/bridge.ts";
import { page_only_refusal } from "../shared/page_api.ts";
import { bind_methods, context_api, is_page_only, is_page_only_call, is_read_only, type ContextMethods } from "../shared/store.ts";

// ── Data calls ───────────────────────────────────────────────────────────────

// An import, such as a Liftosaur file, arrives as one call's argument.
const import_body_limit = 32 * 1024 * 1024;

// Calls arrive as POST <prefix>/call/<method> with the arguments as a JSON list, or by name as a JSON object. A call
// only the user at the page may make, or a write to a setting only the user may change, is refused unless is_page
// says the request came from it.
export function register_context_calls(api: FastifyInstance, database: () => SqlDatabase, changes: EventStream, is_page: (request: FastifyRequest) => boolean): void {
  api.post<{ Params: { method: string } }>("/call/:method", { bodyLimit: import_body_limit }, async (request, reply) => {
    if (is_page_only(request.params.method) && !is_page(request)) return send_text(reply, 403, page_only_refusal);
    const body: unknown = request.body ?? [];
    const spec = context_api[request.params.method as keyof ContextMethods];
    let args: unknown[];
    if (Array.isArray(body)) args = body;
    else if (spec && typeof body === "object" && body !== null) {
      try {
        args = positional_args(spec, body as Record<string, unknown>);
      } catch (error) {
        return send_text(reply, 400, (error as Error).message);
      }
    } else return send_text(reply, 400, "send the arguments as a JSON list or object");
    // A write to a setting that keeps the user in charge is refused to a program as well.
    if (is_page_only_call(request.params.method, args) && !is_page(request)) return send_text(reply, 403, page_only_refusal);
    const methods = bind_methods(database, () => changes.announce_change(changes.client_id_of(request)));
    const result = await context_bridge.dispatch(methods, request.params.method, args);
    if (result === undefined) return reply.code(204).send();
    if (is_read_only(request.params.method)) reply.header("cache-control", "no-store");
    // Fastify would send a string as bare text, which the caller could not tell from JSON.
    return reply.type("application/json").send(JSON.stringify(result));
  });
}
