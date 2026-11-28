// What this computer's configuration declares, as Settings shows it: each declared plugin's settings, the engine and
// embedder it chose and its MCP servers, all read-only, since they are changed where the configuration is written.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { PluginManifest, SettingField } from "@x-tech-laboratories/x-libs/plugins";
import { SettingsDialogRow } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { declared_words, type DeclaredServerSummary, type DeclaredSummary } from "../shared/declared/model.ts";
import { attempt, calls, use_data } from "./api.ts";
import { engine_manifests } from "../shared/engines/manifests.ts";
import { DeclaredModelRow } from "./engines/ModelPicker.tsx";
import { ToolRows } from "./tools/ToolSettings.tsx";

// ── Data ─────────────────────────────────────────────────────────────────────

const nothing_declared: DeclaredSummary = {
  plugins: [],
  engine: null,
  embedder: null,
  mcp_servers: [],
  problems: [],
};

// The declarations, or none while they load or where the host has none to give.
export function use_declared(): DeclaredSummary {
  const declared = use_data(async (api) => {
    try {
      return await api.get_declared_config();
    } catch {
      return nothing_declared;
    }
  });
  return declared.data ?? nothing_declared;
}

// ── A plugin ─────────────────────────────────────────────────────────────────

// A declared field's value in words; a secret only says that it is read from a file.
export function declared_value(field: SettingField, value: unknown): string {
  if (field.type === "switch") return value ? "On" : "Off";
  if (field.type === "choice") return field.choices.find((choice) => choice.value === value)?.label ?? String(value);
  return String(value) || "Empty";
}

function Problems({ problems }: { problems: string[] }) {
  return problems.length === 0 ? null : (
    <ul>
      {problems.map((problem) => (
        <li key={problem} className="tone-bad">
          {problem}
        </li>
      ))}
    </ul>
  );
}

const is_engine = (manifest: PluginManifest) => engine_manifests.some((each) => each.id === manifest.id);

// The declared plugin's settings in place of its controls, with the problems found in them; a declared engine's model
// is only its default, so it stays a choice.
export function DeclaredPluginSettings({ manifest, declared }: { manifest: PluginManifest; declared: DeclaredSummary["plugins"][number] }) {
  const fields = manifest.settings ?? [];
  return (
    <>
      <p className="muted small">{declared_words}: it is on, and these are changed there rather than here{is_engine(manifest) ? ", but for the model, which you can choose on this device" : ""}.</p>
      {fields
        .filter((field) => Object.hasOwn(declared.settings, field.key))
        .map((field) =>
          field.key === "model" && is_engine(manifest) ? (
            <DeclaredModelRow key={field.key} plugin_id={manifest.id} field={field} />
          ) : (
            <SettingRow key={field.key} label={field.label} hint={field.hint}>
              <span>{declared_value(field, declared.settings[field.key])}</span>
            </SettingRow>
          ),
        )}
      {fields
        .filter((field) => declared.secret_fields.includes(field.key))
        .map((field) => (
          <SettingRow key={field.key} label={field.label} hint="Read from a file each time it is needed, and never kept.">
            <span>From a file</span>
          </SettingRow>
        ))}
      {declared.has_key_file && (
        <SettingRow label="API key" hint="Read from a file each time it is needed, and never kept.">
          <span>From a file</span>
        </SettingRow>
      )}
      <Problems problems={declared.problems} />
    </>
  );
}

// ── Choices ──────────────────────────────────────────────────────────────────

// A choice the configuration made, such as the engine that answers, shown in place of its control.
export function DeclaredChoice({ label, value }: { label: string; value: string }) {
  return (
    <SettingRow label={label} hint={`${declared_words}, so it is changed there rather than here.`}>
      <span>{value}</span>
    </SettingRow>
  );
}

// ── MCP servers ──────────────────────────────────────────────────────────────

function DeclaredServerBody({ server }: { server: DeclaredServerSummary }) {
  const listed = use_data((api) => api.list_plugin_tools(), [server.listed_at]);
  const refresh = () => void attempt(() => calls().refresh_declared_mcp_server(server.id), "Its tools were listed again.");
  return (
    <>
      <p className="muted small">{declared_words}: it is on, and how it is reached is changed there rather than here.</p>
      <SettingRow
        label={server.transport === "http" ? "Address" : "Command"}
        hint={server.has_token_file ? "Its token is read from a file each time it connects, and never kept." : "It sends no token."}
      >
        <span>{server.transport === "http" ? server.address : [server.command, ...server.args].join(" ")}</span>
      </SettingRow>
      {server.collector ? (
        <SettingRow label="Collector" hint="Its tools are given to this collector's specialist, which the assistant asks for this app, rather than to a specialist of their own.">
          <span>{server.collector}</span>
        </SettingRow>
      ) : null}
      <SettingRow
        label="Tools"
        hint={`${server.tools.length} listed${server.listed_at ? ` on ${new Date(server.listed_at).toLocaleString()}` : ""}. ${server.sends_outside ? "They send what they are given outside this computer." : "They stay on this computer."}`}
      >
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </SettingRow>
      <Problems problems={server.problem ? [server.problem] : []} />
      <Loaded resource={listed} lines={2}>
        {(entries) => {
          const entry = entries.find((each) => each.key === server.key);
          return entry ? <ToolRows entry={entry} /> : null;
        }}
      </Loaded>
    </>
  );
}

// A row per MCP server the configuration declares.
export function DeclaredServerRows() {
  const declared = use_declared();
  return (
    <>
      {declared.mcp_servers.map((server) => (
        <SettingsDialogRow key={server.id} name={server.name} status={server.problem ? "Not reached" : `${server.tools.length} tools`} about={declared_words}>
          <DeclaredServerBody server={server} />
        </SettingsDialogRow>
      ))}
    </>
  );
}

// What is wrong with the configuration as a whole, shown once under Plugins.
export function DeclaredProblems() {
  const declared = use_declared();
  return declared.problems.length === 0 ? null : (
    <SettingRow label={declared_words} hint="Parts of it CODEX could not use; the rest holds.">
      <Problems problems={declared.problems} />
    </SettingRow>
  );
}
