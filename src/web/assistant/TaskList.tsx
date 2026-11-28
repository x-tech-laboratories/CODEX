// The assistant's task list for the job in hand in the conversation shown: each step with its status and note, folded
// under a line saying how far it has come, and a Clear button once no reply is being written.

// ── Imports ──────────────────────────────────────────────────────────────────

import { FormGroup } from "@x-tech-laboratories/x-libs/web/react/layout";

import { is_open, type TaskStatus, type TaskStep } from "../../shared/conversations/task_list.ts";
import { attempt, calls } from "../api.ts";

// ── Task list ────────────────────────────────────────────────────────────────

const status_words: Record<TaskStatus, string> = { todo: "to do", doing: "doing", done: "done", skipped: "skipped" };

const status_tones: Record<TaskStatus, string> = { todo: "none", doing: "warn", done: "good", skipped: "none" };

export function task_list_summary(steps: TaskStep[]): string {
  const closed = steps.filter((each) => !is_open(each)).length;
  return closed === steps.length ? `Task list: all ${steps.length} steps closed` : `Task list: ${closed} of ${steps.length} steps closed`;
}

export function TaskList({ conversation_id, steps, is_running }: { conversation_id: string; steps: TaskStep[]; is_running: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className="assistant-tasks">
      <FormGroup open={steps.some(is_open)} summary={<span className="muted small">{task_list_summary(steps)}</span>}>
        <ol className="assistant-task-steps small">
          {steps.map((each, at) => (
            <li key={at}>
              <span className={`badge tone-${status_tones[each.status]}`}>{status_words[each.status]}</span> {each.step}
              {each.note && <span className="muted"> — {each.note}</span>}
            </li>
          ))}
        </ol>
        {!is_running && (
          <button type="button" className="small" onClick={() => void attempt(() => calls().set_conversation_task_list(conversation_id, []), "Task list cleared.")}>
            Clear
          </button>
        )}
      </FormGroup>
    </div>
  );
}
