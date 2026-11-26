// A task's steps as they stream: each step's prompt in a folding block, and its thinking as it arrives.
import { useEffect, useRef } from 'react';

import type { PendingStep } from '../lib/controller.ts';
import type { StepSection } from '../run_state.ts';
import { find_step_index, step_name } from '../task_view.ts';

export const NO_INPUT_TEXT = 'Shown once this task makes its first model call.';
export const NO_THINKING_TEXT = 'Each step of this task streams here as it runs.';

interface StepListProps {
    task_id: string;
    steps: StepSection[];
    // A step chosen in the graph, scrolled to and opened once it is drawn.
    pending: PendingStep | null;
    on_revealed: () => void;
}

export function StepList({ task_id, steps, pending, on_revealed }: StepListProps) {
    const inputs = useRef<(HTMLDetailsElement | null)[]>([]);
    const headings = useRef<(HTMLElement | null)[]>([]);

    useEffect(() => {
        if (pending === null || pending.task_id !== task_id) return;
        const index = find_step_index(steps.map((step) => step_name(step.label)), pending.name, pending.occurrence);
        on_revealed();
        if (index < 0) return;
        const block = inputs.current[index];
        if (block) block.open = Boolean(steps[index].input);
        headings.current[index]?.scrollIntoView({ block: 'start' });
    }, [pending, task_id, steps.length]);

    return (
        <>
            <h3 className="detail-heading">Prompt and context</h3>
            <div className="task-inputs" data-empty={!steps.some((step) => step.input)} data-empty-text={NO_INPUT_TEXT}>
                {steps.map((step, index) => (
                    <details key={index} ref={(element) => { inputs.current[index] = element; }} className="input-step" hidden={!step.input}>
                        <summary>{step_name(step.label)}</summary>
                        <p className="input-title">Instructions</p>
                        <pre className="input-text">{step.system}</pre>
                        <p className="input-title">Input and context</p>
                        <pre className="input-text">{step.input}</pre>
                    </details>
                ))}
            </div>
            <h3 className="detail-heading">Thinking</h3>
            <div className="step-text" data-empty={steps.length === 0} data-empty-text={NO_THINKING_TEXT}>
                {steps.map((step, index) => (
                    <span key={index}>
                        <span ref={(element) => { headings.current[index] = element; }} className="step-heading">▸ {step_name(step.label)}</span>
                        {step.text.replace(/^\s+/, '')}
                    </span>
                ))}
            </div>
        </>
    );
}
