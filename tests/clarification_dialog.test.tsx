// @vitest-environment jsdom
import './dom_stubs.ts';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APPROVAL_QUESTION } from '../src/web/run_state.ts';
import { APPROVAL_TEXT, ClarificationDialog } from '../src/web/widgets/clarification_dialog.tsx';

afterEach(cleanup);

describe('clarification dialog', () => {
    it('asks the question and sends the typed reply with Continue', () => {
        const on_answer = vi.fn();
        render(<ClarificationDialog clarification={{ run_id: 1, clarification_id: 2, question: 'Which file?', approval: false }} on_answer={on_answer} />);

        expect(screen.getByText('Which file?')).toBeTruthy();
        fireEvent.change(screen.getByRole('textbox', { name: 'Your response' }), { target: { value: ' notes.md ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

        expect(on_answer).toHaveBeenCalledWith(true, 'notes.md');
    });

    it('shows the plan for an approval, with Approve and Decline', () => {
        const on_answer = vi.fn();
        render(<ClarificationDialog clarification={{ run_id: 1, clarification_id: 2, question: `${APPROVAL_QUESTION}\n- write notes.md`, approval: true }} on_answer={on_answer} />);

        expect(screen.getByText(APPROVAL_TEXT)).toBeTruthy();
        expect(screen.getByText('- write notes.md')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

        expect(on_answer).toHaveBeenCalledWith(false, '');
    });
});
