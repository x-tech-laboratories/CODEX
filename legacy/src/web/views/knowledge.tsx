// The Knowledge page: the store as a graph, with the chosen node's sources, facts and relationships beside it.
import { SearchBox } from '@x-tech-laboratories/x-libs/web/react/controls';
import { Section, Toolbar } from '@x-tech-laboratories/x-libs/web/react/layout';
import { useEffect, useMemo, useRef } from 'react';

import type { KnowledgeGraph } from '../knowledge_graph.ts';
import { choice_key, chosen_knowledge, facts_markdown, graph_markdown, knowledge_tree, sources_markdown } from '../knowledge_view.ts';
import { choose_knowledge, knowledge, knowledge_choice, knowledge_query, refresh_knowledge, search_knowledge } from '../lib/controller.ts';
import { use_store } from '@x-tech-laboratories/x-libs/web/react/store';
import { KnowledgeGraphView } from '../widgets/graph_views.tsx';
import { Markdown } from '@x-tech-laboratories/x-libs/web/react/markdown';

export const CHOOSE_TEXT = 'Select a topic or search stored evidence.';

export function Knowledge() {
    const store = use_store(knowledge);
    const query = use_store(knowledge_query);
    const choice = use_store(knowledge_choice);
    const graph = useRef<KnowledgeGraph | null>(null);
    useEffect(() => void refresh_knowledge(), []);

    const tree = useMemo(() => knowledge_tree(store.topics, store.sources, store.facts), [store]);
    const chosen = query
        ? { sources: store.matches, facts: store.facts, graph: store.graph }
        : chosen_knowledge(choice, store.sources, store.facts, store.graph);

    return (
        <div className="page knowledge">
            <Toolbar>
                <SearchBox label="Search stored evidence" value={query} on_submit={search_knowledge} submit_label="Search" />
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
