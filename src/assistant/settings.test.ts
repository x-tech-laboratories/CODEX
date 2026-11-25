import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, loadSettings } from '@x-tech-laboratories/smartharness/settings';
import { ASSISTANT_DEFAULT_SETTINGS, ASSISTANT_SETTINGS, DEFAULT_KNOWLEDGE_DB_PATH, loadAssistantSettings, saveAssistantSettings, validateAssistantSettings } from './settings.js';

const folders: string[] = [];

function temporaryFolder(): string {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'codex-assistant-settings-')));
    folders.push(folder);
    return folder;
}

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

// ============================================================================
// Harness settings
// ============================================================================

describe('assistant settings', () => {
    it('adds mail to the harness settings and keeps the CODEX database', () => {
        expect(Object.keys(ASSISTANT_DEFAULT_SETTINGS)).toEqual(expect.arrayContaining(Object.keys(DEFAULT_SETTINGS)));
        expect(ASSISTANT_DEFAULT_SETTINGS.knowledge_db_path).toBe(DEFAULT_KNOWLEDGE_DB_PATH);
        expect(DEFAULT_KNOWLEDGE_DB_PATH).toContain('codex');
    });

    it('still checks the harness settings', () => {
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mode: 'guess' })).toThrow(/mode/);
    });

    it('loads mail settings from a file, saves them, and refuses unknown ones', () => {
        const path = join(temporaryFolder(), 'settings.json');
        writeFileSync(path, JSON.stringify({ mail_max_age_days: 3 }), 'utf-8');

        expect(loadAssistantSettings(path).mail_max_age_days).toBe(3);
        expect(saveAssistantSettings(path, { ...ASSISTANT_DEFAULT_SETTINGS, mail_draft_replies: false }).mail_draft_replies).toBe(false);
        expect(loadAssistantSettings(path).mail_draft_replies).toBe(false);
        writeFileSync(path, JSON.stringify({ mail_password: 'x' }), 'utf-8');
        expect(() => loadAssistantSettings(path)).toThrow(/Unknown setting.*mail_password/);
    });

    it('gives the defaults when the user file does not exist yet', () => {
        const userPath = join(temporaryFolder(), 'missing', 'settings.json');

        expect(loadSettings(userPath, { ...ASSISTANT_SETTINGS, userPath })).toEqual(ASSISTANT_DEFAULT_SETTINGS);
        expect(() => loadSettings(join(temporaryFolder(), 'other.json'), ASSISTANT_SETTINGS)).toThrow(/ENOENT/);
    });

    it('bounds the mail age', () => {
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_max_age_days: 0 })).toThrow(/mail_max_age_days/);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_maildir_paths: [''] })).toThrow(/mail_maildir_paths/);
        expect(validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_maildir_paths: [' /mail '] }).mail_maildir_paths).toEqual(['/mail']);
    });
});

// ============================================================================
// Mail
// ============================================================================

describe('imap accounts', () => {
    const account = { name: 'home', host: 'imap.example.test', username: 'me', password_command: ['mail-password', 'home'] };

    it('defaults the port and folder, and has no accounts at first', () => {
        expect(ASSISTANT_DEFAULT_SETTINGS.mail_imap_accounts).toEqual([]);
        expect(validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [account] }).mail_imap_accounts).toEqual([
            { ...account, port: 993, folder: 'INBOX' },
        ]);
    });

    it('takes the password from a command, never from settings', () => {
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [{ ...account, password: 'x' }] })).toThrow(/Unknown field.*password/);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [{ ...account, password_command: [] }] })).toThrow(/password_command/);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [{ ...account, password_command: 'mail-password home' }] })).toThrow(/password_command/);
    });

    it('checks names, hosts, ports and folders', () => {
        const bad = (change: object) => () => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [{ ...account, ...change }] });
        expect(bad({ name: 'a b' })).toThrow(/name/);
        expect(bad({ host: 'imap.example.test:993' })).toThrow(/host/);
        expect(bad({ port: 0 })).toThrow(/port/);
        expect(bad({ folder: 'IN"BOX' })).toThrow(/folder/);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_imap_accounts: [account, account] })).toThrow(/unique/);
    });

    it('needs a boolean for drafting replies, which is on by default', () => {
        expect(ASSISTANT_DEFAULT_SETTINGS.mail_draft_replies).toBe(true);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_draft_replies: 'yes' })).toThrow(/mail_draft_replies/);
    });

    it('proposes a sender rule after three dismissals by default, and takes 0 to never propose one', () => {
        expect(ASSISTANT_DEFAULT_SETTINGS.mail_rule_proposal_threshold).toBe(3);
        expect(validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_rule_proposal_threshold: 0 }).mail_rule_proposal_threshold).toBe(0);
        expect(() => validateAssistantSettings({ ...ASSISTANT_DEFAULT_SETTINGS, mail_rule_proposal_threshold: -1 })).toThrow(/mail_rule_proposal_threshold/);
    });
});

