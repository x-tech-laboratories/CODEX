// Run a command that prints a secret, such as a password manager's, so settings name the program and never hold the secret.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SECRET_TIMEOUT_MILLISECONDS = 10_000;
export const MAX_SECRET_CHARS = 1024;

export type SecretReader = (command: string[]) => Promise<string>;

export class SecretCommandError extends Error {
    constructor() {
        super('The command gave no usable secret.');
        this.name = 'SecretCommandError';
    }
}

// Take the first line the program prints; a missing or overlong line is refused.
export const readSecret: SecretReader = async ([program, ...args]) => {
    const { stdout } = await run(program, args, { timeout: SECRET_TIMEOUT_MILLISECONDS, maxBuffer: MAX_SECRET_CHARS * 4, encoding: 'utf8' });
    const secret = stdout.split('\n')[0].replace(/\r$/, '');
    if (!secret || secret.length > MAX_SECRET_CHARS) {
        throw new SecretCommandError();
    }
    return secret;
};
