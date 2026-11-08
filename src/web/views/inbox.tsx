// The Inbox: the actions the assistant proposes, each a card with Done and Dismiss.
import { Card, Cards } from '@x-tech-laboratories/x-libs/web/react/layout';
import { Empty } from '@x-tech-laboratories/x-libs/web/react/states';
import { useEffect } from 'react';

import { action_cards, NO_ACTIONS_TEXT } from '../inbox_view.ts';
import { inbox, refresh_inbox, resolve_action } from '../lib/controller.ts';
import { use_store } from '../lib/store.ts';

export function Inbox() {
    const actions = use_store(inbox);
    useEffect(() => void refresh_inbox(), []);
    const cards = action_cards(actions);

    return (
        <div className="page">
            <h2>Proposed by the assistant</h2>
            {cards.length === 0 ? <Empty title={NO_ACTIONS_TEXT} /> : (
                <Cards>
                    {cards.map((card) => (
                        <Card key={card.id} title={card.title} subtitle={card.meta}>
                            <p className="inbox-body">{card.body}</p>
                            <div className="toolbar">
                                {card.buttons.map((choice) => (
                                    <button key={choice.resolution} onClick={() => void resolve_action(card.id, choice.resolution)}>{choice.label}</button>
                                ))}
                            </div>
                        </Card>
                    ))}
                </Cards>
            )}
        </div>
    );
}
