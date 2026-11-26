// The tool plugins' settings: in each tool plugin's row under Plugins, its three marks and each tool, whether it is
// offered and whether small models are offered it too; under Action policy, the level of each tool that changes something.

// ── Imports ──────────────────────────────────────────────────────────────────

import { Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { PolicyLevel } from "../../shared/policy/model.ts";
import type { PluginToolEntry, ToolMarkName, ToolPluginEntry } from "../../shared/tools/model.ts";
import { attempt, calls, use_data } from "../api.ts";
import { level_words } from "../assistant/AssistantSettings.tsx";

// ── Marks ────────────────────────────────────────────────────────────────────

export const tool_mark_words: Record<ToolMarkName, { label: string; hint: string }> = {
  send_to_hosted: {
    label: "May be sent to a hosted engine",
    hint: "What its tools give back may go to an engine that is not on this computer or your own network. Off, such an engine is not offered its tools at all, since what they give back would be kept from it, and earlier answers that used them are kept from it too. On to begin with only for Web, which reads public pages; off for every other plugin and MCP server until you turn it on, since a server behind a token may give back what is private to you.",
  },
  trusted: {
    label: "Trusted content",
    hint: "What its tools give back carries no one else's instructions. Off, once the assistant uses one of its tools, every change it asks for waits for your approval. Either way the model reads it as data, never as orders.",
  },
  after_private: {
    label: "May be used after reading private sources",
    hint: "Its tools that send what they are given outside this computer may still be used once the conversation has read something from a source or tool plugin not marked “May be sent to a hosted engine”. Off, they are refused from then on for that reply, so nothing private can leave through them.",
  },
};

// What a tool does that the user cares about, in a few words.
export function tool_facts(tool: Pick<PluginToolEntry, "changes" | "sends_outside">): string {
  const facts = [tool.changes ? "changes something" : "only reads", tool.sends_outside ? "sends what it is given outside this computer" : "stays on this computer"];
  return `It ${facts.join(" and ")}.`;
}

// A tool plugin's marks and each of its tools, with an on switch and the switch offering it to small models.
export function ToolRows({ entry }: { entry: ToolPluginEntry }) {
  return (
    <>
      {entry.problem && <p className="muted small">Its tools could not be listed: {entry.problem}</p>}
      {(Object.keys(tool_mark_words) as ToolMarkName[]).map((mark) => (
        <SettingRow key={mark} label={tool_mark_words[mark].label} hint={tool_mark_words[mark].hint} as_label>
          <Switch label={tool_mark_words[mark].label} checked={entry[mark]} on_change={(on) => void attempt(() => calls().set_tool_plugin_mark(entry.key, mark, on))} />
        </SettingRow>
      ))}
      {entry.tools.length === 0 && !entry.problem && <p className="muted small">It offers no tools as it is set up now.</p>}
      {entry.tools.map((tool) => (
        <div key={tool.name}>
          <SettingRow label={tool.tool} hint={`${tool.description} ${tool_facts(tool)}`} as_label>
            <Switch label={`Offer ${tool.tool}`} checked={tool.enabled} on_change={(on) => void attempt(() => calls().set_plugin_tool_offer(entry.key, tool.tool, "enabled", on))} />
          </SettingRow>
          <SettingRow label="Also offer to small models" hint="Models with a small context are offered only CODEX's core tools unless you tick this." as_label>
            <Switch label={`Also offer ${tool.tool} to small models`} checked={tool.small} disabled={!tool.enabled} on_change={(on) => void attempt(() => calls().set_plugin_tool_offer(entry.key, tool.tool, "small", on))} />
          </SettingRow>
        </div>
      ))}
    </>
  );
}

// A tool plugin's marks and tools, in its row under Plugins; a plugin providing several, such as one per server, shows each under its label.
export function ToolPluginSettings({ plugin_id }: { plugin_id: string }) {
  const listed = use_data((api) => api.list_plugin_tools());
  return (
    <Loaded resource={listed} lines={2}>
      {(entries) => {
        const own = entries.filter((entry) => entry.plugin_id === plugin_id);
        if (own.length === 0) return <p className="muted small">Turn it on to see its tools.</p>;
        return own.map((entry) =>
          own.length === 1 ? (
            <ToolRows key={entry.key} entry={entry} />
          ) : (
            <section key={entry.key}>
              <h3>{entry.label}</h3>
              <ToolRows entry={entry} />
            </section>
          ),
        );
      }}
    </Loaded>
  );
}

// A row for each tool plugin the page has no manifest of, such as one from the plugins folder, holding its marks and tools.
export function OtherToolPluginRows({ known }: { known: ReadonlySet<string> }) {
  const listed = use_data((api) => api.list_plugin_tools());
  return (
    <Loaded resource={listed} lines={1}>
      {(entries) =>
        entries
          .filter((entry) => !known.has(entry.plugin_id))
          .map((entry) => (
            <SettingsDialogRow key={entry.key} name={entry.label} status={entry.problem ? "Not running" : "On"} about={`Tools from the plugin ${entry.plugin_id}.`}>
              <ToolRows entry={entry} />
            </SettingsDialogRow>
          ))
      }
    </Loaded>
  );
}

// ── Levels ───────────────────────────────────────────────────────────────────

const riskier: Partial<Record<PolicyLevel, string>> = { auto: "warn", background: "bad" };

// A level row for each plugin tool that changes something, beside CODEX's own under Action policy.
export function PluginToolLevels() {
  const listed = use_data((api) => api.list_plugin_tools());
  return (
    <Loaded resource={listed} lines={1}>
      {(entries) =>
        entries.flatMap((entry) =>
          entry.tools
            .filter((tool) => tool.level !== null)
            .map((tool) => {
              const level = tool.level!;
              const tone = riskier[level];
              const label = `${entry.label}: ${tool.tool}`;
              return (
                <SettingRow
                  key={tool.name}
                  label={
                    <span className="policy-label">
                      {label}
                      <span className="badge tone-none">plugin</span>
                      {tool.sends_outside && <span className="badge tone-none">sends outside</span>}
                      {tone && <span className={`badge tone-${tone}`}>{level === "background" ? "most risky" : "risky"}</span>}
                    </span>
                  }
                  hint={`${tool.description}${tool.enabled ? "" : " Turned off under Plugins."}`}
                >
                  <Select
                    label={label}
                    bare
                    options={(Object.keys(level_words) as PolicyLevel[]).map((each): [PolicyLevel, string] => [each, level_words[each]])}
                    value={level}
                    on_change={(chosen) => void attempt(() => calls().set_plugin_tool_level(tool.name, chosen))}
                  />
                </SettingRow>
              );
            }),
        )
      }
    </Loaded>
  );
}
