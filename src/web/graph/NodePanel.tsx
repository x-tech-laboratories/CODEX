// What a selected node is and what it is linked to, in the workspace: open it, link it to another node picked through
// search, close or remove its links, accept or reject those proposed, and for an entity rename it, remove it, join it
// with another or undo a join.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Badge } from "@x-tech-laboratories/x-libs/web/react/badges";
import { Dialog, confirm_dialog, open_dialog } from "@x-tech-laboratories/x-libs/web/react/dialog";
import { SearchBox, Select } from "@x-tech-laboratories/x-libs/web/react/controls";
import { FormRow, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import { link_types, type GraphLink, type GraphNode, type LinkType, type NodeLink } from "../../shared/graph/model.ts";
import type { SearchHit } from "../../shared/search/model.ts";
import { attempt, calls, succeeds, use_data } from "../api.ts";
import { maker_text, type_name, type_text } from "./look.ts";

// ── Opening ──────────────────────────────────────────────────────────────────

// Where a node opens: a context's page, a conversation in the pane, or an item in its own app.
export function open_node(node: Pick<GraphNode, "kind" | "id" | "type" | "uri">): void {
  if (node.kind === "context") window.location.hash = `/context/${node.id}`;
  else if (node.kind === "item" && node.type === "conversation") window.location.hash = `/conversation/${encodeURIComponent(node.id.replace(/^conversation:/, ""))}`;
  else if (node.kind === "item" && node.uri) window.open(node.uri, "_blank", "noreferrer");
}

function OpenNode({ node }: { node: GraphNode }) {
  if (node.kind === "entity") return null;
  if (node.kind === "item" && node.type !== "conversation") {
    return node.uri ? <a className="button" href={node.uri} target="_blank" rel="noreferrer">Open in its app</a> : null;
  }
  return <button type="button" onClick={() => open_node(node)}>{node.kind === "context" ? "Open the context" : "Open the conversation"}</button>;
}

// ── Picking a node ───────────────────────────────────────────────────────────

const search_pause_ms = 250;

function key_of_hit(hit: SearchHit): string | null {
  if (hit.kind === "message") return null;
  return `${hit.kind}:${hit.id}`;
}

// Finds a node through the search index: items, contexts and entities, or entities alone.
export function NodePicker({ label, only_entities = false, exclude = [], on_pick }: { label: string; only_entities?: boolean; exclude?: string[]; on_pick: (key: string, title: string) => void }) {
  const [query, set_query] = useState("");
  const [hits, set_hits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!query.trim()) return set_hits([]);
    const timer = setTimeout(() => void attempt(() => calls().search_index(query, null, 20)).then((found) => set_hits(found ?? [])), search_pause_ms);
    return () => clearTimeout(timer);
  }, [query]);
  const shown = hits.filter((hit) => key_of_hit(hit) !== null && (!only_entities || hit.kind === "entity") && !exclude.includes(key_of_hit(hit)!)).slice(0, 8);
  return (
    <div className="graph-picker">
      <SearchBox label={label} value={query} on_input={set_query} />
      {shown.length > 0 && (
        <ul className="found-list">
          {shown.map((hit) => (
            <li key={key_of_hit(hit)} className="found-row">
              <button type="button" className="link" onClick={() => on_pick(key_of_hit(hit)!, hit.title)}>
                {hit.title}
              </button>
              <span className="muted small">{hit.kind === "entity" ? "Entity" : hit.kind === "context" ? "Context" : hit.item_kind}</span>
            </li>
          ))}
        </ul>
      )}
      {query.trim() !== "" && shown.length === 0 && <p className="muted small">Nothing found yet.</p>}
    </div>
  );
}

// ── Links ────────────────────────────────────────────────────────────────────

export function status_badge(link: Pick<GraphLink, "status" | "valid_until">) {
  if (link.status === "proposed") return <Badge tone="warn">Proposed</Badge>;
  if (link.status === "rejected") return <Badge tone="bad">Rejected</Badge>;
  return link.valid_until && link.valid_until <= new Date().toISOString() ? <Badge>Closed</Badge> : null;
}

