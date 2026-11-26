// The workbench's task graph, drawn with force-graph: task rows with step chains, subtask lines and dependency arrows.
import ForceGraph from 'force-graph';

import type { StepRecord, TaskNode } from './types.ts';
import { TASK_STATE_WORDS } from './task_view.ts';

export const BOX_WIDTH = 176;
export const BOX_HEIGHT = 46;
export const STEP_WIDTH = 104;
export const STEP_HEIGHT = 26;
export const BOX_GAP = 22;
export const STEP_GAP = 18;
export const ROW_GAP = 150;
// A task's steps sit this far below the task, above the next level of tasks.
export const STEP_ROW_OFFSET = 62;
// Subtasks hang from the last step with this name, the one that planned them.
export const PLANNING_STEP = 'Planning subtasks';
const FIT_MARGIN = 16;
// Fitting a small tree stops at this zoom rather than filling the panel with it.
const MAX_FIT_ZOOM = 1.2;
const ARROW_LENGTH = 7;
// Each step of the layout spaces the rows this many times, so a crowded row clears within a step.
const ROW_PASSES = 3;

// ============================================================================
// Elements
// ============================================================================

export type TaskGraphNode = {
    id: string;
    kind: 'task' | 'step';
    task_id: string;
    // The node a new node starts under: a task's parent task, or a step's own task.
    anchor: string | null;
    depth: number;
    row: number;
    status: string;
    label: string;
    // The full text shown when the pointer rests on the node.
    tooltip: string;
    width: number;
    height: number;
    // For a step node, which step it is: its name and how many steps of that name came before it in the task.
    step: StepTarget | null;
};

export type StepTarget = { name: string; occurrence: number };

export type TaskGraphLink = { id: string; source: string; target: string; kind: 'subtask' | 'dependency' | 'step' };

export type TaskGraphElements = { nodes: TaskGraphNode[]; links: TaskGraphLink[] };

function parent_id(id: string): string | null {
    const separator = id.lastIndexOf('.');
    return separator < 0 ? null : id.slice(0, separator);
}

export function step_id(task_id: string, index: number): string {
    return `${task_id}:${index}`;
}

function seconds(step: StepRecord): string {
    return step.ended_at === null ? '' : `, ${Math.max(0, step.ended_at - step.started_at).toFixed(1)} s`;
}

function step_tooltip(step: StepRecord): string {
    return `${step.name} (${step.status}${seconds(step)})${step.error ? `: ${step.error}` : ''}`;
}

// Turns the task list into graph nodes and links: tasks, their step chains, subtask lines and dependency arrows.
export function task_graph_elements(tasks: TaskNode[]): TaskGraphElements {
    const ids = new Set(tasks.map((task) => task.id));
    const nodes: TaskGraphNode[] = [];
    const links: TaskGraphLink[] = [];
    for (const task of tasks) {
        const parent = parent_id(task.id);
        const depth = task.id.split('.').length - 1;
        const prompt = task.prompt.replace(/\s+/g, ' ').trim();
        nodes.push({
            id: task.id,
            kind: 'task',
            task_id: task.id,
            anchor: parent !== null && ids.has(parent) ? parent : null,
            depth,
            row: depth * ROW_GAP,
            status: task.status in TASK_STATE_WORDS ? task.status : 'pending',
            label: task.id,
            tooltip: prompt,
            width: BOX_WIDTH,
            height: BOX_HEIGHT,
            step: null,
        });
        (task.steps ?? []).forEach((step, index) => {
            const id = step_id(task.id, index);
            nodes.push({
                id,
                kind: 'step',
                task_id: task.id,
                anchor: task.id,
                depth,
                row: depth * ROW_GAP + STEP_ROW_OFFSET,
                status: step.status,
                label: step.name,
                tooltip: step_tooltip(step),
                width: STEP_WIDTH,
                height: STEP_HEIGHT,
                step: { name: step.name, occurrence: (task.steps ?? []).slice(0, index).filter((earlier) => earlier.name === step.name).length },
            });
            const previous = index === 0 ? task.id : step_id(task.id, index - 1);
            links.push({ id: `step:${previous}>${id}`, source: previous, target: id, kind: 'step' });
        });
    }
    const by_id = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
        const parent = parent_id(task.id);
        if (parent === null || !ids.has(parent)) {
            continue;
        }
        const planning = (by_id.get(parent)!.steps ?? []).map((step) => step.name).lastIndexOf(PLANNING_STEP);
        const source = planning < 0 ? parent : step_id(parent, planning);
        links.push({ id: `subtask:${source}>${task.id}`, source, target: task.id, kind: 'subtask' });
    }
    for (const task of tasks) {
        for (const dependency of task.depends_on ?? []) {
            if (ids.has(dependency)) {
                links.push({ id: `dependency:${dependency}>${task.id}`, source: dependency, target: task.id, kind: 'dependency' });
            }
        }
    }
    return { nodes, links };
}

