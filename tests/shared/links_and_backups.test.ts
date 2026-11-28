import { describe, expect, it } from "vitest";

import { default_backup_schedule } from "@x-tech-laboratories/x-libs/backups";

import { codex_backup_naming, read_schedule } from "../../src/shared/backups.ts";
import { app_link, link_scheme, route_of_link } from "../../src/shared/links.ts";

describe("the app's links", () => {
  it("turn a page's route into a codex:// link and back", () => {
    expect(link_scheme).toBe("codex");
    expect(app_link("#/context/abc")).toBe("codex://context/abc");
    expect(app_link("context/abc")).toBe("codex://context/abc");
    expect(route_of_link("codex://context/abc")).toBe("#/context/abc");
    expect(route_of_link("CODEX://context/abc/")).toBe("#/context/abc");
  });

  it("refuse text that is not one of the app's links", () => {
    expect(route_of_link("x-context://context/abc")).toBeNull();
    expect(route_of_link("https://example.org/")).toBeNull();
    expect(route_of_link("codex://context/<script>")).toBeNull();
  });
});

describe("backups", () => {
  it("are named after the app", () => {
    expect(codex_backup_naming.name_for(new Date("2026-11-26T09:30:00Z"), true)).toBe("codex-2026-11-26T09-30-00Z-auto.db");
  });

  it("read a saved schedule back, keeping the default where it is missing or damaged", () => {
    expect(read_schedule(null)).toEqual(default_backup_schedule);
    expect(read_schedule({ automatic: false, to_keep: 6.6 })).toEqual({ automatic: false, to_keep: 7 });
    expect(read_schedule({ automatic: "yes", to_keep: -1 })).toEqual(default_backup_schedule);
  });
});
