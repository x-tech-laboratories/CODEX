// The Workbench: the task tree, the request box, and the chosen task's details or the final answer with the task graph above.
import { Section, Toolbar } from '@x-tech-laboratories/x-libs/web/react/layout';
import { Select } from '@x-tech-laboratories/x-libs/web/react/controls';
import { Empty } from '@x-tech-laboratories/x-libs/web/react/states';
import { useEffect, useRef } from 'react';

import {
    cancel_run, clear_run, copy_answer, discard_run, form, load_user_commands, pending_step, prompt, resume_run, start_run,
} from '../lib/controller.ts';
import { use_store } from '../lib/store.ts';
import { dispatch, use_workbench } from '../lib/workbench.ts';
import { choose_final_answer, choose_task, chosen_task, chosen_task_steps, set_graph_shown, unfinished_run_text } from '../run_state.ts';
import { MODE_CHOICES, MODE_NAMES } from '../settings_form.ts';
import type { TaskGraph } from '../task_graph.ts';
import { task_output_markdown, task_summary_markdown } from '../task_view.ts';
import { Markdown } from '../widgets/markdown.tsx';
import { TaskGraphView } from '../widgets/graph_views.tsx';
import { PromptBox } from '../widgets/prompt_box.tsx';
import { StepList } from '../widgets/step_list.tsx';
import { FINAL_ROW_ID, TaskTree } from '../widgets/task_tree.tsx';

export const NO_TASKS_TEXT = 'Tasks appear here once a request is planned.';

// Ctrl+Enter and Ctrl+R run the request from anywhere on the page, unless a dialog is open.
function use_run_shortcut(): void {
    useEffect(() => {
        const listener = (event: KeyboardEvent): void => {
            if (event.ctrlKey && (event.key === 'Enter' || event.key.toLowerCase() === 'r') && document.querySelector('dialog[open]') === null) {
                event.preventDefault();
                void start_run();
            }
        };
        document.addEventListener('keydown', listener);
        return () => document.removeEventListener('keydown', listener);
    }, []);
}

export function Workbench() {
    const state = use_workbench();
    const text = use_store(prompt);
    const values = use_store(form);
    const pending = use_store(pending_step);
    const graph = useRef<TaskGraph | null>(null);
    use_run_shortcut();

    const chosen_id = state.phase === 'task' && state.chosen_task_id !== null ? state.chosen_task_id : FINAL_ROW_ID;
    const task = chosen_task(state);
    const resume = unfinished_run_text(state);
    const mode = values?.mode ?? 'auto';

    function choose_row(id: string): void {
        dispatch(id === FINAL_ROW_ID ? choose_final_answer(state) : choose_task(state, id));
    }

    return (
        <div className="workbench">
            <Section title="Task tree" class_name="task-tree-panel">
                <TaskTree
                    nodes={state.nodes}
                    collapsed_task_ids={state.collapsed_task_ids}
                    chosen_id={chosen_id}
                    on_choose={choose_row}
                    on_collapsed_change={(collapsed_task_ids) => dispatch({ ...state, collapsed_task_ids })}
                />
                {state.nodes.length === 0 && <p className="muted small">{NO_TASKS_TEXT}</p>}
            </Section>

            <div className="work">
                <Section title="Your request">
                    <PromptBox value={text} on_change={prompt.set} read_only={state.running} load_commands={load_user_commands} on_run={() => void start_run()} />
                    <Toolbar>
                        <Select
                            label="Mode"
                            bare
                            options={MODE_CHOICES.map((choice) => [choice, MODE_NAMES[choice]])}
                            value={mode}
                            on_change={(choice) => { if (values !== null) form.set({ ...values, mode: choice }); }}
                        />
                        <button className="accent solid" title="Run the request (Ctrl+Enter or Ctrl+R)" disabled={state.running || state.connection !== 'connected'} onClick={() => void start_run()}>Run</button>
                        <button disabled={!state.running || state.cancelling} onClick={cancel_run}>Cancel</button>
                        <button disabled={state.running} onClick={clear_run}>Clear</button>
                        <button disabled={state.running || !state.last_answer} onClick={() => void copy_answer()}>Copy answer</button>
                        <span className="muted small hint">Ctrl+Enter runs</span>
                    </Toolbar>
                    {resume !== null && (
                        <div className="banner resume-bar" role="status">
                            <span>{resume}</span>
                            <button className="accent solid" onClick={() => void resume_run()}>Resume</button>
                            <button onClick={() => void discard_run()}>Discard</button>
                        </div>
                    )}
                </Section>

                <Section
                    title={state.phase === 'task' ? `Task ${state.chosen_task_id ?? ''}` : 'Final answer'}
                    class_name="output-panel"
                    tools={<>
                        {state.graph_shown && <button className="small" title="Fit the whole graph in the panel" onClick={() => graph.current?.reset_view()}>Reset view</button>}
                        <button className="small" aria-pressed={state.graph_shown} title="Show the tasks as a graph above the output" onClick={() => dispatch(set_graph_shown(state, !state.graph_shown))}>Graph</button>
                    </>}
                >
                    {state.graph_shown && (
                        <TaskGraphView
                            nodes={state.nodes}
                            chosen_id={state.phase === 'task' ? state.chosen_task_id : null}
                            graph_ref={graph}
                            on_choose={(task_id, step) => {
                                pending_step.set(step === null ? null : { task_id, ...step });
                                dispatch(choose_task(state, task_id));
                            }}
                        />
                    )}
                    {state.phase === 'task' ? (
                        <div className="output task-detail">
                            <Markdown text={task === null ? `### Task ${state.chosen_task_id ?? ''}` : task_summary_markdown(task)} />
                            <StepList task_id={state.chosen_task_id ?? ''} steps={chosen_task_steps(state)} pending={pending} on_revealed={() => pending_step.set(null)} />
                            <h3 className="detail-heading">Output</h3>
                            <Markdown text={task === null ? '_No output yet._' : task_output_markdown(task)} />
                        </div>
                    ) : (
                        <Markdown text={state.final_text} class_name="output final-answer" />
                    )}
                    {state.nodes.length === 0 && state.graph_shown && <Empty title={NO_TASKS_TEXT} />}
                </Section>
            </div>
        </div>
    );
}