type LinkEnd = string | { id: string };

function end_id(end: LinkEnd): string {
    return typeof end === 'string' ? end : end.id;
}

// Whether a link shows: subtask and step lines always, dependency arrows only when they touch a task in focus.
export function link_shown(link: { kind: string; source: LinkEnd; target: LinkEnd }, focus_ids: (string | null)[]): boolean {
    return link.kind !== 'dependency' || focus_ids.includes(end_id(link.source)) || focus_ids.includes(end_id(link.target));
}

// ============================================================================
// Layout
// ============================================================================

export type Placed = { id: string; width?: number; x?: number; fy?: number };

// Orders tasks and steps as the tree reads, so 1.2.3 comes before 1.3.1, 1.10 after 1.9, and step 1:2 after 1:1.
export function tree_order(first: string, second: string): number {
    const first_parts = first.split(/[.:]/).map(Number);
    const second_parts = second.split(/[.:]/).map(Number);
    for (let index = 0; index < Math.min(first_parts.length, second_parts.length); index++) {
        if (first_parts[index] !== second_parts[index]) {
            return first_parts[index] - second_parts[index];
        }
    }
    return first_parts.length - second_parts.length;
}

// Pushes apart neighbours in the same row that sit closer than their boxes and a gap, keeping each row in tree order.
export function separate_rows(nodes: Placed[]): void {
    const rows = new Map<number, Placed[]>();
    for (const node of nodes) {
        const row = rows.get(node.fy ?? 0) ?? [];
        row.push(node);
        rows.set(node.fy ?? 0, row);
    }
    for (const row of rows.values()) {
        row.sort((first, second) => tree_order(first.id, second.id));
        for (let index = 1; index < row.length; index++) {
            const left = row[index - 1];
            const right = row[index];
            const reach = ((left.width ?? BOX_WIDTH) + (right.width ?? BOX_WIDTH)) / 2;
            const overlap = reach + BOX_GAP - ((right.x ?? 0) - (left.x ?? 0));
            if (overlap > 0) {
                left.x = (left.x ?? 0) - overlap / 2;
                right.x = (right.x ?? 0) + overlap / 2;
            }
        }
    }
}

// Where a new node starts: under its anchor, spread out in order among the nodes that share it.
export function starting_x(anchor_x: number, sibling_index: number, sibling_count: number, width = BOX_WIDTH): number {
    return anchor_x + (sibling_index - (sibling_count - 1) / 2) * (width + BOX_GAP);
}

// ============================================================================
// Drawing
// ============================================================================

export type TaskGraphOptions = { on_choose: (task_id: string, step: StepTarget | null) => void };

// The simulation's copies: force-graph adds positions to nodes and swaps link ends for the node objects.
type SimNode = TaskGraphNode & { x?: number; y?: number; vx?: number; vy?: number; fy?: number };
type SimLink = Omit<TaskGraphLink, 'source' | 'target'> & { source: string | SimNode; target: string | SimNode };

type Palette = {
    foreground: string;
    label: string;
    border: string;
    line: string;
    surface: string;
    step_surface: string;
    dependency: string;
    font: string;
    states: Record<string, string>;
};