// Accept or reject one proposal, from wherever it shows.
export function decide(ids: string[], decision: "accept" | "reject"): Promise<boolean> {
  return succeeds(() => (decision === "accept" ? calls().accept_graph_proposals(ids) : calls().reject_graph_proposals(ids)), decision === "accept" ? "Accepted." : "Rejected; it will not be proposed again.");
}

// What a link can be made to do: accept or reject it while proposed, close it while open, remove it.
export function LinkButtons({ link }: { link: GraphLink }) {
  const is_open = !link.valid_until || link.valid_until > new Date().toISOString();
  return (
    <span className="row-actions">
      {link.status === "proposed" && (
        <>
          <button type="button" className="small" onClick={() => void decide([link.id], "accept")}>Accept</button>
          <button type="button" className="small" onClick={() => void decide([link.id], "reject")}>Reject</button>
        </>
      )}
      {link.status === "accepted" && is_open && (
        <button type="button" className="small" title="It stopped being true; keep it as what was" onClick={() => void succeeds(() => calls().close_graph_link(link.id), "Closed.")}>
          Close
        </button>
      )}
      {link.status !== "rejected" && (
        <button
          type="button"
          className="small"
          onClick={() =>
            confirm_dialog({
              title: "Remove this link?",
              message: link.made_by === "user" ? "It goes; you can bring it back from History." : "It is kept as rejected, so it is never made or proposed again.",
              confirm_label: "Remove",
              danger: true,
              run: async () => void (await succeeds(() => calls().remove_graph_link(link.id), "Removed.")),
            })
          }
        >
          Remove
        </button>
      )}
    </span>
  );
}

// Who made a link and where it came from.
export function LinkFacts({ link }: { link: Pick<GraphLink, "made_by" | "rule" | "engine" | "model" | "evidence"> }) {
  return (
    <span className="muted small">
      By {maker_text(link)}
      {link.evidence.ref && <>; from {link.evidence.label || "something no longer kept"}</>}
      {link.evidence.excerpt && <>: “{link.evidence.excerpt}”</>}
    </span>
  );
}

function LinkRow({ link, on_pick }: { link: NodeLink; on_pick: (key: string) => void }) {
  const arrow = link.direction === "out" ? "→" : link.direction === "in" ? "←" : "↔";
  return (
    <li className="item-row">
      <div className="item-text">
        <div className="item-title">
          <span className="muted">
            {arrow} {link.label || type_text(link.type)}
          </span>
          <button type="button" className="link" onClick={() => on_pick(link.other.key)}>
            {link.other.label}
          </button>
          {status_badge(link)}
        </div>
        <LinkFacts link={link} />
      </div>
      <LinkButtons link={link} />
    </li>
  );
}

// ── Adding a link ────────────────────────────────────────────────────────────

function AddLink({ node }: { node: GraphNode }) {
  const [type, set_type] = useState<LinkType>("related_to");
  const [label, set_label] = useState("");
  return (
    <Section title="Link to another node">
      <div className="toolbar">
        <Select<LinkType> label="Type" options={link_types.filter((each) => each !== "same_as").map((each) => [each, type_text(each)])} value={type} on_change={set_type} />
        <FormRow label="Label (optional)" id="graph-link-label">
          <input id="graph-link-label" value={label} onChange={(event) => set_label(event.target.value)} />
        </FormRow>
      </div>
      <NodePicker label="Find what to link to" exclude={[node.key]} on_pick={(key, title) => void succeeds(() => calls().add_graph_link(node.key, key, type, label), `Linked to ${title}.`).then((done) => done && set_label(""))} />
    </Section>
  );
}

// ── Entities ─────────────────────────────────────────────────────────────────

function rename_entity(node: GraphNode): void {
  open_dialog((close) => <RenameDialog node={node} on_close={close} />);
}

