// The Options page: the daemon's settings as a form, sized for this machine on request, and this computer's launch at login.
import { Switch } from '@x-tech-laboratories/x-libs/web/react/controls';
import { SettingRow, SettingsGroup } from '@x-tech-laboratories/x-libs/web/react/layout';

import {
    apply_settings, auto_size, browse_for_path, form, launch_at_login, restart_daemon, save_settings, set_launch_at_login,
} from '../lib/controller.ts';
import { use_store } from '../lib/store.ts';
import { use_workbench } from '../lib/workbench.ts';
import { FIELD_GROUPS, MCP_SERVERS_HINT, type FormValues, type NumberField, type PathField, type SwitchField } from '../settings_form.ts';

type Change = (change: (values: FormValues) => FormValues) => void;

function NumberInput({ field, values, change }: { field: NumberField; values: FormValues; change: Change }) {
    return (
        <SettingRow label={field.label} as_label>
            <input
                type="number"
                className="input-sm"
                min={field.lowest}
                max={field.highest}
                step={field.step}
                value={values.text[field.name] ?? ''}
                onChange={(event) => { const next = event.currentTarget.value; change((before) => ({ ...before, text: { ...before.text, [field.name]: next } })); }}
            />
        </SettingRow>
    );
}

function PathInput({ field, values, change }: { field: PathField; values: FormValues; change: Change }) {
    const current = values.text[field.name] ?? '';
    const set = (next: string) => change((before) => ({ ...before, text: { ...before.text, [field.name]: next } }));
    return (
        <SettingRow label={field.label}>
            <span className="path-row">
                <input type="text" aria-label={field.label} spellCheck={false} value={current} onChange={(event) => set(event.currentTarget.value)} />
                <button type="button" onClick={() => void browse_for_path(field, current).then((chosen) => { if (chosen !== null) set(chosen); })}>Browse…</button>
            </span>
        </SettingRow>
    );
}

function SwitchInput({ field, values, change }: { field: SwitchField; values: FormValues; change: Change }) {
    return (
        <SettingRow label={field.label} as_label>
            <Switch
                label={field.label}
                checked={values.switches[field.name] ?? false}
                on_change={(on) => change((before) => ({ ...before, switches: { ...before.switches, [field.name]: on } }))}
            />
        </SettingRow>
    );
}

export function Options() {
    const state = use_workbench();
    const values = use_store(form);
    const at_login = use_store(launch_at_login);
    const shown: FormValues = values ?? { text: {}, switches: {}, mcp_servers: '', mode: 'auto', background_research_enabled: false };
    const change: Change = (make) => { if (form.get() !== null) form.set(make(form.get()!)); };

    return (
        <div className="page options">
            <div className="options-grid">
                {FIELD_GROUPS.map((group) => (
                    <SettingsGroup key={group.heading} heading={group.heading}>
                        {group.heading === 'Background research' ? (
                            <>
                                {(group.numbers ?? []).map((field) => <NumberInput key={field.name} field={field} values={shown} change={change} />)}
                                {(group.paths ?? []).map((field) => <PathInput key={field.name} field={field} values={shown} change={change} />)}
                                {(group.after ?? []).map((field) => <NumberInput key={field.name} field={field} values={shown} change={change} />)}
                            </>
                        ) : (
                            <>
                                {(group.paths ?? []).map((field) => <PathInput key={field.name} field={field} values={shown} change={change} />)}
                                {(group.numbers ?? []).map((field) => <NumberInput key={field.name} field={field} values={shown} change={change} />)}
                            </>
                        )}
                        {(group.switches ?? []).map((field) => <SwitchInput key={field.name} field={field} values={shown} change={change} />)}
                    </SettingsGroup>
                ))}
                <SettingsGroup heading="MCP servers" hint={MCP_SERVERS_HINT}>
                    <textarea aria-label="MCP servers" spellCheck={false} rows={8} value={shown.mcp_servers} onChange={(event) => { const next = event.currentTarget.value; change((before) => ({ ...before, mcp_servers: next })); }} />
                </SettingsGroup>
                <SettingsGroup heading="Desktop">
                    <SettingRow label="Launch at login, in the system tray" as_label>
                        <Switch label="Launch at login, in the system tray" checked={at_login} on_change={(on) => set_launch_at_login(on)} />
                    </SettingRow>
                    <div>
                        <button type="button" title="Stop the daemon and start a fresh one" onClick={() => void restart_daemon()}>Restart daemon</button>
                    </div>
                </SettingsGroup>
            </div>
            <div className="form-actions">
                <button className="accent solid" disabled={values === null} onClick={() => void apply_settings()}>Apply</button>
                <button disabled={values === null} onClick={() => void save_settings()}>Save settings</button>
                <button disabled={values === null} onClick={() => void auto_size()}>Auto size</button>
                <span className="muted small">{state.settings_path ? `Saves to ${state.settings_path}` : ''}</span>
            </div>
        </div>
    );
}
