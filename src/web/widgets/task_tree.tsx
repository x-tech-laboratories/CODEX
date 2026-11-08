// The run's tasks as a tree with the final answer at the top, on X-Libs' tree rows.
import { Tree, type TreeItem } from '@x-tech-laboratories/x-libs/web/react/tree';

import { task_tree_rows } from '../task_view.ts';
import type { TaskNode } from '../types.ts';

// The final answer sits at the top of the tree under this id, above the tasks.
export const FINAL_ROW_ID = 'final';

export type TaskTreeItem = TreeItem & { state: string; status: string; prompt: string };

interface TaskTreeProps {
    nodes: TaskNode[];
    collapsed_task_ids: string[];
    // The chosen task's id, or FINAL_ROW_ID for the final answer.
    chosen_id: string;
    on_choose: (id: string) => void;
    on_collapsed_change: (collapsed_task_ids: string[]) => void;
}

function parent_id(id: string): string {
    return id.split('.').slice(0, -1).join('.');
}

// Nests each task under its parent; a task whose parent is missing sits at the top.
export function task_tree_items(nodes: TaskNode[]): TaskTreeItem[] {
    const ids = new Set(nodes.map((node) => node.id));
    const final: TaskTreeItem = { id: FINAL_ROW_ID, parent_id: null, position: 0, state: '', status: 'final', prompt: 'Final answer' };
    return [
        final,
        ...task_tree_rows(nodes).map((row, index) => {
            const parent = parent_id(row.id);
            return { id: row.id, parent_id: ids.has(parent) ? parent : null, position: index + 1, state: row.state, status: row.status, prompt: row.prompt };
        }),
    ];
}

export function TaskTree({ nodes, collapsed_task_ids, chosen_id, on_choose, on_collapsed_change }: TaskTreeProps) {
    return (
        <Tree
            items={task_tree_items(nodes)}
            label="Task tree"
            collapsed={new Set(collapsed_task_ids)}
            on_collapsed_change={(collapsed) => on_collapsed_change([...collapsed])}
            selected_id={chosen_id}
            on_select={(item) => on_choose(item.id)}
            name_of={(item) => item.id === FINAL_ROW_ID ? item.prompt : `task ${item.id}`}
            row_class={(item) => `task-row status-${item.status}`}
            render_item={(item) => (
                <>
                    {item.state && <span className="task-state">{item.state}</span>}
                    {item.id !== FINAL_ROW_ID && <span className="task-id">{item.id}</span>}
                    <span className="task-prompt">{item.prompt}</span>
                </>
            )}
        />
    );
}
