// Making or changing a job: its title, what it does, where, when it runs, its condition and its limits.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { NumberField, Segmented, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormGroup, FormRow } from "@x-tech-laboratories/x-libs/web/react/layout";

import { default_limits, type IntervalUnit, type Job, type JobFields } from "../../shared/jobs/model.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";

// ── Dialog ───────────────────────────────────────────────────────────────────

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const blank = (context_id: string | null): JobFields => ({
  title: "",
  instruction: "",
  context_id,
  schedule: { kind: "every", every: 1, unit: "days" },
  only_when_changed: false,
  limits: default_limits,
});

// Opens the dialog for a new job in the context given, or to change the job given.
export function job_dialog(given: { job?: Job; context_id?: string | null } = {}): void {
  open_dialog((close) => <JobDialog job={given.job ?? null} context_id={given.context_id ?? null} on_close={close} />);
}

function JobDialog({ job, context_id, on_close }: { job: Job | null; context_id: string | null; on_close: () => void }) {
  const [fields, set_fields] = useState<JobFields>(job ? { title: job.title, instruction: job.instruction, context_id: job.context_id, schedule: job.schedule, only_when_changed: job.only_when_changed, limits: job.limits } : blank(context_id));
  const contexts = use_data((api) => api.list_contexts(false));
  const change = (more: Partial<JobFields>) => set_fields((before) => ({ ...before, ...more }));
  const { schedule } = fields;
  const save = async () => {
    const done = job ? await succeeds(() => calls().change_job(job.id, fields), "Saved.") : (await attempt(() => calls().add_job(fields), "The job is made.")) !== undefined;
    if (done) on_close();
  };
  return (
    <Dialog
      title={job ? "Change the job" : "New job"}
      subtitle="Work the assistant does on its own, on a schedule, in a conversation of its own."
      on_close={on_close}
      form={{
        submit_label: job ? "Save" : "Make",
        on_submit: (event) => {
          event.preventDefault();
          void save();
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FormRow label="Title" id="job-title">
        <input id="job-title" value={fields.title} maxLength={120} autoFocus onChange={(event) => change({ title: event.target.value })} />
      </FormRow>
      <FormRow label="What it does" id="job-instruction" hint="Written as you would ask it in a conversation; each run sends it as the message.">
        <textarea id="job-instruction" rows={4} value={fields.instruction} onChange={(event) => change({ instruction: event.target.value })} />
      </FormRow>
      <FormRow label="Works in" id="job-context">
        <Select<string> bare id="job-context" label="Works in" value={fields.context_id ?? ""} options={[["", "No context"], ...(contexts.data ?? []).map((context): [string, string] => [context.id, context.name])]} on_change={(value) => change({ context_id: value || null })} />
      </FormRow>
      <FormRow label="Runs" id="job-when">
        <Segmented<"every" | "at">
          label="Runs"
          choices={[
            { value: "every", label: "Every so often" },
            { value: "at", label: "At a time" },
          ]}
          value={schedule.kind}
          on_change={(kind) => change({ schedule: kind === "every" ? { kind, every: 1, unit: "days" } : { kind, time: "08:00", weekdays: [1, 2, 3, 4, 5] } })}
        />
      </FormRow>
      {schedule.kind === "every" ? (
        <FormRow label="Every" id="job-every" hint="At least every 5 minutes.">
          <div className="job-every">
            <NumberField label="Every" bare min={1} value={schedule.every} on_change={(every) => change({ schedule: { ...schedule, every: every ?? 1 } })} />
            <Select<IntervalUnit> bare label="Unit" value={schedule.unit} options={[["minutes", "minutes"], ["hours", "hours"], ["days", "days"]]} on_change={(unit) => change({ schedule: { ...schedule, unit } })} />
          </div>
        </FormRow>
      ) : (
        <>
          <FormRow label="At" id="job-time" hint="This device's local time.">
            <input id="job-time" type="time" value={schedule.time} onChange={(event) => change({ schedule: { ...schedule, time: event.target.value } })} />
          </FormRow>
          <FormRow label="On" id="job-days">
            <div className="job-days" role="group" aria-label="On these days">
              {weekdays.map((day, at) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={schedule.weekdays.includes(at)}
                    onChange={(event) => change({ schedule: { ...schedule, weekdays: event.target.checked ? [...schedule.weekdays, at].sort() : schedule.weekdays.filter((each) => each !== at) } })}
                  />{" "}
                  {day}
                </label>
              ))}
            </div>
          </FormRow>
        </>
      )}
      <FormRow label="Only when something changed" id="job-changed" hint="Skips a run, with no call to the engine, when nothing in its context changed since the last.">
        <Switch label="Only when something changed" checked={fields.only_when_changed} on_change={(on) => change({ only_when_changed: on })} />
      </FormRow>
      <FormGroup summary="Limits">
        <FormRow label="Rounds a run" id="job-rounds">
          <NumberField label="Rounds a run" bare min={1} max={20} value={fields.limits.max_rounds} on_change={(value) => change({ limits: { ...fields.limits, max_rounds: value ?? default_limits.max_rounds } })} />
        </FormRow>
        <FormRow label="Tokens a run" id="job-tokens">
          <NumberField label="Tokens a run" bare min={1000} max={1_000_000} step={1000} value={fields.limits.max_tokens} on_change={(value) => change({ limits: { ...fields.limits, max_tokens: value ?? default_limits.max_tokens } })} />
        </FormRow>
        <FormRow label="Runs a day" id="job-runs">
          <NumberField label="Runs a day" bare min={1} max={288} value={fields.limits.max_runs_per_day} on_change={(value) => change({ limits: { ...fields.limits, max_runs_per_day: value ?? default_limits.max_runs_per_day } })} />
        </FormRow>
      </FormGroup>
    </Dialog>
  );
}
