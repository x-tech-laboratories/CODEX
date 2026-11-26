// Privacy and trust by source: each collector plugin's two marks, shown in its row under Plugins, and the log of what
// hosted engines were sent, under Assistant.

// ── Imports ──────────────────────────────────────────────────────────────────

import { NumberField, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { EventsList } from "@x-tech-laboratories/x-libs/web/react/events_list";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { HostedSend, MarkName, SourceCount, SourceMark } from "../../shared/privacy/model.ts";
import { attempt, calls, use_data, use_settings } from "../api.ts";

// ── Marks ────────────────────────────────────────────────────────────────────

export const mark_words: Record<MarkName, { label: string; hint: string }> = {
  send_to_hosted: {
    label: "May be sent to a hosted engine",
    hint: "Its items, titles included, may go to an engine a company runs on its own servers, such as Anthropic. Off, a hosted engine is told only how many items were left out. An engine on this computer or your own network always sees them.",
  },
  trusted: {
    label: "Trusted content",
    hint: "What this app holds is yours and carries no one else's instructions. Off, once the assistant reads one of its items, every change it asks for waits for your approval. Either way the model reads it as data, never as orders.",
  },
};

// A collector plugin's two marks, both off until turned on.
export function SourceMarks({ plugin_id }: { plugin_id: string }) {
  const settings = use_settings();
  return (
    <Loaded resource={settings} lines={2}>
      {(values) => {
        const marks = ((values.source_marks ?? {}) as Record<string, Partial<SourceMark>>)[plugin_id] ?? {};
        return (Object.keys(mark_words) as MarkName[]).map((mark) => (
          <SettingRow key={mark} label={mark_words[mark].label} hint={mark_words[mark].hint} as_label>
            <Switch label={mark_words[mark].label} checked={marks[mark] === true} on_change={(on) => void attempt(() => calls().set_source_mark(plugin_id, mark, on))} />
          </SettingRow>
        ));
      }}
    </Loaded>
  );
}

// ── Log ──────────────────────────────────────────────────────────────────────

function counts_words(counts: SourceCount[]): string {
  return counts.map((each) => `${each.count} from ${each.label}`).join(", ");
}

// One run in words, such as "Anthropic, claude-opus-5-5: 3 items (2 from X-Tasks, 1 from Files); 4 withheld (4 from Trilium)".
export function send_words(send: HostedSend): string {
  const sent = send.item_count === 0 ? "no items" : `${send.item_count} ${send.item_count === 1 ? "item" : "items"} (${counts_words(send.included)})`;
  const withheld_total = send.withheld.reduce((sum, each) => sum + each.count, 0);
  const withheld = withheld_total > 0 ? `; ${withheld_total} withheld (${counts_words(send.withheld)})` : "";
  return `${send.engine}${send.model ? `, ${send.model}` : ""}: ${sent}${withheld}`;
}

function SendLog() {
  const sends = use_data((api) => api.list_hosted_sends(100));
  return (
    <Loaded resource={sends}>
      {(entries) => (
        <EventsList
          events={entries.map((send) => ({ epoch: Date.parse(send.sent_at) / 1000, level: "info", message: send_words(send), id: send.id }))}
          row_key={(event) => event.id}
          empty="No reply has been written by a hosted engine yet."
        />
      )}
    </Loaded>
  );
}

export function hosted_log_section(settings: Record<string, unknown>, set_setting: (key: string, value: unknown) => Promise<void>): SettingsSection {
  return {
    id: "hosted-log",
    heading: "Sent to hosted engines",
    hint: "Each reply written by a hosted engine, with how many items of each source it was sent and how many were withheld; never the items themselves. Engines on this computer or your own network are not listed.",
    content: (
      <>
        <SettingRow label="Keep the log for" hint="Older entries are let go as new ones are written.">
          <NumberField label="Keep the log for" bare unit="days" min={1} value={Number(settings["hosted_log.keep_days"])} on_change={(days) => void set_setting("hosted_log.keep_days", days ?? 90)} />
        </SettingRow>
        <SendLog />
      </>
    ),
  };
}

