// The assistant's settings: the harness settings plus mail, kept in the CODEX config folder and database.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DEFAULT_SETTINGS,
    defaultSettingsPath,
    isInteger,
    isObject,
    loadSettings,
    saveSettings,
    validateSettings,
    type Settings,
    type SettingsSchema,
} from '@x-tech-laboratories/smartharness/settings';

// ============================================================================
// Paths
// ============================================================================

export const ASSISTANT_SETTINGS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'settings.json');
export const ASSISTANT_USER_SETTINGS_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex', 'settings.json');
export const DEFAULT_KNOWLEDGE_DB_PATH = '~/.local/share/codex/knowledge.sqlite3';

// ============================================================================
// Mail settings
// ============================================================================

// An IMAP mailbox read over TLS; the password comes from running password_command, so settings never hold it.
export type ImapAccount = {
    name: string;
    host: string;
    port: number;
    username: string;
    password_command: string[];
    folder: string;
};

export type MailSettings = {
    mail_maildir_paths: string[];
    mail_max_age_days: number;
    mail_imap_accounts: ImapAccount[];
    mail_draft_replies: boolean;
    mail_rule_proposal_threshold: number;
};

// ============================================================================
// Model provider settings
// ============================================================================

export const MODEL_PROVIDERS = ['local', 'openai', 'anthropic'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

// A hosted model is named by its provider, endpoint and model name; its key comes from running api_key_command.
export type ModelProviderSettings = {
    model_provider: ModelProvider;
    model_endpoint: string;
    model_name: string;
    model_api_key_command: string[];
    background_model_provider: ModelProvider;
    background_model_endpoint: string;
    background_model_name: string;
    background_model_api_key_command: string[];
};

export type AssistantSettings = Settings & MailSettings & ModelProviderSettings;

export const ASSISTANT_DEFAULT_SETTINGS: Readonly<AssistantSettings> = Object.freeze({
    ...DEFAULT_SETTINGS,
    knowledge_db_path: DEFAULT_KNOWLEDGE_DB_PATH,
    // Every model runs on this computer unless a hosted provider is chosen; background work, mail included, can stay local on its own.
    model_provider: 'local',
    model_endpoint: '',
    model_name: '',
    model_api_key_command: [],
    background_model_provider: 'local',
    background_model_endpoint: '',
    background_model_name: '',
    background_model_api_key_command: [],
    // Maildir folders whose new/ messages become events; none are read until one is listed.
    mail_maildir_paths: [],
    mail_max_age_days: 7,
    mail_imap_accounts: [],
    // A message that needs an answer gets a drafted reply, which the model works as a task tree; it is never sent.
    mail_draft_replies: true,
    // Dismissing this many messages in a row from one sender proposes a rule to ignore it; 0 never proposes one.
    mail_rule_proposal_threshold: 3,
} satisfies AssistantSettings);

// ============================================================================
// Checks
// ============================================================================

// Check the harness settings and then the mail ones, returning a copy with paths trimmed.
export function validateAssistantSettings(input: Record<string, unknown>): AssistantSettings {
    const values: Record<string, unknown> = { ...validateSettings(input) };
    if (!Array.isArray(values.mail_maildir_paths) || values.mail_maildir_paths.some((path) => typeof path !== 'string' || !path.trim())) {
        throw new Error('mail_maildir_paths must be a list of folder path strings.');
    }
    values.mail_maildir_paths = values.mail_maildir_paths.map((path: string) => path.trim());
    values.mail_imap_accounts = validateImapAccounts(values.mail_imap_accounts);
    if (typeof values.mail_draft_replies !== 'boolean') {
        throw new Error('mail_draft_replies must be a boolean.');
    }
    for (const [name, minimum, maximum] of [['mail_max_age_days', 1, 365], ['mail_rule_proposal_threshold', 0, 100]] as const) {
        const value = values[name];
        if (!isInteger(value) || value < minimum || value > maximum) {
            throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
        }
    }
    validateModelProvider(values, 'model');
    validateModelProvider(values, 'background_model');
    return values as AssistantSettings;
}

// Check one model's provider fields, trimming the text ones.
function validateModelProvider(values: Record<string, unknown>, prefix: 'model' | 'background_model'): void {
    const provider = values[`${prefix}_provider`];
    if (!(MODEL_PROVIDERS as readonly unknown[]).includes(provider)) {
        throw new Error(`${prefix}_provider must be one of: ${MODEL_PROVIDERS.join(', ')}.`);
    }
    for (const name of [`${prefix}_endpoint`, `${prefix}_name`]) {
        if (typeof values[name] !== 'string') {
            throw new Error(`${name} must be a string.`);
        }
        values[name] = (values[name] as string).trim();
    }
    const endpoint = values[`${prefix}_endpoint`] as string;
    if (endpoint && !/^https?:\/\/\S+$/.test(endpoint)) {
        throw new Error(`${prefix}_endpoint must be an http or https address, or empty for the provider's own.`);
    }
    if (provider !== 'local' && !values[`${prefix}_name`]) {
        throw new Error(`${prefix}_name must name the model, such as claude-opus-5-5 or llama3.1, when ${prefix}_provider is ${String(provider)}.`);
    }
    const command = values[`${prefix}_api_key_command`];
    if (!Array.isArray(command) || command.some((part) => typeof part !== 'string' || !part)) {
        throw new Error(`${prefix}_api_key_command must be a program and its arguments, or empty for none.`);
    }
}

const ALLOWED_IMAP_FIELDS = new Set(['name', 'host', 'port', 'username', 'password_command', 'folder']);

export function validateImapAccounts(accounts: unknown): ImapAccount[] {
    if (!Array.isArray(accounts)) {
        throw new Error('mail_imap_accounts must be a list.');
    }
    const seenNames = new Set<string>();
    return accounts.map((account: unknown, index): ImapAccount => {
        const where = `mail_imap_accounts[${index}]`;
        if (!isObject(account)) {
            throw new Error(`${where} must be an object.`);
        }
        const unknownFields = Object.keys(account).filter((key) => !ALLOWED_IMAP_FIELDS.has(key));
        if (unknownFields.length > 0) {
            throw new Error(`Unknown field(s) in ${where}: ${unknownFields.sort().join(', ')}`);
        }
        const { name, host, username } = account;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
            throw new Error(`${where}.name must be 1-32 letters, numbers, '_' or '-'.`);
        }
        if (seenNames.has(name)) {
            throw new Error(`IMAP account names must be unique: ${name}.`);
        }
        seenNames.add(name);
        if (typeof host !== 'string' || !/^[A-Za-z0-9.-]+$/.test(host.trim())) {
            throw new Error(`${where}.host must be a host name.`);
        }
        if (typeof username !== 'string' || !username.trim()) {
            throw new Error(`${where}.username must be a non-empty string.`);
        }
        const port = account.port ?? 993;
        if (!isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`${where}.port must be an integer from 1 to 65535.`);
        }
        const command = account.password_command;
        if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part)) {
            throw new Error(`${where}.password_command must be a program and its arguments, such as ["pass", "show", "mail"].`);
        }
        const folder = account.folder ?? 'INBOX';
        if (typeof folder !== 'string' || !/^[^\r\n"\\]+$/.test(folder)) {
            throw new Error(`${where}.folder must be a mailbox name.`);
        }
        return { name, host: host.trim(), port, username: username.trim(), password_command: command as string[], folder };
    });
}

// ============================================================================
// Loading and saving
// ============================================================================

export const ASSISTANT_SETTINGS: SettingsSchema<AssistantSettings> = {
    defaults: ASSISTANT_DEFAULT_SETTINGS,
    validate: validateAssistantSettings,
    bundledPath: ASSISTANT_SETTINGS_PATH,
    userPath: ASSISTANT_USER_SETTINGS_PATH,
};

// Pick the settings file: one in the working folder, then the one beside the program, then the user's own.
export function assistantSettingsPath(): string {
    return defaultSettingsPath({ bundledPath: ASSISTANT_SETTINGS_PATH, userPath: ASSISTANT_USER_SETTINGS_PATH });
}

export function loadAssistantSettings(settingsPath: string): AssistantSettings {
    return loadSettings(settingsPath, ASSISTANT_SETTINGS);
}

export function saveAssistantSettings(settingsPath: string, values: Record<string, unknown>): AssistantSettings {
    return saveSettings(settingsPath, values, validateAssistantSettings);
}
