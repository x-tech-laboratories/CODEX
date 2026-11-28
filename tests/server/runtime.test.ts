import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bind_methods } from "../../src/shared/store.ts";
import { start_runtime, type Runtime, type SyncContext, type SyncRole } from "../../src/server/runtime.ts";
import { sync_client_role } from "../../src/server/sync.ts";

const folders: string[] = [];
let running: Runtime | null = null;

afterEach(async () => {
  await running?.stop();
  running?.database().close();
  running = null;
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

// A sync that only notes what the runtime asked of it.
function noted_sync() {
  const asked: string[] = [];
  let given: SyncContext | null = null;
  const role = (context: SyncContext): SyncRole => {
    given = context;
    return { before_restore: () => asked.push("before_restore"), start: () => asked.push("start"), stop: () => asked.push("stop") };
  };
  return { role, asked, context: () => given! };
}

async function started<Role extends SyncRole>(role: (context: SyncContext) => Role) {
  const profile = mkdtempSync(join(tmpdir(), "codex-runtime-"));
  folders.push(profile);
  running = await start_runtime({
    database_path: join(profile, "codex.db"),
    index_path: join(profile, "codex-index.db"),
    backups_folder: join(profile, "backups"),
    profile,
    plugins_folder: null,
    desktop_plugins: false,
    declared_file: "",
    device: "test device",
    kind: "desktop",
    restore: "reopen",
    sync: role,
  });
  return { runtime: running as Runtime<Role>, profile };
}

describe("the runtime every host shares", () => {
  it("opens the store up to date and hands its sync the database, engine and profile", async () => {
    const sync = noted_sync();
    const { runtime, profile } = await started(sync.role);

    const calls = bind_methods(runtime.database, () => undefined);
    const garden = calls.add_context("Garden");

    expect(calls.get_context(garden).name).toBe("Garden");
    expect(sync.context().profile).toBe(profile);
    expect(sync.context().database()).toBe(runtime.database());
    expect(sync.asked).toEqual([]);
  });

  it("backs up, keeps its schedule beside the database, and restores by reopening after the sync lets go", async () => {
    const sync = noted_sync();
    const { runtime } = await started(sync.role);
    const calls = bind_methods(runtime.database, () => undefined);
    calls.add_context("Before");
    await runtime.backups.create_backup();
    calls.add_context("After");

    runtime.backups.set_backup_schedule({ automatic: false, to_keep: 3 });
    const [backup] = await runtime.backups.list_backups();
    await runtime.backups.restore_backup(backup!.name);

    expect(runtime.backups.get_backup_schedule()).toEqual({ automatic: false, to_keep: 3 });
    expect(sync.asked).toEqual(["before_restore"]);
    const names = bind_methods(runtime.database, () => undefined).list_contexts().map((context) => context.name);
    expect(names).toContain("Before");
    expect(names).not.toContain("After");
  });

  it("stops its sync with everything else", async () => {
    const sync = noted_sync();
    const { runtime } = await started(sync.role);

    await runtime.stop();
    running = null;
    runtime.database().close();

    expect(sync.asked).toEqual(["stop"]);
  });
});

describe("the desktop's sync", () => {
  it("offers the page the sync calls and starts nothing until asked", async () => {
    const { runtime } = await started(sync_client_role("test device"));

    expect(Object.keys(runtime.sync.methods).sort()).toEqual(["connect_sync", "disconnect_sync", "get_sync_status", "sync_now"]);
  });
});
