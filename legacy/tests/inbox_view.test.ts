import { describe, expect, it } from 'vitest';

import { action_cards, action_meta, inbox_tab_text } from '../src/web/inbox_view.ts';
import type { ProposedAction } from '../src/web/types.ts';

const created = new Date(2026, 10, 5, 9, 30).getTime() / 1000;

function action(overrides: Partial<ProposedAction> = {}): ProposedAction {
    return { id: 1, event_id: 7, kind: 'notify', title: 'Alice: Lunch?', body: 'Alice asks about lunch.', payload: '{}', status: 'proposed', created_at: created, ...overrides };
}

describe('action_meta', () => {
    it('lists the importance, category and wait for a reply, then the time', () => {
        const payload = JSON.stringify({ importance: 'high', category: 'work', needs_reply: true });

        expect(action_meta(action({ payload }))).toBe('high importance · work · waiting for a reply · 2026-11-05 09:30');
    });

    it('shows just the time when the payload has nothing to add or cannot be read', () => {
        expect(action_meta(action())).toBe('2026-11-05 09:30');
        expect(action_meta(action({ payload: 'not json' }))).toBe('2026-11-05 09:30');
        expect(action_meta(action({ payload: '[1]' }))).toBe('2026-11-05 09:30');
    });
});

describe('action_cards', () => {
    it('makes a card with Done and Dismiss for each action', () => {
        expect(action_cards([action({ id: 4 })])).toEqual([
            {
                id: 4,
                title: 'Alice: Lunch?',
                body: 'Alice asks about lunch.',
                meta: '2026-11-05 09:30',
                buttons: [
                    { label: 'Done', resolution: 'done' },
                    { label: 'Dismiss', resolution: 'rejected' },
                ],
            },
        ]);
    });
});

describe('inbox_tab_text', () => {
    it('adds the count only while actions are waiting', () => {
        expect(inbox_tab_text(0)).toBe('Inbox');
        expect(inbox_tab_text(3)).toBe('Inbox (3)');
    });
});
