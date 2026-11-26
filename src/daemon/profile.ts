// Which profile the desktop app opens and which socket its window and daemon share, from the variables a dev or test
// run sets, so the window and the daemon always agree.

// ── Imports ──────────────────────────────────────────────────────────────────

import { resolve } from "node:path";

import { daemon_socket_path } from "@x-tech-laboratories/x-libs/local_daemon";

// ── Profile ──────────────────────────────────────────────────────────────────

export interface ProfileVariables {
  CODEX_USER_DATA?: string;
  CODEX_SOCKET?: string;
}

// The profile folder a run asked for, an absolute path as given and a relative one from the working directory; null for the installed app's own.
export function chosen_profile(variables: ProfileVariables, working_directory: string): string | null {
  const given = variables.CODEX_USER_DATA;
  return given ? resolve(working_directory, given) : null;
}

// The daemon's socket: CODEX_SOCKET when set, else the installed app's own, else one for this database alone.
export function socket_of(variables: ProfileVariables, database_path: string, own_profile: boolean): string {
  return variables.CODEX_SOCKET || daemon_socket_path({ app: "codex", data_file: own_profile ? null : database_path });
}
