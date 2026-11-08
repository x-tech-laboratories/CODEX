// How the window shows the knowledge store and the research queue: the graph's tree, sources, facts, relationships and jobs.
import type { Fact, GraphEdge, ResearchJob, Source, Topic } from './types.ts';

export const MAX_GRAPH_EDGES = 50;
export const MAX_QUEUE_JOBS = 20;
export const NO_SOURCES_TEXT = '_No matching stored evidence._';
export const NO_GRAPH_TEXT = '_No graph relationships yet._';
export const NO_FACTS_TEXT = '_No facts stored for this choice._';
export const NO_JOBS_TEXT = 'No research jobs';

// ============================================================================
// Tree
// ============================================================================

export const MAX_LISTED_SOURCES = 30;
export const UNCATEGORIZED_TEXT = 'Uncategorized';

export type TreeChoice =
    | { kind: 'all' }
    | { kind: 'topic'; id: number }
    | { kind: 'uncategorized' }
    | { kind: 'source'; id: number }
    | { kind: 'fact'; id: number }
    | { kind: 'entity'; label: string };

export type MapNode = { key: string; choice: TreeChoice; text: string; children: MapNode[] };

export function choice_key(choice: TreeChoice): string {
    if (choice.kind === 'entity') {
        return `entity:${choice.label}`;
    }
    return 'id' in choice ? `${choice.kind}:${choice.id}` : choice.kind;
}

// A relationship between two named things, rather than the topic and article links the tree already shows.
export function is_relationship(edge: GraphEdge): boolean {
    return edge.source_kind === 'entity' && edge.target_kind === 'entity';
}

function map_node(choice: TreeChoice, text: string, children: MapNode[] = []): MapNode {
    return { key: choice_key(choice), choice, text, children };
}

// Builds the store as a tree under "All topics": topics hold subtopics, articles and findings; loose articles go last.
export function knowledge_tree(topics: Topic[], sources: Source[], facts: Fact[]): MapNode {
    const children = group_by(topics, (topic) => topic.parent_id);
    const sources_by_topic = group_by(sources, (source) => source.topic_id ?? null);
    const facts_by_topic = group_by(facts, (fact) => fact.topic_id);
    const entries = (topic_id: number | null): MapNode[] => [
        ...(sources_by_topic.get(topic_id) ?? []).map((source) => map_node({ kind: 'source', id: source.id }, source.title || source.url)),
        ...(facts_by_topic.get(topic_id) ?? []).map((fact) => map_node({ kind: 'fact', id: fact.id }, fact.statement)),
    ];
    const visited = new Set<number>();
    const build = (topic: Topic): MapNode => {
        visited.add(topic.id);
        const subtopics = (children.get(topic.id) ?? []).filter((child) => !visited.has(child.id)).map(build);
        return map_node({ kind: 'topic', id: topic.id }, `${topic.name}  (${topic.source_count})`, [...subtopics, ...entries(topic.id)]);
    };
    const branches = (children.get(null) ?? []).map(build);
    for (const topic of topics) {
        if (!visited.has(topic.id)) {
            branches.push(build(topic));
        }
    }
    const uncategorized = entries(null);
    if (uncategorized.length > 0) {
        branches.push(map_node({ kind: 'uncategorized' }, `${UNCATEGORIZED_TEXT}  (${uncategorized.length})`, uncategorized));
    }
    return map_node({ kind: 'all' }, 'All topics', branches);
}

function group_by<Item>(items: Item[], key: (item: Item) => number | null): Map<number | null, Item[]> {
    const groups = new Map<number | null, Item[]>();
    for (const item of items) {
        const group = groups.get(key(item)) ?? [];
        group.push(item);
        groups.set(key(item), group);
    }
    return groups;
}

export type ChosenKnowledge = { sources: Source[]; facts: Fact[]; graph: GraphEdge[] };

// Picks what the side panes show for a graph node: its articles, findings and relationships.
export function chosen_knowledge(choice: TreeChoice, sources: Source[], facts: Fact[], graph: GraphEdge[]): ChosenKnowledge {
    switch (choice.kind) {
        case 'all':
            return { sources: sources.slice(0, MAX_LISTED_SOURCES), facts, graph };
        case 'topic':
            return {
                sources: sources.filter((source) => source.topic_id === choice.id).slice(0, MAX_LISTED_SOURCES),
                facts: facts.filter((fact) => fact.topic_id === choice.id),
                graph,
            };
        case 'uncategorized':
            return { sources: sources.filter((source) => source.topic_id == null).slice(0, MAX_LISTED_SOURCES), facts: [], graph };
        case 'source': {
            const source = sources.find((candidate) => candidate.id === choice.id);
            return {
                sources: source ? [source] : [],
                facts: source ? facts.filter((fact) => fact.source_url === source.url) : [],
                graph: source ? graph.filter((edge) => is_relationship(edge) && edge.evidence_url === source.url) : [],
            };
        }
        case 'fact': {
            const fact = facts.find((candidate) => candidate.id === choice.id);
            return {
                sources: fact?.source_url ? sources.filter((source) => source.url === fact.source_url) : [],
                facts: fact ? [fact] : [],
                graph: [],
            };
        }
        case 'entity': {
            const edges = graph.filter((edge) => is_relationship(edge) && (edge.source === choice.label || edge.target === choice.label));
            const evidence = new Set(edges.map((edge) => edge.evidence_url));
            return { sources: sources.filter((source) => evidence.has(source.url)), facts: [], graph: edges };
        }
    }
}

// ============================================================================
// Sources, facts and graph
// ============================================================================

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function format_timestamp(seconds: number): string {
    const when = new Date(seconds * 1000);
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function sources_markdown(sources: Source[]): string {
    if (sources.length === 0) {
        return NO_SOURCES_TEXT;
    }
    return sources
        .map((source) => {
            const title = source.title || source.url;
            return (
                `### [${title}](${source.url})\n` +
                `${source.topic || 'Uncategorized'} | Retrieved ${format_timestamp(source.retrieved_at)}\n\n` +
                `${source.snippet ?? ''}\n\n` +
                `${source.summary ?? ''}`
            );
        })
        .join('\n\n---\n\n');
}

export function facts_markdown(facts: Fact[]): string {
    if (facts.length === 0) {
        return NO_FACTS_TEXT;
    }
    return facts
        .map((fact) => {
            const evidence = fact.source_url ? ` ([evidence](${fact.source_url}))` : '';
            const set_aside = fact.status !== 'active' ? `, ${fact.status}` : '';
            return `- **${fact.topic}**: ${fact.statement} _(confidence ${fact.confidence.toFixed(2)}${set_aside})_${evidence}`;
        })
        .join('\n');
}

export function graph_markdown(edges: GraphEdge[]): string {
    const lines = edges
        .slice(0, MAX_GRAPH_EDGES)
        .map((edge) => `\`${edge.source}\` -${edge.relation}-> \`${edge.target}\`` + (edge.evidence_url ? ` ([evidence](${edge.evidence_url}))` : ''));
    return lines.length > 0 ? lines.join('\n\n') : NO_GRAPH_TEXT;
}

// ============================================================================
// Research queue
// ============================================================================

export function queue_lines(jobs: ResearchJob[]): string {
    if (jobs.length === 0) {
        return NO_JOBS_TEXT;
    }
    return jobs
        .slice(0, MAX_QUEUE_JOBS)
        .map((job) => `${job.status.toUpperCase().padEnd(8)} ${job.topic}` + (job.error ? `  (${job.error})` : ''))
        .join('\n');
}
