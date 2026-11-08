// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptBox } from '../src/web/widgets/prompt_box.tsx';

afterEach(cleanup);

function Harness({ on_run = () => undefined }: { on_run?: () => void }) {
    const [value, set_value] = useState('');
    return <PromptBox value={value} on_change={set_value} read_only={false} load_commands={async () => [{ name: 'review', description: 'Review a file', mode: 'answer' }]} on_run={on_run} />;
}

describe('prompt box', () => {
    it('suggests commands as a slash is typed and completes the chosen one with Tab', async () => {
        render(<Harness />);
        const box = screen.getByRole('textbox', { name: 'Your request' });

        fireEvent.change(box, { target: { value: '/re' } });
        const options = await screen.findAllByRole('option');

        expect(options.map((option) => option.textContent)).toEqual(['/remember [store] statement. Why: reasonKeep a memory without loading the model; stores: general, user, locations, software, project, research, code', '/review [arguments]Review a file (answer mode)']);
        expect(options[0].getAttribute('aria-selected')).toBe('true');

        fireEvent.keyDown(box, { key: 'ArrowDown' });
        fireEvent.keyDown(box, { key: 'Tab' });

        expect((box as HTMLTextAreaElement).value).toBe('/review ');
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('runs on Ctrl+Enter', () => {
        const on_run = vi.fn();
        render(<Harness on_run={on_run} />);

        act(() => {
            fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your request' }), { key: 'Enter', ctrlKey: true });
        });

        expect(on_run).toHaveBeenCalledTimes(1);
    });
});
