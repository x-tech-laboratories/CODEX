// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskNode } from '../src/web/types.ts';
import { FINAL_ROW_ID, task_tree_items, TaskTree } from '../src/web/widgets/task_tree.tsx';

afterEach(cleanup);

function node(id: string, status: string, prompt = 'Find the answer'): TaskNode {
    return { id, prompt, deliverable: 'A short answer', status };
}

const nodes = [node('1', 'done'), node('1.1', 'running'), node('1.2', 'pending'), node('3.1', 'pending')];

describe('task tree items', () => {
    it('puts the final answer first and nests each task under its parent, orphans at the top', () => {
        const items = task_tree_items(nodes);

        expect(items.map((item) => [item.id, item.parent_id])).toEqual([[FINAL_ROW_ID, null], ['1', null], ['1.1', '1'], ['1.2', '1'], ['3.1', null]]);
        expect(items[2]).toMatchObject({ state: 'NOW', status: 'running' });
    });
});

describe('task tree', () => {
    it('shows the rows with their state words and marks the chosen one', () => {
        render(<TaskTree nodes={nodes} collapsed_task_ids={[]} chosen_id="1.1" on_choose={() => undefined} on_collapsed_change={() => undefined} />);

        const rows = screen.getAllByRole('treeitem');
        expect(rows).toHaveLength(5);
        expect(screen.getByText('1.1').closest('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('true');
        expect(screen.getByText('Final answer').closest('[role="treeitem"]')!.getAttribute('aria-selected')).toBe('false');
    });

    it('chooses a row on click and folds a branch from its toggle', () => {
        const on_choose = vi.fn();
        const on_collapsed_change = vi.fn();
        render(<TaskTree nodes={nodes} collapsed_task_ids={[]} chosen_id={FINAL_ROW_ID} on_choose={on_choose} on_collapsed_change={on_collapsed_change} />);

        fireEvent.click(screen.getByText('Final answer'));
        fireEvent.click(screen.getByRole('button', { name: 'Collapse task 1' }));

        expect(on_choose).toHaveBeenCalledWith(FINAL_ROW_ID);
        expect(on_collapsed_change).toHaveBeenCalledWith(['1']);
    });

    it('hides the rows inside a folded branch', () => {
        render(<TaskTree nodes={nodes} collapsed_task_ids={['1']} chosen_id={FINAL_ROW_ID} on_choose={() => undefined} on_collapsed_change={() => undefined} />);

        expect(screen.getAllByRole('treeitem')).toHaveLength(3);
    });
});
