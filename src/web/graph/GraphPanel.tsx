// The graph in the workspace: a context's, or the whole graph, drawn with its filters, what the selected node or link
// is beside it, and the proposed links and entities waiting, accepted or rejected one by one or a selection at once.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, confirm_dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { Segmented, Select, Switch } from "@x-tech-laboratories/x-libs/web/react/controls";
import { GraphView as GraphDrawing } from "@x-tech-laboratories/x-libs/web/react/graph";
import { FormRow, Section, SelectionBar } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { entity_kinds, link_types, type EntityKind, type GraphFilter, type GraphLink, type GraphNode, type GraphProposals, type GraphStatus, type GraphView as GraphViewData, type LinkType } from "../../shared/graph/model.ts";
import { calls, succeeds, use_data } from "../api.ts";
import { drawn, type_name, type_text } from "./look.ts";
import { decide, LinkButtons, LinkFacts, NodePanel, open_node, status_badge } from "./NodePanel.tsx";

// ── Filters ──────────────────────────────────────────────────────────────────

type StatusChoice = "both" | "accepted" | "proposed";

const node_kinds = [
  ["context", "Contexts"],
  ["item", "Items"],
  ["entity", "Entities"],
] as const;

function statuses_of(choice: StatusChoice): GraphStatus[] {
  return choice === "both" ? ["accepted", "proposed"] : [choice];
}

// ── A new entity ─────────────────────────────────────────────────────────────

