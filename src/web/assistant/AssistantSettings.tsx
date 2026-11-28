// The assistant's settings: which engine answers, each engine's own settings, and how freely it may change things.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingRow, type SettingsSection } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { keep_thinking_setting } from "../../shared/conversations/model.ts";
import type { PolicyEntry, PolicyLevel } from "../../shared/policy/model.ts";
import { attempt, calls, set_setting, succeeds, use_data } from "../api.ts";
import { use_declared } from "../declared/declared.tsx";
import { EngineRows } from "../plugins/plugins.tsx";
import { PluginToolLevels } from "../tools/ToolSettings.tsx";

// ── Engine ───────────────────────────────────────────────────────────────────

// The engine chosen here, else the one this computer's configuration starts with; either can be changed at any time.
function EngineChoice({ stored }: { stored: string }) {
  const status = use_data((api) => api.get_assistant_status());
  const declared = use_declared().engine;
  const chosen = stored || (declared ?? "");
  const starting = declared && !stored ? " This computer's configuration starts with it; choosing another here holds over it." : "";
  return (
    <Loaded resource={status} lines={1}>
      {({ engines }) => {
        const options: [string, string][] = [["", "None"], ...engines.map((engine): [string, string] => [engine.id, engine.label])];
        const answering = engines.find((engine) => engine.id === chosen);
        const where = answering ? (answering.is_local ? " It is local: it is sent every source's items." : " It is hosted: it is sent only the items of sources marked “May be sent to a hosted engine” under Plugins.") : "";
        // A chosen engine that is not running stays listed, so the choice is not lost while its plugin is off.
        if (chosen && !engines.some((engine) => engine.id === chosen)) options.push([chosen, `${chosen} (not running)`]);
        return (
          <SettingRow label="Answering" hint={`The engine that writes the assistant's replies. Each engine's model, address and key command are set in its own row below.${where}${starting}`}>
            <Select label="Answering" bare options={options} value={chosen} on_change={(engine) => void set_setting("engine", engine)} />
          </SettingRow>
        );
      }}
    </Loaded>
  );
}

// Whether each reply keeps its model's thinking; off, the thinking still shows while the reply is written.
function KeepThinking({ on }: { on: boolean }) {
  return (
    <SettingRow label="Keep thinking" hint="Keeps a reasoning model's thinking with each reply, folded under Thinking where it happened, and syncs it with the conversation. It is never sent back to the model. Off, the thinking shows only while the reply is written." as_label>
      <Switch label="Keep thinking" checked={on} on_change={(next) => void succeeds(() => set_setting(keep_thinking_setting, next))} />
    </SettingRow>
  );
}

export function engine_section(settings: Record<string, unknown>): SettingsSection {
  return {
    id: "engine",
    heading: "Engine",
    hint: "The assistant answers with a model through an engine. Its key is read from a command each time it answers, and never stored.",
    content: (
      <>
        <EngineChoice stored={String(settings.engine ?? "")} />
        <KeepThinking on={settings[keep_thinking_setting] !== false} />
        <EngineRows />
      </>
    ),
  };
}

// ── Action policy ────────────────────────────────────────────────────────────

export const level_words: Record<PolicyLevel, string> = {
  restricted: "Never",
  proposal: "Ask me first",
  auto: "Allowed while I'm in the conversation",
  background: "Allowed, even in the background",
};

// The two levels that let the assistant change things without asking.
const riskier: Partial<Record<PolicyLevel, string>> = { auto: "warn", background: "bad" };

// A call's name in words, such as "Rename context" for rename_context.
export function call_words(method: string): string {
  const words = method.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function PolicyRow({ entry }: { entry: PolicyEntry }) {
  const tone = riskier[entry.level];
  const label = call_words(entry.method);
  return (
    <SettingRow
      label={
        <span className="policy-label">
          {label}
          {entry.destructive && <span className="badge tone-none">deletes</span>}
          {tone && <span className={`badge tone-${tone}`}>{entry.level === "background" ? "most risky" : "risky"}</span>}
        </span>
      }
      hint={entry.description}
    >
      <Select
        label={label}
        bare
        options={(Object.keys(level_words) as PolicyLevel[]).map((level): [PolicyLevel, string] => [level, level_words[level]])}
        value={entry.level}
        on_change={(level) => void attempt(() => calls().set_action_level(entry.method, level))}
      />
    </SettingRow>
  );
}

function PolicyRows() {
  const policy = use_data((api) => api.get_action_policy());
  return (
    <>
      <Loaded resource={policy}>{(entries) => entries.map((entry) => <PolicyRow key={entry.method} entry={entry} />)}</Loaded>
      <PluginToolLevels />
    </>
  );
}

export const policy_section: SettingsSection = {
  id: "action-policy",
  heading: "Action policy",
  hint: "How freely the assistant may make each kind of change. Ask me first keeps the change in the conversation until you approve it. Once a reply has read text from another app, such as a search or an item's title, every change it asks for waits for you, whatever its level. Tools from plugins that change something are listed after CODEX's own; one that only reads runs at once.",
  content: <PolicyRows />,
};
