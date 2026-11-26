import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

describe('licence', () => {
    it('is GPL-3.0-or-later in package.json and the LICENSE file', () => {
        const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { license: string; engines: { node: string } };
        const licence = readFileSync(new URL('LICENSE', root), 'utf8');

        expect(manifest.license).toBe('GPL-3.0-or-later');
        expect(manifest.engines.node).toBe('>=24');
        expect(licence).toContain('GNU GENERAL PUBLIC LICENSE');
        expect(licence).toContain('Version 3, 29 June 2007');
    });
});