function NewEntityDialog({ on_close, on_made }: { on_close: () => void; on_made: (key: string) => void }) {
  const [kind, set_kind] = useState<EntityKind>("person");
  const [name, set_name] = useState("");
  return (
    <Dialog
      title="New entity"
      subtitle="A person, organisation, topic or place the graph can link to"
      on_close={on_close}
      form={{
        submit_label: "Add",
        on_submit: (event) => {
          event.preventDefault();
          let made = "";
          void succeeds(async () => (made = await calls().add_entity(kind, name)), `Added ${name.trim()}.`).then((done) => {
            if (!done) return;
            on_close();
            on_made(`entity:${made}`);
          });
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <Select<EntityKind> label="Kind" options={entity_kinds.map((each) => [each, type_name({ kind: "entity", type: each })])} value={kind} on_change={set_kind} />
      <FormRow label="Name" id="new-entity-name">
        <input id="new-entity-name" value={name} autoFocus onChange={(event) => set_name(event.target.value)} />
      </FormRow>
    </Dialog>
  );
}

// ── A selected link ──────────────────────────────────────────────────────────

function LinkPanel({ link, nodes, on_pick, on_close }: { link: GraphLink; nodes: Map<string, GraphNode>; on_pick: (key: string) => void; on_close: () => void }) {
  const end = (key: string) => (
    <button type="button" className="link" onClick={() => on_pick(key)}>
      {nodes.get(key)?.label ?? key}
    </button>
  );
  return (
    <section className="graph-detail" aria-label="The link chosen">
      <div className="item-title">
        <h3>
          {end(link.from)} <span className="muted">{link.label || type_text(link.type)}</span> {end(link.to)}
        </h3>
        {status_badge(link)}
      </div>
      <LinkFacts link={link} />
      <div className="toolbar">
        <LinkButtons link={link} />
        <button type="button" onClick={on_close}>Close</button>
      </div>
    </section>
  );
}

// ── Proposals ────────────────────────────────────────────────────────────────

// Every proposal waiting, with who proposed it and its evidence; ticked ones are accepted or rejected together.
export function ProposedList({ proposals, on_pick }: { proposals: GraphProposals; on_pick?: (key: string) => void }) {
  const [ticked, set_ticked] = useState<Set<string>>(() => new Set());
  const all = [...proposals.links.map((link) => link.id), ...proposals.entities.map((entity) => entity.id)];
  const chosen = all.filter((id) => ticked.has(id));
  const tick = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    set_ticked(next);
  };
  const all_of = (decision: "accept" | "reject") =>
    confirm_dialog({
      title: `${decision === "accept" ? "Accept" : "Reject"} ${chosen.length} ${chosen.length === 1 ? "proposal" : "proposals"}?`,
      message: decision === "accept" ? "They join the graph as if you had made them." : "They are remembered, so none of them is proposed again.",
      confirm_label: decision === "accept" ? "Accept" : "Reject",
      danger: decision === "reject",
      run: async () => {
        if (await decide(chosen, decision)) set_ticked(new Set());
      },
    });
  if (all.length === 0) return <p className="muted">Nothing is waiting for you.</p>;
  const name = (key: string, label: string) => (on_pick ? <button type="button" className="link" onClick={() => on_pick(key)}>{label}</button> : <span>{label}</span>);
  return (
    <>
      {chosen.length > 0 && (
        <SelectionBar count={chosen.length} total={all.length} on_clear={() => set_ticked(new Set())} on_select_all={() => set_ticked(new Set(all))}>
          <button type="button" onClick={() => all_of("accept")}>Accept all</button>
          <button type="button" onClick={() => all_of("reject")}>Reject all</button>
        </SelectionBar>
      )}
      <ul className="item-list" aria-label="Proposed links">
        {proposals.entities.map((entity) => (
          <li key={entity.id} className="item-row">
            <input type="checkbox" aria-label={`Choose ${entity.name}`} checked={ticked.has(entity.id)} onChange={(event) => tick(entity.id, event.target.checked)} />
            <div className="item-text">
              <div className="item-title">
                {name(`entity:${entity.id}`, entity.name)}
                <span className="muted">a new {type_name({ kind: "entity", type: entity.kind }).toLowerCase()}</span>
              </div>
              <LinkFacts link={entity} />
            </div>
            <span className="row-actions">
              <button type="button" className="small" onClick={() => void decide([entity.id], "accept")}>Accept</button>
              <button type="button" className="small" onClick={() => void decide([entity.id], "reject")}>Reject</button>
            </span>
          </li>
        ))}
        {proposals.links.map((link) => (
          <li key={link.id} className="item-row">
            <input type="checkbox" aria-label={`Choose ${link.from_node.label} ${type_text(link.type)} ${link.to_node.label}`} checked={ticked.has(link.id)} onChange={(event) => tick(link.id, event.target.checked)} />
            <div className="item-text">
              <div className="item-title">
                {name(link.from, link.from_node.label)}
                <span className="muted">{link.label || type_text(link.type)}</span>
                {name(link.to, link.to_node.label)}
              </div>
              <LinkFacts link={link} />
            </div>
            <span className="row-actions">
              <button type="button" className="small" onClick={() => void decide([link.id], "accept")}>Accept</button>
              <button type="button" className="small" onClick={() => void decide([link.id], "reject")}>Reject</button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export interface GraphPanelProps {
  // The context drawn, or null for the whole graph.
  context_id: string | null;
  // The node selected and centred at first, such as the one an item's link count opened.
  focus?: string | null;
  // Finds a node by name and centres on it.
  with_search?: boolean;
  label: string;
}

export function GraphPanel({ context_id, focus = null, with_search = false, label }: GraphPanelProps) {
  const [everything, set_everything] = useState(false);
  const [kinds, set_kinds] = useState<Set<string>>(() => new Set(node_kinds.map(([kind]) => kind)));
  const [link_type, set_link_type] = useState<LinkType | "all">("all");
  const [status, set_status] = useState<StatusChoice>("both");
  const [selected, set_selected] = useState<string | null>(focus);
  const [selected_link, set_selected_link] = useState<string | null>(null);
  const [focus_id, set_focus_id] = useState<string | null>(focus);
  const [query, set_query] = useState("");
  const scope = everything ? null : context_id;
  const filter: GraphFilter = { node_types: kinds.size === node_kinds.length ? [] : [...kinds], link_types: link_type === "all" ? [] : [link_type], statuses: statuses_of(status), limit: scope ? 500 : 2000 };
  const graph = use_data((api) => api.get_graph(scope, filter), [scope, JSON.stringify(filter)]);
  const proposals = use_data((api) => api.list_graph_proposals(scope), [scope]);
  // The last graph loaded stays drawn while a new filter loads, so the drawing keeps its places and the filters stay.
  const shown = useRef(graph.data);
  if (graph.data) shown.current = graph.data;

  const pick = (key: string) => {
    set_selected(key);
    set_selected_link(null);
    set_focus_id(key);
  };
  const tools = (
    <>
      {context_id !== null && <Switch label="Show everything" show_label checked={everything} on_change={set_everything} />}
      {node_kinds.map(([kind, text]) => (
        <label key={kind} className="check">
          <input
            type="checkbox"
            checked={kinds.has(kind)}
            onChange={(event) => {
              const next = new Set(kinds);
              if (event.target.checked) next.add(kind);
              else next.delete(kind);
              set_kinds(next);
            }}
          />{" "}
          {text}
        </label>
      ))}
      <Select<LinkType | "all"> label="Links" options={[["all", "Every type"], ...link_types.map((each): [LinkType, string] => [each, type_text(each)])]} value={link_type} on_change={set_link_type} />
      <button type="button" onClick={() => open_dialog((close) => <NewEntityDialog on_close={close} on_made={pick} />)}>
        New entity…
      </button>
      <Segmented<StatusChoice>
        label="Which links"
        choices={[
          { value: "both", label: "All" },
          { value: "accepted", label: "Accepted" },
          { value: "proposed", label: "Proposed" },
        ]}
        value={status}
        on_change={set_status}
      />
    </>
  );

  const body = (view: GraphViewData) => (
        <GraphBody
          view={view}
          label={label}
          tools={tools}
          selected={selected}
          selected_link={selected_link}
          focus_id={focus_id}
          query={with_search ? query : null}
          on_query={set_query}
          on_pick={pick}
          on_select={(key) => {
            set_selected(key);
            set_selected_link(null);
          }}
          on_link={(id) => {
            set_selected_link(id);
            set_selected(null);
          }}
          proposals={proposals.data ?? null}
        />
  );
  return shown.current ? body(shown.current) : <Loaded resource={graph}>{body}</Loaded>;
}

interface BodyProps {
  view: GraphViewData;
  label: string;
  tools: ReactNode;
  selected: string | null;
  selected_link: string | null;
  focus_id: string | null;
  query: string | null;
  on_query: (query: string) => void;
  on_pick: (key: string) => void;
  on_select: (key: string | null) => void;
  on_link: (id: string | null) => void;
  proposals: GraphProposals | null;
}

function GraphBody({ view, label, tools, selected, selected_link, focus_id, query, on_query, on_pick, on_select, on_link, proposals }: BodyProps) {
  const drawing = useMemo(() => drawn(view), [view]);
  const nodes = useMemo(() => new Map(view.nodes.map((node) => [node.key, node])), [view]);
  const link = selected_link ? view.links.find((each) => each.id === selected_link) : undefined;
  const matches = query?.trim() ? view.nodes.filter((node) => [node.label, ...node.alt_names].some((name) => name.toLowerCase().includes(query.trim().toLowerCase()))).slice(0, 8) : [];
  return (
    <>
      {query !== null && (
        <div className="graph-search">
          <input
            type="search"
            aria-label="Find a node"
            placeholder="Find a node by name"
            value={query}
            onChange={(event) => on_query(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0]) on_pick(matches[0].key);
            }}
          />
          {matches.length > 0 && (
            <ul className="found-list" aria-label="Nodes found">
              {matches.map((node) => (
                <li key={node.key} className="found-row">
                  <button type="button" className="link" onClick={() => on_pick(node.key)}>
                    {node.label}
                  </button>
                  <span className="muted small">{type_name(node)}</span>
                </li>
              ))}
            </ul>
          )}
          {query.trim() !== "" && matches.length === 0 && <p className="muted small">No node by that name is shown.</p>}
        </div>
      )}
      <div className="graph-layout">
        <div className="graph-main">
          <GraphDrawing
            label={label}
            nodes={drawing.nodes}
            links={drawing.links}
            kinds={drawing.kinds}
            link_legend={[
              { style: "solid", label: "Accepted" },
              { style: "dashed", label: "Proposed" },
            ]}
            selected_id={selected}
            focus_id={focus_id}
            on_select={on_select}
            on_link_select={(id) => (id.startsWith("structure:") ? undefined : on_link(id))}
            on_activate={(key) => {
              const node = nodes.get(key);
              // An entity has nowhere to open, so it is shown beside the drawing instead.
              if (node?.kind === "entity") on_pick(key);
              else if (node) open_node(node);
            }}
            tools={tools}
            empty_title="Nothing in the graph here yet."
            empty_hint="Links appear as items point at each other, and Suggest links asks the assistant to propose some."
            height={460}
          />
          {(view.hidden_nodes > 0 || view.hidden_links > 0) && (
            <p className="muted small">
              {view.hidden_nodes} more nodes and {view.hidden_links} more links are not shown; narrow the filters to see them.
            </p>
          )}
        </div>
        <div className="graph-side">
          {link ? (
            <LinkPanel link={link} nodes={nodes} on_pick={on_pick} on_close={() => on_link(null)} />
          ) : selected ? (
            <NodePanel node_key={selected} on_pick={on_pick} on_close={() => on_select(null)} />
          ) : (
            <p className="muted">Choose a node or a link to see what it is and what it is linked to.</p>
          )}
        </div>
      </div>
      <Section title={`Proposed links${proposals ? ` · ${proposals.links.length + proposals.entities.length}` : ""}`}>
        {proposals ? <ProposedList proposals={proposals} on_pick={on_pick} /> : null}
      </Section>
    </>
  );
}
