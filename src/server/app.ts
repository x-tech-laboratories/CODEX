// The web server: the page, every data call the page makes, and the sync every device runs against, all on one database.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

import fastify, { type FastifyInstance } from "fastify";
import { openapi_document } from "@x-tech-laboratories/x-libs/api_spec";
import { EventStream } from "@x-tech-laboratories/x-libs/server/events";
import { register_call_table } from "@x-tech-laboratories/x-libs/server/call_table";
import { register_mcp_route } from "@x-tech-laboratories/x-libs/server/mcp";
import { register_error_replies, register_lenient_json_body } from "@x-tech-laboratories/x-libs/server/replies";
import { calls_under, register_accounts } from "@x-tech-laboratories/x-libs/server/account_sign_in";
import { AccountStore } from "@x-tech-laboratories/x-libs/server/account_store";
import type { Accounts } from "@x-tech-laboratories/x-libs/server/passwords";
import type { BackupMethods } from "@x-tech-laboratories/x-libs/backup_protocol";
import { register_sync_routes } from "@x-tech-laboratories/x-libs/server/sync_routes";
import { register_web_folder } from "@x-tech-laboratories/x-libs/server/web_folder";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { context_bridge } from "../shared/bridge.ts";
import { mcp_instructions as instructions } from "../shared/mcp.ts";
import { stop_all_runs } from "../shared/conversations/run.ts";
import { conversation_event, page_only_refusal, user_only_backup_calls, user_only_settings } from "../shared/page_api.ts";
import { bind_methods, context_api, is_read_only, page_only, start_assistant, sync_engine } from "../shared/store.ts";
import { register_context_calls } from "./calls.ts";

// ── Options ──────────────────────────────────────────────────────────────────

export interface AppOptions {
  database: SqlDatabase;
  // The users from the accounts file, who are admins; others are added on the Users page.
  declared: Accounts;
  web_folder: string;
  // The database's backups, which an admin manages from the page; one is taken before a device's data replaces it.
  backups: BackupMethods;
}

// ── Other programs ───────────────────────────────────────────────────────────

const version = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

// ── App ──────────────────────────────────────────────────────────────────────

export async function build_app(options: AppOptions): Promise<FastifyInstance> {
  const app = fastify({ forceCloseConnections: true });
  register_lenient_json_body(app);
  register_error_replies(app);
  const accounts = new AccountStore({ database: options.database, app_name: "CODEX", declared: options.declared, token_prefix: "cx" });
  // Backups reach the whole database, the accounts included, so only an admin may manage them. A token, a device's
  // included, is refused the calls only the user at the page may make; a browser signed in with a password, itself or
  // through a trusted proxy, is the user at the page.
  await register_accounts(app, {
    accounts,
    cookie_name: "codex_session",
    read_only_paths: ["/api/mcp"],
    needed: (_method, path) => (path.startsWith("/api/backup/") ? { role: accounts.top_role } : "any"),
    call_of: calls_under("/api/call"),
    // A read-only token may make the calls that only read, such as the item calls other apps use.
    is_read_only,
    page_only,
  });

  const changes = new EventStream();
  const database = () => options.database;
  // A reply streams to every page as it is written; a change it makes is announced to every page, since no page made it.
  start_assistant({ database, announce: () => changes.announce_change(), emit: (event) => changes.send(JSON.stringify(event), { event: conversation_event }) });
  app.addHook("onClose", async () => stop_all_runs());

  await app.register(
    async (api) => {
      changes.register(api, "/events");

      register_context_calls(api, database, changes);

      api.get("/openapi.json", async () =>
        openapi_document(context_api, { title: "CODEX", version, description: instructions, path_of: (method) => `/api/call/${method}`, is_read_only }),
      );

      // A change made through MCP is announced to every page, since no page made it; the page-only calls are not offered.
      await register_mcp_route(api, {
        name: "codex",
        version,
        instructions,
        api: context_api,
        is_read_only,
        page_only,
        call: async (method, args) => {
          const methods = bind_methods(database, () => changes.announce_change(), "program");
          return context_bridge.dispatch(methods, method, args);
        },
      });

      // Backup calls arrive as POST /api/backup/<method> with the arguments as a JSON list. Restoring, deleting and the
      // schedule answer only a browser signed in with a password, itself or through the trusted proxy: every token, a
      // device's included, is refused them, as a restored backup could rewrite what only the user may change.
      await api.register(async (backups) => {
        // By the route's own decoded name, so no spelling of the address gets past it.
        backups.addHook("preHandler", async (request, reply) => {
          const method = (request.params as { method?: string }).method ?? "";
          if (user_only_backup_calls.has(method) && request.viewer?.via !== "session" && request.viewer?.via !== "proxy") await reply.code(403).type("text/plain").send(page_only_refusal);
        });
        register_call_table(backups, "/backup", options.backups, { is_read_only });
      });
      register_sync_routes(api, {
        engine: sync_engine,
        database,
        back_up: async () => void (await options.backups.create_backup()),
        on_change: (request) => changes.announce_change(changes.client_id_of(request)),
        // A setting only the user may change syncs only from the user's own devices, never from a program's token.
        device_only: (change) => change.table === "settings" && user_only_settings.has(change.key),
      });
    },
    { prefix: "/api" },
  );

  await register_web_folder(app, { folder: options.web_folder });
  return app;
}
