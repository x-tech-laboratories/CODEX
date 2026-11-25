import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackgroundPaused, type BackgroundOptions } from '../core/background.js';
import { UNTRUSTED_OPEN } from '../core/contextBudget.js';
import { handleNextEvent, type TreeRunner } from '../core/events.js';
import { KnowledgeStore } from '../core/knowledge.js';
import type { ChatModel } from '../core/model.js';
import { ASSISTANT_DEFAULT_SETTINGS as DEFAULT_SETTINGS, type AssistantSettings as Settings } from './settings.js';
import { RunStopped } from '../core/taskTree.js';
import { ASSISTANT_EVENT_HANDLERS } from './eventHandlers.js';
import { MailStore } from './mailStore.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;
let settings: Settings;
let store: KnowledgeStore;
const options: BackgroundOptions = { llm: {} as ChatModel };

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-draft-reply-'));
    settings = { ...DEFAULT_SETTINGS, knowledge_db_path: join(directory, 'knowledge.db') };
    store = new KnowledgeStore(settings.knowledge_db_path);
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function mailDraft(): void {
    store.enqueueEvent({
        source: 'maildir:/mail',
        type: 'email.draft',
        payload: { from: 'Alice <alice@example.test>', subject: 'Lunch?', body: 'Free on Friday?', message_id: '<1@example.test>' },
    });
}

// ============================================================================
// Drafting a reply
// ============================================================================

describe('drafting a reply', () => {
    it('works the mail as an outside-trust task tree and proposes the draft', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>().mockResolvedValue('Friday works for me.\n\nBest');

        await handleNextEvent(settings, options, ASSISTANT_EVENT_HANDLERS, runTree);

        const [prompt, treeOptions] = runTree.mock.calls[0];
        expect(prompt).toContain(UNTRUSTED_OPEN);
        expect(prompt).toContain('Free on Friday?');
        expect(treeOptions).toMatchObject({ trust: 'external', mode: 'answer', allowFileWrites: false, enableTestExecution: false, mcpServers: [] });
        const [action] = store.actions('proposed');
        expect(action).toMatchObject({ kind: 'draft', title: 'Reply to Alice <alice@example.test>: Lunch?', body: 'Friday works for me. Best' });
        expect(store.events()[0].status).toBe('done');
    });

    it('holds the model for the whole run and releases it when the run fails', async () => {
        mailDraft();
        const lock = { acquire: vi.fn(async () => {}), release: vi.fn() };
        const runTree = vi.fn<TreeRunner>().mockRejectedValue(new Error('boom'));

        await handleNextEvent(settings, { ...options, modelLock: lock }, ASSISTANT_EVENT_HANDLERS, runTree);

        expect(lock.acquire).toHaveBeenCalledOnce();
        expect(lock.release).toHaveBeenCalledOnce();
        expect(store.events()[0]).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('requeues the event when foreground work stops the run', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>().mockRejectedValue(new RunStopped());

        await handleNextEvent(settings, options, ASSISTANT_EVENT_HANDLERS, runTree);

        expect(store.events()[0].status).toBe('pending');
        expect(store.actions()).toEqual([]);
    });

    it('does not start while background work is paused', async () => {
        mailDraft();
        const runTree = vi.fn<TreeRunner>();

        await handleNextEvent(settings, { ...options, shouldPause: () => true }, ASSISTANT_EVENT_HANDLERS, runTree);

        expect(runTree).not.toHaveBeenCalled();
        expect(store.events()[0].status).toBe('pending');
        expect(BackgroundPaused).toBeDefined();
    });

    it('ignores a draft the model left empty', async () => {
        mailDraft();

        await handleNextEvent(settings, options, ASSISTANT_EVENT_HANDLERS, async () => '   ');

        expect(store.events()[0].status).toBe('ignored');
        expect(store.actions()).toEqual([]);
    });

    it('addresses the draft to the sender with a Re: subject, and stores it on its outcome row', async () => {
        const outcomeId = new MailStore(store).recordMailTriage({
            eventId: null, actionId: null, sender: 'alice@example.test', subject: 'Lunch?', messageId: '<1@example.test>',
            mailClass: 'reply', decidedBy: 'model', reason: 'personal',
        });
        store.enqueueEvent({
            source: 'maildir:/mail',
            type: 'email.draft',
            payload: { from: 'Alice <alice@example.test>', subject: 'Lunch?', body: 'Free on Friday?', mail_outcome_id: outcomeId },
        });

        await handleNextEvent(settings, options, ASSISTANT_EVENT_HANDLERS, async () => 'Friday works for me.');

        const [action] = store.actions();
        expect(action.body).toBe('Friday works for me.');
        expect(JSON.parse(String(action.payload))).toMatchObject({ to: 'alice@example.test', subject: 'Re: Lunch?' });
        expect(new MailStore(store).mailOutcomes()[0]).toMatchObject({ draft_action_id: action.id, draft: 'Friday works for me.', draft_checks: '[]', draft_resolution: 'pending' });
    });

    it('still proposes a draft that fails a check, with a note, and records the failed check', async () => {
        const outcomeId = new MailStore(store).recordMailTriage({
            eventId: null, actionId: null, sender: 'alice@example.test', subject: 'Lunch?', messageId: '',
            mailClass: 'reply', decidedBy: 'model', reason: 'personal',
        });
        store.enqueueEvent({
            source: 'maildir:/mail',
            type: 'email.draft',
            payload: { from: 'Alice <alice@example.test>', subject: 'Lunch?', body: 'Free on Friday?', mail_outcome_id: outcomeId },
        });

        await handleNextEvent(settings, options, ASSISTANT_EVENT_HANDLERS, async () => 'Friday works, see you at 1pm with Carol.');

        const [action] = store.actions('proposed');
        expect(action.body).toBe('Friday works, see you at 1pm with Carol.\n\nCheck: not in the email: 1pm, Carol.');
        expect(JSON.parse(String(new MailStore(store).mailOutcomes()[0].draft_checks))).toEqual(['ungrounded']);
    });
});

