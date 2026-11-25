import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeStore, MIGRATIONS } from '../core/knowledge.js';
import { MailStore } from './mailStore.js';

// ============================================================================
// Helpers
// ============================================================================

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-mail-store-'));
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

// ============================================================================
// Mail outcomes and sender rules
// ============================================================================

describe('MailStore', () => {
    let store: KnowledgeStore;
    let mail: MailStore;

    beforeEach(() => {
        store = new KnowledgeStore(join(directory, 'knowledge.db'));
        mail = new MailStore(store);
    });

    // Triage one message from a sender into a shown notification and return its action.
    function shown(sender: string, mailClass: 'notify' | 'reply' = 'notify'): number {
        const actionId = store.addAction({ kind: 'notify', title: `${sender}: hello` });
        mail.recordMailTriage({ eventId: null, actionId, sender, subject: 'Hello', messageId: '', mailClass, decidedBy: 'model', reason: 'work' });
        return actionId;
    }

    it('writes the user answer on the triage and draft of the same message', () => {
        const notifyId = shown('alice@example.test', 'reply');
        const outcomeId = Number(mail.mailOutcomes()[0].id);
        const draftId = store.addAction({ kind: 'draft', title: 'Reply to Alice' });
        mail.recordMailDraft(outcomeId, draftId, 'Sounds good.', ['subject']);

        mail.resolveAction(notifyId, 'done');
        mail.resolveAction(draftId, 'rejected');

        expect(mail.mailOutcomes()[0]).toMatchObject({
            resolution: 'done',
            draft: 'Sounds good.',
            draft_checks: '["subject"]',
            draft_resolution: 'rejected',
            edited_draft: null,
            edit_distance: null,
        });
        expect(mail.mailOutcomes()[0].resolved_at).toBeTypeOf('number');
    });

    it('sums each class and the share of shown mail the user kept', () => {
        mail.resolveAction(shown('alice@example.test'), 'done');
        mail.resolveAction(shown('bob@example.test'), 'rejected');
        shown('carol@example.test', 'reply');
        mail.recordMailTriage({ eventId: null, actionId: null, sender: 'news@example.test', subject: '', messageId: '', mailClass: 'ignore', decidedBy: 'heuristic', reason: 'bulk' });

        const summary = mail.mailOutcomeSummary();

        expect(summary.classes).toEqual([
            { mail_class: 'ignore', decided: 1, approved: 0, rejected: 0, pending: 0 },
            { mail_class: 'notify', decided: 2, approved: 1, rejected: 1, pending: 0 },
            { mail_class: 'reply', decided: 1, approved: 0, rejected: 0, pending: 1 },
        ]);
        expect(summary.agreement).toBe(0.5);
        expect(summary.rule_conflicts).toBe(0);
        mail.setSenderRule('bob@example.test', 'ignore');
        expect(mail.mailOutcomeSummary().rule_conflicts).toBe(1);
    });

    it('proposes an ignore rule only after the set number of dismissals in a row, and only once', () => {
        const options = { senderRuleThreshold: 3 };
        mail.resolveAction(shown('bob@example.test'), 'rejected', options);
        mail.resolveAction(shown('bob@example.test'), 'done', options);
        mail.resolveAction(shown('bob@example.test'), 'rejected', options);
        mail.resolveAction(shown('bob@example.test'), 'rejected', options);
        expect(store.actions('proposed')).toEqual([]);

        mail.resolveAction(shown('bob@example.test'), 'rejected', options);
        mail.resolveAction(shown('bob@example.test'), 'rejected', options);

        const proposals = store.actions('proposed').filter((action) => action.kind === 'rule');
        expect(proposals).toHaveLength(1);
        expect(proposals[0].title).toBe('Ignore mail from bob@example.test?');
        expect(JSON.parse(String(proposals[0].payload))).toEqual({ pattern: 'bob@example.test', mail_class: 'ignore', origin: 'learned' });
        expect(mail.senderRules()).toEqual([]);
    });

    it('proposes nothing when the threshold is zero', () => {
        for (let index = 0; index < 5; index += 1) {
            mail.resolveAction(shown('bob@example.test'), 'rejected', { senderRuleThreshold: 0 });
        }

        expect(store.actions('proposed')).toEqual([]);
    });

    it('adds a learned rule when the user marks the proposal done, and none when it is dismissed', () => {
        for (let index = 0; index < 2; index += 1) {
            mail.resolveAction(shown('bob@example.test'), 'rejected', { senderRuleThreshold: 2 });
            mail.resolveAction(shown('eve@example.test'), 'rejected', { senderRuleThreshold: 2 });
        }
        const [eve, bob] = store.actions('proposed');

        mail.resolveAction(Number(bob.id), 'done');
        mail.resolveAction(Number(eve.id), 'rejected');

        expect(mail.senderRules().map((rule) => [rule.pattern, rule.mail_class, rule.origin])).toEqual([['bob@example.test', 'ignore', 'learned']]);
    });

    it('sets, replaces and deletes a user rule, and matches the exact address before the domain', () => {
        mail.setSenderRule('@Example.test', 'ignore');
        mail.setSenderRule('alice@example.test', 'notify');
        mail.setSenderRule('alice@example.test', 'reply');

        expect(mail.applySenderRule('alice@example.test')?.mail_class).toBe('reply');
        expect(mail.applySenderRule('bob@example.test')?.mail_class).toBe('ignore');
        expect(mail.senderRules().map((rule) => [rule.pattern, rule.origin, rule.hits])).toEqual([
            ['alice@example.test', 'user', 1],
            ['example.test', 'user', 1],
        ]);
        expect(mail.deleteSenderRule('example.test')).toBe(true);
        expect(mail.applySenderRule('bob@example.test')).toBeNull();
        expect(() => mail.setSenderRule('example.test', 'archive' as 'ignore')).toThrow("sender rule's class");
    });
});

// ============================================================================
// Databases made before the mail tables moved
// ============================================================================

describe('MailStore on an older database', () => {
    it('keeps the mail rows a database already holds and records the extension', () => {
        const path = join(directory, 'knowledge.db');
        const before = new MailStore(new KnowledgeStore(path));
        before.setSenderRule('bob@example.test', 'ignore');
        const database = new DatabaseSync(path);
        database.exec("DELETE FROM schema_extensions WHERE name = 'mail'");
        database.close();

        const after = new MailStore(new KnowledgeStore(path));

        expect(after.senderRules().map((rule) => rule.pattern)).toEqual(['bob@example.test']);
        const check = new DatabaseSync(path);
        expect(check.prepare("SELECT version FROM schema_extensions WHERE name = 'mail'").get()).toEqual({ version: 1 });
        expect(Object.values(check.prepare('PRAGMA user_version').get()!)[0]).toBe(MIGRATIONS.length);
        check.close();
    });
});

