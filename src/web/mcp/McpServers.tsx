// Settings → Plugins → MCP servers: each MCP server as a row whose dialog holds how it is reached, whether it is on, the
// tools it listed with Refresh, its marks and each tool's switches, and Remove; then a row to add one.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState, type FormEvent } from "react";

import { Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { Dialog, SettingsDialogRow, confirm_dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { FormRow, SettingRow } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { McpServerFields, McpServerSummary, McpTransport } from "../../shared/mcp/model.ts";
import { attempt, calls, data_watch, succeeds, use_data } from "../api.ts";
import { ToolRows } from "../tools/ToolSettings.tsx";

// ── Form ─────────────────────────────────────────────────────────────────────

interface Values {
  name: string;
  transport: McpTransport;
  address: string;
  token: string;
  command: string;
  // One argument a line.
  args: string;
  // Names separated by commas or spaces.
  variables: string;
}

const empty: Values = { name: "", transport: "stdio", address: "", token: "", command: "", args: "", variables: "" };

function values_of(server: McpServerSummary): Values {
  return { name: server.name, transport: server.transport, address: server.address, token: "", command: server.command, args: server.args.join("\n"), variables: server.variables.join(", ") };
}

// The fields as the store takes them; an empty token field keeps the stored token when the server has one.
export function fields_of(values: Values, keep_token: boolean, enabled?: boolean): McpServerFields {
  const base = { name: values.name, transport: values.transport, ...(enabled === undefined ? {} : { enabled }) };
  if (values.transport === "http") return { ...base, address: values.address, token: keep_token && values.token === "" ? null : values.token };
  return {
    ...base,
    command: values.command,
    args: values.args.split("\n").map((each) => each.trim()).filter(Boolean),
    variables: values.variables.split(/[\s,]+/).filter(Boolean),
  };
}

const transport_words: [McpTransport, string][] = [
  ["stdio", "A command on this computer (stdio)"],
  ["http", "An address (streamable HTTP)"],
];

function ServerFields({ id, values, on_change, has_token }: { id: string; values: Values; on_change: (values: Values) => void; has_token: boolean }) {
  const set = (change: Partial<Values>) => on_change({ ...values, ...change });
  return (
    <>
      <FormRow label="Name" id={`${id}-name`} hint="What CODEX calls the server; its tools are named after it, such as mcp_files__read_file.">
        <input id={`${id}-name`} value={values.name} onChange={(event) => set({ name: event.target.value })} />
      </FormRow>
      <FormRow label="Reached as" id={`${id}-transport`} hint="A local command's tools stay on this computer; a server at an address counts as outside unless the address is this computer's own.">
        <Select id={`${id}-transport`} label="Reached as" bare options={transport_words} value={values.transport} on_change={(transport) => set({ transport })} />
      </FormRow>
      {values.transport === "http" ? (
        <>
          <FormRow label="Address" id={`${id}-address`} hint="Where the server answers MCP over streamable HTTP, such as https://mcp.example.org/mcp.">
            <input id={`${id}-address`} type="url" value={values.address} placeholder="https://mcp.example.org/mcp" onChange={(event) => set({ address: event.target.value })} />
          </FormRow>
          <FormRow label="Token" id={`${id}-token`} hint={has_token ? "Set. Leave empty to keep it, or give a new one." : "A bearer token sent with each request; empty for none. It is kept like a plugin's key and never shown again."}>
            <input id={`${id}-token`} type="password" autoComplete="off" value={values.token} onChange={(event) => set({ token: event.target.value })} />
          </FormRow>
        </>
      ) : (
        <>
          <FormRow label="Program" id={`${id}-command`} hint="The program that starts the server, by its full path or a name on the PATH. It runs where CODEX's data is (the desktop app's daemon, or the server), without a shell.">
            <input id={`${id}-command`} value={values.command} placeholder="/run/current-system/sw/bin/mcp-server-files" onChange={(event) => set({ command: event.target.value })} />
          </FormRow>
          <FormRow label="Arguments" id={`${id}-args`} hint="One a line, each passed as it is.">
            <textarea id={`${id}-args`} rows={3} value={values.args} onChange={(event) => set({ args: event.target.value })} />
          </FormRow>
          <FormRow label="Variables passed" id={`${id}-variables`} hint="It is started with only HOME, LOGNAME, PATH, SHELL, TERM and USER. Name any other variables of CODEX's own it needs, such as GITHUB_TOKEN, separated by commas.">
            <input id={`${id}-variables`} value={values.variables} placeholder="GITHUB_TOKEN" onChange={(event) => set({ variables: event.target.value })} />
          </FormRow>
        </>
      )}
    </>
  );
}

function AddServerDialog({ on_close }: { on_close: () => void }) {
  const [values, set_values] = useState<Values>(empty);
  const [busy, set_busy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    set_busy(true);
    const added = await succeeds(() => calls().add_mcp_server(fields_of(values, false)), `${values.name.trim()} added.`);
    set_busy(false);
    if (added) {
      data_watch.bump();
      on_close();
    }
  };
  return (
    <Dialog
      title="Add an MCP server"
      subtitle="Its tools are offered to the assistant under the action policy: each that the server marks read-only runs at once, every other asks you first until you choose otherwise."
      on_close={on_close}
      form={{ on_submit: (event) => void submit(event), submit_label: busy ? "Listing its tools…" : "Add", submit_disabled: busy }}
    >
      <ServerFields id="new-mcp" values={values} on_change={set_values} has_token={false} />
    </Dialog>
  );
}

// ── A server ─────────────────────────────────────────────────────────────────

function ServerTools({ server }: { server: McpServerSummary }) {
  const listed = use_data((api) => api.list_plugin_tools(), [server.enabled, server.listed_at]);
  const refresh = () => void attempt(() => calls().refresh_mcp_server(server.id), "Its tools were listed again.");
  return (
    <>
      <SettingRow label="Tools" hint={`${server.tools.length} listed${server.listed_at ? ` on ${new Date(server.listed_at).toLocaleString()}` : ""}. ${server.sends_outside ? "They send what they are given outside this computer." : "They stay on this computer."}`}>
        <button type="button" onClick={refresh}>Refresh</button>
      </SettingRow>
      {server.enabled ? (
        <Loaded resource={listed} lines={2}>
          {(entries) => {
            const entry = entries.find((each) => each.key === server.key);
            return entry ? <ToolRows entry={entry} /> : null;
          }}
        </Loaded>
      ) : (
        <p className="muted small">Turned off: the assistant is offered none of its tools.</p>
      )}
    </>
  );
}

function ServerDialogBody({ server }: { server: McpServerSummary }) {
  const [values, set_values] = useState<Values>(values_of(server));
  const [busy, set_busy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    set_busy(true);
    const saved = await succeeds(() => calls().change_mcp_server(server.id, fields_of(values, server.has_token)), "Saved.");
    set_busy(false);
    if (saved) set_values({ ...values, token: "" });
  };
  const set_on = (on: boolean) => void attempt(() => calls().change_mcp_server(server.id, fields_of(values_of(server), true, on)));
  const remove = () =>
    confirm_dialog({
      title: `Remove ${server.name}?`,
      message: "The assistant is no longer offered its tools, and a local server is stopped.",
      confirm_label: "Remove",
      danger: true,
      run: async () => void (await attempt(() => calls().remove_mcp_server(server.id))),
    });
  return (
    <>
      <SettingRow label="On" hint="Off, the assistant is offered none of its tools." as_label>
        <Switch label={`${server.name} on`} checked={server.enabled} on_change={set_on} />
      </SettingRow>
      <form onSubmit={(event) => void save(event)}>
        <ServerFields id={`mcp-${server.id}`} values={values} on_change={set_values} has_token={server.has_token} />
        <SettingRow label="Save" hint="When how it is reached changed, CODEX lists its tools again before keeping the change.">
          <button type="submit" disabled={busy}>{busy ? "Listing its tools…" : "Save"}</button>
        </SettingRow>
      </form>
      <ServerTools server={server} />
      <SettingRow label="Remove" hint="Stop offering its tools.">
        <button type="button" className="danger" onClick={remove}>Remove…</button>
      </SettingRow>
    </>
  );
}

function where_words(server: McpServerSummary): string {
  return server.transport === "http" ? server.address : [server.command, ...server.args].join(" ");
}

// A row per MCP server, then a row to add one.
export function McpServerRows() {
  const servers = use_data((api) => api.list_mcp_servers());
  return (
    <Loaded resource={servers} lines={1}>
      {(list) => (
        <>
          {list.map((server) => (
            <SettingsDialogRow key={server.id} name={server.name} status={server.enabled ? `${server.tools.length} tools` : "Off"} about={where_words(server)}>
              <ServerDialogBody server={server} />
            </SettingsDialogRow>
          ))}
          <SettingRow label="MCP servers" hint="Give the assistant the tools of an MCP server: one started as a command on this computer, or one at an address. Each is a tool plugin of its own, with its own marks.">
            <button type="button" onClick={() => open_dialog((close) => <AddServerDialog on_close={close} />)}>Add an MCP server…</button>
          </SettingRow>
        </>
      )}
    </Loaded>
  );
}
