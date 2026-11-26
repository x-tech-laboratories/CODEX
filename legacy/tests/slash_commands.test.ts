import { describe, expect, it } from 'vitest';

import { command_suggestions, complete_command } from '../src/web/slash_commands.ts';

const user_commands = [{ name: 'review', description: 'Review a file', mode: 'answer' }, { name: 'release', description: '', mode: null }];

describe('slash command suggestions', () => {
    it('offers the memory commands, /init, mode words and user commands', () => {
        const names = command_suggestions('/', user_commands).map((suggestion) => suggestion.name);

        expect(names).toEqual(['remember', 'memories', 'forget', 'init', 'answer', 'draft', 'plan', 'do', 'execute', 'review', 'release']);
    });

    it('narrows the list as the word is typed and stops once arguments start', () => {
        const matching = command_suggestions('  /RE', user_commands);

        expect(matching.map((suggestion) => suggestion.name)).toEqual(['remember', 'review', 'release']);
        expect(matching[1].description).toBe('Review a file (answer mode)');
        expect(matching[2].description).toBe('Your command');
        expect(command_suggestions('/remember tea', user_commands)).toEqual([]);
        expect(command_suggestions('remember', user_commands)).toEqual([]);
    });

    it('puts the chosen command at the start and keeps the rest', () => {
        expect(complete_command('/rem', 'remember')).toBe('/remember ');
        expect(complete_command('  /x keep this', 'init')).toBe('/init keep this');
    });
});