function RenameDialog({ node, on_close }: { node: GraphNode; on_close: () => void }) {
  const [name, set_name] = useState(node.label);
  const [alt, set_alt] = useState(node.alt_names.join(", "));
  return (
    <Dialog
      title="Rename"
      subtitle={type_name(node)}
      on_close={on_close}
      form={{
        submit_label: "Save",
        on_submit: (event) => {
          event.preventDefault();
          const names = alt.split(",").map((each) => each.trim()).filter(Boolean);
          void succeeds(() => calls().rename_entity(node.id, name, names)).then((done) => done && on_close());
        },
      }}
      buttons={<button type="button" onClick={on_close}>Cancel</button>}
    >
      <FormRow label="Name" id="entity-name">
        <input id="entity-name" value={name} autoFocus onChange={(event) => set_name(event.target.value)} />
      </FormRow>
      <FormRow label="Other names, with commas between" id="entity-alt">
        <input id="entity-alt" value={alt} onChange={(event) => set_alt(event.target.value)} />
      </FormRow>
    </Dialog>
  );
}

function EntityActions({ node, on_removed }: { node: GraphNode; on_removed: () => void }) {
  const [joining, set_joining] = useState(false);
  return (
    <>
      <div className="toolbar">
        <button type="button" onClick={() => rename_entity(node)}>Rename…</button>
        <button type="button" aria-pressed={joining} onClick={() => set_joining(!joining)}>Join with…</button>
        <button
          type="button"
          className="danger"
          onClick={() =>
            confirm_dialog({
              title: `Remove ${node.label}?`,
              message: "It goes with every link it has; History can bring it back with them.",
              confirm_label: "Remove",
              danger: true,
              run: async () => {
                if (await succeeds(() => calls().remove_entity(node.id), "Removed.")) on_removed();
              },
            })
          }
        >
          Remove
        </button>
      </div>
      {joining && (
        <NodePicker
          label="Find the entity it is the same as"
          only_entities
          exclude={[node.key, ...node.joined.map((each) => `entity:${each.id}`)]}
          on_pick={(key, title) => void succeeds(() => calls().join_entities(node.id, key.replace(/^entity:/, "")), `Joined with ${title}.`).then((done) => done && set_joining(false))}
        />
      )}
      {node.joined.length > 0 && (
        <Section title="Joined as one">
          <ul className="item-list">
            {node.joined.map((each) => (
              <li key={each.id} className="item-row">
                <span className="item-text">{each.name}</span>
                <span className="row-actions">
                  <button type="button" className="small" onClick={() => void succeeds(() => calls().remove_graph_link(each.link_id), `${each.name} is on its own again.`)}>
                    Undo join
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function NodePanel({ node_key, on_pick, on_close }: { node_key: string; on_pick: (key: string) => void; on_close: () => void }) {
  const found = use_data((api) => api.get_node_links(node_key), [node_key]);
  return (
    <Loaded resource={found}>
      {({ node, links }) => (
        <section className="graph-detail" aria-label={`About ${node.label}`}>
          <div className="item-title">
            <h3>{node.label}</h3>
            {node.status === "proposed" && <Badge tone="warn">Proposed</Badge>}
          </div>
          <p className="muted small">
            {type_name(node)}
            {node.alt_names.length > 0 && <>, also {node.alt_names.join(", ")}</>}
            {node.state && <>, {node.state}</>}
          </p>
          <div className="toolbar">
            <OpenNode node={node} />
            <button type="button" onClick={on_close}>Close</button>
          </div>
          {node.kind === "entity" && <EntityActions node={node} on_removed={on_close} />}
          <Section title={`Links · ${links.length}`}>
            {links.length === 0 ? (
              <p className="muted">Not linked to anything yet.</p>
            ) : (
              <ul className="item-list">
                {links.map((link) => (
                  <LinkRow key={link.id} link={link} on_pick={on_pick} />
                ))}
              </ul>
            )}
          </Section>
          <AddLink node={node} />
        </section>
      )}
    </Loaded>
  );
}
