// Settings → Assistant → Mood: whether the assistant has a mood, whether it colours replies, the mood now and why, and
// the dates it remembers each year.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";

import { Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { FormRow, SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { date_kind_words, date_kinds, mood_settings, type DateKind, type DateToRemember } from "../../shared/mood/model.ts";
import { calls, set_setting, succeeds, use_data } from "../api.ts";
import { mood_summary } from "../assistant/mascot.ts";

// ── Dates ────────────────────────────────────────────────────────────────────

const kind_options = date_kinds.map((kind): [DateKind, string] => [kind, date_kind_words[kind]]);

// A month and day as words, such as 27 November.
export function day_words(day: string): string {
  const [month, date] = day.split("-").map(Number);
  return new Date(2024, (month ?? 1) - 1, date ?? 1).toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

function AddDate({ dates }: { dates: DateToRemember[] }) {
  const [day, set_day] = useState("");
  const [label, set_label] = useState("");
  const [kind, set_kind] = useState<DateKind>("birthday");
  const add = async (event: FormEvent) => {
    event.preventDefault();
    // A date field gives a whole date; only its month and day are kept.
    const added = await succeeds(() => calls().set_mood_dates([...dates, { day: day.slice(5), label, kind }]), `${label.trim()} added.`);
    if (added) {
      set_day("");
      set_label("");
    }
  };
  return (
    <form onSubmit={(event) => void add(event)} className="mood-add-date">
      <FormRow label="Day" id="mood-date-day" hint="Only the month and day are kept; it comes round each year.">
        <input id="mood-date-day" type="date" value={day} onChange={(event) => set_day(event.target.value)} required />
      </FormRow>
      <FormRow label="What it is" id="mood-date-label">
        <input id="mood-date-label" value={label} placeholder="My birthday" onChange={(event) => set_label(event.target.value)} required />
      </FormRow>
      <FormRow label="Kind" id="mood-date-kind">
        <Select id="mood-date-kind" label="Kind" bare options={kind_options} value={kind} on_change={set_kind} />
      </FormRow>
      <SettingRow label="Add the date" hint="The assistant's face shows it all that day.">
        <button type="submit">Add</button>
      </SettingRow>
    </form>
  );
}

function DateRows() {
  const dates = use_data((api) => api.list_mood_dates());
  return (
    <Loaded resource={dates} lines={1}>
      {(list) => (
        <>
          {list.map((date, index) => (
            <SettingRow key={`${date.day}-${date.label}`} label={`${day_words(date.day)}: ${date.label}`} hint={date_kind_words[date.kind]}>
              <button type="button" onClick={() => void succeeds(() => calls().set_mood_dates(list.filter((_, at) => at !== index)))}>Remove</button>
            </SettingRow>
          ))}
          <AddDate dates={list} />
        </>
      )}
    </Loaded>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

function MoodRows({ settings }: { settings: Record<string, unknown> }) {
  const state = use_data((api) => api.get_mood());
  const enabled = settings[mood_settings.enabled] !== false;
  const tone = settings[mood_settings.tone] !== false;
  return (
    <>
      <SettingRow label="Mood" hint="Off, the face stays neutral, showing only when the assistant is thinking." as_label>
        <Switch label="Mood" checked={enabled} on_change={(on) => void succeeds(() => set_setting(mood_settings.enabled, on))} />
      </SettingRow>
      <SettingRow label="Mood colours the tone of replies" hint="On, the assistant is told its mood and why, to colour its tone only; never a fact, an assessment or what it may do." as_label>
        <Switch label="Mood colours the tone of replies" checked={tone} disabled={!enabled} on_change={(on) => void succeeds(() => set_setting(mood_settings.tone, on))} />
      </SettingRow>
      <SettingRow label="Now" hint={state.data ? mood_summary(state.data) : ""}>
        <span className="muted small">{state.data && state.data.enabled && state.data.mood !== "neutral" ? `${Math.round(state.data.strength * 100)}% strong` : ""}</span>
      </SettingRow>
      <h4>Dates to remember</h4>
      <DateRows />
    </>
  );
}

export function mood_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "mood",
    heading: "Mood",
    hint: "The assistant's face can show a small mood: celebrating your birthday, sad with you about a loss, curious when background work finds something, mildly concerned when a job fails. A reply's mood fades within the hour or two and a date's lasts its day; it never changes what the assistant may do, and never sends you anything.",
    content: <MoodRows settings={settings} />,
  };
}
