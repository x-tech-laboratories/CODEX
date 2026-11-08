// The Knowledge page: the store as a graph, with the chosen node's sources, facts and relationships beside it.
import { Section, Toolbar } from '@x-tech-laboratories/x-libs/web/react/layout';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { KnowledgeGraph } from '../knowledge_graph.ts';
import { choice_key, chosen_knowledge, facts_markdown, graph_markdown, knowledge_tree, sources_markdown } from '../knowledge_view.ts';
import { choose_knowledge, knowledge, knowledge_choice, knowledge_query, refresh_knowledge, search_knowledge } from '../lib/controller.ts';
import { use_store } from '../lib/store.ts';
import { KnowledgeGraphView } from '../widgets/graph_views.tsx';
import { Markdown } from '../widgets/markdown.tsx';

export const CHOOSE_TEXT = 'Select a topic or search stored evidence.';

export function Knowledge() {
    const store = use_store(knowledge);
    const query = use_store(knowledge_query);
    const choice = use_store(knowledge_choice);
    const [typed, set_typed] = useState(query);
    const graph = useRef<KnowledgeGraph | null>(null);
    useEffect(() => void refresh_knowledge(), []);
    useEffect(() => set_typed(query), [query]);

    const tree = useMemo(() => knowledge_tree(store.topics, store.sources, store.facts), [store]);
    const chosen = query
        ? { sources: store.matches, facts: store.facts, graph: store.graph }
        : chosen_knowledge(choice, store.sources, store.facts, store.graph);

    return (
        <div className="page knowledge">
            <Toolbar>
                <input
                    type="search"
                    className="grow"
                    aria-label="Search stored evidence"
                    placeholder="Search stored evidence, then press Enter"
                    value={typed}
                    onChange={(event) => set_typed(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') search_knowledge(typed); }}
                />
                <button onClick={() => search_knowledge(typed)}>Search</button>
                <button onClick={() => void refresh_knowledge()}>Refresh</button>
            </Toolbar>
            <div className="knowledge-browser">
                <Section
                    title="Knowledge graph"
                    tools={<>
                        <button className="small" onClick={() => graph.current?.expand_all()}>Expand all</button>
                        <button className="small" onClick={() => graph.current?.collapse_all()}>Collapse all</button>
                        <button className="small" onClick={() => graph.current?.reset_view()}>Reset view</button>
                    </>}
                >
                    <KnowledgeGraphView
                        tree={tree}
                        graph={store.graph}
                        sources={store.sources}
                        facts={store.facts}
                        chosen_key={query ? null : choice_key(choice)}
                        on_choose={choose_knowledge}
                        graph_ref={graph}
                    />
                </Section>
                <Section title={query ? `Sources matching "${query}"` : 'Sources'}>
                    <Markdown class_name="output" text={store.topics.length === 0 && store.sources.length === 0 && !query ? CHOOSE_TEXT : sources_markdown(chosen.sources)} />
                </Section>
            </div>
            <div className="columns">
                <Section title="Facts">
                    <Markdown class_name="output" text={facts_markdown(chosen.facts)} />
                </Section>
                <Section title="Graph relationships">
                    <Markdown class_name="output" text={graph_markdown(chosen.graph)} />
                </Section>
            </div>
        </div>
    );
}