function palette(): Palette {
    const style = getComputedStyle(document.documentElement);
    const colour = (name: string): string => style.getPropertyValue(name).trim();
    return {
        foreground: colour('--text-body'),
        label: colour('--text-secondary'),
        border: colour('--border-default'),
        line: colour('--border-control'),
        surface: colour('--surface-default'),
        step_surface: colour('--surface-secondary'),
        dependency: colour('--accent'),
        font: getComputedStyle(document.body).fontFamily,
        states: {
            pending: colour('--text-tertiary'),
            running: colour('--accent'),
            done: colour('--status-success'),
            unverified: colour('--status-warning'),
            failed: colour('--status-danger'),
        },
    };
}

// Shortens text with an ellipsis until it fits the given width.
function fitted(context: CanvasRenderingContext2D, text: string, width: number): string {
    if (context.measureText(text).width <= width) {
        return text;
    }
    let length = text.length;
    while (length > 0 && context.measureText(`${text.slice(0, length)}…`).width > width) {
        length--;
    }
    return `${text.slice(0, length)}…`;
}

function arrow_head(context: CanvasRenderingContext2D, tip_x: number, tip_y: number, angle: number): void {
    context.beginPath();
    context.moveTo(tip_x, tip_y);
    context.lineTo(tip_x - ARROW_LENGTH * Math.cos(angle - 0.4), tip_y - ARROW_LENGTH * Math.sin(angle - 0.4));
    context.lineTo(tip_x - ARROW_LENGTH * Math.cos(angle + 0.4), tip_y - ARROW_LENGTH * Math.sin(angle + 0.4));
    context.closePath();
    context.fill();
}

// Keeps a live graph of the run's tasks and steps that follows the panel's size and recolours nodes in place.
export class TaskGraph {
    private readonly container: HTMLElement;
    private readonly options: TaskGraphOptions;
    private readonly graph: ForceGraph<SimNode, SimLink>;
    private colours = palette();
    private sim_nodes = new Map<string, SimNode>();
    private chosen_id: string | null = null;
    private pointed_id: string | null = null;
    private drawn_ids = '';
    private fit_pending = true;

