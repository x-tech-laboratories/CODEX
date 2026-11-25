// The assistant's mail records beside the knowledge store: what triage decided, the drafts it proposed, and sender rules.
import { KnowledgeStore, firstChars, now, type ActionResolution, type Connection, type ResolvedAction, type Row, type SchemaExtension } from '../core/knowledge.js';
import { MAIL_CLASSES, conflictingRule, matchSenderRule, normalizeRulePattern, type MailClass, type SenderRule } from './mailChecks.js';

// ============================================================================
// Schema
// ============================================================================

// The tables already exist in databases made before they moved here, so each statement only creates what is missing.
export const MAIL_SCHEMA: SchemaExtension = {
    name: 'mail',
    migrations: [
        `
    CREATE TABLE IF NOT EXISTS mail_outcomes (
        id INTEGER PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        draft_action_id INTEGER REFERENCES actions(id) ON DELETE SET NULL,
        sender TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        mail_class TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        resolution TEXT NOT NULL DEFAULT 'pending',
        draft TEXT,
        draft_checks TEXT NOT NULL DEFAULT '[]',
        draft_resolution TEXT,
        edited_draft TEXT,
        edit_distance INTEGER,
        triaged_at REAL NOT NULL,
        drafted_at REAL,
        resolved_at REAL,
        draft_resolved_at REAL
    );
    CREATE INDEX IF NOT EXISTS mail_outcomes_sender ON mail_outcomes(sender, triaged_at);
    CREATE INDEX IF NOT EXISTS mail_outcomes_action ON mail_outcomes(action_id);
    CREATE INDEX IF NOT EXISTS mail_outcomes_draft_action ON mail_outcomes(draft_action_id);
    CREATE TABLE IF NOT EXISTS mail_sender_rules (
        id INTEGER PRIMARY KEY,
        pattern TEXT NOT NULL UNIQUE,
        mail_class TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'user',
        created_at REAL NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0
    );
        `,
    ],
};

// ============================================================================
// Types
// ============================================================================

// Who decided a message's class: the bulk-mail headers, a sender rule, the model, or nobody because the model failed.
export const MAIL_DECIDERS = ['heuristic', 'rule', 'model', 'fallback'] as const;
export type MailDecider = (typeof MAIL_DECIDERS)[number];
export const SENDER_RULE_ORIGINS = ['user', 'learned'] as const;
export type SenderRuleOrigin = (typeof SENDER_RULE_ORIGINS)[number];

export type NewMailOutcome = {
    eventId: number | null;
    actionId: number | null;
    sender: string;
    subject: string;
    messageId: string;
    mailClass: MailClass;
    decidedBy: MailDecider;
    reason: string;
};

export type SenderRuleRecord = SenderRule & { id: number; origin: SenderRuleOrigin; created_at: number; hits: number };

export type MailClassCounts = { mail_class: string; decided: number; approved: number; rejected: number; pending: number };

export type MailOutcomeSummary = {
    since: number;
    classes: MailClassCounts[];
    drafts: { proposed: number; approved: number; rejected: number; pending: number; failed_checks: number };
    // Share of shown mail the user kept (Done) rather than dismissed, or null before any was resolved.
    agreement: number | null;
    // Past decisions not made by a rule that today's sender rules would class differently.
    rule_conflicts: number;
};

// ============================================================================
// Mail store
// ============================================================================

export class MailStore {
    constructor(readonly store: KnowledgeStore) {
        store.applySchemaExtension(MAIL_SCHEMA);
    }

    // Resolves an action and records the user's answer on the mail it belongs to.
    // With a threshold, repeated dismissals of one sender propose a rule.
    resolveAction(actionId: number, resolution: ActionResolution, options: { senderRuleThreshold?: number } = {}): boolean {
        return this.store.resolveAction(actionId, resolution, (connection, action) => this.followUp(connection, action, options.senderRuleThreshold ?? 0));
    }

    private followUp(connection: Connection, action: ResolvedAction, threshold: number): void {
        connection.run('UPDATE mail_outcomes SET resolution = ?, resolved_at = ? WHERE action_id = ?', action.resolution, action.resolvedAt, action.id);
        connection.run('UPDATE mail_outcomes SET draft_resolution = ?, draft_resolved_at = ? WHERE draft_action_id = ?', action.resolution, action.resolvedAt, action.id);
        if (action.kind === 'rule' && action.resolution !== 'rejected') {
            this.addProposedRule(connection, action.payload);
        }
        if (action.resolution === 'rejected' && threshold > 0) {
            this.proposeIgnoreRule(connection, action.id, threshold);
        }
    }

