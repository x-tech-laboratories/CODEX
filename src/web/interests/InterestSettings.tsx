// Settings → Assistant → Interests: the topics the assistant may research on the web for its own knowledge, each with
// its state and what can be done with it, a row to add one, and the most accepted at once. Accepting shows the exact
// text sent to a search engine, which the user may edit first.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";

import { NumberField } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { interest_settings, longest_topic, max_accepted_bounds, type Interest, type InterestState } from "../../shared/interests/model.ts";
import { calls, data_watch, succeeds, use_data } from "../api.ts";

// ── Words ────────────────────────────────────────────────────────────────────

export const state_words: Record<InterestState, string> = {
  proposed: "Proposed, waiting for you",
  accepted: "Accepted",
  paused: "Paused",
  dropped: "Dropped",
};

const state_tones: Record<InterestState, string> = { proposed: "warn", accepted: "good", paused: "none", dropped: "none" };

// Who made it and where from, with its findings, in plain words.
export function interest_hint(interest: Interest): string {
  const by = interest.made_by === "user" ? "You added it." : interest.made_by === "engine" ? `The assistant proposed it${interest.conversation_title ? ` in “${interest.conversation_title}”` : ""}.` : "A program proposed it.";
  const findings = interest.findings === 0 ? "" : ` ${interest.findings} ${interest.findings === 1 ? "finding" : "findings"}.`;
  return `${by}${interest.reason ? ` ${interest.reason}` : ""}${findings}`;
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

const sent_words = "Once accepted, the Research interests job sends exactly this text to the search engine named in the Web plugin's settings and reads the public pages it finds. Edit it so it holds nothing personal: no names, places, numbers or what a note says.";

function TopicDialog({ interest, on_close }: { interest: Interest | null; on_close: () => void }) {
  const [topic, set_topic] = useState(interest?.topic ?? "");
  const [reason, set_reason] = useState("");
  const [busy, set_busy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    set_busy(true);
    const done = await succeeds(() => (interest ? calls().accept_interest(interest.id, topic) : calls().add_interest(topic, reason)), interest ? "Accepted." : "Added.");
    set_busy(false);
    if (done) {
      data_watch.bump();
      on_close();
    }
  };
  return (
    <Dialog
      title={interest ? "Accept this interest?" : "Add an interest"}
      subtitle={sent_words}
      on_close={on_close}
      form={{ on_submit: (event) => void submit(event), submit_label: interest ? "Accept" : "Add", submit_disabled: busy || !topic.trim() }}
    >
      <FormRow label="Topic sent to the search engine" id="interest-topic" hint={`At most ${longest_topic} characters.`}>
        <input id="interest-topic" value={topic} maxLength={longest_topic} onChange={(event) => set_topic(event.target.value)} />
      </FormRow>
      {interest ? (
        interest.reason && <p className="muted small">Why the assistant proposed it: {interest.reason}</p>
      ) : (
        <FormRow label="Why" id="interest-reason" hint="For you and the assistant; it is never sent to the search engine.">
          <input id="interest-reason" value={reason} onChange={(event) => set_reason(event.target.value)} />
        </FormRow>
      )}
    </Dialog>
  );
}

export function open_topic_dialog(interest: Interest | null): void {
  open_dialog((close) => <TopicDialog interest={interest} on_close={close} />);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function set_state(interest: Interest, state: "paused" | "dropped" | "proposed"): void {
  void succeeds(() => calls().set_interest_state(interest.id, state)).then(() => data_watch.bump());
}

function InterestRow({ interest }: { interest: Interest }) {
  return (
    <SettingRow
      label={
        <span className="policy-label">
          {interest.topic}
          <span className={`badge tone-${state_tones[interest.state]}`}>{state_words[interest.state]}</span>
        </span>
      }
      hint={interest_hint(interest)}
    >
      <span className="interest-actions">
        {interest.context_id && <a href={`#/context/${interest.context_id}`}>Findings</a>}
        {interest.state !== "accepted" && <button type="button" onClick={() => open_topic_dialog(interest)}>Accept…</button>}
        {interest.state === "accepted" && <button type="button" onClick={() => set_state(interest, "paused")}>Pause</button>}
        {interest.state !== "dropped" && <button type="button" onClick={() => set_state(interest, "dropped")}>Drop</button>}
      </span>
    </SettingRow>
  );
}

function InterestRows({ settings }: { settings: Record<string, unknown> }) {
  const listed = use_data((api) => api.list_interests());
  const most = Number(settings[interest_settings.max_accepted] ?? 5);
  return (
    <>
      <Loaded resource={listed} lines={2}>
        {(interests) => (interests.length === 0 ? <p className="muted small">None yet. The assistant proposes one when a conversation shows a topic you care about.</p> : interests.map((interest) => <InterestRow key={interest.id} interest={interest} />))}
      </Loaded>
      <SettingRow label="Add an interest" hint="A topic of your own for the assistant to research; you see the exact text first.">
        <button type="button" onClick={() => open_topic_dialog(null)}>Add an interest…</button>
      </SettingRow>
      <SettingRow label="Most accepted at once" hint="Accepting one more asks you to pause or drop one first.">
        <NumberField label="Most accepted at once" bare min={max_accepted_bounds[0]} max={max_accepted_bounds[1]} value={most} on_change={(value) => value !== null && void succeeds(() => calls().set_max_interests(value))} />
      </SettingRow>
    </>
  );
}

export function interests_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "interests",
    heading: "Interests",
    hint: "Topics the assistant may read about on the public web for its own knowledge, when Research interests is on under Background work. It only proposes them; nothing is searched until you accept the exact text. What it finds is kept in a context of its own, The assistant's interests, where you can read, move or remove it.",
    content: <InterestRows settings={settings} />,
  };
}
