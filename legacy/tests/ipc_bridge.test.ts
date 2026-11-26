import { describe, expect, it } from 'vitest';

import { CODEX_METHODS, codex_bridge, codex_events } from '../src/shared/ipc.ts';

describe('the window bridge', () => {
    it('names every method on its own channel under codex', () => {
        expect([...codex_bridge.method_names]).toEqual([...CODEX_METHODS]);
        expect(codex_bridge.channel('request')).toBe('codex:request');
        expect(codex_events.channel).toBe('codexEvents:event');
    });

    it('sends a daemon event to each window as one named message', () => {
        const sent: unknown[] = [];
        const window = { webContents: { send: (channel: string, message: unknown) => sent.push([channel, message]) } };

        codex_events.emit([window], 'daemon', { event: 'run.started', data: { run_id: 3 } });

        expect(sent).toEqual([['codexEvents:event', { name: 'daemon', payload: { event: 'run.started', data: { run_id: 3 } } }]]);
    });
});
