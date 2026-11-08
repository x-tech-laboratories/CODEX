// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_ACTIONS_TEXT } from '../src/web/inbox_view.ts';

const request = vi.fn(async () => []);

beforeEach(() => {
    Object.assign(window, {
        codex: { request },
        codexEvents: { on: () => () => undefined },
    });
});
afterEach(cleanup);

describe('inbox page', () => {
    it('lists each proposed action as a card with Done and Dismiss, or says nothing waits', async () => {
        const { inbox } = await import('../src/web/lib/controller.ts');
        const { Inbox } = await import('../src/web/views/inbox.tsx');
        inbox.set([{ id: 4, event_id: null, kind: 'notify', title: 'Lunch?', body: 'A friend asks about lunch.', payload: '{}', status: 'proposed', created_at: 0 }]);

        render(<Inbox />);

        expect(screen.getByText('Lunch?')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();

        cleanup();
        inbox.set([]);
        render(<Inbox />);

        expect(screen.getByText(NO_ACTIONS_TEXT)).toBeTruthy();
    });
});
