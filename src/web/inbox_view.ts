// How the window shows the actions the assistant proposes: one card per action, and the count on the Inbox tab.
import { format_timestamp } from './knowledge_view.ts';
import type { ProposedAction } from './types.ts';

export const NO_ACTIONS_TEXT = 'Nothing needs your attention.';
export const INBOX_TAB_TEXT = 'Inbox';

// ============================================================================
// Cards
// ============================================================================

export type ActionCard = {
    id: number;
    title: string;
    body: string;
    // Short facts about the action, such as its importance, shown under the title.
    meta: string;
    // The resolutions its buttons offer, each with the daemon's name for it.
    buttons: Array<{ label: string; resolution: 'done' | 'rejected' }>;
};

function payload_of(action: ProposedAction): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(action.payload);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function action_meta(action: ProposedAction): string {
    const payload = payload_of(action);
    const parts: string[] = [];
    if (typeof payload.importance === 'string') {
        parts.push(`${payload.importance} importance`);
    }
    if (typeof payload.category === 'string') {
        parts.push(payload.category);
    }
    if (payload.needs_reply === true) {
        parts.push('waiting for a reply');
    }
    parts.push(format_timestamp(action.created_at));
    return parts.join(' · ');
}

// Newest first, as the daemon lists them.
export function action_cards(actions: ProposedAction[]): ActionCard[] {
    return actions.map((action) => ({
        id: action.id,
        title: action.title,
        body: action.body,
        meta: action_meta(action),
        buttons: [
            { label: 'Done', resolution: 'done' },
            { label: 'Dismiss', resolution: 'rejected' },
        ],
    }));
}

// ============================================================================
// Tab
// ============================================================================

export function inbox_tab_text(count: number): string {
    return count > 0 ? `${INBOX_TAB_TEXT} (${count})` : INBOX_TAB_TEXT;
}
