import { describe, expect, it } from 'vitest';

import { MAX_SECRET_CHARS, readSecret, SecretCommandError } from './secretCommand.js';

describe('readSecret', () => {
    it('takes the first line the program prints', async () => {
        expect(await readSecret(['printf', 'first\r\nsecond\n'])).toBe('first');
    });

    it('refuses an empty or overlong line', async () => {
        await expect(readSecret(['printf', ''])).rejects.toThrow(SecretCommandError);
        await expect(readSecret(['printf', 'x'.repeat(MAX_SECRET_CHARS + 1)])).rejects.toThrow('no usable secret');
    });

    it('passes on a program that fails', async () => {
        await expect(readSecret(['false'])).rejects.toThrow();
    });
});