    constructor(container: HTMLElement, options: TaskGraphOptions) {
        this.container = container;
        this.options = options;
        this.graph = new ForceGraph<SimNode, SimLink>(container)
            .nodeId('id')
            .warmupTicks(100)
            .cooldownTime(2000)
            .nodeLabel(() => '')
            .nodeCanvasObject((node, context) => (node.kind === 'task' ? this.draw_task(node, context) : this.draw_step(node, context)))
            .nodePointerAreaPaint((node, colour, context) => {
                context.fillStyle = colour;
                context.fillRect((node.x ?? 0) - node.width / 2, (node.y ?? 0) - node.height / 2, node.width, node.height);
            })
            .linkVisibility((link) => link_shown(link, [this.chosen_id, this.pointed_id]))
            .linkColor(() => this.colours.line)
            .linkWidth(1.4)
            .linkCanvasObjectMode((link) => (link.kind === 'subtask' ? undefined : 'replace'))
            .linkCanvasObject((link, context) => (link.kind === 'step' ? this.draw_step_link(link, context) : this.draw_dependency(link, context)))
            .onNodeClick((node) => this.options.on_choose(node.task_id, node.step))
            .onNodeHover((node) => {
                // Labels are shortened in the boxes, so the full text shows as the pointer's tooltip.
                this.container.title = node?.tooltip ?? '';
                this.pointed_id = node?.task_id ?? null;
                this.repaint();
            })
            .onEngineStop(() => {
                if (this.fit_pending) {
                    this.fit_pending = false;
                    this.reset_view();
                }
            });
        // Rows are fixed, so only the lines pull sideways and boxes in a row keep apart.
        this.graph.d3Force('charge', null);
        const links = this.graph.d3Force('link') as unknown as
            | { distance(length: number): { strength(strength: (link: SimLink) => number): void } }
            | undefined;
        links?.distance(ROW_GAP).strength((link) => (link.kind === 'subtask' ? 0.6 : link.kind === 'step' ? 0.3 : 0));
        const rows = Object.assign(
            () => {
                for (let pass = 0; pass < ROW_PASSES; pass++) {
                    separate_rows([...this.sim_nodes.values()]);
                }
            },
            { initialize: () => undefined },
        );
        this.graph.d3Force('rows', rows as never);
        new ResizeObserver(() => {
            if (container.clientWidth > 0 && container.clientHeight > 0) {
                this.graph.width(container.clientWidth).height(container.clientHeight);
                this.reset_view();
            }
        }).observe(container);
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            this.colours = palette();
            this.repaint();
        });
        new MutationObserver(() => {
            this.colours = palette();
            this.repaint();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    draw(tasks: TaskNode[], chosen_id: string | null): void {
        this.chosen_id = chosen_id;
        const elements = task_graph_elements(tasks);
        const ids = [...elements.nodes.map((node) => node.id), ...elements.links.map((link) => link.id)].join('\n');
        if (ids === this.drawn_ids) {
            for (const node of elements.nodes) {
                Object.assign(this.sim_nodes.get(node.id) ?? {}, { status: node.status, tooltip: node.tooltip });
            }
            this.repaint();
            return;
        }
        this.drawn_ids = ids;
        this.fit_pending = true;
        this.place(elements);
    }

    // Fits every box, not just the box centres, inside the panel.
    reset_view(): void {
        const placed = [...this.sim_nodes.values()].filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
        if (placed.length === 0 || this.container.clientWidth === 0) {
            return;
        }
        const left = Math.min(...placed.map((node) => (node.x as number) - node.width / 2));
        const right = Math.max(...placed.map((node) => (node.x as number) + node.width / 2));
        const top = Math.min(...placed.map((node) => (node.y as number) - node.height / 2));
        const bottom = Math.max(...placed.map((node) => (node.y as number) + node.height / 2));
        this.graph.centerAt((left + right) / 2, (top + bottom) / 2);
        const zoom = Math.min(
            MAX_FIT_ZOOM,
            this.container.clientWidth / (right - left + FIT_MARGIN * 2),
            this.container.clientHeight / (bottom - top + FIT_MARGIN * 2),
        );
        this.graph.zoom(zoom);
    }

    // Hands the simulation the nodes, keeping each old one where it was and starting new ones under their anchor.
    private place(elements: TaskGraphElements): void {
        const previous = this.sim_nodes;
        this.sim_nodes = new Map();
        const by_row = [...elements.nodes].sort((first, second) => first.row - second.row);
        for (const node of by_row) {
            const old = previous.get(node.id);
            const siblings = elements.nodes.filter((other) => other.anchor === node.anchor && other.kind === node.kind);
            const anchor_x = node.anchor === null ? 0 : (this.sim_nodes.get(node.anchor)?.x ?? 0);
            const x = old?.x ?? starting_x(anchor_x, siblings.indexOf(node), siblings.length, node.width);
            this.sim_nodes.set(node.id, { ...node, x, y: old?.y, vx: old?.vx, vy: old?.vy, fy: node.row });
        }
        this.graph.graphData({
            nodes: elements.nodes.map((node) => this.sim_nodes.get(node.id) as SimNode),
            links: elements.links.map((link) => ({ ...link })),
        });
    }

    // Setting any drawing option makes force-graph draw the next frame, even once the layout has settled.
    private repaint(): void {
        this.graph.linkVisibility(this.graph.linkVisibility());
    }

    // Draws a dashed arc over the row from the top of one box to the top of the task that builds on it.
    private draw_dependency(link: SimLink, context: CanvasRenderingContext2D): void {
        const start = link.source;
        const end = link.target;
        if (typeof start === 'string' || typeof end === 'string') {
            return;
        }
        const start_x = start.x ?? 0;
        const end_x = end.x ?? 0;
        const top = (start.y ?? 0) - BOX_HEIGHT / 2;
        const lift = Math.min(ROW_GAP / 3, 12 + Math.abs(end_x - start_x) / 6);
        context.beginPath();
        context.moveTo(start_x, top);
        context.quadraticCurveTo((start_x + end_x) / 2, top - lift * 2, end_x, top - ARROW_LENGTH / 2);
        context.setLineDash([4, 3]);
        context.lineWidth = 1.2;
        context.strokeStyle = this.colours.dependency;
        context.stroke();
        context.setLineDash([]);
        context.fillStyle = this.colours.dependency;
        arrow_head(context, end_x, top, Math.atan2(lift * 2 - ARROW_LENGTH / 2, end_x - (start_x + end_x) / 2));
    }

    // Draws a line from a task down to its first step, and an arrow from each step to the next.
    private draw_step_link(link: SimLink, context: CanvasRenderingContext2D): void {
        const start = link.source;
        const end = link.target;
        if (typeof start === 'string' || typeof end === 'string') {
            return;
        }
        const from_task = start.kind === 'task';
        const start_x = from_task ? (start.x ?? 0) : (start.x ?? 0) + start.width / 2;
        const start_y = from_task ? (start.y ?? 0) + start.height / 2 : (start.y ?? 0);
        const end_x = from_task ? (end.x ?? 0) : (end.x ?? 0) - end.width / 2;
        const end_y = from_task ? (end.y ?? 0) - end.height / 2 : (end.y ?? 0);
        context.beginPath();
        context.moveTo(start_x, start_y);
        context.lineTo(end_x, end_y);
        context.lineWidth = 1.2;
        context.strokeStyle = this.colours.line;
        context.stroke();
        context.fillStyle = this.colours.line;
        arrow_head(context, end_x, end_y, Math.atan2(end_y - start_y, end_x - start_x));
    }

    private draw_task(node: SimNode, context: CanvasRenderingContext2D): void {
        const colours = this.colours;
        const state = colours.states[node.status] ?? colours.states.pending;
        const left = (node.x ?? 0) - BOX_WIDTH / 2;
        const top = (node.y ?? 0) - BOX_HEIGHT / 2;
        const chosen = node.id === this.chosen_id;
        context.beginPath();
        context.roundRect(left, top, BOX_WIDTH, BOX_HEIGHT, 7);
        context.fillStyle = colours.surface;
        context.fill();
        context.lineWidth = chosen ? 2 : 1;
        context.strokeStyle = chosen ? colours.dependency : colours.border;
        context.stroke();
        context.beginPath();
        context.roundRect(left, top, 5, BOX_HEIGHT, 2);
        context.fillStyle = state;
        context.fill();

        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.font = `600 12px ${colours.font}`;
        context.fillStyle = colours.foreground;
        context.fillText(node.label, left + 13, top + 18);
        const id_width = context.measureText(node.label).width;
        context.font = `600 10px ${colours.font}`;
        context.fillStyle = state;
        context.fillText((TASK_STATE_WORDS[node.status] ?? 'WAIT').trim(), left + 21 + id_width, top + 18);
        context.font = `11px ${colours.font}`;
        context.fillStyle = colours.label;
        context.fillText(fitted(context, node.tooltip, BOX_WIDTH - 22), left + 13, top + 35);
    }

    private draw_step(node: SimNode, context: CanvasRenderingContext2D): void {
        const colours = this.colours;
        const state = colours.states[node.status] ?? colours.states.pending;
        const left = (node.x ?? 0) - STEP_WIDTH / 2;
        const top = (node.y ?? 0) - STEP_HEIGHT / 2;
        context.beginPath();
        context.roundRect(left, top, STEP_WIDTH, STEP_HEIGHT, 5);
        context.fillStyle = colours.step_surface;
        context.fill();
        context.lineWidth = node.status === 'running' ? 1.5 : 1;
        context.strokeStyle = node.status === 'running' ? state : colours.border;
        context.stroke();
        context.beginPath();
        context.roundRect(left, top, 4, STEP_HEIGHT, 2);
        context.fillStyle = state;
        context.fill();

        context.textAlign = 'left';
        context.textBaseline = 'middle';
        context.font = `10px ${colours.font}`;
        context.fillStyle = node.status === 'failed' ? state : colours.label;
        context.fillText(fitted(context, node.label, STEP_WIDTH - 16), left + 10, node.y ?? 0);
    }
}
