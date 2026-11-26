// Settings → Assistant: Background work (the pause, the one device that does the work, how often it looks for work and
// whether it may use a hosted engine), Maintenance (each built-in job with its switch, budget, last run, what it did and
// why it last did nothing) and The assistant's jobs (their switch and caps).

// ── Imports ──────────────────────────────────────────────────────────────────

import { NumberField, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";
import { Age } from "@x-tech-laboratories/x-libs/web/react/time";

import { background_settings, type BackgroundState, type JobRun } from "../../shared/jobs/model.ts";
import { budget_bounds, type BudgetName, type MaintenanceJobEntry, type MaintenanceKey } from "../../shared/maintenance/model.ts";
import { calls, page, set_setting, succeeds, use_data } from "../api.ts";

// ── Words ────────────────────────────────────────────────────────────────────

const budget_words: Record<BudgetName, { label: string; unit?: string; hint: string }> = {
  runs_per_day: { label: "Runs a day", hint: "Once they are used, it waits until tomorrow. 0 keeps it from running." },
  items_per_run: { label: "Most in one run", hint: "What is left waits for the next run." },
  seconds_per_run: { label: "Longest run", unit: "seconds", hint: "A run stops here, and the rest waits for the next run." },
  model_calls_per_day: { label: "Model calls a day", hint: "Each round of the model's answer counts as one." },
  tokens_per_day: { label: "Tokens a day", hint: "Read and written by the model, every run together." },
};

// When a run happened, as how long ago.
function When({ at }: { at: string }) {
  return at ? <Age epoch={Date.parse(at) / 1000} /> : <>never</>;
}

// What a run did, in a line.
export function run_words(run: JobRun): string {
  const did = [...run.applied, ...run.proposed];
  if (run.outcome === "error") return `It failed: ${run.note}`;
  if (run.outcome === "gave_way") return `It stopped early. ${run.note}`.trim();
  if (run.outcome === "running") return "It is running now.";
  return [did.length > 0 ? did.join(" ") : "It found nothing to change.", run.note].filter(Boolean).join(" ");
}

// The short state shown beside a job's name.
function status_of(job: MaintenanceJobEntry, state: BackgroundState): string {
  if (!job.on) return "Off";
  if (state.paused) return "Paused";
  if (job.used_up) return "Done for today";
  if (job.where === "chosen" && !job.device) return "No device chosen";
  return "On";
}

// The line under a job's name: its state, where it runs, and what it last did or why it last did nothing.
function JobStatus({ job, state }: { job: MaintenanceJobEntry; state: BackgroundState }) {
  const where = job.where === "every" ? "Every device runs it for its own index." : job.device ? `Runs on ${job.device}.` : "";
  const last = job.last_run;
  const skipped_later = job.skipped_at && (!last || job.skipped_at > last.started_at);
  return (
    <>
      <strong>{status_of(job, state)}.</strong> {where}{" "}
      {skipped_later ? (
        <>
          Last looked <When at={job.skipped_at} />: {job.skip_reason}
        </>
      ) : last ? (
        <>
          Last ran <When at={last.started_at} />: {run_words(last)}
        </>
      ) : (
        "It has not looked for work yet."
      )}
    </>
  );
}

// ── One job ──────────────────────────────────────────────────────────────────

function change_job(key: MaintenanceKey, changes: { on?: boolean; budget?: Partial<Record<BudgetName, number>> }): void {
  void succeeds(() => calls().set_maintenance_job(key, changes));
}

// One job's switch, budget, today's use, last run and last look, read fresh as the dialog opens.
function JobSettings({ job_key }: { job_key: MaintenanceKey }) {
  const listed = use_data((api) => api.list_maintenance_jobs());
  return (
    <Loaded resource={listed} lines={4}>
      {(jobs) => {
        const job = jobs.find((each) => each.key === job_key);
        if (!job) return null;
        const parts = (Object.keys(budget_words) as BudgetName[]).filter((name) => job.uses_model || (name !== "model_calls_per_day" && name !== "tokens_per_day"));
        const used: Partial<Record<BudgetName, number>> = { runs_per_day: job.today.runs, items_per_run: job.today.items, model_calls_per_day: job.today.model_calls, tokens_per_day: job.today.tokens };
        return (
          <>
            <SettingRow label="On" hint={job.uses_model ? "Off until you turn it on, since it calls a model." : "It cannot be removed, only turned off."} as_label>
              <Switch label={`${job.title} on`} checked={job.on} on_change={(on) => change_job(job.key, { on })} />
            </SettingRow>
            {parts.map((name) => {
              const words = budget_words[name];
              const [min, max] = budget_bounds[name];
              const today = name === "items_per_run" ? `Today, ${job.today.items.toLocaleString()} ${job.items} in all.` : name === "seconds_per_run" ? "" : `Today: ${(used[name] ?? 0).toLocaleString()}.`;
              return (
                <SettingRow key={name} label={words.label} hint={`${words.hint} ${today}`.trim()}>
                  <NumberField
                    label={`${job.title}: ${words.label}`}
                    bare
                    min={min}
                    max={max}
                    step={name === "tokens_per_day" ? 1000 : 1}
                    {...(words.unit ? { unit: words.unit } : name === "items_per_run" ? { unit: job.items } : {})}
                    value={job.budget[name]}
                    on_change={(value) => value !== null && change_job(job.key, { budget: { [name]: value } })}
                  />
                </SettingRow>
              );
            })}
            <SettingRow label="Last run" hint={job.last_run ? run_words(job.last_run) : "It has not run yet."}>
              <span className="muted small">{job.last_run ? <When at={job.last_run.started_at} /> : "Never"}</span>
            </SettingRow>
            <SettingRow label="Last time it did nothing" hint={job.skip_reason || "It has not skipped a look yet."}>
              <span className="muted small">{job.skipped_at ? <When at={job.skipped_at} /> : "Never"}</span>
            </SettingRow>
            <p className="muted small">
              It looked {job.skips_today.toLocaleString()} {job.skips_today === 1 ? "time" : "times"} today and found nothing to do; those looks make no model call and keep no record but this count.
            </p>
          </>
        );
      }}
    </Loaded>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

function device_label(state: BackgroundState, id: string, name: string, kind: string): string {
  return `${name} (${kind === "server" ? "server" : "desktop"}${id === state.device_id ? ", this one" : ""})`;
}

function BackgroundRows() {
  const state = use_data((api) => api.get_background_state());
  const now = state.data;
  if (!now) return null;
  const here = page().host === "web" ? "the server" : "this device";
  const chosen = now.devices.find((device) => device.id === now.chosen_device);
  return (
    <>
      <SettingRow label="Pause background work" hint="Stops the maintenance jobs and the assistant's jobs at their next safe point, on every device, until you turn it off." as_label>
        <Switch label="Pause background work" checked={now.paused} on_change={(on) => void succeeds(() => set_setting(background_settings.paused, on))} />
      </SettingRow>
      <SettingRow
        label="Device that does it"
        hint={`Only this device asks your apps what changed, keeps the graph tidy, suggests links, writes the digest and runs the assistant's jobs; the others do none of it. Every device keeps its own search index. ${chosen ? "" : "No device is chosen yet. "}This page talks to ${here}.`}
      >
        {now.devices.length === 0 ? (
          <span className="muted small">No desktop app or server has started yet.</span>
        ) : (
          <Select
            label="Device that does it"
            bare
            options={[...(chosen ? [] : [["", "None yet"] as [string, string]]), ...now.devices.map((device): [string, string] => [device.id, device_label(now, device.id, device.name, device.kind)])]}
            value={now.chosen_device}
            on_change={(id) => id && void succeeds(() => calls().set_background_device(id))}
          />
        )}
      </SettingRow>
      <SettingRow label="Look for work every" hint="Each look asks every job whether anything changed, without calling a model or any app, and runs only those with work.">
        <NumberField label="Look for work every" bare unit="minutes" min={5} max={1440} value={now.tick_minutes} on_change={(value) => void succeeds(() => set_setting(background_settings.tick_minutes, value ?? 30))} />
      </SettingRow>
      <SettingRow
        label="Background work may use a hosted engine"
        hint="Off, background work uses only an engine on this computer or your own network, and Suggest links waits, saying why, when there is none. On, the per-source marks and the log of what hosted engines were sent still apply."
        as_label
      >
        <Switch label="Background work may use a hosted engine" checked={now.hosted_allowed} on_change={(on) => void succeeds(() => set_setting(background_settings.hosted, on))} />
      </SettingRow>
    </>
  );
}

function MaintenanceRows() {
  const state = use_data((api) => api.get_background_state());
  const jobs = use_data((api) => api.list_maintenance_jobs());
  const now = state.data;
  if (!now) return null;
  return (
    <Loaded resource={jobs} lines={3}>
      {(entries) =>
        entries.map((job) => (
          <SettingsDialogRow key={job.key} name={job.title} status={<JobStatus job={job} state={now} />} about={job.about}>
            <JobSettings job_key={job.key} />
          </SettingsDialogRow>
        ))
      }
    </Loaded>
  );
}

function AssistantJobRows() {
  const state = use_data((api) => api.get_background_state());
  const now = state.data;
  if (!now) return null;
  return (
    <>
      <SettingRow label="The assistant's jobs" hint="Lets the jobs the assistant made with you run on their schedules with nobody present. Off, none of them runs." as_label>
        <Switch label="The assistant's jobs" checked={now.enabled} on_change={(on) => void succeeds(() => set_setting(background_settings.enabled, on))} />
      </SettingRow>
      <SettingRow label="Runs a day" hint={`The assistant's jobs together, on every device. Today: ${now.runs_today}.`}>
        <NumberField label="Runs a day" bare min={0} value={now.daily_runs} on_change={(value) => void succeeds(() => set_setting(background_settings.daily_runs, value ?? 24))} />
      </SettingRow>
      <SettingRow label="Tokens a day" hint={`Read and written by the assistant's jobs' runs together. Today: ${now.tokens_today.toLocaleString()}.`}>
        <NumberField label="Tokens a day" bare min={0} step={1000} value={now.daily_tokens} on_change={(value) => void succeeds(() => set_setting(background_settings.daily_tokens, value ?? 200_000))} />
      </SettingRow>
    </>
  );
}

export const background_section: SettingsSection = {
  id: "background",
  heading: "Background work",
  hint: "Work done with nobody present: CODEX's own upkeep, and the jobs the assistant made with you. Only changes set to “Allowed, even in the background” are made; the rest wait in the Inbox.",
  content: <BackgroundRows />,
};

export const maintenance_section: SettingsSection = {
  id: "maintenance",
  heading: "Maintenance",
  hint: "CODEX's own upkeep, built in, so it can be turned off but not removed. Each job looks for work at every look and runs only when something changed, within its budget.",
  content: <MaintenanceRows />,
};

export const assistant_jobs_section: SettingsSection = {
  id: "assistant-jobs",
  heading: "The assistant's jobs",
  hint: "The jobs the assistant made with you, under Jobs, each with limits of its own; these caps hold for all of them together.",
  content: <AssistantJobRows />,
};
