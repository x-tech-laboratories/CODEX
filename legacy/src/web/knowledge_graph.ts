// The knowledge page's graph, drawn with force-graph: the topic tree plus relationships and evidence links.
import ForceGraph from 'force-graph';

import { choice_key, is_relationship, type MapNode, type TreeChoice } from './knowledge_view.ts';
import type { Fact, GraphEdge, Source } from './types.ts';

export const MAX_LABEL_CHARS = 48;
const FIT_PADDING = 40;
// Fitting a few nodes stops at this zoom rather than filling the panel with them.
const MAX_FIT_ZOOM = 1.5;
const DOUBLE_CLICK_MILLISECONDS = 350;
// Below this zoom only topics keep their labels, so a zoomed-out graph stays readable.
const LEAF_LABEL_ZOOM = 0.8;

// ============================================================================
// Elements
// ============================================================================

// What a graph node or connection stands for; each kind is drawn differently.
export type ElementKind = TreeChoice['kind'] | 'tree' | 'relation' | 'evidence';

export type GraphNode = { id: string; label: string; text: string; kind: ElementKind; choice: TreeChoice };

export type GraphLink = { id: string; source: string; target: string; kind: ElementKind; label: string };

export type KnowledgeElements = { nodes: GraphNode[]; links: GraphLink[] };

export function label(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

// Turns the topic tree and relationships into nodes and links: tree lines, named relation arrows and evidence lines.
export function knowledge_elements(tree: MapNode, graph: GraphEdge[], sources: Source[], facts: Fact[]): KnowledgeElements {
    const nodes: GraphNode[] = [];
    const links = new Map<string, GraphLink>();
    const link = (source: string, target: string, kind: ElementKind, name = ''): void => {
        const id = `${kind}:${source}>${target}${name ? `:${name}` : ''}`;
        links.set(id, { id, source, target, kind, label: name });
    };
    const walk = (node: MapNode): void => {
        nodes.push({ id: node.key, label: label(node.text), text: node.text, kind: node.choice.kind, choice: node.choice });
        for (const child of node.children) {
            link(node.key, child.key, 'tree');
            walk(child);
        }
    };
    walk(tree);

    const articles = new Map(sources.map((source) => [source.url, choice_key({ kind: 'source', id: source.id })]));
    for (const fact of facts) {
        const article = fact.source_url ? articles.get(fact.source_url) : undefined;
        if (article !== undefined) {
            link(article, choice_key({ kind: 'fact', id: fact.id }), 'evidence');
        }
    }

    const entities = new Set<string>();
    for (const edge of graph.filter(is_relationship)) {
        for (const name of [edge.source, edge.target]) {
            if (!entities.has(name)) {
                entities.add(name);
                const choice: TreeChoice = { kind: 'entity', label: name };
                nodes.push({ id: choice_key(choice), label: label(name), text: name, kind: 'entity', choice });
            }
        }
        const from = choice_key({ kind: 'entity', label: edge.source });
        const to = choice_key({ kind: 'entity', label: edge.target });
        link(from, to, 'relation', edge.relation);
        const article = edge.evidence_url ? articles.get(edge.evidence_url) : undefined;
        if (article !== undefined) {
            link(article, from, 'evidence');
            link(article, to, 'evidence');
        }
    }
    return { nodes, links: [...links.values()] };
}

// The keys of everything below a folded branch, which the graph hides.
export function hidden_keys(tree: MapNode, folded: Set<string>): Set<string> {
    const hidden = new Set<string>();
    const hide = (node: MapNode): void => {
        for (const child of node.children) {
            hidden.add(child.key);
            hide(child);
        }
    };
    const walk = (node: MapNode): void => {
        if (folded.has(node.key)) {
            hide(node);
        } else {
            node.children.forEach(walk);
        }
    };
    walk(tree);
    return hidden;
}

// Leaves out folded branches and things whose supporting articles are all folded away; unsupported things always show.
export function visible_elements(elements: KnowledgeElements, hidden: Set<string>): KnowledgeElements {
    const shown_articles = new Map<string, boolean>();
    for (const link of elements.links) {
        if (link.kind === 'evidence' && link.target.startsWith('entity:')) {
            shown_articles.set(link.target, (shown_articles.get(link.target) ?? false) || !hidden.has(link.source));
        }
    }
    const nodes = elements.nodes.filter((node) => !hidden.has(node.id) && shown_articles.get(node.id) !== false);
    const shown = new Set(nodes.map((node) => node.id));
    return { nodes, links: elements.links.filter((link) => shown.has(link.source) && shown.has(link.target)) };
}

// ============================================================================
// Drawing
// ============================================================================

export type KnowledgeGraphOptions = { on_choose: (choice: TreeChoice) => void };

// The simulation's copies: force-graph adds positions to nodes and swaps link ends for the node objects.
type SimNode = GraphNode & { x?: number; y?: number; vx?: number; vy?: number };
type SimLink = Omit<GraphLink, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode };

