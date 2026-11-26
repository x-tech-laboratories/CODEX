// The question a run asks mid-way, or the approval it needs before changing anything, on X-Libs' dialog.
import { Dialog } from '@x-tech-laboratories/x-libs/web/react/dialog';
import { useState } from 'react';

import { approval_plan, type Clarification } from '../run_state.ts';

export const APPROVAL_TEXT = 'These tasks want to change files, run tests, or call MCP tools. Approve them before anything is changed?';

interface ClarificationDialogProps {
    clarification: Clarification;
    // Called with whether the reply was sent or skipped, and the text typed.
    on_answer: (submitted: boolean, typed: string) => void;
}

export function ClarificationDialog({ clarification, on_answer }: ClarificationDialogProps) {
    const [typed, set_typed] = useState('');
    const approval = clarification.approval;

    return (
        <Dialog
            title={approval ? 'Approve actions' : 'Clarification'}
            on_close={() => on_answer(false, typed.trim())}
            wide
            form={{ on_submit: () => on_answer(true, typed.trim()), submit_label: approval ? 'Approve' : 'Continue' }}
            buttons={<button type="button" onClick={() => on_answer(false, typed.trim())}>{approval ? 'Decline' : 'Skip'}</button>}
        >
            <p className="question">{approval ? APPROVAL_TEXT : clarification.question}</p>
            {approval && <pre className="output plan">{approval_plan(clarification.question)}</pre>}
            <label className="field clarification-answer">
                <span className="field-label">{approval ? 'Reply (optional)' : 'Your response'}</span>
                <textarea rows={3} autoFocus value={typed} onChange={(event) => set_typed(event.currentTarget.value)} />
            </label>
        </Dialog>
    );
}