    // Stores what triage decided for one message; the user's answer is filled in when its action is resolved.
    recordMailTriage(outcome: NewMailOutcome): number {
        const resolution = outcome.mailClass === 'ignore' ? 'ignored' : 'pending';
        return this.store.transaction(
            (connection) =>
                connection.run(
                    'INSERT INTO mail_outcomes(event_id, action_id, sender, subject, message_id, mail_class, decided_by, reason, resolution, triaged_at) ' +
                        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    outcome.eventId, outcome.actionId, outcome.sender, firstChars(outcome.subject, 300), outcome.messageId,
                    outcome.mailClass, outcome.decidedBy, firstChars(outcome.reason, 300), resolution, now(),
                ).lastInsertRowid,
        );
    }

    // Stores the draft proposed for a message and the names of the checks it failed.
    recordMailDraft(outcomeId: number, draftActionId: number, draft: string, failedChecks: string[]): void {
        this.store.transaction((connection) => {
            connection.run(
                "UPDATE mail_outcomes SET draft_action_id = ?, draft = ?, draft_checks = ?, draft_resolution = 'pending', drafted_at = ? WHERE id = ?",
                draftActionId, draft, JSON.stringify(failedChecks), now(), outcomeId,
            );
        });
    }

    mailOutcomes(limit = 100): Row[] {
        return this.store.transaction((connection) =>
            connection.all('SELECT * FROM mail_outcomes ORDER BY triaged_at DESC, id DESC LIMIT ?', limit),
        );
    }

    // Counts per class of what triage decided and what the user then did, for outcomes triaged at or after a time.
    mailOutcomeSummary(since = 0): MailOutcomeSummary {
        return this.store.transaction((connection) => {
            const classes = connection
                .all(
                    "SELECT mail_class, COUNT(*) AS decided, SUM(resolution IN ('approved', 'done')) AS approved, " +
                        "SUM(resolution = 'rejected') AS rejected, SUM(resolution = 'pending') AS pending " +
                        'FROM mail_outcomes WHERE triaged_at >= ? GROUP BY mail_class ORDER BY mail_class',
                    since,
                )
                .map((row) => ({
                    mail_class: String(row.mail_class),
                    decided: Number(row.decided),
                    approved: Number(row.approved ?? 0),
                    rejected: Number(row.rejected ?? 0),
                    pending: Number(row.pending ?? 0),
                }));
            const drafts = connection.get(
                "SELECT COUNT(draft) AS proposed, SUM(draft_resolution IN ('approved', 'done')) AS approved, " +
                    "SUM(draft_resolution = 'rejected') AS rejected, SUM(draft_resolution = 'pending') AS pending, " +
                    "SUM(draft IS NOT NULL AND draft_checks != '[]') AS failed_checks FROM mail_outcomes WHERE triaged_at >= ?",
                since,
            )!;
            const shown = classes.filter((counts) => counts.mail_class !== 'ignore');
            const approved = shown.reduce((total, counts) => total + counts.approved, 0);
            const answered = approved + shown.reduce((total, counts) => total + counts.rejected, 0);
            const rules = this.readSenderRules(connection);
            const ruleConflicts = connection
                .all("SELECT sender, mail_class FROM mail_outcomes WHERE triaged_at >= ? AND decided_by != 'rule'", since)
                .filter((row) => conflictingRule(rules, String(row.sender), String(row.mail_class)) !== null).length;
            return {
                since,
                classes,
                drafts: {
                    proposed: Number(drafts.proposed ?? 0),
                    approved: Number(drafts.approved ?? 0),
                    rejected: Number(drafts.rejected ?? 0),
                    pending: Number(drafts.pending ?? 0),
                    failed_checks: Number(drafts.failed_checks ?? 0),
                },
                agreement: answered > 0 ? approved / answered : null,
                rule_conflicts: ruleConflicts,
            };
        });
    }

    senderRules(): SenderRuleRecord[] {
        return this.store.transaction((connection) => this.readSenderRules(connection));
    }

