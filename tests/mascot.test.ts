import { defaultConfig } from '@x-tech-laboratories/robobuddy';
import { describe, expect, it } from 'vitest';

import type { MascotMood } from '../src/web/mascot.ts';
import { lasting_mood, moment_after } from '../src/web/mascot.ts';
import { begin_run, fail_run, finish_run, initial_state, stop_run } from '../src/web/run_state.ts';
import type { WorkbenchState } from '../src/web/run_state.ts';

function connected(changes: Partial<WorkbenchState> = {}): WorkbenchState {
    return { ...initial_state(), connection: 'connected', ...changes };
}

describe('the mascot mood', () => {
    it('uses only moods RoboBuddy has', () => {
        const moods: MascotMood[] = ['default', 'thinking', 'happy', 'sad', 'asleep'];

        for (const mood of moods) expect(defaultConfig.moods).toHaveProperty(mood);
    });

    it('follows the state, most urgent first', () => {
        const running = begin_run(connected(), 1);

        expect(lasting_mood(connected())).toBe('default');
        expect(lasting_mood(running)).toBe('thinking');
        expect(lasting_mood({ ...running, suspended: true })).toBe('asleep');
        expect(lasting_mood({ ...running, connection: 'unavailable' })).toBe('asleep');
    });

    it('is happy after a completed run and sad after a failed one', () => {
        const running = begin_run(connected(), 1);

        expect(moment_after(running, finish_run(running, 'Done'))).toBe('happy');
        expect(moment_after(running, fail_run(running, 'Broke').state)).toBe('sad');
        expect(moment_after(running, stop_run(running, '_Run cancelled._', 'Cancelled'))).toBeNull();
        expect(moment_after(connected(), begin_run(connected(), 1))).toBeNull();
    });

    it('goes straight to sleep when a run fails because the daemon went away', () => {
        const running = begin_run(connected(), 1);
        const lost = { ...fail_run(running, 'Gone').state, connection: 'unavailable' as const };

        expect(moment_after(running, lost)).toBeNull();
    });
});
