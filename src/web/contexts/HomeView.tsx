// The first page: a search across everything kept, by words and meaning, and each top-level context with what is inside it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Layers, MessageSquare } from "lucide-react";
import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { AddIcon, Icon, type IconGlyph } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Card, Cards, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { ContextSummary } from "../../shared/contexts/model.ts";
import type { HitKind, SearchHit } from "../../shared/search/model.ts";
import { use_data } from "../api.ts";
import { context_href, new_context } from "./actions.tsx";
import { seed_dialog } from "./FeedDialogs.tsx";
import { look_of } from "./kinds.tsx";

// ── Search ───────────────────────────────────────────────────────────────────

const hit_icons: Record<Exclude<HitKind, "item">, IconGlyph> = { context: Layers, message: MessageSquare };

function go_to(context_id: string): void {
  window.location.hash = context_href(context_id).slice(1);
}

// One thing found: its title, opening in its app or on its context's page, the words around the match and where it is.
function Hit({ hit }: { hit: SearchHit }) {
  const icon = hit.kind === "item" ? look_of(hit.item_kind).icon : hit_icons[hit.kind];
  const where = hit.kind === "message" && hit.where.length === 0 ? [{ id: "", name: "General conversation" }] : hit.where;
  const title =
    hit.kind === "item" && hit.uri ? (
      <a href={hit.uri} target="_blank" rel="noreferrer">
        {hit.title}
      </a>
    ) : hit.kind === "context" ? (
      <a href={context_href(hit.id)}>{hit.title}</a>
    ) : (
      <span>{hit.kind === "message" ? `${hit.title}, in a conversation` : hit.title}</span>
    );
  return (
    <li className="item-row">
      <Icon icon={icon} />
      <div className="item-text">
        <div className="item-title">{title}</div>
        {hit.excerpt && <span className="muted item-snippet">{hit.excerpt}</span>}
        <Chips inline>
          {where.map((place) => (
            <Chip key={place.id || place.name} on_click={place.id ? () => go_to(place.id) : undefined}>
              {place.name}
            </Chip>
          ))}
        </Chips>
      </div>
    </li>
  );
}

function Found({ query }: { query: string }) {
  const found = use_data((api) => api.search_index(query, null, 30), [query]);
  return (
    <Section title="Found">
      <Loaded resource={found}>
        {(hits) =>
          hits.length === 0 ? (
            <Empty title="Nothing matches" hint="Items in your contexts, their text from their apps, your contexts' notes and the conversations are searched; add new items from a context's page." />
          ) : (
            <ul className="item-list">
              {hits.map((hit) => (
                <Hit key={`${hit.kind}:${hit.id}`} hit={hit} />
              ))}
            </ul>
          )
        }
      </Loaded>
    </Section>
  );
}

// ── Contexts ─────────────────────────────────────────────────────────────────

function ContextCards({ contexts }: { contexts: ContextSummary[] }) {
  const top = contexts.filter((context) => context.parent_id === null);
  if (top.length === 0) return <Empty title="No contexts yet" hint="Make one for each project or area of your life, then add the tasks, notes, files, emails and links that belong to it." />;
  const inside = (id: string) => contexts.filter((context) => context.parent_id === id);
  return (
    <Cards>
      {top.map((context) => (
        <Card key={context.id} title={context.name} subtitle={`${context.item_count} ${context.item_count === 1 ? "item" : "items"}`} href={context_href(context.id)}>
          {inside(context.id).length > 0 && <span className="muted">{inside(context.id).map((child) => child.name).join(" · ")}</span>}
        </Card>
      ))}
    </Cards>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function HomeView() {
  const [query, set_query] = useState("");
  const contexts = use_data((api) => api.list_contexts(false));
  return (
    <>
      <PageHeading
        title="Contexts"
        actions={
          <>
            <button type="button" onClick={seed_dialog} title="Make a context for each tag or project picked in another app, such as X-Tasks">
              From another app…
            </button>
            <button type="button" className="accent solid" onClick={() => new_context(null)}>
              <Icon icon={AddIcon} /> New context
            </button>
          </>
        }
      />
      <SearchBox label="Search everything kept" value={query} on_input={set_query} />
      {query.trim() ? <Found query={query.trim()} /> : <Loaded resource={contexts}>{(list) => <ContextCards contexts={list} />}</Loaded>}
    </>
  );
}
