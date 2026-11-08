// The two force-graph panels as React elements: each keeps its drawing object across redraws and draws when its data changes.
import { useEffect, useRef, type RefObject } from 'react';

import { KnowledgeGraph } from '../knowledge_graph.ts';
import type { MapNode, TreeChoice } from '../knowledge_view.ts';
import { TaskGraph, type StepTarget } from '../task_graph.ts';
import type { Fact, GraphEdge, Source, TaskNode } from '../types.ts';

export const NO_TASKS_TEXT = 'Tasks appear here once a request is planned.';

interface TaskGraphViewProps {
    nodes: TaskNode[];
    chosen_id: string | null;
    on_choose: (task_id: string, step: StepTarget | null) => void;
    // Filled with the graph, so a Reset view button outside can call it.
    graph_ref: RefObject<TaskGraph | null>;
}

export function TaskGraphView({ nodes, chosen_id, on_choose, graph_ref }: TaskGraphViewProps) {
    const panel = useRef<HTMLDivElement>(null);
    const choose = useRef(on_choose);
    choose.current = on_choose;

    useEffect(() => {
        graph_ref.current = new TaskGraph(panel.current!, { on_choose: (task_id, step) => choose.current(task_id, step) });
        return () => {
            graph_ref.current = null;
        };
    }, []);

    useEffect(() => {
        graph_ref.current?.draw(nodes, chosen_id);
    }, [nodes, chosen_id]);

    return (
        <div ref={panel} className="task-graph" role="img" aria-label="Graph of the tasks and the tasks each builds on" data-empty={nodes.length === 0} data-empty-text={NO_TASKS_TEXT} />
    );
}

interface KnowledgeGraphViewProps {
    tree: MapNode;
    graph: GraphEdge[];
    sources: Source[];
    facts: Fact[];
    chosen_key: string | null;
    on_choose: (choice: TreeChoice) => void;
    graph_ref: RefObject<KnowledgeGraph | null>;
}

export function KnowledgeGraphView({ tree, graph, sources, facts, chosen_key, on_choose, graph_ref }: KnowledgeGraphViewProps) {
    const panel = useRef<HTMLDivElement>(null);
    const choose = useRef(on_choose);
    choose.current = on_choose;

    useEffect(() => {
        graph_ref.current = new KnowledgeGraph(panel.current!, { on_choose: (choice) => choose.current(choice) });
        return () => {
            graph_ref.current = null;
        };
    }, []);

    useEffect(() => {
        graph_ref.current?.draw(tree, graph, sources, facts, chosen_key);
    }, [tree, graph, sources, facts, chosen_key]);

    return <div ref={panel} className="knowledge-map" role="img" aria-label="Graph of topics, articles, findings and relationships" />;
}
