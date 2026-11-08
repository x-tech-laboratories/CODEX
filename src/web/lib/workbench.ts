// The workbench's state as one store: every change goes through the reducers, runs their effects, and redraws at a steady pace.
import { create_watch } from '@x-tech-laboratories/x-libs/web/watch';
import { use_watch } from '@x-tech-laboratories/x-libs/web/react/watch';

import { moment_after, type MascotMood } from '../mascot.ts';
import { initial_state, type Effect, type Reduction, type WorkbenchState } from '../run_state.ts';

export const RENDER_INTERVAL_MILLISECONDS = 150;

let state: WorkbenchState = initial_state();
export const watch = create_watch();
let effect_handler: (effect: Effect) => void = () => undefined;
const moment_listeners = new Set<(moment: MascotMood) => void>();

export function get_state(): WorkbenchState {
    return state;
}

export function use_workbench(): WorkbenchState {
    use_watch(watch);
    return state;
}

// Effects such as refreshing the queue need the daemon, so the controller registers how to run them.
export function set_effect_handler(handler: (effect: Effect) => void): void {
    effect_handler = handler;
}

// Hears the mood the mascot plays for a moment when a run ends.
export function on_moment(listener: (moment: MascotMood) => void): () => void {
    moment_listeners.add(listener);
    return () => void moment_listeners.delete(listener);
}

export function dispatch(reduction: Reduction | WorkbenchState): void {
    const previous = state;
    if ('effects' in reduction) {
        state = reduction.state;
        reduction.effects.forEach((effect) => effect_handler(effect));
    } else {
        state = reduction;
    }
    const moment = moment_after(previous, state);
    if (moment !== null) {
        for (const listener of moment_listeners) listener(moment);
    }
    schedule_redraw();
}

// Puts the state back to its start, for tests.
export function reset_workbench(): void {
    state = initial_state();
    schedule_redraw();
}

// ============================================================================
// Redrawing
// ============================================================================

let redraw_timer: ReturnType<typeof setTimeout> | null = null;
let last_redraw_at = 0;

// Streaming tokens arrive many times a second, so the page redraws at most every interval.
function schedule_redraw(): void {
    if (redraw_timer !== null) {
        return;
    }
    const wait = Math.max(0, RENDER_INTERVAL_MILLISECONDS - (performance.now() - last_redraw_at));
    redraw_timer = setTimeout(() => {
        redraw_timer = null;
        last_redraw_at = performance.now();
        watch.bump();
    }, wait);
}
