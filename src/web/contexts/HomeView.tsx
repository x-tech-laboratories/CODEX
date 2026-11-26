// The first page: a search across every item kept, and each top-level context with what is inside it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Chip, Chips } from "@x-tech-laboratories/x-libs/web/react/badges";
import { SearchBox } from "@x-tech-laboratories/x-libs/web/react/controls";
import { AddIcon, Icon } from "@x-tech-laboratories/x-libs/web/react/icons";
import { Card, Cards, PageHeading, Section } from "@x-tech-laboratories/x-libs/web/react/layout";
import { Empty, Loaded } from "@x-tech-laboratories/x-libs/web/react/states";

import type { ContextSummary } from "../../shared/contexts/model.ts";
import { use_data } from "../api.ts";
import { context_href, new_context } from "./actions.tsx";
import { seed_dialog } from "./FeedDialogs.tsx";
import { look_of } from "./kinds.tsx";

// ── Search ───────────────────────────────────────────────────────────────────

function Found({ query }: { query: string }) {
  const found = use_data((api) => api.search_kept_items(query), [query]);
  return (
    <Section title="Found">
      <Loaded resource={found}>
        {(items) =>
          items.length === 0 ? (
            <Empty title="Nothing kept matches" hint="Only items already in a context are searched here; add new ones from a context's page." />
          ) : (
            <ul className="item-list">
              {items.map((item) => (
                <li key={item.id} className="item-row">
                  <Icon icon={look_of(item.kind).icon} />
                  <div className="item-text">
                    <div className="item-title">
                      {item.uri ? (
                        <a href={item.uri} target="_blank" rel="noreferrer">
                          {item.title}
                        </a>
                      ) : (
                        <span>{item.title}</span>
                      )}
                    </div>
                    {item.snippet && <span className="muted item-snippet">{item.snippet}</span>}
                    <Chips inline>
                      {item.contexts.map((context) => (
                        <Chip key={context.id} on_click={() => (window.location.hash = context_href(context.id).slice(1))}>
                          {context.name}
                        </Chip>
                      ))}
                    </Chips>
                  </div>
                </li>
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
