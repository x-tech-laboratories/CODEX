import { describe, expect, it } from "vitest";

import { daemon_socket_path } from "@x-tech-laboratories/x-libs/local_daemon";

import { chosen_profile, socket_of } from "../../src/daemon/profile.ts";

describe("the desktop profile", () => {
  it("takes an absolute CODEX_USER_DATA as given and a relative one from the working directory", () => {
    expect(chosen_profile({ CODEX_USER_DATA: "/scratch/codex-profile" }, "/home/someone/CODEX")).toBe("/scratch/codex-profile");
    expect(chosen_profile({ CODEX_USER_DATA: "dev-data/desktop" }, "/home/someone/CODEX")).toBe("/home/someone/CODEX/dev-data/desktop");
    expect(chosen_profile({ CODEX_USER_DATA: "../other/" }, "/home/someone/CODEX")).toBe("/home/someone/other");
  });

  it("opens the installed app's own profile when none is asked for", () => {
    expect(chosen_profile({}, "/anywhere")).toBeNull();
    expect(chosen_profile({ CODEX_USER_DATA: "" }, "/anywhere")).toBeNull();
  });
});

describe("the daemon's socket", () => {
  it("is CODEX_SOCKET when set, for the window and the daemon alike", () => {
    const variables = { CODEX_SOCKET: "/scratch/codex.sock" };

    expect(socket_of(variables, "/scratch/profile/codex.db", false)).toBe("/scratch/codex.sock");
    expect(socket_of(variables, "/home/someone/.config/codex/codex.db", true)).toBe("/scratch/codex.sock");
  });

  it("is otherwise the installed app's own, or one for another profile's database alone", () => {
    expect(socket_of({}, "/home/someone/.config/codex/codex.db", true)).toBe(daemon_socket_path({ app: "codex", data_file: null }));
    const other = socket_of({ CODEX_SOCKET: "" }, "/scratch/profile/codex.db", false);
    expect(other).toBe(daemon_socket_path({ app: "codex", data_file: "/scratch/profile/codex.db" }));
    expect(other).not.toBe(daemon_socket_path({ app: "codex", data_file: null }));
  });
});
