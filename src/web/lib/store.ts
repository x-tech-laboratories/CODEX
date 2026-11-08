// A value a page reads and the daemon's events change, with a watch that redraws only what reads it.
import { create_watch, type Watch } from '@x-tech-laboratories/x-libs/web/watch';
import { use_watch } from '@x-tech-laboratories/x-libs/web/react/watch';

export interface Store<Value> {
    get(): Value;
    set(next: Value): void;
    watch: Watch;
}

export function create_store<Value>(initial: Value): Store<Value> {
    let value = initial;
    const watch = create_watch();
    return {
        get: () => value,
        set: (next) => {
            value = next;
            watch.bump();
        },
        watch,
    };
}

export function use_store<Value>(store: Store<Value>): Value {
    use_watch(store.watch);
    return store.get();
}
