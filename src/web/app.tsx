// The CODEX window: X-Libs' shell with the pages in its sidebar, the mascot at its foot, and the daemon's state in the top bar.
import { StateBadge, StatusPill, type Tone } from '@x-tech-laboratories/x-libs/web/react/badges';
import { Shell, use_route } from '@x-tech-laboratories/x-libs/web/react/shell';
import { theme_choice } from '@x-tech-laboratories/x-libs/web/theme';
import { useEffect } from 'react';

import { answer_clarification, inbox, inbox_label, set_background_enabled, start } from './lib/controller.ts';
import { use_store } from '@x-tech-laboratories/x-libs/web/react/store';
import { use_workbench } from './lib/workbench.ts';
import { background_state, type Connection } from './run_state.ts';
import { Background } from './views/background.tsx';
import { Inbox } from './views/inbox.tsx';
import { Knowledge } from './views/knowledge.tsx';
import { Options } from './views/options.tsx';
import { Workbench } from './views/workbench.tsx';
import { ClarificationDialog } from './widgets/clarification_dialog.tsx';
import { Mascot } from './widgets/mascot.tsx';

export const theme = theme_choice('codex-theme');

const CONNECTION_LABELS: Record<Connection, [string, 'none' | 'good' | 'bad']> = {
    connecting: ['Connecting', 'none'],
    connected: ['Connected', 'good'],
    unavailable: ['Daemon unavailable', 'bad'],
};

// The dot's tone for each background state; working pulses while research runs.
const BACKGROUND_TONES: Record<ReturnType<typeof background_state>, Tone> = {
    idle: 'none',
    working: 'info',
    paused: 'warn',
    error: 'bad',
};

const PAGES = {
    '': Workbench,
    inbox: Inbox,
    background: Background,
    knowledge: Knowledge,
    options: Options,
} as const;

type Page = keyof typeof PAGES;

// The background research's state and a button that pauses or resumes it, in the top bar.
function BackgroundPill() {
    const state = use_workbench();
    const enabled = Boolean(state.settings?.background_research_enabled);
    const background = background_state(state.background_status);
    return (
        <StatusPill
            title="Background research"
            tone={BACKGROUND_TONES[background]}
            busy={background === 'working'}
            label={state.background_status}
            action={<button className="small" disabled={state.settings === null} onClick={() => void set_background_enabled(!enabled)}>{enabled ? 'Pause' : 'Resume'}</button>}
        />
    );
}

export function App() {
    const route = use_route();
    const state = use_workbench();
    use_store(inbox);
    useEffect(() => start(), []);

    const page = (route.parts[0] ?? '') as Page;
    const View = PAGES[page] ?? Workbench;
    const sections = [
        { id: '', label: 'Workbench', href: '#/' },
        { id: 'inbox', label: inbox_label(), href: '#/inbox' },
        { id: 'background', label: 'Background', href: '#/background' },
        { id: 'knowledge', label: 'Knowledge', href: '#/knowledge' },
        { id: 'options', label: 'Options', href: '#/options' },
    ];
    // The oldest waiting question shows; a run that ended takes its open question away.
    const clarification = state.clarifications[0] ?? null;

    return (
        <>
            <Shell
                brand="CODEX"
                sections={sections}
                active={page in PAGES ? page : ''}
                theme={theme}
                tools={<>
                    <BackgroundPill />
                    <StateBadge labels={CONNECTION_LABELS} state={state.connection} />
                </>}
                sidebar_foot={<Mascot />}
                view_key={page}
                main_class={page === '' ? 'workbench-main' : undefined}
            >
                <View />
            </Shell>
            {clarification !== null && (
                <ClarificationDialog key={clarification.clarification_id} clarification={clarification} on_answer={(submitted, typed) => answer_clarification(clarification, submitted, typed)} />
            )}
        </>
    );
}
