// The request box: a text area that suggests slash commands as the first word is typed.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

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
    const [suggestions, set_suggestions] = useState<CommandSuggestion[]>([]);
    const [index, set_index] = useState(0);
    const latest_value = useRef(value);
    latest_value.current = value;

    useEffect(() => {
        box.current?.focus();
    }, []);

    // Suggestions follow the text as it changes, and leave once a space follows the command.
    useEffect(() => {
        if (!value.trimStart().startsWith('/')) {
            set_suggestions([]);
            return;
        }
        let stale = false;
        void load_commands().then((commands) => {
            if (stale || latest_value.current !== value) return;
            set_suggestions(command_suggestions(value, commands));
            set_index(0);
        });
        return () => {
            stale = true;
        };
    }, [value]);

    function take(choice: number): void {
        const suggestion = suggestions[choice];
        if (suggestion === undefined) return;
        on_change(complete_command(value, suggestion.name));
        set_suggestions([]);
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
            return;
        }
        if (suggestions.length === 0) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            set_index((index + step + suggestions.length) % suggestions.length);
        } else if ((event.key === 'Tab' || event.key === 'Enter') && !event.ctrlKey) {
            event.preventDefault();
            take(index);
        } else if (event.key === 'Escape') {
            set_suggestions([]);
        }
    }

    return (
        <div className="prompt-wrap">
            <textarea
                ref={box}
                id="prompt"
                aria-label="Your request"
                rows={4}
                spellCheck
                readOnly={read_only}
                placeholder="Ask, draft or change something. Type / for commands."
                value={value}
                onChange={(event) => on_change(event.currentTarget.value)}
                onKeyDown={key_down}
                onBlur={() => set_suggestions([])}
                aria-autocomplete="list"
                aria-expanded={suggestions.length > 0}
                aria-controls="command-suggestions"
            />
            {suggestions.length > 0 && (
                <ul id="command-suggestions" className="suggestions menu" role="listbox" aria-label="Commands">
                    {suggestions.map((suggestion, position) => (
                        <li
                            key={suggestion.name}
                            role="option"
                            className="menu-item"
                            aria-selected={position === index}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                take(position);
                            }}
                        >
                            <span className="usage">{suggestion.usage}</span>
                            <span className="muted small">{suggestion.description}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
