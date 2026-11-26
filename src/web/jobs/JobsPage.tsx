// The Jobs page: the assistant's own recurring work, each with when it runs, where, whether it is on, its last run and
// the device that ran it, and Run now; one job's runs below it when opened. Also the Jobs list a context's page shows.

// ── Imports ──────────────────────────────────────────────────────────────────

import { CalendarClock } from "lucide-react";
import { Chip, Chips, StateBadge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { confirm_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { AddIcon, HistoryIcon, Icon, MoreIcon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { open_context_menu } from "@x-tech-laboratories/x-libs/web/react/menus";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { stamp, until } from "@x-tech-laboratories/x-libs/web/format";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import { conversation_route } from "../../shared/conversations/model.ts";
import type { BackgroundState, Job, JobRun, JobRunOutcome } from "../../shared/jobs/model.ts";
import { open_conversation } from "../assistant/selection.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";
import { context_href } from "../contexts/actions.tsx";
import { open_item_history } from "../history/HistoryView.tsx";
import { job_dialog } from "./JobDialog.tsx";

// ── Runs ─────────────────────────────────────────────────────────────────────

export const outcome_labels: Record<JobRunOutcome, [text: string, tone: "none" | "good" | "bad" | "warn" | "info"]> = {
  running: ["Running", "info"],
  done: ["Done", "good"],
  error: ["Failed", "bad"],
  limit: ["Stopped at a limit", "warn"],
  gave_way: ["Gave way", "none"],
};

function seconds(at: string): number {
  return Date.parse(at) / 1000;
}

function open_run(run: JobRun, context_id: string | null): void {
  if (run.conversation_id) open_conversation(run.conversation_id, context_id ? [context_id] : [], null);
}

function RunLine({ run, context_id }: { run: JobRun; context_id: string | null }) {
  const used = run.input_tokens + run.output_tokens;
  return (
    <li className="item-row">
      <StateBadge labels={outcome_labels} state={run.outcome} />
      <div className="item-text">
        <div className="item-title">
          <span>
            <Age epoch={seconds(run.started_at)} /> on {run.device || "an unknown device"}
          </span>
          {run.conversation_id && (
            <a
              href={conversation_route(run.conversation_id)}
              onClick={(event) => {
                event.preventDefault();
                open_run(run, context_id);
              }}
            >
              Open its conversation
            </a>
          )}
        </div>
        <span className="muted small">
          {[run.engine && [run.engine, run.model].filter(Boolean).join(" · "), `${run.rounds} ${run.rounds === 1 ? "round" : "rounds"}`, `${used.toLocaleString()} tokens`].filter(Boolean).join(" · ")}
        </span>
        {run.applied.length > 0 && <span className="small">Applied: {run.applied.join(" ")}</span>}
        {run.proposed.length > 0 && <span className="small">Proposed: {run.proposed.join(" ")}</span>}
        {run.note && <span className="muted small">{run.note}</span>}
      </div>
    </li>
  );
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

function run_now(job: Job): void {
  void attempt(() => calls().run_job_now(job.id), `Started “${job.title}”.`);
}

function remove(job: Job): void {
  confirm_dialog({
    title: `Remove ${job.title}?`,
    message: "It no longer runs. Its runs and its conversation stay; History keeps the job.",
    confirm_label: "Remove",
    danger: true,
    run: async () => void (await succeeds(() => calls().remove_job(job.id))),
  });
}

function job_menu(job: Job) {
  return [
    { label: "Change…", run: () => job_dialog({ job }) },
    { label: "Run now", run: () => run_now(job) },
    { label: "History", run: () => open_item_history("job", job.id, job.title) },
    { label: "Remove…", danger: true, separator_before: true, run: () => remove(job) },
  ];
}

function JobRow({ job, show_context = true }: { job: Job; show_context?: boolean }) {
  const run = job.last_run;
  return (
    <li className="item-row" onContextMenu={(event) => open_context_menu(event, job_menu(job))}>
      <Icon icon={CalendarClock} />
      <div className="item-text">
        <div className="item-title">
          <a href={`#/jobs/${encodeURIComponent(job.id)}`}>{job.title}</a>
          {job.made_by !== "user" && <span className="badge">{job.made_by === "engine" ? "made by the assistant" : "made by a program"}</span>}
        </div>
        <span className="muted item-snippet">{job.instruction}</span>
        <span className="muted small">
          {job.when[0]!.toUpperCase() + job.when.slice(1)}
          {job.only_when_changed ? ", only when something changed" : ""}
          {job.is_on && <span title={stamp(seconds(job.next_due_at))}>{` · next ${until(seconds(job.next_due_at))}`}</span>}
        </span>
        {run ? (
          <span className="small">
            <StateBadge labels={outcome_labels} state={run.outcome} /> Last ran <Age epoch={seconds(run.started_at)} /> on {run.device || "an unknown device"}
          </span>
        ) : (
          <span className="muted small">Not run yet</span>
        )}
        {show_context && job.context_id && (
          <Chips inline>
            <Chip on_click={() => (window.location.hash = context_href(job.context_id!).slice(1))}>{job.context_name}</Chip>
          </Chips>
        )}
      </div>
      <span className="row-actions">
        <Switch label={`${job.title} is on`} checked={job.is_on} on_change={(on) => void succeeds(() => calls().set_job_on(job.id, on))} />
        <button type="button" onClick={() => run_now(job)}>
          Run now
        </button>
        <button type="button" aria-label={`More for ${job.title}`} onClick={(event) => open_context_menu(event, job_menu(job))}>
          <Icon icon={MoreIcon} />
        </button>
      </span>
    </li>
  );
}

// A context's jobs, on its page.
export function ContextJobs({ context_id }: { context_id: string }) {
  const listed = use_data((api) => api.list_jobs(context_id), [context_id]);
  const jobs = listed.data ?? [];
  if (jobs.length === 0) return null;
  return (
    <Section
      title={`Jobs · ${jobs.length}`}
      tools={
        <button type="button" onClick={() => job_dialog({ context_id })}>
          <Icon icon={AddIcon} /> New job
        </button>
      }
    >
      <ul className="item-list">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} show_context={false} />
        ))}
      </ul>
    </Section>
  );
}

