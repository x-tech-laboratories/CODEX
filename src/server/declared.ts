// Reads the declarations file this computer's configuration writes, such as /etc/codex/declared.json from the NixOS
// module, and the files its secrets are in, for the server and the desktop daemon. The file is read again when it
// changes; a secret is read each time it is needed, so a renewed token holds at once.

// ── Imports ──────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { watch_config, type ConfigWatch } from "@x-tech-laboratories/x-libs/config_watch";
import type { SqlDatabase } from "@x-tech-laboratories/x-libs/sql";

import { list_declared_server, use_declared } from "../shared/declared/current.ts";
import { no_declarations, read_declarations, type DeclaredConfig } from "../shared/declared/model.ts";
import { device_id_of } from "../shared/jobs/records.ts";
import { mcp_connector } from "../shared/mcp/connector.ts";

// ── Files ────────────────────────────────────────────────────────────────────

// Where the NixOS module writes the declarations; CODEX_DECLARED_FILE names another, and empty names none.
export const default_declared_file = "/etc/codex/declared.json";

const longest_secret = 16_384;

// The secret a file holds, its last line break dropped; the error names the file and why, never what it holds.
export function read_secret_from(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const why =
      code === "ENOENT" ? "it does not exist" : code === "EACCES" ? "CODEX may not read it" : code === "EISDIR" ? "it is a folder" : "it could not be read";
    throw new Error(`The secret file ${path} could not be read: ${why}.`);
  }
  const secret = text.trim();
  if (!secret) throw new Error(`The secret file ${path} is empty.`);
  if (secret.length > longest_secret) throw new Error(`The secret file ${path} holds more than a secret.`);
  return secret;
}

// The declarations in a file, with a problem in place of a file that cannot be read or is not JSON.
export function read_declared_file(path: string): DeclaredConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      ...no_declarations,
      problems: [`The configuration file ${path} could not be read.`],
    };
  }
  try {
    return read_declarations(JSON.parse(text));
  } catch {
    return {
      ...no_declarations,
      problems: [`The configuration file ${path} is not JSON.`],
    };
  }
}

// ── Keeping it current ───────────────────────────────────────────────────────

export interface DeclaredWatch {
  // Reads the file again, as a change does, and lists the declared MCP servers' tools.
  reload(): Promise<void>;
  stop(): void;
}

// Uses the declarations in the file, if there is one, watching it for changes; with no file nothing is declared.
export function keep_declared(path: string, database: () => SqlDatabase, on_change: () => void = () => {}): DeclaredWatch {
  let config: DeclaredConfig = no_declarations;
  let digest: string | null = null;
  use_declared({ declarations: () => config, read_secret: read_secret_from });
  const reload = async () => {
    if (!path || !existsSync(path)) {
      config = no_declarations;
      digest = null;
    } else {
      config = read_declared_file(path);
      digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
    for (const problem of config.problems) console.warn(`declared configuration: ${problem}`);
    const here = device_id_of(database());
    await Promise.all(config.mcp_servers.map((server) => list_declared_server(server, here, (record) => mcp_connector().list_tools(record))));
    on_change();
  };
  let watch: ConfigWatch | null = null;
  if (path)
    watch = watch_config({
      path,
      loaded_digest: () => digest,
      reload,
      on_error: (error) => console.warn("declared configuration:", error),
    });
  return {
    reload,
    stop: () => watch?.stop(),
  };
}

// The declarations file this process reads: CODEX_DECLARED_FILE when it is set, even empty, else the module's.
export function declared_file_of(variables: Record<string, string | undefined>, fallback = default_declared_file): string {
  return variables.CODEX_DECLARED_FILE ?? fallback;
}
