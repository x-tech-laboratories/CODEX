// The Background page: whether idle research runs, a topic to queue, the queue, and the model's output as it streams.
import { Switch } from '@x-tech-laboratories/x-libs/web/react/controls';
import { FollowingOutput } from '@x-tech-laboratories/x-libs/web/react/following';
import { Section, SettingRow, Toolbar } from '@x-tech-laboratories/x-libs/web/react/layout';
import { useEffect, useState, type KeyboardEvent } from 'react';

import { queue_text, queue_topic, refresh_queue, research_now, set_background_enabled } from '../lib/controller.ts';
import { use_store } from '@x-tech-laboratories/x-libs/web/react/store';
import { use_workbench } from '../lib/workbench.ts';
import { BACKGROUND_WAITING_TEXT } from '../run_state.ts';

export function Background() {
    const state = use_workbench();
    const queued_jobs = use_store(queue_text);
    const [topic, set_topic] = useState('');
    const [priority, set_priority] = useState('0');
    useEffect(() => void refresh_queue(), []);
    const enabled = Boolean(state.settings?.background_research_enabled);

    async function queue(): Promise<void> {
        if (await queue_topic(topic, Number(priority))) set_topic('');
    }

    function on_enter(event: KeyboardEvent<HTMLInputElement>): void {
        if (event.key === 'Enter') void queue();
    }

    return (
        <div className="page">
            <Section title="Background research">
                <p className="accent-text">{state.background_status}</p>
                <SettingRow label="Enable idle research" as_label class_name="fit-content">
                    <Switch label="Enable idle research" checked={enabled} disabled={state.settings === null} on_change={(on) => set_background_enabled(on)} />
                </SettingRow>
                <Toolbar>
                    <label className="field grow">
                        <span className="field-label">Research topic</span>
                        <input type="text" placeholder="Topic to research" value={topic} onChange={(event) => set_topic(event.currentTarget.value)} onKeyDown={on_enter} />
                    </label>
                    <label className="field">
                        <span className="field-label">Priority</span>
                        <input type="number" className="input-sm" min={-1000} max={1000} step={1} value={priority} onChange={(event) => set_priority(event.currentTarget.value)} onKeyDown={on_enter} />
                    </label>
                    <button onClick={() => void queue()}>Queue topic</button>
                    <button className="accent solid" onClick={() => void research_now(topic, Number(priority)).then((queued) => { if (queued) set_topic(''); })}>Research now</button>
                </Toolbar>
            </Section>
            <div className="background-grid">
                <Section title="Queue">
                    <pre className="output">{queued_jobs}</pre>
                </Section>
                <Section title="Model output">
                    <FollowingOutput text={state.background_output || BACKGROUND_WAITING_TEXT} />
                </Section>
            </div>
        </div>
    );
}
