// The request box: a text area that suggests slash commands as the first word is typed.
import { Suggestions } from '@x-tech-laboratories/x-libs/web/react/suggestions';
import { useEffect, useRef, type KeyboardEvent } from 'react';

import { command_suggestions, complete_command, type CommandSuggestion } from '../slash_commands.ts';
import type { UserCommand } from '../types.ts';

interface PromptBoxProps {
    value: string;
    on_change: (value: string) => void;
    read_only: boolean;
    // The folder's own commands, read when a slash is typed.
    load_commands: () => Promise<UserCommand[]>;
    // Called for Ctrl+Enter inside the box.
    on_run: () => void;
}

export function PromptBox({ value, on_change, read_only, load_commands, on_run }: PromptBoxProps) {
    const box = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        box.current?.focus();
    }, []);

    // The folder's commands are only read once a slash starts the text, and the suggestions leave once a space follows the command.
    function suggest(text: string): CommandSuggestion[] | Promise<CommandSuggestion[]> {
        if (!text.trimStart().startsWith('/')) return [];
        return load_commands().then((commands) => command_suggestions(text, commands));
    }

    function take(suggestion: CommandSuggestion): void {
        on_change(complete_command(value, suggestion.name));
        const field = box.current;
        if (field !== null) {
            field.focus();
            requestAnimationFrame(() => field.setSelectionRange(field.value.length, field.value.length));
        }
    }

    function key_down(event: KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault();
            on_run();
        }
    }

    return (
        <Suggestions<CommandSuggestion, HTMLTextAreaElement>
            value={value}
            source={suggest}
            key_of={(suggestion) => suggestion.name}
            render={(suggestion) => <span className="usage">{suggestion.usage}</span>}
            detail={(suggestion) => suggestion.description}
            on_take={take}
            label="Commands"
            on_key_down={key_down}
        >
            {(field) => (
                <textarea
                    {...field}
                    ref={box}
                    id="prompt"
                    aria-label="Your request"
                    rows={4}
                    spellCheck
                    readOnly={read_only}
                    placeholder="Ask, draft or change something. Type / for commands."
                    value={value}
                    onChange={(event) => on_change(event.currentTarget.value)}
                />
            )}
        </Suggestions>
    );
}
