// Backups of the knowledge database into backups/ beside it: one a day, kept to the schedule set in Options, and any
// taken by hand. Every call into the database opens and closes its own connection within one turn of the event loop,
// so a restore can put the file back while the daemon runs; the next call opens the restored file and migrates it.
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { BackupMethods, BackupSchedule } from '@x-tech-laboratories/x-libs/backup_protocol';
import { backup_naming, keep_backing_up } from '@x-tech-laboratories/x-libs/backups';
import { json_backup_schedule } from '@x-tech-laboratories/x-libs/server/backup_routes';
import { sqlite_backups } from '@x-tech-laboratories/x-libs/server/sqlite_backups';

import type { KnowledgeStore } from '../core/knowledge.js';

export type KnowledgeBackupOptions = {
    // The store for the knowledge database the settings name now.
    store: () => KnowledgeStore;
    // Why a restore has to wait, such as a task still running; null when it may go ahead.
    restoreBlocked: () => string | null;
    // Runs once the restored file is in place, such as dropping the open stores so the next call migrates it.
    afterRestore: () => void;
    onError: (error: unknown) => void;
};

export type KnowledgeBackups = {
    methods: BackupMethods;
    // Takes the daily backup when one is due, now and every hour after.
    start: () => void;
    stop: () => void;
};

export function knowledgeBackups(options: KnowledgeBackupOptions): KnowledgeBackups {
    // VACUUM INTO runs on a connection of the backups' own, with sqlite-vec loaded as the store loads it.
    let connection: { path: string; database: DatabaseSync } | null = null;
    const close = (): void => {
        connection?.database.close();
        connection = null;
    };
    const database = (): DatabaseSync => {
        const store = options.store();
        if (connection?.path !== store.path) {
            close();
            connection = { path: store.path, database: store.open() };
        }
        return connection.database;
    };
    // The schedule sits beside the database, so it follows a database the settings move.
    const schedule = () => json_backup_schedule(join(dirname(options.store().path), 'backup-schedule.json'));

    const kept = sqlite_backups({
        folder: () => join(dirname(options.store().path), 'backups'),
        naming: backup_naming('knowledge', '.sqlite3'),
        database,
        database_path: () => options.store().path,
        close,
        open: options.afterRestore,
    });
    let backingUp: ReturnType<typeof keep_backing_up> | null = null;

    return {
        methods: {
            list_backups: kept.list,
            create_backup: () => kept.create(),
            restore_backup: async (name) => {
                const blocked = options.restoreBlocked();
                if (blocked !== null) {
                    throw new Error(blocked);
                }
                await kept.restore(name);
            },
            remove_backup: kept.remove,
            get_backup_schedule: () => schedule().get(),
            set_backup_schedule: (next: BackupSchedule) => {
                schedule().set(next);
                void backingUp?.check();
            },
        },
        start: () => {
            backingUp ??= keep_backing_up(kept, () => schedule().get(), { on_error: options.onError });
        },
        stop: () => {
            backingUp?.stop();
            backingUp = null;
            close();
        },
    };
}