type Palette = { foreground: string; muted: string; primary: string; line: string; surface: string; entity: string; font: string };

function palette(): Palette {
    const style = getComputedStyle(document.documentElement);
    const colour = (name: string): string => style.getPropertyValue(name).trim();
    return {
        foreground: colour('--text-body'),
        muted: colour('--text-tertiary'),
        primary: colour('--accent'),
        line: colour('--border-control'),
        surface: colour('--surface-default'),
        entity: colour('--status-success'),
        font: getComputedStyle(document.body).fontFamily,
    };
}

const RADIUS: Record<string, number> = { all: 9, topic: 6, uncategorized: 6, entity: 5, source: 4, fact: 4 };
const DISTANCE: Record<string, number> = { tree: 40, relation: 70, evidence: 90 };

function shape(context: CanvasRenderingContext2D, node: SimNode, radius: number): void {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    context.beginPath();
    if (node.kind === 'source') {
        context.rect(x - radius, y - radius, radius * 2, radius * 2);
    } else if (node.kind === 'fact') {
        context.moveTo(x, y - radius * 1.3);
        context.lineTo(x + radius * 1.3, y);
        context.lineTo(x, y + radius * 1.3);
        context.lineTo(x - radius * 1.3, y);
        context.closePath();
    } else if (node.kind === 'entity') {
        for (let corner = 0; corner < 6; corner++) {
            const angle = (Math.PI / 3) * corner;
            context.lineTo(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
        }
        context.closePath();
    } else {
        context.arc(x, y, radius, 0, Math.PI * 2);
    }
}

// Keeps a live force-directed graph of the knowledge store; a double-click on a branch folds or unfolds it.
export class KnowledgeGraph {
    private readonly container: HTMLElement;
    private readonly options: KnowledgeGraphOptions;
    private readonly graph: ForceGraph<SimNode, SimLink>;
    private readonly folded = new Set<string>();
    private colours = palette();
    private tree: MapNode | null = null;
    private elements: KnowledgeElements = { nodes: [], links: [] };
    private sim_nodes = new Map<string, SimNode>();
    private chosen_key: string | null = null;
    private drawn_ids = '';
    private fit_pending = true;
    private last_click = { id: '', time: 0 };

    constructor(container: HTMLElement, options: KnowledgeGraphOptions) {
        this.container = container;
        this.options = options;
        this.graph = new ForceGraph<SimNode, SimLink>(container)
            .nodeId('id')
            // The layout settles a while before the first frame, then runs on for a few seconds.
            .warmupTicks(100)
            .cooldownTime(4000)
            .nodeLabel(() => '')
            .nodeCanvasObject((node, context, scale) => this.draw_node(node, context, scale))
            .nodePointerAreaPaint((node, colour, context) => {
                context.fillStyle = colour;
                shape(context, node, (RADIUS[node.kind] ?? 4) + 3);
                context.fill();
            })
            .linkColor((link) => (link.kind === 'relation' ? this.colours.entity : this.colours.line))
            .linkWidth((link) => (link.kind === 'evidence' ? 0.6 : 1.2))
            .linkLineDash((link) => (link.kind === 'evidence' ? [3, 3] : null))
            .linkDirectionalArrowLength((link) => (link.kind === 'relation' ? 4 : 0))
            .linkDirectionalArrowRelPos(1)
            .linkCanvasObjectMode((link) => (link.kind === 'relation' ? 'after' : undefined))
            .linkCanvasObject((link, context, scale) => this.draw_relation_name(link, context, scale))
            .onNodeClick((node) => this.click(node))
            .onNodeHover((node) => {
                // Labels are shortened, so the full text shows as the pointer's tooltip.
                this.container.title = node?.text ?? '';
            })
            .onEngineStop(() => {
                if (this.fit_pending) {
                    this.fit_pending = false;
                    this.reset_view();
                }
            });
        const links = this.graph.d3Force('link') as unknown as { distance(length: (link: SimLink) => number): void } | undefined;
        links?.distance((link) => DISTANCE[link.kind] ?? 50);
        const charge = this.graph.d3Force('charge') as unknown as { strength(strength: number): void } | undefined;
        charge?.strength(-150);
        // The canvas follows the panel's size, and the graph is fitted to it again.
        new ResizeObserver(() => {
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                this.graph.width(container.clientWidth).height(container.clientHeight);
                this.reset_view();
            }
        }).observe(container);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            this.colours = palette();
        });
        new MutationObserver(() => {
            this.colours = palette();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    draw(tree: MapNode, graph: GraphEdge[], sources: Source[], facts: Fact[], chosen_key: string | null): void {
        this.tree = tree;
        this.chosen_key = chosen_key;
        this.elements = knowledge_elements(tree, graph, sources, facts);
        const ids = [...this.elements.nodes.map((node) => node.id), ...this.elements.links.map((link) => link.id)].join('\n');
        if (ids !== this.drawn_ids) {
            this.fit_pending = this.drawn_ids === '';
            this.drawn_ids = ids;
            this.apply_folds();
        }
    }

    expand_all(): void {
        this.folded.clear();
        this.fit_pending = true;
        this.apply_folds();
    }

    // Folds every branch below the root, leaving only the top-level topics and the things no article mentions.
    collapse_all(): void {
        for (const branch of this.tree?.children ?? []) {
            if (branch.children.length > 0) {
                this.folded.add(branch.key);
            }
        }
        this.fit_pending = true;
        this.apply_folds();
    }

    reset_view(): void {
        // Until the simulation has placed the nodes there is nothing to fit, and fitting would leave the zoom unset.
        if (![...this.sim_nodes.values()].some((node) => Number.isFinite(node.x))) {
            return;
        }
        this.graph.zoomToFit(0, FIT_PADDING);
        if (this.graph.zoom() > MAX_FIT_ZOOM) {
            this.graph.zoom(MAX_FIT_ZOOM);
        }
    }

    // One click chooses a node; a second on the same branch soon after folds or unfolds it.
    private click(node: SimNode): void {
        const now = Date.now();
        const twice = this.last_click.id === node.id && now - this.last_click.time < DOUBLE_CLICK_MILLISECONDS;
        this.last_click = { id: node.id, time: twice ? 0 : now };
        if (twice) {
            this.toggle(node.id);
        } else {
            this.options.on_choose(node.choice);
        }
    }

    private toggle(key: string): void {
        if (!this.elements.links.some((link) => link.kind === 'tree' && link.source === key)) {
            return;
        }
        if (!this.folded.delete(key)) {
            this.folded.add(key);
        }
        this.apply_folds();
    }

    // Hands the simulation what is shown, reusing each node's old position so the graph moves on rather than restarting.
    private apply_folds(): void {
        if (this.tree === null) {
            return;
        }
        const shown = visible_elements(this.elements, hidden_keys(this.tree, this.folded));
        const previous = this.sim_nodes;
        this.sim_nodes = new Map(
            shown.nodes.map((node) => {
                const old = previous.get(node.id);
                return [node.id, { ...node, x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy }];
            }),
        );
        this.graph.graphData({
            nodes: [...this.sim_nodes.values()],
            links: shown.links.map((link) => ({ ...link })),
        });
    }

    private draw_node(node: SimNode, context: CanvasRenderingContext2D, scale: number): void {
        const colours = this.colours;
        const radius = RADIUS[node.kind] ?? 4;
        shape(context, node, radius);
        context.fillStyle =
            node.kind === 'entity' ? colours.entity : node.kind === 'source' || node.kind === 'fact' ? colours.line : colours.primary;
        context.fill();
        if (this.folded.has(node.id)) {
            context.lineWidth = 2 / scale;
            context.strokeStyle = colours.primary;
            shape(context, node, radius + 3 / scale);
            context.stroke();
        }
        if (node.id === this.chosen_key) {
            context.lineWidth = 2 / scale;
            context.strokeStyle = colours.foreground;
            shape(context, node, radius + 1.5 / scale);
            context.stroke();
        }
        const leaf = node.kind === 'source' || node.kind === 'fact' || node.kind === 'entity';
        if (leaf && scale < LEAF_LABEL_ZOOM) {
            return;
        }
        const size = (node.kind === 'all' ? 14 : leaf ? 11 : 12) / scale;
        context.font = `${leaf ? '' : '600 '}${node.kind === 'fact' ? 'italic ' : ''}${size}px ${colours.font}`;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        context.lineWidth = 3 / scale;
        context.strokeStyle = colours.surface;
        const text_y = (node.y ?? 0) + radius + 2 / scale;
        context.strokeText(node.label, node.x ?? 0, text_y);
        context.fillStyle = leaf ? colours.muted : colours.foreground;
        context.fillText(node.label, node.x ?? 0, text_y);
    }

    private draw_relation_name(link: SimLink, context: CanvasRenderingContext2D, scale: number): void {
        const start = link.source;
        const end = link.target;
        if (typeof start === 'string' || typeof end === 'string' || scale < LEAF_LABEL_ZOOM) {
            return;
        }
        const x = ((start.x ?? 0) + (end.x ?? 0)) / 2;
        const y = ((start.y ?? 0) + (end.y ?? 0)) / 2;
        context.font = `${10 / scale}px ${this.colours.font}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineWidth = 3 / scale;
        context.strokeStyle = this.colours.surface;
        context.strokeText(link.label, x, y);
        context.fillStyle = this.colours.muted;
        context.fillText(link.label, x, y);
    }
}
