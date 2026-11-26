import { appIdentity, configDirectory, instructionsFileNames } from '@x-tech-laboratories/smartharness/identity';
import { describe, expect, it } from 'vitest';

import { CODEX_IDENTITY } from './identity.js';

describe('CODEX identity', () => {
    it('gives the harness the codex folders and CODEX.md once imported', () => {
        expect(appIdentity()).toEqual(CODEX_IDENTITY);
        expect(configDirectory().endsWith('codex')).toBe(true);
        expect(instructionsFileNames()).toEqual(['CODEX.md', 'AGENTS.md']);
    });
});