// What background work is set to, in a line, with where to change it.
function StateLine({ state }: { state: BackgroundState }) {
  const where = <a href="#/settings">Settings → Assistant → Background work</a>;
  if (!state.enabled) return <p className="muted small">Background work is off, so no job runs. Turn it on under {where}.</p>;
  if (!state.runs_here) return <p className="muted small">Background work is on, but this device does not run it; another of your devices or the server may. {where}.</p>;
  return (
    <p className="muted small">
      Background work runs on this device ({state.device}): {state.runs_today} of {state.daily_runs} runs and {state.tokens_today.toLocaleString()} of {state.daily_tokens.toLocaleString()} tokens today.
    </p>
  );
}

function OneJob({ id }: { id: string }) {
  const job = use_data((api) => api.get_job(id), [id]);
  return (
    <Loaded resource={job}>
      {(found) => (
        <Section title={found.title} tools={<button type="button" onClick={() => job_dialog({ job: found })}>Change…</button>}>
          <ul className="item-list">
            <JobRow job={found} />
          </ul>
          <p className="small">Its runs, newest first:</p>
          {found.runs.length === 0 ? (
            <p className="muted small">It has not run yet.</p>
          ) : (
            <ul className="item-list">
              {found.runs.map((run) => (
                <RunLine key={run.id} run={run} context_id={found.context_id} />
              ))}
            </ul>
          )}
        </Section>
      )}
    </Loaded>
  );
}

export function JobsPage({ focus }: { focus: string | null }) {
  const data = use_data(async (api) => ({ jobs: await api.list_jobs(), state: await api.get_background_state() }));
  return (
    <>
      <PageHeading
        title="Jobs"
        icon={<Icon icon={CalendarClock} />}
        subtitle="The assistant's own recurring work, done with nobody present: only changes you allow in the background are made, and the rest wait in the Inbox. Your own recurring tasks belong in X-Tasks."
        actions={
          <>
            <button type="button" className="icon" aria-label="History" title="History" onClick={() => (window.location.hash = "/history")}>
              <Icon icon={HistoryIcon} />
            </button>
            <button type="button" className="accent solid" onClick={() => job_dialog()}>
              <Icon icon={AddIcon} /> New job
            </button>
          </>
        }
      />
      <Loaded resource={data}>
        {({ jobs, state }) => (
          <>
            <StateLine state={state} />
            {focus && <OneJob key={focus} id={focus} />}
            <Section title={`All jobs · ${jobs.length}`}>
              {jobs.length === 0 ? (
                <Empty title="No jobs yet" hint="Make one here, or ask the assistant in a conversation to do something every so often." />
              ) : (
                <ul className="item-list">
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} />
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </Loaded>
    </>
  );
}
