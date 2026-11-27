// The user's guidance for one tool plugin's or source app's specialist, in its row under Plugins: Markdown saved a
// moment after typing stops and when the field is left, synced like the plugins' other settings.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useRef } from "react";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { RichText } from "@x-tech-laboratories/x-libs/web/react/rich_text";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { guidance_in, guidance_setting, longest_guidance } from "../../shared/guidance/model.ts";
import { calls, succeeds, use_data, use_settings } from "../api.ts";

// ── Field ────────────────────────────────────────────────────────────────────

const save_delay_ms = 800;

export const guidance_hint = `How this app works and how you want it used, in your own words, up to ${longest_guidance.toLocaleString("en")} characters. The assistant's specialist for it is given it whole, after what the plugin or server says of itself, and yours holds where they differ; the conversation asking it is given the start.`;

function Field({ source, label, stored }: { source: string; label: string; stored: string }) {
  const typed = useRef(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = () => {
    clearTimeout(timer.current);
    if (typed.current !== stored) void succeeds(() => calls().set_plugin_guidance(source, typed.current));
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <SettingRow label={label} hint={guidance_hint}>
      <RichText
        label={label}
        placeholder="Such as: tasks tagged Someday are not due; search by project name first."
        value={stored}
        on_change={(markdown) => {
          typed.current = markdown;
          clearTimeout(timer.current);
          timer.current = setTimeout(save, save_delay_ms);
        }}
        on_blur={save}
      />
    </SettingRow>
  );
}

// The guidance for one source, by the source the run counts it as: a collector's id or tool: and a tool plugin's key.
export function GuidanceField({ source, label = "Guidance for its specialist" }: { source: string; label?: string }) {
  const settings = use_settings();
  return <Loaded resource={settings} lines={2}>{(values) => <Field source={source} label={label} stored={guidance_in(values[guidance_setting], source)} />}</Loaded>;
}

// A guidance field for each source app a collector plugin provides that the assistant can read.
export function CollectorGuidance({ plugin_id }: { plugin_id: string }) {
  const collectors = use_data((api) => api.list_collectors());
  return (
    <Loaded resource={collectors} lines={1}>
      {(all) => {
        const own = all.filter((each) => each.plugin_id === plugin_id && (each.can_search || each.can_refresh || each.can_follow));
        return own.map((each) => <GuidanceField key={each.id} source={each.id} label={own.length === 1 ? "Guidance for its specialist" : `Guidance for the ${each.label} specialist`} />);
      }}
    </Loaded>
  );
}