    // Adds or replaces the rule for an address or domain, returning it and how many past decisions it disagrees with.
    setSenderRule(pattern: string, mailClass: MailClass, origin: SenderRuleOrigin = 'user'): { rule: SenderRuleRecord; conflicts: number } {
        if (!MAIL_CLASSES.includes(mailClass)) {
            throw new Error(`A sender rule's class is one of: ${MAIL_CLASSES.join(', ')}.`);
        }
        const normalized = normalizeRulePattern(pattern);
        return this.store.transaction((connection) => {
            connection.run(
                'INSERT INTO mail_sender_rules(pattern, mail_class, origin, created_at) VALUES (?, ?, ?, ?) ' +
                    'ON CONFLICT(pattern) DO UPDATE SET mail_class = excluded.mail_class, origin = excluded.origin, created_at = excluded.created_at, hits = 0',
                normalized, mailClass, origin, now(),
            );
            const rule = this.readSenderRules(connection).find((candidate) => candidate.pattern === normalized)!;
            const conflicts = connection
                .all("SELECT sender, mail_class FROM mail_outcomes WHERE decided_by != 'rule'")
                .filter((row) => conflictingRule([rule], String(row.sender), String(row.mail_class)) !== null).length;
            return { rule, conflicts };
        });
    }

    deleteSenderRule(pattern: string): boolean {
        const normalized = normalizeRulePattern(pattern);
        return this.store.transaction((connection) => connection.run('DELETE FROM mail_sender_rules WHERE pattern = ?', normalized).changes > 0);
    }

    // The rule that decides for a sender's address, exact address before domain, counting the hit.
    applySenderRule(address: string): SenderRuleRecord | null {
        if (!address) {
            return null;
        }
        return this.store.transaction((connection) => {
            const rule = matchSenderRule(this.readSenderRules(connection), address);
            if (rule) {
                connection.run('UPDATE mail_sender_rules SET hits = hits + 1 WHERE id = ?', rule.id);
            }
            return rule;
        });
    }

    private readSenderRules(connection: Connection): SenderRuleRecord[] {
        return connection
            .all('SELECT id, pattern, mail_class, origin, created_at, hits FROM mail_sender_rules ORDER BY pattern')
            .map((row) => ({ ...row }) as SenderRuleRecord);
    }

    // An approved rule proposal becomes a learned rule, unless the user has set one for that pattern since.
    private addProposedRule(connection: Connection, payloadText: string): void {
        let payload: Record<string, unknown> = {};
        try {
            payload = JSON.parse(payloadText) as Record<string, unknown>;
        } catch {
            return;
        }
        const { pattern, mail_class: mailClass } = payload;
        if (typeof pattern !== 'string' || !(MAIL_CLASSES as readonly unknown[]).includes(mailClass)) {
            return;
        }
        connection.run(
            "INSERT OR IGNORE INTO mail_sender_rules(pattern, mail_class, origin, created_at) VALUES (?, ?, 'learned', ?)",
            normalizeRulePattern(pattern), String(mailClass), now(),
        );
    }

    // After the user dismissed a sender's last few messages in a row, propose ignoring that sender; never write the rule unasked.
    private proposeIgnoreRule(connection: Connection, actionId: number, threshold: number): void {
        const sender = String(connection.value('SELECT sender FROM mail_outcomes WHERE action_id = ?', actionId) ?? '');
        if (!sender || matchSenderRule(this.readSenderRules(connection), sender)) {
            return;
        }
        const proposedBefore = connection.value(
            "SELECT COUNT(*) FROM actions WHERE kind = 'rule' AND json_extract(payload, '$.pattern') = ?",
            sender,
        );
        if (Number(proposedBefore) > 0) {
            return;
        }
        const recent = connection.all(
            "SELECT resolution FROM mail_outcomes WHERE sender = ? AND resolution IN ('approved', 'done', 'rejected') " +
                'ORDER BY resolved_at DESC, id DESC LIMIT ?',
            sender, threshold,
        );
        if (recent.length < threshold || recent.some((row) => row.resolution !== 'rejected')) {
            return;
        }
        const total = Number(connection.value('SELECT COUNT(*) FROM mail_outcomes WHERE sender = ?', sender));
        const changed = Number(connection.value("SELECT COUNT(*) FROM mail_outcomes WHERE sender = ? AND mail_class != 'ignore'", sender));
        connection.run(
            'INSERT INTO actions(event_id, kind, title, body, payload, created_at) VALUES (NULL, ?, ?, ?, ?, ?)',
            'rule',
            firstChars(`Ignore mail from ${sender}?`, 120),
            `You dismissed the last ${threshold} messages from ${sender}. Mark Done to add a sender rule that ignores its mail ` +
                `without the model, or Dismiss to keep it as it is. The rule would have changed ${changed} of ${total} earlier decisions.`,
            JSON.stringify({ pattern: sender, mail_class: 'ignore', origin: 'learned' }),
            now(),
        );
    }
}
