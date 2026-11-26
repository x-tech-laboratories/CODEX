import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codex_bridge } from '../shared/ipc.js';
import { ALLOWED_METHODS, handleRequest, ipcAnswers, listUserCommands, openDialogOptions, saveDialogOptions, type IpcDependencies } from './ipc.js';

// Answers the bridge as the main process does, through handlers kept by channel, for a window that is trusted or not.
function handle_bridge(dependencies: Partial<IpcDependencies>, is_trusted: () => boolean): Map<string, (...args: unknown[]) => unknown> {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: () => undefined };
    codex_bridge.handle(ipcMain, ipcAnswers(dependencies as IpcDependencies), { trusted: is_trusted, envelopes: true });
    return handlers;
}

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

// ============================================================================
// Daemon requests
// ============================================================================

describe('daemon requests from the window', () => {
    it('passes an allowed method and its params to the daemon', async () => {
        const caller = { call: vi.fn(async () => ({ run_id: 4 })) };

        const result = await handleRequest(caller, 'run', { prompt: 'hello' });

        expect(result).toEqual({ run_id: 4 });
        expect(caller.call).toHaveBeenCalledWith('run', { prompt: 'hello' });
    });

    it('never lets the window shut the daemon down', async () => {
        const caller = { call: vi.fn() };

        await expect(handleRequest(caller, 'shutdown', {})).rejects.toThrow('Unknown method: shutdown');

        expect(ALLOWED_METHODS.has('shutdown')).toBe(false);
        expect(caller.call).not.toHaveBeenCalled();
    });

    it('lets the window list and resolve actions but not post events', () => {
        expect(ALLOWED_METHODS.has('actions')).toBe(true);
        expect(ALLOWED_METHODS.has('resolve_action')).toBe(true);
        expect(ALLOWED_METHODS.has('post_event')).toBe(false);
        expect(ALLOWED_METHODS.has('queue_request')).toBe(true);
    });

    it('rejects params that are not an object', async () => {
        await expect(handleRequest({ call: vi.fn() }, 'status', [1])).rejects.toThrow('params must be a JSON object.');
    });

    it('reports a missing connection and daemon errors as text', async () => {
        const failing = { call: vi.fn(async () => Promise.reject(new Error('Another request is already running.'))) };

        await expect(handleRequest(null, 'status', {})).rejects.toThrow('Not connected to the daemon yet.');
        await expect(handleRequest(failing, 'run', { prompt: 'x' })).rejects.toThrow('Another request is already running.');
    });
});

// ============================================================================
// Dialogs and commands
// ============================================================================

describe('native dialog options', () => {
    it('opens a folder or a file with the given filters', () => {
        const folder = openDialogOptions({ directory: true, title: 'Filesystem root' });
        const model = openDialogOptions({ filters: [{ name: 'GGUF model', extensions: ['gguf'] }], defaultPath: '/models' });

        expect(folder.properties).toContain('openDirectory');
        expect(folder.title).toBe('Filesystem root');
        expect(model.properties).toContain('openFile');
        expect(model.filters).toEqual([{ name: 'GGUF model', extensions: ['gguf'] }]);
        expect(model.defaultPath).toBe('/models');
    });

    it('ignores options of the wrong type', () => {
        const options = saveDialogOptions({ title: 3, defaultPath: '' });

        expect(options.title).toBeUndefined();
        expect(options.defaultPath).toBeUndefined();
    });
});

describe('user commands', () => {
    it("lists the folder's own commands by name with their mode", () => {
        const root = mkdtempSync(join(tmpdir(), 'codex-commands-'));
        directories.push(root);
        mkdirSync(join(root, '.codex', 'commands'), { recursive: true });
        writeFileSync(join(root, '.codex', 'commands', 'review.md'), '---\ndescription: Review a file\nmode: answer\n---\nReview $ARGUMENTS');

        const commands = listUserCommands(root);

        expect(commands).toContainEqual({ name: 'review', description: 'Review a file', mode: 'answer' });
        expect(listUserCommands('')).toEqual([]);
    });
});

describe('launch at login', () => {
    it('reads and sets the autostart entry for a trusted window only', async () => {
        let enabled = false;
        let trusted = true;
        const handlers = handle_bridge({ autostart: { isEnabled: () => enabled, setEnabled: (value: boolean) => (enabled = value) } }, () => trusted);

        const turnedOn = await handlers.get(codex_bridge.channel('set_autostart'))!({}, true);
        const read = await handlers.get(codex_bridge.channel('get_autostart'))!({});
        trusted = false;
        const refused = await handlers.get(codex_bridge.channel('set_autostart'))!({}, false);

        expect(turnedOn).toEqual({ ok: true, result: true });
        expect(read).toEqual({ ok: true, result: true });
        expect(refused).toEqual({ ok: false, error: 'Untrusted sender.' });
        expect(enabled).toBe(true);
    });
});

describe('restarting the daemon', () => {
    it('restarts it for a trusted window only', async () => {
        const restartDaemon = vi.fn();
        let trusted = true;
        const handlers = handle_bridge({ restartDaemon }, () => trusted);

        const restarted = await handlers.get(codex_bridge.channel('restart_daemon'))!({});
        trusted = false;
        const refused = await handlers.get(codex_bridge.channel('restart_daemon'))!({});

        expect(restarted).toEqual({ ok: true, result: true });
        expect(refused).toEqual({ ok: false, error: 'Untrusted sender.' });
        expect(restartDaemon).toHaveBeenCalledTimes(1);
    });
});
